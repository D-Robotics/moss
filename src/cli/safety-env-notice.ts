/**
 * Deliver safety-env ignore notices once per process.
 * `-p` and the REPL print them on stderr. The fullscreen TUI hides anything
 * written before the alternate screen, so that path goes to the transcript.
 */
import { takeDotenvSafetyEnvNotices } from '../safety/dotenv-safety-env.js';
import { isZhLocale } from './cli-locale.js';

export function deliverDotenvSafetyEnvNotices(
  useTui: boolean,
  emitTui: (line: string) => void
): void {
  for (const line of takeDotenvSafetyEnvNotices(isZhLocale())) {
    if (useTui) emitTui(line);
    else console.error(line);
  }
}
