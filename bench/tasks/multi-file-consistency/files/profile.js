import { getUserDisplayName } from './user.js';

export function profileLine(user) {
  return `Name: ${getUserDisplayName(user)}`;
}
