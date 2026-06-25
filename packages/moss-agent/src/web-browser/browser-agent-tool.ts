/**
 * Web Browser Agent tool — exposes the WebBrowserAgent as a Tool for the Moss agent.
 *
 * The agent can call this tool with a structured browsing task definition
 * and receive the results (extracted text, links, forms, screenshots).
 *
 * @public
 */
import type { Tool } from '../core/tools/tool-types.js';
import { WebBrowserAgent, type WebBrowserAgentConfig, type WebBrowserTask, type WebBrowserResult } from './browser-agent.js';

export interface WebBrowserAgentInput {
  /** High-level goal of the browsing task. */
  goal: string;
  /** Starting URL. */
  startUrl: string;
  /** Steps to execute, as JSON array of { description, action } objects. */
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
  /** Maximum time for the entire task in ms (default 60s). */
  timeoutMs?: number;
}

function toolError(prefix: string, err: unknown): Error {
  return new Error(`${prefix}: ${err instanceof Error ? err.message : String(err)}`);
}

/**
 * Create a web browser agent tool.
 *
 * @public
 */
export function createWebBrowserAgentTool(config: WebBrowserAgentConfig = {}): Tool<WebBrowserAgentInput> {
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
          description: 'High-level goal of the browsing task (e.g., "Search for Python tutorials and extract the top 5 results").',
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
                description: 'The browser action. type can be: navigate, click, fill, select, press, scroll, wait, waitForSelector, screenshot, extract, evaluate, submit.',
                properties: {
                  type: { type: 'string', description: 'Action type.' },
                  url: { type: 'string', description: 'URL for navigate action.' },
                  selector: { type: 'string', description: 'CSS selector for click/fill/select/waitForSelector actions.' },
                  value: { type: 'string', description: 'Value for fill/select actions.' },
                  key: { type: 'string', description: 'Key name for press action.' },
                  direction: { type: 'string', enum: ['up', 'down'], description: 'Scroll direction.' },
                  amount: { type: 'number', description: 'Scroll amount in pixels.' },
                  ms: { type: 'number', description: 'Wait time in ms.' },
                  mode: { type: 'string', enum: ['text', 'html', 'links', 'forms', 'tables'], description: 'Extract mode.' },
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
        lines.push(result.success ? '[web_browser_agent: task completed]' : '[web_browser_agent: task failed]');
        lines.push(`Goal: ${task.goal}`);
        if (result.finalUrl) lines.push(`Final URL: ${result.finalUrl}`);
        if (result.durationMs) lines.push(`Duration: ${result.durationMs}ms`);

        if (result.stepResults && result.stepResults.length > 0) {
          lines.push('');
          lines.push('--- Steps ---');
          for (const sr of result.stepResults) {
            const status = sr.ok ? 'OK' : 'FAIL';
            lines.push(`  [${status}] ${sr.description}: ${sr.output.slice(0, 200)}`);
          }
        }

        if (result.extractedText) {
          lines.push('');
          lines.push('--- Extracted Text ---');
          lines.push(result.extractedText.slice(0, 10000));
        }

        if (result.links && result.links.length > 0) {
          lines.push('');
          lines.push(`--- Links (${result.links.length}) ---`);
          for (const link of result.links.slice(0, 50)) {
            lines.push(`  ${link.text}: ${link.href}`);
          }
        }

        if (result.forms && result.forms.length > 0) {
          lines.push('');
          lines.push(`--- Forms (${result.forms.length} fields) ---`);
          for (const field of result.forms) {
            lines.push(`  [${field.type}] ${field.name} (${field.selector})${field.placeholder ? ` placeholder="${field.placeholder}"` : ''}`);
          }
        }

        if (result.screenshots && result.screenshots.length > 0) {
          lines.push('');
          lines.push('--- Screenshots ---');
          for (const s of result.screenshots) {
            lines.push(`  ${s}`);
          }
        }

        if (result.error) {
          lines.push('');
          lines.push(`Error: ${result.error}`);
        }

        return lines.join('\n');
      } catch (err) {
        throw toolError('Web browser agent failed', err);
      }
    },
  };
}

/**
 * Default web browser agent tool instance.
 *
 * @public
 */
export const webBrowserAgentTool: Tool<WebBrowserAgentInput> = createWebBrowserAgentTool();
