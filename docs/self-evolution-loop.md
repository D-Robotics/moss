# Self-Evolution Loop: Memory + Verifier Design

> 状态:设计文档(探索阶段定稿,待 Phase 1 MVP 验证后正式走 OpenSpec 变更流程)
> 来源:从「要不要引入 HINDSIGHT」的探索讨论迭代而来,所有决策有代码级证据支撑
> 仓:`D:\moss-drobotics`(Moss @ `packages/moss-agent`)
> 日期:2026-07-28

## 目录

- [1. 背景与问题](#1-背景与问题)
- [2. 现有能力盘点](#2-现有能力盘点)
- [3. 整体架构](#3-整体架构)
- [4. 关键设计决策(D1-D10)](#4-关键设计决策)
- [5. 三项 Capability 规格](#5-三项-capability-规格)
- [6. 风险与取舍](#6-风险与取舍)
- [7. 落地路径](#7-落地路径)
- [8. 未决问题](#8-未决问题)
- [附录 A:死代码复用清单(T0.0)](#附录-a死代码复用清单t00-产出)
- [附录 B:U5 可信根边界验收用例](#附录-bu5-可信根边界验收用例d5d6-可证伪测试)

---

## 1. 背景与问题

Moss 当前能"记住",但不能"学习"。它的记忆系统(`packages/moss-agent/src/memory/`)是被动存储:
- `MemoryManager` 按 scope(workspace/user/device)做混合检索(BM25 + 语义 + RRF),但
  只存"模型主动 `memory_write` 的事实"和"会话级 digest",**Skill 调用的执行轨迹会话结束即丢**;
- `self-learning-memory.ts` / `knowledge-card.ts` / `memory-context-selector.ts` 三套自动沉淀
  逻辑**已实现但未接入主循环**(死代码),`src/` 内无调用点。

后果是 agent 自进化的两个目标都立不起来:
- **② 不重复犯错**:踩过的坑(某参数组合在 S100 上必失败)无结构化留存,下次照样再试;
- **③ 自动课程**:没有"下一步测什么"的数据依据,全靠人工规划。

更深的缺口:即便补上执行轨迹记忆,**"一次调用算成功还是失败"的判定权仍在模型侧**——
模型自报 `status: success` 进库,记忆据此归纳,Reflect 据此出方向,这是系统性自我洗脑
(第一轮痛点 1 "推断伪装成事实反复召回变进步"在 ③ 里的隐蔽重演)。

当前若尝试自进化,只能依赖模型自报成败与自写判据,本质是自证循环,产出的优化数据
无客观可信锚点,最终只会退化为"自我洗脑式"的无效迭代,无法形成真正的能力提升闭环。

**本设计引入 HINDSIGHT**(Latimer et al., ACL 2026 demo)的 retain/recall/reflect 骨架,
**同时**补一层 HINDSIGHT 与 Moss 都没有、而机器人场景独有的客观验证器层,形成可信自进化闭环。

---

## 2. 现有能力盘点

### 2.1 Moss 记忆现状(代码级查实)

- **WorkspaceMemory**(`src/memory/workspace-memory.ts`):Codex 风格层级项目指令加载
  (AGENTS.md/CLAUDE.md,git-root→cwd 合并),进稳定 system prompt。静态文件层,非"AI 记忆"。
- **MemoryManager**(`src/memory/memory-manager.ts`,951 行):动态长期记忆。
  `.moss/memory/index.json` + 倒排索引(中文 2-6 n-gram)+ 可选 embedding。
  检索已是 BM25(TF 饱和 k1=1.2 + 文档长度归一化 b=0.75)+ 语义 + **RRF(k=60)** 混合,
  带写边界兜底(拒注入/拒密钥/拒过短)、串行写链 `_writeChain`、软硬过期。
  **HINDSIGHT 论文四路召回里 Moss 已实现 ~70%(缺图扩散、时间过滤两路)。**
- **死代码**:`self-learning-memory.ts`/`knowledge-card.ts`/`memory-context-selector.ts`
  三套自动沉淀逻辑已实现并导出公共 API,但 `src/` 内无调用点——主循环未接。

### 2.2 Moss 工具执行钩子(验证器挂载点)

- **PostToolUseHook**(`src/core/tools/tool-hooks.ts:30`):execute 之后、返回模型之前。
  签名 `{tool, input, result, isError, durationMs, ctx, sessionId}`,能改 `result` 文本。
  **`isError` 为入参不可改**(架构边界,非缺陷——见 [D1](#d1) 与 Decision 说明)。
- 内置 `createTimingHook` 已示范"hook 里副作用式往外发数据"——验证器同模式写盘。
- 挂载:`execute-tool-call.ts:615 runPostHooks`,**无需改 core**。

### 2.3 Moss 任务/计划载体(代码级查实,★关键利好)

- `Plan` / `PlanStep` 是显式结构化类型(`plan-execute-controller.ts:25-77`)
- `Plan.successCriteria: string[]`(行 66)—— 任务级验收标准现成字段
- `PlanStep.expectedOutput / expectedTools / actualTools / actualOutput` —— 步骤级验收与执行轨迹现成字段
- `completionGate` 扩展位(`moss-agent.ts:1488` 包装器,plan-gate → host-gate 级联)
  含"不 ok 注入 correction turn 强制继续"的硬阻断机制(`agent-loop-response.ts:295-308`,现成可用)

> 这是 [D10](#d10) 把约束 3 从"一票否决"降级为"工程级精度问题"的依据。

### 2.4 HINDSIGHT 论文要点(Latimer et al., ACL 2026)

四网络(World 客观事实 / Experience 第一人称行为 / Observation 中性实体摘要 / Opinion
带置信度且随证据演化的主观判断)+ retain/recall/reflect 三操作。recall 四路并行
(HNSW/BM25/图扩散/时间过滤)→ RRF → cross-encoder 重排。Opinion 置信度随支持/矛盾
证据增减 + freshness trend。Observation 不覆盖只 refine,保留证据链 + proof count。
**面向聊天场景**(benchmark 为 LongMemEval/LoCoMo,对话记忆),无客观成败判定——
这正是机器人场景要补的。

---

## 3. 整体架构

引入"记忆 + 验证"双层的自进化闭环,三个交付物构成「反馈源 - 锚点 - 记忆闭环」
的完整自进化底座,缺一不可:

```
   ┌──────────────────────────────────────────────────────────────┐
   │                        一次任务执行                            │
   │   Agent 决策 ──▶ Skill/工具调用 ──▶ 真机/板子执行              │
   │                                          │                   │
   │                                          ▼                   │
   │   ┌─────────────────────────────────────────────────────┐    │
   │   │   ① 客观验证器层(objective-verifier)                │    │
   │   │      提供系统侧独立判定能力 = 可信反馈来源            │    │
   │   │   硬信号闸门优先(D1):退出码/文件存在/进程 → 几何    │    │
   │   │      谓词/传感器 → 模型兜底(标低可信)              │    │
   │   │   信息隔离(D3):三输入(参数/结果/传感器)不碰思考链 │    │
   │   │   → 输出 {pass/fail, 原因码, 诊断向量, 信号来源}     │    │
   │   └───────────────────────┬─────────────────────────────┘    │
   │                            │                                   │
   └────────────────────────────┼─────────────────────────────────┘
                                │
                    ┌───────────▼───────────┐
                    │  ② HINDSIGHT 记忆骨架  │  验证器打标签,非模型自报
                    │  (hindsight-memory)   │
                    │  Experience(轨迹,     │
                    │   append-only)        │
                    │      ↓ 异步聚合        │
                    │  Observation(规律,    │  = 记忆闭环骨架
                    │   proof count)        │
                    │      ↓ Reflect         │
                    │  Opinion(演化,置信度) │
                    └───────────┬───────────┘
                                │
                    ┌───────────▼───────────┐
                    │  ③ 验收规格体系         │  = 反馈锚点载体
                    │  (acceptance-spec)     │
                    │  层1 Skill 契约(主)   │  挂 Plan.successCriteria
                    │  层2 白名单声明(低可信)│  挂 PlanStep.expectedAccept
                    │  层3 终局跨信号仲裁    │  挂 completionGate 扩展链
                    │  (测量有效性守门人)    │  复用原生 correction 注入
                    └───────────────────────┘
```

### 代码影响

- `packages/moss-agent/src/core/tools/tool-hooks.ts`:新增验证器 PostToolUseHook(不改签名,
  `isError` 为入参不变,验证器副作用式写盘,仿 `createTimingHook` 模式);
- `packages/moss-agent/src/memory/`:新增 `experience-log.ts`(append-only 轨迹)、
  `observation-aggregator.ts`(离线聚合,复用 self-learning 死代码)、扩展 `MemoryEntry`
  加 `trust` 维度(world/observation/opinion,与现有 `scope` 正交);
- `packages/moss-agent/src/acceptance/`(新目录):契约库、白名单谓词、终局仲裁器。

### 依赖策略

**不引入** PostgreSQL/pgvector(HINDSIGHT 原生栈,对 Moss 本地 JSON 形态过重,论文
Limitations 自承"PG 增部署复杂度")。Moss 现有 `.moss/memory/` JSON + 倒排 + 可选
embedding 够用;cross-encoder 重排暂缓(论文 6.3 自承"非主要增益来源")。

### 归因警告

本设计**不**承诺提升 Skill 路由准确率。Moss 路由走 `registry.ts:294 matchByText`
纯字符串启发式,不经过记忆系统;路由收益来自补中文 trigger(已有分支
`fix/moss-skill-cn-trigger`),与记忆库无关。混淆此归因会致投资错配。

---

## 4. 关键设计决策

### D1. 级联方向反转:硬信号前置,模型裁判兜底

HINDSIGHT/Harness 的五级 cascade("成本从低到高")是软件 agent 假设(语法<规则<语义<
裁判)。机器人场景成本结构相反:几何谓词/传感器/退出码是**可信度最高**的物理真值
(零噪声,不需模型);模型裁判反而成本最高、幻觉风险最大、可信度最低。
**落地:硬信号闸门优先,模型裁判仅当硬信号全缺失时兜底且标"低可信"。**

**成本量级(Moss 形态查实,T0.1)**:Moss 无结构化位姿/力觉接口,硬信号读取 = 经 SSH
跑一条命令(`device_exec`)+ 解析 stdout。成本 = 一次 SSH RTT(经 ControlMaster 复用,
~ms 级)+ 文本解析,仍远低于模型裁判(LLM 调用 ~百 ms-秒级 + 幻觉),但非"零成本",
应表述为"低且确定性"。这不改变级联方向结论,仅修正成本量级描述。

**兜底约束**:模型裁判输出的判定结果恒标记 `model_judgment` 低可信等级,判定优先级
低于所有硬信号来源,仅在所有硬信号缺失时启用。

### D2. 舍弃防篡改机制(帧哈希/一次性提交码)

该套机制源自真机评测竞赛,解决"对抗性作弊"。自进化是自监督闭环,执行器无骗己动机,
核心风险是感知误差/执行漂移/环境非预期,非数据篡改。引入防作弊徒增复杂度,且制造
"哈希通过=结果可信"的虚假安全感。**取 Inner Monologue 的 Success Detector(力觉+视觉
判物体在不在爪中),舍帧哈希/提交码。**

### D3. 取 CoEvoSkills 信息隔离,舍其成对协同进化

"生成器-验证器成对迭代"成立前提是执行可复现、成本可忽略。真机有不可逆物理成本
(时间/磨损/能耗)+ 设备状态持续漂移,同一 Skill 两次结果不同是常态,验证器自身稳定性
都不保。**只取"验证逻辑与执行逻辑解耦、执行模块无权改判定"的架构原则,舍迭代对抗。**

**具象化输入边界**:验证器模块不访问模型思考链、对话历史与意图推断内容,仅基于
①工具输入参数、②执行结果、③物理传感器信号三类输入做判定,从机制上避免被模型
输出污染。

### D4. 三层验收叠层(非三选一)

- 层 1 Skill 契约式:主判据,判据由系统/人定义,唯一真正"判定权收回系统"。适用固定
  RDK skill 库(现 20 个)。
- 层 2 前置声明式:覆盖契约触达不到的中间步骤/自定义流程。**强制白名单谓词**(模型只
  能选系统预定义原子谓词 file_exist/pose_error_within/force_below/process_running,
  不可自由定义语义)+ **强制低可信标记**。
- 层 3 终局对齐式:不做单次成败判定,职责是**校验判据本身有效性**——抓"单步全过但
  任务失败"的系统性误判。

### D5. ★可信根边界划分规则(以"是否循环论证"为唯一标准)

**World 层(只读,不可自进化)与 Observation 层(可演化)的唯一划分标准是"会不会陷入
循环论证",而非"是不是语义"。** 原子谓词体系拆分为三层,按可演化权限分别归属不同层级:

1. **谓词签名与语义定义**(输入输出类型、物理量的概念定义):归属 World 层,只读
   不可自进化,修改需人工介入,保证语义共识稳定;
2. **测量有效性主张**(即"某传感器/计算链路可表征目标物理量"的断言):归属 World 层,
   只读不可自进化。**该主张无法通过自身采集的数据自证**,必须通过独立跨信号校验或
   人工标定背书;
3. **测量实现选择、阈值参数、谓词组合逻辑**:归属 Observation 层,可通过历史数据统计
   与层 3 跨信号校验自动演化。

**核心原则:凡无法通过独立信号源完成非循环验证的断言,一律划入 World 层,禁止自进化
链路触碰。层 3 终局校验是系统内唯一具备跨独立信号源仲裁能力的环节,是测量有效性主张
的唯一系统内守门人。**

关键:之前"语义固定、参数可变"的切法把测量有效性主张偷渡进 World 又不审——用相机
vs 力觉可信度差一个数量级,贴 World 标签即永久豁免审计,致"契约全过、真机全错"且
难排查。切准测量有效性:能演化的(阈值/实现选择/组合)放心演化,不能自验的(测量
有效性)层 3 或人锁死,Reflect 碰不到——环路断。

### D6. 契约升层双门槛机制(统计置信度 + 测量有效性,缺一不可)

层 2 前置声明式谓词沉淀为层 1 正式契约,必须同时满足两个条件,缺一不可:

1. **统计置信度门槛**:由 HINDSIGHT Reflect 层基于足量历史数据验证,该谓词与任务终局
   成败具备稳定高相关性,且历史误判率低于预设阈值;
2. **测量有效性门槛**:由层 3 终局校验完成跨独立信号源的有效性确认,证明该谓词的
   测量实现与物理真值一致,而非仅与历史结果相关。

**升层不改变可信根归属**:升层仅沉淀阈值参数、组合逻辑与适用场景,测量有效性主张
**仍永久归属 World 层**,不随升层获得"自证可信"的地位。

**层 3 拥有一票否决权**:跨信号校验不通过的谓词,无论统计相关性多高,均不得进入
层 1 契约库。

漏点背景:Reflect 依据层 2(本就低可信)数据统计"谓词与历史成败相关",但未验测量有效性
——会把"历史相关但测量本身错"的谓词提成 World 级契约,自此用自己的权威验证自己的
出身(可信根可自改老病换马甲重演)。双门槛切断此跳跃。

### D7. 层 3 定位:跨信号真值仲裁者(机器人场景独有红利)

层 3 是闭环里**唯一拥有多独立信号源、能做非循环验证的层级**。纯软件 agent 终局校验
仍用模型判模型(同模态循环);机器人有视觉/力觉/关节编码器/里程计/电压电流等多独立
物理信号链路,彼此无因果依赖(视觉位姿可用关节正运动学交叉校验,力觉接触可用电机
电流转矩交叉校验)——这是真正的非循环真值锚点,聊天场景永远做不到,故 Moss+机器人
的可信度上限**高于** HINDSIGHT 原生纯软件场景。

三级递进:(1) 单次任务级 校验单步判据与终态一致性;(2) 统计演化级 跟踪测量实现
漂移触发阈值/实现选择演化;(3) 可信守门级 对候选升层测量实现做跨信号有效性校验
(升层闸核心锁,解决"相关性≠正确性"谬误)。

### D8. sim2real 定位:负向筛选,非正向验证

仿真高通过率掩盖真机最该学部分(感知噪声/接触不确定),sim2real 经典失败"仿真 99%
pass 真机 30%"。**仿真只负向排除明显错误版本(语法/逻辑/超运动学约束),不证明好用;
仿真通过版本进真机一律按零置信度重评,不继承仿真通过率标签。**

### D9. 架构哲学张力(显性记录)

Moss 现行"记忆即自律"(防模型假记,信任在模型侧:validateMemoryWriteContent/
memory-write-nudge/coding-completion-gate 全是约束模型诚实)。本设计部分推向
"记忆即数据库"(系统替模型管记忆)。此转变是必要代价(自进化需系统侧判定),
但需警惕:验证器层夺权后,若验收规格层(约束 3)没补全,会从"模型假记"升级为
"模型假判失败且记进库",退化风险不降反升——**本设计已通过 D10 复用 Moss 原生 Plan
结构解决该缺口,无残留架构风险**,故 D4/D5/D6 是 D1 的前提,不可拆分落地。

### D10. 验收规格载体复用 Moss 原生 Plan 结构(★约束 3 认知更新)

**约束 3 从"架构级一票否决、必须自建载体"降级为"工程级精度问题"**。依据:代码级
查实 Moss 的 plan-execute 子系统已造好 ~80% 载体——

- `Plan.successCriteria: string[]`(`plan-execute-controller.ts:66`)—— 任务级验收
  标准的现成字段;
- `PlanStep.expectedOutput: string`(`plan-execute-controller.ts:33`)+ `expectedTools`/
  `actualTools`/`actualOutput` —— 步骤级验收与执行轨迹的现成字段;
- `completionGate` 扩展位(`moss-agent.ts:1488` 包装器,plan-gate → host-gate 级联)
  —— 层 3 终局校验的现成挂载点,含"不 ok 注入 correction turn 强制继续"的硬阻断
  机制(`agent-loop-response.ts:295-308`,现成可用)。

**决策:不新建独立数据模型,复用原生 Plan/PlanStep,遵循最小侵入。**
- 任务级验收谓词存于 `Plan.successCriteria`;
- 步骤级验收谓词存于 `PlanStep` 新增可选字段 `expectedAccept?: AcceptSpec[]`
  (扩展,不破坏现有);
- 层 3 终局校验挂 `MossAgent.completionGate` 扩展链,复用原生 correction 注入机制。

**step-工具关联精度**:工具调用不携带 step_id(`ToolContext` 无该字段)。MVP 用
`plan.currentStep` 近似(PostToolUseHook 用 `ctx.sessionKey` 查 plan store,仿
`getActivePlanForSession` 模式)——自进化闭环需求是**步骤级成败统计与规律提炼**,
非单次调用精确归因,近似够用;单工具级精细调试是开发阶段事,非自进化必须。精确绑定
(`ToolContext` 加 stepId 或工具 input 带 step_id)列为 [U6](#u6),MVP 后可选优化。

**MVP 谓词形态务实化**:`Plan.successCriteria` 当前是 `string[]`,MVP **不急于**改成
结构化谓词全集——先让层 3 对自然语言 successCriteria 做初判(标低可信),等闭环跑通、
数据攒够,再把高频验收条件经 D6 升层闸沉淀成结构化 AcceptSpec。这恰与 D6 演化逻辑
自洽(谓词从事后统计中长出来,非先验定义)。

**方案取舍**:A(Plan 复用 + currentStep 近似)为步骤级主路径,B(completionGate 链
插入层 3)为终局校验必选补充,C(纯对话解析)弃用,仅作无 plan 任务的低可信兜底
(且 coding-completion-gate 已在做类似事,不重复造轮子)。

---

## 5. 三项 Capability 规格

### 5.1 objective-verifier(客观验证器层)

**Requirement: 系统侧工具成败判定** —— 验证器必须在工具执行后、结果返回模型前,
基于客观信号(而非模型自报)判定本次调用成败,输出结构化标签写入 Experience 层。
判定逻辑与执行逻辑物理隔离,执行模块无权修改判定结果。

- **WHEN** 调命令类工具(device_exec/exec)且 result 含退出码 → **THEN** 解析退出码,
  退出码 0 仅记"执行层正常"(非"任务成功"),`{verdict: exec_ok, confidence: low, signal: exit_code}` 写入
- **WHEN** 调涉及位姿/力觉 Skill 且契约含几何谓词 → **THEN** 从 ctx 读传感器/位姿信号,
  算几何谓词,`{verdict: pass/fail, signal: geometric, evidence: {...}}`,置信度高于退出码
- **WHEN** 无硬信号且契约未覆盖 → **THEN** 降级模型裁判,强制标 `confidence: low` 且
  `verdict_source: model_judge`,权重低于硬信号判定
- **WHEN** 工具自报 isError:false 但硬信号判 fail → **THEN** 记验证器 fail(夺权),
  isError 字段保留自报值不变(架构边界),两者并存供层 3 仲裁
- **WHEN** 硬信号判定与工具自报/模型结论不一致 → **THEN** 以硬信号为准,记 `signal_conflict`
  事件触发层 3 一致性审计

**Requirement: 判定结果结构化写入 Experience 层** —— append-only,含工具名/入参/自报
isError/verdict/失败原因码/诊断向量/信号来源/置信度/耗时/时间戳。异步写,仿
createTimingHook 副作用模式,不阻塞对话。

**Requirement: 级联方向硬信号前置** —— 硬信号存在时禁调模型裁判;硬信号缺失才兜底。

### 5.2 hindsight-memory(HINDSIGHT 记忆骨架)

**Requirement: Experience 轨迹层(append-only,客观标签)** —— 成败标签来自验证器(D5 守门)
非模型自报。
- **WHEN** 记一次调用 → **THEN** verdict 来自 objective-verifier,**不允许模型直接写 verdict**
- **WHEN** 写判定结果 → **THEN** append-only,禁止改/删历史,补充标注仅追加
- **WHEN** 写成败标签 → **THEN** 必带 ①信号来源 ②可信等级 ③判定层级 三类元信息
- **WHEN** 需更新判定(如层 3 翻盘)→ **THEN** 追加新记录含 `supersedes: <原id>`,原记录保留

**Requirement: Observation 离线聚合(异步,带 proof count)** —— 日/周从 Experience 聚合
激活率/成功率/失败分布/参数命中率,不阻塞对话。
- **WHEN** 在线对话中 → **THEN** 聚合异步跑(HINDSIGHT 4.2 同构:retain 延迟由抽取决定)
- **WHEN** 新 Evidence 与旧 Observation 冲突 → **THEN** 区分软演化(freshness weakening)
  vs 硬作废(固件/板子变更,标 `superseded` 失效,**不参与后续召回**)

**Requirement: Opinion 演化(支持/矛盾证据增减 + freshness)** —— 仅软演化场景,硬作废
用 supersedes 机制。
- **WHEN** 新 Experience 支持 Opinion → **THEN** 置信度 ↑,freshness → strengthening/stable
- **WHEN** 新 Evidence 矛盾 → **THEN** 置信度 ↓,freshness → weakening,但不删除(供层 3 仲裁)

**Requirement: trust 维度(与 scope 正交)** —— MemoryEntry 加 trust
(world/observation/opinion),与 scope 正交。
- **WHEN** 验证器/Reflect 试图 update 一条 trust:world → **THEN** MemoryManager.update 拒写,
  仅人工/外部背书可写(D5:测量有效性主张不可自验)
- **WHEN** 按 scope='device' 召回 → **THEN** 可在该 scope 内按 trust 二次过滤,两维正交

### 5.3 acceptance-spec(验收规格体系)

**Requirement: 层 1 Skill 契约式主判据** —— 20 个 RDK skill 各定义前置/后置验收条件
(签名 + 测量有效性主张 World 层)+ 安全约束,验证器按 Skill ID 匹配。
- **WHEN** 调有契约 Skill → **THEN** 按 sourcePath/name 匹配契约库,判据来源系统/人定义非模型
- **WHEN** 契约定义验收谓词 → **THEN** (a)签名+(b)测量有效性主张归 World 只读,
  (c)参数归 Observation 可演化;**划分标准"是否循环论证"非"是否语义"**

**Requirement: 验收规格载体复用 Moss 原生 Plan 结构(D10)** —— 不新建独立数据模型,
最小侵入。
- **WHEN** 存任务级验收 → **THEN** 复用 `Plan.successCriteria`(兼容 string[]),
  AcceptSpec 作扩展;MVP 允许自然语言初判(标低可信),攒够后经 D6 沉淀
- **WHEN** 存步骤级验收 → **THEN** 挂 `PlanStep.expectedAccept?: AcceptSpec[]`(扩展);
  expectedOutput/actualTools/actualOutput 复用为轨迹对照
- **WHEN** hook 判定调用属哪步验收 → **THEN** 用 ctx.sessionKey 查 plan store 拿 currentStep
  近似;单工具精确归因列为 U6 后置
- **WHEN** 模型拟结束本轮(agent-loop-response.ts:282 触发 completionGate)→ **THEN** 层 3
  跨信号校验挂 MossAgent.completionGate 包装链(plan-gate 后、host-gate 前),不 ok 复用
  原生 correction 注入(:295-308)强制继续,**不自建阻断**

**Requirement: 层 2 前置声明式白名单谓词(强制低可信)** —— 契约触达不到的步骤,Agent
从原子谓词集合选,不可自由定义语义。
- **WHEN** Agent 输出验收谓词 → **THEN** 必须来自白名单
  (file_exist/pose_error_within/force_below/process_running),拒绝自由语义(如"部署成功")
- **WHEN** 层 2 标签写入 → **THEN** 强制 confidence:low 且 verdict_source:model_declared,
  权重低于层 1
- **WHEN** Agent 提交声明式谓词 → **THEN** 校验是否在白名单,自定义直接拒,通过的标 low_confidence

**Requirement: 层 3 终局跨信号真值仲裁** —— 职责校验判据本身有效性(抓"单步全过任务失败"),
闭环里唯一非循环验证层级(机器人场景独有)。
- **WHEN** 单步全 pass 但任务目标未达成 → **THEN** 触发判据审计,对比单步判定与终态硬信号,
  定位失效契约/声明,标 `audit_failed`
- **WHEN** 整轮结束层 3 终局对齐 → **THEN** 对比全流程单步判据与多源终态信号,系统性偏差
  触发 `spec_audit` 标待复核
- **WHEN** 层 3 校验测量实现有效性 → **THEN** 用无因果依赖的不同信号链路交叉校验
  (视觉位姿 vs 关节正运动学,力觉 vs 电机电流转矩),**禁同源自验**(D5)
- **WHEN** 长期统计同 Skill 单步通过率 vs 终局成功率差值超阈 → **THEN** 触发契约阈值/参数重评
  (统计级校准,解决硬信号漂移/传感器磨损)

**Requirement: 契约升层闸(统计置信度 + 跨信号确认)** —— 层 2→层 1 需双门槛。
- **WHEN** 统计置信度达标但层 3 未跨信号确认 → **THEN** 禁止升层(相关性≠正确性,D6),
  仍留层 2 低可信
- **WHEN** 统计置信度达标 **且** 层 3 跨信号确认/人确认 → **THEN** 升层 1,(b)测量有效性主张
  归 World 只读,(c)参数仍可在 Observation 演化

---

## 6. 风险与取舍

- **R1 冷启动**:Experience 数据量不足时 Observation/Opinion 产不出有价值结论,
  通常需 100+ 次 Skill 调用才见效果(HINDSIGHT Limitations 承认)。
- **R2 反思质量依赖模型**:归纳/观点质量与 Reflect 模型能力正相关,小模型只能做统计
  类结论,深层规律提炼需更大模型。
- **R3 硬信号非绝对真值**:视觉有标定误差、编码器有空程、力觉有温漂,关节磨损/电池
  压降影响阈值。需设备级校准(关节零位/力传感器零点/相机标定)+ 统计级校准(层 3 跨步
  骤漂移)两层结合。
- **R4 哲学张力未完全化解**:D9 的转变可能动摇 Moss 现有护栏设计前提,需 A/B 观测
  "记忆即自律"护栏在引入系统侧判定后是否仍有效。
- **R5 投资错配风险**:若把 Skill 路由收益误归因到记忆库(见 §3 归因警告),
  会先搭记忆库再撞路由真因,三月后才发现无效。

---

## 7. 落地路径

### Phase 0 — 未决问题探索(风险导向,先攻一票否决项)

> 排序原则:先证伪"一票否决"的致命假设,再优化实现成本。
> 约束 3(验收规格)是一票否决项,约束 2(ctx 设备访问)是工程量问题有绕路,
> 故约束 3 优先。T0.1(ctx 设备访问)是纯工程量问题随时可补,后置不影响架构成立性。
> 〔已证伪:T0.2 代码查实后约束 3 降级为工程级精度问题,验收载体已由 Moss 原生
> Plan/PlanStep 结构提供,无需从零构建〕

- [x] **T0.0** ✅ 已完成(死代码梳理,接口清单见 §8 附录 A):
  - `self-learning-memory.ts`:`buildSelfLearningMemoryDraft(userMessage)` / `buildImplicitLearningDraft(ctx)`
    纯函数,无副作用,返回 `{content, scope}` 草稿或 null。**可复用**作 Observation 聚合输入,
    但其触发逻辑(检测"没改好/不对"等反馈信号)是会话级,Phase 2 需重新接线到工具级 Experience;
  - `knowledge-card.ts`:`classifyLearningTopic`/`buildKnowledgeCardDraft`/`assessKnowledgeTurn`
    纯函数,**可复用**作 topic 分类(已有 vision/hbm/ros/usb/network/deploy 等 slug)。`assessKnowledgeTurn`
    的"是否值得沉淀"判断(worth/projectRelated)可复用为 Observation 聚合的前置过滤;
  - `memory-context-selector.ts`:`selectMemoriesForContext` + `renderMemoryPicksForSystemPrompt`
    按优先级召回记忆片段注入 prompt。**可复用**作 Reflection 后将 Observation/Opinion 回注上下文,
    但其当前按 scope 而非 trust 分级,Phase 2 需扩 trust 维度(配合 T2.1)。
  - 三套均纯函数无外部依赖,**无重写压力**,Phase 2 接线即可。
- [x] **T0.1** ✅ 已完成(设备访问能力查实)。结论:
  - **无 DeviceManager 单例**;设备是 per-session 绑定,`connectDeviceForSession`
    (cli/device-connect.ts:292)→ `new DeviceSshSession` → `createDeviceSshTools`
    (device-ssh.ts:193),**executor 被【闭包捕获在工具内】(device-ssh.ts:196),
    不在 ToolContext,验证器 hook 取不到**——这是 D10"有绕路"的具体形态;
  - **无结构化硬信号接口**:硬信号读取 = `device_exec` 跑命令 + 解析 stdout
    (位姿/力觉靠 cat /sys/ 或 ROS topic),非零成本(D1 已修正),但仍远低于模型裁判;
  - **异常处理可复用**:`DeviceConnectionHealth`/`DeviceConnectionLostError`
    (device-connection-health.ts)识别 10+ 种断连模式,`ProcessError.timedOut`
    有智能超时建议——验证器跑硬信号命令 catch 后标
    `{verdict: unknown, reason: device_unreachable}` 走层 3 仲裁;
  - **绕路选【绕2 DeviceRegistry 单例】**:`connectDeviceForSession` 时按 sessionKey
    注册 DeviceSshSession,验证器按 `ctx.sessionKey` 取(仿 DeviceConnectionHealth 单例
    模式),**不动 ToolContext core 类型**,符合 D10 最小侵入。改 D1 成本表述 +
    新增 U7(executor 绕路的具体注册/取用接口设计)。
- [x] **T0.2** ✅ 已完成。验收规格载体复用原生 Plan.successCriteria/PlanStep.expectedOutput
  (见 D10);步骤级主路径=方案 A(Plan 复用 + currentStep 近似,零 core 修改);
  终局校验=方案 B(挂 completionGate 扩展链,复用 correction 注入);方案 C 弃用
- [ ] **T0.3** 确认落仓:暂放本 docs 文档,Phase 1 MVP 跑通后再正式 init OpenSpec

### Phase 1 — 客观验证器层 MVP(D1/D2/D3)

- [x] T1.1 ✅ 实现 objective-verifier PostToolUseHook,挂 runPostHooks(:615),仿 createTimingHook(commit 3bd435b)
- [~] T1.2 硬信号闸门优先级联(D1):退出码/文件存在 ✅ 已做;几何谓词/传感器待 T3 谓词定义;模型兜底待后续
- [ ] T1.3 Experience append-only 日志(.moss/memory/experiences.jsonl),复用 atomicWriteFile + 串行写链
- [ ] T1.4 信息隔离(D3):验证器模块与执行模块分离

### Phase 2 — HINDSIGHT 记忆骨架融合(D4 依赖前置)

- [x] T2.1 ✅ 扩 MemoryEntry 加 trust(world/observation/opinion,与 scope 正交)。World 写保护(update 入口预检抛 rejection + 链内双保险静默拒):改 world content/trust 拒、自抬 world 拒、设 observation/opinion 允许、改 pinned/starred 允许。
- [x] T2.2 ✅ Observation 离线聚合(memory/observation-aggregator.ts):从 Experience 按 contractSkill 统计 successRate/proofCount/failureReasons,写 trust=observation 条目进 MemoryManager,异步不阻塞。L2 通用(无 contractSkill)不统计。[✅ 运行时接线(cli-main.ts):经 promotionObserver 在成功 completion 后 fire-and-forget 触发 aggregator.aggregate()(之前"已实现待接线"gap 闭合)]。已知限制:重聚合统计变则新增(无按 trust 删除接口),待加。
- [x] T2.3 ✅ Opinion 演化(memory/opinion-evolver.ts):置信度随支持/矛盾证据增减(钳[0,1]),freshness(new/strengthening/stable/weakening/stale),不删除(保留证据链供层3仲裁)。硬作废(固件变更)用 supersededBy + 拒演化,与软演化 freshness 区分。Opinion 元数据编码进 topic(不动 MemoryEntry 结构)。
- [x] T2.4 ✅ 补召回图扩散通道(merge 进现有 RRF):applyGraphDiffusion — 同 topic 兄弟(一跳图邻居)继承 seed 分数 ×0.5 拉入结果,merge 进 BM25+语义+RRF 两条路径,无 topic no-op,不双计。HINDSIGHT 四路召回现缺时间过滤(暂缓)+ cross-encoder(暂缓)。时间过滤暂缓

### Phase 3 — 三层验收规格载体(D4/D5/D6)

- [~] T3.1 层 1 契约库:[✅ AcceptSpec + 契约加载器 + ContractRegistry(tool+command 反查)+ 谓词执行器 + hook 接契约产 L1,10/20 契约生效(原 6:rdk-board-knowledge/device/ros/llm-deployment/system-config/peripheral-cookbook + 新 4:model-zoo/multimedia/embodied-lerobot/rk-knowledge,只给真跑板端命令有硬信号的 skill 配;纯知识/选型类故意不配 D5)+ 多覆盖已解(expectedCommandPattern,各 skill 独有二进制互斥)+ 解 A 已接线(PlanStep.expectedAccept → findBySkill,优先于解 C)+ 全部几何谓词实现(force_below/pose_error_within/joint_at/video_fps_above,只读读+正则+阈值比)] / [待:补其余 10 skill 契约、给现有 force_below 契约填 readCommand/currentRegex 才真生效]
- [ ] T3.2 层 2 白名单谓词集 + 强制低可信,非白名单拒收
- [~] T3.3 层 3 终局跨信号仲裁器:[✅ 纯逻辑已实现(terminal-arbitrator auditTerminal 判据审计 + checkDrift 统计级漂移校准)+ P0 终态判定器(task-terminal-verifier 读 Plan.terminalAccept 产物级硬信号:file_exist/stdout_matches/exit_code_zero,无 plan/terminalAccept→unknown 不造假)+ 运行时已接线(wrapWithTerminalArbitration 挂 completionGate 链:plan executing 时读全流程 Experience + 跑终态,单步全 pass 但终态 fail→auditFailed→拦截返 correction 复核,否则透传原 gate)+ ✅ 漂移校准接线(arbitrateTaskTerminal 跑 checkDrift:singleStepPassRate vs terminalSuccessRate,冷启动 guard minDriftSamples=10,drift 检出追加进 correction 提示契约重评,观察性不阻断)] / [待:跨信号独立校验需传感器抽象(几何谓词 pose/joint/video_fps 已实现,但 X5 无 pose 对照信号,真机跨信号需 S 系板)]
- [x] T3.4 契约升层闸(D6):[✅ 纯逻辑已实现(promotion-gate 双门槛:统计置信度 且 跨信号确认,任一单独拒)] / [✅ 运行时接线(PromotionCoordinator + composeCliCompletionGate 固定链顺序 coding→terminal→promotion;promotion 最外层观察者,只在 terminal+coding 都接受后跑,绝不阻断 completion)] / [✅ 自进化真闭环(T3.4 closure):真实候选流过四缝——candidateSource 从终局硬信号统计触发(terminal-verdict log,任务级终态 Plan.terminalAccept 产物硬信号,**非** L1 contractSkill 聚合,D5 可信根边界);statsSource 喂 evaluatePromotion;decisionSink 把决策沉淀为 trust=observation 的 Opinion(升层不改变可信根归属,不自动改任何 ACCEPTANCE.json)] / [✅ D6②跨信号闸端到端(createBiasDetectionVerifier + createPoseCrossSignalVerifier):crossSignalVerifier 从死桩 ()=>false 换成 injectable 偏差检测,经真实 evaluatePromotion 跑通(U5 系统偏差→拒升层,双源一致→可升层);production 接 createPoseCrossSignalVerifier 读 camera/encoder 双源位姿误差做跨信号确认,deviceExecutor 实时取(/connect 后非 null,离线 null→保守 false)。**离线保守不自动升层;板子接上+配置好 readCommand 后候选可真 promotable**] / [待:真机调 camera/encoder readCommand(板子特定路径,需在线板子验证);给现有 force_below 契约填 readCommand/currentRegex 才真生效;契约物化(promotable 后改 ACCEPTANCE.json)]

### Phase 4 — sim2real 边界 + A/B(D8/D9/R4)

- [ ] T4.1 sim2real 负向筛选(D8):只排除明显错误版本,通过版本进真机零置信度重评
- [ ] T4.2 A/B(D9/R4):引入系统侧判定后,"记忆即自律"护栏是否仍有效

---

## 8. 未决问题

- **U1** 多信号交叉校验的权重设计与通过率阈值(层 3 跨信号仲裁具体融合规则)
- **U2** 全新测量实现的接入与背书流程(新传感器接入时,(b)测量有效性主张如何被外部背书)
- **U3** 极端场景全测量信号失效时的降级策略(全硬信号缺失 + 层 3 无独立信号时如何判)
- **U4** 契约升层的人工复核触发条件与流程(D6 中"人确认"的具体阈值与流程)
- [x] **U5** ✅ 已实现并通过(证伪 D5/D6 可信根边界 — 见附录 B 用例,已跑通)
  - **反例场景**:视觉位姿检测存在固定系统性偏差,但因环境固定与终局结果高统计相关
    (统计置信度会通过,但测量本身无效)
  - **目标**:确认升层闸能否通过关节编码器跨信号校验拦截该谓词(层 3 一票否决权是否生效)
  - **意义**:D5/D6 切断自证循环的可证伪测试——跑通即证明非纸上谈兵
  - **状态**:用例已写死(附录 B),待 MVP 后直接跑;跑不通则在写代码前改设计,成本最低
  - 注意:此用例依赖层 3 跨信号校验与 Opinion 演化已实现(Phase 2-3),属回归测试而非单测
- **U6** step_id 精确绑定(MVP 后可选,不阻塞主路径):
  - 现状:工具调用不携带 step_id,方案 A 用 currentStep 近似,够用于步骤级成败统计
  - 选项:(a) 接受近似(MVP 方案);(b) 扩 ToolContext 加 stepId(不推荐为求精度动 core);
    (c) 工具 input 带 step_id,填了精确绑定没填 fallback 近似——**step_id 是执行元数据
    非判据本身,不违反 D5**,可平滑兼容
  - 触发:MVP 跑通后若步骤级失败归因精度不足再上
- **U7** DeviceRegistry / 设备只读执行器(T0.1 查实确定的绕路,已实现):
  - 查实修正:Moss 是**单设备模型**(runtime.deviceSession 一个当前设备),非每会话一设备 →
    U7 从"按 sessionKey 索引"改为**当前设备单例**,不按 sessionKey 分桶;
  - 注入方式:**依赖注入,无全局单例**。cli 建 `deviceExecutor = { get current() {...} }`,
    getter 实时从 `liveRuntime.deviceSession.sshSession` 派生只读执行器,任何 /connect /disconnect
    路径更新 liveRuntime 后 current 自动反映,core 无全局状态(符合 Moss host 注入哲学);
  - 已实现 `core/tools/device-readonly-executor.ts`:`makeReadonlyExecutor` 把 DeviceSshSession
    包成 `runReadOnly`,双保险拒写命令(① 白名单只读动词 + 管道每段白名单 ② 复用
    isCommandDangerous 黑名单),断连/危险/非只读 → 返回 null(让 hook 标 unknown 走层 3,不中断);
  - hook 已接:`fileExists` 对设备绝对路径走 `test -f`(经 readonly executor),本地路径 fallback fs.access;
  - 几何/传感器谓词(位姿/力觉)待 AcceptSpec 契约层(T3)定义谓词后接入,本切片仅文件存在信号

---

## 附录 A:死代码复用清单(T0.0 产出)

三个文件均为**纯函数无外部依赖**,Phase 2 接线即可,无重写压力。

### A.1 `self-learning-memory.ts`(行为:`src/memory/self-learning-memory.ts`)

| 导出 | 入参 → 返回 | 可复用性 | Phase 2 接线 |
|---|---|---|---|
| `buildSelfLearningMemoryDraft` | `(userMessage: string) → {content, scope} \| null` | ✅ 纯函数 | 接到 Observation 聚合输入;但触发逻辑(检测"没改好/不对/记住"等反馈信号)是会话级,需从轮末改为工具级 Experience |
| `buildImplicitLearningDraft` | `(ctx: {consecutiveToolFailures, userFollowUp}) → draft \| null` | ✅ 纯函数 | 连续 ≥3 次工具失败后介入——**直接复用**,与 Experience 层连续失败计数对接 |
| `SelfLearningMemoryDraft` / `ImplicitSignalContext` | 类型 | ✅ | 作 Observation 草稿类型 |

### A.2 `knowledge-card.ts`(行为:`src/memory/knowledge-card.ts`)

| 导出 | 入参 → 返回 | 可复用性 | Phase 2 接线 |
|---|---|---|---|
| `classifyLearningTopic` | `(text) → LearningTopicSlug` | ✅ 已有 vision/hbm/ros/usb/network/deploy/general/other | 直接复用为 Observation 的 topic 分类 |
| `assessKnowledgeTurn` | `({userMessage, assistantMessage, toolsUsed}) → {worth, projectRelated, topic, reason}` | ✅ "是否值得沉淀"判断 | 复用为 Observation 聚合前置过滤(低质量对话不沉淀) |
| `buildKnowledgeCardDraft` | `(input) → {title, topic, content} \| null` | ✅ Q&A 结构化 | 复用为 Observation 卡片生成 |
| `coerceLearningTopic` | `(unknown) → slug \| undefined` | ✅ | 输入校验复用 |
| `LEARNING_TOPIC_SLUGS` | 常量数组 | ✅(已在 memory-manager.ts:143) | topic 白名单 |

### A.3 `memory-context-selector.ts`(行为:`src/memory/memory-context-selector.ts`)

| 导出 | 入参 → 返回 | 可复用性 | Phase 2 接线 |
|---|---|---|---|
| `selectMemoriesForContext` | `({memoryManager, deviceId, projectHash, query, deviceTopN, workspaceTopN, userTopN, maxTotal, minScore}) → MemoryContextPick[]` | ⚠️ 部分 | **当前按 scope 优先级召回,需扩 trust 维度**(配合 T2.1)——召回 Observation/Opinion 时按 trust 分级,World 优先 |
| `renderMemoryPicksForSystemPrompt` | `(picks, sanitizeFn?) → string` | ✅ | 复用为 Reflection 后将 Observation/Opinion 回注 prompt 的渲染 |

> 注:三个文件 `src/` 内无调用点(已二次确认),但均经 `index.ts` 导出为公共 API,
> 非废弃而是"已实现待接线"。接线工作 = T2.2。

---

## 附录 B:U5 可信根边界验收用例(D5/D6 可证伪测试)

> **性质**:回归测试(依赖 Phase 2-3 的层 3 跨信号校验与 Opinion 演化实现),非单测。
> **目标**:证伪 D5/D6 是否真切断自证循环——跑通则设计成立,跑不通则在写更多代码前改设计。

### B.1 反例构造

**被测谓词**:`pose_error_within(threshold: 5mm)`,测量实现 = **视觉位姿检测**
(含未察觉的固定系统性偏差:相机外参标定偏 8mm,导致所有位姿读数系统性偏低 8mm)。

**陷阱**:因测试环境固定(每次抓取目标位置不变),视觉读数的偏差是**恒定**的——
"读数与上次一致"→ 与终局结果(抓取成功/失败)呈现**高统计相关性**(误判率低,
统计置信度 D6 第一门槛会通过)。但测量**本身无效**:它量的不是真实位姿,
是"真实位姿 - 8mm"。

**对照独立信号**:关节编码器正运动学算出的位姿(无该偏差,因为不经过相机)。

### B.2 测试步骤与判定

```
   Step 1  灌入 Experience 数据
   ────────────────────────────────────────────
   生成 N≥30 次抓取 Experience:
     · 视觉 pose_error_within(5mm) 全部判定 pass(因恒定偏差,恒过)
     · 终局硬信号(关节编码器 + 接触力觉)记录真实成败
     · 构造 ~70% 终局成功(让视觉谓词与终局统计相关)

   Step 2  Reflect 统计置信度(D6 第一门槛)
   ────────────────────────────────────────────
   预期:视觉 pose_error_within 与终局成败相关性 > 阈值,误判率 < 阈值
   → 统计置信度门槛 ✅ 通过
   (这是陷阱:相关性是假的,但统计看不出来)

   Step 3  层 3 跨信号有效性校验(D6 第二门槛)
   ────────────────────────────────────────────
   层 3 用【关节编码器】交叉校验视觉位姿:
     · 取若干次"视觉判 pass"的样本
     · 用关节正运动学算独立位姿,与视觉读数对比
     · 发现系统性偏差 8mm(两信号不一致)
   → 测量有效性门槛 ❌ 不通过

   Step 4  升层闸判定(D6 总闸)
   ────────────────────────────────────────────
   D6:统计置信度 ✅ 但测量有效性 ❌ → 一票否决,禁止升层 1
   预期:视觉 pose_error_within 仍留层 2 低可信,不进层 1 契约库
```

### B.3 通过 / 失败标准

| 结果 | 含义 | 后续动作 |
|---|---|---|
| **PASS** | 视觉谓词被挡在层 2,未升层 1 | D5/D6 真切断自证循环,设计成立,继续 Phase 实现 |
| **FAIL:升层了** | 视觉谓词进了层 1 | D6 升层闸失效——层 3 跨信号校验没真正执行或没一票否决。**停下来改设计**(可能需强化层 3 在升层流程中的强制位置) |
| **FAIL:层3没检出偏差** | 关节编码器交叉校验没发现 8mm 系统差 | 层 3 跨信号逻辑太弱(可能只比终局成败,没比测量值本身)。**改层 3 校验规则** |
| **PASS 但理由错** | 挡住了但靠统计置信度不足而非跨信号 | 假阳性——D6 第一门槛碰巧挡住,第二门槛没真起作用。**加用例:让统计置信度真通过、只靠第二门槛挡**(即 B.1 的 70% 终局成功构造) |

### B.4 用例所需的最小实现依赖

- Experience 层可灌入测试数据(T1.3)
- `MemoryEntry.trust` 维度(T2.1)
- Opinion 置信度演化(T2.3)
- 层 3 跨信号校验逻辑(T3.3):能取"视觉判 pass 的样本"+ 用关节编码器算独立位姿 + 比对
- D6 升层闸(T3.4):双门槛判定

> 故 U5 在 Phase 3 完成后可跑。**这是整个可信根体系的验收测试,优先级高于一般功能测试。**

