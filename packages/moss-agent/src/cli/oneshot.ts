import path from 'node:path';
import type { MossAgent } from '../core/index.js';
import type { ToolFilter } from '../core/index.js';
import type { SkillLearner } from '../core/memory/skill-learner.js';
import { createCliRunRenderer, resolveCliDetailMode } from './output.js';
import {
  listBackgroundProcessSnapshots,
  waitForBackgroundProcessesIdle,
  type BackgroundProcSnapshot,
} from '../tools/background-exec.js';
import { isZhLocale } from './cli-locale.js';
import { exitCodeForError, ExitCode } from './exit-codes.js';
import {
  createHeadlessPrintState,
  formatHeadlessBackgroundStillRunningEvent,
  formatHeadlessInitEvent,
  formatHeadlessStreamEvent,
  formatHeadlessThrownError,
  isHeadlessResultError,
  type HeadlessOutputFormat,
  type HeadlessResultEvent,
  type HeadlessStreamEvent,
  writeHeadlessJson,
  type HeadlessJsonWriter,
} from './print.js';
import { createCliSessionKey } from './session.js';
import { SkillRegistry } from '../skills/index.js';
import { buildMatchedSkillContext, buildSkillCatalogContext, buildSkillIndexContext } from './tui-utils.js';
import { detectRoboticsDomainContext } from './domain-detection.js';
import { buildGitStatusSnapshot } from '../context/git-status-snapshot.js';
import {
  classifyUserIntent,
  intentNeedsPlanTools,
  intentNeedsWebTools,
  buildDesignIntentHandoffContext,
} from './intent-classify.js';

/** Format the oneshot exit warning when background work outlives the wait window. */
export function formatOneshotStillRunningBackgroundNotice(
  running: ReadonlyArray<Pick<BackgroundProcSnapshot, 'id' | 'command' | 'label' | 'startedAt'>>,
  options: { zh?: boolean; now?: number } = {},
): string {
  const zh = options.zh ?? false;
  const now = options.now ?? Date.now();
  if (running.length === 0) return '';
  const lines = running.slice(0, 5).map((p) => {
    const ageSec = Math.max(0, Math.round((now - p.startedAt) / 1000));
    const tag = p.label ? ` (${p.label})` : '';
    return zh
      ? `  · ${p.id}${tag} 已运行 ${ageSec}s — ${p.command}`
      : `  · ${p.id}${tag} running ${ageSec}s — ${p.command}`;
  });
  const more =
    running.length > 5
      ? zh
        ? `  · …另有 ${running.length - 5} 个`
        : `  · …and ${running.length - 5} more`
      : '';
  const header = zh
    ? `[moss] ${running.length} 个后台命令仍在运行；oneshot 退出后不再监视完成状态：`
    : `[moss] ${running.length} background command(s) still running; oneshot will not monitor them after exit:`;
  return more ? [header, ...lines, more].join('\n') : [header, ...lines].join('\n');
}

export function mossVerboseTools(): boolean {
  return resolveCliDetailMode() === 'verbose';
}

export interface RunOneShotOptions {
  sessionKey?: string;
  /** Optional host-assigned run id for deterministic audited benchmarks. */
  runId?: string;
  outputFormat?: HeadlessOutputFormat;
  headless?: boolean;
  cwd?: string;
  stdout?: HeadlessJsonWriter;
}

const BRIEF_ONE_SHOT_MAX_TURNS = 6;
const BRIEF_ONE_SHOT_MAX_TOOL_CALLS = 4;
const BRIEF_ONE_SHOT_CONTEXT = [
  'One-shot brief-answer mode:',
  '- The user explicitly requested a short answer. Prefer answering directly.',
  '- Do not use create_subagent or fan_out_subagents.',
  '- Use at most one or two targeted file/search reads, then answer with any uncertainty stated plainly.',
  '- Do not broaden into a full codebase review unless the user asks for it.',
].join('\n');

