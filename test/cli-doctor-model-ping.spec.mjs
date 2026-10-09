#!/usr/bin/env node
/**
 * `/doctor` pings the configured model: latency + model name, never the key.
 */
import assert from 'node:assert/strict';

import { probeDoctorModelPing } from '../dist/cli/doctor-model-ping.js';
import { runRegistryCommand } from '../dist/cli/commands/registry.js';

{
  let calls = 0;
  const line = await probeDoctorModelPing({
    model: '',
    provider: {
      complete: async () => {
        calls += 1;
        return { model: 'should-not-run' };
      },
    },
  });
  assert.equal(calls, 0, 'no model means no request');
  assert.match(line, /warn\s+model ping: no model configured/);
}

{
  const seen = [];
  let tick = 1_000;
  const line = await probeDoctorModelPing({
    model: 'configured-model',
    now: () => {
      const current = tick;
      tick += 42;
      return current;
    },
    provider: {
      async complete(options) {
        seen.push(options);
        return { stopReason: 'end_turn', content: [], model: 'gateway-model' };
      },
    },
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].model, 'configured-model');
  assert.equal(seen[0].maxTokens, 1);
  assert.equal(seen[0].messages[0].content, 'ping');
  assert.equal('apiKey' in seen[0], false);
  assert.match(line, /ok\s+model ping: gateway-model · 42ms/);
  assert.doesNotMatch(line, /configured-model/);
}

{
  const secret = 'plain-key-not-a-token-99';
  const line = await probeDoctorModelPing({
    model: 'demo-model',
    secrets: [secret],
    timeoutMs: 1_000,
    provider: {
      async complete() {
        throw new Error(`HTTP 401 Bearer sk-live-secret-token key=${secret}`);
      },
    },
  });
  assert.match(line, /fail\s+model ping: demo-model · \d+ms/);
  assert.match(line, /Bearer \[redacted\]/);
  assert.doesNotMatch(line, /sk-live-secret-token/);
  assert.doesNotMatch(line, new RegExp(secret));
  assert.doesNotMatch(line, /plain-key/);
}

{
  const line = await probeDoctorModelPing({
    model: 'slow-model',
    timeoutMs: 30,
    provider: {
      complete: () => new Promise(() => {}),
    },
  });
  assert.match(line, /fail\s+model ping: slow-model · \d+ms · timed out after 30ms/);
}

{
  const messages = [];
  const handled = await runRegistryCommand('/doctor', {
    agent: {
      config: {
        model: 'session-model',
        llmProvider: {
          async complete() {
            throw new Error('rejected Bearer sk-session-secret');
          },
        },
      },
    },
    sessionKey: 'doctor-ping',
    workspace: process.cwd(),
    surface: 'repl',
    say(_kind, text) {
      messages.push(text);
    },
    prefillInput() {},
  });
  assert.equal(handled, true);
  const text = messages.join('\n');
  assert.match(text, /Doctor/);
  assert.match(text, /model ping: session-model/);
  assert.match(text, /\d+ms/);
  assert.doesNotMatch(text, /sk-session-secret/);
}

console.log('[PASS] doctor model ping');
