import { useCallback, useEffect, useState } from 'react';
import { api } from './api-client.js';
import { Button, Code, Tabs } from './design-system.js';
import { PluginSlot } from './plugin-slot.js';
import type {
  BootstrapResponse,
  GoalSnapshot,
  ExecutionView,
  JobSnapshot,
  RunSnapshot,
  TimelineItem,
  TodoSnapshot,
  WebContribution,
  WorkflowSnapshot,
} from './workbench-types.js';

type DetailTab = 'overview' | 'plan' | 'activity' | 'evidence';
const safeList = <T,>(value: unknown, key: string): T[] =>
  typeof value === 'object' &&
  value !== null &&
  Array.isArray((value as Record<string, unknown>)[key])
    ? ((value as Record<string, T[]>)[key] ?? [])
    : [];

function hasCurrentCriterionEvidence(
  execution: ExecutionView,
  nodeId: string,
  criterion: { readonly id: string; readonly description: string },
  revision: number
): boolean {
  return execution.evidence.some((evidence) => {
    if (evidence.nodeId && evidence.nodeId !== nodeId) return false;
    const evidenceCriterion = evidence.metadata?.criterion;
    if (evidenceCriterion !== criterion.id && evidenceCriterion !== criterion.description) {
      return false;
    }
    const evidenceRevision = evidence.metadata?.contractRevision;
    return evidenceRevision === revision || (evidenceRevision === undefined && revision === 1);
  });
}

