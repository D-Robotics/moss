#!/usr/bin/env node
/**
 * Offline regression: a gateway that refuses `tool_choice: "required"` while
 * thinking is enabled must not fail the run.
 *
 * Incident (RDK Studio + deepseek-flash, Moss 7d1f785): Moss's decision-repair
 * turn sends exactly one tool, `turn_decision`, with `tool_choice: "required"`.
 * The gateway answers HTTP 400 "Thinking mode does not support this
 * tool_choice". The same turn succeeds when `tool_choice` is left out, because
 * the model still calls the only tool it was given; the resolution retries once
 * without the field and leaves the model's thinking mode alone.
 *
 * The retry lives in PiAiLLMProvider, so it covers both transports (the bundled
 * HTTP transport and a host-injected streamFn) and both public entries
 * (`stream()` and `complete()`). `tool_choice` is only relaxed when Moss asked
 * for `required` on this request — a requirement pinned by the caller's config
 * or by the environment is never silently dropped. Nothing is relaxed once the
 * attempt has delivered text, reasoning, tools or usage, nor after a cancel or
 * a watchdog timeout.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '../..');
const load = (file) => import(pathToFileURL(path.join(root, 'dist', file)).href);
const { MossAgent } = await load('core/agent/moss-agent.js');
const { InMemorySessionStore } = await load('core/session/session.js');
const { PiAiLLMProvider } = await load('provider/pi-ai-adapter.js');
const { createHttpStreamFunction } = await load('provider/pi-ai-http-transport.js');

const INCIDENT =
  '400 litellm.BadRequestError: OpenAIException - Thinking mode does not support this tool_choice';
const OPENAI_MODEL = { api: 'openai-completions', provider: 'custom', id: 'deepseek-flash' };
const DECISION_TOOL = {
  name: 'turn_decision',
  description: 'Submit the decision for this turn',
  input_schema: { type: 'object', properties: {} },
};

function makeProvider(streamFn, model = OPENAI_MODEL) {
  return new PiAiLLMProvider({ apiKey: 'offline-key', model, streamFn });
}

function request(overrides = {}) {
  return {
    model: 'deepseek-flash',
    systemPrompt: 'Answer the user.',
    messages: [{ role: 'user', content: '1 + 1 = 2' }],
    tools: [DECISION_TOOL],
    maxTokens: 256,
    ...overrides,
  };
}

/** What the next layer would have sent, minus the objects we cannot compare. */
function snapshot(options) {
  const out = {};
  for (const key of Object.keys(options ?? {}).sort()) {
    const value = options[key];
    if (key === 'abortSignal' || key === 'signal' || key === 'onPayload') out[key] = `<${key}>`;
    else if (typeof value === 'function') out[key] = '<function>';
    else out[key] = value;
  }
  return out;
}

function comparable(options) {
  const copy = { ...options };
  delete copy.toolChoice;
  delete copy.abortSignal;
  delete copy.signal;
  return copy;
}

function rejection(status, message = INCIDENT) {
  return Object.assign(new Error(message), { status });
}

async function streamOnce(provider, options) {
  const events = [];
  try {
    const response = await provider.stream(options, (event) => events.push(event));
    return { events, response };
  } catch (error) {
    return { events, error };
  }
}

async function completeOnce(provider, options) {
  try {
    return { response: await provider.complete(options) };
  } catch (error) {
    return { error };
  }
}

const usage = { input: 12, output: 4 };

/**
 * The "transport threw before the first event" carrier: an async iterable whose
 * first pull rejects, which is how a real stream function reports a hard
 * gateway failure.
 */
function failing(makeError) {
  return {
    [Symbol.asyncIterator]: () => ({
      next: () => Promise.reject(makeError()),
    }),
  };
}

// ─── A: the recorded incident, end to end through the real agent loop ───────

let scenarioSeq = 0;

function frameOf(systemPrompt) {
  const lines = String(systemPrompt ?? '').split('\n');
  const index = lines.lastIndexOf('[Runtime-owned current task intent]');
  if (index < 0) return { revision: 0, inputSeq: 1, pendingInputs: [{ id: 'math-input' }] };
  return JSON.parse(lines[index + 1]);
}

function decisionInput(frame, disposition = 'answer') {
  return {
    baseRevision: frame.revision,
    inputSeq: frame.inputSeq,
    messageIds: frame.pendingInputs.map((item) => item.id),
    changes: [],
    disposition,
    plan: [],
  };
}

