















import fs from 'node:fs/promises';
import path from 'node:path';
import { runProcess, ProcessError } from '../utils/run-process.js';
import { safeChildEnv } from '../utils/safe-child-env.js';
import { isCommandDangerous } from '../safety/channel-safety.js';
import { assertSandboxPath } from '../safety/sandbox-paths.js';
import type { Tool, ToolContext } from '../core/tools/tool-types.js';
import { errorMessage } from '../errors.js';

const IS_WIN = process.platform === 'win32';
const DEFAULT_TIMEOUT_MS = 120_000;
const OUTPUT_MAX = 16_000;

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function localBin(dir: string, name: string): Promise<string | null> {
  const bin = path.join(dir, 'node_modules', '.bin', IS_WIN ? `${name}.cmd` : name);
  return (await fileExists(bin)) ? bin : null;
}

const ESLINT_CONFIGS = [
  '.eslintrc.json',
  '.eslintrc.js',
  '.eslintrc.cjs',
  '.eslintrc.yml',
  '.eslintrc.yaml',
  'eslint.config.js',
  'eslint.config.mjs',
  'eslint.config.cjs',
];

async function hasEslintConfig(dir: string): Promise<boolean> {
  for (const f of ESLINT_CONFIGS) {
    if (await fileExists(path.join(dir, f))) return true;
  }
  return false;
}

async function detectCommand(
  dir: string
): Promise<{ command: string; why: string; alternatives?: string[] } | null> {
  const attempted: string[] = [];

  try {
    const pkg = JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8')) as {
      scripts?: Record<string, unknown>;
    };
    attempted.push('package.json scripts');
    const scripts = pkg?.scripts ?? {};
    for (const name of ['typecheck', 'type-check', 'tsc', 'lint', 'check']) {
      if (typeof scripts[name] === 'string') {
        return {
          command: `npm run ${name} --silent`,
          why: `package.json script "${name}"`,
          alternatives: attempted,
        };
      }
    }
  } catch {
    // continue
  }

  attempted.push('local tsc (tsconfig.json)');
  if (await fileExists(path.join(dir, 'tsconfig.json'))) {
    const bin = await localBin(dir, 'tsc');
    if (bin) {
      return {
        command: `"${bin}" --noEmit --pretty false`,
        why: 'tsconfig.json + local tsc',
        alternatives: attempted,
      };
    }
  }

  attempted.push('local eslint (.eslintrc)');
  if (await hasEslintConfig(dir)) {
    const bin = await localBin(dir, 'eslint');
    if (bin) {
      return {
        command: `"${bin}" .`,
        why: 'eslint config + local eslint',
        alternatives: attempted,
      };
    }
  }
  return null;
}

function truncate(s: string, max = OUTPUT_MAX): string {
  return s.length > max ? `${s.slice(0, max)}\n\n[... truncated ${s.length - max} chars]` : s;
}

export const codeDiagnosticsTool: Tool = {
  name: 'code_diagnostics',
  description:
    'Run the project type/lint checks and report errors and warnings — use this after editing code. ' +
    'Auto-detects JS/TS checks (package.json typecheck/lint script, local tsc, or local eslint). ' +
    'For other toolchains pass `command` (e.g. "ruff check .", "mypy .", "cargo check", "go vet ./...").',
  metadata: {
    sideEffectClass: 'readonly',
    planMode: 'allow',
    timeoutMs: DEFAULT_TIMEOUT_MS,
    permissionBoundary:
      'Executes a diagnostic command in the workspace cwd. Hosts may gate it via AgentHooks.onBeforeToolExec.',
  },
  inputSchema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'Explicit diagnostic command to run (overrides auto-detection)',
      },
      path: {
        type: 'string',
        description: 'Subdirectory to run in, relative to workspace root (default: workspace root)',
      },
      timeout_ms: {
        type: 'number',
        description: `Timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS})`,
      },
    },
  },
  async execute(input, ctx: ToolContext) {
    const timeoutMs = Math.max(1000, Number(input.timeout_ms) || DEFAULT_TIMEOUT_MS);

    let cwd = ctx.workspaceDir;
    if (input.path) {
      try {
        const { resolved } = await assertSandboxPath({
          filePath: String(input.path),
          cwd: ctx.workspaceDir,
          root: ctx.workspaceDir,
        });
        cwd = resolved;
        
        
        
        
        const stat = await fs.stat(cwd).catch(() => null);
        if (stat?.isFile()) cwd = path.dirname(cwd);
      } catch (err) {
        return `Error: ${errorMessage(err)}`;
      }
    }

    let command = typeof input.command === 'string' ? input.command.trim() : '';
    let why = 'explicit command';
    if (!command) {
      const detected = await detectCommand(cwd);
      if (!detected) {
        const altList = ['package.json typecheck/lint/check scripts', 'local tsc', 'local eslint'];
        return (
          'No diagnostic command detected. Checked:\n' +
          altList.map((a) => `  - ${a}`).join('\n') +
          '\n\nPass `command` to run a specific checker, e.g.:\n' +
          '  "ruff check ." (Python)\n' +
          '  "mypy ." (Python types)\n' +
          '  "cargo check" (Rust)\n' +
          '  "go vet ./..." (Go)'
        );
      }
      command = detected.command;
      why = detected.why;
    }

    const danger = isCommandDangerous(command);
    if (danger.blocked) return `Command blocked: ${danger.reason}`;

    const shell = IS_WIN ? process.env.COMSPEC || 'cmd.exe' : '/bin/sh';
    const args = IS_WIN ? ['/c', command] : ['-c', command];
    const header = `Command: ${command}\nVia: ${why}`;

    try {
      const result = await runProcess(shell, {
        args,
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024,
        signal: ctx.abortSignal,
        env: safeChildEnv({ LANG: process.env.LANG || 'en_US.UTF-8' }),
        cwd,
      });
      const combined = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n').trim();
      if (!combined) {
        return `${header}\n\nResult: PASS\nExit: 0\nDiagnostics: none`;
      }
      return `${header}\n\nResult: PASS (with output)\nExit: 0\nOutput:\n${truncate(combined)}`;
    } catch (err) {
      if (err instanceof ProcessError) {
        let result = `${header}\n\nResult: FAIL\nExit: ${err.exitCode}`;

        if (err.timedOut) {
          result += `\n\nTimeout: Command exceeded ${timeoutMs}ms — increase timeout_ms or optimize the check`;
        }

        const stdout = err.stdout.trim();
        const stderr = err.stderr.trim();
        if (stderr) {
          result += `\n\nStderr:\n${truncate(stderr)}`;
        }
        if (stdout) {
          result += `\n\nStdout:\n${truncate(stdout)}`;
        }
        if (!stdout && !stderr && err.message) {
          result += `\n\nError: ${err.message}`;
        }

        result +=
          '\n\nNext step: fix the reported diagnostics (or narrow `command`/`cwd`), then re-run `code_diagnostics` / `verify_fix`. ' +
          'Do not report done while diagnostics are FAIL.\n';
        return result;
      }
      throw err;
    }
  },
};
