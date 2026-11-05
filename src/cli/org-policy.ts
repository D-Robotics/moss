/**
 * D9 team/organization policy layer: one read-only JSON file of permission
 * rules (`MOSS_POLICY_FILE`) that outranks user/workspace config. Delegates all
 * rule syntax to parsePermissionRuleSpec so the policy file and
 * `permissions.allow/ask/deny` cannot drift apart.
 *
 * Deliberately no writes here: a policy file is owned by the organization and
 * Moss only reads it. A missing or malformed policy file is a startup error
 * (fail closed) instead of silently running with a weaker table.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ErrorCode, MossError } from '../errors.js';
import {
  parsePermissionRuleSpec,
  type PermissionLevel,
  type PermissionRule,
} from './permission-rules.js';

export interface OrgPolicy {
  /** Rules in file order (deny/ask/allow); deny still wins in the engine. */
  rules: PermissionRule[];
  /** Absolute path of the loaded file, absent when no policy env was set. */
  path?: string;
}

const POLICY_ENV = 'MOSS_POLICY_FILE';
const POLICY_VERSION = 1;
const LEVELS: readonly PermissionLevel[] = ['allow', 'ask', 'deny'];

function policyError(message: string, context: Record<string, unknown>): MossError {
  return new MossError({
    code: ErrorCode.CONFIG_IO_FAILED,
    message,
    context,
  });
}

/** `MOSS_POLICY_FILE` (absolute or workspace-relative) or none. */
export function loadOrgPolicy(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd()
): OrgPolicy {
  const raw = env[POLICY_ENV]?.trim();
  if (!raw) return { rules: [] };
  const filePath = path.isAbsolute(raw) ? raw : path.resolve(cwd, raw);
  let text: string;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (error: unknown) {
    throw policyError(`cannot read ${POLICY_ENV} file: ${filePath}`, {
      env: POLICY_ENV,
      path: filePath,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error: unknown) {
    throw policyError(`${POLICY_ENV} is not valid JSON: ${filePath}`, {
      path: filePath,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw policyError(`${POLICY_ENV} must be a JSON object`, { path: filePath });
  }
  const record = parsed as Record<string, unknown>;
  if (record.version !== POLICY_VERSION) {
    throw policyError(
      `${POLICY_ENV} must have "version": ${String(POLICY_VERSION)} (got ${JSON.stringify(record.version)})`,
      { path: filePath }
    );
  }
  const rules: PermissionRule[] = [];
  for (const level of LEVELS) {
    const value = record[level];
    if (value === undefined) continue;
    if (!Array.isArray(value) || value.some((spec) => typeof spec !== 'string')) {
      throw policyError(`${POLICY_ENV} "${level}" must be an array of rule strings`, {
        path: filePath,
        level,
      });
    }
    for (const spec of value as string[]) {
      try {
        rules.push(parsePermissionRuleSpec(spec, 'policy', level));
      } catch (error: unknown) {
        throw policyError(`invalid rule in ${POLICY_ENV} "${level}": ${spec}`, {
          path: filePath,
          level,
          spec,
          cause: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  return { rules, path: filePath };
}

/** One-line startup notice so an org policy is never invisible. */
export function orgPolicyNotice(policy: OrgPolicy, zh: boolean): string | null {
  if (!policy.path) return null;
  const deny = policy.rules.filter((rule) => rule.level === 'deny').length;
  const ask = policy.rules.filter((rule) => rule.level === 'ask').length;
  const allow = policy.rules.filter((rule) => rule.level === 'allow').length;
  return zh
    ? `[policy] 已加载组织策略 ${policy.path}（deny ${deny} · ask ${ask} · allow ${allow}，只读、优先于用户/项目规则）`
    : `[policy] organization policy loaded from ${policy.path} (deny ${deny} · ask ${ask} · allow ${allow}; read-only, outranks user/workspace rules)`;
}
