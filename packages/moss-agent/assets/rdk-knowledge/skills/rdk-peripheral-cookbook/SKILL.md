---
name: rdk-peripheral-cookbook
description: Hands-on peripheral driving on RDK boards — GPIO/I2C/SPI/UART/PWM, servos, DC/stepper/BLDC motors, LED/WS2812, audio (ALSA), and CAN (X5 SocketCAN vs S100/S600 MCU-domain CANHAL) — plus cross-platform pin/bus mapping and zero-driver diagnosis. Use whenever the user wants to actually light an LED, spin a motor, read a sensor, play/record audio, wire a servo, bring up CAN, or when a peripheral plugged into the board is "not detected / no driver". 触发词:点灯、GPIO 不工作、libgpiod、i2cdetect、PCA9685、舵机、步进电机、无刷、WS2812 灯带、ALSA 播放录音、aplay、CAN、SocketCAN、cansend、candump、S100 CAN、S600 自锁口、40PIN 接线、拨码开关、设备不识别没驱动. Routing — pure GPIO pin-number facts / per-board pinout tables → rdk-hardware (cite it when wiring); device error-code lookup / "板子报错" → rdk-board-knowledge; connector/cable/accessory part numbers → rdk-accessories.
---

# RDK Peripheral Cookbook

Drive a real peripheral on an RDK board: GPIO, I2C, SPI, UART, PWM, servos, motors, LEDs, audio, and CAN. **The single rule that prevents the most damage: never power a servo, motor, or LED strip from 40PIN Pin 2/4 (5V) — even one SG90 stall current can brown out the board and reboot it. Always use an external 5V/6V supply and share GND.**

> Sources: official D-Robotics docs (rdk_doc / rdk_s_doc 40pin user guide, rdk_x5/can.md, mcu_development/09_mcu_can.md), the x5-hobot-io toolchain, and standard cross-platform Linux peripheral practice. Every non-trivial board-specific claim is verified against the cited source; cross-platform Linux facts (libgpiod, ALSA, PCA9685) are standard and noted as such.

## The one rule that matters most

A peripheral that needs current — **servo, DC/stepper/BLDC motor, WS2812 strip** — must NOT draw its power from the 40PIN 5V rail (Pin 2/4). Stall or full-load current pulls the rail down and reboots the board. **Always:** external 5V/6V supply for the load, signal line back to the board, **common GND**. This applies on RDK, Raspberry Pi, Jetson, and Rockchip alike — it is not RDK-specific.

## Decision cheat-sheet (pick the right approach)

| Need | First-choice approach |
| --- | --- |
| Cross-board GPIO / unsure of pin number | **`libgpiod`** (`gpiodetect` / `gpioinfo` / `gpiofind "GPIO17"`) — don't guess BCM numbers |
| Single servo (1–2 ch) | On-board hardware PWM (50Hz / 20ms period, 1.0–2.0ms pulse), external supply |
| Multiple servos (≥3 ch) | **PCA9685 + I2C** (default addr `0x40`), servo power on PCA9685's V+ terminal |
| DC motor | H-bridge (TB6612 / DRV8833 / BTS7960) + PWM speed + GPIO direction |
| Stepper motor | Dedicated driver (A4988 / DRV8825 / **TMC2209** silent) + STEP/DIR |
| Brushless (BLDC) | RC ESC (50Hz PWM, reuse PCA9685) or ODrive/VESC (UART/CAN closed-loop); on S100 use the MCU real-time domain |
| WS2812 RGB strip | **SPI MOSI emulating the 800kHz timing** (run SPI at 2.4MHz, `NeoPixel-SPI`). RPi's `rpi_ws281x` does NOT work on RDK |
| Audio (no TROS) | Standard **ALSA** (`aplay -l` / `arecord` / `alsamixer`); **a USB sound card is the universal fallback** |
| CAN | **Only X5 is Linux SocketCAN** (TCAN4550): `ip link set can0 type can bitrate 500000 dbitrate 2000000 fd on` + can-utils. **S100/S600 CAN lives in the MCU domain** — use CANHAL/IPC + `/app/Can` sample, NOT `ip link`. X3/Ultra have no on-board CAN. Full bringup: [rdk-can-and-board-io.md](references/rdk-can-and-board-io.md) |

