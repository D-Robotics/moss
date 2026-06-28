



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





export function resolveToolFollowupBypassCap(maxTurns: number): number {
  const scaled = maxTurns + Math.floor(maxTurns / 2) + 32;
  return Math.min(192, scaled);
}
