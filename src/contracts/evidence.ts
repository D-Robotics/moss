/**
 * Evidence contract (robotics closed loop P0-8) — "No Evidence, No Success".
 * An evidence record is the atomic unit every success/failure claim must
 * reduce to: what was measured, what was expected, what was observed, and
 * the verdict. The comparator evaluator lives here (pure, dependency-free)
 * following the async-task contract pattern.
 */

export type EvidenceResult = 'pass' | 'fail' | 'inconclusive';

export type EvidenceComparator =
  | '>='
  | '<='
  | '>'
  | '<'
  | '=='
  | '!='
  | 'contains'
  | 'not-contains'
  | 'exists'
  | 'matches';

export interface EvidenceRecord {
  evidenceId: string;
  /** Task/acceptance this evidence belongs to (task contract id, bench task, …). */
  taskId?: string;
  deviceId?: string;
  /** Where the observation came from: 'device_exec', 'device_deploy', 'run_tests', 'human', … */
  source: string;
  /** What was measured, e.g. 'camera_fps', 'process_alive:app', 'topic_hz:/cmd_vel'. */
  metric: string;
  /** Expectation expression, e.g. '>=30' — evaluated against observed. */
  expected?: string;
  observed?: string | number | boolean;
  comparator?: EvidenceComparator;
  result: EvidenceResult;
  timestamp: number;
  details?: string;
}

export interface ExpectationEvaluation {
  comparator: EvidenceComparator | 'none';
  result: EvidenceResult;
  /** Human-readable expansion, e.g. '31.2 >= 30 → pass'. */
  explanation: string;
}

const COMPARATOR_PATTERN = new RegExp(
  `^(>=|<=|==|!=|>|<|contains|not-contains|exists|matches)\\s*(.*)$`,
  'i'
);

// F24: vocabulary for the `exists` comparator. A presence verdict must
// understand negative observations — scoring observed "missing" as PASS was a
// false-PASS in the acceptance gate. Negatives are matched first so phrases
// like "not found" win over a leading "found"; anything indeterminate is
// inconclusive, honoring this file's invariant: never a silent pass.
const EXISTS_NEGATIVE_EXACT = new Set([
  'missing',
  'absent',
  'false',
  'no',
  'none',
  'null',
  'nil',
  '0',
  'n/a',
  'na',
  'enoent',
  'gone',
  'unavailable',
  'not found',
  'not present',
  'not there',
  'no such file',
  'no such file or directory',
  'no such directory',
  'no such path',
  'does not exist',
  "doesn't exist",
  'file not found',
  'path not found',
  'nothing found',
]);
const EXISTS_NEGATIVE_PHRASES = [
  'no such file',
  'not found',
  'does not exist',
  "doesn't exist",
  'nonexistent',
  'non-existent',
  'enoent',
  'nothing found',
  'found nothing',
  'none found',
  'cannot find',
  "can't find",
  'unable to find',
  'is missing',
  'was missing',
];
const EXISTS_POSITIVE_PREFIX =
  /^(?:exists?|existing|present|found|active|alive|connected|available|ok|okay|yes|true|there)\b/;
const EXISTS_COUNT_PATTERN = /^\d+(?:\.\d+)?$/;

/**
 * Evaluate an expectation expression against an observed value.
 * Supported: numeric comparisons (>=30, <=5, >0, <100, ==4, !=1), string
 * containment (contains err / not-contains fail), presence (exists), and
 * regex matching (matches ^active$). Line-anchored regexes follow grep
 * semantics so trailing newlines do not break device output checks.
 * Anything unparseable is 'inconclusive' — never a silent pass.
 */
