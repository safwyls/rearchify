import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createArchitectureScene } from '../renderers/architecture/architecture-scene.mjs';
import { moveNode } from '../../viewer/architecture-path-edit.mjs';
import { validateSchema } from '../renderers/shared/validator.mjs';
import { ChromeVisualBrowser, findChrome } from '../bin/visual-check.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const fixture = () => ({
  schema_version: 1, diagram_type: 'architecture',
  meta: { title: 'Editable architecture', quality_profile: 'showcase' },
  layout: { mode: 'grid', origin: [60, 80], cols: 3, gapX: 140 },
  components: [
    { id: 'client', type: 'frontend', label: 'Client', row: 0, col: 0 },
    { id: 'api', type: 'backend', label: 'API', row: 0, col: 1 },
    { id: 'db', type: 'database', label: 'Store', brand: 'postgresql', row: 0, col: 2 },
  ],
  boundaries: [{ kind: 'region', label: 'Services', wraps: ['api', 'db'] }],
  connections: [{ from: 'client', to: 'api', label: 'HTTPS' }, { from: 'api', to: 'db', label: 'SQL' }],
});

test('architecture scene reroutes, resizes boundaries, and rejects overlapping edits without retaining state', () => {
  const spec = fixture();
  const first = createArchitectureScene(spec);
  first.validate();
  const original = first.renderSvg();
  spec.components[2].pos = [660, 180];
  const moved = createArchitectureScene(spec);
  moved.validate();
  assert.notEqual(moved.renderSvg(), original);
  assert.ok(moved.report().boundaries[0].height > first.report().boundaries[0].height);
  assert.notDeepEqual(moved.report().connections, first.report().connections);
  spec.components[2].pos = [330, 80];
  assert.throws(() => createArchitectureScene(spec).validate(), /less than 8px apart/i);
  assert.equal(first.renderSvg(), original);
});

const chrome = findChrome();
test('fixed boundaries follow membership on node moves and reject stale saved membership through the CLI', () => {
  const spec = { schema_version: 1, diagram_type: 'architecture', meta: { title: 'Fixed scope', quality_profile: 'showcase' },
    components: [{ id: 'api', type: 'backend', label: 'API', pos: [100, 100] }], connections: [],
    boundaries: [{ kind: 'region', label: 'Production', wraps: ['api'], rect: [60, 60, 200, 140] }],
  };
  moveNode(spec, 'api', 100, 300, createArchitectureScene(spec).editGeometry());
  assert.deepEqual(spec.boundaries[0].wraps, []);
  createArchitectureScene(spec).validate();
  moveNode(spec, 'api', 100, 100, createArchitectureScene(spec).editGeometry());
  assert.deepEqual(spec.boundaries[0].wraps, ['api']);
  createArchitectureScene(spec).validate();
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'archify-fixed-boundary-'));
  try {
    const input = path.join(scratch, 'source.json');
    const output = path.join(scratch, 'source.html');
    for (const [position, wraps] of [[[100, 300], ['api']], [[100, 100], []]]) {
      spec.components[0].pos = position;
      spec.boundaries[0].wraps = wraps;
      fs.writeFileSync(input, JSON.stringify(spec));
      for (const command of ['validate', 'deliver']) {
        assert.throws(() => execFileSync(process.execPath, [path.join(root, 'bin/archify.mjs'), command, 'architecture', input,
          ...(command === 'deliver' ? [output] : []), '--json'], { encoding: 'utf8', stdio: 'pipe' }), error => {
          const receipt = JSON.parse(error.stdout);
          assert.equal(receipt.ok, false);
          const diagnostic = receipt.diagnostics.find(item => item.code === 'layout/boundary-membership');
          assert.equal(diagnostic.subject.index, 0);
          assert.ok(diagnostic.supportedFixes[0].startsWith('set /boundaries/0/wraps to '));
          return true;
        });
      }
    }
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
});

test('explicit boundary rectangles are preserved and unreadable or overlapping titles are rejected', () => {
  const spec = { schema_version: 1, diagram_type: 'architecture', meta: { title: 'Fixed frame', quality_profile: 'showcase' },
    components: [{ id: 'api', type: 'backend', label: 'API', pos: [100, 100] }], connections: [],
    boundaries: [{ kind: 'region', label: 'A long boundary label', wraps: [], rect: [250, 220, 40, 40] }],
  };
  const assertRect = scene => {
    const { x, y, width, height } = scene.report().boundaries[0];
    assert.deepEqual([x, y, width, height], spec.boundaries[0].rect);
  };
  let scene = createArchitectureScene(spec);
  assertRect(scene);
  assert.throws(() => scene.validate(), /shorten the boundary label or widen rect/);
  spec.boundaries[0].rect[2] = 180;
  scene = createArchitectureScene(spec);
  assertRect(scene);
  scene.validate();
  spec.boundaries[0] = { kind: 'region', label: 'Scope', wraps: ['api'], rect: [100, 100, 180, 100] };
  scene = createArchitectureScene(spec);
  assertRect(scene);
  assert.throws(() => scene.validate(), /overlaps component/);
});

