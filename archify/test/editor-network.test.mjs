import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import http from 'node:http';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { editorNetwork, editorUrl, parseEditorOptions } from '../bin/editor-network.mjs';
import { startEditorServer } from '../bin/editor-server.mjs';
import { commandSession } from '../bin/editor-session.mjs';

// Public, test-only self-signed certificate/key. Never use these for deployment.
const cert = fileURLToPath(new URL('./fixtures/editor-tls/cert.pem', import.meta.url));
const key = fileURLToPath(new URL('./fixtures/editor-tls/key.pem', import.meta.url));
const ca = fs.readFileSync(cert);

test('network options fail closed and keep HTTP limited to literal loopback binding', () => {
  assert.equal(editorNetwork().host, '127.0.0.1');
  for (const options of [
    { host: '0.0.0.0' }, { host: 'dev.test' }, { host: '::' },
    { tlsCert: cert }, { port: -1 }, { port: '12junk' }, { port: 65536 },
    { host: '0.0.0.0', tlsCert: cert, tlsKey: key },
    { origin: 'http://dev.test:8787' }, { origin: 'https://dev.test/path' },
    { origin: 'https://user:password@dev.test' }, { origin: 'https://dev.test/?x=1' },
    { origin: 'https://dev.test/#fragment' }, { origin: 'https://0.0.0.0' },
    { origin: 'http://localhost:8787', tlsCert: cert, tlsKey: key },
  ]) assert.throws(() => editorNetwork(options), JSON.stringify(options));
  assert.equal(editorNetwork({ origin: 'http://localhost:9000' }).origin, 'http://localhost:9000');
  assert.equal(editorNetwork({ host: '::1' }).host, '::1');
  assert.equal(editorNetwork({ host: '0.0.0.0', origin: 'https://dev.test', tlsCert: cert, tlsKey: key }).origin, 'https://dev.test');
  assert.throws(() => parseEditorOptions(['--host', 'localhost', '--host', '127.0.0.1']), /Duplicate/);
  assert.throws(() => parseEditorOptions(['--port']), /incomplete/);
  assert.throws(() => editorUrl(`http://dev.test/${'a'.repeat(64)}/`), /HTTPS/);
  assert.equal(editorUrl(`https://dev.test/${'a'.repeat(64)}/`).hostname, 'dev.test');
  assert.equal(parseEditorOptions(['--allow-insecure-http', '--port', '8787']).allowInsecureHttp, true);
  assert.throws(() => parseEditorOptions(['--allow-insecure-http', '--allow-insecure-http']), /Duplicate/);
  assert.throws(() => parseEditorOptions(['--allow-insecure-http', 'false']), /Unknown/);
  assert.throws(() => editorNetwork({ host: 'dev.test', allowInsecureHttp: 'true' }), /boolean/);
  assert.throws(() => editorNetwork({ allowInsecureHttp: true, tlsCert: cert, tlsKey: key }), /combined/);
  assert.throws(() => editorNetwork({ allowInsecureHttp: true, origin: 'https://dev.test' }), /HTTP origin/);
  assert.throws(() => editorNetwork({ host: '0.0.0.0', allowInsecureHttp: true }), /explicit/);
  assert.equal(editorNetwork({ host: '0.0.0.0', origin: 'http://dev.test:8787', allowInsecureHttp: true }).allowInsecureHttp, true);
  assert.equal(editorUrl(`http://dev.test/${'a'.repeat(64)}/`, { allowInsecureHttp: true }).hostname, 'dev.test');
});

