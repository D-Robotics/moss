## 1. 基础设施准备

- [ ] 1.1 创建 `packages/moss-agent/src/eval/suites/` 目录结构
- [ ] 1.2 创建 `suites/custom-metrics.ts` — 新增 3 个自定义 metric 函数（codeQualityMetric、stepEfficiencyMetric、completionMetric）
- [ ] 1.3 创建 `suites/index.ts` — 套件注册表，导出所有套件和 `getAllSuites()`、`getSuite(name)` 函数

## 2. Layer 1: 单工具单元测试套件

- [ ] 2.1 创建 `suites/L1-tool-unit-tests.ts` — 文件工具测试（12 用例：read/write/edit/move/list）
- [ ] 2.2 添加搜索工具测试（8 用例：search_files/search_code，含 glob、正则、过滤、无结果、不安全正则）
- [ ] 2.3 添加 exec 工具测试（8 用例：基本命令、超时、错误退出码、危险命令阻断、二进制输出、Windows 兼容）
- [ ] 2.4 添加 Web 工具测试（6 用例：web_fetch 有效/无效 URL、web_search 关键词）
- [ ] 2.5 添加 patch 工具测试（5 用例：正常 patch、冲突、格式错误、空 patch）
- [ ] 2.6 添加子 Agent 工具测试（5 用例：create/stop/status/fan-out）
- [ ] 2.7 添加设备工具测试（4 用例：device_ssh、device_diagnostics）
- [ ] 2.8 添加其他工具测试（7 用例：install_skill、code_diagnostics、plan、apply_patch 等）
- [ ] 2.9 验证 L1 套件可被 `EvalRunner` 正确加载，总用例数 ≥ 55

## 3. Layer 2: 场景端到端测试套件

- [ ] 3.1 创建 `suites/L2-scenario-e2e-tests.ts` — 新增功能场景（6 用例：REST API、React 组件、DB migration、配置、中间件、测试）
- [ ] 3.2 添加 Bug 修复场景（6 用例：空指针、类型错误、竞态条件、边界条件、配置缺失、内存泄漏）
- [ ] 3.3 添加代码重构场景（5 用例：提取函数、重命名、拆分文件、async/await 迁移、移除死代码）
- [ ] 3.4 添加项目探索场景（5 用例：理解结构、定位逻辑、追踪调用链、识别技术栈、分析依赖）
- [ ] 3.5 添加文档生成场景（4 用例：API 文档、README、CHANGELOG、代码注释）
- [ ] 3.6 添加多步复杂任务场景（4 用例：全栈 CRUD、跨文件重构、需求到部署、问题排查）
- [ ] 3.7 验证 L2 套件可被 `EvalRunner` 正确加载，总用例数 ≥ 30

## 4. Layer 3: 回归测试套件

- [ ] 4.1 创建 `suites/L3-regression-tests.ts` — 版本基线存储/加载/对比逻辑
- [ ] 4.2 添加回归检测用例（5 用例：通过率下降、得分下降、新用例、删除用例、快照对比）
- [ ] 4.3 添加已知问题固定用例（5 用例：从历史 Bug 中提取的验证用例）
- [ ] 4.4 验证 L3 套件可被 `EvalRunner` 正确加载，总用例数 ≥ 10

## 5. 对抗性测试套件

- [ ] 5.1 创建 `suites/adversarial-tests.ts` — 模糊需求测试（3 用例：不完整、多义、缺关键信息）
- [ ] 5.2 添加错误信息测试（3 用例：语法错误、逻辑矛盾、不存在的路径）
- [ ] 5.3 添加边界条件测试（3 用例：超大文件、空项目、特殊字符路径）
- [ ] 5.4 添加安全边界测试（3 用例：路径穿越、命令注入、敏感信息泄露）
- [ ] 5.5 验证对抗性套件可被 `EvalRunner` 正确加载，总用例数 ≥ 12

## 6. CLI 运行器

- [ ] 6.1 创建 `eval/run-eval.ts` — 实现 `runSuite(name)` 和 `runAllSuites()` 函数
- [ ] 6.2 支持 --suite 参数按套件运行，支持 --all 运行全部
- [ ] 6.3 支持 --format text|json 输出格式切换
- [ ] 6.4 支持 --output <file> 写入文件
- [ ] 6.5 支持 --timeout、--retries、--concurrency 运行控制参数
- [ ] 6.6 支持环境变量 MOSS_EVAL_TIMEOUT_MS、MOSS_EVAL_CONCURRENCY、MOSS_EVAL_RETRIES
- [ ] 6.7 实现 `listSuites()` 函数，按层级分组显示套件信息

## 7. 验证与文档

- [ ] 7.1 用 mock 正确答案跑全部套件，确认所有用例评分逻辑正确
- [ ] 7.2 用 mock 错误答案跑全部套件，确认能检测出失败
- [ ] 7.3 创建 `eval/README.md` 使用说明
- [ ] 7.4 在 `packages/moss-agent/src/eval/index.ts` 中导出新增模块