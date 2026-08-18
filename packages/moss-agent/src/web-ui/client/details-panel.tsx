import { useCallback, useEffect, useState } from 'react';
import { api } from './api-client.js';
import { Button, Code, Input, Tabs } from './design-system.js';
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
  onStartExecution,
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
  onStartExecution(execution: ExecutionView): void;
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
  const [elaborationAnswers, setElaborationAnswers] = useState<Record<string, string>>({});
  const [workspacePath, setWorkspacePath] = useState('.');
  const [workspaceEntries, setWorkspaceEntries] = useState<
    Array<{ name: string; path: string; kind: 'directory' | 'file' | 'other' }>
  >([]);
  const [workspacePreview, setWorkspacePreview] = useState<{
    path: string;
    content: string;
  }>();
  const [workspaceChanges, setWorkspaceChanges] = useState('');
  const [workspaceState, setWorkspaceState] = useState<'loading' | 'ready' | 'error'>('loading');
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
  const deliveryAction = useCallback(
    async (execution: ExecutionView, action: Record<string, unknown>) => {
      setExecutionState('loading');
      try {
        const result = await api.executeAction(execution.graphId, execution.revision, action);
        setExecutions((current) =>
          current.map((item) =>
            item.graphId === result.execution.graphId ? result.execution : item
          )
        );
        setExecutionState('ready');
        return result.execution;
      } catch {
        setExecutionState('error');
        return undefined;
      }
    },
    []
  );
  const submitElaboration = useCallback(
    async (execution: ExecutionView) => {
      const round = execution.deliveryCase?.elaborationRounds.at(-1);
      if (!round) return;
      const answered = await deliveryAction(execution, {
        type: 'answer_elaboration',
        roundId: round.id,
        answers: Object.fromEntries(
          round.questions.map((question) => [
            question.id,
            elaborationAnswers[`${execution.graphId}:${question.id}`] ?? question.answer ?? '',
          ])
        ),
      });
      if (answered?.deliveryCase?.elaborationRounds.at(-1)?.resolved) {
        await deliveryAction(answered, { type: 'prepare_proposal' });
      }
    },
    [deliveryAction, elaborationAnswers]
  );
  const loadWorkspace = useCallback(async (relativePath = '.') => {
    setWorkspaceState('loading');
    try {
      const [tree, changes] = await Promise.all([
        api.workspaceTree(relativePath),
        api.workspaceChanges(),
      ]);
      setWorkspacePath(tree.path);
      setWorkspaceEntries(tree.entries);
      setWorkspaceChanges([changes.status, changes.diffStat].filter(Boolean).join('\n'));
      setWorkspaceState('ready');
    } catch {
      setWorkspaceState('error');
    }
  }, []);
  const previewWorkspaceFile = useCallback(async (relativePath: string) => {
    try {
      setWorkspacePreview(await api.workspaceFile(relativePath));
    } catch {
      setWorkspaceState('error');
    }
  }, []);
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
  }, [loadExecutions, run?.id, sessionId]);
  useEffect(() => {
    if (!run?.id) return;
    void Promise.all([api.trajectory(run.id), api.verdict(run.id)])
      .then(([nextTrajectory, nextVerdict]) => {
        setTrajectory(nextTrajectory);
        setVerdict(nextVerdict);
      })
      .catch(() => {});
  }, [run?.id]);
  useEffect(() => {
    if (tab !== 'overview') return;
    void loadWorkspace();
  }, [loadWorkspace, tab]);
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
                  <div className="detail-label">Workspace preview</div>
                  <small>{workspacePath}</small>
                  {workspaceState === 'loading' ? <p>Loading workspace…</p> : null}
                  {workspaceState === 'error' ? (
                    <div className="detail-load-state" role="alert">
                      <p>Workspace preview is unavailable.</p>
                      <Button size="small" onClick={() => void loadWorkspace(workspacePath)}>
                        Retry
                      </Button>
                    </div>
                  ) : null}
                  {workspaceState === 'ready'
                    ? workspaceEntries.map((entry) => (
                        <button
                          className="workspace-entry"
                          key={entry.path}
                          onClick={() => {
                            if (entry.kind === 'directory') {
                              setWorkspacePreview(undefined);
                              void loadWorkspace(entry.path);
                            } else if (entry.kind === 'file') {
                              void previewWorkspaceFile(entry.path);
                            }
                          }}
                        >
                          {entry.kind === 'directory' ? '▸' : '·'} {entry.name}
                        </button>
                      ))
                    : null}
                  {workspacePreview ? (
                    <Code language={workspacePreview.path.split('.').at(-1)}>
                      {workspacePreview.content}
                    </Code>
                  ) : null}
                  <div className="detail-label">Changes</div>
                  <Code>{workspaceChanges || 'No working-tree changes.'}</Code>
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
                              ? `${execution.deliveryCase.stage} · ${execution.deliveryCase.riskLevel} risk · ${execution.deliveryCase.depth} · case r${execution.deliveryCase.revision}`
                              : execution.status}{' '}
                            · revision {execution.revision} ·{' '}
                            {execution.nodes.filter((node) => node.status === 'succeeded').length}/
                            {execution.nodes.length} nodes
                          </small>
                          {execution.deliveryCase?.stage === 'elaborating' ? (
                            <div className="delivery-elaboration">
                              <div className="detail-label">Clarification</div>
                              {execution.deliveryCase.elaborationRounds
                                .at(-1)
                                ?.questions.map((question) => {
                                  const key = `${execution.graphId}:${question.id}`;
                                  const storedAnswer = Array.isArray(question.answer)
                                    ? question.answer.join(', ')
                                    : question.answer;
                                  return (
                                    <Input
                                      key={question.id}
                                      label={question.prompt}
                                      hint={
                                        question.options.length
                                          ? `Options: ${question.options.join(' · ')}`
                                          : undefined
                                      }
                                      value={elaborationAnswers[key] ?? storedAnswer ?? ''}
                                      required={question.required !== false}
                                      onChange={(event) =>
                                        setElaborationAnswers((current) => ({
                                          ...current,
                                          [key]: event.target.value,
                                        }))
                                      }
                                    />
                                  );
                                })}
                              <Button
                                size="small"
                                variant="primary"
                                onClick={() => void submitElaboration(execution)}
                              >
                                Submit clarification
                              </Button>
                            </div>
                          ) : null}
                          {execution.deliveryCase?.proposal ? (
                            <div className="delivery-proposal">
                              <div className="detail-label">
                                Proposal revision {execution.deliveryCase.proposal.revision}
                              </div>
                              <p>{execution.deliveryCase.proposal.summary}</p>
                              {execution.deliveryCase.proposalHistory.length > 1 ? (
                                <details>
                                  <summary>
                                    Revision history (
                                    {execution.deliveryCase.proposalHistory.length})
                                  </summary>
                                  {execution.deliveryCase.proposalHistory.map((proposal) => (
                                    <p key={proposal.revision}>
                                      r{proposal.revision}: {proposal.summary} ·{' '}
                                      {proposal.requirementIds?.length ?? 0} requirements ·{' '}
                                      {proposal.nodeIds?.length ?? 0} nodes
                                    </p>
                                  ))}
                                </details>
                              ) : null}
                              {execution.deliveryCase.proposal.risks?.length ? (
                                <small>
                                  Risks: {execution.deliveryCase.proposal.risks.join(' · ')}
                                </small>
                              ) : null}
                              {execution.deliveryCase.proposal.permissions?.length ? (
                                <small>
                                  Permissions:{' '}
                                  {execution.deliveryCase.proposal.permissions.join(' · ')}
                                </small>
                              ) : null}
                              {execution.deliveryCase.stage === 'proposed' &&
                              !execution.deliveryCase.proposal.approvedAt ? (
                                <Button
                                  size="small"
                                  variant="primary"
                                  onClick={() =>
                                    void deliveryAction(execution, {
                                      type: 'approve_proposal',
                                      evidenceId: `web-approval-${execution.graphId}-${execution.revision}`,
                                    })
                                  }
                                >
                                  Approve Proposal
                                </Button>
                              ) : null}
                              {execution.deliveryCase.stage === 'proposed' &&
                              execution.deliveryCase.proposal.approvedAt ? (
                                <Button
                                  size="small"
                                  variant="primary"
                                  onClick={() => onStartExecution(execution)}
                                >
                                  Start approved execution
                                </Button>
                              ) : null}
                            </div>
                          ) : null}
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
                  {executions.flatMap((execution) => execution.evidence).length ? (
                    executions.flatMap((execution) =>
                      execution.evidence.map((evidence) => (
                        <div
                          className="detail-list-row"
                          key={`${execution.graphId}-${evidence.id}`}
                        >
                          <strong>{evidence.summary}</strong>
                          <small>
                            {evidence.kind} · {evidence.id}
                          </small>
                        </div>
                      ))
                    )
                  ) : (
                    <p>{run?.evidenceCount ?? 0} TaskRun evidence items.</p>
                  )}
                </section>
                <section>
                  <div className="detail-label">Decisions and reference artifacts</div>
                  {executions
                    .flatMap((execution) => execution.deliveryCase?.decisions ?? [])
                    .map((decision) => (
                      <p key={decision.id}>
                        {decision.summary} · {decision.rationale}
                      </p>
                    ))}
                  {executions
                    .flatMap((execution) => execution.deliveryCase?.artifacts ?? [])
                    .map((artifact) => (
                      <p key={artifact.id}>
                        {artifact.kind} · {artifact.id} · evidence {artifact.evidenceId}
                      </p>
                    ))}
                </section>
                <section>
                  <div className="detail-label">Requirement coverage</div>
                  {executions
                    .flatMap((execution) => execution.completionReport?.requirementCoverage ?? [])
                    .map((coverage) => (
                      <p key={coverage.requirementId}>
                        {coverage.covered ? '✓' : '○'} {coverage.requirementId} ·{' '}
                        {coverage.evidenceIds.length} evidence item(s)
                      </p>
                    ))}
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