export function evaluateExpectation(
  expected: string | undefined,
  observed: string | number | boolean | undefined
): ExpectationEvaluation {
  if (expected === undefined || expected === null || expected.trim() === '') {
    return { comparator: 'none', result: 'inconclusive', explanation: 'no expectation given' };
  }
  const match = COMPARATOR_PATTERN.exec(expected.trim());
  const comparator = (match?.[1] ?? '').toLowerCase() as EvidenceComparator | '';
  const operand = (match?.[2] ?? '').trim();
  const observedText =
    observed === undefined ? '' : typeof observed === 'string' ? observed : String(observed);

  if (!comparator) {
    // Bare expected value: equality on strings, numeric equality on numbers.
    if (Number.isFinite(Number(expected)) && Number.isFinite(Number(observed))) {
      const ok = Number(expected) === Number(observed);
      return {
        comparator: '==',
        result: ok ? 'pass' : 'fail',
        explanation: `${observed} == ${expected} → ${ok ? 'pass' : 'fail'}`,
      };
    }
    const ok = observedText.trim() === expected.trim();
    return {
      comparator: '==',
      result: ok ? 'pass' : 'fail',
      explanation: `"${observedText.trim()}" == "${expected.trim()}" → ${ok ? 'pass' : 'fail'}`,
    };
  }

  switch (comparator) {
    case '>=':
    case '<=':
    case '>':
    case '<':
    case '==':
    case '!=': {
      const lhs = Number(observed);
      const rhs = Number(operand);
      if (!Number.isFinite(lhs) || !Number.isFinite(rhs)) {
        return {
          comparator,
          result: 'inconclusive',
          explanation: `non-numeric comparison: observed="${observedText}" ${comparator} ${operand}`,
        };
      }
      const ok =
        comparator === '>='
          ? lhs >= rhs
          : comparator === '<='
            ? lhs <= rhs
            : comparator === '>'
              ? lhs > rhs
              : comparator === '<'
                ? lhs < rhs
                : comparator === '=='
                  ? lhs === rhs
                  : lhs !== rhs;
      return {
        comparator,
        result: ok ? 'pass' : 'fail',
        explanation: `${lhs} ${comparator} ${rhs} → ${ok ? 'pass' : 'fail'}`,
      };
    }
    case 'contains':
    case 'not-contains': {
      const ok = observedText.includes(operand);
      const pass = comparator === 'contains' ? ok : !ok;
      return {
        comparator,
        result: pass ? 'pass' : 'fail',
        explanation: `"${observedText.slice(0, 120)}" ${comparator} "${operand}" → ${pass ? 'pass' : 'fail'}`,
      };
    }
    case 'exists': {
      if (observed === undefined) {
        return { comparator, result: 'fail', explanation: 'nothing observed → fail' };
      }
      const text = observedText.trim();
      if (text === '') {
        return { comparator, result: 'fail', explanation: 'observed empty → fail' };
      }
      const lower = text.toLowerCase();
      if (
        EXISTS_NEGATIVE_EXACT.has(lower) ||
        EXISTS_NEGATIVE_PHRASES.some((phrase) => lower.includes(phrase))
      ) {
        return {
          comparator,
          result: 'fail',
          explanation: `observed "${text.slice(0, 120)}" indicates absence → fail`,
        };
      }
      if (EXISTS_COUNT_PATTERN.test(lower)) {
        const present = Number(lower) > 0;
        return {
          comparator,
          result: present ? 'pass' : 'fail',
          explanation: `observed count ${lower} → ${present ? 'pass' : 'fail'}`,
        };
      }
      if (EXISTS_POSITIVE_PREFIX.test(lower)) {
        return {
          comparator,
          result: 'pass',
          explanation: `observed "${text.slice(0, 120)}" indicates presence → pass`,
        };
      }
      return {
        comparator,
        result: 'inconclusive',
        explanation: `cannot determine presence from observed "${text.slice(0, 120)}" → inconclusive (never a silent pass)`,
      };
    }
    case 'matches': {
      try {
        const ok = new RegExp(operand, 'm').test(observedText);
        return {
          comparator,
          result: ok ? 'pass' : 'fail',
          explanation: `"${observedText.slice(0, 120)}" matches /${operand}/ → ${ok ? 'pass' : 'fail'}`,
        };
      } catch {
        return {
          comparator,
          result: 'inconclusive',
          explanation: `invalid regex: /${operand}/`,
        };
      }
    }
    default:
      return { comparator: comparator, result: 'inconclusive', explanation: 'unknown comparator' };
  }
}

/** Registry-facing summary of stored evidence for a workspace. */
export interface EvidenceStoreSummary {
  total: number;
  passed: number;
  failed: number;
  inconclusive: number;
}
