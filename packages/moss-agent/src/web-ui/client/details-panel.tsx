import { useEffect, useState } from 'react';
import { api } from './api-client.js';
import { Button, Code, Tabs } from './design-system.js';
import { PluginSlot } from './plugin-slot.js';
import type {
  BootstrapResponse,
  GoalSnapshot,
  ExecutionGraphSnapshot,
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

export const DetailsPanel = ({
  sessionId,
  run,
  selectedTool,
  bootstrap,
  contributions,
  initialTab,
  onTab,
  onClose,
}: {
  sessionId?: string;
  run?: RunSnapshot;
  selectedTool?: Extract<TimelineItem, { kind: 'tool' }>;
  bootstrap: BootstrapResponse | null;
  contributions: WebContribution[];
  initialTab: string;
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
  const [tasks, setTasks] = useState<ExecutionGraphSnapshot[]>([]);
  const [workflows, setWorkflows] = useState<WorkflowSnapshot[]>([]);
  const [trajectory, setTrajectory] = useState<unknown>();
  const [verdict, setVerdict] = useState<unknown>();
  useEffect(() => {
    if (!sessionId) return;
    void Promise.all([
      api.goal(sessionId),
      api.todos(sessionId),
      api.jobs(),
      api.workflows(),
      api.tasks(),
    ])
      .then(([nextGoal, nextTodos, nextJobs, nextWorkflows, nextTasks]) => {
        setGoal(nextGoal.goal ?? {});
        setTodos(safeList<TodoSnapshot>(nextTodos, 'todos'));
        setJobs(safeList<JobSnapshot>(nextJobs, 'jobs'));
        setWorkflows(safeList<WorkflowSnapshot>(nextWorkflows, 'workflows'));
        setTasks(safeList<ExecutionGraphSnapshot>(nextTasks, 'tasks'));
      })
      .catch(() => {});
  }, [sessionId]);
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
                  <div className="detail-label">Execution Graph</div>
                  {tasks.filter((task) => !task.sessionId || task.sessionId === sessionId)
                    .length ? (
                    tasks
                      .filter((task) => !task.sessionId || task.sessionId === sessionId)
                      .map((task) => (
                        <div className="detail-list-row" key={task.id}>
                          <strong>{task.goal}</strong>
                          <small>
                            {task.status} · revision {task.revision} ·{' '}
                            {
                              Object.values(task.nodes).filter(
                                (node) => node.status === 'succeeded'
                              ).length
                            }
                            /{Object.keys(task.nodes).length} nodes
                          </small>
                          {task.status === 'paused' || task.status === 'paused_recovered' ? (
                            <button
                              onClick={() =>
                                void api
                                  .controlTask(task.id, 'resume')
                                  .then(({ task: next }) =>
                                    setTasks((current) =>
                                      current.map((item) => (item.id === next.id ? next : item))
                                    )
                                  )
                              }
                            >
                              Resume
                            </button>
                          ) : null}
                          {['ready', 'running', 'blocked'].includes(task.status) ? (
                            <button
                              onClick={() =>
                                void api
                                  .controlTask(task.id, 'stop')
                                  .then(({ task: next }) =>
                                    setTasks((current) =>
                                      current.map((item) => (item.id === next.id ? next : item))
                                    )
                                  )
                              }
                            >
                              Stop
                            </button>
                          ) : null}
                          {Object.values(task.nodes)
                            .filter((node) =>
                              ['failed', 'interrupted', 'blocked', 'merge_conflict'].includes(
                                node.status
                              )
                            )
                            .map((node) => (
                              <button
                                key={`retry-${node.id}`}
                                onClick={() =>
                                  void api
                                    .controlTask(task.id, 'retry', node.id)
                                    .then(({ task: next }) =>
                                      setTasks((current) =>
                                        current.map((item) => (item.id === next.id ? next : item))
                                      )
                                    )
                                }
                              >
                                Retry {node.id}
                              </button>
                            ))}
                          <Code language="json">{JSON.stringify(task, null, 2)}</Code>
                        </div>
                      ))
                  ) : (
                    <p>No durable execution graph for this session.</p>
                  )}
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
