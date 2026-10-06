import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const root = path.dirname(fileURLToPath(import.meta.url));
const maxConfigBytes = 128 * 1024;
const maxApps = 500;
const slugPattern = /^[a-zA-Z0-9_-]{1,80}$/;
const escape = value => String(value).replace(/[&<>"']/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

function hostName(value) {
  if (typeof value !== 'string' || value.length > 260 ||
      !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[0-9]{1,5})?$/i.test(value)) {
    throw new Error('Invalid allowed host');
  }
  return new URL(`http://${value}`).host;
}

function httpsUrl(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\x00-\x20\x7f]/.test(value)) {
    throw new Error('Invalid destination URL');
  }
  const url = new URL(value);
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) {
    throw new Error('Destinations must use HTTPS without embedded credentials');
  }
  return url;
}

function text(value, maxLength) {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) {
    throw new Error('Invalid app text');
  }
  return value;
}

function readJson(configPath) {
  // Read at most the configured limit, including if the file grows during the read.
  const fd = fs.openSync(configPath, 'r');
  let raw;
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error('Configuration must be a regular file');
    const buffer = Buffer.alloc(maxConfigBytes + 1);
    let size = 0;
    while (size < buffer.length) {
      const read = fs.readSync(fd, buffer, size, buffer.length - size, null);
      if (!read) break;
      size += read;
    }
    if (size > maxConfigBytes) throw new Error('Configuration is too large');
    raw = buffer.toString('utf8', 0, size);
  } finally {
    fs.closeSync(fd);
  }
  return JSON.parse(raw);
}

export function loadConfig(configPath) {
  const config = readJson(configPath);
  if (!config || !Array.isArray(config.allowedHosts) || !config.allowedHosts.length ||
      config.allowedHosts.length > 32 || !Array.isArray(config.apps) || config.apps.length > maxApps) {
    throw new Error('Configure allowedHosts and an apps array');
  }
  const allowedHosts = new Set(config.allowedHosts.map(hostName));
  const entries = new Map();
  for (const item of config.apps) {
    if (!item || typeof item.slug !== 'string' || !slugPattern.test(item.slug) || entries.has(item.slug)) {
      throw new Error('Invalid or duplicate app slug');
    }
    let shutdown;
    if (item.service !== undefined) {
      if (!item.service || item.service.type !== 'launchAgent' ||
          typeof item.service.label !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/.test(item.service.label)) {
        throw new Error('Invalid app service');
      }
      shutdown = { type: 'launchAgent', label: item.service.label };
    }
    entries.set(item.slug, {
      slug: item.slug, name: text(item.name, 120),
      description: item.description === undefined || item.description === '' ? '' : text(item.description, 300),
      url: httpsUrl(item.url).href,
      shutdown,
    });
  }
  if (config.tailnow !== undefined) {
    const settings = config.tailnow;
    if (!settings || typeof settings.directory !== 'string' || !path.isAbsolute(settings.directory)) {
      throw new Error('Tailnow requires an absolute directory path');
    }
    const base = httpsUrl(settings.url);
    if (base.search || base.hash || !base.pathname.endsWith('/')) {
      throw new Error('Tailnow URL must end in / without a query or fragment');
    }
    const directory = fs.opendirSync(settings.directory);
    try {
      let count = 0;
      for (let item; (item = directory.readSync()) !== null;) {
        if (++count > 2000) throw new Error('Tailnow directory is too large');
        // Do not follow symlinks or publish arbitrary filenames as shortcuts.
        if (!item.isDirectory() || !slugPattern.test(item.name) || entries.has(item.name)) continue;
        if (entries.size >= maxApps) throw new Error('Too many apps');
        entries.set(item.name, {
          slug: item.name, name: item.name.replaceAll('-', ' '),
          description: 'Published with Tailnow', url: new URL(`${item.name}/`, base).href,
          shutdown: { type: 'tailnow', directory: path.resolve(settings.directory), slug: item.name },
        });
      }
    } finally {
      directory.closeSync();
    }
  }
  return { allowedHosts, entries };
}

function loadState(statePath) {
  let state;
  try { state = readJson(statePath); } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
  if (!state || state.version !== 1 || !state.apps || typeof state.apps !== 'object' || Array.isArray(state.apps) || Object.keys(state.apps).length > 2000) {
    throw new Error('Invalid directory state');
  }
  for (const [slug, entry] of Object.entries(state.apps)) {
    if (!slugPattern.test(slug) || !entry || !['minimized', 'removed'].includes(entry.visibility) ||
        !['none', 'pending', 'stopped', 'failed'].includes(entry.shutdown)) throw new Error('Invalid directory state');
    text(entry.name, 120);
  }
  return state.apps;
}

