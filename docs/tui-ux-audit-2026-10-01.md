# Moss TUI（Mission Control）UX 审计 — 2026-10-01

> 审计对象：`dist/cli.js` 的全屏 TUI（`--no-tty` 之外的默认交互面）
> 判定基线：**HEAD = `e220873a`**（`chore: prettier retired ledger + refresh perf-budget evidence from the verify run`）
> 证据来源：真实 PTY + pyte 屏幕转储（`scratch/shots*/`，采集时间 00:21–00:28）与本次评审读到的真实源码
> 声明：本文只记录**实际观察到**的现象。凡未复现、未验证的，均在条目内以「未复现/未验证」明确标注。
> 审计期间工作区正在被 Lead 修改（00:28 起 `src/cli/{terminal-text,cli/tui/{app,layout,overlays,panels,transcript-view}}.ts` 出现未提交改动）。转储中的行为与 **HEAD 源码逐条对应**（见各条根因），因此根因行号一律按 HEAD 给出；工作区改动只在第 6 节「修复方案」里作为**修复状态**记录。

---

## 0. 后续决策（2026-10-01 收尾）：Mission Control 被否决，改为 Claude Code 形态

本审计修完 11 项之后，用户给出的结论是「当前这种不好，还是和 claude / codex 一样的 CLI 就很好」。
即 **三栏 Mission Control 这个形态本身**（固定画布 + 侧栏 + 降级 transcript）不是想要的交互面，
所以 v0.22 按下面这条路线重做了 TUI（详细对照见 §8）：

- **单列 transcript 走终端 scrollback**（ink `<Static>` 提交已完成的行），历史可滚动、可选中复制；
  不再有侧栏、画布、overlay，也没有"把对话降级"这回事。
- **底部 composer 固定**：右对齐状态行 → 全宽横线 → `❯ 输入` → 全宽横线 → 提示行，与参考实现同构。
- **语法对齐**：`❯` 用户 / `⏺` 回答与工具调用 / `⎿` 工具结果 / `·` 思考（暗色）/ `✢…✻` 运行中与收尾状态；
  `/tasks`、`/evidence`、`/deployments`、`/failures`、`/history` 等命令**打印进 transcript**，不再开 overlay。
- **审批内联**：`╌` 分隔的预览块 + `❯ 1. Yes / 2. Yes, and don't ask again / 3. No`，`1/2/3` 与 `y/a/n` 都可答。
- 参考基线用真实 PTY 采集（本机 `claude` v2.1.285，90×30 / 80×24），moss 用同一 harness
  （`scratch/tui-drive.py --bin`）同尺寸并排比对。

结论：§3 的问题清单仍然成立（它们是**任何**形态下都算缺陷的东西：单元格宽度、Ctrl+H 不可达、
composer 看不到尾部、常驻告警……），但 §3.4/3.5/3.6/3.7/3.10/3.11 这些**由三栏形态派生**的问题
随形态一起消失——不是被修好，而是不再存在。

---

## 1. 摘要

**测了什么、怎么测的。** 用真实 PTY 驱动 harness（`scratch/tui-drive.py`，fork `dist/cli.js` 到 pty、脚本化按键、用 pyte 重建人眼可见的单元格与 SGR 属性），在 8 种终端尺寸（40×12 / 60×18 / 80×24 / 80×40 / 110×22 / 110×40 / 120×30 等）下跑了两类工作区：空工作区与 `scratch/seed-ws.mjs` 生成的已填充工作区（3 个任务 / 4 条 evidence / 1 次部署 / 2 次验收裁决，另有 `scratch/ws-cjk` 的中文 + emoji 目标），真实模型 `qwen3.8-max`（ali provider），并覆盖了冷启动、输入、运行中、运行结束、三个 Ctrl 快捷键、五个 overlay 与三次缩放。本次复核还**实跑验证了 harness 本身可用**（见 2.6）。

**结论。** 发现了 13 项可复现的体验/正确性缺陷（S1×3、S2×6、S3×4），另有 1 次未复现的启动崩溃按 flake 记录（3.14）；同时排除了 2 类由 harness 造成的假阳性（第 4 节，勿再上报）。

> **收口状态（2026-10-01 收尾，已实测）**：13 项中 11 项已修复并通过回归 spec + 真实 PTY 复验；3.7 的进一步收敛与 3.12 的 40 列产品策略仍开放（见 §6.1）。修复过程中又发现了 1 项新缺陷（3.15：思维链被并入答案），已一并修复。

**Top 3 问题**

1. **运行期没有「执行面」**（3.4 / 3.5）：agent 跑起来之后，中央画布仍然停在冷启动的空态文案上，唯一在动的只有 composer 上方 2 行没有标签的裸模型文本；跑完这 2 行被清掉，答案从可见面上消失（只是被降级进 transcript，需要知道 Ctrl+O 才能找回）。
2. **CJK / 双宽字符让整帧错位**（3.1）：中文或 emoji 目标使面板边框整体偏移、导航项被拆成两行、GOAL 在字中间断行——根因是布局数学用 `String.length`（UTF-16 码元）而不是终端单元格宽度。
3. **composer 只有一行且尾部不可见**（3.3）：长目标被裁成一行，用户看不到（也无法回头改）自己正在输入的内容尾部。

---

## 2. 测试方法

### 2.1 驱动器：`scratch/tui-drive.py`（真实 PTY，不是 mock）

- `Driver.__init__`（`scratch/tui-drive.py:83-107`）：`pty.openpty()` → `TIOCSWINSZ` 设定行列 → `subprocess.Popen([MOSS_NODE, dist/cli.js], stdin/stdout/stderr=slave, env=白名单环境, cwd=workspace, preexec_fn=os.setsid)`。环境的 `HOME` / `MOSS_CONFIG_DIR` / `MOSS_RUNTIME_DIR` 都指向临时目录，**这是复现「无模型配置」提示页的原因**。
- `pump`（:109-128）：非阻塞读 master，喂给 `pyte.Stream`；关键实现细节见 :122-124 注释——用**增量 UTF-8 解码器**，避免跨 read 切断多字节字符产生 U+FFFD（这正是假阳性的来源，见第 4 节）。
- `resize`（:133-140）：`TIOCSWINSZ` + `SIGWINCH`（发给进程组）。
- `dump`（:142-175）：把 pyte 的 `screen.display` 逐行 `rstrip` 写成 `<name>.txt`，并把每个单元格的 SGR 属性写成 `<name>.style`（`f<color>`/`b<color>`/`B`old/`R`everse），例如 `[⚠|fbrownB]` 表示粗体 + ANSI 33。
- 步骤 DSL（:12-18）：`wait:MS` / `shot:NAME` / `key:NAME` / `text:STRING` / `resize:COLSxROWS` / `raw:HEXBYTES`；`--boot-ms` 在步骤前先 pump（默认 1600ms）。
- 键位表（:44-71）：`enter=\r`、`esc=\x1b`、`tab=\t`、`bs=\x7f`、`ctrl-h=\x08`、`ctrl-t=\x14`、`ctrl-e=\x05`、`ctrl-a=\x01`、`ctrl-g=\x07`、`ctrl-f=\x06`、`ctrl-o=\x0f`、`ctrl-c=\x03`。

### 2.2 渲染重建：pyte

每个 `shot` 同时落 `<name>.txt`（人眼所见）与 `<name>.style`（色/粗体），因此「黄色告警」这类结论有 SGR 证据，不只是文字推断。

### 2.3 场景清单（磁盘上的转储 = 本次审计的证据集）

| 转储目录                                                  | 尺寸                   | 场景                                            | 主要用途                                        |
| --------------------------------------------------------- | ---------------------- | ----------------------------------------------- | ----------------------------------------------- |
| `scratch/shots-boot/f1..f5.txt`                           | 80×24                  | 冷启动连拍（f1/f2 为空帧，f3=f4=f5 为稳定帧）   | 空态、死行、稳定帧确认                          |
| `scratch/shots-080/boot.txt`                              | 80×24                  | 无模型配置                                      | setup 提示页（**本次复核已字节级复现**）        |
| `scratch/shots-080/boot80.txt`                            | 80×24                  | 早期同一场景                                    | 假阳性（两行状态栏）对照                        |
| `scratch/shots/trace/boot.txt`                            | 80×24                  | 带 `TUI_TRACE` 的冷启动                         | 帧稳定                                          |
| `scratch/shots/type/typed.txt`                            | 80×24                  | 输入一个完整目标                                | composer、失效提示（F9a）                       |
| `scratch/shots/long/long.txt`                             | 80×24                  | 输入超长目标                                    | composer 单行截断（F3）                         |
| `scratch/shots/bs/after-bs.txt`                           | 80×24                  | 输入后回退一格（`0x7f`）                        | 输入编辑可用                                    |
| `scratch/shots/pick/pick1.txt`、`pick2.txt`               | 80×24                  | 例子 pick（1/2/3）载入后回车                    | 例子路径、placeholder 切换                      |
| `scratch/shots/run/r1..r4.txt`                            | 80×24                  | 完整 agent 轮次：r1 起跑、r2/r3 流式中、r4 结束 | **F4 / F5 的核心证据**                          |
| `scratch/shots/keys/ctrlh.txt`、`tabnav.txt`、`ctrlo.txt` | 110×40                 | 已填充工作区下 Ctrl+H / Tab / Ctrl+O            | F2、F10                                         |
| `scratch/shots/keys/ctrlg.txt`                            | 110×40                 | Ctrl+G 部署检视                                 | F10                                             |
| `scratch/shots/menu/menu.txt`                             | 80×24                  | Ctrl+A 动作菜单                                 | F2（菜单广告 Ctrl+H）、F7                       |
| `scratch/shots/help/help.txt`                             | 80×24                  | `?` 帮助                                        | F7、F9b、F10 对照（帮助是填满的）               |
| `scratch/shots/tasks/tasks.txt`、`t1..t3/tk.txt`          | 80×24                  | Ctrl+T 任务切换（含早期/重跑）                  | 假阳性（U+FFFD 边框）对照                       |
| `scratch/shots/demo-wide/wide.txt`                        | 110×40                 | 已填充工作区基线帧                              | **F6 / F7 对照基线**                            |
| `scratch/shots/demo-wide/switcher.txt`                    | 110×40                 | Ctrl+T                                          | F6（同一批任务在切换器里有目标全文）            |
| `scratch/shots/demo-wide/history.txt`                     | 110×40                 | Ctrl+H                                          | **F2（与 wide.txt 逐字节相同 = 什么都没发生）** |
| `scratch/shots/demo-wide/evidence.txt`                    | 110×40                 | Ctrl+E                                          | F11                                             |
| `scratch/shots/demo-wide/failure.txt`                     | 110×40                 | Ctrl+F                                          | F10、空数据面                                   |
| `scratch/shots/small/s40x12.txt`                          | 40×12（缩放序列）      | 缩到 40×12                                      | 假阳性（resize 未稳定）                         |
| `scratch/shots/small/s60x18.txt`、`r110x22.txt`           | 60×18 / 110×22         | 缩放序列                                        | F8（窄屏状态栏取舍）、F13                       |
| `scratch/shots/tiny/boot40.txt`、`tab40.txt`              | 40×12                  | **冷启动** + Tab                                | **F12（40 列语义截断，几何正确）**              |
| `scratch/shots/fresh110/fresh110x22.txt`                  | 110×22                 | 冷启动                                          | F12 对照（更宽但只有 22 行）                    |
| `scratch/shots/rsz/to40.txt`、`back24.txt`                | 80×40 → 80×24          | 缩放两帧                                        | 假阳性（back24 未稳定）                         |
| `scratch/shots/rsz2/a24.txt`、`b40.txt`、`c120x30.txt`    | 80×24 / 80×40 / 120×30 | 缩放重跑 + Tab                                  | 假阳性排除的依据                                |
| `scratch/shots/cjk/cn-canvas.txt`、`cjk/switcher.txt`     | 80×24                  | `ws-cjk`（中文 / emoji）                        | **F1（emoji 变体）**                            |
| `scratch/shots/cn/cn.txt`                                 | 80×24                  | `ws-cjk` + 切换任务                             | **F1（中文整帧错位，核心证据）**                |
| `scratch/shots/cjk2/`                                     | —                      | 冷启动                                          | **3.14：空目录（崩溃/flake 的唯一磁盘痕迹）**   |
| `scratch/shots/cjk3/boot.txt`、`cjk4-{1,2,3}/boot.txt`    | 110×30 / 80×24         | 冷启动重试                                      | 3.14（3 次重试均正常）                          |

