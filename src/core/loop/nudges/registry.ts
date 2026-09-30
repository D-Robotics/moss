/**
 * Nudge injection registry.
 *
 * Collects the mid-turn nudge injections that used to live as copy-pasted
 * `inject*` closures plus call sites in `agent-loop.ts`. The registry owns
 * only the counter plumbing (read `*NudgeAttempts` → evaluate → write
 * counter → collect message); all guard / firing logic stays in the
 * per-nudge `evaluate*` functions, executed here in the exact order the
 * original call sites used.
 */
import type { Message } from '../../session/session-jsonl.js';
import type { AgentLoopMutableState } from '../agent-loop-state.js';
import { evaluateTodoNudge } from './todo-nudge.js';
import { evaluateVerifyNudge } from './verify-nudge.js';
import { evaluateRedVerifyNudge } from './red-verify-nudge.js';
import { evaluateFanOutNudge } from './fan-out-nudge.js';
import { evaluateAmbiguityNudge } from './ambiguity-nudge.js';
import { evaluateSubagentRunningNudge } from './subagent-running-nudge.js';
import { evaluateSubagentStoppedNudge } from './subagent-stopped-nudge.js';
import { evaluateWebToolsNudge } from './web-tools-nudge.js';
import { evaluateGitToolsNudge } from './git-tools-nudge.js';
import { evaluateInstallToolsNudge } from './install-tools-nudge.js';
import { evaluateRunTestsToolsNudge } from './run-tests-tools-nudge.js';
import { evaluateBuildToolsNudge } from './build-tools-nudge.js';
import { evaluateBackgroundServerNudge } from './background-server-nudge.js';
import { evaluateTaskRepairNudge } from './task-repair-nudge.js';

/** Inputs the registry needs from the agent loop host. */
export interface NudgeBuildContext {
  /** Mutable loop state — `*NudgeAttempts` counters are read/written here. */
  state: AgentLoopMutableState;
  /** Current in-flight conversation messages. */
  currentMessages: Message[];
  /** Latest real user text (not tool_result / [System]). */
  lastUserText: () => string;
  /** Build the injected correction message from a nudge correction string. */
  buildCorrectionMessage: (systemText: string) => Message;
}

/**
 * Normalized decision shape — every `evaluate*` result type in this package
 * is assignable to this union, so no per-nudge casting is needed.
 */
type NudgeDecision =
  | { fire: false; resetAttempts?: boolean }
  | { fire: true; correction: string; resetAttempts?: boolean };

/** Read/write access to one `*NudgeAttempts` counter on the loop state. */
interface NudgeCounter {
  get(): number;
  set(value: number): void;
}

/** Options for a single nudge step. */
interface NudgeStepOptions {
  /**
   * When the decision reports `resetAttempts` (RedVerifyNudge green wave),
   * reset the counter to 0 before the fire check — matches the original
   * `injectRedVerifyNudge` ordering.
   */
  resetOnResetAttempts?: boolean;
}

/**
 * Run one nudge evaluation and return the message to inject, or null.
 * Pure counter plumbing only — guards live inside `evaluate`.
 */
function runNudgeStep(
  buildCorrectionMessage: NudgeBuildContext['buildCorrectionMessage'],
  counter: NudgeCounter,
  evaluate: () => NudgeDecision,
  opts?: NudgeStepOptions
): Message | null {
  const decision = evaluate();
  if (opts?.resetOnResetAttempts && decision.resetAttempts) {
    counter.set(0);
  }
  if (!decision.fire) return null;
  counter.set(counter.get() + 1);
  return buildCorrectionMessage(decision.correction);
}

