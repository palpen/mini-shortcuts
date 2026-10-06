import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createServer, loadConfig, stopApp } from '../server.mjs';

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

test('startup failures exit unsuccessfully without logging private values or paths', t => {
  const { dir, configPath, write } = fixture(t);
  const script = fileURLToPath(new URL('../server.mjs', import.meta.url));
  const diagnostic = 'Mini shortcuts could not start; check the local configuration, files, and port.\n';
  const run = (env = {}, entry = script) => {
    const result = spawnSync(process.execPath, [fs.realpathSync(entry)], {
      env: { ...process.env, MINI_CONFIG: configPath, PORT: '8790', ...env },
      encoding: 'utf8', timeout: 5000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, diagnostic);
  };
  fs.writeFileSync(configPath, '{"secret":"FAKE_PRIVATE_VALUE", broken');
  run();
  const config = base();
  config.apps[0].url = 'https://[invalid]/?token=FAKE_PRIVATE_VALUE';
  write(config);
  run();
  run({ MINI_CONFIG: path.join(dir, 'private-missing-config.json') });
  run({ PORT: 'invalid' });
  // Missing startup assets must not leak their absolute filesystem paths either.
  const isolatedScript = path.join(dir, 'server.mjs');
  fs.copyFileSync(script, isolatedScript);
  run({}, isolatedScript);
});

test('a port conflict produces a sanitized startup failure', async t => {
  const { server, configPath } = await running(t);
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../server.mjs', import.meta.url))], {
    env: { ...process.env, MINI_CONFIG: configPath, PORT: String(server.address().port) },
    encoding: 'utf8', timeout: 5000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'Mini shortcuts could not start; check the local configuration, files, and port.\n');
});

const manage = (request, slug, action, headers = {}) => request(`/api/apps/${slug}/${action}`, { 'X-Mini-Request': '1', ...headers }, 'POST');

test('minimize and restore persist across restarts without stopping apps or breaking shortcuts', async t => {
  let stops = 0;
  const { request, configPath } = await running(t, base(), { shutdown: async () => { stops++; } });
  assert.equal((await manage(request, 'pigeon', 'minimize')).status, 200);
  let home = (await request()).body;
  assert.match(home, /id="minimized"/);
  assert.ok(home.indexOf('id="minimized"') < home.indexOf('href="/pigeon"'));
  assert.equal((await request('/pigeon')).status, 302);
  const restarted = await running(t, base(), { configPath });
  assert.match((await restarted.request()).body, /id="minimized"/);
  assert.equal((await manage(request, 'pigeon', 'restore')).status, 200);
  home = (await request()).body;
  assert.ok(!home.includes('id="minimized"'));
  assert.equal(stops, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')), base());
});

test('remove only hides the shortcut, supports restore, and never stops the service', async t => {
  let stops = 0;
  const config = base();
  config.apps[0].service = { type: 'launchAgent', label: 'com.example.pigeon' };
  const { request, configPath } = await running(t, config, { shutdown: async () => { stops++; } });
  assert.equal((await manage(request, 'pigeon', 'remove')).status, 200);
  assert.equal((await request('/pigeon')).status, 404);
  assert.match((await request()).body, /Removed from this directory only/);
  const restarted = await running(t, config, { configPath });
  assert.equal((await restarted.request('/pigeon')).status, 404);
  assert.equal((await manage(request, 'pigeon', 'restore')).status, 200);
  assert.equal((await request('/pigeon')).status, 302);
  assert.equal(stops, 0);
});

test('management rejects cross-site requests, missing custom headers, bodies, and unknown actions', async t => {
  let stops = 0;
  const { request, dir } = await running(t, base(), { shutdown: async () => { stops++; } });
  const route = '/api/apps/pigeon/remove';
  assert.equal((await request(route, {}, 'POST')).status, 403);
  assert.equal((await manage(request, 'pigeon', 'remove', { Origin: 'https://attacker.example' })).status, 403);
  assert.equal((await manage(request, 'pigeon', 'remove', { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate' })).status, 403);
  assert.equal((await manage(request, 'pigeon', 'remove', { Host: 'attacker.example' })).status, 403);
  assert.equal((await request(route, {}, 'OPTIONS')).status, 405);
  assert.equal((await request(route)).status, 404);
  assert.equal((await request(route, {}, 'HEAD')).status, 404);
  assert.equal((await manage(request, 'missing', 'remove')).status, 404);
  assert.equal((await manage(request, 'pigeon', 'execute')).status, 405);
  assert.equal((await manage(request, '..', 'remove')).status, 405);
  assert.equal((await manage(request, 'pigeon', 'remove?label=com.other.app')).status, 405);
  assert.equal((await manage(request, 'pigeon', 'remove', { 'Content-Length': '1' })).status, 400);
  assert.equal((await manage(request, 'pigeon', 'shutdown')).status, 409);
  assert.equal((await request('/pigeon')).status, 302);
  assert.ok(!fs.existsSync(path.join(dir, 'apps.state.json')));
  assert.equal(stops, 0);
});

test('shutdown removes first, uses only the configured target, and saves confirmed status', async t => {
  const config = base();
  config.apps[0].service = { type: 'launchAgent', label: 'com.example.pigeon' };
  let target;
  const { request, dir } = await running(t, config, { shutdown: async app => {
    target = app.shutdown;
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'apps.state.json'))).apps.pigeon.shutdown, 'pending');
    assert.equal((await request('/pigeon')).status, 404);
  } });
  assert.equal((await manage(request, 'pigeon', 'shutdown', { 'X-Service': 'com.unrelated.app' })).status, 200);
  assert.deepEqual(target, { type: 'launchAgent', label: 'com.example.pigeon' });
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'apps.state.json'))).apps.pigeon.shutdown, 'stopped');
  assert.match((await request()).body, /Shut down<\/span>/);
  assert.equal((await manage(request, 'pigeon', 'restore')).status, 409);
  assert.equal(fs.statSync(path.join(dir, 'apps.state.json')).mode & 0o777, 0o600);
});

