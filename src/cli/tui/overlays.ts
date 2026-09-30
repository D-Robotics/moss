/**
 * Mission Control overlays — full-area views layered over the panel layout:
 * Task Switcher, Task History, Evidence Inspector, Deployment Inspector,
 * Action Menu, Failure/Repair View. Pure projections, no ink imports.
 */
import type { DeploymentRecord } from '../../contracts/deployment.js';
import type { EvidenceRecord } from '../../contracts/evidence.js';
import type { TaskDetail, TaskSummary } from '../../core/task-runtime/runtime.js';
import { clip, fmtTime, idTail, line, type PanelLine, wrap } from './panels.js';

export type OverlayKind =
  | 'task-switcher'
  | 'task-history'
  | 'evidence'
  | 'deployments'
  | 'action-menu'
  | 'failure-repair';

export const OVERLAY_TITLE: Record<OverlayKind, string> = {
  'task-switcher': 'TASK SWITCHER',
  'task-history': 'TASK HISTORY',
  evidence: 'EVIDENCE INSPECTOR',
  deployments: 'DEPLOYMENT INSPECTOR',
  'action-menu': 'ACTION MENU',
  'failure-repair': 'FAILURE / REPAIR',
};

function overlayShell(
  kind: OverlayKind,
  body: PanelLine[],
  width: number,
  height: number,
  footer: string
): PanelLine[] {
  const out: PanelLine[] = [];
  const title = OVERLAY_TITLE[kind];
  const dashes = Math.max(0, width - title.length - 5);
  out.push(line(clip(`── ${title} ${'─'.repeat(dashes)}`, width), { bold: true, color: 'cyan' }));
  out.push(...body);
  while (out.length < height - 1) out.push(line('', {}));
  out.push(line(clip(footer, width), { dim: true }));
  return out.slice(0, height);
}

export function renderTaskSwitcher(
  summaries: TaskSummary[],
  cursor: number,
  selectedTaskId: string | undefined,
  width: number,
  height: number
): PanelLine[] {
  const body: PanelLine[] = [];
  if (summaries.length === 0) {
    body.push(line('no tasks yet — describe a goal to create one', { dim: true }));
  }
  summaries.forEach((summary, index) => {
    const marker = index === cursor ? '▸' : summary.taskId === selectedTaskId ? '=' : ' ';
    const result = summary.result ?? summary.state;
    body.push(
      line(
        clip(
          `${marker} ${summary.taskId} ${summary.kind.toUpperCase().padEnd(10)} ${result}`,
          width
        ),
        {
          bold: index === cursor,
        }
      )
    );
    if (index === cursor) {
      body.push(
        ...wrap(summary.goal, width, 4)
          .slice(0, 2)
          .map((text) => line(text, { dim: true }))
      );
      body.push(
        line(
          clip(
            `    ${summary.criteriaMet}/${summary.criteriaTotal} criteria · updated ${fmtTime(summary.updatedAt)}`,
            width
          ),
          { dim: true }
        )
      );
    }
  });
  return overlayShell(
    'task-switcher',
    body,
    width,
    height,
    '↑↓ select · ↵ switch to task · r resume · Esc close'
  );
}

export function renderTaskHistory(
  detail: TaskDetail | undefined,
  width: number,
  height: number
): PanelLine[] {
  const body: PanelLine[] = [];
  if (!detail) {
    body.push(line('no task selected', { dim: true }));
  } else {
    body.push(
      ...wrap(detail.goal, width)
        .slice(0, 1)
        .map((text) => line(text, { dim: true }))
    );
    body.push(line('', {}));
    for (const entry of detail.history.slice(0, height - 6)) {
      const icon =
        entry.kind === 'acceptance'
          ? '◆'
          : entry.kind === 'evidence'
            ? '✓'
            : entry.kind === 'deployment'
              ? '↑'
              : '▸';
      body.push(line(clip(`${fmtTime(entry.at)} ${icon} ${entry.label}`, width)));
    }
  }
  return overlayShell('task-history', body, width, height, 'Esc close');
}

