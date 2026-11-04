#!/usr/bin/env node
/**
 * Stop hook recipe: do not let a run end over an unverified change.
 *
 * This is the user-installable version of Cursor's completion review: after the
 * agent finishes a run, inspect the latest independent-review record and veto
 * the stop (exit 2) unless it passed. Moss then reports the run Incomplete in
 * headless mode (and offers one continuation turn in the REPL), so "done" can
 * never silently mean "no review".
 *
 * Install (user or project config; `command` runs in the workspace):
 *
 *   {
 *     "hooks": {
 *       "Stop": [
 *         { "command": "node docs/hooks/stop-verified-completion.mjs", "timeoutMs": 5000 }
 *       ]
 *     }
 *   }
 *
 * Pair it with `review.mode: "auto"` (or have the model call review_changes),
 * otherwise every run is vetoed because nothing reviewed it.
 *
 * Override the log location with MOSS_STOP_REVIEW_LOG when the workspace is not
 * the current directory.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Where `.moss/review.jsonl` lives; env override keeps the recipe testable. */
function reviewLogPath() {
  const override = process.env.MOSS_STOP_REVIEW_LOG;
  if (override && override.trim() !== '') return override;
  return path.join(process.cwd(), '.moss', 'review.jsonl');
}

function deny(message) {
  process.stderr.write(`review gate: ${message}\n`);
  process.exit(2);
}

function readLatestReview(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    deny(`could not read ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  let latest = null;
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    try {
      latest = JSON.parse(line);
    } catch {
      // A torn trailing line must not hide an earlier review.
    }
  }
  return latest;
}

let body = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  body += chunk;
});
process.stdin.on('end', () => {
  let payload = {};
  try {
    payload = JSON.parse(body === '' ? '{}' : body);
  } catch {
    // A malformed payload is not a reason to approve an unverified run.
  }
  const response = typeof payload.response === 'string' ? payload.response : '';
  if (/no files were (changed|modified)/i.test(response)) {
    // Nothing was touched: an unchanged run needs no verification.
    process.exit(0);
  }
  const record = readLatestReview(reviewLogPath());
  if (!record) {
    deny('no independent review recorded for this workspace; run review_changes or /review first');
  }
  if (record.verdict !== 'pass') {
    const findings = Array.isArray(record.findings) ? record.findings.length : 0;
    const first = record.findings && record.findings[0];
    const where =
      first && first.file ? ` (first: ${first.file}${first.line ? `:${first.line}` : ''})` : '';
    deny(
      `the latest review is ${String(record.verdict).toUpperCase()} with ${findings} unresolved finding(s)${where}`
    );
  }
  process.exit(0);
});