function saveState(statePath, apps) {
  const data = JSON.stringify({ version: 1, apps }, null, 2) + '\n';
  if (Buffer.byteLength(data) > maxConfigBytes || Object.keys(apps).length > 2000) throw new Error('Directory state is too large');
  const temporary = `${statePath}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, data, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, statePath);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

// Targets come exclusively from trusted local configuration, never HTTP input.
export async function stopApp(app, { run = promisify(execFile), platform = process.platform, uid = process.getuid?.() } = {}) {
  const target = app.shutdown;
  if (target?.type === 'tailnow') {
    const source = path.join(target.directory, target.slug);
    if (!fs.lstatSync(source).isDirectory()) throw new Error('Site is not a directory');
    // A sibling outside the served root keeps the site's files recoverable.
    const archive = `${target.directory}.mini-shortcuts-archive`;
    fs.mkdirSync(archive, { recursive: true, mode: 0o700 });
    if (!fs.lstatSync(archive).isDirectory()) throw new Error('Invalid archive directory');
    fs.renameSync(source, path.join(archive, `${target.slug}-${randomUUID()}`));
    return;
  }
  if (target?.type !== 'launchAgent' || platform !== 'darwin' || !Number.isInteger(uid)) throw new Error('Shutdown is unavailable');
  const service = `gui/${uid}/${target.label}`;
  const invoke = args => run('/bin/launchctl', args, { timeout: 3000, maxBuffer: 64 * 1024, encoding: 'utf8' });
  // Persistently disable before unloading so KeepAlive/login cannot restart it.
  await invoke(['disable', service]);
  try { await invoke(['bootout', service]); } catch { /* Verify unloaded state below, including already stopped jobs. */ }
  try {
    await invoke(['print', service]);
  } catch (error) {
    if (error.code === 113 && /Could not find service/.test(error.stderr || '')) return;
    throw new Error('Could not verify shutdown');
  }
  throw new Error('Service is still loaded');
}

function home(entries, state) {
  const button = (slug, action, label, extra = '') => `<button type="button" data-slug="${escape(slug)}" data-action="${action}" ${extra}>${label}</button>`;
  const featured = [], minimized = [], removed = [];
  for (const app of entries.values()) {
    const status = Object.hasOwn(state, app.slug) ? state[app.slug] : undefined;
    if (status?.visibility === 'removed') continue;
    const isMinimized = status?.visibility === 'minimized';
    const controls = button(app.slug, isMinimized ? 'restore' : 'minimize', isMinimized ? 'Restore' : 'Minimize') +
      button(app.slug, 'confirm-remove', 'Remove…', `data-name="${escape(app.name)}" data-shutdown="${app.shutdown?.type || ''}"`);
    const card = `<article class="app${isMinimized ? ' compact' : ''}"><a href="/${escape(app.slug)}"><strong>${escape(app.name)}</strong><span>${escape(app.description)}</span><code>/${escape(app.slug)} →</code></a><div class="controls">${controls}</div></article>`;
    (isMinimized ? minimized : featured).push(card);
  }
  for (const [slug, status] of Object.entries(state)) {
    if (status.visibility !== 'removed') continue;
    const app = entries.get(slug);
    const label = { none: 'Removed from this directory only', pending: app?.shutdown ? 'Shutdown needs verification — retry to confirm' : 'Shutdown needs verification on the server', stopped: 'Shut down', failed: app?.shutdown ? 'Shutdown failed — you can retry' : 'Shutdown needs attention on the server' }[status.shutdown];
    const controls = (app && status.shutdown === 'none' ? button(slug, 'restore', 'Restore') : '') +
      (app?.shutdown && status.shutdown !== 'stopped' ? button(slug, 'confirm-stop', 'Shut down…', `data-name="${escape(status.name)}" data-shutdown="${app.shutdown.type}"`) : '');
    removed.push(`<article class="removed-app"><div><strong>${escape(status.name)}</strong><span>${label}</span></div><div class="controls">${controls}</div></article>`);
  }
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Mini · Your apps</title><link rel="stylesheet" href="/style.css"><script src="/app.js" defer></script></head><body><main><small>Mac Mini · Private apps</small><h1>A little home<br>for your apps.</h1><p>Your everyday apps up front. Minimize the rest to keep them handy and running.</p><p id="notice" role="status" aria-live="polite"></p><section aria-labelledby="featured-title"><h2 id="featured-title">Your apps <span class="count">${featured.length}</span></h2><div class="apps">${featured.join('') || '<p class="empty">No apps up front. Restore a minimized app to bring it here.</p>'}</div></section>${minimized.length ? `<details id="minimized"><summary>Minimized <span class="count">${minimized.length}</span><span class="hint">Still available</span></summary><div class="apps minimized">${minimized.join('')}</div></details>` : ''}${removed.length ? `<details id="removed"><summary>Removed <span class="count">${removed.length}</span></summary><div class="removed-list">${removed.join('')}</div><p class="hint">Shut-down apps need to be restarted or republished on the server before use.</p></details>` : ''}<footer>Minimizing keeps each app available at its usual address. Your layout is saved across devices.</footer></main><dialog id="remove-dialog" aria-labelledby="dialog-title" aria-describedby="dialog-description"><form method="dialog"><h2 id="dialog-title">Remove app?</h2><p id="dialog-description"></p><label id="shutdown-option"><input type="checkbox" id="shutdown-checkbox"> Also shut down on the server</label><p id="shutdown-help" class="hint"></p><p id="dialog-error" role="alert"></p><div class="dialog-actions"><button id="cancel-remove" type="button">Cancel</button><button id="confirm-remove" type="submit" class="danger">Remove</button></div></form></dialog></body></html>`;
}

