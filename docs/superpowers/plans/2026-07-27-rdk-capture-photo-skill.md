# rdk-capture-photo skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a bundled `rdk-capture-photo` skill to the moss repo so a user saying "用这个开发板拍几张照片" auto-matches it and gets the correct `get_isp_data` photo path injected (instead of moss fumbling with `/dev/video` / `srcampy.Camera()` / stopping cam-service).

**Architecture:** Single new file-backed SKILL.md under `packages/moss-agent/assets/rdk-knowledge/skills/rdk-capture-photo/`. It is auto-loaded by `SkillRegistry` via `resolveBundledRdkSkillsDir()` and auto-injected per-turn by `buildMatchedSkillContext` when its Chinese `trigger` words match the user's message via `matchByText`'s `q.includes(trigger)` path. Zero `.ts` code changes — pure asset addition + a regression test.

**Tech Stack:** Node.js, TypeScript (moss-agent), `.mjs` specs via `node:test` + `node:assert`, run through `npm test -w @rdk-moss/agent` (which builds dist first).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-27-rdk-capture-photo-skill-design.md`. Every requirement there is implemented below.
- Only one file is created (the SKILL.md). No edits to `builtin.ts`, `registry.ts`, `tui-utils.ts`, or any `.ts` source — the spec's "非目标" forbids it.
- Skill is file-backed frontmatter parsed by `parseFrontmatter` (`registry.ts:105`): keys are simple `key: value` lines, lists are comma/semicolon-split by `parseList` (`registry.ts:131`), so `trigger:` is a single comma-separated line (not a YAML block list).
- Trigger matching is substring-contains (`registry.ts:316` `q.includes(normalizedTrigger)`). The phrase "拍照" is NOT a valid trigger for "用这个开发板拍几张照片" (the chars are split by "几张"), so trigger words must be the user's actual spoken fragments — verbatim from the spec's trigger table.
- Tests import from `dist/` (compiled), so `npm run build` must run before tests. `npm test` does this via the package's `test` script (`"test": "npm run build && node ../../scripts/run-package-tests.mjs"`).
- `assets/` is shipped verbatim (it's in the `files` array of `packages/moss-agent/package.json`); `resolveBundledRdkSkillsDir()` reads from source-side `assets/` relative to compiled `dist/skills/registry.js` — so after adding the file, a rebuild makes it loadable.

---

### Task 1: Create the `rdk-capture-photo` SKILL.md

**Files:**

- Create: `packages/moss-agent/assets/rdk-knowledge/skills/rdk-capture-photo/SKILL.md`

**Interfaces:**

- Consumes: nothing (pure new asset).
- Produces: a file-backed `SkillMeta` named `rdk-capture-photo` with `trigger` containing `拍几张照片` (and the rest of the spec's trigger table), loadable by `SkillRegistry.list()` and matchable by `SkillRegistry.matchByText()`.

- [ ] **Step 1: Create the SKILL.md with frontmatter + body**

Create the file at exactly `packages/moss-agent/assets/rdk-knowledge/skills/rdk-capture-photo/SKILL.md`. The frontmatter must follow the single-line `key: value` format that `parseFrontmatter` (`registry.ts:105-129`) expects — `trigger` is ONE comma-separated line, NOT a YAML block list.

Content:

````markdown
---
name: rdk-capture-photo
description: 在已连接的 RDK 开发板上用板载 MIPI sensor 拍照出 JPEG。走 get_isp_data 专用工具，不碰 /dev/video、不停 cam-service、等 AEC/AWB 收敛取帧。用户说"用开发板拍几张照片/拍照"时使用。调画质（白平衡/曝光/降噪）不在此，用 rdk-isp-tuning。
trigger: 拍几张照片, 拍张照片, 拍张照, 拍照片, 拍几张照, 拍些照片, 拍个照片, 拍个照, 用摄像头拍, 摄像头拍照, 拍张图, 抓一张图, 抓一帧, 出图, capture photo, take a photo, take photos, capture a frame
tags: rdk, camera, capture, photo, mipi, 拍照
risk: low
permissions: device_exec
requires_board: true
delegate_preference: board
approval_level: confirm
---

# 在 RDK 板子上拍照（快速路径）

用板载 MIPI sensor 出一张 JPEG。本 skill 给"拍照"这个高频任务一个可直接执行的步骤，不展开硬件 pipeline 概念（那在 rdk-multimedia）。

## 前置确认（别跳过）

1. 已连板子（`device_exec` 可用）。没连就用 `/connect <ip>`。
2. **cam-service 必须在跑，绝不能停。** 它是 ISP 的 ISC peer 来源；停了跑 ISP 会报 -22（`isp->isc == NULL`）。检查：`systemctl is-active cam-service`（或 `ps aux | grep cam-service`）。只有独占 VIN 调 I2C/MCLK 时才停，用完立即 `systemctl start cam-service`——拍照不需要停。
3. 列出可用 sensor，记下目标 index：`get_isp_data -h`。OV08D 在 X5 上是 `index 50`（1920×1080 60fps）——这只是示例，换 sensor 一定先 `-h` 看，别写死。

## 拍照步骤（默认拍 1 张）

1. **列 sensor**：`cd /app/multimedia_samples/sample_isp/get_isp_data && ./get_isp_data -h`，记下目标 index（下文用 `<idx>` 代指）。
2. **后台跑 + 喂 `g` 拍照命令 + 等 AEC/AWB 收敛 + 取后面的帧（不要第一帧）**：
   ```bash
   cd /app/multimedia_samples/sample_isp/get_isp_data
   rm -f handle_*.yuv
   nohup ./get_isp_data -s <idx> -c io >/tmp/cap.log 2>&1 &
   sleep 12                                            # 等 AEC/AWB 收敛
   echo -e "g\nq\n" | ./get_isp_data -s <idx> -c io     # 喂 g 抓一帧，q 退出
   sleep 1
   ls -t handle_*.yuv | head -1                        # 取最新一帧
   ```
````

`get_isp_data` 是交互式的：`g` = 抓一帧出 YUV，`q` = 退出。后台 nohup 是为了让 AEC/AWB 有时间收敛；取 `ls -t | head -1` 的帧而不是第一帧，是因为前几帧曝光/白平衡还没收敛。3. **确认 YUV 格式 + 尺寸**：`ls -l handle_*.yuv`，文件大小 = 宽×高×1.5 即 NV12（如 1920×1080 → 3110400 字节）。分辨率从文件名读（`...1920x1080...`）。4. **NV12 YUV → JPEG**：

```bash
ffmpeg -f rawvideo -pix_fmt nv12 -s 1920x1080 -i handle_<最新>.yuv -frames 1 /tmp/photo.jpg -y
```

（`-s` 的宽×高从上一步读出来填，别写死。）5. **把照片给用户**：`device_file_read` 读 `/tmp/photo.jpg` 回传，或起 `python3 -m http.server` 让用户下载。原样交给用户，别改。6. **拍多张**：要拍 N 张就把第 2 步的 `g` 循环喂 N 次（`for i in $(seq 1 N); do echo g; sleep 1; done; echo q` 喂给交互式进程），每张一个 YUV，分别 ffmpeg 转 JPEG。默认就 1 张。

## 绝对不要做（踩坑清单）

- 不要碰 `/dev/video*`：RDK MIPI 摄像头不出这个节点，列出来是空的，别去调 v4l2。
- 不要 `srcampy.Camera()` 直接 open：会报 `No camera sensor found` / `mipi mclk is not configed`，因为没走 sensor 配置流程。
- 不要 `killall cam-service`：见上文，停了 ISP 就 -22。
- 不要取第一帧：AEC/AWB 没收敛，曝光/白平衡不对。

## 调画质 → 不在本 skill

要调白平衡 / 曝光 / 降噪 / 锐化（改 `*_tuning.json` 的 adaptive tables），用 `rdk-isp-tuning`（单独的 skill）。本 skill 只负责"出一张 JPEG"。

````

- [ ] **Step 2: Verify frontmatter parses to the expected SkillMeta**

Run a one-off node check (does NOT require dist — parses the file the same way `registry.ts` does):

```bash
cd "D:/moss-drobotics/packages/moss-agent" && node -e "
const fs = require('fs');
const path = 'assets/rdk-knowledge/skills/rdk-capture-photo/SKILL.md';
const raw = fs.readFileSync(path, 'utf-8');
const m = raw.match(/^﻿?---\r?\n([\s\S]*?)\r?\n---/);
if (!m) throw new Error('no frontmatter');
const map = {};
for (const line of m[1].split(/\r?\n/)) {
  if (/^\s/.test(line) || /^\s*[-#]/.test(line)) continue;
  const i = line.indexOf(':');
  if (i <= 0) continue;
  map[line.slice(0,i).trim()] = line.slice(i+1).trim().replace(/^(['\"])([\s\S]*)\1$/, '\$2');
}
console.log('name:', map.name);
console.log('trigger count:', (map.trigger || '').split(/[;,]/).map(s=>s.trim()).filter(Boolean).length);
console.log('has 拍几张照片:', (map.trigger || '').includes('拍几张照片'));
if (map.name !== 'rdk-capture-photo') throw new Error('wrong name');
if (!(map.trigger || '').includes('拍几张照片')) throw new Error('missing key trigger');
console.log('OK frontmatter');
"
````

Expected output:

```
name: rdk-capture-photo
trigger count: 18
has 拍几张照片: true
OK frontmatter
```

- [ ] **Step 3: Commit**

```bash
cd "D:/moss-drobotics"
git add packages/moss-agent/assets/rdk-knowledge/skills/rdk-capture-photo/SKILL.md
git commit -m "feat(skills): add rdk-capture-photo bundled skill

Adds a file-backed skill so a user saying '用这个开发板拍几张照片'
auto-matches via matchByText's substring trigger path and gets the
correct get_isp_data photo path injected — instead of moss fumbling
with /dev/video / srcampy.Camera / stopping cam-service.

Pure asset addition; no .ts changes. See
docs/superpowers/specs/2026-07-27-rdk-capture-photo-skill-design.md"
```

---

### Task 2: Add a regression test that the skill loads and matches Chinese

**Files:**

- Create: `packages/moss-agent/test/rdk-capture-photo.spec.mjs`

**Interfaces:**

- Consumes: `SkillRegistry` + `resolveBundledRdkSkillsDir` from `dist/skills/index.js` (built in Task 1's build step / by `npm test`). `SkillRegistry` constructor signature: `new SkillRegistry({ workspaceDir: string, includeBundledRdkSkills?: boolean })`. Methods used: `.list(): SkillMeta[]`, `.matchByText(text: string): SkillMeta[]`.
- Produces: a spec that fails if (a) `rdk-capture-photo` is not in the bundled set, (b) its `trigger` lacks `拍几张照片`, or (c) `matchByText("用这个开发板拍几张照片")` does not return it — the three guarantees this feature depends on.

- [ ] **Step 1: Write the failing test**

Create `packages/moss-agent/test/rdk-capture-photo.spec.mjs`:

```javascript
/**
 * rdk-capture-photo — tested from the user's perspective:
 * a Chinese "用这个开发板拍几张照片" request must match the bundled
 * skill via matchByText's substring-trigger path, so its body gets injected.
 * This is the exact failure mode the skill exists to fix: pure-Chinese
 * photo requests previously matched nothing (ascii token branch ignores
 * CJK), so moss fumbled with /dev/video / srcampy.Camera / cam-service.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SkillRegistry } from '../dist/skills/index.js';

function freshWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'moss-capture-ws-'));
}

test('rdk-capture-photo ships in the bundled RDK pack', () => {
  const ws = freshWorkspace();
  try {
    const skills = new SkillRegistry({ workspaceDir: ws }).list();
    const skill = skills.find((s) => s.name === 'rdk-capture-photo');
    assert.ok(skill, 'rdk-capture-photo is bundled and discoverable');
    assert.ok(
      skill.trigger.includes('拍几张照片'),
      'trigger contains the user-typical Chinese fragment 拍几张照片'
    );
    assert.equal(skill.requiresBoard ?? skill.runtimePolicy?.requiresBoard, true, 'requires board');
    // body is read from disk via readSkillBody; here just assert the file has a body section.
    const raw = fs.readFileSync(skill.sourcePath, 'utf-8');
    assert.ok(raw.includes('get_isp_data'), 'body teaches the correct get_isp_data tool');
    assert.ok(raw.includes('cam-service'), 'body warns about cam-service');
    assert.ok(
      !/\bkillall cam-service\b/.test(raw) === false || raw.includes('不要'),
      'body warns not to kill cam-service'
    );
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('matchByText matches a pure-Chinese photo request and returns rdk-capture-photo', () => {
  const ws = freshWorkspace();
  try {
    const registry = new SkillRegistry({ workspaceDir: ws });
    const matched = registry.matchByText('用这个开发板拍几张照片');
    const names = matched.map((s) => s.name);
    assert.ok(
      names.includes('rdk-capture-photo'),
      `expected rdk-capture-photo to match, got [${names.join(', ')}]`
    );
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('matchByText does NOT misfire on a board-diagnostic request', () => {
  // "板子连不上" should match rdk-board-knowledge, NOT rdk-capture-photo.
  const ws = freshWorkspace();
  try {
    const registry = new SkillRegistry({ workspaceDir: ws });
    const names = registry.matchByText('板子连不上了怎么办').map((s) => s.name);
    assert.ok(
      !names.includes('rdk-capture-photo'),
      'rdk-capture-photo must not match an unrelated diagnostic request'
    );
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Build dist (tests import from dist/)**

Run: `cd "D:/moss-drobotics" && npm run build -w @rdk-moss/agent`
Expected: build completes, `packages/moss-agent/dist/skills/index.js` exists. (The new SKILL.md is in `assets/`, read at runtime via `resolveBundledRdkSkillsDir()` — no compilation of the .md needed, but dist must exist for the import.)

- [ ] **Step 3: Run the new test to verify it passes**

Run: `cd "D:/moss-drobotics/packages/moss-agent" && node --test test/rdk-capture-photo.spec.mjs`
Expected: 3 tests pass, 0 fail. If `matchByText` does not return `rdk-capture-photo` for the Chinese phrase, the test fails — that means a trigger word is wrong or missing and you must fix Task 1's `trigger:` line (re-check that `拍几张照片` is present verbatim and not split across lines).

- [ ] **Step 4: Run the full agent test suite to check for regressions**

Run: `cd "D:/moss-drobotics" && npm test -w @rdk-moss/agent`
Expected: all specs pass, including the existing `cli-skills-bundled.spec.mjs` (which asserts `>= 10` bundled skills — adding one more keeps it ≥10, so it stays green) and `builtin-skills.spec.mjs` (unaffected — builtin count unchanged).

- [ ] **Step 5: Commit**

```bash
cd "D:/moss-drobotics"
git add packages/moss-agent/test/rdk-capture-photo.spec.mjs
git commit -m "test(skills): regression for rdk-capture-photo Chinese matching

Asserts the bundled skill (a) loads, (b) carries the 拍几张照片 trigger,
(c) matchByText returns it for a pure-Chinese photo request, and (d)
does not misfire on an unrelated diagnostic request. Pins the exact
failure mode the skill fixes."
```

---

### Task 3: End-to-end verify on the real board

**Files:**

- None (this is a runtime verification of the built skill against the real board, not a code change). Uses the board at `192.168.127.10` (root/root) already connected in prior work.

**Interfaces:**

- Consumes: the built moss from Task 2's `npm run build` (dist is fresh). The board session via `MOSS_DEVICE_*` env vars (set previously in this user's environment).
- Produces: empirical confirmation that the feature works as the user specified ("下次启动 moss 说一句帮我拍几张照片就能拍照").

- [ ] **Step 1: Launch a one-shot moss with the freshly built dist + board env**

```bash
export PATH="/c/Program Files/OpenSSH:$PATH"
export MOSS_DEVICE_HOST=192.168.127.10
export MOSS_DEVICE_USER=root
export MOSS_DEVICE_PASSWORD=root
export MOSS_DEVICE_NO_VERIFY=1
cd "D:/moss-drobotics/packages/moss-agent"
timeout 300 node dist/cli.js "用这个开发板拍几张照片" 2>&1 | tail -50
```

Expected: the output shows (a) `[device] Persistent SSH session established` (board connected), (b) moss calls `device_exec` running `get_isp_data` (NOT `ls /dev/video*`, NOT `srcampy.Camera`, NOT `killall cam-service`), (c) a JPEG is produced and surfaced. The `## Matched Skills` block in the injected context should name `rdk-capture-photo`.

- [ ] **Step 2: Verify the skill actually matched (not luck)**

If Step 1 produced a photo but you want to confirm it was because the skill matched (not the model guessing), check the matched-skill context. Re-run with a tiny instrumented prompt:

```bash
cd "D:/moss-drobotics/packages/moss-agent"
timeout 120 node dist/cli.js "只回答:你这次匹配到的 skill 名字是什么?列出来即可,不要做任何 board 操作" 2>&1 | tail -20
```

Expected: the model names `rdk-capture-photo` among matched skills. (If it names nothing, the skill did not match even a photo-adjacent request — re-check Task 1's trigger line and Task 2's test.)

- [ ] **Step 3: Record the result**

No commit (verification only). If the photo came out and the skill matched, the feature is done. If moss still fumbled (touched `/dev/video` or stopped cam-service), that is a body-content gap — refine the SKILL.md body in Task 1 (the "绝对不要做" section) and rebuild + re-verify.

---

## Self-Review

**1. Spec coverage:**

- "新增 `rdk-capture-photo/SKILL.md` file-backed" → Task 1, Step 1. ✓
- frontmatter fields (name/description/trigger/tags/risk/permissions/requires_board/delegate_preference/approval_level) → Task 1 Step 1 frontmatter block. ✓
- trigger table (18 words, `拍几张照片` as main) → Task 1 Step 1 + verified Step 2. ✓
- body five sections (前置确认 / 拍照步骤 default 1 / 绝对不要 / 调画质指向) → Task 1 Step 1 body. ✓
- "OV08D=50 作示例不写死,先 `-h` 看" → Task 1 Step 1 body 前置确认 #3 + 拍照步骤 #1. ✓
- "不改 builtin.ts/registry.ts/tui-utils.ts" → Global Constraints + no task touches them. ✓
- "不改 matchByText 中文打分" → no task touches registry.ts. ✓
- "不纳入 ISP 调参 skill" → only rdk-capture-photo created. ✓
- 验证方式 (走 get_isp_data / 出 JPEG / 不碰 cam-service) → Task 3. ✓

**2. Placeholder scan:** No "TBD/TODO/implement later". Every code step has full content. The SKILL.md body is complete, not summarized. Test code is complete. Commands have expected output. ✓

**3. Type consistency:** `SkillRegistry({ workspaceDir })` constructor and `.list()` / `.matchByText(text)` methods match the real signatures read from `registry.ts:183,267,294` and the existing `cli-skills-bundled.spec.mjs` pattern. `SkillMeta.trigger` is `string[]` (parsed from the comma-separated line by `parseList`), so `skill.trigger.includes('拍几张照片')` in the test is valid. ✓

No issues found.
