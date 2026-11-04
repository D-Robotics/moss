/**
 * `evals/evals.json`: the machine-checkable part of a skill.
 *
 * A skill is prose written for a model, so "does it work" cannot be answered by
 * reading it. The eval file lists cases that must be exercised with and without
 * the skill loaded; `scripts/skill-eval.mjs` runs them through the real CLI.
 *
 * Accepted shapes (both are common in the wild):
 *   { "skill_name": "x", "evals": [ { "id": "…", "prompt": "…", "expected_output": "…" } ] }
 *   { "cases": [ { "id": "…", "prompt": "…", "expect_contains": ["…"] } ] }
 *
 * Assertions are deliberately mechanical (`expect_contains`); a free-text
 * `expected_output` is kept for humans and reported as unasserted, because a
 * substring match on prose is worse than no check at all.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { SkillIssue } from '../../contracts/skill.js';

export interface SkillEvalCase {
  id: string;
  prompt: string;
  /** Substrings that must appear in the final answer (all of them). */
  expectContains: string[];
  /** Files created in the eval workspace before the run. */
  setup: Record<string, string>;
  /** Free-text expectation kept for humans; unasserted. */
  expectedOutput?: string;
}

export interface SkillEvals {
  file?: string;
  cases: SkillEvalCase[];
  issues: SkillIssue[];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (!value.every((item) => typeof item === 'string')) return undefined;
  return value as string[];
}

/**
 * Load and validate `evals/evals.json` for one skill directory.
 * Returns issues instead of throwing: a broken eval file is a skill problem to
 * report (`moss skill validate`), not a reason to refuse loading the skill.
 */
export function loadSkillEvals(skillDir: string): SkillEvals {
  const file = path.join(skillDir, 'evals', 'evals.json');
  if (!fs.existsSync(file)) return { cases: [], issues: [] };
  const issues: SkillIssue[] = [];
  const push = (message: string): void => {
    issues.push({ code: 'evals-invalid', message, file });
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    push(`evals.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    return { file, cases: [], issues };
  }
  const root = asRecord(parsed);
  const list = Array.isArray(parsed)
    ? parsed
    : root && Array.isArray(root.evals)
      ? root.evals
      : root && Array.isArray(root.cases)
        ? root.cases
        : undefined;
  if (!list) {
    push('evals.json must be an array or have an "evals" / "cases" array');
    return { file, cases: [], issues };
  }
  const cases: SkillEvalCase[] = [];
  const seen = new Set<string>();
  list.forEach((raw, index) => {
    const record = asRecord(raw);
    if (!record) {
      push(`case #${String(index + 1)} is not an object`);
      return;
    }
    const id = asString(record.id) ?? `case-${String(index + 1)}`;
    const prompt = asString(record.prompt);
    if (!prompt) {
      push(`case "${id}" has no prompt string`);
      return;
    }
    if (seen.has(id)) push(`duplicate case id "${id}"`);
    seen.add(id);
    const expectContains =
      asStringList(record.expect_contains) ?? asStringList(record.expectContains) ?? [];
    const expectToolsRaw = record.expect_tools ?? record.expectTools;
    if (expectToolsRaw !== undefined && asStringList(expectToolsRaw) === undefined) {
      push(`case "${id}" has a non-array expect_tools`);
    }
    const setupRaw = asRecord(record.setup) ?? asRecord(record.files);
    const setup: Record<string, string> = {};
    if (setupRaw) {
      for (const [filePath, content] of Object.entries(setupRaw)) {
        const text = asString(content);
        if (text === undefined) push(`case "${id}" setup file "${filePath}" is not a string`);
        else setup[filePath] = text;
      }
    }
    const expectedOutput = asString(record.expected_output) ?? asString(record.expectedOutput);
    cases.push({
      id,
      prompt,
      expectContains,
      setup,
      ...(expectedOutput ? { expectedOutput } : {}),
    });
  });
  if (cases.length === 0 && issues.length === 0) push('evals.json has no cases');
  return { file, cases, issues };
}
