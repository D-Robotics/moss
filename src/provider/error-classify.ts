import { sanitizeSecrets } from '../safety/secret-sanitizer.js';
import type { ProviderErrorResponse } from './errors.js';
import {
  isAbortFailure,
  isAuthFailure,
  isAuthStatus,
  isConnectionError,
  isPrematureStreamClose,
  isQuotaExceededError,
  isRateLimitFailure,
  isServerErrorFailure,
  isThinkingHistoryCorruption,
  isTimeoutFailure,
} from './errors.js';
import { isOverflowMessage } from './overflow-patterns.js';

/**
 * Stable category assigned to a provider/runtime failure.
 *
 * @public
 */
export type ProviderErrorCategory =
  | 'auth'
  | 'context_corruption'
  | 'timeout'
  | 'rate_limit'
  | 'quota_exceeded'
  | 'aborted_by_user'
  | 'aborted_by_server'
  | 'network'
  | 'model_not_found'
  | 'service_unavailable'
  | 'context_length_exceeded'
  | 'tools_not_supported'
  | 'streaming_not_supported'
  | 'empty_response'
  | 'runtime_lifecycle'
  | 'unknown'
  | 'ambiguous';

/**
 * Recovery action that a host can present for a classified provider failure.
 *
 * @public
 */
export interface ProviderErrorAction {
  id:
    | 'retry'
    | 'openSettings'
    | 'switchModel'
    | 'newSession'
    | 'resetSession'
    | 'useFallbackProvider'
    | 'openBoardAgent';

  label: string;

  variant: 'primary' | 'secondary' | 'ghost';
}

/**
 * Host-facing, sanitized representation of a provider/runtime failure.
 *
 * @public
 */
export interface ProviderErrorSurface {
  category: ProviderErrorCategory;

  userMessage: string;

  actions: ProviderErrorAction[];

  silent: boolean;

  retryable: boolean;
}

export interface ProviderErrorInput {
  errorMessage?: string;
  status?: number;
  code?: string;

  abortReason?: 'user' | 'server' | 'timeout';

  provider?: string;
  baseUrl?: string;

  lane?: 'quick' | 'thinking';

  /**
   * Optional unified error response from provider.
   * If provided, status/code/provider are extracted from this.
   */
  providerErrorResponse?: ProviderErrorResponse;
}

const SILENT_USER_ABORT: ProviderErrorSurface = {
  category: 'aborted_by_user',
  userMessage: '',
  actions: [],
  silent: true,
  retryable: false,
};

/**
 * Locale for user-facing strings. The provider layer cannot import the CLI's
 * locale helper (layering), so it reads the same env variables inline; the
 * classifier's Chinese strings are the zh voice and English is the fallback,
 * chosen once at module load (a process does not switch locale mid-run).
 */
function isZhEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const locale = env.LC_ALL || env.LC_MESSAGES || env.LANG || '';
  return /^zh/i.test(locale);
}

function msg(zh: string, en: string): string {
  return isZhEnv() ? zh : en;
}

const ACTION_RETRY: ProviderErrorAction = {
  id: 'retry',
  label: msg('重试', 'Retry'),
  variant: 'primary',
};
const ACTION_OPEN_SETTINGS: ProviderErrorAction = {
  id: 'openSettings',
  label: msg('打开设置', 'Open settings'),
  variant: 'secondary',
};
const ACTION_OPEN_BOARD_AGENT: ProviderErrorAction = {
  id: 'openBoardAgent',
  label: msg('检查板端智能体', 'Check board agent'),
  variant: 'primary',
};
const ACTION_SWITCH_MODEL: ProviderErrorAction = {
  id: 'switchModel',
  label: msg('换个模型', 'Switch model'),
  variant: 'ghost',
};
const ACTION_NEW_SESSION: ProviderErrorAction = {
  id: 'newSession',
  label: msg('开新对话', 'New session'),
  variant: 'ghost',
};

// 判定谓词（abort/auth/rate-limit/timeout/network/5xx/stream-drop/quota/
// thinking-corruption）以 errors.ts 的共享谓词为单一来源（T5.1 去重）；
// 本文件只保留 provider 面特有的判定（model_not_found、context_length、
// tools/streaming/empty/runtime_lifecycle）与 ProviderErrorCategory 视图映射。