## Safety rules (check before powering any peripheral)

1. **Never take 5V for servos/motors/WS2812 from 40PIN Pin 2/4.** External 5V/6V supply, common GND with the board.
2. **Scan before you read/write.** I2C: run `i2cdetect -y <bus>` and confirm the address appears first. PWM: start at low frequency / low duty.
3. **Persistent kernel/boot changes are the highest risk** (`/boot`, device tree, MCU firmware). On RDK, don't touch them unless necessary.
4. **RDK-specific trap:** a 40PIN pin may default to GPIO. On X-series, switch the function first via `sudo srpi-config` → `3 Interface Options` → `I3 Peripheral bus config` (or the `/app/40pin_samples/` scripts) before `/dev/i2c-X` or a `pwmchip` appears. **S100** muxes I2C5/UART2 on the 40PIN with a **dip switch** (pick one). **S600 has NO standard 40PIN** — self-locking connectors, 1.8V digital IO; the 40PIN wiring in this cookbook does not apply to S600 (see [rdk-can-and-board-io.md](references/rdk-can-and-board-io.md) §4 and rdk-hardware).

## Workflows

### Workflow 1 — Cross-board GPIO (light an LED, read a button)

**Use when:** 点灯, GPIO 不工作, blink, button read, writing a script meant to run on more than one board.

1. **Enumerate, don't guess.** `gpiodetect` → lists every gpiochip. `gpioinfo gpiochip0` → shows each line's name.
2. **Operate by name** for portability: `gpioset $(gpiofind "GPIO17")=1`. This is the only API common to RDK / RPi / Jetson / Rockchip.
3. **Use `Hobot.GPIO`** only when you need RPi-tutorial compatibility (its API copies `RPi.GPIO`). It is **system-Python only** — `import Hobot.GPIO` inside conda/venv fails; use `/usr/bin/python3`.
4. **Real-time / <1ms jitter?** Call `libgpiod` from C, or on X5 use `x5-hobot-io` (C bindings, ~10× lower latency than Python `Hobot.GPIO`).

Details and the cross-platform pin/bus mapping: [hardware-notes.md](references/hardware-notes.md).

### Workflow 2 — Servos and motors

**Use when:** 舵机, 步进电机, 直流电机, 无刷, motor won't turn, robot joint.

1. **Single servo (1–2 ch):** on-board hardware PWM. Signal = 50Hz (20ms period) + 1.0ms (0°) to 2.0ms (180°) pulse. Switch the pin to PWM mode first (`srpi-config` on X-series), then drive via `/sys/class/pwm/pwmchipN/`.
2. **≥3 servos:** **PCA9685 + I2C** (addr `0x40`, 16ch, 12-bit). Servo power goes to PCA9685's **V+ screw terminal**, never the 40PIN rail.
3. **DC motor:** H-bridge + PWM (speed) + GPIO (direction). TB6612FNG for a small 2-wheel car, BTS7960 for high current.
4. **Stepper:** dedicated driver + STEP/DIR (2 GPIO, no PWM needed). TMC2209 if silence matters.
5. **BLDC:** RC ESC (50Hz PWM like a servo) for open-loop; ODrive/VESC (UART/USB/CAN) for closed-loop. **Bus servos** (Feetech STS / Dynamixel) over USB-TTL are the standard for desktop arms / quadrupeds — one wire, many addressable servos.

Full wiring tables, code, and the PCA9685 troubleshooting steps: [hardware-notes.md](references/hardware-notes.md) §Servos and §Motors.

### Workflow 3 — Audio without TROS (ALSA)

**Use when:** play/record audio and `hobot_audio` (TROS + official mic-array board) is not available.

