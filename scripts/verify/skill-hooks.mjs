#!/usr/bin/env node
/**
 * D11 skill-declared hooks probe.
 *
 * A skill ships `hooks: hooks.json` next to SKILL.md. Invoking the skill must
 * (1) activate those entries for the rest of the session, (2) run them through
 * the *real* hooks pipeline (matcher / if / deny), and (3) fail closed when the
 * file is missing, invalid, or points outside the skill directory.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '../..');
const registry = await import(
  pathToFileURL(path.join(root, 'dist/core/skills/skill-registry.js')).href
);
const toolModule = await import(
  pathToFileURL(path.join(root, 'dist/core/skills/skill-tool.js')).href
);
const hooksModule = await import(pathToFileURL(path.join(root, 'dist/cli/hooks.js')).href);
const hookAsk = await import(pathToFileURL(path.join(root, 'dist/cli/hook-ask.js')).href);
const state = await import(pathToFileURL(path.join(root, 'dist/core/skills/skill-hooks.js')).href);

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-skill-hooks-'));
const skillsDir = path.join(workspace, '.moss', 'skills');
const marker = path.join(workspace, 'post.marker');

let checks = 0;
const ok = (name) => {
  checks += 1;
  console.log(`[skill-hooks] ok ${name}`);
};

function writeSkill(name, { frontmatter, hooks, files = {} }) {
  const dir = path.join(skillsDir, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: probe skill ${name}\n${frontmatter ?? ''}---\n\n# ${name}\n\nBody for ${name}.\n`
  );
  if (hooks !== undefined) {
    fs.writeFileSync(
      path.join(dir, 'hooks.json'),
      typeof hooks === 'string' ? hooks : JSON.stringify(hooks, null, 2)
    );
  }
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(dir, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  return dir;
}

writeSkill('demo-guard', {
  frontmatter: 'hooks: hooks.json\n',
  hooks: {
    PreToolUse: [
      {
        matcher: 'exec',
        if: 'exec(rm *)',
        command: `${JSON.stringify(process.execPath)} -e "process.exit(2)"`,
      },
    ],
    PostToolUse: [
      {
        matcher: 'write_file',
        command: `${JSON.stringify(process.execPath)} -e "require('fs').writeFileSync('${marker}','post')"`,
      },
    ],
    Stop: [{ command: `${JSON.stringify(process.execPath)} -e "process.exit(1)"` }],
  },
});
writeSkill('missing-file', { frontmatter: 'hooks: nope.json\n' });
writeSkill('bad-json', { frontmatter: 'hooks: hooks.json\n', hooks: '{ not json' });
writeSkill('escape', { frontmatter: 'hooks: ../outside.json\n' });

const issues = [];
const skills = registry.loadSkills([skillsDir], { onIssue: (issue) => issues.push(issue) });
const byName = new Map(skills.map((skill) => [skill.name, skill]));

// 1. Frontmatter path lands on the manifest; unsafe paths are an issue, not a hook.
const demo = byName.get('demo-guard');
assert.ok(demo);
assert.equal(demo.hooks, 'hooks.json');
const escape = byName.get('escape');
assert.ok(escape);
assert.equal(escape.hooks, undefined);
assert.ok(escape.issues.some((issue) => issue.code === 'unsafe-hooks-path'));
ok('frontmatter hooks path parsed; escaping path rejected with an issue');

// 2. Invoking the skill activates hooks and tells the model (incl. dropped events).
const tool = toolModule.createSkillTool(skills);
const ctx = { workspaceDir: workspace, sessionKey: 'probe-session', runId: 'probe-run' };
const loaded = await tool.execute({ name: 'demo-guard' }, ctx);
assert.match(loaded, /# demo-guard/);
assert.match(loaded, /Body for demo-guard/);
assert.match(
  loaded,
  /Skill hooks active for the rest of this session: PreToolUse 1, PostToolUse 1\./
);
assert.match(loaded, /declares hooks for "Stop"[\s\S]*ignored/);
assert.deepEqual(state.activeSkillHookSkills(), ['demo-guard']);
ok('skill invocation activates hook entries and warns about dropped events');

// 3. The real pipeline runs them: deny on a matching exec, no effect elsewhere.
const configured = hooksModule.createConfiguredHookCallbacks(undefined, {
  workspaceDir: workspace,
});
const request = (toolName, input) => ({
  tool: { name: toolName },
  input,
  sessionKey: 'probe-session',
  runId: 'probe-run',
  toolCallId: 'call-1',
  abortSignal: new AbortController().signal,
});
const denied = await configured.onBeforeToolExec(request('exec', { command: 'rm -rf build' }));
assert.equal(denied.approved, false);
assert.match(denied.reason, /PreToolUse hook/);
const allowedIfMiss = await configured.onBeforeToolExec(request('exec', { command: 'ls -la' }));
assert.equal(allowedIfMiss.approved, true);
const allowedMatcherMiss = await configured.onBeforeToolExec(
  request('read_file', { path: 'README.md' })
);
assert.equal(allowedMatcherMiss.approved, true);
ok('PreToolUse skill hook blocks only the matching call');

// 4. A skill's PostToolUse hook runs through the real pipeline.
configured.onToolResult(
  { id: 'call-2', name: 'write_file', input: { path: marker } },
  { toolUseId: 'call-2', content: 'ok', isError: false }
);
// B236: the hook creates the file and writes it; polling only for existence
// could read it empty on a slow CI runner (shard 2 of run 42255871389).
let markerText = '';
for (let i = 0; i < 100; i += 1) {
  try {
    markerText = fs.readFileSync(marker, 'utf8');
  } catch {
    markerText = '';
  }
  if (markerText === 'post') break;
  await new Promise((resolve) => setTimeout(resolve, 20));
}
assert.equal(markerText, 'post');
ok('PostToolUse skill hook runs after the tool call');

// 5. Composition stays intact when no static pre hooks exist: the approval gate
//    still runs, and the dynamic entry can be removed by clearing state.
let approvals = 0;
const gate = hookAsk.composePreToolUseGate(configured.onBeforeToolExec, async () => {
  approvals += 1;
  return { approved: true };
});
assert.deepEqual(await gate(request('read_file', { path: 'a.ts' })), { approved: true });
assert.equal(approvals, 1);
state.clearSkillHookState();
approvals = 0;
const afterClear = await gate(request('exec', { command: 'rm -rf build' }));
assert.equal(afterClear.approved, true);
assert.equal(approvals, 1);
ok('gate composition unchanged; clearing state removes the dynamic hooks');

// 6. Fail closed: missing file, invalid JSON, and re-invocation replace state.
const missing = await tool.execute({ name: 'missing-file' }, ctx);
assert.match(missing, /was not loaded: hooks file "nope\.json" was declared but cannot be read/);
assert.doesNotMatch(missing, /Body for missing-file/);
const bad = await tool.execute({ name: 'bad-json' }, ctx);
assert.match(bad, /hooks file "hooks\.json" is not valid JSON/);
assert.doesNotMatch(bad, /Body for bad-json/);
assert.deepEqual(state.activeSkillHookSkills(), []);
ok('broken hooks files fail the skill load instead of loading without the guard');

console.log(`[skill-hooks] ${checks}/${checks} checks passed`);
