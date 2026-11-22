export const MOSS_DEFAULT_MAX_AGENT_TURNS = 64;

export const MOSS_MAX_AGENT_TURNS_HARD_CAP = 256;

export function resolveMossMaxAgentTurns(envValue?: string | undefined): number {
  const raw = envValue ?? process.env.MOSS_MAX_AGENT_TURNS?.trim();
  if (raw) {
    const n = Number.parseInt(String(raw).trim(), 10);
    if (Number.isFinite(n) && n > 0) return Math.min(MOSS_MAX_AGENT_TURNS_HARD_CAP, n);
  }
  return MOSS_DEFAULT_MAX_AGENT_TURNS;
}

export function resolveToolFollowupBypassCap(maxTurns: number | null): number {
  if (maxTurns === null) return 0; // No post-limit bypass is needed for unlimited turns.
  // A bounded sub-agent budget is an authority boundary, not a soft target.
  // Historically every budget received a fixed +32 extra turns; that is fine
  // for a 64-turn parent but lets a 2-turn child run 35 turns, creating a long
  // tail the parent UI cannot distinguish from a stalled run. Studio's child
  // budgets are 2–10 turns, so cap their headroom at their own budget while
  // leaving larger (parent) budgets on the historical formula.
  if (maxTurns <= 12) {
    return Math.min(192, Math.max(maxTurns + 2, maxTurns * 2));
  }
  const scaled = maxTurns + Math.floor(maxTurns / 2) + 32;
  return Math.min(192, scaled);
}
