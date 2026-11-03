/**
 * Remove explicit negative action clauses before applying positive intent
 * heuristics. Stop at sentence separators and adversatives so a separate
 * affirmative request is still visible to the caller.
 */
const NEGATED_ACTION_CLAUSE =
  /(?:(?:不要|请勿|不得|无需|不需要|不必|禁止|不能|不可|不允许|别)\s*(?:再|直接|去|进行)?\s*(?:修复|修好|修一下|修掉|改好|修改|更改|改动|编辑|改成|改为|改掉|新增|添加|增加|补上|补一|重构|删掉|删除|安装|装依赖|(?:运行|执行)\s*(?:npm|pnpm|yarn|bun)\s+(?:install|ci|add|i))|\b(?:do\s+not|don't|never|avoid|without)\s+(?:modify|modifying|edit|editing|change|changing|update|updating|alter|altering|create|creating|add|adding|write|writing|delete|deleting|remove|removing|fix|fixing|refactor|refactoring|touch|touching|install|installing|run\s+(?:npm|pnpm|yarn|bun)\s+(?:install|ci|add|i))\b)(?:(?![，,。.!！？?；;\n]|但是|而是|但|\b(?:but|instead)\b).)*/gi;

export function stripNegatedActionClauses(text: string): string {
  return text.replace(NEGATED_ACTION_CLAUSE, ' ');
}