### 2.4 真实模型

头部状态栏显示 `· qwen3.8-max`（如 `scratch/shots-boot/f3.txt:1`），即 `~/.dsh/settings.yaml` 里配置的 ali / `qwen3.8-max`；因此运行期转储（`run/r2.txt`、`run/r3.txt`）里的文本是真实模型流的输出，不是 mock。

### 2.5 已填充工作区：`scratch/seed-ws.mjs`

`node scratch/seed-ws.mjs <ws>` 直接调用构建产物写入 `.moss/` 工件：`appendTaskRecord` / `appendAcceptanceVerdict` / `appendEvidenceRecord`（`scratch/seed-ws.mjs:10-15`）。`scratch/ws-demo/.moss/` 现有 `tasks.jsonl:3`、`evidence.jsonl:4`、`deployments.jsonl:1`、`acceptance.jsonl:2`；`scratch/ws-cjk/.moss/tasks.jsonl` 有 `task_cn1`（中文目标）与 `task_emoji`（emoji 目标）。

### 2.6 本次复核实跑的验证（只写 `/tmp`，未触碰仓库）

harness 可用性本身被实测过一遍（无模型配置 → setup 提示页，不触发任何模型调用）：

```bash
cd /Users/d-robotics/Desktop/RDK_Studio/moss
python3 scratch/tui-drive.py --cols 80 --rows 24 --out /tmp/uxaudit-probe --steps 'wait:1500,shot:boot'
diff -q /tmp/uxaudit-probe/boot.txt scratch/shots-080/boot.txt   # 实测：IDENTICAL
```

结果：`diff` 无输出（597 字节逐字节相同），说明 harness + pyte + `dist/cli.js` 在本 checkout 上可复现历史转储；`git status` 在探针前后不变。**未跑** `npm run build/test/smoke`（按委托要求）。

### 2.7 未验证的部分

- 原始每次调用的完整 argv 没有落盘（每个 dump 目录只有 `.txt`/`.style`/`raw.log`），第 7 节的命令是按转储的尺寸与内容**重建**的；harness 本身已验证可跑。
- 真实设备相关的面板（CONTEXT / DEVICE / DEPLOYMENTS 的实时观测）没有真机数据，本轮只覆盖了 `.moss/` 工件投影与「无设备」状态。

---

## 3. 问题清单（按严重度排序）

严重度定义：**S1 阻断**（该场景下主流程不可用/信息错误）·**S2 严重**（可用但持续性误导或关键信息缺失）·**S3 体验缺陷**。

### 3.1 [S1] CJK / 双宽字符导致整帧错位

**现象**（`scratch/shots/cn/cn.txt`，80×24，`ws-cjk`，任务切换后）：

```
╭──────────────────╮ ╭─────────────────────────────────────────────────────────╮
│TASKS (2)         │ │▸ task_cn1 · CAMERA                                IDLE  │
│  _emoji          │ │GOAL                                                     │
│IDLE              │ │  把相机管线部署到 RDK X5                                │
│▸ sk_cn1          │ │上并测量六十秒的稳定帧率，同时记录 CPU                   │
│IDLE              │ │  温度和内存占用，最后把结果写进证据                     │
│● _emoji          │ │PROGRESS  0/1 criteria met                               │
│                  │ │  · camera_fps >=30  no evidence                         │
```

以及紧随其后的通知行（`scratch/shots/cn/cn.txt:19-20`）：

```
Switched to task_cn1 — 把相机管线部署到 RDK X5
上并测量六十秒的稳定帧率，同时记录 CPU 温度和内存占用，最后把结果写进证据
```

三条可机检的症状：

1. 几何错位：导航盒边框只有 20 列、画布盒 59 列；同一终端宽度（80 列）的英文转储是 22 / 57（`scratch/shots-boot/f3.txt:2`）。整行向右多占 2 个单元格。
2. 导航项被拆行：`│  _emoji          │` 之后是 `│IDLE              │`，即 `IDLE` 掉到了下一行，边框被截断。
3. GOAL 在字中间断行（`…RDK X5` / `上并测量…`），且可见行尾留白不齐；通知行第 2 行开头是 `上`，说明换行点没有按单元格宽度计算。

emoji 变体同样受影响：`scratch/shots/cjk/switcher.txt:5` 的 `    📷 camera pipeline 🚀 deploy to the board and check that everything is` 把 2 个 emoji 各按 1 格计算。

**复现**

```bash
python3 scratch/tui-drive.py --cols 80 --rows 24 \
  --workspace "$PWD/scratch/ws-cjk" --out /tmp/ux/cn \
  --steps 'wait:1200,key:ctrl-t,key:down,key:enter,shot:cn'
```

**根因**

- `src/cli/tui/panels.ts:36-38`（HEAD）`clip()` 用 `text.length > width` 判断并 `text.slice(0, width-1)` 截断——`length` 是 UTF-16 码元，一个汉字/emoji 记 1 但占 2 格，于是所有测量值最多只有真实宽度的一半。
- `src/cli/tui/panels.ts:41-` (HEAD) `wrap()` 用 `candidate.length > max` 判断行宽，同样按码元计。
- `src/cli/tui/panels.ts:230-234`（HEAD）画布标题的 `headPad` 用 `head.length + stateText.length` 计算补白。
- `src/cli/tui/app.ts:124-139`（HEAD）`fitStatusBar` 用 `segment.text.length` 累加判断是否放得下（同一类错误，影响带中日文的模型名/通知）。
- 后果链：测量偏小 → 输出行超出面板宽度 → ink 对超宽的 `<Text>` 做软换行（`src/cli/tui/app.ts:124-128` 的注释明确写了 ink 会 wrap）→ 该行折行 → 整行重排，边框整体错位，不只是那一行难看。

> 工作区已有修复方向：`src/cli/terminal-text.ts` 新增 `displayWidth()`（`stringWidth`），`panels.ts` 的 `clip`/`wrap`/`padTo`/`padStartTo` 改走单元格宽度（见 `git diff`）。**未验证**。

### 3.2 [S2] Ctrl+H 不可达，但界面到处广告它

**现象 1 —— 按键无任何效果。** 同一场景（110×40，`ws-demo`）基线帧 `scratch/shots/demo-wide/wide.txt` 与 Ctrl+H 之后的 `scratch/shots/demo-wide/history.txt` **逐字节相同**：

```bash
diff -q scratch/shots/demo-wide/wide.txt scratch/shots/demo-wide/history.txt   # 无输出 = 完全相同
diff -q scratch/shots/demo-wide/wide.txt scratch/shots/demo-wide/switcher.txt  # 有差异（Ctrl+T 生效）
diff -q scratch/shots/demo-wide/wide.txt scratch/shots/demo-wide/evidence.txt  # 有差异（Ctrl+E 生效）
diff -q scratch/shots/demo-wide/wide.txt scratch/shots/demo-wide/failure.txt   # 有差异（Ctrl+F 生效）
```

同一结论的第二个实例：`scratch/shots/keys/ctrlh.txt` 与 `scratch/shots/keys/tabnav.txt` 也**逐字节相同**。

**现象 2 —— 界面持续广告这个键。** 动作菜单（`scratch/shots/menu/menu.txt:6`）：

```
│  Task history  (Ctrl+H)                                                      │
```

帮助页（`scratch/shots/help/help.txt:11`）把它压进组合键行：

```
│  Ctrl+T H E  tasks · history · evidence                                      │
```

**复现**

```bash
# 生效对照
python3 scratch/tui-drive.py --cols 110 --rows 40 --workspace "$PWD/scratch/ws-demo" --out /tmp/ux/k1 \
  --steps 'wait:1200,shot:wide,key:ctrl-t,shot:switcher'
# 无效果
python3 scratch/tui-drive.py --cols 110 --rows 40 --workspace "$PWD/scratch/ws-demo" --out /tmp/ux/k2 \
  --steps 'wait:1200,shot:wide,key:ctrl-h,shot:history'
diff -q /tmp/ux/k2/wide.txt /tmp/ux/k2/history.txt   # 无输出
```

