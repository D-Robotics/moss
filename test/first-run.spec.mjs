#!/usr/bin/env node
/**
 * First-run setup: env-key offers never print the value, connection failures
 * are classified, the shown-once notice is in-memory, and a pasted key is mode 0600.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cli = path.join(repoRoot, 'dist', 'cli.js');

const { detectEnvCredentials, toPublicOffer } = await import('../dist/cli/env-credentials.js');
const { probeModel, fetchGatewayModels } = await import('../dist/cli/connection-probe.js');
const {
  applyModelsResult,
  initialFirstRunView,
  lookupOfferSecret,
  normalizeGatewayUrl,
  closestModelName,
  interpretModelInput,
  reduceFirstRun,
  renderFirstRunLines,
  saveUserModelConfig,
} = await import('../dist/cli/first-run.js');
const { envBeforeDotenv, shouldShowFullDefaultNotice } = await import('../dist/cli/config.js');
const { captureEnvBeforeDotenv } = await import('../dist/utils/startup-env.js');
const { renderAuthDoctorLine } = await import('../dist/cli/doctor.js');
const { probeDoctorModelPing } = await import('../dist/cli/doctor-model-ping.js');
const { formatFullModeNotice, formatInteractionModeNotice } =
  await import('../dist/cli/cli-locale.js');

const SECRET = 'sk-firstrun-unit-secret';

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ─── env credentials: the offer names the variable and hides the value ─────

{
  const env = {
    DEEPSEEK_API_KEY: SECRET,
    OPENAI_API_KEY: 'sk-openai-other-secret',
    OPENAI_BASE_URL: 'http://127.0.0.1:9/v1/',
    ANTHROPIC_API_KEY: 'sk-ant-api03-unit',
    DASHSCOPE_API_KEY: 'dash-secret-value',
    QWEN_API_KEY: 'qwen-should-skip',
  };
  const found = detectEnvCredentials(env);
  const vars = found.map((item) => item.keyVar);
  assert.deepEqual(vars, [
    'DEEPSEEK_API_KEY',
    'ANTHROPIC_API_KEY',
    'DASHSCOPE_API_KEY',
    'OPENAI_API_KEY',
  ]);
  const openai = found.find((item) => item.id === 'openai');
  assert.equal(openai.provider, 'openai-compatible');
  assert.equal(openai.baseUrl, 'http://127.0.0.1:9');
  assert.equal(openai.needsModelList, true);
  assert.equal(openai.model, '');
  const deepseek = found.find((item) => item.id === 'deepseek');
  assert.equal(deepseek.provider, 'deepseek');
  assert.equal(deepseek.needsModelList, false);
  assert.ok(deepseek.model.length > 0);
  for (const item of found) {
    const offer = toPublicOffer(item);
    assert.equal('apiKey' in offer, false);
    assert.doesNotMatch(offer.label, /sk-|dash-secret|qwen-should/);
    assert.match(offer.label, new RegExp(item.keyVar));
  }
  const view = initialFirstRunView(env);
  const rendered = renderFirstRunLines(view, 'C').join('\n');
  assert.match(rendered, /OPENAI_API_KEY → http:\/\/127\.0\.0\.1:9/);
  assert.doesNotMatch(rendered, /OPENAI_BASE_URL \(/);
  assert.doesNotMatch(rendered, /sk-firstrun|sk-openai|dash-secret|sk-ant/);
  const accepted = reduceFirstRun(view, { type: 'enter', draft: '' }, '', 'C');
  assert.equal(accepted.offerId, 'deepseek');
  assert.equal(accepted.job.type, 'probe');
  assert.equal(lookupOfferSecret('openai', env), 'sk-openai-other-secret');
  const declined = reduceFirstRun(view, { type: 'char', char: 'n' }, '', 'C');
  assert.equal(declined.view.step, 'provider');
}

{
  const env = {
    OPENAI_API_KEY: 'sk-openai-other-secret',
    OPENAI_BASE_URL: 'http://127.0.0.1:9/v1/',
  };
  const view = initialFirstRunView(env);
  assert.equal(view.step, 'offer');
  assert.match(view.offers[0].label, /http:\/\/127\.0\.0\.1:9/);
  const entered = reduceFirstRun(view, { type: 'enter', draft: '' }, '', 'C');
  assert.equal(entered.job, undefined);
  assert.equal(entered.view.step, 'provider');
  const picked = reduceFirstRun(view, { type: 'char', char: '1' }, '', 'C');
  assert.equal(picked.job?.type, 'models');
  assert.equal(picked.job.baseUrl, 'http://127.0.0.1:9');
  assert.equal(picked.offerId, 'openai');
}

{
  const snapshot = { ...envBeforeDotenv };
  const savedBase = process.env.OPENAI_BASE_URL;
  const savedKey = process.env.OPENAI_API_KEY;
  try {
    captureEnvBeforeDotenv({ OPENAI_API_KEY: 'sk-user-shell-key' });
    process.env.OPENAI_API_KEY = 'sk-user-shell-key';
    process.env.OPENAI_BASE_URL = 'http://127.0.0.1:9/v1';
    const found = detectEnvCredentials();
    assert.equal(found.length, 1);
    assert.equal(found[0].baseUrl, 'https://api.openai.com');
    assert.match(found[0].label, /https:\/\/api\.openai\.com/);
    assert.doesNotMatch(found[0].label, /127\.0\.0\.1/);
    const view = initialFirstRunView();
    assert.equal(view.offers[0].baseUrl, 'https://api.openai.com');
  } finally {
    captureEnvBeforeDotenv(snapshot);
    if (savedBase === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = savedBase;
    if (savedKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = savedKey;
  }
}

{
  assert.equal(normalizeGatewayUrl('https://gw.example/v1/'), 'https://gw.example');
  assert.equal(
    normalizeGatewayUrl('https://user:pw@gw.example/v1/chat/completions?x=1'),
    'https://gw.example'
  );
}

{
  let view = initialFirstRunView({});
  assert.equal(view.step, 'provider');
  const picked = reduceFirstRun(view, { type: 'char', char: '6' }, '', 'C');
  assert.equal(picked.view.step, 'url');
  assert.equal(picked.view.provider, 'openai-compatible');
  const url = reduceFirstRun(
    picked.view,
    { type: 'enter', draft: 'http://127.0.0.1:9/v1' },
    '',
    'C'
  );
  assert.equal(url.view.step, 'key');
  assert.equal(url.view.baseUrl, 'http://127.0.0.1:9');
  assert.match(url.view.notice, /\/v1/);
  const empty = reduceFirstRun(url.view, { type: 'enter', draft: '' }, '', 'C');
  assert.match(empty.view.error, /API key is required/);
  const keyed = reduceFirstRun(url.view, { type: 'enter', draft: '' }, SECRET, 'C');
  assert.equal(keyed.view.step, 'working');
  assert.equal(keyed.job.type, 'models');
  const lines = renderFirstRunLines({ ...url.view, keyDots: SECRET.length }, 'C').join('\n');
  assert.match(lines, /•/);
  assert.doesNotMatch(lines, /sk-firstrun/);
}

{
  const listed = applyModelsResult(
    {
      step: 'working',
      offers: [],
      cursor: 0,
      provider: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:9',
      pending: { type: 'models', provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:9' },
    },
    { ok: true, models: ['stub-alpha', 'stub-beta'] },
    'C'
  );
  assert.equal(listed.step, 'model');
  assert.equal(listed.models[0], 'stub-alpha');
  const chosen = reduceFirstRun(listed, { type: 'enter', draft: '2' }, SECRET, 'C');
  assert.equal(chosen.view.model, 'stub-beta');
  assert.equal(chosen.saved.model, 'stub-beta');
  assert.equal(chosen.job, undefined);
  const offline = applyModelsResult(
    {
      step: 'working',
      offers: [],
      cursor: 0,
      provider: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:9',
      pending: { type: 'models', provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:9' },
    },
    {
      ok: false,
      kind: 'network',
      message: 'Could not connect. Check the base URL and your network, then press Enter to retry.',
    },
    'C'
  );
  assert.equal(offline.step, 'url');
  assert.equal(offline.pending, undefined);
  const retry = reduceFirstRun(offline, { type: 'enter', draft: '' }, SECRET, 'C');
  assert.equal(retry.job.type, 'models');
  assert.equal(retry.view.baseUrl, 'http://127.0.0.1:9');
  const fresh = initialFirstRunView({});
  assert.equal(fresh.step, 'provider');
  assert.equal(fresh.cursor, 0);
  const preselected = reduceFirstRun(fresh, { type: 'enter', draft: '' }, '', 'C');
  assert.equal(preselected.view.provider, 'd-robotics');
  assert.equal(preselected.view.step, 'key');
  const named = reduceFirstRun(
    { step: 'provider', offers: [], cursor: 0, apiKeyEnv: 'MY_GATEWAY_KEY' },
    { type: 'char', char: '1' },
    'secret-not-printed',
    'C'
  );
  assert.equal(named.view.provider, 'd-robotics');
  assert.equal(named.view.apiKeyEnv, 'MY_GATEWAY_KEY');
  assert.equal(named.view.step, 'working');
  assert.equal(named.job.type, 'probe');
  const digua = reduceFirstRun(initialFirstRunView({}), { type: 'char', char: '1' }, '', 'zh_CN');
  assert.equal(digua.view.step, 'key');
  assert.equal(digua.view.provider, 'd-robotics');
  assert.equal(digua.view.model, 'deepseek-flash');
  assert.match(digua.view.baseUrl, /ai-api\.d-robotics\.cc/);
  const kept = reduceFirstRun(
    {
      step: 'error',
      offers: [],
      cursor: 0,
      provider: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:9',
      model: 'stub-alpha',
      failStep: 'key',
      error: 'API key 被拒绝（401）。请重新粘贴 key（不会显示内容）。',
    },
    { type: 'enter', draft: '仍然保存' },
    SECRET,
    'zh_CN.UTF-8'
  );
  assert.equal(kept.saved.provider, 'openai-compatible');
  assert.equal(kept.saved.model, 'stub-alpha');
  assert.equal(kept.job, undefined);
  const back = reduceFirstRun(kept.view, { type: 'escape' }, SECRET, 'zh_CN.UTF-8');
  assert.equal(back.view.step, 'key');
  const shown = renderFirstRunLines(
    {
      step: 'error',
      offers: [],
      cursor: 0,
      failStep: 'key',
      error:
        'API key 被拒绝（401）。请重新粘贴 key（不会显示内容）。\nReceived API Key = [REDACTED], Key Hash (Token) = [REDACTED]',
    },
    'zh_CN.UTF-8'
  );
  assert.ok(shown.some((line) => line.includes('请重新粘贴')));
  assert.ok(shown.some((line) => line.includes('Received API Key')));
  assert.ok(shown.some((line) => line.includes('Esc 返回修改 key')));
  assert.notEqual(
    shown.find((line) => line.includes('请重新粘贴')),
    shown.find((line) => line.includes('Received API Key'))
  );
  const readlineLines = renderFirstRunLines(
    {
      step: 'error',
      offers: [],
      cursor: 0,
      failStep: 'key',
      error: '密钥被拒绝（401）。请重新粘贴 API key。',
    },
    'zh_CN.UTF-8',
    'readline'
  );
  assert.ok(readlineLines.some((line) => line.includes('请重新粘贴')));
  assert.equal(
    readlineLines.some((line) => /Esc|仍然保存|press 1|按 1/.test(line)),
    false
  );
  const forced = reduceFirstRun(
    {
      step: 'error',
      offers: [],
      cursor: 0,
      provider: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:9',
      failStep: 'key',
      error: '密钥被拒绝（401）。请重新粘贴 API key。',
    },
    { type: 'char', char: '1' },
    SECRET,
    'zh_CN.UTF-8'
  );
  assert.equal(forced.view.step, 'model');
  assert.equal(forced.view.commitOnModel, true);
  assert.equal(forced.saved, undefined);
  const typed = reduceFirstRun(forced.view, { type: 'enter', draft: 'stub-alpha' }, SECRET, 'C');
  assert.equal(typed.saved.model, 'stub-alpha');
  assert.equal(typed.job, undefined);
}

// ─── probe classes: one row per gateway response ───────────────────────────

{
  const probeCase = async (status, body, locale) =>
    probeModel({
      provider: 'openai-compatible',
      baseUrl: 'http://gateway.example',
      apiKey: SECRET,
      model: 'stub-alpha',
      locale,
      fetchImpl: async () => new Response(body, { status }),
    });
  const rows = [
    { status: 401, body: `invalid api key ${SECRET}`, kind: 'auth', match: /API key was rejected/ },
    {
      status: 403,
      body: JSON.stringify({ error: { message: 'Tried to access deepseek-flsh' } }),
      kind: 'model',
      match: /Tried to access deepseek-flsh/,
    },
    {
      status: 403,
      body: JSON.stringify({ error: { message: 'not available in your country' } }),
      kind: 'region',
      match: /region/,
    },
    { status: 404, body: 'Not Found', kind: 'network', match: /not a missing model/ },
    {
      status: 400,
      body: JSON.stringify({ error: { message: 'Model Not Exist' } }),
      kind: 'model',
      match: /Model Not Exist/,
    },
    {
      status: 429,
      body: JSON.stringify({ error: { message: 'Too Many Requests' } }),
      kind: 'rate_limit',
      match: /Rate limited/,
    },
    {
      status: 429,
      body: JSON.stringify({
        error: { message: 'Too Many Requests', type: 'insufficient_quota' },
      }),
      kind: 'balance',
      match: /quota|balance/i,
    },
    {
      status: 403,
      body: '<!DOCTYPE html><html><head><title>403 Forbidden</title></head><body>Attention Required Cloudflare</body></html>',
      kind: 'network',
      match: /proxy or firewall/i,
    },
    {
      status: 402,
      body: JSON.stringify({ error: { message: 'Insufficient balance' } }),
      kind: 'balance',
      match: /quota|balance/i,
    },
    {
      status: 200,
      body: '<html>captive portal</html>',
      kind: 'unknown',
      match: /without a model reply/,
    },
    {
      status: 200,
      body: JSON.stringify({ choices: [] }),
      kind: 'unknown',
      match: /without a model reply/,
    },
  ];
  for (const row of rows) {
    const result = await probeCase(row.status, row.body, 'C');
    assert.equal(result.ok, false, row.kind);
    assert.equal(result.kind, row.kind, row.body);
    assert.match(result.message, row.match, row.kind);
    assert.doesNotMatch(result.message, /sk-firstrun/);
  }
  const leaked = await probeCase(
    401,
    JSON.stringify({
      error: { message: 'Received API Key = sk-live-000, Key Hash (Token) = 2c58abcd1234' },
    }),
    'zh_CN.UTF-8'
  );
  assert.equal(leaked.kind, 'auth');
  const [diagnosis, original] = leaked.message.split('\n');
  assert.match(diagnosis, /密钥被拒绝/);
  assert.match(diagnosis, /401/);
  assert.doesNotMatch(diagnosis, /moss setup/);
  assert.doesNotMatch(diagnosis, /Received API Key/);
  assert.match(original, /^网关原文：/);
  assert.match(original, /Received API Key = \[REDACTED\]/);
  assert.match(original, /Key Hash \(Token\) = \[REDACTED\]/);
  assert.doesNotMatch(leaked.message, /sk-live|2c58abcd/);

  const protocol = await probeModel({
    provider: 'openai-compatible',
    baseUrl: 'https://gateway.example',
    apiKey: SECRET,
    model: 'stub-alpha',
    fetchImpl: async () => {
      const err = new Error('write EPROTO wrong version number');
      err.code = 'EPROTO';
      throw err;
    },
  });
  assert.equal(protocol.kind, 'network');
  assert.match(protocol.message, /HTTP, not HTTPS/);
  assert.doesNotMatch(protocol.message, /certificate/);

  const tls = await probeModel({
    provider: 'openai-compatible',
    baseUrl: 'https://gateway.example',
    apiKey: SECRET,
    model: 'stub-alpha',
    fetchImpl: async () => {
      const err = new Error(`certificate verify failed ${SECRET}`);
      err.code = 'UNABLE_TO_VERIFY_LEAF_SIGNATURE';
      throw err;
    },
  });
  assert.equal(tls.kind, 'tls');
  assert.match(tls.message, /certificate/);
  assert.doesNotMatch(tls.message, /sk-firstrun/);
}

{
  const calls = [];
  const ok = await probeModel({
    provider: 'openai-compatible',
    baseUrl: 'http://gateway.example/v1',
    apiKey: SECRET,
    model: 'stub-alpha',
    locale: 'C',
    now: () => 0,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), headers: init.headers, body: init.body });
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
        status: 200,
      });
    },
  });
  assert.equal(ok.ok, true);
  assert.equal(calls[0].url, 'http://gateway.example/v1/chat/completions');
  assert.equal(calls[0].headers.authorization, `Bearer ${SECRET}`);
  assert.match(ok.message, /Connected — stub-alpha/);
  assert.doesNotMatch(ok.message, /sk-firstrun/);
  const parsed = JSON.parse(calls[0].body);
  assert.equal(parsed.max_tokens, 1);
  assert.equal(parsed.model, 'stub-alpha');

  const namedModel = await probeModel({
    provider: 'openai-compatible',
    baseUrl: 'http://gateway.example',
    apiKey: SECRET,
    model: 'missing-model',
    fetchImpl: async () =>
      new Response(JSON.stringify({ error: { message: 'model missing-model not found' } }), {
        status: 404,
      }),
  });
  assert.equal(namedModel.kind, 'model');
  assert.match(namedModel.message, /missing-model/);

  const hanging = http.createServer((_req, _res) => {});
  const hangSockets = new Set();
  hanging.on('connection', (socket) => {
    hangSockets.add(socket);
    socket.on('close', () => hangSockets.delete(socket));
  });
  await new Promise((resolve) => hanging.listen(0, '127.0.0.1', resolve));
  const hangPort = hanging.address().port;
  let timedOut;
  try {
    timedOut = await probeModel({
      provider: 'openai-compatible',
      baseUrl: `http://127.0.0.1:${hangPort}`,
      apiKey: SECRET,
      model: 'stub-alpha',
      timeoutMs: 200,
    });
  } finally {
    for (const socket of hangSockets) socket.destroy();
    hanging.close();
  }
  assert.equal(timedOut.kind, 'timeout');
  assert.match(timedOut.message, /timed out/i);
  assert.doesNotMatch(timedOut.message, /sk-firstrun/);

  const refused = await fetchGatewayModels({
    baseUrl: 'http://127.0.0.1:1',
    apiKey: SECRET,
    timeoutMs: 500,
    fetchImpl: async () => {
      const err = new Error('connect ECONNREFUSED 127.0.0.1:1');
      err.code = 'ECONNREFUSED';
      throw err;
    },
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.kind, 'network');
  assert.doesNotMatch(refused.message, /sk-firstrun/);
}

{
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/v1/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'live-a' }, { id: 'live-a' }, { name: 'live-b' }] }));
      return;
    }
    res.writeHead(404);
    res.end('missing');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const listed = await fetchGatewayModels({
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: SECRET,
    });
    assert.equal(listed.ok, true);
    assert.deepEqual(listed.models, ['live-a', 'live-b']);
  } finally {
    server.close();
  }
}

// ─── locale of the setup panel and the startup sentences ───────────────────

{
  const zh = renderFirstRunLines({ step: 'url', offers: [], cursor: 0 }, 'zh_CN.UTF-8').join('\n');
  assert.match(zh, /Moss 设置/);
  assert.match(zh, /网关地址/);
  assert.doesNotMatch(zh, /Gateway URL/);
  const en = renderFirstRunLines({ step: 'provider', offers: [], cursor: 0 }, 'en_US.UTF-8').join(
    '\n'
  );
  assert.match(en, /Moss setup/);
  assert.match(en, /OpenAI-compatible gateway/);
  assert.doesNotMatch(en, /网关/);
  assert.match(formatFullModeNotice('zh_CN'), /只显示一次/);
  assert.match(formatFullModeNotice('C'), /This notice shows once/);
  assert.match(formatInteractionModeNotice('full', 'zh_CN'), /交互模式/);
  assert.match(formatInteractionModeNotice('full', 'C'), /full \(v0\.26 default/);
}

// ─── "shown once" is persisted in the config dir ───────────────────────────

{
  const dir = tempDir('moss-notice-');
  const config = {
    approvalPolicy: 'never',
    deniedTools: [],
    permissions: { source: 'default' },
  };
  const env = { MOSS_CONFIG_DIR: dir };
  assert.equal(shouldShowFullDefaultNotice(config, env), true);
  assert.equal(fs.existsSync(path.join(dir, '.full_default_notice_shown')), true);
  assert.equal(shouldShowFullDefaultNotice(config, env), false);
}

// ─── doctor names the exact fix and never the key ──────────────────────────

{
  const blank = {
    apiKey: '',
    apiKeySource: 'none',
    apiKeyEncrypted: false,
    usingBundledDefault: false,
  };
  const withEnv = renderAuthDoctorLine(blank, { OPENAI_API_KEY: SECRET });
  assert.match(withEnv, /fail\s+auth:/);
  assert.match(withEnv, /OPENAI_API_KEY/);
  assert.match(withEnv, /Fix:/);
  assert.doesNotMatch(withEnv, /sk-firstrun/);
  const none = renderAuthDoctorLine(blank, {});
  assert.match(none, /moss setup/);
  const saved = renderAuthDoctorLine(
    {
      apiKey: SECRET,
      apiKeySource: 'config',
      apiKeyEncrypted: true,
      usingBundledDefault: false,
    },
    {}
  );
  assert.match(saved, /ok\s+auth:/);
  assert.doesNotMatch(saved, /sk-firstrun/);
}

{
  const line = await probeDoctorModelPing({
    model: 'demo-model',
    secrets: [SECRET],
    provider: {
      async complete() {
        throw new Error(`HTTP 401 Bearer ${SECRET}`);
      },
    },
  });
  assert.match(line, /fail\s+model ping: demo-model/);
  assert.match(line, /Fix: The API key was rejected/);
  assert.doesNotMatch(line, /sk-firstrun/);
}

// ─── a paste is mode 0600; an env offer stores the variable name only ──────

{
  const dir = tempDir('moss-save-key-');
  const savedPath = saveUserModelConfig({
    provider: 'openai-compatible',
    model: 'stub-alpha',
    baseUrl: 'http://127.0.0.1:9',
    apiKey: SECRET,
    env: { MOSS_CONFIG_DIR: dir },
  });
  const raw = fs.readFileSync(savedPath, 'utf8');
  assert.match(raw, /"apiKey": "enc:/);
  assert.match(raw, /stub-alpha/);
  assert.doesNotMatch(raw, /sk-firstrun/);
  assert.equal(fs.statSync(savedPath).mode & 0o777, 0o600);
  const again = saveUserModelConfig({
    model: 'stub-beta',
    env: { MOSS_CONFIG_DIR: dir },
  });
  const updated = JSON.parse(fs.readFileSync(again, 'utf8'));
  assert.equal(updated.model, 'stub-beta');
  assert.match(updated.apiKey, /^enc:/);
  assert.equal(updated.provider, 'openai-compatible');
  const envPath = saveUserModelConfig({
    model: 'stub-env',
    apiKeyEnv: 'OPENAI_API_KEY',
    env: { MOSS_CONFIG_DIR: dir },
  });
  const fromEnv = JSON.parse(fs.readFileSync(envPath, 'utf8'));
  assert.equal(fromEnv.apiKeyEnv, 'OPENAI_API_KEY');
  assert.equal(fromEnv.apiKey, undefined);
  assert.equal(fs.statSync(envPath).mode & 0o777, 0o600);
}

// ─── CLI: doctor fix text, zh startup, shown-once across processes ─────────

function cleanEnv(extra) {
  return {
    PATH: process.env.PATH ?? '',
    HOME: extra.HOME,
    TERM: 'dumb',
    LANG: extra.LANG ?? 'C',
    LC_ALL: extra.LC_ALL ?? 'C',
    MOSS_CONFIG_DIR: extra.MOSS_CONFIG_DIR,
    MOSS_NO_BUNDLED_DEFAULT: '1',
    NO_COLOR: '1',
    FORCE_COLOR: '0',
    ...extra,
  };
}

function runMoss(args, env, cwd) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 20_000,
    input: '',
  });
}

const cliCases = [
  {
    prefix: 'moss-doctor-home-',
    args: ['doctor'],
    extra: { OPENAI_API_KEY: SECRET },
    status: 1,
    match: [/OPENAI_API_KEY/, /Fix:/],
    absent: [/sk-firstrun/],
  },
  {
    prefix: 'moss-doctor-zh-',
    args: ['doctor'],
    extra: { LANG: 'zh_CN.UTF-8', LC_ALL: 'zh_CN.UTF-8' },
    match: [/修复/, /缺少 API key/],
  },
  {
    prefix: 'moss-once-home-',
    args: [],
    runs: 2,
    noticeFile: true,
    firstMatch: [/This\s+notice shows once/, /Interaction mode: full \(v0\.26 default/],
    eachMatch: [/Interaction mode:/],
    laterAbsent: [/This\s+notice shows once/],
  },
  {
    prefix: 'moss-once-zh-',
    args: [],
    extra: { LANG: 'zh_CN.UTF-8', LC_ALL: 'zh_CN.UTF-8' },
    match: [/此\s*提\s*示\s*只\s*显\s*示\s*一\s*次/, /交互模式/],
    absent: [/This notice shows once/],
  },
];

for (const row of cliCases) {
  const home = tempDir(row.prefix);
  const configDir = path.join(home, 'config');
  const workspace = tempDir(`${row.prefix}ws-`);
  const env = cleanEnv({ HOME: home, MOSS_CONFIG_DIR: configDir, ...row.extra });
  const texts = [];
  for (let i = 0; i < (row.runs ?? 1); i += 1) {
    const result = runMoss([...row.args, '-C', workspace], env, workspace);
    const text = `${result.stdout}\n${result.stderr}`;
    if (row.status !== undefined) assert.equal(result.status, row.status, text);
    texts.push(text);
  }
  const text = texts.at(-1) ?? '';
  for (const pattern of row.firstMatch ?? []) assert.match(texts[0] ?? '', pattern, row.prefix);
  for (const pattern of row.match ?? []) assert.match(text, pattern, row.prefix);
  for (const pattern of row.absent ?? []) assert.doesNotMatch(text, pattern, row.prefix);
  for (const pattern of row.eachMatch ?? []) {
    for (const item of texts) assert.match(item, pattern, row.prefix);
  }
  if (row.noticeFile === true) {
    assert.equal(fs.existsSync(path.join(configDir, '.full_default_notice_shown')), true);
  }
  for (const pattern of row.laterAbsent ?? []) {
    for (const item of texts.slice(1)) assert.doesNotMatch(item, pattern, row.prefix);
  }
}

{
  assert.equal(
    closestModelName('deepseek-flsh', ['deepseek-flash', 'deepseek-v4-flash']),
    'deepseek-flash'
  );
  const rejected = interpretModelInput(
    'deepseek-flsh',
    ['deepseek-flash', 'deepseek-v4-flash'],
    'deepseek-flash',
    'C'
  );
  assert.equal(rejected.suggested, 'deepseek-flash');
  assert.match(rejected.reject, /Closest match: deepseek-flash/);
  const view = {
    step: 'model',
    cursor: 1,
    offers: [],
    models: ['deepseek-flash', 'deepseek-v4-flash'],
    model: 'deepseek-v4-flash',
    provider: 'deepseek',
    baseUrl: 'https://api.deepseek.com',
  };
  const next = reduceFirstRun(view, { type: 'enter', draft: 'deepseek-flsh' }, '', 'C');
  assert.equal(next.view.step, 'model');
  assert.match(next.view.error, /deepseek-flash/);
  assert.equal(next.view.model, 'deepseek-v4-flash');
  assert.equal(next.view.cursor, 0);
  assert.equal(next.job, undefined);
}

console.log('[PASS] first-run setup');