const FOCUSED_INSPECTION_CONTEXT = [
  'Focused read-only repository question:',
  '- Answer only the requested fields; do not expand into a general repository report.',
  '- Read the root manifest first. If it names the relevant workspace paths, do not list that directory.',
  '- Batch independent reads and stop as soon as each requested fact has direct evidence.',
  '- Keep the final answer under 12 lines with no table. Do not add implementation details the user did not request.',
].join('\n');

export interface FocusedInspectionRunOptions {
  maxTurns: number;
  maxToolCalls: number;
  extraContext: string;
  toolFilter?: ToolFilter;
}

export interface FastNewsRunPolicy {
  maxToolCalls: number;
  maxOutputTokens: number;
  reasoning: 'off';
  toolInputLimits: Record<string, Record<string, number>>;
  toolInputOverrides: Record<string, Record<string, string | number | boolean>>;
  extraContext: string;
}

function hasFreshNewsSignal(text: string): boolean {
  return /(?:\b(?:news|headlines|current\s+events)\b|\b(?:today(?:'s)?|latest|current)\b.{0,32}\b(?:news|headlines|updates|announcements|developments)\b|\b(?:news|headlines|updates|announcements|developments)\b.{0,32}\b(?:today(?:'s)?|latest|current)\b|(?:今天|今日|最新).{0,16}(?:新闻|热点|资讯|动态|消息|大事|头条)|(?:新闻|热点|资讯|动态|消息|大事|头条).{0,16}(?:今天|今日|最新))/iu.test(text);
}

export function verifiedNewsResearchContext(message: string): string | undefined {
  const text = message.trim();
  const newsSignal = hasFreshNewsSignal(text);
  const verificationSignal = /交叉验证|相互独立|独立来源|多个来源|原始(?:文章|报道|来源)|cross[- ]?check|cross[- ]?verify|independent sources?|multiple sources?/iu.test(text);
  if (!newsSignal || !verificationSignal) return undefined;
  return [
    'Verified current-news research contract:',
    '- A claim is cross-verified only when two independent article-level URLs support the same material fact.',
    '- Syndicated copies, portal reposts, aggregator links, and several sites repeating one wire report count as one source, not multiple independent sources.',
    '- A publisher name, search snippet, or homepage without its article-level URL is not sufficient verification evidence.',
    '- If only one attributable article supports a claim, label it a single-source lead even when that publisher is reputable.',
    '- Never invent or reconstruct a likely URL. Cite only URLs returned by tools or present in fetched content.',
    '- If the requested verification standard is not met, say so plainly rather than upgrading confidence.',
  ].join('\n');
}

