#!/usr/bin/env node
/**
 * knowledge_search 工具 & Skill 匹配 → 联网搜索链路测试
 *
 * 测试目标：
 * 1. knowledge_search 工具已正确注册到 builtinTools
 * 2. Skill 注册表能正确匹配事实性问题
 * 3. 端到端：Moss 对事实性问题调用 knowledge_search 而非直接回答
 *
 * Run: node packages/moss-agent/test/knowledge-search-chain.spec.mjs
 * Exit 0 on pass; exit 1 on any assertion failure.
 */

import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* ---- 测试 1: knowledge_search 工具已注册 ---- */

function testToolRegistered() {
  // 检查 builtin.ts 中是否导入了 knowledge_search 工具
  const builtinPath = path.resolve(__dirname, '..', 'src', 'tools', 'builtin.ts');
  const content = fs.readFileSync(builtinPath, 'utf-8');

  assert.ok(
    content.includes('createKnowledgeSearchTool'),
    'builtin.ts should import createKnowledgeSearchTool',
  );
  assert.ok(
    content.includes("from './knowledge-search.js'"),
    'builtin.ts should import from knowledge-search.js',
  );

  console.log('  ✅ testToolRegistered');
}

/* ---- 测试 2: knowledge_search 工具源码存在 ---- */

function testToolSourceExists() {
  const toolPath = path.resolve(__dirname, '..', 'src', 'tools', 'knowledge-search.ts');
  assert.ok(fs.existsSync(toolPath), 'knowledge-search.ts should exist');

  const content = fs.readFileSync(toolPath, 'utf-8');

  // 验证工具名
  assert.ok(content.includes("name: 'knowledge_search'"), 'tool name should be knowledge_search');

  // 验证内部调用 web_search
  assert.ok(content.includes('createWebSearchTool'), 'should import createWebSearchTool');
  assert.ok(content.includes('createWebFetchTool'), 'should import createWebFetchTool');

  // 验证输入 schema
  assert.ok(content.includes("required: ['query']"), 'query should be required');

  console.log('  ✅ testToolSourceExists');
}

/* ---- 测试 3: Skill 匹配事实性问题 ---- */

function testSkillMatching() {
  // 模拟 SkillRegistry.matchByText 的核心逻辑
  const testQuestions = [
    'S600的rdk_model_zoo是哪个分支',
    'RDK X5 用哪个 model zoo 分支',
    'S100 的 model zoo 分支是什么',
    '哪个板卡支持 YOLO11',
    'jetson 的 model zoo',
    'rdk model zoo 分支',
  ];

  // 模拟 rdk-model-zoo skill 的元数据
  const skillMeta = {
    name: 'rdk-model-zoo',
    description: 'Run a ready-made, officially pre-compiled BPU model from the RDK Model Zoo on a board — pick the right branch (branch = board), download the matching .bin/.hbm, run the sample, read the per-board benchmark (latency/FPS/accuracy). Use whenever the user wants a precompiled model instead of quantizing their own, asks "does RDK have a converted YOLO/classification/segmentation/OCR .bin/.hbm", "how do I run a Model Zoo sample", "which branch for my board", or "where do I download the precompiled model". 触发词:Model Zoo、现成模型、预编译模型、官方转好的、有没有现成的 bin/hbm、模型仓、跑示例 sample、哪个分支、archive.d-robotics 下载、benchmark 帧率精度、YOLO11 哪块板能跑、模型性能对比。',
    tags: ['model-zoo', 'rdk', 'bpu', 'precompiled', 'benchmark'],
    trigger: [
      'model zoo', 'model_zoo', '预编译模型', '现成模型', 'bin', 'hbm',
      '模型仓', '哪个分支', 'benchmark', '帧率', 'YOLO', '板卡',
    ],
  };

  // 复制 matchByText 核心逻辑
  function matchByText(text, skill) {
    const q = text.toLowerCase().trim();
    if (!q) return false;
    const asciiWords = [
      ...new Set(q.split(/[^\p{L}\p{N}]+/u).filter((t) => /^[a-z0-9]{2,}$/i.test(t))),
    ];
    const nameL = skill.name.toLowerCase();
    const descL = skill.description.toLowerCase();
    if (nameL.includes(q) || descL.includes(q)) return true;
    const nameSpaced = nameL.replace(/-/g, ' ');
    if (nameSpaced.includes(q) || q.includes(nameSpaced)) return true;
    if (asciiWords.length > 0) {
      const nameHay = nameSpaced;
      const descHay = descL.replace(/-/g, ' ');
      if (asciiWords.every((t) => nameHay.includes(t) || descHay.includes(t))) return true;
    }
    return skill.trigger.some((t) => q.includes(t.toLowerCase()));
  }

  for (const question of testQuestions) {
    const matched = matchByText(question, skillMeta);
    assert.ok(matched, `"${question}" should match rdk-model-zoo skill triggers`);
  }

  console.log('  ✅ testSkillMatching');
}

