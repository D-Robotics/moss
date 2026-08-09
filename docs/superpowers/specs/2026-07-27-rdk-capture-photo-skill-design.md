---
date: 2026-07-27
status: draft
---

# rdk-capture-photo skill 设计

## 目标

在已连接的 RDK 开发板上,让用户用一句自然语言"用这个开发板拍几张照片"就能拍照出 JPEG,
且 moss 自动走对路径(专用工具 `get_isp_data`),不再退化成通用 Linux 摄像头思路(碰
`/dev/video`、`srcampy.Camera()` 直接 open、停 cam-service)。

只改本地 moss 仓库 `D:\moss-drobotics`,加一个内置 RDK skill 资产文件,不碰匹配/注入代码。

## 背景:为什么现在走错路

实测 + 代码确认根因有两层:

1. **匹配层**(`packages/moss-agent/src/skills/registry.ts:294 matchByText`):
   每轮把用户消息去匹配 skill,命中 ≥90 分的经
   `packages/moss-agent/src/cli/tui-utils.ts:1374 buildMatchedSkillContext`
   inline 注入每轮 `extraContext`。打分主要靠英文 ascii 词
   (`q.split(/[^\p{L}\p{N}]+/u)` 再过滤 `^[a-z0-9]{3,}$`,`registry.ts:297-303`),
   纯中文 token 不进主打分分支。中文要命中,必须靠 `q.includes(trigger)`
   这条(`registry.ts:316`),即 skill 的 `trigger` 字段里**显式写了用户说的中文片段**。
   现有 17 个 builtin + 20 个 RDK skill,没有任何一个的 trigger 含"拍几张照片/拍照",
   所以纯中文拍照请求一个都命中不了 → moss 拿不到 RDK 拍照指引 → 凭通用常识瞎搞。

2. **内容层**:最相关的 `rdk-multimedia` skill,正文 + references + scripts
   里完全没有 `get_isp_data` / `single_pipe_vin_isp_vse` / "cam-service 不能停"
   / "等 AEC 收敛" 的任何提及(grep 零命中)。它讲硬件 pipeline 概念,没给"拍照"
   一个可直接执行的正确步骤。所以哪怕被注入也救不了。

## 改动范围(只加一个文件)

新增:

```
packages/moss-agent/assets/rdk-knowledge/skills/rdk-capture-photo/SKILL.md
```

file-backed,跟其他 20 个 RDK skill 同级。走
`registry.ts:85 resolveBundledRdkSkillsDir()` 自动加载,无需改 builtin.ts、
无需改 registry.ts 匹配逻辑、无需改 tui-utils.ts 注入逻辑。零代码改动。

## SKILL.md 内容

### frontmatter

```yaml
---
name: rdk-capture-photo
description: 在已连接的 RDK 开发板上用板载 MIPI sensor 拍照出 JPEG。走 get_isp_data 专用工具,不碰 /dev/video、不停 cam-service、等 AEC/AWB 收敛取帧。用户说"用开发板拍几张照片/拍照"时使用。调画质(白平衡/曝光/降噪)不在此,用 rdk-isp-tuning。
trigger: 拍几张照片, 拍张照片, 拍张照, 拍照片, 拍几张照, 拍些照片, 拍个照片, 拍个照, 用摄像头拍, 摄像头拍照, 拍张图, 抓一张图, 抓一帧, 出图, capture photo, take a photo, take photos, capture a frame
tags: rdk, camera, capture, photo, mipi, 拍照
risk: low
permissions: device_exec
requires_board: true
delegate_preference: board
approval_level: confirm
---
```

### trigger 词表设计依据

用户典型说法"用这个开发板拍几张照片"。注意 `matchByText` 的 trigger 命中靠
`q.includes(normalizedTrigger)`(`registry.ts:316`),是**子串包含**。
`"用这个开发板拍几张照片".includes("拍照")` = **false**(中间被"几张"隔开),
所以不能用"拍照"这种根词,必须用用户真实会说的**完整片段**:

- `拍几张照片` ← 主 trigger,精确匹配典型说法
- `拍张照片`/`拍张照`/`拍照片`/`拍几张照`/`拍些照片` ← "几张/张/些"变体
- `拍个照片`/`拍个照` ← 口语变体
- `用摄像头拍`/`摄像头拍照` ← 从"摄像头"角度说
- `拍张图`/`抓一张图`/`抓一帧`/`出图` ← 技术口吻
- `capture photo`/`take a photo`/`take photos`/`capture a frame` ← 英文,零成本顺带

