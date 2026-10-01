/**
 * Deployment contract (robotics closed loop P0-5) — the shared types for the
 * unified deployment lifecycle: upload → (start) → health check → record.
 * A deployment is the durable unit that ties an artifact to a device run and
 * carries the evidence later verification consumes.
 */

export type DeploymentStatus =
  | 'pending'
  | 'uploading'
  | 'uploaded'
  | 'starting'
  | 'running'
  | 'failed'
  | 'stopped';

export interface DeploymentStepLog {
  step: 'prepare-dir' | 'upload' | 'chmod' | 'start' | 'health-check';
  status: 'ok' | 'failed' | 'skipped';
  exitCode?: number | null;
  durationMs?: number;
  outputPreview?: string;
}

export interface DeploymentHealthCheck {
  command: string;
  passed: boolean;
  checkedAt: number;
  exitCode?: number | null;
  outputPreview?: string;
}

export interface DeploymentRecord {
  deploymentId: string;
  deviceId: string;
  artifactPath: string;
  remotePath: string;
  status: DeploymentStatus;
  startedAt: number;
  completedAt?: number;
  steps: DeploymentStepLog[];
  healthCheck?: DeploymentHealthCheck;
  error?: string;
  /**
   * Task this deployment serves (explicit task_id or the latest live task).
   * Absent on records written before the field existed — consumers fall back
   * to device-scoped association for those.
   */
  taskId?: string;
}

export interface DeploymentPlan {
  /** Local artifact to deploy. Resolved inside the workspace sandbox. */
  artifactPath: string;
  /** Absolute destination path on the device. */
  remotePath: string;
  /** Mark the artifact executable on the device (chmod +x). */
  executable?: boolean;
  /** Command that starts the deployed artifact (systemd / nohup / direct). */
  startCommand?: string;
  /** Command proving the deployment is alive; exit 0 = healthy. */
  healthCommand?: string;
  /** Optional regex the health output must match (beyond exit 0). */
  healthExpect?: string;
  timeoutMs?: number;
}
