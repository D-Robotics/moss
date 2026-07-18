import assert from 'node:assert/strict';
import benchmark from '../benchmarks/agent-harness-real-world.mjs';
import sourceIndex from '../benchmarks/agent-harness-source-index.mjs';
import results from '../benchmarks/agent-harness-results.json' with { type: 'json' };
import efficiency from '../benchmarks/agent-efficiency-results.json' with { type: 'json' };

assert.equal(benchmark.cases.length, 200, 'benchmark must contain exactly 200 cases');
assert.equal(new Set(benchmark.cases.map((entry) => entry.id)).size, 200, 'case ids must be unique');

const categories = new Map();
for (const entry of benchmark.cases) {
  assert.match(entry.id, /^[a-z0-9_]+-\d{2}$/);
  assert.ok(['P0', 'P1', 'P2'].includes(entry.priority), `${entry.id}: invalid priority`);
  assert.ok(entry.prompt.length >= 20, `${entry.id}: prompt is too short`);
  assert.ok(entry.sourceProjects.length > 0, `${entry.id}: missing source projects`);
  assert.equal(entry.sourceProjects.length, entry.sourceUrls.length, `${entry.id}: source mismatch`);
  assert.ok(entry.expectedSignals.length >= 2, `${entry.id}: missing expected signals`);
  assert.ok(entry.forbiddenSignals.length >= 2, `${entry.id}: missing forbidden signals`);
  categories.set(entry.category, (categories.get(entry.category) ?? 0) + 1);
}

assert.equal(categories.size, 20, 'benchmark must cover exactly 20 categories');
for (const [category, count] of categories) {
  assert.equal(count, 10, `${category}: expected 10 cases`);
}

assert.ok(sourceIndex.length >= 20, 'source index must contain at least 20 concrete issues');
for (const source of sourceIndex) {
  assert.match(source.url, /^https:\/\/github\.com\//);
  assert.ok(source.themes.length > 0, `${source.project}#${source.issue}: missing themes`);
  for (const theme of source.themes) {
    assert.ok(categories.has(theme), `${source.project}#${source.issue}: unknown theme ${theme}`);
  }
}

const ids = new Set(benchmark.cases.map((entry) => entry.id));
for (const run of results.runs) {
  assert.ok(ids.has(run.caseId), `result references unknown case ${run.caseId}`);
  assert.ok(['passed', 'passed-fixture', 'failed', 'blocked'].includes(run.status));
  assert.ok(run.evidence.length >= 30, `${run.caseId}: evidence is too short`);
}

const priorities = Object.groupBy(benchmark.cases, (entry) => entry.priority);
console.log(`Validated ${benchmark.cases.length} cases across ${categories.size} categories.`);
console.log(`Priority mix: P0=${priorities.P0?.length ?? 0}, P1=${priorities.P1?.length ?? 0}, P2=${priorities.P2?.length ?? 0}`);
console.log(`Concrete source issues: ${sourceIndex.length}; recorded runs: ${results.runs.length}`);

for (const run of efficiency.runs) {
  assert.ok(['passed', 'failed', 'blocked'].includes(run.status), `${run.agent}: invalid efficiency status`);
  assert.ok(run.wallTimeMs > 0, `${run.agent}: missing wall time`);
  assert.ok(run.modelCalls >= 0, `${run.agent}: invalid model call count`);
  assert.ok(run.toolCalls >= 0, `${run.agent}: invalid tool call count`);
  assert.ok(run.evidence.length >= 40, `${run.agent}: efficiency evidence is too short`);
  if (run.status === 'passed') assert.equal(run.testsPassed, true, `${run.agent}: passed without tests`);
}
console.log(`Efficiency runs: ${efficiency.runs.length} across ${new Set(efficiency.runs.map((run) => run.taskId)).size} task(s).`);
