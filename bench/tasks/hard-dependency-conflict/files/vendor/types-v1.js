// Shared type vocabulary, v1 API (frozen upstream module).
export const KIND = { USER: 'user_v1', GROUP: 'group_v1' };
export function describe(kind) {
  return kind === KIND.USER ? 'a user record' : 'a group record';
}
