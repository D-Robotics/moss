# Moss 发布策略：版本、tag 与证据口径

> 决策日期：2026-10-01。取代 `docs/superpowers/plans/2026-09-30-moss-v014-v020-roadmap.md`
> 中"每版独立硬验收门、缺一不发 tag、上一版未过门下一版不开工"的链式发布约定。

## 决策

1. **main 是滚动线。** 能力持续累积进 main；`package.json` 的版本号表示**当前能力级别**，
   不表示某个被单独验收并发过 tag 的版本。
2. **semver（0.x）**：新增导出、向后兼容扩展 = minor；删除/重命名/行为破坏 = 在提交说明里
   显式写"破坏性变更"。SDK 公共面仍由 `test/sdk-contract.spec.mjs` 快照锁定。
3. **tag 只在有真实证据时打。** 打 tag 前必须：`npm run verify` 全绿（check + 全部 spec + PTY smoke）、
   `npm run examples` 三例实跑通过。tag 说明里必须写清**跑了什么、没跑什么**。
4. **不为从未验收的中间版本补打 tag。** v0.14.0–v0.20.0 永久不补：它们的门（SWE-bench 三跑、
   确定性对、T-Bench 基线、v0.20 全量 bench 复跑）从未执行，补打等于伪造发布证据。
5. **退役的门可随时复活。** 9 个验收脚本移入 `.autopilot/acceptance/retired/`，命令与状态
   逐条登记在 `.autopilot/acceptance/retired/README.md`；哪天门跑完，就按本文件第 3 条主张对应版本号。

## 为什么改口径

`2026-09-30-moss-v014-v020-roadmap.md` 的 E1 已经记录过一次版本欠账（tag 止于 v0.9.0 而
package.json 已 0.13.0）。v0.14–v0.20 期间欠账扩大：代码交付到 v0.21（TUI Mission Control +
统一 Task OS），`package.json` 仍写 0.13.0，中间 8 个版本既无 tag 也无证据，9 个门脚本
停留在 `.autopilot/acceptance/pending/`，夜报正文是"待填"占位。

两种修法：

- **补证据**：需要外部榜单基础设施（Docker 宿主 + SWE-bench official harness + 100 实例三次跑 +
  Terminal-Bench 40 任务 + 数据集/镜像配额），当时未执行，现在仍不具备等量条件。
- **改口径**（本文件）：滚动 main + 单点版本，把"我们主张什么"收缩到当前真实证据能支撑的范围。

选择后者：证据不足时缩小主张，而不是补齐文字。

## 当前主张（2026-10-02，v0.23.0）

- **版本**：`0.23.0`；tag `v0.23.0`。该版本在 v0.22（精简发布）之上交付能力层可用性
  （v0.23 计划见 `docs/superpowers/plans/2026-10-02-v023-capability.md`）：
  - `moss mcp add|list|remove|test`：MCP 生命周期命令（写用户/项目两级 mcp.json，写前校验，
    test 走真 initialize+tools/list）；掉线服务器在下次调用懒重连一次（显式 closeAll 不复活）。
  - `moss device add|list|remove|test`：`.moss/devices.json` 注册表（凭据只存 env 引用名，
    写入即拒绝明文密钥）；解析级联 host > env > registry；test 走真 SSH + 身份探测。
  - `moss skill create|list`：SKILL.md 脚手架（含 $ARGUMENTS 提示）；skill 工具接受 {args}
    注入占位符；会话级 body 缓存（mtime 失效）；/skills 浏览命令（REPL+TUI 同源）。
  - Ghost 清理：/learn 预留名、skill-learning 注释、.moss/skills/learned 计数。
- **已跑、可主张**：
  - `npm run verify`：format/lint/typecheck + 全部 spec 文件 + PTY 冒烟全绿。
  - `npm run examples`：三例实跑通过。
  - 四命令族全部真实运行取证（mcp：add→list→test 50 工具→remove；device：add→registry 落盘→
    list→test；skill：create→list→调用注入）。
  - in-process ssh2 真协议握手（device test 正/反路径）；stdio MCP fixture 真连与懒重连；
    /skills PTY 交互取证。
  - 新增 bench 任务 `domain:skills`（skills-usage：create→discover→inject）。
