import { ErrorCode, MossError } from '../errors.js';

/** Supported verification mechanism for one acceptance criterion. @beta */
export type AcceptanceCriterionKind = 'deterministic' | 'semantic' | 'manual';

/** One stable, evidence-addressable definition-of-done condition. @beta */
export interface AcceptanceCriterion {
  readonly id: string;
  readonly description: string;
  readonly kind: AcceptanceCriterionKind;
  readonly required: boolean;
  readonly evidenceKinds?: readonly string[];
  readonly requirementIds?: readonly string[];
}

/** Revisioned definition of done for an execution node. @beta */
export interface AcceptanceContract {
  readonly revision: number;
  readonly criteria: readonly AcceptanceCriterion[];
  readonly verificationPolicy: 'all_required';
}

/** Evidence-bound result for one acceptance-contract revision. @beta */
export interface AcceptanceVerdict {
  readonly verdict: 'PASS' | 'FAIL' | 'PARTIAL' | 'STALE';
  readonly contractRevision: number;
  readonly evidenceIds: readonly string[];
  readonly reasons: readonly string[];
  readonly decidedAt: number;
}

function isLegacyAcceptance(
  input: AcceptanceContract | readonly string[] | undefined
): input is readonly string[] {
  return Array.isArray(input);
}

function invalid(message: string): MossError {
  return new MossError({ code: ErrorCode.EXECUTION_STATE_INVALID, message });
}

function normalizeCriterion(
  criterion: AcceptanceCriterion,
  index: number
): AcceptanceCriterion | undefined {
  if (!criterion || typeof criterion !== 'object') {
    throw invalid(`acceptance criterion ${index + 1} must be an object`);
  }
  if (typeof criterion.description !== 'string' || typeof criterion.id !== 'string') {
    throw invalid(`acceptance criterion ${index + 1} requires string id and description`);
  }
  const description = criterion.description.trim();
  if (!description) return undefined;
  const id = criterion.id.trim() || `criterion-${index + 1}`;
  if (!['deterministic', 'semantic', 'manual'].includes(criterion.kind)) {
    throw invalid(`acceptance criterion "${id}" has an invalid kind`);
  }
  return {
    id,
    description,
    kind: criterion.kind,
    required: criterion.required !== false,
    ...(criterion.evidenceKinds
      ? {
          evidenceKinds: [
            ...new Set(
              criterion.evidenceKinds.map((item) => {
                if (typeof item !== 'string') throw invalid(`evidence kind must be a string`);
                return item.trim();
              })
            ),
          ],
        }
      : {}),
    ...(criterion.requirementIds
      ? {
          requirementIds: [
            ...new Set(
              criterion.requirementIds.map((item) => {
                if (typeof item !== 'string') throw invalid(`requirement id must be a string`);
                return item.trim();
              })
            ),
          ],
        }
      : {}),
  };
}

/** Normalize a structured or legacy acceptance definition into one contract. @beta */
export function normalizeAcceptanceContract(
  input: AcceptanceContract | readonly string[] | undefined,
  revision = 1
): AcceptanceContract | undefined {
  const legacy = isLegacyAcceptance(input);
  const contractRevision = legacy ? revision : (input?.revision ?? revision);
  if (!Number.isInteger(contractRevision) || contractRevision < 1) {
    throw invalid('acceptance contract revision must be a positive integer');
  }
  const rawCriteria: readonly AcceptanceCriterion[] | undefined = legacy
    ? input.map((description, index) => ({
        id: `criterion-${index + 1}`,
        description,
        kind: 'deterministic' as const,
        required: true,
      }))
    : input?.criteria;
  if (!rawCriteria) return undefined;
  const criteria = rawCriteria
    .map((criterion, index) => normalizeCriterion(criterion, index))
    .filter((criterion): criterion is AcceptanceCriterion => criterion !== undefined);
  const ids = new Set<string>();
  for (const criterion of criteria) {
    if (ids.has(criterion.id)) throw invalid(`duplicate acceptance criterion "${criterion.id}"`);
    ids.add(criterion.id);
  }
  return {
    revision: contractRevision,
    criteria,
    verificationPolicy: 'all_required',
  };
}

/** Assert the acceptance invariant for one mutating implementation node. @beta */
export function requireMutatingAcceptanceContract(
  nodeId: string,
  contract: AcceptanceContract | undefined
): AcceptanceContract {
  if (!contract || !contract.criteria.some((criterion) => criterion.required)) {
    throw invalid(
      `implementation node "${nodeId}" requires at least one non-empty acceptance criterion`
    );
  }
  return contract;
}