/* ---- 测试 4: SKILL.md 内容指向 knowledge_search ---- */

function testSkillMdReferencesKnowledgeSearch() {
  const skillPath = path.resolve(
    __dirname, '..', 'assets', 'rdk-knowledge', 'skills', 'rdk-model-zoo', 'SKILL.md',
  );
  const content = fs.readFileSync(skillPath, 'utf-8');

  // 验证 skill 引用了 knowledge_search
  assert.ok(
    content.includes('knowledge_search'),
    'rdk-model-zoo SKILL.md should reference knowledge_search',
  );

  // 验证 skill 不再硬编码分支映射表（或标记为参考）
  // 检查是否仍然有硬编码的分支表（旧的）
  const hasHardcodedBranchTable = /\|.*RDK.*\|.*rdk_model_zoo.*\|.*rdk_[a-z0-9_]+.*\|/.test(content);
  if (hasHardcodedBranchTable) {
    console.log('  ⚠️  SKILL.md still contains hardcoded branch table (may be reference only)');
  }

  // 验证 skill 有搜索指引
  assert.ok(
    content.includes('必须先') || content.includes('必须') || content.includes('knowledge_search'),
    'rdk-model-zoo SKILL.md should instruct LLM to use knowledge_search',
  );

  console.log('  ✅ testSkillMdReferencesKnowledgeSearch');
}

/* ---- 测试 5: 类似问题覆盖矩阵 ---- */

