#!/usr/bin/env node
/**
 * O151: a run whose verification step names the workspace root R — as the
 * `cd` target (J12/J13) or as a plain read-only operand next to an
 * interpreter (`git -C R diff` in J13-moss-2, `ls -la R; python3 -V` on the
 * B1 board, R not even a git repo) — must not be labelled "git repository
 * internals" / 「git 仓库内部文件」 and must not end in a false Incomplete
 * (exit 9). Real writes to `.git/`, hooks and `.env` stay blocked, and the
 * files are byte-for-byte unchanged (sha256 before == after).
 *
 * Process-level: real `dist/cli.js -p` against the local fake model from the
 * O121 spec; text last line, exit code and json `result` must agree (zh/en).
 * Policy-level: `findShellProtectedWrites` on the same shapes (fast, exact).
 *
 * Before #124 (de60df80) the cd-only GREEN cases fail; before the O151 src
 * fix (#131 0804efa8) the read-only-operand GREEN cases fail with exit 9.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scenario } from './o121-safety-block-outcome.spec.mjs';

const IS_WIN = process.platform === 'win32';
const CLAIM = { zh: '已修好，校验通过。', en: 'Fixed; the check passes.' };
const exec = (command) => ({ name: 'exec', args: { command } });
const q = (p) => (/[\s"]/.test(p) ? `'${p}'` : p);
const GIT_INTERNALS = /git repository internals|git 仓库内部文件/;
const BLOCKED = /未完成|被拦|Incomplete|Blocked by/;

/** Tiny `count` CLI so the J13-moss-2 original command runs for real. */
const COUNT_CLI = `const fs = require('fs');
const [cmd, file, flag] = process.argv.slice(2);
if (cmd !== 'count' || !file) { console.error('usage: cli count <file> [--json]'); process.exit(2); }
const s = fs.readFileSync(file, 'utf8');
const o = { lines: s.split('\\n').length - 1, words: s.split(/\\s+/).filter(Boolean).length, chars: s.length };
console.log(flag === '--json' ? JSON.stringify(o) : o.lines + ' ' + o.words + ' ' + o.chars);
`;

/** Verification-only commands; `marker` = stdout proving it really ran (posix). */
const GREEN = [
  {
    id: 'j12-node-e',
    gitInit: true,
    steps: ({ proj }) => [exec(`cd ${q(proj)} && node -e "console.log(['1h30m'].join())"`)],
    marker: '1h30m',
  },
  {
    id: 'j13-redirect-and-node',
    gitInit: true,
    steps: ({ proj }) => [
      exec(`cd ${q(proj)} && printf 'a b\\nc\\n' > w.txt && echo "--plain--" && node -e "1"`),
    ],
    marker: '--plain--',
  },
  {
    id: 'j13-git-diff-subst',
    gitInit: true,
    steps: ({ proj }) => [
      exec(
        `cd ${q(proj)} && git diff --stat -- README.md && echo "unchanged: $(git diff --quiet -- README.md && echo yes)"`
      ),
    ],
    marker: 'unchanged: yes',
  },
  // ── QA BLOCK on #131 (0804efa8): R as a plain operand, not only the cd target ──
  {
    // J13-moss-2, verbatim from the run log (R substituted).
    id: 'j13-moss-2-orig',
    gitInit: true,
    seedFiles: { 'src/cli.js': COUNT_CLI },
    steps: ({ proj }) => [
      exec(
        `cd ${q(proj)} && printf 'a b\\nc\\n' > /tmp/t.txt && echo "== plain ==" && node src/cli.js count /tmp/t.txt && echo "== json ==" && node src/cli.js count /tmp/t.txt --json && echo "== json typeof ==" && node src/cli.js count /tmp/t.txt --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const o=JSON.parse(s);console.log(Object.keys(o).join(','),typeof o.lines,typeof o.words,typeof o.chars,'lines='+s.split('\\n').length-1)})" && echo "== usage (exit code) ==" ; node src/cli.js count ; echo "exit=$?" ; git -C ${q(proj)} diff -- src/cli.js | tail -8`
      ),
    ],
    marker: '== plain ==',
  },
  {
    // B1 board, verbatim; ~/b1 is NOT a git repository.
    id: 'b1-orig-not-git',
    gitInit: false,
    seedFiles: { 'src/talker.py': 'print(1)\n' },
    steps: ({ proj }) => [
      exec(`ls -la ${q(proj)}; ls -la ${q(proj)}/src; which colcon ros2 python3; python3 -V`),
    ],
    marker: 'talker.py',
  },
  {
    id: 'min-node-e-then-ls-root',
    gitInit: true,
    steps: ({ proj }) => [exec(`node -e 1; ls ${q(proj)}`)],
    marker: 'README.md',
  },
  {
    id: 'min-node-e-then-git-C-root-diff',
    gitInit: true,
    seedFiles: { 'README.md': '# p changed-o151\n' },
    steps: ({ proj }) => [exec(`node -e 1 && git -C ${q(proj)} diff`)],
    marker: 'changed-o151',
  },
  {
    id: 'min-cd-root-node-e-ls-root',
    gitInit: true,
    steps: ({ proj }) => [exec(`cd ${q(proj)} && node -e 1 && ls ${q(proj)}`)],
    marker: 'README.md',
  },
  {
    id: 'min-ls-root-python3-not-git',
    gitInit: false,
    steps: ({ proj }) => [exec(`ls -la ${q(proj)}; python3 -V`)],
    marker: 'README.md',
  },
];

