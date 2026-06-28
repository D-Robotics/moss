# RDK Studio Desktop Client (host-side)

> Sources, item by item:
> - `rdk_studio_doc` `docs/1-product-intro/{1-overview,2-architecture,3-feature-matrix,4-supported-hardware}.md`
> - `rdk_studio_doc` `docs/2-quick-start/{1-install-and-login,2-flash-system,3-connect-device/*}.md`
> - `rdk_studio_doc` `docs/3-user-guide/15-cli/{index,1-rdkstudio,2-dmoss-agent}.md`
>
> RDK Studio runs on the **PC**. The board is the *target*, reached over SSH or Type-C. Everything below is host-side.

## Table of contents

- [1. What RDK Studio is](#1-what-rdk-studio-is)
- [2. Install matrix & login](#2-install-matrix--login)
- [3. First-run onboarding (4 steps)](#3-first-run-onboarding-4-steps)
- [4. Connecting a board (SSH / Type-C / serial)](#4-connecting-a-board-ssh--type-c--serial)
- [5. The flash wizard](#5-the-flash-wizard)
- [6. The CLI: rdkstudio & dmoss-agent](#6-the-cli-rdkstudio--dmoss-agent)
- [7. Supported devices](#7-supported-devices)

---

## 1. What RDK Studio is

RDK Studio is an **AI-native desktop workbench for robot development**. It puts Moss chat, the project workspace, device connection, remote development, flashing, local models, and the board-side agent (OpenClaw) in one native window.

Three parts to understand:

| Part | Where you see it | Used for |
|---|---|---|
| **Desktop client** | The RDK Studio window on your PC | Add devices, flash, terminal, files, remote desktop, code editor, settings |
| **Moss** | Workbench + AI Dock | Analyzes problems / generates steps from current device, project, logs; executes supported actions after you confirm |
| **OpenClaw** | 板端 Agent page | Deployed *onto* an RDK board for board-side chat, device skills, device-local tasks |

Main navigation is grouped into **核心 / 开发工具 / AI 能力**: 工作台; 烧录 / 远程桌面 / 代码编辑器; 板端 Agent / 本地大模型 / 技能工坊.

## 2. Install matrix & login

Download from `https://developer.d-robotics.cc/rdkstudio`.

| Host OS | Installer |
|---|---|
| Windows 10 / 11 (64-bit) | `.exe` |
| macOS (Apple Silicon / M-series) | `.dmg` |

**Not provided:** 32-bit Windows, Windows 7/8/8.1, **Intel Mac**, Linux/Ubuntu desktop. On those platforms use the **CLI** (§6) instead of the GUI.

**Login:** first launch opens the D-Robotics unified SSO login (account/password or SMS). The client stores only the login *state*, never the password. Login state persists; re-opening restores device list, model config, skills, local-model state, and chat history. Reset via *设置 → 账户与安全* → sign out.

## 3. First-run onboarding (4 steps)

| Step | Page | Goal |
|---|---|---|
| 1 | 选择开发板 | Pick RDK X3 / X5 / S100 → drives recommended images & connect methods |
| 2 | 准备系统 | Enter the flash wizard, or skip if the board already boots |
| 3 | 添加设备 | Add via SSH / RDK Type-C 直连 / 本机串口日志 |
| 4 | 开始使用 Moss | Send the first message in the workbench |

Onboarding is skippable and can be restarted from the empty workbench.

## 4. Connecting a board (SSH / Type-C / serial)

**SSH** is the universal entry — works for RDK boards *and* generic Linux / Jetson / Raspberry Pi / Rockchip hosts.

| Field | Note |
|---|---|
| Host / IP | device IP or hostname |
| Port | default `22` |
| User | RDK official images commonly `root`; generic Linux = real account |
| Password | quick connect |
| Alias | shown in the device list & Moss workspace |

After SSH validation, the workbench/terminal/files/code-editor/remote-desktop/Moss all use that one connection. Studio auto-classifies the device (RDK vs generic Linux vs Jetson/Pi/Rockchip vs unknown) and shows only the capabilities that apply.

**Type-C direct connect** — for "device next to the PC, no LAN IP yet":
- Needs a **full-function Type-C data cable** (not charge-only) and a board that supports USB networking.
- Studio detects the new/online USB NIC, configures the host network, and connects with defaults.
- Addresses: **device side `192.168.128.10`**, PC side an address on the same subnet.
- Auth default `root/root`; if the image password was changed, add it as an SSH device instead.
- ⚠️ Distinguish this Type-C gadget address (`192.168.128.10`) from the **S100/S600 management port `eth1` fixed at `192.168.127.10`** — different interfaces.

**Serial log** — host-side boot-log viewer only; **does not** add the device to the list or enable files/Moss/OpenClaw (those still need SSH). RDK debug port is commonly **`115200`** baud; if you see garbage, try another baud per the board's docs. (For S-series *flashing* the serial console is 921600 — see host-flashing.md.)

## 5. The flash wizard

Four steps inside Studio: **选择设备 → 选择镜像 → 开始烧录 → 完成**. Supports official images (incl. online download) and local image/firmware files. TF-card writes offer 稳定模式 (default, low CPU) vs 高速模式 (faster, heavier). Full tool/flow detail (X-series SD vs S-series Xburn) is in [host-flashing.md](host-flashing.md).

## 6. The CLI: `rdkstudio` & `dmoss-agent`

Run the desktop client first so devices/models are configured; the CLI **reuses** that config.

| CLI | Source | When |
|---|---|---|
| `rdkstudio` | written to PATH after you enable it in *配置中心 → 应用与更新* | day-to-day terminal use, reuses desktop device/model config |
| `dmoss-agent` | standalone NPM package `@dmoss/agent` | CI/CD, Docker, standalone scripts |

**`rdkstudio`** common commands:
```bash
rdkstudio --version
rdkstudio device list
rdkstudio device add <device-ip>
rdkstudio exec "uname -a"        # short commands only
rdkstudio file list /userdata
rdkstudio "查看当前设备状态"      # hand a question to Moss
cat error.log | rdkstudio --pipe
```
Enable: *配置中心 → 应用与更新 → 命令行工具 rdkstudio → 启用命令行*. On Windows, open a new terminal after enabling; on macOS run `hash -r` if `command not found`.

**`dmoss-agent`** (standalone, automation):
```bash
npm install -g @dmoss/agent     # needs Node.js ≥20 (22.x recommended)
dmoss-agent --version
export DMOSS_API_KEY=<key>
export DMOSS_MODEL=qwen3.6-plus
export DMOSS_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
dmoss-agent "帮我整理这个目录"
echo "解释这段代码" | dmoss-agent
```
Extra automation flags vs `rdkstudio`: `--weixin` (WeChat iLink channel), `--mesh` (Agent Mesh multi-machine), `--json`, `--no-color`, `--log-level`. Config via env vars or `~/.dmoss-agent/config.json`; keep keys in CI secrets/env, not the repo.

The CLI does **not** carry GUI-only features (flash wizard, remote desktop, local-model management).

## 7. Supported devices

| Item | RDK X3 | RDK X5 | RDK S100 / S100P |
|---|---|---|---|
| Flash method | TF card | TF card; eMMC variants have an eMMC flow | S100 flow (Xburn), wizard-guided |
| Type-C direct | not supported | supported | supported |
| OpenClaw deploy | yes (needs SSH) | yes (SSH or Type-C) | yes (online + reachable) |

Generic Linux / Jetson / Raspberry Pi / Rockchip connect over SSH and get Moss + terminal + files + code editor + project workspace; RDK-exclusive features (Wi-Fi config, Type-C, BPU temperature, OpenClaw install, RDK flashing) are hidden or disabled. Hardware specs: see the official board pages (`developer.d-robotics.cc/rdkx3|rdkx5|rdks100`).
