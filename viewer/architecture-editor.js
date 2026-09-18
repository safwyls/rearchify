import { createArchitectureScene } from '../archify/renderers/architecture/architecture-scene.mjs';
import { fixedBoundaryMembers } from '../archify/renderers/architecture/boundary-membership.mjs';
import { RESOLVED_MARK } from '../archify/renderers/shared/brand-rendering.mjs';
import { routePorts, pinRoute, moveSegment, moveBend, addJog, moveNode, moveEndpoint, removeJog, mergeNearbyBends, nearestSegment, snapLabel } from './architecture-path-edit.mjs';

const draftKey = 'archify-apply:' + location.href.split('#')[0];

// This bundle runs before viewer initialization. Apply navigates normally, then
// restores the draft SVG before any reader caches geometry or installs handlers.
// document.open/write inside a pointer event can corrupt subsequent exit events
// for every component, even if each component's listeners are reinstalled.
function restoreAppliedDraft() {
  try {
    const stored = sessionStorage.getItem(draftKey);
    if (!stored) return;
    const { data, saveSession } = JSON.parse(stored);
    const rendered = JSON.parse(JSON.stringify(data.spec));
    rendered.components.forEach(node => {
      if (data.brands?.[node.id]) node[RESOLVED_MARK] = data.brands[node.id];
    });
    const svg = createArchitectureScene(rendered).renderSvg();
    document.querySelector('.diagram-container > svg').outerHTML = svg;
    document.getElementById('archify-editor-data').textContent = JSON.stringify(data)
      .replaceAll('<', '\\u003c').replaceAll('>', '\\u003e').replaceAll('&', '\\u0026');
    window.__archifyRestoredSaveSession = saveSession;
    sessionStorage.removeItem(draftKey);
  } catch (error) {
    window.__archifyDraftRestoreError = error.message;
  }
}
restoreAppliedDraft();

