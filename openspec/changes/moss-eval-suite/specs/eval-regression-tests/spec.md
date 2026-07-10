## ADDED Requirements

### Requirement: 版本基线存储
The system SHALL maintain a versioned baseline of test results for regression detection.

#### Scenario: 保存基线
- **WHEN** 运行回归测试套件并指定 --save-baseline
- **THEN** 当前所有用例的得分被保存为基线文件

#### Scenario: 加载基线
- **WHEN** 运行回归测试套件
- **THEN** 自动加载最新基线文件进行对比

#### Scenario: 基线文件格式
- **WHEN** 基线文件被保存
- **THEN** 文件为 JSON 格式，包含 timestamp、version、cases 数组

### Requirement: 回归检测
The system SHALL detect regressions by comparing current results against baseline.

#### Scenario: 检测通过率下降
- **WHEN** 当前用例通过率低于基线 5% 以上
- **THEN** 报告标记为 "REGRESSION DETECTED"

#### Scenario: 检测得分下降
- **WHEN** 单个用例得分较基线下降超过 10%
- **THEN** 该用例标记为 "DEGRADED"

#### Scenario: 新增用例
- **WHEN** 基线中不存在的用例
- **THEN** 标记为 "NEW"，不参与回归对比

#### Scenario: 删除用例
- **WHEN** 用例在基线中存在但当前套件中不存在
- **THEN** 标记为 "REMOVED"，记录在报告中

### Requirement: 历史快照
The system SHALL support preserving snapshots of test results for historical comparison.

#### Scenario: 快照命名
- **WHEN** 创建快照
- **THEN** 快照文件名为 `<version>_<timestamp>.json`

#### Scenario: 快照对比
- **WHEN** 指定两个快照版本进行对比
- **THEN** 输出每个用例的得分变化（+/- 数值）

#### Scenario: 快照列表
- **WHEN** 查询可用快照列表
- **THEN** 返回所有快照的版本和时间戳

### Requirement: 已知问题固定用例
The system SHALL include fixed test cases for known bugs and edge cases.

#### Scenario: 已知 Bug 验证
- **WHEN** 运行包含已知 Bug 的用例
- **THEN** 通过状态表示该 Bug 已被修复

#### Scenario: 历史失败用例
- **WHEN** 运行历史上曾失败的用例
- **THEN** 对比当前得分与历史得分，输出变化趋势