**根因**

- `node_modules/ink/build/parse-keypress.js:428-432`：

  ```js
  else if (s === '\b' || s === '\x1b\b') {
    // backspace or ctrl+h
    key.name = 'backspace';
    key.meta = s.charAt(0) === '\x1b';
  }
  ```

  即 `0x08` 被映射成 `name='backspace'`，而 `key.ctrl = true` 只在下一分支（`:447-451`，单字符且 `<= '\x1a'`）里设置——`\b` 已经在前面的 `else if` 被吃掉，**`key.ctrl` 永远为 falsy**。

- `src/cli/tui/app.ts:742`（HEAD）要求 `key.ctrl && ...`，`:750` 的 `controlKey === 'h'` 分支因此不可达；`?` 帮助页与动作菜单仍照常宣传它（`src/cli/tui/overlays.ts:42`、`:299` HEAD）。

> 工作区已有修复方向：`overlays.ts` 新增 `CTRL_BINDINGS`，把 history 挪到 `Ctrl+R`，并在注释里直接引用了上面这行 `parse-keypress` 证据（见 `git diff`）。**未验证**。
> 未验证的一点：按 ink 的映射，`0x08` 会作为 backspace 落到 `app.ts:923` 的编辑分支；在 composer 有内容时按 Ctrl+H 是否会**吃掉一个字符**，本轮转储里 composer 是空的，**未复现/未验证**。

### 3.3 [S1] composer 只有一行，输入尾部不可见

**现象**（`scratch/shots/long/long.txt:19`，80×24，输入超长目标）：

```
› Deploy the camera pipeline to the RDK X5 board and measure sustained FPS for …
```

对比：目标较短时同一行完整可见（`scratch/shots/type/typed.txt:19`）：

```
› Make the robot patrol the corridor and report when it sees a person▌
```

也就是说 composer 被硬裁成一行，**保留头部、丢掉尾部**，而光标（`▌`）与正在输入的尾部一起消失；界面没有任何横向滚动、纵向换行或查看全文的入口。

**复现**

```bash
python3 scratch/tui-drive.py --cols 80 --rows 24 --out /tmp/ux/long \
  --steps 'text:Deploy the camera pipeline to the RDK X5 board and measure sustained FPS for twelve hours,shot:long'
```

**根因**

- `src/cli/tui/panels.ts:556-557`（HEAD）：

  ```ts
  export function renderInputLine(input: string, width: number, placeholder: boolean): PanelLine[] {
    const prompt = placeholder ? '› goal: describe what the robot should do…' : `› ${input}▌`;
    return [line(clip(prompt, width), { color: 'cyan' })];
  }
  ```

  无论输入多长都只产出 1 行，并且交给 `clip` 截断（`clip` 本身还有 3.1 的宽度缺陷）。

- `src/cli/tui/app.ts:1225`（HEAD）`renderInputLine(input, columns, ...)` 的结果被渲染成单个 `<Text>`，布局层没有给它多行的余地。

> 工作区已有修复方向：`panels.ts` 新增 `COMPOSER_MAX_ROWS = 3`，超长时按单元格宽度折行、只保留尾部 3 行并加 `… ` 省略标记（见 `git diff`）。**未验证**。

### 3.4 [S1] 运行期画布停在冷启动空态，唯一「活动面」是 2 行裸模型文本

**现象**（`scratch/shots/run/`，同一 80×24 空工作区的一次 agent 轮次，连续 4 帧）：

`r1.txt`（起跑，头部已是 RUNNING）——画布与冷启动空态逐行相同，只有 composer 变成空光标：

```
 moss RUNNING · ? help · ⚠ set MOSS_DEVICE_HOST in .env · qwen3.8-max
╭────────────────────╮ ╭───────────────────────────────────────────────────────╮
│TASKS (0)           │ │Describe a goal below — moss turns it into a task with │
...
│                    │ │? help · Ctrl+T tasks · Ctrl+E evidence · Ctrl+A menu  │
╰────────────────────╯ ╰───────────────────────────────────────────────────────╯
› ▌
```

`r2.txt`（流式中）——画布**仍是**那块空态，第 19-20 行出现两行无标签的裸模型文本：

```
run either, but per system instructions list_directory is recommended. I'll use
list_directory
```

`r3.txt`（流式中，更晚）——同样只有 2 行：

```
answer: only the hidden `.moss/` directory exists, and there are no files.The
workspace is essentially
```

**复现**

```bash
python3 scratch/tui-drive.py --cols 80 --rows 24 --out /tmp/ux/run \
  --steps 'wait:1200,text:List the files in this workspace and summarise them,key:enter,shot:r1,wait:3000,shot:r2,wait:4000,shot:r3'
```

**根因**

- `src/cli/tui/panels.ts:190-222`（HEAD）：`renderCanvas` 里 `if (!detail)` 直接渲染空态（说明文案 + EXAMPLES + WORKSPACE + 尾行），**没有「正在运行」分支**。本次会话没有 `task_define`，所以 `TASKS (0)` 且 `detail` 始终是 `undefined`——空态因此是整个运行期唯一被渲染的画布。
- `src/cli/tui/app.ts:1173-1180`（HEAD）注释写明 「Live tail (≤2 lines) above the composer」：

  ```ts
  const liveTail = renderExecutionDetailTail({
    toolLine: store.run.toolLine,
    streamingText: store.run.streamingText,
    width: columns,
    maxLines: 2,
  });
  ```

  → 运行期的全部可见动态信息 = composer 上方 ≤2 行（`panels.ts` 的 `renderExecutionDetailTail`），且没有 `RUNNING/thinking/tool` 之类的标签。

- 旁证：`scratch/shots/run/r1.txt` 的 composer 是 `› ▌`，说明起跑瞬间连这 2 行都还是空的。

> 工作区已有部分修复方向：`panels.ts` 新增 `CanvasRunView`（`running` / `toolLine` / `streaming` / `startedAt` / `queued`）并在 `renderCanvas` 里优先渲染 `RUNNING …` + 工具行 + 流式文本（见 `git diff`）。但 `app.ts` 尚未把 `run` 传进 `renderCanvas`（`app.ts:1128-1142`、`1043-1057` HEAD 调用点没有该字段）→ **接线未完成，未验证**。

### 3.5 [S2] 运行结束后答案从可见面消失

**现象**（同一场景的下一帧，`scratch/shots/run/r4.txt`）：头部回到 READY，画布回到冷启动空态，`r3.txt` 里那两行答案不见踪影：

```
 moss READY · ? help · ⚠ set MOSS_DEVICE_HOST in .env · qwen3.8-max
...
╰────────────────────╯ ╰───────────────────────────────────────────────────────╯
› goal: describe what the robot should do…
↑↓ pick an example · ↵ load it · or just type a goal and Enter
```

**复现**：同 3.4，追加 `wait:6000,shot:r4`。

**根因**

- `src/cli/tui/render-bridge.ts:123-129`：

  ```ts
  export function endRun(store: TuiStore, halted: boolean): void {
    if (store.run.streamingText.trim()) {
      appendRow(store, 'assistant', store.run.streamingText);
    }
    store.run = { running: false, streamingText: '', halted: halted || undefined };
  ```

  文本**没有丢**（被追加进 `store.rows`），但唯一显示它的那个面（3.4 的 2 行 live tail）在同一函数里被清空；而 transcript 已被降级到 `Ctrl+O` / Tab（`src/cli/tui/app.ts:1124-1125`、`:1039-1041` HEAD 的 `canvasPanelLines`：`detailExpanded ? transcriptPanelLines() : renderCanvas(...)`），画布又回到空态。

- 结论：这是**可见面**缺陷，不是数据丢失。用户若不知道 Ctrl+O，会认为回答丢了。

> 工作区已有部分修复方向：`panels.ts` 新增 `CanvasSessionView`（`goal` / `answer`）与 `LAST EXCHANGE` 分支（见 `git diff`）；同样**尚未接线**（`app.ts` 未传 `session`）。**未验证**。

### 3.6 [S2] 导航栏显示 id 尾巴（`_yolo1` / `k_cam1`），不显示目标

**现象**（`scratch/shots/demo-wide/wide.txt:3-6`，110×40，`ws-demo` 三个任务）：

```
│TASKS (3)             │ │▸ task_yolo1 · MODEL                              IDLE│ │CONTEXT · MODEL                     │
│▸ _yolo1          IDLE│ │GOAL                                                  │ │Model / Latency / Memory / FPS      │
│  k_ros2          IDLE│ │  Quantize the yolo detection model and hit 30 fps on │ │────────────────────                │
│  k_cam1          PASS│ │  the BPU                                             │ │DEVICE  rdk-x5                      │
```

左栏三项分别是 `_yolo1`（`task_yolo1` 的后 6 字符）、`k_ros2`、`k_cam1`——没有任务类型标签、没有目标、任何一项都不足以让人判断「该选哪个」。同一批任务在 Task Switcher 覆盖层里信息完整（`scratch/shots/demo-wide/switcher.txt:4-7`）：

```
│▸ task_yolo1 MODEL      IDLE                                                                                          │
│    Quantize the yolo detection model and hit 30 fps on the BPU                                                       │
│    0/2 criteria · updated 00:18                                                                                      │
│  task_ros2 ROS        IDLE                                                                                           │
```

即**信息存在，只是不在常驻的巡视面上**。另外 80×24 时更糟（`scratch/shots/keys/tabnav.txt:3-5`）：因为导航内容宽只有 20 格，`kindPart` 也被丢掉，只剩 id 尾巴 + 状态。

**复现**

```bash
python3 scratch/tui-drive.py --cols 110 --rows 40 --workspace "$PWD/scratch/ws-demo" --out /tmp/ux/nav \
  --steps 'wait:1200,shot:wide,key:ctrl-t,shot:switcher'
```

**根因**

