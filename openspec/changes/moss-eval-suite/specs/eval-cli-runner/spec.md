## ADDED Requirements

### Requirement: 按套件运行
The system SHALL support running evaluation suites by name.

#### Scenario: 运行指定套件
- **WHEN** 执行 `moss eval run --suite L1`
- **THEN** 仅运行 L1-tool-unit-tests 套件

#### Scenario: 运行多个套件
- **WHEN** 执行 `moss eval run --suite L1 --suite L2`
- **THEN** 依次运行 L1 和 L2 套件，输出合并报告

#### Scenario: 运行全部套件
- **WHEN** 执行 `moss eval run --all`
- **THEN** 运行所有已注册套件

### Requirement: 输出格式
The system SHALL support both text and JSON output formats.

#### Scenario: 文本格式输出
- **WHEN** 执行不带 --format 参数
- **THEN** 输出人类可读的文本报告，包含 Summary、Metrics、Cases

#### Scenario: JSON 格式输出
- **WHEN** 执行 `moss eval run --format json`
- **THEN** 输出 JSON 格式报告，包含 summary、results 数组

#### Scenario: 输出到文件
- **WHEN** 执行 `moss eval run --output report.json`
- **THEN** 报告写入指定文件而非 stdout

### Requirement: 运行控制
The system SHALL support timeout, retry, and concurrency configuration.

#### Scenario: 超时控制
- **WHEN** 执行 `moss eval run --timeout 30000`
- **THEN** 每个用例超时时间为 30 秒

#### Scenario: 重试控制
- **WHEN** 执行 `moss eval run --retries 2`
- **THEN** 失败用例最多重试 2 次

#### Scenario: 并发控制
- **WHEN** 执行 `moss eval run --concurrency 4`
- **THEN** 最多同时运行 4 个用例

### Requirement: 套件注册
The system SHALL provide a suite registry for discovering and managing eval suites.

#### Scenario: 列出所有套件
- **WHEN** 执行 `moss eval list`
- **THEN** 返回所有已注册套件的名称和描述

#### Scenario: 套件分组
- **WHEN** 查询套件列表
- **THEN** 套件按层级（L1/L2/L3/adversarial）分组显示

#### Scenario: 套件详情
- **WHEN** 执行 `moss eval info --suite L1`
- **THEN** 返回套件的用例数、覆盖工具列表、评分维度

### Requirement: 环境变量配置
The system SHALL support configuration via environment variables.

#### Scenario: 超时环境变量
- **WHEN** 设置 MOSS_EVAL_TIMEOUT_MS=30000
- **THEN** 未指定 --timeout 时默认使用 30 秒

#### Scenario: 并发环境变量
- **WHEN** 设置 MOSS_EVAL_CONCURRENCY=4
- **THEN** 未指定 --concurrency 时默认并发 4

#### Scenario: 重试环境变量
- **WHEN** 设置 MOSS_EVAL_RETRIES=2
- **THEN** 未指定 --retries 时默认重试 2 次