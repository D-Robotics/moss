# Raspberry Pi Board Specs & AI Acceleration

> Source: official raspberrypi.com product/specification pages and the AI HAT+ product page. Every spec line below is quoted/derived from the official source; newer boards (CM5, Pi 500) change fast, so confirm on raspberrypi.com.

## Board specifications

### Raspberry Pi 5
- **SoC:** Broadcom **BCM2712**
- **CPU:** Quad-core **Arm Cortex-A76 @ 2.4 GHz**, 64-bit, with cryptography extensions, 512 KB per-core L2, 2 MB shared L3
- **RAM:** **LPDDR4X-4267** — **1 GB / 2 GB / 4 GB / 8 GB / 16 GB** (16 GB is Pi 5 only)
- **I/O:** **RP1** southbridge drives the 40-pin header, USB, and other peripherals over PCIe
- **GPIO:** use `gpiozero` / `lgpio` — **not** `RPi.GPIO` (see gpio-rp1.md)
- **AI:** no NPU; CPU inference, or add a **Hailo AI HAT+** (PCIe)

### Raspberry Pi 4 Model B
- **SoC:** Broadcom **BCM2711**
- **CPU:** Quad-core **Cortex-A72 (Arm v8) @ 1.8 GHz**, 64-bit
- **RAM:** **1 GB / 2 GB / 4 GB / 8 GB** LPDDR4
- **I/O:** GPIO controller is on the SoC (no RP1)
- **GPIO:** `gpiozero` / `lgpio`; classic `RPi.GPIO` still works here
- **AI:** no NPU; CPU / ONNX / TFLite

### Compute Module 4 (CM4)
- **SoC:** Broadcom **BCM2711**
- **CPU:** Quad-core **Cortex-A72 (Arm v8) @ 1.5 GHz**, 64-bit
- **RAM:** **1 GB / 2 GB / 4 GB / 8 GB** LPDDR4-3200
- **Variants:** Lite (no eMMC) vs eMMC, and wireless vs non-wireless SKUs
- **I/O:** GPIO on the SoC (no RP1); exposed via the carrier board's connectors
- **AI:** no NPU; CPU / ONNX / TFLite

### Quick comparison

| | Pi 5 | Pi 4B | CM4 |
|---|------|-------|-----|
| SoC | BCM2712 | BCM2711 | BCM2711 |
| CPU | A76 @2.4GHz | A72 @1.8GHz | A72 @1.5GHz |
| Max RAM | 16 GB | 8 GB | 8 GB |
| RP1 | Yes | No | No |
| RPi.GPIO works | No | Yes | Yes |
| On-board NPU | No | No | No |

> Newer boards exist (CM5, Raspberry Pi 500, etc.). Treat any spec not listed here as "check raspberrypi.com" rather than guessing.

## AI acceleration — no on-board NPU

All three boards report **0 TOPS** — there is **no neural accelerator in the SoC**. Inference options:

1. **CPU only (any Pi):** ONNX Runtime, TensorFlow Lite, or PyTorch aarch64 wheels. Quantize to INT8 for usable throughput; expect modest FPS.
2. **Hailo AI HAT+ (Pi 5 only, PCIe):**

   | Product | TOPS | Hailo accelerator |
   |---------|------|-------------------|
   | Raspberry Pi AI HAT+ 13 TOPS | 13 | **Hailo-8L** |
   | Raspberry Pi AI HAT+ 26 TOPS | 26 | **Hailo-8** |

   - Models run as **HEF** files (Hailo Executable Format).
   - HEF files are **compiled on a host** with Hailo's Dataflow Compiler / Model Zoo (TensorFlow/PyTorch → HEF), **not** on the Pi.
   - The Pi runs **HailoRT** to execute the HEF. The HAT+ mounts on a Pi 5 (with the Active Cooler / stacking header).

> An earlier **AI Kit** (M.2, also Hailo-8L, 13 TOPS) preceded the AI HAT+; the AI HAT+ is the current PCIe-HAT form.

## Operating system & paths

- **OS:** Raspberry Pi OS (Debian-based) is the reference; Ubuntu and other distros also run.
- **Boot config (Bookworm+):** `/boot/firmware/config.txt` (moved from `/boot/config.txt`).
- **Identify a board at runtime:** `cat /proc/device-tree/model`.

## Official links

- [Raspberry Pi Documentation](https://www.raspberrypi.com/documentation/)
- [Raspberry Pi 5 product page](https://www.raspberrypi.com/products/raspberry-pi-5/)
- [Raspberry Pi 4 Model B specifications](https://www.raspberrypi.com/products/raspberry-pi-4-model-b/specifications/)
- [Compute Module 4 product page](https://www.raspberrypi.com/products/compute-module-4/)
- [Raspberry Pi AI HAT+](https://www.raspberrypi.com/products/ai-hat/)
- [Camera software documentation](https://www.raspberrypi.com/documentation/computers/camera_software.html)
