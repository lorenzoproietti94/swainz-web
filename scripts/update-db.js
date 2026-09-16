/**
 * Swainz — update-db.js  (v200)
 * ─────────────────────────────────────────────────────────────────────────────
 * Aggiorna ogni notte le colonne:
 *   poster_url            → URL locandina TMDB (w342)
 *   Piattaforme           → piattaforme in ABBONAMENTO/gratis (flatrate+free+ads)
 *   Piattaforme_noleggio  → piattaforme a NOLEGGIO/ACQUISTO   (rent+buy)
 *   Voto IMDB             → vote_average da TMDB (scala 0–10, zero chiamate extra)
 *   Regista               → nome ufficiale TMDB, formato "Nome Cognome"
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
 * v200 — Il campo Regista viene ora preso da TMDB (endpoint /credits) nel
 *         formato ufficiale "Nome Cognome". Motivo: la colonna era stata
 *         compilata a mano nel tempo e conteneva formati MESCOLATI
 *         ("Coppola Francis Ford" accanto a "Francis Ford Coppola"), lo
 *         stesso regista come persone diverse (almeno 15 coppie), refusi
 *         ("Russel" per Russell, "Armirpour" per Amirpour) e record
 *         malformati. Uno scambio automatico nome/cognome non era
 *         praticabile: avrebbe invertito anche i nomi già corretti.
 *         Precauzioni: soglia di confidenza 0.75 (più severa del poster,
 *         perché un regista sbagliato passa inosservato e inquina ricerca
 *         e filtri); se TMDB non fornisce il dato il valore esistente NON
 *         viene toccato; oltre 4 registi il valore curato a mano è
 *         preferito. Più registi uniti con " & ". Ogni cambio è loggato.
 * v199 — Aggiunte a PROV_RENT: Rakuten TV (id 35, store puro) e TIMVISION Store
 *         (id 109, TIMVISION a noleggio, distinto dall'abbonamento). Microsoft
 *         Store non mappabile (assente dai provider TMDB per l'Italia).
 * v198 — Chip abbonamento/noleggio distinti per i brand misti. La whitelist
 *         unica IT_PROVIDERS è ora sdoppiata in PROV_SUB (flatrate+free+ads) e
 *         PROV_RENT (rent+buy); lo stesso provider_id può produrre nomi diversi
 *         nelle due colonne (es. Apple TV vs Apple TV Store; Prime Video vs
 *         Prime Video Store; YouTube Premium vs YouTube; Infinity vs Infinity
 *         Store). Store puri (Google Play, CHILI) presenti solo in PROV_RENT.
 *         Rimossa la deduplica cross-colonna (i nomi ora sono indipendenti).
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
const DELAY_MS     = 350;  // v200: da 280ms. La chiamata /credits porta le
                           // richieste per film da ~3 a ~4; il margine sul
                           // limite TMDB (40 req/10s) è garantito soprattutto
                           // dalla gestione del 429 in apiFetch.

/** Provider IDs TMDB → nome canonico Swainz (IT).
 *  DUE mappe distinte perché lo stesso provider può avere un nome diverso a
 *  seconda della sezione TMDB in cui compare per un dato film:
 *   - SUB  : sezioni flatrate/free/ads (abbonamento/gratis) → colonna Piattaforme
 *   - RENT : sezioni rent/buy (noleggio/acquisto) → colonna Piattaforme_noleggio
 *  Es. Apple (id 350) è "Apple TV" in abbonamento ma "Apple TV Store" a noleggio.
 *  Più ID possono puntare allo stesso canonico (accorpamento): la deduplica in
 *  tmdbProviders() li fonde. Un provider assente da una mappa è ignorato in
 *  quella sezione (es. Google Play non esiste in abbonamento). */
const PROV_SUB = {
  8:    'Netflix',
  119:  'Prime Video',   // Amazon Prime Video
  10:   'Prime Video',   // Amazon Video
  2100: 'Prime Video',   // Amazon Prime Video with Ads
  337:  'Disney+',
  350:  'Apple TV',      // Apple TV (abbonamento Apple TV+)
  2243: 'Apple TV',      // Apple TV Amazon Channel
  11:   'MUBI',          // MUBI
  201:  'MUBI',          // MUBI Amazon Channel
  222:  'RaiPlay',       // Rai Play (gratis)
  359:  'Infinity',      // Mediaset Infinity
  1726: 'Infinity',      // Infinity Selection Amazon Channel
  39:   'NowTV',         // Now TV
  29:   'Sky Go',
  531:  'Paramount+',    // Paramount Plus
  582:  'Paramount+',    // Paramount+ Amazon Channel
  109:  'TIMVISION',
  188:  'YouTube Premium',
  283:  'Crunchyroll',   // Crunchyroll
  1968: 'Crunchyroll',   // Crunchyroll Amazon Channel
  2141: 'MGM+',          // MGM Plus Amazon Channel
  1899: 'HBO Max',       // HBO Max
  1825: 'HBO Max',       // HBO Max Amazon Channel
};

