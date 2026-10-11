#!/usr/bin/env node
/**
 * O76 (QA e2e): in an untrusted workspace, the repo's own git hooks must not run
 * when Moss runs git (e.g. `git commit`). Guards core.hooksPath injection on
 * every platform, including win32 where exec bits do not exist.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isolatedCliEnv } from './helpers/isolated-cli-env.mjs';

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'cli.js');

function put(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function cliEnv() {
  const env = isolatedCliEnv({ prefix: 'moss-untrusted-perm-' });
  env.MOSS_NO_TUI = '1';
  env.MOSS_NO_COLOR = '1';
  env.MOSS_NO_BUNDLED_DEFAULT = '1';
  env.LANG = 'C';
  env.LC_ALL = 'C';
  delete env.MOSS_LANG;
  delete env.MOSS_TRUST_WORKSPACE;
  delete env.MOSS_AUTO_APPROVE;
  delete env.MOSS_CLI_AUTO_APPROVE;
  delete env.MOSS_SAFETY_MODE;
  delete env.MOSS_CLI_SAFETY_MODE;
  delete env.MOSS_APPROVAL_POLICY;
  delete env.MOSS_ASK_FOR_APPROVAL;
  delete env.MOSS_TRUSTED_TOOLS;
  delete env.MOSS_DENIED_TOOLS;
  return env;
}

function userConfig(baseUrl, permissions) {
  return {
    provider: 'openai-compatible',
    model: 'stub-model',
    baseUrl,
    apiKey: 'test-key',
    permissions,
  };
}

function runCli(cwd, env, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`timed out\n${stderr}\n${stdout}`));
    }, 45000);
    child.stdout.on('data', (buf) => {
      stdout += buf.toString();
    });
    child.stderr.on('data', (buf) => {
      stderr += buf.toString();
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

let pendingCommand = 'true';
const live = await new Promise((resolve) => {
  const hits = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      hits.push({ url: req.url ?? '', body });
      let toolFollowUp = false;
      try {
        const messages = JSON.parse(body).messages ?? [];
        toolFollowUp = messages.some((message) => message.role === 'tool');
      } catch {
        // Not a chat body. The first response is still the exec tool call.
      }
      const payload = toolFollowUp
        ? {
            choices: [
              { message: { role: 'assistant', content: 'stopped' }, finish_reason: 'stop' },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          }
        : {
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [
                    {
                      id: 'call_pwn',
                      type: 'function',
                      function: {
                        name: 'exec',
                        arguments: JSON.stringify({ command: pendingCommand }),
                      },
                    },
                  ],
                },
                finish_reason: 'tool_calls',
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    });
  });
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    resolve({
      port: address.port,
      hits,
      close: () => new Promise((done) => server.close(() => done())),
    });
  });
});

const liveBase = `http://127.0.0.1:${live.port}/v1`;

// QA O76: an untrusted repo's own git hook must not run when Moss runs git commit.
{
  const env = cliEnv();
  const ws = path.join(env.HOME, 'ws');
  fs.mkdirSync(ws, { recursive: true });
  const git = (...a) => execFileSync('git', a, { cwd: ws, stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 'qa@example.test');
  git('config', 'user.name', 'qa');
  const marker = path.join(env.HOME, 'GIT_HOOK_RAN');
  const hook = path.join(ws, '.git', 'hooks', 'pre-commit');
  fs.writeFileSync(hook, `#!/bin/sh\necho x > "${marker.replace(/\\/g, '/')}"\n`);
  fs.chmodSync(hook, 0o755);
  // Sanity: the hook really fires when git runs it directly.
  git('commit', '-q', '--allow-empty', '-m', 'direct');
  assert.equal(fs.existsSync(marker), true, 'sanity: hook did not run under plain git');
  fs.rmSync(marker);
  pendingCommand = 'git commit --allow-empty -m via-moss';
  put(path.join(env.MOSS_CONFIG_DIR, 'config.json'), userConfig(liveBase, { defaultMode: 'full' }));
  const printed = await runCli(ws, env, ['-p', 'commit', '-C', ws]);
  const log = execFileSync('git', ['log', '--oneline'], { cwd: ws }).toString();
  assert.match(log, /via-moss/, `moss did not commit\n${printed.stderr}`);
  assert.equal(
    fs.existsSync(marker),
    false,
    `untrusted repo pre-commit ran via moss\n${printed.stderr}`
  );
}
await live.close();
console.log('[PASS] qa-repro-o76-git-hooks');
