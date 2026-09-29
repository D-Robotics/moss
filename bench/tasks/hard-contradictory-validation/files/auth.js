// Authentication for the admin panel.
export function checkToken(token) {
  return typeof token === 'string' && token.length >= 8;
}
