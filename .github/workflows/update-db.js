// scripts/update-db.js  — Swainz daily DB updater (with poster_url support)
// Unchanged logic for IMDB rating + piattaforme; adds poster_url fetch from TMDB.

const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_KEY;
const OMDB_KEY      = process.env.OMDB_API_KEY;
const TMDB_KEY      = process.env.TMDB_API_KEY;

const TMDB_IMG_BASE = 'https://image.tmdb.org/t/p/w342';
const BATCH_SIZE    = 950;    // max per day (OMDB free limit)
const SLEEP_MS      = 400;    // ms between film requests

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── helpers ──────────────────────────────────────────────────────────────────

async function supaFetch(path, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      ...opts.headers,
    },
    ...opts,
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  return res.json().catch(() => null);
}

// Dice-coefficient string similarity (title matching)
function dice(a, b) {
  if (!a || !b) return 0;
  a = a.toLowerCase().replace(/[^a-z0-9 ]/g, '');
  b = b.toLowerCase().replace(/[^a-z0-9 ]/g, '');
  if (a === b) return 1;
  const biA = new Set(), biB = new Set();
  for (let i = 0; i < a.length - 1; i++) biA.add(a[i] + a[i + 1]);
  for (let i = 0; i < b.length - 1; i++) biB.add(b[i] + b[i + 1]);
  let inter = 0;
  biA.forEach(g => { if (biB.has(g)) inter++; });
  return (2 * inter) / (biA.size + biB.size);
}

// ── TMDB: search film → get imdb_id + poster_path + watch providers ──────────

async function tmdbSearch(title, year) {
  const url = `https://api.themoviedb.org/3/search/movie?api_key=${TMDB_KEY}&query=${encodeURIComponent(title)}&year=${year}&language=it-IT`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json();
  if (!data.results?.length) return null;

  // pick best match by title similarity
  let best = null, bestScore = 0;
  for (const r of data.results.slice(0, 5)) {
    const score = Math.max(dice(r.title, title), dice(r.original_title, title));
    if (score > bestScore) { bestScore = score; best = r; }
  }
  if (!bestScore || bestScore < 0.4) return null;
  return best; // { id, title, original_title, poster_path, ... }
}

async function tmdbDetails(tmdbId) {
  const url = `https://api.themoviedb.org/3/movie/${tmdbId}?api_key=${TMDB_KEY}&append_to_response=watch/providers`;
  const res = await fetch(url);
  if (!res.ok) return null;
  return res.json();
}

async function tmdbProviders(tmdbId) {
  const url = `https://api.themoviedb.org/3/movie/${tmdbId}/watch/providers?api_key=${TMDB_KEY}`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const data = await res.json();
  const it = data.results?.IT;
  if (!it) return [];
  const providers = new Set();
  const MAP = {
    'Netflix': 'Netflix', 'Prime Video': 'Prime Video', 'Amazon Prime Video': 'Prime Video',
    'Disney Plus': 'Disney+', 'Disney+': 'Disney+', 'MUBI': 'MUBI',
    'Apple TV Plus': 'Apple TV', 'Apple TV+': 'Apple TV',
  };
  for (const p of [...(it.flatrate || []), ...(it.free || [])]) {
    const name = MAP[p.provider_name];
    if (name) providers.add(name);
  }
  return [...providers];
}

// ── OMDB: get precise IMDB rating ──────────────────────────────────────────

async function omdbRating(imdbId) {
  if (!imdbId) return null;
  const url = `https://www.omdbapi.com/?i=${imdbId}&apikey=${OMDB_KEY}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json();
  const r = parseFloat(data.imdbRating);
  return isNaN(r) ? null : r;
}

// ── batch selection (day-based rotation) ────────────────────────────────────

async function getTodaysBatch(all) {
  const total = all.length;
  const numBatches = Math.ceil(total / BATCH_SIZE);
  const dayIndex = Math.floor(Date.now() / (1000 * 60 * 60 * 24));
  const batchIndex = dayIndex % numBatches;
  const start = batchIndex * BATCH_SIZE;
  const end   = Math.min(start + BATCH_SIZE, total);
  console.log(`📦 Batch ${batchIndex + 1}/${numBatches} — film ${start + 1}–${end} of ${total}`);
  return all.slice(start, end);
}

// ── main ─────────────────────────────────────────────────────────────────────

(async () => {
  // fetch all films from Supabase
  const all = [];
  let page = 0;
  const step = 1000;
  while (true) {
    const rows = await supaFetch(`Movies?select=ID,Titolo,Regista,Anno,Piattaforme,"Voto IMDB",poster_url&limit=${step}&offset=${page * step}&order=ID`);
    if (!rows?.length) break;
    all.push(...rows);
    if (rows.length < step) break;
    page++;
  }
  console.log(`📽  Loaded ${all.length} films from Supabase`);

  const batch = await getTodaysBatch(all);
  let updated = 0, errors = 0;

  for (const film of batch) {
    const id      = film.ID;
    const title   = film.Titolo || '';
    const year    = film.Anno   || 0;
    const changes = {};

    try {
      // 1. TMDB search
      const tmdb = await tmdbSearch(title, year);
      if (!tmdb) { await sleep(SLEEP_MS); continue; }

      const LOW_CONF = dice(tmdb.title, title) < 0.65 && dice(tmdb.original_title, title) < 0.65;

      // 2. Poster URL (save/update if missing or LOW_CONF skip)
      if (!film.poster_url && tmdb.poster_path && !LOW_CONF) {
        changes['poster_url'] = `${TMDB_IMG_BASE}${tmdb.poster_path}`;
      }

      // 3. TMDB details for IMDB id
      const details = await tmdbDetails(tmdb.id);
      await sleep(100);
      const imdbId = details?.imdb_id;

      // 4. OMDB rating
      if (imdbId) {
        const r = await omdbRating(imdbId);
        if (r !== null) {
          const current = parseFloat(film['Voto IMDB']) || 0;
          if (Math.abs(r - current) >= 0.1) {
            changes['Voto IMDB'] = String(r);
          }
        }
      }

      // 5. Platforms
      if (!LOW_CONF) {
        const providers = await tmdbProviders(tmdb.id);
        const newPlt = providers.join(', ');
        if (providers.length && newPlt !== (film.Piattaforme || '')) {
          changes['Piattaforme'] = newPlt;
        }
      }

      if (Object.keys(changes).length) {
        const label = LOW_CONF ? '[LOW CONF] ' : '';
        await supaFetch(`Movies?ID=eq.${id}`, {
          method: 'PATCH',
          headers: { Prefer: 'return=minimal' },
          body: JSON.stringify(changes),
        });
        console.log(`✅ [${id}] ${title} ${label}→`, Object.keys(changes).join(', '));
        updated++;
      }
    } catch (e) {
      console.error(`❌ [${id}] ${title}: ${e.message}`);
      errors++;
    }

    await sleep(SLEEP_MS);
  }

  console.log(`\n🎬 Done — ${updated} updated, ${errors} errors`);
})();
