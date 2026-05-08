/**
 * Swainz – Daily DB Update  (con batch rotation + matching migliorato)
 *
 * MATCHING STRATEGY:
 *  1. Cerca su TMDB per titolo + anno esatto
 *  2. Verifica che il risultato abbia anno ≤ ±1 dal nostro
 *  3. Verifica similarità titolo ≥ 0.6 (evita false corrispondenze su titoli brevi/comuni)
 *  4. Se la confidenza è bassa → salta piattaforme (meglio non aggiornare che sbagliare)
 *  5. Logga i match incerti per revisione manuale
 *
 * OMDB (Voto IMDB): cerca per imdb_id se disponibile, altrimenti titolo+anno.
 *
 * BATCH ROTATION:
 *  BATCH_SIZE film/giorno (default 950, entro il limite OMDB free 1000/day)
 *  Rotazione deterministica sul giorno → ciclo completo ogni ceil(tot/950) giorni
 */

'use strict';

const SUPA_URL   = process.env.SUPABASE_URL  || 'https://dhddiepwazmkezyhxahe.supabase.co';
const SUPA_KEY   = process.env.SUPABASE_SERVICE_KEY;
const OMDB_KEY   = process.env.OMDB_API_KEY;
const TMDB_KEY   = process.env.TMDB_API_KEY;
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || '950', 10);

// Provider TMDB flatrate → nome piattaforma nel DB (catalogo Italia)
const PROVIDER_MAP = {
  8:   'Netflix',        // Netflix IT
  119: 'Prime Video',   // Amazon Prime Video IT
  337: 'Disney+',       // Disney Plus IT
  11:  'MUBI',          // MUBI IT
  350: 'Apple TV',      // Apple TV+ IT
};

// ─── helpers ───────────────────────────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function safeJSON(url, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      if (i === retries) throw e;
      await sleep(600 * (i + 1));
    }
  }
}

/**
 * Similarità tra due stringhe (Dice coefficient sui bigrammi).
 * Restituisce un valore tra 0 (nessuna somiglianza) e 1 (identici).
 * Usato per validare che il film trovato su TMDB sia effettivamente il nostro.
 */
function stringSimilarity(a, b) {
  const norm = s => s.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
  a = norm(a); b = norm(b);
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const bigrams = s => {
    const bg = new Map();
    for (let i = 0; i < s.length - 1; i++) {
      const bg2 = s.slice(i, i + 2);
      bg.set(bg2, (bg.get(bg2) || 0) + 1);
    }
    return bg;
  };
  const bgA = bigrams(a), bgB = bigrams(b);
  let intersection = 0;
  bgA.forEach((count, key) => { if (bgB.has(key)) intersection += Math.min(count, bgB.get(key)); });
  return (2 * intersection) / (a.length - 1 + b.length - 1);
}

// ─── Supabase ──────────────────────────────────────────────────────────────

