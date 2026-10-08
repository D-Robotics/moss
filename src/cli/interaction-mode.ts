/** CLI interaction modes shared by terminal and embedded hosts. */
import type { CliSafetyModeConfig, ConfigApprovalPolicy } from './config.js';

/**
 * v0.26 four-state interaction mode (PRD 2026-10-08 W1):
 * `manual` (renamed from `default`, alias-kept), `acceptEdits`, `plan`, `full`.
 * The mode is the FIRST axis of the permission engine — deriveEngineQuantas
 * derives safetyMode / approvalPolicy / deviceMutationPolicy from it.
 */
export type CliInteractionMode = 'manual' | 'acceptEdits' | 'plan' | 'full';

/** Engine quantas derived from a mode (design §1.2 derivation table). */
export interface EngineQuantas {
  safetyMode: CliSafetyModeConfig;
  approvalPolicy: ConfigApprovalPolicy;
  deviceMutationPolicy: 'ask' | 'allow' | 'deny';
  /** Workspace file edits auto-approve when the mode is acceptEdits/full. */
  acceptEditsEligible: boolean;
}

/**
 * Derive the engine quantas for a mode (the single derivation table):
 * - manual:      workspace-write + prompt + device ask + not acceptEdits-eligible
 * - acceptEdits: same base as manual but eligible for edit auto-approval
 * - plan:        workspace-write base + device class-level deny (decisions go
 *               through isAllowedDuringPlanMode, all current semantics kept)
 * - full:        full-access + never + device allow + eligible
 */
export function deriveEngineQuantas(mode: CliInteractionMode): EngineQuantas {
  switch (mode) {
    case 'full':
      return {
        safetyMode: 'full-access',
        approvalPolicy: 'never',
        deviceMutationPolicy: 'allow',
        acceptEditsEligible: true,
      };
    case 'plan':
      return {
        safetyMode: 'workspace-write',
        approvalPolicy: 'prompt',
        deviceMutationPolicy: 'deny',
        acceptEditsEligible: false,
      };
    case 'acceptEdits':
      return {
        safetyMode: 'workspace-write',
        approvalPolicy: 'prompt',
        deviceMutationPolicy: 'ask',
        acceptEditsEligible: true,
      };
    case 'manual':
      return {
        safetyMode: 'workspace-write',
        approvalPolicy: 'prompt',
        deviceMutationPolicy: 'ask',
        acceptEditsEligible: false,
      };
  }
}

let currentInteractionMode: CliInteractionMode = 'manual';

const interactionModeListeners = new Set<(mode: CliInteractionMode) => void>();

export function setCliInteractionMode(mode: CliInteractionMode): void {
  if (currentInteractionMode === mode) return;
  currentInteractionMode = mode;
  for (const listener of interactionModeListeners) {
    try {
      listener(mode);
    } catch {
      // listeners must not break mode transitions
    }
  }
}

export function getCliInteractionMode(): CliInteractionMode {
  return currentInteractionMode;
}

/** Subscribe to interaction-mode changes (manual / acceptEdits / plan / full). */
export function subscribeCliInteractionMode(
  listener: (mode: CliInteractionMode) => void
): () => void {
  interactionModeListeners.add(listener);
  return () => {
    interactionModeListeners.delete(listener);
  };
}

export function formatCliInteractionModeLabel(mode: CliInteractionMode, zh = false): string {
  if (mode === 'plan') return zh ? '计划模式' : 'plan';
  if (mode === 'acceptEdits') return zh ? '自动接受编辑' : 'accept-edits';
  if (mode === 'full') return zh ? '全开' : 'full';
  return zh ? '手动' : 'manual';
}

export function parseCliInteractionMode(raw: string | undefined): CliInteractionMode | null {
  const token = String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, '-');
  if (!token) return null;
  if (token === 'plan' || token === 'p' || token === '计划' || token === '计划模式') {
    return 'plan';
  }
  // v0.26: 'manual' is the canonical name; 'default' (and zh 默认) stay as
  // parse aliases so existing /mode default input and session-recovery
  // inference keep working (PRD W1, design §7-7).
  if (
    token === 'manual' ||
    token === 'default' ||
    token === 'd' ||
    token === 'normal' ||
    token === '默认' ||
    token === '默认模式' ||
    token === '手动'
  ) {
    return 'manual';
  }
  if (
    token === 'accept-edits' ||
    token === 'acceptedits' ||
    token === 'accept' ||
    token === 'a' ||
    token === '自动接受' ||
    token === '自动接受编辑'
  ) {
    return 'acceptEdits';
  }
  // full: new in v0.26. 'yolo' is deliberately NOT an alias — the ghost
  // command was deleted (design §1.4, args.ts cleanup).
  if (
    token === 'full' ||
    token === 'bypass' ||
    token === 'bypasspermissions' ||
    token === '自动' ||
    token === '全开'
  ) {
    return 'full';
  }
  return null;
}

/**
 * Best-effort interaction mode recovery from session history (no extra storage).
 * Newest signal wins:
 * - "Left plan mode → default" / switched-to-default text → manual
 * - user prompt prefixed with Moss plan-mode header → plan
 * - explicit /mode plan|default|accept-edits|full user text → that mode
 * Returns null when no signal is found.
 */
export function inferCliInteractionModeFromMessages(
  messages: ReadonlyArray<{ role?: string; content?: unknown }>
): CliInteractionMode | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m) continue;
    const texts: string[] = [];
    if (typeof m.content === 'string') {
      texts.push(m.content);
    } else if (Array.isArray(m.content)) {
      for (const block of m.content) {
        if (!block || typeof block !== 'object') continue;
        const b = block as { type?: string; text?: string; content?: unknown };
        if (typeof b.text === 'string') texts.push(b.text);
        if (typeof b.content === 'string') texts.push(b.content);
      }
    }
    for (const text of texts) {
      const head = text.slice(0, 240);
      if (
        /Left plan mode\s*(→|->)\s*default/i.test(text) ||
        /已切换到默认/i.test(text) ||
        /已切换到手动/i.test(text) ||
        /Switched to default\b/i.test(text) ||
        /Switched to manual\b/i.test(text)
      ) {
        return 'manual';
      }
      if (m.role === 'user' && (/^\[Plan mode\]/m.test(head) || /^\[计划模式\]/m.test(head))) {
        return 'plan';
      }
      if (m.role === 'user') {
        const cmd = text.trim().toLowerCase();
        if (/^\/mode\s+plan\b/.test(cmd) || cmd === '/plan') return 'plan';
        if (/^\/mode\s+accept-?edits\b/.test(cmd)) return 'acceptEdits';
        if (/^\/mode\s+(?:default|manual)\b/.test(cmd) || /^\/mode\s+(?:full|bypass)\b/.test(cmd)) {
          if (/^\/mode\s+full\b/.test(cmd)) return 'full';
          return 'manual';
        }
      }
    }
  }
  return null;
}

/** v0.26 default mode is `full` (PRD W1 default flip: full-access + never). */
export const DEFAULT_CLI_INTERACTION_MODE: CliInteractionMode = 'full';

/**
 * Translate a legacy safety-mode/approval-policy pair into a mode override
 * (design §3.3 mapping table). Exported for the config-side migration.
 */
export function modeFromLegacySafetyPair(
  safetyMode: CliSafetyModeConfig | undefined,
  approvalPolicy: ConfigApprovalPolicy | undefined
): CliInteractionMode {
  if (safetyMode === 'full-access' && approvalPolicy === 'never') return 'full';
  return 'manual';
}