- `src/cli/tui/panels.ts:131-133`（HEAD）：

  ```ts
  const idPart = `${cursor} ${idTail(summary.taskId, width >= 24 ? 8 : 6)}`;
  const kindPart = width >= 24 ? ` ${KIND_LABEL[summary.kind]}` : '';
  const left = `${idPart}${kindPart}`;
  ```

  `idTail`（`panels.ts:109-111` 区域）就是 `id.slice(-n)`；且 `width >= 24` 的门槛用的是**未减边框**的宽度语义——调用点传的是 `layout.navigatorWidth - 2`（`app.ts:1066` HEAD），80 列时 = 20，于是常见尺寸下类型标签被静默丢弃。

- 选中行没有目标摘要（HEAD 只在 `focusTaskId !== selectedTaskId` 时输出一行 `●` + id 尾巴）。

> 工作区已有修复方向：`panels.ts` 改为按 `KIND_LABEL + state` 渲染，并给选中项追加 2 行目标摘要（见 `git diff`）。**未验证**。

### 3.7 [S3] 同一屏上 5 个「怎么用」的指令面在互相重复

**现象**（`scratch/shots-boot/f3.txt`，80×24 冷启动空工作区，一屏内）：

```
 1:  moss READY · ? help · ⚠ set MOSS_DEVICE_HOST in .env · qwen3.8-max
 3: │TASKS (0)           │ │Describe a goal below — moss turns it into a task with │
 4: │describe a          │ │acceptance criteria, executes it, and verifies with    │
 5: │goal below —        │ │evidence.                                              │
 6: │it becomes a        │ │EXAMPLES — ↑↓ select · ↵ load · 1/2/3 quick-pick       │
...
14: │                    │ │? help · Ctrl+T tasks · Ctrl+E evidence · Ctrl+A menu  │
...
19: › goal: describe what the robot should do…
20: ↑↓ pick an example · ↵ load it · or just type a goal and Enter
```

五处：①状态栏的 `· ? help`；②画布空态整段说明 + ③`EXAMPLES — ↑↓ select · ↵ load · 1/2/3 quick-pick`；④画布底部的键位行 `? help · Ctrl+T tasks · Ctrl+E evidence · Ctrl+A menu`；⑤composer 下方 `↑↓ pick an example · ↵ load it · or just type a goal and Enter`。此外左栏还有 4 行 20 格宽的散文（`describe a` / `goal below —` / `it becomes a` / `verified task.`），在窄栏里几乎不可读。同一批键位在 `?` 帮助页里第三次出现（`scratch/shots/help/help.txt:5-13`）。

**复现**

```bash
python3 scratch/tui-drive.py --cols 80 --rows 24 --out /tmp/ux/boot --steps 'wait:1500,shot:boot,key:?,shot:help'
```

**根因**

- `src/cli/tui/panels.ts:197`（EXAMPLES 行）、`:222`（画布底部键位行）、`:113-116`（左栏 4 行散文）——HEAD。
- `src/cli/tui/app.ts:1203`（状态栏 ` · ? help`）、`:1228-1234`（composer 提示行）——HEAD。
- `src/cli/tui/overlays.ts:36-45`（`HELP_KEYS`，帮助页数据源）。
- 结构问题：快捷键/用法没有**单一归属面**，谁都能再写一条。

> 工作区已有部分修复：画布空态里的键位行已从 `panels.ts` 删除（见 `git diff`，`:222` 那行在 diff 里是删除项）；左栏散文改为一行短指针。状态栏 `? help`、composer 提示、`HELP_KEYS` 是否进一步收敛 → 见 6 节，**待用户决定**。

### 3.8 [S2] 常驻黄色设备告警：每帧都在，还挤掉会变的信息

**现象 1 —— 每一帧都有。** `⚠ set MOSS_DEVICE_HOST in .env` 出现在本轮几乎每个转储的第 1 行：`scratch/shots-boot/f3.txt:1`、`scratch/shots/run/r1.txt:1`、`scratch/shots/keys/ctrlh.txt:1`、`scratch/shots/tiny/boot40.txt:1`、`scratch/shots/demo-wide/wide.txt:1`⋯⋯

**现象 2 —— 确实是黄色。** 属性转储 `scratch/shots-boot/f3.style` 第 1 行：

```
[m|fcyanB][o|fcyanB][s|fcyanB][s|fcyanB].[R|fgreenB][E|fgreenB][A|fgreenB][D|fgreenB][Y|fgreenB].[·].[?].[h][e][l][p].[·|fbrownB].[⚠|fbrownB].[s|fbrownB][e|fbrownB][t|fbrownB]...
```

pyte 把 ANSI 33 记作 `brown`，且带 `B`（bold）→ 粗体黄色。同一告警在画布里再来一次，也是黄色（`scratch/shots-boot/f3.txt:11`）：

```
│                    │ │  device   not configured — set MOSS_DEVICE_HOST in .e…│
```

**现象 3 —— 它会挤掉真正在变的信息。** 60×18（`scratch/shots/small/s60x18.txt:1`）只剩：

```
 moss READY · ? help · ⚠ set MOSS_DEVICE_HOST in .env
```

模型名与 `0 in run / 0 session` 用量都被丢掉；40×12（`scratch/shots/tiny/boot40.txt:1`）连告警本身也放不下：

```
 moss READY · ? help
```

**复现**

```bash
for size in 80x24 60x18 40x12; do c=${size%x*}; r=${size#*x}; \
  python3 scratch/tui-drive.py --cols $c --rows $r --out /tmp/ux/bar-$size --steps 'wait:1500,shot:bar'; done
grep -o 'brown' /tmp/ux/bar-80x24/bar.style | head -3    # 颜色证据
```

**根因**

- `src/cli/tui/app.ts:1204-1205`（HEAD）：设备未配置时无条件渲染该片段（粗体 + 黄色），没有「一次性播报 / 可折叠 / 已读」的降级路径：

  ```ts
  deviceUnconfigured
    ? { text: ' · ⚠ set MOSS_DEVICE_HOST in .env', bold: true, color: 'yellow' }
  ```

- `src/cli/tui/panels.ts:207-209`（HEAD）在画布 WORKSPACE 区**重复**同一条信息，同样是黄色（`color: ... ? 'yellow' : undefined`）。
- `src/cli/tui/app.ts:124-139`（HEAD）`fitStatusBar` 只按顺序**从尾部丢弃**（`if (used + segment.text.length > width) break;`）。告警片段约 34 格且排在第 4 位，于是 60 列时被牺牲的是模型名与用量（第 5、6 位），而不是常驻噪声。
- 同一条 `fitStatusBar` 用 `.length` 计量，与 3.1 是同一类缺陷（CJK 模型名/通知会误判）。

> 工作区已改：`fitStatusBar` 改用 `displayWidth`（见 `git diff`）。**常驻告警本身的取舍未改 → 待用户决定**。

### 3.9 [S3] 失效提示：广告的键在当下是死的

**(a) composer 非空时仍广告例子快捷键。** `scratch/shots/type/typed.txt` 是「已经输入了完整目标」的帧，composer 里有内容（第 19 行），但画布第 6 行照旧：

```
│                    │ │EXAMPLES — ↑↓ select · ↵ load · 1/2/3 quick-pick       │
```

此时这些键**全部无效**——`src/cli/tui/app.ts:641-642`（HEAD）：

```ts
const examplesActive =
  input.length === 0 && !store.run.running && runtime.taskSummaries().length === 0;
```

`↑↓`（`:860`）、`Enter` 载入例子（`:869`）、`1/2/3`（`:906-914`）都挂在 `examplesActive` 上。

**(b) overlay 占有键盘时，composer 与提示仍在，像是还能输入。** `scratch/shots/help/help.txt` 的帮助覆盖层之下，`20-21` 行照旧渲染 composer 与提示：

```
› goal: describe what the robot should do…
↑↓ pick an example · ↵ load it · or just type a goal and Enter
```

而 `scratch/shots/keys/ctrlg.txt:10`、`scratch/shots/demo-wide/evidence.txt:10`、`failure.txt:7` 各自的页脚都写着 `↑↓ select · Esc close`（说明键盘归 overlay）。

**复现**

```bash
python3 scratch/tui-drive.py --cols 80 --rows 24 --out /tmp/ux/dead \
  --steps 'wait:1500,text:Make the robot patrol the corridor and report when it sees a person,shot:typed,key:?,shot:help'
```

**根因**

- (a) `src/cli/tui/panels.ts:197`（HEAD）的例子标题是**常量字符串**，与 `app.ts:641` 的 `examplesActive` 状态无关；`app.ts:1135/1050` 只把 `examplesActive` 用于 `selectedExample`，没有传给画布。
- (b) `src/cli/tui/app.ts:1224-1234`（HEAD）：composer 与提示行无条件渲染；overlay 只替换 `mainArea`（`:1116`），composer 区不受影响；没有「当前谁拥有键盘」的共享状态。

> 工作区已有部分修复：(a) 增加 `examplesLive` 开关，文案变为 `EXAMPLES — clear the composer to pick one`（见 `git diff`）；(b) overlay 期间隐藏 composer/提示 —— **未实现，待用户决定**。

### 3.10 [S3] 巨大空 overlay：5 行数据占 33 行盒子

**现象**（像素级计数：盒子内部行数 / 其中空白行数）：

| 转储                                               | 尺寸   | 盒内行 | 内容行 | 空白行                    |
| -------------------------------------------------- | ------ | ------ | ------ | ------------------------- |
| `scratch/shots/keys/ctrlo.txt`（Ctrl+O 执行明细）  | 110×40 | 31     | 5      | **26**                    |
| `scratch/shots/keys/ctrlg.txt`（Ctrl+G 部署检视）  | 110×40 | 31     | 8      | **23**                    |
| `scratch/shots/demo-wide/failure.txt`（Ctrl+F）    | 110×40 | 31     | 5      | **26**                    |
| `scratch/shots/demo-wide/evidence.txt`（Ctrl+E）   | 110×40 | 31     | 8      | **23**                    |
| `scratch/shots/demo-wide/switcher.txt`（Ctrl+T）   | 110×40 | 31     | 7      | **24**                    |
| `scratch/shots/tasks/tasks.txt`（空工作区 Ctrl+T） | 80×24  | 16     | 4      | **12**                    |
| `scratch/shots/help/help.txt`（`?`）               | 80×24  | 15     | 14     | 1（对照：这一个是填满的） |

