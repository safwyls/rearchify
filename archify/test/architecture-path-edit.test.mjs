import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createArchitectureScene } from '../renderers/architecture/architecture-scene.mjs';
import { attachRoute, moveNode, moveEndpoint, moveSegment, moveBend, routePorts, pinRoute, addJog, removeJog, mergeNearbyBends, snapLabel, snapNodePosition } from '../../viewer/architecture-path-edit.mjs';
import { labelPoint } from '../renderers/shared/geometry.mjs';

const demo = () => JSON.parse(fs.readFileSync(new URL('../examples/web-app.architecture.json', import.meta.url), 'utf8'));

test('node grid snapping uses centers, including odd dimensions and canvas bounds', () => {
  for (const size of [[130, 64], [131, 65]]) {
    const box = { width: size[0], height: size[1] };
    for (const desired of [[102, 109], [-100, -100]]) {
      const position = snapNodePosition(box, desired);
      position.forEach((value, axis) => {
        assert.ok(value >= 0);
        assert.equal((value + size[axis] / 2) % 10, 0);
      });
      const spec = { components: [{ id: 'a' }], connections: [] };
      moveNode(spec, 'a', ...position, { components: [{ id: 'a', ...box }], connections: [] });
      assert.deepEqual(spec.components[0].pos, position, 'do not round away half-pixel centers');
    }
  }
  assert.deepEqual(snapNodePosition({ width: 130, height: 64 }, [102, 109]), [105, 108]);
});

test('endpoints snap to each node edge center with a bounded, optional tolerance', () => {
  for (const endpoint of ['from', 'to']) for (const side of ['left', 'right', 'top', 'bottom']) {
    const spec = demo(), index = spec.connections.findIndex(edge => edge.id === 'jwt-verification');
    const geometry = createArchitectureScene(spec).editGeometry();
    const edge = spec.connections[index], box = geometry.components.find(node => node.id === edge[endpoint]);
    const center = side === 'left' ? [box.x, box.y + box.height / 2] : side === 'right' ? [box.x + box.width, box.y + box.height / 2] : side === 'top' ? [box.x + box.width / 2, box.y] : [box.x + box.width / 2, box.y + box.height];
    const axis = side === 'left' || side === 'right' ? 1 : 0;
    for (const tolerance of [10, 0, 4]) {
      const draft = structuredClone(spec), target = [...center]; target[axis] += 5;
      const routed = moveEndpoint(draft, index, endpoint, target, geometry, tolerance);
      orthogonal(routed);
      assert.deepEqual(endpoint === 'from' ? routed[0] : routed.at(-1), tolerance === 10 ? center : target);
      assert.deepEqual(endpoint === 'from' ? routed.at(-1) : routed[0], endpoint === 'from' ? geometry.connections[index].points.at(-1) : geometry.connections[index].points[0]);
    }
  }
});

test('endpoint proximity to another handle straightens a path in both orientations and directions', () => {
  for (const vertical of [false, true]) for (const reverse of [false, true]) {
    const transform = point => vertical ? [point[1], point[0]] : point;
    let points = [[100, 30], [150, 30], [150, 50], [200, 50]].map(transform);
    const components = [{ id: 'a', x: 0, y: 0, width: 100, height: 100 }, { id: 'b', x: vertical ? 0 : 200, y: vertical ? 200 : 0, width: 100, height: 100 }];
    let edge = { from: 'a', to: 'b', fromSide: vertical ? 'bottom' : 'right', toSide: vertical ? 'top' : 'left' };
    if (reverse) { points.reverse(); edge = { from: 'b', to: 'a', fromSide: edge.toSide, toSide: edge.fromSide }; }
    const spec = { components, connections: [edge] }, geometry = { components, connections: [{ points }] };
    const endpoint = reverse ? 'to' : 'from';
    const expected = [[100,50], [200,50]].map(transform); if (reverse) expected.reverse();
    const moved = moveEndpoint(spec, 0, endpoint, transform([100, 44]), geometry, 10);
    assert.deepEqual(moved, expected);
    orthogonal(moved);
  }
});