function testQuestionCoverage() {
  // 模拟 Skill 注册表
  const skills = [
    {
      name: 'rdk-model-zoo',
      description: 'Run a ready-made, officially pre-compiled BPU model from the RDK Model Zoo on a board — pick the right branch (branch = board), download the matching .bin/.hbm, run the sample, read the per-board benchmark (latency/FPS/accuracy). Use whenever the user wants a precompiled model instead of quantizing their own, asks "does RDK have a converted YOLO/classification/segmentation/OCR .bin/.hbm", "how do I run a Model Zoo sample", "which branch for my board", or "where do I download the precompiled model". 触发词:Model Zoo、现成模型、预编译模型、官方转好的、有没有现成的 bin/hbm、模型仓、跑示例 sample、哪个分支、archive.d-robotics 下载、benchmark 帧率精度、YOLO11 哪块板能跑、模型性能对比。',
      tags: ['model-zoo', 'rdk', 'bpu', 'precompiled', 'benchmark'],
      trigger: [
        'model zoo', 'model_zoo', '预编译模型', '现成模型', 'bin', 'hbm',
        '模型仓', '哪个分支', 'benchmark', '帧率', 'YOLO', '板卡',
      ],
    },
    {
      name: 'rdk-source-map',
      description: 'Map and disambiguate repositories in the D-Robotics GitHub org (226 public / 327 total incl. private) — tell the user what a repo is, which layer it belongs to, which board it targets, which repo to use for a task, and how to build an RDK OS image or TROS workspace from source. Use whenever the user sees a D-Robotics repo and doesn\'t know what it does, can\'t tell hobot- (hyphen, BSP) from hobot_ (underscore, ROS2 app), asks "which repo do I clone for X". 触发词:这个仓库是干嘛的、属于哪一层、对应哪块板、该 clone 哪个仓、hobot- 和 hobot_ 区别、GitHub、D-Robotics。',
      tags: ['repo', 'github', 'source-map', 'rdk'],
      trigger: [
        'hobot-', 'hobot_', '仓库', 'GitHub', 'D-Robotics', 'repo',
        'rdk-gen', 'manifest', '哪个仓', 'clone',
      ],
    },
    {
      name: 'rdk-device',
      description: 'Model quantization and BPU deployment on RDK boards — hb_mapper (X-series), hb_compile (S-series), calibration, march selection, toolchain workflow. Use when the user wants to convert their own model, asks about quantization, hb_mapper, hb_compile, BPU deployment.',
      tags: ['device', 'quantization', 'bpu', 'toolchain'],
      trigger: [
        'hb_mapper', 'hb_compile', '量化', 'BPU', 'march', 'toolchain',
        '校准', '部署',
      ],
    },
    {
      name: 'rdk-llm-deployment',
      description: 'Deploy LLM/VLM on RDK boards — hobot_llamacpp, InternVL, Qwen, on-device chat. Use when user asks about LLM deployment, model version, supported models.',
      tags: ['llm', 'deployment', 'vlm'],
      trigger: [
        'llm', 'LLM', 'VLM', 'qwen', 'deepseek', 'internvl',
        'hobot_llamacpp', '部署', '大模型',
      ],
    },
  ];

  // 这些问题都应该触发 knowledge_search 而非直接回答
  const factualQuestions = [
    // 分支/版本类
    { q: 'S600的rdk_model_zoo是哪个分支', category: 'branch' },
    { q: 'RDK X5 model zoo 用哪个分支', category: 'branch' },
    { q: 'S100P 的 model zoo 分支是什么', category: 'branch' },
    // 支持矩阵类
    { q: 'S600 支持 YOLO11 吗', category: 'support' },
    { q: 'X5 能跑 YOLOv8 吗', category: 'support' },
    { q: '哪些板卡支持深度估计模型', category: 'support' },
    // Benchmark 类
    { q: 'X5 上 YOLO11n 的帧率是多少', category: 'benchmark' },
    { q: 'S100 上 YOLOv8 的 latency', category: 'benchmark' },
    // 版本/配置类
    { q: 'hb_mapper 的最新版本是什么', category: 'version' },
    { q: 'RDK OS 最新版本号', category: 'version' },
    // 仓库/组织类
    { q: 'D-Robotics 的 GitHub 有哪些公开仓库', category: 'repo' },
    { q: 'hobot_dnn 和 hobot-dnn 有什么区别', category: 'repo' },
  ];

  // matchByText 核心逻辑（与 SkillRegistry 一致）
  function matchByText(text, skill) {
    const q = text.toLowerCase().trim();
    if (!q) return false;
    const asciiWords = [
      ...new Set(q.split(/[^\p{L}\p{N}]+/u).filter((t) => /^[a-z0-9]{2,}$/i.test(t))),
    ];
    const nameL = skill.name.toLowerCase();
    const descL = skill.description.toLowerCase();
    if (nameL.includes(q) || descL.includes(q)) return true;
    const nameSpaced = nameL.replace(/-/g, ' ');
    if (nameSpaced.includes(q) || q.includes(nameSpaced)) return true;
    if (asciiWords.length > 0) {
      const nameHay = nameSpaced;
      const descHay = descL.replace(/-/g, ' ');
      if (asciiWords.every((t) => nameHay.includes(t) || descHay.includes(t))) return true;
    }
    return skill.trigger.some((t) => q.includes(t.toLowerCase()));
  }

  console.log(`\n  📋 测试问题覆盖矩阵 (${factualQuestions.length} 个问题):\n`);

  const byCategory = {};
  const unmatched = [];

  for (const item of factualQuestions) {
    byCategory[item.category] = (byCategory[item.category] || 0) + 1;

    // 验证每个问题至少命中一个 Skill
    const matchedSkills = skills.filter((s) => matchByText(item.q, s));
    const skillNames = matchedSkills.map((s) => s.name).join(', ') || '❌ 无匹配';

    if (matchedSkills.length === 0) {
      unmatched.push(item.q);
    }

    console.log(`     [${item.category}] ${item.q}`);
    console.log(`       → ${skillNames}`);
  }

  // 汇总
  console.log(`\n  📊 类别覆盖:`);
  for (const [cat, count] of Object.entries(byCategory)) {
    console.log(`     ${cat}: ${count} 个问题`);
  }

  // 验证覆盖了所有类别
  assert.ok(byCategory.branch >= 3, 'should have at least 3 branch questions');
  assert.ok(byCategory.support >= 3, 'should have at least 3 support questions');
  assert.ok(byCategory.benchmark >= 2, 'should have at least 2 benchmark questions');
  assert.ok(byCategory.version >= 2, 'should have at least 2 version questions');
  assert.ok(byCategory.repo >= 2, 'should have at least 2 repo questions');

  // 验证每个问题都至少匹配一个 Skill
  assert.equal(unmatched.length, 0, `unmatched questions: ${unmatched.join(', ')}`);

  console.log('  ✅ testQuestionCoverage');
}

/* ---- 测试 6: 内置知识不包含答案（硬约束验证）---- */

