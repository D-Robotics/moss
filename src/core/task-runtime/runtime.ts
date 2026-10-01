/**
 * Task Runtime (robotics closed loop) — the single source of truth for
 * mission state that the TUI, REPL and headless frontends share. It fuses two
 * channels: the durable `.moss/` artifacts (task contracts, evidence,
 * deployments, acceptance verdicts) and the live MossAgentEvent stream (tool
 * activity, device observations, approvals, errors) into a task-first
 * projection: state machine + result + canvas model.
 *
 * The runtime never renders; projections are plain data so specs can drive
 * them without ink. UI layers turn these into panels.
 */
import type { DeploymentRecord } from '../../contracts/deployment.js';
import type { EvidenceRecord } from '../../contracts/evidence.js';
import type { AcceptanceVerdict, CriterionVerdict, TaskContract } from '../../contracts/task.js';
import { evaluateAcceptance } from '../../contracts/task.js';
import type { MossAgentEvent } from '../agent/moss-agent-types.js';
import { loadTaskArtifacts, type TaskArtifacts } from './artifacts.js';
import { listTaskStateSnapshots } from '../task/task-store.js';
import type { TaskStateSnapshot } from '../../contracts/task-runtime.js';

export type MissionState = 'IDLE' | 'PLANNING' | 'EXECUTING' | 'BLOCKED' | 'COMPLETED';
export type MissionResult = 'PASS' | 'FAIL' | 'NEEDS USER';
export type TaskKind = 'camera' | 'ros' | 'model' | 'navigation' | 'general';

export interface TaskSummary {
  taskId: string;
  goal: string;
  kind: TaskKind;
  state: MissionState;
  /** Only meaningful once state is COMPLETED or BLOCKED. */
  result?: MissionResult;
  criteriaMet: number;
  criteriaTotal: number;
  updatedAt: number;
  targetDeviceId?: string;
  /** Task OS blocked reason, when the snapshot recorded one (blocked_on_user). */
  blockedReason?: string;
}

export interface FailureItem {
  at: number;
  source: 'evidence' | 'acceptance' | 'deployment' | 'tool';
  label: string;
  detail?: string;
}

export interface RepairCycle {
  /** When the failing verdict landed (repair trigger). */
  at: number;
  unmetRequired: number;
  /** Evidence re-measurements recorded after the failure. */
  reMeasurements: number;
  /** Deployments after the failure (redeploy attempts). */
  reDeployments: number;
  /** Verdict of the acceptance run after the repair, if any. */
  resolvedTo?: 'pass' | 'fail' | 'partial';
}

export interface TaskHistoryEntry {
  at: number;
  kind: 'deployment' | 'evidence' | 'acceptance' | 'define';
  label: string;
}

export interface DeviceObservation {
  at: number;
  tool: string;
  preview: string;
}

export interface TaskDeviceContext {
  deviceId: string;
  deployments: DeploymentRecord[];
  /** Live session observations (device tool outputs), newest last. */
  observations: DeviceObservation[];
}

export interface TaskDetail {
  summary: TaskSummary;
  goal: string;
  constraints?: string[];
  /** Agent-declared verification plan (contract verificationPlan). */
  plan: string[];
  currentAction?: string;
  /** Live criterion evaluation — progress before any recorded verdict. */
  progress: CriterionVerdict[];
  failure?: { headline: string; items: FailureItem[] };
  repair: RepairCycle[];
  /** Evidence records for this task, newest first. */
  verification: EvidenceRecord[];
  acceptance?: AcceptanceVerdict;
  history: TaskHistoryEntry[];
  device?: TaskDeviceContext;
}

export interface RuntimeLiveState {
  running: boolean;
  sawToolCall: boolean;
  currentAction?: string;
  focusTaskId?: string;
  approvalPending: boolean;
  halted: boolean;
  lastError?: { tool?: string; message: string; at: number };
}

