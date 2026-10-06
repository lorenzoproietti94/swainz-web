/**
 * Swainz — backup-db.js  (v3, ottobre 2026)
 * ─────────────────────────────────────────────────────────────────────────────
 * Esporta ogni notte le tabelle di Supabase in un unico file JSON. Il workflow
 * .github/workflows/backup-db.yml lo comprime, lo cifra (AES-256, chiave nel
 * secret BACKUP_PASSPHRASE) e lo conserva come artifact per 30 giorni.
 *
 * Perché: il piano gratuito di Supabase non fa backup automatici. Copre la
 * perdita di dati nelle tabelle (es. una query sbagliata), non la perdita
 * dell'intero progetto: lo schema auth (account, password) resta a Supabase.
 *
 * v3 — Aggiunta la tabella sw_wl_alerts (avvisi email di “Lo guarderò”, sito v438).
 * v2 — Pagine da 500 righe come il sito e update-db.js, avanzamento in base alle
 *      righe ricevute (funziona con qualunque limite "max rows" del progetto),
 *      barra finale tolta da SUPABASE_URL, tabella "mancante" solo se lo dice
 *      PostgREST (PGRST205/42P01), errori con stato e risposta completi.
 *
 * Usa gli stessi secret di update-db.js: SUPABASE_URL, SUPABASE_SERVICE_KEY.
 * Nessuna dipendenza npm (fetch nativo di Node 18+).
 *
 * Uscita: <cartella>/swainz-backup.json  { manifest, tables: { nome: [righe] } }
 * Errore (workflow fallito → email di GitHub) se:
 *   - una tabella obbligatoria non si legge;
 *   - Movies ha meno di MIN_MOVIES righe (catalogo svuotato per errore).
 */
import fs from 'fs';
import path from 'path';

const SUPABASE_URL         = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
const SUPABASE_SERVICE_KEY = (process.env.SUPABASE_SERVICE_KEY || '').trim();
const MIN_MOVIES           = parseInt(process.env.MIN_MOVIES || '1000', 10);
const PAGE                 = 500;

// order: chiave stabile per la paginazione; required: errore se manca
const TABLES = [
  { name: 'Movies',       order: 'id',              required: true  },
  { name: 'user_data',    order: 'user_id',         required: true  },
  { name: 'sw_rec_log',   order: 'user_id,film_id', required: false },
  { name: 'search_usage', order: 'user_id,day',     required: false },
  { name: 'sw_api_usage', order: null,              required: false },
  { name: 'sw_wl_alerts', order: 'user_id,film_id,platform', required: false },   // v3: avvisi di Lo guarderò (v438)
];

function headers(extra = {}) {
  return { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, ...extra };
}

async function getPage(table, order, offset, wantCount) {
  const q = new URLSearchParams({ select: '*', limit: String(PAGE), offset: String(offset) });
  if (order) q.set('order', order);
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${encodeURIComponent(table)}?${q}`, {
    headers: headers(wantCount ? { Prefer: 'count=exact' } : {}),
  });
  const text = await res.text();
  let body = null; try { body = JSON.parse(text); } catch (e) {}
  return { status: res.status, body, range: res.headers.get('content-range') };
}

async function exportTable(t) {
  let order = t.order, rows = [], total = null;
  for (let offset = 0; ; ) {
    let r = await getPage(t.name, order, offset, offset === 0);
    if (r.status === 400 && order && offset === 0) {          // colonna d'ordine diversa da quella attesa
      console.log(`  [AVVISO] ${t.name}: ordinamento "${order}" non accettato (${JSON.stringify(r.body).slice(0, 160)}), esporto senza ordine`);
      order = null; r = await getPage(t.name, null, 0, true);
    }
    const raw = JSON.stringify(r.body || '');
    if (/PGRST205|42P01|Could not find the table|does not exist/i.test(raw) && r.status >= 400) {
      return { missing: true };
    }
    if (r.status < 200 || r.status >= 300 || !Array.isArray(r.body)) {
      const hint = r.status === 404 ? ' — indirizzo non trovato: controlla il secret SUPABASE_URL (deve essere https://<progetto>.supabase.co)'
                 : (r.status === 401 || r.status === 403) ? ' — accesso negato: controlla il secret SUPABASE_SERVICE_KEY (serve la service_role key)' : '';
      throw new Error(`${t.name}: HTTP ${r.status} ${raw.slice(0, 300)}${hint}`);
    }
    if (offset === 0 && r.range && r.range.includes('/')) {
      const n = parseInt(r.range.split('/')[1], 10); if (!isNaN(n)) total = n;
    }
    rows.push(...r.body);
    offset += r.body.length;
    // fine: pagina vuota, oppure raggiunto il totale dichiarato, oppure (senza totale) pagina corta
    if (!r.body.length || (total !== null ? rows.length >= total : r.body.length < PAGE)) break;
  }
  if (total !== null && rows.length !== total) {
    throw new Error(`${t.name}: esportate ${rows.length} righe su ${total} attese`);
  }
  return { rows, ordered: !!order };
}

async function main() {
  const outDir = process.argv[2] || 'backup-out';
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) throw new Error('Mancano SUPABASE_URL o SUPABASE_SERVICE_KEY');
  console.log(`Progetto: ${SUPABASE_URL.replace(/^https?:\/\//, '').split('.')[0]} · pagine da ${PAGE} righe`);
  fs.mkdirSync(outDir, { recursive: true });

  const started = new Date().toISOString();
  const tables = {}, counts = {}, notes = [];
  for (const t of TABLES) {
    const r = await exportTable(t);
    if (r.missing) {
      if (t.required) throw new Error(`Tabella obbligatoria non trovata: ${t.name}`);
      notes.push(`${t.name}: non trovata, saltata`); console.log(`  [SALTATA] ${t.name}: non trovata`);
      continue;
    }
    tables[t.name] = r.rows; counts[t.name] = r.rows.length;
    console.log(`  [OK] ${t.name}: ${r.rows.length} righe`);
  }
  if ((counts.Movies || 0) < MIN_MOVIES) {
    throw new Error(`Movies ha solo ${counts.Movies || 0} righe (minimo atteso ${MIN_MOVIES}): backup NON salvato, controlla il catalogo`);
  }
  const manifest = { app: 'swainz', format: 1, started, finished: new Date().toISOString(), counts, notes };
  fs.writeFileSync(path.join(outDir, 'swainz-backup.json'), JSON.stringify({ manifest, tables }));
  fs.writeFileSync(path.join(outDir, 'counts.json'), JSON.stringify(manifest, null, 2)); // solo conteggi, per il riepilogo
  console.log('\nBackup pronto:', JSON.stringify(counts));
}

main().catch(e => { console.error('\nFATAL:', e.message); process.exit(1); });
