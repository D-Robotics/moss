export function readEnv(name: string): string | undefined {
  const env =
    typeof process !== 'undefined' && typeof process.env === 'object' ? process.env : undefined;
  const value = env?.[name]?.trim();
  return value === undefined || value === '' ? undefined : value;
}

export function readEnvFlag(name: string): boolean {
  const value = readEnv(name);
  return value === '1' || value === 'true';
}

export function parseEnvPositiveInt(name: string, fallback: number): number {
  const raw = readEnv(name);
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function parseEnvBoundedInt(
  name: string,
  fallback: number,
  min: number,
  max: number
): number {
  const raw = readEnv(name);
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

export function parseEnvBoundedFloat(
  name: string,
  fallback: number,
  min: number,
  max: number
): number {
  const raw = readEnv(name);
  if (!raw) return fallback;
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

export function envPreferMoss(mossKey: string, legacyKey: string): string | undefined {
  const v = readEnv(mossKey);
  if (v !== undefined && v !== '') return v;
  const legacy = readEnv(legacyKey);
  if (legacy !== undefined && legacy !== '') return legacy;
  return undefined;
}

export function parseEnvNumberPreferMoss(mossKey: string, legacyKey: string): number | undefined {
  const raw = envPreferMoss(mossKey, legacyKey);
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

export function envTruthyUnlessZeroPreferMoss(mossKey: string, legacyKey: string): boolean {
  const dm = readEnv(mossKey);
  const leg = readEnv(legacyKey);
  if (dm !== undefined) return dm !== '0';
  if (leg !== undefined) return leg !== '0';
  return true;
}