export function fastNewsRunPolicy(
  message: string,
  previousUserMessage?: string,
): FastNewsRunPolicy | undefined {
  const text = message.trim();
  const newsSignal = hasFreshNewsSignal(text);
  const previousNewsSignal = previousUserMessage
    ? hasFreshNewsSignal(previousUserMessage)
    : false;
  const followUpSignal = /(?:相关的|那.+呢|还有呢|呢[？?]?$|什么信息|有什么(?:信息|动态|消息)|what about|how about|related)/iu.test(text);
  const inheritedNewsFollowUp = previousNewsSignal && followUpSignal;
  if (!newsSignal && !inheritedNewsFollowUp) return undefined;
  const researchSignal = /并行|交叉验证|相互独立|独立来源|多个来源|原始(?:文章|报道|来源)|cross[- ]?check|cross[- ]?verify|independent sources?|multiple sources?|parallel research/iu.test(text);
  if (researchSignal) return undefined;
  const oneSearch = /(?:只|仅).{0,4}搜索.{0,4}(?:一次|1次)|search (?:only )?once|one search/iu.test(text);
  const requestedCount = text.match(/(?:最多|不超过|up to|max(?:imum)?(?: of)?)\s*([1-9]|10)\s*(?:条|items?|results?)/iu);
  const maxResults = Math.min(10, Math.max(1, Number(requestedCount?.[1] ?? (oneSearch ? 5 : 6))));
  const previousText = previousUserMessage ?? '';
  const explicitDate = text.match(/\b(20\d{2}-\d{2}-\d{2})\b/u)?.[1]
    ?? previousText.match(/\b(20\d{2}-\d{2}-\d{2})\b/u)?.[1];
  return {
    maxToolCalls: 1,
    maxOutputTokens: 700,
    reasoning: 'off',
    toolInputLimits: { web_search: { max_results: maxResults } },
    toolInputOverrides: { web_search: { ...(explicitDate ? { published_on: explicitDate } : {}) } },
    extraContext: [
      inheritedNewsFollowUp ? 'Fast fresh-news follow-up:' : 'Fast fresh-news answer:',
      `- Make exactly one web_search call with max_results=${maxResults}.`,
      '- web_search internally performs multi-source and multi-query parallel retrieval. Treat that one call as the complete search batch.',
      '- Answer immediately after that result; do not browse, fetch, call web_search again, research further, or spend a long reasoning pass.',
      `- Return at most ${maxResults} items. Every item needs its own publication date and article-level URL.`,
      '- Keep the final answer under 500 Chinese characters or 350 English words. Merge duplicate coverage of the same event.',
      '- Never present an undated result, publisher homepage, aggregator redirect, or unverified search title as a confirmed current-news item.',
      '- Interpret “today” as a recent 24-hour window unless the user names an exact calendar date. Never infer the local calendar date from result dates. Say “最近约 24 小时” when results cross midnight, and show each item’s actual publication date/time.',
      ...(inheritedNewsFollowUp
        ? ['- This is a follow-up to the previous news request. Preserve its date/freshness constraint while narrowing to the new topic.']
        : []),
      '- If the result contains no reliable item published on the requested date, say that plainly.',
    ].join('\n'),
  };
}