function matchContextCorruption(msg: string): { hit: boolean; flavor: 'thinking' | 'tool' | null } {
  if (isThinkingHistoryCorruption(msg)) {
    return { hit: true, flavor: 'thinking' };
  }
  const m = msg.toLowerCase();
  if (m.includes('tool result') && m.includes('not found')) {
    return { hit: true, flavor: 'tool' };
  }
  // DeepSeek SDK error code 2013: "tool id(call_function_...) not found (2013)"
  // — the model referenced a tool-call ID in a tool_result that doesn't match
  // any pending call_function in the current context. Treated as a 'tool'
  // history-format error (same recovery path as the "tool result not found" branch).
  if (/\(2013\)/.test(m)) {
    return { hit: true, flavor: 'tool' };
  }
  return { hit: false, flavor: null };
}

function inferLocalInferenceStack(input: ProviderErrorInput): boolean {
  const p = String(input.provider || '').toLowerCase();
  const raw = `${input.baseUrl || ''}|${input.errorMessage || ''}`.toLowerCase();
  return (
    p === 'ollama' ||
    raw.includes('localhost:11434') ||
    raw.includes('127.0.0.1:11434') ||
    raw.includes('[::1]:11434') ||
    /\boolama\b/.test(raw)
  );
}

function matchModelNotFound(msg: string, status?: number, code?: string): boolean {
  if (status === 404) return true;
  if ((code ?? '').toLowerCase() === 'model_not_found') return true;
  const raw = msg.trim();
  if (
    /\b无效模型\b|无效\s*的?\s*模型|模型\s*无效|未知模型|没有该模型|无此模型|模型不存在/.test(
      raw
    ) ||
    /\binvalid\s+model\b|invalid\s+model\s+name/.test(msg.toLowerCase())
  ) {
    return true;
  }
  const m = msg.toLowerCase();
  return /\bmodel[_ ]not[_ ]found\b|no such model|model.*does not exist|the model (?:is )?(?:has been )?deprecated|model.*not (?:available|supported|enabled|active)|the requested model is/i.test(
    m
  );
}

function matchToolUnsupported(msg: string): boolean {
  const m = msg.toLowerCase();
  return /does not support tools|tools? (?:are )?not supported|tool use (?:is )?not supported|unsupported.*tools?|function[ _]call(?:ing)? not supported|no tools? (?:are )?available/i.test(
    m
  );
}

function matchContextLengthExceeded(msg: string, code?: string): boolean {
  if ((code ?? '').toLowerCase() === 'context_length_exceeded') return true;
  const c = (code ?? '').toLowerCase();
  if (
    (c === 'invalid_request_error' || c === 'bad_request') &&
    // Tightened: require an overflow sense of "context" — not just the bare
    // word. "context deadline exceeded" (gRPC/Go timeout) was a false positive
    // under the old /context|token|length|.../ alternation. (Found by moss
    // self-iteration — glm-5.2 reviewed this file.)
    /context (?:length|window|size|limit)|exceeds? .*context|上下文|窗口|超限|过长/i.test(msg)
  ) {
    return true;
  }
  // Delegates to overflow-patterns.ts — merged Pi v0.80.3 per-provider regex
  // patterns (25+) + moss Chinese patterns. The previous inline Chinese +
  // English regexes are subsumed by the consolidated pattern set.
  return isOverflowMessage(msg);
}

function matchStreamingUnsupported(msg: string): boolean {
  const m = msg.toLowerCase();
  return /stream(?:ing)? (?:is )?not supported|does not support stream|stream (?:is )?disabled|cannot stream/i.test(
    m
  );
}

function matchEmptyResponse(msg: string): boolean {
  const m = msg.toLowerCase();
  return /empty (?:response|content|completion)|received (?:an )?empty|model returned empty|response had no content/i.test(
    m
  );
}

function matchRuntimeLifecycle(msg: string): boolean {
  const m = msg.toLowerCase();
  return (
    /lifecyle_error|lifecycle_error|requested agent harness|agent harness .*not registered|protocol mismatch|agent session failed|occode/i.test(
      msg
    ) ||
    /anthropic messages transport requires a positive maxtokens value|requires a positive maxTokens value/i.test(
      msg
    ) ||
    (m.includes('board agent') &&
      /gateway|protocol|lifecycle|harness|not registered|maxtokens/.test(m))
  );
}

