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
      name: 'rdk-doc-finder',
      sourcePath: path.join(here, '..', 'assets', 'rdk-knowledge', 'skills', 'rdk-doc-finder', 'SKILL.md'),
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
  assert.equal(contracts.size, 1, '只有 rdk-board-knowledge 有契约(rdk-doc-finder 无 → 跳过不报错)');
  const loaded = contracts.get('rdk-board-knowledge');
  assert.ok(loaded);
  assert.equal(loaded.skillName, 'rdk-board-knowledge');
}
console.log('✓ loadAcceptanceContracts: 有契约加载、无契约跳过不报错');

// ─── 8. 批量补的 6 个新契约(rdk-model-zoo/multimedia/embodied-lerobot/rk-knowledge/board-delegate/accessories) ─
// 只给真跑板端命令、有可验证硬信号(退出码/产物/FPS)的 skill 配契约。纯知识/选型类
// (doc-finder/source-map/command-manual/ecosystem/hardware/jetson/rpi/host-software-dev)不配
// —— 它们调 read_file/search 无硬信号,套契约会把"读到文件"误当"任务完成",违背 D5 可信根。
{
  const skillsRoot = path.join(here, '..', 'assets', 'rdk-knowledge', 'skills');
  const newOnes = ['rdk-model-zoo', 'rdk-multimedia', 'rdk-embodied-lerobot', 'rk-knowledge', 'rdk-board-delegate', 'rdk-accessories'];
  const skills = newOnes.map((name) => ({
    name,
    sourcePath: path.join(skillsRoot, name, 'SKILL.md'),
    description: '', trigger: [], tags: [], version: '0', risk: 'low', runtimePolicy: {}, updatedAt: 0,
  }));
  const contracts = loadAcceptanceContracts(skills);
  assert.equal(contracts.size, 6, '6 个新 skill 都应有契约');

  // rdk-model-zoo:跑现成 .bin/.hbm sample,exit_code_zero + stdout_matches(推理结果 bbox/score/name)
  const mz = contracts.get('rdk-model-zoo');
  assert.ok(mz);
  assert.deepEqual(mz.expectedTools, ['device_exec']);
  assert.ok(mz.expectedCommandPattern?.includes('hb_mapper'), 'model-zoo pattern 应含 hb_mapper(branch_selector/hbmrun 等独有二进制)');
  assert.ok(mz.expectedCommandPattern?.includes('pydev_demo'), 'model-zoo pattern 应含 pydev_demo(真机 python3 /app/pydev_demo/NN_sample 命令锚定)');
  assert.ok(mz.postconditions.some((p) => p.name === 'exit_code_zero'));
  assert.ok(mz.postconditions.some((p) => p.name === 'stdout_matches'), 'model-zoo 应有 stdout_matches(验推理输出 bbox/score/name)');

  // rdk-multimedia:硬件编解码 sp_dev/cdev_demo/sample_codec,exit + stdout_matches(帧/分辨率)
  const mm = contracts.get('rdk-multimedia');
  assert.ok(mm);
  assert.ok(mm.postconditions.some((p) => p.name === 'exit_code_zero'));
  assert.ok(mm.postconditions.some((p) => p.name === 'stdout_matches'));

  // rdk-embodied-lerobot:ACT/Pi0 上板 bpu_control_robot/build_all,exit + 产物 .hbm
  const el = contracts.get('rdk-embodied-lerobot');
  assert.ok(el);
  assert.ok(el.postconditions.some((p) => p.name === 'exit_code_zero'));
  assert.ok(el.postconditions.some((p) => p.name === 'file_exist'));

  // rk-knowledge:RKNN 推理 rknn/librknnrt,exit + stdout_matches(输出张量/推理结果)
  const rk = contracts.get('rk-knowledge');
  assert.ok(rk);
  assert.ok(rk.postconditions.some((p) => p.name === 'exit_code_zero'));
  assert.ok(rk.postconditions.some((p) => p.name === 'stdout_matches'));

  // rdk-board-delegate:S 系 MCU 固件/remoteproc/EtherCAT,exit + stdout_matches(loaded/ready)
  const bd = contracts.get('rdk-board-delegate');
  assert.ok(bd);
  assert.ok(bd.postconditions.some((p) => p.name === 'exit_code_zero'));
  assert.ok(bd.postconditions.some((p) => p.name === 'stdout_matches'));

  // rdk-accessories:官方外设 SDK bring-up,exit + stdout_matches(IMU/相机数据)
  const ac = contracts.get('rdk-accessories');
  assert.ok(ac);
  assert.ok(ac.postconditions.some((p) => p.name === 'exit_code_zero'));
  assert.ok(ac.postconditions.some((p) => p.name === 'stdout_matches'));
}
console.log('✓ 6 个新契约加载正确(model-zoo/multimedia/embodied-lerobot/rk-knowledge/board-delegate/accessories)');

console.log('\n✅ contract-loader T3.1 全部通过(8/8)');
