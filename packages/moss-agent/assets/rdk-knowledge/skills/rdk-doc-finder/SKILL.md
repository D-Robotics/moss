---
name: rdk-doc-finder
description: Pinpoints WHERE in the official D-Robotics documentation a given RDK topic lives, then derives the exact developer.d-robotics.cc URL and verifies it. Use whenever the user asks "where in the docs is X / which manual covers Y / which chapter / where do I look up Z / give me the authoritative link". This is the official doc-SITE navigator — it routes across the six split Docusaurus sites (rdk_x_doc / rdk_s_doc / tros_doc / model_zoo_doc / rdk_studio_doc / accessories_doc) and the archived rdk_doc. 触发词:官方文档在哪、哪本手册、哪一章、去哪查、文档链接、权威出处、developer.d-robotics.cc、文档站、用户手册、Quick Start 在哪、FAQ 在哪、给个官方链接、这个在哪讲。Routing — locating a GitHub repo / source code → rdk-source-map; which board to buy / can it run X / spec comparison → rdk-ecosystem; error-code diagnosis → rdk-board-knowledge; hardware pin/electrical facts → rdk-hardware. This skill answers only "which manual, which chapter, what URL" — it does not replace those content skills.
---

# RDK Official Doc Locator

Point any RDK question at the right official manual, chapter, and verified `developer.d-robotics.cc` URL. The single most important thing: **the docs are split across SIX live sites plus one archive — pick the right site first, then derive the URL, then verify it before handing it over.** Never paste a derived URL you have not confirmed `200`.

> Sources: the six D-Robotics Docusaurus repos (`rdk_x_doc`, `rdk_s_doc`, `tros_doc`, `model_zoo_doc`, `rdk_studio_doc`, `accessories_doc`, default branch `main`) plus the archived `rdk_doc`. URL rules were checked against each repo's `docusaurus.config.js`; representative URLs were curl-tested 200/404 (see "Verified anchors"). Docs evolve with releases — when in doubt, re-fetch.

## Step 1 — Pick the right site (six-site split)

Each topic belongs to exactly one site. Get this wrong and every URL after it is wrong.

| Site (`baseUrl`) | Owns | Boards |
|---|---|---|
| **rdk_x_doc** | X-series main manual: quick start / system config / 40pin / vision / audio / multimedia / toolchain / Linux dev / FAQ / appendix commands | X3 · X3 Module · X5 · X5 Module · Ultra* |
| **rdk_s_doc** | S-series main manual: all of the above **plus MCU dev / hbmem / PCIe / OTA / VDSP** (S-only) | S100 · S100P · S600 |
| **tros_doc** | **TROS / ROS2 robotics**: install / quick demo / function packages (boxs) / apps / perf tuning | cross-board (X & S) |
| **model_zoo_doc** | **Model Zoo** algorithm catalog + usage (precompiled models, infer API, per-board guides) | X3 · X5 · S100 · S600 |
| **rdk_studio_doc** | **RDK Studio desktop client**: install/login / flashing / connect device / AI chat / OpenClaw / Skill / CLI / FAQ | Studio app itself |
| **accessories_doc** | **Official accessories**: stereo cameras GS130W / GS130WI, IMU module | accessory hardware |

\* Ultra has **no page in rdk_x_doc** — its hardware intro lives only in the archived `rdk_doc` (see Step 3).

Site-selection cheat-sheet:

| User asks about… | Go to |
|---|---|
| Using a ROS2 node, installing TROS, Nav2, SLAM, stereo/VIO | **tros_doc** (even on X/S boards) |
| Ready-made YOLO/classification/segmentation model, accuracy figures | **model_zoo_doc** |
| RDK Studio client UI, OpenClaw, flashing dialog, client errors | **rdk_studio_doc** |
| S100/S600 MCU / R52 / hbmem / .hbm / PCIe / EtherCAT / OTA / VDSP | **rdk_s_doc** (X site has no MCU chapter) |
| Other on-board system / peripheral / toolchain topics | X board → **rdk_x_doc**, S board → **rdk_s_doc** |
| Stereo camera GS130W/GS130WI, IMU module | **accessories_doc** |

