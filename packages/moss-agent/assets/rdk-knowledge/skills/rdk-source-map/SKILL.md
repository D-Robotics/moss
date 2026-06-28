---
name: rdk-source-map
description: Map and disambiguate repositories in the D-Robotics GitHub org (226 public / 327 total incl. private) — tell the user what a repo is, which layer it belongs to, which board it targets, which repo to use for a task, and how to build an RDK OS image or TROS workspace from source. Use whenever the user sees a D-Robotics repo and doesn't know what it does, can't tell hobot- (hyphen, BSP) from hobot_ (underscore, ROS2 app), asks "which repo do I clone for X", or wants the repo/manifest/rdk-gen/vcstool source-build flow. 触发词:这个仓库是干嘛的、属于哪一层、对应哪块板、该 clone 哪个仓、hobot- 和 hobot_ 区别、连字符 下划线、rdk-gen、manifest、repo sync、vcstool、ros2.repos、从源码构建镜像、定制内核、编译 TROS、x5-rdk-gen、s100-rdk-gen。Routing — finding a doc-site chapter → rdk-doc-finder; running a ready-made model on-board → rdk-model-zoo; ROS node usage → rdk-ros; embodied/LLM deployment → rdk-embodied-lerobot / rdk-llm-deployment.
---

# D-Robotics GitHub Org Repo Map

Help a user who is staring at the [D-Robotics org](https://github.com/D-Robotics) (226 public repos, 327 total including private) and cannot tell which repo is which. This skill answers four questions: **what is this repo, what layer/board does it belong to, which repo should I use for my task, and how do I build an image/workspace from source.** The single most important rule: **`hobot-` (hyphen) and `hobot_` (underscore) are two different systems** — get that wrong and every downstream answer is wrong.

> Sources: live `gh api orgs/D-Robotics/repos` metadata (verified 2026-06, 226 public / 327 total) plus the READMEs of [rdk-gen](https://github.com/D-Robotics/rdk-gen), [manifest](https://github.com/D-Robotics/manifest), and [robot_dev_config](https://github.com/D-Robotics/robot_dev_config). Repo counts drift as the org evolves — re-run `gh api` to confirm before quoting an exact number.

## The one distinction that matters most: hyphen vs underscore

Verified by name across all public repos (2026-06): ~20 `hobot-*` (hyphen) vs ~38 `hobot_*` (underscore). They are NOT stylistic variants of the same thing. (Counts drift — `gh api orgs/D-Robotics/repos --paginate --jq '.[].name' | grep -c '^hobot-'` to recount.)

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

### Board-prefix decision table

| Prefix | Board | BSP/build repos public? |
| --- | --- | --- |
| *(none)* | RDK X3 | ✅ public (`rdk-gen`, `manifest`, `kernel`, `uboot`, `bootloader`, `hobot-*`) |
| `x5-` | RDK X5 | ✅ public (`x5-rdk-gen`, `x5-manifest`, `x5-kernel`, `x5-hobot-*`) |
| `s100-` | RDK S100 / S100P | ⚠️ **private** (`s100-rdk-gen`, `s100-bootloader`, `s100-hobot-*` exist but are not publicly browsable; there is no `s100-manifest`) |
| `j5-` | Journey 5 (征程5, automotive SoC) | ⚠️ **private** (`j5-rdk-gen`, `j5-manifest`, `j5-kernel-5.10`) |
| *(no `s600-` prefix)* | RDK S600 | ❌ **no `s600-` BSP repos exist** (public or private); only app-layer repos carry S600 support |

**Do not tell a user to clone `s100-rdk-gen` or `j5-manifest` as if it were public** — those prefixed BSP/build repos are private. The board-prefix → board mapping is real and useful for *classifying* a name, but availability differs.

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

## Task → which repo family (quick lookup)

| I want to… | Go to this repo family |
| --- | --- |
| Run a ready-made BPU model | `rdk_model_zoo` (X3/X5 branches) / `rdk_model_zoo_s` (S, default branch `s100`) → skill `rdk-model-zoo` |
| Use a vision/perception ROS node (detect/stereo/SLAM/calib) | `hobot_*` underscore + `mono*/stereo*/face_*/hand_*` → skill `rdk-ros` |
| On-device LLM/VLM/speech | `hobot_llamacpp`/`hobot_llm`/`hobot_xlm`/`hobot_tts`/`hobot_audio` → skill `rdk-llm-deployment` |
| Embodied / arm / LeRobot / VLA | `rdk_LeRobot_tools`/`lerobot`/`openpi*`/`RoboTwin` → skill `rdk-embodied-lerobot` |
| **Build/customize an OS image, kernel, driver, add a sensor** | `*-rdk-gen` + `*-manifest` + `kernel`/`uboot`/`bootloader` + `hobot-*` (hyphen) |
| Compile all of TROS from source | `robot_dev_config` (entry) + `tros_*` |
| Package a TROS app into a deb for the app center | `nodehub_*` (READMEs mostly reference TROS docs) |
| Read official doc source | `rdk_doc` (main, 16★) / `rdk_x_doc` / `rdk_s_doc` / `tros_doc` / `model_zoo_doc` → skill `rdk-doc-finder` |

The full 12-family map with representative repo lists is in [repo-families.md](references/repo-families.md).

## Worked examples

**Example 1 — "`hobot-dnn` 和 `hobot_dnn` 有什么区别?哪个是我要的?"**
They are different layers. `hobot-dnn` (hyphen) is the low-level BPU inference **library** that goes into the OS image (BSP). `hobot_dnn` (underscore) is the ROS2 **package** (`dnn_node`) that wraps it for use as a node. If you're writing a ROS2 perception node, you want the underscore one; if you're rebuilding the system image or debugging the BPU library, the hyphen one. Rule: upper ROS node (underscore) → lower BSP lib (hyphen).

**Example 2 — "我想从源码构建 S100 的系统镜像,该 clone `s100-rdk-gen` 吗?"**
The `s100-rdk-gen` / `s100-bootloader` / `s100-hobot-*` repos **exist but are private** — you can't clone them anonymously. Public source-build is available for X3 (`rdk-gen` + `manifest`) and X5 (`x5-rdk-gen` + `x5-manifest`); the flow is `repo init -u …/manifest.git -b main` → `repo sync` → `./pack_image.sh`. For S100 image building, use the official prebuilt image instead, or request access. See [os-image-build.md](references/os-image-build.md).

**Example 3 — "组织里 `rcl`、`rclcpp`、`rmw_cyclonedds` 这些是 RDK 自己写的吗?"**
No. Those are **upstream ROS2 repos ported/mirrored** into the org for the TROS cross-compile (pulled by `vcstool` via `ros2.repos`), not RDK-original algorithms. When one of them misbehaves, check upstream ROS2 behavior first before assuming an RDK change. Same for `rosbag2`/`vision_opencv`/`isaac_*`.

**Example 4 — "我要跑一个现成的 YOLO,该去哪个仓?S 系列的板呢?"**
Don't clone a BSP repo. For ready-made models use `rdk_model_zoo` (pick the branch matching your board — `rdk_x3`, `rdk_x5`, or a `s600` feature branch) and for S-series use `rdk_model_zoo_s` (default branch `s100`). Then hand off to skill `rdk-model-zoo` for the actual run-on-board steps. The `nodehub-x5-rdkmodelzoo-samples` repo packages some of these as installable NodeHub apps.

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
