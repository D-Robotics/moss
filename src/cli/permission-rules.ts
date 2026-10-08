/**
 * v0.26 permission rules engine (W2a / T03) — pure functions, zero src-layer
 * imports (only micromatch + ../errors.js) so every branch is unit-testable.
 *
 * Behavior contract: PRD 2026-10-08
 * (docs/superpowers/plans/2026-10-08-v026-permission-model.md) W2 and design
 * §3.1/§3.2/§4 (docs/superpowers/plans/2026-10-08-v026-architecture.md).
 * The decision order lives ONLY in resolvePermissionDecision (§7-4): the
 * approval hook assembles inputs, never re-implements the ordering.
 */
import micromatch from 'micromatch';
import { ErrorCode, throwMoss } from '../errors.js';

/** Rule level: deny beats ask beats allow (deny wins in ANY mode incl. full). */
export type PermissionLevel = 'allow' | 'ask' | 'deny';

/** Where a rule came from: user config / workspace config / live session. */
export type PermissionRuleSource = 'user' | 'workspace' | 'session';

/**
 * A single permission rule. `toolName` may carry a micromatch glob (e.g.
 * 'device_*'); `operandPattern` (the parenthesized part) matches the tool's
 * primary operand (command / path) — absent means the whole tool.
 */
export interface PermissionRule {
  level: PermissionLevel;
  toolName: string;
  operandPattern?: string;
  source: PermissionRuleSource;
}

/**
 * The permissions block shape as it appears in a config file. `defaultMode`
 * is the mode-engine knob (T01); the three lists use the Tool(pattern) syntax.
 */
export interface PermissionsConfig {
  defaultMode?: string;
  allow?: string[];
  ask?: string[];
  deny?: string[];
}

/** Merged, ready-to-evaluate rule table plus its source files. */
export interface ResolvedPermissionRules {
  rules: readonly PermissionRule[];
  sources: { userPath?: string; workspacePath?: string };
}

/** Tool side-effect classes (mirrors core tool-types — kept literal so this
 * module stays free of src imports). */
export type RuleSideEffectClass =
  | 'readonly'
  | 'local_write'
  | 'device_mutation'
  | 'credential'
  | 'external_message'
  | 'memory_write'
  | 'runtime_state'
  | 'subagent';

/** Interaction modes (mirrors cli/interaction-mode.ts — literal for purity). */
export type RuleInteractionMode = 'manual' | 'acceptEdits' | 'plan' | 'full';

/** Everything the decision order needs, assembled by the approval hook. */
export interface PermissionDecisionInput {
  toolName: string;
  sideEffect: RuleSideEffectClass;
  /** Primary operand (exec.command / read_file.path / device_exec.command …). */
  operand?: string;
  requiresApproval: boolean;
  mode: RuleInteractionMode;
  /** --read-only / MOSS_SAFETY_MODE=read-only / migrated cautious profile. */
  readOnlyCeiling: boolean;
  boardMode: boolean;
  /** Workspace file-edit auto-approval eligibility (hook computes: the
   * sandbox-enforced file-mutation tools under acceptEdits/full). */
  acceptEditsEligible?: boolean;
  /** planMode metadata of the tool (plan ceiling consults it). */
  planModeAllowed?: boolean;
}

export type PermissionDecisionOutcome =
  | { decision: 'deny'; reason: string; matchedRule?: PermissionRule }
  | { decision: 'block'; reason: string }
  | { decision: 'ask' }
  | { decision: 'ask-rule'; matchedRule: PermissionRule }
  | {
      decision: 'allow';
      reason: 'rule' | 'mode' | 'accept-edits' | 'board' | 'no-approval-needed';
      matchedRule?: PermissionRule;
    };

// ── parsing ──────────────────────────────────────────────────────────────────

/**
 * Parse a Tool(pattern) rule spec. Level is assigned by the caller (the same
 * spec string fills the allow/ask/deny lists).
 *
 *   'exec(npm run *)' → { toolName: 'exec', operandPattern: 'npm run *' }
 *   'edit_file'       → { toolName: 'edit_file' }  (whole-tool rule)
 *
 * Malformed specs (empty string, empty/nested parentheses, stray parens)
 * throw USER_INPUT_INVALID with the spec and source in the context.
 */
