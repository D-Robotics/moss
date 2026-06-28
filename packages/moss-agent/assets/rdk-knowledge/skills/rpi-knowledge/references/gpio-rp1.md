# Raspberry Pi GPIO & the RP1 I/O Chip

> Source: official raspberrypi.com GPIO documentation and the Raspberry Pi "GPIO usage and current best practices" white paper, plus gpiozero/lgpio project docs. Every recommendation below is from the official guidance.

## The core change on Pi 5

On Raspberry Pi 4 Model B and earlier, the GPIO controller is **inside the BCM SoC**. Older libraries reach the pins by memory-mapping the SoC's peripheral registers (`/dev/mem` / `/dev/gpiomem`).

On **Raspberry Pi 5**, the 40-pin header is driven by the **RP1** southbridge — a separate I/O controller connected over PCIe — not by the main BCM2712 SoC. The old register mappings no longer exist at the same addresses, so:

- **`RPi.GPIO` does not work on Pi 5** (it expects the SoC peripheral base; you typically see `RuntimeError: Cannot determine SOC peripheral base address` or "Not running on a RPi").
- **`wiringPi`** (deprecated for years) likewise can't reach the new layout.
- Anything poking `/dev/mem` registers directly must be replaced with a library that uses the **`/dev/gpiochip*` character-device** interface.

The **pin numbering is unchanged** — pins are still referenced by their BCM number (`GPIO17`, `GPIO27`, …). Only the access mechanism moved.

## Which library to use (official recommendation)

| Library | Use it when | Backend / interface | Pi 5? |
|---------|-------------|---------------------|-------|
| **`gpiozero`** | Default for beginners and most projects; portable code across all Pi models | High-level objects (`LED`, `Button`, `Motor`…); uses `lgpio` as its pin factory | ✅ (recommended) |
| **`lgpio`** | You want lower-level control or are on a non-Pi SBC | `/dev/gpiochip*` character device | ✅ |
| **`libgpiod` / `gpiod`** | C programs or shell tools (`gpioget`, `gpioset`, `gpioinfo`) | `/dev/gpiochip*` character device | ✅ |
| **`rpi-lgpio`** | You have existing `RPi.GPIO` code and want minimal changes | Re-implements the `RPi.GPIO` API on top of `lgpio` | ✅ (drop-in shim) |
| ~~`RPi.GPIO`~~ | Pi 4B / older only | Direct SoC register access | ❌ on Pi 5 |
| ~~`wiringPi`~~ | Deprecated, avoid | Direct register access | ❌ |

**Decision order for a new project:** `gpiozero` first → drop to `lgpio` only if you need lower-level control → use `rpi-lgpio` only to keep an old `RPi.GPIO` codebase alive without rewriting.

### `gpiozero` is portable

`gpiozero` is pre-installed on Raspberry Pi OS and automatically selects a working pin factory (`lgpio` on current OS). The same `gpiozero` script runs on a Pi 4B and a Pi 5 without change — this is the main reason the docs recommend it as the default.

### `rpi-lgpio` caveat

`rpi-lgpio` provides the **same module name and API as `RPi.GPIO`**. Do **not** have both installed at once — uninstall the real `RPi.GPIO` first, or imports become ambiguous. It also depends on `lgpio`.

## gpiochip numbering (only matters for raw `gpiod`/`lgpio` chip selection)

`gpiochip` device numbers are assigned by the kernel GPIO framework in **probe order**, which a driver cannot influence. Because RP1 sits on the **PCIe bus**, it enumerates after directly-attached controllers and historically received a higher number:

- On many Pi 5 kernels the expansion-header pins were exposed as **`gpiochip4`** (the RP1 controller, 54 lines), with `gpiochip0–3` belonging to the BCM2712.
- On **newer Pi 5 kernels** the RP1 main GPIOs enumerate first as **`gpiochip0`**.

**Practical advice:** don't hard-code the chip number. Use `gpioinfo` to discover which chip holds the header pins, or just use `gpiozero`/`lgpio`, which resolve the right chip for you.

## Quick command reference

```bash
# Identify the board (decides whether RP1 applies)
cat /proc/device-tree/model

# List GPIO chips and their lines (libgpiod tools)
gpioinfo

# Read / set a line with libgpiod (chip number from gpioinfo)
gpioget gpiochip0 17
gpioset gpiochip0 17=1

# Inspect / control pins with the Raspberry Pi pinctrl utility
pinctrl get 17
pinctrl set 17 op dh    # output, drive high
```

```python
# gpiozero — portable, recommended
from gpiozero import LED
led = LED(17)          # BCM 17
led.on()

# lgpio — lower level, character-device based
import lgpio
h = lgpio.gpiochip_open(0)     # chip 0 (verify with gpioinfo)
lgpio.gpio_claim_output(h, 17)
lgpio.gpio_write(h, 17, 1)
```

## Troubleshooting map

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `Cannot determine SOC peripheral base address` on Pi 5 | `RPi.GPIO` on Pi 5 | Switch to `gpiozero`/`lgpio`, or `rpi-lgpio` for legacy code |
| `import RPi.GPIO` works but pins do nothing on Pi 5 | Both `RPi.GPIO` and `rpi-lgpio` installed, or stale lib | Uninstall real `RPi.GPIO`; rely on `rpi-lgpio`/`gpiozero` |
| `gpioget gpiochip0 N` reads the wrong pin | Wrong chip number for this kernel | Run `gpioinfo`; use the chip that lists header pins |
| Pin works on Pi 4 code, fails on Pi 5 | Direct-register library | Move to character-device library |
