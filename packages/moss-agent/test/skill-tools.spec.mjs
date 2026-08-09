#!/usr/bin/env node
/**
 * load_skill + skill index + SkillHub helpers — Claude/Grok Skill tool parity.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { SkillRegistry } = await import(pathToFileURL(path.join(root, 'dist/skills/index.js')).href);
const { buildSkillIndexContext } = await import(
  pathToFileURL(path.join(root, 'dist/cli/tui-utils.js')).href
);
const { loadSkillTool, skillhubSearchTool, skillhubInstallTool } = await import(
  pathToFileURL(path.join(root, 'dist/tools/skill-tools.js')).href
);
const {
  skillHubSearch,
  skillHubInstall,
  ensureSkillHubCli,
  resetSkillHubEnsureForTests,
  skillHubInstallHint,
} = await import(pathToFileURL(path.join(root, 'dist/skills/skillhub.js')).href);

function ctx(workspaceDir) {
  return {
    workspaceDir,
    sessionKey: 'test',
  };
}

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-skill-tools-'));
try {
  // ── load_skill lists builtins ──────────────────────────────────────────
  const listOut = await loadSkillTool.execute({ list: true }, ctx(ws));
  assert.match(listOut, /Local skills \(/);
  assert.match(listOut, /code-review/);
  assert.match(listOut, /load_skill/);

  // ── load_skill loads a builtin body ────────────────────────────────────
  const loaded = await loadSkillTool.execute({ name: 'code-review' }, ctx(ws));
  assert.match(loaded, /<skill name="code-review"/);
  assert.match(loaded, /severity/i);
  assert.match(loaded, /Follow the skill instructions/);

  // ── unknown skill surfaces similar + skillhub tip ──────────────────────
  const missing = await loadSkillTool.execute({ name: 'definitely-not-a-skill-xyz' }, ctx(ws));
  assert.match(missing, /not found/i);
  assert.match(missing, /skillhub_search/);

  // ── workspace skill is discoverable after install_skill-style write ────
  const skillDir = path.join(ws, '.moss', 'skills', 'my-board-loop');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    `---
name: my-board-loop
description: Loop ROS diagnostics on RDK boards
tags: ros2, rdk
trigger: board-loop
---

# Board loop
1. Connect to the board
2. Check ros2 topic list
`,
    'utf8'
  );
  const board = await loadSkillTool.execute({ name: 'my-board-loop' }, ctx(ws));
  assert.match(board, /Board loop/);
  assert.match(board, /ros2 topic list/);

  // ── filter list by query ───────────────────────────────────────────────
  const filtered = await loadSkillTool.execute({ list: true, query: 'board-loop' }, ctx(ws));
  assert.match(filtered, /my-board-loop/);

  // ── always-on skill index is compact and actionable ────────────────────
  const registry = new SkillRegistry({ workspaceDir: ws });
  const index = buildSkillIndexContext(registry);
  assert.match(index, /## Skills index/);
  assert.match(index, /load_skill/);
  assert.match(index, /skillhub_search/);
  assert.match(index, /my-board-loop|code-review/);
  assert.ok(index.length < 12_000, `skill index should stay compact, got ${index.length}`);

  // Budget: force tiny budget truncates with "more"
  const tiny = buildSkillIndexContext(registry, { charBudget: 400, maxDescChars: 40 });
  assert.match(tiny, /Skills index/);
  assert.ok(tiny.length <= 500, `tiny budget respected, got ${tiny.length}`);

  // ── skillhub helpers with injected runner (no network, no CLI required) ─
  const searchResult = await skillHubSearch('ros2', {
    run: async () => ({
      stdout: JSON.stringify({
        query: 'ros2',
        count: 1,
        results: [
          {
            slug: 'ros2-debug',
            name: 'ROS2 Debug',
            description: 'Debug ROS2 on device',
            version: '1.0.0',
            source: 'community',
          },
        ],
      }),
      stderr: '',
      exitCode: 0,
    }),
  });
  assert.equal(searchResult.ok, true);
  if (searchResult.ok) {
    assert.equal(searchResult.hits[0]?.slug, 'ros2-debug');
    assert.match(searchResult.hits[0]?.description ?? '', /ROS2/);
  }

  // Install with mock runner that plants a SKILL.md
  const installResult = await skillHubInstall('ros2-debug', {
    workspaceDir: ws,
    run: async (_cmd, args) => {
      const dirFlag = args.indexOf('--dir');
      const skillsDir = dirFlag >= 0 ? args[dirFlag + 1] : path.join(ws, '.moss', 'skills');
      const target = path.join(skillsDir, 'ros2-debug');
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(path.join(target, 'SKILL.md'), '---\nname: ros2-debug\n---\n# Debug ROS2\n');
      return { stdout: 'ok', stderr: '', exitCode: 0 };
    },
  });
  assert.equal(installResult.ok, true);
  if (installResult.ok) {
    assert.match(installResult.message, /load_skill/);
    assert.match(
      installResult.message,
      /Install only writes SKILL\.md|inject instructions for this turn/i
    );
    const loadedHub = await loadSkillTool.execute({ name: 'ros2-debug' }, ctx(ws));
    assert.match(loadedHub, /Debug ROS2/);
  }

  // skillhub tools refuse empty slug / query
  const emptyInstall = await skillhubInstallTool.execute({ slug: '' }, ctx(ws));
  assert.match(emptyInstall, /required|invalid|SkillHub/i);

  const emptySearch = await skillhubSearchTool.execute({ query: '   ' }, ctx(ws));
  assert.match(emptySearch, /required|SkillHub|install/i);

  // If CLI is available, live search should return structured hits
  const live = await skillhubSearchTool.execute({ query: 'coding', limit: 3 }, ctx(ws));
  if (!/not installed|install\.sh/i.test(live)) {
    assert.match(live, /SkillHub results|coding/i);
  }

  // ── ensureSkillHubCli: mock installer path ─────────────────────────────
  resetSkillHubEnsureForTests();
  // When CLI is already available, ensure is a no-op success.
  const ensureWhenPresent = await ensureSkillHubCli({
    run: async () => {
      throw new Error('installer must not run when CLI already present');
    },
  });
  // Either CLI is present (ok) or ensure runs mock and fails/succeeds —
  // if CLI present on this machine, run must not be called.
  if (ensureWhenPresent.ok) {
    assert.equal(ensureWhenPresent.installed, false);
    assert.ok(ensureWhenPresent.command.includes('skillhub'));
  }

  // Install hint always mentions skillhub.cn guide
  assert.match(skillHubInstallHint(), /skillhub\.cn\/install\/skillhub\.md/);
  assert.match(skillHubInstallHint(), /--cli-only/);

  console.error('skill-tools: load_skill + skill index + skillhub tools ✓');
} finally {
  fs.rmSync(ws, { recursive: true, force: true });
}

// prioritizePrefixes floats robotics skills when board-connected
{
  const registry = new SkillRegistry({ workspaceDir: ws });
  const withPri = buildSkillIndexContext(registry, {
    prioritizePrefixes: ['rdk-', 'ros'],
    charBudget: 2_500,
  });
  assert.match(withPri, /Board connected: RDK\/ROS/);
  // First listed skill entry (line starting with `- `) should be rdk-* / ros*
  // when board-connected prioritization is on. The `…and N more` summary line
  // does not start with `- `, so it is already excluded by the prefix filter.
  const firstSkill = withPri.split('\n').find((l) => l.startsWith('- '));
  assert.ok(firstSkill, 'has a skill line');
  assert.match(firstSkill, /^- rdk-|^- ros/i);
  console.error('skill-tools: board-connected skill index prioritization ✓');
}