async function scenario(decide, maxTurns = 6) {
  // Every scenario gets its own workspace and input id: a reused input id would
  // look like an already-committed turn to the intent store.
  const workspace = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'moss-tool-choice-fallback-'))
  );
  const seq = ++scenarioSeq;
  const session = `math-${seq}`;
  const inputId = `math-input-${seq}`;
  const transcript = [];
  const starts = [];
  const validations = [];
  const streamFn = async function* (_model, context, options) {
    const tools = (context.tools ?? []).map((tool) => tool.name);
    const frame = frameOf(context.systemPrompt);
    transcript.push({ tools, options: snapshot(options) });
    if (options?.toolChoice === 'required') throw new Error(INCIDENT);
    if (tools.length === 1 && tools[0] === 'turn_decision') {
      yield* decide(frame, transcript);
      return;
    }
    yield { type: 'text_delta', delta: '是的，1 + 1 = 2。' };
    yield { type: 'done', reason: 'stop', usage: { input: 20, output: 6 } };
  };
  const provider = makeProvider(streamFn);
  const agent = new MossAgent({
    llmProvider: provider,
    sessionStore: new InMemorySessionStore(),
    workspaceDir: workspace,
    sessionInboxDir: path.join(workspace, 'inbox'),
    baseSystemPrompt: 'Follow the user. Never invent observations.',
    domainPrompt: false,
    taskIntent: true,
    verificationGate: false,
    validateTaskIntentDecision: (decision) => {
      validations.push(decision.disposition);
    },
  });
  for (const name of ['device_probe', 'read_device']) {
    agent.tools.register({
      name,
      description: name,
      metadata: { sideEffectClass: 'readonly' },
      inputSchema: { type: 'object', properties: {} },
      execute: async () => {
        starts.push(name);
        return `${name} ok`;
      },
    });
  }
  try {
    const result = await agent.chat(session, '1 + 1 = 2', {
      userInput: { id: inputId },
      taskFlow: false,
      maxTurns,
    });
    return {
      result,
      transcript,
      starts,
      validations,
      receipt: agent.getTaskIntentReceipt(session, inputId),
      intent: agent.getTaskIntent(session),
    };
  } finally {
    await agent.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
}

{
  const run = await scenario(async function* (frame) {
    yield { type: 'text_delta', delta: '1 + 1 = 2' };
    yield {
      type: 'toolcall_end',
      toolCall: { id: 'decision-1', name: 'turn_decision', arguments: decisionInput(frame) },
    };
    yield { type: 'done', reason: 'toolCall', usage: { input: 30, output: 8 } };
  });

  assert.equal(run.transcript.length, 3, 'the repair turn is physically sent twice');
  assert.equal(
    run.transcript[0].options.toolChoice,
    undefined,
    'the first turn offers the model no forced choice'
  );
  assert(
    run.transcript[0].tools.length > 1,
    'the first turn still exposes the business tools and turn_decision'
  );
  assert.deepEqual(
    run.transcript[1].tools,
    ['turn_decision'],
    'the repair request only exposes turn_decision'
  );
  assert.equal(
    run.transcript[1].options.toolChoice,
    'required',
    'the logical repair request still requires a decision'
  );
  assert.deepEqual(
    run.transcript[2].tools,
    ['turn_decision'],
    'the retry still gives the model the decision tool'
  );
  assert.equal(run.transcript[2].options.toolChoice, undefined, 'the retry omits tool_choice');
  assert.deepEqual(
    comparable(run.transcript[1].options),
    comparable(run.transcript[2].options),
    'the physical attempts differ only in tool_choice'
  );
  assert.match(String(run.result.response), /2/, 'the final reply carries the answer');
  assert.doesNotMatch(
    String(run.result.response),
    /是的/,
    'the staged text from the first attempt is not published as the answer'
  );
  assert.equal(run.receipt?.status, 'committed', 'the decision was committed once');
  assert.equal(run.intent?.revision, 1, 'the intent revision advanced exactly once');
  assert.deepEqual(run.validations, ['answer'], 'the host validation ran once');
  assert.deepEqual(run.starts, [], 'no business tool ran');
  console.log(
    '[evidence] incident turns ' +
      JSON.stringify(
        run.transcript.map(({ tools, options }) => ({ tools, toolChoice: options.toolChoice }))
      )
  );
  console.log(
    '[evidence] decision ' +
      JSON.stringify({
        receipt: run.receipt,
        validations: run.validations,
        businessStarts: run.starts.length,
        answer: String(run.result.response),
      })
  );
  console.log(
    '[tool-choice] ok incident replay: repair rejected once, retried, decision committed, zero tools ran'
  );
}

