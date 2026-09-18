// Fixed editor frames describe the components fully enclosed by their authored
// rectangle. Use the same rule for drawing, node moves, and CLI validation.
export function fixedBoundaryMembers([x, y, width, height], components) {
  const epsilon = 1e-9;
  return [...components].filter(node => node.x >= x - epsilon && node.y >= y - epsilon
    && node.x + node.width <= x + width + epsilon
    && node.y + node.height <= y + height + epsilon).map(node => node.id);
}
