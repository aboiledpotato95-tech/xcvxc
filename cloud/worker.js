// QuickAns cloud - one Cloudflare Worker + one D1 database (binding DB). Secret: QA_KEY. No R2, no card.
// Everything lives in D1: account, spent ID cards, pre-IDs, history, photo/video previews, notifications, phones.
// Pictures are stored as base64 text in the "blobs" table, cut into pieces of 700 KB so no row passes D1's 2 MB row limit.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'X-Key,X-Meta,Content-Type',
  'Access-Control-Allow-Methods': 'GET,PUT,DELETE,OPTIONS',
  'Access-Control-Max-Age': '86400'
};
const json = (s, code = 200) => new Response(s, { status: code, headers: Object.assign({ 'Content-Type': 'application/json' }, CORS) });
const err = (m, code) => json(JSON.stringify({ error: m }), code);
const okId = s => /^[A-Za-z0-9_.-]{1,90}$/.test(s || '');
// ---------- protection: nothing is read into memory above these sizes, nothing grows without a limit ----------
const MB = 1024 * 1024;
const MAX_MEDIA = 8 * MB;       // one photo/video preview upload (small picture + preview)
const MAX_NOTIF = 15 * MB;      // one notification picture
const MAX_ACCT = 6 * MB;        // the ID card photo
const MAX_HIST = 16 * MB;       // one history answer
const MAX_DEV = 8 * 1024;       // one phone record
const MAX_DEVICES = 50;         // phones kept in the list
const MAX_PREID_OPEN = 20;      // unused pre-IDs at the same time
// refuses a too-big body BEFORE it is read (Content-Length), so a huge request never reaches memory
const tooBig = (req, max) => { const n = +req.headers.get('Content-Length'); return n > max ? err('request too large', 413) : null; };
// ---------- linking several clouds together (optional) ----------
// Set the SPOKE_URLS secret to a comma-separated list of other QuickAns clouds' addresses (each its own
// Cloudflare account + D1 database) to pool their storage. Every linked cloud uses the SAME CLOUD_KEY -
// there is no separate key per cloud. The phones and Drivi only ever talk to THIS cloud (the "hub"); this
// cloud quietly spreads new items across every linked cloud and merges listings back together.
const peers = (env, req) => (req && req.headers.get('X-Hop')) ? [''] : [''].concat(String(env.SPOKE_URLS || '').split(',').map(x => x.trim().replace(/\/+$/, '')).filter(Boolean));
const PROXY_TIMEOUT_MS = 20000;   // an unreachable or slow linked cloud is treated as "down" after this, never hangs the request
async function proxy(env, peer, method, path, body, extraHeaders) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), PROXY_TIMEOUT_MS);
  try {
    // X-Hop tells the receiving cloud "this already came through a hub" - it must answer using ONLY its own
    // storage this time, never its own SPOKE_URLS (if any were ever set there by mistake). This is what stops
    // a star from ever becoming an accidental, endlessly-forwarding loop, even if someone misconfigures a spoke.
    return await fetch(peer + path, { method, body, signal: ac.signal, headers: Object.assign({ 'X-Key': env.QA_KEY, 'X-Hop': '1' }, extraHeaders || {}) });
  } finally { clearTimeout(t); }
}
// a small counter (abusing the usage table's spare 'rot' row) so new items are spread round-robin across
// every linked cloud from the start, instead of filling this one before any other is touched
async function nextRot(env, n) {
  const row = await env.DB.prepare("SELECT bytes FROM usage WHERE k='rot'").first();
  const cur = row ? row.bytes : 0;
  await env.DB.prepare("INSERT INTO usage (k, bytes) VALUES ('rot', ?) ON CONFLICT(k) DO UPDATE SET bytes=excluded.bytes").bind((cur + 1) % Math.max(n, 1)).run();
  return cur % Math.max(n, 1);
}
// where a given id actually lives: '' = this cloud, a URL = that linked cloud, undefined = not known yet (new id)
async function locOf(env, id) {
  const r = await env.DB.prepare('SELECT peer FROM loc WHERE id=?').bind(id).first();
  return r ? r.peer : undefined;
}
async function locSet(env, id, kind, peer) {
  await env.DB.prepare('INSERT INTO loc (id, kind, peer) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET peer=excluded.peer').bind(id, kind, peer).run();
}
async function locDel(env, id) { await env.DB.prepare('DELETE FROM loc WHERE id=?').bind(id).run(); }
// creating or editing an item (media/notif/history, all share this): an EDIT of an id that already exists
// always goes back to the exact cloud it already lives on (so an edit can never leave a stale copy behind);
// a brand-new id is spread round-robin across every linked cloud that still has room.
async function createAcrossPeers(req, env, id, kind, path, max, localFn) {
  const big = tooBig(req, max); if (big) return big;
  const bodyBuf = await req.arrayBuffer();
  if (bodyBuf.byteLength > max) return err('too large', 413);
  const extra = {}; const xm = req.headers.get('X-Meta'); if (xm) extra['X-Meta'] = xm;
  const all = peers(env, req);
  if (all.length === 1) return localFn(bodyBuf);
  const existing = await locOf(env, id);
  if (existing !== undefined) {
    if (existing === '') return localFn(bodyBuf);
    try { return await proxy(env, existing, req.method, path, bodyBuf, extra); }
    catch (e) { return err("that item's cloud is unreachable right now", 502); }
  }
  const n0 = await nextRot(env, all.length);
  const order = all.slice(n0).concat(all.slice(0, n0));
  let lastErr = null;
  for (const peer of order) {
    let res;
    if (peer === '') res = await localFn(bodyBuf);
    else { try { res = await proxy(env, peer, req.method, path, bodyBuf, extra); } catch (e) { lastErr = err('a linked cloud is unreachable', 502); continue; } }
    if (res.status === 413 || res.status === 507) { lastErr = res; continue; }
    if (res.ok) await locSet(env, id, kind, peer);
    return res;
  }
  return lastErr || err('every linked cloud is full', 507);
}
// reading, viewing or deleting one existing item: find which cloud it's on and run there (proxying if it's
// a linked cloud) - never guesses, never scans every cloud for a single id
async function runAt(env, id, path, method, localFn, req) {
  if (peers(env, req).length === 1) return localFn();
  const peer = await locOf(env, id);
  if (peer === undefined || peer === '') return localFn();
  try { return await proxy(env, peer, method, path); }
  catch (e) { return err("that item's cloud is unreachable right now", 502); }
}
async function routedDelete(env, id, path, localFn, req) {
  const r = await runAt(env, id, path, 'DELETE', localFn, req);
  if (r.ok) await locDel(env, id);
  return r;
}
async function fetchPeerAll(env, peer, path) {
  let out = [], cur = '';
  for (let i = 0; i < 40; i++) {      // 40 x 1000 = up to 40,000 items from one cloud - plenty for a personal app
    const sep = path.indexOf('?') < 0 ? '?' : '&';
    const r = await proxy(env, peer, 'GET', path + sep + 'limit=1000' + (cur ? '&cursor=' + encodeURIComponent(cur) : ''));
    if (!r.ok) throw new Error('peer answered ' + r.status);
    const j = await r.json();
    out = out.concat(j.items || []);
    if (!j.cursor) break;
    cur = j.cursor;
  }
  return out;
}
async function fetchLocalAll(env, table, col) {
  let out = [], cur = '';
  for (let i = 0; i < 40; i++) {
    const rows = ((await env.DB.prepare('SELECT id, ' + col + ' AS m FROM ' + table + ' WHERE id > ? ORDER BY id LIMIT 1000').bind(cur).all()).results || []);
    out = out.concat(rows.map(x => JSON.parse(x.m)));
    if (rows.length < 1000) break;
    cur = rows[rows.length - 1].id;
  }
  return out;
}
// lists everything from THIS cloud and every linked cloud, merged into one answer. A linked cloud that's
// down is skipped (never blocks the rest) and noted in "failed" so Drivi can say so.
async function fanList(env, table, col, path, q, req) {
  const all = peers(env, req);
  if (all.length === 1) return json(await listRows(env, table, col, q));
  const settled = await Promise.allSettled(all.map(peer => peer === '' ? fetchLocalAll(env, table, col) : fetchPeerAll(env, peer, path)));
  let items = [], failed = [];
  settled.forEach((r, i) => { if (r.status === 'fulfilled') items = items.concat(r.value); else failed.push(all[i] || '(this cloud)'); });
  const seen = new Set(); items = items.filter(x => { const k = x && x.id; if (k === undefined) return true; if (seen.has(k)) return false; seen.add(k); return true; });   // same id on two clouds (a retry after a lost reply) shows once
  return json(JSON.stringify({ items, cursor: '', partial: failed.length > 0, failed }));
}
// runs a bulk delete (delete-range / delete-all) on THIS cloud and every linked cloud at once, so it never
// leaves items stranded on a cloud Drivi didn't reach, and sums up the total deleted.
async function fanDelete(env, path, localFn, req) {
  const all = peers(env, req);
  if (all.length === 1) return localFn();
  const settled = await Promise.allSettled(all.map(peer => (peer === '' ? localFn() : proxy(env, peer, 'DELETE', path)).then(r => r.json())));
  let deleted = 0, failed = [], locPromises = [];
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') { deleted += r.value.deleted || 0; if (Array.isArray(r.value.ids)) locPromises.push(...r.value.ids.map(x => locDel(env, x))); }
    else failed.push(all[i] || '(this cloud)');
  });
  await Promise.all(locPromises);
  return json(JSON.stringify({ ok: true, deleted, partial: failed.length > 0, failed }));
}
function same(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// ---------- pictures in D1: blobs(k, seq, d) - one picture = a few rows ----------
const CHUNK = 700 * 1024;
const DB_BUDGET = 480 * MB;     // one free D1 database's real hard cap is 500 MB (Cloudflare's own limit) - this leaves a safety margin.
                                // Raise it (e.g. 9500 * MB) only after upgrading THAT cloud to the $5/mo Workers Paid plan (10 GB/database).
const B64 = 1.34;               // pictures are stored as base64 text (see CHUNK above) - that is about 4/3 the real byte count, rounded up for safety
const used = env => env.DB.prepare("SELECT bytes FROM usage WHERE k='media'").first().then(r => r ? r.bytes : 0);
const usageAdd = (env, n) => env.DB.prepare("UPDATE usage SET bytes = MAX(0, bytes + ?) WHERE k='media'").bind(n);
const usageSub = (env, sql, ...a) => env.DB.prepare("UPDATE usage SET bytes = MAX(0, bytes - IFNULL((" + sql + "), 0)) WHERE k='media'").bind(...a);
const HIST_CAP = 80 * MB;      // kept back for saved history answers (plain text - no base64 overhead), out of the same DB_BUDGET
const MEDIA_CAP = Math.floor((DB_BUDGET - HIST_CAP) / B64);  // the rest, for photo/video previews - shrunk to allow for the base64 overhead above
const usedHist = env => env.DB.prepare("SELECT bytes FROM usage WHERE k='history'").first().then(r => r ? r.bytes : 0);
const histUsageAdd = (env, n) => env.DB.prepare("UPDATE usage SET bytes = MAX(0, bytes + ?) WHERE k='history'").bind(n);
const histUsageSub = (env, id) => env.DB.prepare(
  "UPDATE usage SET bytes = MAX(0, bytes - IFNULL((SELECT LENGTH(IFNULL(body,'')) + LENGTH(meta) FROM history WHERE id=?), 0)) WHERE k='history'"
).bind(id);
// recounts both usage rows from the real tables (fixes a counter that drifted, e.g. after a failed write)
async function recount(env) {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO usage (k, bytes) VALUES ('media', (SELECT IFNULL(SUM(CAST(json_extract(meta,'$.sz') AS INTEGER)),0) FROM media) + (SELECT IFNULL(SUM(CAST(json_extract(meta,'$.sz') AS INTEGER)),0) FROM notif)) ON CONFLICT(k) DO UPDATE SET bytes=excluded.bytes"),
    env.DB.prepare("INSERT INTO usage (k, bytes) VALUES ('history', (SELECT IFNULL(SUM(LENGTH(IFNULL(body,''))+LENGTH(meta)),0) FROM history)) ON CONFLICT(k) DO UPDATE SET bytes=excluded.bytes")
  ]);
}
let lastRecount = 0;
// "is there room?" - if the counter says full, recount once (at most every 10 minutes) before refusing, so a drifted counter cannot block uploads for good
async function roomFor(env, read, cap, n) {
  if ((await read(env)) + n <= cap) return true;
  if (Date.now() - lastRecount < 600000) return false;
  lastRecount = Date.now(); await recount(env);
  return (await read(env)) + n <= cap;
}
function b64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
  return btoa(s);
}
function unb64(t) {
  const s = atob(t), n = s.length, out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = s.charCodeAt(i);
  return out;
}
// statements that replace everything stored under key k
function blobPut(env, k, buf) {
  const bytes = new Uint8Array(buf), st = [env.DB.prepare('DELETE FROM blobs WHERE k=?').bind(k)];
  for (let i = 0, seq = 0; i < bytes.length; i += CHUNK, seq++)
    st.push(env.DB.prepare('INSERT INTO blobs (k, seq, d) VALUES (?, ?, ?)').bind(k, seq, b64(bytes.subarray(i, i + CHUNK))));
  return st;
}
async function blobGet(env, k) {
  const r = await env.DB.prepare('SELECT d FROM blobs WHERE k=? ORDER BY seq').bind(k).all();
  const rows = r.results || [];
  if (!rows.length) return null;
  const parts = rows.map(x => unb64(x.d));
  if (parts.length === 1) return parts[0];
  let n = 0; for (const p of parts) n += p.length;
  const out = new Uint8Array(n); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
function jpegResponse(bytes, cache) {
  return new Response(bytes, { headers: Object.assign({ 'Content-Type': 'image/jpeg', 'Cache-Control': cache }, CORS) });
}
// a page of list items: rows have id + meta (already JSON text, passed through untouched to stay fast)
async function listRows(env, table, col, q) {
  const lim = Math.min(1000, Math.max(1, +q.get('limit') || 500)), cur = q.get('cursor') || '';
  const r = await env.DB.prepare('SELECT id, ' + col + ' AS m FROM ' + table + ' WHERE id > ? ORDER BY id LIMIT ?').bind(cur, lim + 1).all();
  const rows = r.results || [], more = rows.length > lim, page = more ? rows.slice(0, lim) : rows;
  return '{"items":[' + page.map(x => x.m).join(',') + '],"cursor":' + JSON.stringify(more ? page[page.length - 1].id : '') + '}';
}
async function allIds(env, prefix) {
  const r = await env.DB.prepare('SELECT id FROM media WHERE substr(id, 1, ?) = ?').bind(prefix.length, prefix).all();
  return (r.results || []).map(x => x.id);
}
// body = [4 bytes meta length][meta json][4 bytes small-picture length][small picture][preview]
async function upload(buf, env, id) {
  if (buf.byteLength < 16) return err('empty', 400);
  const dv = new DataView(buf);
  let o = 0;
  const ml = dv.getUint32(o); o += 4;
  if (ml > 4000 || o + ml + 4 > buf.byteLength) return err('bad body', 400);
  let meta;
  try { meta = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, o, ml))); } catch (e) { return err('bad meta', 400); }
  o += ml;
  const tl = dv.getUint32(o); o += 4;
  if (!tl || o + tl >= buf.byteLength) return err('bad body', 400);
  const th = buf.slice(o, o + tl), pv = buf.slice(o + tl);
  meta.id = id; meta.sz = th.byteLength + pv.byteLength;
  if (!(await roomFor(env, used, MEDIA_CAP, meta.sz))) return err('cloud storage full (some is kept back for history answers)', 507);
  // one atomic batch: the picture never shows up in the list without its preview
  await env.DB.batch([].concat(
    [usageSub(env, 'SELECT CAST(json_extract(meta,\'$.sz\') AS INTEGER) FROM media WHERE id=?', id), usageAdd(env, meta.sz)],
    blobPut(env, 'pv/' + id, pv),
    blobPut(env, 'th/' + id, th),
    [env.DB.prepare('INSERT INTO media (id, meta) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET meta=excluded.meta').bind(id, JSON.stringify(meta))]
  ));
  return json('{"ok":true}');
}
function randCode(n) {
  const a = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', b = new Uint8Array(n);
  crypto.getRandomValues(b);
  let s = '';
  for (let i = 0; i < n; i++) s += a[b[i] % a.length];
  return s;
}
// ---------- D1: schema (+ a one-time copy of old R2 data, only if an R2 bucket is still linked) ----------
let ready = null;
function init(env) {
  if (!env.DB) throw new Error('D1 database is not linked (binding DB)');
  if (ready) return ready;
  ready = (async () => {
    await env.DB.batch([
      env.DB.prepare('CREATE TABLE IF NOT EXISTS acct (id INTEGER PRIMARY KEY, meta TEXT NOT NULL)'),
      env.DB.prepare('CREATE TABLE IF NOT EXISTS used_ids (fp TEXT PRIMARY KEY)'),
      env.DB.prepare('CREATE TABLE IF NOT EXISTS preid (code TEXT PRIMARY KEY, used INTEGER NOT NULL DEFAULT 0, ts INTEGER)'),
      env.DB.prepare('CREATE TABLE IF NOT EXISTS history (id TEXT PRIMARY KEY, meta TEXT NOT NULL, body TEXT, ts INTEGER)'),
      env.DB.prepare('CREATE TABLE IF NOT EXISTS flags (k TEXT PRIMARY KEY)'),
      env.DB.prepare('CREATE TABLE IF NOT EXISTS blobs (k TEXT NOT NULL, seq INTEGER NOT NULL, d TEXT NOT NULL, PRIMARY KEY (k, seq))'),
      env.DB.prepare('CREATE TABLE IF NOT EXISTS media (id TEXT PRIMARY KEY, meta TEXT NOT NULL)'),
      env.DB.prepare('CREATE TABLE IF NOT EXISTS notif (id TEXT PRIMARY KEY, meta TEXT NOT NULL, ts INTEGER)'),
      env.DB.prepare('CREATE TABLE IF NOT EXISTS dev (id TEXT PRIMARY KEY, rec TEXT NOT NULL)'),
      env.DB.prepare('CREATE TABLE IF NOT EXISTS usage (k TEXT PRIMARY KEY, bytes INTEGER NOT NULL)'),
      env.DB.prepare('CREATE TABLE IF NOT EXISTS loc (id TEXT PRIMARY KEY, kind TEXT NOT NULL, peer TEXT NOT NULL)')      // only meaningful once SPOKE_URLS links another cloud
    ]);
    // first time only: count what is already stored (the scan runs only when a counter row is missing - never on a normal start)
    const have = new Set(((await env.DB.prepare('SELECT k FROM usage').all()).results || []).map(x => x.k));
    if (!have.has('media') || !have.has('history')) await recount(env);
    if (env.BUCKET) await migrate(env);
  })().catch(e => { ready = null; throw e; });
  return ready;
}
async function migrate(env) {
  if (await env.DB.prepare("SELECT 1 FROM flags WHERE k='from_r2'").first()) return;
  const st = [];
  const m = await env.BUCKET.get('acct/meta.json');
  if (m) st.push(env.DB.prepare('INSERT OR IGNORE INTO acct (id, meta) VALUES (1, ?)').bind(await m.text()));
  const u = await env.BUCKET.get('acct/usedids.json');
  if (u) { try { for (const fp of JSON.parse(await u.text())) st.push(env.DB.prepare('INSERT OR IGNORE INTO used_ids (fp) VALUES (?)').bind(String(fp))); } catch (e) { } }
  const pr = await env.BUCKET.list({ prefix: 'preid/', limit: 40 });
  for (const o of pr.objects) {
    const g = await env.BUCKET.get(o.key); if (!g) continue;
    let rec = {}; try { rec = JSON.parse(await g.text()); } catch (e) { }
    st.push(env.DB.prepare('INSERT OR IGNORE INTO preid (code, used, ts) VALUES (?, ?, ?)').bind(o.key.slice(6, -5), rec.used ? 1 : 0, rec.ts || 0));
  }
  // history: only the list info is copied now (body stays NULL and is read from R2 the first time it is opened)
  let cursor;
  do {
    const r = await env.BUCKET.list({ prefix: 'h/', cursor, limit: 1000, include: ['customMetadata'] });
    for (const o of r.objects) {
      const id = o.key.slice(2, -5), mm = (o.customMetadata && o.customMetadata.m) || JSON.stringify({ id });
      let ts = 0; try { ts = JSON.parse(mm).ts || 0; } catch (e) { }
      st.push(env.DB.prepare('INSERT OR IGNORE INTO history (id, meta, body, ts) VALUES (?, ?, NULL, ?)').bind(id, mm, ts));
    }
    cursor = r.truncated ? r.cursor : undefined;
  } while (cursor);
  for (let i = 0; i < st.length; i += 90) await env.DB.batch(st.slice(i, i + 90));
  await env.DB.prepare("INSERT OR IGNORE INTO flags (k) VALUES ('from_r2')").run();
}

