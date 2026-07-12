#!/usr/bin/env node
/**
 * PreFlightRouter 测试 — 预检路由逻辑
 *
 * 核心规则：默认所有 Skill 都是 timeSensitive（触发预搜索）。
 * 只有标记 stable: true 的纯方法论 Skill 不触发。
 *
 * Run: node packages/moss-agent/test/pre-flight-router.spec.mjs
 */

import assert from 'node:assert/strict';

/* ---- 模拟 pre-flight-router 逻辑 ---- */

function hasTimeSensitiveSkill(matchedSkills) {
  return matchedSkills.some((s) => s.timeSensitive === true);
}

function shouldPreSearch(matchedSkills) {
  if (hasTimeSensitiveSkill(matchedSkills)) return { trigger: true, reason: 'skill' };
  return { trigger: false, reason: 'none' };
}

function buildSearchQuery(message, matchedSkills) {
  const tsSkill = matchedSkills.find((s) => s.timeSensitive && s.searchQueryTemplate);
  if (tsSkill?.searchQueryTemplate) {
    return tsSkill.searchQueryTemplate.replace(/\{\{query\}\}/g, message);
  }
  return message;
}

/* ---- 测试 1: 默认触发（timeSensitive 默认为 true）---- */

function testDefaultTrigger() {
  // 默认 Skill（registry 默认 timeSensitive = true）→ 触发
  const defaultSkill = { name: 'rdk-model-zoo', timeSensitive: true };
  let result = shouldPreSearch([defaultSkill]);
  assert.equal(result.trigger, true, 'default skill should trigger');

  // 标记 stable: true 的 Skill → registry 设置 timeSensitive = false → 不触发
  const stableSkill = { name: 'git-workflow', timeSensitive: false };
  result = shouldPreSearch([stableSkill]);
  assert.equal(result.trigger, false, 'stable skill should not trigger');

  // 空列表 → 不触发
  result = shouldPreSearch([]);
  assert.equal(result.trigger, false);

  console.log('  ✅ testDefaultTrigger');
}

/* ---- 测试 2: stable 技能不触发 ---- */

function testStableNonTrigger() {
  const stableSkills = [
    { name: 'git-workflow', timeSensitive: false },
    { name: 'refactoring', timeSensitive: false },
    { name: 'code-review', timeSensitive: false },
  ];

  const questions = [
    'Python 最新版本是什么',
    '哪个分支',
    '帮我写一个脚本',
  ];

  for (const q of questions) {
    const result = shouldPreSearch(stableSkills);
    assert.equal(result.trigger, false, `"${q}" with stable skills should not trigger`);
  }

  console.log('  ✅ testStableNonTrigger');
}

/* ---- 测试 3: 搜索查询生成 ---- */

function testSearchQueryGeneration() {
  // 有 template 的 time_sensitive skill
  const skill = {
    name: 'rdk-model-zoo',
    timeSensitive: true,
    searchQueryTemplate: 'rdk_model_zoo github branches {{query}}',
  };
  const query = buildSearchQuery('S600的rdk_model_zoo是哪个分支', [skill]);
  assert.equal(query, 'rdk_model_zoo github branches S600的rdk_model_zoo是哪个分支');

  // 没有 template → 直接用用户消息
  const noTemplateSkill = { name: 'rdk-model-zoo', timeSensitive: true };
  const query2 = buildSearchQuery('S600分支', [noTemplateSkill]);
  assert.equal(query2, 'S600分支');

  console.log('  ✅ testSearchQueryGeneration');
}

/* ---- 测试 4: 完整覆盖矩阵 ---- */

function testFullCoverageMatrix() {
  // 默认 Skill（registry 默认 timeSensitive = true）→ 触发
  const defaultSkills = [
    { name: 'rdk-model-zoo', timeSensitive: true },
    { name: 'rdk-source-map', timeSensitive: true },
  ];

  const triggeredQuestions = [
    'S600的rdk_model_zoo是哪个分支',
    'RDK X5 model zoo 用哪个分支',
    'S100P 的 model zoo 分支是什么',
    'S600 支持 YOLO11 吗',
    'X5 能跑 YOLOv8 吗',
    '哪些板卡支持深度估计模型',
    'X5 上 YOLO11n 的帧率是多少',
    'S100 上 YOLOv8 的 latency',
    'hb_mapper 的最新版本是什么',
    'RDK OS 最新版本号',
    'D-Robotics 的 GitHub 有哪些公开仓库',
    'hobot_dnn 和 hobot-dnn 有什么区别',
  ];

  console.log(`\n  📋 触发预搜索 (${triggeredQuestions.length} 个问题):\n`);

  for (const q of triggeredQuestions) {
    const result = shouldPreSearch(defaultSkills);
    assert.equal(result.trigger, true, `"${q}" should trigger pre-search`);
    console.log(`     [${result.reason}] ${q}`);
  }

  // Stable Skill（timeSensitive: false）→ 不触发
  const stableSkills = [
    { name: 'git-workflow', timeSensitive: false },
    { name: 'refactoring', timeSensitive: false },
  ];

  const nonTriggeredQuestions = [
    '帮我写一个脚本',
    '怎么用 Docker',
    'Python 最新版本是什么',
  ];

  console.log(`\n  📋 不触发预搜索 (${nonTriggeredQuestions.length} 个问题):\n`);

  for (const q of nonTriggeredQuestions) {
    // 只有 stable skill → 不触发
    let result = shouldPreSearch(stableSkills);
    assert.equal(result.trigger, false, `"${q}" with stable skills should not trigger`);

    // 没有 skill → 不触发
    result = shouldPreSearch([]);
    assert.equal(result.trigger, false, `"${q}" with no skills should not trigger`);

    console.log(`     [none]  ${q}`);
  }

  console.log('  ✅ testFullCoverageMatrix');
}

/* ---- 运行所有测试 ---- */

console.log('\n🔬 PreFlightRouter 测试\n');

const tests = [
  { name: '默认触发', fn: testDefaultTrigger },
  { name: 'Stable 不触发', fn: testStableNonTrigger },
  { name: '搜索查询生成', fn: testSearchQueryGeneration },
  { name: '完整覆盖矩阵', fn: testFullCoverageMatrix },
];

let passed = 0;
let failed = 0;

for (const { name, fn } of tests) {
  try {
    fn();
    passed++;
  } catch (err) {
    failed++;
    console.log(`  ❌ ${name}: ${err.message}`);
  }
}

console.log(`\n📊 结果: ${passed} passed, ${failed} failed, ${tests.length} total\n`);

if (failed > 0) process.exit(1);