test('shutdown failures remain removed, sanitize errors, and allow a later retry', async t => {
  const config = base();
  config.apps[0].service = { type: 'launchAgent', label: 'com.example.pigeon' };
  let attempts = 0;
  const { request, configPath } = await running(t, config, { shutdown: async () => {
    if (++attempts === 1) throw new Error('/private/service/path: secret');
  } });
  const failure = await manage(request, 'pigeon', 'shutdown');
  assert.equal(failure.status, 502);
  assert.ok(!failure.body.includes('secret'));
  assert.equal((await request('/pigeon')).status, 404);
  assert.match((await request()).body, /Shutdown failed/);
  const restarted = await running(t, config, { configPath });
  assert.match((await restarted.request()).body, /Shutdown failed/);
  assert.equal((await manage(request, 'pigeon', 'shutdown')).status, 200);
  assert.equal(attempts, 2);
});

test('failure to save removal never stops an app', async t => {
  const config = base();
  config.apps[0].service = { type: 'launchAgent', label: 'com.example.pigeon' };
  let stops = 0;
  const { request, dir } = await running(t, config, { shutdown: async () => { stops++; } });
  fs.mkdirSync(path.join(dir, 'apps.state.json'));
  assert.equal((await manage(request, 'pigeon', 'shutdown')).status, 503);
  assert.equal(stops, 0);
  assert.equal((await request('/pigeon')).status, 302);
  assert.ok(!fs.readdirSync(dir).some(name => name.endsWith('.tmp')));
});

test('simultaneous changes are rejected while a shutdown is in progress', async t => {
  const config = base();
  config.apps[0].service = { type: 'launchAgent', label: 'com.example.pigeon' };
  let release, started;
  const began = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const { request } = await running(t, config, { shutdown: async () => { started(); await gate; } });
  const first = manage(request, 'pigeon', 'shutdown');
  await began;
  try {
    assert.equal((await manage(request, 'pigeon', 'restore')).status, 409);
    assert.equal((await manage(request, 'pigeon', 'shutdown')).status, 409);
  } finally { release(); }
  assert.equal((await first).status, 200);
});

