'use strict';

/* Local editing server for the Christine-Guttmann site.
 *
 * Serves the admin shell, serves the real site into a preview iframe with the
 * editor injected, writes edits back into the .html files and publishes to
 * GitHub. No npm dependencies — plain Node. Binds to localhost only. */

const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const H = require('./lib/html');
const { applyOps, PatchError } = require('./lib/patch');
const git = require('./lib/git');

const ROOT = path.resolve(__dirname, '..');
const UI = path.join(__dirname, 'ui');
const IMG_DIR = path.join(ROOT, 'assets', 'img');
const BACKUP_DIR = path.join(ROOT, '.cms-backups');

const PAGES = [
  { file: 'index.html', title: 'Startseite' },
  { file: 'ausstellungen.html', title: 'Ausstellungen' },
  { file: 'vita.html', title: 'Vita' },
  { file: 'kontakt.html', title: 'Kontakt' },
  { file: 'impressum.html', title: 'Impressum' },
  { file: 'datenschutz.html', title: 'Datenschutz' },
];
const PAGE_FILES = new Set(PAGES.map((p) => p.file));

const MAX_UPLOAD = 16 * 1024 * 1024;
const MAX_BODY = 24 * 1024 * 1024;
const KEEP_BACKUPS = 40;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.png': 'image/png', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};

/* ---------- helpers ---------- */

const send = (res, code, body, headers = {}) => {
  res.writeHead(code, { 'Cache-Control': 'no-store', ...headers });
  res.end(body);
};
const sendJson = (res, code, obj) =>
  send(res, code, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8' });

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('Anfrage zu groß')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch (err) { reject(new Error('Ungültiges JSON')); }
    });
    req.on('error', reject);
  });
}

