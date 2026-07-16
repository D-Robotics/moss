/**
 * OpenTelemetry metrics for Moss — instrument handles.
 *
 * Uses the global MeterProvider. When none is registered (observability
 * disabled), metrics.getMeter() returns a noop meter whose instruments are
 * no-ops, so business code calls .add()/.record() unconditionally at zero cost.
 *
 * Usage:
 *   import { mossMetrics } from './observability/index.js';
 *   mossMetrics.llmTokens.add(inputTokens, { direction: 'input', model });
 */
import { metrics } from '@opentelemetry/api';

const meter = metrics.getMeter('moss-agent');

export const mossMetrics = {
  // LLM
  llmTokens: meter.createCounter('moss.llm.tokens', { unit: '{token}' }),
  llmDuration: meter.createHistogram('moss.llm.request.duration', { unit: 'ms' }),
  // tool
  toolInvocations: meter.createCounter('moss.tool.invocations'),
  toolDuration: meter.createHistogram('moss.tool.invoke.duration', { unit: 'ms' }),
  // session
  sessionCount: meter.createCounter('moss.session.count'),
  sessionDuration: meter.createHistogram('moss.session.duration', { unit: 'ms' }),
  // 每轮工具数（纠正 from-remote 把它误命名为 session.turns 的错位）
  sessionToolCount: meter.createHistogram('moss.session.tool_count'),
};