const PROV_RENT = {
  // Store puri (esistono SOLO a noleggio/acquisto)
  3:    'Google Play',   // Google Play Movies
  40:   'CHILI',
  35:   'Rakuten TV',    // Rakuten TV (store puro)
  // Versioni-store dei brand misti (nome distinto dal chip abbonamento)
  350:  'Apple TV Store',      // Apple (a noleggio)
  2:    'Apple TV Store',      // Apple TV Store
  119:  'Prime Video Store',   // Prime (a noleggio)
  10:   'Prime Video Store',   // Amazon Video (a noleggio)
  188:  'YouTube',             // YouTube (a noleggio, distinto da YouTube Premium)
  359:  'Infinity Store',      // Mediaset Infinity (acquisti)
  1726: 'Infinity Store',      // Infinity Selection (acquisti)
  109:  'TIMVISION Store',     // TIMVISION (a noleggio, distinto dall'abbonamento)
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

async function apiFetch(url, _retry = 0) {
  const res = await fetch(url);

  // v200: gestione esplicita del rate limit TMDB (40 richieste / 10s).
  // Con la chiamata /credits le richieste per film sono passate da ~3 a ~4 e
  // su rete veloce il limite può essere raggiunto. Invece di irrigidire
  // l'attesa fissa (che rallenterebbe sempre, anche quando non serve),
  // si rispetta l'header Retry-After e si riprova: più efficiente e robusto.
  if (res.status === 429 && _retry < 3) {
    const wait = (parseInt(res.headers.get('Retry-After')) || 2) * 1000;
    console.log(`  [RATE] limite TMDB raggiunto, attendo ${wait}ms e riprovo`);
    await new Promise(r => setTimeout(r, wait));
    return apiFetch(url, _retry + 1);
  }

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
 *   sub  ← flatrate+free+ads  mappati con PROV_SUB   → colonna Piattaforme
 *   rent ← rent+buy           mappati con PROV_RENT  → colonna Piattaforme_noleggio
 *  I nomi delle due colonne sono INDIPENDENTI (es. Apple TV vs Apple TV Store),
 *  quindi non c'è più deduplica/precedenza cross-colonna: un film può legittima-
 *  mente essere "Apple TV" in sub e "Apple TV Store" in rent. Deduplica solo
 *  intra-colonna (accorpamento di più ID sullo stesso canonico). */
async function tmdbProviders(tmdbId) {
  const data = await apiFetch(
    `https://api.themoviedb.org/3/movie/${tmdbId}/watch/providers?api_key=${TMDB_API_KEY}`
  );
  const it = data?.results?.IT || {};

  const mapWith = (arr, table) => [
    ...new Set(
      (arr || [])
        .filter(p => table[p.provider_id])
        .map(p => table[p.provider_id])
    ),
  ];

  const sub  = mapWith([...(it.flatrate || []), ...(it.free || []), ...(it.ads || [])], PROV_SUB);
  const rent = mapWith([...(it.rent || []), ...(it.buy || [])], PROV_RENT);

  return { sub, rent };
}

// ─── TMDB: registi (nome nel formato ufficiale) ───────────────────────────────

/** Legge i crediti del film e restituisce i registi nel formato corretto
 *  ("Christopher Nolan", non "Nolan Christopher").
 *
 *  Perché: la colonna Regista è stata popolata a mano nel tempo e contiene
 *  formati mescolati ("Coppola Francis Ford" e "Francis Ford Coppola"),
 *  refusi ("Russel" per Russell) e record malformati. Uno scambio automatico
 *  di nome/cognome non è praticabile perché invertirebbe anche i nomi già
 *  corretti. TMDB è la fonte autorevole e risolve tutto insieme.
 *
 *  Più registi → uniti con " & " (stesso separatore già usato nel DB).
 *  Ritorna null se il dato non è disponibile: in quel caso il valore
 *  esistente NON viene toccato. */
async function tmdbDirectors(tmdbId) {
  const data = await apiFetch(
    `https://api.themoviedb.org/3/movie/${tmdbId}/credits?api_key=${TMDB_API_KEY}`
  );
  const crew = data?.crew;
  if (!Array.isArray(crew) || !crew.length) return null;

  const names = [
    ...new Set(
      crew
        .filter(p => p && p.job === 'Director' && typeof p.name === 'string')
        .map(p => p.name.trim())
        .filter(Boolean)
    ),
  ];
  if (!names.length) return null;

  // Limite di sicurezza: oltre 4 registi è quasi sempre un film collettivo o
  // un dato anomalo; meglio non sostituire il valore curato a mano.
  if (names.length > 4) return null;

  return names.join(' & ');
}

// ─── Elaborazione singolo film ────────────────────────────────────────────────

async function processFilm(film) {
  const { id, Titolo, Anno } = film;  // film.Regista usato nel confronto log

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

  // Regista — nome ufficiale TMDB, solo con match ad alta confidenza (>=0.75).
  // Soglia più severa del poster: un poster sbagliato si nota subito, un nome
  // di regista sbagliato passa inosservato e inquina ricerca e filtri.
  // Se TMDB non fornisce il dato, il valore esistente resta intatto.
  if (bestScore >= 0.75) {
    const dirs = await tmdbDirectors(best.id);
    if (dirs) {
      if (dirs !== film.Regista) {
        console.log(`           regista: "${film.Regista || '(vuoto)'}" → "${dirs}"`);
      }
      update['Regista'] = dirs;
    }
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
      .select('id, Titolo, Anno, Regista')  // v200: Regista serve per il log del cambio
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