export const DetailsPanel = ({
  sessionId,
  run,
  selectedTool,
  bootstrap,
  contributions,
  initialTab,
  preferredExecutionId,
  onExecution,
  onTab,
  onClose,
}: {
  sessionId?: string;
  run?: RunSnapshot;
  selectedTool?: Extract<TimelineItem, { kind: 'tool' }>;
  bootstrap: BootstrapResponse | null;
  contributions: WebContribution[];
  initialTab: string;
  preferredExecutionId?: string;
  onExecution(value?: string): void;
  onTab(value: string): void;
  onClose(): void;
}) => {
  const [tab, setTab] = useState<DetailTab>(
    (['overview', 'plan', 'activity', 'evidence'].includes(initialTab)
      ? initialTab
      : 'overview') as DetailTab
  );
  const [goal, setGoal] = useState<GoalSnapshot>({});
  const [todos, setTodos] = useState<TodoSnapshot[]>([]);
  const [jobs, setJobs] = useState<JobSnapshot[]>([]);
  const [executions, setExecutions] = useState<ExecutionView[]>([]);
  const [executionState, setExecutionState] = useState<'idle' | 'loading' | 'ready' | 'error'>(
    'idle'
  );
  const [workflows, setWorkflows] = useState<WorkflowSnapshot[]>([]);
  const [trajectory, setTrajectory] = useState<unknown>();
  const [verdict, setVerdict] = useState<unknown>();
  const loadExecutions = useCallback(async () => {
    if (!sessionId) return;
    setExecutionState('loading');
    try {
      const response = await api.executions(sessionId);
      const next = safeList<ExecutionView>(response, 'executions');
      setExecutions(next);
      onExecution(
        next.find((execution) => execution.graphId === preferredExecutionId)?.graphId ??
          next[0]?.graphId
      );
      setExecutionState('ready');
    } catch {
      setExecutionState('error');
    }
  }, [onExecution, preferredExecutionId, sessionId]);
  const controlExecution = useCallback(
    async (execution: ExecutionView, type: 'resume' | 'retry' | 'stop', nodeId?: string) => {
      setExecutionState('loading');
      try {
        await api.executeAction(execution.graphId, execution.revision, {
          type,
          ...(nodeId ? { nodeId } : {}),
        });
        await loadExecutions();
      } catch {
        setExecutionState('error');
      }
    },
    [loadExecutions]
  );
  useEffect(() => {
    if (!sessionId) return;
    void loadExecutions();
    void Promise.all([api.goal(sessionId), api.todos(sessionId), api.jobs(), api.workflows()])
      .then(([nextGoal, nextTodos, nextJobs, nextWorkflows]) => {
        setGoal(nextGoal.goal ?? {});
        setTodos(safeList<TodoSnapshot>(nextTodos, 'todos'));
        setJobs(safeList<JobSnapshot>(nextJobs, 'jobs'));
        setWorkflows(safeList<WorkflowSnapshot>(nextWorkflows, 'workflows'));
      })
      .catch(() => {});
  }, [loadExecutions, sessionId]);
  useEffect(() => {
    if (!run?.id) return;
    void Promise.all([api.trajectory(run.id), api.verdict(run.id)])
      .then(([nextTrajectory, nextVerdict]) => {
        setTrajectory(nextTrajectory);
        setVerdict(nextVerdict);
      })
      .catch(() => {});
  }, [run?.id]);
  const setActiveTab = (value: DetailTab) => {
    setTab(value);
    onTab(value);
  };
  return (
    <aside className="details-panel">
      <header>
        <div>
          <p className="overline">TASK DETAILS</p>
          <h2>{selectedTool ? 'Tool call' : 'Runtime'}</h2>
        </div>
        <Button variant="ghost" size="small" onClick={onClose} aria-label="Close details">
          ×
        </Button>
      </header>
      {selectedTool ? (
        <div className="detail-content">
          <PluginSlot
            slot="tool.details"
            contributions={contributions}
            owner={{ kind: 'tool', id: selectedTool.id, data: selectedTool }}
          />
          <div className={`detail-status status-${selectedTool.state}`}>
            <span />
            {selectedTool.state}
          </div>
          <h3>{selectedTool.name}</h3>
          <div className="detail-label">Input</div>
          <Code language="json">{JSON.stringify(selectedTool.input ?? {}, null, 2)}</Code>
          <div className="detail-label">Result</div>
          <Code>
            {typeof selectedTool.result === 'string'
              ? selectedTool.result
              : JSON.stringify(selectedTool.result ?? {}, null, 2)}
          </Code>
        </div>
      ) : (
        <>
          <Tabs
            value={tab}
            options={[
              { value: 'overview', label: 'Overview' },
              { value: 'plan', label: 'Plan' },
              { value: 'activity', label: 'Activity' },
              { value: 'evidence', label: 'Evidence' },
            ]}
            onChange={setActiveTab}
            ariaLabel="Task details"
          />
          <div
            className="detail-content"
            id={`moss-panel-${tab}`}
            role="tabpanel"
            aria-labelledby={`moss-tab-${tab}`}
          >
            <PluginSlot
              slot="conversation.details"
              contributions={contributions}
              owner={{ kind: 'session', id: sessionId ?? 'new' }}
            />
            {tab === 'overview' && (
              <>
                <section>
                  <div className="detail-label">Model</div>
                  <strong>{bootstrap?.model ?? 'Connecting…'}</strong>
                </section>
                <section>
                  <div className="detail-label">Goal</div>
                  <strong>{goal.objective ?? 'No active goal'}</strong>
                  <small>{goal.status}</small>
                  {sessionId && (
                    <div className="goal-actions">
                      <Button
                        size="small"
                        onClick={() =>
                          void api.updateGoal(sessionId, {
                            action: goal.status === 'paused' ? 'resume' : 'pause',
                          })
                        }
                      >
                        {goal.status === 'paused' ? 'Resume Goal' : 'Pause Goal'}
                      </Button>
                    </div>
                  )}
                </section>
                <section>
                  <div className="detail-label">Todo</div>
                  {todos.length ? (
                    todos.map((todo, index) => (
                      <div className="todo-row" key={todo.id ?? index}>
                        <span>{todo.status === 'completed' ? '✓' : '○'}</span>
                        {todo.text ?? todo.title ?? 'Todo'}
                      </div>
                    ))
                  ) : (
                    <p>No Todo items.</p>
                  )}
                </section>
              </>
            )}
            {tab === 'plan' && (
              <>
                <section>
                  <div className="detail-label">Delivery Case</div>
                  {executionState === 'loading' ? (
                    <p aria-live="polite">Loading execution…</p>
                  ) : null}
                  {executionState === 'error' ? (
                    <div className="detail-load-state" role="alert">
                      <p>Execution state could not be loaded.</p>
                      <Button size="small" onClick={() => void loadExecutions()}>
                        Retry loading
                      </Button>
                    </div>
                  ) : null}
                  {executionState === 'ready' && executions.length
                    ? executions.map((execution) => (
                        <div className="detail-list-row execution-card" key={execution.graphId}>
                          <strong>{execution.goal}</strong>
                          <small>
                            {execution.deliveryCase
                              ? `${execution.deliveryCase.stage} · ${execution.deliveryCase.riskLevel} risk · ${execution.deliveryCase.depth}`
                              : execution.status}{' '}
                            · revision {execution.revision} ·{' '}
                            {execution.nodes.filter((node) => node.status === 'succeeded').length}/
                            {execution.nodes.length} nodes
                          </small>
                          {execution.status === 'paused' ||
                          execution.status === 'paused_recovered' ? (
                            <button onClick={() => void controlExecution(execution, 'resume')}>
                              Resume
                            </button>
                          ) : null}
                          {['ready', 'running', 'blocked'].includes(execution.status) ? (
                            <button onClick={() => void controlExecution(execution, 'stop')}>
                              Stop
                            </button>
                          ) : null}
                          {execution.nodes
                            .filter((node) =>
                              ['failed', 'interrupted', 'blocked', 'merge_conflict'].includes(
                                node.status
                              )
                            )
                            .map((node) => (
                              <button
                                key={`retry-${node.id}`}
                                onClick={() => void controlExecution(execution, 'retry', node.id)}
                              >
                                Retry {node.id}
                              </button>
                            ))}
                          <div className="detail-label">Task DAG</div>
                          {execution.nodes.map((node) => (
                            <div className="execution-node" key={node.id}>
                              <span className={`status-${node.status}`} />
                              <div>
                                <strong>{node.title}</strong>
                                <small>
                                  {node.kind} · {node.status}
                                  {node.roleId ? ` · ${node.roleId}` : ''}
                                  {node.dependencies.length
                                    ? ` · after ${node.dependencies.join(', ')}`
                                    : ''}
                                </small>
                              </div>
                            </div>
                          ))}
                          <div className="detail-label">Acceptance criteria</div>
                          {execution.nodes.flatMap((node) =>
                            (node.acceptanceContract?.criteria ?? []).map((criterion) => (
                              <div className="acceptance-row" key={`${node.id}-${criterion.id}`}>
                                <span>
                                  {hasCurrentCriterionEvidence(
                                    execution,
                                    node.id,
                                    criterion,
                                    node.acceptanceContract?.revision ?? 1
                                  )
                                    ? '✓'
                                    : '○'}
                                </span>
                                <span>{criterion.description}</span>
                              </div>
                            ))
                          )}
                          <div className="detail-label">Whole-change review</div>
                          {execution.reviews.filter((review) => review.scope === 'whole_change')
                            .length ? (
                            execution.reviews
                              .filter((review) => review.scope === 'whole_change')
                              .map((review) => (
                                <p key={`${review.scope}-${review.round}`}>
                                  Round {review.round}: {review.verdict} · {review.roleId}
                                </p>
                              ))
                          ) : (
                            <p>Awaiting independent review.</p>
                          )}
                          {execution.completionReport ? (
                            <div className="completion-report">
                              <div className="detail-label">Completion Report</div>
                              <p>{execution.completionReport.summary}</p>
                            </div>
                          ) : null}
                        </div>
                      ))
                    : null}
                  {executionState === 'ready' && !executions.length ? (
                    <p>No Delivery Case exists for this session.</p>
                  ) : null}
                </section>
                <section>
                  <div className="detail-label">Queue / Steering</div>
                  <p>
                    Queued prompts wait for the current turn. Steering is delivered at the next safe
                    boundary.
                  </p>
                </section>
                <section>
                  <div className="detail-label">Workflow Runs</div>
                  {workflows.map((workflow) => (
                    <div className="detail-list-row" key={workflow.id}>
                      <strong>{workflow.title ?? workflow.id}</strong>
                      <small>{workflow.status}</small>
                      {sessionId && (
                        <button onClick={() => void api.runWorkflow(workflow.id, sessionId)}>
                          Run
                        </button>
                      )}
                    </div>
                  ))}
                </section>
              </>
            )}
            {tab === 'activity' && (
              <>
                <section>
                  <div className="detail-label">Background Jobs</div>
                  {jobs.length ? (
                    jobs.map((job) => (
                      <div className="detail-list-row" key={job.id}>
                        <strong>{job.title ?? job.id}</strong>
                        <small>{job.status}</small>
                        {job.status === 'running' && (
                          <button onClick={() => void api.stopJob(job.id)}>Stop</button>
                        )}
                      </div>
                    ))
                  ) : (
                    <p>No active Jobs.</p>
                  )}
                </section>
                <section>
                  <div className="detail-label">Trajectory</div>
                  <Code language="json">{JSON.stringify(trajectory ?? {}, null, 2)}</Code>
                </section>
              </>
            )}
            {tab === 'evidence' && (
              <>
                <section>
                  <div className="detail-label">Evidence</div>
                  <strong>{run?.evidenceCount ?? 0} recorded items</strong>
                  <p>{run?.verification ?? 'No verification summary yet.'}</p>
                </section>
                <section>
                  <div className="detail-label">Completion verdict</div>
                  <Code language="json">{JSON.stringify(verdict ?? {}, null, 2)}</Code>
                </section>
              </>
            )}
          </div>
        </>
      )}
    </aside>
  );
};