// The editor owns a separate canvas; Apply starts a fresh document lifecycle.
function initializeEditor() {
  const dataElement = document.getElementById('archify-editor-data');
  if (!dataElement) return;
  const data = JSON.parse(dataElement.textContent);
  const saveSession = document.getElementById('archify-save-session');
  const localSave = window.__archifyRestoredSaveSession || (saveSession ? JSON.parse(saveSession.textContent) : null);
  const shell = new DOMParser().parseFromString(window.__archifyEditorShell || '<!DOCTYPE html>\n' + document.documentElement.outerHTML, 'text/html');
  if (window.__archifyEditorShell) {
    // These scripts arrive after the reader's early snapshot was captured.
    for (const element of [dataElement, document.getElementById('archify-editor-runtime'), saveSession]) {
      if (element && !shell.getElementById(element.id)) shell.body.append(shell.importNode(element, true));
    }
  }
  const pristine = '<!DOCTYPE html>\n' + shell.documentElement.outerHTML;
  const copy = value => JSON.parse(JSON.stringify(value));
  let spec = copy(data.spec);
  let undo = data.undo || [];
  let redo = data.redo || [];
  let selected = null;
  let selectedEdge = null;
  let selectedPart = null;
  let selectedBoundary = null;
  let drawingBoundary = false;
  let currentScene = null;
  let viewport = null;
  let drag = null;
  let renderError = null;
  let dirty = Boolean(data.edited);
  let snapLabels = data.preferences?.snapLabels !== false;
  let snapPreview = null;
  const zh = spec.meta.locale === 'zh-CN';
  const t = (en, cn) => zh ? cn : en;
  const style = document.createElement('style');
  style.textContent = `
    #architecture-editor { position:fixed; inset:16px; width:calc(100% - 32px); height:calc(100% - 32px); max-width:none; max-height:none; box-sizing:border-box; margin:auto; padding:16px; border:1px solid #718096; border-radius:12px; color:#e5e7eb; background:#141b29; z-index:10000; }
    #architecture-editor::backdrop { background:#000b; }
    #architecture-editor[open] { display:flex; flex-direction:column; gap:12px; }
    #architecture-editor .editor-controls { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
    #architecture-editor button, #architecture-editor input, #architecture-editor select { font:inherit; color:inherit; background:#263246; border:1px solid #8290a8; border-radius:5px; padding:6px 10px; }
    #architecture-editor button:disabled { opacity:.4; }
    #architecture-editor .editor-controls button:not(:disabled):active, #architecture-editor .editor-controls button.editor-clicked { background:#42618a; border-color:#93c5fd; box-shadow:inset 0 2px 4px #0005; transform:translateY(1px); }
    #btn-save-deliver[hidden] { display:none !important; }
    #btn-save-deliver { background:#b91c1c; border-color:#f87171; color:#fff; }
    #btn-save-deliver:hover:not(:disabled) { background:#991b1b; border-color:#fca5a5; }
    #btn-save-deliver:active:not(:disabled) { background:#7f1d1d; transform:translateY(1px); }
    #architecture-editor input[type=checkbox] { accent-color:#60a5fa; }
    #architecture-editor input[type=text] { flex:1; min-width:120px; }
    #architecture-editor .editor-stage { flex:1; min-height:160px; overflow:hidden; background:var(--bg,#101827); border:1px solid #536177; border-radius:6px; touch-action:none; }
    #architecture-editor .editor-stage>svg { width:100%; height:100%; display:block; }
    #architecture-editor [data-node-id] { cursor:grab; }
    #architecture-editor [data-editor-kind="label"], #architecture-editor [data-editor-kind="bend"] { cursor:move; }
    #architecture-editor path[data-editor-edge-selected] { stroke:#60a5fa; }
    #architecture-editor .editor-bend { fill:var(--bg); stroke:#60a5fa; stroke-width:2; vector-effect:non-scaling-stroke; }
    #architecture-editor .editor-segment { stroke:transparent; stroke-width:14; pointer-events:stroke; vector-effect:non-scaling-stroke; }
    #architecture-editor [data-editor-kind="label"] rect { pointer-events:all; }
    #architecture-editor [data-editor-selected] > rect { stroke:#60a5fa; stroke-width:2.5; }
    #architecture-editor [data-animate] { animation:none !important; opacity:1 !important; }
    #architecture-editor .editor-status { flex:0 0 120px; height:120px; min-height:0; box-sizing:border-box; white-space:pre-line; overflow:auto; font-size:13px; margin:0; }
    #architecture-editor .editor-help { margin:0; font-size:13px; }
    #architecture-editor :focus-visible { outline:2px solid #60a5fa; outline-offset:2px; }
    #architecture-editor .editor-popover { position:fixed; z-index:1; padding:6px; border:1px solid #8290a8; border-radius:8px; background:#182336; box-shadow:0 12px 32px #0006; max-width:calc(100vw - 48px); }
    #architecture-editor [hidden] { display:none !important; }
    #architecture-editor [role=menu] { min-width:210px; }
    #architecture-editor [role=menu] button { display:block; width:100%; text-align:left; border:0; background:transparent; }
    #architecture-editor [role=menu] button:hover:not(:disabled) { background:#30415b; }
    #architecture-editor [role=menu] button[aria-checked=true]::before { content:'✓ '; }
    #architecture-editor .editor-relabel { width:330px; }
    #architecture-editor .editor-relabel input { display:block; width:100%; box-sizing:border-box; margin:8px 0; }
    #architecture-editor .editor-snap-guide { stroke:#22d3ee; stroke-width:3; stroke-dasharray:4 3; pointer-events:none; vector-effect:non-scaling-stroke; }
    .architecture-edit-note { font-size:12px; text-align:center; padding:4px; }
    @media print { #architecture-editor, #btn-edit-layout, .architecture-edit-note { display:none !important; } }
  `;
  document.head.append(style);
  const trigger = document.createElement('button');
  trigger.id = 'btn-edit-layout';
  trigger.type = 'button';
  trigger.textContent = t('Edit layout', '编辑布局');
  document.querySelector('.toolbar').append(trigger);
  const saveButton = document.createElement('button');
  saveButton.id = 'btn-save-deliver';
  saveButton.type = 'button';
  saveButton.textContent = t('Save & deliver', '保存并交付');
  saveButton.hidden = true;
  let serviceAlive = false;
  let saving = false;
  let heartbeatTimer;
  let heartbeatController;
  function updateSaveButton() {
    const hidden = !data.edited || !serviceAlive;
    const changed = saveButton.hidden !== hidden;
    saveButton.hidden = hidden;
    saveButton.disabled = saving || !serviceAlive;
    if (changed) window.dispatchEvent(new Event('resize'));
  }
  async function heartbeat() {
    clearTimeout(heartbeatTimer);
    if (!localSave?.heartbeatUrl || heartbeatController) return;
    const controller = new AbortController();
    heartbeatController = controller;
    const timeout = setTimeout(() => controller.abort(), 2000);
    try {
      const response = await fetch(localSave.heartbeatUrl, { headers: { 'X-Archify-Token': localSave.token }, cache: 'no-store', signal: controller.signal });
      serviceAlive = response.ok && (await response.json()).ok === true;
    } catch { serviceAlive = false; }
    finally {
      clearTimeout(timeout);
      heartbeatController = null;
      updateSaveButton();
      heartbeatTimer = setTimeout(heartbeat, 5000);
    }
  }
  window.addEventListener('offline', () => { serviceAlive = false; updateSaveButton(); });
  window.addEventListener('online', heartbeat);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) heartbeat(); });
  window.addEventListener('pagehide', () => { clearTimeout(heartbeatTimer); heartbeatController?.abort(); });
  heartbeat();
  saveButton.title = localSave ? t(`Overwrite ${localSave.input} and ${localSave.output} after full delivery checks pass.`, `完整交付检查通过后覆盖 ${localSave.input} 和 ${localSave.output}。`) : t('Open with: archify edit architecture <input.json> <output.html> to enable saving to disk.', '使用 archify edit architecture <input.json> <output.html> 打开，以启用磁盘保存。');
  document.querySelector('.toolbar').append(saveButton);
  saveButton.addEventListener('click', async () => {
    if (!localSave || !data.edited || !serviceAlive || saving) return;
    let note = document.querySelector('.architecture-edit-note');
    if (!note) { note = document.createElement('p'); note.className = 'architecture-edit-note'; document.querySelector('.diagram-container').before(note); }
    note.setAttribute('role', 'status');
    const message = value => { note.textContent = value; window.Archify?.readerLayout?.schedule?.(); window.dispatchEvent(new Event('resize')); };
    saving = true; updateSaveButton(); trigger.disabled = true;
    message(t('Running full delivery checks. Files will update only after checks pass…', '正在运行完整交付检查。检查通过后才会更新文件…'));
    try {
      const response = await fetch(localSave.saveUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Archify-Token': localSave.token }, body: JSON.stringify({ revision: localSave.revision, spec: data.spec }) });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || 'Delivery failed.');
      // Navigate to the newly delivered artifact. It embeds the committed JSON
      // and receives a fresh session revision from the local service.
      window.location.reload();
    } catch (error) {
      message(t('Save failed: ', '保存失败：') + error.message + t(' Your edits remain in this page; you can download a copy.', '您的编辑仍保留在此页面，可下载副本。'));
      saving = false; updateSaveButton(); trigger.disabled = false;
      heartbeat();
    }
  });
  if (dirty) {
    const note = document.createElement('p');
    note.className = 'architecture-edit-note';
    note.textContent = t('Edited diagram · Full delivery checks have not been run. This notice is about validation, not save status.', '已编辑图表 · 尚未运行完整交付检查。此提示表示验证状态，而非保存状态。');
    document.querySelector('.diagram-container').before(note);
  }
  const dialog = document.createElement('dialog');
  dialog.id = 'architecture-editor';
  dialog.setAttribute('aria-label', t('Edit architecture layout', '编辑架构布局'));
  // Only fixed UI strings enter innerHTML. Authored text uses textContent/value.
  dialog.innerHTML = `
    <div class="editor-controls">
      <strong>${t('Edit layout', '编辑布局')}</strong>
      <button type="button" data-action="undo">${t('Undo', '撤销')}</button>
      <button type="button" data-action="redo">${t('Redo', '重做')}</button>
      <label><input type="checkbox" data-control="snap" checked> ${t('Snap to 10px grid', '吸附到 10px 网格')}</label>
      <button type="button" data-action="fit">${t('Fit', '适应画布')}</button>
      <button type="button" data-action="validate">${t('Check layout', '检查布局')}</button>
      <button type="button" data-action="json" title="${t('Download the edited source for regeneration and delivery checks.', '下载编辑后的源文件，用于重新生成和交付检查。')}">${t('Save JSON', '保存 JSON')}</button>
      <button type="button" data-action="html" title="${t('Save a standalone editable copy that retains your changes when reopened.', '保存独立可编辑副本，重新打开时保留更改。')}">${t('Download HTML', '下载 HTML')}</button>
      <button type="button" data-action="apply" title="${t('Update this page only. Download HTML or Save JSON to keep changes beyond this session.', '仅更新当前页面。请下载 HTML 或保存 JSON 以持久保留更改。')}">${t('Apply & close', '应用并关闭')}</button>
      <button type="button" data-action="cancel">${t('Cancel', '取消')}</button>
    </div>
    <p class="editor-help">${t('Right-click empty canvas to draw a boundary, or an object for actions (Shift+F10). Drag labels near a segment to snap; hold Alt for free placement. Nearby corners merge. Drag background to pan; scroll to zoom. Ctrl/Cmd+Z: undo.', '右键单击节点或连线打开操作（键盘：Shift+F10）。标签靠近线段时吸附，按住 Alt 自由移动。相邻转角靠近时合并。拖动画布平移，滚轮缩放。Ctrl/Cmd+Z：撤销。')}</p>
    <div class="editor-stage" tabindex="0" aria-label="${t('Layout canvas', '布局画布')}"></div>
    <p class="editor-status" role="status" aria-live="polite"></p>
    <div class="editor-popover" id="editor-context" role="menu" aria-label="${t('Edit actions', '编辑操作')}" hidden>
      <button type="button" role="menuitem" data-action="draw-boundary">${t('Draw boundary', '绘制边界')}</button>
      <button type="button" role="menuitem" data-action="boundary-kind">${t('Change boundary type', '切换边界类型')}</button>
      <button type="button" role="menuitem" data-action="delete-boundary">${t('Delete boundary', '删除边界')}</button>
      <button type="button" role="menuitem" data-action="relabel">${t('Relabel', '修改标签')}</button>
      <button type="button" role="menuitem" data-action="jog">${t('Add jog', '添加折弯')}</button>
      <button type="button" role="menuitem" data-action="remove-jog">${t('Remove jog segment', '移除折弯线段')}</button>
      <button type="button" role="menuitem" data-action="auto-route">${t('Auto route', '自动布线')}</button>
      <button type="button" role="menuitem" data-action="auto-label">${t('Auto label', '自动标签位置')}</button>
      <button type="button" role="menuitemcheckbox" data-action="snap-label" aria-checked="true">${t('Snap labels to path', '标签吸附到连线')}</button>
    </div>
    <div class="editor-popover editor-relabel" role="dialog" aria-labelledby="editor-label-title" hidden>
      <label id="editor-label-title" for="editor-label">${t('Relabel', '修改标签')}</label><input id="editor-label" type="text" disabled>
      <button type="button" data-action="label" disabled>${t('Update label', '更新标签')}</button>
      <button type="button" data-action="dismiss">${t('Cancel', '取消')}</button>
    </div>
  `;
  document.body.append(dialog);
  const stage = dialog.querySelector('.editor-stage');
  const status = dialog.querySelector('.editor-status');
  const input = dialog.querySelector('#editor-label');
  const menu = dialog.querySelector('#editor-context');
  const relabelPanel = dialog.querySelector('.editor-relabel');
  let menuPosition = [0, 0];
  const button = action => dialog.querySelector(`[data-action="${action}"]`);
  function attachBrands(value) {
    value.components.forEach(node => {
      if (data.brands?.[node.id]) node[RESOLVED_MARK] = data.brands[node.id];
    });
    return value;
  }
  function sceneFor(value) { return createArchitectureScene(attachBrands(copy(value))); }
  function select(id) {
    selected = id;
    const item = selectedBoundary !== null ? spec.boundaries?.[selectedBoundary] : selectedEdge === null ? spec.components.find(n => n.id === id) : spec.connections[selectedEdge];
    input.disabled = !item;
    button('label').disabled = !item;
    input.value = item?.label || '';
    button('jog').disabled = selectedEdge === null;
    button('auto-route').disabled = selectedEdge === null;
    button('auto-label').disabled = selectedEdge === null || !item?.label;
    stage.querySelectorAll('[data-node-id]').forEach(element => {
      element.toggleAttribute('data-editor-selected', element.dataset.nodeId === id);
    });
  }
  function selectPath(index, part = null) {
    selectedEdge = index;
    selectedPart = part;
    select(null);
    decoratePaths();
  }
  function decoratePaths() {
    const svg = stage.firstElementChild;
    if (!svg || !currentScene) return;
    svg.querySelectorAll('[data-editor-overlay]').forEach(element => element.remove());
    const geometry = currentScene.editGeometry();
    const element = (tag, attributes) => {
      const result = document.createElementNS('http://www.w3.org/2000/svg', tag);
      Object.entries(attributes).forEach(([key, value]) => result.setAttribute(key, value));
      return result;
    };
    const hits = element('g', { 'data-editor-overlay': '', 'aria-hidden': 'true' });
    geometry.connections.forEach((connection, edge) => {
      connection.points.slice(0, -1).forEach((point, index) => {
        const end = connection.points[index + 1];
        if (point[0] === end[0] && point[1] === end[1]) return;
        hits.append(element('line', { x1: point[0], y1: point[1], x2: end[0], y2: end[1],
          class: 'editor-segment', 'data-editor-edge': edge, 'data-editor-kind': 'segment', 'data-editor-index': index,
          style: `cursor:${point[1] === end[1] ? 'ns-resize' : 'ew-resize'}` }));
      });
    });
    // Wide segment hit targets must stay behind labels, otherwise dragging a
    // label that lies on its route moves the connector instead.
    svg.insertBefore(hits, svg.querySelector('g[data-edge-key], [data-node-id]'));
    svg.querySelectorAll('rect[data-graph-role="structural-frame"]').forEach(frame => {
      const index = Number(frame.dataset.compositionFrameId);
      const attributes = { x: frame.getAttribute('x'), y: frame.getAttribute('y'), width: frame.getAttribute('width'), height: frame.getAttribute('height'), fill: 'none', stroke: index === selectedBoundary ? '#60a5fa' : 'transparent', 'stroke-width': 10, 'vector-effect': 'non-scaling-stroke', 'pointer-events': 'stroke', 'data-editor-boundary': index, style: 'cursor:move', tabindex: 0, 'aria-label': spec.boundaries[index].label };
      const overlay = element('g', { 'data-editor-overlay': '' });
      attributes.stroke = 'transparent';
      overlay.append(element('rect', attributes));
      if (index === selectedBoundary) {
        overlay.append(element('rect', { ...attributes, stroke: '#60a5fa', 'stroke-width': 2, 'pointer-events': 'none', tabindex: -1 }));
        const scale = Math.hypot(svg.getScreenCTM().a, svg.getScreenCTM().b) || 1;
        for (const corner of [0, 1, 2, 3]) {
          const x = Number(attributes.x) + (corner % 2 ? Number(attributes.width) : 0);
          const y = Number(attributes.y) + (corner > 1 ? Number(attributes.height) : 0);
          overlay.append(element('rect', { x: x - 5 / scale, y: y - 5 / scale, width: 10 / scale, height: 10 / scale, fill: '#60a5fa', 'data-editor-boundary': index, 'data-editor-corner': corner, style: `cursor:${corner === 0 || corner === 3 ? 'nwse' : 'nesw'}-resize` }));
        }
      }
      svg.append(overlay);
    });
    svg.querySelectorAll('g[data-graph-role="structural-frame-label"]').forEach(label => { label.dataset.editorBoundary = label.dataset.compositionFrameId; });
    svg.querySelectorAll('path[data-edge-key]').forEach(path => {
      path.toggleAttribute('data-editor-edge-selected', Number(path.dataset.edgeKey) === selectedEdge);
      path.dataset.editorEdge = path.dataset.edgeKey;
      path.dataset.editorKind = 'path';
      path.setAttribute('tabindex', '0');
      path.setAttribute('role', 'button');
      path.setAttribute('aria-label', `${path.dataset.edgeLabel || t('Path', '连线')}: ${path.dataset.edgeFrom} → ${path.dataset.edgeTo}`);
    });
    svg.querySelectorAll('g[data-edge-key]').forEach(label => {
      label.dataset.editorEdge = label.dataset.edgeKey;
      label.dataset.editorKind = 'label';
      label.setAttribute('tabindex', '0');
      label.setAttribute('role', 'button');
      label.setAttribute('aria-label', label.dataset.edgeLabel || t('Path label', '连线标签'));
    });
    if (selectedEdge !== null) {
      const handles = element('g', { 'data-editor-overlay': '', 'aria-hidden': 'true' });
      const points = geometry.connections[selectedEdge].points;
      const scale = Math.hypot(svg.getScreenCTM().a, svg.getScreenCTM().b) || 1;
      points.slice(1, -1).forEach((point, index) => handles.append(element('circle', {
        cx: point[0], cy: point[1], r: 6 / scale, class: 'editor-bend',
        'data-editor-edge': selectedEdge, 'data-editor-kind': 'bend', 'data-editor-index': index + 1,
      })));
      [0, points.length - 1].forEach(index => handles.append(element('rect', {
        x: points[index][0] - 6 / scale, y: points[index][1] - 6 / scale,
        width: 12 / scale, height: 12 / scale, rx: 2 / scale,
        class: 'editor-bend', style: 'cursor:grab;fill:#60a5fa',
        'data-editor-edge': selectedEdge, 'data-editor-kind': 'endpoint', 'data-editor-index': index,
      })));
      svg.append(handles);
    }
    // A label mask can overlap a bend handle after routing. Keep the visible
    // label on top so its text remains a label drag, not a geometry edit.
    svg.querySelectorAll('g[data-edge-key]').forEach(label => svg.append(label));
    if (snapPreview) {
      const points = geometry.connections[snapPreview.edge].points;
      const a = points[snapPreview.index], b = points[snapPreview.index + 1];
      if (a && b) {
        const guide = element('line', { x1:a[0], y1:a[1], x2:b[0], y2:b[1], 'data-editor-overlay':'', class:'editor-snap-guide' });
        svg.insertBefore(guide, svg.querySelector('g[data-edge-key]'));
      }
    }
  }
  function syncControls() {
    button('undo').disabled = undo.length === 0;
    button('redo').disabled = redo.length === 0;
    select(selected);
  }
  function check() {
    try {
      if (renderError) throw renderError;
      sceneFor(spec).validate();
      status.textContent = t('Layout checks passed. Edited downloads are drafts; run Archify deliver on the saved JSON for full delivery checks.', '布局检查通过。编辑后的下载为草稿；请对保存的 JSON 运行 Archify deliver 以完成交付检查。');
      status.dataset.valid = 'true';
      return true;
    } catch (error) {
      status.textContent = t('Layout needs attention:\n', '布局需要调整：\n') + error.message;
      status.dataset.valid = 'false';
      return false;
    }
  }
  function draw({ validate = true } = {}) {
    try {
      const next = sceneFor(spec);
      const markup = next.renderSvg();
      stage.innerHTML = markup;
      currentScene = next;
      renderError = null;
      if (!viewport) viewport = [0, 0, ...next.report().viewBox];
      stage.firstElementChild.setAttribute('viewBox', viewport.join(' '));
      stage.firstElementChild.removeAttribute('data-animation');
      select(selected);
      decoratePaths();
    } catch (error) {
      renderError = error;
      status.textContent = t('Cannot preview this layout. Undo or adjust the label.\n', '无法预览此布局。请撤销或调整标签。\n') + error.message;
      status.dataset.valid = 'false';
    }
    syncControls();
    if (validate) check();
  }
  function remember(before) {
    if (JSON.stringify(before) === JSON.stringify(spec)) return;
    undo.push(before);
    if (undo.length > 50) undo.shift();
    redo = [];
    dirty = true;
  }
  function change(callback) {
    const before = copy(spec);
    callback();
    remember(before);
    draw();
  }
  function move(id, x, y) {
    moveNode(spec, id, x, y, drag?.geometry || currentScene.editGeometry());
  }
  function updateLabel() {
    if (!selected && selectedEdge === null && selectedBoundary === null) return;
    if (!input.value.trim()) {
      status.textContent = t('A label cannot be empty.', '标签不能为空。');
      return;
    }
    const value = input.value;
    change(() => { (selectedBoundary !== null ? spec.boundaries[selectedBoundary] : selectedEdge === null ? spec.components.find(n => n.id === selected) : spec.connections[selectedEdge]).label = value; });
    closePopovers();
  }
  function history(back) {
    const source = back ? undo : redo;
    const destination = back ? redo : undo;
    if (!source.length) return;
    destination.push(copy(spec));
    spec = source.pop();
    selectedBoundary = null;
    selectedPart = null;
    dirty = true;
    draw();
  }
  function download(content, type, filename) {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function editedHtml() {
    // Serialize the startup document, never the modal, focus overlays, camera,
    // export receipts, or other transient state from the current viewer.
    const doc = new DOMParser().parseFromString(pristine, 'text/html');
    doc.getElementById('archify-save-session')?.remove();
    const svg = new DOMParser().parseFromString(sceneFor(spec).renderSvg(), 'image/svg+xml').documentElement;
    doc.querySelector('.diagram-container > svg').replaceWith(doc.importNode(svg, true));
    const payload = { spec, brands: data.brands, edited: dirty, undo, redo, preferences: { snapLabels } };
    doc.getElementById('archify-editor-data').textContent = JSON.stringify(payload)
      .replaceAll('<', '\\u003c').replaceAll('>', '\\u003e').replaceAll('&', '\\u0026');
    return '<!DOCTYPE html>\n' + doc.documentElement.outerHTML;
  }
  function closePopovers(focus = true) {
    menu.hidden = true;
    relabelPanel.hidden = true;
    if (focus) stage.focus();
  }
  function positionPopover(panel, x, y) {
    panel.hidden = false;
    const bounds = dialog.getBoundingClientRect();
    const rect = panel.getBoundingClientRect();
    panel.style.left = `${Math.max(bounds.left + 8, Math.min(x, bounds.right - rect.width - 8))}px`;
    panel.style.top = `${Math.max(bounds.top + 8, Math.min(y, bounds.bottom - rect.height - 8))}px`;
  }
  function chooseTarget(target, x, y) {
    const boundary = target.closest('[data-editor-boundary]');
    if (boundary) {
      selectedBoundary = Number(boundary.dataset.editorBoundary);
      selectedEdge = null; selectedPart = boundary.hasAttribute('data-editor-corner') ? { corner: Number(boundary.dataset.editorCorner) } : null;
      select(null); decoratePaths(); return true;
    }
    selectedBoundary = null;
    const id = target.closest('[data-node-id]')?.dataset.nodeId;
    const hit = target.closest('[data-editor-kind]');
    if (id) {
      selectedEdge = null; selectedPart = null; select(id); decoratePaths();
      return true;
    }
    if (hit) {
      const edge = Number(hit.dataset.editorEdge);
      let kind = hit.dataset.editorKind;
      let index = Number(hit.dataset.editorIndex);
      if (kind === 'path' || kind === 'label') {
        const local = new DOMPoint(x, y).matrixTransform(stage.firstElementChild.getScreenCTM().inverse());
        index = nearestSegment(currentScene.editGeometry().connections[edge].points, [local.x, local.y])?.index ?? 0;
        if (kind === 'path') kind = 'segment';
      }
      selectPath(edge, { kind, index });
      return true;
    }
    return false;
  }
  function removableSegment() {
    if (selectedEdge === null || !selectedPart) return null;
    const geometry = currentScene.editGeometry();
    const points = geometry.connections[selectedEdge].points;
    const ports = routePorts(spec, selectedEdge, geometry);
    const indices = selectedPart.kind === 'bend' ? [selectedPart.index, selectedPart.index - 1] : [selectedPart.index];
    return indices.find(index => index > 0 && index < points.length - 2 && removeJog(points, index, ports).length < points.length) ?? null;
  }
  function showMenu(x, y) {
    closePopovers(false);
    menuPosition = [x, y];
    const allowed = selectedBoundary !== null ? ['relabel', 'boundary-kind', 'delete-boundary'] : selectedEdge !== null ? ['relabel', 'jog', 'remove-jog', 'auto-route', 'auto-label', 'snap-label'] : selected ? ['relabel'] : ['draw-boundary'];
    menu.querySelectorAll('button').forEach(item => { item.hidden = !allowed.includes(item.dataset.action); });
    button('remove-jog').disabled = removableSegment() === null;
    button('snap-label').setAttribute('aria-checked', String(snapLabels));
    positionPopover(menu, x, y);
    menu.querySelector('button:not([hidden]):not(:disabled)').focus();
  }
  const actions = {
    'draw-boundary': () => { drawingBoundary = true; stage.style.cursor = 'crosshair'; status.textContent = t('Drag to draw a boundary. Escape cancels.', '拖动绘制边界。按 Escape 取消。'); },
    'boundary-kind': () => { if (selectedBoundary !== null) change(() => { const b = spec.boundaries[selectedBoundary]; b.kind = b.kind === 'region' ? 'security-group' : 'region'; }); },
    'delete-boundary': () => { if (selectedBoundary !== null) change(() => { spec.boundaries.splice(selectedBoundary, 1); selectedBoundary = null; }); },
    undo: () => history(true), redo: () => history(false),
    fit: () => { viewport = null; draw(); }, validate: check, label: updateLabel,
    dismiss: () => closePopovers(),
    relabel: () => {
      closePopovers(false);
      positionPopover(relabelPanel, ...menuPosition);
      input.focus(); input.select();
    },
    'snap-label': () => { snapLabels = !snapLabels; },
    'remove-jog': () => {
      const index = removableSegment();
      if (index === null) return;
      const geometry = currentScene.editGeometry();
      const points = geometry.connections[selectedEdge].points;
      const ports = routePorts(spec, selectedEdge, geometry);
      change(() => pinRoute(spec, selectedEdge, removeJog(points, index, ports), geometry));
      selectedPart = null;
    },
    jog: () => {
      if (selectedEdge === null) return;
      const geometry = currentScene.editGeometry();
      const points = geometry.connections[selectedEdge].points;
      const lengths = points.slice(1).map((point, index) => Math.hypot(point[0] - points[index][0], point[1] - points[index][1]));
      const index = selectedPart?.kind === 'segment' ? selectedPart.index : lengths.indexOf(Math.max(...lengths));
      change(() => pinRoute(spec, selectedEdge, addJog(points, index), geometry));
      selectedPart = null;
    },
    'auto-route': () => {
      if (selectedEdge === null) return;
      change(() => {
        const edge = spec.connections[selectedEdge];
        delete edge.via; delete edge.fromSide; delete edge.toSide;
        delete edge.fromOffset; delete edge.toOffset;
        edge.route = 'auto';
      });
      selectedPart = null;
    },
    'auto-label': () => {
      if (selectedEdge === null) return;
      change(() => {
        const edge = spec.connections[selectedEdge];
        delete edge.labelAt; delete edge.labelDx; delete edge.labelDy; delete edge.labelSegment;
      });
    },
    json: () => { check(); download(JSON.stringify(spec, null, 2) + '\n', 'application/json', 'architecture-edited.json'); },
    html: () => { check(); download(editedHtml(), 'text/html', 'architecture-edited.html'); },
    apply: () => {
      check();
      // Keep Apply session-local. Preserve the revision the user actually edited
      // so reloading cannot silently bypass Save & deliver's conflict detection.
      try {
        sessionStorage.setItem(draftKey, JSON.stringify({
          data: { spec, brands: data.brands, edited: dirty, undo, redo, preferences: { snapLabels } },
          saveSession: localSave,
        }));
      } catch {
        throw new Error(t('Apply needs browser session storage. Download HTML to keep your edits.', '应用更改需要浏览器会话存储。请下载 HTML 以保留编辑。'));
      }
      location.reload();
    },
    cancel: () => { dialog.close(); trigger.focus(); },
  };
  dialog.addEventListener('click', event => {
    const clicked = event.target.closest('[data-action]');
    const action = clicked?.dataset.action;
    if (!action) return;
    if (clicked.disabled) return;
    if (clicked.closest('.editor-controls')) {
      clicked.classList.add('editor-clicked');
      clearTimeout(clicked.feedbackTimer);
      clicked.feedbackTimer = setTimeout(() => clicked.classList.remove('editor-clicked'), 240);
    }
    try {
      const wasMenu = menu.contains(event.target);
      actions[action]();
      if (wasMenu && action !== 'relabel') closePopovers();
    } catch (error) { status.textContent = error.message; }
  });
  dialog.addEventListener('pointerdown', event => {
    if (!event.target.closest('.editor-popover')) closePopovers(false);
  }, true);
  menu.addEventListener('keydown', event => {
    const items = [...menu.querySelectorAll('button:not([hidden]):not(:disabled)')];
    const index = items.indexOf(document.activeElement);
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault(); event.stopPropagation();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items[next].focus();
    } else if (event.key === 'Tab') closePopovers();
  });
  stage.addEventListener('contextmenu', event => {
    event.preventDefault();
    if (!chooseTarget(event.target, event.clientX, event.clientY)) { selectedEdge = null; selectedPart = null; select(null); }
    showMenu(event.clientX, event.clientY);
  });
  stage.addEventListener('dblclick', event => {
    if (chooseTarget(event.target, event.clientX, event.clientY)) {
      menuPosition = [event.clientX, event.clientY];
      actions.relabel();
    }
  });
  stage.addEventListener('focusin', event => {
    if (event.target === stage) return;
    const rect = event.target.getBoundingClientRect();
    chooseTarget(event.target, rect.x + rect.width / 2, rect.y + rect.height / 2);
  });
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter') { event.preventDefault(); updateLabel(); }
  });
  trigger.addEventListener('click', () => {
    spec = copy(data.spec);
    undo = copy(data.undo || []);
    redo = copy(data.redo || []);
    dirty = Boolean(data.edited);
    viewport = null;
    selected = null;
    selectedBoundary = null; drawingBoundary = false; stage.style.cursor = '';
    selectedEdge = null;
    selectedPart = null;
    snapPreview = null;
    closePopovers(false);
    dialog.showModal();
    draw();
  });
  stage.addEventListener('pointerdown', event => {
    if (event.button !== 0 || !currentScene) return;
    const svg = stage.firstElementChild;
    const matrix = svg.getScreenCTM().inverse();
    const start = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix);
    if (drawingBoundary) {
      drag = { pointer: event.pointerId, before: copy(spec), boundary: (spec.boundaries || []).length, creating: true, start, matrix, geometry: currentScene.editGeometry() };
      selectedBoundary = drag.boundary; selectedEdge = null; selectedPart = null; selected = null;
      stage.setPointerCapture(event.pointerId); event.preventDefault(); return;
    }
    if (!chooseTarget(event.target, event.clientX, event.clientY)) {
      selectedEdge = null; selectedPart = null; select(null); decoratePaths();
    }
    const id = selected, edge = selectedEdge, part = selectedPart;
    const box = id && currentScene.report().components.find(node => node.id === id);
    const scale = Math.hypot(svg.getScreenCTM().a, svg.getScreenCTM().b) || 1;
    drag = { pointer: event.pointerId, before: copy(spec), id, box, edge, part, scale, geometry: currentScene.editGeometry(), start, matrix, viewport: [...viewport] };
    if (selectedBoundary !== null) {
      const frame = stage.querySelector(`rect[data-graph-role="structural-frame"][data-composition-frame-id="${selectedBoundary}"]`);
      drag.boundary = selectedBoundary;
      drag.rect = ['x', 'y', 'width', 'height'].map(name => Number(frame.getAttribute(name)));
    }
    stage.setPointerCapture(event.pointerId);
    stage.focus();
    event.preventDefault();
  });
  stage.addEventListener('pointermove', event => {
    if (!drag || event.pointerId !== drag.pointer) return;
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(drag.matrix);
    const dx = point.x - drag.start.x;
    const dy = point.y - drag.start.y;
    const snap = dialog.querySelector('[data-control="snap"]').checked;
    const round = value => snap ? Math.round(value / 10) * 10 : Math.round(value);
    // Every frame starts from the transaction snapshot, not the last preview.
    // This prevents accumulated elbow insertion and makes reversal exact.
    spec = copy(drag.before);
    snapPreview = null;
    if (drag.boundary !== undefined) {
      let x1, y1, x2, y2;
      if (drag.creating) { x1 = round(drag.start.x); y1 = round(drag.start.y); x2 = round(point.x); y2 = round(point.y); }
      else {
        const [x,y,w,h] = drag.rect;
        x1=x; y1=y; x2=x+w; y2=y+h;
        if (drag.part?.corner !== undefined) {
          if (drag.part.corner % 2) x2=round(x+w+dx); else x1=round(x+dx);
          if (drag.part.corner > 1) y2=round(y+h+dy); else y1=round(y+dy);
        } else { x1=round(x+dx); y1=round(y+dy); x2=x1+w; y2=y1+h; }
      }
      const rect = [Math.min(x1,x2), Math.min(y1,y2), Math.max(20,Math.abs(x2-x1)), Math.max(20,Math.abs(y2-y1))];
      spec.boundaries ||= [];
      const boundary = spec.boundaries[drag.boundary] ||= { kind: 'region', label: t('New boundary', '新边界'), wraps: [] };
      boundary.rect = rect;
      boundary.wraps = fixedBoundaryMembers(rect, drag.geometry.components);
      draw({ validate: false });
    } else if (drag.id) {
      if (Math.abs(dx) + Math.abs(dy) < 1) return;
      move(drag.id, round(drag.box.x + dx), round(drag.box.y + dy));
      draw({ validate: false });
    } else if (drag.edge !== null) {
      if (Math.abs(dx) + Math.abs(dy) < 1) return;
      const { points, labelAt } = drag.geometry.connections[drag.edge];
      const ports = routePorts(spec, drag.edge, drag.geometry);
      let hint = '';
      if (drag.part.kind === 'endpoint') {
        const endpoint = drag.part.index === 0 ? 'from' : 'to';
        const origin = endpoint === 'from' ? points[0] : points.at(-1);
        moveEndpoint(spec, drag.edge, endpoint, [origin[0] + dx, origin[1] + dy], drag.geometry);
        hint = t('Attachment follows the node edge · Drag around a corner to change sides.', '连接点沿节点边缘移动 · 拖过转角可切换边。');
      } else if (drag.part.kind === 'label') {
        const position = [labelAt[0] + dx, labelAt[1] + dy];
        const snapped = snapLabels && !event.altKey ? snapLabel(points, position, 12 / drag.scale) : null;
        const edge = spec.connections[drag.edge];
        if (snapped) {
          delete edge.labelAt;
          Object.assign(edge, snapped.fields);
          snapPreview = { edge: drag.edge, index: snapped.index };
          hint = t('Label snapped to path · Hold Alt to place freely.', '标签已吸附到连线 · 按住 Alt 可自由移动。');
        } else edge.labelAt = position.map(value => event.altKey ? Math.round(value) : round(value));
      } else {
        const index = drag.part.index;
        let moved;
        if (drag.part.kind === 'bend') {
          const target = [round(points[index][0] + dx), round(points[index][1] + dy)];
          moved = moveBend(points, index, target[0] - points[index][0], target[1] - points[index][1], ports);
          const merged = mergeNearbyBends(moved, ports, 10 / drag.scale, target);
          moved = merged.points;
          if (merged.merged) hint = t('Nearby corners merged · Release to keep, or drag away to restore.', '相邻转角已合并 · 松开保留，移开恢复。');
        } else {
          const axis = points[index][1] === points[index + 1][1] ? 1 : 0;
          const distance = round(points[index][axis] + (axis ? dy : dx)) - points[index][axis];
          moved = moveSegment(points, index, distance, ports, event.altKey ? 0 : 10 / drag.scale);
          if (moved.length < points.length) hint = t('Aligned segments merged · Release to keep, or drag away to restore.', '对齐线段已合并 · 松开保留，移开恢复。');
        }
        pinRoute(spec, drag.edge, moved, drag.geometry);
      }
      draw({ validate: false });
      if (!renderError) {
        status.textContent = hint || t('Release to place · Layout checks run when the drag finishes.', '松开以放置 · 拖动结束后检查布局。');
        status.dataset.valid = 'pending';
      }
    } else {
      viewport = [drag.viewport[0] - dx, drag.viewport[1] - dy, ...drag.viewport.slice(2)];
      stage.firstElementChild.setAttribute('viewBox', viewport.join(' '));
    }
  });
  function finishDrag(event, cancel = false) {
    if (!drag || event.pointerId !== drag.pointer) return;
    const transaction = drag;
    drag = null;
    snapPreview = null;
    const changed = JSON.stringify(transaction.before) !== JSON.stringify(spec);
    if (cancel) spec = transaction.before;
    else if (transaction.id || transaction.edge !== null || transaction.boundary !== undefined) remember(transaction.before);
    if (transaction.creating) { drawingBoundary = false; stage.style.cursor = ''; if (cancel) selectedBoundary = null; }
    if (changed && transaction.part?.kind !== 'label' && transaction.edge !== null) selectedPart = null;
    if (stage.hasPointerCapture(event.pointerId)) stage.releasePointerCapture(event.pointerId);
    draw();
  }
  stage.addEventListener('pointerup', event => finishDrag(event));
  stage.addEventListener('pointercancel', event => finishDrag(event, true));
  stage.addEventListener('lostpointercapture', event => finishDrag(event, true));
  stage.addEventListener('wheel', event => {
    if (!viewport) return;
    event.preventDefault();
    closePopovers(false);
    const matrix = stage.firstElementChild.getScreenCTM().inverse();
    const at = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix);
    const factor = Math.exp(Math.max(-100, Math.min(100, event.deltaY)) * .002);
    const width = Math.max(100, Math.min(10000, viewport[2] * factor));
    const scale = width / viewport[2];
    viewport = [at.x + (viewport[0] - at.x) * scale, at.y + (viewport[1] - at.y) * scale, width, viewport[3] * scale];
    stage.firstElementChild.setAttribute('viewBox', viewport.join(' '));
    decoratePaths();
  }, { passive: false });
  dialog.addEventListener('keydown', event => {
    if (event.key === 'Escape' && (drawingBoundary || drag?.boundary !== undefined)) {
      event.preventDefault();
      if (drag) finishDrag({ pointerId: drag.pointer }, true);
      drawingBoundary = false; stage.style.cursor = ''; return;
    }
    if (event.key === 'Escape' && (!menu.hidden || !relabelPanel.hidden)) {
      event.preventDefault(); closePopovers(); return;
    }
    if (event.target.matches('input, select, textarea')) return;
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
      event.preventDefault();
      const rect = (stage.contains(event.target) && event.target !== stage ? event.target : stage).getBoundingClientRect();
      showMenu(rect.x + rect.width / 2, rect.y + rect.height / 2);
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault(); history(!event.shiftKey); return;
    }
    const directions = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (!selected || !directions[event.key] || !stage.contains(event.target)) return;
    event.preventDefault();
    const box = currentScene.report().components.find(n => n.id === selected);
    const [dx, dy] = directions[event.key];
    const step = event.shiftKey ? 10 : 1;
    change(() => move(selected, box.x + dx * step, box.y + dy * step));
  });
  dialog.addEventListener('cancel', () => { drag = null; });
  // Keep the normal viewer's document-level shortcuts out of the modal.
  ['keydown', 'keyup', 'click', 'pointerdown'].forEach(type => {
    dialog.addEventListener(type, event => event.stopPropagation());
  });
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initializeEditor, { once: true });
else initializeEditor();
