#!/usr/bin/env node
// Embedding example 4/4: a skill library without the CLI.
// The host supplies a SkillCatalogPort; core renders the budgeted catalog into
// the prompt and registers the `skill` tool. No API key needed (scripted mock):
//   node examples/skill-catalog.mjs
import { MossAgent } from '../dist/core/agent/moss-agent.js';
import { InMemorySessionStore } from '../dist/core/session/session.js';

const skill = {
  name: 'deploy-check',
  description: 'Use before deploying: prints the checklist token the operator expects.',
  when: 'the user asks whether a deploy is ready',
  allowedTools: [],
  disallowedTools: [],
  metadata: {},
  globs: [],
  scope: 'workspace',
  dir: '/virtual/skills/deploy-check',
  file: '/virtual/skills/deploy-check/SKILL.md',
  body: '# Deploy check\nAlways print the token DEPLOY-OK after checking the checklist.\n',
  resources: { scripts: [], references: [], assets: [], evals: false },
  issues: [],
  legacy: false,
};

const provider = {
  id: 'scripted',
  displayName: 'scripted (offline)',
  capabilities: { streaming: true },
  calls: 0,
  async complete(options) {
    this.calls += 1;
    if (this.calls === 1) {
      return {
        stopReason: 'tool_use',
        content: [{ type: 'tool_use', id: 'call-1', name: 'skill', input: { name: skill.name } }],
      };
    }
    const toolResult = options.messages.at(-1)?.content?.find?.((b) => b?.type === 'tool_result');
    const body = String(toolResult?.content ?? '');
    const token = body.includes('DEPLOY-OK') ? 'DEPLOY-OK' : 'MISSING-TOKEN';
    return {
      stopReason: 'end_turn',
      content: [{ type: 'text', text: 'deploy check loaded, says ' + token }],
    };
  },
  async stream(options, onEvent) {
    const response = await this.complete(options);
    onEvent({ type: 'message_start' });
    for (const block of response.content) {
      onEvent({
        type: 'content_block_start',
        ...(block.type === 'tool_use' ? { toolUse: { id: block.id, name: block.name } } : {}),
      });
      onEvent(
        block.type === 'tool_use'
          ? { type: 'content_block_delta', partialJson: JSON.stringify(block.input) }
          : { type: 'content_block_delta', text: block.text }
      );
      onEvent({ type: 'content_block_stop' });
    }
    onEvent({ type: 'message_delta', stopReason: response.stopReason });
    onEvent({ type: 'message_stop' });
    return response;
  },
};

const agent = new MossAgent({
  llmProvider: provider,
  sessionStore: new InMemorySessionStore(),
  baseSystemPrompt: 'You are an embedded deploy agent.',
  domainPrompt: false,
  enableSteering: false,
  enableFollowUpGuard: false,
  // This is the whole integration: core owns the catalog text and the tool.
  skills: { manifests: () => [skill], budgetChars: 4_000 },
});

if (!agent.tools.get('skill')) throw new Error('skill tool was not registered by core');
const prompt = agent.composeSystemPrompt().full;
if (!prompt.includes('Available skills') || !prompt.includes(skill.name)) {
  throw new Error('catalog was not injected into the dynamic prompt');
}
console.log(`catalog stats: ${JSON.stringify(agent.skillCatalogStats())}`);

const result = await agent.chat('skill-demo', 'Is the deploy ready? Load the skill first.', {
  onStream: (event) => console.log(JSON.stringify({ type: event.type })),
});
if (!result.response.includes('DEPLOY-OK')) {
  throw new Error(`skill body did not reach the model: ${result.response}`);
}
console.log(`final response: ${result.response}`);
await agent.close();
