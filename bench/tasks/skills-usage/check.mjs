#!/usr/bin/env node
/**
 * skills-usage acceptance: the scaffold exists with a real description, a
 * $ARGUMENTS-using body, the skill list names it, and a probe proves the
 * tool-level injection contract (placeholders never leak to the model).
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const problems = [];
const ws = process.cwd();

// Where is the Moss build under test? The workspace has no node_modules/moss,
// so resolve it from the runner instead:
//   1. MOSS_BENCH_MOSS_ROOT (package root that contains dist/), or
//   2. dirname(dirname(MOSS_BENCH_CLI)) when the runner names its dist/cli.js, or
//   3. the repo that holds this task (bench/tasks/<id> -> ../../..), or
//   4. legacy ws/node_modules/moss.
const taskDir = process.env.MOSS_BENCH_TASK_DIR ?? path.dirname(new URL(import.meta.url).pathname);
const candidates = [
  process.env.MOSS_BENCH_MOSS_ROOT,
  process.env.MOSS_BENCH_CLI ? path.dirname(path.dirname(process.env.MOSS_BENCH_CLI)) : undefined,
  path.resolve(taskDir, '..', '..', '..'),
  path.join(ws, 'node_modules', 'moss'),
].filter(Boolean);
const mossRoot = candidates.find((c) =>
  fs.existsSync(path.join(c, 'dist', 'core', 'skills', 'skill-registry.js'))
);
if (!mossRoot) {
  console.error(
    'skills-usage CHECK-ENV-ERROR: Moss dist not found; set MOSS_BENCH_MOSS_ROOT. Tried: ' +
      candidates.join(', ')
  );
  process.exit(2);
}
const mossModule = (...p) => pathToFileURL(path.join(mossRoot, 'dist', ...p)).href;

// 1. The scaffold exists with a filled description.
const skillPath = path.join(ws, '.moss', 'skills', 'robot-check', 'SKILL.md');
if (!fs.existsSync(skillPath)) {
  problems.push('skill scaffold missing: .moss/skills/robot-check/SKILL.md');
} else {
  const text = fs.readFileSync(skillPath, 'utf8');
  if (!/description:\s*verify a robot subsystem is ready/.test(text)) {
    problems.push('description not set to the required line');
  }
  if (!text.includes('$ARGUMENTS')) {
    problems.push('body lost the $ARGUMENTS placeholder');
  }
  // 2. Discovery: loadSkills sees it.
  const { loadSkills } = await import(mossModule('core', 'skills', 'skill-registry.js'));
  const skills = loadSkills([path.join(ws, '.moss', 'skills')]);
  const found = skills.find((s) => s.name === 'robot-check');
  if (!found) problems.push('skill not discovered by loadSkills');
  else if (!found.description.includes('robot subsystem')) {
    problems.push('discovered description mismatch');
  }
  // 3. Injection contract: calling the tool with args replaces placeholders.
  if (found) {
    const { createSkillTool } = await import(mossModule('tools', 'skill-tool.js'));
    const tool = createSkillTool([found]);
    const loaded = await tool.execute({ name: 'robot-check', args: 'camera' }, {});
    if (String(loaded).includes('$ARGUMENTS')) {
      problems.push('placeholder leaked into the loaded body');
    }
    if (!String(loaded).includes('camera')) {
      problems.push('args value did not appear in the loaded body');
    }
  }
}

if (problems.length > 0) {
  console.error('skills-usage FAIL:');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log('skills-usage PASS: scaffold + discovery + args injection verified');