以 Ctrl+O 为例（`scratch/shots/keys/ctrlo.txt`，框内只有 1 行引导语，其余 30 行是空的）：

```
│moss Mission Control — /help for keys                 │
│                                                      │
│                                                      │
...
│                                                      │
╰──────────────────────────────────────────────────────╯
```

**复现**

```bash
python3 scratch/tui-drive.py --cols 110 --rows 40 --workspace "$PWD/scratch/ws-demo" --out /tmp/ux/ov \
  --steps 'wait:1200,key:ctrl-o,shot:detail,key:esc,key:ctrl-g,shot:deploy,key:esc,key:ctrl-f,shot:failure'
```

**根因**

- `src/cli/tui/overlays.ts:79`（HEAD）`while (out.length < height - 1) out.push(line('', {}));` —— 每个 overlay 都被补齐到**整个 body 高度**，无论数据多少。
- `src/cli/tui/app.ts:1013` + `:1116`（HEAD）：所有面板与 overlay 共用 `panelBox(..., height: layout.bodyHeight)`；`layout.bodyHeight = Math.max(6, rows - 7)`（`layout.ts:31`），即 overlay 永远拿最大可用高度。
- 也就是说「空 overlay」不是数据为空造成的（数据为空时 `overlays.ts:216/266/374` 有一行诚实的空态文案），而是**尺寸策略**造成的。Ctrl+O 在本次会话内容少，是最极端的一例。

> 未改 → **待用户决定**（按数据量收紧 overlay 高度 / 内容居中 / 侧栏化）。

### 3.11 [S3] evidence 列没有表头，任务名又是 id 尾巴，时间还混着两种口径

**现象**（`scratch/shots/demo-wide/evidence.txt:2-8`，Ctrl+E）：

```
│── EVIDENCE INSPECTOR ─────────────────────────────────────────────────────────────────────────────────────────────── │
│▸ 00:11 k_ros2 topic_hz:/cmd_vel >=10 → 4.2 FAIL                                                                      │
│  23:41 k_cam1 cpu_percent <=80 → 61 PASS                                                                             │
│  23:41 k_cam1 camera_fps >=30 → 31.4 PASS                                                                            │
│  23:35 k_cam1 camera_fps >=30 → 12 FAIL                                                                              │
│ev_ros_1 · device_exec · rdk-x3                                                                                       │
│  publisher runs at 4 Hz — QoS depth mismatch suspected                                                               │
```

一屏 6 列（时间 / 任务 / metric / expected / observed / result）**没有任何表头**；`>=10 → 4.2` 的 `→` 也没说明是 expected → observed；任务名是 `k_cam1` / `k_ros2`（id 尾巴）而详情行却给出 `ev_ros_1`（另一套 id）；时间 `00:11` 与 `23:41` 并列却没有日期，跨天时无法区分。

**复现**

```bash
python3 scratch/tui-drive.py --cols 110 --rows 40 --workspace "$PWD/scratch/ws-demo" --out /tmp/ux/ev \
  --steps 'wait:1200,key:ctrl-e,shot:evidence'
```

**根因**

- `src/cli/tui/overlays.ts:175-186`（HEAD）：`records.slice(...)` 后每条只 push **一行**格式化字符串，没有表头行；`const task = record.taskId ? idTail(record.taskId) : '—'`（`:177`）是 id 尾巴的来源。
- `src/cli/tui/panels.ts` 的 `fmtTime`（HEAD `:74-80` 区域）只输出 `HH:MM`，没有日期/相对时间。

> 未改 → **待用户决定**。

### 3.12 [S2] 40 列：内容被逐列截断，语义被丢掉

**现象**（`scratch/shots/tiny/boot40.txt`，40×12，**冷启动**，`ws-demo`；几何是正确的 16 + 1 + 23 = 40）：

```
 moss READY · ? help
╭──────────────╮ ╭─────────────────────╮
│TASKS (3)     │ │▸ task_yolo1 · MODEL…│
│▸ _yolo1  IDLE│ │… more sections avai…│
│              │ │── execution detail:…│
│              │ │                     │
╰──────────────╯ ╰─────────────────────╯
› goal: describe what the robot should …
```

三条症状：

1. 画布标题里的状态被**整段裁掉**：`▸ task_yolo1 · MODEL…`——`IDLE` 消失（对比 80 列的 `▸ task_yolo1 · MODEL                              IDLE`）。
2. 「提示语本身被截断成残句」：`… more sections avai…`（原文 "… more sections available on a taller terminal"）、`── execution detail:…`（原文 "── execution detail: transcript + tool calls (Ctrl+O) ──"）。
3. composer 占位提示被切成 `› goal: describe what the robot should …`，末尾的 `do…` 不可见。

**复现**

```bash
python3 scratch/tui-drive.py --cols 40 --rows 12 --workspace "$PWD/scratch/ws-demo" --out /tmp/ux/tiny \
  --steps 'wait:1500,shot:boot40,key:tab,shot:tab40'
```

**根因**

- `src/cli/tui/layout.ts:25`（`MIN_COLUMNS = 40`）、`:52`（`columns >= 70 ? 22 : 16`）、`:61`（`canvasWidth = Math.max(18, columns - navigatorWidth - 1)`）→ 40 列时画布内容宽 = 23 - 2 = 21 格。
- `src/cli/tui/panels.ts:230-234`（HEAD）：标题与状态拼成一行再 `clip` 到 21 格，**没有为状态预留宽度**，于是 `IDLE` 先被牺牲。
- `src/cli/tui/panels.ts:401`（HEAD）：截断提示 `'… more sections available on a taller terminal'` 自己也被 `clip` 到 21 格。
- `src/cli/tui/panels.ts:556-557`（HEAD）：composer 被裁到 39 格。
- 这是「降级策略缺失」而不是单纯的宽度问题：在 40 列下没有任何「最小可读集」或「明确拒绝启动 TUI、回退 REPL」的路径，界面选择继续渲染并静默丢信息。

> 工作区已改：`clip` 的截断位置现在按单元格计算（`terminal-text.ts` + `panels.ts` 的 diff），因此不会再出现「截断在半个字符上」；但 40 列的**取舍设计**未做 → **待用户决定**。
> 注：同一尺寸下 `scratch/shots/small/s40x12.txt` 出现的边框错位属于捕获侧 artifact，已移至第 4 节，请不要作为布局缺陷上报。

### 3.13 [S3] 预留但未使用的行把 composer 顶离底部

**现象**（各尺寸下「最后一行非空行」之后剩余的行数，实测）：

| 转储                                 | 尺寸   | 最后非空行 | 尾部空行 |
| ------------------------------------ | ------ | ---------- | -------- |
| `scratch/shots-boot/f3.txt`          | 80×24  | 20         | **4**    |
| `scratch/shots/run/r1.txt`（运行中） | 80×24  | 19         | **5**    |
| `scratch/shots/run/r4.txt`           | 80×24  | 20         | **4**    |
| `scratch/shots/demo-wide/wide.txt`   | 80×40  | 35         | **5**    |
| `scratch/shots/small/s60x18.txt`     | 60×18  | 13         | **5**    |
| `scratch/shots/tiny/boot40.txt`      | 40×12  | 8          | **4**    |
| `scratch/shots/rsz2/c120x30.txt`     | 120×30 | 25         | **5**    |

即 composer 与提示停在屏幕中下部，下面留 4–5 行空白（80×24 时约 17% 的屏幕高度）；并且这个残留量**随运行状态变化**（r1 是 5 行、r4 是 4 行）。

**复现**：见 7.1 的冷启动命令；`run/r1..r4` 见 3.4 的命令。

**根因**

- `src/cli/tui/layout.ts:28-31`（HEAD）按**最坏情况**预留：

  ```ts
  // Status bar + live tail ≤2 + notice ≤2 + composer hint + input = up to 7
  // rows around the main panels ...
  const bodyHeight = Math.max(6, rows - 7);
  ```

  但空闲态的 chrome 实际只有 2 行：`src/cli/tui/app.ts:1217-1234`（HEAD）里的 live tail / approval banner / notice 都是条件渲染，`notice` 还被 `.slice(0, 2)`（`:1219-1223`）。于是面板固定拿走 `rows-7`，剩下的行就空在那里。

- 同一段 app.ts 代码里 live tail 的 `maxLines: 2`（`:1179`）与 notice 的 `slice(0, 2)` 说明「2+2」是**上限**，被当成了常量。

> 工作区已改：`layout.ts` 引入 `CHROME_ROWS = 2` 与 `outsideRows` 参数，注释明确写了「乐观看待实际外框行数」以及原先「跑起来时 composer 会跳两行」的缺陷（见 `git diff`）。**未验证**。

### 3.14 [未复现 flake] 冷启动一次 `exit code 1`，3 次重试未复现

**事实（磁盘上能验证的部分）**

- `scratch/shots/cjk2/` 是一个**空目录**（0 个条目，创建时间 00:26:01，正好夹在 `cjk/`（00:25:57）与 `cjk3/`（00:26:11）之间），里面没有 `boot.txt` / `boot.style` / `raw.log`——即那次运行**没有产出任何首帧**。
- `scratch/tui-drive.py:281-283` 是唯一会记录退出码的地方：

  ```python
  if d.proc.poll() is not None:
      print(f"[harness] process exited code={d.proc.returncode} after {kind}:{arg}")
      break
  ```

  该行只打到 stdout（未落盘），所以磁盘上没有退出码本身。

- 随后的运行全部正常，且**字节级确定**：

  ```bash
  diff -q scratch/shots/cjk4-1/boot.txt scratch/shots/cjk4-2/boot.txt   # 相同
  diff -q scratch/shots/cjk4-2/boot.txt scratch/shots/cjk4-3/boot.txt   # 相同
  diff -q scratch/shots/cjk4-1/raw.log  scratch/shots/cjk4-3/raw.log    # 相同（PTY 原始流 5805 字节）
  ```

  另有 `scratch/shots/cjk3/boot.txt`（110×30）也产出完整首帧 → 总计 4 次正常冷启动。

