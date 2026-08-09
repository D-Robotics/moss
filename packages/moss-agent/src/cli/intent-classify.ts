/**
 * Lightweight user-turn intent classification for tool/skill routing.
 *
 * Pure heuristics (no LLM). Used by oneshot/TUI to:
 * - keep pure chat light (existing isPureChatOneShotRequest)
 * - enable web / plan / ops / subagent tools when signals match
 * - leave coding tools available for engineering work
 *
 * Not a hard state machine — the agent loop still decides; this only shapes
 * host-side tool filters and prompt budgets.
 */

export type IntentClass = 'chat' | 'coding' | 'debug' | 'research' | 'ops' | 'design' | 'plan_only';

export type IntentConfidence = 'high' | 'medium' | 'low';

export interface IntentClassification {
  primary: IntentClass;
  /** Secondary tags that also matched (for logging / skill suggestions). */
  secondary: IntentClass[];
  confidence: IntentConfidence;
}

const DEBUG_RE =
  /(?:\bfix\b|\bbug\b|repair|patch|crash|stack\s*trace|exception|error|fail(?:ed|ing|ure)?|报错|失败|崩溃|异常|修复|修一下|定位)/iu;

const CODING_RE =
  /(?:implement|refactor|optimi[sz]e|edit|write|code|file|path|test|build|lint|typecheck|git|commit|pr\b|diff|migrate|feature|函数|文件|实现|重构|测试|仓库|目录|\.ts\b|\.js\b|\.py\b|package\.json)/iu;

const RESEARCH_RE =
  /(?:web_?search|web_?fetch|search the web|google|bing|docs?\.|documentation|官网|文档|联网|网上|搜一下|查(一下|下).*(新闻|资料|文档)|https?:\/\/|latest|新闻|资料)/iu;

const OPS_RE =
  /(?:\brdk\b|\bros2?\b|robot|board|device|ssh|串口|机器人|开发板|板子|设备|话题|节点|ros2)/iu;

const DESIGN_RE =
  /(?:ardot|design system|ui design|figma|画布|设计稿|页面设计|组件库|视觉|icon set|layout mock)/iu;

const PLAN_RE =
  /(?:\bplan\b|roadmap|proposal|architecture decision|执行计划|方案设计|怎么拆|分阶段|里程碑|plan_step|评测|benchmark suite)/iu;

const CHAT_RE =
  /^(?:hi|hello|hey|ping|pong|ok|thanks?|thank you|你好|您好|在吗|嗨|哈喽|谢谢|好的|收到)[\s!.。！？]*$/iu;

/**
 * Classify a user message into a primary intent for host routing.
 * Longer / multi-signal messages get medium confidence and secondary tags.
 */
export function classifyUserIntent(message: string): IntentClassification {
  const text = (message || '').trim();
  if (!text) {
    return { primary: 'chat', secondary: [], confidence: 'low' };
  }

  const hits: IntentClass[] = [];
  if (DEBUG_RE.test(text)) hits.push('debug');
  if (CODING_RE.test(text)) hits.push('coding');
  if (RESEARCH_RE.test(text)) hits.push('research');
  if (OPS_RE.test(text)) hits.push('ops');
  if (DESIGN_RE.test(text)) hits.push('design');
  if (PLAN_RE.test(text) && !/(?:implement|写代码|改代码|fix the|修复)/iu.test(text)) {
    hits.push('plan_only');
  } else if (PLAN_RE.test(text)) {
    hits.push('coding');
  }

  // Short pure chat
  if (hits.length === 0) {
    if (CHAT_RE.test(text) || text.length <= 40) {
      return { primary: 'chat', secondary: [], confidence: 'high' };
    }
    // Generic questions default to research if webby, else coding-ish medium
    if (
      /^(?:what|who|why|how|when|where|which|请|什么|怎么|为何)/iu.test(text) &&
      text.length < 200
    ) {
      return { primary: 'research', secondary: [], confidence: 'low' };
    }
    return { primary: 'coding', secondary: [], confidence: 'low' };
  }

  // Priority: debug > design > research > ops > plan_only > coding
  // Research beats ops when the message is explicitly web/docs research about
  // robotics (e.g. "search the web for ROS2 release notes") so web tools route on.
  const order: IntentClass[] = ['debug', 'design', 'research', 'ops', 'plan_only', 'coding'];
  let primary: IntentClass = hits[0]!;
  for (const p of order) {
    if (hits.includes(p)) {
      primary = p;
      break;
    }
  }

  const secondary = hits.filter((h) => h !== primary);
  const confidence: IntentConfidence =
    hits.length === 1 && text.length < 400 ? 'high' : hits.length >= 2 ? 'medium' : 'medium';

  return { primary, secondary, confidence };
}

/** Whether this intent typically needs coding mutation tools. */
export function intentNeedsCodingTools(intent: IntentClass): boolean {
  return intent === 'coding' || intent === 'debug' || intent === 'ops';
}

/** Whether this intent typically needs web tools. */
export function intentNeedsWebTools(intent: IntentClass): boolean {
  return intent === 'research';
}

/** Whether this intent is plan/architecture without immediate implement. */
export function intentNeedsPlanTools(intent: IntentClass): boolean {
  return intent === 'plan_only';
}

/**
 * Soft dynamic-context note when the user asks for canvas/UI design work but
 * this Moss session has no design-canvas tools registered.
 * Empty string when not design intent (or when design tools are available).
 */
export function buildDesignIntentHandoffContext(
  message: string,
  options?: { hasDesignTools?: boolean }
): string {
  const intent = classifyUserIntent(message);
  if (intent.primary !== 'design' && !intent.secondary.includes('design')) {
    return '';
  }
  if (options?.hasDesignTools) return '';
  return [
    '## Design intent (no canvas tools in this session)',
    'The user asked for UI/design-canvas style work (Figma-like).',
    'This Moss CLI session does **not** register design-canvas tools.',
    'Do **not** pretend a canvas was updated.',
    'Instead:',
    '1. Offer a **code-only** path (HTML/CSS/React components in the workspace) if that can still help, or',
    "2. State clearly that canvas design belongs in the host's design-canvas tool, and give a one-line handoff, or",
    '3. Ask one clarifying question if either path needs a decision.',
    'Prefer a short structured reply over inventing design-tool calls.',
  ].join('\n');
}
