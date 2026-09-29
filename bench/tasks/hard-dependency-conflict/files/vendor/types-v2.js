// Shared type vocabulary, v2 API (frozen upstream module).
export const KIND = { USER: 'user', GROUP: 'group' };
export function describe(kind) {
  return `kind=${kind}`;
}
