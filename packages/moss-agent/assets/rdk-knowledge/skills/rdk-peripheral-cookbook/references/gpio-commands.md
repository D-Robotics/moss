# GPIO / Peripheral Commands

> Sources: D-Robotics RDK official docs (rdk_doc / rdk_s_doc 40pin user guide), toolchain, and standard Linux practice. Facts are carried over with provenance; technical content is not invented.

## Probe / control commands (quick reference)

| Command | Purpose | Risk | Boards |
| --- | --- | --- | --- |
| `i2cdetect` / `i2cget` / `i2cset` | I2C bus scan / read / write | moderate | x3 / x5 / ultra / s100 / s100p / s600 |
| `spidev_test` | SPI loopback test | moderate | x3 / x5 / ultra / s100 / s100p / s600 |
| `gpioset` / `gpioget` / `gpioinfo` / `gpiodetect` (libgpiod) | GPIO line control / inspection | moderate | x3 / x5 / ultra / s100 / s100p / s600 |
| `cat /sys/kernel/debug/pinctrl/...` | Pinmux status query | safe | x3 / x5 / ultra / s100 / s100p / s600 |

## Notes

- On X-series, switch a 40PIN pin's function with `sudo srpi-config` → `3 Interface Options` → `I3 Peripheral bus config` before the corresponding `/dev/i2c-X`, `/dev/spidevX.Y`, or `pwmchip` node appears. The `/app/40pin_samples/` scripts (`test_i2c.py`, `test_spi.py`, `test_serial.py`, `button_led.py`) are pre-verified on the board.
- On S100, I2C5 and UART2 share the same 40PIN pins through a dip switch — only one is active at a time. On S600 there is no standard 40PIN (1.8V self-locking connectors). See [rdk-can-and-board-io.md](rdk-can-and-board-io.md).
- Prefer `libgpiod` (`gpiodetect` → `gpioinfo` → operate by line name) over the deprecated `/sys/class/gpio` sysfs interface and over guessing BCM numbers. See [hardware-notes.md](hardware-notes.md) §libgpiod.