test('corners align with endpoint and corner axes and collapse jogs, with free movement outside tolerance', () => {
  for (const vertical of [false, true]) for (const reverse of [false, true]) {
    const transform = point => vertical ? [point[1], point[0]] : point;
    let points = [[0,0],[60,0],[60,40],[120,40],[120,0],[180,0]].map(transform);
    if (reverse) points.reverse();
    const ports = { start: points[0], end: points.at(-1), fromSide: vertical ? (reverse ? 'top' : 'bottom') : (reverse ? 'left' : 'right'), toSide: vertical ? (reverse ? 'bottom' : 'top') : (reverse ? 'right' : 'left') };
    const index = reverse ? 3 : 2, delta = transform([0,-34]);
    assert.deepEqual(moveBend(points, index, ...delta, ports, 10), [ports.start, ports.end]);
    assert.ok(moveBend(points, index, ...delta, ports, 0).length > 2);
    assert.ok(moveBend(points, index, ...delta, ports, 5).length > 2);
    orthogonal(moveBend(points, index, ...transform([0,-20]), ports, 10));
  }
});
test('live attachment cleanup removes partial backtracks in both directions and orientations', () => {
  for (const transpose of [false, true]) for (const reverse of [false, true]) {
    const transform = p => transpose ? [p[1], p[0]] : p;
    let points = [[137,112],[137,285],[137,190],[431,190],[431,230]].map(transform);
    let expected = [[137,112],[137,190],[431,190],[431,230]].map(transform);
    if (reverse) { points.reverse(); expected.reverse(); }
    const ports = { start: points[0], end: points.at(-1), fromSide: transpose ? (reverse ? 'left' : 'right') : (reverse ? 'top' : 'bottom'), toSide: transpose ? (reverse ? 'right' : 'left') : (reverse ? 'bottom' : 'top') };
    assert.deepEqual(attachRoute(points, ports), expected);
    assert.deepEqual(attachRoute(expected, ports), expected, 'repeated previews do not insert elbows again');
  }
});

test('corner previews collapse a partial reversal while keeping outward endpoint stubs', () => {
  const ports = { start: [0,0], end: [200,100], fromSide: 'right', toSide: 'left' };
  const points = [[0,0],[60,0],[60,100],[200,100]];
  const moved = moveBend(points, 1, -100, 0, ports);
  orthogonal(moved);
  assert.ok(moved[1][0] > 0, 'cleanup must not reverse the pinned departure side');
  assert.deepEqual(moved[0], ports.start);
  assert.deepEqual(moved.at(-1), ports.end);
});
test('endpoint attachments persist on every side and follow node movement', () => {
  for (const endpoint of ['from', 'to']) for (const side of ['left', 'right', 'top', 'bottom']) {
    const spec = demo();
    const index = spec.connections.findIndex(edge => edge.id === 'jwt-verification');
    const geometry = createArchitectureScene(spec).editGeometry();
    const edge = spec.connections[index];
    const box = geometry.components.find(node => node.id === edge[endpoint]);
    const position = side === 'left' ? [box.x, box.y + box.height * .3] : side === 'right' ? [box.x + box.width, box.y + box.height * .3] : side === 'top' ? [box.x + box.width * .3, box.y] : [box.x + box.width * .3, box.y + box.height];
    moveEndpoint(spec, index, endpoint, position, geometry);
    assert.equal(edge[`${endpoint}Side`], side);
    const after = createArchitectureScene(JSON.parse(JSON.stringify(spec))).editGeometry();
    const points = after.connections[index].points;
    orthogonal(points);
    assert.deepEqual(endpoint === 'from' ? points[0] : points.at(-1), position);
    assert.deepEqual(endpoint === 'from' ? points.at(-1) : points[0], endpoint === 'from' ? geometry.connections[index].points.at(-1) : geometry.connections[index].points[0]);
    moveNode(spec, edge[endpoint], box.x + 20, box.y + 30, after);
    const moved = createArchitectureScene(spec).editGeometry().connections[index].points;
    orthogonal(moved);
    assert.deepEqual(endpoint === 'from' ? moved[0] : moved.at(-1), [position[0] + 20, position[1] + 30]);
  }
});
function orthogonal(points) {
  points.slice(1).forEach((point, index) => assert.ok(point[0] === points[index][0] || point[1] === points[index][1], `Diagonal segment: ${points[index]} → ${point}`));
}

