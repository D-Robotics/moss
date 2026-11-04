/**
 * Color-level detection and the shared color helpers.
 *
 * This lives in its own module so both `bootstrap.ts` (the full CLI path) and
 * the `--version` fast path in `cli.ts` paint exactly the same output: the fast
 * path must not pull in the bootstrap graph just to learn whether to emit ANSI
 * codes. Rules are unchanged from the original inline detection.
 */
import pc from 'picocolors';

export interface ColorHelpers {
  bold: (s: string) => string;
  dim: (s: string) => string;
  red: (s: string) => string;
  green: (s: string) => string;
  yellow: (s: string) => string;
  blue: (s: string) => string;
  cyan: (s: string) => string;
  magenta: (s: string) => string;
  gray: (s: string) => string;
}

/** `--no-color`, NO_COLOR, MOSS_NO_COLOR=1, or no TTY on either stream. */
export function isColorEnabled(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (argv.includes('--no-color')) return false;
  if (env.NO_COLOR || env.MOSS_NO_COLOR === '1') return false;
  if (!process.stderr.isTTY && !process.stdout.isTTY) return false;
  return true;
}

export function createColors(enabled: boolean): ColorHelpers {
  const wrap =
    (fn: (s: string) => string) =>
    (s: string): string =>
      enabled ? fn(s) : s;
  return {
    bold: wrap(pc.bold),
    dim: wrap(pc.dim),
    red: wrap(pc.red),
    green: wrap(pc.green),
    yellow: wrap(pc.yellow),
    blue: wrap(pc.blue),
    cyan: wrap(pc.cyan),
    magenta: wrap(pc.magenta),
    gray: wrap(pc.gray),
  };
}
