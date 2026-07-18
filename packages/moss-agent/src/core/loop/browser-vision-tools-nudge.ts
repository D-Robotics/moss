/**
 * BrowserVisionToolsNudge — mid-run reminder when the user asked for browser
 * or vision work but no matching tools have run yet.
 *
 * Soft: max 1 fire per run. Pairs with evaluateBrowserVisionCompletionGate.
 */

export const BROWSER_VISION_TOOLS_NUDGE_MAX_ATTEMPTS = 1;

const BROWSER_TOOLS = new Set(['web_browser_control', 'web_browser_fetch']);
const VISION_TOOLS = new Set(['vision_analyze', 'screenshot_capture']);

const BROWSER_USER_RE =
  /(?:\bbrowser\b|\bwebsite\b|\bweb page\b|click|fill (?:the )?form|登录表单|浏览器|网页)/iu;
const VISION_USER_RE =
  /(?:\bimage\b|\bphoto\b|\bpicture\b|\bvision\b|\bscreenshot\b|图片|图像|照片|截图|看图)/iu;

export interface BrowserVisionToolsNudgeRequest {
  userText: string;
  toolCallsByName: Record<string, number>;
  totalToolCalls: number;
  attempts: number;
}

export type BrowserVisionToolsNudgeResult =
  | { fire: false }
  | { fire: true; correction: string };

function countBySet(byName: Record<string, number>, names: Set<string>): number {
  let n = 0;
  for (const [name, count] of Object.entries(byName)) {
    if (names.has(name)) n += count;
  }
  return n;
}

export function evaluateBrowserVisionToolsNudge(
  request: BrowserVisionToolsNudgeRequest,
): BrowserVisionToolsNudgeResult {
  if (request.attempts >= BROWSER_VISION_TOOLS_NUDGE_MAX_ATTEMPTS) return { fire: false };
  if (request.totalToolCalls < 1) return { fire: false };

  const user = (request.userText || '').trim();
  if (!user) return { fire: false };

  const wantsBrowser = BROWSER_USER_RE.test(user);
  const wantsVision = VISION_USER_RE.test(user);
  if (!wantsBrowser && !wantsVision) return { fire: false };

  const usedBrowser = countBySet(request.toolCallsByName, BROWSER_TOOLS) > 0;
  const usedVision = countBySet(request.toolCallsByName, VISION_TOOLS) > 0;

  // Docs-only / conceptual UI questions without asking to operate a browser.
  if (
    wantsBrowser &&
    !usedBrowser &&
    /(?:what is|how does|文档|原理|介绍)/iu.test(user) &&
    !/(?:click|fill|open|navigate|登录|打开|点击)/iu.test(user)
  ) {
    // still allow vision branch below
    if (!wantsVision || usedVision) return { fire: false };
  }

  if (wantsBrowser && !usedBrowser) {
    return {
      fire: true,
      correction:
        '[System] The user asked for browser/UI interaction, but no `web_browser_control` / `web_browser_fetch` has run this turn. ' +
        'If live page actions are required, use those tools (or `web_fetch` for static HTML). ' +
        'If answering from description only, say so — do not invent clicks or form fills.',
    };
  }

  if (wantsVision && !usedVision) {
    return {
      fire: true,
      correction:
        '[System] The user asked about an image/screenshot, but no `vision_analyze` / `screenshot_capture` has run this turn. ' +
        'Call those tools for visual evidence, or clearly answer without claiming to have seen the image.',
    };
  }

  return { fire: false };
}
