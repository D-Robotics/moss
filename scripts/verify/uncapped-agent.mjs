import assert from 'node:assert/strict';
import {
  MossAgent,
  InMemorySessionStore,
  resolveToolFollowupBypassCap,
} from '../../dist/index.js';

assert.equal(resolveToolFollowupBypassCap(2), 4);
assert.equal(resolveToolFollowupBypassCap(6), 12);
assert.equal(resolveToolFollowupBypassCap(8), 16);
assert.equal(resolveToolFollowupBypassCap(10), 20);
assert.equal(resolveToolFollowupBypassCap(12), 24);
assert.equal(resolveToolFollowupBypassCap(64), 128);
assert.equal(resolveToolFollowupBypassCap(100), 182);
assert.equal(resolveToolFollowupBypassCap(null), 0);

function provider(target, repeated = false) {
  return {
    id: 'uncapped-probe',
    displayName: 'Offline progress probe',
    capabilities: { streaming: true },
    calls: 0,
    async complete(options) {
      if (!options.tools?.some((tool) => tool.name === 'observe_step'))
        return {
          stopReason: 'end_turn',
          content: [{ type: 'text', text: 'Summary unavailable.' }],
        };
      this.calls++;
      return this.calls <= target
        ? {
            stopReason: 'tool_use',
            content: [
              {
                type: 'tool_use',
                id: `step-${this.calls}`,
                name: 'observe_step',
                input: { step: repeated ? 1 : this.calls },
              },
            ],
          }
        : { stopReason: 'end_turn', content: [{ type: 'text', text: 'Delivered.' }] };
    },
    async stream(options, emit) {
      const result = await this.complete(options);
      emit({ type: 'message_start' });
      for (const block of result.content) {
        emit({
          type: 'content_block_start',
          ...(block.type === 'tool_use' ? { toolUse: { id: block.id, name: block.name } } : {}),
        });
        emit(
          block.type === 'tool_use'
            ? { type: 'content_block_delta', partialJson: JSON.stringify(block.input) }
            : { type: 'content_block_delta', text: block.text }
        );
        emit({ type: 'content_block_stop' });
      }
      emit({ type: 'message_delta', stopReason: result.stopReason });
      emit({ type: 'message_stop' });
      return result;
    },
  };
}
async function run(target, limit, repeated = false, budget) {
  const llmProvider = provider(target, repeated);
  const agent = new MossAgent({
    llmProvider,
    sessionStore: new InMemorySessionStore(),
    baseSystemPrompt: 'Use observe_step then deliver.',
    domainPrompt: false,
    enableSteering: false,
    enableFollowUpGuard: false,
    maxAgentTurns: limit,
    budget,
  });
  let executed = 0;
  agent.tools.register({
    name: 'observe_step',
    description: 'Return a fresh observation for the requested step.',
    metadata: { sideEffectClass: 'readonly' },
    inputSchema: { type: 'object', properties: { step: { type: 'number' } }, required: ['step'] },
    async execute(input) {
      executed++;
      return repeated ? 'same unchanged observation' : `New observation ${input.step}`;
    },
  });
  try {
    return {
      result: await agent.chat('progress', 'Observe each step, then deliver.', { taskFlow: false }),
      calls: llmProvider.calls,
      executed,
    };
  } finally {
    await agent.close();
  }
}
const long = await run(300, 'unlimited');
assert.equal(
  long.calls,
  301,
  'productive work must cross both the old default and hard turn limits'
);
assert.equal(long.executed, 300);
assert.equal(long.result.response, 'Delivered.');
const ordinary = await run(300, 2);
assert.ok(ordinary.calls < 301, 'explicit finite callers retain their limit');
const guarded = await run(8, 'unlimited', true);
assert.ok(guarded.executed < 8, 'unlimited turns must retain repeated-tool no-progress protection');
const budgeted = await run(300, 'unlimited', false, { maxTurns: 2 });
assert.ok(budgeted.calls <= 2, 'an explicit SDK RunBudget remains effective for other hosts');
console.log(
  '[uncapped-agent] productive 301-call run, finite callers, explicit budgets and loop guard verified'
);
