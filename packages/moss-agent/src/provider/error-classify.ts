




















import { sanitizeSecrets } from '../safety/secret-sanitizer.js';
import type { ProviderErrorResponse } from './errors.js';
import { isOverflowMessage } from './overflow-patterns.js';

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

const ACTION_RETRY: ProviderErrorAction = { id: 'retry', label: '重试', variant: 'primary' };
const ACTION_OPEN_SETTINGS: ProviderErrorAction = {
  id: 'openSettings',
  label: '打开设置',
  variant: 'secondary',
};
const ACTION_OPEN_BOARD_AGENT: ProviderErrorAction = {
  id: 'openBoardAgent',
  label: '检查板端智能体',
  variant: 'primary',
};
const ACTION_SWITCH_MODEL: ProviderErrorAction = {
  id: 'switchModel',
  label: '换个模型',
  variant: 'ghost',
};
const ACTION_NEW_SESSION: ProviderErrorAction = {
  id: 'newSession',
  label: '开新对话',
  variant: 'ghost',
};

function matchAuth(msg: string, status?: number): boolean {
  if (status === 401) return true;
  const m = msg.toLowerCase();
  return /incorrect api key|invalid api key|unauthorized|api key/i.test(m);
}

function matchContextCorruption(msg: string): { hit: boolean; flavor: 'thinking' | 'tool' | null } {
  const m = msg.toLowerCase();
  if (m.includes('reasoning_content') && m.includes('thinking mode')) {
    return { hit: true, flavor: 'thinking' };
  }
  if (m.includes('tool result') && m.includes('not found')) {
    return { hit: true, flavor: 'tool' };
  }
  if (/\(2013\)/.test(m)) {
    return { hit: true, flavor: 'tool' };
  }
  return { hit: false, flavor: null };
}

function matchAbort(msg: string): boolean {
  const m = msg.toLowerCase();
  return m.includes('request was aborted') || m.includes('aborterror') || m === 'aborted';
}












function matchQuotaExceeded(msg: string): boolean {
  if (!msg) return false;
  const m = msg.toLowerCase();
  return (
    /exceeded (?:the |your )?(?:monthly |daily |current )?(?:usage )?quota/.test(m) ||
    /monthly usage (?:quota|limit)/.test(m) ||
    /usage limit (?:exceeded|reached)/.test(m) ||
    /plan (?:quota|limit)/.test(m) ||
    /insufficient_quota/.test(m) ||
    /out of credits/.test(m)
  );
}

function matchRateLimit(msg: string, status?: number): boolean {
  if (status === 429) return true;
  const m = msg.toLowerCase();
  return /rate[ _-]?limit|quota|too many requests|limit exceeded/i.test(m);
}

function matchNetwork(msg: string): boolean {
  const m = msg.toLowerCase();
  return /econnreset|connection reset|econnrefused|etimedout|enotfound|eai_again|network ?error|fetch failed|networkerror/i.test(
    m
  );
}

function matchOpaqueStreamConnectionDrop(msg: string): boolean {
  const m = msg.toLowerCase().trim();
  return (
    m === 'terminated' ||
    m === 'connection error' ||
    m === 'connection error.' ||
    /^(?:llm\s+stream\s+error:\s*)?terminated\.?$/i.test(msg.trim()) ||
    /^(?:llm\s+stream\s+error:\s*)?connection error\.?$/i.test(msg.trim()) ||
    /terminated.*other side closed|other side closed|stream.*terminated/i.test(m)
  );
}

function matchToolUnsupported(msg: string): boolean {
  const m = msg.toLowerCase();
  return /does not support tools|tools? (?:are )?not supported|tool use (?:is )?not supported|unsupported.*tools?|function[ _]call(?:ing)? not supported|no tools? (?:are )?available/i.test(
    m
  );
}

