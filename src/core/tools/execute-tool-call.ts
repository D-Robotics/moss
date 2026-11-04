import type {
  ProtectedPathChangeReport,
  Tool,
  ToolContext,
  ToolContentBlock,
  ToolResult,
  ToolResultOutcome,
} from './tool-types.js';
import type { ToolHookRegistry } from './tool-hooks.js';
import type { MiniAgentEvent } from '../subagent/agent-events.js';
import { abortable, combineAbortSignals } from '../agent/abort.js';
import { describeError, isTimeoutError, isTransientError } from '../../provider/errors.js';
import { getRootLogger } from '../../logger.js';
import { runPreToolHookChain, validateToolInputObject } from './tool-pipeline.js';
import { MossError, ErrorCode, errorMessage, isMossError, wrapAsMoss } from '../../errors.js';
import { isEffectiveUiZh } from '../../utils/ui-language.js';
import type { DenialClass } from '../../contracts/tool-denial.js';

/**
 * O88: text the model (and the tool row) gets when approval is refused. It
 * always opens with an explicit "blocked/denied" so the model never mistakes it
 * for success. A hook's own reason already opens with 「已拦截：」/`Blocked`, so
 * it is used as-is instead of being wrapped in an untranslated prefix.
 * The outcome kind ('denied') and TOOL_NOT_ALLOWED code are unaffected.
 *
 * The guidance is chosen by the *denial class* the decision point attached
 * (`DenialClass`), never by one blanket sentence. Why: the four sources imply
 * different next actions, and a blanket "do not retry" directly contradicts a
 * mode-block reason that already says "then run it again". Claude Code gets away
 * with one sentence because its `denied` has one source (the permission system,
 * acting for the user); Moss's denial has four, so the class must travel with
 * the decision and the copy must agree with the reason it accompanies.
 *
 * The sentence stays on the same line after the reason so the prefix-based
 * classifiers in `tool-loop-guard.ts` / `run-completion.ts` keep matching their
 * first sentence unchanged.
 */
const DENIED_GUIDANCE: Record<DenialClass | 'unspecified', { en: string; zh: string }> = {
  user: {
    en: 'The user declined this call. Do not retry it unchanged; adjust the request (narrower, safer, or read-only) or ask the user how to proceed.',
    zh: '用户拒绝了这次调用；不要原样重试，改为调整请求（更窄、更安全或只读）或询问用户下一步。',
  },
  mode: {
    en: 'The current interaction mode blocks this action. Do not reach the same effect through another tool; if it is genuinely needed, ask the user to switch modes and then run it again.',
    zh: '当前交互模式拦截了该操作；不要换工具绕行，确有必要时请用户切换模式后再执行。',
  },
  policy: {
    en: 'A configured policy or protected-path rule blocks this. Do not route around it with another tool; use an allowed path or tell the user which rule blocked it.',
    zh: '已配置的策略或受保护路径规则拦截了该操作；不要用其他工具绕行，改用允许的路径，或告诉用户是哪条规则拦截的。',
  },
  headless: {
    en: 'No interactive approver is available in this run. Do not retry; choose an action that needs no approval, or report what you would need from the user.',
    zh: '本次运行没有人可以批准该操作；不要重试，改用无需批准的做法，或说明需要用户提供什么。',
  },
  unspecified: {
    en: 'Do not retry this call unchanged; adjust the request (narrower, safer, or read-only) or ask the user how to proceed.',
    zh: '不要原样重试这次调用；调整请求（更窄、更安全或只读）或询问用户下一步。',
  },
};

/** Drop the reason's trailing punctuation so the guidance never prints ".." or "。。". */
function trimTrailingPunctuation(text: string): string {
  return text.replace(/[.。!！?？;；,，\s]+$/u, '');
}