export function parsePermissionRuleSpec(
  spec: string,
  source: PermissionRuleSource,
  level: PermissionLevel = 'allow'
): PermissionRule {
  const trimmed = String(spec ?? '').trim();
  const open = trimmed.indexOf('(');
  const close = trimmed.lastIndexOf(')');
  const parens = (trimmed.match(/\(/g) ?? []).length > 0 || (trimmed.match(/\)/g) ?? []).length > 0;

  let toolName: string;
  let operandPattern: string | undefined;

  if (!parens) {
    // Bare tool name: whole-tool rule.
    toolName = trimmed;
  } else {
    const malformed =
      open === -1 ||
      close === -1 ||
      close < open ||
      (trimmed.match(/\(/g) ?? []).length !== 1 ||
      (trimmed.match(/\)/g) ?? []).length !== 1 ||
      close !== trimmed.length - 1;
    if (malformed) {
      throwMoss({
        code: ErrorCode.USER_INPUT_INVALID,
        message: `Invalid permission rule spec: "${trimmed}"`,
        hint: 'Rules look like ToolName (whole tool) or ToolName(pattern), e.g. exec(npm run *) or read_file(./.env)',
        context: { spec: trimmed, source },
      });
    }
    toolName = trimmed.slice(0, open).trim();
    const rawPattern = trimmed.slice(open + 1, close).trim();
    if (!rawPattern) {
      throwMoss({
        code: ErrorCode.USER_INPUT_INVALID,
        message: `Invalid permission rule spec: "${trimmed}" (empty pattern)`,
        hint: 'Use the bare tool name for a whole-tool rule, or put a pattern in parentheses, e.g. exec(npm run *)',
        context: { spec: trimmed, source },
      });
    }
    operandPattern = rawPattern;
  }

  if (!toolName || !/^[A-Za-z0-9_.:/\-*?]+$/.test(toolName)) {
    throwMoss({
      code: ErrorCode.USER_INPUT_INVALID,
      message: `Invalid permission rule tool name: "${toolName || '(empty)'}"`,
      hint: 'Tool names must only contain letters, digits, _, ., :, /, -, *, or ?',
      context: { spec: trimmed, source },
    });
  }

  return operandPattern === undefined
    ? { level, toolName, source }
    : { level, toolName, operandPattern, source };
}

/**
 * Primary-operand extraction table (pure data mapping, design §3.1):
 * exec/device_exec → command; file tools → path; device_deploy → remote_path;
 * move_file → source; apply_patch → the patch's first file path; everything
 * else → undefined (only the tool name can match).
 */
export function extractRuleOperand(
  toolName: string,
  input: Record<string, unknown>
): string | undefined {
  if (toolName === 'exec' || toolName === 'device_exec' || toolName === 'exec_background') {
    const command = input.command ?? input.cmd ?? input.shell_command;
    return typeof command === 'string' ? command : undefined;
  }
  if (
    toolName === 'read_file' ||
    toolName === 'write_file' ||
    toolName === 'edit_file' ||
    toolName === 'multi_edit' ||
    toolName === 'device_file_write' ||
    toolName === 'device_file_read'
  ) {
    const p = input.path ?? input.file_path ?? input.filepath;
    return typeof p === 'string' ? p : undefined;
  }
  if (toolName === 'device_deploy') {
    const p = input.remote_path ?? input.remotePath;
    return typeof p === 'string' ? p : undefined;
  }
  if (toolName === 'move_file') {
    const s = input.source ?? input.src;
    return typeof s === 'string' ? s : undefined;
  }
  if (toolName === 'apply_patch' && typeof input.patch === 'string') {
    const match = /^\*\*\* (?:Update|Add|Delete) File: (.+)$/m.exec(input.patch);
    return match?.[1]?.trim() || undefined;
  }
  return undefined;
}

// ── matching ─────────────────────────────────────────────────────────────────

/** micromatch options identical to the trustedTools matcher (approval.ts). */
const TOOL_NAME_MATCH_OPTIONS = {
  contains: false,
  dot: true,
  nocase: false,
  noextglob: true,
  nonegate: true,
} as const;

function toolNameMatches(pattern: string, toolName: string): boolean {
  if (pattern === toolName) return true;
  return micromatch.isMatch(toolName, pattern, TOOL_NAME_MATCH_OPTIONS);
}

/**
 * Match one rule against a tool call. Bare rules match only the tool name;
 * pattern rules additionally require the operand to match the pattern.
 *
 * Operand semantics are PREFIX-WILDCARD (CC `Bash(npm run *)` alignment, PRD
 * W2): a pattern ending in `*` matches `prefix + anything` — including path
 * separators, so `exec(rm *)` matches `rm -rf /tmp/x`. Patterns without a
 * trailing wildcard use micromatch exact/glob matching ('./.env' or
 * 'device_exec(*)' — the bare `*` matches every operand).
 */