test('moving either JWT endpoint adjusts adjacent bends and keeps the route orthogonal', () => {
  for (const [id, pos] of [['auth', [80, 130]], ['api', [700, 310]], ['auth', [720, 90]]]) {
    const spec = demo();
    const geometry = createArchitectureScene(spec).editGeometry();
    const index = spec.connections.findIndex(edge => edge.id === 'jwt-verification');
    const original = structuredClone(spec.connections[index].via);
    moveNode(spec, id, ...pos, geometry);
    const moved = createArchitectureScene(spec).editGeometry().connections[index].points;
    orthogonal(moved);
    assert.notDeepEqual(spec.connections[index].via, original);
    if (id === 'auth') {
      assert.deepEqual(moved[0], [pos[0] + 120, pos[1] + 32]);
      assert.deepEqual(moved.at(-1), geometry.connections[index].points.at(-1));
    } else {
      assert.deepEqual(moved.at(-1), [pos[0] + 65, pos[1]]);
    }
  }
});

test('all JWT segments and bends remain orthogonal, anchored, and serializable when edited', () => {
  for (const kind of ['segment', 'bend']) {
    const original = demo();
    const index = original.connections.findIndex(edge => edge.id === 'jwt-verification');
    const geometry = createArchitectureScene(original).editGeometry();
    const points = geometry.connections[index].points;
    for (let part = kind === 'segment' ? 0 : 1; part < points.length - 1; part++) {
      const spec = structuredClone(original);
      const ports = routePorts(spec, index, geometry);
      const moved = kind === 'segment' ? moveSegment(points, part, 40, ports) : moveBend(points, part, 30, 40, ports);
      pinRoute(spec, index, moved, geometry);
      const restored = createArchitectureScene(JSON.parse(JSON.stringify(spec))).editGeometry().connections[index].points;
      orthogonal(restored);
      assert.deepEqual(restored[0], points[0]);
      assert.deepEqual(restored.at(-1), points.at(-1));
      assert.notDeepEqual(restored, points);
    }
  }
});

test('a straight path can be dragged into a jog and gains stable manual route pins', () => {
  const spec = demo();
  const index = spec.connections.findIndex(edge => edge.id === 'api-sql');
  const geometry = createArchitectureScene(spec).editGeometry();
  const points = geometry.connections[index].points;
  assert.equal(points.length, 2);
  const moved = moveSegment(points, 0, -40, routePorts(spec, index, geometry));
  pinRoute(spec, index, moved, geometry);
  const after = createArchitectureScene(spec).editGeometry().connections[index].points;
  orthogonal(after);
  assert.equal(after.length, 6);
  assert.equal(spec.connections[index].via.length, 4);
  assert.deepEqual(after[0], points[0]);
  assert.deepEqual(after.at(-1), points.at(-1));
});

test('adding a jog preserves other segments and label pins remain independent', () => {
  const spec = demo();
  const index = spec.connections.findIndex(edge => edge.id === 'jwt-verification');
  const geometry = createArchitectureScene(spec).editGeometry();
  const points = geometry.connections[index].points;
  const moved = addJog(points, 0, -40);
  pinRoute(spec, index, moved, geometry);
  spec.connections[index].labelAt = [760, 220];
  const after = createArchitectureScene(spec).editGeometry().connections[index];
  orthogonal(after.points);
  assert.deepEqual(after.labelAt, [760, 220]);
  assert.deepEqual(after.points.slice(-3), points.slice(-3));
  const exported = JSON.parse(JSON.stringify(spec));
  assert.deepEqual(createArchitectureScene(exported).editGeometry().connections[index], after);
});

test('route editing retains fractional geometry and reconnects automatic spread ports', () => {
  const spec = { meta: { title: 'Ports' }, components: [
    { id: 'a', type: 'backend', label: 'A', pos: [40.5, 60.5], size: [120, 61] },
    { id: 'b', type: 'backend', label: 'B', pos: [360.5, 60.5] },
    { id: 'c', type: 'backend', label: 'C', pos: [360.5, 200.5] },
  ], connections: [{ from: 'a', to: 'b' }, { from: 'a', to: 'c' }] };
  const geometry = createArchitectureScene(spec).editGeometry();
  const points = geometry.connections[0].points;
  pinRoute(spec, 0, moveSegment(points, 0, -30, routePorts(spec, 0, geometry)), geometry);
  const after = createArchitectureScene(spec).editGeometry().connections[0].points;
  orthogonal(after);
  assert.deepEqual(after[0], [160.5, 91]);
  assert.deepEqual(after.at(-1), [360.5, 90.5]);
});

