#!/usr/bin/env node
/**
 * Fetches the SWE-bench_Verified test split from the HuggingFace datasets-server
 * API and writes a locked, deterministic 100-instance subset to
 * bench/boards/swebench-instances.json.
 *
 * Sampling: sort all 500 instances by (repo, instance_id), then take every 5th
 * — deterministic, roughly proportional per repo (stratified). The full source
 * snapshot date is recorded so the lock is auditable.
 *
 * Usage: node scripts/lib/swebench-fetch.mjs [--size 100] [--stride auto]
 */
import fs from 'node:fs';
import path from 'node:path';

const DATASET = 'SWE-bench/SWE-bench_Verified';
const API = `https://datasets-server.huggingface.co/rows?dataset=${encodeURIComponent(
  DATASET
)}&config=default&split=test`;
const PAGE = 100;

function parseArgs(argv) {
  const out = { size: 100 };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--size') out.size = Number(argv[i + 1]);
  }
  return out;
}

function parseTestList(raw) {
  // FAIL_TO_PASS / PASS_TO_PASS may arrive as a real array (org dataset) or as
  // a JSON-encoded string (classic princeton-nlp dataset).
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
}

async function main() {
  const { size } = parseArgs(process.argv.slice(2));
  const rows = [];
  for (let offset = 0; ; offset += PAGE) {
    const url = `${API}&offset=${offset}&length=${PAGE}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`datasets-server ${res.status} at offset ${offset}`);
    const body = await res.json();
    if (!body.rows?.length) break;
    rows.push(...body.rows.map((r) => r.row));
    if (body.rows.length < PAGE || rows.length >= (body.num_rows_total ?? Infinity)) break;
  }
  if (rows.length < 300) throw new Error(`unexpectedly few rows: ${rows.length}`);

  const instances = rows
    .map((r) => ({
      instance_id: r.instance_id,
      repo: r.repo,
      base_commit: r.base_commit,
      version: r.version,
      image: r.image,
      eval_script: r.eval_script,
      problem_statement: r.problem_statement,
      test_patch: r.test_patch,
      fail_to_pass: parseTestList(r.FAIL_TO_PASS),
      pass_to_pass: parseTestList(r.PASS_TO_PASS),
    }))
    .sort((a, b) => (a.repo + a.instance_id < b.repo + b.instance_id ? -1 : 1));

  const stride = Math.floor(instances.length / size);
  const subset = [];
  for (let i = 0; i < size; i += 1) subset.push(instances[i * stride]);

  const byRepo = {};
  for (const inst of subset) byRepo[inst.repo] = (byRepo[inst.repo] ?? 0) + 1;

  const payload = {
    source: `hf:${DATASET}`,
    snapshotDate: new Date().toISOString().slice(0, 10),
    totalRows: rows.length,
    sampling: `sorted by (repo, instance_id), every ${stride}-th of ${rows.length}`,
    size: subset.length,
    repos: byRepo,
    instances: subset,
  };
  const outPath = path.join(process.cwd(), 'bench', 'boards', 'swebench-instances.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
  console.log(
    `wrote ${subset.length} instances (${Object.keys(byRepo).length} repos) to ${outPath}`
  );
  console.log(JSON.stringify(byRepo));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
