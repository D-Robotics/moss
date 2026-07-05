import type { GoalState } from './goal-state.js';

export type GoalCommandAction =
  | 'status'
  | 'set'
  | 'pause'
  | 'resume'
  | 'complete'
  | 'block'
  | 'clear';

export type GoalCommandEvent =
  | 'goal_status'
  | 'goal_set'
  | 'goal_paused'
  | 'goal_resumed'
  | 'goal_completed'
  | 'goal_blocked'
  | 'goal_cleared';

export interface ParsedGoalCommand {
  handled: boolean;
  action?: GoalCommandAction;
  objective?: string;
  reason?: string;
  error?: string;
}

export interface GoalCommandResult {
  handled: boolean;
  action?: GoalCommandAction;
  event?: GoalCommandEvent;
  goal?: GoalState;
  replaced?: boolean;
  message: string;
  error?: string;
}

export interface GoalCommandAgent {
  getGoal(sessionKey: string): Promise<GoalState | undefined>;
  setGoal(sessionKey: string, objective: string): Promise<GoalState>;
  pauseGoal(sessionKey: string, reason?: string): Promise<GoalState | undefined>;
  resumeGoal(sessionKey: string): Promise<GoalState | undefined>;
  completeGoal(sessionKey: string, reason?: string): Promise<GoalState | undefined>;
  blockGoal(sessionKey: string, reason?: string): Promise<GoalState | undefined>;
  clearGoal(sessionKey: string): Promise<void>;
}

export interface GoalCommandOptions {
  locale?: string;
}

export interface HandleGoalCommandParams extends GoalCommandOptions {
  agent: GoalCommandAgent;
  sessionKey: string;
  input: string;
}

const GOAL_COMMAND_RE = /^\/goal(?::|：|\s|$)/i;
const EMPTY_MESSAGE = '';

function startsWithZh(locale?: string): boolean {
  return Boolean(locale && locale.toLowerCase().startsWith('zh'));
}

function eventForAction(action?: GoalCommandAction): GoalCommandEvent | undefined {
  switch (action) {
    case 'status':
      return 'goal_status';
    case 'set':
      return 'goal_set';
    case 'pause':
      return 'goal_paused';
    case 'resume':
      return 'goal_resumed';
    case 'complete':
      return 'goal_completed';
    case 'block':
      return 'goal_blocked';
    case 'clear':
      return 'goal_cleared';
    default:
      return undefined;
  }
}

function goalStatusLabel(goal: GoalState, locale?: string): string {
  if (!startsWithZh(locale)) return goal.status;
  switch (goal.status) {
    case 'active':
      return '进行中';
    case 'paused':
      return '已暂停';
    case 'completed':
      return '已完成';
    case 'blocked':
      return '已阻塞';
    default:
      return goal.status;
  }
}

function statusMessage(goal: GoalState | undefined, locale?: string): string {
  if (!goal) {
    return startsWithZh(locale) ? '当前会话没有设置目标。' : 'No goal is set for this session.';
  }
  const reason = goal.statusReason
    ? startsWithZh(locale)
      ? ` 原因：${goal.statusReason}`
      : ` Reason: ${goal.statusReason}`
    : '';
  if (startsWithZh(locale)) {
    return `当前目标（${goalStatusLabel(goal, locale)}）：${goal.objective}${reason}`;
  }
  return `Current goal (${goalStatusLabel(goal, locale)}): ${goal.objective}${reason}`;
}

