#!/usr/bin/env node
/**
 * Probe for the session commands both shells share: `/thinking`, `/session`,
 * `/usage`, `/changelog` and `/debug`.
 *
 * The PTY probe (`tui-interaction.py`) shows these answer from the keyboard.
 * A full-screen renderer paints only the rows that fit the viewport, so a
 * 24-line block leaves none of its first lines in the byte stream. What the
 * commands print is asserted here instead, against the real registry, the real
 * usage accumulator and the real changelog, with only the agent stubbed:
 *
 *   - the catalog resolves the four new commands and the `/usage` aliases;
 *   - the thinking cycle is Pi's seven levels in Pi's order and wraps to `off`;
 *   - `/thinking` shows, sets and hands back the level, and refuses a word
 *     that names none;
 *   - `/session` and `/usage` print what the accumulator counted, and say so
 *     when nothing was counted;
 *   - `/changelog` prints the top of the changelog and stops at its limit;
 *   - `/debug` writes the session messages and the screen lines to a file
 *     only the user can read.
 *
 * The REPL turn is the eighth check. Stdin that is not a terminal is read as
 * one prompt, so the REPL has no scripted form: the turn is started the way
 * `repl.ts` starts it (`runOneShot`, the level left open), against the CLI's
 * own provider on a local OpenAI-compatible stub that records what each
 * request asked for.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '../..');
// `/debug` and the price lookup read the config dir; keep both out of the
// user's real one. This has to be set before the modules load.
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-command-extras-'));
process.env.MOSS_CONFIG_DIR = configDir;

const load = (file) => import(pathToFileURL(path.join(root, file)).href);
const { runRegistryCommand, findRegistryCommand, changelogExcerpt } = await load(
  'dist/cli/commands/registry.js'
);
const { createSessionUsageAccumulator } = await load('dist/cli/session-usage.js');
const {
  THINKING_CYCLE,
  getSessionThinkingLevel,
  setSessionThinkingLevel,
  parseThinkingLevel,
  nextThinkingLevel,
  sessionReasoningOption,
} = await load('dist/cli/thinking-level.js');

let checks = 0;
const ok = (name) => {
  checks += 1;
  console.log(`[command-extras] ok ${name}`);
};

try {
  // 1. The catalog.
  for (const name of ['/thinking', '/session', '/changelog', '/debug']) {
    assert.equal(findRegistryCommand(name)?.spec.name, name, `${name} is in the catalog`);
  }
  assert.equal(findRegistryCommand('/cost')?.spec.name, '/usage');
  assert.equal(findRegistryCommand('/stats')?.spec.name, '/usage');
  ok('the four new commands and the /usage aliases resolve');

  // 2. The cycle.
  assert.deepEqual(
    [...THINKING_CYCLE],
    ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
  );
  let level = null;
  const walk = [];
  for (let step = 0; step < 9; step += 1) {
    level = nextThinkingLevel(level);
    walk.push(level);
  }
  assert.deepEqual(walk, [
    'off',
    'minimal',
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
    'off',
    'minimal',
  ]);
  assert.equal(parseThinkingLevel(' HIGH '), 'high');
  assert.equal(parseThinkingLevel('default'), null);
  assert.equal(parseThinkingLevel(''), null);
  assert.equal(parseThinkingLevel('sideways'), undefined);
  ok("the cycle is Pi's seven levels in Pi's order and wraps to off");

  // 3. What a turn receives.
  setSessionThinkingLevel(null);
  assert.deepEqual(sessionReasoningOption(), {});
  setSessionThinkingLevel('low');
  assert.deepEqual(sessionReasoningOption(), { reasoning: 'low' });
  assert.deepEqual(sessionReasoningOption(null), { reasoning: null });
  assert.deepEqual(sessionReasoningOption('max'), { reasoning: 'max' });
  setSessionThinkingLevel(null);
  ok('a session level goes out unless the caller set one of its own');

  // 4. `/thinking` through the registry.
  const said = [];
  const agent = {
    config: { model: 'probe-model' },
    projectedConversation: () => [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
    ],
    countSessionMessages: async () => 2,
  };
  const ctx = {
    agent,
    sessionKey: 'probe-session',
    workspace: fs.mkdtempSync(path.join(os.tmpdir(), 'moss-command-extras-ws-')),
    surface: 'repl',
    locale: 'en',
    say: (kind, text) => said.push({ kind, text }),
    prefillInput: () => {},
    submitPrompt: () => {},
  };
  const last = () => said.at(-1)?.text ?? '';

  assert.equal(await runRegistryCommand('/thinking', ctx), true);
  assert.match(
    last(),
    /thinking: model default\nlevels: off \| minimal \| low \| medium \| high \| xhigh \| max \| default/
  );
  await runRegistryCommand('/thinking high', ctx);
  assert.equal(getSessionThinkingLevel(), 'high');
  assert.match(last(), /thinking: high \(this session\) from the next turn\./);
  await runRegistryCommand('/thinking default', ctx);
  assert.equal(getSessionThinkingLevel(), null);
  assert.match(last(), /thinking follows the config again \(model default\) from the next turn\./);
  await runRegistryCommand('/thinking sideways', ctx);
  assert.equal(said.at(-1)?.kind, 'error');
  assert.match(last(), /unknown level "sideways"/);
  assert.equal(getSessionThinkingLevel(), null);
  ok('/thinking shows, sets and hands back the level, and refuses a word that names none');

  // 5. `/session` and `/usage` against the real accumulator.
  const usage = createSessionUsageAccumulator();
  assert.deepEqual(usage.summary().calls, 0);
  for (const call of [
    { inputTokens: 100, outputTokens: 1, cacheReadTokens: 20 },
    { inputTokens: 300, outputTokens: 3, cacheReadTokens: 0 },
    { inputTokens: 650, outputTokens: 5, cacheReadTokens: 0 },
  ]) {
    usage.record({ type: 'llm_usage', model: 'probe-model', ...call });
  }
  const counting = {
    ...ctx,
    getSessionUsage: () => usage.summary(),
  };
  said.length = 0;
  await runRegistryCommand('/session', counting);
  const session = said.map((entry) => entry.text).join('\n');
  assert.equal(said.at(-1)?.kind, 'system');
  assert.match(
    session,
    /Session\n {2}id\s+probe-session\n {2}workspace\s+\S+\n {2}model\s+probe-model\n {2}messages\s+2\n/
  );
  assert.match(session, /model calls 3/);
  assert.match(session, /input\s+1,050 tokens/);
  assert.match(session, /output\s+9 tokens/);
  assert.match(session, /cost: unpriced \(moss config set pricing\.models\.probe-model\.input/);
  assert.doesNotMatch(session, /no model calls yet/);
  said.length = 0;
  await runRegistryCommand('/usage', counting);
  const counted = said.map((entry) => entry.text).join('\n');
  assert.match(counted, /Session usage\n {2}model calls {3}3/);
  assert.match(counted, /cache read {2}20 tokens/);
  assert.match(counted, /cache new {2}0 tokens/);
  assert.match(counted, /prompt total 1,070 tokens \(incl\. cache\)/);
  assert.match(counted, /cache hit {3}2%/);
  said.length = 0;
  await runRegistryCommand('/cost', { ...ctx, getSessionUsage: () => usage.summary() });
  assert.match(said.map((entry) => entry.text).join('\n'), /model calls {3}3/);
  // Nothing counted: both say so instead of printing zeros as if they were data.
  for (const [name, text] of [
    ['/session', /no model calls yet\./],
    ['/usage', /No model calls recorded in this session yet\. Send a message, then run \/usage\./],
  ]) {
    said.length = 0;
    await runRegistryCommand(name, { ...ctx, getSessionUsage: () => undefined });
    assert.match(said.map((entry) => entry.text).join('\n'), text, `${name} with no usage`);
  }
  ok('/session and /usage print what the accumulator counted, and say when nothing was');

  // 6. `/changelog`.
  const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
  const excerpt = changelogExcerpt(changelog);
  assert.match(excerpt, /^## Unreleased\n/);
  const shown = excerpt
    .split('\n')
    .filter((line) => !line.startsWith('## ') && !/more line\(s\)/.test(line));
  assert.equal(shown.length, 24, 'the excerpt stops at its limit');
  assert.match(excerpt, /… \d+ more line\(s\) in CHANGELOG\.md$/);
  assert.doesNotMatch(excerpt.slice('## Unreleased\n'.length), /^## /m);
  assert.equal(changelogExcerpt('nothing with a heading here'), '');
  const small = '# Changelog\n\n## 1.0.0\n\n- one\n- two\n\n## 0.9.0\n\n- zero\n';
  assert.equal(changelogExcerpt(small), '## 1.0.0\n- one\n- two\n## 0.9.0\n- zero');
  // A spent budget stops the excerpt: the next release is not announced bare.
  assert.equal(changelogExcerpt(small, 1), '## 1.0.0\n- one\n  … 1 more line(s) in CHANGELOG.md');
  assert.equal(changelogExcerpt(small, 2), '## 1.0.0\n- one\n- two');
  // What the first section leaves of the budget goes to the newest release.
  assert.equal(changelogExcerpt(small, 3), '## 1.0.0\n- one\n- two\n## 0.9.0\n- zero');
  ok('/changelog shows the top of the changelog and stops at its limit');

  // 7. `/debug`.
  const before = new Set(
    fs.existsSync(path.join(configDir, 'debug'))
      ? fs.readdirSync(path.join(configDir, 'debug'))
      : []
  );
  said.length = 0;
  assert.equal(
    await runRegistryCommand('/debug', {
      ...ctx,
      agent: { ...agent, config: { model: 'probe-model', provider: 'probe-provider' } },
      getRenderedRows: () => ['row one', 'row two'],
    }),
    true
  );
  const written = /wrote (\S+) \(/.exec(last())?.[1];
  assert.ok(written, `/debug names the file it wrote: ${last()}`);
  assert.ok(written.startsWith(`${path.join(configDir, 'debug')}${path.sep}`));
  assert.ok(!before.has(path.basename(written)));
  assert.equal(fs.statSync(written).mode & 0o777, 0o600);
  assert.match(last(), /2 messages, 2 screen lines/);
  const log = fs.readFileSync(written, 'utf8');
  assert.match(
    log,
    /^moss debug log\ntime {6}\S+\nsession {3}probe-session\nworkspace .+\nmodel {5}probe-model\nprovider {2}probe-provider\n/
  );
  assert.match(log, /== session messages \(2\) ==\n\[\n {2}\{\n {4}"role": "user"/);
  assert.match(log, /== screen lines \(2\) ==\nrow one\nrow two\n$/);
  ok('/debug writes the session messages and the screen lines to a private file');

  // 8. A REPL turn carries the session level to the wire.
  const answer = 'ok';
  const requests = [];
  const stub = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      const parsed = JSON.parse(body);
      const has = Object.hasOwn(parsed, 'reasoning_effort');
      requests.push({ effort: has ? parsed.reasoning_effort : undefined, has });
      const usage = { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 };
      const message = { role: 'assistant', content: answer };
      if (!parsed.stream) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'x',
            object: 'chat.completion',
            created: 1,
            model: 'm',
            choices: [{ index: 0, message, finish_reason: 'stop' }],
            usage,
          })
        );
        return;
      }
      const chunk = (delta, finish_reason) =>
        `data: ${JSON.stringify({
          id: 'x',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'm',
          choices: [{ index: 0, delta, finish_reason }],
          ...(finish_reason ? { usage } : {}),
        })}\n\n`;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`${chunk(message, null)}${chunk({}, 'stop')}data: [DONE]\n\n`);
    });
  });
  await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
  const { createCliProvider } = await load('dist/cli/providers.js');
  const { runOneShot } = await load('dist/cli/oneshot.js');
  const { MossAgent } = await load('dist/core/agent/moss-agent.js');
  const { InMemorySessionStore } = await load('dist/core/session/session.js');
  const { registerBuiltinTools } = await load('dist/tools/builtin.js');
  const live = new MossAgent({
    llmProvider: createCliProvider({
      provider: 'openai-compatible',
      apiKey: 'offline-key',
      model: 'm',
      baseUrl: `http://127.0.0.1:${stub.address().port}/v1`,
    }),
    sessionStore: new InMemorySessionStore(),
    workspaceDir: ctx.workspace,
    baseSystemPrompt: 'Answer in one word.',
    domainPrompt: false,
    verificationGate: false,
  });
  registerBuiltinTools(live);
  const turn = (extra = {}) => runOneShot(live, 'probe', { sessionKey: 'wire-probe', ...extra });
  // In the text format the run renderer prints each turn on the real stdout.
  // Drop what the eight turns print so the probe's own lines stay readable.
  const print = process.stdout.write.bind(process.stdout);
  let turning = false;
  process.stdout.write = (chunk, ...rest) => (turning ? true : print(chunk, ...rest));
  // `undefined` is a request without the field; `null` would be a JSON null.
  const asked = () => requests.map((request) => (request.has ? request.effort : '<absent>'));
  try {
    turning = true;
    for (const [command, option, expected] of [
      ['/thinking default', {}, '<absent>'],
      ['/thinking high', {}, 'high'],
      ['/thinking xhigh', {}, 'xhigh'],
      ['/thinking off', {}, 'none'],
      ['/thinking default', {}, '<absent>'],
      // A caller that names a level of its own keeps it over the session's.
      ['/thinking high', { reasoning: 'low' }, 'low'],
      ['/thinking high', { reasoning: 'off' }, 'none'],
      ['/thinking high', { reasoning: null }, '<absent>'],
    ]) {
      assert.equal(await runRegistryCommand(command, ctx), true, `${command} ran`);
      requests.length = 0;
      await turn(option);
      assert.deepEqual(
        asked(),
        [expected],
        `after ${command}, a turn with ${JSON.stringify(option)}`
      );
    }
  } finally {
    turning = false;
    process.stdout.write = print;
    await live.close();
    await new Promise((resolve) => stub.close(resolve));
  }
  setSessionThinkingLevel(null);
  ok('a REPL turn carries the session level to the wire, and keeps the level its caller named');

  fs.rmSync(ctx.workspace, { recursive: true, force: true });
  console.log(`[command-extras] ${checks}/${checks} checks passed`);
} finally {
  fs.rmSync(configDir, { recursive: true, force: true });
}