export function createServer({ configPath = path.join(root, 'apps.json'), statePath = path.join(path.dirname(configPath), `${path.basename(configPath, '.json')}.state.json`), reloadMs = 1000, shutdown = stopApp, onConfigError = () => console.error('Shortcut configuration unavailable; check the local configuration.') } = {}) {
  const stylesheet = fs.readFileSync(path.join(root, 'public/style.css'));
  const javascript = fs.readFileSync(path.join(root, 'public/app.js'));
  let state = loadState(statePath);
  let busy = false;
  let config = loadConfig(configPath);
  let checkedAt = performance.now();
  let hadError = false;
  const server = http.createServer({ maxHeaderSize: 8192, headersTimeout: 10000, requestTimeout: 15000, connectionsCheckingInterval: 1000 }, async (req, res) => {
    const reply = (status, body = '', headers = {}) => {
      res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', ...headers });
      res.end(req.method === 'HEAD' ? undefined : body);
    };
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    if (!['GET', 'HEAD', 'POST'].includes(req.method)) return reply(405, 'Method not allowed', { Allow: 'GET, HEAD, POST', Connection: 'close' });
    if (req.headers['transfer-encoding'] || (req.headers['content-length'] && req.headers['content-length'] !== '0')) {
      return reply(400, 'Request bodies are not supported', { Connection: 'close' });
    }
    if (!req.url || req.url.length > 2048) return reply(414, 'Request target too long');
    // Accept origin-form paths only. Never use the request to select a destination host.
    if (!/^\/(?!\/)/.test(req.url) || /[\\\x00-\x20\x7f]/.test(req.url)) return reply(400, 'Invalid request target');
    if (performance.now() - checkedAt >= reloadMs) {
      checkedAt = performance.now();
      try {
        config = loadConfig(configPath);
        hadError = false;
      } catch {
        config = null;
        if (!hadError) onConfigError();
        hadError = true;
      }
    }
    if (!config) return reply(503, 'App shortcuts are temporarily unavailable.');
    let host;
    try {
      host = hostName(req.headers.host);
      const hostCount = req.rawHeaders.filter((_, index) => index % 2 === 0 && req.rawHeaders[index].toLowerCase() === 'host').length;
      if (hostCount !== 1 || !config.allowedHosts.has(host)) return reply(403, 'Unrecognized host');
      if (req.headers.origin) {
        const origin = new URL(req.headers.origin);
        if (!['http:', 'https:'].includes(origin.protocol) || hostName(origin.host) !== host) return reply(403, 'Cross-origin request blocked');
      }
    } catch {
      return reply(403, 'Unrecognized host or origin');
    }
    if (req.headers['sec-fetch-site'] === 'cross-site' && req.headers['sec-fetch-mode'] !== 'navigate') {
      return reply(403, 'Cross-site request blocked');
    }
    // A query cannot alter a configured redirect. Avoid URL path normalization.
    const pathname = req.url.split('?')[0];
    const action = /^\/api\/apps\/([a-zA-Z0-9_-]{1,80})\/(minimize|restore|remove|shutdown)$/.exec(pathname);
    if (req.method === 'POST') {
      if (!action || req.url !== pathname) return reply(405, 'Method not allowed', { Allow: 'GET, HEAD' });
      // Custom header cannot be sent by a cross-origin form or fetch without a
      // CORS preflight. No CORS permission is granted, even on HTTP tailnet URLs.
      if (req.headers['x-mini-request'] !== '1' || req.headers['sec-fetch-site'] === 'cross-site') return reply(403, 'Management request blocked');
      if (busy) return reply(409, 'Another change is in progress. Please try again.');
      busy = true;
      try {
        config = loadConfig(configPath);
        checkedAt = performance.now();
        const [, slug, operation] = action;
        const app = config.entries.get(slug);
        const previous = Object.hasOwn(state, slug) ? state[slug] : undefined;
        if (!app) return reply(404, 'App is no longer available. Reload the directory.');
        if (operation === 'shutdown' && previous?.shutdown === 'stopped') return reply(200, 'Already shut down');
        if (operation === 'shutdown' && !app.shutdown) return reply(409, 'Server shutdown has not been configured for this app.');
        if (operation !== 'shutdown' && previous?.shutdown && previous.shutdown !== 'none') return reply(409, 'This app has a shutdown record. Restart it on the server before resetting its directory state.');
        if (operation === 'minimize' && previous?.visibility === 'removed') return reply(409, 'Restore this app first.');
        const update = value => {
          const next = { ...state };
          if (value) Object.defineProperty(next, slug, { value, enumerable: true, writable: true, configurable: true });
          else delete next[slug];
          saveState(statePath, next);
          state = next;
        };
        if (operation === 'restore') update(null);
        else {
          const record = { name: app.name, visibility: operation === 'minimize' ? 'minimized' : 'removed', shutdown: operation === 'shutdown' ? 'pending' : 'none' };
          // Save removal before stopping. A failed shutdown remains visible in
          // the Removed section so it can be retried, including after restart.
          update(record);
          if (operation === 'shutdown') {
            try { await shutdown(app); } catch {
              update({ ...record, shutdown: 'failed' });
              return reply(502, 'Removed from the directory, but shutdown could not be confirmed. Open Removed to retry.');
            }
            update({ ...record, shutdown: 'stopped' });
          }
        }
        // Refresh discovery after an unpublish without undoing a completed action.
        checkedAt = -Infinity;
        return reply(200, 'Saved');
      } catch {
        return reply(503, 'Could not save this change. Reload the directory and try again.');
      } finally { busy = false; }
    }
    if (pathname === '/') return reply(200, home(config.entries, state), { 'Content-Type': 'text/html; charset=utf-8' });
    if (pathname === '/style.css') return reply(200, stylesheet, { 'Content-Type': 'text/css; charset=utf-8' });
    if (pathname === '/app.js') return reply(200, javascript, { 'Content-Type': 'text/javascript; charset=utf-8' });
    const match = /^\/([a-zA-Z0-9_-]{1,80})\/?$/.exec(pathname);
    const app = match && config.entries.get(match[1]);
    if (app && !(Object.hasOwn(state, app.slug) && state[app.slug].visibility === 'removed')) return reply(302, '', { Location: app.url });
    return reply(404, 'Unknown shortcut. Open the home page to see your apps.');
  });
  server.keepAliveTimeout = 5000;
  server.maxRequestsPerSocket = 100;
  server.maxConnections = 128;
  server.setTimeout(15000, socket => socket.destroy());
  return server;
}

async function start() {
  const port = Number(process.env.PORT || 8790);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
  const server = createServer({ configPath: process.env.MINI_CONFIG || path.join(root, 'apps.json') });
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  console.log(`Mini shortcuts listening on 127.0.0.1:${port}`);
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => { server.closeAllConnections(); process.exit(0); }, 5000).unref();
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  start().catch(() => {
    // Parser and filesystem errors can contain private configuration or paths.
    console.error('Mini shortcuts could not start; check the local configuration, files, and port.');
    process.exitCode = 1;
  });
}
