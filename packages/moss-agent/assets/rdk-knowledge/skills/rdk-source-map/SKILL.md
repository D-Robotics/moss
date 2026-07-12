---
name: rdk-source-map
description: Map and disambiguate repositories in the D-Robotics GitHub org — tell the user what a repo is, which layer it belongs to, which board it targets, which repo to use for a task, and how to build an RDK OS image or TROS workspace from source. Use whenever the user sees a D-Robotics repo and doesn't know what it does, can't tell hobot- (hyphen, BSP) from hobot_ (underscore, ROS2 app), asks "which repo do I clone for X", or wants the repo/manifest/rdk-gen/vcstool source-build flow. 触发词:这个仓库是干嘛的、属于哪一层、对应哪块板、该 clone 哪个仓、hobot- 和 hobot_ 区别、连字符 下划线、rdk-gen、manifest、repo sync、vcstool、ros2.repos、从源码构建镜像、定制内核、编译 TROS、x5-rdk-gen、s100-rdk-gen。Routing — finding a doc-site chapter → rdk-doc-finder; running a ready-made model on-board → rdk-model-zoo; ROS node usage → rdk-ros; embodied/LLM deployment → rdk-embodied-lerobot / rdk-llm-deployment.
search_query_template: "D-Robotics github repos {{query}}"
---

# D-Robotics GitHub Org Repo Map