1. **Probe:** `aplay -l` / `arecord -l` list output/input cards. Nothing listed → kernel didn't see hardware → check `lsusb` and `dmesg | grep -i snd`.
2. **Play:** `aplay test.wav`, or `aplay -D plughw:1,0 test.wav` for a specific card. MP3 needs `mpg123` / `sox` first.
3. **Record:** `arecord -D plughw:1,0 -f S16_LE -r 16000 -c 1 -d 5 test.wav`.
4. **Silent but a card exists?** `alsamixer` → unmute (M), raise volume. Busy/"unable to open slave" → another process holds it (`sudo fuser /dev/snd/*`).
5. **Universal fallback:** plug in a **USB sound card** — `snd-usb-audio` auto-loads and `aplay -l` shows it immediately. This is the only recommended path on Jetson (no on-board audio) and on RDK without an I2S HAT.

Command catalog and error table: [hardware-notes.md](references/hardware-notes.md) §Audio.

### Workflow 4 — CAN bringup

**Use when:** CAN, SocketCAN, cansend, candump, S100/S600 CAN.

1. **Identify the board first** — this decides everything (`scripts/can_mode.py <board>` answers it deterministically):
   - **X5** → Linux SocketCAN (TCAN4550 on SPI5). `ip link` + `can-utils`. Has a `can0` network device.
   - **S100 / S600** → CAN controller is in the **MCU domain**. Use CANHAL library + IPC + the `/app/Can` sample. There is **no `can0`** — `ip link set canX` does not apply.
   - **X3 / Ultra** → no on-board CAN.
2. **X5 quick self-test (loopback):** `ip link set can0 type can bitrate 125000` → `loopback on` → `up` → `candump can0 -L &` → `cansend can0 123#1122334455667788`.
3. **X5 CAN FD:** `ip link set can0 type can bitrate 500000 dbitrate 2000000 fd on`; send an FD frame with `##` (e.g. `cansend can0 123##3...`).
4. **S100/S600:** start MCU1, build the `/app/Can` sample (`make`), edit the JSON config to the right IPC instance/channel for your CAN line, then `./canhal_get bypass &` / `./canhal_send bypass <ch>`. Terminate the bus with the right 120Ω element (X5 = switch, S100 = jumper, S600 = dip ON).

Full per-board CAN bringup, IPC channel maps, S100 dip mux, and S600 self-locking IO: [rdk-can-and-board-io.md](references/rdk-can-and-board-io.md).

### Workflow 5 — Zero-driver diagnosis (device not detected)

**Use when:** "I plugged in X but the board doesn't recognize it / no driver". Don't guess — run the 9 steps. Universal across RDK / RPi / Jetson / Rockchip.

```
dmesg | tail -50  →  lsusb  →  ls /dev/ (tty*/video*/i2c-*/spidev*/snd/)
→  i2cdetect -l && i2cdetect -y <bus>  →  v4l2-ctl --list-devices
→  aplay -l / arecord -l  →  lsmod | grep <kw>  →  modinfo/modprobe <mod>
→  cat /proc/device-tree/…
```

**Answer template:** ask for **board model + interface (USB / 40PIN I2C / UART / MIPI) + device model** → have the user run `dmesg`/`lsusb`/`ls /dev` and paste back → match the symptom table → give the smallest verifiable command → only then discuss ROS2-node wrapping / autostart.

Symptom→diagnosis table and the three orthogonal fix paths: [hardware-notes.md](references/hardware-notes.md) §Zero-driver diagnosis.

## Worked examples

**Example 1 — "我在 S100 上敲 `ip link set can0 type can bitrate 500000` 不工作"**
That's the X5 path. **S100's CAN is in the MCU domain — there is no `can0` network device.** Answer: *"S100/S600 don't expose SocketCAN. The CAN controller lives in the MCU domain; Acore reaches it through CAN2IPC → IPC → the CANHAL library. Use the `/app/Can` sample: start MCU1, `make` the sample, set the IPC instance/channel in its JSON config (e.g. S100 CAN6 = instance 0 / channel 6), then `./canhal_get bypass &` and `./canhal_send bypass 6`. `ip link`, `cansend`, `candump` only work on X5."* Point to [rdk-can-and-board-io.md](references/rdk-can-and-board-io.md) §2.