/** Resolve a URL path inside `base`, refusing anything that escapes it. */
function safeJoin(base, urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const target = path.resolve(base, '.' + path.posix.normalize('/' + decoded));
  const rel = path.relative(base, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return target;
}

async function serveFile(res, file, transform) {
  let data;
  try { data = await fsp.readFile(file); }
  catch { return send(res, 404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' }); }
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  if (transform) data = Buffer.from(transform(data.toString('utf8')), 'utf8');
  send(res, 200, data, { 'Content-Type': type });
}

/* ---------- preview injection ---------- */

/* The site's own main.js drives a rotating slider, a lightbox that swallows
 * clicks and a filter that hides items — all of which fight with editing.
 * In preview it is replaced by the editor, which supplies tamer versions. */
function injectEditor(html, pageFile) {
  let out = html.replace(
    /<script src="assets\/js\/main\.js"><\/script>/,
    `<script>window.__CMS_PAGE__=${JSON.stringify(pageFile)}</script>\n<script src="/__cms/editor.js"></script>`
  );
  if (out === html) {
    out = html.replace(
      /<\/body>/i,
      `<script>window.__CMS_PAGE__=${JSON.stringify(pageFile)}</script>\n<script src="/__cms/editor.js"></script>\n</body>`
    );
  }
  return out.replace(/<\/head>/i, '<link rel="stylesheet" href="/__cms/editor.css">\n</head>');
}

/* ---------- page model ---------- */

async function pageModel(file) {
  const src = await fsp.readFile(path.join(ROOT, file), 'utf8');
  const { regions } = H.findRegions(src);
  return {
    file,
    regions: regions.map((r) => ({ id: r.id, kind: r.kind, label: r.label, global: r.global })),
  };
}

async function listImages() {
  const names = await fsp.readdir(IMG_DIR);
  const out = [];
  for (const name of names) {
    if (!/\.(jpe?g|png|webp|gif)$/i.test(name)) continue;
    const st = await fsp.stat(path.join(IMG_DIR, name));
    out.push({ name, path: `assets/img/${name}`, bytes: st.size, mtime: st.mtimeMs });
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

/* ---------- writing ---------- */

async function backup(file, contents) {
  await fsp.mkdir(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  await fsp.writeFile(path.join(BACKUP_DIR, `${stamp}__${file}`), contents, 'utf8');

  const all = (await fsp.readdir(BACKUP_DIR)).filter((n) => n.endsWith('.html')).sort();
  for (const old of all.slice(0, Math.max(0, all.length - KEEP_BACKUPS))) {
    await fsp.unlink(path.join(BACKUP_DIR, old)).catch(() => {});
  }
}

/** Write atomically so a crash can never leave a half-written page. */
async function writeAtomic(file, text) {
  const target = path.join(ROOT, file);
  const tmp = `${target}.cms-tmp`;
  await fsp.writeFile(tmp, text, 'utf8');
  await fsp.rename(tmp, target);
}

async function savePage(file, regionOps) {
  if (!PAGE_FILES.has(file)) throw new PatchError(`unknown page "${file}"`);
  const src = await fsp.readFile(path.join(ROOT, file), 'utf8');
  const out = applyOps(src, regionOps);
  if (out === src) return { file, changed: false };
  await backup(file, src);
  await writeAtomic(file, out);
  return { file, changed: true };
}

/** Global regions (footer contact details) live on every page. */
async function saveGlobals(regionOps, originPage) {
  const touched = [];
  for (const { file } of PAGES) {
    if (file === originPage) continue;
    const src = await fsp.readFile(path.join(ROOT, file), 'utf8');
    const { regions } = H.findRegions(src);
    const ids = new Set(regions.filter((r) => r.global).map((r) => r.id));
    const subset = {};
    for (const [id, ops] of Object.entries(regionOps)) if (ids.has(id)) subset[id] = ops;
    if (!Object.keys(subset).length) continue;

    const out = applyOps(src, subset);
    if (out === src) continue;
    await backup(file, src);
    await writeAtomic(file, out);
    touched.push(file);
  }
  return touched;
}

/* ---------- uploads ---------- */

function slugify(name) {
  const ext = (path.extname(name) || '.jpg').toLowerCase();
  const base = path.basename(name, path.extname(name))
    // umlauts first: NFD would otherwise reduce "ä" to a bare "a"
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue')
    .replace(/Ä/g, 'Ae').replace(/Ö/g, 'Oe').replace(/Ü/g, 'Ue').replace(/ß/g, 'ss')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 70) || 'bild';
  return { base, ext: ['.jpg', '.jpeg', '.png', '.webp'].includes(ext) ? ext : '.jpg' };
}

async function uniquePath(base, ext) {
  let name = `${base}${ext}`;
  let n = 1;
  while (fs.existsSync(path.join(IMG_DIR, name))) name = `${base}-${n++}${ext}`;
  return name;
}

async function handleUpload(body) {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,/.exec(body.dataUrl || '');
  if (!m) throw new PatchError('Nur JPG-, PNG- oder WebP-Bilder werden unterstützt.');
  const buf = Buffer.from(body.dataUrl.slice(m[0].length), 'base64');
  if (!buf.length) throw new PatchError('Die Bilddatei ist leer.');
  if (buf.length > MAX_UPLOAD) throw new PatchError('Das Bild ist zu groß (max. 16 MB).');

  const fromMime = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' }[m[1]];
  const { base } = slugify(body.name || 'bild');
  const name = await uniquePath(base, fromMime);
  await fsp.writeFile(path.join(IMG_DIR, name), buf);
  return { name, path: `assets/img/${name}`, bytes: buf.length };
}

/* ---------- routes ---------- */

async function handleApi(req, res, url) {
  const route = url.pathname.slice('/api/'.length);

  if (req.method === 'GET' && route === 'state') {
    return sendJson(res, 200, {
      pages: await Promise.all(PAGES.map(async (p) => ({ ...p, ...(await pageModel(p.file)) }))),
      git: await git.status(),
    });
  }

  if (req.method === 'GET' && route === 'images') {
    return sendJson(res, 200, { images: await listImages() });
  }

  if (req.method === 'GET' && route === 'git') {
    return sendJson(res, 200, await git.status());
  }

  if (req.method === 'POST' && route === 'save') {
    const body = await readBody(req);
    const page = String(body.page || '');
    const ops = body.regions || {};
    const result = await savePage(page, ops);
    const alsoTouched = await saveGlobals(ops, page);
    return sendJson(res, 200, { ok: true, ...result, alsoTouched, git: await git.status() });
  }

  if (req.method === 'POST' && route === 'upload') {
    const body = await readBody(req);
    return sendJson(res, 200, { ok: true, ...(await handleUpload(body)) });
  }

  if (req.method === 'POST' && route === 'publish') {
    const body = await readBody(req);
    const result = await git.publish(body.message);
    return sendJson(res, result.ok ? 200 : 400, result);
  }

  if (req.method === 'POST' && route === 'discard') {
    const result = await git.discardAll();
    return sendJson(res, result.ok ? 200 : 400, { ...result, git: await git.status() });
  }

  return sendJson(res, 404, { error: 'unknown endpoint' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);

    if (url.pathname === '/' || url.pathname === '/index') {
      return serveFile(res, path.join(UI, 'admin.html'));
    }

    if (url.pathname.startsWith('/__cms/')) {
      const file = safeJoin(UI, url.pathname.slice('/__cms'.length));
      return file ? serveFile(res, file) : send(res, 403, 'Forbidden');
    }

    if (url.pathname.startsWith('/preview/')) {
      const rel = url.pathname.slice('/preview'.length) || '/';
      const file = safeJoin(ROOT, rel === '/' ? '/index.html' : rel);
      if (!file) return send(res, 403, 'Forbidden');
      const name = path.basename(file);
      if (PAGE_FILES.has(name)) return serveFile(res, file, (html) => injectEditor(html, name));
      return serveFile(res, file);
    }

    const file = safeJoin(ROOT, url.pathname);
    return file ? serveFile(res, file) : send(res, 403, 'Forbidden');
  } catch (err) {
    const isUserError = err instanceof PatchError || err instanceof H.ParseError;
    if (!isUserError) console.error('[cms]', err);
    return sendJson(res, isUserError ? 400 : 500, { error: err.message || String(err) });
  }
});

function listen(port, attemptsLeft = 12) {
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && attemptsLeft > 0) return listen(port + 1, attemptsLeft - 1);
    console.error('Server konnte nicht gestartet werden:', err.message);
    process.exit(1);
  });
  server.listen(port, '127.0.0.1', () => {
    const url = `http://localhost:${server.address().port}/`;
    console.log(`\n  Website-Editor läuft auf ${url}`);
    console.log('  Zum Beenden dieses Fenster schließen oder Strg+C drücken.\n');
    if (process.env.CMS_NO_OPEN !== '1') {
      require('child_process').exec(`start "" "${url}"`, { windowsHide: true });
    }
  });
}

listen(parseInt(process.env.CMS_PORT, 10) || 4321);
