# Super-agent in Moss

Moss 0.29 adds an optional host for the actual [DeepSeek Super-agent prototype core](https://github.com/deepseek-ai/dsh-superagent-prototype/tree/6337fc823ce20251c8de8085948165c81aaa701e/src/core). The core owns requests, immutable mandates, tickets, assignments and local replies. Moss owns models, tools, permissions, sessions and verified Task Runtime execution. It is integrated into Moss, rather than installed as a plugin. DSH, Cordis, GitHub/Feishu adapters and Web UI are not included.

## Local CLI

Use a Git repository with a commit. Model configuration comes from the usual `moss setup`/CLI configuration. Worktrees start from committed HEAD; commit files required by the task first. Changes stay in each ticket's worktree for inspection and manual integration. Uncommitted dependencies such as the parent's node_modules are not copied; prepare dependencies in the ticket workspace with the permissions you choose.

```bash
moss superagent init --accept "npm test" --workers 2
moss superagent submit "Fix the failing parser test" --id parser-001
moss superagent work
moss superagent status
```

Choose the acceptance command yourself; it executes as a trusted shell command in the ticket workspace, and runs both in native Task Runtime and independently in the controller. It must be repeatable. The command is pinned per mandate; changing configuration affects new mandates. A model's completion statement cannot replace it.

Workers run with a workspace-write/manual permission ceiling (or inherit a stricter read-only ceiling) and retain operator allow/deny rules. Noninteractive execution cannot ask for approvals. Authorize the specific tools/commands you need in your **user** configuration, for example:

```json
{
  "permissions": {
    "defaultMode": "manual",
    "allow": ["write_file", "apply_patch"]
  }
}
```

This grants file edits, not arbitrary shell execution or device mutations. A task needing another denied/approval-required tool blocks honestly. Worktree isolation prevents accidental concurrent edits; it is not an OS sandbox.

`work` drains admitted work; `start` stays in the foreground and polls. Use a second terminal for `submit`, `status`, `pause`, `resume`, `stop <ticket-id>` or `retry <ticket-id>`. Pause holds new launches and leaves running work alone; stop targets one worker. Ctrl+C cancels active assignments cooperatively. A forced shutdown or uncertain crash requires inspection followed by explicit retry. A blocked task makes `work` exit 9; exit 0 can also mean an empty or paused queue, so inspect ticket state when scripting.

Use `--thread` to send a follow-up to an existing conversation. Stable `--id` values deduplicate events across restart; reusing an ID with different contents is rejected. Follow-ups remain within the original mandate. A completed ticket can start another verified round in the same workspace/session. The `status` output includes its native task ID and local result receipts.

## SDK and policy

```js
import { createMossSuperagent } from '@rdk-moss/agent';

const runtime = await createMossSuperagent({
  workspaceDir: '/absolute/path/to/repository',
  config: {
    acceptanceCommand: 'npm test',
    allowedActors: { local: ['operator'] },
    acceptMode: 'observe',
    rules: [],
    maxWorkers: 1,
    maxWallMs: 1_800_000,
  },
});
try {
  runtime.receive({
    id: 'request-001',
    source: 'local',
    actor: 'operator',
    thread: 'conversation-001',
    text: 'Fix the parser test',
    human: true,
    addressed: true,
  });
  await runtime.work();
  console.log(runtime.tickets());
} finally {
  await runtime.close();
}
```

The default SDK worker also uses the normal CLI setup; its user configuration must be available to the subprocess. A trusted host can supply a `SuperagentWorker` implementation, but ready results still require native task acceptance, the original oracle and controller re-verification. Cancel and await `work` before closing the runtime.

Source adapters authenticate actors before calling `receive`; `human`/`actor` are trusted host assertions, never fields copied directly from untrusted webhook text. Unlisted actors/bots cannot authorize work. Written `rules` and a semantic assessor are required for inferred work. `observe` records a positive would-accept audit without executing; `auto` can execute only a valid assessment matching configured rules. Explicit addressed requests from an allowed human do not need an assessor.

`configure <policy.json>` replaces the complete operator policy, preserving existing state. Policy contains exactly the six fields in the example above. Off disables inferred admission; observe and auto select its execution behavior. Policy changes notify affected live tickets but do not rewrite existing mandates or grant extra tool permissions. `pause`/`stop` are the controls for holding/revoking work already admitted.

State lives in private `.moss/superagent/state.sqlite` (transactional domain rows, queued effects, local replies), with worktrees under `.moss/worktrees/superagent-<ticket-id>`. One scheduler owns the state; other connections may submit or inspect. Keep the database, WAL and SHM files together when backing up a live system, or stop all connections first. Do not copy API keys into policy files or requests. No automatic push, merge, reply transmission or cleanup of user work occurs.

See the [implementation spec](specs/moss-superagent.md), [acceptance evidence](specs/moss-superagent-acceptance.md), [pinned provenance](specs/superagent-upstream.json) and [upstream license](../THIRD-PARTY-NOTICES.md).