export function matchPermissionRule(
  rule: PermissionRule,
  toolName: string,
  operand?: string
): boolean {
  if (!toolNameMatches(rule.toolName, toolName)) return false;
  if (rule.operandPattern === undefined) return true;
  if (operand === undefined) return false;
  const pattern = rule.operandPattern;
  if (pattern === '*') return true;
  if (pattern.endsWith('*')) {
    return operand.startsWith(pattern.slice(0, -1));
  }
  return micromatch.isMatch(operand, pattern, {
    dot: true,
    nocase: false,
    noextglob: true,
    nonegate: true,
  });
}

// ── merging ──────────────────────────────────────────────────────────────────

/**
 * Safety-directional merge of the user and workspace rule sets:
 * - deny rules union ACROSS levels (a workspace deny cannot be lifted by a
 *   user allow — deny wins at match time by ordering, so keeping both is the
 *   safe union);
 * - allow/ask rules merge with per-level dedup (exact spec identity:
 *   level + toolName + operandPattern).
 */
export function mergePermissionRuleSets(
  userRules: readonly PermissionRule[],
  workspaceRules: readonly PermissionRule[]
): PermissionRule[] {
  const specKey = (rule: PermissionRule): string =>
    `${rule.level}:${rule.toolName}:${rule.operandPattern ?? ''}`;

  const denyUnion = new Map<string, PermissionRule>();
  for (const rule of [...userRules, ...workspaceRules]) {
    if (rule.level !== 'deny') continue;
    denyUnion.set(specKey(rule), rule);
  }
  const nonDenyUnion = new Map<string, PermissionRule>();
  for (const rule of [...userRules, ...workspaceRules]) {
    if (rule.level === 'deny') continue;
    // user-wins on the same non-deny spec (user first in the loop).
    if (!nonDenyUnion.has(specKey(rule))) nonDenyUnion.set(specKey(rule), rule);
  }

  return [...denyUnion.values(), ...nonDenyUnion.values()];
}

// ── session registry (design §3.2) ───────────────────────────────────────────

/**
 * Session-scoped rule registry: /permissions add/remove and the approval
 * hook's 'a' ("don't ask again") write here; the live getter wired by
 * cli-main snapshots it per tool call so changes take effect on the very
 * next call (PRD W2 运行中生效). Pure in-memory — no IO.
 */
export class PermissionRuleRegistry {
  private sessionRules: PermissionRule[] = [];
  private readonly listeners = new Set<() => void>();

  /** Add a rule (validated spec, session source). */
  add(rule: PermissionRule): void {
    this.sessionRules.push({ ...rule, source: 'session' });
    this.notify();
  }

  /** Add from a spec string (throws USER_INPUT_INVALID on bad syntax). */
  addSpec(spec: string, level: PermissionLevel): PermissionRule {
    const rule = parsePermissionRuleSpec(spec, 'session', level);
    this.add(rule);
    return rule;
  }

  /** Remove by index or by spec identity; true when something was removed. */
  remove(indexOrSpec: number | string): boolean {
    const before = this.sessionRules.length;
    if (typeof indexOrSpec === 'number') {
      if (indexOrSpec < 0 || indexOrSpec >= this.sessionRules.length) return false;
      this.sessionRules.splice(indexOrSpec, 1);
    } else {
      const spec = indexOrSpec.trim();
      this.sessionRules = this.sessionRules.filter((rule) => {
        const identity = `${rule.toolName}${rule.operandPattern ? `(${rule.operandPattern})` : ''}`;
        return identity !== spec;
      });
    }
    if (this.sessionRules.length !== before) this.notify();
    return this.sessionRules.length !== before;
  }

  /** Current session rules (defensive copy). */
  list(): readonly PermissionRule[] {
    return [...this.sessionRules];
  }

  /** Snapshot merged with startup rules for the decision order. */
  snapshot(startupRules: readonly PermissionRule[] = []): ResolvedPermissionRules {
    return {
      rules: mergePermissionRuleSets(startupRules, this.sessionRules),
      sources: {},
    };
  }

