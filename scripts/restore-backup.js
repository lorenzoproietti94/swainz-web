/**
 * Swainz — restore-backup.js  (v1, ottobre 2026)
 * ─────────────────────────────────────────────────────────────────────────────
 * Legge un backup cifrato prodotto da backup-db.yml e, a richiesta, rimette le
 * righe in una tabella di Supabase. Da lanciare sul proprio computer (Node 18+).
 * La decifratura è fatta in Node: non serve openssl installato.
 *
 * Variabili d'ambiente: BACKUP_PASSPHRASE (sempre), SUPABASE_URL e
 * SUPABASE_SERVICE_KEY (solo con --apply).
 *
 * Esempi:
 *   node scripts/restore-backup.js swainz-backup-2026-10-02.json.gz.enc
 *        → riepilogo del backup (tabelle e righe)
 *   node scripts/restore-backup.js FILE --extract copia.json
 *        → salva il contenuto in chiaro (contiene dati personali: cancellalo dopo l'uso)
 *   node scripts/restore-backup.js FILE --table user_data --where user_id=<uuid>
 *        → PROVA: mostra cosa verrebbe ripristinato, non scrive nulla
 *   node scripts/restore-backup.js FILE --table user_data --where user_id=<uuid> --apply
 *        → scrive davvero (upsert: aggiorna le righe esistenti, crea le mancanti,
 *          non cancella nulla)
 *
 * Sicurezza: senza --apply non scrive mai. Per user_data le colonne di Stripe e
 * is_premium NON vengono ripristinate (le gestisce il webhook), salvo
 * --with-billing. Senza --where su user_data serve anche --all-rows.
 */
import fs from 'fs';
import zlib from 'zlib';
import crypto from 'crypto';

const KEYS = { Movies: 'id', user_data: 'user_id', sw_rec_log: 'user_id,film_id', search_usage: 'user_id,day',
               sw_wl_alerts: 'user_id,film_id,platform' };   // v438: avvisi di Lo guarderò
const BILLING = ['is_premium', 'stripe_customer_id', 'stripe_subscription_id', 'subscription_status'];

function arg(name) { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; }
function flag(name) { return process.argv.includes(name); }

// formato di "openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -md sha256 -salt"
function decrypt(buf, pass) {
  if (buf.subarray(0, 8).toString('latin1') !== 'Salted__') throw new Error('File non riconosciuto (manca l\'intestazione di openssl)');
  const salt = buf.subarray(8, 16);
  const kiv = crypto.pbkdf2Sync(Buffer.from(pass, 'utf8'), salt, 200000, 48, 'sha256');
  const d = crypto.createDecipheriv('aes-256-cbc', kiv.subarray(0, 32), kiv.subarray(32, 48));
  try { return Buffer.concat([d.update(buf.subarray(16)), d.final()]); }
  catch (e) { throw new Error('Decifratura non riuscita: BACKUP_PASSPHRASE sbagliata o file danneggiato'); }
}

async function upsert(table, rows) {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('Per --apply servono SUPABASE_URL e SUPABASE_SERVICE_KEY');
  const conflict = KEYS[table];
  if (!conflict) throw new Error(`Tabella ${table}: chiave di ripristino non definita in KEYS`);
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const res = await fetch(`${url}/rest/v1/${encodeURIComponent(table)}?on_conflict=${encodeURIComponent(conflict)}`, {
      method: 'POST',
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json',
                 Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(chunk),
    });
    if (!res.ok) throw new Error(`Scrittura ${table} righe ${i + 1}-${i + chunk.length}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
    console.log(`  scritte ${i + chunk.length}/${rows.length}`);
  }
}

async function main() {
  const file = process.argv[2];
  const pass = process.env.BACKUP_PASSPHRASE;
  if (!file || file.startsWith('--')) throw new Error('Indica il file del backup (…json.gz.enc)');
  if (!pass) throw new Error('Manca BACKUP_PASSPHRASE');
  const data = JSON.parse(zlib.gunzipSync(decrypt(fs.readFileSync(file), pass)).toString('utf8'));
  const m = data.manifest || {};
  console.log(`Backup del ${m.finished || '?'} — righe: ${JSON.stringify(m.counts || {})}`);

  const out = arg('--extract');
  if (out) { fs.writeFileSync(out, JSON.stringify(data, null, 1)); console.log(`Salvato in chiaro in ${out}: contiene dati personali, cancellalo dopo l'uso.`); return; }

  const table = arg('--table');
  if (!table) return;
  let rows = (data.tables || {})[table];
  if (!Array.isArray(rows)) throw new Error(`La tabella ${table} non è nel backup`);

  const where = arg('--where');
  if (where) {
    const [col, ...v] = where.split('='); const val = v.join('=');
    rows = rows.filter(r => String(r[col]) === val);
  } else if (table === 'user_data' && !flag('--all-rows')) {
    throw new Error('Per user_data indica --where user_id=<uuid>, oppure --all-rows per tutte le righe');
  }
  if (table === 'user_data' && !flag('--with-billing')) {
    rows = rows.map(r => { const c = { ...r }; BILLING.forEach(k => delete c[k]); return c; });
  }
  console.log(`\n${table}: ${rows.length} righe selezionate${where ? ` (${where})` : ''}`);
  rows.slice(0, 3).forEach(r => console.log('  es.', JSON.stringify(r).slice(0, 180)));
  if (!rows.length) return;
  if (!flag('--apply')) { console.log('\nPROVA: nulla è stato scritto. Aggiungi --apply per ripristinare.'); return; }
  await upsert(table, rows);
  console.log('Ripristino completato.');
}

main().catch(e => { console.error('\nERRORE:', e.message); process.exit(1); });
