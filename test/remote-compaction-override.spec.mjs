import assert from 'node:assert/strict';
import http from 'node:http';
import { MossAgent, InMemorySessionStore, mossScopedInferenceVersion } from '../dist/index.js';
assert.equal(mossScopedInferenceVersion, 1);
let remoteCalls = 0;
const server = http.createServer((_req, res) => {
  remoteCalls++;
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ summary: 'remote summary', tokensSaved: 1000, method: 'remote' }));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const old = process.env.MOSS_REMOTE_COMPACT_ENDPOINT;
process.env.MOSS_REMOTE_COMPACT_ENDPOINT = `http://127.0.0.1:${server.address().port}`;
try {
  for (const override of [undefined, null]) {
    const store = new InMemorySessionStore();
    let localCalls = 0;
    const agent = new MossAgent({
      sessionStore: store,
      llmProvider: {
        id: 'local',
        capabilities: { streaming: false },
        async complete() {
          localCalls++;
          return {
            stopReason: 'end_turn',
            content: [
              { type: 'text', text: '<summary>Local summary preserves decisions.</summary>' },
            ],
          };
        },
      },
      model: 'test',
      contextTokens: 4000,
      maxTokens: 500,
      domainPrompt: false,
      remoteCompactProvider: override,
      compactionSettings: {
        enabled: true,
        reserveTokens: 500,
        keepRecentTokens: 200,
        restoreFileContents: false,
      },
    });
    const before = remoteCalls;
    try {
      for (let index = 0; index < 10; index++)
        await store.appendMessage('history', {
          role: index % 2 ? 'assistant' : 'user',
          content: 'history '.repeat(120),
        });
      const result = await agent.compactSession('history');
      assert.equal(result.compacted, true);
      if (override === null) {
        assert.equal(
          remoteCalls,
          before,
          'null never calls environment remote health or inference'
        );
        assert.ok(localCalls > 0);
      } else assert.ok(remoteCalls > before, 'undefined preserves existing environment offload');
    } finally {
      await agent.close();
    }
  }
} finally {
  if (old === undefined) delete process.env.MOSS_REMOTE_COMPACT_ENDPOINT;
  else process.env.MOSS_REMOTE_COMPACT_ENDPOINT = old;
  await new Promise((resolve) => server.close(resolve));
}
console.log('remote-compaction-override: null disables environment offload per agent');
