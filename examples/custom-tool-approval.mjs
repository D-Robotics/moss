#!/usr/bin/env node
// Embedding example 3/3: custom tools with approval hooks and an audit
// trail. The mock model asks to archive a note (local_write) and then to
// delete it (destructive). onBeforeToolExec approves the archive, rejects
// the delete; onToolResult logs every execution. Offline:
// `node examples/custom-tool-approval.mjs`
import { MossAgent } from '../dist/core/agent/moss-agent.js';
import { InMemorySessionStore } from '../dist/core/session/session.js';

const audit = [];

const provider = {
  id: 'scripted',
  displayName: 'scripted (offline)',
  capabilities: { streaming: true },
  calls: 0,
  async complete() {
    this.calls += 1;
    if (this.calls === 1) {
      return {
        stopReason: 'tool_use',
        content: [
          { type: 'tool_use', id: 'call-1', name: 'archive_note', input: { note: 'ship it' } },
        ],
      };
    }
    if (this.calls === 2) {
      return {
        stopReason: 'tool_use',
        content: [{ type: 'tool_use', id: 'call-2', name: 'purge_archive', input: {} }],
      };
    }
    return {
      stopReason: 'end_turn',
      content: [{ type: 'text', text: 'archive kept; purge was blocked by policy.' }],
    };
  },
  async stream(options, onEvent) {
    const response = await this.complete();
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
  baseSystemPrompt: 'You manage the note archive.',
  domainPrompt: false,
  enableSteering: false,
  enableFollowUpGuard: false,
  hooks: {
    async onBeforeToolExec(request) {
      if (request.tool.name === 'purge_archive') {
        console.log(`[approval] DENY ${request.tool.name}: destructive and not allowed here`);
        return { approved: false, reason: 'purge is destructive; this host forbids it' };
      }
      console.log(`[approval] ALLOW ${request.tool.name}`);
      return { approved: true };
    },
    onToolResult(call, result) {
      audit.push({ tool: call.name, blocked: Boolean(result.isError) });
    },
  },
});

agent.tools.register({
  name: 'archive_note',
  description: 'Archive a note for later retrieval.',
  metadata: { sideEffectClass: 'local_write' },
  inputSchema: {
    type: 'object',
    properties: { note: { type: 'string' } },
    required: ['note'],
  },
  async execute(input) {
    return `archived: ${input.note}`;
  },
});
agent.tools.register({
  name: 'purge_archive',
  description: 'Delete everything in the archive.',
  metadata: { sideEffectClass: 'destructive', requiresApproval: true },
  inputSchema: { type: 'object', properties: {} },
  async execute() {
    return 'purged';
  },
});

const result = await agent.chat('approval-demo', 'Archive "ship it", then purge the archive.');
console.log(`\nfinal response: ${result.response}`);
console.log('audit trail:', JSON.stringify(audit));
await agent.close();
