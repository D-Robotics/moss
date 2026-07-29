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
      name: 'rdk-doc-finder',
      sourcePath: path.join(here, '..', 'assets', 'rdk-knowledge', 'skills', 'rdk-doc-finder', 'SKILL.md'),
      description: '', trigger: [], tags: [], version: '0', risk: 'low', runtimePolicy: {}, updatedAt: 0,
    },
  ];
  const reg2 = ContractRegistry.fromSkills(skills);
  assert.equal(reg2.size(), 1, '只 rdk-board-knowledge 有契约');
  assert.ok(reg2.findByTool('device_exec'));
  assert.equal(reg2.findByTool('exec'), undefined, 'rdk-doc-finder 无契约 → exec 不被覆盖');
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

// ─── 6. 3 个真实契约端到端:各覆盖各自工具 + device_exec 多覆盖 ────────────
{
  const skills = ['rdk-board-knowledge', 'rdk-device', 'rdk-ros', 'rdk-doc-finder'].map((n) => ({
    name: n,
    sourcePath: path.join(here, '..', 'assets', 'rdk-knowledge', 'skills', n, 'SKILL.md'),
    description: '', trigger: [], tags: [], version: '0', risk: 'low', runtimePolicy: {}, updatedAt: 0,
  }));
  const reg4 = ContractRegistry.fromSkills(skills);
  assert.equal(reg4.size(), 3, '3 个契约加载(rdk-doc-finder 无 → 跳过)');

  // 各自工具反查
  assert.ok(reg4.findByTool('ros2_topic_hz'), 'rdk-ros 覆盖 ros2_topic_hz');
  assert.ok(reg4.findByTool('ros2_node_list'));
  assert.ok(reg4.findByTool('ros2_topic_echo') === undefined, 'rdk-ros 没声明 ros2_topic_echo');

  // device_exec 被 rdk-board-knowledge + rdk-device 都声明 → 第一个(board-knowledge)胜出
  const de = reg4.findByTool('device_exec');
  assert.ok(de);
  assert.equal(de.skillName, 'rdk-board-knowledge', 'device_exec 多覆盖:先注册的 rdk-board-knowledge 胜出');
}
console.log('✓ 3 真实契约端到端: 各工具反查 + device_exec 多覆盖第一个胜出');

// ─── 7. 多覆盖按 input.command 区分(核心:expectedCommandPattern)──────────
{
  const skills = ['rdk-board-knowledge', 'rdk-device', 'rdk-ros'].map((n) => ({
    name: n,
    sourcePath: path.join(here, '..', 'assets', 'rdk-knowledge', 'skills', n, 'SKILL.md'),
    description: '', trigger: [], tags: [], version: '0', risk: 'low', runtimePolicy: {}, updatedAt: 0,
  }));
  const reg5 = ContractRegistry.fromSkills(skills);
  assert.equal(reg5.coverage('device_exec'), 3, 'device_exec 被 3 契约覆盖');

  // device_exec 跑 hb_mapper → 命中 rdk-device(pattern)
  let f = reg5.findByTool('device_exec', { command: 'hb_mapper onnx2bin ...' });
  assert.equal(f.skillName, 'rdk-device', 'command=hb_mapper → rdk-device');

  // device_exec 跑 ros2 launch → 命中 rdk-ros(pattern)
  f = reg5.findByTool('device_exec', { command: 'ros2 launch pkg node.py' });
  assert.equal(f.skillName, 'rdk-ros', 'command=ros2 launch → rdk-ros');

  // device_exec 跑 xburn(无 pattern 匹配)→ 兜底 rdk-board-knowledge(无 pattern)
  f = reg5.findByTool('device_exec', { command: 'xburn --flash image.bin' });
  assert.equal(f.skillName, 'rdk-board-knowledge', 'command=xburn 无 pattern 匹配 → 兜底 board-knowledge');

  // device_exec 不传 command → 兜底(无 pattern 的 board-knowledge)
  f = reg5.findByTool('device_exec');
  assert.equal(f.skillName, 'rdk-board-knowledge', '无 command → 兜底无 pattern 契约');

  // device_exec 传非 command input → 兜底
  f = reg5.findByTool('device_exec', { path: '/x' });
  assert.equal(f.skillName, 'rdk-board-knowledge', '无 command 字段 → 兜底');

  // 专属工具(只有 rdk-ros 声明)→ 直接命中,不走 command
  f = reg5.findByTool('ros2_topic_hz');
  assert.equal(f.skillName, 'rdk-ros', '专属工具 ros2_topic_hz → rdk-ros');
}
console.log('✓ 多覆盖按 input.command 区分:hb_mapper→device / ros2→ros / xburn→兜底');

