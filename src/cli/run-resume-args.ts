/**
 * `moss goal --resume …` argument shaping (B139).
 *
 * The CLI has one hero command for starting a verified run (`moss goal`), but
 * resuming one still required the long `moss task resume <id>` form. `--resume`
 * makes the run entry symmetric: no id resumes the newest resumable task, an id
 * resumes that one. This module only reshapes argv (pure), so the dispatcher and
 * the probe share exactly one parser.
 */
export interface ResumeShaping {
  /** True when `--resume` was present. */
  resume: boolean;
  /** Explicit id immediately after `--resume`, when it is not a flag. */
  id?: string;
  /** Remaining arguments with `--resume` (and the id) removed. */
  rest: string[];
}

export function shapeRunResumeArgs(args: readonly string[]): ResumeShaping {
  const index = args.indexOf('--resume');
  if (index === -1) return { resume: false, rest: [...args] };
  const rest = args.filter((_, position) => position !== index);
  const following = rest[index];
  // `moss goal --resume --accept "…"` keeps the id implicit; only a positional
  // token directly after `--resume` is an id (flags and their values are not).
  if (following !== undefined && !following.startsWith('-')) {
    return { resume: true, id: following, rest: rest.filter((_, position) => position !== index) };
  }
  return { resume: true, rest };
}

/** Build the `moss task …`-shape argv for the resume path. */
export function resumeTaskArgs(shaping: ResumeShaping, resolvedId: string): string[] {
  return ['resume', resolvedId, ...shaping.rest];
}
