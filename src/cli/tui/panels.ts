/**
 * Mission Control panel projections — pure functions from task-runtime data
 * to renderable lines. No ink/react imports so specs can drive them
 * directly. Every line is clipped to the panel width.
 */
import type {
  MissionResult,
  MissionState,
  TaskDetail,
  TaskKind,
  TaskSummary,
} from '../../core/task-runtime/runtime.js';
import type { EvidenceRecord } from '../../contracts/evidence.js';

export type PanelColor =
  | 'red'
  | 'green'
  | 'yellow'
  | 'cyan'
  | 'magenta'
  | 'blue'
  | 'gray'
  | 'white';

export interface PanelLine {
  text: string;
  color?: PanelColor;
  bold?: boolean;
  dim?: boolean;
}

export function line(text: string, props: Omit<PanelLine, 'text'> = {}): PanelLine {
  return { text, ...props };
}

export function clip(text: string, width: number): string {
  if (width <= 1) return text.length > 0 ? '…' : '';
  return text.length > width ? `${text.slice(0, width - 1)}…` : text;
}

export function wrap(text: string, width: number, indent = 0): string[] {
  const max = Math.max(4, width - indent);
  const words = text.replace(/\s+/g, ' ').trim().split(' ');
  const out: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > max && current) {
      out.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) out.push(current);
  return out.map((chunk) => ' '.repeat(indent) + chunk);
}

export function fmtTime(at: number): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return '--:--';
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

export function idTail(id: string, n = 6): string {
  return id.length > n ? id.slice(-n) : id;
}

const STATE_COLOR: Record<MissionState, PanelColor> = {
  IDLE: 'gray',
  PLANNING: 'cyan',
  EXECUTING: 'cyan',
  BLOCKED: 'yellow',
  COMPLETED: 'green',
};

const RESULT_COLOR: Record<MissionResult, PanelColor> = {
  PASS: 'green',
  FAIL: 'red',
  'NEEDS USER': 'magenta',
};

const KIND_LABEL: Record<TaskKind, string> = {
  camera: 'CAMERA',
  ros: 'ROS',
  model: 'MODEL',
  navigation: 'NAV',
  general: 'TASK',
};

export function stateLine(summary: TaskSummary): PanelLine {
  const label = summary.result ?? summary.state;
  const color = summary.result ? RESULT_COLOR[summary.result] : STATE_COLOR[summary.state];
  return line(label, { color, bold: summary.state === 'EXECUTING' });
}

// ---- Task Navigator (left column / task switcher) ----

export interface NavigatorInput {
  summaries: TaskSummary[];
  selectedTaskId?: string;
  focusTaskId?: string;
  width: number;
  height: number;
}

export function renderNavigator(input: NavigatorInput): PanelLine[] {
  const { summaries, selectedTaskId, focusTaskId, width, height } = input;
  const out: PanelLine[] = [
    line(clip(`TASKS (${summaries.length})`, width), { bold: true }),
    line('─'.repeat(Math.max(3, Math.min(width, 24))), { dim: true }),
  ];
  if (summaries.length === 0) {
    out.push(line(clip('no tasks yet', width), { dim: true }));
    out.push(line(clip('describe a goal below', width), { dim: true }));
  }
  for (const summary of summaries) {
    const cursor = summary.taskId === selectedTaskId ? '▸' : ' ';
    const resultLabel = summary.result ?? summary.state;
    const left = `${cursor} ${idTail(summary.taskId)} ${KIND_LABEL[summary.kind]}`;
    const stateText = clip(resultLabel, Math.max(4, width - left.length - 1));
    const pad = ' '.repeat(Math.max(1, width - left.length - stateText.length));
    const color = summary.result ? RESULT_COLOR[summary.result] : STATE_COLOR[summary.state];
    out.push(
      line(clip(`${left}${pad}${stateText}`, width), {
        color: summary.taskId === selectedTaskId ? color : undefined,
        bold: summary.taskId === selectedTaskId,
      })
    );
  }
  const focus = summaries.find((s) => s.taskId === focusTaskId);
  if (focus && focus.taskId !== selectedTaskId) {
    out.push(line(clip(`● live: ${idTail(focus.taskId)}`, width), { color: 'cyan', dim: true }));
  }
  out.push(line('', {}));
  out.push(line(clip('↑↓ select · ↵ switch', width), { dim: true }));
  while (out.length < height) out.push(line('', {}));
  return out.slice(0, height);
}

