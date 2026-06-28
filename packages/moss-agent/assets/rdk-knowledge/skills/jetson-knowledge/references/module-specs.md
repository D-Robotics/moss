# Jetson Module Specifications

> Source: NVIDIA official — the [Jetson Orin product page](https://www.nvidia.com/en-us/autonomous-machines/embedded-systems/jetson-orin/), the [JetPack 6.2 Super Mode blog](https://developer.nvidia.com/blog/nvidia-jetpack-6-2-brings-super-mode-to-nvidia-jetson-orin-nano-and-jetson-orin-nx-modules/), and the [Jetson Product Lifecycle](https://developer.nvidia.com/embedded/lifecycle). All AI-performance figures are **INT8 Sparse** unless noted; dense INT8 is half. Defer to the live NVIDIA selector page for "currently shipping" status.

## Jetson Orin family (Ampere GPU)

| Module | GPU (CUDA cores) | CPU | INT8 Sparse / Dense | Memory | FP32 |
|--------|------------------|-----|---------------------|--------|------|
| AGX Orin 64GB | Ampere, 2048 | 12-core Arm | 275 / — TOPS | 64GB LPDDR5 | 5.3 TFLOPS |
| AGX Orin 32GB | Ampere, 1792 | 8-core Arm | 248 / — TOPS | 32GB LPDDR5 | — |
| Orin NX 16GB | Ampere, 1024 | 8-core Arm | 157 / 78 TOPS | 16GB LPDDR5 | 2.4 TFLOPS |
| Orin NX 8GB | Ampere, 1024 | 6-core Arm | 117 / 58 TOPS | 8GB LPDDR5 | — |
| Orin Nano 8GB | Ampere, 1024 | 6-core Arm | 67 / 33 TOPS | 8GB LPDDR5 | 1.04 TFLOPS |
| Orin Nano 4GB | Ampere, 512 | 6-core Arm | 34 / 17 TOPS | 4GB LPDDR5 | — |

- The Orin NX/Nano numbers above are the **JetPack 6.2 Super Mode** values. Pre-Super (JetPack ≤ 6.1) figures were: Orin NX 16GB = 100, Orin NX 8GB = 70, Orin Nano 8GB = 40, Orin Nano 4GB = 20 TOPS.
- AGX Orin has **no Super Mode** — it already runs at its MAXN ceiling. The 64GB part is 275 TOPS, the 32GB part 248 TOPS.
- All Orin modules include **DLA** (Deep Learning Accelerator) cores alongside the GPU; offloading to DLA frees the GPU for other work (`trtexec --useDLACore`).

## Super Mode power profiles (JetPack 6.2)

Super Mode is a **software-only** boost (higher GPU / DLA / CPU clocks) enabled by flashing JetPack 6.2 and selecting the new `nvpmodel` profile. No hardware change.

| Module | New power modes | Super Mode peak (INT8 Sparse) | Enable |
|--------|-----------------|-------------------------------|--------|
| Orin Nano 4GB | 10W, 25W, MAXN SUPER | 34 TOPS | `sudo nvpmodel -m 2` |
| Orin Nano 8GB | 15W, 25W, MAXN SUPER | 67 TOPS | `sudo nvpmodel -m 2` |
| Orin NX 8GB | 10W, 15W, 20W, 40W, MAXN SUPER | 117 TOPS | `sudo nvpmodel -m 0` |
| Orin NX 16GB | 10W, 15W, 25W, 40W, MAXN SUPER | 157 TOPS | `sudo nvpmodel -m 0` |

- Clock deltas NVIDIA cited: Orin Nano GPU 625 → 1020 MHz, CPU 1.5 → 1.7 GHz; Orin NX GPU → 1173 MHz (8GB 765, 16GB 918 → 1173).
- After selecting the mode, **reboot**, then optionally `sudo jetson_clocks` to pin to max for benchmarking.
- List available modes: `sudo nvpmodel -q`. Mode indices differ between Nano and NX — always check `-q` rather than assuming.

## Legacy modules

| Module | GPU arch | AI perf | Memory | Max JetPack | Status |
|--------|----------|---------|--------|-------------|--------|
| Xavier NX | Volta, 384-core (+ 2 NVDLA) | **21 TOPS** | 8 / 16GB LPDDR4x | JetPack 5.1.x (TensorRT 8.5.x) | Production; no JetPack 6 |
| Jetson Nano | Maxwell, 128-core | **472 GFLOPS FP16** | 2 / 4GB LPDDR4 | JetPack 4.6.x | **EOL** (JetPack 4 EOL Nov 2024) |

- **Xavier NX** is **Volta**, not Ampere. 21 TOPS is its fixed spec; there is no Super Mode. It runs JetPack 5.1.x at most.
- **Jetson Nano** (Tegra X1, 128-core Maxwell) has **no INT8 tensor acceleration** — do **not** convert its FP16 GFLOPS into a TOPS figure. Its peak is 472 GFLOPS FP16. JetPack 4 reached End of Life in November 2024; last release was 4.6.6 (Jetson Linux R32.7.6). JetPack 5 and 6 do not support the original Nano.

## Identifying a module on-device

```
cat /proc/device-tree/model          # e.g. "NVIDIA Jetson Orin Nano Developer Kit"
cat /etc/nv_tegra_release             # L4T R-number (maps to JetPack)
sudo apt-cache show nvidia-jetpack    # JetPack version + bundled component versions
```

"Developer Kit" in the model string means the carrier-board devkit; production deployments use the bare module on a custom/partner carrier with the same SoC specs.
