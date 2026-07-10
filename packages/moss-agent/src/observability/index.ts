export { redactSensitiveData, parseTelemetryAllow } from './redact.js';
export type { RedactOptions } from './redact.js';
export {
  TraceRegistry,
  setTracer,
  getTracer,
  withSpan,
  turnAttributes,
  toolAttributes,
  llmRequestAttributes,
} from './tracing.js';
export type { Tracer, TraceSpan } from './tracing.js';
export {
  logLLMUsage,
  readUsageLog,
  summarizeUsage,
  formatUsageSummary,
  estimateLLMCost,
  registerModelPricing,
} from './llm-usage.js';
export type { LLMUsageRecord, LLMUsageSummary } from './llm-usage.js';

// A/B testing
export {
  ABTestRegistry,
  globalABTests,
} from './ab-testing.js';
export type {
  ABTestConfig,
  ABTestResult,
  ABTestStats,
  ABTestReport,
} from './ab-testing.js';

// Trace file exporter
export {
  TraceFileExporter,
  globalTraceExporter,
} from './trace-exporter.js';
export type { SerializedSpan, TraceStats } from './trace-exporter.js';