// ---- Task Execution Canvas (center) ----

export interface CanvasInput {
  detail?: TaskDetail;
  summaries: TaskSummary[];
  selectedTaskId?: string;
  width: number;
  height: number;
  detailExpanded: boolean;
  /** Real workspace facts for the empty state (product register: empty
   * states teach the interface and show live truth, not "nothing here"). */
  workspace?: {
    device?: string;
    tasks: number;
    evidence: number;
    acceptance: number;
  };
}

/** Empty-state examples — pressing 1/2/3 loads one into the composer. */
export const EMPTY_STATE_EXAMPLES: string[] = [
  'Stream the camera at 30 fps and verify the pipeline on the device',
  'Deploy bin/fps_probe to the device and prove it is running',
  'Bring up the ros2 demo nodes and check the topic rate',
];

interface CanvasSection {
  priority: number;
  lines: PanelLine[];
}

export function renderCanvas(input: CanvasInput): PanelLine[] {
  const { detail, width, height } = input;
  const out: PanelLine[] = [];

  if (!detail) {
    const ws = input.workspace;
    const empty: PanelLine[] = [
      ...wrap(
        'Describe a goal below — moss turns it into a task with acceptance criteria, executes it, and verifies with evidence.',
        width
      ).map((text) => line(text)),
      line(''),
      line('TRY — press 1 / 2 / 3 to load an example, edit, Enter', { bold: true }),
      ...EMPTY_STATE_EXAMPLES.map((example, i) =>
        line(clip(`  ${i + 1}  ${example}`, width), { color: 'cyan' })
      ),
      line(''),
      line('WORKSPACE', { bold: true }),
      line(clip(`  device   ${ws?.device ?? 'checking…'}`, width), {
        dim: (ws?.device ?? '').startsWith('not configured'),
        color: (ws?.device ?? '').startsWith('not configured') ? 'yellow' : undefined,
      }),
      line(
        clip(
          `  history  ${ws ? `${ws.tasks} task${ws.tasks === 1 ? '' : 's'} · ${ws.evidence} evidence · ${ws.acceptance} acceptance` : '…'}`,
          width
        ),
        { dim: true }
      ),
      line(''),
      ...wrap('One intent → one task → one verified result.', width).map((text) =>
        line(text, { color: 'cyan' })
      ),
      line(clip('Ctrl+T tasks · Ctrl+E evidence · Ctrl+A menu · Ctrl+O transcript', width), {
        dim: true,
      }),
    ];
    out.push(...empty);
    while (out.length < height) out.push(line(''));
    return out.slice(0, height);
  }

  const summary = detail.summary;
  const head = `▸ ${summary.taskId} · ${KIND_LABEL[summary.kind]}`;
  const stateText = summary.result ?? summary.state;
  const headPad = ' '.repeat(Math.max(1, width - head.length - stateText.length));
  out.push(
    line(clip(`${head}${headPad}${stateText}`, width), {
      bold: true,
      color: summary.result ? RESULT_COLOR[summary.result] : STATE_COLOR[summary.state],
    })
  );

  const sections: CanvasSection[] = [];

  sections.push({
    priority: 1,
    lines: [
      line('GOAL', { bold: true, color: 'white' }),
      ...wrap(detail.goal, width, 2).map((text) => line(text)),
    ],
  });

  if (detail.constraints?.length) {
    sections.push({
      priority: 9,
      lines: [
        line('CONSTRAINTS', { bold: true, color: 'white' }),
        ...detail.constraints.slice(0, 3).map((c) => line(clip(`  · ${c}`, width), { dim: true })),
      ],
    });
  }

  if (detail.plan.length > 0) {
    sections.push({
      priority: 6,
      lines: [
        line('PLAN', { bold: true, color: 'white' }),
        ...detail.plan.slice(0, 5).map((step, i) => line(clip(`  ${i + 1}. ${step}`, width))),
      ],
    });
  }

  if (detail.currentAction) {
    sections.push({
      priority: 2,
      lines: [line(clip(`NOW ▌ ${detail.currentAction}`, width), { color: 'cyan' })],
    });
  }

  if (detail.progress.length > 0) {
    const met = detail.progress.filter((p) => p.result === 'pass').length;
    sections.push({
      priority: 3,
      lines: [
        line(`PROGRESS  ${met}/${detail.progress.length} criteria met`, {
          bold: true,
          color: 'white',
        }),
        ...detail.progress.slice(0, 6).map((c) => {
          const icon = c.result === 'pass' ? '✓' : c.result === 'fail' ? '✗' : '·';
          const observed = c.observed !== undefined ? `  observed ${c.observed}` : '  no evidence';
          return line(clip(`  ${icon} ${c.metric} ${c.expected}${observed}`, width), {
            color: c.result === 'pass' ? 'green' : c.result === 'fail' ? 'red' : 'gray',
          });
        }),
      ],
    });
  }

  if (detail.failure) {
    sections.push({
      priority: 4,
      lines: [
        line(`FAILURE / DIAGNOSIS — ${detail.failure.headline}`, {
          bold: true,
          color: 'red',
        }),
        ...detail.failure.items
          .slice(0, 3)
          .flatMap((item) => [
            line(clip(`  ✗ ${item.label}`, width), { color: 'red' }),
            ...(item.detail ? [line(clip(`    ℹ ${item.detail}`, width), { dim: true })] : []),
          ]),
      ],
    });
  }

  if (detail.repair.length > 0) {
    sections.push({
      priority: 7,
      lines: [
        line('REPAIR', { bold: true, color: 'white' }),
        ...detail.repair.slice(0, 3).map((cycle) => {
          const resolution =
            cycle.resolvedTo !== undefined
              ? ` → ${cycle.resolvedTo.toUpperCase()}`
              : ' → in flight';
          return line(
            clip(
              `  ↺ ${fmtTime(cycle.at)} ${cycle.unmetRequired} unmet · ${cycle.reMeasurements} re-measure${cycle.reMeasurements === 1 ? '' : 's'} · ${cycle.reDeployments} redeploy${cycle.reDeployments === 1 ? '' : 's'}${resolution}`,
              width
            ),
            { color: cycle.resolvedTo === 'pass' ? 'green' : 'yellow' }
          );
        }),
      ],
    });
  }

  if (detail.verification.length > 0) {
    sections.push({
      priority: 8,
      lines: [
        line('VERIFICATION', { bold: true, color: 'white' }),
        ...detail.verification.slice(0, 3).map((record) =>
          line(
            clip(
              `  ${record.result === 'pass' ? '✓' : record.result === 'fail' ? '✗' : '?'} ${record.metric} = ${record.observed ?? '?'} (${record.source}) ${fmtTime(record.timestamp)}`,
              width
            ),
            {
              color: record.result === 'pass' ? 'green' : record.result === 'fail' ? 'red' : 'gray',
            }
          )
        ),
      ],
    });
  }

  if (detail.acceptance) {
    const verdict = detail.acceptance;
    sections.push({
      priority: 5,
      lines: [
        line(
          clip(
            `ACCEPTANCE  ${verdict.verdict.toUpperCase()} at ${fmtTime(verdict.acceptedAt)} · ${verdict.criteriaResults.length - verdict.unmetRequired}/${verdict.criteriaResults.length} criteria · ${verdict.evidenceConsidered} evidence`,
            width
          ),
          {
            bold: true,
            color:
              verdict.verdict === 'pass' ? 'green' : verdict.verdict === 'fail' ? 'red' : 'yellow',
          }
        ),
      ],
    });
  }

  const sorted = [...sections].sort((a, b) => a.priority - b.priority);
  const budget = height - out.length - 2; // reserve truncation notice + detail teaser
  const taken: PanelLine[] = [];
  let used = 0;
  let truncated = false;
  if (budget > 0) {
    for (const section of sorted) {
      if (used + section.lines.length <= budget) {
        taken.push(...section.lines, line('', {}));
        used += section.lines.length + 1;
      } else if (used < budget) {
        truncated = true;
        const remaining = budget - used - 1;
        if (remaining > 0) {
          taken.push(...section.lines.slice(0, remaining), line('', {}));
          used += remaining + 1;
        }
      } else {
        truncated = true;
      }
    }
  }
  out.push(...taken);
  if (truncated) {
    out.push(line(clip('… more sections available on a taller terminal', width), { dim: true }));
  }
  out.push(
    line(
      clip(
        input.detailExpanded
          ? '── execution detail (Ctrl+O to collapse) ──'
          : '── execution detail: transcript + tool calls (Ctrl+O) ──',
        width
      ),
      { dim: true }
    )
  );
  while (out.length < height) out.push(line('', {}));
  return out.slice(0, height);
}

