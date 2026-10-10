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
  const { loadSkills } = await import(
    pathToFileURL(
      path.join(ws, 'node_modules', 'moss', 'dist', 'core', 'skills', 'skill-registry.js')
    ).href
  );
  const skills = loadSkills([path.join(ws, '.moss', 'skills')]);
  const found = skills.find((s) => s.name === 'robot-check');
  if (!found) problems.push('skill not discovered by loadSkills');
  else if (!found.description.includes('robot subsystem')) {
    problems.push('discovered description mismatch');
  }
  // 3. Injection contract: calling the tool with args replaces placeholders.
  if (found) {
    const { createSkillTool } = await import(
      pathToFileURL(path.join(ws, 'node_modules', 'moss', 'dist', 'tools', 'skill-tool.js')).href
    );
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
