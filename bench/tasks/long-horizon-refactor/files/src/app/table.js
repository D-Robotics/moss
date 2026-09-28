import { truncateEnd, padCenter } from '../util/string-helpers-a.js';

export function renderRow(cells, widths) {
  return cells.map((c, i) => padCenter(truncateEnd(String(c), widths[i]), widths[i])).join(' | ');
}