// ─── 8. 新增 3 契约(llm/system-config/peripheral)command 区分 ───────────────
{
  const skills = ['rdk-board-knowledge', 'rdk-device', 'rdk-ros', 'rdk-llm-deployment', 'rdk-system-config', 'rdk-peripheral-cookbook'].map((n) => ({
    name: n,
    sourcePath: path.join(here, '..', 'assets', 'rdk-knowledge', 'skills', n, 'SKILL.md'),
    description: '', trigger: [], tags: [], version: '0', risk: 'low', runtimePolicy: {}, updatedAt: 0,
  }));
  const reg6 = ContractRegistry.fromSkills(skills);
  assert.equal(reg6.size(), 6, '6 契约加载');
  assert.equal(reg6.coverage('device_exec'), 6, 'device_exec 被 6 契约覆盖(全靠 command 区分)');

  // 各 command 命中正确契约,不串
  const cases = [
    ['llama --model model.gguf', 'rdk-llm-deployment'],
    ['nmcli dev wifi connect xxx', 'rdk-system-config'],
    ['gpiodget gpiochip0 23', 'rdk-peripheral-cookbook'],
    ['i2cdetect -y 0', 'rdk-peripheral-cookbook'],
    ['hb_mapper quantiz', 'rdk-device'],
    ['ros2 launch pkg node', 'rdk-ros'],
    ['xburn --flash img.bin', 'rdk-board-knowledge'], // 兜底
    ['echo hello', 'rdk-board-knowledge'], // 无 pattern 匹配 → 兜底
  ];
  for (const [cmd, expectedSkill] of cases) {
    const f = reg6.findByTool('device_exec', { command: cmd });
    assert.ok(f, `command 有契约命中: ${cmd}`);
    assert.equal(f.skillName, expectedSkill, `command="${cmd}" → ${expectedSkill}(不串)`);
  }
}
console.log('✓ 6 契约端到端: device_exec 6 覆盖,8 command 各命中正确契约不串');

// ─── 9. 新增 4 契约(model-zoo/multimedia/embodied-lerobot/rk)command 路由 ────
{
  const all = ['rdk-board-knowledge', 'rdk-device', 'rdk-ros', 'rdk-llm-deployment', 'rdk-system-config', 'rdk-peripheral-cookbook', 'rdk-model-zoo', 'rdk-multimedia', 'rdk-embodied-lerobot', 'rk-knowledge', 'rdk-board-delegate', 'rdk-accessories'].map((n) => ({
    name: n,
    sourcePath: path.join(here, '..', 'assets', 'rdk-knowledge', 'skills', n, 'SKILL.md'),
    description: '', trigger: [], tags: [], version: '0', risk: 'low', runtimePolicy: {}, updatedAt: 0,
  }));
  const reg = ContractRegistry.fromSkills(all);
  assert.equal(reg.size(), 12, '12 契约加载(6 原有 + 6 新增)');
  assert.equal(reg.coverage('device_exec'), 12, 'device_exec 被 12 契约覆盖(全靠 command 区分)');

  // 新增 6 契约各按真实 command 命中、不串到别的契约(pattern 用各自独有二进制,互斥)
  const cases = [
    ['./sample_codec -t 1 -i input.h264', 'rdk-multimedia'],
    ['sp_dev --pipe 0 --fps', 'rdk-multimedia'],
    ['python branch_selector.py --board x5', 'rdk-model-zoo'],
    ['hbmrun --model model.hbm', 'rdk-model-zoo'],
    ['python3 /app/pydev_demo/07_yolov5_sample/test_yolov5.py', 'rdk-model-zoo'],
    ['./bpu_control_robot --policy policy.hbm', 'rdk-embodied-lerobot'],
    ['bash build_all.sh', 'rdk-embodied-lerobot'],
    ['python3 -c "from rknn_toolkit_lite2 import ..."', 'rk-knowledge'],
    ['./rknn_infer --rknn model.rknn', 'rk-knowledge'],
    ['echo /sys/class/remoteproc/remoteproc0/firmware', 'rdk-board-delegate'],
    ['ethercat master', 'rdk-board-delegate'],
    ['iio_attr -c -o imu0', 'rdk-accessories'],
    ['./rdk-imu-module-sdk read', 'rdk-accessories'],
  ];
  for (const [cmd, expectedSkill] of cases) {
    const f = reg.findByTool('device_exec', { command: cmd });
    assert.ok(f, `command 有契约命中: ${cmd}`);
    assert.equal(f.skillName, expectedSkill, `command="${cmd}" → ${expectedSkill}(不串)`);
  }
}
console.log('✓ 12 契约端到端: 新增 6 契约按真实 command 各命中正确契约不串');

console.log('\n✅ contract-registry T3.1 全部通过(9/9)');