export function classifyProviderError(input: ProviderErrorInput): ProviderErrorSurface {
  // Extract metadata from unified error response if provided
  const resp = input.providerErrorResponse;
  const raw = String(resp?.message ?? input.errorMessage ?? '').trim();
  const status = resp?.status ?? input.status;
  const code = resp?.code ?? input.code;
  const provider = resp?.provider ?? input.provider;

  if (isAbortFailure(raw)) {
    if (input.abortReason === 'user') return SILENT_USER_ABORT;
    if (input.abortReason === 'timeout') {
      return {
        category: 'timeout',
        userMessage: msg('模型响应超时，请稍后重试。', 'The model timed out; try again shortly.'),
        actions: [ACTION_RETRY, ACTION_SWITCH_MODEL],
        silent: false,
        retryable: true,
      };
    }
    return {
      category: 'aborted_by_server',
      userMessage: msg(
        '请求被中断，请稍后重试。',
        'The request was interrupted; try again shortly.'
      ),
      actions: [ACTION_RETRY],
      silent: false,
      retryable: true,
    };
  }

  // A first-chunk stall message can include generic setup guidance such as
  // "check API Key". Classify the observed timeout before matching auth text.
  // An explicit HTTP auth status (401/403) remains authoritative.
  if (!isAuthStatus(status) && isTimeoutFailure(raw, status)) {
    return {
      category: 'timeout',
      userMessage: msg(
        '模型响应超时，请稍后重试或在设置里换一个更快的模型。',
        'The model timed out; try again shortly or switch to a faster model in settings.'
      ),
      actions: [ACTION_RETRY, ACTION_SWITCH_MODEL],
      silent: false,
      retryable: true,
    };
  }

  if (isAuthFailure(raw, status)) {
    return {
      category: 'auth',
      userMessage: msg(
        '模型访问密钥无效或配置异常，请在设置中校验。',
        'The model API key is invalid or misconfigured; check it in settings.'
      ),
      actions: [ACTION_OPEN_SETTINGS, ACTION_SWITCH_MODEL],
      silent: false,
      retryable: false,
    };
  }

  const ctx = matchContextCorruption(raw);
  if (ctx.hit) {
    if (ctx.flavor === 'thinking') {
      return {
        category: 'context_corruption',
        userMessage: msg(
          '思考模式历史上下文缺少 reasoning 信息，建议开新对话或重试。',
          'The thinking-mode history is missing reasoning payloads; start a new session or retry.'
        ),
        actions: [ACTION_NEW_SESSION, ACTION_RETRY],
        silent: false,
        retryable: false,
      };
    }
    return {
      category: 'context_corruption',
      userMessage: msg(
        '工具调用上下文丢失，建议重新提问。',
        'Tool-call context was lost; ask again.'
      ),
      actions: [ACTION_RETRY, ACTION_NEW_SESSION],
      silent: false,
      retryable: false,
    };
  }

  if (isQuotaExceededError(raw)) {
    return {
      category: 'quota_exceeded',
      userMessage: msg(
        '当前模型的调用额度已用尽，建议换个模型或在设置中调整。',
        "This model's quota is exhausted; switch models or adjust in settings."
      ),
      actions: [ACTION_SWITCH_MODEL, ACTION_OPEN_SETTINGS],
      silent: false,
      retryable: false,
    };
  }

  if (isRateLimitFailure(raw, status)) {
    return {
      category: 'rate_limit',
      userMessage: msg('访问太频繁，请稍后再试。', 'Rate limited; try again shortly.'),
      actions: [ACTION_RETRY],
      silent: false,
      retryable: true,
    };
  }

  if (isConnectionError(raw)) {
    return {
      category: 'network',
      userMessage: msg(
        '网络连接失败，请检查网络或代理配置。',
        'Network connection failed; check the network or proxy configuration.'
      ),
      actions: [ACTION_RETRY, ACTION_OPEN_SETTINGS],
      silent: false,
      retryable: true,
    };
  }

  // Model not found
  if (matchModelNotFound(raw, status, code)) {
    const inferInput = {
      provider: provider ?? input.provider,
      baseUrl: input.baseUrl,
      errorMessage: raw,
    };
    const localish = inferLocalInferenceStack(inferInput as ProviderErrorInput);
    const quickLocal = input.lane === 'quick' && localish;
    const userMessage = quickLocal
      ? msg(
          '本机快速模型不可用：请确认 Ollama 已启动且已拉取该模型；可打开「本地模型」完成安装与下发。',
          "The local quick model is unavailable: make sure Ollama is running and the model is pulled; open 'Local models' to install it."
        )
      : localish
        ? msg(
            '本机找不到该模型或未启动推理服务。请在「本地模型」检查运行状态与模型列表，或核对设置中的模型 ID。',
            "The local model was not found or the inference service is not running; check 'Local models' or fix the model ID in settings."
          )
        : msg(
            '云端或网关找不到该模型 ID。请到服务商控制台核对名称/权限，或在设置中更换模型。',
            'The gateway cannot find this model ID; verify the name/permissions in the provider console or switch models in settings.'
          );
    return {
      category: 'model_not_found',
      userMessage,
      actions: [ACTION_OPEN_SETTINGS, ACTION_SWITCH_MODEL],
      silent: false,
      retryable: false,
    };
  }

  // Context length exceeded — retrying the same prompt WILL overflow again;
  // the only recovery is a new session (with compaction) or a bigger model.
  // H3 fix: was retryable:true + ACTION_RETRY, which made runtime-retry loop
  // on the same overflowing prompt. Now retryable:false, actions drop RETRY.
  if (matchContextLengthExceeded(raw, code)) {
    return {
      category: 'context_length_exceeded',
      userMessage: msg(
        '对话上下文已超出模型限制。建议开启新对话（Moss 会保留上一个会话的摘要），或换用更大上下文窗口的模型。',
        "The conversation exceeds the model's context limit; start a new session (Moss keeps a summary of the previous one) or switch to a larger-window model."
      ),
      actions: [ACTION_NEW_SESSION, ACTION_SWITCH_MODEL],
      silent: false,
      retryable: false,
    };
  }

  if (isServerErrorFailure(raw, status) || isPrematureStreamClose(raw)) {
    return {
      category: 'service_unavailable',
      userMessage: msg(
        '厂商服务暂时不可用，请稍后再试或切换深度/快速车道。',
        'The provider is temporarily unavailable; retry shortly or switch between the deep/quick lanes.'
      ),
      actions: [ACTION_RETRY, ACTION_SWITCH_MODEL],
      silent: false,
      retryable: true,
    };
  }

  if (matchStreamingUnsupported(raw)) {
    return {
      category: 'streaming_not_supported',
      userMessage: '当前模型/网关不支持流式输出，请到设置中换一个支持 stream 的模型。',
      actions: [ACTION_OPEN_SETTINGS, ACTION_SWITCH_MODEL],
      silent: false,
      retryable: false,
    };
  }

  if (matchToolUnsupported(raw)) {
    return {
      category: 'tools_not_supported',
      userMessage:
        '当前模型不支持工具调用，工具任务可能失败；请到设置换用支持 tools 的模型（推荐 qwen3 / qwen3-coder / llama3.1 / gpt-4.x 或同类工具模型）。',
      actions: [ACTION_OPEN_SETTINGS, ACTION_SWITCH_MODEL],
      silent: false,
      retryable: false,
    };
  }

  if (matchEmptyResponse(raw)) {
    return {
      category: 'empty_response',
      userMessage:
        '模型返回空内容（常见于思考类模型把所有输出放进 reasoning）。请到设置把「推理可见度」改为「stream」让思考过程可见，或换一个非纯思考模型。',
      actions: [ACTION_OPEN_SETTINGS, ACTION_SWITCH_MODEL],
      silent: false,
      retryable: true,
    };
  }

  if (matchRuntimeLifecycle(raw)) {
    return {
      category: 'runtime_lifecycle',
      userMessage: '板端协作运行时没有准备好，Moss 需要先恢复板端智能体或 Gateway 后才能继续。',
      actions: [ACTION_OPEN_BOARD_AGENT, ACTION_RETRY, ACTION_OPEN_SETTINGS],
      silent: false,
      retryable: true,
    };
  }

  return {
    category: 'unknown',
    userMessage: msg(
      '模型暂时不可用。若当前对话反复失败，请开启新对话并让 Moss 查看上一个会话内容后继续。',
      'The model is temporarily unavailable. If this conversation keeps failing, start a new session and let Moss pick up from the previous one.'
    ),
    actions: [ACTION_RETRY, ACTION_NEW_SESSION, ACTION_SWITCH_MODEL],
    silent: false,
    retryable: false,
  };
}

export function renderProviderErrorSurface(surface: ProviderErrorSurface): string {
  if (surface.silent) return '';
  const head = surface.userMessage;
  if (surface.actions.length === 0) return head;
  const actionsLine = surface.actions.map((a) => a.label).join(' · ');
  return `${head}\n\n${msg('下一步', 'Next steps')}：${actionsLine}`;
}

export function sanitizeRawErrorForDetail(raw: string): string {
  if (!raw) return '';
  return sanitizeSecrets(raw);
}