  /** Subscribe to registry mutations; returns the unsubscribe. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // listeners must not break registry mutations
      }
    }
  }
}

// ── decision order (the single authoritative implementation, §7-4) ───────────

/**
 * Plan-mode class-level gate, mirroring approval.ts's isAllowedDuringPlanMode
 * (device_mutation denied; readonly allowed; other classes need
 * planMode: 'allow' metadata). Duplicated literally to keep this module pure.
 */
function allowedDuringPlanMode(input: PermissionDecisionInput): boolean {
  if (input.sideEffect === 'device_mutation') return false;
  if (input.sideEffect === 'readonly') return true;
  return input.planModeAllowed === true;
}

function isBoardScopedSideEffect(sideEffect: RuleSideEffectClass): boolean {
  return sideEffect === 'device_mutation' || sideEffect === 'local_write';
}

/**
 * The permission decision order (the ONLY place it exists):
 *
 *   1. deny rule match — wins in ANY mode including full (PRD W2: deny 在任何
 *      模式含 full 下都赢), checked BEFORE the readonly short-circuit so
 *      read_file(.env) denies stay effective.
 *   2. mode ceilings — readOnlyCeiling blocks every non-readonly side effect
 *      (runtime_state included, stricter than plan); plan applies the
 *      class-level gate above.
 *   3. ask rules — manual/acceptEdits go interactive ('ask-rule'); full skips
 *      them (PRD decision 3); plan already fell out at step 2.
 *   4. allow rules → allow (incl. device_mutation — the old trusted-tool
 *      special case is subsumed here).
 *   5. mode defaults — full → allow(mode); acceptEditsEligible →
 *      allow(accept-edits); boardMode + board-scoped side effect →
 *      allow(board); requiresApproval=false → allow(no-approval-needed).
 *   6. everything else → 'ask' (interactive prompt; headless denies).
 */
export function resolvePermissionDecision(
  input: PermissionDecisionInput,
  resolved: ResolvedPermissionRules
): PermissionDecisionOutcome {
  // 1. deny rules first — before the readonly short-circuit so a deny on a
  //    readonly tool (read_file .env) cannot be bypassed by the no-approval path.
  for (const rule of resolved.rules) {
    if (rule.level !== 'deny') continue;
    if (matchPermissionRule(rule, input.toolName, input.operand)) {
      return {
        decision: 'deny',
        reason: `blocked by deny rule ${rule.toolName}${
          rule.operandPattern ? `(${rule.operandPattern})` : ''
        } (${rule.source})`,
        matchedRule: rule,
      };
    }
  }

  // 2. mode ceilings.
  if (input.readOnlyCeiling) {
    if (input.sideEffect !== 'readonly') {
      return {
        decision: 'block',
        reason:
          'read-only ceiling: only read-only tools run in this mode (stricter than plan — runtime_state included)',
      };
    }
    // readonly under the ceiling: still honor the no-approval shortcut below.
  } else if (input.mode === 'plan' && !allowedDuringPlanMode(input)) {
    return {
      decision: 'block',
      reason: 'plan mode: code exploration and planning only',
    };
  }

  // readonly tools need no approval — short-circuit right after the deny
  // check (and the plan ceiling) so read_file denies stay effective (§7-4).
  if (!input.requiresApproval && input.sideEffect === 'readonly') {
    return { decision: 'allow', reason: 'no-approval-needed' };
  }

  // 3. ask rules (full skips them — PRD decision 3).
  if (input.mode !== 'full' && !input.readOnlyCeiling) {
    for (const rule of resolved.rules) {
      if (rule.level !== 'ask') continue;
      if (matchPermissionRule(rule, input.toolName, input.operand)) {
        return { decision: 'ask-rule', matchedRule: rule };
      }
    }
  }

  // 4. allow rules.
  for (const rule of resolved.rules) {
    if (rule.level !== 'allow') continue;
    if (matchPermissionRule(rule, input.toolName, input.operand)) {
      return { decision: 'allow', reason: 'rule', matchedRule: rule };
    }
  }

  // 5. mode defaults.
  if (input.mode === 'full' && !input.readOnlyCeiling) {
    return { decision: 'allow', reason: 'mode' };
  }
  if (input.mode === 'acceptEdits' && input.acceptEditsEligible === true) {
    return { decision: 'allow', reason: 'accept-edits' };
  }
  if (input.boardMode && isBoardScopedSideEffect(input.sideEffect)) {
    return { decision: 'allow', reason: 'board' };
  }
  if (!input.requiresApproval) {
    return { decision: 'allow', reason: 'no-approval-needed' };
  }

  // 6. everything else: interactive ask (the hook maps this to the asker;
  // headless runs deny here with the new full-mode guidance).
  return { decision: 'ask' };
}