test('Tailnow shutdown archives only the selected site and removed discoveries stay hidden', async t => {
  const { request, dir, write, configPath } = await running(t, base(), { reloadMs: 0 });
  const sites = path.join(dir, 'sites');
  fs.mkdirSync(sites);
  for (const slug of ['weather', 'notes']) {
    fs.mkdirSync(path.join(sites, slug));
    fs.writeFileSync(path.join(sites, slug, 'index.html'), slug);
  }
  write({ ...base(), tailnow: { directory: sites, url: 'https://published.example/' } });
  assert.equal((await manage(request, 'weather', 'remove')).status, 200);
  assert.equal((await request('/weather')).status, 404);
  assert.ok(fs.existsSync(path.join(sites, 'weather/index.html')));
  assert.equal((await manage(request, 'weather', 'shutdown')).status, 200);
  assert.ok(!fs.existsSync(path.join(sites, 'weather')));
  assert.equal(fs.readFileSync(path.join(sites, 'notes/index.html'), 'utf8'), 'notes');
  const archive = `${sites}.mini-shortcuts-archive`;
  const [archived] = fs.readdirSync(archive);
  assert.equal(fs.readFileSync(path.join(archive, archived, 'index.html'), 'utf8'), 'weather');
  assert.equal((await request('/notes')).status, 302);
  assert.match((await request()).body, /Shut down<\/span>/);
  const restarted = await running(t, base(), { configPath });
  assert.equal((await restarted.request('/weather')).status, 404);
  assert.match((await restarted.request()).body, /Shut down<\/span>/);
});

test('Tailnow shutdown refuses replaced site and archive symlinks', async t => {
  const { dir } = fixture(t);
  const sites = path.join(dir, 'sites');
  const outside = path.join(dir, 'outside');
  fs.mkdirSync(sites); fs.mkdirSync(outside);
  const app = { shutdown: { type: 'tailnow', directory: sites, slug: 'weather' } };
  fs.symlinkSync(outside, path.join(sites, 'weather'));
  await assert.rejects(stopApp(app));
  fs.unlinkSync(path.join(sites, 'weather'));
  fs.mkdirSync(path.join(sites, 'weather'));
  fs.symlinkSync(outside, `${sites}.mini-shortcuts-archive`);
  await assert.rejects(stopApp(app));
  assert.ok(fs.existsSync(path.join(sites, 'weather')));
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('LaunchAgent shutdown disables automatic restart, unloads, and verifies absence without a shell', async () => {
  const calls = [];
  const app = { shutdown: { type: 'launchAgent', label: 'com.example.pigeon' } };
  const run = async (file, args, options) => {
    calls.push(args);
    assert.equal(file, '/bin/launchctl');
    assert.equal(options.shell, undefined);
    assert.equal(options.timeout, 3000);
    if (args[0] === 'print') throw Object.assign(new Error('missing'), { code: 113, stderr: 'Could not find service "com.example.pigeon"' });
  };
  await stopApp(app, { run, platform: 'darwin', uid: 501 });
  assert.deepEqual(calls, ['disable', 'bootout', 'print'].map(action => [action, 'gui/501/com.example.pigeon']));
  await assert.rejects(stopApp(app, { run: async () => ({}), platform: 'darwin', uid: 501 }), /still loaded/);
  await assert.rejects(stopApp(app, { run: async () => { throw new Error('denied'); }, platform: 'darwin', uid: 501 }));
  await assert.rejects(stopApp(app, { run, platform: 'linux', uid: 501 }));
});

test('configuration rejects unsafe service mappings and broken persistent state', t => {
  const { configPath, write, dir } = fixture(t);
  for (const service of [null, { type: 'shell', label: 'foo' }, { type: 'launchAgent', label: '../foo' },
    { type: 'launchAgent', label: 'foo;reboot' }, { type: 'launchAgent', label: '-x' }]) {
    write({ ...base(), apps: [{ ...base().apps[0], service }] });
    assert.throws(() => loadConfig(configPath));
  }
  write(base());
  for (const state of ['secret-invalid-json', '{"version":1,"apps":[]}', '{"version":1,"apps":{"bad/path":{}}}']) {
    fs.writeFileSync(path.join(dir, 'apps.state.json'), state);
    assert.throws(() => createServer({ configPath }));
  }
});

test('special property names are safe app slugs and state never leaks through HTTP', async t => {
  const config = base();
  config.apps[0].slug = '__proto__';
  const { request } = await running(t, config);
  assert.equal((await manage(request, '__proto__', 'minimize')).status, 200);
  assert.equal((await request('/__proto__')).status, 302);
  assert.match((await request()).body, /id="minimized"/);
  assert.equal((await manage(request, '__proto__', 'remove')).status, 200);
  assert.equal((await request('/__proto__')).status, 404);
  assert.equal((await request('/apps.state.json')).status, 404);
  assert.equal((await request('/app.js')).headers['content-type'], 'text/javascript; charset=utf-8');
});
