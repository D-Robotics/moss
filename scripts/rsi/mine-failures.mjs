#!/usr/bin/env node
/**
 * Deterministic failure-signature miner. No model calls.
 * Holdout summaries contribute category + count only — never task ids or transcripts.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { redactKnownSecrets, sensitiveDataPaths } from './lib/secrets.mjs';

const MOSS_CODES = [
  'USER_INPUT_INVALID',
  'PROVIDER_CONFIG_MISSING',
  'PROVIDER_UPSTREAM_ERROR',
  'PROVIDER_CONTEXT_OVERFLOW',
  'PROVIDER_AUTH_FAILED',
  'PROVIDER_RATE_LIMITED',
  'TOOL_EXECUTION_FAILED',
  'TOOL_EXECUTION_TIMEOUT',
  'TOOL_NOT_FOUND',
  'TOOL_NOT_ALLOWED',
  'SESSION_NOT_FOUND',
  'SESSION_PERSIST_FAILED',
  'SKILL_LOAD_FAILED',
  'USER_ABORTED',
  'AGENT_DISPOSED',
  'EXECUTION_REVISION_CONFLICT',
  'EXECUTION_LEASE_HELD',
  'EXECUTION_STATE_INVALID',
  'EXECUTION_STORE_FAILED',
  'CONFIG_IO_FAILED',
  'INTERNAL_INVARIANT_VIOLATED',
  'UNKNOWN',
];

const SURFACE_UNITS = { prompt: 1, nudge: 1, tool: 2, context: 2, loop: 3, human: 8 };

function usage() {
  return [
    'Usage: npm run rsi:mine -- [--results <dir>] [--out <path>] [--repo <path>]',
    '',
    'Reads summary.json files under --results (default bench/results), plus sibling',
    'transcripts and .moss/ JSONL. Writes .rsi/backlog.json. Holdout rows (meta.split',
    'or meta.holdout) contribute category + count only.',
  ].join('\n');
}

function parseArgs(argv) {
  const out = { repo: process.cwd() };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} requires a value`);
      return value;
    };
    if (arg === '--results') out.results = next();
    else if (arg === '--out') out.out = next();
    else if (arg === '--repo') out.repo = next();
    else if (arg === '--tasks-root') out.tasksRoot = next();
    else if (arg === '--help' || arg === '-h') out.help = true;
    else throw new Error(`unknown flag: ${arg}`);
  }
  out.repo = path.resolve(out.repo);
  out.results = path.resolve(out.repo, out.results ?? path.join('bench', 'results'));
  out.out = path.resolve(out.repo, out.out ?? path.join('.rsi', 'backlog.json'));
  out.tasksRoot = path.resolve(out.repo, out.tasksRoot ?? path.join('bench', 'tasks'));
  return out;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readJsonl(file) {
  if (!file || !fs.existsSync(file)) return [];
  const rows = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      // Torn line.
    }
  }
  return rows;
}

function discoverSummaries(root) {
  if (!fs.existsSync(root)) return [];
  const found = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.moss')
        continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.endsWith('.moss')) continue;
        stack.push(full);
      } else if (entry.isFile() && entry.name === 'summary.json') found.push(full);
    }
  }
  return found.sort();
}

function pad(sample) {
  return String(sample).padStart(2, '0');
}

export function normalizeCheckOutput(output) {
  if (typeof output !== 'string' || !output.trim()) return '';
  const lines = redactKnownSecrets(output).split(/\r?\n/).slice(0, 3).join('\n');
  return lines
    .replace(/[A-Za-z]:\\[^\s]+/g, '<path>')
    .replace(/(?:\/|\\)(?:[^\s/\\]+[/\\])*[^\s/\\]+/g, '<path>')
    .replace(/\b[0-9a-f]{7,}\b/gi, '<hex>')
    .replace(/\d+(?:\.\d+)?/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
}

function normSymptom(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/\d+(?:\.\d+)?/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

function isHoldout(summary) {
  return summary?.meta?.split === 'holdout' || summary?.meta?.holdout === true;
}

function isDeviceSummary(summary) {
  if (summary?.meta?.kind === 'device-bench') return true;
  return (summary.rows ?? []).some((row) => row && row.status && row.id && row.task === undefined);
}

function roundOf(summary, file) {
  if (Number.isInteger(summary?.meta?.round)) return summary.meta.round;
  const match = /round-(\d+)/.exec(file.replaceAll('\\', '/'));
  if (match) return Number(match[1]);
  return null;
}

function weightOf(tags, tier) {
  if (Array.isArray(tags) && tags.includes('tier:hard')) return 3;
  if (tier === 'core') return 3;
  return 1;
}

function tagsFor(summary, row, tasksRoot) {
  if (Array.isArray(row.tags)) return row.tags;
  const fromPer = (summary.perTask ?? []).find((task) => task.task === row.task);
  if (Array.isArray(fromPer?.tags)) return fromPer.tags;
  if (row.task && tasksRoot) {
    const taskFile = path.join(tasksRoot, row.task, 'task.json');
    if (fs.existsSync(taskFile)) {
      try {
        const task = readJson(taskFile);
        if (Array.isArray(task.tags)) return task.tags;
      } catch {
        return [];
      }
    }
  }
  return [];
}

function blocksOf(event) {
  const content = event?.message?.content;
  return Array.isArray(content) ? content : [];
}

function toolNames(events) {
  const names = [];
  for (const event of events) {
    for (const block of blocksOf(event)) {
      if (block?.type === 'tool_use' && typeof block.name === 'string') names.push(block);
    }
  }
  return names;
}

function transcriptText(events) {
  return JSON.stringify(events);
}

function surfaceFor(signature) {
  if (signature.startsWith('device:policy-denied')) return null;
  if (signature.startsWith('outcome:')) return 'loop';
  if (signature.startsWith('taskos:metric-repeat')) return 'loop';
  if (signature.startsWith('taskos:')) return 'nudge';
  if (signature.startsWith('tool:')) return 'tool';
  if (signature.startsWith('context:')) return 'context';
  if (signature.startsWith('knowledge:')) return 'tool';
  if (signature.startsWith('check:')) return 'nudge';
  if (signature.startsWith('device:')) return 'tool';
  return 'loop';
}

function rel(repo, file) {
  if (!file) return null;
  return path.relative(repo, file).replaceAll('\\', '/');
}

function addHit(groups, signature, sample) {
  let group = groups.get(signature);
  if (!group) {
    group = { signature, samples: [] };
    groups.set(signature, group);
  }
  group.samples.push(sample);
}

function capabilitySignatures(row, events, moss) {
  const signatures = [];
  const timedOut = row.timedOut === true;
  const maxTurns =
    row.subtype === 'error_max_turns' ||
    (Number.isInteger(row.maxTurns) &&
      typeof row.numTurns === 'number' &&
      row.numTurns >= row.maxTurns);
  if (timedOut) signatures.push('outcome:timedOut');
  if (maxTurns) signatures.push('outcome:maxTurns');
  if (!timedOut && !maxTurns && row.subtype) signatures.push(`outcome:subtype:${row.subtype}`);
  if (!timedOut && !maxTurns && typeof row.mossExitCode === 'number' && row.mossExitCode !== 0) {
    signatures.push(`outcome:exit:${row.mossExitCode}`);
  }
  if (typeof row.compactions === 'number' && row.compactions > 0) {
    signatures.push('context:compaction-failed');
  }
  const normalized = normalizeCheckOutput(row.checkOutput);
  if (normalized) signatures.push(`check:${normalized}`);

  const text = `${row.checkOutput ?? ''}\n${transcriptText(events)}`;
  if (text.includes('noGoodMatch')) signatures.push('knowledge:noGoodMatch');
  if (
    /rdk-docs/i.test(text) &&
    /unreachable|ENOTFOUND|ECONNREFUSED|fetch failed|failed to fetch/i.test(text)
  ) {
    signatures.push('knowledge:rdk-docs-unreachable');
  }
  if (/no url|missing url|without a url/i.test(text))
    signatures.push('knowledge:answer-without-url');

  const uses = toolNames(events);
  const names = new Set(uses.map((block) => block.name));
  const repeated = new Set();
  const seen = new Map();
  for (const block of uses) {
    const key = `${block.name}\0${JSON.stringify(block.input ?? {})}`;
    const count = (seen.get(key) ?? 0) + 1;
    seen.set(key, count);
    if (count >= 2) repeated.add(block.name);
  }
  for (const name of [...repeated].sort()) signatures.push(`tool:repeat:${name}`);
  if (/tool loop guard/i.test(text)) signatures.push('tool:loop-guard');
  const foundCodes = new Set();
  for (const code of MOSS_CODES) {
    if (text.includes(code)) foundCodes.add(code);
  }
  for (const event of events) {
    if (typeof event.error_code === 'string') foundCodes.add(event.error_code);
  }
  for (const code of [...foundCodes].sort()) signatures.push(`tool:moss-error:${code}`);

  const failures = readJsonl(moss ? path.join(moss, 'task-failures.jsonl') : null);
  const repairs = readJsonl(moss ? path.join(moss, 'task-repairs.jsonl') : null);
  const acceptance = readJsonl(moss ? path.join(moss, 'acceptance.jsonl') : null);
  const tasks = readJsonl(moss ? path.join(moss, 'tasks.jsonl') : null);
  const bySymptom = new Map();
  for (const failure of failures) {
    const key = normSymptom(failure.metric ?? failure.symptom);
    if (!key) continue;
    bySymptom.set(key, (bySymptom.get(key) ?? 0) + 1);
  }
  for (const [symptom, count] of [...bySymptom.entries()].sort()) {
    if (count >= 2) signatures.push(`taskos:metric-repeat:${symptom}`);
  }
  const defined = names.has('task_define') || tasks.length > 0;
  const accepted = names.has('task_acceptance') || acceptance.length > 0;
  if (defined && !accepted) signatures.push('taskos:define-without-acceptance');
  const acceptanceFailed =
    acceptance.some((record) => record.verdict === 'fail') ||
    uses.some(
      (block) => block.name === 'task_acceptance' && /fail/i.test(JSON.stringify(block.input ?? {}))
    );
  const repaired = names.has('record_repair') || repairs.length > 0;
  if (acceptanceFailed && !repaired) signatures.push('taskos:fail-without-repair');
  return signatures;
}

function policyHits(summaryDir) {
  const hits = [];
  const stack = [summaryDir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && entry.name === 'evidence.jsonl') {
        for (const record of readJsonl(full)) {
          const denied =
            record.metric === 'device_policy' &&
            (record.result === 'fail' || String(record.observed ?? '').includes('deny'));
          if (denied) hits.push(record);
        }
      }
    }
  }
  return hits;
}

function failingCapability(row) {
  return row && row.pass === false;
}

function failingDevice(row) {
  return (
    row && (row.status === 'fail' || row.status === 'falseSuccess' || row.falseSuccess === true)
  );
}

export function mineFailures({ repo, results, tasksRoot }) {
  const summaries = discoverSummaries(results);
  const groups = new Map();
  const holdout = new Map();
  const loaded = [];
  for (const file of summaries) {
    let summary;
    try {
      summary = readJson(file);
    } catch {
      continue;
    }
    loaded.push({ summary, file });
    const dir = path.dirname(file);
    const round = roundOf(summary, file);
    if (isHoldout(summary)) {
      const category =
        summary.meta?.category ?? (isDeviceSummary(summary) ? 'device' : 'capability');
      const rows = summary.rows ?? [];
      const count = rows.filter((row) => failingCapability(row) || failingDevice(row)).length;
      if (count > 0) holdout.set(category, (holdout.get(category) ?? 0) + count);
      continue;
    }
    if (isDeviceSummary(summary)) {
      for (const row of summary.rows ?? []) {
        if (!failingDevice(row)) continue;
        const signature =
          row.status === 'falseSuccess' || row.falseSuccess === true
            ? 'device:falseSuccess'
            : `device:status:${row.status ?? 'fail'}`;
        addHit(groups, signature, {
          task: row.id ?? null,
          round,
          weight: weightOf(row.tags, row.tier),
          transcript: null,
          holdout: false,
        });
        const detail = normalizeCheckOutput(row.verdictDetail);
        if (detail) {
          addHit(groups, `check:${detail}`, {
            task: row.id ?? null,
            round,
            weight: weightOf(row.tags, row.tier),
            transcript: null,
            holdout: false,
          });
        }
      }
      for (const record of policyHits(dir)) {
        addHit(groups, 'device:policy-denied', {
          task: record.taskId ?? null,
          round,
          weight: 1,
          transcript: null,
          holdout: false,
          needsHuman: true,
        });
      }
      continue;
    }
    for (const row of summary.rows ?? []) {
      if (!failingCapability(row)) continue;
      const transcript = transcriptPath(dir, row.task, row.sample);
      const moss = mossDir(dir, row.task, row.sample);
      const events = transcript ? readJsonl(transcript) : [];
      const tags = tagsFor(summary, row, tasksRoot);
      const sample = {
        task: row.task ?? null,
        round,
        weight: weightOf(tags, row.tier),
        transcript,
        holdout: false,
      };
      for (const signature of new Set(capabilitySignatures(row, events, moss))) {
        addHit(groups, signature, sample);
      }
    }
    for (const record of policyHits(dir)) {
      addHit(groups, 'device:policy-denied', {
        task: record.taskId ?? null,
        round,
        weight: 1,
        transcript: null,
        holdout: false,
        needsHuman: true,
      });
    }
  }

  const rounds = loaded
    .map((item) => roundOf(item.summary, item.file))
    .filter((round) => Number.isInteger(round));
  const fresh = new Set([...new Set(rounds)].sort((a, b) => b - a).slice(0, 3));

  const items = [...groups.values()].map((group) => {
    const freshSamples = group.samples.filter(
      (sample) => sample.round == null || fresh.has(sample.round)
    );
    const weighted = freshSamples.reduce((sum, sample) => sum + sample.weight, 0);
    const surface = surfaceFor(group.signature);
    const units = surface ? SURFACE_UNITS[surface] : SURFACE_UNITS.human;
    let score = units === 0 ? 0 : weighted / units;
    const roundList = [
      ...new Set(
        group.samples.map((sample) => sample.round).filter((round) => Number.isInteger(round))
      ),
    ].sort((a, b) => a - b);
    const downgraded = stuck(roundList);
    const needsHuman =
      downgraded || group.samples.some((sample) => sample.needsHuman) || surface === null;
    if (downgraded) score /= 10;
    const tasks = [...new Set(group.samples.map((sample) => sample.task).filter(Boolean))].sort();
    const examples = [
      ...new Set(
        group.samples
          .map((sample) => sample.transcript)
          .filter(Boolean)
          .map((file) => rel(repo, file))
      ),
    ]
      .sort()
      .slice(0, 2);
    return {
      signature: group.signature,
      surface,
      needsHuman,
      downgraded,
      score: Number(score.toFixed(4)),
      failSamples: group.samples.length,
      freshSamples: freshSamples.length,
      tasks,
      examples,
      rounds: roundList,
    };
  });
  items.sort((a, b) => b.score - a.score || a.signature.localeCompare(b.signature));

  const synthetic =
    loaded.length > 0 && loaded.every((item) => item.summary?.meta?.synthetic === true);
  const holdoutCategories = [...holdout.entries()]
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => a.category.localeCompare(b.category));
  return {
    synthetic,
    source: {
      results: rel(repo, results),
      summaries: loaded.length,
      note: synthetic
        ? 'Every summary is marked meta.synthetic. These items are mined from fixture inputs, not from a measured bench run.'
        : loaded.length === 0
          ? 'No summary.json files were found under the results directory.'
          : null,
    },
    items,
    holdout: holdoutCategories,
  };
}

function transcriptPath(dir, task, sample) {
  if (!task || sample === undefined || sample === null) return null;
  const file = path.join(dir, `${task}-${pad(sample)}.jsonl`);
  return fs.existsSync(file) ? file : null;
}

function mossDir(dir, task, sample) {
  if (!task || sample === undefined || sample === null) return null;
  const direct = path.join(dir, `${task}-${pad(sample)}.moss`);
  if (fs.existsSync(direct)) return direct;
  const nested = path.join(dir, 'workspaces', task, '.moss');
  if (fs.existsSync(nested)) return nested;
  return null;
}

function stuck(rounds) {
  for (const round of rounds) {
    if (rounds.includes(round + 1) && rounds.includes(round + 2)) return true;
  }
  return false;
}

function refuseIfStopped(repo) {
  if (process.env.MOSS_RSI_DISABLED === '1') {
    console.error('RSI refused: MOSS_RSI_DISABLED=1');
    process.exit(2);
  }
  if (fs.existsSync(path.join(repo, '.rsi', 'STOP'))) {
    console.error('RSI refused: .rsi/STOP exists');
    process.exit(2);
  }
}

function isDirect() {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(path.resolve(entry)).href;
}

if (isDirect()) {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
    if (args.help) {
      if (
        process.env.MOSS_RSI_DISABLED === '1' ||
        fs.existsSync(path.join(args.repo, '.rsi', 'STOP'))
      ) {
        refuseIfStopped(args.repo);
      }
      console.log(usage());
      process.exit(0);
    }
    refuseIfStopped(args.repo);
  } catch (error) {
    console.error(`[rsi:mine] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
  const backlog = mineFailures(args);
  const sensitive = sensitiveDataPaths(backlog);
  if (sensitive.length > 0) {
    console.error(
      `[rsi:mine] refusing to write secrets to the RSI backlog: ${sensitive.join(', ')}`
    );
    process.exit(2);
  }
  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, `${JSON.stringify(backlog, null, 2)}\n`);
  console.log(
    `[rsi:mine] items=${backlog.items.length} holdout=${backlog.holdout.length} synthetic=${backlog.synthetic} wrote ${args.out}`
  );
}
