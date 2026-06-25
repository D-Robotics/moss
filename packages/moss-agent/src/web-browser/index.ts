/**
 * Web Browser Agent module — autonomous browser automation for the Moss agent.
 *
 * Extends the existing browser-tools (Puppeteer-based) with a higher-level
 * browsing agent that can navigate, interact, extract data, and take screenshots
 * as part of an autonomous agent workflow.
 *
 * @module web-browser
 * @public
 */
export {
  WebBrowserAgent,
  type WebBrowserAgentConfig,
  type WebBrowserTask,
  type WebBrowserStep,
  type WebBrowserResult,
  type BrowserAction,
} from './browser-agent.js';

export {
  createWebBrowserAgentTool,
  webBrowserAgentTool,
  type WebBrowserAgentInput,
} from './browser-agent-tool.js';

export {
  buildWebBrowserSystemPrompt,
  type WebBrowserPromptOptions,
} from './browser-prompt.js';