export function renderEvidenceInspector(
  records: EvidenceRecord[],
  cursor: number,
  width: number,
  height: number
): PanelLine[] {
  const body: PanelLine[] = [];
  if (records.length === 0) {
    body.push(line('no evidence recorded yet (record_evidence)', { dim: true }));
  }
  records.slice(0, height - 8).forEach((record, index) => {
    const marker = index === cursor ? '▸' : ' ';
    const task = record.taskId ? idTail(record.taskId) : '—';
    const observed = record.observed === undefined ? '?' : String(record.observed).slice(0, 20);
    body.push(
      line(
        clip(
          `${marker} ${fmtTime(record.timestamp)} ${task} ${record.metric} ${record.expected ?? ''} → ${observed} ${record.result.toUpperCase()}`,
          width
        ),
        {
          bold: index === cursor,
          color: record.result === 'pass' ? 'green' : record.result === 'fail' ? 'red' : 'gray',
        }
      )
    );
  });
  const selected = records[cursor];
  if (selected) {
    body.push(line('', {}));
    body.push(
      line(
        clip(
          `${selected.evidenceId} · ${selected.source}${selected.deviceId ? ` · ${selected.deviceId}` : ''}`,
          width
        ),
        { dim: true }
      )
    );
    if (selected.details) {
      body.push(
        ...wrap(selected.details, width, 2)
          .slice(0, 2)
          .map((text) => line(text, { dim: true }))
      );
    }
  }
  return overlayShell('evidence', body, width, height, '↑↓ select · Esc close');
}

export function renderDeploymentInspector(
  deployments: DeploymentRecord[],
  cursor: number,
  width: number,
  height: number
): PanelLine[] {
  const body: PanelLine[] = [];
  if (deployments.length === 0) {
    body.push(line('no deployments yet (device_deploy)', { dim: true }));
  }
  deployments.slice(0, height - 9).forEach((deployment, index) => {
    const marker = index === cursor ? '▸' : ' ';
    const failedStep = deployment.steps.find((step) => step.status === 'failed');
    const tail = failedStep ? ` ✗ ${failedStep.step}` : '';
    body.push(
      line(
        clip(
          `${marker} ${fmtTime(deployment.startedAt)} ${deployment.deviceId} ${deployment.remotePath.split('/').pop() ?? ''} ${deployment.status.toUpperCase()}${tail}`,
          width
        ),
        {
          bold: index === cursor,
          color:
            deployment.status === 'failed'
              ? 'red'
              : deployment.status === 'running'
                ? 'green'
                : 'gray',
        }
      )
    );
  });
  const selected = deployments[cursor];
  if (selected) {
    body.push(line('', {}));
    body.push(
      line(clip(`${selected.artifactPath} → ${selected.remotePath}`, width), { dim: true })
    );
    for (const step of selected.steps) {
      body.push(
        line(
          clip(
            `  ${step.status === 'ok' ? '✓' : step.status === 'failed' ? '✗' : '·'} ${step.step}${step.exitCode !== undefined && step.exitCode !== null ? ` (exit ${step.exitCode})` : ''}`,
            width
          ),
          {
            dim: true,
            color: step.status === 'failed' ? 'red' : undefined,
          }
        )
      );
    }
    if (selected.healthCheck) {
      body.push(
        line(
          clip(
            `  health: ${selected.healthCheck.passed ? 'PASS' : 'FAIL'} — ${selected.healthCheck.command}`,
            width
          ),
          { dim: true, color: selected.healthCheck.passed ? 'green' : 'red' }
        )
      );
    }
    if (selected.error) {
      body.push(
        ...wrap(selected.error, width, 2)
          .slice(0, 1)
          .map((text) => line(text, { color: 'red' }))
      );
    }
  }
  return overlayShell('deployments', body, width, height, '↑↓ select · Esc close');
}