### body 正文结构

正文命中后由 `buildMatchedSkillContext` inline 注入每轮 `extraContext`,
所以写成"可直接执行的指令",不写概念铺垫。结构:

1. **一句话目的**:用板载 MIPI sensor 出一张 JPEG。
2. **前置确认(别跳过)**:
   - 已连板(`device_exec` 可用)
   - `cam-service` 在跑 —— **绝不能停**(它是 ISP ISC peer 来源,停了报 -22,
     `isp->isc == NULL`)。引用 rdk-multimedia / SKILL.md 的 ISP -22 认知。
   - `get_isp_data -h` 看 sensor 列表,记下目标 sensor 的 index。
     **OV08D 在 X5 上 index 50(1920×1080 60fps)作示例,不写死 —— 换 sensor 先 `-h` 看。**
3. **拍照步骤(默认拍 1 张)**:
   - 列 sensor:`get_isp_data -h`
   - 后台跑 + 喂 `g` 命令 + 等 AEC/AWB 收敛 + 取后面帧(**不要第一帧**):
     `nohup get_isp_data -s <idx> -c io >/tmp/cap.log 2>&1 &`
     → `sleep 12`(等收敛)
     → `echo "g" | ...` 触发抓帧(或交互式喂 `g`)
     → `ls -t *.yuv | tail -1` 取最新帧
   - NV12 YUV → JPEG:
     `ffmpeg -f rawvideo -pix_fmt nv12 -s 1920x1080 -i frame.yuv -frames 1 out.jpg`
     (1920×1080×1.5 = 3110400 字节 = NV12,先确认尺寸)
   - 拉回/展示给用户
   - **注明:循环喂 N 次 `g` 即拍多张,默认 1 张**
4. **绝对不要做(踩坑清单)**:
   - 不要碰 `/dev/video`(RDK MIPI 不出这个节点)
   - 不要 `srcampy.Camera()` 直接 open(会报 `No camera sensor found` /
     `mipi mclk is not configed`)
   - 不要 `killall cam-service`
   - 不要取第一帧(AEC/AWB 没收敛,曝光/白平衡不对)
5. **调画质 → 指向 rdk-isp-tuning**(不展开,只指:要调白平衡/曝光/降噪/锐化用
   `*_tuning.json`,本 skill 不覆盖)

## 为什么能命中(机制依据)

- 用户说法"用这个开发板拍几张照片" → `includes("拍几张照片")` = true →
  trigger 命中,打分 110 + `min(20, len)`(`registry.ts:317`),稳过 90 分显式命中阈值。
- 没有别的 skill trigger 含这些中文片段 → 不会被抢匹配。
- `rdk-multimedia` description 里有英文 "capture",但走 description 分支只打 90 分
  (`registry.ts:320`),低于 trigger 命中的 110+;且 `rdk-multimedia` 没有 `trigger`
  字段含"拍",不参与 110 分那条。故 `rdk-capture-photo` 优先级更高。
- 命中后 `buildMatchedSkillContext`(`tui-utils.ts:1388 readSkillBody`)读 SKILL.md
  正文 → 拼成 `### rdk-capture-photo\n{description}\n\n{body}` 注入
  每轮 `extraContext`(动态桶,不破坏 prompt 缓存)→ moss 一上来就拿到正确步骤。

## 验证方式

改完启动 moss,连上开发板,输入"用这个开发板拍几张照片",观察:

1. moss 是否走 `get_isp_data`(而不是 `/dev/video`、`srcampy.Camera()`)
2. 是否拍到照片、出了 JPEG
3. 是否没碰 `cam-service`(没 `killall cam-service`)

(如何让本地改的代码在启动 moss 时生效 —— rebuild dist 还是 npm link ——
属实施细节,留 writing-plans 阶段定,不在本 spec 写死。)

## 非目标(明确不做)

- 不改 `matchByText` 中文打分逻辑(那是独立长期优化,影响所有 skill,要跑 eval,
  不和本需求捆绑)。
- 不把 SKILL.md(Downloads 里那份 ISP 调参经验)纳入本次 —— 那是调画质任务,
  职责不同,作为 `rdk-isp-tuning` skill 单独补。
- 不动 builtin.ts、registry.ts、tui-utils.ts。
- 不改板子时间同步(已确认时间不是连接根因,与本需求无关)。
