#!/usr/bin/env node
import assert from 'node:assert/strict';
import { OpenAILLMProvider } from '../packages/moss-agent/dist/provider/openai.js';
import { MossAgent } from '../packages/moss-agent/dist/core/agent/moss-agent.js';
import { InMemorySessionStore } from '../packages/moss-agent/dist/core/session/session.js';

const apiKey = process.env.OPENAI_API_KEY;
const baseUrl = process.env.OPENAI_BASE_URL;
const models = (process.env.MOSS_REVIEW_MODELS ?? '')
  .split(',')
  .map((model) => model.trim())
  .filter(Boolean);
if (!apiKey || !baseUrl || models.length < 2) {
  process.stderr.write(
    'Set OPENAI_API_KEY, OPENAI_BASE_URL, and at least two comma-separated MOSS_REVIEW_MODELS.\n'
  );
  process.exitCode = 2;
} else {
  const reviews = [];
  for (const model of models) {
    const provider = new OpenAILLMProvider({ apiKey, baseUrl, defaultModel: model });
    const agent = new MossAgent({
      llmProvider: provider,
      model,
      maxAgentTurns: 4,
      sessionStore: new InMemorySessionStore(),
      baseSystemPrompt:
        'You are participating in a tool-use interoperability evaluation. When the user names an available tool, you must call it before answering and must ground the answer in its result.',
      domainPrompt: false,
      includeAgentBehaviorPrompt: false,
      includeLanguagePolicyPrompt: false,
    });
    agent.tools.register({
      name: 'inspect_interaction_contract',
      description: 'Read the exact Moss cloud/local and Web interaction acceptance contract.',
      metadata: { sideEffectClass: 'readonly', planMode: 'allow' },
      inputSchema: { type: 'object', properties: {} },
      async execute() {
        return JSON.stringify({
          evidence: 'INTERACTION_CONTRACT_OK',
          requirements: [
            'remote failure is observable before retry',
            'local artifact and remote attestation must reconcile',
            'durable history is keyboard accessible',
            'completion and verification remain separate',
          ],
        });
      },
    });
    try {
      const result = await agent.chat(
        `multi-model-review-${model}`,
        'You MUST call the available inspect_interaction_contract tool now; do not describe or simulate the call. After its result arrives, independently identify the highest-risk remaining UX or agent reliability gap. Your final answer must cite INTERACTION_CONTRACT_OK and give one concrete recommendation.'
      );
      assert.deepEqual(
        result.toolCalls.map(({ name }) => name),
        ['inspect_interaction_contract']
      );
      assert.match(result.response, /INTERACTION_CONTRACT_OK/);
      reviews.push({
        model,
        grounded: true,
        toolCalls: result.toolCalls.map(({ name }) => name),
        recommendation: result.response,
      });
    } finally {
      await agent.close();
    }
  }
  process.stdout.write(`${JSON.stringify({ ok: true, reviews }, null, 2)}\n`);
}
