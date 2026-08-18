#!/bin/bash
set -euo pipefail
npm run build -w @rdk-moss/agent
node --input-type=module - <<'NODE'
const orchestration = await import('@rdk-moss/agent/orchestration');
for (const name of ['InMemoryExecutionStore', 'JsonlExecutionStore', 'ExecutionGraphScheduler', 'CompletionArbiter']) {
  if (!(name in orchestration)) throw new Error(`missing orchestration export: ${name}`);
}
NODE
npm run test:filter -w @rdk-moss/agent -- --filter task-command --filter plugin-agent-role