/** Run all nudge checks in the historical order and return messages to inject. */
export function collectNudgeInjections(ctx: NudgeBuildContext): Message[] {
  const { state, currentMessages } = ctx;
  const metrics = state.toolExecutionMetrics;
  const out: Message[] = [];
  const push = (msg: Message | null): void => {
    if (msg) out.push(msg);
  };

  // 1. Soft multi-step plan reminder (Grok TodoNudge light) — after tools
  // have already run so we only fire on real multi-tool coding work.
  push(
    runNudgeStep(
      ctx.buildCorrectionMessage,
      {
        get: () => state.todoNudgeAttempts,
        set: (v) => {
          state.todoNudgeAttempts = v;
        },
      },
      () =>
        evaluateTodoNudge({
          turns: state.turns,
          totalToolCalls: metrics.totalToolCalls,
          toolCallsByName: metrics.toolCallsByName,
          userText: ctx.lastUserText(),
          attempts: state.todoNudgeAttempts,
        })
    )
  );

  // 2. Soft mid-run verification reminder after several edits with no tests.
  push(
    runNudgeStep(
      ctx.buildCorrectionMessage,
      {
        get: () => state.verifyNudgeAttempts,
        set: (v) => {
          state.verifyNudgeAttempts = v;
        },
      },
      () =>
        evaluateVerifyNudge({
          turns: state.turns,
          totalToolCalls: metrics.totalToolCalls,
          toolCallsByName: metrics.toolCallsByName,
          userText: ctx.lastUserText(),
          attempts: state.verifyNudgeAttempts,
        })
    )
  );

  // 3. After a red verification result, force fix-then-rerun (VerifyNudge
  // alone is silenced once any verify tool has been called).
  push(
    runNudgeStep(
      ctx.buildCorrectionMessage,
      {
        get: () => state.redVerifyNudgeAttempts,
        set: (v) => {
          state.redVerifyNudgeAttempts = v;
        },
      },
      () =>
        evaluateRedVerifyNudge({
          messages: currentMessages,
          attempts: state.redVerifyNudgeAttempts,
        }),
      { resetOnResetAttempts: true }
    )
  );

  // 4. After failed fan_out / create_subagent children, merge or re-run
  // before more unrelated work (pairs with end-of-turn FanOutMergeGate).
  push(
    runNudgeStep(
      ctx.buildCorrectionMessage,
      {
        get: () => state.fanOutNudgeAttempts,
        set: (v) => {
          state.fanOutNudgeAttempts = v;
        },
      },
      () =>
        evaluateFanOutNudge({
          messages: currentMessages,
          attempts: state.fanOutNudgeAttempts,
          userText: ctx.lastUserText(),
          toolCallsByName: metrics.toolCallsByName,
        })
    )
  );

  // 5. Multi-interpretation coding + edits without clarify/assumption.
  push(
    runNudgeStep(
      ctx.buildCorrectionMessage,
      {
        get: () => state.ambiguityNudgeAttempts,
        set: (v) => {
          state.ambiguityNudgeAttempts = v;
        },
      },
      () =>
        evaluateAmbiguityNudge({
          toolCallsByName: metrics.toolCallsByName,
          userText: ctx.lastUserText(),
          attempts: state.ambiguityNudgeAttempts,
        })
    )
  );

  // 6. Background create_subagent still STARTED without terminal status.
  push(
    runNudgeStep(
      ctx.buildCorrectionMessage,
      {
        get: () => state.subagentRunningNudgeAttempts,
        set: (v) => {
          state.subagentRunningNudgeAttempts = v;
        },
      },
      () =>
        evaluateSubagentRunningNudge({
          messages: currentMessages,
          attempts: state.subagentRunningNudgeAttempts,
        })
    )
  );

  // 7. subagent_stop is not a successful fix — remind before claiming done.
  push(
    runNudgeStep(
      ctx.buildCorrectionMessage,
      {
        get: () => state.subagentStoppedNudgeAttempts,
        set: (v) => {
          state.subagentStoppedNudgeAttempts = v;
        },
      },
      () =>
        evaluateSubagentStoppedNudge({
          messages: currentMessages,
          toolCallsByName: metrics.toolCallsByName,
          attempts: state.subagentStoppedNudgeAttempts,
        })
    )
  );

  // 8. Online research asked but no web_search/web_fetch yet.
  push(
    runNudgeStep(
      ctx.buildCorrectionMessage,
      {
        get: () => state.webToolsNudgeAttempts,
        set: (v) => {
          state.webToolsNudgeAttempts = v;
        },
      },
      () =>
        evaluateWebToolsNudge({
          userText: ctx.lastUserText(),
          toolCallsByName: metrics.toolCallsByName,
          totalToolCalls: metrics.totalToolCalls,
          attempts: state.webToolsNudgeAttempts,
        })
    )
  );

  // 9. Commit/push asked but no git/gh exec yet.
  push(
    runNudgeStep(
      ctx.buildCorrectionMessage,
      {
        get: () => state.gitToolsNudgeAttempts,
        set: (v) => {
          state.gitToolsNudgeAttempts = v;
        },
      },
      () =>
        evaluateGitToolsNudge({
          userText: ctx.lastUserText(),
          toolCallsByName: metrics.toolCallsByName,
          messages: currentMessages,
          totalToolCalls: metrics.totalToolCalls,
          attempts: state.gitToolsNudgeAttempts,
        })
    )
  );

  // 10. Install deps asked but no package-manager install exec yet.
  push(
    runNudgeStep(
      ctx.buildCorrectionMessage,
      {
        get: () => state.installToolsNudgeAttempts,
        set: (v) => {
          state.installToolsNudgeAttempts = v;
        },
      },
      () =>
        evaluateInstallToolsNudge({
          userText: ctx.lastUserText(),
          toolCallsByName: metrics.toolCallsByName,
          messages: currentMessages,
          totalToolCalls: metrics.totalToolCalls,
          attempts: state.installToolsNudgeAttempts,
        })
    )
  );

  // 11. User explicitly asked to run tests but no verify tools yet.
  push(
    runNudgeStep(
      ctx.buildCorrectionMessage,
      {
        get: () => state.runTestsToolsNudgeAttempts,
        set: (v) => {
          state.runTestsToolsNudgeAttempts = v;
        },
      },
      () =>
        evaluateRunTestsToolsNudge({
          userText: ctx.lastUserText(),
          toolCallsByName: metrics.toolCallsByName,
          messages: currentMessages,
          totalToolCalls: metrics.totalToolCalls,
          attempts: state.runTestsToolsNudgeAttempts,
        })
    )
  );

  // 12. User asked to build/compile but no build-shaped exec yet.
  push(
    runNudgeStep(
      ctx.buildCorrectionMessage,
      {
        get: () => state.buildToolsNudgeAttempts,
        set: (v) => {
          state.buildToolsNudgeAttempts = v;
        },
      },
      () =>
        evaluateBuildToolsNudge({
          userText: ctx.lastUserText(),
          toolCallsByName: metrics.toolCallsByName,
          messages: currentMessages,
          totalToolCalls: metrics.totalToolCalls,
          attempts: state.buildToolsNudgeAttempts,
        })
    )
  );

  // 13. Dev server/watcher start asked but no exec_background yet.
  push(
    runNudgeStep(
      ctx.buildCorrectionMessage,
      {
        get: () => state.backgroundServerNudgeAttempts,
        set: (v) => {
          state.backgroundServerNudgeAttempts = v;
        },
      },
      () =>
        evaluateBackgroundServerNudge({
          userText: ctx.lastUserText(),
          toolCallsByName: metrics.toolCallsByName,
          messages: currentMessages,
          totalToolCalls: metrics.totalToolCalls,
          attempts: state.backgroundServerNudgeAttempts,
        })
    )
  );

  // 14. Red task_acceptance verdict with no repair-path progress after it —
  // force the diagnose→repair→reverify loop (and, after a re-fail with a
  // repair on record, a DIFFERENT root-cause hypothesis instead of a repeat).
  push(
    runNudgeStep(
      ctx.buildCorrectionMessage,
      {
        get: () => state.taskRepairNudgeAttempts,
        set: (v) => {
          state.taskRepairNudgeAttempts = v;
        },
      },
      () =>
        evaluateTaskRepairNudge({
          messages: currentMessages,
          attempts: state.taskRepairNudgeAttempts,
        }),
      { resetOnResetAttempts: true }
    )
  );

  return out;
}