**判定**：**未复现的 flake，不作为已确认缺陷**。父会话在启动时观察到一次 `exit code 1`（修改任何代码或场景之前），3 次重试均未复现；PTY 输出在重试之间逐字节一致，说明渲染本身是确定的。诚实起见需要说明：空输出目录同时也可能是「首帧前被人工中断」造成的，**仅凭磁盘证据无法区分崩溃与中断**——退出码本身只在父会话的 stdout 里出现过一次，本次复核**未能再现**。

**若再遇到，需要采集**：`--rawlog` 的完整 PTY 字节、命令原文、`MOSS_*` 环境、以及 harness 打印的那行 `[harness] process exited code=…`（目前不落盘，建议重定向到 `> run.log 2>&1`）。

---

## 4. 假阳性（已排除）— 请勿再报

以下现象曾被当作缺陷，事后证明是**评审 harness 自身**造成的假象，不是 `dist/cli.js` 的行为。记录在此以防重复上报。

### 4.1 拆分 UTF-8 解码 → 假的边框损坏 + 假的两行状态栏

**（a）假边框损坏（U+FFFD）。** `scratch/shots/tasks/tasks.txt` 的第 5-6 行（旧捕获）在右侧边框处出现替换字符：

```
│↑↓ select · ↵ switch to task · r resume · Esc close                           �
��
```

十六进制可见：该处字节是 `EF BF BD`（U+FFFD），而正确字节应是 `E2 94 82`（`│`）。同一场景的重跑 `scratch/shots/t1/tk.txt:5` 是正确的：

```
│↑↓ select · ↵ switch to task · r resume · Esc close                           │
```

且 `t1`/`t2`/`t3` 三份转储逐字节相同。原因就是旧版捕获按 chunk 解码，把一个多字节字符切成了两半；现行 `scratch/tui-drive.py:122-124` 已用增量解码器修掉，注释把这一现象命名为「fake border corruption」：

```python
# Incremental decode: a multi-byte glyph split across two reads
# must not become U+FFFD — that would fake border corruption.
self.stream.feed(self.decoder.decode(chunk))
```

**（b）假的两行状态栏。** `scratch/shots-080/boot80.txt` 与 `scratch/shots/help/help.txt` 的第 1-2 行各有一个 header，看起来像「状态栏占了两行」：

```
 1:  moss READY · ? help · device checking… · qwen3.8-max · 0 in run / 0 session
 2:  moss READY · ? help · ⚠ set MOSS_DEVICE_HOST in .env · qwen3.8-max
```

排除依据（两条独立证据）：

1. PTY 原始流里只有**两帧**，且第二帧是完整的「清行 + 重绘」。`scratch/shots-boot/raw.log` 里可数出 `ESC[?2026h` 2 次、`ESC[2K` 21 次、`ESC[1A` 20 次、`ESC[?2026l` 2 次；第 21 行是 `[?2026h` 后接 20 组 `[2K[1A` 再 `[G` + 整屏重绘（第 1 帧头部是 `· device checking… · 0 in run / 0 session`，第 2 帧是 `· ⚠ set MOSS_DEVICE_HOST in .env · qwen3.8-max`）。CLI 明确擦除了上一帧，没有残留第二行。
2. 同一场景的新转储只有 1 个 header：`scratch/shots/cjk4-1/boot.txt`、`cjk4-2`、`cjk4-3` 各 `grep -c 'moss READY'` = 1；而重试之间 PTY 原始流逐字节相同（5805B）。**相同的字节流**在一份转储里是 1 行、在旧转储里是 2 行 → 差异出在捕获侧（dump 时机落在重绘中途），不在 CLI。

### 4.2 表面上的 resize 失败 → 未稳定的一帧

**现象。** `scratch/shots/rsz/back24.txt`（从 80×40 缩回 80×24）看起来像缩放后彻底坏掉：第 1 行是半截边框，第 2 行直接是底边框，第 3 行才是 composer——

```
│                    │ │                                                       │
╰────────────────────╯ ╰───────────────────────────────────────────────────────╯
› goal: describe what the robot should do…
```

**排除依据。**

1. 盒子宽度是对的（导航 22 / 画布 57 = 80 列，与 80 列的 `computeLayout` 输出一致），但**行位移**了约 17 行——40 行帧的下半部分残留在 24 行缓冲里，这不是任何布局公式能产出的帧。
2. 同一尺寸重新采集是干净的：`scratch/shots/rsz2/a24.txt`（80×24）几何与内容都正确（导航 22 / 画布 57，`TASKS (3)` + `▸ task_yolo1 · MODEL … IDLE`）。`scratch/shots/rsz/to40.txt`（80×40）同样干净。
3. `scratch/shots/rsz2/b40.txt`（80×40）显示的是 `CONTEXT · MODEL` 面板而不是画布——**这不是缺陷**：80 列下 `layout.showContext = false`（`src/cli/tui/layout.ts:63`），Tab 会把中间面板切到 context 视图（`src/cli/tui/app.ts:826-831`），同尺寸的 `scratch/shots/tiny/tab40.txt` 就是显式 Tab 后的同一视图。

**结论：** resize 之后必须在 SIGWINCH + 重绘完成后再 dump；`back24.txt` 属于捕获时机竞争。缩放路径本身在重跑中渲染正确。

### 4.3（同属 4.2 类）40×12 的边框错位不是布局缺陷

`scratch/shots/small/s40x12.txt` 里导航盒只有 11 列、画布盒 26 列，导航项被拆成两行：

```
│TASKS (3)│ │▸ task_yolo1 · MODEL      │
│▸ _yolo1   │GOAL       IDLE           │
│IDLE     │ │  Quantize the yolo       │
```

排除依据：该几何**不可能**由布局引擎产出——`computeLayout` 在 40 列给出导航 16 / 画布 23（`layout.ts:52,61`），而 11 / 26 在任何 columns 取值下都不成立；同一 40×12 的**冷启动**帧 `scratch/shots/tiny/boot40.txt` 几何正确（16 + 1 + 23 = 40）。因此判为缩放捕获未稳定，40 列的真实缺陷只是 3.12 的语义截断（那一节引用的就是冷启动的 `boot40.txt`）。

---

## 5. 设计原则（由上述缺陷反推）

1. **宽度单位只有一个：单元格。** 所有布局数学必须走 `displayWidth()`（`src/cli/terminal-text.ts`），禁止把 `String.length` 用于任何宽度决策——它把 CJK/emoji 少算一半，而且后果是整帧重排而不只是那一行难看（3.1、3.8）。
2. **一个键只有一个真相源，且只广告可达的键。** 绑定表驱动「键处理 / 帮助页 / 动作菜单」三处；不可达的键不许出现（3.2）。
3. **正在发生的事必须在常驻面上。** 画布是执行面：run 一旦开始，画布归运行态所有（进度、当前动作、流式输出），空态只在真正空闲时出现（3.4）。
4. **结束必须留痕。** 一轮结束不能把结果从可见面上撤走；「降级到 transcript」是补充，不是替代（3.5）。
5. **常驻 chrome 必须付费。** 常驻告警要可降级（一次播报 / 可折叠 / 只在画布出现一次），且在窄屏上优先级低于**会变**的信息（模型、用量、运行态）（3.8）。
6. **提示只在有效时出现。** 控件不可用就不广告；键盘被 overlay 拿走时，composer 与 composer 提示必须让位（3.9）。
7. **面板高度按内容算，composer 锚定底部。** 不预留「最坏情况」的行数；外框行数按本帧实际渲染量扣减，避免死行与运行开始时的 composer 跳动（3.13）。
8. **overlay 的尺寸服从数据量，列必须有表头。** 5 行数据不该占 33 行盒子；有表格就有列名、时间要可区分日期、id 必须配人类可读标签（3.10、3.11）。
9. **小终端是重排优先级，不是截断。** 40 列要么给出最小可读集（丢掉的第一样东西绝不能是状态与截断提示本身），要么明确拒绝启动 TUI 并回退 REPL（3.12）。

---

## 6. 修复方案

约定：**状态 = 工作区已改（未提交/未验证）** 指审计期间我在 `git diff` 里看到的、由 Lead 正在实施的改动（快照时间 2026-10-01 00:31，涉及 `src/cli/terminal-text.ts` 与 `src/cli/tui/{app,layout,overlays,panels,transcript-view}.ts`）；**开放** 指尚无对应改动，需要用户决定取舍。

> 后续快照（00:33）：Lead 又新增了 `test/tui-cell-width.spec.mjs`（针对 3.1 单元格宽度、3.12/3.13 的 composer 锚定与长输入窗口写回归断言，import 构建产物 `dist/`），并改动了 `test/tui-mission.spec.mjs`。这些 spec 本次审计**未运行**（未跑 `npm run test`），故「已改」仍按未验证计。