/** Real writes to protected files; each must exit 9 AND leave the file unchanged. */
const SEED = { '.git/hooks/pre-commit': '#!/bin/sh\nexit 0\n', '.env': 'ORIG=1\n' };
const WATCH = ['.git/config', '.git/hooks/pre-commit', '.env'];
const nodeW = (file) => `node -e "require('fs').writeFileSync('${file}','x')"`;
const PROBES = [
  { id: 'hooks echo >', cmd: (R) => `cd ${R} && echo 'exit 1' > .git/hooks/pre-commit` },
  { id: 'hooks node -e', cmd: (R) => `cd ${R} && ${nodeW('.git/hooks/pre-commit')}` },
  { id: '.env echo >', cmd: (R) => `cd ${R} && echo SECRET=1 > .env` },
  { id: '.env node -e', cmd: (R) => `cd ${R} && ${nodeW('.env')}` },
  { id: '.git/config node -e', cmd: (R) => `cd ${R} && ${nodeW('.git/config')}` },
  {
    id: 'cd R/.git node -e (names .git/config)',
    cmd: (R) => `cd ${R}/.git && ${nodeW('config')}`,
    names: /\.git\/config/,
  },
  { id: 'cd R/.git printf >', cmd: (R) => `cd ${R}/.git && printf x > config` },
  { id: 'cd R && cd .git node -e', cmd: (R) => `cd ${R} && cd .git && ${nodeW('config')}` },
  { id: 'cd R && cd .git printf >', cmd: (R) => `cd ${R} && cd .git && printf x > config` },
  { id: '; separator', cmd: (R) => `cd ${R}; ${nodeW('.git/config')}` },
  { id: '|| true &&', cmd: (R) => `cd ${R} || true && ${nodeW('.git/config')}` },
  { id: '|| exit 1; hooks', cmd: (R) => `cd ${R} || exit 1; printf x > .git/hooks/pre-commit` },
  { id: 'pushd printf >', cmd: (R) => `pushd ${R} && printf x > .git/config` },
  {
    id: 'pushd ; node -e hooks',
    cmd: (R) => `pushd ${R} >/dev/null; ${nodeW('.git/hooks/pre-commit')}`,
  },
  { id: 'symlink root node -e', symlink: true, cmd: (R) => `cd ${R} && ${nodeW('.git/config')}` },
  { id: 'symlink root printf >', symlink: true, cmd: (R) => `cd ${R} && printf x > .git/config` },
  // The O151 exemption itself must not open a hole:
  { id: 'ls R; node -e write', cmd: (R) => `ls ${R}; ${nodeW('.git/config')}` },
  {
    id: 'git -C R diff; python3 write',
    cmd: (R) => `git -C ${R} diff; python3 -c "open('.git/config','w').write('x')"`,
  },
  { id: 'ls R | xargs rm -rf', cmd: (R) => `ls -d ${R} | xargs rm -rf; node -e 1` },
  { id: 'ls R; rm -rf R/.git', cmd: (R) => `ls ${R}; node -e 1; rm -rf ${R}/.git` },
  { id: '[zh] .git/config node -e', lang: 'zh', cmd: (R) => `cd ${R} && ${nodeW('.git/config')}` },
  {
    id: '[json] .git/config node -e',
    json: true,
    cmd: (R) => `cd ${R} && ${nodeW('.git/config')}`,
  },
];

