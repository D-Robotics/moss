## ADDED Requirements

### Requirement: 新增功能场景测试
The system SHALL provide test cases evaluating the agent's ability to add new features to an existing codebase.

#### Scenario: 添加 REST API 端点
- **WHEN** 要求添加一个 GET /api/items 端点
- **THEN** 生成包含路由注册、handler、类型定义的代码

#### Scenario: 添加 React 组件
- **WHEN** 要求创建一个 Button 组件
- **THEN** 生成含 props 类型、样式、测试的完整组件

#### Scenario: 添加数据库迁移
- **WHEN** 要求添加 users 表的 migration
- **THEN** 生成含 up/down 的迁移文件

#### Scenario: 添加配置文件
- **WHEN** 要求添加项目配置模块
- **THEN** 生成含默认值、环境变量覆盖的配置代码

#### Scenario: 添加中间件
- **WHEN** 要求添加请求日志中间件
- **THEN** 生成含请求计时、日志输出的中间件

#### Scenario: 添加单元测试
- **WHEN** 要求为现有函数补充测试
- **THEN** 生成覆盖正常/边界/异常情况的测试用例

### Requirement: Bug 修复场景测试
The system SHALL provide test cases evaluating the agent's ability to diagnose and fix bugs.

#### Scenario: 修复空指针异常
- **WHEN** 给定含有 null/undefined 访问的代码
- **THEN** 添加空值检查或可选链

#### Scenario: 修复类型错误
- **WHEN** 给定 TypeScript 类型不匹配的代码
- **THEN** 修正类型声明或使用方式

#### Scenario: 修复竞态条件
- **WHEN** 给定异步操作未正确处理顺序的代码
- **THEN** 添加 await 或 Promise.all 确保正确顺序

#### Scenario: 修复边界条件错误
- **WHEN** 给定数组越界或空集合处理不当的代码
- **THEN** 添加边界检查

#### Scenario: 修复配置缺失
- **WHEN** 给定缺少必要环境变量的运行时错误
- **THEN** 添加配置校验和友好错误提示

#### Scenario: 修复内存泄漏
- **WHEN** 给定未清理的事件监听器或定时器
- **THEN** 添加 cleanup 逻辑

### Requirement: 代码重构场景测试
The system SHALL provide test cases evaluating the agent's ability to refactor code safely.

#### Scenario: 提取公共函数
- **WHEN** 给定两处包含重复逻辑的代码
- **THEN** 提取为独立函数并替换原有调用

#### Scenario: 重命名变量
- **WHEN** 要求将变量名改为更语义化的名称
- **THEN** 所有引用处同步更新且不破坏功能

#### Scenario: 拆分大文件
- **WHEN** 给定超过 500 行的单文件
- **THEN** 按职责拆分为多个模块

#### Scenario: 替换设计模式
- **WHEN** 要求将回调改为 async/await
- **THEN** 保持功能等价且错误处理完整

#### Scenario: 移除死代码
- **WHEN** 给定包含未使用变量、函数、导入的代码
- **THEN** 安全移除未被引用的代码

### Requirement: 项目探索场景测试
The system SHALL provide test cases evaluating the agent's ability to explore and understand unfamiliar codebases.

#### Scenario: 理解项目结构
- **WHEN** 要求描述项目目录结构
- **THEN** 返回包含各目录职责的结构化说明

#### Scenario: 找到特定逻辑
- **WHEN** 要求定位认证逻辑的实现位置
- **THEN** 返回准确的文件路径和关键函数

#### Scenario: 追踪调用链
- **WHEN** 要求追踪某个函数的完整调用链
- **THEN** 返回从入口到出口的完整调用路径

#### Scenario: 识别技术栈
- **WHEN** 要求识别项目使用的技术栈
- **THEN** 返回框架、库、工具链列表

#### Scenario: 分析依赖关系
- **WHEN** 要求分析模块间依赖关系
- **THEN** 返回模块依赖图或说明

### Requirement: 文档生成场景测试
The system SHALL provide test cases evaluating the agent's ability to generate documentation.

#### Scenario: 生成 API 文档
- **WHEN** 要求为 REST API 生成文档
- **THEN** 返回包含端点、参数、响应的结构化文档

#### Scenario: 生成 README
- **WHEN** 要求为项目生成 README
- **THEN** 包含安装、使用、贡献指南等标准章节

#### Scenario: 生成 CHANGELOG
- **WHEN** 要求根据 git 历史生成 CHANGELOG
- **THEN** 按版本分组，列出新增、修复、破坏性变更

#### Scenario: 生成代码注释
- **WHEN** 要求为无注释的代码添加 JSDoc
- **THEN** 每个导出函数/类包含参数和返回值说明

### Requirement: 多步复杂任务场景测试
The system SHALL provide test cases evaluating the agent's ability to handle multi-step complex tasks.

#### Scenario: 全栈 CRUD 实现
- **WHEN** 要求实现完整的 CRUD 功能（路由+服务+数据层+测试）
- **THEN** 所有层级正确实现且风格一致

#### Scenario: 跨文件重构加测试
- **WHEN** 要求重构一个函数签名并更新所有调用方和测试
- **THEN** 所有引用处更新且测试通过

#### Scenario: 从需求到部署
- **WHEN** 要求从自然语言需求描述实现完整功能
- **THEN** 包含代码、配置、文档的完整交付

#### Scenario: 问题排查和修复
- **WHEN** 给定一个模糊的错误报告
- **THEN** 先定位问题根因，再提出修复方案

### Requirement: 场景级评分
The system SHALL use multidimensional scoring for scenario tests: completion (40%), code quality (30%), tool efficiency (20%), step efficiency (10%).

#### Scenario: 完成度评分
- **WHEN** 任务完成
- **THEN** 完成度不低于 70% 为 PASS

#### Scenario: 输出格式正确
- **WHEN** 用例定义了 outputSchema
- **THEN** 输出必须通过 jsonSchemaMetric 校验