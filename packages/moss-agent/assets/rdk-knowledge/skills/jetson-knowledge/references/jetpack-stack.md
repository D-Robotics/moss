# JetPack / Jetson Linux (L4T) Software Stack

> Source: NVIDIA official — [JetPack SDK pages](https://developer.nvidia.com/embedded/jetpack), the [JetPack 6.2 release notes](https://docs.nvidia.com/jetson/archives/jetpack-archived/jetpack-62/release-notes/index.html), and [JetPack 5.1.5](https://developer.nvidia.com/embedded/jetpack-sdk-515). Component versions below are from those release notes.

## What JetPack bundles

**JetPack** is the Jetson board SDK. It is **not** a separate OS — it installs **Jetson Linux (L4T, "Linux for Tegra")** plus the AI/compute libraries on top:

- **Jetson Linux (L4T):** the BSP — bootloader, Linux kernel, Ubuntu root filesystem, NVIDIA drivers.
- **CUDA, cuDNN** — GPU compute.
- **TensorRT** — inference engine builder/runtime.
- **VPI** (Vision Programming Interface), **DLA** stack, multimedia APIs, DeepStream (optional).

One JetPack release pins one L4T release. Never mix component versions across JetPack lines.

## Version matrix

| JetPack | Jetson Linux (L4T) | Kernel | Ubuntu | CUDA | TensorRT | cuDNN | Supported modules |
|---------|--------------------|--------|--------|------|----------|-------|-------------------|
| **6.2** (current prod) | 36.4.3 | 5.15 | 22.04 | 12.6 | 10.3 | 9.3 | Orin (Nano / NX / AGX) — **Super Mode** |
| 6.1 | 36.4 | 5.15 | 22.04 | 12.6 | 10.x | 9.x | Orin |
| 6.0 | 36.3 | 5.15 | 22.04 | 12.2 | 8.6/10.x | 8.9 | Orin |
| 5.1.x | 35.x | 5.10 | 20.04 | 11.4 | 8.5.x | 8.6 | Orin + **Xavier** |
| 4.6.x (**EOL** Nov 2024) | 32.7.x | 4.9 | 18.04 | 10.2 | 8.2 | 8.2 | Nano + Xavier (legacy) |

- **Xavier NX** caps at JetPack **5.1.x**; it never gets JetPack 6.
- Original **Jetson Nano** caps at JetPack **4.6.x** (EOL); last release 4.6.6 / L4T R32.7.6.
- Orin modules are the only ones that receive JetPack 6 and Super Mode.

## Flashing methods

1. **SD-card image** — simplest for the **Orin Nano** and **Xavier NX** developer kits. Download the JetPack SD image from the [Jetson Download Center](https://developer.nvidia.com/embedded/downloads), write with balenaEtcher/`dd`, boot. The Orin Nano **Super** devkit experience requires the JetPack 6.2 image (or the `jetson-orin-nano-devkit-super.conf` flashing config) to unlock Super Mode.
2. **NVIDIA SDK Manager** — GUI on an x86 Ubuntu host; flashes the full SDK (incl. CUDA/TensorRT host tools) and works for AGX Orin / production modules over USB recovery mode. Required for modules with eMMC/NVMe rather than SD.
3. **Manual `flash.sh`** — the underlying L4T flashing script for custom carriers / production lines.

## Version-check commands (on-device)

```
sudo apt-cache show nvidia-jetpack          # JetPack version + bundled component versions
cat /etc/nv_tegra_release                    # L4T R-number (e.g. R36 REVISION: 4.3 → JetPack 6.2)
dpkg -l | grep -E 'tensorrt|cuda-toolkit'    # confirm TensorRT / CUDA versions
nvcc --version                               # CUDA compiler (if dev packages installed)
```

## Container images (`nvcr.io` / NGC)

- Jetson containers come from **NGC** (`nvcr.io`), e.g. the `l4t-base`, `l4t-jetpack`, `l4t-ml`, `l4t-tensorrt`, and DeepStream images.
- The container's **L4T base tag must match the host JetPack** major.minor. A JetPack 6 (`l4t-*:r36.x`) container **will not run** on a JetPack 5 (`r35.x`) host, and vice versa — the userspace CUDA/TensorRT libs are bind-mounted from the host via the NVIDIA container runtime and must be ABI-compatible.
- Use `nvidia-container-runtime` (preinstalled on JetPack) so the GPU/CUDA stack is exposed into the container.

## Health / monitoring

- `tegrastats` — built-in; live GPU%, EMC bandwidth, per-rail power, CPU load, thermals.
- `jtop` — install via `sudo pip3 install jetson-stats` (community `jetson-stats` package); a top-like dashboard wrapping tegrastats, nvpmodel, and jetson_clocks.
- `sudo nvpmodel -q` — current power mode; `sudo jetson_clocks --show` — current clock pinning.
