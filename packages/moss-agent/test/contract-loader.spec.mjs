#!/usr/bin/env node
/**
 * contract-loader — T3.1 契约加载器验证。
 *
 * 用真实的 rdk-board-knowledge/ACCEPTANCE.yaml 验解析器 + 白名单 + 类型校验。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAcceptanceContract, loadAcceptanceContracts } from '../dist/acceptance/contract-loader.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const skillDir = path.join(here, '..', 'assets', 'rdk-knowledge', 'skills', 'rdk-board-knowledge');
const contractPath = path.join(skillDir, 'ACCEPTANCE.json');

// ─── 1. 解析真实 ACCEPTANCE.json ─────────────────────────────────────────────
const text = fs.readFileSync(contractPath, 'utf-8');
const contract = parseAcceptanceContract(text, contractPath);
assert.ok(contract, 'contract parsed');
assert.equal(contract.skillName, 'rdk-board-knowledge');
assert.equal(contract.version, '1');
console.log('✓ 解析 rdk-board-knowledge/ACCEPTANCE.yaml 成 contract');

// ─── 2. postconditions 非空,3 个谓词 ────────────────────────────────────────
assert.equal(contract.postconditions.length, 3);
assert.deepEqual(
  contract.postconditions.map((p) => p.name),
  ['exit_code_zero', 'process_running', 'file_exist'],
);
console.log('✓ postconditions: 3 个白名单谓词');

// ─── 3. params 类型与值正确 ──────────────────────────────────────────────────
const pc0 = contract.postconditions[0];
assert.ok(pc0);
assert.equal(pc0.name, 'exit_code_zero');
assert.deepEqual(pc0.params, {});

const procRunning = contract.postconditions[1];
assert.ok(procRunning);
assert.equal(procRunning.name, 'process_running');
assert.equal(procRunning.params.pattern, 'hbmitools');

const fileExist = contract.postconditions[2];
assert.ok(fileExist);
assert.equal(fileExist.name, 'file_exist');
assert.equal(fileExist.params.path, '/userdata/log/flash.log');
console.log('✓ params 类型与值正确(标量/map/字符串/数字)');

// ─── 4. preconditions + safetyConstraints 都解析了 ──────────────────────────
assert.ok(contract.preconditions?.length === 1);
const pre0 = contract.preconditions[0];
assert.ok(pre0);
assert.equal(pre0.name, 'file_exist');
assert.equal(pre0.params.path, '/userdata/model.bin');

assert.ok(contract.safetyConstraints?.length === 1);
const sc = contract.safetyConstraints[0];
assert.ok(sc);
assert.equal(sc.name, 'force_below');
assert.equal(sc.params.threshold_n, 50); // 数字类型
assert.equal(sc.params.source, 'current'); // 字符串
console.log('✓ preconditions + safetyConstraints 解析正确(含数字/字符串 params)');

// ─── 5. 非白名单谓词被拒 ─────────────────────────────────────────────────────
{
  const bad = parseAcceptanceContract(
    JSON.stringify({ skillName: 'bad', version: '1', postconditions: [{ name: 'deploy_success', params: {} }] }),
    'bad.json',
  );
  assert.equal(bad, null, '非白名单谓词 deploy_success 被拒');
}
console.log('✓ 非白名单谓词被拒(D5:谓词名 World 只读)');

// ─── 6. 无 params 被拒 ──────────────────────────────────────────────────────
{
  const bad = parseAcceptanceContract(
    JSON.stringify({ skillName: 'bad', version: '1', postconditions: [{ name: 'file_exist' }] }),
    'bad.json',
  );
  assert.equal(bad, null, '缺 params 被拒');
}
console.log('✓ 无 params 的谓词被拒');

// ─── 7. loadAcceptanceContracts 从 SkillRegistry-like 列表加载 ──────────────
{
  const skills = [
    {
      name: 'rdk-board-knowledge',
      sourcePath: path.join(skillDir, 'SKILL.md'),
      description: '',
      trigger: [],
      tags: [],
      version: '0',
      risk: 'low',
      runtimePolicy: {},
      updatedAt: 0,
    },
    {
      name: 'rdk-device',
      sourcePath: path.join(here, '..', 'assets', 'rdk-knowledge', 'skills', 'rdk-device', 'SKILL.md'),
      description: '',
      trigger: [],
      tags: [],
      version: '0',
      risk: 'low',
      runtimePolicy: {},
      updatedAt: 0,
    },
  ];
  const contracts = loadAcceptanceContracts(skills);
  assert.equal(contracts.size, 1, '只有 rdk-board-knowledge 有契约(rdk-device 无 → 跳过不报错)');
  const loaded = contracts.get('rdk-board-knowledge');
  assert.ok(loaded);
  assert.equal(loaded.skillName, 'rdk-board-knowledge');
}
console.log('✓ loadAcceptanceContracts: 有契约加载、无契约跳过不报错');

console.log('\n✅ contract-loader T3.1 全部通过(7/7)');
