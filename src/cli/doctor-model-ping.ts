/**
 * `/doctor` model ping — one tiny completion, bounded, so the report shows
 * that the configured model actually answers. The line names the model and
 * the latency. It never includes the API key.
 */
import { errorMessage } from '../errors.js';
import type { LLMProvider } from '../core/llm/llm-provider.js';
import { classifyProviderError } from '../provider/error-classify.js';
import { uiText } from '../utils/ui-language.js';
import { fail, ok, warn } from './doctor.js';

export const DOCTOR_MODEL_PING_TIMEOUT_MS = 5_000;

export interface DoctorModelPingInput {
  model: string;
  provider?: Pick<LLMProvider, 'complete'>;
  timeoutMs?: number;
  now?: () => number;
  /** Values that must not appear in the printed line (the configured key). */
  secrets?: readonly string[];
}

function redactPingDetail(text: string, secrets: readonly string[]): string {
  let out = text.replace(/\s+/g, ' ').trim();
  for (const secret of secrets) {
    if (secret.length >= 4) out = out.split(secret).join('[redacted]');
  }
  return out
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{6,}\b/g, '[redacted]')
    .replace(/\/\/[^/\s:@]+:[^/\s@]+@/g, '//[redacted]@')
    .slice(0, 200);
}

/**
 * Ask the configured model for a 1-token reply. Returns one doctor line.
 * A missing model or provider is a warning and does not call the network.
 */
export async function probeDoctorModelPing(input: DoctorModelPingInput): Promise<string> {
  const model = input.model.trim();
  const timeoutMs = input.timeoutMs ?? DOCTOR_MODEL_PING_TIMEOUT_MS;
  const secrets = input.secrets ?? [];
  const now = input.now ?? Date.now;
  const provider = input.provider;
  const label = uiText('model ping', '模型探测');
  if (!model) return warn(label, uiText('no model configured', '没有配置模型'));
  if (!provider || typeof provider.complete !== 'function') {
    return warn(label, uiText(`${model} — provider unavailable`, `${model} — 服务商不可用`));
  }

  const started = now();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guarded = Promise.resolve()
    .then(() =>
      provider.complete({
        model,
        systemPrompt: '',
        messages: [{ role: 'user', content: 'ping' }],
        maxTokens: 1,
        abortSignal: controller.signal,
      })
    )
    .then(
      (value) => ({ kind: 'ok' as const, value }),
      (err: unknown) => ({ kind: 'err' as const, err })
    );
  const timeout = new Promise<{ kind: 'timeout' }>((resolve) => {
    timer = setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs);
  });

  try {
    const outcome = await Promise.race([guarded, timeout]);
    const latencyMs = Math.max(0, now() - started);
    if (outcome.kind === 'timeout') {
      controller.abort();
      return fail(
        label,
        uiText(
          `${model} · ${latencyMs}ms · timed out after ${timeoutMs}ms`,
          `${model} · ${latencyMs} 毫秒 · 超时（${timeoutMs} 毫秒）`
        )
      );
    }
    if (outcome.kind === 'err') {
      const detail = redactPingDetail(errorMessage(outcome.err), secrets);
      const surface = classifyProviderError({ errorMessage: detail });
      const fix = surface.userMessage
        ? uiText(` Fix: ${surface.userMessage}`, ` 处理：${surface.userMessage}`)
        : '';
      return fail(
        label,
        uiText(
          `${model} · ${latencyMs}ms · ${detail || 'request failed'}${fix}`,
          `${model} · ${latencyMs} 毫秒 · ${detail || '请求失败'}${fix}`
        )
      );
    }
    const reported = redactPingDetail(outcome.value.model?.trim() || model, secrets) || model;
    return ok(label, uiText(`${reported} · ${latencyMs}ms`, `${reported} · ${latencyMs} 毫秒`));
  } finally {
    if (timer) clearTimeout(timer);
  }
}
