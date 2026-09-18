import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../bin/archify.mjs', import.meta.url));
test('background editor survives CLI exit, reuses sessions, stops and restarts without changing delivered files', { timeout: 45000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'archify-session-'));
  const input = path.join(directory, 'source with spaces.json');
  const output = path.join(directory, 'diagram with spaces.html');
  fs.copyFileSync(new URL('../examples/web-app.architecture.json', import.meta.url), input);
  const run = async (...args) => JSON.parse((await exec(process.execPath, [cli, 'edit', ...args], { windowsHide: true, timeout: 15000 })).stdout);
  const waitStopped = async () => {
    for (let n = 0; n < 50 && fs.existsSync(output + '.editor-session.json'); n++) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(fs.existsSync(output + '.editor-session.json'), false);
  };
  try {
    assert.equal((await run('status', output)).running, false);
    const first = await run('start', 'architecture', input, output);
    assert.equal(first.running, true);
    const html = fs.readFileSync(output), source = fs.readFileSync(input);
    assert.equal((await fetch(first.url)).status, 200);
    const again = await run('start', 'architecture', input, output);
    assert.equal(again.url, first.url);
    assert.equal(again.reused, true);
    assert.equal((await run('status', output)).pid, first.pid);
    const discovered = await exec(process.execPath, [cli, 'edit', '--no-open'], { cwd: directory, windowsHide: true, timeout: 15000 });
    assert.ok(discovered.stdout.includes(first.url), 'Bare edit discovers and reuses the running diagram');
    await assert.rejects(run('start', 'architecture', input, output, '--quality', 'standard'), /different source or validation settings/);
    assert.equal((await fetch(new URL('stop', first.url), { method: 'POST' })).status, 403);
    assert.equal((await run('stop', output)).running, false);
    await waitStopped();
    assert.equal((await run('status', output)).running, false);
    assert.equal((await run('stop', output)).running, false);
    // Stale metadata after a host/process exit must not prevent restarting.
    fs.writeFileSync(output + '.editor-session.json', JSON.stringify(first));
    const restarted = await run('start', 'architecture', input, output);
    assert.notEqual(restarted.url, first.url);
    assert.deepEqual(fs.readFileSync(output), html);
    assert.deepEqual(fs.readFileSync(input), source);
    await run('stop', output); await waitStopped();
    await assert.rejects(run('start', 'workflow', input, output), /Usage/);
  } finally {
    await run('stop', output).catch(() => {});
    await waitStopped();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
