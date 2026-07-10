/**
 * TraceFileExporter — serializes TraceSpans to a local JSONL file.
 *
 * Default: no-op until init() is called. When enabled, spans are buffered in
 * memory and flushed to .moss/analytics/traces.jsonl every 30 seconds.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

export interface SerializedSpan {
  name: string;
  startTime: number;
  endTime: number;
  attributes: Record<string, string | number | boolean>;
  events: Array<{ name: string; time: number; attrs?: Record<string, unknown> }>;
  status: 'ok' | 'error';
  statusMessage?: string;
}

export interface TraceStats {
  totalSpans: number;
  totalErrors: number;
  errorRate: number;
  byName: Record<string, { count: number; errors: number; avgDurationMs: number }>;
  toolSpans: Array<{ toolName: string; count: number; errors: number; avgDurationMs: number }>;
}

export class TraceFileExporter {
  private enabled = false;
  private buffer: SerializedSpan[] = [];
  private analyticsDir: string | null = null;
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  init(workspaceDir: string): void {
    this.enabled = true;
    this.analyticsDir = path.join(workspaceDir, '.moss', 'analytics');
    this.flushTimer = setInterval(() => this.flush(), 30_000);
  }

  exportSpan(span: SerializedSpan): void {
    if (!this.enabled) return;
    this.buffer.push(span);
  }

  async flush(): Promise<void> {
    if (!this.enabled || !this.analyticsDir || this.buffer.length === 0) return;
    try {
      await fs.mkdir(this.analyticsDir, { recursive: true });
      const file = path.join(this.analyticsDir, 'traces.jsonl');
      const lines = this.buffer.map((s) => JSON.stringify(s)).join('\n') + '\n';
      await fs.appendFile(file, lines, 'utf-8');
    } catch {
      // Silently ignore — never block the agent
    }
    this.buffer = [];
  }

  async cleanup(): Promise<void> {
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flushTimer = null;
    await this.flush();
    this.enabled = false;
    this.analyticsDir = null;
  }

  /** Read aggregated stats from the JSONL file (for CLI reporting). */
  async getStats(): Promise<TraceStats> {
    if (!this.analyticsDir) return emptyStats();
    const file = path.join(this.analyticsDir, 'traces.jsonl');
    let lines: string[];
    try {
      const content = await fs.readFile(file, 'utf-8');
      lines = content.split('\n').filter(Boolean);
    } catch {
      return emptyStats();
    }

    const stats: TraceStats = {
      totalSpans: 0,
      totalErrors: 0,
      errorRate: 0,
      byName: {},
      toolSpans: [],
    };

    for (const line of lines) {
      try {
        const span: SerializedSpan = JSON.parse(line);
        stats.totalSpans++;
        if (span.status === 'error') stats.totalErrors++;

        const name = span.name;
        if (!stats.byName[name]) {
          stats.byName[name] = { count: 0, errors: 0, avgDurationMs: 0 };
        }
        const entry = stats.byName[name];
        entry.count++;
        if (span.status === 'error') entry.errors++;
        const duration = span.endTime - span.startTime;
        entry.avgDurationMs =
          (entry.avgDurationMs * (entry.count - 1) + duration) / entry.count;

        if (name === 'tool.execute') {
          const toolName = String(span.attributes.toolName || 'unknown');
          let toolEntry = stats.toolSpans.find((t) => t.toolName === toolName);
          if (!toolEntry) {
            toolEntry = { toolName, count: 0, errors: 0, avgDurationMs: 0 };
            stats.toolSpans.push(toolEntry);
          }
          toolEntry.count++;
          if (span.status === 'error') toolEntry.errors++;
          toolEntry.avgDurationMs =
            (toolEntry.avgDurationMs * (toolEntry.count - 1) + duration) / toolEntry.count;
        }
      } catch {
        // Skip corrupted lines
      }
    }

    stats.errorRate = stats.totalSpans > 0 ? stats.totalErrors / stats.totalSpans : 0;
    stats.toolSpans.sort((a, b) => b.count - a.count);
    return stats;
  }
}

function emptyStats(): TraceStats {
  return { totalSpans: 0, totalErrors: 0, errorRate: 0, byName: {}, toolSpans: [] };
}

/** Global singleton */
export const globalTraceExporter = new TraceFileExporter();