function actionMessage(
  action: GoalCommandAction,
  goal: GoalState | undefined,
  locale?: string,
  extra?: { replaced?: boolean; reason?: string }
): string {
  const zh = startsWithZh(locale);
  switch (action) {
    case 'set': {
      const verb = extra?.replaced
        ? zh
          ? '已替换目标'
          : 'Goal replaced'
        : zh
          ? '已设置目标'
          : 'Goal set';
      const objective = goal?.objective ?? '';
      
      
      return zh
        ? `${verb}：${objective}\n我会每轮持续推进这个目标，直到你用 /goal complete 标记完成、/goal block 标记阻塞，或 /goal clear 清除。/goal 查看状态，/goal pause 暂停自动推进。`
        : `${verb}: ${objective}\nI'll keep working toward it each turn until you /goal complete it, /goal block it, or /goal clear it. Use /goal to check status, /goal pause to pause auto-continuation.`;
    }
    case 'pause':
      if (zh) return `目标已暂停：${goal?.objective ?? ''}`;
      return `Goal paused: ${goal?.objective ?? ''}`;
    case 'resume':
      if (zh) return `目标已恢复：${goal?.objective ?? ''}`;
      return `Goal resumed: ${goal?.objective ?? ''}`;
    case 'complete':
      if (zh) return `目标已完成：${goal?.objective ?? ''}`;
      return `Goal completed: ${goal?.objective ?? ''}`;
    case 'block':
      if (zh) return `目标已标记为阻塞：${goal?.objective ?? ''}`;
      return `Goal blocked: ${goal?.objective ?? ''}`;
    case 'clear':
      if (zh) return '目标已清除。';
      return 'Goal cleared.';
    case 'status':
      return statusMessage(goal, locale);
  }
}

function errorMessage(error: string, locale?: string): string {
  if (!startsWithZh(locale)) return error;
  switch (error) {
    case 'Goal objective must not be empty.':
      return '目标不能为空。';
    case 'No goal is set for this session.':
      return '当前会话没有设置目标。';
    default:
      return error;
  }
}

function parseNoArgAction(action: GoalCommandAction, tail: string): ParsedGoalCommand {
  if (tail) {
    return {
      handled: true,
      action,
      error: `/goal ${action} does not accept arguments.`,
    };
  }
  return { handled: true, action };
}

// Vague-verb + generic-target pattern. Catches goals like "fix it",
// "make it better", "improve this", "work on it", "refactor everything",
// "clean up stuff" — a vague verb with no concrete target. Concrete goals
// (incl. short CJK goals like "修复登录bug") don't match and pass through.
const VAGUE_GOAL_RE =
  /\b(?:make|fix|improve|work\s+on|do|handle|update|refactor|optimize|optimise|clean\s+up|sort\s+out)\b.{0,30}\b(?:it|this|that|everything|everyone|stuff|things|anything|something|better)\b/i;

/**
 * If the objective is too vague to run against autonomously, return a
 * clarification message; otherwise return undefined and let the caller set
 * the goal. The bar is deliberately high (only flags vague-verb + pronoun
 * forms) so legitimate short or CJK goals are not blocked.
 */
export function assessGoalVagueness(objective: string): string | undefined {
  const trimmed = objective.trim();
  if (!trimmed) return undefined;
  if (!VAGUE_GOAL_RE.test(trimmed)) return undefined;
  return [
    `This goal looks too broad to run autonomously: "${trimmed}".`,
    'Before I start, narrow it down — tell me:',
    '  • the concrete success state (what observable result means "done")',
    '  • which files, module, or area to touch',
    '  • any constraints (must not change X, keep public API, etc.)',
    'Re-issue: /goal set <a more specific objective>',
    'Example: /goal set add an OAuth login page to web/ that uses Google, with a passing integration test',
  ].join('\n');
}

export function isGoalCommand(input: string): boolean {
  return GOAL_COMMAND_RE.test(String(input ?? '').trimStart());
}

export function parseGoalCommand(input: string): ParsedGoalCommand {
  const trimmed = String(input ?? '').trim();
  if (!isGoalCommand(trimmed)) return { handled: false };

  const rest = trimmed.replace(/^\/goal(?::|：)?/i, '').trim();
  if (!rest) return { handled: true, action: 'status' };

  const [rawAction = '', ...parts] = rest.split(/\s+/);
  const action = rawAction.toLowerCase();
  const tail = parts.join(' ').trim();

  switch (action) {
    case 'status':
      return parseNoArgAction('status', tail);
    case 'set':
      if (!tail) {
        return {
          handled: true,
          action: 'set',
          error: 'Goal objective must not be empty.',
        };
      }
      return { handled: true, action: 'set', objective: tail };
    case 'pause':
      return { handled: true, action: 'pause', reason: tail || undefined };
    case 'resume':
      return parseNoArgAction('resume', tail);
    case 'complete':
      return { handled: true, action: 'complete', reason: tail || undefined };
    case 'block':
      return { handled: true, action: 'block', reason: tail || undefined };
    case 'clear':
      return parseNoArgAction('clear', tail);
    default:
      return { handled: true, action: 'set', objective: rest };
  }
}

