import { stripVTControlCharacters } from 'node:util';

/** cmd.exe, English and Simplified Chinese UI (`'X' 不是内部或外部命令…`). */
const CMD_NOT_RECOGNIZED =
  /^\s*'([^'\r\n]+)' (?:is not recognized as an internal or external command\b|不是内部或外部命令)/i;

/**
 * PowerShell CommandNotFoundException message, English UI.
 * - pwsh 7 (ConciseView): `X: The term 'X' is not recognized as a name of a
 *   cmdlet, function, script file, or executable program.`
 * - Windows PowerShell 5.1 (NormalView): `X : The term 'X' is not recognized
 *   as the name of a cmdlet, function, script \r\nfile, or operable program.`
 *   (O156: space before the colon, "operable", and wrapped at console width.)
 *
 * Must accept everything main's pattern accepted (QA #149 R2-F1): no space
 * after the colon (`:\s*`) and no article (`(?:(?:a|the)\s+)?name`) are
 * still a missing command, so this is a strict superset of
 * `/^\s*(\S+):\s*The term '\1' is not recognized as (?:a |the )?name of a
 * cmdlet, function, script file, or executable program\b/i`.
 */
const PS_NOT_RECOGNIZED_EN =
  /^\s*(\S+) ?:\s*The\s+term\s+'\1'\s+is\s+not\s+recognized\s+as\s+(?:(?:a|the)\s+)?name\s+of\s+a\s+cmdlet,\s*function,\s*script\s+file,\s*or\s+(?:executable|operable)\s+program\b/i;

/**
 * Same message, Simplified Chinese UI.
 * - pwsh 7 zh-Hans (measured on windows-latest, O156): `X: 术语 'X' 不会被识别为
 *   cmdlet、函数、脚本文件或可执行程序的名称。`
 * - Windows PowerShell 5.1 zh-CN: `X : 无法将“X”项识别为 cmdlet、函数、脚本文件或
 *   可运行程序的名称。`
 */
const PS_NOT_RECOGNIZED_ZH =
  /^\s*(\S+) ?:\s*(?:术语\s*['‘’“”"]\1['‘’“”"]\s*不会被识别为|无法将\s*['‘’“”"]\1['‘’“”"]\s*项识别为)\s*cmdlet\s*、\s*函数\s*、\s*脚\s*本\s*文\s*件\s*或\s*可\s*(?:执\s*行|运\s*行)\s*程\s*序\s*的\s*名\s*称/;

/**
 * Locale-independent: Windows PowerShell 5.1's NormalView error record always
 * ends with a CategoryInfo line built from enum and type names, which are
 * never translated: `+ CategoryInfo : ObjectNotFound: (X:String) [],
 * CommandNotFoundException`. Accept it only for the first error record, whose
 * first line must start with `X :` / `X:`, so a hook that ran for a while and
 * then hit an unrelated missing command later in its output does not count.
 */
const PS_FIRST_RECORD_HEAD = /^\s*(\S+) ?:\s/;
/**
 * Static pattern (QA #149 F1): the name comes from the CategoryInfo line and
 * is compared with the head as a string. A RegExp built from stderr text has
 * no size bound (a >= 32759-character first token made V8 throw "Regular
 * expression too large").
 */
const PS_CATEGORY_INFO =
  /^\s*\+\s*CategoryInfo\s*:\s*ObjectNotFound\s*:\s*\((\S+?):String\)\s*\[\]\s*,\s*CommandNotFoundException\b/m;
/** The first error record is read up to this many characters. */
const PS_RECORD_LIMIT = 4000;
/** Longer "names" are not a command PowerShell reported (Windows MAX_PATH-ish bound with room). */
const PS_NAME_LIMIT = 1024;
function powershellCategoryInfo(text: string): string | undefined {
  const head = text.slice(0, PS_RECORD_LIMIT);
  const name = PS_FIRST_RECORD_HEAD.exec(head)?.[1];
  if (name === undefined || name.length > PS_NAME_LIMIT) return undefined;
  // The first record ends at the first blank line.
  const record = head.split(/\r?\n[ \t]*\r?\n/, 1)[0]!;
  return PS_CATEGORY_INFO.exec(record)?.[1] === name ? name : undefined;
}

/**
 * Name of the command a Windows shell could not find, from the shell's own
 * diagnostic at the start of stderr; undefined when stderr is something else.
 * Native shell diagnostics only; callers must use stderr, not child stdout.
 */
export function windowsMissingCommand(stderr: string): string | undefined {
  const text = stripVTControlCharacters(stderr);
  return (
    CMD_NOT_RECOGNIZED.exec(text)?.[1] ??
    PS_NOT_RECOGNIZED_EN.exec(text)?.[1] ??
    PS_NOT_RECOGNIZED_ZH.exec(text)?.[1] ??
    powershellCategoryInfo(text)
  );
}
