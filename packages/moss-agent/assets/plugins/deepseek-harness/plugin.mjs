import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const skillUrl = new URL('./skills/deepseek-harness/SKILL.md', import.meta.url);

export default {
  id: 'deepseek/harness',
  async setup(context) {
    const sourcePath = fileURLToPath(skillUrl);
    const source = await readFile(skillUrl, 'utf8');
    const body = source.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim();
    context.registerSkill({
      stableId: 'deepseek-harness',
      name: 'deepseek-harness',
      description: 'Apply the DeepSeek V4 API protocol rules for safe reasoning and tool loops.',
      summary:
        'DeepSeek V4 protocol guidance for reasoning_content, streaming tools, token caps, cache stability, and endpoint selection.',
      sourcePath,
      version: '0.2.0',
      tags: ['deepseek', 'api', 'reasoning', 'streaming', 'tool-calls'],
      trigger: [
        'deepseek',
        'deepseek-v4-pro',
        'deepseek-v4-flash',
        'deepseek-chat',
        'deepseek-reasoner',
        'reasoning_content',
        '深度求索',
      ],
      risk: 'low',
      permissions: { workspaceRead: true },
      enabled: true,
      updatedAt: 0,
      body,
    });
    context.registerCommand({
      id: 'deepseek-protocol',
      title: 'Apply DeepSeek protocol guidance',
      description:
        'Inject the reviewed DeepSeek V4 reasoning, streaming, token, cache, and tool-loop rules.',
      expand(args) {
        const task = args.trim();
        return [
          'Apply the installed deepseek-harness skill and its protocol checks to this request.',
          task || 'Inspect the active DeepSeek provider integration and report protocol risks.',
        ].join('\n\n');
      },
    });
    context.registerMcpPreset({
      id: 'deepseek-harness',
      displayName: 'DeepSeek Harness protocol tools',
      server: {
        command: 'npx',
        args: ['-y', '@deepseek-harness/mcp@0.2.0'],
        requestTimeoutMs: 30_000,
      },
    });
  },
};
