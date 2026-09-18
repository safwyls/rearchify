import { anchor, normalizeRoutePoints, labelPoint, routeHonorsEndpointSides } from '../archify/renderers/shared/geometry.mjs';
import { fixedBoundaryMembers } from '../archify/renderers/architecture/boundary-membership.mjs';

const vectors = { left: [-1, 0], right: [1, 0], top: [0, -1], bottom: [0, 1] };
const horizontal = side => side === 'left' || side === 'right';
const clonePoints = points => points.map(point => [...point]);
const boxWithCenter = box => ({ ...box, cx: box.x + box.width / 2, cy: box.y + box.height / 2 });

// Resolve the actual port from measured geometry, including spread automatic
// ports. Pinning a route disables automatic port spreading in the renderer, so
// manual routes reconnect to the canonical center of that same endpoint side.
function sideAt(box, point) {
  return Object.entries({ left: Math.abs(point[0] - box.x), right: Math.abs(point[0] - box.x - box.width),
    top: Math.abs(point[1] - box.y), bottom: Math.abs(point[1] - box.y - box.height) })
    .sort((a, b) => a[1] - b[1])[0][0];
}

export function routePorts(spec, index, geometry) {
  const connection = spec.connections[index];
  const from = boxWithCenter(geometry.components.find(node => node.id === connection.from));
  const to = boxWithCenter(geometry.components.find(node => node.id === connection.to));
  const points = geometry.connections[index].points;
  const fromSide = vectors[connection.fromSide] ? connection.fromSide : sideAt(from, points[0]);
  const toSide = vectors[connection.toSide] ? connection.toSide : sideAt(to, points.at(-1));
  return { fromSide, toSide, start: anchor(from, fromSide, connection.fromOffset), end: anchor(to, toSide, connection.toOffset) };
}

export function moveEndpoint(spec, index, endpoint, position, geometry) {
  const connection = spec.connections[index];
  const points = clonePoints(geometry.connections[index].points);
  // Preserve both measured attachments when converting automatic ports to pins.
  for (const end of ['from', 'to']) {
    const box = geometry.components.find(node => node.id === connection[end]);
    const point = end === 'from' ? points[0] : points.at(-1);
    const side = vectors[connection[`${end}Side`]] ? connection[`${end}Side`] : sideAt(box, point);
    connection[`${end}Side`] = side;
    connection[`${end}Offset`] = horizontal(side) ? (point[1] - box.y) / box.height : (point[0] - box.x) / box.width;
  }
  const box = geometry.components.find(node => node.id === connection[endpoint]);
  const oldSide = connection[`${endpoint}Side`];
  const side = sideAt(box, position);
  const length = horizontal(side) ? box.height : box.width;
  const along = horizontal(side) ? position[1] - box.y : position[0] - box.x;
  // Keep handles clear of rounded corners while allowing every side.
  const margin = Math.min(8, length / 4);
  connection[`${endpoint}Side`] = side;
  connection[`${endpoint}Offset`] = Math.max(margin, Math.min(length - margin, along)) / length;
  const ports = routePorts(spec, index, geometry);
  if (oldSide === side && points.length > 2) {
    const adjacent = endpoint === 'from' ? 1 : points.length - 2;
    const axis = horizontal(side) ? 1 : 0;
    points[adjacent][axis] = ports[endpoint === 'from' ? 'start' : 'end'][axis];
  }
  return pinRoute(spec, index, points, geometry);
}

function stub(point, side, length = 24) {
  const vector = vectors[side];
  return point.map((value, axis) => value + vector[axis] * length);
}

function outward(start, next, side) {
  const axis = horizontal(side) ? 0 : 1;
  return start[1 - axis] === next[1 - axis] && (next[axis] - start[axis]) * vectors[side][axis] > 0;
}

function bridgeToInterior(port, point, side) {
  if (outward(port, point, side)) return [port, point];
  const s = stub(port, side);
  return horizontal(side) ? [port, s, [s[0], point[1]], point] : [port, s, [point[0], s[1]], point];
}

