#!/usr/bin/env node
/**
 * contract-registry — T3.1 按 tool 反查契约(解 C)验证。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ContractRegistry } from '../dist/acceptance/contract-registry.js';
import { parseAcceptanceContract } from '../dist/acceptance/contract-loader.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const skillDir = path.join(here, '..', 'assets', 'rdk-knowledge', 'skills', 'rdk-board-knowledge');

// 用真实 rdk-board-knowledge 契约建 registry
const contract = parseAcceptanceContract(
  fs.readFileSync(path.join(skillDir, 'ACCEPTANCE.json'), 'utf-8'),
  path.join(skillDir, 'ACCEPTANCE.json'),
);
assert.ok(contract);

const reg = new ContractRegistry(new Map([['rdk-board-knowledge', contract]]));

// ─── 1. 按 tool 反查:device_exec → rdk-board-knowledge ─────────────────────
const found = reg.findByTool('device_exec');
assert.ok(found, 'device_exec 反查到契约');
assert.equal(found.skillName, 'rdk-board-knowledge');
console.log('✓ 按 tool 反查: device_exec → rdk-board-knowledge');

// ─── 2. 未覆盖的 tool 返回 undefined ────────────────────────────────────────
assert.equal(reg.findByTool('write_file'), undefined, 'write_file 未被契约覆盖');
assert.equal(reg.findByTool('exec'), undefined);
console.log('✓ 未覆盖的 tool 返回 undefined(退回 L2 通用判定)');

// ─── 3. findBySkill 按 skill 名取 ──────────────────────────────────────────
const bySkill = reg.findBySkill('rdk-board-knowledge');
assert.ok(bySkill);
assert.equal(bySkill.skillName, 'rdk-board-knowledge');
assert.equal(reg.findBySkill('nope'), undefined);
console.log('✓ findBySkill: 按 skill 名取');

// ─── 4. fromSkills 从 SkillMeta 列表建(端到端加载)────────────────────────
{
  const skills = [
    {
      name: 'rdk-board-knowledge',
      sourcePath: path.join(skillDir, 'SKILL.md'),
      description: '', trigger: [], tags: [], version: '0', risk: 'low', runtimePolicy: {}, updatedAt: 0,
    },
    {
      name: 'rdk-device',
      sourcePath: path.join(here, '..', 'assets', 'rdk-knowledge', 'skills', 'rdk-device', 'SKILL.md'),
      description: '', trigger: [], tags: [], version: '0', risk: 'low', runtimePolicy: {}, updatedAt: 0,
    },
  ];
  const reg2 = ContractRegistry.fromSkills(skills);
  assert.equal(reg2.size(), 1, '只 rdk-board-knowledge 有契约');
  assert.ok(reg2.findByTool('device_exec'));
  assert.equal(reg2.findByTool('exec'), undefined, 'rdk-device 无契约 → exec 不被覆盖');
}
console.log('✓ fromSkills: 端到端加载,无契约 skill 静默跳过');

// ─── 5. 多契约覆盖同 tool:第一个胜出(不覆盖,可审计)───────────────────────
{
  const c1 = { ...contract, skillName: 'skill-a', sourcePath: 'a', expectedTools: ['device_exec'] };
  const c2 = { ...contract, skillName: 'skill-b', sourcePath: 'b', expectedTools: ['device_exec'] };
  const reg3 = new ContractRegistry(new Map([['skill-a', c1], ['skill-b', c2]]));
  const f = reg3.findByTool('device_exec');
  assert.equal(f.skillName, 'skill-a', '先注册的 skill-a 胜出(不覆盖)');
}
console.log('✓ 多契约覆盖同 tool: 第一个胜出(可审计,后续可加优先级)');

console.log('\n✅ contract-registry T3.1 全部通过(5/5)');
