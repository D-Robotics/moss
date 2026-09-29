// Builds a flat listing from the nested catalog tree.
export function flatten(tree) {
  let lines = [];
  for (const node of tree) {
    lines = lines.concat([node.name]);
    if (node.children) {
      lines = lines.concat(flatten(node.children).map((l) => `  ${l}`));
    }
  }
  return lines;
}

export function summary(lines) {
  let report = '';
  for (const line of lines) {
    report = report + line + '\n';
  }
  return report;
}
