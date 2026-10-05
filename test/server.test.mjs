import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createServer, loadConfig } from '../server.mjs';

const base = () => ({
  allowedHosts: ['mini', '127.0.0.1:8790'],
  apps: [{ slug: 'pigeon', name: 'Pigeon', description: 'Files', url: 'https://destination.example:8443/' }],
});

function fixture(t, config = base()) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-shortcuts-test-'));
  const configPath = path.join(dir, 'apps.json');
  const write = value => fs.writeFileSync(configPath, JSON.stringify(value));
  write(config);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, configPath, write };
}

async function running(t, config = base(), options = {}) {
  const files = fixture(t, config);
  const server = createServer({ configPath: files.configPath, ...options });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  function request(target = '/', headers = {}, method = 'GET') {
    return new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path: target,
        method, headers: { Host: 'mini', ...headers }, agent: false }, res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
      });
      req.on('error', reject);
      req.end();
    });
  }
  return { ...files, server, request };
}

test('home escapes configured text and serves CSS under a restrictive CSP', async t => {
  const config = base();
  config.apps[0].name = '<script>alert(1)</script>';
  config.apps[0].description = '"><img src=x onerror=alert(1)>';
  const { request } = await running(t, config);
  const home = await request();
  assert.equal(home.status, 200);
  assert.ok(home.body.includes('&lt;script&gt;'));
  assert.ok(!home.body.includes('<script>'));
  assert.ok(!home.body.includes('<img'));
  assert.ok(home.headers['content-security-policy'].includes("default-src 'none'"));
  assert.ok(!home.headers['content-security-policy'].includes('unsafe-inline'));
  assert.equal(home.headers['referrer-policy'], 'no-referrer');
  assert.equal(home.headers['x-frame-options'], 'DENY');
  assert.equal(home.headers['cache-control'], 'no-store');
  assert.equal((await request('/style.css')).headers['content-type'], 'text/css; charset=utf-8');
});

test('rejects unknown, deceptive, malformed, and duplicate Host headers', async t => {
  const { request, server } = await running(t);
  for (const host of ['attacker.example', 'mini.attacker.example', 'mini@attacker.example', 'mini:9999']) {
    const result = await request('/', { Host: host });
    assert.ok([400, 403].includes(result.status), JSON.stringify(host));
    assert.ok(!result.body.includes('Pigeon'));
  }
  const raw = await new Promise((resolve, reject) => {
    const socket = net.connect(server.address().port, '127.0.0.1', () => {
      socket.write('GET / HTTP/1.1\r\nHost: mini\r\nHost: attacker.example\r\nConnection: close\r\n\r\n');
    });
    let response = '';
    socket.on('data', chunk => { response += chunk; });
    socket.on('end', () => resolve(response));
    socket.on('error', reject);
  });
  assert.match(raw, /^HTTP\/1\.1 (400|403)/);
  assert.equal((await request('/', { Host: 'MINI:80' })).status, 200);
});

