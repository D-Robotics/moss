# Native RSI SDK and Studio consumer — execution spec

## 用户结果与边界

Moss 脱离 Studio 也能完成“案例→生成→成对评测→晋升→新任务使用→回滚”。
Studio 是 SDK 消费者，保留账号/设备/模型配置、插件启停、HTTP 与页面，不再拥有
另一套学习/评测/晋升算法。此 spec 取代上一阶段“学习闭环全部由宿主拥有”的决策。
现有 SDK 的可选 harnessAdapter 和真实 turn_start/result receipt 继续是执行真源。
不引入模型权重训练、通用调度器、自动改源码或旧 Python 实验工具。

## SDK 契约

1. 在可选 core/rsi 模块导出 RsiEngine、RsiStore、RsiError、通用 artifact/case/
   evaluation/policy/namespace 类型和哈希函数；复用当前成熟的 JSON 原子事务、
   一次性 holdout、exposure ledger、CAS 和独立保留的 validation identity。
   SDK 不 import Studio、SSO、路由、插件注册表或产品路径。
2. RsiEngine 构造接受 rootDir、learning provider/factory 及可选 authorize(scope)
   端口。status 返回通用状态；宿主补 installed/enabled/available/pluginId 等字段。
   scope 由可信宿主给出，SDK 不根据 HTTP/body/query 决定账号。
3. 生成器通过注入的 LLMProvider 调用模型，支持 objective 与 evaluator 端口。
   现有下一步动作分类器可保留为 convenience evaluator，但不是 engine 的领域限制。
   实际任务 evaluator 通过注入 runCase(adapter,case,budget) 复用真实 MossAgent；
   配对、冻结、计量和判据由 SDK 提供，不在 Studio 复制。
4. provider/model/endpoint identity 与 evaluator identity 分离：普通任务只比较模型/
   provider 身份；晋升另外核对冻结 evaluatorVersion/判据。密钥轮换不改变模型身份。
5. captureAdapter 返回冻结策略及可直接传给 ChatOptions 的 harnessAdapter（baseline
   不传空 instructions）。运行期间策略变化不能改变已捕获的 snapshot。
6. 新观测只在 root 原生 turn_start 的真实 harnessAdapter receipt 与选择的
   id/version/sha256 一致时归因 native-sdk；没有执行/receipt 不得伪造已应用。
   不再用 baseSystemPrompt.includes 或 host prompt append 证明原生应用。
   兼容读取已存在的 host-prompt-layer 历史记录。
7. 保留真实 Phase4/durable terminal 收口、child identity 排除、元数据白名单与覆盖缺口。
   无默认全量对话/思考/工具输出捕获，不把可选 RSI 模块扩为全局观测服务。

## 冻结任务定义来源

SDK 提供 enrollTaskCase(scope,{sourceKey,input,expectedOutcome,split,fixtureDigest,
oracleVersion,observationRunId?})，evidence.source=task-fixture 明确表示尚未求解的冻结定义，
不伪造 native run。SDK 自行计算 taskDefinitionDigest。仅训练可绑定真实 terminal observation；
验证/holdout 定义禁止绑定 observation，可以在候选生成前冻结而不提前求解。
propose/evaluate 也拒绝存储中不符合这一分组契约的 observation。actor 只接收 input 与可选观测白名单，
不接收 case IDs、split、oracleVersion、label 或 fixture/definition hash。
fixture 的 exposure/holdout key 仅由 immutable fixtureDigest 决定；更换 sourceKey、文本、
label、oracleVersion 或删除 case 不能使同一数据跨 split 或重置消耗。绑定 observation 时，
同一事务也检查并登记原生 run 来源的 split exposure；普通 enrol、不同 fixture、删除或保留期
清理都不能把这条真实观测转入其他 split。Studio HTTP 只保留
真实 native run 的原 enrol 接口，不开放该可信 host 端口给客户端提交伪造证据。

## 冻结评测与晋升

