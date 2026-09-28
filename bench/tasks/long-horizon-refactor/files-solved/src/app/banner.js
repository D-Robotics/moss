import { truncateEnd, padCenter } from '../util/string-ops.js';

export function renderBanner(title, width) {
  return padCenter(truncateEnd(title, width), width);
}
