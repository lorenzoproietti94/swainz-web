/**
 * Swainz — wl-alerts.js  (v1, ottobre 2026, con la v438 del sito)
 * ─────────────────────────────────────────────────────────────────────────────
 * Avvisi email di “Lo guarderò” per gli utenti Premium che li hanno attivati
 * nel Profilo (user_data.wl_alerts.on = true).
 *
 * Gira ogni mattina (workflow .github/workflows/wl-alerts.yml, dopo update-db):
 *   1. TRACCIAMENTO (ogni giorno). Per ogni utente idoneo e ogni film della sua
 *      lista non ancora visto confronta le piattaforme in abbonamento di oggi
 *      (colonna Piattaforme, solo le 15 di SW_PLAT_SUB: niente noleggio) con
 *      quelle registrate in sw_wl_alerts:
 *        - film mai osservato  → tutte le piattaforme attuali “known” (nessun
 *          avviso: se e' gia' su Netflix l'utente lo sa) + riga segnaposto '*';
 *        - piattaforma nuova   → “pending” se e' tra quelle dell'utente
 *          (FCK q7b; se non ha risposto, tutte), altrimenti “known”;
 *        - “pending” la cui piattaforma e' sparita prima dell'invio → cancellata.
 *      Righe dei film usciti dalla lista o segnati come visti → cancellate.
 *      Utenti non piu' idonei (non Premium o avvisi spenti) → righe cancellate,
 *      cosi' alla riattivazione si riparte senza una valanga di avvisi.
 *   2. INVIO (solo il venerdi', ora di Roma, oppure SEND=yes). Una email per
 *      utente con tutti i film “pending”, via API di Brevo; dopo ogni invio
 *      riuscito le righe diventano “sent” (mai due avvisi per lo stesso film
 *      sulla stessa piattaforma).
 *
 * Secret: SUPABASE_URL, SUPABASE_SERVICE_KEY (come update-db), BREVO_API_KEY.
 * Opzioni (variabili d'ambiente, impostate dal workflow):
 *   SEND        auto (default: invia solo il venerdi') · yes · no
 *   ONLY_EMAIL  invia solo a questo indirizzo (prove); il tracciamento resta per tutti
 *   DRY_RUN     1/true: nessuna scrittura e nessun invio, solo resoconto e anteprima
 * Nessuna dipendenza npm (fetch nativo di Node 18+).
 */
import fs from 'fs';

const SUPABASE_URL = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
const SERVICE_KEY  = (process.env.SUPABASE_SERVICE_KEY || '').trim();
const BREVO_KEY    = (process.env.BREVO_API_KEY || '').trim();
const SEND         = (process.env.SEND || 'auto').trim().toLowerCase();
const ONLY_EMAIL   = (process.env.ONLY_EMAIL || '').trim().toLowerCase();
const DRY_RUN      = /^(1|true|yes)$/i.test((process.env.DRY_RUN || '').trim());
const SENDER       = { name: 'Swainz', email: (process.env.SENDER_EMAIL || 'noreply@swainz.it').trim() };
const SITE         = 'https://swainz.it';
const BREVO_URL    = (process.env.BREVO_URL || 'https://api.brevo.com/v3/smtp/email').trim();
const PAGE = 500, MAX_FILMS_IN_EMAIL = 20, MAX_EMAILS_PER_RUN = 250;

// Le 15 piattaforme in abbonamento del sito (SW_PLAT_SUB, index.html): niente noleggio
const SW_PLAT_SUB = ['Netflix','Prime Video','Apple TV','Disney+','Sky Go','Paramount+','TIMVISION','NowTV','Infinity','MUBI','RaiPlay','YouTube Premium','Crunchyroll','MGM+','HBO Max'];
const SUB = new Set(SW_PLAT_SUB);