test('architecture editor supports drag, history, labels, draft checks, downloads, and reopening offline', {
  skip: chrome ? false : 'Chrome/Chromium unavailable', timeout: 90000,
}, async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'archify-editor-'));
  const input = path.join(scratch, 'source.json');
  const output = path.join(scratch, 'source.html');
  fs.writeFileSync(input, JSON.stringify(fixture()));
  execFileSync(process.execPath, [path.join(root, 'renderers/architecture/render-architecture.mjs'), input, output]);
  const browser = new ChromeVisualBrowser(chrome);
  try {
    const session = await browser.sessionPromise;
    const send = (method, params = {}) => browser.cdp.send(method, params, session);
    const evaluate = async expression => {
      const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      assert.equal(result.exceptionDetails, undefined, result.exceptionDetails?.exception?.description);
      return result.result.value;
    };
    await send('Page.addScriptToEvaluateOnNewDocument', { source: `window.editorErrors = [];
      addEventListener('error', e => editorErrors.push(e.message));
      addEventListener('unhandledrejection', e => editorErrors.push(String(e.reason)));` });
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    async function load(file) {
      const loaded = browser.cdp.waitFor('Page.loadEventFired', session);
      await send('Page.navigate', { url: pathToFileURL(file).href });
      await loaded;
      await evaluate(`document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))`);
    }
    const click = async action => {
      const before = action === 'apply' ? await evaluate('performance.timeOrigin') : null;
      const loaded = action === 'apply' ? browser.cdp.waitFor('Page.loadEventFired', session) : null;
      await evaluate(`document.querySelector('#architecture-editor [data-action="${action}"]').click()`);
      if (loaded) {
        await loaded;
        assert.notEqual(await evaluate('performance.timeOrigin'), before, 'Apply must create a fresh document lifecycle');
      }
    };
    async function contextMenu(selector) {
      const rect = await evaluate(`(() => {const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'right', clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'right', clickCount: 1 });
      assert.equal(await evaluate(`document.getElementById('editor-context').hidden`), false);
    }
    async function beginRelabel(selector) { await contextMenu(selector); await click('relabel'); }
    const geometry = () => evaluate(`(() => {const svg=document.querySelector('.diagram-container > svg').cloneNode(true);svg.querySelectorAll('[data-legend-bridge-runtime], [data-relationship-hit-overlay]').forEach(el=>el.remove());return svg.innerHTML})()`);
    const open = () => evaluate(`document.getElementById('btn-edit-layout').click()`);
    const pos = () => evaluate(`(() => {const r = document.querySelector('#architecture-editor [data-node-id="db"] > rect');return [Number(r.getAttribute('x')),Number(r.getAttribute('y'))]})()`);
    async function captureDownloads() {
      await evaluate(`window.editorDownloads=[];window.originalCreateURL=URL.createObjectURL;URL.createObjectURL = blob => {editorDownloads.push(blob);return originalCreateURL(blob)};`);
    }
    await load(output);
    await open();
    assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('#architecture-editor .editor-controls [data-action]'), el=>el.dataset.action)`), ['undo','redo','fit','validate','json','html','apply','cancel']);
    assert.equal(await evaluate(`document.querySelector('.editor-status').dataset.valid`), 'true');
    assert.equal(await evaluate(`Boolean(document.querySelector('#architecture-editor [data-brand-mark="postgresql"]'))`), true);
    const original = await pos();
    const box = await evaluate(`(() => {const r = document.querySelector('#architecture-editor [data-node-id="db"] > rect').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x + 50, y: box.y + 60, button: 'left', buttons: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x + 50, y: box.y + 60, button: 'left', clickCount: 1 });
    const moved = await pos();
    assert.notDeepEqual(moved, original);
    assert.equal(moved[0] % 10, 0);
    await click('undo');
    assert.deepEqual(await pos(), original);
    await click('redo');
    assert.deepEqual(await pos(), moved);
    await evaluate(`document.querySelector('.editor-stage').focus()`);
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight' });
    assert.deepEqual(await pos(), [moved[0] + 1, moved[1]]);
    await click('undo');
    assert.deepEqual(await pos(), moved);
    await beginRelabel('#architecture-editor [data-node-id="db"] > rect');
    assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('#editor-context button:not([hidden])'), el=>el.dataset.action)`), ['relabel']);
    await evaluate(`document.getElementById('editor-label').value = 'Storage'`);
    await click('label');
    assert.equal(await evaluate(`document.querySelector('#architecture-editor [data-node-id="db"]').dataset.nodeLabel`), 'Storage');
    await captureDownloads();
    await click('json');
    const saved = JSON.parse(await evaluate('editorDownloads.at(-1).text()'));
    assert.deepEqual(saved.components[2].pos, moved);
    assert.equal(saved.components[2].row, undefined);
    assert.equal(saved.components[2].label, 'Storage');
    createArchitectureScene(saved).validate();
    await click('html');
    const html = await evaluate('editorDownloads.at(-1).text()');
    assert.equal(html.includes('id="architecture-editor"'), false);
    const reopened = path.join(scratch, 'edited.html');
    fs.writeFileSync(reopened, html);
    fs.writeFileSync(path.join(scratch, 'edited.json'), JSON.stringify(saved));
    const rerendered = path.join(scratch, 'rerendered.html');
    execFileSync(process.execPath, [path.join(root, 'renderers/architecture/render-architecture.mjs'), path.join(scratch, 'edited.json'), rerendered]);
    const svg = text => text.match(/<svg\b[\s\S]*?<\/svg>/)[0];
    // HTML serialization normalizes case/attributes; compare geometry in-browser.
    await load(reopened);
    const savedGeometry = await geometry();
    assert.equal(await evaluate(`document.querySelectorAll('#btn-edit-layout').length`), 1);
    assert.equal(await evaluate(`Boolean(document.querySelector('.architecture-edit-note'))`), true);
    await open();
    assert.deepEqual(await pos(), moved);
    const stageBounds = () => evaluate(`(() => {const r=document.querySelector('.editor-stage').getBoundingClientRect();return [r.x,r.y,r.width,r.height]})()`);
    const stableStage = await stageBounds();
    await beginRelabel('#architecture-editor [data-node-id="db"] > rect');
    await evaluate(`document.getElementById('editor-label').value='A label that is far too long to fit this node at the legible minimum';`);
    await click('label');
    assert.equal(await evaluate(`document.querySelector('.editor-status').dataset.valid`), 'false');
    assert.deepEqual(await stageBounds(), stableStage, 'validation errors must not resize or shift the canvas');
    await evaluate(`document.querySelector('.editor-status').textContent=Array(50).fill('Long layout diagnostic').join('\\n')`);
    assert.deepEqual(await stageBounds(), stableStage, 'overflowing diagnostics must stay within their reserved space');
    assert.equal(await evaluate(`(() => {const s=document.querySelector('.editor-status');return s.scrollHeight>s.clientHeight})()`), true);
    await click('undo');
    assert.equal(await evaluate(`document.querySelector('.editor-status').dataset.valid`), 'true');
    assert.deepEqual(await stageBounds(), stableStage, 'clearing validation errors must not shift the canvas');
    await beginRelabel('#architecture-editor [data-node-id="db"] > rect');
    await evaluate(`document.getElementById('editor-label').value='Database'`);
    await click('label');
    await click('apply');
    // Apply reloads and restores the draft before reader initialization.
    await evaluate(`new Promise(resolve => {let n=0;const id=setInterval(()=>{if(document.getElementById('btn-edit-layout') || ++n>100){clearInterval(id);resolve()}},20)})`);
    assert.equal(await evaluate(`document.querySelector('.diagram-container [data-node-id="db"]').dataset.nodeLabel`), 'Database');
    const appliedWidths = await evaluate(`new Promise(resolve => {const widths=[];function sample(){widths.push(document.querySelector('.diagram-container').getBoundingClientRect().width);if(widths.length<90)requestAnimationFrame(sample);else resolve(widths.slice(-30));}requestAnimationFrame(sample);})`);
    assert.ok(Math.max(...appliedWidths)-Math.min(...appliedWidths)<1, 'applied viewer must settle instead of oscillating between widths');
    await open();
    assert.equal(await evaluate(`document.querySelector('.editor-status').dataset.valid`), 'true');
    if (process.env.ARCHIFY_EDITOR_SCREENSHOT) {
      const shot = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(process.env.ARCHIFY_EDITOR_SCREENSHOT, Buffer.from(shot.data, 'base64'));
    }
    await click('cancel');
    assert.deepEqual(await evaluate('editorErrors'), []);
    for (const [width, height] of [[1440, 900], [1600, 1000], [1920, 1080]]) {
      await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
      await evaluate(`document.documentElement.setAttribute('data-theme', 'light')`);
      await open();
      assert.equal(await evaluate(`document.documentElement.scrollWidth <= innerWidth`), true);
      assert.equal(await evaluate(`(() => {const r=document.querySelector('.editor-stage').getBoundingClientRect();return r.width>0 && r.height>0 && r.bottom<innerHeight})()`), true);
      await click('cancel');
    }
    await load(rerendered);
    assert.equal(await geometry(), savedGeometry);
    assert.equal(svg(html).includes('Storage'), true);

    // Reproduce the user's JWT jog case in the actual shipped demo, including
    // pointer interaction, a second drag frame, history, and saved-file replay.
    const demoOutput = path.join(scratch, 'demo.html');
    execFileSync(process.execPath, [path.join(root, 'renderers/architecture/render-architecture.mjs'), path.join(root, 'examples/web-app.architecture.json'), demoOutput]);
    await load(demoOutput);
    await open();
    await evaluate(`document.querySelector('[data-control="snap"]').checked=false`);
    await click('cancel');
    async function checkHover() {
    const hoverTarget = await evaluate(`(() => {const r=document.querySelector('.diagram-container [data-node-id="api"] > rect').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    await send('Input.dispatchMouseEvent', {type:'mouseMoved', ...hoverTarget});
    const hoverFrames = await evaluate(`new Promise(resolve=>{const values=[];function sample(){const svg=document.querySelector('.diagram-container > svg');values.push({active:svg.getAttribute('data-intent-trace-active'),overlays:svg.querySelectorAll('[data-intent-trace-overlay]').length});if(values.length<90)requestAnimationFrame(sample);else resolve(values.slice(-30));}requestAnimationFrame(sample);})`);
    assert.ok(hoverFrames.every(frame=>frame.active==='api' && frame.overlays===1), JSON.stringify(hoverFrames));
    await send('Input.dispatchMouseEvent', {type:'mouseMoved', x:1,y:1});
    assert.equal(await evaluate(`document.querySelector('.diagram-container > svg').getAttribute('data-intent-trace-active')`), null, 'leaving a node restores the full diagram');
    assert.equal(await evaluate(`document.querySelectorAll('.diagram-container [data-intent-trace-overlay]').length`), 0);
    const edgeTarget = await evaluate(`(() => {const svg=document.querySelector('.diagram-container > svg'),path=svg.querySelector('path[data-edge-id="jwt-verification"]'),p=path.getAttribute('data-composition-points').split(';').map(s=>s.split(',').map(Number));const q=new DOMPoint((p[0][0]+p[1][0])/2,(p[0][1]+p[1][1])/2).matrixTransform(svg.getScreenCTM());return {x:q.x,y:q.y}})()`);
    await send('Input.dispatchMouseEvent', {type:'mouseMoved', ...edgeTarget});
    const edgeFrames = await evaluate(`new Promise(resolve=>{let n=0;const values=[];function sample(){values.push(document.querySelector('.diagram-container > svg').getAttribute('data-relationship-preview-active'));if(++n<45)requestAnimationFrame(sample);else resolve(values.slice(-15));}requestAnimationFrame(sample);})`);
    assert.ok(edgeFrames.every(key=>key==='1'), 'connection hover must remain stable: '+JSON.stringify(edgeFrames));
    await send('Input.dispatchMouseEvent', {type:'mouseMoved', x:1,y:1});
    assert.equal(await evaluate(`document.querySelector('.diagram-container > svg').getAttribute('data-relationship-preview-active')`), null, 'leaving a connection restores the full diagram after Apply');
    for (const [selector, attribute] of [['[data-guided-view-id]', 'data-chapter-preview'], ['[data-legend-kind][role="button"]', 'data-legend-preview-active']]) {
      const target = await evaluate(`(() => {const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
      await send('Input.dispatchMouseEvent', {type:'mouseMoved', ...target});
      await evaluate(`new Promise(resolve=>{let n=0;function step(){if(++n<15)requestAnimationFrame(step);else resolve();}requestAnimationFrame(step);})`);
      assert.ok(await evaluate(`document.querySelector('.diagram-container > svg').hasAttribute(${JSON.stringify(attribute)})`), selector+' hover starts');
      await send('Input.dispatchMouseEvent', {type:'mouseMoved',x:1,y:1});
      assert.equal(await evaluate(`document.querySelector('.diagram-container > svg').getAttribute(${JSON.stringify(attribute)})`), null, selector+' hover clears');
    }
    }
    await checkHover();
    for (let cycle = 0; cycle < 2; cycle++) {
      await evaluate(`document.querySelector('.diagram-container [data-node-id="api"]').dispatchEvent(new MouseEvent('click',{bubbles:true}))`);
      assert.equal(await evaluate(`document.querySelector('.diagram-container > svg').getAttribute('data-focus-active')`), 'api');
      await open(); await click('apply');
      await evaluate(`new Promise(resolve => {const id=setInterval(()=>{if(document.getElementById('btn-edit-layout')){clearInterval(id);resolve()}},20)})`);
      await evaluate(`document.getElementById('btn-focus-clear').click()`);
      // Clearing pinned focus deliberately returns keyboard focus to its node.
      // Move keyboard focus to the toolbar before testing mouse-only previews.
      await evaluate(`document.getElementById('btn-edit-layout').focus()`);
      assert.equal(await evaluate(`document.querySelectorAll('#overview-map-surface > svg').length`), 1, 'Apply must rebuild one fresh radar, not retain stale hit targets');
      const kinds = await evaluate(`[...document.querySelectorAll('.semantic-lens-kind')].map(n=>n.dataset.kind)`);
      assert.equal(kinds.length, new Set(kinds).size, 'Apply must not duplicate semantic highlight controls');
      await checkHover();
    }
    await open();
    await evaluate(`document.querySelector('[data-control="snap"]').checked=false`);
    async function dragElement(selector, dx, dy, modifiers = 0) {
      const center = await evaluate(`(() => {const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();const m=document.querySelector('.editor-stage > svg').getScreenCTM();return {x:r.x+r.width/2,y:r.y+r.height/2,dx:m.a*${dx}+m.c*${dy},dy:m.b*${dx}+m.d*${dy}}})()`);
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: center.x, y: center.y, button: 'left', clickCount: 1, modifiers });
      for (const amount of [.5, 1]) await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: center.x + center.dx * amount, y: center.y + center.dy * amount, button: 'left', buttons: 1, modifiers });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: center.x + center.dx, y: center.y + center.dy, button: 'left', clickCount: 1, modifiers });
    }
    const jwtPoints = () => evaluate(`document.querySelector('.editor-stage path[data-edge-id="jwt-verification"]').getAttribute('data-composition-points').split(';').map(p=>p.split(',').map(Number))`);
    const assertOrthogonal = points => points.slice(1).forEach((point, index) => assert.ok(point[0] === points[index][0] || point[1] === points[index][1], `unexpected diagonal ${points[index]} → ${point}`));
    const initialJwt = await jwtPoints();
    await dragElement('#architecture-editor [data-node-id="auth"] > rect', 0, 20);
    const nodeMovedJwt = await jwtPoints();
    assert.equal(nodeMovedJwt[1][1], initialJwt[1][1] + 20);
    assertOrthogonal(nodeMovedJwt);
    await click('apply');
    await evaluate(`new Promise(resolve => {let n=0;const id=setInterval(()=>{if(document.getElementById('btn-edit-layout') || ++n>100){clearInterval(id);resolve()}},20)})`);
    for (const [width,height] of [[1440,900],[1600,1000],[1920,1080]]) {
      await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
      const widths = await evaluate(`new Promise(resolve=>{const values=[];function sample(){values.push(document.querySelector('.diagram-container').getBoundingClientRect().width);if(values.length<90)requestAnimationFrame(sample);else resolve(values.slice(-30));}requestAnimationFrame(sample);})`);
      assert.ok(Math.max(...widths)-Math.min(...widths)<1, 'demo Apply must settle at '+width+'x'+height+': '+JSON.stringify([...new Set(widths)]));
    }
    await checkHover();
    await open();
    await evaluate(`document.querySelector('[data-control="snap"]').checked=false`);
    await contextMenu('[data-editor-kind="segment"][data-editor-edge="1"][data-editor-index="1"]');
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
    assert.equal(await evaluate(`document.getElementById('architecture-editor').open`), true);
    await dragElement('[data-editor-kind="endpoint"][data-editor-edge="1"][data-editor-index="0"]', 0, -12);
    const endpointMovedJwt = await jwtPoints();
    assert.equal(endpointMovedJwt[0][0], nodeMovedJwt[0][0]);
    assert.ok(Math.abs(endpointMovedJwt[0][1] - (nodeMovedJwt[0][1] - 12)) < .001);
    assert.deepEqual(endpointMovedJwt.at(-1), nodeMovedJwt.at(-1));
    assertOrthogonal(endpointMovedJwt);
    await click('undo');
    assert.deepEqual(await jwtPoints(), nodeMovedJwt);
    await click('redo');
    assert.deepEqual(await jwtPoints(), endpointMovedJwt);
    await click('undo');
    await dragElement('[data-editor-kind="segment"][data-editor-edge="1"][data-editor-index="1"]', 20, 0);
    const segmentMovedJwt = await jwtPoints();
    assert.equal(segmentMovedJwt[1][0], nodeMovedJwt[1][0] + 20);
    assert.equal(segmentMovedJwt[2][0], nodeMovedJwt[2][0] + 20);
    assertOrthogonal(segmentMovedJwt);
    await click('undo');
    assert.deepEqual(await jwtPoints(), nodeMovedJwt);
    await click('redo');
    assert.deepEqual(await jwtPoints(), segmentMovedJwt);
    const labelPosition = () => evaluate(`(() => {const text=document.querySelector('.editor-stage g[data-edge-key="1"] text');return [Number(text.getAttribute('x')),Number(text.getAttribute('y'))]})()`);
    const labelBefore = await labelPosition();
    // This assertion covers free placement; snapping has separate coverage.
    await dragElement('.editor-stage g[data-edge-key="1"]', -90, 0, 1);
    assert.deepEqual(await labelPosition(), [labelBefore[0] - 90, labelBefore[1]]);
    assert.deepEqual(await jwtPoints(), segmentMovedJwt, 'label dragging must not alter route geometry');
    await dragElement('[data-editor-kind="bend"][data-editor-edge="1"][data-editor-index="2"]', -10, -10);
    const bendMovedJwt = await jwtPoints();
    assertOrthogonal(bendMovedJwt);
    assert.notDeepEqual(bendMovedJwt, segmentMovedJwt);
    await contextMenu('[data-editor-kind="segment"][data-editor-edge="1"][data-editor-index="0"]');
    await click('jog');
    assert.ok((await jwtPoints()).length > bendMovedJwt.length);
    assertOrthogonal(await jwtPoints());
    await click('undo');
    assert.deepEqual(await jwtPoints(), bendMovedJwt);
    await contextMenu('[data-editor-kind="segment"][data-editor-edge="1"][data-editor-index="1"]');
    await click('auto-route');
    assert.notDeepEqual(await jwtPoints(), bendMovedJwt);
    await click('undo');
    assert.deepEqual(await jwtPoints(), bendMovedJwt);
    await contextMenu('.editor-stage g[data-edge-key="1"]');
    await click('auto-label');
    assert.notDeepEqual(await labelPosition(), [labelBefore[0] - 90, labelBefore[1]]);
    await click('undo');
    // Snap onto the vertical JWT segment, keep the label attached when that
    // segment moves, and retain a deliberate Alt-drag escape hatch.
    const freeLabel = await labelPosition();
    const channelX = bendMovedJwt[1][0];
    await dragElement('.editor-stage g[data-edge-key="1"]', channelX - freeLabel[0] - 2, 0);
    assert.deepEqual(await labelPosition(), [channelX, freeLabel[1]]);
    await dragElement('[data-editor-kind="segment"][data-editor-edge="1"][data-editor-index="1"]', 20, 0);
    assert.deepEqual(await labelPosition(), [channelX + 20, freeLabel[1]]);
    await click('undo'); await click('undo');
    await dragElement('.editor-stage g[data-edge-key="1"]', channelX - freeLabel[0] - 2, 0, 1);
    assert.deepEqual(await labelPosition(), [channelX - 2, freeLabel[1]]);
    await click('undo');
    await contextMenu('.editor-stage g[data-edge-key="1"]');
    assert.equal(await evaluate(`document.querySelector('[data-action="snap-label"]').getAttribute('aria-checked')`), 'true');
    await click('snap-label');
    await dragElement('.editor-stage g[data-edge-key="1"]', channelX - freeLabel[0] - 2, 0);
    assert.deepEqual(await labelPosition(), [channelX - 2, freeLabel[1]]);
    await click('undo');
    await contextMenu('.editor-stage g[data-edge-key="1"]'); await click('snap-label');
    // Merge the adjacent vertical corners by bringing the lower one within
    // a few screen pixels of the upper one, then verify it is one undo step.
    await dragElement('[data-editor-kind="bend"][data-editor-edge="1"][data-editor-index="2"]', 0, bendMovedJwt[1][1] - bendMovedJwt[2][1] + 2);
    assert.ok((await jwtPoints()).length < bendMovedJwt.length);
    assertOrthogonal(await jwtPoints());
    await click('undo');
    assert.deepEqual(await jwtPoints(), bendMovedJwt);
    // Removing a selected interior jog also simplifies rather than detaching
    // the path, and keyboard users can open and dismiss the same menu.
    await contextMenu('[data-editor-kind="segment"][data-editor-edge="1"][data-editor-index="1"]');
    assert.equal(await evaluate(`document.querySelector('[data-action="remove-jog"]').disabled`), false);
    await click('remove-jog');
    assert.ok((await jwtPoints()).length < bendMovedJwt.length);
    assertOrthogonal(await jwtPoints());
    await click('undo');
    await evaluate(`document.querySelector('.editor-stage path[data-edge-key="1"]').focus()`);
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'F10', code: 'F10', modifiers: 8 });
    assert.equal(await evaluate(`document.getElementById('editor-context').hidden`), false);
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowDown', code: 'ArrowDown' });
    assert.equal(await evaluate(`document.activeElement.dataset.action`), 'jog');
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
    assert.equal(await evaluate(`document.getElementById('architecture-editor').open`), true);
    await captureDownloads();
    await click('json');
    const editedDemo = JSON.parse(await evaluate('editorDownloads.at(-1).text()'));
    assert.deepEqual(editedDemo.connections[1].labelAt, [labelBefore[0] - 90, labelBefore[1]]);
    createArchitectureScene(editedDemo).validate();
    const editedDemoJson = path.join(scratch, 'edited-demo.json');
    fs.writeFileSync(editedDemoJson, JSON.stringify(editedDemo));
    execFileSync(process.execPath, [path.join(root, 'renderers/architecture/render-architecture.mjs'), editedDemoJson, path.join(scratch, 'edited-demo-cli.html')]);
    await click('html');
    const editedDemoHtml = await evaluate('editorDownloads.at(-1).text()');
    assert.equal(svg(editedDemoHtml).includes('data-editor-overlay'), false);
    fs.writeFileSync(path.join(scratch, 'edited-demo.html'), editedDemoHtml);
    if (process.env.ARCHIFY_EDITOR_SCREENSHOT) {
      const shot = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(process.env.ARCHIFY_EDITOR_SCREENSHOT.replace(/\.png$/, '-paths.png'), Buffer.from(shot.data, 'base64'));
      await contextMenu('[data-editor-kind="segment"][data-editor-edge="1"][data-editor-index="1"]');
      const menuShot = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(process.env.ARCHIFY_EDITOR_SCREENSHOT.replace(/\.png$/, '-context.png'), Buffer.from(menuShot.data, 'base64'));
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
    }
    assert.deepEqual(await evaluate('editorErrors'), []);
    await load(path.join(scratch, 'edited-demo.html'));
    await open();
    assert.deepEqual(await jwtPoints(), bendMovedJwt);
    assert.deepEqual(await labelPosition(), editedDemo.connections[1].labelAt);
    await evaluate(`document.querySelector('[data-control="snap"]').checked=false`);
    await dragElement('.editor-stage g[data-edge-key="1"]', channelX - freeLabel[0] - 2, 0);
    await captureDownloads();
    await click('json');
    const snappedJson = JSON.parse(await evaluate('editorDownloads.at(-1).text()'));
    assert.equal(snappedJson.connections[1].labelAt, undefined);
    assert.equal(snappedJson.connections[1].labelSegment, 1);
    createArchitectureScene(snappedJson).validate();
    await contextMenu('.editor-stage g[data-edge-key="1"]');
    await click('snap-label');
    await click('html');
    fs.writeFileSync(path.join(scratch, 'snapped.html'), await evaluate('editorDownloads.at(-1).text()'));
    await load(path.join(scratch, 'snapped.html')); await open();
    assert.deepEqual(await labelPosition(), [channelX, freeLabel[1]]);
    await contextMenu('.editor-stage g[data-edge-key="1"]');
    assert.equal(await evaluate(`document.querySelector('[data-action="snap-label"]').getAttribute('aria-checked')`), 'false');
    assert.equal(await evaluate(`(() => {const a=document.querySelector('#editor-context').getBoundingClientRect(),b=document.querySelector('#architecture-editor').getBoundingClientRect();return a.left>=b.left && a.top>=b.top && a.right<=b.right && a.bottom<=b.bottom})()`), true);
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
    // Existing boundaries are editable, and drawing creates a persisted frame.
    await contextMenu('.editor-stage g[data-graph-role="structural-frame-label"][data-composition-frame-id="0"]');
    await click('relabel');
    await evaluate(`document.getElementById('editor-label').value='Edited scope'`);
    await click('label');
    assert.equal(await evaluate(`document.querySelector('.editor-stage rect[data-graph-role="structural-frame"]').dataset.compositionFrameLabel`), 'Edited scope');
    await dragElement('[data-editor-boundary="0"][data-editor-corner="3"]', 20, 30);
    await captureDownloads(); await click('json');
    const resizedBoundary = JSON.parse(await evaluate('editorDownloads.at(-1).text()')).boundaries[0];
    assert.equal(resizedBoundary.rect.length, 4);
    await dragElement('.editor-stage g[data-graph-role="structural-frame-label"][data-composition-frame-id="0"]', 20, 10);
    await click('json');
    const movedBoundary = JSON.parse(await evaluate('editorDownloads.at(-1).text()')).boundaries[0];
    assert.deepEqual(movedBoundary.rect, [resizedBoundary.rect[0]+20, resizedBoundary.rect[1]+10, ...resizedBoundary.rect.slice(2)]);
    await click('undo');
    await contextMenu('.editor-stage g[data-graph-role="structural-frame-label"][data-composition-frame-id="0"]');
    await click('boundary-kind');
    await click('json');
    assert.notEqual(JSON.parse(await evaluate('editorDownloads.at(-1).text()')).boundaries[0].kind, resizedBoundary.kind);
    await click('undo');
    await evaluate(`document.querySelector('.editor-stage > svg').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:100,clientY:100}))`);
    assert.equal(await evaluate(`document.querySelector('[data-action="draw-boundary"]').hidden`), false);
    await click('draw-boundary');
    const drawPoints = await evaluate(`(() => {const svg=document.querySelector('.editor-stage > svg'),m=svg.getScreenCTM(),v=svg.viewBox.baseVal;return [[v.x+30,v.y+30],[v.x+180,v.y+140]].map(p=>{const q=new DOMPoint(...p).matrixTransform(m);return {x:q.x,y:q.y}})})()`);
    await send('Input.dispatchMouseEvent', { type:'mousePressed', ...drawPoints[0], button:'left', clickCount:1 });
    await send('Input.dispatchMouseEvent', { type:'mouseMoved', ...drawPoints[1], button:'left', buttons:1 });
    await send('Input.dispatchMouseEvent', { type:'mouseReleased', ...drawPoints[1], button:'left', clickCount:1 });
    await click('json');
    const drawnSpec = JSON.parse(await evaluate('editorDownloads.at(-1).text()'));
    validateSchema('architecture', drawnSpec);
    const newIndex = drawnSpec.boundaries.length - 1;
    assert.equal(drawnSpec.boundaries[newIndex].label, 'New boundary');
    assert.ok(drawnSpec.boundaries[newIndex].rect[2] >= 140);
    await click('undo'); await click('json');
    assert.equal(JSON.parse(await evaluate('editorDownloads.at(-1).text()')).boundaries.length, newIndex);
    await click('redo');
    await click('html');
    fs.writeFileSync(path.join(scratch,'boundaries.html'), await evaluate('editorDownloads.at(-1).text()'));
    await load(path.join(scratch,'boundaries.html')); await open();
    assert.equal(await evaluate(`document.getElementById('btn-save-deliver').hidden`), true, 'Standalone edited drafts never offer service-backed saving');
    await captureDownloads(); await click('json');
    assert.deepEqual(JSON.parse(await evaluate('editorDownloads.at(-1).text()')).boundaries, drawnSpec.boundaries);
    await contextMenu(`.editor-stage g[data-graph-role="structural-frame-label"][data-composition-frame-id="${newIndex}"]`);
    await click('delete-boundary'); await click('json');
    assert.equal(JSON.parse(await evaluate('editorDownloads.at(-1).text()')).boundaries.length, newIndex);
    await click('cancel');
    // Other diagram types never receive the architecture editor.
    execFileSync(process.execPath, [path.join(root, 'renderers/workflow/render-workflow.mjs'), path.join(root, 'examples/agent-tool-call.workflow.json'), path.join(scratch, 'workflow.html')]);
    assert.equal(fs.readFileSync(path.join(scratch, 'workflow.html'), 'utf8').includes('id="archify-editor-data"'), false);
  } finally {
    await browser.close();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
