import type { Tool } from '../core/tools/tool-types.js';
import {
  WebBrowserAgent,
  type WebBrowserAgentConfig,
  type WebBrowserTask,
  type WebBrowserResult,
} from './browser-agent.js';
import { errorMessage } from '../errors.js';

export interface WebBrowserAgentInput {
  goal: string;

  startUrl: string;

  steps?: Array<{
    description: string;
    action: {
      type: string;
      url?: string;
      selector?: string;
      value?: string;
      key?: string;
      direction?: string;
      amount?: number;
      ms?: number;
      mode?: string;
      script?: string;
      path?: string;
      fullPage?: boolean;
      waitUntil?: string;
      timeoutMs?: number;
    };
  }>;

  timeoutMs?: number;
}

function toolError(prefix: string, err: unknown): Error {
  return new Error(`${prefix}: ${errorMessage(err)}`);
}

export function createWebBrowserAgentTool(
  config: WebBrowserAgentConfig = {}
): Tool<WebBrowserAgentInput> {
  const agent = new WebBrowserAgent(config);

  return {
    name: 'web_browser_agent',
    description:
      'Execute a multi-step browser automation task. ' +
      'Navigate to pages, click elements, fill forms, extract content, and take screenshots. ' +
      'Use this when you need to interact with a website beyond simple fetching — ' +
      'e.g., logging in, searching, filling forms, scraping dynamic content, or testing web apps. ' +
      'Provide a goal, starting URL, and ordered steps. Each step describes one browser action.',
    metadata: {
      sideEffectClass: 'external_message',
      planMode: 'requires_user_confirmation',
      timeoutMs: 120_000,
    },
    inputSchema: {
      type: 'object',
      properties: {
        goal: {
          type: 'string',
          description:
            'High-level goal of the browsing task (e.g., "Search for Python tutorials and extract the top 5 results").',
        },
        startUrl: {
          type: 'string',
          description: 'Starting URL to navigate to.',
        },
        steps: {
          type: 'array',
          description: 'Ordered list of browser actions to perform.',
          items: {
            type: 'object',
            properties: {
              description: { type: 'string', description: 'What this step does.' },
              action: {
                type: 'object',
                description:
                  'The browser action. type can be: navigate, click, fill, select, press, scroll, wait, waitForSelector, screenshot, extract, evaluate, submit.',
                properties: {
                  type: { type: 'string', description: 'Action type.' },
                  url: { type: 'string', description: 'URL for navigate action.' },
                  selector: {
                    type: 'string',
                    description: 'CSS selector for click/fill/select/waitForSelector actions.',
                  },
                  value: { type: 'string', description: 'Value for fill/select actions.' },
                  key: { type: 'string', description: 'Key name for press action.' },
                  direction: {
                    type: 'string',
                    enum: ['up', 'down'],
                    description: 'Scroll direction.',
                  },
                  amount: { type: 'number', description: 'Scroll amount in pixels.' },
                  ms: { type: 'number', description: 'Wait time in ms.' },
                  mode: {
                    type: 'string',
                    enum: ['text', 'html', 'links', 'forms', 'tables'],
                    description: 'Extract mode.',
                  },
                  script: { type: 'string', description: 'JavaScript to evaluate.' },
                  path: { type: 'string', description: 'Screenshot file path.' },
                  fullPage: { type: 'boolean', description: 'Full page screenshot.' },
                },
                required: ['type'],
              },
            },
            required: ['description', 'action'],
          },
        },
        timeoutMs: {
          type: 'number',
          description: 'Maximum time for the entire task in ms (default 60s).',
        },
      },
      required: ['goal', 'startUrl'],
    },
    async execute(input, _ctx) {
      try {
        const steps = (input.steps ?? []).map((s) => ({
          description: s.description,
          action: {
            ...s.action,
            type: s.action.type,
          } as any,
        }));

        const task: WebBrowserTask = {
          goal: input.goal,
          startUrl: input.startUrl,
          steps,
          timeoutMs: input.timeoutMs,
        };

        const result: WebBrowserResult = await agent.executeTask(task);

        const lines: string[] = [];
        if (result.success) {
          lines.push('[web_browser_agent_ok]');
          lines.push('✓ Task completed successfully');
        } else {
          lines.push('[web_browser_agent_error]');
          lines.push('✗ Task failed');
        }
        lines.push(`Goal: ${task.goal}`);
        if (result.finalUrl) lines.push(`Final URL: ${result.finalUrl}`);
        if (result.durationMs) lines.push(`Duration: ${result.durationMs}ms`);

        if (result.stepResults && result.stepResults.length > 0) {
          lines.push('');
          lines.push('Step Results:');
          for (const sr of result.stepResults) {
            const icon = sr.ok ? '  ✓' : '  ✗';
            lines.push(`${icon} ${sr.description}`);
            if (!sr.ok || sr.output) {
              lines.push(`    ${sr.output.slice(0, 200)}`);
            }
          }
        }

        if (result.extractedText && result.extractedText.trim()) {
          lines.push('');
          lines.push('Extracted Text:');
          lines.push(result.extractedText.slice(0, 10000));
        }

        if (result.links && result.links.length > 0) {
          lines.push('');
          lines.push(`Links (${result.links.length} total, showing first 50):`);
          for (const link of result.links.slice(0, 50)) {
            lines.push(`  • ${link.text}: ${link.href}`);
          }
        }

        if (result.forms && result.forms.length > 0) {
          lines.push('');
          lines.push(`Forms (${result.forms.length} fields):`);
          for (const field of result.forms) {
            const placeholder = field.placeholder ? ` [${field.placeholder}]` : '';
            lines.push(`  • [${field.type}] ${field.name}${placeholder}`);
          }
        }

        if (result.screenshots && result.screenshots.length > 0) {
          lines.push('');
          lines.push('Screenshots:');
          for (const s of result.screenshots) {
            lines.push(`  📷 ${s}`);
          }
        }

        if (result.error) {
          lines.push('');
          lines.push(`Error Details: ${result.error}`);
        }

        return lines.join('\n');
      } catch (err) {
        throw toolError('Web browser agent failed', err);
      }
    },
  };
}

export const webBrowserAgentTool: Tool<WebBrowserAgentInput> = createWebBrowserAgentTool();
