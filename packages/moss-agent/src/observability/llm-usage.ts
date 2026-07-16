









import fs from 'node:fs';
import path from 'node:path';



export interface LLMUsageRecord {
  timestamp: string;
  runId: string;
  providerId: string;
  model: string;
  /** Uncached input tokens. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  
  estimatedCostUsd?: number;
  
  durationMs: number;
  
  success: boolean;
  
  error?: string;
}

export interface LLMUsageSummary {
  totalRequests: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
  totalCostUsd: number;
  costUnavailableRequests: number;
  byModel: Record<
    string,
    {
      requests: number;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheCreationTokens: number;
      costUsd: number;
      costUnavailableRequests: number;
    }
  >;
  byProvider: Record<
    string,
    {
      requests: number;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheCreationTokens: number;
      costUsd: number;
      costUnavailableRequests: number;
    }
  >;
  periodStart: string;
  periodEnd: string;
}



const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  
  'claude-opus-4-8': { input: 0.015, output: 0.075 },
  'claude-sonnet-4-6': { input: 0.003, output: 0.015 },
  'claude-haiku-4-5-20251001': { input: 0.001, output: 0.005 },
  
  'gpt-4o': { input: 0.0025, output: 0.01 },
  'gpt-4o-mini': { input: 0.00015, output: 0.0006 },
  
  'deepseek-v4-flash': { input: 0.00009, output: 0.00018 },
  'deepseek-v4-pro': { input: 0.000435, output: 0.00087 },
  
  'deepseek-chat': { input: 0.00009, output: 0.00018 },
  'deepseek-reasoner': { input: 0.00009, output: 0.00018 },
  
  'qwen3.6-plus': { input: 0.0004, output: 0.0016 },
  'qwen3.7-max': { input: 0.0016, output: 0.0064 },
  'qwen3.6-flash': { input: 0.00008, output: 0.00032 },
  
  'qwen-plus': { input: 0.0008, output: 0.002 },
  'qwen-max': { input: 0.002, output: 0.006 },
  'qwen-coder-plus': { input: 0.0008, output: 0.002 },
};





export function registerModelPricing(model: string, inputPer1K: number, outputPer1K: number): void {
  MODEL_PRICING[model] = { input: inputPer1K, output: outputPer1K };
}



export function resolveLLMUsageLogPath(
  options: { logPath?: string; workspaceDir?: string; env?: NodeJS.ProcessEnv } = {}
): string {
  if (options.logPath) return options.logPath;
  const env = options.env ?? process.env;
  const envPath = env.MOSS_LLM_USAGE_LOG;
  if (envPath) return envPath;
  const cwd = options.workspaceDir ?? env.MOSS_WORKSPACE_DIR ?? process.cwd();
  return path.join(cwd, '.moss', 'llm-usage.jsonl');
}



function estimateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens = 0,
  cacheCreationTokens = 0
): number | undefined {
  const pricing = MODEL_PRICING[model];
  if (!pricing) return undefined;
  if (cacheReadTokens > 0 || cacheCreationTokens > 0) return undefined;
  return (inputTokens / 1000) * pricing.input + (outputTokens / 1000) * pricing.output;
}





export async function logLLMUsage(
  record: Omit<LLMUsageRecord, 'timestamp' | 'estimatedCostUsd'>,
  options: { logPath?: string } = {}
): Promise<void> {
  const logPath = resolveLLMUsageLogPath(options);
  const dir = path.dirname(logPath);

  try {
    await fs.promises.mkdir(dir, { recursive: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }

  const fullRecord: LLMUsageRecord = {
    ...record,
    timestamp: new Date().toISOString(),
    estimatedCostUsd: estimateCost(
      record.model,
      record.inputTokens,
      record.outputTokens,
      record.cacheReadTokens,
      record.cacheCreationTokens
    ),
  };

  const line = JSON.stringify(fullRecord) + '\n';
  await fs.promises.appendFile(logPath, line, 'utf-8');
}






export async function readUsageLog(options: { logPath?: string } = {}): Promise<LLMUsageRecord[]> {
  const logPath = resolveLLMUsageLogPath(options);
  try {
    const content = await fs.promises.readFile(logPath, 'utf-8');
    let corruptCount = 0;
    const records = content
      .trim()
      .split('\n')
      .filter((line) => line.length > 0)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as LLMUsageRecord];
        } catch {
          corruptCount++;
          return [];
        }
      });
    if (corruptCount > 0) {
      console.warn(
        `[usage] ${logPath}: skipped ${corruptCount} corrupt line(s). ` +
          `Usage statistics may be slightly undercounted.`
      );
    }
    return records;
  } catch {
    return [];
  }
}




export function summarizeUsage(
  records: LLMUsageRecord[],
  periodStart?: string,
  periodEnd?: string
): LLMUsageSummary {
  const start = periodStart ? new Date(periodStart).getTime() : 0;
  const end = periodEnd ? new Date(periodEnd).getTime() : Infinity;

  const filtered = records.filter((r) => {
    const ts = new Date(r.timestamp).getTime();
    return ts >= start && ts <= end;
  });

  const summary: LLMUsageSummary = {
    totalRequests: filtered.length,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheCreationTokens: 0,
    totalCostUsd: 0,
    costUnavailableRequests: 0,
    byModel: {},
    byProvider: {},
    periodStart: filtered.length > 0 ? filtered[0].timestamp : (periodStart ?? ''),
    periodEnd: filtered.length > 0 ? filtered[filtered.length - 1].timestamp : (periodEnd ?? ''),
  };

  for (const r of filtered) {
    const cacheReadTokens = r.cacheReadTokens ?? 0;
    const cacheCreationTokens = r.cacheCreationTokens ?? 0;
    summary.totalInputTokens += r.inputTokens + cacheReadTokens + cacheCreationTokens;
    summary.totalOutputTokens += r.outputTokens;
    summary.totalCacheReadTokens += cacheReadTokens;
    summary.totalCacheCreationTokens += cacheCreationTokens;
    summary.totalCostUsd += r.estimatedCostUsd ?? 0;
    if (r.estimatedCostUsd === undefined) summary.costUnavailableRequests++;

    
    const m = (summary.byModel[r.model] ??= {
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: 0,
      costUnavailableRequests: 0,
    });
    m.requests++;
    m.inputTokens += r.inputTokens + cacheReadTokens + cacheCreationTokens;
    m.outputTokens += r.outputTokens;
    m.cacheReadTokens += cacheReadTokens;
    m.cacheCreationTokens += cacheCreationTokens;
    m.costUsd += r.estimatedCostUsd ?? 0;
    if (r.estimatedCostUsd === undefined) m.costUnavailableRequests++;

    
    const p = (summary.byProvider[r.providerId] ??= {
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: 0,
      costUnavailableRequests: 0,
    });
    p.requests++;
    p.inputTokens += r.inputTokens + cacheReadTokens + cacheCreationTokens;
    p.outputTokens += r.outputTokens;
    p.cacheReadTokens += cacheReadTokens;
    p.cacheCreationTokens += cacheCreationTokens;
    p.costUsd += r.estimatedCostUsd ?? 0;
    if (r.estimatedCostUsd === undefined) p.costUnavailableRequests++;
  }

  return summary;
}




export function formatUsageSummary(summary: LLMUsageSummary): string {
  const lines: string[] = [];
  lines.push(`LLM Usage Summary`);
  lines.push(`  Period: ${summary.periodStart} → ${summary.periodEnd}`);
  lines.push(`  Total requests: ${summary.totalRequests}`);
  lines.push(
    `  Total tokens:  ${summary.totalInputTokens.toLocaleString()} in / ${summary.totalOutputTokens.toLocaleString()} out`
  );
  if (summary.totalCacheReadTokens > 0 || summary.totalCacheCreationTokens > 0) {
    lines.push(
      `  Prompt cache:  ${summary.totalCacheReadTokens.toLocaleString()} cache read / ${summary.totalCacheCreationTokens.toLocaleString()} cache write`
    );
  }
  if (summary.costUnavailableRequests > 0) {
    lines.push(`  Cost unavailable for ${summary.costUnavailableRequests} request(s) (pricing not configured).`);
  } else {
    lines.push(`  Est. cost:      $${summary.totalCostUsd.toFixed(4)}`);
  }
  lines.push('');

  if (Object.keys(summary.byModel).length > 0) {
    lines.push('  By model:');
    for (const [model, m] of Object.entries(summary.byModel)) {
      const costStr = m.costUnavailableRequests > 0 ? ' — cost unavailable' : ` — $${m.costUsd.toFixed(4)}`;
      lines.push(
        `    ${model}: ${m.requests} req, ${m.inputTokens.toLocaleString()}/${m.outputTokens.toLocaleString()} tokens${costStr}`
      );
    }
    lines.push('');
  }

  if (Object.keys(summary.byProvider).length > 0) {
    lines.push('  By provider:');
    for (const [provider, p] of Object.entries(summary.byProvider)) {
      const costStr = p.costUnavailableRequests > 0 ? ' — cost unavailable' : ` — $${p.costUsd.toFixed(4)}`;
      lines.push(
        `    ${provider}: ${p.requests} req, ${p.inputTokens.toLocaleString()}/${p.outputTokens.toLocaleString()} tokens${costStr}`
      );
    }
  }

  return lines.join('\n');
}





export function estimateLLMCost(
  model: string,
  inputTokens: number,
  outputTokens: number
): number | undefined {
  return estimateCost(model, inputTokens, outputTokens);
}