// ── harness ──
let pass = 0;
const failures = [];
const resultOf = (r) =>
  r.out
    .trim()
    .split('\n')
    .filter((l) => l.startsWith('{'))
    .map((l) => JSON.parse(l))
    .filter((e) => e.type === 'result')
    .pop();

/** Run jobs with limited concurrency; report in declaration order. */
async function runAll(jobs, limit = 4) {
  const results = new Array(jobs.length);
  let next = 0;
  async function worker() {
    while (next < jobs.length) {
      const i = next++;
      try {
        await jobs[i].fn();
        results[i] = null;
      } catch (err) {
        results[i] = err;
      }
    }
  }
  await Promise.all(Array.from({ length: limit }, worker));
  jobs.forEach((job, i) => {
    if (results[i]) {
      failures.push(job.name);
      console.log(`not ok - ${job.name}: ${results[i]?.message ?? results[i]}`);
    } else {
      pass += 1;
      console.log(`ok - ${job.name}`);
    }
  });
}

// ── policy level (dist/safety) ──
{
  const { findShellProtectedWrites } = await import(
    new URL('../dist/safety/protected-paths.js', import.meta.url)
  );
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'o151-pol-')));
  const R = path.join(base, 'proj');
  const NR = path.join(base, 'b1');
  const home = path.join(base, 'home');
  for (const d of [path.join(R, '.git', 'hooks'), path.join(R, 'src'), path.join(NR, 'src'), home])
    fs.mkdirSync(d, { recursive: true });
  const hits = (cmd, root = R) =>
    findShellProtectedWrites(cmd, { cwd: root, workspaceRoot: root, home });
  const green = [
    [`cd ${R} && node -e 1 ; git -C ${R} diff -- src/cli.js | tail -8`, R],
    [`ls -la ${NR}; ls -la ${NR}/src; which colcon ros2 python3; python3 -V`, NR],
    [`ls -la ${R}; ls -la ${R}/src; which colcon ros2 python3; python3 -V`, R],
    [`node -e 1; ls ${R}`, R],
    [`node -e 1 && git -C ${R} diff`, R],
    [`cd ${R} && node -e 1 && ls ${R}`, R],
    [`ls -la ${NR}; python3 -V`, NR],
    [`node -e 1; cat ${R}/README.md`, R],
  ];
  const red = [
    `ls ${R} | xargs rm -rf; node -e 1`,
    `ls ${R} > out.txt; node -e 1`,
    `node -e "require('fs').rmSync('${R}',{recursive:true})"; ls ${R}`,
    `ls ${R}; python3 -c "import shutil;shutil.rmtree('.')"`,
    `python3 -c 'import sys;print(sys.argv)' ${R}`,
    `cd ${R} && cd .. && node -e 1 && ls ${R}`,
    `git -C ${R} clean -fdx; node -e 1`,
    `find ${R} -delete; node -e 1`,
    `ls ${R}; node -e 1 && rm -rf ${R}`,
    `ls $(echo ${R}); node -e 1`,
    `ls ${R}/src/..; node -e "x('${R}/src/..')"`,
    `ls ${R}; node -e "require('fs').writeFileSync('.git/config','x')"`,
  ];
  const jobs = [];
  for (const [cmd, root] of green)
    jobs.push({
      name: `policy GREEN: ${cmd.replaceAll(base, '<b>')}`,
      fn: async () => assert.deepEqual(hits(cmd, root), []),
    });
  for (const cmd of red)
    jobs.push({
      name: `policy RED: ${cmd.replaceAll(base, '<b>')}`,
      fn: async () => assert.ok(hits(cmd).length > 0, 'expected a protected hit'),
    });
  jobs.push({
    name: 'policy F6: cd R/.git && node -e writeFileSync(config) names .git/config first',
    fn: async () => {
      const h = hits(`cd ${R}/.git && ${nodeW('config')}`);
      assert.equal(h[0]?.raw, '.git/config', JSON.stringify(h));
    },
  });
  await runAll(jobs, 1);
  fs.rmSync(base, { recursive: true, force: true });
}