export function deniedToolResultText(
  reason: string | undefined,
  zh = isEffectiveUiZh(),
  denialClass?: DenialClass
): string {
  const r = reason?.trim();
  const guidance = DENIED_GUIDANCE[denialClass ?? 'unspecified'];
  // A hook's own copy already carries its handling instructions and its own
  // decision source; appending a second, differently-scoped instruction is the
  // contradiction this function exists to remove.
  if (zh && r?.startsWith('已拦截')) return r;
  if (!zh && r && /^blocked\b/i.test(r)) return r;
  if (!r) {
    return zh
      ? `已拦截：用户拒绝了这次工具调用。${guidance.zh}`
      : `Tool execution denied by user. ${guidance.en}`;
  }
  if (zh) return `已拦截：${trimTrailingPunctuation(r)}。${guidance.zh}`;
  return `Tool execution denied: ${trimTrailingPunctuation(r)}. ${guidance.en}`;
}

const logger = getRootLogger();

const TRANSIENT_RETRY_TOOLS = new Set([
  'read_file',
  'search_code',
  'search_files',
  'list_directory',
  'grep',
  'web_search',
  'web_fetch',
  'codegraph_search',
  'codegraph_callers',
  'codegraph_callees',
  'codegraph_trace',
  'codegraph_impact',
  'codegraph_node',
  'codegraph_context',
  'codegraph_explore',
  'codegraph_files',
  'codegraph_status',
  'device_info',
  'device_file_read',
  'device_file_list',
  'device_temperature',
  'device_resources',
  'device_processes',
  'device_network',
  'device_cameras',
  'ros2_topic_list',
  'ros2_topic_echo',
  'ros2_topic_hz',
  'ros2_node_list',
  'ros2_service_list',
  'ros2_pkg_list',
  'mesh_list_peers',
]);

const MAX_RETRY_ATTEMPTS = (() => {
  const env = process.env.MOSS_TOOL_RETRY_MAX;
  if (env !== undefined) {
    const parsed = Number.parseInt(env, 10);
    if (Number.isInteger(parsed) && parsed >= 0 && parsed <= 5) return parsed;
  }
  return 2;
})();

const RETRY_BACKOFF_BASE_MS = (() => {
  const env = process.env.MOSS_TOOL_RETRY_BACKOFF_BASE_MS;
  if (env !== undefined) {
    const parsed = Number.parseInt(env, 10);
    if (Number.isInteger(parsed) && parsed >= 50) return parsed;
  }
  return 200;
})();

const RETRY_BACKOFF_MAX_MS = (() => {
  const env = process.env.MOSS_TOOL_RETRY_BACKOFF_MAX_MS;
  if (env !== undefined) {
    const parsed = Number.parseInt(env, 10);
    if (Number.isInteger(parsed) && parsed >= 100) return parsed;
  }
  return 5_000;
})();

/**
 * Tools often encode failure in the returned string (`Error: …`,
 * `Command failed (exit 1)`, `exit_code: 1`) without throwing. Without this
 * check, is_error stays false and completion gates / tool-loop failure
 * counters never see the failure.
 *
 * Important: do NOT use multiline `^Error:` over the whole body — successful
 * test/log output often contains lines like `Error: expected …` and would
 * be false-positive failures.
 */
export function isStringToolFailureResult(text: string | undefined): boolean {
  if (!text) return false;
  const head = text.slice(0, 400);
  // Prefix-only failure encodings (start of the tool result).
  if (/^\s*Error:/i.test(head)) return true;
  if (/^\s*Command failed\b/i.test(head)) return true;
  // exec timeout / signal kill are marked structurally via ctx.markResultError
  // (builtin exec catch branch) — never by matching stdout text (O96).
  if (/^\s*Command blocked:/i.test(head)) return true;
  if (/^\s*Patch rejected\b/i.test(head)) return true;
  // exec non-zero exit is emitted as the first line: "exit_code: N\n..."
  if (/^\s*exit_code:\s*([1-9]\d*)\b/i.test(head)) return true;
  if (/^\s*Operation blocked by workspace policy\./i.test(head)) return true;
  // harness-tools / diagnostics structured status near the top of the result
  if (/Test Results:\s*❌/i.test(head)) return true;
  if (/Test Results:\s*⚠️\s*NO TESTS EXECUTED/i.test(head)) return true;
  if (/Verify Fix:\s*❌/i.test(head)) return true;
  if (/Verify Fix:\s*⚠️\s*NO (?:TESTS|STEPS) EXECUTED/i.test(head)) return true;
  if (/❌\s+\d+\s+FAILED\b/i.test(head)) return true;
  if (/❌\s+ISSUES FOUND\b/i.test(head)) return true;
  if (/(?:^|\n)\s*(?:Build|Typecheck|Tests):\s*❌\s*FAIL\b/i.test(head)) return true;
  // A verification command's "Result: FAIL" is its own status line near the top
  if (/(?:^|\n)\s*Result:\s*FAIL\b/i.test(head)) return true;
  // create_subagent / subagent_status / fan_out child failure banners
  if (/\[Sub-agent[^\]]*\]\s*FAILED/i.test(head)) return true;
  if (/Error:\s*\[Sub-agent/i.test(head)) return true;
  if (/Error:\s*\[fan_out_subagents\]/i.test(head)) return true;
  return false;
}

