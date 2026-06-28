---
name: host-software-dev
description: Host-side (x86 PC) software/tooling for RDK dev — the RDK Studio desktop client (install/login/flash/connect/CLI), the x86 Docker BPU toolchain that produces .bin/.hbm, the host flashing tools (RDK Studio/Rufus for X-series SD, Xburn for S-series USB), AND the Electron/React/Vite/Node/TypeScript engineering of building RDK Studio itself. Use whenever the work happens ON THE PC rather than on the board — installing or driving RDK Studio, choosing a flasher, setting up the toolchain Docker, or fixing a desktop-app build/IPC/HMR/packaging issue. 触发词:RDK Studio、studio 安装、烧录工具、Rufus、Xburn、烧录系统、Type-C 直连、rdkstudio 命令行、dmoss-agent、工具链 docker、x86 转换环境、Electron、preload、IPC、Vite、HMR、tsc 报错、打包签名。Routing — running things ON the board (first boot, on-board inference, camera) → rdk-device; the .pt→.bin/.hbm conversion commands → rdk-device/rdk-model-zoo; board error-code lookup → rdk-board-knowledge.
---

# RDK Host Software & Tooling

Everything a user does **on the x86 PC** to develop for RDK: drive the **RDK Studio** desktop client, flash a board, set up the **Docker BPU toolchain**, or — if you are building Studio itself — fix its Electron/React/Vite/Node engineering. The single most important reflex: **decide whether the task runs on the PC (this skill) or on the board (rdk-device) before answering.**

> Sources: official `rdk_studio_doc` (product intro, quick-start, CLI), `rdk_doc` install_os & toolchain chapters, `rdk_s_doc` Xburn flashing, plus framework docs (Electron, Vite, TypeScript, Node). Every non-trivial claim is verified against these; nothing is invented.

## The one distinction that matters most

**Host vs. board.** The PC runs RDK Studio, the flasher, and the model-conversion Docker. The board runs the OS, the runtime (`hobot_dnn`/`hbm_runtime`), and the camera. Two hard rules that follow:

- ✅ Model conversion (`hb_mapper` / `hb_compile`) runs **only on an x86 Linux host inside Docker** — never on the board.
- ❌ RDK Studio's **desktop client ships only for Windows 10/11 (64-bit) and macOS Apple-Silicon** — there is **no** Intel-Mac, 32-bit Windows, or Linux desktop installer. For Linux/CI, use the `rdkstudio` / `dmoss-agent` CLI instead.

## Host-task cheat-sheet

| User wants to… | Host tool | Key fact |
|---|---|---|
| Install RDK Studio | `.exe` (Win 10/11 64-bit) or `.dmg` (macOS Apple Silicon) | No Intel-Mac / Linux / 32-bit build; download from `developer.d-robotics.cc/rdkstudio` |
| Flash X3 / X5 (SD) | RDK Studio flasher **or** Rufus | Writes `.img` to a ≥16 GB Micro SD; X5 eMMC variants have an eMMC flow |
| Flash S100 / S600 (USB) | **Xburn** (Win/macOS/Linux) | USB DFU+Fastboot (bricked/blank) or Fastboot (re-flash); Win needs the `sunrise5_winusb` driver |
| Connect a board with no LAN IP | RDK Studio **Type-C 直连** | Device side `192.168.128.10`; full-function Type-C cable; default `root/root` |
| Convert `.pt`/`.onnx` → `.bin` (X3/X5/Ultra) | `hb_mapper` in OpenExplorer Docker | Host: Ubuntu 20.04, ≥16 GB RAM, Docker 19.03+; GPU optional. X5 image `..._x5_*`, X3 image `..._x3j5_*` |
| Convert → `.hbm` (S100/S100P/S600) | `hb_compile` in OpenExplorer Docker | Host Docker `ai_toolchain_ubuntu_22_s100_s600_*` |
| Script Studio without the GUI | `rdkstudio` CLI / `dmoss-agent` (`@dmoss/agent`) | Enable `rdkstudio` from *配置中心 → 应用与更新*; `dmoss-agent` is the standalone NPM pkg for CI/Docker |
| Build / debug RDK Studio itself | Electron + React + Vite + Node/TS | See **Workflow 4** and `references/desktop-app-engineering.md` |

## Workflows

### Workflow 1 — Install & first-run RDK Studio (PC onboarding)

