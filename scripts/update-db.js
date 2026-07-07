/**
 * Swainz — update-db.js  (v197)
 * ─────────────────────────────────────────────────────────────────────────────
 * Aggiorna ogni notte le colonne:
 *   poster_url            → URL locandina TMDB (w342)
 *   Piattaforme           → piattaforme in ABBONAMENTO/gratis (flatrate+free+ads)
 *   Piattaforme_noleggio  → piattaforme a NOLEGGIO/ACQUISTO   (rent+buy)
 *   Voto IMDB             → vote_average da TMDB (scala 0–10, zero chiamate extra)
 *
 * Variabili d'ambiente richieste (GitHub Secrets):
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY, TMDB_API_KEY
 *
 * Soglie Dice similarity (bigrammi sul titolo):
 *   < 0.50  → SKIP totale
 *   0.50–0.65 → aggiorna solo Piattaforme(+noleggio) + Voto IMDB (niente poster)
 *   0.65–0.75 → LOW CONF  — aggiorna tutto, logga avviso
 *   > 0.75  → HIGH CONF  — aggiorna tutto normalmente
 *
 * v197 — (1) Whitelist IT_PROVIDERS ampliata: RaiPlay, Infinity, NowTV, Sky Go,
 *         Google Play, Paramount+, TIMVISION, YouTube Premium, CHILI,
 *         Crunchyroll, MGM+, HBO Max. Accorpamento multi-ID → canonico unico
 *         (es. Amazon Video/Prime-with-Ads→Prime Video; *Amazon Channel→brand).
 *         (2) tmdbProviders() legge ora flatrate+free+ads (→Piattaforme) e
 *         rent+buy (→Piattaforme_noleggio) invece del solo flatrate; questo
 *         permette la comparsa di RaiPlay/Infinity gratis e il toggle
 *         noleggio/acquisto lato frontend. L'abbonamento ha precedenza:
 *         un canonico presente in sub è rimosso da rent.
 *         PREREQUISITO DB: colonna "Piattaforme_noleggio" text[] (vedi SQL).
 * v196 — Voto IMDB ora letto da best.vote_average (già presente nel risultato
 *         tmdbSearch, zero chiamate API aggiuntive). Rimossi tmdbExternalIds
 *         e omdbRating. Rimossa dipendenza da OMDB_API_KEY.
 */

import { createClient } from '@supabase/supabase-js';

// ─── Config ──────────────────────────────────────────────────────────────────

const SUPABASE_URL        = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY= process.env.SUPABASE_SERVICE_KEY;
const TMDB_API_KEY        = process.env.TMDB_API_KEY;

const POSTER_BASE  = 'https://image.tmdb.org/t/p/w342';
const BATCH_SIZE   = 950;
const DELAY_MS     = 280;  // ~3.5 req/s — sotto il limite TMDB (40 req/10s)

/** Provider IDs TMDB → nome canonico Swainz (IT).
 *  Più ID possono puntare allo stesso canonico (accorpamento): la
 *  deduplica in tmdbProviders() li fonde in un'unica voce. */