function progressiveBackoffDelay(attemptIndex: number): number {
  const computed = RETRY_BACKOFF_BASE_MS * 2 ** attemptIndex;
  const capped = Math.min(computed, RETRY_BACKOFF_MAX_MS);
  const jitter = Math.floor(Math.random() * capped * 0.5) - Math.floor(capped * 0.25);
  return Math.max(0, capped + jitter);
}

const MAX_UNKNOWN_TOOL_SUGGESTIONS = 40;

function formatAvailableToolNames(toolsForRun: Tool[]): string {
  const toolNames = [...new Set(toolsForRun.map((tool) => tool.name).filter(Boolean))].sort(
    (a, b) => a.localeCompare(b)
  );
  if (toolNames.length === 0) return '(none registered)';
  const visible = toolNames.slice(0, MAX_UNKNOWN_TOOL_SUGGESTIONS);
  const suffix =
    toolNames.length > visible.length ? ` ... (${toolNames.length - visible.length} more)` : '';
  return `${visible.join(', ')}${suffix}`;
}

function resolveMaxMissedHeartbeats(
  toolTimeoutMs: number,
  heartbeatIntervalMs: number,
  explicitMaxMissed?: number
): number {
  if (explicitMaxMissed !== undefined) return Math.max(1, explicitMaxMissed);
  const normalizedIntervalMs = Math.max(1, heartbeatIntervalMs);
  return Math.max(1, Math.ceil(toolTimeoutMs / normalizedIntervalMs));
}

function textFromStructuredContent(content: ToolContentBlock[]): string {
  const text = content
    .map((block) => {
      if (block.type === 'text') return block.text;
      if (block.type === 'resource' && typeof block.text === 'string') return block.text;
      return '';
    })
    .filter((part) => part.length > 0)
    .join('\n');
  if (text) return text;
  if (content.length > 0) {
    return `[${content.length} content block(s): ${content.map((block) => block.type).join(', ')}]`;
  }
  return '';
}

// A system error's code identifies its cause; path and dest are untrusted data
// and may themselves contain words used by the text-based classifiers.
function pathSystemError(err: unknown): { code: string; message?: string } | undefined {
  const seen = new Set<object>();
  let current = err;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const cause = current as {
      cause?: unknown;
      code?: unknown;
      message?: unknown;
      errno?: unknown;
      syscall?: unknown;
      path?: unknown;
      dest?: unknown;
    };
    if (
      current instanceof Error &&
      typeof cause.code === 'string' &&
      typeof cause.errno === 'number' &&
      typeof cause.syscall === 'string' &&
      (typeof cause.path === 'string' || typeof cause.dest === 'string')
    ) {
      return {
        code: cause.code.toUpperCase(),
        ...(typeof cause.message === 'string' ? { message: cause.message } : {}),
      };
    }
    current = cause.cause;
  }
  return undefined;
}

type ToolFailureClassification = {
  kind: 'blocked' | 'aborted' | 'timeout' | 'failure';
  retryable: boolean;
};

