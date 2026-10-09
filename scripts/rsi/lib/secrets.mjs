const SENSITIVE_KEY_RE =
  /^(?:api[-_]?key|authorization|password|passphrase|secret|access[-_]?token|refresh[-_]?token|private[-_]?key)$/i;
const SENSITIVE_ENV_RE =
  /(?:API_KEY|PASSWORD|PASSPHRASE|SECRET|ACCESS_TOKEN|REFRESH_TOKEN|PRIVATE_KEY)$/i;

export function knownSecretValues(env = process.env) {
  return [
    ...new Set(
      Object.entries(env)
        .filter(([name, value]) => SENSITIVE_ENV_RE.test(name) && typeof value === 'string')
        .map(([, value]) => value)
        .filter((value) => value.length >= 4)
    ),
  ];
}

export function redactKnownSecrets(text, env = process.env) {
  let redacted = String(text ?? '');
  for (const value of knownSecretValues(env)) redacted = redacted.split(value).join('[redacted]');
  return redacted;
}

export function sensitiveDataPaths(value, env = process.env) {
  const hits = [];
  const secrets = knownSecretValues(env);
  const visit = (item, at) => {
    if (typeof item === 'string') {
      if (secrets.some((secret) => item.includes(secret))) hits.push(at);
      return;
    }
    if (!item || typeof item !== 'object') return;
    if (Array.isArray(item)) {
      item.forEach((child, index) => visit(child, `${at}[${index}]`));
      return;
    }
    for (const [key, child] of Object.entries(item)) {
      const next = at ? `${at}.${key}` : key;
      if (SENSITIVE_KEY_RE.test(key) && child != null && child !== '') hits.push(next);
      visit(child, next);
    }
  };
  visit(value, '');
  return [...new Set(hits)].sort();
}
