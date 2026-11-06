/**
 * `/context` tool-surface reporting (backlog B15).
 *
 * The tool declarations are paid on every turn, and the lean/full description
 * tier changes that cost, so `/context` must show the number and the tier it
 * will actually use. This stage drives the readline REPL in a PTY (the line is
 * rendered by the real command, not by a copy of the logic) twice: a large
 * context window (full descriptions) and a 32k window (lean, because
 * `shouldLeanToolDescriptions` switches at 64k).
 *
 * Set `MOSS_VERIFY_CLI_ENTRY` to run the assertions against another build (used
 * to prove the probe fails on the previous revision).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { captureProcess } from '../lib/proc.mjs';

const TOOL_LINE = /tools\s+~([\d,]+) tokens \((\d+) declared, (lean|full) descriptions\)/;

async function run(command, args, options = {}) {
  const result = await captureProcess(command, args, {
    cwd: options.cwd ?? process.cwd(),
    env: options.env ?? process.env,
    timeoutMs: options.timeoutMs ?? 120_000,
  });
  if (result.timedOut) {
    throw new Error(`$ ${command} ${args.join(' ')} timed out`);
  }
  if (result.status !== 0) {
    throw new Error(
      [
        `$ ${command} ${args.join(' ')}`,
        `status: ${String(result.status)}; signal: ${result.signal ?? 'none'}`,
        result.stdout,
        result.stderr,
      ]
        .filter(Boolean)
        .join('\n')
    );
  }
  return result;
}

function configFor(contextTokens) {
  const config = {
    provider: 'openai-compatible',
    model: 'fake-model',
    baseUrl: 'http://127.0.0.1:9/v1',
    apiKey: 'sk-test',
    permissions: { defaultMode: 'full' },
  };
  if (contextTokens !== undefined) config.agent = { contextTokens };
  return config;
}

async function driveRepl(nodeBin, cliEntry, tempRoot, configDir, workspace) {
  const code = String.raw`
import fcntl, os, pty, select, struct, subprocess, sys, tempfile, termios, time

node_bin, cli_path, temp_root, config_dir, workspace = sys.argv[1:6]
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 120, 0, 0))
home = tempfile.mkdtemp(prefix='home-', dir=temp_root)
env = {
  'PATH': os.environ.get('PATH', ''),
  'HOME': home,
  'TERM': 'xterm-256color',
  'LANG': 'C.UTF-8',
  'MOSS_NO_COLOR': '1',
  'MOSS_NO_TUI': '1',
  'MOSS_NO_RDK_DOCS': '1',
  'MOSS_TRUST_WORKSPACE': '1',
  'MOSS_CONFIG_DIR': config_dir,
}
proc = subprocess.Popen(
  [node_bin, cli_path],
  stdin=slave, stdout=slave, stderr=slave, env=env, cwd=workspace,
)
os.close(slave)


def read_until(needle, timeout):
  data = b''
  deadline = time.time() + timeout
  while time.time() < deadline:
    r, _, _ = select.select([master], [], [], 0.2)
    if r:
      try:
        chunk = os.read(master, 8192)
      except OSError:
        break
      if not chunk:
        break
      data += chunk
      if needle in data:
        return data
  return data


# The REPL prints its banner before accepting commands; wait for output rather
# than a fixed string (ANSI wrapping can split it), then ask for /context.
read_until(b'Moss', 10)
time.sleep(0.4)
os.write(master, b'/context\r')
data = read_until(b'tools', 10)
os.write(master, b'/exit\r')
read_until(b'exit', 3)
proc.kill()
proc.wait(timeout=3)
os.close(master)
print(data.decode('utf-8', 'replace'))
`;
  const result = await run(
    'python3',
    ['-c', code, nodeBin, cliEntry, tempRoot, configDir, workspace],
    {
      timeoutMs: 180_000,
    }
  );
  return result.stdout;
}

function parseToolLine(output) {
  const match = TOOL_LINE.exec(output.replace(/\r/g, ''));
  if (!match) {
    throw new Error(
      `the REPL output has no "/context" tool-surface line matching ${TOOL_LINE}\n--- output ---\n${output.slice(-3000)}`
    );
  }
  return { tokens: Number(match[1].replace(/,/g, '')), declared: Number(match[2]), tier: match[3] };
}

async function pythonWithPty() {
  if (process.platform === 'win32') return null;
  const probe = await captureProcess('python3', ['--version'], {});
  return probe.status === 0 ? 'python3' : null;
}

export const stage = {
  name: 'context-surface',
  requires: ['build'],
  description: 'REPL /context reports the tool-surface cost and the description tier actually used',
  async run(context) {
    const cliEntry = process.env.MOSS_VERIFY_CLI_ENTRY ?? path.join(context.root, 'dist', 'cli.js');
    if (!fs.existsSync(cliEntry)) {
      return { ok: false, detail: `${cliEntry} is missing; run the build stage first` };
    }
    const hasPython = (await pythonWithPty()) !== null;
    if (!hasPython) {
      console.log('[context-surface] skipping: python3/pty is unavailable');
      return { ok: true };
    }
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-context-surface-'));
    try {
      const runOnce = async (contextTokens) => {
        const configDir = path.join(tempRoot, `config-${contextTokens ?? 'default'}`);
        const workspace = path.join(tempRoot, `workspace-${contextTokens ?? 'default'}`);
        fs.mkdirSync(configDir, { recursive: true });
        fs.mkdirSync(workspace, { recursive: true });
        fs.writeFileSync(
          path.join(configDir, 'config.json'),
          JSON.stringify(configFor(contextTokens))
        );
        const output = await driveRepl(process.execPath, cliEntry, tempRoot, configDir, workspace);
        return { output, parsed: parseToolLine(output) };
      };

      console.log('[context-surface] checking a large window reports the full tier');
      const full = await runOnce(undefined);
      if (!/window\s+unprobed/.test(full.output)) {
        throw new Error(
          `a config without agent.contextTokens must label the window unprobed; output:\n${full.output.slice(-1500)}`
        );
      }
      if (full.parsed.tier !== 'full') {
        throw new Error(
          `a large context window reported the ${full.parsed.tier} tier, expected full`
        );
      }

      console.log('[context-surface] checking a 32k window reports the lean tier');
      const lean = await runOnce(32_000);
      if (lean.parsed.tier !== 'lean') {
        throw new Error(
          `a 32k context window reported the ${lean.parsed.tier} tier, expected lean`
        );
      }
      if (lean.parsed.declared !== full.parsed.declared) {
        throw new Error(
          `the two tiers declared ${lean.parsed.declared} vs ${full.parsed.declared} tools; the tier must not change the tool set`
        );
      }
      if (!(lean.parsed.tokens < full.parsed.tokens)) {
        throw new Error(
          `the lean tier reported ${lean.parsed.tokens} tokens, not fewer than the full tier's ${full.parsed.tokens}`
        );
      }
      console.log(
        `[context-surface] full: ${full.parsed.declared} tools / ${full.parsed.tokens} tokens; lean: ${lean.parsed.declared} tools / ${lean.parsed.tokens} tokens`
      );
      return { ok: true };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  },
};
