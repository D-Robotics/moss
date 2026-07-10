## ADDED Requirements

### Requirement: 文件工具测试覆盖
The system SHALL provide test cases covering all file manipulation tools: `read_file`, `write_file`, `edit_file`, `move_file`, `list_directory`.

#### Scenario: read_file 基本读取
- **WHEN** 给定一个存在的文本文件路径
- **THEN** 返回文件内容，每行带行号前缀

#### Scenario: read_file 大文件分页
- **WHEN** 给定 offset 和 limit 参数
- **THEN** 仅返回指定范围的行，并标注总行数

#### Scenario: read_file 空文件
- **WHEN** 读取一个空文件
- **THEN** 返回空内容（无错误）

#### Scenario: read_file 不存在的文件
- **WHEN** 读取不存在的路径
- **THEN** 返回错误信息

#### Scenario: write_file 基本写入
- **WHEN** 给定路径和内容
- **THEN** 文件被创建，返回成功消息含字符数

#### Scenario: write_file 覆盖已存在文件
- **WHEN** 写入已存在的文件路径
- **THEN** 旧内容被替换

#### Scenario: write_file 自动创建父目录
- **WHEN** 写入路径的父目录不存在
- **THEN** 自动创建父目录后写入

#### Scenario: edit_file 精确替换
- **WHEN** old_string 在文件中唯一匹配
- **THEN** 替换为 new_string，返回替换数量

#### Scenario: edit_file replace_all 全量替换
- **WHEN** old_string 匹配多处且 replace_all=true
- **THEN** 所有匹配处均被替换

#### Scenario: edit_file 不匹配时报错
- **WHEN** old_string 在文件中不存在
- **THEN** 返回错误，提示 old_string not found

#### Scenario: move_file 移动文件
- **WHEN** source 和 destination 均合法
- **THEN** 文件从 source 移到 destination

#### Scenario: list_directory 列出目录
- **WHEN** 给定有效目录路径
- **THEN** 返回目录内文件/文件夹列表，目录带 `/` 后缀

### Requirement: 搜索工具测试覆盖
The system SHALL provide test cases covering `search_files` and `search_code` tools.

#### Scenario: search_files glob 匹配
- **WHEN** 给定 glob 模式如 "*.ts"
- **THEN** 返回匹配的文件路径列表

#### Scenario: search_files 无结果
- **WHEN** 给定无匹配的 glob 模式
- **THEN** 返回 "No files found"

#### Scenario: search_code 正则搜索
- **WHEN** 给定有效正则表达式
- **THEN** 返回匹配行及上下文

#### Scenario: search_code 文件类型过滤
- **WHEN** 给定 fileTypes 参数
- **THEN** 仅搜索指定扩展名的文件

#### Scenario: search_code 不安全正则拒绝
- **WHEN** 给定可能 ReDoS 的模式
- **THEN** 返回 "pattern rejected" 错误

### Requirement: exec 工具测试覆盖
The system SHALL provide test cases covering the `exec` tool.

#### Scenario: exec 基本命令执行
- **WHEN** 执行简单命令如 echo
- **THEN** 返回 stdout 输出

#### Scenario: exec 命令失败
- **WHEN** 执行返回非零退出码的命令
- **THEN** 返回 "Command failed" 含退出码

#### Scenario: exec 危险命令阻断
- **WHEN** 执行被 safety 规则阻止的命令
- **THEN** 返回 "Command blocked" 含原因

#### Scenario: exec 二进制输出检测
- **WHEN** 命令输出包含大量非打印字符
- **THEN** 返回 "(binary output, suppressed)" 提示

### Requirement: Web 工具测试覆盖
The system SHALL provide test cases covering `web_fetch` and `web_search` tools.

#### Scenario: web_fetch 抓取 URL
- **WHEN** 给定有效 HTTP URL
- **THEN** 返回页面内容摘要

#### Scenario: web_fetch 无效 URL
- **WHEN** 给定无效或不可达的 URL
- **THEN** 返回错误信息

#### Scenario: web_search 关键词搜索
- **WHEN** 给定搜索关键词
- **THEN** 返回搜索结果列表

### Requirement: 子 Agent 工具测试覆盖
The system SHALL provide test cases covering subagent tools: `create_subagent`, `fan_out_subagents`, `subagent_status`, `subagent_stop`.

#### Scenario: create_subagent 创建子 Agent
- **WHEN** 给定任务描述
- **THEN** 返回子 Agent ID 和初始状态

#### Scenario: subagent_status 查询状态
- **WHEN** 给定有效子 Agent ID
- **THEN** 返回子 Agent 当前状态

#### Scenario: fan_out_subagents 并行派发
- **WHEN** 给定多个任务
- **THEN** 并行创建多个子 Agent

### Requirement: 设备工具测试覆盖
The system SHALL provide test cases covering device tools: `device_ssh`, `device_ros2`, `device_diagnostics`, `batch_device`.

#### Scenario: device_ssh 命令执行
- **WHEN** 对已配置设备执行 SSH 命令
- **THEN** 返回远程执行结果

#### Scenario: device_diagnostics 诊断报告
- **WHEN** 对已配置设备执行诊断
- **THEN** 返回包含温度、BPU、摄像头等状态的报告

### Requirement: 其他工具测试覆盖
The system SHALL provide test cases for remaining tools: `install_skill`, `apply_patch`, `code_diagnostics`, `vision_analyze`, `plan`, `plan_step`.

#### Scenario: install_skill 安装 Skill
- **WHEN** 给定合法的 name、description、body
- **THEN** 创建 .moss/skills/<name>/SKILL.md

#### Scenario: apply_patch 应用补丁
- **WHEN** 给定有效的 unified diff
- **THEN** 补丁成功应用到目标文件

#### Scenario: apply_patch 冲突补丁
- **WHEN** 补丁与当前文件内容冲突
- **THEN** 返回冲突错误

#### Scenario: code_diagnostics 代码诊断
- **WHEN** 对 TypeScript 文件执行诊断
- **THEN** 返回诊断问题列表

#### Scenario: plan 创建计划
- **WHEN** 给定任务描述
- **THEN** 返回结构化执行计划

### Requirement: 度量指标集成
The system SHALL use at least 3 metrics per test case from the available pool: exactMatch, containsAll, containsAny, tokenOverlap, toolUsage, jsonSchema.

#### Scenario: 每个用例至少 3 个指标
- **WHEN** 运行任意测试用例
- **THEN** 结果包含至少 3 个 metric 评分

#### Scenario: 工具类用例使用 toolUsage 指标
- **WHEN** 用例期望验证工具调用正确性
- **THEN** 必须包含 toolUsage metric