export function focusedInspectionRunOptions(message: string): FocusedInspectionRunOptions | undefined {
  const text = message.trim();
  const intentText = text.replace(
    /(?:不要|别|禁止|无需|不许|do not|don't|without)\s*(?:修改|改动|编辑|实现|修复|change|modify|edit|implement|fix)(?:任何)?/giu,
    '',
  );
  const readOnly = /只读|read[- ]?only|不要修改|do not modify|without (?:changing|modifying)/iu.test(text);
  const boundedQuestion = /指出|列出|说明|identify|name|show me|which (?:file|command|entry)/iu.test(text);
  const repositorySignal = /monorepo|仓库|代码库|repository|codebase|package|入口|entry point|测试命令|test command/iu.test(text);
  const implementationRequest = /修复|实现|修改|重构|优化|fix|implement|change|refactor|optimi[sz]e/iu.test(intentText);
  if (!readOnly || !boundedQuestion || !repositorySignal || implementationRequest) return undefined;
  const rejectsDirectoryListing = /不要.*(?:目录树|列目录)|do not.*(?:list|print).*(?:director|tree)/iu.test(text);
  return {
    maxTurns: 4,
    maxToolCalls: 8,
    extraContext: FOCUSED_INSPECTION_CONTEXT,
    ...(rejectsDirectoryListing
      ? { toolFilter: (tool: { name: string }) => tool.name !== 'list_directory' }
      : {}),
  };
}

const ONE_SHOT_BROWSER_TOOLS = new Set([
  'web_browser_fetch',
  'web_browser_control',
  'web_browser_agent',
]);
const ONE_SHOT_VISION_TOOLS = new Set(['vision_analyze', 'screenshot_capture']);
const ONE_SHOT_SUBAGENT_TOOLS = new Set([
  'create_subagent',
  'fan_out_subagents',
  'subagent_status',
  'subagent_stop',
]);
const ONE_SHOT_BACKGROUND_TOOLS = new Set(['exec_background', 'exec_logs', 'exec_stop']);
/** Device/fleet schemas are large; only expose when board/ROS/ops is in play. */
const ONE_SHOT_DEVICE_TOOLS = new Set([
  'fleet_batch',
  'device_exec',
  'device_info',
  'device_file_read',
  'device_file_list',
  'device_temperature',
  'device_resources',
  'device_processes',
  'device_network',
  'device_cameras',
  'device_robotics_status',
]);
const ONE_SHOT_SKILL_TOOLS = new Set(['install_skill', 'skillhub_search', 'skillhub_install']);
/** plan/eval tools are large schemas and rarely needed for ordinary coding turns. */
const ONE_SHOT_PLAN_EVAL_TOOLS = new Set(['plan', 'plan_step', 'eval']);
/** Web tools: large schemas; only when the prompt needs online search/fetch. */
const ONE_SHOT_WEB_TOOLS = new Set(['web_search', 'web_fetch']);
/**
 * Pure chat / no workspace work — hide coding+web schemas so short answers
 * don't pay ~10k tool tokens of prefill on every "PONG"-style turn.
 */
const ONE_SHOT_CODING_HEAVY_TOOLS = new Set([
  'read_file',
  'write_file',
  'edit_file',
  'multi_edit',
  'move_file',
  'list_directory',
  'exec',
  'search_files',
  'search_code',
  'apply_patch',
  'code_diagnostics',
  'run_tests',
  'verify_fix',
  'todo_write',
  'ask_user_question',
  'load_skill',
  'generate_structured',
]);
const ROUTED_ONE_SHOT_TOOLS = new Set([
  ...ONE_SHOT_BROWSER_TOOLS,
  ...ONE_SHOT_VISION_TOOLS,
  ...ONE_SHOT_SUBAGENT_TOOLS,
  ...ONE_SHOT_BACKGROUND_TOOLS,
  ...ONE_SHOT_DEVICE_TOOLS,
  ...ONE_SHOT_SKILL_TOOLS,
  ...ONE_SHOT_PLAN_EVAL_TOOLS,
  ...ONE_SHOT_WEB_TOOLS,
  ...ONE_SHOT_CODING_HEAVY_TOOLS,
]);

/** True when the message looks like plain chat with no tool work. */
/**
 * A prompt is "web-eligible" if it plausibly needs live web information — not
 * just explicit "search the web" but also:
 * - time-sensitive / current-events phrasing (今天/最近/最新/发生了什么/news/events)
 * - coding-adjacent lookup (怎么用/如何实现/查文档/找方案/latest API/SDK docs/how to/
 *   报错排查) — coding often needs live docs/examples/solutions, not training memory.
 *
 * Used by isPureChatOneShotRequest (to NOT classify these as pure-chat, which
 * would hide all tools) AND by oneShotToolFilterForMessage (to enable web tools).
 * Centralized so the two stay consistent.
 */
export const WEB_ELIGIBLE_PROMPT_RE =
  /今[天日]|最近|最新|现在|当前|当下|本周|本月|今年|current|latest|recent|today|this (?:week|month|year)|now\b|大事件|新闻|动态|发生了什么|有什么新|新进展|热点|头条|速报|web_?search|web_?fetch|search the web|google|bing|搜一下|联网|网上|官网|文档站|https?:\/\/|怎么用|怎么办|怎么实现|如何使用|如何实现|查一下|查下|找一下|找下|找方案|查方案|查文档|看文档|参考文档|latest\s+api|api\s+reference|sdk\s+docs?|how\s+to\b|docs?\b|example|示例|报错|错误信息|stack\s*trace|exception/i;

export function isWebEligiblePrompt(message: string): boolean {
  return WEB_ELIGIBLE_PROMPT_RE.test(message);
}

export function isPureChatOneShotRequest(message: string): boolean {
  const text = message.trim();
  if (!text) return false;
  // Long prompts are rarely pure chat.
  if (text.length > 240) return false;
  if (/\n/.test(text) && text.length > 120) return false;
  // Coding / workspace / research signals → keep tools.
  if (
    /(?:fix|bug|implement|refactor|edit|file|path|test|build|lint|git|commit|pr\b|diff|search|grep|read|write|code|函数|文件|修复|实现|重构|测试|仓库|目录|搜索|网页|搜索一下|http|www\.|\.ts\b|\.js\b|\.py\b|package\.json|CLAUDE\.md|AGENTS\.md)/i.test(
      text,
    )
  ) {
    return false;
  }
  // Web-eligible prompts (time-sensitive, find-a-solution, lookup docs) are
  // NOT pure chat — they need tools (web_search/web_fetch), not a knowledge
  // reply. Without this, "今天的大事件呢" or "怎么用 X 库" gets classified as
  // pure chat and web tools are hidden → moss refuses with "no web tools".
  if (isWebEligiblePrompt(text)) return false;
  // Short conversational / ping patterns.
  return /^(?:hi|hello|hey|ping|pong|ok|thanks?|thank you|你好|您好|在吗|嗨|哈喽|谢谢|好的|收到)[\s!.。！？]*$/i.test(
    text,
  )
    || /reply with exactly|只回复|仅回复|回答[：:]\s*\S{1,20}$|说[：:]\s*\S{1,20}$/i.test(text)
    || (text.length <= 80 && !/[\\/`]/.test(text) && !/\b(?:run|exec|npm|pnpm|yarn|cargo|pytest)\b/i.test(text)
      && /^(?:what|who|why|how|when|where|which|is|are|can|could|do|does|请|什么|怎么|为何|是否)/i.test(text)
      && !/(?:code|file|repo|project|bug|error|stack)/i.test(text));
}

export function oneShotToolFilterForMessage(message: string): ToolFilter {
  const text = message.toLowerCase();
  const explicitlyForbidsTools = /(?:不要|别|禁止|无需|不许)(?:调用|使用|运行)?(?:任何|所有)?\s*(?:工具|tool)|(?:do not|don't|without|no)\s+(?:call|use|run|using|calling)?\s*(?:any\s+)?tools?/i.test(text);
  if (explicitlyForbidsTools) return () => false;

  // Pure chat: hide all heavy tools (model can still answer from system prompt).
  if (isPureChatOneShotRequest(message)) return () => false;

  const needsBrowser = /browser|website|web page|网页|浏览器|click|fill (?:the )?form|登录表单|登录|登陆|点击|输入用户名|交互|js 渲染|动态页面|动态网站|single[- ]?page app|spa\b|单页应用|scrape|爬取|抓取.*(?:页面|网页|内容)|rendered page/i.test(text);
  const needsVision = needsBrowser && /screenshot|截图/.test(text)
    || /image|photo|picture|vision|图片|图像|照片|截图|看图/.test(text);
  const needsSubagents =
    /sub-?agents?|fan[ -]?out|parallel (?:review|agents?|tasks?|fix(?:es)?|bugs?)|in parallel|concurrent(?:ly)?|子代理|子智能体|并行(?:审查|代理|任务|修复)|多角度|multi[- ]?angle/.test(
      text,
    ) ||
    // Single background/async child without "parallel" keyword
    /(?:background|async)\s+sub-?agent|sub-?agent\s+(?:in\s+the\s+)?background|create_subagent|subagent_status|子代理后台|后台子代理|后台跑(?:一个)?子/.test(
      text,
    ) ||
    // Open-ended codebase exploration (Claude/Codex Explore subagent path)
    /(?:how is (?:the )?(?:codebase|project|repo|code) (?:organized|structured)|architecture (?:of|overview)|explore (?:the )?(?:codebase|repo|project)|代码(?:库|仓)?(?:怎么|如何)(?:组织|架构)|架构(?:概览|梳理)|开放式探索)/i.test(
      text,
    );
  const needsBackground =
    /background|long-running|dev server|watcher|tail (?:the )?logs?|后台|长时间运行|开发服务器|监听日志|background sub-?agent|子代理后台|后台子/.test(
      text,
    );
  const needsSkillInstall =
    /install (?:a )?skill|add (?:a )?skill|load (?:a )?skill|use (?:the )?skill|安装技能|添加技能|加载技能|skillhub|技能市场|skill marketplace|from skillhub|skillhub_search|skillhub_install/.test(
      text,
    );
  const intent = classifyUserIntent(message);
  const needsPlanEval =
    intentNeedsPlanTools(intent.primary) ||
    /\bplan\b|plan_step|\beval\b|evaluation suite|benchmark suite|执行计划|评估套件|评测/.test(text);
  const needsWeb =
    intentNeedsWebTools(intent.primary) || isWebEligiblePrompt(text);
  const needsDevice =
    intent.primary === 'ops' ||
    intent.secondary.includes('ops') ||
    /\brdk\b|\bros2?\b|robot|board|device|ssh\b|机器人|开发板|板子|设备|话题|温度|BPU|相机列表/.test(
      text,
    );

  return (tool) => {
    if (!ROUTED_ONE_SHOT_TOOLS.has(tool.name)) return true;
    if (ONE_SHOT_BROWSER_TOOLS.has(tool.name)) return needsBrowser;
    if (ONE_SHOT_VISION_TOOLS.has(tool.name)) return needsVision;
    if (ONE_SHOT_SUBAGENT_TOOLS.has(tool.name)) return needsSubagents;
    if (ONE_SHOT_BACKGROUND_TOOLS.has(tool.name)) return needsBackground;
    if (ONE_SHOT_DEVICE_TOOLS.has(tool.name)) return needsDevice;
    if (ONE_SHOT_SKILL_TOOLS.has(tool.name)) return needsSkillInstall;
    if (ONE_SHOT_PLAN_EVAL_TOOLS.has(tool.name)) return needsPlanEval;
    if (ONE_SHOT_WEB_TOOLS.has(tool.name)) return needsWeb;
    // Coding-heavy tools stay available for normal coding/debug turns.
    if (ONE_SHOT_CODING_HEAVY_TOOLS.has(tool.name)) return true;
    return true;
  };
}

export function isBriefOneShotRequest(message: string): boolean {
  const text = message.trim();
  if (!text) return false;
  return /(?:简短|短答|[0-9０-９一二三四五六七八九十]+\s*行以内|控制在\s*[0-9０-９一二三四五六七八九十]+\s*行|within\s+\d+\s+lines?)/iu.test(
    text
  );
}

export async function runOneShot(
  agent: MossAgent,
  message: string,
  learner?: SkillLearner,
  options: RunOneShotOptions = {}
) {
  const sessionKey = options.sessionKey || createCliSessionKey();
  const outputFormat = options.outputFormat || 'text';
  const stdout = options.stdout ?? process.stdout;
  const workspaceDir = options.cwd ?? process.cwd();
  const renderer =
    outputFormat === 'text' ? createCliRunRenderer({ workspaceDir }) : null;

  const state = createHeadlessPrintState({
    sessionId: sessionKey,
    model: agent.config.model,
    startTime: Date.now(),
  });
  let finalResult: HeadlessResultEvent | undefined;
  let runError: unknown = undefined;
  const routedToolFilter = oneShotToolFilterForMessage(message);
    const focusedInspection = focusedInspectionRunOptions(message);
    const fastNews = fastNewsRunPolicy(message);
    const verifiedNewsContext = verifiedNewsResearchContext(message);
  const toolFilter: ToolFilter = (tool) => (
    routedToolFilter(tool) && (focusedInspection?.toolFilter?.(tool) ?? true)
  );

  function rememberStructuredResult(events: HeadlessStreamEvent[]): void {
    for (const structured of events) {
      if (structured.type === 'result') finalResult = structured;
    }
  }

  function writeStructured(events: HeadlessStreamEvent[]): void {
    for (const structured of events) {
      if (structured.type === 'result') {
        finalResult = structured;
        // Pure `json` mode: hold the final result until after the short
        // background-wait window so still-running work can be embedded.
        // `stream-json` still emits immediately and also gets a system event later.
        if (outputFormat === 'json') continue;
      }
      if (outputFormat === 'stream-json' || structured.type === 'result') {
        writeHeadlessJson(stdout, structured);
      }
    }
  }

  if (outputFormat === 'stream-json') {
    writeHeadlessJson(
      stdout,
      formatHeadlessInitEvent({
        cwd: options.cwd ?? process.cwd(),
        model: agent.config.model,
        tools: agent.tools.getAll().filter(toolFilter).map((tool) => tool.name),
        sessionId: sessionKey,
      })
    );
  }

  try {
    const brief = isBriefOneShotRequest(message);
    // Match builtin + workspace + bundled-RDK skills against the prompt and
    // inject their instructions via extraContext — previously oneshot/REPL
    // users got ZERO skill matching (only the TUI path called
    // buildMatchedSkillContext), so non-interactive users missed the code-review
    // / refactoring / documentation / etc. skill guidance entirely.
    let matchedSkillContext = '';
    let skillCatalogContext = '';
    let skillIndexContext = '';
    try {
      const registry = new SkillRegistry({ workspaceDir: options.cwd ?? process.cwd() });
      matchedSkillContext = buildMatchedSkillContext(registry, message);
      skillCatalogContext = buildSkillCatalogContext(registry, message);
      // Compact skills index when tools may be used. Pure-chat turns skip it
      // to avoid ~1–4k chars of dead prefill on "PONG"-style messages.
      if (!isPureChatOneShotRequest(message) && !isBriefOneShotRequest(message)) {
        skillIndexContext = buildSkillIndexContext(registry, { charBudget: 1_800, maxDescChars: 72 });
      }
    } catch {
      // best-effort — skill matching must not break the oneshot run.
    }
    // Inject the robotics domain prompt only when this turn shows a robotics
    // signal — office/coding tasks skip the ~5k-char engineering-method block.
    const roboticsContext = detectRoboticsDomainContext(message);
    // Fresh git status each turn (startup environment layer can go stale).
    // Skip pure chat — no workspace work, save a process spawn + prompt tokens.
    let gitSnapshot = '';
    if (!isPureChatOneShotRequest(message) && !isBriefOneShotRequest(message)) {
      try {
        gitSnapshot = await buildGitStatusSnapshot(workspaceDir);
      } catch {
        // best-effort
      }
    }
    const designHandoff = buildDesignIntentHandoffContext(message, {
      // Moss CLI does not register Ardot/canvas tools today.
      hasDesignTools: false,
    });
    const mergedExtraContext = [
      ...(brief ? [BRIEF_ONE_SHOT_CONTEXT] : []),
      ...(focusedInspection ? [focusedInspection.extraContext] : []),
      ...(fastNews ? [fastNews.extraContext] : []),
      ...(verifiedNewsContext ? [verifiedNewsContext] : []),
      ...(matchedSkillContext ? [matchedSkillContext] : []),
      ...(skillCatalogContext ? [skillCatalogContext] : []),
      ...(skillIndexContext ? [skillIndexContext] : []),
      ...(roboticsContext ? [roboticsContext] : []),
      ...(gitSnapshot ? [gitSnapshot] : []),
      ...(designHandoff ? [designHandoff] : []),
    ].join('\n\n') || undefined;
    const pureChat = isPureChatOneShotRequest(message);
    const streamOptions = brief || focusedInspection || fastNews
      ? {
          ...(options.runId ? { runId: options.runId } : {}),
          maxTurns: brief ? BRIEF_ONE_SHOT_MAX_TURNS : focusedInspection?.maxTurns,
          maxToolCalls: brief
            ? BRIEF_ONE_SHOT_MAX_TOOL_CALLS
            : fastNews?.maxToolCalls ?? focusedInspection?.maxToolCalls,
          extraContext: mergedExtraContext ?? BRIEF_ONE_SHOT_CONTEXT,
          ...(fastNews
            ? {
                reasoning: fastNews.reasoning,
                maxOutputTokens: fastNews.maxOutputTokens,
                toolInputLimits: fastNews.toolInputLimits,
                toolInputOverrides: fastNews.toolInputOverrides,
              }
            : {}),
          toolFilter,
          // Pure chat / brief: skip project AGENTS/CLAUDE.md + capability notes (~3k+ tokens).
          ...(pureChat || brief ? { omitExtraPromptLayers: true as const } : {}),
        }
      : {
          ...(options.runId ? { runId: options.runId } : {}),
          ...(mergedExtraContext ? { extraContext: mergedExtraContext } : {}),
          toolFilter,
          ...(pureChat ? { omitExtraPromptLayers: true as const } : {}),
        };
    for await (const event of agent.streamChat(sessionKey, message, streamOptions)) {
      const structuredEvents = formatHeadlessStreamEvent(state, event);
      if (outputFormat === 'text') {
        renderer?.handle(event);
        rememberStructuredResult(structuredEvents);
      } else {
        writeStructured(structuredEvents);
      }
      if (event.type === 'done') {
        if (learner && event.result?.toolCalls && event.result.toolCalls.length >= 2) {
          try {
            const messages = await agent.config.sessionStore.loadMessages(sessionKey);
            const skillPath = await learner.maybeLearnFromSession(sessionKey, messages);
            if (skillPath && mossVerboseTools() && outputFormat === 'text') {
              process.stderr.write(`\n[learned] Skill saved: ${path.basename(skillPath)}\n`);
            }
          } catch {
            
          }
        }
      }
    }
  } catch (err) {
    runError = err;
    if (outputFormat === 'text') throw err;
    writeStructured(formatHeadlessThrownError(state, err));
  }

  if (finalResult ? isHeadlessResultError(finalResult) : Boolean(state.lastError)) {
    process.exitCode = runError ? exitCodeForError(runError) : ExitCode.GENERIC;
  }

  // Give short-lived background commands a brief window so headless users see
  // completion notices before the process exits (TUI stays open so it does not need this).
  // If anything is still running after the wait, say so explicitly: oneshot will
  // not keep monitoring after process exit.
  try {
    const idle = await waitForBackgroundProcessesIdle(1_500);
    await new Promise((r) => setTimeout(r, 25));
    const running = idle
      ? []
      : listBackgroundProcessSnapshots().filter((p) => p.status === 'running');
    const notice =
      running.length > 0
        ? formatOneshotStillRunningBackgroundNotice(running, { zh: isZhLocale() })
        : '';

    if (running.length > 0 && notice) {
      if (outputFormat === 'text') {
        process.stderr.write(`${notice}\n`);
      } else if (outputFormat === 'stream-json') {
        // Live stream already emitted result earlier; add an explicit system event.
        writeHeadlessJson(
          stdout,
          formatHeadlessBackgroundStillRunningEvent({
            sessionId: sessionKey,
            message: notice,
            processes: running.map((p) => ({
              id: p.id,
              command: p.command,
              label: p.label,
              startedAt: p.startedAt,
            })),
          }),
        );
      }
    }

    // Pure json: emit the held final result after the wait, optionally embedding
    // still-running background metadata for hosts that only read the result event.
    if (outputFormat === 'json' && finalResult) {
      if (running.length > 0 && notice) {
        finalResult = {
          ...finalResult,
          background_still_running: {
            message: notice,
            will_monitor_after_exit: false,
            processes: running.map((p) => ({
              id: p.id,
              command: p.command,
              ...(p.label ? { label: p.label } : {}),
              started_at: p.startedAt,
              running_for_ms: Math.max(0, Date.now() - p.startedAt),
            })),
          },
        };
      }
      writeHeadlessJson(stdout, finalResult);
    }
  } catch {
    /* best-effort */
    if (outputFormat === 'json' && finalResult) {
      try {
        writeHeadlessJson(stdout, finalResult);
      } catch {
        /* ignore */
      }
    }
  } finally {
    try {
      renderer?.dispose?.();
    } catch {
      /* ignore */
    }
  }
}