export function renderTaskStrip(summaries: TaskSummary[], width: number): PanelLine {
  if (summaries.length === 0) {
    return line(clip('TASKS: none yet', width), { bold: true });
  }
  const chips = summaries.slice(0, 6).map((summary) => {
    const label = summary.result ?? summary.state;
    return `[${idTail(summary.taskId, 4)} ${label}]`;
  });
  const text = chips.join(' ');
  return line(clip(`TASKS ${text}`, width), { bold: true });
}

// ---- Contextual Device + Verification panel (right) ----

const KIND_METRIC_HINT: Record<TaskKind, string> = {
  camera: 'Camera / FPS / Pipeline',
  ros: 'Nodes / Topics / Runtime',
  model: 'Model / Latency / Memory / FPS',
  navigation: 'Position / Velocity / Goal / Safety',
  general: 'Device / Task',
};

const KIND_METRIC_PATTERN: Record<TaskKind, RegExp | undefined> = {
  camera: /fps|frame|camera|pipeline|exposure|rgb|isp/i,
  ros: /topic|node|hz|ros|launch|service/i,
  model: /latency|fps|mem|bpu|model|infer|quant/i,
  navigation: /position|velocity|goal|odom|error|safety|slam/i,
  general: undefined,
};

export interface ContextPanelInput {
  detail?: TaskDetail;
  width: number;
  height: number;
}

