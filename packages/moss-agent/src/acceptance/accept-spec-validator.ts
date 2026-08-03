import type { AcceptPredicateName, AcceptSpec } from './types.js';

const ACCEPT_PREDICATES = new Set<AcceptPredicateName>([
  'file_exist',
  'process_running',
  'pose_error_within',
  'force_below',
  'joint_at',
  'exit_code_zero',
  'stdout_matches',
  'video_fps_above',
]);

const REQUIRED_STRING_PARAMS: Partial<Record<AcceptPredicateName, string[]>> = {
  file_exist: ['path'],
  process_running: ['pattern'],
  pose_error_within: ['source', 'readCommand', 'valueRegex'],
  force_below: ['source', 'readCommand', 'currentRegex'],
  joint_at: ['readCommand', 'valueRegex'],
  stdout_matches: ['pattern'],
  video_fps_above: ['readCommand', 'valueRegex'],
};

const REQUIRED_NUMERIC_PARAMS: Partial<Record<AcceptPredicateName, string[]>> = {
  pose_error_within: ['threshold_mm'],
  force_below: ['threshold_n'],
  joint_at: ['target', 'tolerance'],
  video_fps_above: ['threshold_fps'],
};

const REGEX_PARAMS: Partial<Record<AcceptPredicateName, string[]>> = {
  process_running: ['pattern'],
  pose_error_within: ['valueRegex'],
  force_below: ['currentRegex'],
  joint_at: ['valueRegex'],
  stdout_matches: ['pattern'],
  video_fps_above: ['valueRegex'],
};

export function validateAcceptSpecs(specs: AcceptSpec[] | undefined): string[] {
  if (specs === undefined) return [];
  if (!Array.isArray(specs)) return ['terminalAccept must be an array'];
  const errors: string[] = [];
  specs.forEach((spec, index) => {
    const prefix = `terminalAccept[${index}]`;
    if (!spec || typeof spec !== 'object') {
      errors.push(`${prefix} must be an object`);
      return;
    }
    if (!ACCEPT_PREDICATES.has(spec.name)) {
      errors.push(`${prefix}.name is not a supported acceptance predicate: ${String(spec.name)}`);
      return;
    }
    if (!spec.params || typeof spec.params !== 'object' || Array.isArray(spec.params)) {
      errors.push(`${prefix}.params must be an object`);
      return;
    }
    for (const key of REQUIRED_STRING_PARAMS[spec.name] ?? []) {
      if (typeof spec.params[key] !== 'string' || !String(spec.params[key]).trim()) {
        errors.push(`${prefix}.params.${key} must be a non-empty string`);
      }
    }
    for (const key of REQUIRED_NUMERIC_PARAMS[spec.name] ?? []) {
      if (typeof spec.params[key] !== 'number' || !Number.isFinite(spec.params[key])) {
        errors.push(`${prefix}.params.${key} must be a finite number`);
      }
    }
    if (spec.name === 'joint_at' && typeof spec.params.tolerance === 'number' && spec.params.tolerance < 0) {
      errors.push(`${prefix}.params.tolerance must be >= 0`);
    }
    for (const key of ['threshold_mm', 'threshold_n', 'threshold_fps']) {
      if (typeof spec.params[key] === 'number' && spec.params[key] <= 0) {
        errors.push(`${prefix}.params.${key} must be > 0`);
      }
    }
    if (spec.name === 'pose_error_within' && !['camera', 'encoder'].includes(String(spec.params.source))) {
      errors.push(`${prefix}.params.source must be camera or encoder`);
    }
    if (spec.name === 'force_below' && !['force_sensor', 'current'].includes(String(spec.params.source))) {
      errors.push(`${prefix}.params.source must be force_sensor or current`);
    }
    for (const key of REGEX_PARAMS[spec.name] ?? []) {
      const value = spec.params[key];
      if (typeof value !== 'string' || !value) continue;
      try {
        new RegExp(value);
      } catch {
        errors.push(`${prefix}.params.${key} must be a valid regular expression`);
      }
    }
  });
  return errors;
}