const IT_PROVIDERS = {
  // ── Netflix ──
  8:    'Netflix',
  // ── Prime Video (tutte le declinazioni Amazon dirette) ──
  119:  'Prime Video',   // Amazon Prime Video
  10:   'Prime Video',   // Amazon Video
  2100: 'Prime Video',   // Amazon Prime Video with Ads
  // ── Disney+ ──
  337:  'Disney+',
  // ── Apple TV ──
  350:  'Apple TV',      // Apple TV
  2:    'Apple TV',      // Apple TV Store
  2243: 'Apple TV',      // Apple TV Amazon Channel
  // ── MUBI ──
  11:   'MUBI',          // MUBI
  201:  'MUBI',          // MUBI Amazon Channel
  // ── RaiPlay ──
  222:  'RaiPlay',       // Rai Play
  // ── Infinity ──
  359:  'Infinity',      // Mediaset Infinity
  1726: 'Infinity',      // Infinity Selection Amazon Channel
  // ── NowTV ──
  39:   'NowTV',         // Now TV
  // ── Sky Go ──
  29:   'Sky Go',
  // ── Google Play ──
  3:    'Google Play',   // Google Play Movies
  // ── Paramount+ ──
  531:  'Paramount+',    // Paramount Plus
  582:  'Paramount+',    // Paramount+ Amazon Channel
  // ── TIMVISION ──
  109:  'TIMVISION',
  // ── YouTube Premium ──
  188:  'YouTube Premium',
  // ── CHILI ──
  40:   'CHILI',
  // ── Crunchyroll ──
  283:  'Crunchyroll',   // Crunchyroll
  1968: 'Crunchyroll',   // Crunchyroll Amazon Channel
  // ── MGM+ ──
  2141: 'MGM+',          // MGM Plus Amazon Channel
  // ── HBO Max ──
  1899: 'HBO Max',       // HBO Max
  1825: 'HBO Max',       // HBO Max Amazon Channel
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

/** Restituisce { sub, rent } con i canonici Swainz:
 *   sub  ← flatrate + free + ads   (disponibilità "in abbonamento/gratis")
 *   rent ← rent + buy              (disponibilità a noleggio/acquisto)
 *  Ogni provider TMDB non in whitelist è ignorato. Deduplica via Set.
 *  Un canonico che comparirebbe in entrambe resta SOLO in sub (l'abbonamento
 *  ha precedenza: se un film è incluso nell'abbonamento, il noleggio è
 *  irrilevante per l'utente). */
async function tmdbProviders(tmdbId) {
  const data = await apiFetch(
    `https://api.themoviedb.org/3/movie/${tmdbId}/watch/providers?api_key=${TMDB_API_KEY}`
  );
  const it = data?.results?.IT || {};

  const canon = arr => [
    ...new Set(
      (arr || [])
        .filter(p => IT_PROVIDERS[p.provider_id])
        .map(p => IT_PROVIDERS[p.provider_id])
    ),
  ];

  const sub  = canon([...(it.flatrate || []), ...(it.free || []), ...(it.ads || [])]);
  const rentRaw = canon([...(it.rent || []), ...(it.buy || [])]);

  // Rimuovo dal noleggio i canonici già coperti dall'abbonamento
  const subSet = new Set(sub);
  const rent = rentRaw.filter(name => !subSet.has(name));

  return { sub, rent };
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

  // Piattaforme — richiede una chiamata API separata.
  // sub  → abbonamento/gratis (flatrate+free+ads) → colonna "Piattaforme"
  // rent → noleggio/acquisto  (rent+buy)          → colonna "Piattaforme_noleggio"
  const { sub, rent } = await tmdbProviders(best.id);
  update['Piattaforme']          = sub;
  update['Piattaforme_noleggio'] = rent;

  // Poster — già nel risultato search, condizionato alla soglia confidenza
  if (bestScore >= 0.65 && best.poster_path) {
    update['poster_url'] = `${POSTER_BASE}${best.poster_path}`;
  }

  // Voto IMDB — già nel risultato search, zero chiamate extra
  const voto = best.vote_average;
  if (typeof voto === 'number' && voto > 0) {
    update['Voto IMDB'] = Math.round(voto * 10) / 10;
  }

  return { id, update };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('═══════════════════════════════════════════════════════');
  console.log('  Swainz DB Update   |   ' + new Date().toISOString());
  console.log('═══════════════════════════════════════════════════════');

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !TMDB_API_KEY) {
    throw new Error(
      'Variabili d\'ambiente mancanti! Controlla: ' +
      'SUPABASE_URL, SUPABASE_SERVICE_KEY, TMDB_API_KEY'
    );
  }

  // Paginazione a cursore: più robusta di .range() con qualsiasi impostazione max_rows
  const allFilms = [];
  const PAGE = 500;
  let lastId = 0;
  while (true) {
    const { data, error } = await DB
      .from('Movies')
      .select('id, Titolo, Anno')
      .order('id', { ascending: true })
      .gt('id', lastId)
      .limit(PAGE);
    if (error) throw new Error('Supabase fetch error: ' + error.message);
    if (!data?.length) break;
    allFilms.push(...data);
    lastId = data[data.length - 1].id;
    if (data.length < PAGE) break;
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
