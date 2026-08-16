import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { createMossRuntime } from '../../packages/moss-agent/dist/runtime/shared-runtime.js';
import { InMemorySessionStore } from '../../packages/moss-agent/dist/core/session/session.js';
import { startMossWebServer } from '../../packages/moss-agent/dist/web-ui/web-server.js';

const MANIFEST = {
  release: 'moss-cloud-local-fixture',
  revision: 7,
  files: ['runtime.js', 'README.md'],
};

function toolResults(messages) {
  return messages
    .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
    .filter((block) => block.type === 'tool_result')
    .map((block) => ({ content: block.content, isError: block.is_error === true }));
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}

async function close(server) {
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
}

function createCloudFixture(expectedDigest) {
  let attempts = 0;
  const server = http.createServer((request, response) => {
    if (request.url !== '/release-evidence') {
      response.writeHead(404).end();
      return;
    }
    attempts += 1;
    if (attempts === 1) {
      response.writeHead(503, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'fixture warming up', retryable: true }));
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        release: MANIFEST.release,
        revision: MANIFEST.revision,
        manifestDigest: expectedDigest,
        attestation: 'CLOUD_ATTESTATION_OK',
      })
    );
  });
  return { server, attempts: () => attempts };
}

/**
 * Exercise Moss across a local artifact and a deterministic loopback "cloud" boundary.
 *
 * The scenario deliberately returns HTTP 503 once. Success therefore proves that the
 * agent observed a failed tool call, selected the retry path, reconciled independent
 * local/cloud evidence, and exposed the evidence through the durable Web task ledger.
 * It never reads credentials or contacts the public network.
 */
