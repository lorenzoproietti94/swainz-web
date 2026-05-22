/**
 * Swainz — update-db.js  (v194)
 * ─────────────────────────────────────────────────────────────────────────────
 * Aggiorna ogni notte le colonne:
 *   poster_url   → URL locandina TMDB (w342)
 *   Piattaforme  → Netflix, Prime Video, ecc. (watch/providers IT)
 *   Voto IMDB    → voto reale via OMDB
 *
 * Variabili d'ambiente richieste (GitHub Secrets):
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY, TMDB_API_KEY, OMDB_API_KEY
 *
 * Soglie Dice similarity (bigrammi sul titolo):
 *   < 0.50  → SKIP totale
 *   0.50–0.65 → aggiorna solo Piattaforme + Voto IMDB (niente poster)
 *   0.65–0.75 → LOW CONF  — aggiorna tutto, logga avviso
 *   > 0.75  → HIGH CONF  — aggiorna tutto normalmente
 */

import { createClient } from '@supabase/supabase-js';

// ─── Config ──────────────────────────────────────────────────────────────────

const SUPABASE_URL        = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY= process.env.SUPABASE_SERVICE_KEY;
const TMDB_API_KEY        = process.env.TMDB_API_KEY;
const OMDB_API_KEY        = process.env.OMDB_API_KEY;

const POSTER_BASE  = 'https://image.tmdb.org/t/p/w342';
const BATCH_SIZE   = 950;
const DELAY_MS     = 280;  // ~3.5 req/s — sotto il limite TMDB (40 req/10s)

/** Provider IDs TMDB → nome Swainz (IT) */
const IT_PROVIDERS = {
  8:   'Netflix',
  119: 'Prime Video',
  337: 'Disney+',
  11:  'MUBI',
  350: 'Apple TV',
};

// ─── Supabase client ──────────────────────────────────────────────────────────

const DB = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// ─── Dice similarity su bigrammi ──────────────────────────────────────────────

function dice(a, b) {
  if (!a || !b) return 0;
  const norm = s => s.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // rimuove accenti
    .replace(/[^a-z0-9 ]/g, '')
    .trim();
  const na = norm(a), nb = norm(b);
  if (na === nb) return 1;
  if (na.length < 2 || nb.length < 2) return 0;

  const bigrams = str => {
    const m = new Map();
    for (let i = 0; i < str.length - 1; i++) {
      const bg = str[i] + str[i + 1];
      m.set(bg, (m.get(bg) || 0) + 1);
    }
    return m;
  };

  const ba = bigrams(na), bb = bigrams(nb);
  let inter = 0;
  for (const [k, v] of ba) {
    if (bb.has(k)) inter += Math.min(v, bb.get(k));
  }
  const total =
    [...ba.values()].reduce((s, v) => s + v, 0) +
    [...bb.values()].reduce((s, v) => s + v, 0);
  return total === 0 ? 0 : (2 * inter) / total;
}

// ─── Helpers fetch ────────────────────────────────────────────────────────────

async function apiFetch(url) {
  const res = await fetch(url);
  if (!res.ok) return null;
  return res.json().catch(() => null);
}

// ─── TMDB: ricerca film ───────────────────────────────────────────────────────

async function tmdbSearch(title, year) {
  const base = `https://api.themoviedb.org/3/search/movie?api_key=${TMDB_API_KEY}&language=it-IT`;
  const q    = encodeURIComponent(title);

  for (const extra of [`&year=${year}`, '']) {
    const data = await apiFetch(`${base}&query=${q}${extra}`);
    if (data?.results?.length) return data.results;
  }
  return [];
}

// ─── TMDB: provider italiani ──────────────────────────────────────────────────

async function tmdbProviders(tmdbId) {
  const data = await apiFetch(
    `https://api.themoviedb.org/3/movie/${tmdbId}/watch/providers?api_key=${TMDB_API_KEY}`
  );
  const flatrate = data?.results?.IT?.flatrate || [];
  return [
    ...new Set(
      flatrate
        .filter(p => IT_PROVIDERS[p.provider_id])
        .map(p => IT_PROVIDERS[p.provider_id])
    ),
  ];
}

// ─── TMDB: external_ids (→ imdb_id) ──────────────────────────────────────────

async function tmdbExternalIds(tmdbId) {
  return apiFetch(
    `https://api.themoviedb.org/3/movie/${tmdbId}/external_ids?api_key=${TMDB_API_KEY}`
  );
}

// ─── OMDB: voto IMDB reale ────────────────────────────────────────────────────

