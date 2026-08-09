#!/usr/bin/env node
/**
 * Skill validation — content validation, template generation, frontmatter defaults.
 * Tests the core skill-lifecycle path: generate → validate → merge defaults.
 */
import assert from 'node:assert/strict';
import {
  validateSkillContent,
  generateSkillTemplate,
  mergeSkillFrontmatterDefaults,
} from '../dist/skill-learning/index.js';

// ─── 1. validateSkillContent — rejection paths ──────────────────────────────

{
  // Empty content
  const empty = validateSkillContent('');
  assert.equal(empty.valid, false, 'empty content is invalid');
  assert.ok(empty.errors.length > 0, 'empty content has errors');

  // Missing frontmatter entirely
  const noFm = validateSkillContent('Just some body text without frontmatter.');
  assert.equal(noFm.valid, false, 'missing frontmatter is invalid');

  // Missing required fields
  const missingFields = validateSkillContent(`---
name: test-skill
description: too short
---
Body text here.`);
  assert.ok(missingFields.errors.length > 0, 'missing fields produce errors');
  assert.ok(
    missingFields.errors.some((e) => e.includes('version')),
    'version is flagged as missing'
  );

  // Invalid risk value
  const badRisk = validateSkillContent(`---
name: test-skill
description: A sufficiently long description for testing
version: 1.0.0
trigger: test,测试
risk: extreme
permissions: workspace_read
delegate_preference: local
requires_board: false
approval_level: none
cooldown_seconds: 0
scheduler_template: none
category: test
---
## 执行流程
1. Do something
2. Verify result`);
  assert.equal(badRisk.valid, false, 'invalid risk value is rejected');
  assert.ok(
    badRisk.errors.some((e) => e.includes('risk')),
    'risk error message present'
  );
}

// ─── 2. validateSkillContent — valid skill with warnings ─────────────────────

{
  const valid = validateSkillContent(`---
name: deploy-model
description: Deploys a model to RDK board when user asks for deployment
version: 1.0.0
trigger: deploy,部署
risk: low
permissions: workspace_read
delegate_preference: local
requires_board: true
approval_level: confirm
cooldown_seconds: 0
scheduler_template: none
category: deployment
---
## 执行流程
1. Connect to device
2. Copy model file
3. Run deployment command
4. Verify deployment`);

  assert.equal(valid.valid, true, 'well-formed skill is valid');
  assert.equal(valid.errors.length, 0, 'no errors for valid skill');

  // Legacy approval_level alias produces warning
  const legacy = validateSkillContent(`---
name: legacy-skill
description: A sufficiently long description for the legacy skill test
version: 1.0.0
trigger: legacy,遗留
risk: medium
permissions: workspace_read
delegate_preference: local
requires_board: false
approval_level: auto
cooldown_seconds: 0
scheduler_template: none
category: test
---
## 执行流程
1. Do something`);
  assert.equal(legacy.valid, true, 'legacy alias is still valid');
  assert.ok(
    legacy.warnings.some((w) => w.includes('auto')),
    'legacy alias produces warning'
  );
}

// ─── 3. generateSkillTemplate → validate round-trip ─────────────────────────

{
  const template = generateSkillTemplate({
    name: 'gpio-setup',
    description: 'Configures GPIO pins on RDK board when user needs peripheral setup',
    category: 'peripheral',
    requiresBoard: true,
    triggers: ['gpio', 'GPIO', '引脚'],
    risk: 'low',
    permissions: ['workspace_read', 'device_exec'],
    delegatePreference: 'board',
  });

  assert.ok(template.includes('---'), 'template has frontmatter delimiter');
  assert.ok(template.includes('name: gpio-setup'), 'template has skill name');
  assert.ok(template.includes('requires_board: true'), 'template has board requirement');
  assert.ok(template.includes('## 执行流程'), 'template has workflow section');

  // Generated template should pass validation
  const result = validateSkillContent(template);
  assert.equal(result.valid, true, 'generated template is valid');
  assert.equal(result.errors.length, 0, 'no errors in generated template');
}

// ─── 4. mergeSkillFrontmatterDefaults — fills missing fields ────────────────

{
  // Content with no frontmatter at all — defaults should be applied
  const noFm = mergeSkillFrontmatterDefaults('Some body text', { skillId: 'my-skill' });
  assert.ok(noFm.startsWith('---\n'), 'frontmatter added');
  assert.ok(noFm.includes('name: my-skill'), 'name defaults to skillId');
  assert.ok(noFm.includes('version: 1.0.0'), 'version defaults to 1.0.0');
  assert.ok(noFm.includes('risk: low'), 'risk defaults to low');

  // Content with partial frontmatter — existing values preserved, missing filled
  const partial = mergeSkillFrontmatterDefaults(
    `---
name: custom-name
description: A custom skill description that is long enough
---
Body here`,
    { skillId: 'my-skill' }
  );
  assert.ok(partial.includes('name: custom-name'), 'existing name preserved');
  assert.ok(partial.includes('version: 1.0.0'), 'missing version filled with default');

  // Short description gets extended
  const shortDesc = mergeSkillFrontmatterDefaults(
    `---
name: short
description: too short
---
Body`,
    { skillId: 'short' }
  );
  assert.ok(
    shortDesc.includes('请补充') || shortDesc.includes('Imported workspace'),
    'short description gets extended or replaced with default'
  );
}

// ─── 5. mergeSkillFrontmatterDefaults → validate round-trip ─────────────────

{
  const merged = mergeSkillFrontmatterDefaults(
    'Plain body content that describes what this skill does in detail',
    { skillId: 'round-trip' }
  );
  const result = validateSkillContent(merged);
  assert.equal(result.valid, true, 'merged output is valid');
}

console.log('✓ skill-validation.spec.mjs — all assertions passed');