test('rejects cross-origin fetches while allowing normal link navigation', async t => {
  const { request } = await running(t);
  assert.equal((await request('/', { Origin: 'https://attacker.example' })).status, 403);
  assert.equal((await request('/', { Origin: 'null' })).status, 403);
  assert.equal((await request('/', { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'cors' })).status, 403);
  assert.equal((await request('/pigeon', { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate' })).status, 302);
  assert.equal((await request('/', { Origin: 'http://mini' })).status, 200);
});

test('redirect destinations come only from local configuration', async t => {
  const { request } = await running(t);
  for (const target of ['/pigeon', '/pigeon/', '/pigeon?url=https://attacker.example', '/pigeon?next=//attacker.example']) {
    const result = await request(target, { 'X-Forwarded-Host': 'attacker.example' });
    assert.equal(result.status, 302);
    assert.equal(result.headers.location, 'https://destination.example:8443/');
  }
});

test('does not expose source, configuration, directory traversal, or unknown paths', async t => {
  const { request } = await running(t);
  for (const target of ['/apps.json', '/server.mjs', '/.git/config', '/backups/', '/%2e%2e/apps.json', '/../pigeon', '/pigeon/extra', '/unknown']) {
    assert.equal((await request(target)).status, 404, target);
  }
  for (const target of ['//attacker.example/pigeon', 'https://attacker.example/pigeon', '/\\attacker.example']) {
    assert.equal((await request(target)).status, 400, target);
  }
});

test('allows only read requests without bodies and returns empty HEAD responses', async t => {
  const { request } = await running(t);
  assert.equal((await request('/', {}, 'POST')).status, 405);
  assert.equal((await request('/pigeon', {}, 'DELETE')).status, 405);
  assert.equal((await request('/', { 'Content-Length': '1' })).status, 400);
  const head = await request('/', {}, 'HEAD');
  assert.equal(head.status, 200);
  assert.equal(head.body, '');
  const redirect = await request('/pigeon', {}, 'HEAD');
  assert.equal(redirect.status, 302);
  assert.equal(redirect.body, '');
});

test('rejects oversized request targets and headers', async t => {
  const { request } = await running(t);
  assert.equal((await request('/' + 'x'.repeat(2100))).status, 414);
  assert.equal((await request('/', { 'X-Large': 'x'.repeat(10000) })).status, 431);
});

test('invalid destinations are rejected in explicit and discovered app configuration', t => {
  const { configPath, write, dir } = fixture(t);
  for (const url of ['http://destination.example/', 'javascript:alert(1)', 'file:///etc/passwd', '//destination.example/', 'https://user:password@destination.example/', 'https://destination.example/\r\nX-Test:value']) {
    const config = base(); config.apps[0].url = url; write(config);
    assert.throws(() => loadConfig(configPath), url);
    write({ ...base(), tailnow: { directory: dir, url } });
    assert.throws(() => loadConfig(configPath), `Tailnow ${url}`);
  }
  for (const url of ['https://destination.example/path', 'https://destination.example/?secret=x', 'https://destination.example/#fragment']) {
    write({ ...base(), tailnow: { directory: dir, url } });
    assert.throws(() => loadConfig(configPath));
  }
});

test('validates configuration shape, text, host names, slugs, and size', t => {
  const { configPath, write } = fixture(t);
  for (const config of [null, {}, { ...base(), allowedHosts: [] }, { ...base(), allowedHosts: ['mini/'] },
    { ...base(), apps: [null] }, { ...base(), apps: [base().apps[0], base().apps[0]] },
    { ...base(), apps: [{ ...base().apps[0], slug: '../secret' }] },
    { ...base(), apps: [{ ...base().apps[0], name: 123 }] },
    { ...base(), apps: [{ ...base().apps[0], description: 'x'.repeat(301) }] }]) {
    write(config); assert.throws(() => loadConfig(configPath));
  }
  fs.writeFileSync(configPath, ' '.repeat(128 * 1024 + 1));
  assert.throws(() => loadConfig(configPath), /too large/);
});

test('discovers real Tailnow directories, ignores symlinks, and preserves explicit overrides', t => {
  const { dir, configPath, write } = fixture(t);
  for (const name of ['weather', 'hello-world', 'pigeon', 'bad name']) fs.mkdirSync(path.join(dir, name));
  fs.symlinkSync(path.join(dir, 'weather'), path.join(dir, 'linked-site'));
  write({ ...base(), tailnow: { directory: dir, url: 'https://published.example/sites/' } });
  const { entries } = loadConfig(configPath);
  assert.equal(entries.get('weather').url, 'https://published.example/sites/weather/');
  assert.equal(entries.get('pigeon').url, base().apps[0].url);
  assert.ok(!entries.has('linked-site'));
  assert.ok(!entries.has('bad name'));
  assert.ok(!entries.has('apps.json'));
});

test('fails closed on a broken reload and recovers without leaking configuration errors', async t => {
  let errors = 0;
  const { request, configPath, write } = await running(t, base(), { reloadMs: 0, onConfigError: () => errors++ });
  fs.writeFileSync(configPath, '{private-secret-path');
  const result = await request();
  assert.equal(result.status, 503);
  assert.ok(!result.body.includes('private-secret-path'));
  await request();
  assert.equal(errors, 1);
  const config = base(); config.apps[0].url = 'https://updated.example/'; write(config);
  assert.equal((await request('/pigeon')).headers.location, 'https://updated.example/');
});

test('configuration cache avoids filesystem reads on every request', async t => {
  const { request, configPath } = await running(t, base(), { reloadMs: 60000 });
  fs.writeFileSync(configPath, 'invalid');
  assert.equal((await request()).status, 200);
});