test('explicit insecure HTTP supports hostname saves and discovery without persisting consent', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'archify-http-'));
  const input = path.join(directory, 'source.json'), output = path.join(directory, 'diagram.html');
  fs.copyFileSync(new URL('../examples/web-app.architecture.json', import.meta.url), input);
  const args = ['start', 'architecture', input, output, '--origin', 'http://dev.test', '--allow-insecure-http'];
  try {
    const session = await commandSession(args, { quiet: true });
    const route = new URL(session.url).pathname;
    const request = (target, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port: session.boundPort, path: target, method, headers: { Host: 'dev.test', ...headers } }, res => {
        let text = ''; res.on('data', chunk => { text += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, text }));
      });
      req.on('error', reject); req.end(body);
    });
    const page = await request(route);
    assert.equal(page.status, 200);
    assert.equal((await request(route, { headers: { Host: 'evil.test' } })).status, 403);
    const config = JSON.parse(page.text.match(/id="archify-save-session">(.*?)<\/script>/s)[1]);
    const spec = JSON.parse(fs.readFileSync(input)); spec.meta.title = 'Explicit HTTP save';
    const headers = { Origin: 'http://dev.test', 'X-Archify-Token': config.token, 'Content-Type': 'application/json' };
    const body = JSON.stringify({ revision: config.revision, spec });
    assert.equal((await request(config.saveUrl, { method: 'POST', headers: { ...headers, Origin: 'http://evil.test' }, body })).status, 403);
    assert.equal((await request(config.saveUrl, { method: 'POST', headers: { ...headers, 'X-Archify-Token': 'wrong' }, body })).status, 403);
    assert.equal((await request(config.saveUrl, { method: 'POST', headers, body })).status, 200);
    assert.equal(JSON.parse(fs.readFileSync(input)).meta.title, spec.meta.title);
    const cli = fileURLToPath(new URL('../bin/archify.mjs', import.meta.url));
    const discovered = await promisify(execFile)(process.execPath, [cli, 'edit', '--allow-insecure-http', output, '--no-open', '--origin', 'http://dev.test'], { cwd: directory, windowsHide: true });
    assert.ok(discovered.stdout.includes(session.url));
    await assert.rejects(commandSession(args.slice(0, -1), { quiet: true }), /explicit/);
    await assert.rejects(commandSession(args.slice(0, 4), { quiet: true }), /network settings/);
    assert.equal(JSON.parse(fs.readFileSync(output + '.editor-settings.json')).allowInsecureHttp, undefined);
    await commandSession(['stop', output]);
    for (let i = 0; i < 50 && fs.existsSync(output + '.editor-session.json'); i++) await new Promise(resolve => setTimeout(resolve, 20));
    const local = await commandSession(args.slice(0, 4), { quiet: true });
    assert.ok(local.url.startsWith('http://127.0.0.1:'));
    assert.equal(local.network.allowInsecureHttp, undefined);
  } finally {
    await commandSession(['stop', output]);
    for (let i = 0; i < 50 && fs.existsSync(output + '.editor-session.json'); i++) await new Promise(resolve => setTimeout(resolve, 20));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('TLS hostname service validates certificates, Host, Origin and independent control credentials', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'archify-network-'));
  const input = path.join(directory, 'source.json'), output = path.join(directory, 'diagram.html');
  fs.copyFileSync(new URL('../examples/web-app.architecture.json', import.meta.url), input);
  const session = await startEditorServer({ input, output, host: '127.0.0.1', origin: 'https://dev.test', tlsCert: cert, tlsKey: key });
  const route = new URL(session.url).pathname;
  function request(target, { method = 'GET', headers = {}, body, trust = ca } = {}) {
    return new Promise((resolve, reject) => {
      const req = https.request({ hostname: '127.0.0.1', port: session.port, servername: 'dev.test', ca: trust, method, path: target, headers: { Host: 'dev.test', ...headers } }, res => {
        let text = ''; res.on('data', chunk => { text += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
      });
      req.on('error', reject); req.end(body);
    });
  }
  try {
    await assert.rejects(request(route, { trust: null }));
    assert.equal((await request(route, { headers: { Host: 'evil.test', 'X-Forwarded-Host': 'dev.test' } })).status, 403);
    assert.equal((await request('/wrong/')).status, 404);
    const page = await request(route);
    assert.equal(page.status, 200);
    assert.equal(page.headers['content-security-policy'], "frame-ancestors 'none'");
    assert.equal(page.headers['referrer-policy'], 'no-referrer');
    const config = JSON.parse(page.text.match(/id="archify-save-session">(.*?)<\/script>/s)[1]);
    assert.equal((await request(config.heartbeatUrl)).status, 403);
    const spec = JSON.parse(fs.readFileSync(input)); spec.meta.title = 'Saved securely by hostname';
    const headers = { Origin: 'https://dev.test', 'X-Archify-Token': config.token, 'Content-Type': 'application/json' };
    const body = JSON.stringify({ revision: config.revision, spec });
    assert.equal((await request(config.saveUrl, { method: 'POST', headers: { ...headers, Origin: 'https://evil.test', 'X-Forwarded-Host': 'dev.test' }, body })).status, 403);
    assert.equal((await request(config.saveUrl, { method: 'POST', headers: { ...headers, 'X-Archify-Token': 'wrong' }, body })).status, 403);
    assert.equal((await request(config.saveUrl, { method: 'POST', headers, body })).status, 200);
    assert.equal(JSON.parse(fs.readFileSync(input)).meta.title, spec.meta.title);
    const control = new URL(session.controlUrl), token = control.pathname.split('/')[1];
    assert.equal((await fetch(new URL('heartbeat', control), { headers: { 'X-Archify-Token': config.token } })).status, 403);
    assert.equal((await fetch(control, { headers: { 'X-Archify-Token': token } })).status, 404);
    assert.equal((await fetch(new URL('heartbeat', control), { headers: { 'X-Archify-Token': token } })).status, 200);
    const settings = JSON.parse(fs.readFileSync(output + '.editor-settings.json'));
    assert.equal(settings.host, undefined, 'Network exposure must not persist as a default');
    assert.equal(settings.tlsKey, undefined);
  } finally {
    await new Promise(resolve => session.server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('managed TLS sessions reuse matching bindings and stop through loopback without trusting the public hostname', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'archify-network-session-'));
  const input = path.join(directory, 'source.json'), output = path.join(directory, 'diagram.html');
  fs.copyFileSync(new URL('../examples/web-app.architecture.json', import.meta.url), input);
  const args = ['start', 'architecture', input, output, '--origin', 'https://dev.test', '--tls-cert', cert, '--tls-key', key];
  try {
    const first = await commandSession(args, { quiet: true });
    assert.ok(first.url.startsWith('https://dev.test/'));
    assert.ok(first.controlUrl.startsWith('http://127.0.0.1:'));
    assert.equal((await commandSession(args, { quiet: true })).reused, true);
    const cli = fileURLToPath(new URL('../bin/archify.mjs', import.meta.url));
    const discovered = await promisify(execFile)(process.execPath, [cli, 'edit', output, '--no-open', '--origin', 'https://dev.test', '--tls-cert', cert, '--tls-key', key], { cwd: directory, windowsHide: true });
    assert.ok(discovered.stdout.includes(first.url), 'Discovery forwards explicitly requested network options');
    await assert.rejects(commandSession(['start', 'architecture', input, output], { quiet: true }), /network settings/);
    await commandSession(['status', output]);
    await commandSession(['stop', output]);
    for (let i = 0; i < 50 && fs.existsSync(output + '.editor-session.json'); i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(fs.existsSync(output + '.editor-session.json'), false);
    const local = await commandSession(['start', 'architecture', input, output], { quiet: true });
    assert.ok(local.url.startsWith('http://127.0.0.1:'));
  } finally {
    await commandSession(['stop', output]);
    for (let i = 0; i < 50 && fs.existsSync(output + '.editor-session.json'); i++) await new Promise(resolve => setTimeout(resolve, 20));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('SSH-style TCP forwarding supports a different browser port with an exact loopback origin', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'archify-tunnel-'));
  const input = path.join(directory, 'source.json'), output = path.join(directory, 'diagram.html');
  fs.copyFileSync(new URL('../examples/web-app.architecture.json', import.meta.url), input);
  let destination, session;
  const sockets = new Set();
  const tunnel = net.createServer(socket => {
    const upstream = net.connect(destination, '127.0.0.1');
    sockets.add(socket); sockets.add(upstream);
    socket.on('error', () => upstream.destroy()); upstream.on('error', () => socket.destroy());
    socket.on('close', () => sockets.delete(socket)); upstream.on('close', () => sockets.delete(upstream));
    socket.pipe(upstream).pipe(socket);
  });
  await new Promise(resolve => tunnel.listen(0, '127.0.0.1', resolve));
  try {
    const origin = `http://127.0.0.1:${tunnel.address().port}`;
    session = await startEditorServer({ input, output, origin });
    destination = session.port;
    const page = await fetch(session.url);
    assert.equal(page.status, 200);
    const config = JSON.parse((await page.text()).match(/id="archify-save-session">(.*?)<\/script>/s)[1]);
    const spec = JSON.parse(fs.readFileSync(input)); spec.meta.title = 'Saved through a tunnel';
    const saved = await fetch(new URL(config.saveUrl, session.url), { method: 'POST', headers: { Origin: origin, 'X-Archify-Token': config.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: config.revision, spec }) });
    assert.equal(saved.status, 200);
    assert.equal(JSON.parse(fs.readFileSync(input)).meta.title, spec.meta.title);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => tunnel.close(resolve));
    if (session) await new Promise(resolve => session.server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