export interface ActionMenuItem {
  id: string;
  label: string;
  hint?: string;
}

export function actionMenuItems(): ActionMenuItem[] {
  return [
    { id: 'new-task', label: 'New task — describe a goal' },
    { id: 'switch-task', label: 'Switch task', hint: 'Ctrl+T' },
    { id: 'task-history', label: 'Task history', hint: 'Ctrl+H' },
    { id: 'resume-task', label: 'Resume selected task' },
    { id: 'evidence', label: 'Evidence inspector', hint: 'Ctrl+E' },
    { id: 'deployments', label: 'Deployment inspector', hint: 'Ctrl+G' },
    { id: 'failure-repair', label: 'Failure / repair view', hint: 'Ctrl+F' },
    { id: 'execution-detail', label: 'Execution detail (transcript)', hint: 'Ctrl+O' },
    { id: 'sessions', label: 'Sessions' },
    { id: 'mcp', label: 'MCP servers' },
    { id: 'subs', label: 'Sub-agents' },
    { id: 'quit', label: 'Quit', hint: '/quit' },
  ];
}

export function renderActionMenu(cursor: number, width: number, height: number): PanelLine[] {
  const items = actionMenuItems();
  const body: PanelLine[] = [];
  items.forEach((item, index) => {
    const marker = index === cursor ? '▸' : ' ';
    const hint = item.hint ? `  (${item.hint})` : '';
    body.push(line(clip(`${marker} ${item.label}${hint}`, width), { bold: index === cursor }));
  });
  return overlayShell('action-menu', body, width, height, '↑↓ select · ↵ run · Esc close');
}

export function renderFailureRepair(
  detail: TaskDetail | undefined,
  width: number,
  height: number
): PanelLine[] {
  const body: PanelLine[] = [];
  if (!detail) {
    body.push(line('no task selected', { dim: true }));
  } else {
    body.push(
      ...wrap(`Task ${detail.summary.taskId}: ${detail.goal}`, width)
        .slice(0, 1)
        .map((text) => line(text, { dim: true }))
    );
    body.push(line('', {}));
    if (!detail.failure) {
      body.push(line('no failures on record for this task', { color: 'green' }));
    } else {
      body.push(line(`FAILURES (${detail.failure.items.length})`, { bold: true, color: 'red' }));
      for (const item of detail.failure.items.slice(0, 6)) {
        body.push(
          line(clip(`${fmtTime(item.at)} ✗ [${item.source}] ${item.label}`, width), {
            color: 'red',
          })
        );
        if (item.detail) {
          body.push(
            ...wrap(item.detail, width, 6)
              .slice(0, 1)
              .map((text) => line(text, { dim: true }))
          );
        }
      }
    }
    body.push(line('', {}));
    if (detail.repair.length === 0) {
      body.push(line('no repair cycles yet', { dim: true }));
    } else {
      body.push(line('REPAIR CYCLES', { bold: true }));
      for (const cycle of detail.repair.slice(0, 5)) {
        const resolution =
          cycle.resolvedTo === 'pass'
            ? '→ PASS'
            : cycle.resolvedTo
              ? `→ ${cycle.resolvedTo.toUpperCase()}`
              : '→ in flight';
        body.push(
          line(
            clip(
              `${fmtTime(cycle.at)} ↺ ${cycle.unmetRequired} unmet · ${cycle.reMeasurements} re-measurements · ${cycle.reDeployments} redeploys ${resolution}`,
              width
            ),
            { color: cycle.resolvedTo === 'pass' ? 'green' : 'yellow' }
          )
        );
      }
    }
    if (detail.acceptance) {
      body.push(line('', {}));
      body.push(
        line(
          clip(
            `latest acceptance: ${detail.acceptance.verdict.toUpperCase()} at ${fmtTime(detail.acceptance.acceptedAt)}`,
            width
          ),
          { bold: true }
        )
      );
    }
  }
  return overlayShell('failure-repair', body, width, height, 'Esc close');
}
