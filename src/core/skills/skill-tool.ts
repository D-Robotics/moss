import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import type { Tool, ToolContext } from '../tools/tool-types.js';
import { findSkill, parseSkillFile, type SkillManifest } from './skill-registry.js';
import { applySkillToolScope, describeSkillToolScope } from './skill-tool-scope.js';
import { recordSkillUse } from './skill-usage.js';
import {
  describeSkillRunPolicy,
  setSkillRunPolicy,
  type SkillRunPolicy,
} from './skill-run-policy.js';

/**
 * L2 of progressive disclosure: the full body plus the provenance and resource
 * manifest the model needs before it can act.
 *
 * Two contracts matter here:
 * - the budget is declared (`maxResultTokens` / `truncationHint`), so the
 *   context layer truncates with skill semantics instead of the generic 4k
 *   default, and the wrapper says whether the body was clipped;
 * - bundled resources are listed, not inlined — the model reads
 *   `references/...` on demand rather than paying for them upfront.
 */
export const SKILL_TOOL_MAX_RESULT_TOKENS = 6_000;
const BYTES_PER_TOKEN = 4;
/** Leave room for the wrapper inside the declared budget. */
const WRAPPER_RESERVE_BYTES = 1_200;
const MAX_RESOURCE_ENTRIES = 12;

export interface SkillToolInput {
  name: string;
  /** Free-form arguments injected into $ARGUMENTS placeholders in the body. */
  args?: string;
}

/** Session-level body cache: file mtime is the invalidation key. */
const bodyCache = new Map<string, { mtimeMs: number; body: string }>();

export function readSkillBodyCached(skill: SkillManifest): string {
  if (typeof skill.body === 'string') return skill.body;
  const stat = fs.statSync(skill.file);
  const cached = bodyCache.get(skill.file);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.body;
  const body = parseSkillFile(fs.readFileSync(skill.file, 'utf8')).body;
  bodyCache.set(skill.file, { mtimeMs: stat.mtimeMs, body });
  return body;
}

function resourceLines(skill: SkillManifest): string[] {
  const groups = [
    ['scripts', skill.resources.scripts],
    ['references', skill.resources.references],
    ['assets', skill.resources.assets],
  ] as const;
  const lines: string[] = [];
  for (const [kind, files] of groups) {
    if (files.length === 0) continue;
    const shown = files.slice(0, MAX_RESOURCE_ENTRIES);
    lines.push(
      `  ${kind}/: ${shown.join(', ')}${files.length > shown.length ? ` (+${String(files.length - shown.length)} more)` : ''}`
    );
  }
  if (skill.resources.evals) lines.push('  evals/evals.json');
  return lines;
}

function provenanceLine(skill: SkillManifest): string {
  const parts = [
    `source: ${skill.scope}`,
    skill.dir.startsWith('builtin:') ? 'bundled' : skill.dir,
  ];
  if (skill.version) parts.push(`version ${skill.version}`);
  if (skill.license) parts.push(`license ${skill.license}`);
  return `Source: ${parts.join(' · ')}`;
}

function buildWrapper(skill: SkillManifest, body: string): string {
  const lines = [`# Skill: ${skill.name}`, provenanceLine(skill)];
  if (skill.allowedTools.length > 0) lines.push(`Declared tools: ${skill.allowedTools.join(' ')}`);
  const resources = resourceLines(skill);
  if (resources.length > 0) {
    lines.push('Resources (read on demand; paths are relative to the skill source):');
    lines.push(...resources);
  }
  if (skill.when) lines.push(`When: ${collapse(skill.when)}`);
  lines.push('', body);
  return lines.join('\n');
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function clampBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  const notice =
    '\n\n[... skill body truncated at the tool budget; ask for a specific section or read references/ directly ...]';
  const budget = Math.max(0, maxBytes - Buffer.byteLength(notice, 'utf8'));
  let end = Math.min(text.length, budget);
  while (end > 0 && Buffer.byteLength(text.slice(0, end), 'utf8') > budget) {
    end = Math.floor(end * 0.99);
  }
  return `${text.slice(0, end).trimEnd()}${notice}`;
}

