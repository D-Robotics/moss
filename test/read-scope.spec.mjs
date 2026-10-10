#!/usr/bin/env node
/**
 * Workspace-default reads, field-level config redaction, raw key withhold,
 * and the device-env report (names only). Shell commands are not scope-blocked.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  applyPatchTool,
  editFileTool,
  execTool,
  multiEditTool,
  readFileTool,
  searchCodeTool,
  writeFileTool,
} from '../dist/tools/builtin.js';
import { ToolHookRegistry } from '../dist/core/tools/tool-hooks.js';
import { presentToolOutput, redactToolOutput } from '../dist/safety/tool-output-redact.js';
import {
  commandInspectsProcessEnv,
  deviceEnvFootnote,
  formatDeviceEnvReport,
  safeChildEnv,
} from '../dist/utils/safe-child-env.js';

const saved = {
  HOME: process.env.HOME,
  MOSS_EXTRA_READ_ROOTS: process.env.MOSS_EXTRA_READ_ROOTS,
  MOSS_DEVICE_HOST: process.env.MOSS_DEVICE_HOST,
  MOSS_DEVICE_PORT: process.env.MOSS_DEVICE_PORT,
  MOSS_DEVICE_USER: process.env.MOSS_DEVICE_USER,
  MOSS_DEVICE_PASSWORD: process.env.MOSS_DEVICE_PASSWORD,
  MOSS_DEVICE_KEY: process.env.MOSS_DEVICE_KEY,
  MOSS_DEVICE_KEY_PASSPHRASE: process.env.MOSS_DEVICE_KEY_PASSPHRASE,
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-read-scope-'));
const home = path.join(root, 'home');
const project = path.join(root, 'project');
const sibling = path.join(root, 'sibling');
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(project, { recursive: true });
fs.mkdirSync(sibling, { recursive: true });
process.env.HOME = home;

const PROJECT_MARKER = 'PROJECT_MARKER_read_scope';
const SIBLING_MARKER = 'SIBLING_MARKER_read_scope';
const HOME_MARKER = 'HOME_MARKER_read_scope';
const KEY_VALUE = 'sk-abcdefghijklmnopqrstuvwxyz123456';
const ENC_VALUE = `enc:${'A'.repeat(24)}/${'B'.repeat(8)}`;
const SOURCE = 'const token = req.headers.authorization;\nconst wrapped = ${process.env.TOKEN};\n';

fs.writeFileSync(path.join(project, 'note.txt'), `hello ${PROJECT_MARKER}\n`);
fs.writeFileSync(path.join(sibling, 'secret.txt'), `hidden ${SIBLING_MARKER}\n`);
fs.writeFileSync(path.join(home, 'transcript.txt'), `other agent ${HOME_MARKER}\n`);
fs.mkdirSync(path.join(home, '.moss'), { recursive: true });
fs.mkdirSync(path.join(home, '.config', 'moss'), { recursive: true });
fs.mkdirSync(path.join(home, '.ssh'), { recursive: true });
const mossConfig = JSON.stringify({ apiKey: ENC_VALUE, provider: 'openai-compatible' });
fs.writeFileSync(path.join(home, '.moss', 'config.json'), mossConfig);
fs.writeFileSync(path.join(home, '.config', 'moss', 'config.json'), mossConfig);
fs.writeFileSync(path.join(home, '.ssh', 'config'), 'Host *\n');
fs.writeFileSync(path.join(home, '.ssh', 'id_rsa'), 'PRIVATE KEY MATERIAL\n');
fs.mkdirSync(path.join(project, '.moss'), { recursive: true });
fs.writeFileSync(path.join(project, '.moss', 'tasks.jsonl'), '{"task":"ok"}\n');
fs.writeFileSync(path.join(project, '.moss', 'config.json'), mossConfig);
fs.writeFileSync(path.join(project, 'local-key.txt'), `apiKey=${KEY_VALUE}\nplain text stays\n`);
fs.writeFileSync(path.join(project, 'auth.ts'), SOURCE);

function ctx(extra = {}) {
  return {
    workspaceDir: project,
    sessionKey: 'read-scope',
    abortSignal: new AbortController().signal,
    ...extra,
  };
}

async function modelView(tool, input, context, raw) {
  const registry = new ToolHookRegistry();
  registry.registerPost({
    name: 'secret-sanitizer',
    priority: 10,
    async process({ tool: hooked, input: hookedInput, result, ctx: hookedCtx }) {
      const sanitized = presentToolOutput({
        toolName: hooked.name,
        input: hookedInput,
        text: result,
        workspaceDir: hookedCtx.workspaceDir,
      });
      return sanitized !== result ? { result: sanitized } : null;
    },
  });
  return registry.runPostHooks({
    tool,
    input,
    result: String(raw),
    isError: false,
    durationMs: 0,
    ctx: context,
    sessionId: 'read-scope',
  });
}

function restoreEnv() {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

try {
  // ── search from the project does not escape ──────────────────────────────
  const inProject = await searchCodeTool.execute({ pattern: PROJECT_MARKER }, ctx());
  assert.match(inProject, new RegExp(PROJECT_MARKER), 'search finds the project file');
  assert.doesNotMatch(inProject, new RegExp(SIBLING_MARKER));
  assert.doesNotMatch(inProject, new RegExp(HOME_MARKER));

  const escaped = await searchCodeTool.execute({ pattern: SIBLING_MARKER, path: '..' }, ctx());
  assert.match(String(escaped), new RegExp(SIBLING_MARKER), 'an explicit parent path is searched');
  assert.doesNotMatch(String(escaped), /Command blocked:/);

  const homeSearch = await searchCodeTool.execute({ pattern: HOME_MARKER, path: '~' }, ctx());
  assert.match(String(homeSearch), new RegExp(HOME_MARKER), 'an explicit home path is searched');

  const grepHome = await execTool.execute({ command: `grep -R ${HOME_MARKER} ~` }, ctx());
  assert.doesNotMatch(String(grepHome), /Command blocked:/);
  assert.match(String(grepHome), new RegExp(HOME_MARKER), 'shell grep of home runs');

  const grepProject = await execTool.execute({ command: `grep -R ${PROJECT_MARKER} .` }, ctx());
  assert.match(String(grepProject), new RegExp(PROJECT_MARKER), 'in-workspace grep still runs');
  assert.doesNotMatch(String(grepProject), /Command blocked:/);

  for (const command of ['cat /proc/cpuinfo', 'ls /dev/video*', 'ls /opt/tros']) {
    const out = await execTool.execute({ command }, ctx());
    assert.doesNotMatch(
      String(out),
      /Command blocked:/,
      `board command is not scope-blocked: ${command}`
    );
  }
  assert.match(
    String(await execTool.execute({ command: 'cat /proc/cpuinfo' }, ctx())),
    /processor|cpu/i
  );

  // ── Moss credential values are withheld; the read itself is allowed ──────
  const encPattern = new RegExp(ENC_VALUE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  for (const target of ['~/.moss/config.json', '~/.config/moss/config.json', '.moss/config.json']) {
    const read = await readFileTool.execute({ path: target }, ctx());
    assert.doesNotMatch(String(read), /denied|Command blocked/i, `read is allowed: ${target}`);
    assert.match(String(read), /openai-compatible/, `the read itself returns the file: ${target}`);
    const viewed = await modelView(readFileTool, { path: target }, ctx(), read);
    assert.match(viewed, /openai-compatible/, `non-secret config stays visible: ${target}`);
    assert.match(viewed, /\[REDACTED\]/, `secret field is masked: ${target}`);
    assert.doesNotMatch(viewed, encPattern, `ciphertext absent from model view: ${target}`);
    assert.doesNotMatch(
      viewed,
      /Moss credential values withheld/,
      `config is not fully withheld: ${target}`
    );
  }
  const tasks = await readFileTool.execute({ path: '.moss/tasks.jsonl' }, ctx());
  assert.match(String(tasks), /"task":"ok"/, 'project task log stays readable');
  const tasksView = await modelView(readFileTool, { path: '.moss/tasks.jsonl' }, ctx(), tasks);
  assert.match(tasksView, /"task":"ok"/, 'project task log is shown to the model');
  assert.doesNotMatch(tasksView, /Moss credential values withheld/);

  fs.writeFileSync(path.join(home, '.moss', '.apikey-key'), 'raw-key-material-not-a-pattern\n');
  const keyFile = await readFileTool.execute(
    { path: path.join(home, '.moss', '.apikey-key') },
    ctx()
  );
  const keyView = await modelView(
    readFileTool,
    { path: path.join(home, '.moss', '.apikey-key') },
    ctx(),
    keyFile
  );
  assert.doesNotMatch(keyView, /raw-key-material-not-a-pattern/);
  assert.match(keyView, /Moss credential values withheld/);

  const catConfig = await execTool.execute({ command: 'cat ~/.moss/config.json' }, ctx());
  assert.doesNotMatch(String(catConfig), /Command blocked:/, 'cat of moss config runs');
  const catView = await modelView(
    execTool,
    { command: 'cat ~/.moss/config.json' },
    ctx(),
    catConfig
  );
  assert.doesNotMatch(catView, encPattern);
  assert.match(catView, /openai-compatible/);
  assert.match(catView, /\[REDACTED\]/);
  assert.doesNotMatch(catView, /Moss credential values withheld/);

  const catKeyFile = await execTool.execute({ command: 'cat ~/.moss/.apikey-key' }, ctx());
  assert.doesNotMatch(String(catKeyFile), /Command blocked:/);
  const catKeyView = await modelView(
    execTool,
    { command: 'cat ~/.moss/.apikey-key' },
    ctx(),
    catKeyFile
  );
  assert.doesNotMatch(catKeyView, /raw-key-material-not-a-pattern/);
  assert.match(catKeyView, /Moss credential values withheld/);

  const mixed = presentToolOutput({
    toolName: 'search_code',
    input: { query: 'apiKey' },
    text: [
      `${path.join(home, '.moss', 'config.json')}:1: ${mossConfig}`,
      `${path.join(project, 'note.txt')}:1: hello ${PROJECT_MARKER}`,
    ].join('\n'),
    workspaceDir: project,
    env: process.env,
  });
  assert.match(mixed, new RegExp(PROJECT_MARKER));
  assert.match(mixed, /openai-compatible/);
  assert.match(mixed, /\[REDACTED\]/);
  assert.doesNotMatch(mixed, encPattern);
  assert.doesNotMatch(mixed, /Moss credential values withheld/);

  const debugConfig = JSON.stringify({
    baseUrl: 'https://api.example.test/v1',
    model: 'deepseek-chat',
    apiKeyEnv: 'MOSS_API_KEY',
    apiKey: 'k9f2mQ7xP4wL8nB3',
    hooks: { post: 'echo ok' },
    mcp: { rdkDocs: true },
  });
  fs.writeFileSync(path.join(home, '.moss', 'config.json'), `${debugConfig}\n`);
  const debugRead = await readFileTool.execute({ path: '~/.moss/config.json' }, ctx());
  const debugView = await modelView(
    readFileTool,
    { path: '~/.moss/config.json' },
    ctx(),
    debugRead
  );
  assert.match(debugView, /https:\/\/api\.example\.test\/v1/);
  assert.match(debugView, /deepseek-chat/);
  assert.match(debugView, /MOSS_API_KEY/);
  assert.match(debugView, /echo ok/);
  assert.match(debugView, /rdkDocs/);
  assert.match(debugView, /\[REDACTED\]/);
  assert.doesNotMatch(debugView, /k9f2mQ7xP4wL8nB3/);
  const debugCat = await execTool.execute({ command: 'cat ~/.moss/config.json' }, ctx());
  const debugCatView = await modelView(
    execTool,
    { command: 'cat ~/.moss/config.json' },
    ctx(),
    debugCat
  );
  assert.match(debugCatView, /https:\/\/api\.example\.test\/v1/);
  assert.match(debugCatView, /deepseek-chat/);
  assert.match(debugCatView, /MOSS_API_KEY/);
  assert.doesNotMatch(debugCatView, /k9f2mQ7xP4wL8nB3/);
  assert.match(debugCatView, /\[REDACTED\]/);

  const envHome = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-apikeyenv-home-'));
  const envWs = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-apikeyenv-ws-'));
  const savedHomeForEnv = process.env.HOME;
  const savedProfileForEnv = process.env.USERPROFILE;
  const savedGateway = process.env.MY_USER_CFG;
  const savedCwd = process.cwd();
  process.env.HOME = envHome;
  process.env.USERPROFILE = envHome;
  process.env.MY_USER_CFG = 'gateway-secret-value-99';
  process.chdir(envWs);
  try {
    const envFiles = [
      { file: path.join(envHome, '.moss', 'config.json'), name: 'MY_USER_MOSS' },
      { file: path.join(envHome, '.config', 'moss', 'config.json'), name: 'MY_USER_CFG' },
      { file: path.join(envWs, '.moss', 'config.json'), name: 'MY_PROJECT' },
    ];
    for (const row of envFiles) {
      fs.mkdirSync(path.dirname(row.file), { recursive: true });
      fs.writeFileSync(
        row.file,
        `${JSON.stringify({
          baseUrl: 'https://api.example.test/v1',
          apiKeyEnv: row.name,
          apiKey: 'k9f2mQ7xP4wL8nB3',
        })}\n`
      );
    }
    for (const row of envFiles) {
      const read = await readFileTool.execute({ path: row.file }, ctx({ workspaceDir: envWs }));
      const viewed = await modelView(
        readFileTool,
        { path: row.file },
        ctx({ workspaceDir: envWs }),
        read
      );
      assert.match(viewed, new RegExp(row.name), `apiKeyEnv stays visible: ${row.file}`);
      assert.match(viewed, /api\.example\.test/, row.file);
      assert.doesNotMatch(viewed, /k9f2mQ7xP4wL8nB3/, row.file);
      assert.doesNotMatch(viewed, /gateway-secret-value-99/, row.file);
    }
  } finally {
    process.chdir(savedCwd);
    if (savedHomeForEnv === undefined) delete process.env.HOME;
    else process.env.HOME = savedHomeForEnv;
    if (savedProfileForEnv === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedProfileForEnv;
    if (savedGateway === undefined) delete process.env.MY_USER_CFG;
    else process.env.MY_USER_CFG = savedGateway;
  }

  // ── key-like tool output is redacted; source expressions are not ─────────
  const sample = `apiKey=${KEY_VALUE}\npassword: "hunter22hunter"\nenc blob ${ENC_VALUE}\nplain text stays`;
  const redacted = redactToolOutput(sample);
  assert.doesNotMatch(redacted, new RegExp(KEY_VALUE));
  assert.doesNotMatch(redacted, /hunter22hunter/);
  assert.doesNotMatch(redacted, new RegExp(ENC_VALUE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(redacted, /\[REDACTED\]/);
  assert.match(redacted, /plain text stays/);
  assert.equal(redactToolOutput('apiKey: string'), 'apiKey: string');
  assert.equal(
    redactToolOutput('const token = req.headers.authorization;'),
    'const token = req.headers.authorization;'
  );
  assert.equal(
    redactToolOutput('const wrapped = ${process.env.TOKEN};'),
    'const wrapped = ${process.env.TOKEN};'
  );

  const echoedRaw = await execTool.execute(
    { command: `printf '%s\\n' 'apiKey=${KEY_VALUE}'` },
    ctx()
  );
  const echoed = await modelView(execTool, { command: 'printf' }, ctx(), echoedRaw);
  assert.doesNotMatch(echoed, new RegExp(KEY_VALUE));
  assert.match(echoed, /\[REDACTED\]/);

  const fromFileRaw = await readFileTool.execute({ path: 'local-key.txt' }, ctx());
  const fromFile = await modelView(readFileTool, { path: 'local-key.txt' }, ctx(), fromFileRaw);
  assert.doesNotMatch(fromFile, new RegExp(KEY_VALUE));
  assert.match(fromFile, /plain text stays/);
  assert.match(fromFile, /\[REDACTED\]/);

  const sourceRead = await readFileTool.execute({ path: 'auth.ts' }, ctx());
  assert.match(String(sourceRead), /req\.headers\.authorization/);
  assert.doesNotMatch(String(sourceRead), /\[REDACTED\]/);
  const sourceView = await modelView(readFileTool, { path: 'auth.ts' }, ctx(), sourceRead);
  assert.match(sourceView, /req\.headers\.authorization/);
  assert.match(sourceView, /\$\{process\.env\.TOKEN\}/);
  const rewritten = await writeFileTool.execute({ path: 'auth.ts', content: SOURCE }, ctx());
  assert.match(String(rewritten), /Successfully wrote/);
  assert.equal(fs.readFileSync(path.join(project, 'auth.ts'), 'utf8'), SOURCE);

  const poisoned = await writeFileTool.execute(
    { path: 'auth.ts', content: `${SOURCE}[REDACTED]\n` },
    ctx()
  );
  assert.match(String(poisoned), /refusing to write \[REDACTED\]/);
  assert.equal(fs.readFileSync(path.join(project, 'auth.ts'), 'utf8'), SOURCE);

  const fresh = await writeFileTool.execute(
    { path: 'fresh.ts', content: 'token = [REDACTED]\n' },
    ctx()
  );
  assert.match(String(fresh), /refusing to write \[REDACTED\]/);
  assert.equal(fs.existsSync(path.join(project, 'fresh.ts')), false);

  const edited = await editFileTool.execute(
    {
      path: 'auth.ts',
      old_string: 'const token = req.headers.authorization;',
      new_string: 'const token = [REDACTED];',
    },
    ctx()
  );
  assert.match(String(edited), /refusing to write \[REDACTED\]/);
  assert.equal(fs.readFileSync(path.join(project, 'auth.ts'), 'utf8'), SOURCE);

  const multi = await multiEditTool.execute(
    {
      edits: [
        {
          path: 'auth.ts',
          old_string: 'const token = req.headers.authorization;',
          new_string: 'const token = [REDACTED];',
        },
      ],
    },
    ctx()
  );
  assert.match(String(multi), /refusing to write \[REDACTED\]/);
  assert.equal(fs.readFileSync(path.join(project, 'auth.ts'), 'utf8'), SOURCE);

  const patched = await applyPatchTool.execute(
    {
      patch: [
        '*** Begin Patch',
        '*** Update File: auth.ts',
        '@@',
        '-const token = req.headers.authorization;',
        '+const token = [REDACTED];',
        '*** End Patch',
      ].join('\n'),
    },
    ctx()
  );
  assert.match(String(patched), /refusing to write \[REDACTED\]/);
  assert.equal(fs.readFileSync(path.join(project, 'auth.ts'), 'utf8'), SOURCE);

  const markedBody = `const key = "${KEY_VALUE}";\nexpect(/[REDACTED]/);\n`;
  fs.writeFileSync(path.join(project, 'marked.ts'), markedBody);
  const markedRead = await readFileTool.execute({ path: 'marked.ts' }, ctx());
  const markedView = await modelView(readFileTool, { path: 'marked.ts' }, ctx(), markedRead);
  assert.doesNotMatch(markedView, new RegExp(KEY_VALUE));
  const markedWrite = await writeFileTool.execute(
    { path: 'marked.ts', content: markedView },
    ctx()
  );
  assert.match(String(markedWrite), /refusing to write \[REDACTED\]/);
  assert.equal(fs.readFileSync(path.join(project, 'marked.ts'), 'utf8'), markedBody);

  const stable = 'already [REDACTED] here\n';
  fs.writeFileSync(path.join(project, 'stable.ts'), stable);
  await readFileTool.execute({ path: 'stable.ts' }, ctx());
  const stableWrite = await writeFileTool.execute({ path: 'stable.ts', content: stable }, ctx());
  assert.match(String(stableWrite), /Successfully wrote/);
  const stablePoison = await writeFileTool.execute(
    { path: 'stable.ts', content: `${stable}extra [REDACTED]\n` },
    ctx()
  );
  assert.match(String(stablePoison), /refusing to write \[REDACTED\]/);
  assert.equal(fs.readFileSync(path.join(project, 'stable.ts'), 'utf8'), stable);

  const editMarked = 'const keep = 1;\nnote [REDACTED]\n';
  fs.writeFileSync(path.join(project, 'edit-marked.ts'), editMarked);
  await readFileTool.execute({ path: 'edit-marked.ts' }, ctx());
  const editPoison = await editFileTool.execute(
    {
      path: 'edit-marked.ts',
      old_string: 'const keep = 1;',
      new_string: 'const keep = [REDACTED];',
    },
    ctx()
  );
  assert.match(String(editPoison), /refusing to write \[REDACTED\]/);
  assert.equal(fs.readFileSync(path.join(project, 'edit-marked.ts'), 'utf8'), editMarked);
  const editOk = await editFileTool.execute(
    {
      path: 'edit-marked.ts',
      old_string: 'const keep = 1;',
      new_string: 'const keep = 2;',
    },
    ctx()
  );
  assert.match(String(editOk), /Edited /);
  assert.equal(
    fs.readFileSync(path.join(project, 'edit-marked.ts'), 'utf8'),
    'const keep = 2;\nnote [REDACTED]\n'
  );
  const patchOk = await applyPatchTool.execute(
    {
      patch: [
        '*** Begin Patch',
        '*** Update File: edit-marked.ts',
        '@@',
        '-const keep = 2;',
        '+const keep = 3;',
        '*** End Patch',
      ].join('\n'),
    },
    ctx()
  );
  assert.match(String(patchOk), /Patch applied/);
  assert.equal(
    fs.readFileSync(path.join(project, 'edit-marked.ts'), 'utf8'),
    'const keep = 3;\nnote [REDACTED]\n'
  );

  const outsideFile = path.join(sibling, 'secret.txt');
  const outsideRead = await readFileTool.execute({ path: outsideFile }, ctx());
  assert.match(String(outsideRead), new RegExp(SIBLING_MARKER), 'outside file read is allowed');

  // ── device env values stay hidden; names are reported ────────────────────
  process.env.MOSS_DEVICE_HOST = '10.9.9.9';
  process.env.MOSS_DEVICE_USER = 'root';
  process.env.MOSS_DEVICE_PASSWORD = 'device-password-should-stay-hidden';
  process.env.MOSS_DEVICE_KEY = '/tmp/should-not-leak.key';
  process.env.MOSS_DEVICE_KEY_PASSPHRASE = 'passphrase-should-stay-hidden';
  const child = safeChildEnv();
  assert.equal(child.MOSS_DEVICE_HOST, undefined);
  assert.equal(child.MOSS_DEVICE_USER, undefined);
  assert.equal(child.MOSS_DEVICE_PASSWORD, undefined);
  assert.equal(child.MOSS_DEVICE_KEY, undefined);
  assert.equal(child.MOSS_DEVICE_KEY_PASSPHRASE, undefined);
  const report = formatDeviceEnvReport();
  assert.match(report, /MOSS_DEVICE_HOST/);
  assert.match(report, /MOSS_DEVICE_USER/);
  assert.match(report, /names only/);
  assert.match(report, /MOSS_DEVICE_PASSWORD/);
  assert.doesNotMatch(report, /10\.9\.9\.9/);
  assert.doesNotMatch(report, /device-password-should-stay-hidden/);
  assert.doesNotMatch(report, /passphrase-should-stay-hidden/);

  const inspected = await execTool.execute(
    {
      command:
        'printenv MOSS_DEVICE_HOST; printenv MOSS_DEVICE_PASSWORD || true; printenv MOSS_DEVICE_KEY || true',
    },
    ctx()
  );
  assert.doesNotMatch(String(inspected), /10\.9\.9\.9/);
  assert.match(String(inspected), /MOSS_DEVICE_HOST/);
  assert.match(String(inspected), /hidden from shell subprocesses/);
  assert.doesNotMatch(String(inspected), /device-password-should-stay-hidden/);
  assert.doesNotMatch(String(inspected), /should-not-leak\.key/);

  assert.equal(commandInspectsProcessEnv('cat .env'), false);
  assert.equal(commandInspectsProcessEnv('cat .env | head'), false);
  assert.equal(commandInspectsProcessEnv('fw_printenv boot'), false);
  assert.equal(commandInspectsProcessEnv('env'), true);
  assert.equal(commandInspectsProcessEnv('printenv HOME'), true);
  assert.equal(commandInspectsProcessEnv('/usr/bin/env python3'), true);
  assert.equal(commandInspectsProcessEnv('sudo printenv'), true);
  assert.equal(deviceEnvFootnote('cat .env'), '');
  const listedEnv = await execTool.execute({ command: 'cat .env' }, ctx());
  assert.doesNotMatch(String(listedEnv), /hidden from shell subprocesses/);
  assert.doesNotMatch(String(listedEnv), /MOSS_DEVICE_HOST/);

  console.log('[PASS] workspace read scope, credential redaction, device env');
} finally {
  restoreEnv();
  fs.rmSync(root, { recursive: true, force: true });
}
