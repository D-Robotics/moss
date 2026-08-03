import { createHash } from 'node:crypto';
import path from 'node:path';

export interface DeviceEnvironmentFacts {
  boardModel?: string;
  osVersion?: string;
  kernelVersion?: string;
  firmwareVersion?: string;
  architecture?: string;
}

export interface TrustedEnvironmentIdentity {
  schemaVersion: 1;
  fingerprint: string;
  completeness: 'complete' | 'incomplete';
  runtimeMode: 'local' | 'device';
  reasonCode: 'complete' | 'missing_workspace' | 'missing_board_model' | 'missing_version_signal';
}

export interface DeviceIdentityExecutor {
  run(command: string, options?: { timeout?: number; maxBuffer?: number }): Promise<{ stdout: string }>;
}

/** Fixed, system-owned probe. No user, model, Plan, or contract text is interpolated. */
export const DEVICE_ENVIRONMENT_IDENTITY_PROBE = [
  `printf 'boardModel=%s\\n' "$(tr -d '\\000' < /proc/device-tree/model 2>/dev/null || cat /sys/devices/soc0/machine 2>/dev/null || true)"`,
  `printf 'osVersion=%s\\n' "$(. /etc/os-release 2>/dev/null; printf '%s' "\${PRETTY_NAME:-\${VERSION_ID:-}}")"`,
  `printf 'kernelVersion=%s\\n' "$(uname -r 2>/dev/null || true)"`,
  `printf 'firmwareVersion=%s\\n' "$(dpkg-query -W -f='\${Version}' hobot-kernel-headers 2>/dev/null || true)"`,
  `printf 'architecture=%s\\n' "$(uname -m 2>/dev/null || true)"`,
].join('; ');

function normalized(value: string | undefined): string | undefined {
  const trimmed = value?.replace(/\0/g, '').replace(/\s+/g, ' ').trim();
  return trimmed || undefined;
}

export function parseDeviceEnvironmentFacts(output: string): DeviceEnvironmentFacts {
  const values = new Map<string, string>();
  for (const line of output.split(/\r?\n/)) {
    const index = line.indexOf('=');
    if (index <= 0) continue;
    const value = normalized(line.slice(index + 1));
    if (value) values.set(line.slice(0, index), value);
  }
  return {
    boardModel: values.get('boardModel'),
    osVersion: values.get('osVersion'),
    kernelVersion: values.get('kernelVersion'),
    firmwareVersion: values.get('firmwareVersion'),
    architecture: values.get('architecture'),
  };
}

export async function probeDeviceEnvironmentFacts(executor: DeviceIdentityExecutor): Promise<DeviceEnvironmentFacts> {
  try {
    const result = await executor.run(DEVICE_ENVIRONMENT_IDENTITY_PROBE, {
      timeout: 10_000,
      maxBuffer: 16 * 1024,
    });
    return parseDeviceEnvironmentFacts(result.stdout);
  } catch {
    return {};
  }
}

export function trustedEnvironmentIdentity(input: {
  workspaceDir?: string;
  runtimeMode: 'local' | 'device';
  device?: DeviceEnvironmentFacts;
}): TrustedEnvironmentIdentity {
  const workspace = normalized(input.workspaceDir)
    ? path.resolve(input.workspaceDir!).replace(/\\/g, '/').toLowerCase()
    : undefined;
  if (!workspace) {
    return { schemaVersion: 1, fingerprint: 'unknown', completeness: 'incomplete', runtimeMode: input.runtimeMode, reasonCode: 'missing_workspace' };
  }
  if (input.runtimeMode === 'device') {
    const boardModel = normalized(input.device?.boardModel);
    const versionSignal = normalized(input.device?.firmwareVersion)
      ?? normalized(input.device?.osVersion)
      ?? normalized(input.device?.kernelVersion);
    if (!boardModel) {
      return { schemaVersion: 1, fingerprint: 'unknown', completeness: 'incomplete', runtimeMode: 'device', reasonCode: 'missing_board_model' };
    }
    if (!versionSignal) {
      return { schemaVersion: 1, fingerprint: 'unknown', completeness: 'incomplete', runtimeMode: 'device', reasonCode: 'missing_version_signal' };
    }
  }
  const values = {
    schemaVersion: 1,
    workspace,
    runtimeMode: input.runtimeMode,
    ...(input.runtimeMode === 'device' ? {
      boardModel: normalized(input.device?.boardModel),
      osVersion: normalized(input.device?.osVersion),
      kernelVersion: normalized(input.device?.kernelVersion),
      firmwareVersion: normalized(input.device?.firmwareVersion),
      architecture: normalized(input.device?.architecture),
    } : {}),
  };
  return {
    schemaVersion: 1,
    fingerprint: `sha256:v1:${createHash('sha256').update(JSON.stringify(values)).digest('hex')}`,
    completeness: 'complete',
    runtimeMode: input.runtimeMode,
    reasonCode: 'complete',
  };
}

/** Hash stable, non-secret execution context without persisting its raw values. */
export function environmentFingerprint(input: {
  workspaceDir?: string;
  boardType?: string;
  firmwareVersion?: string;
  runtimeMode?: string;
}): string {
  const workspaceDir = input.workspaceDir?.trim();
  const values = {
    ...(workspaceDir ? { workspace: path.resolve(workspaceDir).replace(/\\/g, '/').toLowerCase() } : {}),
    ...(input.boardType ? { boardType: input.boardType } : {}),
    ...(input.firmwareVersion ? { firmwareVersion: input.firmwareVersion } : {}),
    ...(input.runtimeMode ? { runtimeMode: input.runtimeMode } : {}),
  };
  if (Object.keys(values).length === 0) return 'unknown';
  return `sha256:${createHash('sha256').update(JSON.stringify(values)).digest('hex')}`;
}
