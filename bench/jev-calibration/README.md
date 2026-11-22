# MOSS × Jev 校准评测集

版本 `jev-calibration-24.v1`。这 24 题只用于校准评分、日志筛选和完成判定。每道修复题只有一条用户请求。检查点题从给定的工作区及工具事件继续，用户也只发一条请求。

| 题型               |    L1 |    L2 |    L3 |    L4 |   合计 |
| ------------------ | ----: | ----: | ----: | ----: | -----: |
| 常规真实修复       |     3 |     4 |     4 |     3 |     14 |
| 带长日志的真实修复 |     0 |     1 |     2 |     2 |      5 |
| 收尾与过期证据     |     1 |     1 |     1 |     0 |      3 |
| 误拦与开销对照     |     1 |     0 |     1 |     0 |      2 |
| **合计**           | **5** | **6** | **8** | **5** | **24** |

[详细清单](catalog.json)保存每题的冻结来源、环境、四维分值与依据、验收位置和 SHA-256。按定位、耦合、证据、验证依次给 0–3 分，L1 为 0–2 分，L2 为 3–5 分，L3 为 6–8 分，L4 为 9–12 分。当前为首评，档位待第二位评审复核。

## 题目目录

| ID  | 题目                                                                      | 难度               | 来源                                                                                                                                   | 隐藏验收                          |
| --- | ------------------------------------------------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| R01 | [Flask：空名称 Blueprint](agent/R01/request.md)                           | L1 · 0 + 0 + 0 + 1 | [问题](https://github.com/pallets/flask/issues/5010) · [修复 PR](https://github.com/pallets/flask/pull/5014)                           | [验收](evaluator/R01/checks.json) |
| R02 | [Preact：SVG xlink 属性](agent/R02/request.md)                            | L1 · 0 + 0 + 1 + 0 | [问题](https://github.com/preactjs/preact/issues/3441) · [修复 PR](https://github.com/preactjs/preact/pull/3454)                       | [验收](evaluator/R02/checks.json) |
| R03 | [Astropy：短参数列表 FITS 识别](agent/R03/request.md)                     | L1 · 0 + 1 + 0 + 1 | [问题](https://github.com/astropy/astropy/issues/14305) · [修复 PR](https://github.com/astropy/astropy/pull/14309)                     | [验收](evaluator/R03/checks.json) |
| R04 | [Pylint：重复行检测阈值为零](agent/R04/request.md)                        | L2 · 1 + 1 + 1 + 1 | [问题](https://github.com/pylint-dev/pylint/issues/4901) · [修复 PR](https://github.com/pylint-dev/pylint/pull/4970)                   | [验收](evaluator/R04/checks.json) |
| R05 | [pytest：caplog 恢复 handler 级别](agent/R05/request.md)                  | L2 · 1 + 1 + 1 + 1 | [问题](https://github.com/pytest-dev/pytest/issues/7569) · [修复 PR](https://github.com/pytest-dev/pytest/pull/7571)                   | [验收](evaluator/R05/checks.json) |
| R06 | [Preact：渲染装箱字符串](agent/R06/request.md)                            | L2 · 1 + 1 + 1 + 1 | [问题](https://github.com/preactjs/preact/issues/4151) · [修复 PR](https://github.com/preactjs/preact/pull/4152)                       | [验收](evaluator/R06/checks.json) |
| R07 | [Hugo：缺失分组参数](agent/R07/request.md)                                | L2 · 1 + 1 + 1 + 1 | [问题](https://github.com/gohugoio/hugo/issues/12578) · [修复 PR](https://github.com/gohugoio/hugo/pull/12579)                         | [验收](evaluator/R07/checks.json) |
| R08 | [Immutable.js：有序集合的哈希一致性](agent/R08/request.md)                | L3 · 2 + 2 + 1 + 2 | [问题](https://github.com/immutable-js/immutable-js/issues/2002) · [修复 PR](https://github.com/immutable-js/immutable-js/pull/2005)   | [验收](evaluator/R08/checks.json) |
| R09 | [Sphinx：toctree 引用生成页](agent/R09/request.md)                        | L3 · 2 + 2 + 2 + 2 | [问题](https://github.com/sphinx-doc/sphinx/issues/8438) · [修复 PR](https://github.com/sphinx-doc/sphinx/pull/10673)                  | [验收](evaluator/R09/checks.json) |
| R10 | [Astropy：结构化数组列与掩码](agent/R10/request.md)                       | L3 · 1 + 2 + 2 + 2 | [问题](https://github.com/astropy/astropy/issues/13235) · [修复 PR](https://github.com/astropy/astropy/pull/13236)                     | [验收](evaluator/R10/checks.json) |
| R11 | [scikit-learn：ColumnTransformer 的 remainder 输出](agent/R11/request.md) | L3 · 2 + 2 + 2 + 2 | [问题](https://github.com/scikit-learn/scikit-learn/issues/26306) · [修复 PR](https://github.com/scikit-learn/scikit-learn/pull/26323) | [验收](evaluator/R11/checks.json) |
| R12 | [Axum：HEAD 传输中的 Content-Length](agent/R12/request.md)                | L4 · 2 + 3 + 3 + 3 | [问题](https://github.com/tokio-rs/axum/issues/730) · [修复 PR](https://github.com/tokio-rs/axum/pull/734)                             | [验收](evaluator/R12/checks.json) |
| R13 | [Django：仅 DurationField 的表达式](agent/R13/request.md)                 | L4 · 2 + 3 + 3 + 2 | [问题](https://code.djangoproject.com/ticket/28925) · [修复 PR](https://github.com/django/django/pull/13121)                           | [验收](evaluator/R13/checks.json) |
| R14 | [Lucene：地理形状的相等性与哈希](agent/R14/request.md)                    | L4 · 2 + 3 + 2 + 3 | [问题](https://github.com/apache/lucene/issues/13292) · [修复 PR](https://github.com/apache/lucene/pull/13301)                         | [验收](evaluator/R14/checks.json) |
| G01 | [Astropy：零长度多维单元格的表格输出](agent/G01/request.md)               | L2 · 1 + 1 + 2 + 1 | [问题](https://github.com/astropy/astropy/issues/13836) · [修复 PR](https://github.com/astropy/astropy/pull/13838)                     | [验收](evaluator/G01/checks.json) |
| G02 | [Astropy：NumPy 升级后的表列比较](agent/G02/request.md)                   | L3 · 2 + 2 + 2 + 2 | [问题](https://github.com/astropy/astropy/issues/13332) · [修复 PR](https://github.com/astropy/astropy/pull/13390)                     | [验收](evaluator/G02/checks.json) |
| G03 | [Sphinx：C++14 模板参数解析](agent/G03/request.md)                        | L3 · 2 + 2 + 2 + 2 | [问题](https://github.com/sphinx-doc/sphinx/issues/7944) · [修复 PR](https://github.com/sphinx-doc/sphinx/pull/8037)                   | [验收](evaluator/G03/checks.json) |
| G04 | [xarray：循环 attrs 的深复制与展示](agent/G04/request.md)                 | L4 · 2 + 3 + 3 + 3 | [问题](https://github.com/pydata/xarray/issues/7111) · [修复 PR](https://github.com/pydata/xarray/pull/7112)                           | [验收](evaluator/G04/checks.json) |
| G05 | [scikit-learn：并行 SparseCoder 的只读数组](agent/G05/request.md)         | L4 · 2 + 2 + 3 + 3 | [问题](https://github.com/scikit-learn/scikit-learn/issues/5956) · [修复 PR](https://github.com/scikit-learn/scikit-learn/pull/11346)  | [验收](evaluator/G05/checks.json) |
| M01 | [修完截断范围后尚未跑测试](agent/M01/request.md)                          | L1 · 0 + 0 + 0 + 1 | [MOSS 本地夹具](../tasks/single-edit/task.json)                                                                                        | [验收](evaluator/M01/checks.json) |
| M02 | [队列修改发生在测试通过之后](agent/M02/request.md)                        | L2 · 1 + 1 + 1 + 1 | [MOSS 本地夹具](../tasks/test-fix-loop/task.json)                                                                                      | [验收](evaluator/M02/checks.json) |
| M03 | [并行检查结束晚但读的是旧版](agent/M03/request.md)                        | L3 · 1 + 2 + 2 + 3 | [MOSS 本地夹具](../tasks/hard-coupling-refactor/task.json)                                                                             | [验收](evaluator/M03/checks.json) |
| C01 | [只读 Node 检查包含箭头函数](agent/C01/request.md)                        | L1 · 0 + 0 + 0 + 1 | [MOSS 本地夹具](../tasks/hard-stale-spec/task.json)                                                                                    | [验收](evaluator/C01/checks.json) |
| C02 | [历史失败已被两项当前验证覆盖](agent/C02/request.md)                      | L3 · 1 + 1 + 2 + 2 | [MOSS 本地夹具](../tasks/hard-multi-hypothesis/task.json)                                                                              | [验收](evaluator/C02/checks.json) |

真实修复题覆盖 13 个项目，包含 Python、JavaScript/TypeScript、Go、Rust、Java。三个上游数据源都以不可变发布版本记录，参考补丁和回归用例沿用上游许可。机制题与对照题来自 MOSS 已有夹具，检查点的事件顺序是重建的，命令输出来自相应快照中的实际执行。[SWE-bench Verified](https://huggingface.co/datasets/princeton-nlp/SWE-bench_Verified) · [SWE-bench](https://huggingface.co/datasets/princeton-nlp/SWE-bench) · [SWE-bench Multilingual](https://huggingface.co/datasets/SWE-bench/SWE-bench_Multilingual)

## 投放与隔离

1. 在评测目录读取 `catalog.json`，按 digest 取得 Linux amd64 镜像，再校验镜像内上游工作区的 commit 等于 `source.baseline`。随后将该版本文件导出到干净的任务工作区。Agent 端若需要 Git，重新初始化仅有初始快照的本地仓库。子目录配置和依赖在离线运行前准备好。
2. 只给 Agent 当前题的 `agent/<ID>/request.md`，以及该题需要的 `workspace/`、`checkpoint.json` 或 `input/`。长日志复制到 `.moss-eval/input/failure.log` 并设为只读。正式评测把 `evaluator/`、清单、整个 MOSS 源码工作区和上游历史留在单独的评测环境，任务容器使用预置依赖并禁用网络。
3. 真实修复题从另一份相同的可信基线核验候选改动。拒绝修改现有测试、配置和诊断材料的候选。独立应用 `hidden-tests.patch`，执行 `failToPass` 和 `passToPass` 列出的目标及 `additionalChecks`。真实测试必须在日志中出现并通过，零匹配、跳过和环境无法启动分开登记。上游用例允许替代实现，无需与 `reference.patch` 一致。
4. Multilingual 的 `upstream-eval.sh` 仅用于评测端，已内嵌同一份隐藏补丁。运行脚本时使用脚本自己的注入流程，直接执行命令时使用独立的 `hidden-tests.patch`。Python 任务的上游 test parser 采用清单固定的 harness 版本。保留原始 `failToPass` 和 `passToPass` ID，避免解析时因输出别名把缺跑判成通过。
5. 检查点题在对应 `workspace/` 恢复给定快照，按 `checkpoint.json` 的顺序导入工具事件和候选答复，再观察接下来的完成判定。旧快照可以应用 `evaluator/<ID>/checks.json` 的反向覆盖重建；按测试启动时的 revision 确定证据覆盖范围。确定性使用 argv 或支持引号的 shell 拆词。C01 的引号内 `=>` 是 JavaScript 表达式的一部分。

## 长日志和隐藏计分

五题均采用上游故障单里的原始 stdout/诊断段，统一换行并脱敏保留行序；有些诊断来自交互式环境，原始退出码不可得。回放用同一条命令输出历史日志，记录的退出码 1 属于回放协议。验证修复用当前工作区的新命令和实际退出结果。

每份 `checks.json` 记录原始诊断段、分发哈希和必需证据的行范围；范围按分发后的文本从 1 开始，含两个端点。单个证据单元可能有多段，完整保留这些关联信息才计为保留。评测时记录工具输出是否先发生截断、主模型真正收到的内容、Jev 收到的输入及可恢复归档。独立修复验收与证据保留率分别记分。

M01 要求真实启动一项补验。M02 拒绝用旧版绿色结果证明最新版。M03 里旧测试虽然晚退出，读取的是更早的工作区，补跑它即可。C01 评估只读、短输出和引号里的箭头函数。C02 的旧失败已由最新两项成功取代，重复执行计入误拦或冗余验证。

## 入库状态

- 19 道真实修复题已核对公开问题、合并提交、基线涉及文件、OCI digest，以及参考补丁和隐藏补丁单独与联合的 `git apply --check`。
- 5 份长日志已经逐份检查行范围、指纹、字符数和确定性回放。历史诊断来自关联问题，报告中的软件版本可能早于冻结基线。
- 5 道检查点题的 14 次本地夹具校验已记录实际测试退出码和输出。完整 MOSS 检查点回放仍待接入。
- R01 已在隔离的本地临时目录验证：基线 1 失败、59 通过，参考补丁 60 通过，错误补丁 58 失败、2 通过。该记录与冻结 Linux 容器的验收分别保存。
- 独立容器内的基线失败、参考通过和错误补丁拒绝尚待核验。宿主环境没有可用的容器运行器。R13 的 MySQL 和 PostgreSQL 补验设置也需要准备。各候选的 `negativePatchHypothesis` 给出应由隐藏验收拒绝的具体错误修法。
- 余下正式组 96 题另行采集。登记新任务时保留这里的 `source.group`，同源历史缺陷和派生轨迹留在校准组。

[120 题评测集规范](../../docs/specs/moss-jev-evaluation-dataset.md)