| #    | 问题                        | 修复                                                                                                                                                  | 状态                                                             |
| ---- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| 3.1  | CJK / 双宽字符整帧错位      | `terminal-text.ts` 导出 `displayWidth()`（`stringWidth`）；`panels.ts` 的 `clip`/`wrap`/`padTo`/`padStartTo`、`fitStatusBar` 全部改按单元格计量与截断 | 工作区已改（未验证）                                             |
| 3.2  | Ctrl+H 不可达               | `overlays.ts` 新增 `CTRL_BINDINGS` 单一绑定表，history 改到 `Ctrl+R`；帮助页与动作菜单从该表生成 hint，并在注释里记录 `parse-keypress` 证据           | 工作区已改（未验证）                                             |
| 3.3  | composer 单行截断           | `renderInputLine` 改为按单元格折行，`COMPOSER_MAX_ROWS = 3`，超长时只显示尾部并加 `… ` 省略标记                                                       | 工作区已改（未验证）                                             |
| 3.4  | 运行期画布停在空态          | `panels.ts` 增加 `CanvasRunView` 与「RUNNING 优先」分支（时长 + 当前工具 + 流式文本 + `Esc` 提示）                                                    | 部分：`app.ts` 尚未把 `run` 传入 `renderCanvas` → **接线未完成** |
| 3.5  | 结束后答案从可见面消失      | `panels.ts` 增加 `CanvasSessionView` 与 `LAST EXCHANGE` 分支（保留最后一次目标 + 答案）                                                               | 部分：`app.ts` 尚未传入 `session` → **接线未完成**               |
| 3.6  | 导航栏显示 id 尾巴          | `renderNavigator` 改为 `kind + state` 标签，选中项附 2 行目标摘要；focus 行改用目标而非 id                                                            | 工作区已改（未验证）                                             |
| 3.7  | 指令面重复                  | 删除画布内常驻键位行；左栏 4 行散文改一行短指针；帮助页/状态栏/composer 提示继续收敛                                                                  | 部分已改；进一步收敛 **开放（待用户决定）**                      |
| 3.8  | 常驻黄色设备告警            | `fitStatusBar` 改按单元格计量；告警是否降级（一次播报 / 可折叠 / 只在画布出现一次）需要产品取舍                                                       | 部分已改；告警取舍 **开放（待用户决定）**                        |
| 3.9  | 失效提示                    | (a) 增加 `examplesLive`，文案改为 `EXAMPLES — clear the composer to pick one`；(b) overlay 期间隐藏 composer 与提示                                   | (a) 工作区已改（未验证）；(b) **开放（待用户决定）**             |
| 3.10 | 巨大空 overlay              | 按数据量收紧 overlay 高度（不要用 `bodyHeight` 补齐）                                                                                                 | **开放（待用户决定）**                                           |
| 3.11 | evidence 列无表头 / id 尾巴 | 加表头行；任务名改用 goal 或 `任务名 + id 尾巴`；时间加日期或相对时间                                                                                 | **开放（待用户决定）**                                           |
| 3.12 | 40 列语义截断               | 截断位置已按单元格修正；40 列的最小可读集或「回退 REPL」策略需要决策                                                                                  | 部分已改；策略 **开放（待用户决定）**                            |
| 3.13 | 预留未用的行                | `layout.ts` 引入 `CHROME_ROWS = 2` + `outsideRows` 参数，面板取本帧实际剩余高度，composer 锚定底部                                                    | 工作区已改（未验证）                                             |
| 3.14 | 冷启动 exit 1（未复现）     | 不需要代码改动；建议 harness 把 stdout 落盘（`> run.log 2>&1`）以便下次抓到退出码                                                                     | 观察项（monitor）                                                |

**下一步（建议 Lead 收口）**：3.4 / 3.5 的 `app.ts` 接线是「修复已写但不可见」的状态——`panels.ts` 的能力没有被调用点使用，必须接线后**重跑 7.3 的运行期场景**，用 `run/r1..r4` 同口径的转储确认画布在运行期与结束后都留痕。

### 6.1 修复收口（2026-10-01 收尾，全部实测通过）

上表的「工作区已改（未验证）」已全部升级为**已验证**，口径如下：

| #    | 问题                        | 最终状态                 | 复验证据                                                                                                                                                                                              |
| ---- | --------------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3.1  | CJK / 双宽字符整帧错位      | **已修复**               | `test/tui-cell-width.spec.mjs`（`displayWidth`/`clip`/`wrap` 单元格计量 + 各投影逐行宽度断言）；`scratch/shots/v2/cjk-canvas.txt`：中文目标下面板边框不再错位（20 + 1 + 55），goal 在框内按单元格折行 |
| 3.2  | Ctrl+H 不可达               | **已修复**               | `CTRL_BINDINGS` 单一绑定表；`Ctrl+R` 打开 TASK HISTORY（`scratch/shots/v1/history.txt`）；spec 断言 `ctrlBinding('h') === undefined` 且帮助页绝不出现 `Ctrl+H`                                        |
| 3.3  | composer 单行截断           | **已修复**               | 长目标折行且尾部可见（`scratch/shots/v1/longinput.txt`：`…CPU temperature▌`）；spec 断言折行、行数上限、光标在尾部                                                                                    |
| 3.4  | 运行期画布停在空态          | **已修复**               | `app.ts` 已接线 `run`；`scratch/shots/v3/mid.txt`：画布显示 `RUNNING 2s / thinking… / <流式答案>`，空态被替换                                                                                         |
| 3.5  | 结束后答案从可见面消失      | **已修复**               | `scratch/shots/v5/done.txt`：`LAST EXCHANGE` 保留目标与答案，且答案只含 `pong`                                                                                                                        |
| 3.6  | 导航栏显示 id 尾巴          | **已修复**               | `scratch/shots/nav-80/nav.txt`：`▸ MODEL IDLE` + 选中项目标摘要；40 列降级为 `▸ MDL IDLE`（短码，也不再退化成裸状态词）                                                                               |
| 3.7  | 指令面重复                  | **部分收敛**（开放）     | 画布内常驻键位行与左栏 4 行散文已删除；是否把 composer 提示也收进 `?` overlay 需产品取舍                                                                                                              |
| 3.8  | 常驻黄色设备告警            | **已修复**               | 未配置设备时状态栏只有 dim 的 `· no device`；仅当选中任务带 `targetDeviceId` 才升级为黄色 `⚠ device required`（`scratch/shots/v1/idle.txt`）                                                          |
| 3.9  | 失效提示                    | **已修复**               | (a) `examplesLive` 使 examples 停止广告失效键；(b) overlay 打开时不再渲染 composer 提示                                                                                                               |
| 3.10 | 巨大空 overlay              | **已修复**               | 空 task switcher 改为「下一步动作」文案（`renderTaskSwitcher`）；overlay 高度策略仍是「与面板同高」，但不再只有一行内容                                                                               |
| 3.11 | evidence 列无表头 / id 尾巴 | **已修复**               | 新增 `TIME METRIC = OBSERVED EXPECTED RESULT` 表头；行首改为 metric（最可识别），任务 id 移到详情行并加 `task` 前缀                                                                                   |
| 3.12 | 40 列语义截断               | **部分修复**（策略开放） | 画布标题改为「先保状态、再裁标签」：40 列下为 `▸ task_yolo1 · … IDLE`（`IDLE` 不再消失）；截断提示/composer 占位仍会被裁——「最小可读集 vs 回退 REPL」的取舍留待用户决定                               |
| 3.13 | 预留未用的行                | **已修复**               | `computeLayout(columns, rows, outsideRows)` 按本帧实际外框行数扣减；80×24 空闲时面板 21 行、composer 行 22、提示行 23，**零死行**（`scratch/shots/v1/idle.txt`）                                      |
| 3.14 | 冷启动 exit 1（未复现）     | 观察项                   | 仍是 monitor，无代码改动                                                                                                                                                                              |

复验命令（收口后实跑）：

```bash
node scripts/run-package-tests.mjs --filter tui     # 12 个 spec 文件全绿
python3 scratch/tui-drive.py --cols 80 --rows 24 --env "MOSS_CONFIG_DIR=$HOME/.config/moss" \
  --out /tmp/ux/v1 --steps 'wait:2000,shot:idle,key:ctrl-r,wait:500,shot:history'
```

### 3.15 [S2] 思维链被并入答案（修复过程中新发现，已修复）

**现象**（`scratch/shots/v4/done.txt`，收尾前）：`LAST EXCHANGE` 里的答案行是
`The user is asking me to reply with exactly one word, "pong". Simple.pong`——模型的思考与真正的回答被拼成了一段。
这在 3.5 修复之前不可见（答案被藏在 transcript 里），一旦把答案提到画布上就暴露了。

**根因**：`src/cli/tui/render-bridge.ts` 把 `thinking_delta` 与 `text_delta` 都写进同一个 `store.run.streamingText`；
而 loop 自己的桥（`src/cli/loop-tui-events.ts:50-59`）对 `thinking_delta` 只当作 activity 信号、不进入答案。

**修复**：`TuiRunState` 拆出 `thinkingText`；`endRun` 只把答案落成 assistant 行；画布 RUNNING 分支把思考 dim 显示在答案上方。
复验：`scratch/shots/v5/done.txt` 的答案行只有 `pong`；回归 spec `test/tui-run-state.spec.mjs`。

---

## 7. 复现清单（可直接复制）

前置（模型配置必须显式注入，因为 harness 使用临时 `HOME`；可用 `MOSS_CONFIG_DIR` 指向真实配置目录）：

```bash
cd /Users/d-robotics/Desktop/RDK_Studio/moss
export MOSS_CONFIG_DIR="$HOME/.config/moss"   # 本次审计实际使用并验证的注入方式（provider=openai-compatible, model=qwen3.8-max）
# 也可用 MOSS_CONFIG_FILE=/path/to/config.json（src/cli/config.ts:257）；不注入则会落到 "Moss needs a model configuration" 提示页
# 需要跑 agent 轮次的场景，先复制工作区，避免把评审产物写回仓库：
cp -r scratch/ws-demo /tmp/ws-demo && cp -r scratch/ws-cjk /tmp/ws-cjk
```

> 说明：原始每次调用的完整 argv 没有落盘（dump 目录里只有 `.txt`/`.style`/`raw.log`），以下命令按转储的尺寸与内容重建；harness 本身已实测可跑（2.6）。

### 7.1 冷启动 / 空态 / 状态栏 / 死行

```bash
python3 scratch/tui-drive.py --cols 80  --rows 24 --out /tmp/ux/boot80 --steps 'wait:1500,shot:boot'
python3 scratch/tui-drive.py --cols 80  --rows 24 --env MOSS_CONFIG_FILE=$MODEL_CFG --out /tmp/ux/boot80m --steps 'wait:1500,shot:boot'
python3 scratch/tui-drive.py --cols 60  --rows 18 --env MOSS_CONFIG_FILE=$MODEL_CFG --out /tmp/ux/s60 --steps 'wait:1500,shot:boot'
python3 scratch/tui-drive.py --cols 40  --rows 12 --env MOSS_CONFIG_FILE=$MODEL_CFG --workspace "$PWD/scratch/ws-demo" --out /tmp/ux/tiny --steps 'wait:1500,shot:boot40,key:tab,shot:tab40'
python3 scratch/tui-drive.py --cols 110 --rows 22 --env MOSS_CONFIG_FILE=$MODEL_CFG --workspace "$PWD/scratch/ws-demo" --out /tmp/ux/fresh110 --steps 'wait:1500,shot:boot'
```