- **未执行、因此不主张**：SWE-bench/Terminal-Bench/全量 bench 复跑（同 v0.21 口径）；
  真机（非 in-process SSH）设备全链——需设备凭据时另行人工执行（AGENTS.md 纪律）；
  MOSS_LOOP 系 bench 复跑。

## 上一版主张（2026-10-02，v0.22.0）

- **版本**：`0.22.0`；tag `v0.22.0`。该版本在 v0.21（Mission Control TUI + 统一 Task Runtime）之上
  交付全软件精简专项（16 个提交，`ab2e8279…9edd9889`，对账见
  `docs/superpowers/plans/2026-10-02-simplification-v2.md`）：
  - 单一来源：命令目录（REPL/TUI 同表投影）、配置快照（config-snapshot.ts 三视图）、
    环境变量权威清单（`moss config env`，src 扫描双向 CI 锁）、自主循环引擎（/loop /goal
    翻译到 /task run，PASS 只来自 verdict provider）。
  - 人眼版默认视图：/status 6 行、/permissions 5 行、brief help 12 行、TUI 命令面 32→24、
    只读工具结果折叠、运行尾行去 token 遥测。
  - 审批免询问：'a' 持久化（exec 入信任、编辑族一次覆盖、重启生效）；术语与遥测全进 --verbose。
- **已跑、可主张**：
  - `npm run verify`：format/lint/typecheck + 194 个 spec 文件 + PTY 冒烟全绿（精简专项每批独立过门）。
  - `npm run examples`：三个嵌入示例实跑通过（含审批 ALLOW/DENY 审计轨迹）。
  - PTY 交互级 dogfood 两份：通用壳（banner/permissions/task view/jobs/对话轮/退出）与
    引擎合一（/goal --accept → 命令裁决 PASS → accepted → /task status → /loop resume），
    证据 `scratch/dogfood-tui.log`、`scratch/loop-unify.log`（scratch/ 不入库）。
  - CI：v0.22.0 tag 时点 main 上全部 run 绿。
- **未执行、因此不主张**：SWE-bench Verified 三跑、确定性对、Terminal-Bench 基线、全量 bench 复跑
  （同 v0.21 口径，退役门登记于 `.autopilot/acceptance/retired/`）；behavior 层 prompt 压缩
  （待 bench 背书）；safety 解析双链合并（显式遗留）。

## 上一版主张（2026-10-01，v0.21.0）

- **版本**：`0.21.0`；tag `v0.21.0`。该版本覆盖两条已合并的线：
  v0.21 Mission Control TUI + 统一 Task Runtime（Task OS）。
- **已跑、可主张**：
  - `npm run verify`：format/lint/typecheck + 171 个 spec 文件 + PTY 冒烟全绿。
  - `npm run examples`：`examples/` 三个嵌入示例实跑通过。
  - Task OS 三类任务基准 3/3（A 编码 / B 真机设备 / C 故障修复），记录在
    `docs/superpowers/plans/2026-09-30-moss-task-os.md` 与 `bench/results/`（不入库）。
  - v0.13.0 全量基准（easy 100 / hard 93.9）为上一版历史证据，见 `.autopilot/PROGRESS.md`。
- **未执行、因此不主张**：SWE-bench Verified 100 实例的 base2 / v015goal / v016 三跑、
  确定性对、Terminal-Bench 基线、v0.20 全量 bench 复跑、v0.12 三臂 A/B 的第三臂。
  这些项在文档里一律标注"未执行"，不得转述为"已通过"。

## 撤销 / 回到严格链式发布

```bash
git tag -d v0.21.0                    # 撤销本口径的 tag
git revert <本策略的提交>              # 回到候选状态
node .autopilot/acceptance/retired/<gate>.sh   # 逐门执行，跑完再主张版本号
```