// ── normalizzazione dei nomi (stessa di _safeArr del sito e di recommend) ──
function fixName(x) {
  const s = String(x).trim().replace(/^"|"$/g, '');
  if (s === 'Apple TV+') return 'Apple TV';
  if (/^rai\s*play$/i.test(s)) return 'RaiPlay';
  if (/^mediaset\s*infinity$/i.test(s) || s === 'Infinity+' || s === 'Infinity Selection') return 'Infinity';
  if (/^now\s*tv$/i.test(s) || s === 'NOW' || s === 'Now') return 'NowTV';
  if (/^paramount(\s*plus|\+)?$/i.test(s)) return 'Paramount+';
  if (/^timvision$/i.test(s)) return 'TIMVISION';
  if (/^google\s*play(\s*movies)?$/i.test(s)) return 'Google Play';
  if (/^sky\s*go$/i.test(s)) return 'Sky Go';
  if (/^youtube\s*premium$/i.test(s)) return 'YouTube Premium';
  if (/^mgm(\s*plus|\+)?$/i.test(s)) return 'MGM+';
  if (/^hbo\s*max$/i.test(s)) return 'HBO Max';
  if (/^crunchyroll$/i.test(s)) return 'Crunchyroll';
  if (/^chili$/i.test(s)) return 'CHILI';
  return s;
}
function safeArr(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v.filter(Boolean).map(fixName);
  let s = String(v).trim();
  if (s.charAt(0) === '[') {
    try { const a = JSON.parse(s); if (Array.isArray(a)) return a.filter(Boolean).map(fixName); } catch (e) { /* sotto */ }
    s = s.slice(1, s.length - 1);
  }
  if (s.charAt(0) === '{') s = s.slice(1, s.length - 1);
  return s.split(',').map(fixName).filter(Boolean);
}
const subPlatforms = (row) => new Set(safeArr(row.Piattaforme).filter((p) => SUB.has(p)));