export function renderContextPanel(input: ContextPanelInput): PanelLine[] {
  const { detail, width, height } = input;
  const out: PanelLine[] = [];

  if (!detail) {
    out.push(line(clip('DEVICE + VERIFICATION', width), { bold: true }));
    out.push(line(clip('no task selected', width), { dim: true }));
    while (out.length < height) out.push(line(''));
    return out.slice(0, height);
  }

  out.push(line(clip(`CONTEXT · ${KIND_LABEL[detail.summary.kind]}`, width), { bold: true }));
  out.push(line(clip(KIND_METRIC_HINT[detail.summary.kind], width), { dim: true }));
  out.push(line('─'.repeat(Math.max(3, Math.min(width, 20))), { dim: true }));

  if (detail.device) {
    out.push(line(clip(`DEVICE  ${detail.device.deviceId}`, width), { bold: true }));
    if (detail.device.observations.length > 0) {
      for (const observation of detail.device.observations.slice(-4)) {
        out.push(
          line(clip(`  ${fmtTime(observation.at)} ${observation.preview}`, width), { dim: true })
        );
      }
    } else {
      out.push(line(clip('  no live observations yet', width), { dim: true }));
    }
    out.push(line('', {}));
  }

  const pattern = KIND_METRIC_PATTERN[detail.summary.kind];
  const metrics = new Map<string, EvidenceRecord>();
  for (const record of detail.verification) {
    if (pattern && !pattern.test(record.metric)) continue;
    if (!metrics.has(record.metric)) metrics.set(record.metric, record);
  }
  if (metrics.size > 0) {
    out.push(line(clip('METRICS', width), { bold: true }));
    for (const [metric, record] of metrics) {
      const icon = record.result === 'pass' ? '✓' : record.result === 'fail' ? '✗' : '?';
      out.push(
        line(clip(`  ${icon} ${metric} = ${record.observed ?? '?'}`, width), {
          color: record.result === 'pass' ? 'green' : record.result === 'fail' ? 'red' : 'gray',
        })
      );
    }
    out.push(line('', {}));
  }

  if (detail.verification.length > 0) {
    out.push(line(clip('VERIFICATION', width), { bold: true }));
    for (const record of detail.verification.slice(0, 4)) {
      out.push(
        line(
          clip(
            `  ${record.result === 'pass' ? '✓' : record.result === 'fail' ? '✗' : '?'} ${record.metric} ${fmtTime(record.timestamp)}`,
            width
          ),
          {
            color: record.result === 'pass' ? 'green' : record.result === 'fail' ? 'red' : 'gray',
          }
        )
      );
    }
    out.push(line('', {}));
  }

  if (detail.device?.deployments.length) {
    out.push(line(clip('DEPLOYMENTS', width), { bold: true }));
    for (const deployment of detail.device.deployments.slice(0, 4)) {
      out.push(
        line(
          clip(
            `  ${deployment.status === 'running' ? '●' : deployment.status === 'failed' ? '✗' : '○'} ${idTail(deployment.deploymentId, 4)} ${deployment.remotePath.split('/').pop() ?? ''} ${deployment.status}`,
            width
          ),
          {
            color:
              deployment.status === 'failed'
                ? 'red'
                : deployment.status === 'running'
                  ? 'green'
                  : 'gray',
          }
        )
      );
    }
  }

  if (detail.failure) {
    out.push(line('', {}));
    out.push(
      line(clip(`FAILURES (${detail.failure.items.length})`, width), { bold: true, color: 'red' })
    );
    out.push(line(clip('  Ctrl+F for failure / repair view', width), { dim: true }));
  }

  while (out.length < height) out.push(line(''));
  return out.slice(0, height);
}

