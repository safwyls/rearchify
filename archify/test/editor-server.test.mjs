import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { startEditorServer } from '../bin/editor-server.mjs';
import { discoverDiagrams } from '../bin/editor-discovery.mjs';
import { ChromeVisualBrowser, findChrome } from '../bin/visual-check.mjs';

test('local editor delivers source and artifact together, rejects invalid or stale saves and foreign requests', { timeout: 90000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'archify-save-'));
  const input = path.join(directory, 'source.json'), output = path.join(directory, 'diagram.html');
  fs.copyFileSync(new URL('../examples/web-app.architecture.json', import.meta.url), input);
  const session = await startEditorServer({ input, output });
  const getSession = async () => JSON.parse((await (await fetch(session.url)).text()).match(/id="archify-save-session">(.*?)<\/script>/s)[1]);
  const config = await getSession();
  const save = (payload, origin = new URL(session.url).origin) => fetch(new URL(config.saveUrl, session.url), { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Archify-Token': config.token, Origin: origin }, body: JSON.stringify(payload) });
  try {
    const heartbeat = new URL(config.heartbeatUrl, session.url);
    assert.equal((await fetch(heartbeat)).status, 403);
    assert.equal((await fetch(heartbeat, { headers: { 'X-Archify-Token': config.token, Origin: 'https://example.com' } })).status, 403);
    assert.deepEqual(await (await fetch(heartbeat, { headers: { 'X-Archify-Token': config.token } })).json(), { ok: true });
    const spec = JSON.parse(fs.readFileSync(input));
    spec.meta.title = 'Saved from the viewer';
    assert.equal((await save({ revision: config.revision, spec }, 'https://example.com')).status, 403);
    const saved = await save({ revision: config.revision, spec });
    const receipt = await saved.json();
    assert.equal(saved.status, 200, JSON.stringify(receipt));
    assert.equal(JSON.parse(fs.readFileSync(input)).meta.title, spec.meta.title);
    assert.match(fs.readFileSync(output, 'utf8'), /Saved from the viewer/);
    const digest = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    assert.equal(receipt.receipt.specification.sha256, digest(input));
    assert.equal(receipt.receipt.artifact.sha256, digest(output));
    assert.equal(receipt.receipt.input, input);
    assert.equal(receipt.receipt.output, output);
    assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'diagram.delivery.json'))).ok, true);
    assert.equal((await save({ revision: config.revision, spec })).status, 409);
    const stableInput = fs.readFileSync(input), stableOutput = fs.readFileSync(output);
    const invalid = structuredClone(spec); invalid.components[0].id = 'invalid id';
    assert.equal((await save({ revision: receipt.revision, spec: invalid })).status, 422);
    assert.deepEqual(fs.readFileSync(input), stableInput);
    assert.deepEqual(fs.readFileSync(output), stableOutput);
    fs.appendFileSync(input, '\n');
    assert.equal((await save({ revision: receipt.revision, spec })).status, 409);
    assert.equal(fs.readdirSync(directory).some(name => name.startsWith('.archify-editor-')), false);
  } finally {
    await new Promise(resolve => session.server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

const chrome = findChrome();
test('editor rejects stale artifacts and survives missing files; settings survive restart', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'archify-save-recovery-'));
  const input = path.join(directory, 'source.json'), output = path.join(directory, 'diagram.html');
  const spec = JSON.parse(fs.readFileSync(new URL('../examples/web-app.architecture.json', import.meta.url)));
  delete spec.meta.quality_profile;
  fs.writeFileSync(input, JSON.stringify(spec));
  let session = await startEditorServer({ input, output, quality: 'showcase', repoRoot: directory });
  try {
    const artifact = fs.readFileSync(output);
    const changed = structuredClone(spec); changed.meta.title = 'External source change';
    fs.writeFileSync(input, JSON.stringify(changed));
    assert.equal((await fetch(session.url)).status, 409);
    assert.deepEqual(JSON.parse(fs.readFileSync(input)), changed);
    fs.writeFileSync(input, JSON.stringify(spec));
    fs.unlinkSync(output);
    assert.equal((await fetch(session.url)).status, 503);
    fs.writeFileSync(output, artifact);
    assert.equal((await fetch(session.url)).status, 200);
    await new Promise(resolve => session.server.close(resolve));
    const pair = discoverDiagrams(directory)[0];
    assert.equal(pair.quality, 'showcase');
    assert.equal(pair.repoRoot, directory);
    session = await startEditorServer(pair);
    const html = await (await fetch(session.url)).text();
    const config = JSON.parse(html.match(/id="archify-save-session">(.*?)<\/script>/s)[1]);
    const saved = await fetch(new URL(config.saveUrl, session.url), { method: 'POST', headers: { Origin: new URL(session.url).origin, 'Content-Type': 'application/json', 'X-Archify-Token': config.token }, body: JSON.stringify({ revision: config.revision, spec }) });
    assert.equal(saved.status, 200);
    assert.equal((await saved.json()).receipt.validation.compositionProfile, 'showcase');
    const collision = path.join(directory, 'collision.html.editor-settings.json');
    fs.writeFileSync(collision, JSON.stringify(spec));
    await assert.rejects(startEditorServer({ input: collision, output: path.join(directory, 'collision.html') }), /must not overwrite the source/);
    assert.deepEqual(JSON.parse(fs.readFileSync(collision)), spec);
  } finally {
    await new Promise(resolve => session.server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
test('main-view Save & deliver survives Apply and commits the edited JSON from the browser', { skip: !chrome, timeout: 90000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'archify-browser-save-'));
  const input = path.join(directory, 'source.json'), output = path.join(directory, 'diagram.html');
  fs.copyFileSync(new URL('../examples/web-app.architecture.json', import.meta.url), input);
  const session = await startEditorServer({ input, output });
  const browser = new ChromeVisualBrowser(chrome);
  try {
    const id = await browser.sessionPromise;
    const send = (method, params = {}) => browser.cdp.send(method, params, id);
    const evaluate = async expression => {
      const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      assert.equal(result.exceptionDetails, undefined, result.exceptionDetails?.exception?.description);
      return result.result.value;
    };
    const loaded = browser.cdp.waitFor('Page.loadEventFired', id);
    await send('Page.navigate', { url: session.url }); await loaded;
    assert.equal(await evaluate(`document.getElementById('btn-save-deliver').hidden`), true);
    await evaluate(`document.getElementById('btn-edit-layout').click();document.querySelector('[data-action="fit"]').click()`);
    assert.equal(await evaluate(`document.querySelector('[data-action="fit"]').classList.contains('editor-clicked')`), true);
    await evaluate(`new Promise(resolve=>setTimeout(resolve,300))`);
    assert.equal(await evaluate(`document.querySelector('[data-action="fit"]').classList.contains('editor-clicked')`), false);
    await evaluate(`document.querySelector('[data-action="fit"]').focus()`);
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    assert.equal(await evaluate(`document.querySelector('[data-action="fit"]').classList.contains('editor-clicked')`), true);
    await evaluate(`document.querySelector('[data-action="cancel"]').click()`);
    const applied = browser.cdp.waitFor('Page.loadEventFired', id);
    await evaluate(`document.getElementById('btn-edit-layout').click();const n=document.querySelector('#architecture-editor [data-node-id="api"] > rect');const r=n.getBoundingClientRect();n.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:r.x,clientY:r.y}));document.querySelector('[data-action="relabel"]').click();document.getElementById('editor-label').value='API saved';document.querySelector('[data-action="label"]').click();document.querySelector('[data-action="apply"]').click();`);
    await applied;
    const waitSaveHidden = hidden => evaluate(`new Promise((resolve,reject)=>{const deadline=Date.now()+10000;const timer=setInterval(()=>{if(document.getElementById('btn-save-deliver')?.hidden===${hidden}){clearInterval(timer);resolve();}else if(Date.now()>deadline){clearInterval(timer);reject(Error('Save visibility timeout'));}},20)})`);
    await waitSaveHidden(false);
    assert.equal(await evaluate(`getComputedStyle(document.getElementById('btn-save-deliver')).backgroundColor`), 'rgb(185, 28, 28)');
    await send('Network.enable');
    await send('Network.setBlockedURLs', { urls: ['*heartbeat'] });
    await waitSaveHidden(true);
    assert.equal(await evaluate(`JSON.parse(document.getElementById('archify-editor-data').textContent).spec.components.find(n=>n.id==='api').label`), 'API saved');
    await send('Network.setBlockedURLs', { urls: [] });
    await evaluate(`window.dispatchEvent(new Event('online'))`);
    await waitSaveHidden(false);
    const reloaded = browser.cdp.waitFor('Page.loadEventFired', id);
    await evaluate(`document.getElementById('btn-save-deliver').click()`);
    await reloaded;
    assert.equal(JSON.parse(fs.readFileSync(input)).components.find(n=>n.id==='api').label, 'API saved');
    assert.equal(await evaluate(`Boolean(document.querySelector('.architecture-edit-note'))`), false);
    assert.equal(await evaluate(`document.getElementById('btn-save-deliver').hidden`), true);
    assert.equal(await evaluate(`document.querySelector('.diagram-container [data-node-id="api"]').dataset.nodeLabel`), 'API saved');
  } finally {
    await browser.close();
    await new Promise(resolve => session.server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
