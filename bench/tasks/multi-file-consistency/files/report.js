import { getUserDisplayName } from './user.js';

export function reportHeader(user) {
  return `[${getUserDisplayName(user)}]`;
}