// ─── E: a 200 after the retry is not a decision ─────────────────────────────

{
  const run = await scenario(async function* () {
    yield { type: 'text_delta', delta: '1 + 1 = 2' };
    yield { type: 'done', reason: 'stop', usage: { input: 30, output: 8 } };
  }, 3).catch((error) => ({ error }));
  assert(run.error === undefined, 'the run itself still completes');
  assert.equal(run.receipt?.status !== 'committed', true, 'plain text commits no decision');
  assert.deepEqual(run.starts, [], 'no business tool ran before a decision');
  assert.equal(
    run.result.stopReason,
    'max_turns_reached',
    'the existing turn budget still applies'
  );
  assert.equal(
    run.transcript.filter((item) => item.tools.length === 1).length,
    4,
    'each repair turn is retried once and nothing more'
  );
  console.log(
    '[tool-choice] ok text-only 200 after the retry commits nothing and exhausts the budget'
  );
}

{
  const run = await scenario(async function* (frame) {
    yield { type: 'text_delta', delta: '1 + 1 = 2' };
    yield {
      type: 'toolcall_end',
      toolCall: {
        id: 'decision-1',
        name: 'turn_decision',
        arguments: { ...decisionInput(frame), plan: ['not allowed for an answer'] },
      },
    };
    yield { type: 'done', reason: 'toolCall', usage: { input: 30, output: 8 } };
  }, 3);
  assert.equal(run.receipt?.status !== 'committed', true, 'an invalid decision commits nothing');
  assert.deepEqual(run.starts, [], 'no business tool ran on an invalid decision');
  assert.equal(run.result.stopReason, 'tool_followup_cap_reached');
  assert.deepEqual(run.validations, [], 'the host never validated an illegal decision');
  console.log('[tool-choice] ok an invalid 200 after the retry still fails the decision contract');
}

// ─── B: a gateway that accepts `required` sees exactly one request ───────────

{
  const attempts = [];
  const provider = makeProvider(async function* (_model, _context, options) {
    attempts.push(snapshot(options));
    yield {
      type: 'toolcall_end',
      toolCall: { id: 'call-1', name: 'turn_decision', arguments: { disposition: 'answer' } },
    };
    yield { type: 'done', reason: 'toolCall', usage };
  });
  const { response, error } = await completeOnce(provider, request({ toolChoice: 'required' }));
  assert.equal(error, undefined);
  assert.equal(attempts.length, 1, 'an accepted `required` is sent once');
  assert.equal(attempts[0].toolChoice, 'required');
  assert.equal(
    attempts[0].allowToolChoiceFallback,
    undefined,
    'the provider owns the compatibility fallback'
  );
  assert(
    response.content.some((block) => block.type === 'tool_use'),
    'the retried response is parsed into a tool call'
  );
  console.log('[tool-choice] ok accepted `required` is sent once');
}

// ─── C: both carriers, both public entries ───────────────────────────────────

{
  const attempts = [];
  const provider = makeProvider(async function* (_model, _context, options) {
    attempts.push(snapshot(options));
    if (attempts.length === 1) throw new Error(INCIDENT);
    yield {
      type: 'toolcall_end',
      toolCall: { id: 'call-1', name: 'turn_decision', arguments: { disposition: 'answer' } },
    };
    yield { type: 'done', reason: 'toolCall', usage };
  });
  const { response, error } = await streamOnce(provider, request({ toolChoice: 'required' }));
  assert.equal(error, undefined, 'stream() recovers from a thrown rejection');
  assert.equal(attempts.length, 2, 'exactly one compatibility retry');
  assert.equal(attempts[0].toolChoice, 'required');
  assert.equal(attempts[1].toolChoice, undefined, 'the retry omits tool_choice');
  assert.deepEqual(comparable(attempts[0]), comparable(attempts[1]), 'only tool_choice changed');
  assert.equal(attempts[1].maxTokens, 256);
  assert.deepEqual(
    attempts[1].reasoning,
    attempts[0].reasoning,
    'the thinking setting is untouched'
  );
  assert(
    response.content.some((block) => block.type === 'tool_use'),
    'the retried response is parsed into a tool call'
  );
  console.log('[tool-choice] ok stream() retries a thrown rejection without tool_choice');
}

