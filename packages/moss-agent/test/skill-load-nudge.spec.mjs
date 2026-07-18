#!/usr/bin/env node
import assert from 'node:assert/strict';
import { evaluateSkillLoadNudge } from '../dist/core/loop/skill-load-nudge.js';

// No installs
{
  const r = evaluateSkillLoadNudge({
    toolCallsByName: { load_skill: 1 },
    attempts: 0,
  });
  assert.equal(r.fire, false);
}

// Install without load → fire
{
  const r = evaluateSkillLoadNudge({
    toolCallsByName: { skillhub_install: 1 },
    attempts: 0,
  });
  assert.equal(r.fire, true);
  assert.match(r.correction, /load_skill/i);
  assert.match(r.correction, /does \*\*not\*\* load|does not load|SKILL\.md/i);
}

// install_skill local path
{
  const r = evaluateSkillLoadNudge({
    toolCallsByName: { install_skill: 1, read_file: 2 },
    attempts: 0,
  });
  assert.equal(r.fire, true);
}

// Already loaded
{
  const r = evaluateSkillLoadNudge({
    toolCallsByName: { skillhub_install: 1, load_skill: 1 },
    attempts: 0,
  });
  assert.equal(r.fire, false);
}

// Once only
{
  const r = evaluateSkillLoadNudge({
    toolCallsByName: { skillhub_install: 1 },
    attempts: 1,
  });
  assert.equal(r.fire, false);
}

console.log('[PASS] skill-load-nudge');