**Use when:** "怎么安装 RDK Studio", "studio 打不开", "第一次用 studio".

1. **Download** the right installer from `https://developer.d-robotics.cc/rdkstudio` — `.exe` for Windows 10/11 64-bit, `.dmg` for macOS Apple Silicon. **If the user is on Intel Mac, Linux, or 32-bit Windows, stop** — there is no desktop build; route them to the CLI.
2. **First launch** opens the D-Robotics unified SSO login. Studio stores only the login *state*, never the password.
3. **Four-step onboarding:** 选择开发板 (X3/X5/S100) → 准备系统 (flash or skip) → 添加设备 (SSH / Type-C / serial-log) → 开始使用 Moss. The onboarding can be skipped if the board already boots.
4. Re-opening restores device list, model config, skills, local-model state, and chat history. If login is broken, *设置 → 账户与安全* → sign out and back in.

### Workflow 2 — Flash a board from the PC

**Use when:** "烧录系统", "用什么工具刷机", "Rufus", "Xburn", "刷不进去".

1. **Pick the flasher by board family — they are different tools:**
   - **X3 / X5 (SD card):** **RDK Studio** flasher (online or local image, Win+macOS, single-card) **or Rufus** (Windows, local image). Need a ≥16 GB Micro SD + reader. X5 eMMC variants have a separate eMMC flow.
   - **S100 / S100P / S600 (USB):** **Xburn** over a Type-C data cable. Two modes — **DFU+Fastboot** for a blank/bricked board (set boot mode to `dfu`), **Fastboot** for a normal re-flash (board reaches `uboot`). On Windows install the `sunrise5_winusb` driver first; serial console is 921600 baud.
2. **Get the image** from `archive.d-robotics.cc/downloads/os_images/...` (X-series) — choose `server` (headless) or `desktop`. S-series uses official firmware packages.
3. **Inside RDK Studio** the flash wizard is 4 steps: 选择设备 → 选择镜像 → 开始烧录 → 完成. TF-card writes offer 稳定模式 (default, low CPU) vs 高速模式 (faster, heavier).
4. **Never** unplug the card / Type-C cable, sleep, or force-quit Studio mid-write; flashing **erases** the target — confirm it is not the system disk.

### Workflow 3 — Set up the host BPU toolchain (Docker)

**Use when:** "工具链 docker 怎么装", "x86 转换环境", "hb_mapper 在哪跑", "转换环境要求".

1. **The toolchain is host-only, in Docker.** Never `apt install hb_mapper` on the board.
2. **Host requirements (X-series OpenExplorer):** CPU i3+ / E3/E5, **≥16 GB RAM**, **Ubuntu 20.04**, **Docker 19.03+**. GPU is optional (CUDA 11.6, driver ≥510.39.01) — a CPU-only host converts models fine; add NVIDIA Container Toolkit (1.13.5) only for GPU.
3. **Add the user to the docker group** so root is not required: `sudo groupadd docker && sudo gpasswd -a ${USER} docker && sudo service docker restart`.
4. **Pull & run the image** matching the board — **X5** uses `openexplorer/ai_toolchain_ubuntu_20_x5_*`, **X3** uses `openexplorer/ai_toolchain_ubuntu_20_x3j5_*`, **S-series** uses `ai_toolchain_ubuntu_22_s100_s600_*`. Mount the project and enlarge shared memory: `docker run -it --rm --shm-size=15g -v "$(pwd)":/open_explorer <image>`.
5. The **conversion commands themselves** (`hb_mapper checker/makertbin`, `hb_compile`, config.yaml, calibration, `march` values) belong to **rdk-device** → see `references/toolchain-host-setup.md` for the host-side scaffolding and the cross-link.

### Workflow 4 — Build / debug RDK Studio the desktop app (for Studio engineers)

**Use when:** the user is editing RDK Studio's own source — Electron main/preload/renderer, React/Vite UI, Node backend, packaging.

1. **Locate where the code runs first:** browser/renderer, Electron main, preload, Node backend, or build tool. A bug in one layer is not a bug in another. Node APIs must not be reached from the renderer except through a narrow `contextBridge` preload.
2. **Run the narrow command that matches the failure** — `tsc --noEmit` for types, `vite`/`npm run dev` for the dev server, the production build for bundling, `electron-builder` for packaging.
3. **IPC contract:** register `ipcMain.handle(channel, ...)` before any renderer `invoke`; expose only a typed minimal API via `contextBridge`; return structured-clone-serializable values; centralize channel names.
4. **Full troubleshooting table** (preload sandbox, IPC drift, Vite HMR, TS errors, ESM resolution, signing, port-in-use) lives in `references/desktop-app-engineering.md`.