async function getAllFilms() {
  const all = [];
  let offset = 0;
  while (true) {
    const res = await fetch(
      `${SUPA_URL}/rest/v1/Movies?select=ID,Titolo,Anno,Piattaforme,"Voto IMDB"&order=ID&limit=500&offset=${offset}`,
      { headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` } }
    );
    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) break;
    all.push(...data);
    if (data.length < 500) break;
    offset += 500;
  }
  return all;
}

async function patchFilm(id, patch) {
  const res = await fetch(`${SUPA_URL}/rest/v1/Movies?ID=eq.${id}`, {
    method: 'PATCH',
    headers: {
      apikey: SUPA_KEY,
      Authorization: `Bearer ${SUPA_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`Supabase PATCH ${res.status}: ${await res.text()}`);
}

// ─── TMDB ──────────────────────────────────────────────────────────────────

/**
 * Cerca il film su TMDB con validazione robusta.
 * Restituisce { tmdbId, imdbId, confidence, matchTitle } oppure null.
 * confidence = 'high' | 'low' | 'skip'
 */
async function searchTMDB(title, year) {
  const YEAR_TOLERANCE = 1;       // anno ± 1 anno
  const SIM_THRESHOLD  = 0.50;    // similarità titolo minima accettata
  const SIM_HIGH       = 0.75;    // soglia per confidenza "high"

  const trySearch = async (q, y) => {
    const url = `https://api.themoviedb.org/3/search/movie?api_key=${TMDB_KEY}&query=${encodeURIComponent(q)}${y ? `&year=${y}` : ''}&language=it-IT`;
    const data = await safeJSON(url);
    return data.results || [];
  };

  // Raccoglie candidati: prima con anno, poi senza anno come fallback
  let candidates = await trySearch(title, year);
  if (candidates.length === 0) {
    await sleep(80);
    candidates = await trySearch(title, null);
  }

  // Filtra per anno (± YEAR_TOLERANCE)
  const byYear = candidates.filter(r => {
    const ry = parseInt(r.release_date?.slice(0, 4) || '0', 10);
    return Math.abs(ry - year) <= YEAR_TOLERANCE;
  });

  // Lavora con i candidati filtrati per anno se esistono, altrimenti con tutti
  const pool = byYear.length > 0 ? byYear : candidates;
  if (pool.length === 0) return null;

  // Trova il candidato con la maggiore similarità di titolo
  let best = null, bestSim = -1;
  for (const r of pool) {
    // Confronta con titolo italiano, titolo originale e titolo TMDB
    const sims = [r.title, r.original_title, r.name].filter(Boolean)
      .map(t => stringSimilarity(title, t));
    const sim = Math.max(...sims);
    if (sim > bestSim) { bestSim = sim; best = r; }
  }

  // Rifiuta match troppo incerti
  if (bestSim < SIM_THRESHOLD) {
    return { tmdbId: null, imdbId: null, confidence: 'skip',
      matchTitle: best?.title, matchSim: bestSim.toFixed(2) };
  }

  const confidence = bestSim >= SIM_HIGH ? 'high' : 'low';

  await sleep(80);
  const ext = await safeJSON(
    `https://api.themoviedb.org/3/movie/${best.id}/external_ids?api_key=${TMDB_KEY}`
  ).catch(() => ({}));

  return {
    tmdbId: best.id,
    imdbId: ext.imdb_id || null,
    confidence,
    matchTitle: best.title,
    matchSim: bestSim.toFixed(2),
  };
}

async function getPlatformsIT(tmdbId) {
  const data = await safeJSON(
    `https://api.themoviedb.org/3/movie/${tmdbId}/watch/providers?api_key=${TMDB_KEY}`
  );
  const flatrate = data.results?.IT?.flatrate || [];
  return flatrate
    .filter(p => PROVIDER_MAP[p.provider_id])
    .map(p => PROVIDER_MAP[p.provider_id]);
}

// ─── OMDB ──────────────────────────────────────────────────────────────────

async function getIMDBRating(title, year, imdbId) {
  const url = imdbId
    ? `https://www.omdbapi.com/?apikey=${OMDB_KEY}&i=${imdbId}`
    : `https://www.omdbapi.com/?apikey=${OMDB_KEY}&t=${encodeURIComponent(title)}&y=${year}&type=movie`;
  const data = await safeJSON(url).catch(() => ({}));
  if (data.Response === 'True' && data.imdbRating && data.imdbRating !== 'N/A') {
    return parseFloat(data.imdbRating);
  }
  return null;
}

// ─── Batch selection ───────────────────────────────────────────────────────

function selectTodaysBatch(films) {
  const numBatches = Math.ceil(films.length / BATCH_SIZE);
  const dayIndex   = Math.floor(Date.now() / 86400000);
  const batchIndex = dayIndex % numBatches;
  const start      = batchIndex * BATCH_SIZE;
  const end        = Math.min(start + BATCH_SIZE, films.length);
  return { batch: films.slice(start, end), batchIndex, numBatches, start, end };
}

// ─── main ─────────────────────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║   Swainz – Daily DB Update               ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log(`Started:    ${new Date().toISOString()}`);
  console.log(`Batch size: ${BATCH_SIZE} film/giorno\n`);

  if (!SUPA_KEY || !OMDB_KEY || !TMDB_KEY) {
    console.error('❌ Variabili mancanti: SUPABASE_SERVICE_KEY, OMDB_API_KEY, TMDB_API_KEY');
    process.exit(1);
  }

  const allFilms = await getAllFilms();
  console.log(`Film totali nel DB: ${allFilms.length}`);

  const { batch, batchIndex, numBatches, start, end } = selectTodaysBatch(allFilms);
  console.log(`\n📦 Batch ${batchIndex + 1}/${numBatches} — film ${start + 1}–${end} (${batch.length} film)`);
  console.log(`   Ciclo completo ogni ${numBatches} giorni\n`);

  const stats   = { checked: 0, updated: 0, errors: 0, skipped: 0, lowConf: 0 };
  const changes = [];
  const warnings = [];

  for (let i = 0; i < batch.length; i++) {
    const film  = batch[i];
    const patch = {};

    try {
      const tmdb = await searchTMDB(film.Titolo, film.Anno);
      await sleep(120);

      if (!tmdb) {
        // Nessun risultato TMDB: salta piattaforme, prova solo IMDB via titolo
      } else if (tmdb.confidence === 'skip') {
        // Titolo troppo dissimile: non aggiornare piattaforme
        stats.skipped++;
        warnings.push(`  ⚠ SKIP match incerto [${film.ID}] "${film.Titolo}" → trovato "${tmdb.matchTitle}" (sim=${tmdb.matchSim})`);
      } else {
        // Match trovato
        if (tmdb.confidence === 'low') {
          stats.lowConf++;
          warnings.push(`  ℹ LOW CONF [${film.ID}] "${film.Titolo}" → "${tmdb.matchTitle}" (sim=${tmdb.matchSim}) — piattaforme aggiornate comunque`);
        }

        // Piattaforme
        const newPlt = await getPlatformsIT(tmdb.tmdbId);
        await sleep(100);

        const curPlt  = film.Piattaforme ? film.Piattaforme.split(', ').filter(Boolean) : [];
        const sortNew = [...newPlt].sort().join(', ');
        const sortCur = [...curPlt].sort().join(', ');

        if (sortNew !== sortCur) {
          patch.Piattaforme = newPlt.join(', ');
          changes.push({ id: film.ID, title: film.Titolo, field: 'Piattaforme', from: sortCur || '(nessuna)', to: sortNew || '(nessuna)' });
        }

        // Voto IMDB (usa imdb_id da TMDB se disponibile)
        const newRating = await getIMDBRating(film.Titolo, film.Anno, tmdb.imdbId);
        await sleep(150);

        if (newRating !== null) {
          const curRating = parseFloat(film['Voto IMDB'] || 0);
          if (Math.abs(newRating - curRating) >= 0.1) {
            patch['Voto IMDB'] = newRating;
            changes.push({ id: film.ID, title: film.Titolo, field: 'Voto IMDB', from: curRating, to: newRating });
          }
        }
      }

      if (Object.keys(patch).length > 0) {
        await patchFilm(film.ID, patch);
        stats.updated++;
        console.log(`  ✏  [${String(film.ID).padStart(4)}] ${film.Titolo} → ${Object.keys(patch).join(', ')}`);
      }

      stats.checked++;
    } catch (e) {
      stats.errors++;
      console.error(`  ✗  [${film.ID}] ${film.Titolo}: ${e.message}`);
    }

    if ((i + 1) % 100 === 0) {
      console.log(`  … ${i + 1}/${batch.length} (${Math.round((i+1)/batch.length*100)}%)`);
    }
  }

  // ── Riepilogo ─────────────────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════');
  console.log(`Elaborati: ${stats.checked} | Aggiornati: ${stats.updated} | Saltati (match incerto): ${stats.skipped} | Bassa confidenza: ${stats.lowConf} | Errori: ${stats.errors}`);

  if (warnings.length > 0) {
    console.log('\n⚠ Match incerti / bassa confidenza (verificare manualmente):');
    warnings.forEach(w => console.log(w));
  }

  if (changes.length > 0) {
    console.log('\n📋 Modifiche apportate:');
    changes.forEach(c => console.log(`  [${c.id}] ${c.title} — ${c.field}: "${c.from}" → "${c.to}"`));
  } else {
    console.log('\n✅ Nessuna modifica necessaria nel batch di oggi.');
  }

  console.log(`\nFinished: ${new Date().toISOString()}`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