function classifyThrownToolFailure(
  err: unknown,
  rawMessage: string,
  userAborted: boolean,
  deadlineElapsed: boolean
): ToolFailureClassification {
  if (userAborted) return { kind: 'aborted', retryable: false };
  if (isMossError(err) && err.code === ErrorCode.TOOL_NOT_ALLOWED) {
    return { kind: 'blocked', retryable: false };
  }
  // abortable() can surface USER_ABORTED when our own deadline aborts its
  // signal; the observed deadline takes precedence over that derived error.
  if (deadlineElapsed) return { kind: 'timeout', retryable: true };
  if (isMossError(err) && err.code === ErrorCode.USER_ABORTED) {
    return { kind: 'aborted', retryable: false };
  }

  const systemError = pathSystemError(err);
  const systemMessage = systemError?.message;
  const systemIndex = systemMessage ? rawMessage.indexOf(systemMessage) : -1;
  // Only use the native code when its full message is present; otherwise the
  // outer message may describe an independent failure and retains precedence.
  const systemCode = systemIndex >= 0 ? systemError?.code : undefined;
  const diagnostic =
    systemMessage && systemIndex >= 0
      ? rawMessage.slice(0, systemIndex) + rawMessage.slice(systemIndex + systemMessage.length)
      : rawMessage;
  const explicitTimeout = isMossError(err) && err.code === ErrorCode.TOOL_EXECUTION_TIMEOUT;
  const isTimeout = explicitTimeout || systemCode === 'ETIMEDOUT' || /timed out/i.test(diagnostic);
  const retryable =
    !/Device connection lost/i.test(diagnostic) &&
    (explicitTimeout ||
      systemCode === 'EAGAIN' ||
      systemCode === 'EWOULDBLOCK' ||
      isTransientError(diagnostic) ||
      isTransientError(systemCode));
  return { kind: isTimeout ? 'timeout' : 'failure', retryable };
}

function policyBlockedToolResult(error: MossError): string {
  return [
    'Operation blocked by workspace policy. The tool did not inspect the target: its existence is unknown and no contents were read.',
    `Reason: ${errorMessage(error)}`,
  ].join('\n');
}

export interface ExecuteToolCallDeps {
  toolsForRun: Tool[];
  toolCtx: ToolContext;
  sessionKey: string;
  /** Canonical run identifier; falls back to `toolCtx.runId` for old callers. */
  runId?: string;
  /** Canonical zero-or-greater turn index; loop callers always provide it. */
  turnIndex?: number;
  toolHooks?: ToolHookRegistry;
  abortSignal: AbortSignal;
  toolTimeoutMs: number;

  enableHeartbeat: boolean;

  heartbeatIntervalMs: number;

  skipHeartbeatToolNames: ReadonlySet<string>;

  toolAbortSignalFor?: (toolCallId: string) => AbortSignal | undefined;

  enrichToolContext?: (baseCtx: ToolContext, sessionKey: string) => ToolContext;

  checkToolApproval?: (call: {
    id: string;
    name: string;
    input: unknown;
    abortSignal: AbortSignal;
    tool?: Tool;
  }) => Promise<{
    approved: boolean;
    decision: string;
    reason?: string;
    denialClass?: DenialClass;
  } | null>;

  push: (event: MiniAgentEvent) => void;

  onBeforeStartEmit?: (mutatedInput: Record<string, unknown>) => void;

  maxMissedHeartbeats?: number;
}

export type ExecuteToolCallOutcome =
  | {
      kind: 'completed';
      text: string;
      isError: boolean;
      durationMs: number;
      outcome?: ToolResultOutcome;
      aborted?: { by: 'user' | 'timeout' };
      structuredContent?: ToolContentBlock[];
      error?: ToolResult['error'];
      /** O152 F9b: L3 post-run changes, independent of `text` truncation. */
      protectedPathChanges?: ProtectedPathChangeReport[];
    }
  | {
      kind: 'unknown-tool';
      text: string;
      error?: ToolResult['error'];
    }
  | {
      kind: 'pre-blocked';
      text: string;
      error?: ToolResult['error'];
    }
  | {
      kind: 'hook-blocked';
      text: string;
      error?: ToolResult['error'];
    }
  | {
      kind: 'denied';
      text: string;
      error?: ToolResult['error'];
    };

export async function executeOneToolCall(
  call: { id: string; name: string; input: Record<string, unknown> },
  deps: ExecuteToolCallDeps
): Promise<ExecuteToolCallOutcome> {
  return executeOneToolCallInner(call, deps);
}