export function formatGoalCommandResult(result: GoalCommandResult, locale?: string): string {
  if (!result.handled) return EMPTY_MESSAGE;
  if (result.error) return errorMessage(result.error, locale);
  if (!result.action) return result.message;
  if (result.action === 'status') return statusMessage(result.goal, locale);
  return actionMessage(result.action, result.goal, locale, { replaced: result.replaced });
}

export async function executeGoalCommand(
  agent: GoalCommandAgent,
  sessionKey: string,
  parsedCommand: ParsedGoalCommand,
  options?: GoalCommandOptions
): Promise<GoalCommandResult> {
  const locale = options?.locale;
  if (!parsedCommand.handled) {
    return { handled: false, message: EMPTY_MESSAGE };
  }

  if (parsedCommand.error) {
    return {
      handled: true,
      action: parsedCommand.action,
      event: eventForAction(parsedCommand.action),
      message: errorMessage(parsedCommand.error, locale),
      error: parsedCommand.error,
    };
  }

  const action = parsedCommand.action;
  if (!action) {
    const error = 'Goal command action is missing.';
    return { handled: true, message: errorMessage(error, locale), error };
  }

  try {
    if (action === 'status') {
      const goal = await agent.getGoal(sessionKey);
      const result: GoalCommandResult = {
        handled: true,
        action,
        event: eventForAction(action),
        goal,
        message: statusMessage(goal, locale),
      };
      return result;
    }

    if (action === 'set') {
      const objective = parsedCommand.objective ?? '';
      // Refuse to commit a vague goal and ask the user to clarify instead —
      // running autonomously against "fix it" / "make it better" wastes a goal
      // auto-run on a direction the model has to guess. The heuristic is
      // deliberately narrow (vague verb + generic pronoun/target, no concrete
      // noun) so concrete goals — including short CJK goals like "修复登录bug" —
      // pass through untouched. The user re-issues /goal set with more detail.
      const vagueness = assessGoalVagueness(objective);
      if (vagueness) {
        return {
          handled: true,
          action,
          message: vagueness,
        };
      }
      const existing = await agent.getGoal(sessionKey);
      const goal = await agent.setGoal(sessionKey, objective);
      return {
        handled: true,
        action,
        event: eventForAction(action),
        goal,
        replaced: Boolean(existing),
        message: actionMessage(action, goal, locale, { replaced: Boolean(existing) }),
      };
    }

    if (action === 'clear') {
      await agent.clearGoal(sessionKey);
      return {
        handled: true,
        action,
        event: eventForAction(action),
        message: actionMessage(action, undefined, locale),
      };
    }

    const goal = await executeTransition(agent, sessionKey, action, parsedCommand.reason);
    if (!goal) {
      const error = 'No goal is set for this session.';
      return {
        handled: true,
        action,
        event: eventForAction(action),
        message: errorMessage(error, locale),
        error,
      };
    }

    return {
      handled: true,
      action,
      event: eventForAction(action),
      goal,
      message: actionMessage(action, goal, locale, { reason: parsedCommand.reason }),
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return {
      handled: true,
      action,
      event: eventForAction(action),
      message: errorMessage(error, locale),
      error,
    };
  }
}

async function executeTransition(
  agent: GoalCommandAgent,
  sessionKey: string,
  action: Exclude<GoalCommandAction, 'status' | 'set' | 'clear'>,
  reason?: string
): Promise<GoalState | undefined> {
  switch (action) {
    case 'pause':
      return agent.pauseGoal(sessionKey, reason);
    case 'resume':
      return agent.resumeGoal(sessionKey);
    case 'complete':
      return agent.completeGoal(sessionKey, reason);
    case 'block':
      return agent.blockGoal(sessionKey, reason);
  }
}

export async function handleGoalCommand(
  params: HandleGoalCommandParams
): Promise<GoalCommandResult> {
  const parsed = parseGoalCommand(params.input);
  return executeGoalCommand(params.agent, params.sessionKey, parsed, { locale: params.locale });
}