function connectPorts(start, end, fromSide, toSide) {
  if (outward(start, end, fromSide) && outward(end, start, toSide)) return [start, end];
  const a = stub(start, fromSide);
  const b = stub(end, toSide);
  let middle;
  if (horizontal(fromSide) && horizontal(toSide)) {
    const x = (a[0] + b[0]) / 2;
    middle = [[x, a[1]], [x, b[1]]];
  } else if (!horizontal(fromSide) && !horizontal(toSide)) {
    const y = (a[1] + b[1]) / 2;
    middle = [[a[0], y], [b[0], y]];
  } else {
    middle = [horizontal(fromSide) ? [b[0], a[1]] : [a[0], b[1]]];
  }
  return normalizeRoutePoints([start, a, ...middle, b, end]);
}

export function attachRoute(points, ports) {
  const { start, end, fromSide, toSide } = ports;
  const interior = clonePoints(points.slice(1, -1));
  if (!interior.length) return connectPorts(start, end, fromSide, toSide);
  const attached = normalizeRoutePoints([
    ...bridgeToInterior(start, interior[0], fromSide).slice(0, -1),
    ...interior,
    ...bridgeToInterior(end, interior.at(-1), toSide).reverse().slice(1),
  ]);
  // Endpoint bridges can double back only partway along an existing leg.
  // Collapse those overlaps every preview frame, while preserving the outward
  // departure and perpendicular arrival required by the pinned node sides.
  const simplified = simplifySpurs(attached);
  return routeHonorsEndpointSides(simplified, fromSide, toSide) ? simplified : attached;
}

export function pinRoute(spec, index, points, geometry) {
  const ports = routePorts(spec, index, geometry);
  const connection = spec.connections[index];
  const routed = attachRoute(points, ports);
  followSnappedLabel(connection, geometry.connections[index].points, routed);
  connection.fromSide = ports.fromSide;
  connection.toSide = ports.toSide;
  connection.route = 'auto';
  connection.via = routed.slice(1, -1);
  return routed;
}

// Moving a segment slides its corridor perpendicular to its direction. Endpoint
// segments get extra elbows instead of pulling their attachment off the node.
export function moveSegment(points, index, distance, ports, mergeTolerance = 0) {
  const moved = clonePoints(points);
  const isHorizontal = points[index][1] === points[index + 1][1];
  const axis = isHorizontal ? 1 : 0;
  // Snap to the parallel legs immediately across either adjoining jog. Work
  // from the original drag geometry so pulling away restores the detour.
  if (mergeTolerance > 0) {
    const target = points[index][axis] + distance;
    const candidates = [index - 2, index + 2]
      .filter(other => other >= 0 && other + 1 < points.length && points[other][axis] === points[other + 1][axis])
      .map(other => points[other][axis])
      .filter(value => Math.abs(value - target) <= mergeTolerance)
      .sort((a, b) => Math.abs(a - target) - Math.abs(b - target));
    if (candidates.length) distance = candidates[0] - points[index][axis];
  }
  if (index === 0 && index === points.length - 2) {
    const a = stub(points[0], ports.fromSide);
    const b = stub(points.at(-1), ports.toSide);
    const shiftedA = [...a]; shiftedA[axis] += distance;
    const shiftedB = [...b]; shiftedB[axis] += distance;
    return normalizeRoutePoints([points[0], a, shiftedA, shiftedB, b, points.at(-1)]);
  }
  if (index > 0) moved[index][axis] += distance;
  if (index + 1 < points.length - 1) moved[index + 1][axis] += distance;
  return attachRoute(simplifySpurs(moved), ports);
}

export function moveBend(points, index, dx, dy, ports) {
  const moved = clonePoints(points);
  const point = moved[index];
  point[0] += dx; point[1] += dy;
  if (index > 1) {
    const axis = points[index - 1][1] === points[index][1] ? 1 : 0;
    moved[index - 1][axis] = point[axis];
  }
  if (index < points.length - 2) {
    const axis = points[index + 1][1] === points[index][1] ? 1 : 0;
    moved[index + 1][axis] = point[axis];
  }
  return attachRoute(moved, ports);
}