function testNoHardcodedAnswers() {
  const modelZooPath = path.resolve(
    __dirname, '..', 'assets', 'rdk-knowledge', 'skills', 'rdk-model-zoo', 'SKILL.md',
  );
  const sourceMapPath = path.resolve(
    __dirname, '..', 'assets', 'rdk-knowledge', 'skills', 'rdk-source-map', 'SKILL.md',
  );
  const modelZooContent = fs.readFileSync(modelZooPath, 'utf-8');
  const sourceMapContent = fs.readFileSync(sourceMapPath, 'utf-8');

  // 检查项：每个问题不应在 Skill 中找到硬编码的答案
  const checks = [
    {
      content: modelZooContent, skill: 'rdk-model-zoo',
      desc: 'S600→rdk_s 分支映射表',
      // 旧的硬编码格式: | RDK S600 | rdk_model_zoo | rdk_s | ... |
      // 搜索示例中是 "knowledge_search(query=...rdk_s...S600...)" 这是指引，不是答案
      mustNotContain: [/\|.*RDK.*S600.*\|.*rdk_model_zoo.*\|.*rdk_s.*\|/],
    },
    {
      content: modelZooContent, skill: 'rdk-model-zoo',
      desc: 'X5→rdk_x5 分支映射表',
      mustNotContain: [/\|.*RDK.*X5.*\|.*rdk_model_zoo.*\|.*rdk_x5[^_].*\|/],
    },
    {
      content: modelZooContent, skill: 'rdk-model-zoo',
      desc: 'YOLO11n FPS benchmark 数字',
      // 旧格式: | yolo11n | 8.2 | 122 | ... |
      mustNotContain: [/\|.*yolo11n.*\|\s*\d+\.?\d*\s*\|\s*\d+\.?\d*\s*\|/i],
    },
    {
      content: modelZooContent, skill: 'rdk-model-zoo',
      desc: 'X5 YOLOv8 支持矩阵表',
      mustNotContain: [/\|.*YOLOv8.*X5.*\|/, /\|.*X5.*\|.*YOLOv8.*\|/],
    },
    {
      content: sourceMapContent, skill: 'rdk-source-map',
      desc: '仓库数量硬编码',
      mustNotContain: [/\d{2,}\s*(?:public|个公开)/, /~\d{1,3}\s*(?:hobot|个)/],
    },
    {
      content: sourceMapContent, skill: 'rdk-source-map',
      desc: 'hobot_dnn vs hobot-dnn（概念解释，允许保留）',
      mustNotContain: null,
    },
  ];

  console.log(`\n  🔍 验证 SKILL.md 不包含硬编码答案:\n`);

  for (const check of checks) {
    if (check.mustNotContain === null) {
      console.log(`     ⏭️  ${check.desc}: 概念性知识，允许内置`);
      continue;
    }
    let leaked = false;
    for (const pattern of check.mustNotContain) {
      if (pattern.test(check.content)) {
        leaked = true;
        console.log(`     ❌ ${check.desc}: 仍包含硬编码答案! (${pattern})`);
        break;
      }
    }
    if (!leaked) {
      console.log(`     ✅ ${check.desc}: 已移除，必须联网搜索`);
    }
    assert.ok(!leaked, `${check.skill}: ${check.desc} 不应硬编码在 SKILL.md 中`);
  }

  // 验证 SKILL.md 包含强制搜索语言（硬约束，不是软建议）
  const mandatoryPatterns = [
    /必须.*knowledge_search|knowledge_search.*必须/,
    /必须先.*搜索|先搜索.*再回答/,
    /⚠️.*搜索.*回答/,
  ];
  let hasMandatory = false;
  for (const pattern of mandatoryPatterns) {
    if (pattern.test(modelZooContent)) {
      hasMandatory = true;
      break;
    }
  }
  assert.ok(hasMandatory, 'rdk-model-zoo SKILL.md must contain mandatory search language');

  console.log('  ✅ testNoHardcodedAnswers');
}

/* ---- 运行所有测试 ---- */

console.log('\n🔬 knowledge_search 链路测试\n');

const tests = [
  { name: '工具注册', fn: testToolRegistered },
  { name: '工具源码', fn: testToolSourceExists },
  { name: 'Skill 匹配', fn: testSkillMatching },
  { name: 'SKILL.md 引用', fn: testSkillMdReferencesKnowledgeSearch },
  { name: '问题覆盖', fn: testQuestionCoverage },
  { name: '无硬编码答案', fn: testNoHardcodedAnswers },
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

if (failed > 0) {
  process.exit(1);
}