#!/usr/bin/env node
/**
 * File-defined sub-agents: Claude-compatible markdown, precedence, tool
 * mapping, ignored permission fields, and delegation that still asks approval.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  adoptFileAgents,
  formatFileAgentReport,
  loadAgentFiles,
  projectAgentDeclaresWriteTools,
} from '../dist/core/subagent/agent-file-loader.js';
import { SubagentExpertRegistry } from '../dist/core/subagent/expert-registry.js';
import { selectSubagentTools } from '../dist/core/subagent/subagent-runner.js';
import { MossAgent } from '../dist/core/agent/moss-agent.js';
import { InMemorySessionStore } from '../dist/core/session/session.js';
import { registerBuiltinTools } from '../dist/tools/builtin.js';
import { runRegistryCommand } from '../dist/cli/commands/registry.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-agents-'));
const home = path.join(root, 'home');
const workspace = path.join(root, 'ws');

function writeAgent(dir, name, body) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, body);
  return file;
}

const projectMoss = path.join(workspace, '.moss', 'agents');
const projectClaude = path.join(workspace, '.claude', 'agents');
const userMoss = path.join(home, '.moss', 'agents');
const userClaude = path.join(home, '.claude', 'agents');

writeAgent(
  projectMoss,
  'reviewer.md',
  [
    '---',
    'name: reviewer',
    'description: Reviews code from the project Moss dir.',
    'tools: Read, Grep, Glob',
    'model: sonnet',
    'permissionMode: bypassPermissions',
    'hooks:',
    '  PreToolUse:',
    '    - matcher: Bash',
    'mcpServers:',
    '  docs:',
    '    command: npx',
    'color: blue',
    '---',
    'Review only. Do not edit.',
    '',
  ].join('\n')
);
writeAgent(
  projectClaude,
  'reviewer.md',
  [
    '---',
    'name: reviewer',
    'description: Claude project copy that must lose.',
    'tools: Bash',
    '---',
    'Lose the name clash.',
    '',
  ].join('\n')
);
writeAgent(
  projectClaude,
  'writer.md',
  [
    '---',
    'name: writer',
    'description: Writes files when asked.',
    'tools: Read, Write, Edit, Bash, NotebookEdit',
    'model: sonnet',
    'disallowedTools: Bash',
    '---',
    'FILE_AGENT_MARKER write only through approval.',
    '',
  ].join('\n')
);
writeAgent(
  userMoss,
  'reviewer.md',
  [
    '---',
    'name: reviewer',
    'description: User moss copy.',
    'tools: Read',
    '---',
    'User moss.',
    '',
  ].join('\n')
);
writeAgent(
  userClaude,
  'notes.md',
  [
    '---',
    'name: notes',
    'description: User Claude notes agent.',
    'tools: [Read, Grep]',
    'model: inherit',
    '---',
    'Take notes from files.',
    '',
  ].join('\n')
);
writeAgent(
  projectMoss,
  'broken.md',
  [
    '---',
    'name: broken',
    'description: never closes',
    'tools: Read',
    'this file has no closing marker',
  ].join('\n')
);
writeAgent(
  projectMoss,
  'garbage.md',
  [
    '---',
    'name: garbage-reader',
    'description: Survives a bad frontmatter line.',
    'not a valid line',
    'tools: Read',
    '---',
    'Still loads.',
    '',
  ].join('\n')
);
writeAgent(
  projectMoss,
  'debugger.md',
  [
    '---',
    'name: debugger',
    'description: Should not shadow the built-in.',
    'tools: Read',
    '---',
    'Nope.',
    '',
  ].join('\n')
);
writeAgent(
  projectMoss,
  'editor.md',
  [
    '---',
    'name: editor',
    'description: Project Moss writer.',
    'tools: Write',
    '---',
    'Edit project files.',
    '',
  ].join('\n')
);
writeAgent(
  projectClaude,
  'claude-reader.md',
  [
    '---',
    'name: claude-reader',
    'description: Read-only Claude project agent.',
    'tools: Read',
    '---',
    'Read only.',
    '',
  ].join('\n')
);
writeAgent(
  userMoss,
  'narrowed.md',
  [
    '---',
    'name: narrowed',
    'description: Inherits tools except the denylist.',
    'disallowedTools: Write, Edit, Bash(git push *), mcp__docs',
    '---',
    'Do not write.',
    '',
  ].join('\n')
);
writeAgent(
  userMoss,
  'priced.md',
  [
    '---',
    'name: priced',
    'description: Unknown model id must not be sent.',
    'tools: Read',
    'model: claude-opus-4-20250514',
    '---',
    'Stay on the parent model.',
    '',
  ].join('\n')
);
writeAgent(
  userMoss,
  'same-model.md',
  [
    '---',
    'name: same-model',
    'description: Explicit parent model id.',
    'tools: Read',
    'model: parent-model',
    '---',
    'Use the parent model.',
    '',
  ].join('\n')
);
writeAgent(
  userMoss,
  'tiered.md',
  [
    '---',
    'name: tiered',
    'description: Tier key resolves to the configured value.',
    'tools: Read',
    'model: strong',
    '---',
    'Use the strong tier.',
    '',
  ].join('\n')
);

const loadOpts = {
  workspaceDir: workspace,
  homeDir: home,
  parentModel: 'parent-model',
  modelTiers: { strong: 'tier-strong' },
};
const loaded = loadAgentFiles(loadOpts);
assert.ok(loaded.agents.length >= 1, 'valid files load');
const byId = new Map(loaded.agents.map((agent) => [agent.id, agent]));

const reviewer = byId.get('reviewer');
assert.ok(reviewer, 'project moss reviewer loaded');
assert.equal(reviewer.agentOrigin, 'project-moss');
assert.equal(reviewer.description, 'Reviews code from the project Moss dir.');
assert.equal(reviewer.instructions, 'Review only. Do not edit.');
assert.equal(reviewer.scope, 'read-only');
assert.deepEqual(reviewer.allowedTools, ['read_file', 'search_code', 'search_files']);
assert.equal(reviewer.model, undefined, 'sonnet is not a parent model or tier value');
assert.ok(
  (reviewer.loadWarnings ?? []).some(
    (item) => item.includes('model-inherit') && item.includes('sonnet')
  ),
  'unknown alias inherits the parent model with a warning'
);
assert.equal(reviewer.fileDefined, true);
assert.ok(
  (reviewer.loadWarnings ?? []).some((item) => item.includes('permissionMode')),
  'permissionMode is warned'
);
assert.ok(
  (reviewer.loadWarnings ?? []).some((item) => item.includes('"hooks"') || item.includes('hooks')),
  'hooks are warned'
);
assert.ok(
  (reviewer.loadWarnings ?? []).some((item) => item.includes('mcpServers')),
  'mcpServers are warned'
);
assert.equal(reviewer.scope, 'read-only', 'ignored fields do not grant write tools');

assert.equal(byId.has('writer'), false, 'untrusted project Claude write agents stay unloaded');
assert.equal(byId.has('editor'), false, 'untrusted project Moss write agents stay unloaded');
assert.equal(byId.has('claude-reader'), false, 'project .claude agents need claudeOptIn');
assert.ok(
  loaded.notices.some(
    (item) => item.includes('"trust-blocked"') && item.includes('writer') && item.includes('claude')
  ),
  'writer is recorded as trust-blocked'
);
assert.ok(
  loaded.notices.some(
    (item) =>
      item.includes('"trust-blocked"') && item.includes('editor') && item.includes('workspace')
  ),
  'editor is blocked for workspace trust only'
);

const workspaceOnly = loadAgentFiles({
  ...loadOpts,
  projectTrust: { trusted: true, claudeOptIn: false },
});
assert.ok(workspaceOnly.agents.some((agent) => agent.id === 'editor'));
assert.equal(
  workspaceOnly.agents.some((agent) => agent.id === 'writer'),
  false
);
assert.equal(
  workspaceOnly.agents.some((agent) => agent.id === 'claude-reader'),
  false
);

const claudeOnly = loadAgentFiles({
  ...loadOpts,
  projectTrust: { trusted: false, claudeOptIn: true },
});
assert.ok(claudeOnly.agents.some((agent) => agent.id === 'claude-reader'));
assert.equal(
  claudeOnly.agents.some((agent) => agent.id === 'writer'),
  false
);
assert.equal(
  claudeOnly.agents.some((agent) => agent.id === 'editor'),
  false
);

const trusted = loadAgentFiles({
  ...loadOpts,
  projectTrust: { trusted: true, claudeOptIn: true },
});
const writer = trusted.agents.find((agent) => agent.id === 'writer');
assert.ok(writer, 'project claude writer loads when trusted and opted in');
assert.equal(writer.agentOrigin, 'project-claude');
assert.deepEqual(writer.allowedTools, ['read_file', 'write_file', 'edit_file']);
assert.deepEqual(writer.deniedTools, ['exec']);
assert.equal(writer.scope, 'full', 'write tools widen scope for file agents only');
assert.equal(writer.model, undefined, 'sonnet inherits the parent model');
assert.ok(
  (writer.loadWarnings ?? []).some((item) => item.includes('NotebookEdit')),
  'unknown Claude tools warn instead of crashing'
);

const notes = byId.get('notes');
assert.ok(notes, 'user claude agent loads');
assert.equal(notes.agentOrigin, 'user-claude');
assert.equal(notes.model, undefined, 'inherit leaves the parent model');

const garbage = byId.get('garbage-reader');
assert.ok(garbage, 'a bad frontmatter line warns and still loads');
assert.ok((garbage.loadWarnings ?? []).some((item) => item.includes('malformed-line')));

assert.equal(byId.has('broken'), false, 'unclosed frontmatter is not an expert');
assert.ok(
  loaded.notices.some((item) => item.includes('broken.md') && item.includes('malformed')),
  'malformed frontmatter becomes a notice'
);
assert.equal(
  loaded.notices.filter((item) => item.includes('"clash"') && item.includes('"id":"reviewer"'))
    .length,
  2,
  'project Claude and user Moss reviewer files lose to project Moss'
);

const priced = byId.get('priced');
assert.equal(priced.model, undefined, 'unknown concrete model ids are not passed through');
assert.ok((priced.loadWarnings ?? []).some((item) => item.includes('claude-opus-4-20250514')));
assert.equal(byId.get('same-model').model, 'parent-model');
assert.equal(byId.get('tiered').model, 'tier-strong');

const narrowed = byId.get('narrowed');
assert.ok(narrowed, 'omitted tools still honor disallowedTools');
assert.equal(narrowed.allowedTools, undefined);
assert.deepEqual(narrowed.deniedTools, ['write_file', 'edit_file', 'exec', 'mcp__docs']);
assert.equal(
  (narrowed.loadWarnings ?? []).some((item) => item.includes('disallowed-ignored')),
  false,
  'disallowedTools is applied instead of ignored'
);

const adopted = adoptFileAgents(trusted);
assert.equal(
  adopted.agents.some((agent) => agent.id === 'debugger'),
  false,
  'file agents do not shadow built-in experts'
);
assert.ok(adopted.notices.some((item) => item.includes('builtin-clash')));

assert.equal(projectAgentDeclaresWriteTools(writer), true);
assert.equal(projectAgentDeclaresWriteTools(reviewer), false);
assert.equal(projectAgentDeclaresWriteTools({ ...writer, agentOrigin: 'user-claude' }), false);
assert.equal(projectAgentDeclaresWriteTools(narrowed), false);

const registry = new SubagentExpertRegistry(adopted.agents);
assert.equal(registry.get('writer')?.scope, 'full');
assert.equal(registry.get('debugger')?.fileDefined, undefined, 'built-in debugger stays');
assert.throws(
  () =>
    registry.register({
      id: 'plugin-full',
      displayName: 'Plugin',
      description: 'Not from a file.',
      instructions: 'Stay read-only.',
      scope: 'full',
    }),
  /read-only scope/
);

const selected = selectSubagentTools(
  [
    { name: 'read_file', metadata: { sideEffectClass: 'readonly' } },
    { name: 'write_file', metadata: { sideEffectClass: 'local_write' } },
    { name: 'exec', metadata: { sideEffectClass: 'local_write' } },
  ],
  { scope: 'full', allowedTools: writer.allowedTools }
);
assert.deepEqual(
  selected.map((tool) => tool.name),
  ['read_file', 'write_file'],
  'file-agent allowlist keeps write_file and drops Bash after disallowedTools'
);

const narrowedSelected = selectSubagentTools(
  [
    { name: 'read_file', metadata: { sideEffectClass: 'readonly' } },
    { name: 'write_file', metadata: { sideEffectClass: 'local_write' } },
    { name: 'edit_file', metadata: { sideEffectClass: 'local_write' } },
    { name: 'exec', metadata: { sideEffectClass: 'local_write' } },
    { name: 'mcp__docs__search', metadata: { sideEffectClass: 'readonly' } },
    { name: 'mcp__other__search', metadata: { sideEffectClass: 'readonly' } },
  ],
  { scope: 'full', deniedTools: narrowed.deniedTools }
);
assert.deepEqual(
  narrowedSelected.map((tool) => tool.name),
  ['read_file', 'mcp__other__search'],
  'omitted tools plus disallowedTools removes Write, Edit, Bash(git push *), and mcp__docs'
);

const patterned = selectSubagentTools(
  [
    { name: 'exec', metadata: { sideEffectClass: 'local_write' } },
    { name: 'read_file', metadata: { sideEffectClass: 'readonly' } },
    { name: 'mcp__x__tool', metadata: { sideEffectClass: 'readonly' } },
  ],
  { scope: 'full', deniedTools: ['Bash(git push *)', 'mcp__x'] }
);
assert.deepEqual(
  patterned.map((tool) => tool.name),
  ['read_file'],
  'runner strips (...) patterns and applies mcp__ prefixes'
);

const en = formatFileAgentReport({
  experts: adopted.agents,
  notices: adopted.notices,
  zh: false,
});
assert.match(en, /Agents/);
assert.match(en, /source: .*reviewer\.md/);
assert.match(en, /would widen permissions/);
assert.match(en, /unmapped tool NotebookEdit/);
assert.match(en, /Not loaded/);
assert.match(en, /malformed frontmatter/);
const zh = formatFileAgentReport({
  experts: adopted.agents,
  notices: adopted.notices,
  zh: true,
});
assert.match(zh, /子代理/);
assert.match(zh, /来源：/);
assert.match(zh, /会放宽权限/);
assert.match(zh, /未映射工具 NotebookEdit/);
assert.match(zh, /未加载/);
assert.match(zh, /frontmatter 无效/);
const blockedReport = formatFileAgentReport({
  experts: loaded.agents,
  notices: loaded.notices,
  zh: false,
});
assert.match(blockedReport, /--trust-workspace/);
assert.match(blockedReport, /MOSS_TRUST_WORKSPACE=1/);
const blockedZh = formatFileAgentReport({
  experts: loaded.agents,
  notices: loaded.notices,
  zh: true,
});
assert.match(blockedZh, /MOSS_TRUST_WORKSPACE=1/);
assert.match(blockedZh, /工作区未信任/);

const said = [];
const commandAgent = new MossAgent({
  llmProvider: {
    id: 'agents-cmd',
    displayName: 'agents cmd',
    capabilities: { streaming: false },
    async complete() {
      return { stopReason: 'end_turn', content: [{ type: 'text', text: 'ok' }] };
    },
    async stream() {
      throw new Error('unused');
    },
  },
  sessionStore: new InMemorySessionStore(),
  domainPrompt: false,
  includeLanguagePolicyPrompt: false,
  includeAgentBehaviorPrompt: false,
  subagentExperts: adopted.agents,
  subagentExpertNotices: adopted.notices,
});
const handled = await runRegistryCommand('/agents', {
  agent: commandAgent,
  runtime: undefined,
  sessionKey: 'agents-cmd',
  workspace,
  locale: 'zh_CN',
  surface: 'repl',
  say(_kind, text) {
    said.push(text);
  },
  prefillInput() {},
});
assert.equal(handled, true);
assert.match(said.join('\n'), /子代理/);
assert.match(said.join('\n'), /会放宽权限/);
await commandAgent.close();

const requests = [];
let childCalls = 0;
let parentCalls = 0;
const approvalCalls = [];
const provider = {
  id: 'agent-file-e2e',
  displayName: 'agent file e2e',
  capabilities: { streaming: true },
  async complete() {
    throw new Error('streaming provider expected');
  },
  async stream(options, onEvent) {
    requests.push({
      model: options.model,
      systemPrompt: options.systemPrompt,
      tools: options.tools,
    });
    const child = String(options.systemPrompt).includes('FILE_AGENT_MARKER');
    let response;
    if (child) {
      childCalls += 1;
      response =
        childCalls === 1
          ? {
              stopReason: 'tool_use',
              content: [
                {
                  type: 'tool_use',
                  id: 'write-1',
                  name: 'write_file',
                  input: { path: 'secret.txt', content: 'should-not-land' },
                },
              ],
            }
          : {
              stopReason: 'end_turn',
              content: [{ type: 'text', text: 'child stopped before writing' }],
            };
    } else {
      parentCalls += 1;
      response =
        parentCalls === 1
          ? {
              stopReason: 'tool_use',
              content: [
                {
                  type: 'tool_use',
                  id: 'spawn-1',
                  name: 'create_subagent',
                  input: { task: 'Write secret.txt', expert: 'writer' },
                },
              ],
            }
          : { stopReason: 'end_turn', content: [{ type: 'text', text: 'delegated ok' }] };
    }
    onEvent({ type: 'message_start' });
    for (const block of response.content) {
      onEvent({ type: 'content_block_start' });
      if (block.type === 'text') onEvent({ type: 'content_block_delta', text: block.text });
      else onEvent({ type: 'content_block_delta', toolUse: { id: block.id, name: block.name } });
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
  model: 'parent-model',
  workspaceDir: workspace,
  baseSystemPrompt: 'Delegate to file agents.',
  domainPrompt: false,
  includeLanguagePolicyPrompt: false,
  includeAgentBehaviorPrompt: false,
  enableSteering: false,
  enableFollowUpGuard: false,
  maxAgentTurns: 6,
  subagentExperts: adopted.agents,
  hooks: {
    async onBeforeToolExec(request) {
      approvalCalls.push(request.tool.name);
      if (
        request.tool.name === 'write_file' ||
        request.tool.name === 'edit_file' ||
        request.tool.name === 'exec'
      ) {
        return { approved: false, reason: 'denied in test' };
      }
      return { approved: true };
    },
  },
});
registerBuiltinTools(agent);
const result = await agent.chat('agent-file', 'Delegate the write.');
assert.match(result.response, /delegated ok/);
assert.match(requests[0].systemPrompt, /writer.*Writes files when asked/s);
assert.ok(
  requests.some(
    (request) =>
      request.systemPrompt.includes('FILE_AGENT_MARKER') && request.model === 'parent-model'
  ),
  `child should run the mapped model (models: ${requests.map((request) => request.model).join(', ')})`
);
assert.ok(
  requests.some(
    (request) =>
      request.systemPrompt.includes('FILE_AGENT_MARKER') &&
      (request.tools ?? []).some((tool) => tool.name === 'write_file')
  ),
  'mapped Write tool is offered to the child'
);
assert.ok(
  approvalCalls.includes('write_file'),
  `write_file must hit parent approval (calls: ${approvalCalls.join(', ')})`
);
assert.equal(fs.existsSync(path.join(workspace, 'secret.txt')), false, 'denied write did not land');
await agent.close();

console.log('[PASS] file-defined sub-agents load, map tools, and still require approval');