{
  const attempts = [];
  const provider = makeProvider(async function* (_model, _context, options) {
    attempts.push(snapshot(options));
    if (attempts.length === 1) {
      yield { type: 'error', error: { errorMessage: INCIDENT, status: 400 } };
      return;
    }
    yield {
      type: 'toolcall_end',
      toolCall: { id: 'call-1', name: 'turn_decision', arguments: { disposition: 'answer' } },
    };
    yield { type: 'done', reason: 'toolCall', usage };
  });
  const { response, error } = await streamOnce(provider, request({ toolChoice: 'required' }));
  assert.equal(error, undefined, 'stream() recovers from a rejected first pi-ai error event');
  assert.equal(attempts.length, 2, 'exactly one compatibility retry');
  assert.equal(attempts[1].toolChoice, undefined);
  assert(
    response.content.some((block) => block.type === 'tool_use'),
    'the retried response is parsed into a tool call'
  );
  console.log('[tool-choice] ok stream() retries a rejection carried by the first error event');
}

{
  const attempts = [];
  const provider = makeProvider(async function* (_model, _context, options) {
    attempts.push(snapshot(options));
    if (attempts.length === 1) throw new Error(INCIDENT);
    yield {
      type: 'toolcall_end',
      toolCall: { id: 'call-1', name: 'turn_decision', arguments: { disposition: 'answer' } },
    };
    yield { type: 'done', reason: 'toolCall', usage };
  });
  const { response, error } = await completeOnce(provider, request({ toolChoice: 'required' }));
  assert.equal(error, undefined);
  assert.equal(attempts.length, 2);
  assert.equal(attempts[1].toolChoice, undefined);
  assert.equal(response.usage.inputTokens, 12, 'usage comes from the successful attempt only');
  assert.equal(response.usage.outputTokens, 4);
  console.log('[tool-choice] ok complete() uses the same compatibility retry');
}

{
  const attempts = [];
  const provider = makeProvider(async function* (_model, _context, options) {
    attempts.push(snapshot(options));
    if (attempts.length === 1) {
      yield {
        type: 'error',
        error: { errorMessage: 'Thinking mode does not support this tool_choice', status: 400 },
      };
      return;
    }
    yield { type: 'text_delta', delta: '2' };
    yield { type: 'done', reason: 'stop', usage };
  });
  const { response, error } = await completeOnce(provider, request({ toolChoice: 'required' }));
  assert.equal(error, undefined, 'a structured status alone is enough evidence');
  assert.equal(attempts.length, 2);
  assert.match(response.content.map((block) => block.text ?? '').join(''), /2/);
  console.log('[tool-choice] ok structured status without the status in the text still retries');
}

// ─── D: no retry where the attempt is not clean or the error is unrelated ────

const unrelated = [
  ['unrelated 400', () => rejection(400, '400 Invalid parameter: temperature must be <= 2')],
  [
    '400 that blames tool_choice without calling it unsupported',
    () => rejection(400, '400 tool_choice is required for this endpoint'),
  ],
  ['401', () => rejection(401, '401 Incorrect API key provided')],
  ['403', () => rejection(403, '403 The project does not have access to this model')],
  ['429', () => rejection(429, '429 Rate limit reached for requests')],
  ['500', () => rejection(500, '500 upstream failure')],
  ['network failure', () => new TypeError('fetch failed')],
];
for (const [name, makeError] of unrelated) {
  let calls = 0;
  const provider = makeProvider(() => {
    calls += 1;
    return failing(() => makeError());
  });
  const { error } = await streamOnce(provider, request({ toolChoice: 'required' }));
  assert(error instanceof Error, `${name}: the request still fails`);
  assert.equal(calls, 1, `${name}: is not retried as a tool_choice mismatch`);
}

{
  let calls = 0;
  const controller = new AbortController();
  const provider = makeProvider(() => {
    calls += 1;
    controller.abort();
    return failing(() => rejection(400));
  });
  const { error } = await streamOnce(
    provider,
    request({ toolChoice: 'required', abortSignal: controller.signal })
  );
  assert(error instanceof Error);
  assert.equal(calls, 1, 'a cancelled request is never sent again');
}

{
  let calls = 0;
  const provider = makeProvider(async function* () {
    calls += 1;
    yield { type: 'text_delta', delta: 'partial answer' };
    throw rejection(400);
  });
  const events = [];
  const response = await provider.stream(request({ toolChoice: 'required' }), (event) =>
    events.push(event)
  );
  assert.equal(calls, 1, 'a stream that already delivered text is not replayed');
  assert.match(response.content.map((block) => block.text ?? '').join(''), /partial answer/);
  assert(response.incomplete, 'the delivered text is marked incomplete');
  assert.equal(
    events.filter((event) => event.type === 'content_block_delta').length,
    1,
    'the text delta is delivered once'
  );
}

