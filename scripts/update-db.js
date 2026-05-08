/**
 * Swainz – Daily DB Update  (con batch rotation)
 *
 * PROBLEMA: OMDB free = 1000 req/giorno → con 4-5k film non basta fare tutto in un giorno.
 * SOLUZIONE: ogni giorno si aggiorna un batch di ~950 film (margine di sicurezza).
 *            La rotazione è deterministica sul giorno: nessuno stato esterno da salvare.
 *
 *  Esempio con 5000 film / BATCH_SIZE=950:
 *    numBatches = ceil(5000 / 950) = 6
 *    Ogni giorno un batch diverso → ciclo completo in 6 giorni
 *
 * TMDB (piattaforme) non ha limiti significativi → si aggiorna insieme al batch OMDB.
 *
 * Fonti:
 *  - TMDB API  → watch/providers Italia + imdb_id
 *  - OMDB API  → Voto IMDB reale (via imdb_id)
 *
 * Variabili d'ambiente:
 *  SUPABASE_URL          https://xxxx.supabase.co
 *  SUPABASE_SERVICE_KEY  service_role key (scrittura DB)
 *  OMDB_API_KEY          omdbapi.com – free: 1000 req/giorno
 *  TMDB_API_KEY          themoviedb.org – free, nessun limite significativo
 *  BATCH_SIZE            (opzionale, default 950)
 */

'use strict';

const SUPA_URL   = process.env.SUPABASE_URL  || 'https://dhddiepwazmkezyhxahe.supabase.co';
const SUPA_KEY   = process.env.SUPABASE_SERVICE_KEY;
const OMDB_KEY   = process.env.OMDB_API_KEY;
const TMDB_KEY   = process.env.TMDB_API_KEY;
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || '950', 10);