export function addJog(points, index, offset = 40) {
  const a = points[index], b = points[index + 1];
  const along = a[1] === b[1] ? 0 : 1;
  const cross = 1 - along;
  const first = [...a], last = [...b];
  first[along] = a[along] + (b[along] - a[along]) / 3;
  last[along] = a[along] + (b[along] - a[along]) * 2 / 3;
  const raisedFirst = [...first], raisedLast = [...last];
  raisedFirst[cross] += offset; raisedLast[cross] += offset;
  return normalizeRoutePoints([...points.slice(0, index + 1), first, raisedFirst, raisedLast, last, ...points.slice(index + 1)]);
}

export function nearestSegment(points, position) {
  let nearest = null;
  points.slice(1).forEach((end, index) => {
    const start = points[index];
    const vector = end.map((value, axis) => value - start[axis]);
    const length2 = vector[0] ** 2 + vector[1] ** 2;
    if (!length2) return;
    const amount = Math.max(0, Math.min(1, ((position[0] - start[0]) * vector[0] + (position[1] - start[1]) * vector[1]) / length2));
    const point = start.map((value, axis) => value + amount * vector[axis]);
    const distance = Math.hypot(point[0] - position[0], point[1] - position[1]);
    if (!nearest || distance < nearest.distance) nearest = { index, point, distance };
  });
  return nearest;
}

// SVG labels use a baseline 3px below their mask's center. Snap that center,
// then encode the placement using existing segment-relative fields so it follows
// subsequent segment moves instead of becoming a fixed world-coordinate pin.
export function snapLabel(points, position, tolerance) {
  const nearest = nearestSegment(points, [position[0], position[1] - 3]);
  if (!nearest || nearest.distance > tolerance) return null;
  const baseline = [nearest.point[0], nearest.point[1] + 3];
  const base = labelPoint({ labelSegment: nearest.index }, points);
  return { ...nearest, position: baseline, fields: {
    labelSegment: nearest.index, labelDx: baseline[0] - base[0], labelDy: baseline[1] - base[1],
  } };
}

function followSnappedLabel(connection, before, after) {
  if (connection.labelAt || !Number.isInteger(connection.labelSegment)) return;
  const oldLabel = labelPoint(connection, before);
  if (!snapLabel(before, oldLabel, 0.000001)) return;
  const oldIndex = Math.min(before.length - 2, Math.max(0, connection.labelSegment));
  const a = before[oldIndex], b = before[oldIndex + 1];
  const along = a[1] === b[1] ? 0 : 1;
  const center = [oldLabel[0], oldLabel[1] - 3];
  const low = Math.min(a[along], b[along]), high = Math.max(a[along], b[along]);
  const candidates = [];
  after.slice(1).forEach((end, index) => {
    const start = after[index];
    if (start[1 - along] !== end[1 - along] || start[along] === end[along]) return;
    const overlap = Math.max(0, Math.min(high, Math.max(start[along], end[along])) - Math.max(low, Math.min(start[along], end[along])));
    const middle = start.map((value, axis) => (value + end[axis]) / 2);
    candidates.push({ index, overlap, distance: Math.hypot(center[0] - middle[0], center[1] - middle[1]), middle });
  });
  const selected = candidates.sort((left, right) => right.overlap - left.overlap || left.distance - right.distance)[0];
  let index, point;
  if (selected) {
    index = selected.index;
    point = [...selected.middle];
    const desired = selected.middle[along] + center[along] - (a[along] + b[along]) / 2;
    point[along] = Math.max(Math.min(after[index][along], after[index + 1][along]), Math.min(desired, Math.max(after[index][along], after[index + 1][along])));
  } else {
    const nearest = nearestSegment(after, center);
    if (!nearest) return;
    ({ index, point } = nearest);
  }
  const base = labelPoint({ labelSegment: index }, after);
  connection.labelSegment = index;
  connection.labelDx = point[0] - base[0];
  connection.labelDy = point[1] + 3 - base[1];
}

