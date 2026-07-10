/**
 * A/B Testing Framework — compare prompt/strategy variants.
 *
 * Determinisically assigns sessions to variants and tracks results.
 * Results are stored in .moss/ab-tests/ for analysis.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

export interface ABTestConfig {
  name: string;
  variants: string[];
  trafficSplit: number[];
  description?: string;
  autoStop?: boolean;
  minSamples?: number;
  significanceThreshold?: number;
}

export interface ABTestResult {
  variant: string;
  success: boolean;
  durationMs: number;
  tokensUsed: number;
  corrections: number;
  metadata?: Record<string, unknown>;
}

export interface ABTestStats {
  variant: string;
  samples: number;
  successRate: number;
  avgDurationMs: number;
  avgTokens: number;
  avgCorrections: number;
}

export interface ABTestReport {
  name: string;
  description?: string;
  variants: ABTestStats[];
  winner: string | null;
  confidence: number;
  totalSamples: number;
  startedAt: number;
  updatedAt: number;
}

function hashToBucket(key: string, numBuckets: number): number {
  const hash = createHash('sha256').update(key).digest();
  const num = hash.readUInt32BE(0);
  return num % numBuckets;
}

class ABTestInstance {
  readonly config: ABTestConfig;
  private results: ABTestResult[] = [];
  private startedAt: number;
  private storageDir: string | null = null;

  constructor(config: ABTestConfig) {
    this.config = config;
    this.startedAt = Date.now();
  }

  setStorageDir(dir: string): void { this.storageDir = dir; }

  assign(sessionKey: string): string {
    const bucket = hashToBucket(`${this.config.name}:${sessionKey}`, 10000);
    let cumulative = 0;
    for (let i = 0; i < this.config.variants.length; i++) {
      cumulative += this.config.trafficSplit[i] * 10000;
      if (bucket < cumulative) return this.config.variants[i];
    }
    return this.config.variants[this.config.variants.length - 1];
  }

  record(variant: string, result: Omit<ABTestResult, 'variant'>): void {
    this.results.push({ variant, ...result });
  }

  getStats(): ABTestStats[] {
    const variantMap = new Map<string, ABTestResult[]>();
    for (const r of this.results) {
      const list = variantMap.get(r.variant) || [];
      list.push(r);
      variantMap.set(r.variant, list);
    }
    return this.config.variants.map((variant) => {
      const results = variantMap.get(variant) || [];
      const samples = results.length;
      const successes = results.filter((r) => r.success).length;
      return {
        variant, samples,
        successRate: samples > 0 ? successes / samples : 0,
        avgDurationMs: samples > 0 ? results.reduce((s, r) => s + r.durationMs, 0) / samples : 0,
        avgTokens: samples > 0 ? results.reduce((s, r) => s + r.tokensUsed, 0) / samples : 0,
        avgCorrections: samples > 0 ? results.reduce((s, r) => s + r.corrections, 0) / samples : 0,
      };
    });
  }

  getReport(): ABTestReport {
    const stats = this.getStats();
    const totalSamples = stats.reduce((s, st) => s + st.samples, 0);
    let winner: string | null = null;
    let confidence = 0;
    const sorted = [...stats].sort((a, b) => b.successRate - a.successRate);
    if (sorted.length >= 2 && sorted[0].samples > 0 && sorted[1].samples > 0) {
      const best = sorted[0], second = sorted[1];
      const minSamples = this.config.minSamples ?? 10;
      const threshold = this.config.significanceThreshold ?? 0.95;
      if (best.samples >= minSamples && second.samples >= minSamples) {
        const p1 = best.successRate, p2 = second.successRate;
        const n1 = best.samples, n2 = second.samples;
        const p = (p1 * n1 + p2 * n2) / (n1 + n2);
        const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
        const z = se > 0 ? (p1 - p2) / se : 0;
        confidence = Math.min(1, Math.max(0, 0.5 + z / 6));
        if (confidence >= threshold) winner = best.variant;
      }
    }
    return { name: this.config.name, description: this.config.description, variants: stats, winner, confidence, totalSamples, startedAt: this.startedAt, updatedAt: Date.now() };
  }

  async save(): Promise<void> {
    if (!this.storageDir) return;
    const report = this.getReport();
    const file = path.join(this.storageDir, `${this.config.name}.json`);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(report, null, 2));
  }

  getResults(): ABTestResult[] { return this.results; }
}

export class ABTestRegistry {
  private tests: Map<string, ABTestInstance> = new Map();
  private storageDir: string | null = null;

  async init(workspaceDir: string): Promise<void> {
    this.storageDir = path.join(workspaceDir, '.moss', 'ab-tests');
    await fs.mkdir(this.storageDir, { recursive: true });
    for (const test of this.tests.values()) test.setStorageDir(this.storageDir);
  }

  register(config: ABTestConfig): ABTestInstance {
    if (this.tests.has(config.name)) return this.tests.get(config.name)!;
    const instance = new ABTestInstance(config);
    if (this.storageDir) instance.setStorageDir(this.storageDir);
    this.tests.set(config.name, instance);
    return instance;
  }

  get(name: string): ABTestInstance | undefined { return this.tests.get(name); }
  list(): ABTestConfig[] { return [...this.tests.values()].map((t) => t.config); }
  getAllReports(): ABTestReport[] { return [...this.tests.values()].map((t) => t.getReport()); }

  async saveAll(): Promise<void> {
    for (const test of this.tests.values()) await test.save();
  }
}

export const globalABTests = new ABTestRegistry();