**Example 2 — "想在 RDK X5 上接 4 个舵机，怎么接线?"**
Don't drive 4 servos from on-board PWM or the 40PIN rail. Answer: *"Use a PCA9685 (I2C, default `0x40`, 16 channels). Wire SDA/SCL/VCC/GND to the board; put the **servo power on the PCA9685 V+ screw terminal** from an external 5V/5A supply, common GND. Confirm with `i2cdetect -y <bus>` that `0x40` shows up before coding. If servos jitter, it's almost always supply, not signal."* Point to Workflow 2.

**Example 3 — "插了 USB 麦克风，想录音,没装 TROS"**
No TROS needed — go straight to ALSA. Answer: *"`arecord -l` to find the card (e.g. card 1). Record with `arecord -D plughw:1,0 -f S16_LE -r 16000 -c 1 -d 5 test.wav`, play back with `aplay test.wav`. If nothing shows in `arecord -l`, check `lsusb` and `dmesg | grep -i snd` — a USB mic should auto-load `snd-usb-audio`."* Point to Workflow 3.

**Example 4 — "我接了个 WS2812 灯带,GPIO 拉高拉低控制不了"**
GPIO bitbang can't hold the WS2812 800kHz timing reliably. Answer: *"Drive WS2812 from the **SPI MOSI** pin, emulating the timing: run SPI at ~2.4MHz and encode each WS2812 bit as 4 SPI bits, via `Adafruit-CircuitPython-NeoPixel-SPI`. RPi's `rpi_ws281x` does NOT work on RDK. And 30 LEDs at full white ≈ 1.8A — power the strip from an external 5V supply with common GND, never the 40PIN rail."* Point to [hardware-notes.md](references/hardware-notes.md) §LEDs.

## Common pitfalls

| ❌ Don't | ✅ Do |
| --- | --- |
| Power servos/motors/WS2812 from 40PIN Pin 2/4 | External 5V/6V supply, common GND |
| Run `ip link set can0 ...` on S100/S600 | Use the MCU-domain CANHAL `/app/Can` sample (only X5 is SocketCAN) |
| Guess BCM numbers in a cross-board script | Use `libgpiod` by line name (`gpiofind "GPIO17"`) |
| Read I2C before confirming the address | `i2cdetect -y <bus>` first, then read/write |
| Expect `/dev/i2c-X` / `pwmchip` to exist by default | Switch the 40PIN function first (X5 `srpi-config`; S100 dip switch) |
| `import Hobot.GPIO` inside conda/venv | Use system `/usr/bin/python3` (bindings are system-only) |
| Drive WS2812 via GPIO bitbang | SPI MOSI emulation at 2.4MHz (`NeoPixel-SPI`) |
| Assume S600 has a 40PIN | S600 uses 1.8V self-locking connectors (§4) |

## Reference map

| Read this | When |
| --- | --- |
| [gpio-commands.md](references/gpio-commands.md) | Quick command/risk table for I2C / SPI / GPIO / pinmux probing |
| [hardware-notes.md](references/hardware-notes.md) | Deep dives: cross-platform 40PIN pin/bus mapping, libgpiod, servos & PCA9685, motor paradigms, LEDs/WS2812, ALSA audio, zero-driver diagnosis SOP |
| [rdk-can-and-board-io.md](references/rdk-can-and-board-io.md) | CAN bringup (X5 SocketCAN / S100·S600 MCU-domain CANHAL), S100 I2C5↔UART2 dip mux, S600 self-locking IO (GPIO/UART6-7/SPI1) |
| `scripts/can_mode.py <board>` | Deterministic "is this board SocketCAN or MCU-domain CAN?" lookup (X5/S100/S100P/S600/X3/Ultra) |