// ---- Status + composer (bottom) ----

export interface ComposerStatusInput {
  model?: string;
  live: { running: boolean; approvalPending: boolean };
  taskSummary?: TaskSummary;
  queueLength: number;
  queuePaused: boolean;
  usageText: string;
  width: number;
}

export function renderStatusLine(input: ComposerStatusInput): PanelLine {
  const bits: string[] = [];
  if (input.model) bits.push(input.model);
  if (input.taskSummary) {
    bits.push(`${idTail(input.taskSummary.taskId)} ${KIND_LABEL[input.taskSummary.kind]}`);
    bits.push(input.taskSummary.result ?? input.taskSummary.state);
  } else {
    bits.push(input.live.running ? 'RUNNING' : 'READY');
  }
  if (input.queueLength > 0)
    bits.push(`queue:${input.queueLength}${input.queuePaused ? ' paused' : ''}`);
  bits.push(input.usageText);
  return line(clip(bits.join(' · '), input.width), {
    color: input.live.running ? 'yellow' : 'green',
  });
}

export function renderApprovalBanner(question: string, width: number): PanelLine[] {
  return [
    line(clip('APPROVAL NEEDED — reply y (once) / a (session) / n (deny)', width), {
      bold: true,
      color: 'magenta',
    }),
    ...wrap(question, width, 2)
      .slice(0, 2)
      .map((text) => line(text, { color: 'magenta' })),
  ];
}

export function renderInputLine(input: string, width: number, placeholder: boolean): PanelLine[] {
  const prompt = placeholder ? '› goal: describe what the robot should do…' : `› ${input}▌`;
  return [line(clip(prompt, width), { color: 'cyan' })];
}

// ---- Execution detail (transcript, demoted) ----

export interface DetailTeaserInput {
  toolLine?: string;
  streamingText: string;
  width: number;
  maxLines: number;
}

export function renderExecutionDetailTail(input: DetailTeaserInput): PanelLine[] {
  const out: PanelLine[] = [];
  if (input.streamingText.trim()) {
    out.push(
      ...wrap(input.streamingText.trim(), input.width)
        .slice(-2)
        .map((text) => line(text, { dim: true }))
    );
  }
  if (input.toolLine) {
    out.push(line(clip(`  ${input.toolLine}`, input.width), { dim: true }));
  }
  return out.slice(-input.maxLines);
}
