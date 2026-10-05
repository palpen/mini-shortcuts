import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const stylesheet = fs.readFileSync(path.join(root, 'public/style.css'));
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

export function loadConfig(configPath) {
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
  const config = JSON.parse(raw);
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
    entries.set(item.slug, {
      slug: item.slug, name: text(item.name, 120),
      description: item.description === undefined || item.description === '' ? '' : text(item.description, 300),
      url: httpsUrl(item.url).href,
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
        });
      }
    } finally {
      directory.closeSync();
    }
  }
  return { allowedHosts, entries };
}

function home(entries) {
  const cards = [...entries.values()].map(app => `<a href="/${escape(app.slug)}"><strong>${escape(app.name)}</strong><span>${escape(app.description)}</span><code>/${escape(app.slug)} →</code></a>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Mini · Your apps</title><link rel="stylesheet" href="/style.css"></head><body><main><small>Mac Mini · Private apps</small><h1>A little home<br>for your apps.</h1><p>Choose an app, or add <b>/app-name</b> to this address on a device connected to your Tailscale network.</p><div class="apps">${cards}</div><footer>Short names lead to each app’s secure HTTPS address.</footer></main></body></html>`;
}

export function createServer({ configPath = path.join(root, 'apps.json'), reloadMs = 1000, onConfigError = () => console.error('Shortcut configuration unavailable; check the local configuration.') } = {}) {
  let config = loadConfig(configPath);
  let checkedAt = performance.now();
  let hadError = false;
  const server = http.createServer({ maxHeaderSize: 8192, headersTimeout: 10000, requestTimeout: 15000, connectionsCheckingInterval: 1000 }, (req, res) => {
    const reply = (status, body = '', headers = {}) => {
      res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', ...headers });
      res.end(req.method === 'HEAD' ? undefined : body);
    };
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    if (!['GET', 'HEAD'].includes(req.method)) return reply(405, 'Method not allowed', { Allow: 'GET, HEAD', Connection: 'close' });
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
    if (pathname === '/') return reply(200, home(config.entries), { 'Content-Type': 'text/html; charset=utf-8' });
    if (pathname === '/style.css') return reply(200, stylesheet, { 'Content-Type': 'text/css; charset=utf-8' });
    const match = /^\/([a-zA-Z0-9_-]{1,80})\/?$/.exec(pathname);
    const app = match && config.entries.get(match[1]);
    if (app) return reply(302, '', { Location: app.url });
    return reply(404, 'Unknown shortcut. Open the home page to see your apps.');
  });
  server.keepAliveTimeout = 5000;
  server.maxRequestsPerSocket = 100;
  server.maxConnections = 128;
  server.setTimeout(15000, socket => socket.destroy());
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const port = Number(process.env.PORT || 8790);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
  const server = createServer({ configPath: process.env.MINI_CONFIG || path.join(root, 'apps.json') });
  server.listen(port, '127.0.0.1', () => console.log(`Mini shortcuts listening on 127.0.0.1:${port}`));
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => { server.closeAllConnections(); process.exit(0); }, 5000).unref();
  });
}