{
  let calls = 0;
  const provider = makeProvider(async function* () {
    calls += 1;
    yield { type: 'thinking_delta', delta: 'thinking about 1 + 1' };
    throw rejection(400);
  });
  const { error } = await streamOnce(provider, request({ toolChoice: 'required' }));
  assert(error instanceof Error);
  assert.equal(calls, 1, 'a stream that already delivered reasoning is not replayed');
}

{
  let calls = 0;
  const provider = makeProvider(() => {
    calls += 1;
    return failing(() => (calls === 1 ? rejection(400) : rejection(500, '500 gateway exploded')));
  });

  {
    // A first-event watchdog timeout is a timing fact, never a tool_choice
    // mismatch: the attempt must surface the timeout and stay single-shot.
    const previous = process.env.MOSS_PI_AI_FIRST_EVENT_TIMEOUT_MS;
    process.env.MOSS_PI_AI_FIRST_EVENT_TIMEOUT_MS = '5000';
    let calls = 0;
    const provider = makeProvider((_model, _context, options) => {
      calls += 1;
      const signal = options?.abortSignal ?? options?.signal;
      return {
        [Symbol.asyncIterator]: () => ({
          next: () =>
            new Promise((_resolve, reject) => {
              const abort = () => {
                const error = new Error('The operation was aborted');
                error.name = 'AbortError';
                reject(error);
              };
              if (signal?.aborted) abort();
              else signal?.addEventListener('abort', abort, { once: true });
            }),
        }),
      };
    });
    try {
      const { error } = await completeOnce(provider, request({ toolChoice: 'required' }));
      assert(error instanceof Error, 'a timed-out attempt still fails');
      assert.equal(
        error.name,
        'PiAiFirstEventTimeoutError',
        'the watchdog timeout is surfaced as-is'
      );
      assert.equal(calls, 1, 'a timed-out attempt is never replayed');
    } finally {
      if (previous === undefined) delete process.env.MOSS_PI_AI_FIRST_EVENT_TIMEOUT_MS;
      else process.env.MOSS_PI_AI_FIRST_EVENT_TIMEOUT_MS = previous;
    }
  }
  const { error } = await completeOnce(provider, request({ toolChoice: 'required' }));
  assert(error instanceof Error);
  assert.match(String(error.message), /500/, 'the second attempt keeps its own error');
  assert.equal(calls, 2, 'a failed retry never becomes a third request');
}
console.log(
  '[tool-choice] ok unrelated, cancelled, partly delivered and failed-retry attempts are not replayed'
);

// ─── F: caller and environment requirements stay hard ────────────────────────

{
  let calls = 0;
  const attempts = [];
  const provider = makeProvider((_model, _context, options) => {
    calls += 1;
    attempts.push(snapshot(options));
    return failing(() => rejection(400));
  });
  const previous = process.env.MOSS_PI_AI_TOOL_CHOICE;
  process.env.MOSS_PI_AI_TOOL_CHOICE = 'required';
  try {
    const { error } = await streamOnce(provider, request());
    assert(error instanceof Error);
    assert.equal(
      attempts[0].toolChoice,
      'required',
      'the environment requirement still reaches the wire'
    );
    assert.equal(calls, 1, 'a requirement Moss did not raise is not silently relaxed');
  } finally {
    if (previous === undefined) delete process.env.MOSS_PI_AI_TOOL_CHOICE;
    else process.env.MOSS_PI_AI_TOOL_CHOICE = previous;
  }
  console.log('[tool-choice] ok an environment-pinned `required` is a hard requirement');
}

