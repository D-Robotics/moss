#!/usr/bin/env node
/**
 * O151: a run whose verification step is `cd <workspace root> && node -e …`
 * (J12/J13 shape, real git repo at the root) must not be labelled
 * "git repository internals" / 「git 仓库内部文件」 and must not end in a false
 * Incomplete (exit 9). Real `.git/` writes after the same `cd` stay blocked.
 * Process-level: real `dist/cli.js -p` against the local fake model from the
 * O121 spec; text last line, exit code and json `result` must agree (zh/en).
 *
 * Before #124 (O127 cd exemption, e.g. de60df80) the green cases fail with
 * exit 9 「未完成：…git 仓库内部文件…」 — that is the J12/J13 regression this
 * spec pins.
 */
import assert from 'node:assert/strict';
import { scenario } from './o121-safety-block-outcome.spec.mjs';

const CLAIM = { zh: '已修好，校验通过。', en: 'Fixed; the check passes.' };
const exec = (command) => ({ name: 'exec', args: { command } });
const q = (p) => (/[\s"]/.test(p) ? `'${p}'` : p);

/** Verification-only commands models ran in J12/J13 after `cd <root>`. */
const GREEN = [
  {
    id: 'j12-node-e',
    steps: ({ proj }) => [exec(`cd ${q(proj)} && node -e "console.log(['1h30m'].join())"`)],
  },
  {
    id: 'j13-redirect-and-node',
    steps: ({ proj }) => [
      exec(`cd ${q(proj)} && printf 'a b\\nc\\n' > w.txt && echo "--plain--" && node -e "1"`),
    ],
  },
  {
    id: 'j13-git-diff-subst',
    steps: ({ proj }) => [
      exec(
        `cd ${q(proj)} && git diff --stat -- README.md && echo "unchanged: $(git diff --quiet -- README.md && echo yes)"`
      ),
    ],
  },
];

/** Same `cd <root>`, but the command really writes git internals. */
const RED = {
  id: 'git-config-write-after-cd',
  steps: ({ proj }) => [
    exec(`cd ${q(proj)} && node -e "require('fs').writeFileSync('.git/config','x')"`),
  ],
};

const GIT_INTERNALS = /git repository internals|git 仓库内部文件/;

let pass = 0;
const failures = [];
async function check(fn, name) {
  try {
    await fn();
    pass += 1;
    console.log(`ok - ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`not ok - ${name}: ${err?.message ?? err}`);
  }
}
const resultOf = (r) =>
  r.out
    .trim()
    .split('\n')
    .filter((l) => l.startsWith('{'))
    .map((l) => JSON.parse(l))
    .filter((e) => e.type === 'result')
    .pop();

for (const c of GREEN) {
  for (const lang of ['zh', 'en']) {
    await check(async () => {
      const r = await scenario({ lang, gitInit: true, steps: c.steps, finalText: CLAIM[lang] });
      const ctx = `last=${r.last}\n${r.err.slice(-600)}`;
      assert.equal(r.code, 0, `exit 0, got ${r.code}; ${ctx}`);
      assert.doesNotMatch(r.last, /未完成|被拦|Incomplete|Blocked by/, ctx);
      assert.doesNotMatch(r.err + r.out, GIT_INTERNALS, ctx);
    }, `[${lang}] ${c.id}: cd <root> verification → exit 0, no git-internals label`);
    await check(async () => {
      const r = await scenario({
        lang,
        gitInit: true,
        steps: c.steps,
        finalText: CLAIM[lang],
        json: true,
      });
      const res = resultOf(r);
      assert.ok(res, `result event; err=${r.err.slice(-300)}`);
      assert.equal(r.code, 0, `exit 0, got ${r.code}; ${JSON.stringify(res).slice(0, 400)}`);
      assert.equal(res.subtype, 'success', JSON.stringify(res).slice(0, 400));
      assert.equal(res.is_error, false);
    }, `[${lang}] ${c.id}: json result is success (consistent with exit 0)`);
  }
}

for (const lang of ['zh', 'en']) {
  await check(async () => {
    const r = await scenario({ lang, gitInit: true, steps: RED.steps, finalText: CLAIM[lang] });
    const ctx = `last=${r.last}\n${r.err.slice(-600)}`;
    assert.equal(r.code, 9, `exit 9, got ${r.code}; ${ctx}`);
    assert.match(r.last, lang === 'zh' ? /^未完成.*被拦/ : /^Incomplete.*Blocked by/, ctx);
    assert.match(r.last, /\.git/, ctx);
    assert.doesNotMatch(r.gitConfig ?? '', /^x$/, '.git/config not overwritten');
  }, `[${lang}] ${RED.id}: real .git write after cd <root> → still exit 9 被拦`);
}

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