// ── accesso a Supabase (PostgREST con la service role) ────────────────────
function hdr(extra = {}) {
  return { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', ...extra };
}
async function rest(method, path, body, prefer) {
  const res = await fetch(`${SUPABASE_URL}${path}`, {
    method, headers: hdr(prefer ? { Prefer: prefer } : {}), body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null; try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
  if (res.status < 200 || res.status >= 300) {
    const hint = (res.status === 401 || res.status === 403) ? ' — controlla il secret SUPABASE_SERVICE_KEY' :
      /PGRST205|42P01|sw_wl_alerts|wl_alerts|42703/.test(text) ? ' — hai eseguito sql/swainz_alerts_v438.sql?' : '';
    throw new Error(`${method} ${path.split('?')[0]}: HTTP ${res.status} ${text.slice(0, 300)}${hint}`);
  }
  return data;
}
async function getAll(table, query, order) {
  const out = [];
  for (let off = 0; ; ) {
    const rows = await rest('GET', `/rest/v1/${table}?${query}&order=${order}&limit=${PAGE}&offset=${off}`);
    out.push(...rows); off += rows.length;
    if (rows.length < PAGE) break;
  }
  return out;
}
const q = (v) => '"' + String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';   // valore tra virgolette per in.(...)
const inList = (arr) => encodeURIComponent('(' + arr.map(q).join(',') + ')');
const chunks = (arr, n) => { const o = []; for (let i = 0; i < arr.length; i += n) o.push(arr.slice(i, i + n)); return o; };

// ── utilità ───────────────────────────────────────────────────────────────
const isTrue = (v) => v === true || v === 'true';
function romeWeekday(d = new Date()) {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Rome', weekday: 'short' }).format(d);
}
function userPlatforms(fck) {
  if (fck && fck.q7 === 'yes' && Array.isArray(fck.q7b)) {
    const s = new Set(fck.q7b.map(fixName).filter((p) => SUB.has(p)));
    if (s.size) return s;
  }
  return new Set(SW_PLAT_SUB);  // nessuna risposta: tutte le piattaforme in abbonamento
}
function watchIds(wl) {
  if (!Array.isArray(wl)) return [];
  return [...new Set(wl.map((e) => Number(e && typeof e === 'object' ? e.id : e)).filter((n) => Number.isFinite(n) && n > 0))];
}
function seenIds(v) {
  const s = new Set();
  (Array.isArray(v) ? v : []).forEach((x) => { const n = Number(x); if (Number.isFinite(n)) s.add(n); });
  return s;
}
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const joinList = (arr, lang) => arr.length < 2 ? arr.join('') : arr.slice(0, -1).join(', ') + (lang === 'en' ? ' and ' : ' e ') + arr[arr.length - 1];

// ── email ─────────────────────────────────────────────────────────────────
const TXT = {
  it: {
    kicker: 'Lo guarderò · avvisi della settimana',
    subj1: (t, p) => `🎬 ${t} è arrivato su ${p}`,
    subjN: (n) => `🎬 ${n} film della tua lista sono arrivati sulle tue piattaforme`,
    hello: (n) => n ? `Ciao ${n},` : 'Ciao,',
    intro1: 'questa settimana un film che hai segnato come “Lo guarderò” è arrivato in abbonamento su una delle tue piattaforme:',
    introN: 'questa settimana alcuni film che hai segnato come “Lo guarderò” sono arrivati in abbonamento sulle tue piattaforme:',
    on: 'ora su', more: (n) => `…e altri ${n} film: li trovi tutti nella tua lista.`,
    btn: 'Apri la tua lista',
    why: 'Ricevi questa email perché hai attivato gli avvisi di “Lo guarderò” nel tuo profilo Swainz (Premium). Ti scriviamo al massimo una volta a settimana, solo quando ci sono novità.',
    unsub: 'Disattiva gli avvisi', src: 'Disponibilità in streaming: JustWatch',
  },
  en: {
    kicker: 'Watch later · weekly alerts',
    subj1: (t, p) => `🎬 ${t} is now on ${p}`,
    subjN: (n) => `🎬 ${n} films on your list just landed on your platforms`,
    hello: (n) => n ? `Hi ${n},` : 'Hi,',
    intro1: 'this week a film you marked “Watch later” became available on one of your streaming subscriptions:',
    introN: 'this week some films you marked “Watch later” became available on your streaming subscriptions:',
    on: 'now on', more: (n) => `…and ${n} more: find them all in your list.`,
    btn: 'Open your list',
    why: 'You get this email because you turned on “Watch later” alerts in your Swainz profile (Premium). We write at most once a week, only when there is news.',
    unsub: 'Turn off alerts', src: 'Streaming availability: JustWatch',
  },
};
export function buildEmail({ lang, name, items, unsubUrl }) {
  const L = TXT[lang === 'en' ? 'en' : 'it'];
  const shown = items.slice(0, MAX_FILMS_IN_EMAIL), extra = items.length - shown.length;
  const subject = items.length === 1 ? L.subj1(items[0].title, joinList(items[0].platforms, lang)) : L.subjN(items.length);
  const listUrl = `${SITE}/raccomandazioni`;
  const rows = shown.map((it) => {
    const img = it.poster
      ? `<img src="${esc(it.poster)}" width="56" height="84" alt="" style="display:block;width:56px;height:84px;border-radius:6px;object-fit:cover;border:0;">`
      : `<div style="width:56px;height:84px;border-radius:6px;background:#2c2d31;"></div>`;
    const badges = it.platforms.map((p) => `<span style="display:inline-block;margin:4px 6px 0 0;padding:3px 9px;border-radius:999px;background:#141518;border:1px solid #ff7a18;color:#ffb45e;font-size:12px;font-weight:bold;">${esc(p)}</span>`).join('');
    return `<tr><td style="padding:10px 0;border-top:1px solid #2c2d31;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
<td valign="top" style="padding-right:14px;">${img}</td>
<td valign="top" style="font-family:Arial,Helvetica,sans-serif;">
<div style="font-size:16px;font-weight:bold;color:#ffffff;line-height:21px;">${esc(it.title)}${it.year ? ` <span style="font-weight:normal;color:#9aa1ab;">(${esc(it.year)})</span>` : ''}</div>
<div style="font-size:12px;color:#9aa1ab;margin-top:4px;">${esc(L.on)}</div><div>${badges}</div></td>
</tr></table></td></tr>`;
  }).join('');
  const html = `<!DOCTYPE html>
<html lang="${lang === 'en' ? 'en' : 'it'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Swainz</title></head>
<body style="margin:0;padding:0;background:#141518;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#141518;">
<tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;background:#1f2024;border:1px solid #3a2a1e;border-radius:14px;">
<tr><td style="padding:28px 28px 8px 28px;font-family:Arial,Helvetica,sans-serif;font-size:22px;font-weight:bold;letter-spacing:4px;color:#ff7a18;">SWAINZ</td></tr>
<tr><td style="padding:0 28px;font-family:Arial,Helvetica,sans-serif;font-size:12px;letter-spacing:2px;color:#9aa1ab;text-transform:uppercase;">${esc(L.kicker)}</td></tr>
<tr><td style="padding:22px 28px 4px 28px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:22px;color:#d5d9e0;">${esc(L.hello(name))}<br>${esc(items.length === 1 ? L.intro1 : L.introN)}</td></tr>
<tr><td style="padding:8px 28px 4px 28px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${rows}</table></td></tr>
${extra > 0 ? `<tr><td style="padding:4px 28px 0 28px;font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#9aa1ab;">${esc(L.more(extra))}</td></tr>` : ''}
<tr><td align="center" style="padding:22px 28px 26px 28px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td style="border-radius:10px;background:#ff7a18;">
<a href="${listUrl}" style="display:inline-block;padding:13px 26px;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:bold;color:#ffffff;text-decoration:none;">${esc(L.btn)}</a>
</td></tr></table></td></tr>
<tr><td style="padding:14px 28px 22px 28px;border-top:1px solid #2c2d31;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:18px;color:#7d848e;">${esc(L.why)}<br><a href="${esc(unsubUrl)}" style="color:#ffb45e;">${esc(L.unsub)}</a><br><span style="color:#5f656e;">${esc(L.src)}</span></td></tr>
</table>
<p style="font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#5f656e;margin:16px 0 0 0;">Swainz · swainz.it</p>
</td></tr></table>
</body></html>`;
  const text = [L.hello(name), items.length === 1 ? L.intro1 : L.introN, '',
    ...shown.map((it) => `• ${it.title}${it.year ? ` (${it.year})` : ''} — ${L.on} ${it.platforms.join(', ')}`),
    ...(extra > 0 ? [L.more(extra)] : []), '', `${L.btn}: ${listUrl}`, '', L.why, `${L.unsub}: ${unsubUrl}`, L.src].join('\n');
  return { subject, html, text };
}

async function sendBrevo(to, name, mail) {
  const res = await fetch(BREVO_URL, {
    method: 'POST',
    headers: { 'api-key': BREVO_KEY, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ sender: SENDER, to: [name ? { email: to, name } : { email: to }], subject: mail.subject,
      htmlContent: mail.html, textContent: mail.text, tags: ['wl-alerts'] }),
  });
  const text = await res.text();
  if (res.status === 201 || res.status === 200) return { ok: true };
  const hint = res.status === 401 ? ' — chiave BREVO_API_KEY non valida, oppure Brevo blocca l’indirizzo IP del server di GitHub (Brevo → Impostazioni → Sicurezza → IP autorizzati → Disattiva per API)'
    : res.status === 400 && /sender/i.test(text) ? ` — il mittente ${SENDER.email} non è verificato in Brevo` : '';
  return { ok: false, fatal: res.status === 401, msg: `HTTP ${res.status} ${text.slice(0, 200)}${hint}` };
}

// ── programma ─────────────────────────────────────────────────────────────
async function main() {
  if (!SUPABASE_URL || !SERVICE_KEY) throw new Error('Mancano i secret SUPABASE_URL / SUPABASE_SERVICE_KEY');
  const now = new Date().toISOString();
  const doSend = SEND === 'yes' || (SEND === 'auto' && romeWeekday() === 'Fri');
  if (doSend && !BREVO_KEY && !DRY_RUN) throw new Error('Manca il secret BREVO_API_KEY');
  console.log(`wl-alerts v1 · ${now} · invio: ${doSend ? 'sì' : 'no'} (SEND=${SEND}, giorno a Roma: ${romeWeekday()})${ONLY_EMAIL ? ' · solo ' + ONLY_EMAIL : ''}${DRY_RUN ? ' · PROVA (nessuna scrittura)' : ''}`);

  // 1. utenti idonei: Premium con avvisi accesi
  const users = (await getAll('user_data',
    'select=user_id,email,nome,is_premium,watchlist,seen_film_ids,fck_answers,wl_alerts&is_premium=eq.true&wl_alerts->>on=eq.true', 'user_id'))
    .filter((u) => u.user_id && isTrue(u.is_premium) && u.wl_alerts && isTrue(u.wl_alerts.on));
  const byUser = new Map(); users.forEach((u) => { if (!byUser.has(u.user_id)) byUser.set(u.user_id, u); });
  const uids = [...byUser.keys()];
  console.log(`Utenti con avvisi attivi: ${uids.length}`);

  // 2. pulizia: righe di utenti non piu' idonei
  if (!DRY_RUN) {
    const all = await getAll('sw_wl_alerts', 'select=user_id', 'user_id');
    const stale = [...new Set(all.map((r) => r.user_id))].filter((id) => !byUser.has(id));
    for (const c of chunks(stale, 100)) await rest('DELETE', `/rest/v1/sw_wl_alerts?user_id=in.${inList(c)}`);
    if (stale.length) console.log(`Righe tolte per ${stale.length} utenti non più idonei`);
  }

  // 3. film delle liste (non visti)
  const active = new Map();   // uid -> Set(film_id)
  const filmIds = new Set();
  for (const [uid, u] of byUser) {
    const seen = seenIds(u.seen_film_ids);
    const s = new Set(watchIds(u.watchlist).filter((id) => !seen.has(id)));
    active.set(uid, s); s.forEach((id) => filmIds.add(id));
  }
  const films = new Map();
  for (const c of chunks([...filmIds], 150)) {
    const rows = await rest('GET', `/rest/v1/Movies?select=id,Titolo,Anno,poster_url,Piattaforme&id=in.(${c.join(',')})`);
    rows.forEach((r) => films.set(Number(r.id), r));
  }
  console.log(`Film nelle liste: ${filmIds.size} (trovati nel catalogo: ${films.size})`);

  // 4. stato attuale
  const existing = new Map();   // uid -> Map(film -> Map(platform -> row))
  for (const c of chunks(uids, 100)) {
    const rows = await getAll('sw_wl_alerts', `select=user_id,film_id,platform,status&user_id=in.${inList(c)}`, 'user_id,film_id,platform');
    rows.forEach((r) => {
      if (!existing.has(r.user_id)) existing.set(r.user_id, new Map());
      const m = existing.get(r.user_id); const f = Number(r.film_id);
      if (!m.has(f)) m.set(f, new Map());
      m.get(f).set(r.platform, r);
    });
  }

  // 5. confronto
  const inserts = [], delFilms = [], delRows = [], pendingByUser = new Map();
  let nBaseline = 0, nNew = 0;
  for (const uid of uids) {
    const u = byUser.get(uid), plats = userPlatforms(u.fck_answers), act = active.get(uid);
    const mine = existing.get(uid) || new Map();
    for (const f of mine.keys()) if (!act.has(f) || !films.has(f)) delFilms.push({ uid, f });
    for (const f of act) {
      const film = films.get(f); if (!film) continue;
      const cur = subPlatforms(film), rows = mine.get(f);
      if (!rows) {   // prima osservazione: niente avvisi per cio' che c'e' gia'
        nBaseline++;
        inserts.push({ user_id: uid, film_id: f, platform: '*', status: 'known' });
        cur.forEach((p) => inserts.push({ user_id: uid, film_id: f, platform: p, status: 'known' }));
        continue;
      }
      const pend = [];
      cur.forEach((p) => {
        const r = rows.get(p);
        if (!r) {
          const st = plats.has(p) ? 'pending' : 'known';
          inserts.push({ user_id: uid, film_id: f, platform: p, status: st, detected_at: st === 'pending' ? now : null });
          if (st === 'pending') { pend.push(p); nNew++; }
        } else if (r.status === 'pending' && plats.has(p)) pend.push(p);
      });
      rows.forEach((r, p) => { if (r.status === 'pending' && p !== '*' && !cur.has(p)) delRows.push({ uid, f, p }); });
      if (pend.length) {
        if (!pendingByUser.has(uid)) pendingByUser.set(uid, []);
        pendingByUser.get(uid).push({ film_id: f, title: film.Titolo || '', year: film.Anno || '', poster: film.poster_url || '',
          platforms: SW_PLAT_SUB.filter((p) => pend.includes(p)) });
      }
    }
  }
  console.log(`Film osservati per la prima volta: ${nBaseline} · nuovi arrivi da avvisare: ${nNew} · utenti con avvisi in attesa: ${pendingByUser.size}`);

  if (!DRY_RUN) {
    for (const c of chunks(inserts, 500)) await rest('POST', '/rest/v1/sw_wl_alerts', c, 'resolution=ignore-duplicates,return=minimal');
    const byU = new Map(); delFilms.forEach(({ uid, f }) => { if (!byU.has(uid)) byU.set(uid, []); byU.get(uid).push(f); });
    for (const [uid, fs_] of byU) for (const c of chunks(fs_, 150))
      await rest('DELETE', `/rest/v1/sw_wl_alerts?user_id=eq.${uid}&film_id=in.(${c.join(',')})`);
    for (const { uid, f, p } of delRows)
      await rest('DELETE', `/rest/v1/sw_wl_alerts?user_id=eq.${uid}&film_id=eq.${f}&platform=eq.${encodeURIComponent(p)}`);
    console.log(`Scritture: ${inserts.length} righe nuove, ${delFilms.length} film tolti, ${delRows.length} avvisi annullati (piattaforma sparita)`);
  }

  // 6. invio
  if (!doSend) { console.log('Oggi niente invio.'); return; }
  // indirizzo: colonna email di user_data, altrimenti quello dell'account (Auth)
  const emails = new Map();
  for (const uid of pendingByUser.keys()) {
    let email = String(byUser.get(uid).email || '').trim();
    if (!email) {
      try { const a = await rest('GET', `/auth/v1/admin/users/${uid}`); email = String((a && (a.email || (a.user && a.user.email))) || '').trim(); } catch (e) { /* sotto */ }
    }
    emails.set(uid, email);
  }
  let targets = [...pendingByUser.keys()];
  if (ONLY_EMAIL) targets = targets.filter((uid) => emails.get(uid).toLowerCase() === ONLY_EMAIL);
  if (targets.length > MAX_EMAILS_PER_RUN) {
    console.log(`[AVVISO] ${targets.length} email da inviare: ne invio ${MAX_EMAILS_PER_RUN} (limite del piano gratuito di Brevo), le altre restano in attesa`);
    targets = targets.slice(0, MAX_EMAILS_PER_RUN);
  }
  if (!targets.length) { console.log('Nessuna email da inviare.'); return; }
  const tokens = new Map();
  if (!DRY_RUN) for (const c of chunks(targets, 200)) {
    const rows = await rest('POST', '/rest/v1/rpc/sw_wl_unsub_tokens', { p_uids: c });
    rows.forEach((r) => tokens.set(r.user_id, r.token));
  }
  let sent = 0, failed = 0;
  for (const uid of targets) {
    const u = byUser.get(uid);
    const email = emails.get(uid);
    const lang = u.wl_alerts && u.wl_alerts.lang === 'en' ? 'en' : 'it';
    const items = pendingByUser.get(uid).sort((a, b) => a.title.localeCompare(b.title, 'it'));
    const unsubUrl = `${SITE}/disiscrizione?u=${uid}&t=${tokens.get(uid) || 'ANTEPRIMA'}&l=${lang}`;
    const mail = buildEmail({ lang, name: String(u.nome || '').trim(), items, unsubUrl });
    if (DRY_RUN) {
      console.log(`[PROVA] a ${email || '(nessun indirizzo)'}: "${mail.subject}" · ${items.length} film`);
      if (!sent) { fs.writeFileSync('wl-alerts-anteprima.html', mail.html); console.log('Anteprima scritta in wl-alerts-anteprima.html'); }
      sent++; continue;
    }
    if (!email) { console.log(`[ERRORE] utente ${uid}: indirizzo email non trovato`); failed++; continue; }
    const r = await sendBrevo(email, String(u.nome || '').trim(), mail);
    if (!r.ok) {
      failed++; console.log(`[ERRORE] invio a ${email.replace(/(^.).*(@.*$)/, '$1***$2')}: ${r.msg}`);
      if (r.fatal) throw new Error('Invio interrotto: ' + r.msg);
      continue;
    }
    sent++;
    for (const it of items)
      await rest('PATCH', `/rest/v1/sw_wl_alerts?user_id=eq.${uid}&film_id=eq.${it.film_id}&status=eq.pending&platform=in.${inList(it.platforms)}`,
        { status: 'sent', sent_at: new Date().toISOString() }, 'return=minimal');
    await new Promise((ok) => setTimeout(ok, 250));
  }
  console.log(`Email inviate: ${sent}${failed ? ` · non inviate: ${failed}` : ''}`);
  if (failed) process.exitCode = 1;
}

if (process.argv[1] && process.argv[1].endsWith('wl-alerts.js')) {
  main().catch((e) => { console.error('ERRORE: ' + (e && e.message ? e.message : e)); process.exit(1); });
}