export function createSkillTool(
  skills: readonly SkillManifest[] | (() => readonly SkillManifest[])
): Tool<SkillToolInput> {
  const list = (): readonly SkillManifest[] => (typeof skills === 'function' ? skills() : skills);
  // Repeat activations in one run return a pointer, not the whole body again.
  const loaded = new Map<string, string>();
  return {
    name: 'skill',
    description:
      'Load a skill body by name. The system prompt only has the index. Pass args to fill $ARGUMENTS.',
    metadata: {
      sideEffectClass: 'readonly',
      planMode: 'allow',
      requiresApproval: false,
      maxResultTokens: SKILL_TOOL_MAX_RESULT_TOKENS,
      truncationHint:
        'the skill body was clipped; ask for a specific section or read its references/ files individually',
      classification: { discovery: true, singleCallExempt: true },
    },
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Skill name exactly as listed in the Available skills index.',
        },
        args: {
          type: 'string',
          description:
            'Optional free-form arguments; replaces every $ARGUMENTS placeholder in the skill body.',
        },
      },
      required: ['name'],
    },
    async execute(input: SkillToolInput, ctx: ToolContext): Promise<string> {
      const skill = findSkill(list(), String(input.name ?? '').trim());
      if (!skill) {
        const available =
          list()
            .map((s) => s.name)
            .join(', ') || '(none)';
        return `Unknown skill "${input.name}". Available skills: ${available}`;
      }
      const args = typeof input.args === 'string' ? input.args : '';
      const previousArgs = loaded.get(skill.name);
      if (previousArgs !== undefined && previousArgs === args) {
        return `Skill "${skill.name}" is already loaded in this run (see the earlier # Skill block). Repeating it would only spend context.`;
      }
      let body: string;
      try {
        body = readSkillBodyCached(skill);
      } catch {
        return `Skill "${skill.name}" could not be read from ${skill.file}`;
      }
      if (body.includes('$ARGUMENTS')) body = body.replaceAll('$ARGUMENTS', args);
      if (skill.background === true) {
        // D11 `background: true`: the body starts as a background sub-agent and
        // this turn returns at once with a task id. It implies fork isolation —
        // the parent pays for the pointer, not the body — and the child's final
        // summary resolves through subagent_status / subagent_resume.
        const spawn = ctx.spawnSubagent;
        const registry = ctx.asyncTaskRegistry;
        if (!spawn || !registry) {
          return `Skill "${skill.name}" declares \`background: true\`, but this host has no background sub-agent runner; run it in an interactive/full host, or remove that field to load it inline.`;
        }
        const taskId = `${ctx.runId ?? ctx.sessionKey}/skill-${randomUUID().slice(0, 8)}`;
        registry.start(
          {
            taskId,
            kind: 'subagent',
            label: `skill-${skill.name}`,
            ...(ctx.runId !== undefined ? { parentRunId: ctx.runId } : {}),
            timeoutMs: 10 * 60_000,
            payload: { skill: skill.name, args, ...(skill.model ? { model: skill.model } : {}) },
          },
          async (_request, signal) => {
            const result = await spawn({
              task: body,
              label: `skill-${skill.name}`,
              maxTurns: 20,
              ...(skill.allowedTools.length > 0 ? { allowedTools: skill.allowedTools } : {}),
              ...(skill.disallowedTools.length > 0 ? { deniedTools: skill.disallowedTools } : {}),
              ...(skill.model ? { model: skill.model } : {}),
              abortSignal: signal,
            });
            if (!result) {
              return { success: false, summary: 'Sub-agent spawning is no longer available.' };
            }
            const summary = (result.summary ?? '').trim();
            // Empty child output is a failure, same contract as create_subagent.
            const ok = result.success && summary.length > 0;
            return {
              success: ok,
              summary: ok
                ? summary
                : `${summary || 'Sub-agent failed.'}\n(empty output treated as failure — do not invent success)`,
              data: {
                runId: result.runId,
                sessionKey: result.sessionKey,
                ...(result.turns !== undefined ? { turns: result.turns } : {}),
                ...(result.durationMs !== undefined ? { durationMs: result.durationMs } : {}),
              },
            };
          },
          ctx.abortSignal ? { parentSignal: ctx.abortSignal } : undefined
        );
        loaded.set(skill.name, args);
        recordSkillUse(ctx.workspaceDir, skill.name);
        return [
          `# Skill: ${skill.name} (background task ${taskId}) STARTED`,
          '',
          'The skill body is running in an isolated background sub-agent; this turn does not block on it.',
          `Poll it with subagent_status (taskId="${taskId}", wait=true to block), read its final summary with subagent_resume, or stop it with subagent_stop.`,
        ].join('\n');
      }
      if (skill.context === 'fork') {
        // D11 `context: fork`: the body runs in an isolated sub-agent, so the
        // parent context pays for the summary instead of the whole skill. The
        // body is the child's task; args are already substituted above.
        if (!ctx.spawnSubagent) {
          return `Skill "${skill.name}" declares \`context: fork\`, but this host has no sub-agent runner; run it in an interactive/full host, or remove that field to load it inline.`;
        }
        const forked = await ctx.spawnSubagent({
          task: body,
          label: `skill-${skill.name}`,
          maxTurns: 20,
          ...(skill.allowedTools.length > 0 ? { allowedTools: skill.allowedTools } : {}),
          ...(skill.disallowedTools.length > 0 ? { deniedTools: skill.disallowedTools } : {}),
          ...(skill.model ? { model: skill.model } : {}),
          ...(ctx.abortSignal ? { abortSignal: ctx.abortSignal } : {}),
          cleanup: 'delete',
        });
        loaded.set(skill.name, args);
        recordSkillUse(ctx.workspaceDir, skill.name);
        const status = forked.success
          ? 'completed'
          : `failed${forked.error ? `: ${forked.error}` : ''}`;
        const detail = [
          forked.turns !== undefined ? `${String(forked.turns)} turn(s)` : '',
          forked.durationMs !== undefined ? `${String(Math.round(forked.durationMs / 1000))}s` : '',
        ]
          .filter(Boolean)
          .join(', ');
        return `# Skill: ${skill.name} (forked sub-agent ${forked.runId}, ${status}${detail ? ` · ${detail}` : ''})\n\nThe skill body ran in an isolated sub-agent; only this summary returns to the parent context.\n\n${forked.summary}`;
      }
      const maxBodyBytes = SKILL_TOOL_MAX_RESULT_TOKENS * BYTES_PER_TOKEN - WRAPPER_RESERVE_BYTES;
      const clipped = clampBytes(body, Math.max(1_000, maxBodyBytes));
      const wrapped = buildWrapper(skill, clipped);
      // D11: a skill that declares tool restrictions narrows the rest of the
      // run. The model is told, so it does not try tools it can no longer call.
      const scopeNote = applySkillToolScope(ctx.runId ?? ctx.sessionKey, skill)
        ? describeSkillToolScope(ctx.runId ?? ctx.sessionKey)
        : undefined;
      loaded.set(skill.name, args);
      // D11 inline policy: a skill can switch the model/effort for the rest of
      // the run (forked skills pass the model to the child instead).
      const runId = ctx.runId ?? ctx.sessionKey;
      const policy: SkillRunPolicy = {
        ...(skill.model ? { model: skill.model } : {}),
        ...(skill.effort ? { effort: skill.effort } : {}),
      };
      const policyNote =
        policy.model !== undefined || policy.effort !== undefined
          ? (setSkillRunPolicy(runId, policy), describeSkillRunPolicy(policy))
          : undefined;
      // D10: local counters power `/skills` cost-vs-usage visibility.
      recordSkillUse(ctx.workspaceDir, skill.name);
      const notes = [scopeNote, policyNote].filter((note): note is string => note !== undefined);
      return notes.length > 0 ? `${wrapped}\n\n${notes.join('\n')}` : wrapped;
    },
  };
}