// the account: one password hash in D1 (this cloud belongs to one person); the ID card photo itself is stored in D1 (blobs)
async function acctGet(env) {
  const r = await env.DB.prepare('SELECT meta FROM acct WHERE id=1').first();
  if (!r) return err('not found', 404);
  return json(r.meta);
}
async function acctPut(req, env) {
  const big = tooBig(req, MAX_ACCT); if (big) return big;
  const buf = await req.arrayBuffer();
  if (buf.byteLength > MAX_ACCT) return err('too large', 413);
  if (buf.byteLength < 4) return err('bad body', 400);
  const dv = new DataView(buf);
  const ml = dv.getUint32(0);
  if (ml > 2000 || 4 + ml > buf.byteLength) return err('bad body', 400);
  let meta;
  try { meta = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, ml))); } catch (e) { return err('bad meta', 400); }
  if (!meta.passHash) return err('missing password', 400);
  if (await env.DB.prepare('SELECT 1 FROM acct WHERE id=1').first()) return err('An account already exists. Please use Login.', 409);
  if (meta.idFp && (await env.DB.prepare('SELECT 1 FROM used_ids WHERE fp=?').bind(meta.idFp).first())) return err('This ID card has already been used and cannot be used again.', 409);
  let preSt = null;
  if (meta.viaPreId) {      // a pre-ID is only spent here, in the same batch that creates the account - backing out of signup costs nothing
    const pc = String(meta.preId || '').trim().toUpperCase();
    if (!pc) return err('missing pre-ID', 400);
    const pr = await env.DB.prepare('SELECT used FROM preid WHERE code=?').bind(pc).first();
    if (!pr) return err('unknown pre-ID', 404);
    if (pr.used) return err('this pre-ID was already used', 409);
    preSt = env.DB.prepare('UPDATE preid SET used=1, ts=? WHERE code=? AND used=0').bind(Date.now(), pc);
  }
  delete meta.preId;
  const img = buf.slice(4 + ml);
  meta.hasId = img.byteLength > 0;
  meta.ts = Date.now();
  meta.session = randCode(10);
  const st = [env.DB.prepare('INSERT INTO acct (id, meta) VALUES (1, ?)').bind(JSON.stringify(meta))];
  if (img.byteLength > 0) st.push(...blobPut(env, 'acct/id', img));
  if (meta.idFp) st.push(env.DB.prepare('INSERT OR IGNORE INTO used_ids (fp) VALUES (?)').bind(meta.idFp));   // kept forever, even past a later "terminate" - that ID card is now spent
  if (preSt) st.push(preSt);
  try { await env.DB.batch(st); } catch (e) { return err('An account already exists. Please use Login.', 409); }   // two signups at once: the second one hits the single-account row
  return json(JSON.stringify({ ok: true, session: meta.session }));
}
async function acctRelogin(env) {        // logs the linked phone out: it must re-enter the password, but the ID card is untouched
  const r = await env.DB.prepare('SELECT meta FROM acct WHERE id=1').first();
  if (!r) return err('not found', 404);
  const meta = JSON.parse(r.meta);
  meta.session = randCode(10);
  await env.DB.prepare('UPDATE acct SET meta=? WHERE id=1').bind(JSON.stringify(meta)).run();
  return json(JSON.stringify({ ok: true, session: meta.session }));
}
async function acctDelete(env) {
  await env.DB.batch([env.DB.prepare('DELETE FROM acct WHERE id=1'), env.DB.prepare("DELETE FROM blobs WHERE k='acct/id'")]);
  return json('{"ok":true}');
}
async function preidNew(env) {
  await env.DB.prepare('DELETE FROM preid WHERE used=1 AND ts < ?').bind(Date.now() - 30 * 86400000).run();      // spent codes are forgotten after 30 days
  const open = await env.DB.prepare('SELECT COUNT(*) AS n FROM preid WHERE used=0').first();
  if ((open.n || 0) >= MAX_PREID_OPEN) return err('too many unused pre-IDs (' + MAX_PREID_OPEN + ') - use one first', 429);
  let code;
  for (let i = 0; i < 5; i++) {
    code = randCode(8);
    if (!(await env.DB.prepare('SELECT 1 FROM preid WHERE code=?').bind(code).first())) break;
  }
  await env.DB.prepare('INSERT INTO preid (code, used, ts) VALUES (?, 0, ?)').bind(code, Date.now()).run();
  return json(JSON.stringify({ code }));
}
async function preidCheck(env, code) {      // looks only - does not spend the pre-ID
  const r = await env.DB.prepare('SELECT used FROM preid WHERE code=?').bind(code.toUpperCase()).first();
  if (!r) return err('unknown pre-ID', 404);
  if (r.used) return err('this pre-ID was already used', 409);
  return json('{"ok":true}');
}
async function preidUse(env, code) {
  const c = code.toUpperCase();
  const r = await env.DB.prepare('SELECT used FROM preid WHERE code=?').bind(c).first();
  if (!r) return err('unknown pre-ID', 404);
  if (r.used) return err('this pre-ID was already used', 409);
  const u = await env.DB.prepare('UPDATE preid SET used=1, ts=? WHERE code=? AND used=0').bind(Date.now(), c).run();
  if (!u.meta || u.meta.changes === 0) return err('this pre-ID was already used', 409);
  return json('{"ok":true}');
}
// history answers (D1). A body over ~1.8 MB would not fit one row, so that rare one is stored as pieces in "blobs".
async function histGet(env, id) {
  const r = await env.DB.prepare('SELECT body FROM history WHERE id=?').bind(id).first();
  if (!r) return err('not found', 404);
  if (r.body !== null && r.body !== undefined) return json(r.body);
  const b = await blobGet(env, 'h/' + id);
  if (b) return json(new TextDecoder().decode(b));
  if (env.BUCKET) { const o = await env.BUCKET.get('h/' + id + '.json'); if (o) return json(await o.text()); }   // old data not copied yet
  return err('not found', 404);
}
async function histPut(env, id, body, metaRaw) {
  let meta = {};
  try { meta = JSON.parse(decodeURIComponent(metaRaw || '{}')); } catch (e) { }
  meta.id = id;
  let m = JSON.stringify(meta);
  if (m.length > 1800) m = JSON.stringify({ id, ts: meta.ts || 0 });
  const bodyBytes = new TextEncoder().encode(body);      // byte size, not character count: Hindi/maths text is 2-3 bytes per character and one D1 row holds at most 2,000,000 bytes
  const newSize = bodyBytes.length + m.length;
  if (!(await roomFor(env, usedHist, HIST_CAP, newSize))) return err('History storage is full (the space kept for saved answers is used up)', 507);
  const st = [histUsageSub(env, id), histUsageAdd(env, newSize)];
  let store = body;
  if (bodyBytes.length > 1500000) { st.push(...blobPut(env, 'h/' + id, bodyBytes)); store = null; }
  else st.push(env.DB.prepare('DELETE FROM blobs WHERE k=?').bind('h/' + id));
  st.push(env.DB.prepare('INSERT INTO history (id, meta, body, ts) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET meta=excluded.meta, body=excluded.body, ts=excluded.ts').bind(id, m, store, meta.ts || 0));
  await env.DB.batch(st);
  return json('{"ok":true}');
}
async function histDelete(env, id) {
  await env.DB.batch([histUsageSub(env, id), env.DB.prepare('DELETE FROM history WHERE id=?').bind(id), env.DB.prepare('DELETE FROM blobs WHERE k=?').bind('h/' + id)]);
  return json('{"ok":true}');
}
// notifications: the picture at FULL size, the small info in the notif table
async function notifUpload(buf, env, id) {
  if (buf.byteLength < 4) return err('empty', 400);
  const dv = new DataView(buf);
  const ml = dv.getUint32(0);
  if (ml > 2000 || 4 + ml > buf.byteLength) return err('bad body', 400);
  let meta;
  try { meta = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, ml))); } catch (e) { return err('bad meta', 400); }
  const img = buf.slice(4 + ml);
  meta.id = id; meta.hasImg = img.byteLength > 0; meta.sz = img.byteLength;
  if (img.byteLength > 0 && !(await roomFor(env, used, MEDIA_CAP, img.byteLength))) return err('cloud storage full (some is kept back for history answers)', 507);
  const st = [usageSub(env, 'SELECT CAST(json_extract(meta,\'$.sz\') AS INTEGER) FROM notif WHERE id=?', id), usageAdd(env, img.byteLength)].concat(img.byteLength > 0 ? blobPut(env, 'nf/' + id, img) : [env.DB.prepare('DELETE FROM blobs WHERE k=?').bind('nf/' + id)]);
  st.push(env.DB.prepare('INSERT INTO notif (id, meta, ts) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET meta=excluded.meta, ts=excluded.ts').bind(id, JSON.stringify(meta), +meta.ts || 0));
  await env.DB.batch(st);
  return json('{"ok":true}');
}
async function notifImg(env, id) {
  const b = await blobGet(env, 'nf/' + id);
  return b ? jpegResponse(b, 'private, max-age=31536000, immutable') : err('not found', 404);
}
async function notifDelete(env, id) {
  await env.DB.batch([usageSub(env, 'SELECT CAST(json_extract(meta,\'$.sz\') AS INTEGER) FROM notif WHERE id=?', id), env.DB.prepare('DELETE FROM notif WHERE id=?').bind(id), env.DB.prepare('DELETE FROM blobs WHERE k=?').bind('nf/' + id)]);
  return json('{"ok":true}');
}
// deletes every media row (photo/video preview) whose timestamp falls in [from, to] - across every phone on this account,
// since all phones share one account. "delete all" is the same call with a range wide enough to cover everything.
async function mediaDeleteOne(env, id) {
  await env.DB.batch([usageSub(env, 'SELECT CAST(json_extract(meta,\'$.sz\') AS INTEGER) FROM media WHERE id=?', id), env.DB.prepare('DELETE FROM media WHERE id=?').bind(id), env.DB.prepare('DELETE FROM blobs WHERE k IN (?, ?)').bind('th/' + id, 'pv/' + id)]);
  return json('{"ok":true}');
}
async function mediaDeleteRange(env, from, to, type) {
  const args = [from, to];
  let sql = "SELECT id FROM media WHERE json_extract(meta,'$.ts') BETWEEN ? AND ?";
  if (type) { sql += " AND json_extract(meta,'$.t')=?"; args.push(type); }
  const ids = ((await env.DB.prepare(sql).bind(...args).all()).results || []).map(x => x.id);
  if (!ids.length) return json(JSON.stringify({ ok: true, deleted: 0, ids: [] }));
  for (let i = 0; i < ids.length; i += 100) {      // in chunks, so one request can't run forever on a huge account
    const chunk = ids.slice(i, i + 100), ph = chunk.map(() => '?').join(',');
    const st = [usageSub(env, "SELECT SUM(CAST(json_extract(meta,'$.sz') AS INTEGER)) FROM media WHERE id IN (" + ph + ')', ...chunk)];
    for (const id of chunk) st.push(env.DB.prepare('DELETE FROM blobs WHERE k IN (?, ?)').bind('th/' + id, 'pv/' + id));
    st.push(env.DB.prepare('DELETE FROM media WHERE id IN (' + ph + ')').bind(...chunk));
    await env.DB.batch(st);
  }
  return json(JSON.stringify({ ok: true, deleted: ids.length, ids }));
}
async function notifDeleteRange(env, from, to) {
  const ids = ((await env.DB.prepare('SELECT id FROM notif WHERE ts >= ? AND ts <= ?').bind(from, to).all()).results || []).map(x => x.id);
  if (!ids.length) return json(JSON.stringify({ ok: true, deleted: 0, ids: [] }));
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100), ph = chunk.map(() => '?').join(',');
    const st = [usageSub(env, "SELECT SUM(CAST(json_extract(meta,'$.sz') AS INTEGER)) FROM notif WHERE id IN (" + ph + ')', ...chunk)];
    for (const id of chunk) st.push(env.DB.prepare('DELETE FROM blobs WHERE k=?').bind('nf/' + id));
    st.push(env.DB.prepare('DELETE FROM notif WHERE id IN (' + ph + ')').bind(...chunk));
    await env.DB.batch(st);
  }
  return json(JSON.stringify({ ok: true, deleted: ids.length, ids }));
}
// phones: one small record each
async function devList(env) {
  const r = await env.DB.prepare('SELECT rec FROM dev ORDER BY id').all();
  return '{"items":[' + (r.results || []).map(x => x.rec).join(',') + '],"cursor":""}';
}
async function devPut(env, id, req) {
  const big = tooBig(req, MAX_DEV); if (big) return big;
  let incoming = {};
  try { const t = await req.text(); if (t.length > MAX_DEV) return err('too large', 413); incoming = JSON.parse(t); } catch (e) { return err('bad body', 400); }
  const o = await env.DB.prepare('SELECT rec FROM dev WHERE id=?').bind(id).first();
  if (!o && ((await env.DB.prepare('SELECT COUNT(*) AS n FROM dev').first()).n || 0) >= MAX_DEVICES) return err('too many phones registered', 409);
  let rec = { id, backupOn: true };
  if (o) { try { rec = JSON.parse(o.rec); } catch (e) { } }
  rec = Object.assign(rec, incoming, { id });
  if (typeof rec.backupOn !== 'boolean') rec.backupOn = true;
  // per-phone upload settings chosen in Drivi: speedKB = KB/s while the screen is on (0 = unlimited),
  // capMB = photo/video MB per day on mobile data (0 = no limit). Anything odd is dropped (the phone then keeps its default).
  for (const [k, max] of [['speedKB', 102400], ['capMB', 100000]]) {
    if (k in rec) { const v = rec[k]; if (!(Number.isInteger(v) && v >= 0 && v <= max)) delete rec[k]; }
  }
  const s = JSON.stringify(rec);
  if (s.length > MAX_DEV) return err('too large', 413);
  await env.DB.prepare('INSERT INTO dev (id, rec) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET rec=excluded.rec').bind(id, s).run();
  return json(s);
}
async function acctImg(env) {
  const b = await blobGet(env, 'acct/id');
  return b ? jpegResponse(b, 'private, max-age=86400') : err('not found', 404);
}
async function picture(env, kind, id) {
  const b = await blobGet(env, kind + '/' + id);
  return b ? jpegResponse(b, 'private, max-age=31536000, immutable') : err('not found', 404);
}
export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const u = new URL(req.url), p = u.pathname.split('/').filter(Boolean);
    if (p[0] !== 'api') return new Response('QuickAns cloud is running.', { headers: { 'Content-Type': 'text/plain' } });
    const key = req.headers.get('X-Key') || u.searchParams.get('k') || '';
    if (!env.QA_KEY || !same(key, env.QA_KEY)) return err('wrong key', 401);
    const q = u.searchParams, M = req.method, a = p[1], id = p[2];
    try {
      if (a === 'ping') return json('{"ok":true}');
      await init(env);
      if (a === 'up' && M === 'PUT' && okId(id)) return createAcrossPeers(req, env, id, 'm', '/api/up/' + encodeURIComponent(id), MAX_MEDIA, buf => upload(buf, env, id));
      if (a === 'list' && M === 'GET') return fanList(env, 'media', 'meta', '/api/list', q, req);
      if (a === 'ids' && M === 'GET') {
        const prefix = String(q.get('p') || '').replace(/[^A-Za-z0-9_.-]/g, '') + '_';
        const all = peers(env, req);
        if (all.length === 1) return json(JSON.stringify({ ids: await allIds(env, prefix) }));
        const settled = await Promise.allSettled(all.map(peer => peer === '' ? allIds(env, prefix) : proxy(env, peer, 'GET', '/api/ids?p=' + encodeURIComponent(q.get('p') || '')).then(r => r.json()).then(j => j.ids || [])));
        let ids = [];
        settled.forEach(r => { if (r.status === 'fulfilled') ids = ids.concat(r.value); });
        return json(JSON.stringify({ ids }));
      }
      if ((a === 'th' || a === 'pv') && M === 'GET' && okId(id)) return runAt(env, id, '/api/' + a + '/' + encodeURIComponent(id), 'GET', () => picture(env, a, id), req);
      if (a === 'acct' && !id) {
        if (M === 'GET') return acctGet(env);
        if (M === 'PUT') return acctPut(req, env);
        if (M === 'DELETE') return acctDelete(env);
      }
      if (a === 'acct' && id === 'id' && M === 'GET') return acctImg(env);
      if (a === 'acct' && id === 'relogin' && M === 'POST') return acctRelogin(env);
      if (a === 'dev' && !id && M === 'GET') return json(await devList(env));
      if (a === 'dev' && okId(id) && M === 'PUT') return devPut(env, id, req);
      if (a === 'notif' && !id) {
        if (M === 'GET') return fanList(env, 'notif', 'meta', '/api/notif', q, req);
        if (M === 'DELETE') { const from = +q.get('from') || 0, to = +q.get('to') || Date.now(); return fanDelete(env, '/api/notif?from=' + from + '&to=' + to, () => notifDeleteRange(env, from, to), req); }
      }
      if (a === 'notif' && id && okId(id)) {
        if (M === 'PUT') return createAcrossPeers(req, env, id, 'n', '/api/notif/' + encodeURIComponent(id), MAX_NOTIF, buf => notifUpload(buf, env, id));
        if (M === 'DELETE') return routedDelete(env, id, '/api/notif/' + encodeURIComponent(id), () => notifDelete(env, id), req);
        if (M === 'GET' && p[3] === 'img') return runAt(env, id, '/api/notif/' + encodeURIComponent(id) + '/img', 'GET', () => notifImg(env, id), req);
      }
      if (a === 'recount' && M === 'POST') { await recount(env); return json('{"ok":true}'); }
      if (a === 'preid' && !id && M === 'POST') return preidNew(env);
      if (a === 'preid' && id && p[3] === 'check' && M === 'POST') return preidCheck(env, id);
      if (a === 'preid' && id && !p[3] && M === 'POST') return preidUse(env, id);
      if (a === 'm' && !id && M === 'DELETE') {
        const type = q.get('t') || '';
        if (type && type !== 'p' && type !== 'v') return err('bad type', 400);
        const from = +q.get('from') || 0, to = +q.get('to') || (Date.now() + 86400000);
        return fanDelete(env, '/api/m?from=' + from + '&to=' + to + (type ? '&t=' + type : ''), () => mediaDeleteRange(env, from, to, type), req);
      }
      if (a === 'm' && M === 'DELETE' && okId(id)) return routedDelete(env, id, '/api/m/' + encodeURIComponent(id), () => mediaDeleteOne(env, id), req);
      if (a === 'h' && !id && M === 'GET') return fanList(env, 'history', 'meta', '/api/h', q, req);
      if (a === 'h' && okId(id)) {
        if (M === 'GET') return runAt(env, id, '/api/h/' + encodeURIComponent(id), 'GET', () => histGet(env, id), req);
        if (M === 'PUT') return createAcrossPeers(req, env, id, 'h', '/api/h/' + encodeURIComponent(id), MAX_HIST, buf => histPut(env, id, new TextDecoder().decode(buf), req.headers.get('X-Meta')));
        if (M === 'DELETE') return routedDelete(env, id, '/api/h/' + encodeURIComponent(id), () => histDelete(env, id), req);
      }
      return err('unknown request', 404);
    } catch (e) {
      return err(String(e && e.message || e).slice(0, 200), 500);
    }
  }
};