{
  const attempts = [];
  const provider = makeProvider(async function* (_model, _context, options) {
    attempts.push(snapshot(options));
    if (attempts.length === 1) throw rejection(400);
    yield {
      type: 'toolcall_end',
      toolCall: { id: 'call-1', name: 'turn_decision', arguments: { disposition: 'answer' } },
    };
    yield { type: 'done', reason: 'toolCall', usage };
  });
  const first = request({ toolChoice: 'required' });
  const previous = process.env.MOSS_PI_AI_TOOL_CHOICE;
  process.env.MOSS_PI_AI_TOOL_CHOICE = 'required';
  try {
    const { error } = await streamOnce(provider, first);
    assert.equal(error, undefined);
    assert.equal(attempts.length, 2);
    assert.equal(attempts[1].toolChoice, undefined, 'the retry is not refilled by the environment');
    assert.equal(first.toolChoice, 'required', 'the caller object is left untouched');

    // A later request through the same provider starts from `required` again.
    const second = await streamOnce(provider, request({ toolChoice: 'required' }));
    assert.equal(second.error, undefined);
    assert.equal(attempts.length, 3);
    assert.equal(attempts[2].toolChoice, 'required', 'no shared default was mutated');
  } finally {
    if (previous === undefined) delete process.env.MOSS_PI_AI_TOOL_CHOICE;
    else process.env.MOSS_PI_AI_TOOL_CHOICE = previous;
  }
  console.log('[tool-choice] ok the retry is request-local and never leaks into later requests');
}

// ─── F: the bundled HTTP transport keeps its behaviour without owning the retry ─

const httpRequests = [];
let httpDecision = { disposition: 'answer' };
const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => {
    raw += chunk;
  });
  req.on('end', () => {
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      body = {};
    }
    httpRequests.push(body);
    if (body.tool_choice === 'required') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: INCIDENT, type: 'invalid_request_error' } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'chatcmpl-offline',
        object: 'chat.completion',
        model: 'deepseek-flash',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: '1 + 1 = 2',
              tool_calls: [
                {
                  id: 'call-1',
                  type: 'function',
                  function: { name: 'turn_decision', arguments: JSON.stringify(httpDecision) },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 11, completion_tokens: 5 },
      })
    );
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;

try {
  const transport = createHttpStreamFunction({
    providerLabel: 'Offline gateway',
    apiKey: 'offline-key',
    model: 'deepseek-flash',
    baseUrl,
  });

  // The transport alone must not retry: one `required` request, one HTTP request.
  const generator = transport(
    { ...OPENAI_MODEL, baseUrl },
    {
      systemPrompt: 'Answer the user.',
      messages: [{ role: 'user', content: '1 + 1 = 2' }],
      tools: [
        {
          name: 'turn_decision',
          description: 'decide',
          parameters: { type: 'object', properties: {} },
        },
      ],
      apiKey: 'offline-key',
    },
    { apiKey: 'offline-key', toolChoice: 'required', allowToolChoiceFallback: true, maxTokens: 256 }
  );
  await assert.rejects(async () => {
    for await (const _event of generator) void _event;
  });
  assert.equal(httpRequests.length, 1, 'the transport does not send a second request on its own');
  assert.equal(httpRequests[0].tool_choice, 'required');
  console.log('[tool-choice] ok the bundled transport no longer owns the tool_choice retry');

  httpRequests.length = 0;
  const provider = makeProvider(transport, { ...OPENAI_MODEL, baseUrl });
  const { response, error } = await completeOnce(provider, request({ toolChoice: 'required' }));
  assert.equal(error, undefined, 'the adapter recovers the bundled transport rejection');
  assert.equal(httpRequests.length, 2, 'one rejected request plus one compatibility retry');
  assert.equal(httpRequests[0].tool_choice, 'required');
  assert.equal('tool_choice' in httpRequests[1], false, 'the retry omits tool_choice on the wire');
  assert(
    httpRequests[1].tools?.some((tool) => tool.function?.name === 'turn_decision'),
    'the retry keeps the turn_decision tool'
  );
  assert.deepEqual(
    httpRequests[1].messages,
    httpRequests[0].messages,
    'the retry keeps the same messages'
  );
  assert.equal(httpRequests[1].model, httpRequests[0].model);
  assert.equal(httpRequests[1].reasoning_effort, httpRequests[0].reasoning_effort);
  assert(
    response.content.some((block) => block.type === 'tool_use'),
    'the retried response is parsed into a tool call'
  );
  assert.equal(response.usage.inputTokens, 11, 'the retried response is parsed exactly once');
  console.log(
    '[evidence] http ' +
      JSON.stringify(
        httpRequests.map((body) => ({
          tool_choice: body.tool_choice,
          tools: body.tools?.map((tool) => tool.function?.name),
        }))
      )
  );
  console.log('[evidence] http usage ' + JSON.stringify(response.usage));
  console.log(
    '[tool-choice] ok one HTTP request rejected, one retried without tool_choice, parsed once'
  );
} finally {
  await new Promise((resolve) => server.close(resolve));
}

console.log('[tool-choice] ok provider tool-choice compatibility');