async function omdbRating(imdbId) {
  if (!imdbId) return null;
  const data = await apiFetch(
    `https://www.omdbapi.com/?i=${imdbId}&apikey=${OMDB_API_KEY}`
  );
  if (!data || data.Response !== 'True') return null;
  const r = parseFloat(data.imdbRating);
  return isNaN(r) ? null : r;
}

// ─── Elaborazione singolo film ────────────────────────────────────────────────

async function processFilm(film) {
  const { id, Titolo, Anno } = film;

  const results = await tmdbSearch(Titolo, Anno);
  if (!results.length) {
    console.log(`  [SKIP]  ${Titolo} (${Anno}) — nessun risultato TMDB`);
    return null;
  }

  let best = null, bestScore = 0;
  for (const r of results) {
    const s = Math.max(dice(Titolo, r.title), dice(Titolo, r.original_title));
    if (s > bestScore) { bestScore = s; best = r; }
  }

  if (bestScore < 0.50) {
    console.log(`  [SKIP]  ${Titolo} — score ${bestScore.toFixed(2)} (miglior match: "${best?.title}")`);
    return null;
  }

  const conf = bestScore >= 0.75 ? 'HIGH' : bestScore >= 0.65 ? 'LOW ' : 'MIN ';
  console.log(`  [${conf}] ${Titolo} → "${best.title}" (score ${bestScore.toFixed(2)}, tmdb_id=${best.id})`);

  const update = {};

  const providers = await tmdbProviders(best.id);
  update['Piattaforme'] = providers;

  if (bestScore >= 0.65 && best.poster_path) {
    update['poster_url'] = `${POSTER_BASE}${best.poster_path}`;
  }

  const ext = await tmdbExternalIds(best.id);
  if (ext?.imdb_id) {
    const rating = await omdbRating(ext.imdb_id);
    if (rating !== null) update['Voto IMDB'] = rating;
  }

  return { id, update };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('═══════════════════════════════════════════════════════');
  console.log('  Swainz DB Update   |   ' + new Date().toISOString());
  console.log('═══════════════════════════════════════════════════════');

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !TMDB_API_KEY || !OMDB_API_KEY) {
    throw new Error(
      'Variabili d\'ambiente mancanti! Controlla: ' +
      'SUPABASE_URL, SUPABASE_SERVICE_KEY, TMDB_API_KEY, OMDB_API_KEY'
    );
  }

  const allFilms = [];
  let from = 0;
  const PAGE = 100;  // ridotto per rispettare il limite max_rows di Supabase
  while (true) {
    const { data, error } = await DB
      .from('Movies')
      .select('id, Titolo, Anno')
      .range(from, from + PAGE - 1)
      .order('id');
    if (error) throw new Error('Supabase fetch error: ' + error.message);
    if (!data?.length) break;
    allFilms.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }

  console.log(`\nFilm nel DB: ${allFilms.length}`);

  const numBatches = Math.max(1, Math.ceil(allFilms.length / BATCH_SIZE));
  const batchIndex = Math.floor(Date.now() / 86400000) % numBatches;
  const start      = batchIndex * BATCH_SIZE;
  const batch      = allFilms.slice(start, start + BATCH_SIZE);

  console.log(
    `Batch ${batchIndex + 1}/${numBatches} ` +
    `(film ${start + 1}–${start + batch.length})\n`
  );

  let updated = 0, skipped = 0, errors = 0;

  for (let i = 0; i < batch.length; i++) {
    const film = batch[i];
    process.stdout.write(`[${String(i + 1).padStart(4)}/${batch.length}] `);

    try {
      const result = await processFilm(film);

      if (result && Object.keys(result.update).length > 0) {
        const { error } = await DB
          .from('Movies')
          .update(result.update)
          .eq('id', result.id);

        if (error) {
          console.error(`  [ERR]  id ${result.id} — update Supabase: ${error.message}`);
          errors++;
        } else {
          updated++;
        }
      } else {
        skipped++;
      }
    } catch (e) {
      console.error(`  [ERR]  ${film.Titolo}: ${e.message}`);
      errors++;
    }

    await new Promise(r => setTimeout(r, DELAY_MS));
  }

  console.log('\n═══════════════════════════════════════════════════════');
  console.log(`  ✅ Aggiornati:  ${updated}`);
  console.log(`  ⏭  Saltati:     ${skipped}`);
  console.log(`  ❌ Errori:      ${errors}`);
  console.log('  Fine: ' + new Date().toISOString());
  console.log('═══════════════════════════════════════════════════════');
}

main().catch(e => { console.error('\nFATAL:', e.message); process.exit(1); });
