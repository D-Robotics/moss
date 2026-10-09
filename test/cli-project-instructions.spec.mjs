#!/usr/bin/env node
/**
 * Project instructions (AGENTS.md) loading — the layer that makes the CLI's
 * "auto-loaded from workspace root" claim true.
 *
 * Locks: present file → its content rides in the layer; absent file → empty
 * layer (no invented content); oversized file → byte-capped with an explicit
 * truncation notice; the banner names the file that was loaded.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  AGENTS_MD_MAX_BYTES,
  buildAgentsMdLayer,
  findAgentsMdPath,
} from '../dist/cli/project-instructions.js';

function tempWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'moss-agents-md-'));
}

{
  const dir = tempWorkspace();
  assert.equal(buildAgentsMdLayer(dir), '', 'no AGENTS.md → empty layer');
  assert.equal(findAgentsMdPath(dir), undefined, 'no AGENTS.md → no path');
}

{
  const dir = tempWorkspace();
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# Project\n\nnpm run verify\n', 'utf8');
  assert.equal(path.basename(findAgentsMdPath(dir)), 'AGENTS.md');
  const layer = buildAgentsMdLayer(dir);
  assert.match(layer, /^\[Project instructions — AGENTS\.md\]/, 'the layer names its source');
  assert.ok(layer.includes('npm run verify'), 'the project content rides in the layer');
}

{
  const dir = tempWorkspace();
  fs.writeFileSync(path.join(dir, 'agents.md'), 'lowercase spelling\n', 'utf8');
  const layer = buildAgentsMdLayer(dir);
  assert.ok(layer.includes('lowercase spelling'), 'the lowercase spelling is accepted too');
}

{
  const dir = tempWorkspace();
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), '   \n\t\n', 'utf8');
  assert.equal(buildAgentsMdLayer(dir), '', 'a whitespace-only file loads nothing');
}

{
  const dir = tempWorkspace();
  // Oversized: CJK content so the byte cap and the char count clearly differ.
  const big = '构建说明\n'.repeat(20_000);
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), big, 'utf8');
  const layer = buildAgentsMdLayer(dir);
  assert.match(layer, /truncated, ~\d+KB dropped/, 'oversized file says it was truncated');
  assert.ok(
    Buffer.byteLength(layer, 'utf8') <= AGENTS_MD_MAX_BYTES + 512,
    'the layer itself stays near the byte cap'
  );
  assert.ok(!layer.endsWith('\ufffd'), 'the cut never ships a broken code unit');
}

console.log('[PASS] project-instructions (AGENTS.md layer)');

{
  // The reply follows the latest user message. Locale only picks the fallback
  // when that message has no language of its own.
  const { buildAnswerLanguageLayer, formatInteractionModeNotice, formatFullModeNotice } =
    await import('../dist/cli/cli-locale.js');
  const zh = buildAnswerLanguageLayer('zh_CN.UTF-8');
  assert.match(zh, /\[Answer language\]/, 'zh locale gets the layer');
  assert.match(zh, /简体中文/, 'the zh layer pins Simplified Chinese');
  assert.match(zh, /代码.*保持原样/, 'code and identifiers stay untranslated');
  const en = buildAnswerLanguageLayer('en_US.UTF-8');
  assert.equal(en, '', 'non-zh locales add no answer-language layer');
  const { buildLanguagePolicyPrompt, buildLanguagePolicyPromptQuick } =
    await import('../dist/contracts/prompts/language-policy-prompt.js');
  const policy = buildLanguagePolicyPrompt();
  assert.match(policy, /latest user message/, 'the policy follows the latest user message');
  assert.match(policy, /otherwise English/, 'no signal is otherwise English');
  assert.match(policy, /\[Answer language\]/, 'a present answer-language section still overrides');
  assert.doesNotMatch(policy, /respond in \*\*English\*\*/);
  const quick = buildLanguagePolicyPromptQuick();
  assert.match(quick, /otherwise English/);
  assert.match(quick, /\[Answer language\]/);
  assert.match(formatInteractionModeNotice('full', 'zh_CN.UTF-8'), /交互模式/);
  assert.match(formatInteractionModeNotice('full', 'en_US.UTF-8'), /Interaction mode/);
  assert.match(formatFullModeNotice('zh_CN.UTF-8'), /拒绝规则/);
  assert.match(formatFullModeNotice('en_US.UTF-8'), /deny rules/);
}
