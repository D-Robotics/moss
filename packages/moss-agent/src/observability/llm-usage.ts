









import fs from 'node:fs';
import path from 'node:path';



export interface LLMUsageRecord {
  timestamp: string;
  runId: string;
  providerId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  
  estimatedCostUsd?: number;
  
  durationMs: number;
  
  success: boolean;
  
  error?: string;
}

export interface LLMUsageSummary {
  totalRequests: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  byModel: Record<
    string,
    {
      requests: number;
      inputTokens: number;
      outputTokens: number;
      costUsd: number;
    }
  >;
  byProvider: Record<
    string,
    {
      requests: number;
      inputTokens: number;
      outputTokens: number;
      costUsd: number;
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



function getUsageLogPath(): string {
  const envPath = process.env.MOSS_LLM_USAGE_LOG;
  if (envPath) return envPath;
  const cwd = process.env.MOSS_WORKSPACE_DIR ?? process.cwd();
  return path.join(cwd, '.moss', 'llm-usage.jsonl');
}



function estimateCost(
  model: string,
  inputTokens: number,
  outputTokens: number
): number | undefined {
  const pricing = MODEL_PRICING[model];
  if (!pricing) return undefined;
  return (inputTokens / 1000) * pricing.input + (outputTokens / 1000) * pricing.output;
}





export async function logLLMUsage(
  record: Omit<LLMUsageRecord, 'timestamp' | 'estimatedCostUsd'>
): Promise<void> {
  const logPath = getUsageLogPath();
  const dir = path.dirname(logPath);

  try {
    await fs.promises.mkdir(dir, { recursive: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }

  const fullRecord: LLMUsageRecord = {
    ...record,
    timestamp: new Date().toISOString(),
    estimatedCostUsd: estimateCost(record.model, record.inputTokens, record.outputTokens),
  };

  const line = JSON.stringify(fullRecord) + '\n';
  await fs.promises.appendFile(logPath, line, 'utf-8');
}






export async function readUsageLog(): Promise<LLMUsageRecord[]> {
  const logPath = getUsageLogPath();
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
    totalCostUsd: 0,
    byModel: {},
    byProvider: {},
    periodStart: filtered.length > 0 ? filtered[0].timestamp : (periodStart ?? ''),
    periodEnd: filtered.length > 0 ? filtered[filtered.length - 1].timestamp : (periodEnd ?? ''),
  };

  for (const r of filtered) {
    summary.totalInputTokens += r.inputTokens;
    summary.totalOutputTokens += r.outputTokens;
    summary.totalCostUsd += r.estimatedCostUsd ?? 0;

    
    const m = (summary.byModel[r.model] ??= {
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    });
    m.requests++;
    m.inputTokens += r.inputTokens;
    m.outputTokens += r.outputTokens;
    m.costUsd += r.estimatedCostUsd ?? 0;

    
    const p = (summary.byProvider[r.providerId] ??= {
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    });
    p.requests++;
    p.inputTokens += r.inputTokens;
    p.outputTokens += r.outputTokens;
    p.costUsd += r.estimatedCostUsd ?? 0;
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
  if (summary.totalCostUsd > 0) {
    lines.push(`  Est. cost:      $${summary.totalCostUsd.toFixed(4)}`);
  }
  lines.push('');

  if (Object.keys(summary.byModel).length > 0) {
    lines.push('  By model:');
    for (const [model, m] of Object.entries(summary.byModel)) {
      const costStr = m.costUsd > 0 ? ` — $${m.costUsd.toFixed(4)}` : '';
      lines.push(
        `    ${model}: ${m.requests} req, ${m.inputTokens.toLocaleString()}/${m.outputTokens.toLocaleString()} tokens${costStr}`
      );
    }
    lines.push('');
  }

  if (Object.keys(summary.byProvider).length > 0) {
    lines.push('  By provider:');
    for (const [provider, p] of Object.entries(summary.byProvider)) {
      const costStr = p.costUsd > 0 ? ` — $${p.costUsd.toFixed(4)}` : '';
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
