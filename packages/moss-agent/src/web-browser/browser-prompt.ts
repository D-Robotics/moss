export interface WebBrowserPromptOptions {
  browserEnabled?: boolean;

  browserFetchEnabled?: boolean;
}

export function buildWebBrowserSystemPrompt(options: WebBrowserPromptOptions = {}): string {
  if (!options.browserEnabled) return '';

  const lines: string[] = [];

  lines.push('## Browser Automation Capability');
  lines.push('');
  lines.push('You have access to browser automation tools for interacting with web pages:');
  lines.push('');

  if (options.browserFetchEnabled) {
    lines.push(
      '- `web_browser_fetch` — Fetch and extract visible text from a web page using a real browser (handles JavaScript-rendered content).'
    );
    lines.push(
      '- `web_browser_control` — Drive a browser with ordered steps (goto, click, fill, press, wait, screenshot, text).'
    );
  }

  lines.push(
    '- `web_browser_agent` — Execute a structured multi-step browser automation task with navigation, interaction, and content extraction.'
  );
  lines.push('');

  lines.push('**When to use browser automation:**');
  lines.push('- The target page requires JavaScript to render content (SPAs, dynamic apps)');
  lines.push('- You need to interact with a page (login, search, fill forms, click buttons)');
  lines.push('- You need to extract structured data from multiple pages');
  lines.push('- The user asks you to "browse to", "open this site", "test this web app"');
  lines.push('- You need screenshots of web pages for visual analysis');
  lines.push('');

  lines.push('**When NOT to use browser automation:**');
  lines.push('- Simple static page content → use `web_fetch` (faster, lighter)');
  lines.push('- API data → use `web_fetch` with JSON endpoints');
  lines.push('- Search queries → use `web_search` for search engine results');
  lines.push('');

  lines.push('**Best practices:**');
  lines.push('- Break complex browsing tasks into clear, sequential steps');
  lines.push('- Always wait for selectors to appear before interacting with them');
  lines.push(
    '- Use `extract` mode to get structured data (text, links, forms) from the final page'
  );
  lines.push('- Take screenshots when you need to visually verify page state');
  lines.push('- Set reasonable timeouts for slow-loading pages');
  lines.push('');

  return lines.join('\n');
}