If the board is unknown, **ask "which board (X3/X5/Ultra/S100/S600)?" first** — do not default to X5.

## Step 2 — Derive the URL, then verify

All six sites are Docusaurus with `url: https://developer.d-robotics.cc`, `baseUrl: /<repo>/`, `routeBasePath: /`. From a GitHub source path you derive the site URL:

> **Baseline rule:** take the repo file `docs/<path>.md`, **strip the leading `NN_` / `NN-` numeric ordering prefix from each path segment**, drop `.md`, keep the case as-is, and join onto `https://developer.d-robotics.cc/<repo>/<path>`.

Verified examples:
- `tros_doc` `docs/03_boxs/detection/yolo.md` → `…/tros_doc/boxs/detection/yolo` (200)
- `rdk_s_doc` `docs/07_Advanced_development/05_mcu_development/08_mcu_ipc.md` → `…/rdk_s_doc/Advanced_development/mcu_development/mcu_ipc` (200)
- `rdk_studio_doc` `docs/3-user-guide/10-openclaw/1-overview.md` → `…/rdk_studio_doc/user-guide/openclaw/overview` (200)

> ⚠️ **Prefix-stripping is NOT global — some leaf directories keep their number.** The `01_40pin_user_sample/` segment is kept: GPIO is `…/Basic_Application/01_40pin_user_sample/gpio` (200); stripping the `01_` to `…/Basic_Application/40pin_user_sample/gpio` returns **404**. So **always `curl`/`web_fetch` a derived URL before handing it out**, especially for `40pin_user_sample` and nested numbered sections.

**Exceptions — check the source frontmatter before deriving:**
1. **Custom `slug:` overrides the path.** A file with `slug:` in its frontmatter keeps whatever that slug says — often including the numeric prefixes. The S100/S600 hardware-intro pages do this: the S600 dev-kit page is `…/rdk_s_doc/01_Quick_start/01_hardware_introduction/02_rdk_s600/01_rdk_s600_kit` (200, slug keeps every `NN_`).
2. **When unsure, give the GitHub source path + the site root** rather than inventing a URL. Inspect frontmatter:
   ```bash
   gh api "repos/D-Robotics/<repo>/contents/<docs/path.md>?ref=main" --jq '.content' | base64 -d | head -8
   ```

## Step 3 — Old `rdk_doc` migration (read this)

- The old merged repo **`rdk_doc`** (`developer.d-robotics.cc/rdk_doc/…`, with `docs/`=X and a second instance routed at `rdk_s`) is **still live** but carries a "this manual has migrated to the new doc center" banner.
- **Always prefer the split `rdk_x_doc` / `rdk_s_doc` / `tros_doc` etc.** Fall back to `rdk_doc` only when the new sites genuinely lack the page, and tell the user it is the archived version.
- `rdk_x_doc` and `rdk_s_doc` are the X/S split-out targets of `rdk_doc`; `tros_doc` was split out of old `rdk_doc` chapter 5 (Robot development).
- **Known archive-only page: RDK Ultra hardware intro** — `…/rdk_doc/Quick_start/hardware_introduction/rdk_ultra` (200). There is no `rdk_ultra` page under `rdk_x_doc`.

## Step 4 — Can't find it? Verify, don't invent

- Unsure a page exists or a URL is right → `web_fetch`/`curl` the URL, or list the repo tree to locate the file first:
  ```bash
  gh api "repos/D-Robotics/<repo>/git/trees/main?recursive=1" --jq '.tree[].path' | grep -iE '<keyword>'
  ```
- The **full topic → location index** (quick start / system config / 40pin / vision / audio / multimedia / Model Zoo / TROS / toolchain / Linux & MCU advanced dev / FAQ / appendix command manual / release notes / RDK Studio / accessories) is in **[doc-map.md](references/doc-map.md)** — each row tags which boards it covers and which site it lives on.

## Worked examples