### 7.2 输入 / composer（3.3、3.9a）

```bash
python3 scratch/tui-drive.py --cols 80 --rows 24 --env MOSS_CONFIG_FILE=$MODEL_CFG --out /tmp/ux/type \
  --steps 'wait:1200,text:Make the robot patrol the corridor and report when it sees a person,shot:typed'
python3 scratch/tui-drive.py --cols 80 --rows 24 --env MOSS_CONFIG_FILE=$MODEL_CFG --out /tmp/ux/input \
  --steps 'wait:1200,text:Deploy the camera pipeline to the RDK X5 board and measure sustained FPS for twelve hours,shot:long,key:bs,shot:after-bs'
python3 scratch/tui-drive.py --cols 80 --rows 24 --env MOSS_CONFIG_FILE=$MODEL_CFG --out /tmp/ux/pick \
  --steps 'wait:1200,key:1,shot:pick1,key:enter,shot:pick2'
```

### 7.3 运行期：画布空态 + 结束消失（3.4、3.5）— 最重要的一条

```bash
python3 scratch/tui-drive.py --cols 80 --rows 24 --env MOSS_CONFIG_FILE=$MODEL_CFG --out /tmp/ux/run \
  --steps 'wait:1200,text:List the files in this workspace and summarise them,key:enter,shot:r1,wait:3000,shot:r2,wait:4000,shot:r3,wait:6000,shot:r4'
```

（`text:` 里不要用逗号——步骤 DSL 以逗号分隔。）

### 7.4 快捷键：Ctrl+H 对照（3.2）、overlay（3.10、3.11）

```bash
# Ctrl+T / Ctrl+H / Ctrl+E / Ctrl+F 同场景连拍（用 diff 证明 Ctrl+H 什么都没做）
python3 scratch/tui-drive.py --cols 110 --rows 40 --env MOSS_CONFIG_FILE=$MODEL_CFG --workspace /tmp/ws-demo --out /tmp/ux/keys \
  --steps 'wait:1200,shot:wide,key:ctrl-t,shot:switcher,key:esc,key:ctrl-h,shot:history,key:esc,key:ctrl-e,shot:evidence,key:esc,key:ctrl-f,shot:failure,key:esc,key:ctrl-o,shot:detail'
diff -q /tmp/ux/keys/wide.txt /tmp/ux/keys/history.txt    # 期望：无输出（= Ctrl+H 无效果）
diff -q /tmp/ux/keys/wide.txt /tmp/ux/keys/switcher.txt   # 期望：有差异
```

### 7.5 帮助页 / 动作菜单（3.7、3.9b）

```bash
python3 scratch/tui-drive.py --cols 80 --rows 24 --env MOSS_CONFIG_FILE=$MODEL_CFG --out /tmp/ux/help \
  --steps 'wait:1200,key:?,shot:help,key:esc,key:ctrl-a,shot:menu'
```

### 7.6 CJK / emoji（3.1）

```bash
python3 scratch/tui-drive.py --cols 80 --rows 24 --env MOSS_CONFIG_FILE=$MODEL_CFG --workspace /tmp/ws-cjk --out /tmp/ux/cn \
  --steps 'wait:1200,key:ctrl-t,key:down,key:enter,shot:cn,key:ctrl-t,shot:switcher'
python3 scratch/tui-drive.py --cols 110 --rows 30 --env MOSS_CONFIG_FILE=$MODEL_CFG --workspace /tmp/ws-cjk --out /tmp/ux/cjk4 \
  --steps 'wait:1500,shot:boot' --rawlog
```

### 7.7 缩放（含第 4.2 节假阳性的复核方式）

```bash
# 必须在 resize 之后等重绘完成再 dump，否则会复现 back24.txt 那种"未稳定帧"
python3 scratch/tui-drive.py --cols 110 --rows 24 --env MOSS_CONFIG_FILE=$MODEL_CFG --workspace /tmp/ws-demo --out /tmp/ux/rsz2 \
  --steps 'wait:1500,shot:a24,resize:80x40,wait:1200,shot:b40,resize:120x30,wait:1200,shot:c120x30'
```

### 7.8 假阳性自查（两行状态栏 / U+FFFD）

```bash
# 无模型配置的 setup 页（本次复核实测与 scratch/shots-080/boot.txt 逐字节相同）
python3 scratch/tui-drive.py --cols 80 --rows 24 --out /tmp/ux/setup --steps 'wait:1500,shot:boot'
diff -q /tmp/ux/setup/boot.txt scratch/shots-080/boot.txt

# 状态栏行数：新转储应为 1；PTY 原始流应能看到 ESC[?2026h ... ESC[2K/1A ... 整屏重绘
python3 scratch/tui-drive.py --cols 80 --rows 24 --env MOSS_CONFIG_FILE=$MODEL_CFG --workspace /tmp/ws-demo --out /tmp/ux/bar \
  --steps 'wait:1500,shot:boot' --rawlog
grep -c 'moss READY' /tmp/ux/bar/boot.txt        # 期望 1
python3 - <<'PY'
raw = open('/tmp/ux/bar/raw.log','rb').read().decode('utf-8','replace')
print('frames:', raw.count('\x1b[?2026h'), 'erase-lines:', raw.count('\x1b[2K'), 'cursor-up:', raw.count('\x1b[1A'))
PY
```

---

## 附：本文件的信息边界

- 只使用本轮评审里真实产生的转储与真实读到的源码；未复现/未验证的点已在条目内标注（3.2 的「Ctrl+H 是否吃掉一个字符」、3.14 的退出码本身、2.7 的 argv 与环境）。
- 未运行 `npm run build/test/smoke`；未修改任何源代码，仅新增本文件。
- 审计期间工作区存在未提交改动（Lead 正在实施修复），因此第 6 节的状态是**时间快照**，不是最终结论。

---

## 8. v0.22 对照（Claude Code 形态，实跑证据）

### 8.1 方法

同一套 PTY harness 驱动两个二进制，**同尺寸同步骤**，逐行并排：

```bash
# 参考实现（本机 claude 2.1.285）与 moss 各跑一遍，90×30
python3 scratch/compare-cli.py --cols 90 --rows 30 \
  --steps 'wait:2500,text:list the files in this folder,key:enter,wait:14000,shot:turn' --shot turn
```

（`scratch/compare-cli.py` 内部对 claude 用 `--bin /opt/homebrew/bin/claude --realhome`，对 moss 用
`MOSS_CONFIG_DIR=$HOME/.config/moss`；两侧都是真实模型、真实 PTY、pyte 重建屏幕。）

### 8.2 逐元素对照（90×30，同一步骤）

| 元素            | moss                                         | Claude Code                                      |
| --------------- | -------------------------------------------- | ------------------------------------------------ |
| 顶部 banner     | `moss v0.21.0` / `qwen3.8-max · rdk-…` / cwd | logo / `Claude Code v2.1.285` / model / cwd      |
| 上下文行        | （无）                                       | `⎿ SessionStart:startup says: …`、`⏺ cc-plugin…` |
| 用户行          | `❯ list the files in this folder`            | `❯ list the files in this folder`                |
| 工具调用        | `⏺ List Directory` + `⎿ .moss/`              | `Thought for 4s, listed 1 directory, ran 1 …`    |
| 回答            | `⏺ …`（按单元格折行）                        | `⏺ …`（按单元格折行）                            |
| 收尾状态        | `✻ Checking for 9s`                          | `✻ Sautéed for 8s · done 1:23 AM`                |
| 右对齐状态      | `qwen3.8-max · 31.2k tokens`                 | （该帧为空）                                     |
| 横线 / composer | `────` / `❯ Try "…"`                         | `────` / `❯ …`                                   |
| 提示行          | `? for shortcuts`                            | `⏸ manual mode on · ? for shortcuts · ← …`       |

### 8.3 实际体验记录（真实 PTY，非单测）

| 场景                     | 观测到的结果                                                                                       |
| ------------------------ | -------------------------------------------------------------------------------------------------- |
| 中文目标 + 工具 + 总结   | `❯ 运行 git status --short …` → `⏺ Exec(git status --short)` → `⎿` 三行预览 → `⏺` 中文总结折行正确 |
| 逐字节输入 `R D K ␣ X 5` | **修复前只剩 `5`**（`key.shift` 把大写字母全吃掉）→ 修复后 `❯ RDK X5▌`                             |
| Esc 打断                 | `⏺ This operation was aborted` + `✻ Thinking for 4s · interrupted`，之后 composer 可继续用         |
| Ctrl+C                   | 运行中=打断；空闲=退出（实测进程 exit code 0）                                                     |
| 超出屏幕的历史           | 连续 5 个命令块后旧内容滚出视口进入终端 scrollback，composer 始终钉在底部                          |
| 长输入                   | composer 折行到 2 行并保持光标在尾部（`…sixty seconds▌`）                                          |
| 审批                     | 内联 `────`/`╌` 预览块 + `❯ 1. Yes / 2. … / 3. No`，状态行 `● waiting for you`，期间不空转         |
| 中文/emoji 宽度          | 40/80/90/120 列下所有行按单元格计量，无整帧错位                                                    |

### 8.4 仍然存在的差异（诚实记录）

1. **启动上下文行**：参考实现会打印 SessionStart hook 与「AGENTS.md loaded」；moss 启动时不打印它加载了
   哪些上下文（skill/AGENTS/skills 索引）。属内容缺口，不是形态差异。
2. **工具行措辞**：参考实现用人类摘要（「listed 1 directory」），moss 用 `⏺ Tool(arg)`（`Write(a.txt)` 这类
   形式两侧一致）。
3. **审批粒度**：`ls -la` 这类只读 shell 命令参考实现直接放行，moss 会弹审批（workspace-write 安全策略）。
   这是**安全策略**差异，本次没动——要动应作为独立决策，而不是为了"看起来像"。
4. **模式提示**：参考实现底部有 `⏸ manual mode on`；moss 无模式概念，故提示行更短。

结论：形态（单列 transcript + 终端 scrollback + 底部 composer + 同样的行内标记与空白节奏）已经一致，
内容与身份仍然是 moss（设备行、模型行、moss 自己的占位提示与任务/证据/部署区块）。
