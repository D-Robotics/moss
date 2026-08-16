import assert from 'node:assert/strict';
import { SubagentExpertRegistry } from '../dist/core/subagent/expert-registry.js';
import { MossAgent } from '../dist/core/agent/moss-agent.js';
import { InMemorySessionStore } from '../dist/core/session/session.js';
import { ErrorCode, MossError } from '../dist/errors.js';
import { selectSubagentTools } from '../dist/core/subagent/subagent-runner.js';
import { builtinTools } from '../dist/tools/builtin.js';

const architect = {
  id: 'architecture-reviewer',
  displayName: 'Architecture reviewer',
  description: 'Challenges boundaries and coupling.',
  instructions: 'Review dependency direction and identify counterexamples.',
  scope: 'read-only',
  allowedTools: ['read_file', 'search_code', 'write_file'],
  model: 'review-model',
  maxTurns: 7,
  timeoutMs: 2_000,
};

const first = new SubagentExpertRegistry([architect]);
const second = new SubagentExpertRegistry();
assert.equal(first.get('architecture-reviewer')?.displayName, 'Architecture reviewer');
assert.equal(second.get('architecture-reviewer'), undefined, 'registries are instance-isolated');
assert.throws(() => first.register(architect), /already registered/);
assert.throws(
  () => first.register({ ...architect, id: 'unsafe', scope: 'full' }),
  /read-only scope/
);

first.registerContributor({
  id: 'quality-plugin',
  contributeExperts: () => [
    {
      ...architect,
      id: 'test-reviewer',
      displayName: 'Test reviewer',
    },
  ],
});
assert.deepEqual(
  first.list().map(({ id }) => id),
  ['architecture-reviewer', 'test-reviewer']
);

const beforeFailedContribution = first.list();
assert.throws(
  () =>
    first.registerContributor({
      id: 'broken-plugin',
      contributeExperts: () => [
        { ...architect, id: 'would-leak', displayName: 'Would leak' },
        { ...architect, id: 'invalid-scope', scope: 'full' },
      ],
    }),
  /read-only scope/
);
assert.deepEqual(
  first.list(),
  beforeFailedContribution,
  'failed contributors roll back atomically'
);

const disposeContributor = first.registerContributor({
  id: 'temporary-plugin',
  contributeExperts: () => [{ ...architect, id: 'temporary-reviewer' }],
});
assert.ok(first.get('temporary-reviewer'));
disposeContributor();
disposeContributor();
assert.equal(first.get('temporary-reviewer'), undefined, 'contributor disposal is idempotent');

const catalogAgent = new MossAgent({
  llmProvider: {
    id: 'catalog-test',
    displayName: 'Catalog test',
    capabilities: { streaming: false },
    async complete() {
      return { stopReason: 'end_turn', content: [{ type: 'text', text: 'done' }] };
    },
    async stream() {
      throw new Error('streaming disabled');
    },
  },
  sessionStore: new InMemorySessionStore(),
  domainPrompt: false,
  includeLanguagePolicyPrompt: false,
  includeAgentBehaviorPrompt: false,
  capabilityPacks: [{ id: 'review-pack', subagentExperts: [architect] }],
});
const catalogPrompt = catalogAgent.buildSystemPrompt();
assert.match(catalogPrompt, /architecture-reviewer.*Challenges boundaries and coupling/s);
assert.doesNotMatch(catalogPrompt, /Review dependency direction/);
assert.doesNotMatch(catalogPrompt, /review-model/);

const sharedRegistry = new SubagentExpertRegistry();
const sharedConfig = {
  llmProvider: catalogAgent.config.llmProvider,
  sessionStore: new InMemorySessionStore(),
  domainPrompt: false,
  subagentExpertRegistry: sharedRegistry,
  capabilityPacks: [{ id: 'shared-pack', subagentExperts: [architect] }],
};
const sharedAgent = new MossAgent(sharedConfig);
assert.ok(sharedRegistry.get(architect.id));
await sharedAgent.close();
assert.equal(
  sharedRegistry.get(architect.id),
  undefined,
  'agent close disposes shared-registry packs'
);
await new MossAgent(sharedConfig).close();

assert.throws(
  () =>
    new MossAgent({
      ...sharedConfig,
      capabilityPacks: [
        {
          id: 'invalid-pack',
          subagentExperts: [{ ...architect, id: 'invalid-pack-expert', scope: 'full' }],
        },
      ],
    }),
  (error) =>
    error instanceof MossError &&
    error.code === ErrorCode.USER_INPUT_INVALID &&
    error.cause instanceof Error
);
assert.deepEqual(
  selectSubagentTools([{ name: 'read_file', metadata: { sideEffectClass: 'readonly' } }], {
    scope: 'read-only',
    allowedTools: [],
  }),
  [],
  'an explicit empty allowlist grants no tools'
);

const createSubagent = builtinTools.find(({ name }) => name === 'create_subagent');
assert.ok(createSubagent);
let received;
const output = await createSubagent.execute(
  { task: 'Review this change', expert: architect.id, scope: 'full', model: 'untrusted-model' },
  {
    workspaceDir: process.cwd(),
    sessionKey: 'expert-test',
    resolveSubagentExpert: (id) => first.get(id),
    spawnSubagent: async (params) => {
      received = params;
      return {
        runId: 'expert-child',
        sessionKey: 'subagent:expert-child',
        summary: 'Found one coupling risk.',
        success: true,
      };
    },
  }
);
assert.match(output, /SUCCESS/);
assert.equal(received.scope, 'read-only', 'trusted expert scope overrides model input');
assert.equal(received.model, 'review-model', 'trusted expert model overrides model input');
assert.equal(received.maxTurns, 7);
assert.equal(received.timeoutMs, 2_000);
assert.deepEqual(received.allowedTools, architect.allowedTools);
assert.equal(received.expertPrompt, architect.instructions);

const unknown = await createSubagent.execute(
  { task: 'Review this change', expert: 'missing' },
  {
    workspaceDir: process.cwd(),
    sessionKey: 'expert-test',
    resolveSubagentExpert: (id) => first.get(id),
    spawnSubagent: async () => {
      throw new Error('must not spawn');
    },
  }
);
assert.match(unknown, /unknown or unavailable.*missing/);

const selected = selectSubagentTools(
  [
    { name: 'read_file', metadata: { sideEffectClass: 'readonly' } },
    { name: 'write_file', metadata: { sideEffectClass: 'local_write' } },
    { name: 'plugin_without_metadata' },
    { name: 'fan_out_subagents', metadata: { sideEffectClass: 'readonly' } },
  ],
  { scope: 'read-only', allowedTools: ['read_file', 'write_file', 'plugin_without_metadata'] }
);
assert.deepEqual(
  selected.map(({ name }) => name),
  ['read_file'],
  'read-only experts reject mutating, metadata-free, and delegation tools'
);

console.log('[PASS] declarative sub-agent experts are isolated, bounded, and enforced');
