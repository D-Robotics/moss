import { stripVTControlCharacters } from 'node:util';

/** Native shell diagnostics only; callers must use stderr, not child stdout. */
export function windowsMissingCommand(stderr: string): string | undefined {
  const text = stripVTControlCharacters(stderr);
  return (
    /^\s*'([^'\r\n]+)' is not recognized as an internal or external command\b/i.exec(text)?.[1] ??
    /^\s*(\S+):\s*The term '\1' is not recognized as (?:a |the )?name of a cmdlet, function, script file, or executable program\b/i.exec(
      text
    )?.[1]
  );
}
