






















import type { Tool, ToolContext, ToolContentBlock, ToolResultOutcome } from './tool-types.js';
import type { ToolHookRegistry } from './tool-hooks.js';
import type { MiniAgentEvent } from '../subagent/agent-events.js';
import { abortable, combineAbortSignals } from '../agent/abort.js';
import { describeError, isTimeoutError, isTransientError } from '../../provider/errors.js';
import { getRootLogger } from '../../logger.js';
import { runPreToolHookChain, validateToolInputObject } from './tool-pipeline.js';
import { MossError, ErrorCode, errorMessage, isMossError } from '../../errors.js';

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
  // code_diagnostics: "Result: FAIL" is its own status line near the top
  if (/(?:^|\n)\s*Result:\s*FAIL\b/i.test(head)) return true;
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
  }) => Promise<{ approved: boolean; decision: string; reason?: string } | null>;
  








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
    }
  | {
      kind: 'unknown-tool';
      text: string;
    }
  | {
      kind: 'pre-blocked';
      text: string;
    }
  | {
      kind: 'hook-blocked';
      text: string;
    }
  | {
      kind: 'denied';
      text: string;
    };

export async function executeOneToolCall(
  call: { id: string; name: string; input: Record<string, unknown> },
  deps: ExecuteToolCallDeps
): Promise<ExecuteToolCallOutcome> {
  try {
    
    const tool = deps.toolsForRun.find((t) => t.name === call.name);
    if (!tool) {
      return {
        kind: 'unknown-tool',
        text: `Unknown tool: ${call.name}. Available tools: ${formatAvailableToolNames(deps.toolsForRun)}. Use only registered tool names.`,
      };
    }

    
    const schemaCheck = validateToolInputObject(tool, call.input);
    if (!schemaCheck.ok) {
      return { kind: 'pre-blocked', text: schemaCheck.message };
    }

    
    const hooked = await runPreToolHookChain(call.name, schemaCheck.value, deps.sessionKey);
    if (!hooked.ok) {
      return { kind: 'pre-blocked', text: hooked.message };
    }
    call.input = hooked.input;

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

    
    let approvalTriggered = false;
    if (deps.checkToolApproval) {
      const approval = await abortable(
        deps.checkToolApproval({ ...call, abortSignal: effectiveAbortSignal }),
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
          return {
            kind: 'denied',
            text: reason ? `Tool execution denied: ${reason}` : 'Tool execution denied by user.',
          };
        }
      }
    }

    
    if (deps.toolHooks) {
      const { decision, hookName } = await deps.toolHooks.runPreHooks({
        tool,
        input: call.input,
        ctx: callToolCtx,
        sessionId: deps.sessionKey,
      });
      if (decision.action === 'block') {
        return { kind: 'hook-blocked', text: `[${hookName}] ${decision.reason}` };
      }
      if (decision.action === 'modify') {
        call.input = decision.input;
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

    const skipAgentHeartbeat = !deps.enableHeartbeat || deps.skipHeartbeatToolNames.has(call.name);

    let retriesUsed = 0;
    const eligibleForRetry =
      (tool.metadata?.transientRetry ?? TRANSIENT_RETRY_TOOLS.has(call.name)) && !approvalTriggered;

    for (let attempt = 0; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
      
      if (deps.abortSignal.aborted) {
        aborted = { by: 'user' };
        text = text || 'Execution error: aborted_by_user: cancelled before retry';
        errFlag = true;
        break;
      }

      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      let heartbeatHandle: ReturnType<typeof setInterval> | null = null;
      let attemptErrFlag = false;
      let attemptText = '';
      let attemptTimeout = false;
      
      
      structuredBlocks = undefined;
      const timeoutAbortCtrl = new AbortController();

      try {
        const toolTimeoutPromise = new Promise<never>(
          (_, reject) =>
            (timeoutHandle = setTimeout(() => {
              try {
                timeoutAbortCtrl.abort();
              } catch {
                
              }
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
        const attemptCtx: ToolContext = { ...callToolCtx, abortSignal: attemptSignal };
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
              } catch {
                
              }
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
          }
        } else {
          attemptText = await Promise.race([
            abortable(tool.execute(call.input, attemptCtx), attemptSignal),
            toolTimeoutPromise,
          ]);
          // Many tools (exec, edit_file, …) return error as a string instead of
          // throwing. Detect those so is_error / failure gates / loop-guard
          // see a real failure (Claude/Codex: non-zero shell is not success).
          if (!attemptErrFlag && isStringToolFailureResult(attemptText)) {
            attemptErrFlag = true;
          }
        }
      } catch (err) {
        const rawMessage = errorMessage(err);
        if (
          timeoutAbortCtrl.signal.aborted &&
          !deps.abortSignal.aborted &&
          !perToolAbortSignal?.aborted
        ) {
          attemptTimeout = true;
          attemptText = `Execution error: Tool ${call.name} timed out (${deps.toolTimeoutMs / 1000}s)`;
        } else if (
          deps.abortSignal.aborted ||
          (perToolAbortSignal?.aborted && !deps.abortSignal.aborted)
        ) {
          aborted = { by: 'user' };
          attemptText = 'Execution error: aborted_by_user: cancelled during execution';
        } else if (/timed out/i.test(rawMessage)) {
          attemptTimeout = true;
          attemptText = `Execution error: ${rawMessage}`;
        } else if (isMossError(err) && err.code === ErrorCode.TOOL_NOT_ALLOWED) {
          attemptText = policyBlockedToolResult(err);
        } else {
          attemptText = `Execution error: ${rawMessage}`;
        }
        attemptErrFlag = true;
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        if (heartbeatHandle) clearInterval(heartbeatHandle);
      }

      
      if (attemptErrFlag && eligibleForRetry && attempt < MAX_RETRY_ATTEMPTS && !aborted) {
        const rawMsg = attemptText.replace(/^Execution error:\s*/, '');
        if (
          !/Device connection lost/i.test(rawMsg) &&
          (isTransientError(rawMsg) || isTimeoutError(rawMsg))
        ) {
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
      break;
    }

    
    emitStart();

    
    if (deps.toolHooks) {
      text = await deps.toolHooks.runPostHooks({
        tool,
        input: call.input,
        result: text,
        isError: errFlag,
        durationMs: Date.now() - startMs,
        ctx: callToolCtx,
        sessionId: deps.sessionKey,
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
      ...(structuredBlocks ? { structuredContent: structuredBlocks } : {}),
    };
  } catch (err) {
    if (isMossError(err) && err.code === ErrorCode.USER_ABORTED) {
      return {
        kind: 'completed',
        text: 'Execution error: aborted_by_user: cancelled before tool execution completed',
        isError: true,
        durationMs: 0,
        aborted: { by: 'user' },
      };
    }
    return { kind: 'pre-blocked', text: `Execution error: ${describeError(err)}` };
  }
}





export function outcomeToResult(outcome: ExecuteToolCallOutcome): {
  text: string;
  isError: boolean;
  structuredContent?: ToolContentBlock[];
} {
  switch (outcome.kind) {
    case 'completed':
      return {
        text: outcome.text,
        isError: outcome.isError,
        ...(outcome.structuredContent ? { structuredContent: outcome.structuredContent } : {}),
      };
    case 'unknown-tool':
    case 'pre-blocked':
    case 'hook-blocked':
    case 'denied':
      return { text: outcome.text, isError: true };
  }
}
