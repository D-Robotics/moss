/**
 * Persist every device-policy decision to the task evidence file and, when
 * a live task exists, to its timeline as a `note` (info event; phase unchanged).
 */
import type { EvidenceRecord } from '../contracts/evidence.js';
import { appendEvidenceRecord } from '../core/task-runtime/artifacts.js';
import { findLatestLiveTaskSnapshot, tryAppendTaskEvent } from '../core/task/task-store.js';
import type { DeviceRiskTier } from '../safety/device-risk.js';
import { sanitizeSecrets } from '../safety/secret-sanitizer.js';

export interface DevicePolicyLogInput {
  workspaceDir: string | undefined;
  toolName: string;
  tier: DeviceRiskTier;
  decision: 'allow' | 'deny';
  signal: string;
  reason: string;
  operand?: string;
  deviceId?: string;
}

function evidenceId(): string {
  return `ev_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export async function recordDevicePolicyDecision(input: DevicePolicyLogInput): Promise<void> {
  const workspaceDir = input.workspaceDir;
  if (!workspaceDir) return;
  try {
    const operand = sanitizeSecrets((input.operand ?? '').slice(0, 400));
    const reason = sanitizeSecrets(input.reason).slice(0, 300);
    const taskId = (await findLatestLiveTaskSnapshot(workspaceDir))?.taskId;
    const record: EvidenceRecord = {
      evidenceId: evidenceId(),
      ...(taskId ? { taskId } : {}),
      ...(input.deviceId ? { deviceId: input.deviceId } : {}),
      source: 'device_policy',
      metric: 'device_policy',
      expected:
        input.tier === 'sensitive'
          ? 'sensitive-requires-explicit-trust'
          : input.tier === 'destructive'
            ? 'destructive-requires-explicit-trust'
            : 'auto-allow',
      observed: `${input.tier}:${input.decision}`,
      result: input.decision === 'allow' ? 'pass' : 'fail',
      timestamp: Date.now(),
      details: sanitizeSecrets(
        `${input.signal}: ${reason}${operand ? `; operand=${operand}` : ''}`
      ).slice(0, 800),
    };
    await appendEvidenceRecord(workspaceDir, record);
    if (taskId) {
      await tryAppendTaskEvent(workspaceDir, taskId, 'note', {
        kind: 'device_policy',
        tool: input.toolName,
        tier: input.tier,
        decision: input.decision,
        signal: input.signal,
        reason,
        ...(input.deviceId ? { deviceId: input.deviceId } : {}),
      });
    }
  } catch {
    // A logging failure must not flip the decision.
  }
}