// ── process level ──
const jobs = [];
for (const c of GREEN) {
  for (const lang of ['zh', 'en']) {
    const opts = {
      lang,
      gitInit: c.gitInit,
      seedFiles: c.seedFiles,
      steps: c.steps,
      finalText: CLAIM[lang],
    };
    jobs.push({
      name: `[${lang}] ${c.id}: root as cd target / read-only operand → exit 0, no git-internals label`,
      fn: async () => {
        const r = await scenario(opts);
        const ctx = `last=${r.last}\n${r.err.slice(-600)}`;
        assert.equal(r.code, 0, `exit 0, got ${r.code}; ${ctx}`);
        assert.doesNotMatch(r.last, BLOCKED, ctx);
        assert.doesNotMatch(r.err + r.out, GIT_INTERNALS, ctx);
        assert.doesNotMatch(r.err, /\[moss\] Blocked/, ctx);
        const tools = r.toolResults.join('\n');
        assert.doesNotMatch(tools, GIT_INTERNALS, tools.slice(0, 400));
        // The command really ran (posix shells; Windows runs pwsh).
        if (!IS_WIN)
          assert.ok(tools.includes(c.marker), `marker ${c.marker}: ${tools.slice(0, 400)}`);
      },
    });
    jobs.push({
      name: `[${lang}] ${c.id}: json result is success (consistent with exit 0)`,
      fn: async () => {
        const r = await scenario({ ...opts, json: true });
        const res = resultOf(r);
        assert.ok(res, `result event; err=${r.err.slice(-300)}`);
        assert.equal(r.code, 0, `exit 0, got ${r.code}; ${JSON.stringify(res).slice(0, 400)}`);
        assert.equal(res.subtype, 'success', JSON.stringify(res).slice(0, 400));
        assert.equal(res.is_error, false);
      },
    });
  }
}

for (const p of PROBES) {
  if (p.symlink && IS_WIN) continue; // dir symlinks need admin on Windows runners
  const lang = p.lang ?? 'en';
  jobs.push({
    name: `probe ${p.id}: exit 9 被拦, protected files byte-identical`,
    fn: async () => {
      const r = await scenario({
        lang,
        gitInit: true,
        seedFiles: SEED,
        watch: WATCH,
        symlinkRoot: !!p.symlink,
        json: !!p.json,
        steps: ({ proj }) => [exec(p.cmd(q(proj)))],
        finalText: CLAIM[lang],
      });
      const ctx = `last=${r.last}\n${r.err.slice(-600)}`;
      assert.equal(r.code, 9, `exit 9, got ${r.code}; ${ctx}`);
      if (p.json) {
        const res = resultOf(r);
        assert.equal(res?.subtype, 'error_during_execution', JSON.stringify(res).slice(0, 300));
        assert.equal(res.is_error, true);
      } else {
        assert.match(r.last, lang === 'zh' ? /^未完成.*被拦/ : /^Incomplete.*Blocked by/, ctx);
        if (p.names) assert.match(r.last, p.names, ctx);
      }
      for (const rel of WATCH) {
        assert.notEqual(r.hashes.before[rel], 'ABSENT', `${rel} seeded`);
        assert.equal(r.hashes.after[rel], r.hashes.before[rel], `${rel} unchanged`);
      }
    },
  });
}

await runAll(jobs, 4);

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
