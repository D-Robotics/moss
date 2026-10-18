#!/usr/bin/env node
/**
 * O156 (P2 safety): a claude-format hook run through Windows PowerShell 5.1
 * (`powershell -Command <missing>`) exits 1 with
 * `X : The term 'X' is not recognized as the name of a cmdlet, function,
 * script \r\nfile, or operable program.` — space before the colon, "operable",
 * wrapped at console width. Moss did not see that as "failed to start", so
 * UserPromptSubmit / Stop / PermissionRequest let it through (exit 1 is the
 * non-blocking claude verdict). Measured on windows-latest, run 39100883578.
 *
 * Detection must not depend on English: PS 5.1's error record ends with a
 * CategoryInfo line made of enum/type names that are never translated, and
 * pwsh 7's zh-Hans text is covered as measured.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { windowsMissingCommand } from '../dist/utils/windows-missing-command.js';
import {
  classifyShellToolFailure,
  parseMissingCommandName,
} from '../dist/core/tools/tool-loop-guard.js';
import { createConfiguredHookCallbacks } from '../dist/cli/hooks.js';
import { execTool } from '../dist/tools/builtin.js';
import { clearUiLanguage } from '../dist/cli/cli-locale.js';
import { installUiLanguage } from '../dist/utils/ui-language.js';
import { scenario } from './o121-safety-block-outcome.spec.mjs';

const IS_WIN = process.platform === 'win32';
const X = 'moss-o156-missing-cmd';
const ESC = '\u001b';

// ---- stderr fixtures --------------------------------------------------------
// Verbatim from windows-latest run 39100883578 (job 117596735596).
const PS51_EN =
  `${X} : The term '${X}' is not recognized as the name of a cmdlet, function, script \r\n` +
  'file, or operable program. Check the spelling of the name, or if a path was included, verify that the path is correct \r\n' +
  'and try again.\r\nAt line:1 char:1\r\n' +
  `+ ${X}\r\n+ ${'~'.repeat(X.length)}\r\n` +
  `    + CategoryInfo          : ObjectNotFound: (${X}:String) [], CommandNotFoundException\r\n` +
  '    + FullyQualifiedErrorId : CommandNotFoundException\r\n \r\n';
const PWSH7_EN =
  `${ESC}[31;1m${X}: ${ESC}[31;1mThe term '${X}' is not recognized as a name of a cmdlet, function, script file, or executable program.${ESC}[0m\r\n` +
  `${ESC}[31;1m${ESC}[31;1mCheck the spelling of the name, or if a path was included, verify that the path is correct and try again.${ESC}[0m\r\n`;
// pwsh 7 with CurrentUICulture=zh-CN (zh-Hans resources ship with pwsh), same run.
const PWSH7_ZH =
  `${ESC}[31;1m${X}: ${ESC}[31;1m术语 '${X}' 不会被识别为 cmdlet、函数、脚本文件或可执行程序的名称。${ESC}[0m\r\n` +
  `${ESC}[31;1m${ESC}[31;1m请检查名称的拼写或验证路径是否正确(如果包含路径)，然后重试。${ESC}[0m\r\n`;
// Windows PowerShell 5.1 on a zh-CN system. Not measurable on windows-latest
// (no zh-CN language pack for 5.1; the run fell back to English), so this is
// the known 5.1 resource text in the measured 5.1 layout.
const PS51_ZH =
  `${X} : 无法将“${X}”项识别为 cmdlet、函数、脚本文件或可运行程序的名称。请检查名称的拼写，如果包括路径，请确保路径正\r\n` +
  '确，然后再试一次。\r\n所在位置 行:1 字符: 1\r\n' +
  `+ ${X}\r\n+ ${'~'.repeat(X.length)}\r\n` +
  `    + CategoryInfo          : ObjectNotFound: (${X}:String) [], CommandNotFoundException\r\n` +
  '    + FullyQualifiedErrorId : CommandNotFoundException\r\n \r\n';
// Any other UI language (German 5.1 text here): only the invariant
// CategoryInfo line identifies it. Also stands in for a zh message that was
// decoded with the wrong code page (mojibake) — the ASCII line survives.
const PS51_DE =
  `${X} : Die Benennung "${X}" wurde nicht als Name eines Cmdlet, einer Funktion, einer Skriptdatei oder eines ausführbaren\r\n` +
  'Programms erkannt.\r\nIn Zeile:1 Zeichen:1\r\n' +
  `+ ${X}\r\n+ ${'~'.repeat(X.length)}\r\n` +
  `    + CategoryInfo          : ObjectNotFound: (${X}:String) [], CommandNotFoundException\r\n` +
  '    + FullyQualifiedErrorId : CommandNotFoundException\r\n \r\n';
const PS51_MOJIBAKE = [...PS51_ZH].map((c) => (c.charCodeAt(0) > 0x7f ? '\ufffd' : c)).join('');

test('detector: Windows PowerShell 5.1 English text (measured) names the command', () => {
  assert.equal(windowsMissingCommand(PS51_EN), X);
});
test('detector: pwsh 7 zh-Hans text (measured) names the command', () => {
  assert.equal(windowsMissingCommand(PWSH7_ZH), X);
});
test('detector: Windows PowerShell 5.1 zh-CN text names the command', () => {
  assert.equal(windowsMissingCommand(PS51_ZH), X);
});
test('detector: 5.1 in any other UI language or mis-decoded is caught by the invariant CategoryInfo line', () => {
  assert.equal(windowsMissingCommand(PS51_DE), X);
  assert.equal(windowsMissingCommand(PS51_MOJIBAKE), X);
});
test('detector: pwsh 7 English and cmd.exe stay recognized (O135 controls)', () => {
  assert.equal(windowsMissingCommand(PWSH7_EN), X);
  assert.equal(
    windowsMissingCommand(
      `'${X}' is not recognized as an internal or external command,\r\noperable program or batch file.\r\n`
    ),
    X
  );
});
test('detector counterexamples: other ObjectNotFound errors and later records do not count', () => {
  // Get-Item on a missing path: ObjectNotFound, but ItemNotFoundException.
  assert.equal(
    windowsMissingCommand(
      "Get-Item : Cannot find path 'C:\\nope' because it does not exist.\r\nAt line:1 char:1\r\n+ Get-Item C:\\nope\r\n" +
        '    + CategoryInfo          : ObjectNotFound: (C:\\nope:String) [Get-Item], ItemNotFoundException\r\n' +
        '    + FullyQualifiedErrorId : PathNotFound,Microsoft.PowerShell.Commands.GetItemCommand\r\n \r\n'
    ),
    undefined
  );
  // The hook started and wrote its own stderr first; a later missing command is not "failed to start".
  assert.equal(windowsMissingCommand(`policy check failed\r\n\r\n${PS51_DE}`), undefined);
  // CategoryInfo for a different name than the record's head.
  assert.equal(
    windowsMissingCommand(PS51_DE.replace(`(${X}:String)`, '(other:String)')),
    undefined
  );
});
test('parseMissingCommandName names the command for 5.1 and zh output', () => {
  for (const s of [PS51_EN, PS51_ZH, PWSH7_ZH, PS51_DE]) {
    assert.equal(parseMissingCommandName(`Command failed (exit 1)\n${s}`), X);
  }
});

// ---- process level (windows-latest has Windows PowerShell 5.1 and pwsh 7) ----
function useLang(language) {
  clearUiLanguage();
  installUiLanguage({ language, source: 'flag', setting: 'auto' });
}
async function quiet(fn) {
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = () => true;
  try {
    return await fn();
  } finally {
    process.stderr.write = orig;
  }
}
const ZH_UI = "[Threading.Thread]::CurrentThread.CurrentUICulture='zh-CN';";
const SHELLS = {
  'PS 5.1': `powershell -NoProfile -NonInteractive -Command ${X}`,
  'pwsh 7': `pwsh -NoProfile -NonInteractive -Command ${X}`,
  'pwsh 7 zh-CN UI': `pwsh -NoProfile -NonInteractive -Command "${ZH_UI} ${X}"`,
};
const START_FAILED = /failed to start; treated as deny/;

for (const [label, command] of Object.entries(SHELLS)) {
  test(
    `win32 ${label}: claude UserPromptSubmit / Stop / PermissionRequest / PreToolUse with a missing command fail closed as "failed to start"`,
    { skip: !IS_WIN && 'platform mismatch (not win32)' },
    async () => {
      useLang('en');
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-o156-'));
      const hook = { command, format: 'claude' };
      const cbs = createConfiguredHookCallbacks(
        { UserPromptSubmit: [hook], Stop: [hook], PermissionRequest: [hook], PreToolUse: [hook] },
        { workspaceDir: dir }
      );
      await quiet(async () => {
        const ups = await cbs.runUserPromptSubmit('hi');
        assert.equal(ups.blocked, true, `UserPromptSubmit must block: ${ups.reason}`);
        assert.match(ups.reason, START_FAILED);
        const stop = await cbs.runStop({ stopReason: 'end_turn' });
        assert.equal(stop.blocked, true, `Stop must block: ${stop.reason}`);
        assert.match(stop.reason, START_FAILED);
        const perm = await cbs.runPermissionRequest({ toolName: 'write_file', input: {} });
        assert.equal(perm.denied, true, `PermissionRequest must deny: ${perm.reason}`);
        assert.match(perm.reason, START_FAILED);
        const pre = await cbs.onBeforeToolExec({
          tool: { name: 'write_file', metadata: { sideEffectClass: 'local_write' } },
          input: {},
          sessionKey: 'o156',
          runId: 'o156',
          toolCallId: 't1',
          abortSignal: new AbortController().signal,
        });
        assert.equal(pre.approved, false, `PreToolUse must deny: ${pre.reason}`);
        assert.match(pre.reason, START_FAILED);
      });
    }
  );
}

test(
  'win32 exec: `powershell -Command <missing>` is a start_failure that names the command',
  { skip: !IS_WIN && 'platform mismatch (not win32)' },
  async (t) => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-o156-exec-'));
    t.after(() => fs.rmSync(workspaceDir, { recursive: true, force: true }));
    const text = await execTool.execute(
      { command: `powershell -NoProfile -NonInteractive -Command ${X}` },
      { workspaceDir, sessionKey: 'o156' }
    );
    assert.equal(classifyShellToolFailure(text), 'start_failure', text.slice(0, 400));
    assert.equal(parseMissingCommandName(text), X, text.slice(0, 400));
  }
);

const WIN_BASE_ENV = Object.fromEntries(
  [
    'SystemDrive',
    'windir',
    'ComSpec',
    'PATHEXT',
    'TEMP',
    'TMP',
    'APPDATA',
    'LOCALAPPDATA',
    'ProgramFiles',
    'ProgramData',
  ]
    .map((k) => [k, process.env[k]])
    .filter(([, v]) => v !== undefined)
);

// CLI: PreToolUse through PS 5.1 → exit 9, last line 「被拦」, the write never lands,
// and the terminal says the hook failed to start (not an ordinary exit 1).
for (const lang of ['en', 'zh']) {
  test(
    `win32 CLI [${lang}]: PreToolUse via powershell -Command <missing> → exit 9, 被拦, file unchanged, "failed to start"`,
    { skip: !IS_WIN && 'platform mismatch (not win32)' },
    async () => {
      const NOTES = 'original notes\n';
      const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
      const r = await scenario({
        lang,
        // Windows PowerShell 5.1 starts slowly in the scenario's bare env (no
        // LOCALAPPDATA → no module analysis cache): give it the usual Windows
        // vars and room to start, so the verdict is about the missing command,
        // not a 30 s timeout (seen on windows-latest, run 39101586306).
        extraEnv: WIN_BASE_ENV,
        hooks: {
          PreToolUse: [{ command: SHELLS['PS 5.1'], format: 'claude', timeoutMs: 120_000 }],
        },
        steps: [
          {
            name: 'exec',
            args: { command: `node -e "require('fs').writeFileSync('notes.txt','PWNED')"` },
          },
        ],
        finalText: lang === 'zh' ? '全部完成，已经做好了。' : 'All done, everything is finished.',
        notesBody: NOTES,
      });
      const ctx = `code=${r.code} last=${r.last}\n${r.err.slice(-800)}`;
      assert.equal(r.code, 9, ctx);
      assert.equal(sha(r.notes), sha(NOTES), `notes.txt must be unchanged; ${ctx}`);
      assert.match(r.last, lang === 'zh' ? /被拦/ : /Blocked by/, ctx);
      assert.match(
        r.err.replace(/\s+/g, ' '),
        lang === 'zh' ? /未能启动，已按拒绝处理/ : /failed to start; treated as deny/,
        ctx
      );
    }
  );
}

// QA #149 F3: the O156 fail-open path itself through the CLI. A claude
// UserPromptSubmit hook via PS 5.1 exits 1 (non-blocking claude verdict): on
// old code the model was called and ran the exec step. Now the prompt is
// refused before the model, the terminal says "failed to start", and the
// file stays unchanged. (PermissionRequest only fires through the interactive
// asker, so `-p` cannot reach it; it is covered at hook level above.)
for (const lang of ['en', 'zh']) {
  test(
    `win32 CLI [${lang}]: UserPromptSubmit via powershell -Command <missing> → refused before the model, "failed to start", file unchanged`,
    { skip: !IS_WIN && 'platform mismatch (not win32)' },
    async () => {
      const NOTES = 'original notes\n';
      const r = await scenario({
        lang,
        extraEnv: WIN_BASE_ENV,
        hooks: {
          UserPromptSubmit: [{ command: SHELLS['PS 5.1'], format: 'claude', timeoutMs: 120_000 }],
        },
        steps: [
          {
            name: 'exec',
            args: { command: `node -e "require('fs').writeFileSync('notes.txt','PWNED')"` },
          },
        ],
        finalText: 'All done.',
        notesBody: NOTES,
      });
      const ctx = `code=${r.code} last=${r.last}\n${r.err.slice(0, 1200)}`;
      assert.notEqual(r.code, 0, ctx);
      assert.equal(r.notes, NOTES, `notes.txt must be unchanged; ${ctx}`);
      assert.deepEqual(r.toolResults, [], `the model must not get to run a tool; ${ctx}`);
      assert.match(
        r.err.replace(/\s+/g, ' '),
        lang === 'zh'
          ? /提交用户提示前钩子 .*未能启动，已按拒绝处理/
          : /UserPromptSubmit hook .*failed to start; treated as deny/,
        ctx
      );
    }
  );
}
