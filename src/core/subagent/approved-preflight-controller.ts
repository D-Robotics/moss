export type ApprovedPreflightStopResult =
  | 'cancel_requested'
  | 'queued'
  | 'already_cancelled'
  | 'already_terminal'
  | 'not_found';
export interface ApprovedPreflightStopDecision {
  outcome: ApprovedPreflightStopResult;
  state?: 'completed' | 'failed';
}

type AssignmentRuntimeState = 'queued' | 'running' | 'cancelled' | 'completed' | 'failed';

interface AssignmentRuntime {
  controller: AbortController;
  state: AssignmentRuntimeState;
}

/**
 * Per-MossAgent controller for host-approved preflight children.
 *
 * Stop requests may arrive just before the agent registers its approved
 * assignments, so pending requests are retained and applied at beginRun().
 */
export class ApprovedPreflightController {
  private readonly runs = new Map<string, Map<string, AssignmentRuntime>>();
  private readonly pendingStops = new Map<string, Set<string>>();
  private readonly finishedRuns = new Set<string>();

  beginRun(runId: string, assignmentIds: readonly string[]): void {
    this.finishedRuns.delete(runId);
    const requested = this.pendingStops.get(runId);
    const assignments = new Map<string, AssignmentRuntime>();
    for (const assignmentId of assignmentIds) {
      const controller = new AbortController();
      const cancelled = requested?.has(assignmentId) ?? false;
      if (cancelled) controller.abort();
      assignments.set(assignmentId, {
        controller,
        state: cancelled ? 'cancelled' : 'queued',
      });
    }
    this.runs.set(runId, assignments);
    this.pendingStops.delete(runId);
  }

  requestStop(runId: string, assignmentId: string): ApprovedPreflightStopDecision {
    if (this.finishedRuns.has(runId)) return { outcome: 'not_found' };
    const run = this.runs.get(runId);
    const assignment = run?.get(assignmentId);
    if (!assignment) {
      if (run) return { outcome: 'not_found' };
      let pending = this.pendingStops.get(runId);
      if (!pending) {
        pending = new Set();
        this.pendingStops.set(runId, pending);
      }
      if (pending.has(assignmentId)) return { outcome: 'already_cancelled' };
      pending.add(assignmentId);
      return { outcome: 'queued' };
    }
    if (assignment.state === 'cancelled') return { outcome: 'already_cancelled' };
    if (assignment.state === 'completed' || assignment.state === 'failed') {
      return { outcome: 'already_terminal', state: assignment.state };
    }
    assignment.state = 'cancelled';
    assignment.controller.abort();
    return { outcome: 'cancel_requested' };
  }

  signalFor(runId: string, assignmentId: string): AbortSignal | undefined {
    return this.runs.get(runId)?.get(assignmentId)?.controller.signal;
  }

  markRunning(runId: string, assignmentId: string): boolean {
    const assignment = this.runs.get(runId)?.get(assignmentId);
    if (!assignment || assignment.state === 'cancelled') return false;
    if (assignment.state === 'completed' || assignment.state === 'failed') return false;
    assignment.state = 'running';
    return true;
  }

  markTerminal(runId: string, assignmentId: string, state: 'completed' | 'failed'): void {
    const assignment = this.runs.get(runId)?.get(assignmentId);
    if (!assignment || assignment.state === 'cancelled') return;
    assignment.state = state;
  }

  isCancelled(runId: string, assignmentId: string): boolean {
    return this.runs.get(runId)?.get(assignmentId)?.state === 'cancelled';
  }

  finishRun(runId: string): void {
    this.runs.delete(runId);
    this.pendingStops.delete(runId);
    this.finishedRuns.add(runId);
  }

  releaseRun(runId: string): void {
    this.runs.delete(runId);
    this.pendingStops.delete(runId);
    this.finishedRuns.delete(runId);
  }
}