function matchTimeout(msg: string, status?: number): boolean {
  if (status === 504) return true;
  const m = msg.toLowerCase();
  return /\btimed? ?out\b|timeout exceeded|first[ -]?event timeout|piaifirsteventtimeouterror/i.test(
    m
  );
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

function matchServiceUnavailable(msg: string, status?: number): boolean {
  if (status === 502 || status === 503) return true;
  const m = msg.toLowerCase();
  return /service unavailable|temporarily unavailable|upstream (?:server|gateway) (?:error|busy)|gateway timeout|bad gateway|upstream connect error|model is currently overloaded|overloaded_error|server is busy|(?:llm\s+stream\s+error:\s*)?codex\s+stream\s+error/i.test(
    m
  );
}

function matchContextLengthExceeded(msg: string, code?: string): boolean {
  if ((code ?? '').toLowerCase() === 'context_length_exceeded') return true;
  const c = (code ?? '').toLowerCase();
  if (
    (c === 'invalid_request_error' || c === 'bad_request') &&
    /context|token|length|窗口|超限|过长/i.test(msg)
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

  
  if (matchAbort(raw)) {
    if (input.abortReason === 'user') return SILENT_USER_ABORT;
    if (input.abortReason === 'timeout') {
      return {
        category: 'timeout',
        userMessage: '模型响应超时，请稍后重试。',
        actions: [ACTION_RETRY, ACTION_SWITCH_MODEL],
        silent: false,
        retryable: true,
      };
    }
    return {
      category: 'aborted_by_server',
      userMessage: '请求被中断，请稍后重试。',
      actions: [ACTION_RETRY],
      silent: false,
      retryable: true,
    };
  }

  
  if (matchAuth(raw, status)) {
    return {
      category: 'auth',
      userMessage: '模型访问密钥无效或配置异常，请在设置中校验。',
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
        userMessage: '思考模式历史上下文缺少 reasoning 信息，建议开新对话或重试。',
        actions: [ACTION_NEW_SESSION, ACTION_RETRY],
        silent: false,
        retryable: false,
      };
    }
    return {
      category: 'context_corruption',
      userMessage: '工具调用上下文丢失，建议重新提问。',
      actions: [ACTION_RETRY, ACTION_NEW_SESSION],
      silent: false,
      retryable: false,
    };
  }

  
  
  if (matchQuotaExceeded(raw)) {
    return {
      category: 'quota_exceeded',
      userMessage: '当前模型的调用额度已用尽，建议换个模型或在设置中调整。',
      actions: [ACTION_SWITCH_MODEL, ACTION_OPEN_SETTINGS],
      silent: false,
      retryable: false,
    };
  }

  
  if (matchRateLimit(raw, status)) {
    return {
      category: 'rate_limit',
      userMessage: '访问太频繁，请稍后再试。',
      actions: [ACTION_RETRY],
      silent: false,
      retryable: true,
    };
  }

  
  if (matchNetwork(raw)) {
    return {
      category: 'network',
      userMessage: '网络连接失败，请检查网络或代理配置。',
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
      ? '本机快速模型不可用：请确认 Ollama 已启动且已拉取该模型；可打开「本地模型」完成安装与下发。'
      : localish
        ? '本机找不到该模型或未启动推理服务。请在「本地模型」检查运行状态与模型列表，或核对设置中的模型 ID。'
        : '云端或网关找不到该模型 ID。请到服务商控制台核对名称/权限，或在设置中更换模型。';
    return {
      category: 'model_not_found',
      userMessage,
      actions: [ACTION_OPEN_SETTINGS, ACTION_SWITCH_MODEL],
      silent: false,
      retryable: false,
    };
  }

  // Context length exceeded
  if (matchContextLengthExceeded(raw, code)) {
    return {
      category: 'context_length_exceeded',
      userMessage:
        '对话上下文已超出模型限制。建议开启新对话（Moss 会保留上一个会话的摘要），或换用更大上下文窗口的模型。',
      actions: [ACTION_NEW_SESSION, ACTION_RETRY, ACTION_SWITCH_MODEL],
      silent: false,
      retryable: true,
    };
  }

  
  if (matchServiceUnavailable(raw, status) || matchOpaqueStreamConnectionDrop(raw)) {
    return {
      category: 'service_unavailable',
      userMessage: '厂商服务暂时不可用，请稍后再试或切换深度/快速车道。',
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

  
  if (matchTimeout(raw, status)) {
    return {
      category: 'timeout',
      userMessage: '模型响应超时，请稍后重试或在设置里换一个更快的模型。',
      actions: [ACTION_RETRY, ACTION_SWITCH_MODEL],
      silent: false,
      retryable: true,
    };
  }

  
  return {
    category: 'unknown',
    userMessage:
      '模型暂时不可用。若当前对话反复失败，请开启新对话并让 Moss 查看上一个会话内容后继续。',
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
  return `${head}\n\n下一步：${actionsLine}`;
}







export function sanitizeRawErrorForDetail(raw: string): string {
  if (!raw) return '';
  return sanitizeSecrets(raw);
}