// Provider TMDB → nome piattaforma nel DB (Italia)
const PROVIDER_MAP = {
  8:   'Netflix',
  119: 'Prime Video',
  337: 'Disney+',
  11:  'MUBI',
  350: 'Apple TV',
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

// ─── Supabase helpers ──────────────────────────────────────────────────────

async function getAllFilms() {
  const all = [];
  let offset = 0;
  const step  = 500;
  while (true) {
    const res = await fetch(
      `${SUPA_URL}/rest/v1/Movies?select=ID,Titolo,Anno,Piattaforme,"Voto IMDB"&order=ID&limit=${step}&offset=${offset}`,
      { headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` } }
    );
    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) break;
    all.push(...data);
    if (data.length < step) break;
    offset += step;
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
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Supabase PATCH failed (${res.status}): ${txt}`);
  }
}

// ─── TMDB helpers ──────────────────────────────────────────────────────────

async function searchTMDB(title, year) {
  // 1) con anno
  let url = `https://api.themoviedb.org/3/search/movie?api_key=${TMDB_KEY}&query=${encodeURIComponent(title)}&year=${year}&language=it-IT`;
  let data = await safeJSON(url);
  let result = data.results?.[0];

  // 2) senza anno (fallback)
  if (!result) {
    data = await safeJSON(
      `https://api.themoviedb.org/3/search/movie?api_key=${TMDB_KEY}&query=${encodeURIComponent(title)}`
    );
    result = (data.results || []).find(r => Math.abs((r.release_date?.slice(0,4)|0) - year) <= 2)
          || data.results?.[0];
  }
  if (!result) return null;

  // external_ids per avere imdb_id
  await sleep(80);
  const ext = await safeJSON(
    `https://api.themoviedb.org/3/movie/${result.id}/external_ids?api_key=${TMDB_KEY}`
  ).catch(() => ({}));

  return { tmdbId: result.id, imdbId: ext.imdb_id || null };
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

// ─── OMDB helper ──────────────────────────────────────────────────────────

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

// ─── Selezione batch giornaliero ──────────────────────────────────────────

/**
 * Restituisce il sottoinsieme di film da elaborare oggi.
 *
 * Algoritmo:
 *   dayIndex  = giorni trascorsi dall'epoch Unix (deterministico, stesso per tutte le run dello stesso giorno)
 *   numBatches = ceil(totalFilms / BATCH_SIZE)
 *   batchIndex = dayIndex % numBatches          ← quale batch tocca oggi
 *   batch      = films[ batchIndex*size .. (batchIndex+1)*size ]
 *
 * Proprietà:
 *   - Nessuno stato da salvare (basato solo sulla data)
 *   - Si scala automaticamente all'aumentare dei film nel DB
 *   - Si aggiusta da solo se qualche giorno il job non gira
 */
function selectTodaysBatch(films) {
  const numBatches  = Math.ceil(films.length / BATCH_SIZE);
  const dayIndex    = Math.floor(Date.now() / 86400000);   // giorni da epoch
  const batchIndex  = dayIndex % numBatches;
  const start       = batchIndex * BATCH_SIZE;
  const end         = Math.min(start + BATCH_SIZE, films.length);
  const batch       = films.slice(start, end);

  return { batch, batchIndex, numBatches, start, end };
}

// ─── main ─────────────────────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║   Swainz – Daily DB Update (batch)       ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log(`Started:    ${new Date().toISOString()}`);
  console.log(`Batch size: ${BATCH_SIZE} film/giorno\n`);

  if (!SUPA_KEY || !OMDB_KEY || !TMDB_KEY) {
    console.error('❌ Variabili mancanti: SUPABASE_SERVICE_KEY, OMDB_API_KEY, TMDB_API_KEY');
    process.exit(1);
  }

  // Recupera tutti i film dal DB (solo per determinare la dimensione e l'ordine)
  const allFilms = await getAllFilms();
  console.log(`Film totali nel DB: ${allFilms.length}`);

  // Selezione batch odierno
  const { batch, batchIndex, numBatches, start, end } = selectTodaysBatch(allFilms);

  console.log(`\n📦 Batch ${batchIndex + 1} di ${numBatches}`);
  console.log(`   Film ${start + 1}–${end} (${batch.length} film)`);
  console.log(`   Ciclo completo ogni ${numBatches} giorni`);
  console.log(`   Prossimo batch: film ${(end % allFilms.length) + 1}–${Math.min(end + BATCH_SIZE, allFilms.length)}\n`);

  const stats   = { checked: 0, updated: 0, errors: 0 };
  const changes = [];

  for (let i = 0; i < batch.length; i++) {
    const film  = batch[i];
    const patch = {};

    try {
      // TMDB: cerca il film per ottenere tmdbId + imdbId
      const tmdb = await searchTMDB(film.Titolo, film.Anno);
      await sleep(120);

      // Piattaforme (solo se trovato su TMDB)
      if (tmdb?.tmdbId) {
        const newPlt = await getPlatformsIT(tmdb.tmdbId);
        await sleep(100);

        const curPlt  = film.Piattaforme
          ? film.Piattaforme.split(', ').filter(Boolean)
          : [];
        const sortNew = [...newPlt].sort().join(', ');
        const sortCur = [...curPlt].sort().join(', ');

        if (sortNew !== sortCur) {
          patch.Piattaforme = newPlt.join(', ');
          changes.push({ id: film.ID, title: film.Titolo, field: 'Piattaforme', from: sortCur || '(nessuna)', to: sortNew || '(nessuna)' });
        }
      }

      // Voto IMDB tramite OMDB
      const newRating = await getIMDBRating(film.Titolo, film.Anno, tmdb?.imdbId);
      await sleep(150);

      if (newRating !== null) {
        const curRating = parseFloat(film['Voto IMDB'] || 0);
        if (Math.abs(newRating - curRating) >= 0.1) {
          patch['Voto IMDB'] = newRating;
          changes.push({ id: film.ID, title: film.Titolo, field: 'Voto IMDB', from: curRating, to: newRating });
        }
      }

      // Applica patch se ci sono modifiche
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

    // Progresso ogni 100 film
    if ((i + 1) % 100 === 0) {
      console.log(`  … ${i + 1}/${batch.length} (${Math.round((i+1)/batch.length*100)}%)`);
    }
  }

  // ── Riepilogo ─────────────────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════');
  console.log(`Elaborati: ${stats.checked} | Aggiornati: ${stats.updated} | Errori: ${stats.errors}`);
  console.log(`Prossimo batch domani: ${numBatches > 1 ? `film ${end + 1}–${Math.min(end + BATCH_SIZE, allFilms.length)}` : 'tutto il DB (1 batch)'}`);

  if (changes.length > 0) {
    console.log('\n📋 Modifiche apportate:');
    changes.forEach(c =>
      console.log(`  [${c.id}] ${c.title} — ${c.field}: "${c.from}" → "${c.to}"`)
    );
  } else {
    console.log('\n✅ Nessuna modifica necessaria nel batch di oggi.');
  }

  console.log(`\nFinished: ${new Date().toISOString()}`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