每次调用模型前冻结 baseline/candidate/case/label/model/provider/evaluator/预算与criterion。
actor 不接收 expected label；生成器不接收 holdout。holdout 执行前消费，失败、删除、
重标注与过期均不能重置。策略/模型/证据漂移必须拒绝晋升。

- 默认 correctness：保持原判据——全部 candidate 正确，且至少一个独立 holdout
  从 baseline 错误变为 candidate 正确。平手拒绝。
- 可选 efficiency：在生成前指定 metric（toolCalls/modelCalls/sshExecCalls）和
  minimumAbsoluteGain>=1。两臂全部任务均正确；每个受保护案例的该计数不增加；
  holdout 合计减少达到门槛。保留两臂原始 metrics，称“效率改善”，不称成功率提升。
- runner/verifier 缺失、非有限计量、provider 异常、预算不足、验收信息不完整均 fail closed。
- 晋升后最小验证身份独立于观测/评测留存；回滚只影响后续运行。

## Studio 集成

server/rsi 只保留配置/门控的薄适配层；共享前端类型复用 SDK 类型，UI-only 契约留在 Studio。
真实 run-agent-lifecycle 的 ChatOptions.harnessAdapter 进入 agent.run/Task OS runner；
移除 run-agent-context 的 RSI prompt append。页面展示原生 receipt、SDK评测结果及可选
效率指标，不把正确性平手称进化成功。现有账号/环境隔离与部署限制保持。

正式产品依赖只能沿上游 main→正式版本/工件→完整 SHA pin/lock 的流程升级。
允许在单独、忽略的 consumer fixture 安装明确标注的候选 npm tarball 做预发布验收；
不能把 unpublished 分支私换进正式 external/moss 或把候选称已发布 SDK。

## 真机至少一轮验收

使用已连接的 RDK X5 真实 SSH；凭据仅在运行时，设备地址/凭据不进入共享 spec 或提交。
只在独立临时板端目录创建本次案例，不动系统配置、网络、固件或原有项目。

1. 连接和身份只读探测，保存真实板型/架构/解释器可用性。
2. 提前冻结可复现的任务生成器、独立 train/validation/holdout、oracle、模型、工具、
   预算与正确性/效率门槛。nonce/任务数据只在板端临时项目中，不把答案写进 adapter。
3. 基线使用正常 Moss 能力；两臂相同模型、任务输入、工具权限与预算，不故意削弱基线。
   可选择板端配置/数据分析任务，以实际 SSH 工具读文件、解析相对路径并生成可检验摘要。
4. 从 training 的真实执行经验生成候选；候选冻结后才执行独立 holdout 配对，保留
   真 SSH/tool 轨迹与独立 oracle 结果，不以 JSON action 或模型散文替代实际任务成功。
5. 至少完整执行一轮：生成→真实成对验收→按冻结判据决定晋升。若通过，必须再执行
   一个新任务，验证新 native receipt；回滚后再执行，验证恢复旧版本。若未通过，
   记录未提升，最多再用新 holdout 进行两轮，不复用旧 holdout 或事后放宽门槛。
6. Studio 消费同一 SDK 后至少真实执行一次任务，核对插件记录与 native receipt 一致；
   候选包验收与正式集成必须区分。不得将受控评分测试称为真实模型能力提升。

## 验证与交付

新增 SDK 公开面同步 semver/contract snapshots/example。运行 Moss build/check、相关
contract/RSI/child/CLI 测试、真实包 consumer、examples、完整 verify；Studio 运行
RSI/owner/native lifecycle 测试、types/build、i18n、harness 与适用 fast/full 门禁。
禁止删测试、放宽 checker、静默 skip 或手工拼接成功证据。

合入 main、tag/公开发布与产品 pin 更新以各自真实门禁及上游权限为准；门禁失败保留原始
结果，完成可独立审阅的代码/候选工件/真机报告，明确待完成步骤，不冒充已发布或已合并。
