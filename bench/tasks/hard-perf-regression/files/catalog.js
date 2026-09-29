// Builds a flat listing from the nested catalog tree.
export function flatten(tree) {
  let lines = [];
  for (const node of tree) {
    lines = lines.concat([node.name]);
    if (node.children) {
      lines = lines.concat(flatten(node.children));
    }
  }
  return lines;
}
