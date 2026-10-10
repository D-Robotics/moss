#!/usr/bin/env node
/**
 * Older tool results fold into a short summary at a checkpoint, not on every
 * new result. The pending batch and the most recent results stay in full.
 * A second pass does not rewrite a folded stub, so the prompt-cache prefix
 * stays stable between checkpoints.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  foldOlderToolResults,
  TOOL_RESULT_FOLDED_MARKER,
  TOOL_RESULT_FOLD_HORIZON,
} from '../dist/context/tool-result-fold.js';
import { elideOldLargeToolResults } from '../dist/context/tool-result-elision.js';
import { dedupeUnchangedReadToolResults } from '../dist/context/stale-read-invalidate.js';
import { findReplayableToolResultContent } from '../dist/core/tools/index.js';
import { runPerTurnContextManagement } from '../dist/core/loop/per-turn-context-management.js';
import { MossAgent } from '../dist/core/agent/moss-agent.js';
import { InMemorySessionStore } from '../dist/core/session/session.js';
import { globalToolStateManager } from '../dist/tools/tool-helpers.js';

function page(label, chars, tail = '') {
  const body = `${label}\n` + 'x'.repeat(chars);
  return tail ? `${body}\n${tail}` : body;
}

function resultMessage(id, name, content) {
  return {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: id, name, content }],
  };
}

function assistantCall(id, name, input) {
  return {
    role: 'assistant',
    content: [{ type: 'tool_use', id, name, input: input ?? { q: id } }],
  };
}

test('fold waits for a batch, keeps the pending result, and is stable on the next pass', () => {
  const messages = [{ role: 'user', content: 'What is the pinmux?' }];
  for (let i = 1; i <= 5; i++) {
    messages.push(assistantCall(`c${i}`, 'get_page'));
    messages.push(resultMessage(`c${i}`, 'get_page', page(`Page ${i}`, 5000, `TAIL-${i}`)));
  }
  const early = foldOlderToolResults(messages);
  assert.equal(early.foldedCount, 0, 'five results: one pending, four old, batch not full');
  assert.equal(early.messages, messages);

  messages.push(assistantCall('c6', 'get_page'));
  messages.push(resultMessage('c6', 'get_page', page('Page 6', 5000, 'TAIL-6')));
  const folded = foldOlderToolResults(messages, { remainingRequests: 64 });
  assert.equal(folded.foldedCount, 3);
  assert.ok(folded.savedChars > 4000);
  const texts = folded.messages
    .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
    .filter((block) => block.type === 'tool_result')
    .map((block) => block.content);
  assert.equal(texts.filter((text) => text.includes(TOOL_RESULT_FOLDED_MARKER)).length, 3);
  assert.ok(texts[3].includes('Page 4'), 'a recent completed page stays in full');
  assert.ok(texts[4].includes('Page 5'), 'the newest completed page stays in full');
  assert.ok(texts[5].includes('Page 6'), 'the pending page stays in full');
  assert.match(texts[0], /Page 1/);
  assert.match(texts[0], /TAIL-1/, 'the stub keeps the tail');

  const again = foldOlderToolResults(folded.messages);
  assert.equal(again.foldedCount, 0);
  assert.equal(again.messages, folded.messages);
  assert.equal(JSON.stringify(again.messages), JSON.stringify(folded.messages));
});

function cacheStable(prev, next) {
  // Appending to a JSON array only moves the closing bracket.
  return next.startsWith(prev.slice(0, -1));
}

function simulate(apply, bodyFor) {
  let messages = [{ role: 'user', content: 'What is the camera pinmux?' }];
  let prev = JSON.stringify(messages);
  const rows = [];
  let rewrites = 0;
  let hitSum = 0;
  for (let i = 1; i <= 12; i++) {
    const body = bodyFor(i);
    const name = body.length > 8_000 ? 'get_page' : 'search_docs';
    messages.push(assistantCall(`c${i}`, name));
    messages.push(resultMessage(`c${i}`, name, body));
    const applied = apply(messages);
    messages = applied.messages;
    const payload = JSON.stringify(messages);
    let shared = 0;
    const limit = Math.min(prev.length, payload.length);
    while (shared < limit && prev[shared] === payload[shared]) shared += 1;
    const hit = shared / prev.length;
    if (!cacheStable(prev, payload)) rewrites += 1;
    hitSum += hit;
    rows.push({
      step: i,
      chars: payload.length,
      tokens: Math.ceil(payload.length / 4),
      prefixHit: Number(hit.toFixed(4)),
      rewrite: !cacheStable(prev, payload),
    });
    prev = payload;
  }
  const totalTokens = rows.reduce((sum, row) => sum + row.tokens, 0);
  return {
    rows,
    rewrites,
    hitAvg: hitSum / rows.length,
    finalChars: prev.length,
    totalTokens,
  };
}

function summarize(label, raw, elision, fold) {
  const lines = [
    label,
    'tokens estimated as serialized message chars / 4',
    'prefixHit is the shared byte prefix of this request over the previous request',
    `raw     rewrites=${raw.rewrites} hitAvg=${raw.hitAvg.toFixed(3)} finalChars=${raw.finalChars} totalTokens=${raw.totalTokens}`,
    `elision rewrites=${elision.rewrites} hitAvg=${elision.hitAvg.toFixed(3)} finalChars=${elision.finalChars} totalTokens=${elision.totalTokens}`,
    `fold    rewrites=${fold.rewrites} hitAvg=${fold.hitAvg.toFixed(3)} finalChars=${fold.finalChars} totalTokens=${fold.totalTokens}`,
    'step rawTokens elisionTokens foldTokens elisionHit foldHit elisionRewrite foldRewrite',
  ];
  for (let i = 0; i < raw.rows.length; i++) {
    lines.push(
      [
        raw.rows[i].step,
        raw.rows[i].tokens,
        elision.rows[i].tokens,
        fold.rows[i].tokens,
        elision.rows[i].prefixHit,
        fold.rows[i].prefixHit,
        elision.rows[i].rewrite ? 1 : 0,
        fold.rows[i].rewrite ? 1 : 0,
      ].join(' ')
    );
  }
  return lines;
}

test('checkpoint fold rewrites the cache prefix less often than sliding elision', () => {
  const large = (i) => page(`Page ${i} pinmux table`, 14_000);
  const mixed = (i) =>
    i % 3 === 1 ? page(`Search hit ${i}`, 5_000) : page(`Page ${i} pinmux table`, 14_000);
  const run = (bodyFor) => ({
    raw: simulate((messages) => ({ messages }), bodyFor),
    elision: simulate((messages) => elideOldLargeToolResults(messages), bodyFor),
    fold: simulate((messages) => foldOlderToolResults(messages), bodyFor),
  });
  const pages = run(large);
  const docs = run(mixed);

  assert.ok(pages.fold.rewrites <= 3, `fold rewrites ${pages.fold.rewrites}`);
  assert.ok(pages.elision.rewrites >= 6, `elision rewrites ${pages.elision.rewrites}`);
  assert.ok(
    pages.fold.hitAvg > pages.elision.hitAvg + 0.05,
    `fold hit ${pages.fold.hitAvg.toFixed(3)} vs elision ${pages.elision.hitAvg.toFixed(3)}`
  );
  assert.ok(pages.fold.finalChars < pages.raw.finalChars / 2);
  assert.ok(pages.fold.rewrites < pages.elision.rewrites);
  assert.ok(docs.fold.rewrites <= pages.elision.rewrites);

  const lines = [
    ...summarize(
      'scenario: 12 page dumps, 14k chars each (above the old 8k elision floor)',
      pages.raw,
      pages.elision,
      pages.fold
    ),
    '',
    ...summarize(
      'scenario: docs Q&A mix, search 5k chars (under the old floor) and pages 14k',
      docs.raw,
      docs.elision,
      docs.fold
    ),
  ];
  console.log(lines.join('\n'));
});

test('results under 4k chars are not folded', () => {
  const bodyFor = (i) => page(`Note ${i}`, 800);
  const raw = simulate((messages) => ({ messages }), bodyFor);
  const fold = simulate((messages) => foldOlderToolResults(messages), bodyFor);
  assert.equal(fold.rewrites, 0);
  assert.equal(fold.finalChars, raw.finalChars);
  assert.equal(fold.totalTokens, raw.totalTokens);
});

test('error results and retainResult tools stay in full', () => {
  const messages = [{ role: 'user', content: 'q' }];
  messages.push(assistantCall('e1', 'exec'));
  messages.push({
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: 'e1',
        name: 'exec',
        is_error: true,
        content: page('ERR', 5000, 'ERROR-CAUSE-TAIL'),
      },
    ],
  });
  messages.push(assistantCall('t1', 'todo_write'));
  messages.push(resultMessage('t1', 'todo_write', page('TODO', 5000, 'TODO-STILL-OPEN')));
  for (let i = 1; i <= 6; i++) {
    messages.push(assistantCall(`c${i}`, 'get_page'));
    messages.push(resultMessage(`c${i}`, 'get_page', page(`Page ${i}`, 5000, `TAIL-${i}`)));
  }
  const folded = foldOlderToolResults(messages, {
    retainTools: new Set(['todo_write']),
    remainingRequests: 64,
  });
  assert.ok(folded.foldedCount >= 3);
  const texts = folded.messages
    .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
    .filter((block) => block.type === 'tool_result')
    .map((block) => block.content);
  const error = texts.find((text) => text.includes('ERROR-CAUSE-TAIL'));
  const todo = texts.find((text) => text.includes('TODO-STILL-OPEN'));
  assert.equal(error.includes(TOOL_RESULT_FOLDED_MARKER), false);
  assert.equal(todo.includes(TOOL_RESULT_FOLDED_MARKER), false);
  const stub = texts.find((text) => text.includes(TOOL_RESULT_FOLDED_MARKER));
  assert.match(stub, /TAIL-/);
});

test('the savings gate refuses a fold that does not pay for the rewrite', () => {
  const messages = [{ role: 'user', content: 'q' }];
  for (let i = 1; i <= 6; i++) {
    messages.push(assistantCall(`c${i}`, 'get_page'));
    messages.push(resultMessage(`c${i}`, 'get_page', page(`Page ${i}`, 5000)));
  }
  const refused = foldOlderToolResults(messages, { remainingRequests: 1 });
  assert.equal(refused.foldedCount, 0);
  assert.equal(refused.messages, messages);
  const allowed = foldOlderToolResults(messages, { remainingRequests: 64 });
  assert.equal(allowed.foldedCount, 3);
  const horizon = foldOlderToolResults(messages);
  assert.equal(TOOL_RESULT_FOLD_HORIZON, 5);
  assert.equal(horizon.foldedCount, 0, 'the default horizon does not fold a 5k batch');
  assert.equal(horizon.messages, messages);
});

test('a folded read is not replayed, not deduped to see-below, and marks the cache truncated', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-fold-read-'));
  const file = path.join(dir, 'page.txt');
  fs.writeFileSync(file, 'pinmux\n');
  await globalToolStateManager.recordFileState(file, 'full', false);
  assert.equal(await globalToolStateManager.readReuseState(file, 'full'), 'fresh');

  const body = page('Same', 5000, 'SAME-TAIL');
  const messages = [{ role: 'user', content: 'q' }];
  for (let i = 1; i <= 6; i++) {
    messages.push(assistantCall(`r${i}`, 'read_file', { path: i === 1 ? file : 'src/a.ts' }));
    messages.push(resultMessage(`r${i}`, 'read_file', body));
  }
  const folded = foldOlderToolResults(messages, { remainingRequests: 64 });
  assert.ok(folded.foldedCount >= 1);
  assert.equal(await globalToolStateManager.readReuseState(file, 'full'), 'truncated');
  assert.equal(
    findReplayableToolResultContent(folded.messages, 'read_file', { path: file }, 32, 'readonly'),
    null
  );

  const deduped = dedupeUnchangedReadToolResults(folded.messages);
  const texts = deduped.messages
    .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
    .filter((block) => block.type === 'tool_result')
    .map((block) => block.content);
  assert.ok(
    texts.some((text) => text.includes('SAME-TAIL') && !text.includes(TOOL_RESULT_FOLDED_MARKER))
  );
  assert.ok(texts.some((text) => text.includes(TOOL_RESULT_FOLDED_MARKER)));
  fs.rmSync(dir, { recursive: true, force: true });
});

function perTurn(messages, turns) {
  const events = [];
  const result = runPerTurnContextManagement({
    currentMessages: messages,
    estPromptTokens: 1000,
    effectiveContextWindowTokens: 200_000,
    pendingToolResultFollowUp: true,
    turns,
    maxTurns: 64,
    push: (event) => events.push(event),
  });
  return { result, events, joined: JSON.stringify(messages) };
}

test('per-turn context management folds a 14k batch and leaves a 4k batch', () => {
  const small = [{ role: 'user', content: 'Look up the pinmux.' }];
  for (let i = 1; i <= 6; i++) {
    small.push(assistantCall(`s${i}`, 'get_page'));
    small.push(resultMessage(`s${i}`, 'get_page', page(`Page ${i}`, 4000)));
  }
  const short = perTurn(small, 6);
  assert.equal(short.result.savedChars, 0);
  assert.equal(short.joined.includes(TOOL_RESULT_FOLDED_MARKER), false);

  const large = [{ role: 'user', content: 'Look up the pinmux.' }];
  for (let i = 1; i <= 11; i++) {
    large.push(assistantCall(`c${i}`, 'get_page'));
    large.push(resultMessage(`c${i}`, 'get_page', page(`Page ${i}`, 14_000)));
  }
  const folded = perTurn(large, 12);
  assert.ok(folded.result.savedChars > 0);
  assert.ok(folded.joined.includes(TOOL_RESULT_FOLDED_MARKER));
  assert.equal(folded.joined.includes('[earlier tool result elided'), false);
  const action = folded.events.find((event) => event.type === 'context_action');
  const foldAction = action?.actions?.find((row) => row.kind === 'elide_old_large_tool_results');
  assert.ok(foldAction?.count >= 3);
});

test('a docs-style turn folds old pages before the answer and keeps the prefix', async () => {
  const captured = [];
  let round = 0;
  const provider = {
    id: 'fold-capture',
    displayName: 'fold',
    capabilities: { streaming: true },
    async complete(opts) {
      captured.push(opts);
      round += 1;
      const chars = JSON.stringify(opts.messages ?? []).length;
      if (round <= 11) {
        return {
          stopReason: 'tool_use',
          content: [
            {
              type: 'tool_use',
              id: `c${round}`,
              name: 'lookup',
              input: { q: String(round) },
            },
          ],
          usage: { inputTokens: Math.ceil(chars / 4), outputTokens: 20 },
        };
      }
      return {
        stopReason: 'end_turn',
        content: [{ type: 'text', text: 'The camera clock is GPIO 3.' }],
        usage: { inputTokens: Math.ceil(chars / 4), outputTokens: 12 },
      };
    },
    async stream(opts, onEvent) {
      onEvent?.({ type: 'message_start' });
      return this.complete(opts);
    },
  };
  const store = new InMemorySessionStore();
  const agent = new MossAgent({
    llmProvider: provider,
    sessionStore: store,
    model: 'fold-capture',
    baseSystemPrompt: 'Answer from the docs.',
    domainPrompt: false,
    includeAgentBehaviorPrompt: false,
    includeLanguagePolicyPrompt: false,
    enableSteering: false,
    enableFollowUpGuard: false,
    maxAgentTurns: 64,
    contextTokens: 200_000,
  });
  agent.tools.register({
    name: 'lookup',
    description: 'Look up a docs page.',
    metadata: { sideEffectClass: 'readonly' },
    inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
    async execute(input) {
      return page(`Page ${input.q} pinmux`, 14_000);
    },
  });
  agent.tools.register({
    name: 'ask_user_question',
    description: 'Ask the user.',
    metadata: { requiresUserQuestion: true },
    inputSchema: { type: 'object', properties: {} },
    async execute() {
      return 'asked';
    },
  });
  agent.tools.register({
    name: 'task_define',
    description: 'Define a task.',
    inputSchema: { type: 'object', properties: {} },
    async execute() {
      return 'defined';
    },
  });

  const result = await agent.chat('fold-qa', 'Which pin is the camera clock?');
  const text = typeof result === 'string' ? result : result?.response;
  assert.match(text, /GPIO 3/);
  assert.equal(captured.length, 12);

  const names = captured[0].tools.map((tool) => tool.name);
  assert.ok(names.includes('lookup'));
  assert.ok(names.includes('task_define'));
  assert.ok(!names.includes('ask_user_question'));

  const payloads = captured.map((opts) => JSON.stringify(opts.messages));
  let rewrites = 0;
  for (let i = 1; i < payloads.length; i++) {
    if (!cacheStable(payloads[i - 1], payloads[i])) rewrites += 1;
  }
  assert.ok(rewrites <= 2, `prefix rewrites ${rewrites}`);
  assert.ok(payloads[11].includes(TOOL_RESULT_FOLDED_MARKER));
  assert.equal(payloads[10].includes(TOOL_RESULT_FOLDED_MARKER), false);
  const rawBodies = 11 * 14_000;
  assert.ok(payloads[11].length < rawBodies, 'the answer request is smaller than the raw pages');

  const stored = JSON.stringify(await store.loadMessages('fold-qa'));
  assert.ok(stored.includes(TOOL_RESULT_FOLDED_MARKER), 'folded text is stored for the next turn');

  const requestTokens = payloads.map((payload) => Math.ceil(payload.length / 4));
  console.log(
    `agent docs turn requests=${captured.length} rewrites=${rewrites} tokens=${requestTokens.join(',')} total=${requestTokens.reduce((sum, n) => sum + n, 0)}`
  );
  await agent.close();
});

function sizedPage(label, chars) {
  const head = `${label}\n`;
  return head + 'x'.repeat(Math.max(0, chars - head.length));
}

function cacheDollars(rows, price) {
  let amount = 0;
  rows.forEach((row, idx) => {
    if (idx === 0) {
      amount += (row.tokens * price.write) / 1e6;
      return;
    }
    const write = Math.max(0, row.tokens - row.read);
    amount += (row.read * price.read + write * price.write) / 1e6;
  });
  return amount;
}

function pricedRun(steps, chars) {
  const prices = {
    Anthropic: { write: 3.75, read: 0.3 },
    DeepSeek: { write: 0.3, read: 0.006 },
    OpenAI: { write: 1.25, read: 0.125 },
  };
  const run = (apply) => {
    let messages = [{ role: 'user', content: 'What is the camera pinmux?' }];
    let prev = JSON.stringify(messages);
    const rows = [];
    let rewrites = 0;
    let folded = 0;
    for (let i = 1; i <= steps; i++) {
      const body = sizedPage(`Page ${i} pinmux table`, chars);
      messages.push(assistantCall(`c${i}`, 'get_page'));
      messages.push(resultMessage(`c${i}`, 'get_page', body));
      const applied = apply(messages, i);
      if (applied.foldedCount > 0) folded += applied.foldedCount;
      messages = applied.messages;
      const payload = JSON.stringify(messages);
      let shared = 0;
      const limit = Math.min(prev.length, payload.length);
      while (shared < limit && prev[shared] === payload[shared]) shared += 1;
      const stable = payload.startsWith(prev.slice(0, -1));
      if (!stable) rewrites += 1;
      const tokens = Math.ceil(payload.length / 4);
      rows.push({ tokens, read: Math.min(Math.floor(shared / 4), tokens) });
      prev = payload;
    }
    return { rows, rewrites, folded };
  };
  const main = run((messages) => elideOldLargeToolResults(messages));
  const fold = run((messages, i) =>
    foldOlderToolResults(messages, {
      remainingRequests: Math.min(i + 1, TOOL_RESULT_FOLD_HORIZON),
    })
  );
  const cells = {};
  for (const [name, price] of Object.entries(prices)) {
    cells[name] = { main: cacheDollars(main.rows, price), fold: cacheDollars(fold.rows, price) };
  }
  return { main, fold, cells };
}

test('the observed horizon is never more expensive than main, including a short turn', () => {
  const sizes = [800, 4_000, 8_000, 14_000, 30_000];
  const lines = [
    `horizon=${TOOL_RESULT_FOLD_HORIZON} (min of requests so far and the cap)`,
    'tokens = serialized chars / 4; cache read on the shared prefix; cache write on the rest',
    'main is sliding elision',
  ];
  for (const steps of [12, 4]) {
    lines.push('', `steps=${steps}`);
    for (const size of sizes) {
      const priced = pricedRun(steps, size);
      lines.push(
        `size=${size} mainRewrites=${priced.main.rewrites} foldRewrites=${priced.fold.rewrites} folded=${priced.fold.folded}`
      );
      for (const [name, cell] of Object.entries(priced.cells)) {
        const delta = ((cell.fold - cell.main) / cell.main) * 100;
        lines.push(
          `  ${name} main=$${cell.main.toFixed(6)} fold=$${cell.fold.toFixed(6)} delta=${delta.toFixed(1)}%`
        );
        assert.ok(
          cell.fold <= cell.main + 1e-12,
          `${steps}x${size} ${name} fold $${cell.fold} > main $${cell.main}`
        );
        if (steps === 12 && size >= 14_000) {
          assert.ok(delta <= -44, `${steps}x${size} ${name} saved only ${delta.toFixed(1)}%`);
        }
      }
      if (steps === 12 && size === 4_000) assert.equal(priced.fold.folded, 0);
      if (steps === 12 && size >= 14_000) assert.ok(priced.fold.folded > 0);
    }
  }
  console.log(lines.join('\n'));
});