function simplifySpurs(points) {
  const stack = [];
  for (const point of points) {
    if (stack.length && point[0] === stack.at(-1)[0] && point[1] === stack.at(-1)[1]) continue;
    // A→B→C on one axis reduces to A→C even when C lies between A and B.
    // Repeat so nested reversals disappear in the same pointer frame.
    while (stack.length > 1) {
      const a = stack.at(-2), b = stack.at(-1);
      if (!((a[0] === b[0] && b[0] === point[0]) || (a[1] === b[1] && b[1] === point[1]))) break;
      stack.pop();
    }
    if (!stack.length || stack.at(-1)[0] !== point[0] || stack.at(-1)[1] !== point[1]) stack.push(point);
  }
  return normalizeRoutePoints(stack);
}

// Collapse an interior segment by joining its two corners. Move the adjoining
// leg onto the retained corner's axis, then reconnect fixed endpoint ports.
// Removing a detour's middle segment also removes the resulting out-and-back spur.
export function removeJog(points, index, ports) {
  if (index < 1 || index >= points.length - 2) return clonePoints(points);
  const axis = points[index][0] === points[index + 1][0] ? 1 : 0;
  const candidates = [true, false].map(keepFirst => {
    const moved = clonePoints(points);
    if (keepFirst) {
      moved[index + 1][axis] = moved[index][axis];
      if (index + 2 < points.length - 1) moved[index + 2][axis] = moved[index][axis];
    } else {
      moved[index][axis] = moved[index + 1][axis];
      if (index > 1) moved[index - 1][axis] = moved[index][axis];
    }
    return simplifySpurs(attachRoute(simplifySpurs(moved), ports));
  });
  return candidates.sort((a, b) => a.length - b.length)[0];
}

export function mergeNearbyBends(points, ports, tolerance, around) {
  const candidates = [];
  for (let index = 1; index < points.length - 2; index++) {
    const a = points[index], b = points[index + 1];
    const distance = Math.hypot(a[0] - b[0], a[1] - b[1]);
    if (distance <= tolerance && Math.min(Math.hypot(a[0] - around[0], a[1] - around[1]), Math.hypot(b[0] - around[0], b[1] - around[1])) <= tolerance) {
      candidates.push({ index, distance });
    }
  }
  for (const { index } of candidates.sort((a, b) => a.distance - b.distance)) {
    const merged = removeJog(points, index, ports);
    if (merged.length < points.length) return { points: merged, merged: true };
  }
  return { points, merged: false };
}

export function moveNode(spec, id, x, y, geometry) {
  const node = spec.components.find(candidate => candidate.id === id);
  node.pos = [Math.max(0, Math.round(x)), Math.max(0, Math.round(y))];
  delete node.row; delete node.col;
  const movedGeometry = { ...geometry, components: geometry.components.map(box => box.id === id
    ? { ...box, x: node.pos[0], y: node.pos[1] } : box) };
  for (const boundary of spec.boundaries || []) {
    if (boundary.rect) boundary.wraps = fixedBoundaryMembers(boundary.rect, movedGeometry.components);
  }
  spec.connections.forEach((connection, index) => {
    if (!connection.via || (connection.from !== id && connection.to !== id)) return;
    const points = normalizeRoutePoints(clonePoints(geometry.connections[index].points));
    const oldPorts = routePorts(spec, index, geometry);
    // Freeze auto side choices for a manually shaped route before recomputing.
    connection.fromSide = oldPorts.fromSide;
    connection.toSide = oldPorts.toSide;
    const ports = routePorts(spec, index, movedGeometry);
    if (points.length > 2) {
      if (connection.from === id) {
        const axis = horizontal(ports.fromSide) ? 1 : 0;
        points[1][axis] = ports.start[axis];
      }
      if (connection.to === id) {
        const axis = horizontal(ports.toSide) ? 1 : 0;
        points[points.length - 2][axis] = ports.end[axis];
      }
    }
    const attached = attachRoute(points, ports);
    followSnappedLabel(connection, geometry.connections[index].points, attached);
    connection.via = attached.slice(1, -1);
  });
}
