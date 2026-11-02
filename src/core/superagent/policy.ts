import { createHash } from 'node:crypto';
import type { SuperagentConfig } from '../../contracts/superagent.js';
import type { Policy } from './upstream/index.js';
import { ErrorCode, MossError } from '../../errors.js';

export function invalid(message: string): MossError {
  return new MossError({ code: ErrorCode.USER_INPUT_INVALID, message });
}
export function checkedConfig(value: SuperagentConfig): SuperagentConfig {
  if (
    !value ||
    Object.keys(value).some(
      (key) =>
        ![
          'acceptanceCommand',
          'allowedActors',
          'acceptMode',
          'rules',
          'maxWorkers',
          'maxWallMs',
        ].includes(key)
    ) ||
    typeof value.acceptanceCommand !== 'string' ||
    !value.acceptanceCommand.trim() ||
    value.acceptanceCommand.length > 8192 ||
    !['off', 'observe', 'auto'].includes(value.acceptMode) ||
    !Number.isInteger(value.maxWorkers) ||
    value.maxWorkers < 1 ||
    value.maxWorkers > 8 ||
    !Number.isInteger(value.maxWallMs) ||
    value.maxWallMs < 100 ||
    value.maxWallMs > 86_400_000 ||
    !value.allowedActors ||
    typeof value.allowedActors !== 'object' ||
    Array.isArray(value.allowedActors) ||
    !Array.isArray(value.rules) ||
    value.rules.length > 50 ||
    value.rules.some(
      (rule) =>
        !rule ||
        typeof rule.id !== 'string' ||
        !/^[\w.-]{1,80}$/.test(rule.id) ||
        typeof rule.instruction !== 'string' ||
        !rule.instruction.trim() ||
        rule.instruction.length > 8192
    ) ||
    new Set(value.rules.map((rule) => rule.id)).size !== value.rules.length ||
    Object.entries(value.allowedActors).some(
      ([source, actors]) =>
        !/^[\w.-]{1,80}$/.test(source) ||
        !Array.isArray(actors) ||
        actors.length > 100 ||
        actors.some((actor) => typeof actor !== 'string' || !actor || actor.length > 200)
    )
  ) {
    throw invalid(
      'Invalid Super-agent configuration; a fixed acceptance command and bounded policy are required'
    );
  }
  return structuredClone({ ...value, acceptanceCommand: value.acceptanceCommand.trim() });
}
export function policyFor(config: SuperagentConfig, paused: boolean): Policy {
  const version = createHash('sha256').update(JSON.stringify(config)).digest('hex');
  const allowed = (source: string, actor: string) =>
    Object.hasOwn(config.allowedActors, source) && config.allowedActors[source]!.includes(actor);
  return {
    version,
    paused,
    evalTimeoutMs: 120_000,
    gate: (trigger) => {
      if (!trigger.human || !allowed(trigger.source, trigger.actor.id))
        return { admissible: false, reason: 'sender_not_allowed' };
      if (trigger.addressed)
        return {
          admissible: true,
          strength: 'explicit',
          basis: {
            via: 'addressed',
            source: trigger.source,
            sender: trigger.actor.id,
            addressed: trigger.addressed,
          },
        };
      if (config.acceptMode === 'off' || !config.rules.length)
        return { admissible: false, reason: 'inferred_disabled' };
      return {
        admissible: true,
        strength: 'inferred',
        basis: {
          via: 'listed',
          source: trigger.source,
          sender: trigger.actor.id,
          observation: { mode: config.acceptMode },
        },
      };
    },
    revalidate: (mandate) =>
      allowed(mandate.actor.source, mandate.actor.id) &&
      (mandate.strength === 'explicit' ||
        (config.acceptMode === 'auto' &&
          !!mandate.basis.rules?.length &&
          mandate.basis.rules.every((id) => config.rules.some((rule) => rule.id === id)))),
    admitsInferred: (rules) =>
      config.acceptMode === 'auto' &&
      rules.length > 0 &&
      rules.every((id) => config.rules.some((rule) => rule.id === id)),
  };
}