**Example 1 — "YOLO 目标检测在官方文档哪里讲?给个链接"**
This is a ROS2 function package → **tros_doc**, not the X/S board manual. Answer: `https://developer.d-robotics.cc/tros_doc/boxs/detection/yolo` (verified 200). If they instead want a *precompiled* YOLO model to download, that is model_zoo_doc — ask which they mean.

**Example 2 — "S100 的 MCU IPC 文档在哪?"**
MCU is S-only → **rdk_s_doc**, Advanced development. Source `docs/07_Advanced_development/05_mcu_development/08_mcu_ipc.md`, strip prefixes → `https://developer.d-robotics.cc/rdk_s_doc/Advanced_development/mcu_development/mcu_ipc` (verified 200). Note the X site has no MCU chapter at all.

**Example 3 — "RDK Ultra 的硬件介绍官方在哪看?"**
Trap: there is **no Ultra page in rdk_x_doc** (only rdk_x3 / rdk_x5). The Ultra hardware intro is archive-only: `https://developer.d-robotics.cc/rdk_doc/Quick_start/hardware_introduction/rdk_ultra` (200). Tell the user it is on the legacy site pending migration.

**Example 4 — "RDK Studio 里 OpenClaw 怎么用,有没有官方文档?"**
The desktop client → **rdk_studio_doc** (uses hyphenated `NN-` prefixes). Source `docs/3-user-guide/10-openclaw/1-overview.md` → `https://developer.d-robotics.cc/rdk_studio_doc/user-guide/openclaw/overview` (verified 200).

## Common pitfalls

| ❌ Don't | ✅ Do |
|---|---|
| Hand out a derived URL without checking it | `curl`/`web_fetch` it 200 first — `40pin` and nested numbered sections fail the naive rule |
| Strip the number from `01_40pin_user_sample/` | Keep it — stripped → 404, kept → 200 |
| Send TROS/Nav2/SLAM questions to the board manual | Route all ROS2 topics to **tros_doc** |
| Invent an `rdk_ultra` page under rdk_x_doc | Use the archived `rdk_doc/…/rdk_ultra`; rdk_x_doc only has x3/x5 |
| Default to X5 when the board is unstated | Ask which board first |
| Prefer old `rdk_doc` links | Use the split sites; fall back to `rdk_doc` only when no new page exists, and flag it as archived |
| Assume a custom-slug page follows the strip rule | Read the frontmatter `slug:` (S100/S600 hardware intros keep numeric prefixes) |

## Verified anchors (200, re-checkable)

Stable URLs confirmed live, useful as derivation reference points:

| URL | Site |
|---|---|
| `…/rdk_x_doc/Quick_start/hardware_introduction/rdk_x5` | rdk_x_doc |
| `…/rdk_x_doc/Basic_Application/01_40pin_user_sample/gpio` | rdk_x_doc (prefix kept) |
| `…/rdk_s_doc/01_Quick_start/01_hardware_introduction/01_rdk_s100/01_rdk_s100_kit` | rdk_s_doc (custom slug) |
| `…/rdk_s_doc/Advanced_development/mcu_development/mcu_ipc` | rdk_s_doc |
| `…/tros_doc/boxs/detection/yolo` | tros_doc |
| `…/model_zoo_doc/rdk_x5_guide` | model_zoo_doc |
| `…/rdk_studio_doc/user-guide/openclaw/overview` | rdk_studio_doc |
| `…/accessories_doc/stereo_camera_gs130w/product_overview` | accessories_doc |
| `…/rdk_doc/Quick_start/hardware_introduction/rdk_ultra` | rdk_doc (archive-only) |

## Reference map

| Read this | When |
|---|---|
| [doc-map.md](references/doc-map.md) | You need the full topic → site/URL index across all six sites + archive — every chapter row, with board coverage and verification status |
| `scripts/derive_doc_url.py` | Deterministically derive a candidate URL from a `repo` + `docs/...md` path (applies the strip rule, flags the `40pin`/slug exceptions to verify) |