Help a user who is staring at the [D-Robotics org](https://github.com/D-Robotics) and cannot tell which repo is which. This skill answers four questions: **what is this repo, what layer/board does it belong to, which repo should I use for my task, and how do I build an image/workspace from source.**

## ⚠️ 关键：先搜索，再回答

**仓库数量、分支名、板卡前缀映射、repo 用途都是时效性信息，会随时间变化。回答前必须先用 `knowledge_search` 或 `web_fetch` 搜索 GitHub 上的最新信息。**

### 仓库分拣（必须用 knowledge_search）

当用户问"这个仓是干嘛的"、"XX板卡该 clone 哪个仓"、"有什么 repo 可用"时，**必须**先搜索：

```
knowledge_search(query="D-Robotics github <仓库名或板卡名>")
```

或直接用 `web_fetch` 打开 `https://github.com/D-Robotics/<repo-name>` 看 README。

### 板卡/前缀/分支（时效性信息，必须搜索确认）

板卡前缀映射和分支策略会随新产品发布而变化。遇到此类问题**必须**搜索确认，不要凭内置知识回答。

The single most important rule: **`hobot-` (hyphen) and `hobot_` (underscore) are two different systems** — get that wrong and every downstream answer is wrong.

> Sources: live `gh api orgs/D-Robotics/repos` metadata plus the READMEs of [rdk-gen](https://github.com/D-Robotics/rdk-gen), [manifest](https://github.com/D-Robotics/manifest), and [robot_dev_config](https://github.com/D-Robotics/robot_dev_config). Repo counts drift as the org evolves — use `gh api` to get current numbers, do not quote exact counts from memory.

## The one distinction that matters most: hyphen vs underscore

Verified by name across all public repos: `hobot-*` (hyphen) vs `hobot_*` (underscore). They are NOT stylistic variants of the same thing. (Counts drift — run `gh api orgs/D-Robotics/repos --paginate --jq '.[].name' | grep -c '^hobot-'` to get current numbers.)

| | `hobot-xxx` (**hyphen**) | `hobot_xxx` (**underscore**) |
| --- | --- | --- |
| Layer | BSP / system source (goes into the OS image) | TROS / ROS2 **application package** |
| Examples | `hobot-boot`, `hobot-camera`, `hobot-multimedia`, `hobot-bpu-drivers`, `hobot-dnn` (low-level lib) | `hobot_dnn` (dnn_node), `hobot_stereonet`, `hobot_usb_cam`, `hobot_llamacpp` |
| Assembled by | `repo` + `manifest` + `*-rdk-gen` → **system image** | `vcstool` + `robot_dev_config/ros2.repos` → **TROS workspace** |
| Language | C / Shell / config | C++ / Python (ROS packages) |

> **Same name across layers:** `hobot-dnn` (hyphen — the low-level BPU inference library inside the image) is wrapped by `hobot_dnn` (underscore — the ROS2 `dnn_node` package). The rule of thumb: **upper ROS node (underscore) → lower BSP library (hyphen).** When a user says "hobot_dnn vs hobot-dnn," this is the answer.

## Three orthogonal axes (apply all three to classify any repo)

1. **Layer**: BSP/system → TROS/ROS2 middleware → application/AI → product/docs.
2. **Board prefix**: see the table below. The bare (no-prefix) `hobot-*`/`rdk-gen`/`manifest` set targets **RDK X3**; `x5-` targets X5.
3. **Assembly system**: `hobot-` (hyphen, image) vs `hobot_` (underscore, TROS) — the section above.

### Board-prefix decision table (参考 — 用 knowledge_search 验证)

> ⚠️ 下表是历史快照，新板卡和新前缀会不断增加。回答前用 `knowledge_search` 搜索确认。

| Prefix | Board | BSP/build repos public? |
| --- | --- | --- |
| *(none)* | RDK X3 | ✅ public (`rdk-gen`, `manifest`, `kernel`, `uboot`, `bootloader`, `hobot-*`) |
| `x5-` | RDK X5 | ✅ public (`x5-rdk-gen`, `x5-manifest`, `x5-kernel`, `x5-hobot-*`) |
| `s100-` | RDK S100 / S100P | ⚠️ **private** (`s100-rdk-gen`, `s100-bootloader`, `s100-hobot-*` exist but are not publicly browsable) |
| `j5-` | Journey 5 (征程5, automotive SoC) | ⚠️ **private** (`j5-rdk-gen`, `j5-manifest`, `j5-kernel-5.10`) |

**用 `knowledge_search` 搜索最新板卡前缀**：`knowledge_search(query="D-Robotics github repo board prefix S600 RDK new")`

### Same BSP component, one copy per SoC

`hobot-multimedia` (X3) / `x5-hobot-multimedia` (X5) / `s100-hobot-multimedia` (S100) are **the same component maintained as three SoC-specific copies**. The same holds for `camera` / `dnn` / `boot` / `dtb` / `wifi` / `io` / `utils` / `display` / `spdev` / `configs` / `audio-config`. This is the Android/Yocto-style per-chip multi-repo BSP layout.

## Two "multi-repo assembly" systems (the key to the whole org)

```
OS IMAGE BUILD                              TROS APP BUILD
  repo + manifest                             vcstool + ros2.repos
  entry: rdk-gen / x5-rdk-gen                 entry: robot_dev_config
  pulls kernel/uboot/bootloader/hobot-*       pulls hobot_* (underscore)
        (hyphen)                                    + rcl/rclcpp/rmw…
  → flashable RDK OS image (*.img)            → /opt/tros workspace + deb packages
  low-level, board-specific                   upper-level, cross-board (relies on BSP)
```

Both flows, with exact commands, are in [os-image-build.md](references/os-image-build.md). **Most users never need either** — they flash an official image and `apt install` TROS. Only reach for source-build when customizing the image, kernel, device tree, a new sensor, or compiling all of TROS from source.

## Workflow — classify an unknown repo

1. **Check the suffix/prefix first** (cheapest signal): `*_doc`/`*-doc` → docs; `nodehub_*` → NodeHub deb packaging; `tros_*` → TROS tooling/orchestration; `magicbox_*` → MagicBox product; `rcl`/`rclcpp`/`rmw_*`/`rosbag2`/`vision_opencv`/`isaac_*` → upstream ROS2 port (NOT RDK-original).
2. **Check hyphen vs underscore** if it contains `hobot`: hyphen → BSP/image; underscore → ROS2 app package.
3. **Check the board prefix**: none → X3, `x5-` → X5, `s100-` → S100/S100P (private), `j5-` → Journey 5 (private).
4. **If still unsure, look it up** — `gh api repos/D-Robotics/<name> --jq '{lang:.language, desc:.description}'`, or run `scripts/classify_repo.py <name>` for a deterministic axis breakdown.
5. **Route to the task-family table** (below) for "which repo do I use."

## Task → which repo family (quick lookup, 用 knowledge_search 验证)

> ⚠️ 仓库和分支会随产品迭代变化。回答前用 `knowledge_search` 搜索确认。

| I want to… | Go to this repo family |
| --- | --- |
| Run a ready-made BPU model | `rdk_model_zoo` → skill `rdk-model-zoo`（用 `knowledge_search` 查分支） |
| Use a vision/perception ROS node (detect/stereo/SLAM/calib) | `hobot_*` underscore + `mono*/stereo*/face_*/hand_*` → skill `rdk-ros` |
| On-device LLM/VLM/speech | `hobot_llamacpp`/`hobot_llm`/`hobot_xlm`/`hobot_tts`/`hobot_audio` → skill `rdk-llm-deployment` |
| Embodied / arm / LeRobot / VLA | `rdk_LeRobot_tools`/`lerobot`/`openpi*`/`RoboTwin` → skill `rdk-embodied-lerobot` |
| **Build/customize an OS image, kernel, driver, add a sensor** | `*-rdk-gen` + `*-manifest` + `kernel`/`uboot`/`bootloader` + `hobot-*` (hyphen) |
| Compile all of TROS from source | `robot_dev_config` (entry) + `tros_*` |
| Package a TROS app into a deb for the app center | `nodehub_*` (READMEs mostly reference TROS docs) |
| Read official doc source | `rdk_doc` / `rdk_x_doc` / `rdk_s_doc` / `tros_doc` / `model_zoo_doc` → skill `rdk-doc-finder` |

The full 12-family map with representative repo lists is in [repo-families.md](references/repo-families.md).

## Worked examples

**Example 1 — "`hobot-dnn` 和 `hobot_dnn` 有什么区别?哪个是我要的?"**
They are different layers. `hobot-dnn` (hyphen) is the low-level BPU inference **library** that goes into the OS image (BSP). `hobot_dnn` (underscore) is the ROS2 **package** (`dnn_node`) that wraps it for use as a node. If you're writing a ROS2 perception node, you want the underscore one; if you're rebuilding the system image or debugging the BPU library, the hyphen one. Rule: upper ROS node (underscore) → lower BSP lib (hyphen).

**Example 2 — "我想从源码构建 S100 的系统镜像,该 clone `s100-rdk-gen` 吗?"**
The `s100-rdk-gen` / `s100-bootloader` / `s100-hobot-*` repos **exist but are private** — you can't clone them anonymously. Public source-build is available for X3 (`rdk-gen` + `manifest`) and X5 (`x5-rdk-gen` + `x5-manifest`); the flow is `repo init -u …/manifest.git -b main` → `repo sync` → `./pack_image.sh`. For S100 image building, use the official prebuilt image instead, or request access. See [os-image-build.md](references/os-image-build.md).

**Example 3 — "组织里 `rcl`、`rclcpp`、`rmw_cyclonedds` 这些是 RDK 自己写的吗?"**
No. Those are **upstream ROS2 repos ported/mirrored** into the org for the TROS cross-compile (pulled by `vcstool` via `ros2.repos`), not RDK-original algorithms. When one of them misbehaves, check upstream ROS2 behavior first before assuming an RDK change. Same for `rosbag2`/`vision_opencv`/`isaac_*`.

**Example 4 — "我要跑一个现成的 YOLO,该去哪个仓?S 系列的板呢?"**
Don't clone a BSP repo. For ready-made models use `rdk_model_zoo`。先用 `knowledge_search` 查对应板卡的分支：`knowledge_search(query="rdk_model_zoo github branches <板卡型号>")`。然后 hand off to skill `rdk-model-zoo` for the actual run-on-board steps.

## Common pitfalls

| ❌ Don't | ✅ Do |
| --- | --- |
| Treat `hobot-dnn` and `hobot_dnn` as the same repo | Hyphen = BSP image lib; underscore = ROS2 package |
| Tell the user to clone `s100-rdk-gen` / `j5-manifest` | Those BSP/build repos are private; only X3 & X5 source-build is public |
| Invent an `s600-` prefix or `s600-rdk-gen` repo | No `s600-` BSP repos exist; S600 support lives in app-layer repos only |
| Assume `rcl`/`rclcpp`/`isaac_*` are RDK-original | They are upstream ROS2 ports; debug against upstream first |
| Quote an exact repo count as fixed | Counts drift — re-run `gh api orgs/D-Robotics/repos` to confirm |
| Send a "run a model" user into a BSP/manifest repo | Route to `rdk_model_zoo` / skill `rdk-model-zoo` |

## Reference map

| Read this | When |
| --- | --- |
| [repo-families.md](references/repo-families.md) | Need the full 12-family classification, the naming-convention cheat table, or a representative repo list for a family |
| [os-image-build.md](references/os-image-build.md) | User wants the actual source-build commands — `repo`/`manifest`/`*-rdk-gen` for the OS image, or `vcstool`/`robot_dev_config` for TROS |
| `scripts/classify_repo.py` | Deterministic axis breakdown for a single repo name (layer / board / assembly system) without reciting from memory |