const TASK_MUTATING_TOOLS = new Set([
  'task_define',
  'task_acceptance',
  'record_evidence',
  'device_deploy',
]);
const DEVICE_TOOLS = new Set([
  'device_info',
  'device_processes',
  'device_resources',
  'device_temperature',
  'device_network',
  'device_cameras',
  'device_robotics_status',
  'device_file_read',
  'device_file_list',
  'device_exec',
  'device_file_write',
  'device_deploy',
]);

const KIND_PATTERNS: Array<{ kind: TaskKind; pattern: RegExp }> = [
  { kind: 'camera', pattern: /camera|fps|frame|imaging|rgb|isp|双目|相机|摄像头|影像/gi },
  { kind: 'ros', pattern: /\bros2?\b|ros[ _-]|node|topic|launch|tros|humble|话题|节点/gi },
  { kind: 'model', pattern: /model|infer|latency|bpu|quant|yolo|detect|nn_|模型|推理|量化/gi },
  {
    kind: 'navigation',
    pattern: /nav|slam|odom|position|velocity|waypoint|move_base|定位|导航|建图/gi,
  },
];

export function classifyTaskKind(
  goal: string,
  metrics: string[] = [],
  extra: string[] = []
): TaskKind {
  const haystack = [goal, ...metrics, ...extra].join(' ');
  let best: { kind: TaskKind; score: number } = { kind: 'general', score: 0 };
  for (const { kind, pattern } of KIND_PATTERNS) {
    const score = haystack.match(pattern)?.length ?? 0;
    if (score > best.score) best = { kind, score };
  }
  return best.score > 0 ? best.kind : 'general';
}

function pickString(input: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return undefined;
}

function clip(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

/** Human phrase for the "current action" line — internal tool names are UI noise. */
export function describeToolCall(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case 'task_define':
      return `defining task: ${clip(pickString(input, ['goal']) ?? '', 60)}`;
    case 'task_acceptance':
      return 'evaluating acceptance';
    case 'record_evidence':
      return `verifying: ${pickString(input, ['metric']) ?? 'recording evidence'}`;
    case 'device_exec':
      return `device ▸ ${clip(pickString(input, ['command']) ?? '', 48)}`;
    case 'device_deploy':
      return `deploying ${clip(pickString(input, ['artifact_path']) ?? 'artifact', 36)} → device`;
    case 'device_file_write':
      return `device ▸ writing ${clip(pickString(input, ['path', 'remote_path']) ?? '', 40)}`;
    case 'device_file_read':
      return `device ▸ reading ${clip(pickString(input, ['path', 'remote_path']) ?? '', 40)}`;
    case 'device_file_list':
      return `device ▸ listing ${clip(pickString(input, ['path']) ?? '', 40)}`;
    case 'device_info':
      return 'device ▸ reading system info';
    case 'device_processes':
      return 'device ▸ listing processes';
    case 'device_resources':
      return 'device ▸ sampling cpu/memory';
    case 'device_temperature':
      return 'device ▸ reading temperature';
    case 'device_network':
      return 'device ▸ mapping network';
    case 'device_cameras':
      return 'device ▸ probing cameras';
    case 'device_robotics_status':
      return 'device ▸ probing ROS/TROS stack';
    case 'run_tests':
      return `running tests${pickString(input, ['command']) ? ` ▸ ${clip(pickString(input, ['command']) ?? '', 40)}` : ''}`;
    case 'read':
      return `reading ${clip(pickString(input, ['file_path', 'path']) ?? '', 48)}`;
    case 'write':
      return `writing ${clip(pickString(input, ['file_path', 'path']) ?? '', 48)}`;
    case 'edit':
      return `editing ${clip(pickString(input, ['file_path', 'path']) ?? '', 48)}`;
    case 'bash':
    case 'shell':
    case 'exec':
      return `running ${clip(pickString(input, ['command']) ?? '', 48)}`;
    default:
      return toolName.replace(/_/g, ' ');
  }
}

function observationPreview(result: string): string {
  const lines = result
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== '' && !line.startsWith('==='));
  return lines.slice(0, 2).join(' | ');
}