export async function runCloudLocalScenario(options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-cloud-local-'));
  const manifestPath = path.join(root, 'release-manifest.json');
  const manifestBody = `${JSON.stringify(MANIFEST, null, 2)}\n`;
  const digest = createHash('sha256').update(manifestBody).digest('hex');
  await fs.writeFile(manifestPath, manifestBody, { mode: 0o600 });

  const cloudDigest = options.cloudDigestMismatch ? `mismatch-${digest.slice(0, 12)}` : digest;
  const fixture = createCloudFixture(cloudDigest);
  const fixtureUrl = await listen(fixture.server);
  const trace = [];
  let localEvidence;
  let cloudEvidence;

  const provider = {
    id: 'deterministic-cloud-local',
    displayName: 'Deterministic cloud/local scenario provider',
    capabilities: { streaming: false },
    async complete(request) {
      const results = toolResults(request.messages);
      if (results.length === 0) {
        return {
          stopReason: 'tool_use',
          content: [{ type: 'tool_use', id: 'local-1', name: 'inspect_local_release', input: {} }],
        };
      }
      if (results.length === 1) {
        return {
          stopReason: 'tool_use',
          content: [
            { type: 'tool_use', id: 'cloud-1', name: 'fetch_cloud_attestation', input: {} },
          ],
        };
      }
      if (results.length === 2) {
        assert.equal(
          results[1].isError,
          true,
          'the first cloud attempt must be observable as failed'
        );
        trace.push({ phase: 'recovery-decision', reason: 'retryable HTTP 503' });
        return {
          stopReason: 'tool_use',
          content: [
            { type: 'tool_use', id: 'cloud-2', name: 'fetch_cloud_attestation', input: {} },
          ],
        };
      }
      assert.equal(results[2].isError, false);
      assert.match(results[0].content, new RegExp(digest));
      assert.match(results[2].content, /CLOUD_ATTESTATION_OK/);
      return {
        stopReason: 'tool_use',
        content: [
          { type: 'tool_use', id: 'reconcile-1', name: 'reconcile_release_evidence', input: {} },
        ],
      };
    },
    async stream() {
      throw new Error('streaming disabled');
    },
  };

  let finalTurn = false;
  const originalComplete = provider.complete.bind(provider);
  provider.complete = async (request) => {
    const results = toolResults(request.messages);
    if (results.length === 4) {
      finalTurn = true;
      if (options.cloudDigestMismatch) {
        assert.equal(results[3].isError, true);
        trace.push({ phase: 'reconciliation', outcome: 'CLOUD_LOCAL_REJECTED' });
        return {
          stopReason: 'end_turn',
          content: [
            {
              type: 'text',
              text: 'CLOUD_LOCAL_REJECTED: local and remote digests do not agree.',
            },
          ],
        };
      }
      assert.equal(results[3].isError, false);
      assert.match(results[3].content, /CLOUD_LOCAL_RECONCILED/);
      return {
        stopReason: 'end_turn',
        content: [
          {
            type: 'text',
            text: `CLOUD_LOCAL_COMPLETE: revision ${MANIFEST.revision}, evidence ${digest.slice(0, 12)}.`,
          },
        ],
      };
    }
    return originalComplete(request);
  };

  const runtime = await createMossRuntime({
    workspaceDir: root,
    dataDir: path.join(root, '.data'),
    enableSelfEvolution: false,
    toolProfile: 'desktop-safe',
    plugins: [
      {
        id: 'scenario/cloud-local-evidence',
        setup(context) {
          context.registerTool({
            name: 'inspect_local_release',
            description: 'Read and hash the deterministic local release manifest.',
            metadata: { sideEffectClass: 'readonly', planMode: 'allow' },
            inputSchema: { type: 'object', properties: {} },
            async execute() {
              const body = await fs.readFile(manifestPath, 'utf8');
              localEvidence = {
                ...JSON.parse(body),
                manifestDigest: createHash('sha256').update(body).digest('hex'),
              };
              trace.push({ phase: 'local-artifact', digest: localEvidence.manifestDigest });
              return JSON.stringify(localEvidence);
            },
          });
          context.registerTool({
            name: 'fetch_cloud_attestation',
            description: 'Fetch release attestation from the loopback cloud fixture.',
            metadata: { sideEffectClass: 'readonly', planMode: 'allow' },
            inputSchema: { type: 'object', properties: {} },
            async execute() {
              const response = await fetch(`${fixtureUrl}/release-evidence`, {
                signal: AbortSignal.timeout(2_000),
              });
              if (!response.ok) throw new Error(`retryable cloud fixture HTTP ${response.status}`);
              cloudEvidence = await response.json();
              trace.push({ phase: 'cloud-attestation', attempts: fixture.attempts() });
              return JSON.stringify(cloudEvidence);
            },
          });
          context.registerTool({
            name: 'reconcile_release_evidence',
            description: 'Reconcile independently collected local and cloud release evidence.',
            metadata: { sideEffectClass: 'readonly', planMode: 'allow' },
            inputSchema: { type: 'object', properties: {} },
            async execute() {
              assert.ok(localEvidence && cloudEvidence);
              assert.equal(cloudEvidence.manifestDigest, localEvidence.manifestDigest);
              assert.equal(cloudEvidence.revision, localEvidence.revision);
              trace.push({ phase: 'reconciliation', outcome: 'CLOUD_LOCAL_RECONCILED' });
              return `CLOUD_LOCAL_RECONCILED: digest=${localEvidence.manifestDigest}`;
            },
          });
        },
      },
    ],
    agentConfig: {
      llmProvider: provider,
      sessionStore: new InMemorySessionStore(),
      domainPrompt: false,
      includeLanguagePolicyPrompt: false,
      includeAgentBehaviorPrompt: false,
    },
  });

  const web = await startMossWebServer(runtime.agent, {
    port: 0,
    taskRunFile: path.join(root, '.moss', 'task-runs.jsonl'),
  });
  try {
    const session = await fetch(`${web.url}/api/sessions`, { method: 'POST' }).then((response) =>
      response.json()
    );
    const wire = await fetch(`${web.url}/api/sessions/${session.sessionId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt: 'Reconcile the local release manifest with cloud attestation and recover failures.',
      }),
    }).then((response) => response.text());
    assert.equal(finalTurn, true);
    assert.match(
      wire,
      options.cloudDigestMismatch ? /CLOUD_LOCAL_REJECTED/ : /CLOUD_LOCAL_COMPLETE/
    );

    const terminal = wire
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .find((event) => event.type === 'done');
    assert.ok(terminal?.run?.id);
    const history = await fetch(`${web.url}/api/runs/${terminal.run.id}`).then((response) =>
      response.json()
    );
    const evidence = history.events
      .filter((event) => event.type === 'tool.failed' || event.type === 'tool.succeeded')
      .map((event) => ({ type: event.type, name: event.data.name }));
    assert.deepEqual(evidence, [
      { type: 'tool.succeeded', name: 'inspect_local_release' },
      { type: 'tool.failed', name: 'fetch_cloud_attestation' },
      { type: 'tool.succeeded', name: 'fetch_cloud_attestation' },
      {
        type: options.cloudDigestMismatch ? 'tool.failed' : 'tool.succeeded',
        name: 'reconcile_release_evidence',
      },
    ]);
    assert.equal(history.run.status, 'completed');
    assert.equal(history.run.evidenceCount, 4);
    assert.equal(fixture.attempts(), 2);
    return {
      ok: true,
      run: history.run,
      cloudAttempts: fixture.attempts(),
      evidence,
      trace,
      final: options.cloudDigestMismatch
        ? 'CLOUD_LOCAL_REJECTED: local and remote digests do not agree.'
        : `CLOUD_LOCAL_COMPLETE: revision ${MANIFEST.revision}, evidence ${digest.slice(0, 12)}.`,
    };
  } finally {
    await web.close();
    await runtime.close();
    await close(fixture.server);
    await fs.rm(root, { recursive: true, force: true });
  }
}