## Worked examples

**Example 1 — "我电脑是 Intel 的 MacBook，怎么装 RDK Studio？"**
*"RDK Studio 的桌面客户端目前只发 Windows 10/11 64 位（`.exe`）和 Apple Silicon Mac（`.dmg`），**没有 Intel Mac 安装包**，所以你这台装不了桌面端。两条路:在一台 Win/Apple-Silicon 机器上跑桌面端;或在 Intel/Linux 上用命令行 `rdkstudio` / `dmoss-agent`(`@dmoss/agent`)做设备、文件、对话这些脚本化任务。"* Don't invent an Intel build.

**Example 2 — "S100 怎么刷系统?用 Rufus 吗?"**
*"S 系列不用 Rufus。Rufus / RDK Studio 是给 X3/X5 写 SD 卡的;S100/S600 走 USB 的 **Xburn** 工具(Win/macOS/Linux 都有)。空板或变砖用 DFU+Fastboot 模式(板子进 `dfu`),正常重刷用 Fastboot 模式。Windows 上先装 `sunrise5_winusb` 驱动,串口 921600。"* Then point to Workflow 2.

**Example 3 — "在哪台机器上跑 hb_mapper 把模型转成 bin?"**
*"在 x86 Linux 开发机的 Docker 里,不是在板子上。最低要求:Ubuntu 20.04、内存 ≥16G、Docker 19.03+;GPU 可选,CPU 机器也能转。拉 X5 镜像 `openexplorer/ai_toolchain_ubuntu_20_x5_*`(X3 是 `..._x3j5_*`),`--shm-size=15g` 挂载工程目录进容器再跑 `hb_mapper`。转换命令本身和 march 取值看 rdk-device。"* (Host setup here; conversion command detail → rdk-device.)

**Example 4 — "RDK Studio 里 preload 报 `require is not defined` 怎么办?"** (Studio engineer)
*"这是 preload/renderer 的 sandbox 边界问题,不是业务 bug。Node-only 代码留在 main 或 preload,用 `contextBridge.exposeInMainWorld` 暴露一个窄接口给 renderer,别在 renderer 直接 `require`;再确认 `BrowserWindow` 的 `webPreferences.preload` 真的指向了这个 preload 文件。"* See `references/desktop-app-engineering.md`.

## Common pitfalls

| ❌ Don't | ✅ Do |
|---|---|
| Look for an Intel-Mac / Linux RDK Studio installer | Use Win10/11-64 or Apple-Silicon desktop, else the CLI |
| Tell an S-series user to flash with Rufus / SD | Use **Xburn** over USB (DFU+Fastboot / Fastboot) |
| `apt install hb_mapper` on the board | Run the toolchain in x86 Docker on the host |
| Assume the toolchain needs a GPU | A CPU-only host (Ubuntu 20.04, 16 GB, Docker 19.03+) converts fine |
| `require()` Node APIs in the renderer | Bridge a narrow typed API via `contextBridge` preload |
| Treat a `tsc` error and a Vite-HMR error as the same surface | Run the command that matches the failing layer |
| Confuse Type-C direct address with the board mgmt port | Type-C gadget = `192.168.128.10`; S-series `eth1` mgmt = `192.168.127.10` |

## Reference map

| Read this | When |
|---|---|
| [rdk-studio-client.md](references/rdk-studio-client.md) | Driving the Studio desktop client — install matrix, SSO login, onboarding, flash wizard, Type-C/SSH/serial connect, `rdkstudio`/`dmoss-agent` CLI |
| [host-flashing.md](references/host-flashing.md) | Choosing & using a flasher — RDK Studio / Rufus (X-series SD) vs Xburn (S-series USB), images, drivers, modes, safety |
| [toolchain-host-setup.md](references/toolchain-host-setup.md) | Setting up the x86 Docker conversion environment — host specs, Docker images, run flags, docker-group; cross-link to rdk-device for the conversion commands |
| [desktop-app-engineering.md](references/desktop-app-engineering.md) | Building RDK Studio itself — Electron process model, preload/IPC, Vite/HMR, TypeScript, ESM, packaging/signing, and the error→cause table |