export interface TaskRuntimeOptions {
  workspaceDir: string;
  now?: () => number;
}

/**
 * Shared task runtime. Call `refresh()` on boot, feed every agent event with
 * `applyEvent`, bracket runs with `beginRun`/`endRun`, and let approval /
 * interrupt state in via `setApprovalPending`. Projections (`taskSummaries`,
 * `taskDetail`) are cheap and synchronous over cached artifacts.
 */
export class TaskRuntime {
  readonly workspaceDir: string;
  private readonly now: () => number;
  private artifacts: TaskArtifacts = {
    tasks: [],
    evidence: [],
    deployments: [],
    acceptance: [],
  };
  private taskSnapshots = new Map<string, TaskStateSnapshot>();
  private live: RuntimeLiveState = {
    running: false,
    sawToolCall: false,
    approvalPending: false,
    halted: false,
  };
  private runStartedAt = 0;
  private observations: DeviceObservation[] = [];
  private activeToolCallId: string | undefined;
  private refreshing = false;
  private refreshQueued = false;
  private listeners = new Set<() => void>();
  /** Bumped after every completed refresh — UIs re-read projections then. */
  version = 0;

  constructor(options: TaskRuntimeOptions) {
    this.workspaceDir = options.workspaceDir;
    this.now = options.now ?? (() => Date.now());
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notifyChange(): void {
    this.version++;
    for (const listener of this.listeners) listener();
  }

  async refresh(): Promise<void> {
    if (this.refreshing) {
      this.refreshQueued = true;
      return;
    }
    this.refreshing = true;
    try {
      this.artifacts = await loadTaskArtifacts(this.workspaceDir);
      const snapshots = await listTaskStateSnapshots(this.workspaceDir);
      this.taskSnapshots = new Map(snapshots.map((snapshot) => [snapshot.taskId, snapshot]));
    } finally {
      this.refreshing = false;
      if (this.refreshQueued) {
        this.refreshQueued = false;
        await this.refresh();
        return;
      }
    }
    this.updateFocus();
    this.notifyChange();
  }

  private updateFocus(): void {
    const touched = this.artifacts.tasks
      .filter((task) => task.updatedAt >= this.runStartedAt && this.runStartedAt > 0)
      .sort((a, b) => b.updatedAt - a.updatedAt);
    if (touched.length > 0) {
      this.live.focusTaskId = touched[0].taskId;
    } else if (!this.live.focusTaskId) {
      const latest = [...this.artifacts.tasks].sort((a, b) => b.updatedAt - a.updatedAt)[0];
      if (latest) this.live.focusTaskId = latest.taskId;
    }
  }

  beginRun(): void {
    this.runStartedAt = this.now();
    this.live.running = true;
    this.live.sawToolCall = false;
    this.live.currentAction = undefined;
    this.live.halted = false;
    this.live.lastError = undefined;
  }

  async endRun(halted: boolean): Promise<void> {
    this.live.running = false;
    this.live.currentAction = undefined;
    this.live.halted = halted;
    await this.refresh();
  }

  setApprovalPending(pending: boolean): void {
    this.live.approvalPending = pending;
  }

  getLiveState(): RuntimeLiveState {
    return { ...this.live };
  }

  getArtifacts(): TaskArtifacts {
    return this.artifacts;
  }

  applyEvent(event: MossAgentEvent): void {
    switch (event.type) {
      case 'tool_start': {
        this.live.sawToolCall = true;
        this.live.currentAction = describeToolCall(event.toolName, event.input);
        this.activeToolCallId = event.toolCallId;
        if (event.toolName === 'task_define') {
          const redefine = pickString(event.input, ['task_id']);
          if (redefine) this.live.focusTaskId = redefine;
        }
        break;
      }
      case 'tool_end': {
        if (event.isError) {
          this.live.lastError = {
            tool: event.toolName,
            message: clip(event.result || event.error?.message || 'tool failed', 160),
            at: this.now(),
          };
        }
        if (TASK_MUTATING_TOOLS.has(event.toolName)) {
          void this.refresh();
        }
        if (DEVICE_TOOLS.has(event.toolName) && !event.isError) {
          const preview = observationPreview(event.result);
          if (preview) {
            this.observations.push({ at: this.now(), tool: event.toolName, preview });
            if (this.observations.length > 30) this.observations.shift();
          }
        }
        if (event.toolCallId === this.activeToolCallId) {
          this.live.currentAction = undefined;
          this.activeToolCallId = undefined;
        }
        break;
      }
      case 'error': {
        this.live.lastError = { message: clip(String(event.error), 160), at: this.now() };
        break;
      }
      default:
        break;
    }
  }

  private verdictsFor(taskId: string): AcceptanceVerdict[] {
    return this.artifacts.acceptance.filter((verdict) => verdict.taskId === taskId);
  }

  private latestVerdict(taskId: string): AcceptanceVerdict | undefined {
    const verdicts = this.verdictsFor(taskId);
    return verdicts.length > 0 ? verdicts[verdicts.length - 1] : undefined;
  }

  private deriveState(
    task: TaskContract,
    latestVerdict: AcceptanceVerdict | undefined
  ): { state: MissionState; result?: MissionResult } {
    const snapshot = this.taskSnapshots.get(task.taskId);
    if (snapshot?.phase === 'accepted') return { state: 'COMPLETED', result: 'PASS' };
    if (snapshot?.phase === 'failed' || snapshot?.phase === 'abandoned') {
      return { state: 'COMPLETED', result: 'FAIL' };
    }
    if (snapshot?.phase === 'blocked') return { state: 'BLOCKED', result: 'NEEDS USER' };
    if (snapshot && ['understanding', 'planning', 'ready'].includes(snapshot.phase)) {
      return { state: 'PLANNING' };
    }
    if (
      snapshot &&
      ['executing', 'verifying', 'diagnosing', 'repairing', 'reverifying'].includes(snapshot.phase)
    ) {
      return { state: 'EXECUTING' };
    }
    const isFocus = this.live.focusTaskId === task.taskId;
    const pass = latestVerdict?.verdict === 'pass' || task.status === 'accepted';
    if (pass) return { state: 'COMPLETED', result: 'PASS' };
    if (isFocus && this.live.approvalPending) return { state: 'BLOCKED', result: 'NEEDS USER' };
    if (isFocus && this.live.running) {
      return { state: this.live.sawToolCall ? 'EXECUTING' : 'PLANNING' };
    }
    if (latestVerdict?.verdict === 'fail' || task.status === 'failed') {
      return { state: 'BLOCKED', result: 'FAIL' };
    }
    if (task.status === 'abandoned') return { state: 'BLOCKED', result: 'NEEDS USER' };
    if (isFocus && (this.live.halted || this.live.lastError)) {
      return { state: 'BLOCKED', result: 'NEEDS USER' };
    }
    return { state: 'IDLE' };
  }

  private summarize(task: TaskContract): TaskSummary {
    const evidence = this.artifacts.evidence;
    const verdict = evaluateAcceptance(task, evidence);
    const { state, result } = this.deriveState(task, this.latestVerdict(task.taskId));
    return {
      taskId: task.taskId,
      goal: task.goal,
      kind: classifyTaskKind(
        task.goal,
        task.acceptanceCriteria.map((criterion) => criterion.metric),
        [task.expectedBehavior ?? '', task.verificationPlan?.join(' ') ?? '']
      ),
      state,
      ...(result ? { result } : {}),
      criteriaMet: verdict.criteriaResults.filter((r) => r.result === 'pass').length,
      criteriaTotal: verdict.criteriaResults.length,
      updatedAt: task.updatedAt,
      ...(task.targetDeviceId ? { targetDeviceId: task.targetDeviceId } : {}),
      ...(this.taskSnapshots.get(task.taskId)?.blockedReason
        ? { blockedReason: this.taskSnapshots.get(task.taskId)?.blockedReason }
        : {}),
    };
  }

  /** All tasks, newest activity first — the Task Navigator list. */
  taskSummaries(): TaskSummary[] {
    return [...this.artifacts.tasks]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((task) => this.summarize(task));
  }

  private failuresFor(
    task: TaskContract,
    verdicts: AcceptanceVerdict[],
    evidence: EvidenceRecord[],
    deployments: DeploymentRecord[]
  ): FailureItem[] {
    const items: FailureItem[] = [];
    for (const verdict of verdicts) {
      if (verdict.verdict === 'pass') continue;
      for (const row of verdict.criteriaResults) {
        if (row.result === 'pass') continue;
        items.push({
          at: verdict.acceptedAt,
          source: 'acceptance',
          label: `${row.metric} ${row.result === 'no-evidence' ? 'missing evidence' : `observed ${row.observed ?? '?'}, expected ${row.expected}`}`,
          ...(row.explanation ? { detail: row.explanation } : {}),
        });
      }
    }
    for (const record of evidence) {
      if (record.result !== 'fail') continue;
      items.push({
        at: record.timestamp,
        source: 'evidence',
        label: `${record.metric} = ${record.observed ?? '?'} (${record.expected ?? 'no expectation'})`,
        ...(record.details ? { detail: clip(record.details, 160) } : {}),
      });
    }
    for (const deployment of deployments) {
      if (deployment.status !== 'failed') continue;
      items.push({
        at: deployment.startedAt,
        source: 'deployment',
        label: `deploy ${deployment.artifactPath} failed at ${deployment.steps.find((s) => s.status === 'failed')?.step ?? 'unknown step'}`,
        ...(deployment.error ? { detail: clip(deployment.error, 160) } : {}),
      });
    }
    if (this.live.focusTaskId === task.taskId && this.live.lastError) {
      items.push({
        at: this.live.lastError.at,
        source: 'tool',
        label: `${this.live.lastError.tool ?? 'agent'}: ${this.live.lastError.message}`,
      });
    }
    return items.sort((a, b) => b.at - a.at);
  }

  private repairsFor(
    verdicts: AcceptanceVerdict[],
    evidence: EvidenceRecord[],
    deployments: DeploymentRecord[]
  ): RepairCycle[] {
    const failing = verdicts.filter((verdict) => verdict.verdict !== 'pass');
    return failing.map((verdict, index) => {
      const next = failing[index + 1];
      const windowEnd = next?.acceptedAt ?? Number.POSITIVE_INFINITY;
      const reMeasurements = evidence.filter(
        (record) => record.timestamp > verdict.acceptedAt && record.timestamp < windowEnd
      ).length;
      const reDeployments = deployments.filter(
        (deployment) =>
          deployment.startedAt > verdict.acceptedAt && deployment.startedAt < windowEnd
      ).length;
      const after = verdicts.find(
        (candidate) => candidate.acceptedAt > verdict.acceptedAt && candidate.acceptedAt < windowEnd
      );
      return {
        at: verdict.acceptedAt,
        unmetRequired: verdict.unmetRequired,
        reMeasurements,
        reDeployments,
        ...(after ? { resolvedTo: after.verdict } : {}),
      };
    });
  }

  /** Full canvas model for one task; default = the focused / latest task. */
  taskDetail(taskId?: string): TaskDetail | undefined {
    const tasks = this.artifacts.tasks;
    const id =
      taskId ??
      this.live.focusTaskId ??
      [...tasks].sort((a, b) => b.updatedAt - a.updatedAt)[0]?.taskId;
    const task = tasks.find((candidate) => candidate.taskId === id);
    if (!task) return undefined;

    const verdicts = this.verdictsFor(task.taskId);
    const evidence = this.artifacts.evidence.filter((record) => record.taskId === task.taskId);
    // A3: never invent an association. A tagged deployment belongs to exactly
    // its task; only legacy untagged records fall back to device-scoped
    // association via the task's own device evidence. Live device
    // observations belong to the task being worked NOW, not to any task whose
    // detail happens to be browsed.
    const ownDeviceId = task.targetDeviceId ?? evidence.find((record) => record.deviceId)?.deviceId;
    const deviceId = ownDeviceId;
    const deployments = this.artifacts.deployments.filter(
      (deployment) =>
        deployment.taskId === task.taskId ||
        (deployment.taskId === undefined &&
          ownDeviceId !== undefined &&
          deployment.deviceId === ownDeviceId)
    );
    const observations = this.live.focusTaskId === task.taskId ? this.observations.slice(-8) : [];

    const summary = this.summarize(task);
    const failures = this.failuresFor(task, verdicts, evidence, deployments);
    const repairs = this.repairsFor(verdicts, evidence, deployments);

    const history: TaskHistoryEntry[] = [
      ...evidence.map((record) => ({
        at: record.timestamp,
        kind: 'evidence' as const,
        label: `${record.metric} → ${record.result.toUpperCase()}${record.observed !== undefined ? ` (${record.observed})` : ''}`,
      })),
      ...verdicts.map((verdict) => ({
        at: verdict.acceptedAt,
        kind: 'acceptance' as const,
        label: `acceptance ${verdict.verdict.toUpperCase()} (${verdict.unmetRequired} required unmet)`,
      })),
      ...deployments.map((deployment) => ({
        at: deployment.startedAt,
        kind: 'deployment' as const,
        label: `deploy ${deployment.artifactPath} → ${deployment.status}`,
      })),
      {
        at: task.createdAt,
        kind: 'define' as const,
        label: `task defined: ${clip(task.goal, 60)}`,
      },
    ].sort((a, b) => b.at - a.at);

    const live = this.getLiveState();
    return {
      summary,
      goal: task.goal,
      ...(task.constraints?.length ? { constraints: task.constraints } : {}),
      plan: task.verificationPlan ?? [],
      ...(live.running && live.focusTaskId === task.taskId
        ? {
            currentAction:
              live.currentAction ?? (live.sawToolCall ? undefined : 'reasoning about the goal'),
          }
        : {}),
      progress: evaluateAcceptance(task, evidence).criteriaResults,
      ...(failures.length > 0
        ? {
            failure: {
              headline: `${failures.length} failure${failures.length === 1 ? '' : 's'} on record`,
              items: failures.slice(0, 12),
            },
          }
        : {}),
      repair: repairs,
      verification: evidence,
      ...(verdicts.length > 0 ? { acceptance: verdicts[verdicts.length - 1] } : {}),
      history,
      ...(deviceId || observations.length > 0
        ? {
            device: {
              deviceId: deviceId ?? 'device (live session)',
              deployments: deployments.slice(0, 10),
              observations,
            },
          }
        : {}),
    };
  }
}

/**
 * A4: one deployment, one honest line. The status word alone lets "uploaded"
 * read as "running" and "running" read as "verified" — the tail names the
 * stage the record actually proves, including the health-check result.
 */
export function formatDeploymentLine(deployment: DeploymentRecord): string {
  const head = `${deployment.status.toUpperCase().padEnd(9)} ${deployment.deviceId} ${deployment.remotePath}`;
  let tail: string;
  switch (deployment.status) {
    case 'uploaded':
      tail = 'upload ok · not started';
      break;
    case 'uploading':
    case 'pending':
      tail = 'upload not confirmed';
      break;
    case 'starting':
      tail = 'start command issued';
      break;
    case 'running':
      tail = deployment.healthCheck
        ? `health ${deployment.healthCheck.passed ? 'PASS' : 'FAIL'} (exit ${deployment.healthCheck.exitCode ?? '?'})`
        : 'no health check recorded';
      break;
    case 'failed':
      tail = deployment.error ? deployment.error : 'failed';
      break;
    case 'stopped':
      tail = 'stopped by user';
      break;
    default:
      tail = deployment.status;
  }
  return `${head} — ${tail}${deployment.taskId ? ` · task ${deployment.taskId.slice(-6)}` : ''}`;
}