async function executeOneToolCallInner(
  call: { id: string; name: string; input: Record<string, unknown> },
  deps: ExecuteToolCallDeps
): Promise<ExecuteToolCallOutcome> {
  try {
    let tool = deps.toolsForRun.find((t) => t.name === call.name);
    if (!tool && deps.toolCtx.resolveMissingTool) {
      const resolved = await deps.toolCtx.resolveMissingTool(call.name, deps.abortSignal);
      if (resolved) tool = resolved;
    }
    if (!tool) {
      const reason = deps.toolCtx.describeMissingTool?.(call.name);
      const text =
        reason ??
        `Unknown tool: ${call.name}. Available tools: ${formatAvailableToolNames(deps.toolsForRun)}. Use only registered tool names.`;
      return {
        kind: 'unknown-tool',
        text,
        error: new MossError({ code: ErrorCode.TOOL_NOT_FOUND, message: text }),
      };
    }

    const schemaCheck = validateToolInputObject(tool, call.input);
    if (!schemaCheck.ok) {
      return {
        kind: 'pre-blocked',
        text: schemaCheck.message,
        error: new MossError({
          code: ErrorCode.USER_INPUT_INVALID,
          message: schemaCheck.message,
        }),
      };
    }

    const hooked = await runPreToolHookChain(call.name, schemaCheck.value, deps.sessionKey);
    if (!hooked.ok) {
      return {
        kind: 'pre-blocked',
        text: hooked.message,
        error: new MossError({ code: ErrorCode.TOOL_NOT_ALLOWED, message: hooked.message }),
      };
    }
    const globallyHookedSchemaCheck = validateToolInputObject(tool, hooked.input);
    if (!globallyHookedSchemaCheck.ok) {
      return {
        kind: 'pre-blocked',
        text: globallyHookedSchemaCheck.message,
        error: new MossError({
          code: ErrorCode.USER_INPUT_INVALID,
          message: globallyHookedSchemaCheck.message,
        }),
      };
    }
    call.input = globallyHookedSchemaCheck.value;

    const perToolAbortSignal = deps.toolAbortSignalFor?.(call.id);
    const effectiveAbortSignal =
      combineAbortSignals(deps.abortSignal, perToolAbortSignal) ?? deps.abortSignal;
    let callToolCtx: ToolContext = {
      ...deps.toolCtx,
      abortSignal: effectiveAbortSignal,
      toolCallId: call.id,
    };
    if (deps.enrichToolContext) {
      callToolCtx = deps.enrichToolContext(callToolCtx, deps.sessionKey);
    }

    if (deps.toolHooks) {
      const { decision, hookName } = await deps.toolHooks.runPreHooks({
        tool,
        input: call.input,
        ctx: callToolCtx,
        sessionId: deps.sessionKey,
      });
      if (decision.action === 'block') {
        const text = `[${hookName}] ${decision.reason}`;
        return {
          kind: 'hook-blocked',
          text,
          error: new MossError({ code: ErrorCode.TOOL_NOT_ALLOWED, message: text }),
        };
      }
      if (decision.action === 'modify') {
        call.input = decision.input;
      }
    }

    // The execution-boundary schema check runs after every input-mutating
    // hook and before approval. This ensures the user approves exactly the
    // validated action that can reach the tool implementation.
    const finalSchemaCheck = validateToolInputObject(tool, call.input);
    if (!finalSchemaCheck.ok) {
      return {
        kind: 'pre-blocked',
        text: finalSchemaCheck.message,
        error: new MossError({
          code: ErrorCode.USER_INPUT_INVALID,
          message: finalSchemaCheck.message,
        }),
      };
    }
    call.input = finalSchemaCheck.value;

    let approvalTriggered = false;
    if (deps.checkToolApproval) {
      const approval = await abortable(
        deps.checkToolApproval({ ...call, abortSignal: effectiveAbortSignal, tool }),
        effectiveAbortSignal
      );
      if (approval !== null) {
        approvalTriggered = true;
        const decision = approval.decision as 'allow-once' | 'allow-always' | 'deny';
        deps.push({
          type: 'tool_approval_request',
          toolCallId: call.id,
          toolName: call.name,
          args: call.input,
        });
        deps.push({
          type: 'tool_approval_resolved',
          toolCallId: call.id,
          toolName: call.name,
          decision,
        });
        if (!approval.approved) {
          const reason = approval.reason?.trim();
          const text = deniedToolResultText(reason, undefined, approval.denialClass);
          return {
            kind: 'denied',
            text,
            error: new MossError({ code: ErrorCode.TOOL_NOT_ALLOWED, message: text }),
          };
        }
      }
    }

    let startEmitted = false;
    const emitStart = () => {
      if (startEmitted) return;
      startEmitted = true;
      deps.onBeforeStartEmit?.(call.input);
      deps.push({
        type: 'tool_execution_start',
        toolCallId: call.id,
        toolName: call.name,
        args: call.input,
      });
    };

    const startMs = Date.now();
    let text = '';
    let errFlag = false;
    let reachedExecute = false;
    let aborted: { by: 'user' | 'timeout' } | undefined;
    let structuredBlocks: ToolContentBlock[] | undefined;
    let toolError: MossError | undefined;
    // O152 F9b: structured L3 result (survives output truncation).
    const protectedPathChanges: ProtectedPathChangeReport[] = [];

    const skipAgentHeartbeat = !deps.enableHeartbeat || deps.skipHeartbeatToolNames.has(call.name);

    let retriesUsed = 0;
    const eligibleForRetry =
      tool.metadata?.sideEffectClass === 'readonly' &&
      (tool.metadata.transientRetry ?? TRANSIENT_RETRY_TOOLS.has(call.name)) &&
      !approvalTriggered;

    for (let attempt = 0; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
      if (deps.abortSignal.aborted) {
        aborted = { by: 'user' };
        text = text || 'Execution error: aborted_by_user: cancelled before retry';
        errFlag = true;
        toolError = new MossError({
          code: ErrorCode.USER_ABORTED,
          message: 'Tool execution was cancelled before retry.',
        });
        break;
      }

      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      let heartbeatHandle: ReturnType<typeof setInterval> | null = null;
      let attemptErrFlag = false;
      let attemptText = '';
      let attemptTimeout = false;
      let attemptError: MossError | undefined;
      let failureClassification: ToolFailureClassification | undefined;
      const workspaceRecoveryPaths = new Set<string>();

      structuredBlocks = undefined;
      const timeoutAbortCtrl = new AbortController();

      try {
        const toolTimeoutPromise = new Promise<never>(
          (_, reject) =>
            (timeoutHandle = setTimeout(() => {
              try {
                timeoutAbortCtrl.abort();
              } catch {}
              reject(
                new MossError({
                  code: ErrorCode.TOOL_EXECUTION_TIMEOUT,
                  message: `Tool ${call.name} timed out (${deps.toolTimeoutMs / 1000}s)`,
                })
              );
            }, deps.toolTimeoutMs))
        );

        const attemptSignal =
          combineAbortSignals(effectiveAbortSignal, timeoutAbortCtrl.signal) ??
          effectiveAbortSignal;
        let structuralError = false;
        const attemptCtx: ToolContext = {
          ...callToolCtx,
          abortSignal: attemptSignal,
          markResultError: () => {
            structuralError = true;
          },
          reportProtectedPathChanges: (changes) => {
            protectedPathChanges.push(...changes.map((c) => ({ ...c })));
          },
          reportWorkspaceRecoveryPath: (workspacePath) => {
            workspaceRecoveryPaths.add(workspacePath);
          },
        };
        if (!skipAgentHeartbeat) {
          const heartbeatIntervalMs = Math.max(1, deps.heartbeatIntervalMs);
          const maxMissed = resolveMaxMissedHeartbeats(
            deps.toolTimeoutMs,
            heartbeatIntervalMs,
            deps.maxMissedHeartbeats
          );
          let beatsFired = 0;
          heartbeatHandle = setInterval(() => {
            const elapsed = Math.round((Date.now() - startMs) / 1000);
            beatsFired++;
            deps.push({
              type: 'tool_execution_progress',
              toolCallId: call.id,
              toolName: call.name,
              elapsed_sec: elapsed,
            });

            if (beatsFired >= maxMissed) {
              logger.warn(
                `[execute-tool-call] watchdog: ${call.name}(${call.id}) exceeded ${maxMissed} heartbeats — force aborting`
              );
              try {
                timeoutAbortCtrl.abort();
              } catch {}
            }
          }, heartbeatIntervalMs);
        }

        if (attempt === 0) emitStart();
        reachedExecute = true;
        if (tool.executeStructured) {
          const structured = await Promise.race([
            abortable(tool.executeStructured(call.input, attemptCtx), attemptSignal),
            toolTimeoutPromise,
          ]);
          structuredBlocks = structured.content;
          attemptText = textFromStructuredContent(structured.content);
          if (structured.isError) {
            attemptErrFlag = true;
            attemptError = new MossError({
              code: ErrorCode.TOOL_EXECUTION_FAILED,
              message: attemptText || `Tool ${call.name} returned an error result.`,
            });
          }
        } else {
          attemptText = await Promise.race([
            abortable(tool.execute(call.input, attemptCtx), attemptSignal),
            toolTimeoutPromise,
          ]);
          // Many tools (exec, edit_file, …) return error as a string instead of
          // throwing. Detect those so is_error / failure gates / loop-guard
          // see a real failure (Claude/Codex: non-zero shell is not success).
          if (!attemptErrFlag && (structuralError || isStringToolFailureResult(attemptText))) {
            attemptErrFlag = true;
            attemptError = new MossError({
              code: ErrorCode.TOOL_EXECUTION_FAILED,
              message: attemptText,
            });
          }
        }
      } catch (err) {
        const rawMessage = errorMessage(err);
        const userAborted = deps.abortSignal.aborted || !!perToolAbortSignal?.aborted;
        const deadlineElapsed = timeoutAbortCtrl.signal.aborted && !userAborted;
        failureClassification = classifyThrownToolFailure(
          err,
          rawMessage,
          userAborted,
          deadlineElapsed
        );
        if (failureClassification.kind === 'aborted') {
          aborted = { by: 'user' };
          if (isMossError(err) && err.code === ErrorCode.USER_ABORTED) {
            attemptText = `Execution error: ${rawMessage}`;
            attemptError = err;
          } else {
            attemptText = 'Execution error: aborted_by_user: cancelled during execution';
            attemptError = new MossError({
              code: ErrorCode.USER_ABORTED,
              message: 'Tool execution was cancelled by the user.',
              cause: err,
            });
          }
        } else if (failureClassification.kind === 'blocked' && isMossError(err)) {
          attemptText = policyBlockedToolResult(err);
          attemptError = err;
        } else if (failureClassification.kind === 'timeout') {
          attemptTimeout = true;
          if (deadlineElapsed) {
            attemptText = `Execution error: Tool ${call.name} timed out (${deps.toolTimeoutMs / 1000}s)`;
            attemptError =
              isMossError(err) && err.code === ErrorCode.TOOL_EXECUTION_TIMEOUT
                ? err
                : new MossError({
                    code: ErrorCode.TOOL_EXECUTION_TIMEOUT,
                    message: `Tool ${call.name} timed out (${deps.toolTimeoutMs / 1000}s)`,
                    cause: err,
                  });
          } else {
            attemptText = `Execution error: ${rawMessage}`;
            attemptError = new MossError({
              code: ErrorCode.TOOL_EXECUTION_TIMEOUT,
              message: rawMessage,
              cause: err,
            });
          }
        } else {
          attemptText = `Execution error: ${rawMessage}`;
          attemptError = wrapAsMoss(err, ErrorCode.TOOL_EXECUTION_FAILED, {
            message: rawMessage,
          });
        }
        if (attemptTimeout || aborted) {
          for (const workspacePath of workspaceRecoveryPaths) {
            attemptText += `\n[worktree preserved: ${workspacePath}]`;
          }
        }
        attemptErrFlag = true;
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        if (heartbeatHandle) clearInterval(heartbeatHandle);
      }

      if (attemptErrFlag && eligibleForRetry && attempt < MAX_RETRY_ATTEMPTS && !aborted) {
        const rawMsg = attemptText.replace(/^Execution error:\s*/, '');
        const retryable =
          failureClassification?.retryable ??
          (!/Device connection lost/i.test(rawMsg) &&
            (isTransientError(rawMsg) || isTimeoutError(rawMsg)));
        if (retryable) {
          retriesUsed++;
          const delayMs = progressiveBackoffDelay(retriesUsed - 1);
          logger.debug(
            `[execute-tool-call] retry #${retriesUsed}/${MAX_RETRY_ATTEMPTS} for ${call.name}(${call.id}) after ${delayMs}ms (progressive backoff): ${rawMsg.slice(0, 120)}`
          );

          let backoffTimer: ReturnType<typeof setTimeout> | undefined;
          let onBackoffAbort: (() => void) | undefined;
          await new Promise<void>((resolve) => {
            backoffTimer = setTimeout(resolve, delayMs);
            onBackoffAbort = () => resolve();
            deps.abortSignal.addEventListener('abort', onBackoffAbort, { once: true });
          });
          if (backoffTimer) clearTimeout(backoffTimer);
          if (onBackoffAbort) deps.abortSignal.removeEventListener('abort', onBackoffAbort);

          if (deps.abortSignal.aborted) {
            aborted = { by: 'user' };
            text = 'Execution error: aborted_by_user: cancelled during retry backoff';
            errFlag = true;
            toolError = new MossError({
              code: ErrorCode.USER_ABORTED,
              message: 'Tool execution was cancelled during retry backoff.',
              cause: attemptError,
            });
            break;
          }
          continue;
        }
      }

      if (attemptTimeout && !aborted) {
        aborted = { by: 'timeout' };
      }
      text = attemptText;
      errFlag = attemptErrFlag;
      toolError = attemptError;
      break;
    }

    emitStart();

    let postHookModified = false;
    const textBeforePostHooks = text;
    if (deps.toolHooks) {
      text = await deps.toolHooks.runPostHooks({
        tool,
        input: call.input,
        result: text,
        isError: errFlag,
        durationMs: Date.now() - startMs,
        ctx: callToolCtx,
        sessionId: deps.sessionKey,
        onModified: () => {
          postHookModified = true;
        },
      });
    }

    if (errFlag && deps.toolHooks && reachedExecute) {
      text = await deps.toolHooks.runPostFailureHooks({
        tool,
        input: call.input,
        result: text,
        durationMs: Date.now() - startMs,
        ctx: callToolCtx,
        sessionId: deps.sessionKey,
        onModified: () => {
          postHookModified = true;
        },
      });
    }

    return {
      kind: 'completed',
      text,
      isError: errFlag,
      durationMs: Date.now() - startMs,
      ...(errFlag && text.startsWith('Operation blocked by workspace policy.')
        ? { outcome: 'blocked' as const }
        : {}),
      ...(aborted ? { aborted } : {}),
      ...(!postHookModified && text === textBeforePostHooks && !aborted && structuredBlocks
        ? { structuredContent: structuredBlocks }
        : {}),
      ...(toolError ? { error: toolError } : {}),
      ...(protectedPathChanges.length > 0 ? { protectedPathChanges } : {}),
    };
  } catch (err) {
    if (isMossError(err) && err.code === ErrorCode.USER_ABORTED) {
      return {
        kind: 'completed',
        text: 'Execution error: aborted_by_user: cancelled before tool execution completed',
        isError: true,
        durationMs: 0,
        aborted: { by: 'user' },
        error: err,
      };
    }
    const text = `Execution error: ${describeError(err)}`;
    return {
      kind: 'pre-blocked',
      text,
      error: wrapAsMoss(err, ErrorCode.TOOL_EXECUTION_FAILED, { message: describeError(err) }),
    };
  }
}

export function outcomeToResult(outcome: ExecuteToolCallOutcome): {
  text: string;
  isError: boolean;
  structuredContent?: ToolContentBlock[];
  error?: ToolResult['error'];
  protectedPathChanges?: ProtectedPathChangeReport[];
} {
  switch (outcome.kind) {
    case 'completed':
      return {
        text: outcome.text,
        isError: outcome.isError,
        ...(outcome.structuredContent ? { structuredContent: outcome.structuredContent } : {}),
        ...(outcome.error ? { error: outcome.error } : {}),
        ...(outcome.protectedPathChanges
          ? { protectedPathChanges: outcome.protectedPathChanges }
          : {}),
      };
    case 'unknown-tool':
    case 'pre-blocked':
    case 'hook-blocked':
    case 'denied':
      return {
        text: outcome.text,
        isError: true,
        ...(outcome.error ? { error: outcome.error } : {}),
      };
  }
}
