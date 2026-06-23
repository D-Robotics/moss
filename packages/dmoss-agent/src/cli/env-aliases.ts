/**
 * Env-var name migration shim.
 *
 * The public environment-variable prefix is now `MOSS_*`. The legacy `DMOSS_*`
 * names still work for back-compat (existing scripts, CI, and on-board cron
 * agents), so nothing breaks during the rename.
 *
 * This runs at process entry (cli.ts) BEFORE any module reads `process.env`, and
 * bridges both directions IN PLACE — so the ~250 existing `process.env.DMOSS_*`
 * reads keep working unchanged while users set the new `MOSS_*` names:
 *   - `MOSS_X` set  → also set `DMOSS_X` (existing reads see the new name)
 *   - `DMOSS_X` set → also set `MOSS_X` (forward-compat) and report it as legacy
 * When both are present, `MOSS_X` wins.
 *
 * @internal
 */
export function normalizeMossEnvAliases(env: NodeJS.ProcessEnv = process.env): string[] {
  const legacyUsed: string[] = [];
  // New name wins: mirror every MOSS_X onto its DMOSS_X twin first.
  for (const key of Object.keys(env)) {
    if (key.startsWith('MOSS_') && env[key] !== undefined) {
      env[`D${key}`] = env[key]; // MOSS_X → DMOSS_X
    }
  }
  // Back-compat: a legacy DMOSS_X with no MOSS_X twin populates the new name and
  // is reported so the caller can nudge the user to migrate.
  for (const key of Object.keys(env)) {
    if (key.startsWith('DMOSS_') && env[key] !== undefined) {
      const modern = key.slice(1); // DMOSS_X → MOSS_X
      if (env[modern] === undefined) {
        env[modern] = env[key];
        legacyUsed.push(key);
      }
    }
  }
  return legacyUsed;
}

/**
 * Apply the alias bridge at startup. Mutates `process.env`; safe to call once.
 *
 * The bridge is intentionally SILENT — it must not print to stdout/stderr (that
 * would pollute piped output and every script/CI run that still sets `DMOSS_*`).
 * The migration path is disclosed in `--help` (Environment: "the legacy DMOSS_
 * names still work for now"); `DMOSS_*` keeps working indefinitely for now.
 *
 * @internal
 */
export function applyMossEnvAliases(env: NodeJS.ProcessEnv = process.env): void {
  normalizeMossEnvAliases(env);
}
