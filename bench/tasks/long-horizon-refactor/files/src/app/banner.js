import { clip, centerPad } from '../util/string-helpers-b.js';

export function renderBanner(title, width) {
  return centerPad(clip(title, width), width);
}