test('removing a jog collapses its return legs without a backtracking spur', () => {
  for (const points of [[[0, 0], [180, 0]], [[0, 0], [0, 180]]]) {
    const horizontal = points[1][1] === 0;
    const ports = { start: points[0], end: points[1], fromSide: horizontal ? 'right' : 'bottom', toSide: horizontal ? 'left' : 'top' };
    const jogged = addJog(points, 0);
    for (const segment of [1, 2, 3]) {
      const removed = removeJog(jogged, segment, ports);
      orthogonal(removed);
      assert.deepEqual(removed, points);
    }
  }
});

test('nearby adjacent corners merge without detaching endpoints, distant/unrelated bends remain', () => {
  const ports = { start: [200, 162], end: [735, 300], fromSide: 'right', toSide: 'top' };
  const points = [[200,162],[630,162],[630,164],[735,164],[735,300]];
  const merged = mergeNearbyBends(points, ports, 10, [630,164]);
  assert.equal(merged.merged, true);
  assert.deepEqual(merged.points, [[200,162],[735,162],[735,300]]);
  orthogonal(merged.points);
  assert.equal(mergeNearbyBends(points, ports, 1, [630,164]).merged, false);
  assert.equal(mergeNearbyBends(points, ports, 10, [735,300]).merged, false);
});

test('dragging near a neighboring parallel segment merges the jog in either orientation', () => {
  for (const vertical of [false, true]) {
    const transform = point => vertical ? [point[1], point[0]] : point;
    const straight = [[0, 0], [180, 0]].map(transform);
    const ports = { start: straight[0], end: straight[1], fromSide: vertical ? 'bottom' : 'right', toSide: vertical ? 'top' : 'left' };
    const jogged = addJog(straight, 0, 40);
    const original = structuredClone(jogged);
    assert.deepEqual(moveSegment(jogged, 2, -34, ports, 10), straight);
    assert.deepEqual(moveSegment(jogged, 2, -46, ports, 10), straight);
    assert.ok(moveSegment(jogged, 2, -29, ports, 10).length > 2, 'outside the threshold stays separate');
    assert.ok(moveSegment(jogged, 2, -34, ports, 0).length > 2, 'snapping can be bypassed');
    assert.ok(moveSegment(jogged, 2, -34, ports, 5).length > 2, 'tolerance scales with zoom');
    assert.deepEqual(jogged, original, 'drag snapshots remain unchanged for reversal and undo');
    const offset = [[0,0],[60,0],[60,40],[180,40]].map(transform);
    const offsetPorts = { ...ports, end: offset.at(-1) };
    for (const [index, distance] of [[0,34],[2,-34]]) {
      const merged = moveSegment(offset, index, distance, offsetPorts, 10);
      orthogonal(merged);
      assert.deepEqual(merged[0], offsetPorts.start);
      assert.deepEqual(merged.at(-1), offsetPorts.end);
    }
  }
});

test('label snapping projects to horizontal/vertical segments and persists relative placement', () => {
  const horizontal = [[0,0],[180,0]];
  const snapped = snapLabel(horizontal, [70, 7], 10);
  assert.deepEqual(snapped.position, [70,3]);
  assert.deepEqual(labelPoint(snapped.fields, horizontal), snapped.position);
  assert.equal(snapLabel(horizontal, [70,30], 10), null);
  const vertical = [[0,0],[0,180]];
  const snap = snapLabel(vertical, [6,75], 10);
  assert.deepEqual(snap.position, [0,75]);
  assert.deepEqual(labelPoint(snap.fields, vertical), snap.position);
  assert.deepEqual(labelPoint(snap.fields, [[30,0],[30,180]]), [30,75]);
});

test('a snapped label follows the main corridor when a straight path gains endpoint elbows', () => {
  const spec = demo();
  const index = spec.connections.findIndex(edge => edge.id === 'api-sql');
  const geometry = createArchitectureScene(spec).editGeometry();
  const points = geometry.connections[index].points;
  const mid = [(points[0][0] + points[1][0]) / 2, points[0][1] + 3];
  Object.assign(spec.connections[index], snapLabel(points, mid, 1).fields);
  pinRoute(spec, index, moveSegment(points, 0, -40, routePorts(spec, index, geometry)), geometry);
  const edited = createArchitectureScene(spec).editGeometry().connections[index];
  assert.deepEqual(edited.labelAt, [mid[0], mid[1] - 40]);
  assert.equal(spec.connections[index].labelAt, undefined);
  assert.equal(spec.connections[index].labelSegment, 2);
});
