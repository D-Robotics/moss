# RDK Peripheral Cookbook · Hardware & System Notes

> Sources: D-Robotics RDK official docs (rdk_doc / rdk_s_doc 40pin user guide, X5 hardware), the x5-hobot-io toolchain, and standard cross-platform Linux peripheral practice. Board-specific claims are verified against the cited source; cross-platform Linux facts (libgpiod, ALSA, PCA9685, WS2812-over-SPI) are industry-standard and marked as such.

## Table of contents

- [X5 board-side IO acceleration libraries](#x5-board-side-io-acceleration-libraries)
- [40PIN cross-platform pin & bus mapping](#40pin-cross-platform-pin--bus-mapping) — the first step before any peripheral wiring
- [libgpiod: the universal cross-platform GPIO API](#libgpiod-the-universal-cross-platform-gpio-api)
- [Servos: single servo to multi-channel PCA9685](#servos-single-servo-to-multi-channel-pca9685)
- [Motors: the three driving paradigms](#motors-the-three-driving-paradigms)
- [LEDs: single-color to WS2812 strip](#leds-single-color-to-ws2812-strip)
- [Audio: the ALSA fallback path](#audio-the-alsa-fallback-path)
- [Zero-driver diagnosis SOP](#zero-driver-diagnosis-sop)

---

## X5 board-side IO acceleration libraries

- **x5-hobot-io** — <https://github.com/D-Robotics/x5-hobot-io>. C bindings for X5 GPIO/I2C/SPI/PWM/UART, roughly 10× lower latency than Python `Hobot.GPIO`. Use for real-time control (motors, servos, sensor polling). Building needs the RDK X5 toolchain; cross-compile per the repo README.
- **x5-hobot-utils** — <https://github.com/D-Robotics/x5-hobot-utils>. X5 diagnostics / flashing helper tools.

---

## 40PIN cross-platform pin & bus mapping

> When the user asks "how do I wire X", confirm the **board model** first. The 40PIN physical positions are identical across vendors, but **power capacity, GPIO numbering, I2C bus number, and PWM path all differ.**

**Physical layout is identical across the four vendors** (copied from RPi 3B+): `Pin 1 = 3.3V`, `Pin 2/4 = 5V`, `Pin 6/9/14/20/25/30/34/39 = GND`. No physical difference — the difference is electrical and in numbering.

### Power capacity (essential before driving servos/strips)

| Platform | 40PIN 5V limit | Servo / strip power advice |
|----------|----------------|----------------------------|
| RPi 5 | ~600mA shared | **External 5V supply required**, common GND |
| Jetson Orin Nano | ~1A | One servo marginal; multiple → external |
| RK3588 (Orange Pi 5) | ~800mA | Same as Jetson |
| **RDK X5 / S100** | X5 marks 40PIN as 1A @ 3.3V / 1A @ 5V; on S100 verify against the expansion-board power budget | **Always external 5V/6V for servos/motors/strips, common GND** |

> "Take 5V from Pin 2 to drive one SG90" → acceptable. "Drive 4 servos / a WS2812 strip of 30+" → **warn: external supply required**, or the board browns out and reboots.

### GPIO numbering (same physical Pin 11, four different names)

| Platform | Scheme | Pin 11 name | User-space API |
|----------|--------|-------------|----------------|
| RPi | BCM | `GPIO17` | `RPi.GPIO` / `gpiozero` / **`libgpiod`** |
| Jetson Orin Nano | tegra-gpio | `PQ.05` (chip0 line 144) | `Jetson.GPIO` / **`libgpiod`** |
| RK3588 | `GPIOx_yZ` (bank_group_pin) | `GPIO3_C6` (= 3×32 + 2×8 + 6 = 118) | `OPi.GPIO` / **`libgpiod`** |
| **RDK X3** | Hobot custom | check the X3 pinout table | `Hobot.GPIO` / `libwiringpi` / **`libgpiod`** |
| **RDK X5** | Hobot custom | check the X5 pinout table | `Hobot.GPIO` / `x5-hobot-io` / **`libgpiod`** |

> The only API common to all four = **`libgpiod`** (next section). For cross-board scripts, prefer libgpiod and don't guess BCM numbers.

### I2C bus mapping (essential for sensors / PCA9685)

| Platform | 40PIN exposed I2C | Device node | How to enable |
|----------|-------------------|-------------|---------------|
| RPi | I2C1 (Pin 3/5) | `/dev/i2c-1` | `raspi-config` → Interface → I2C |
| Jetson Orin Nano | I2C1 (Pin 3/5), I2C8 (Pin 27/28) | `/dev/i2c-7` (Orin actual number) | on by default |
| RK3588 | I2C3/7/8 exposed | `/dev/i2c-3` etc. | overlay required |
| **RDK X3** | 2 lines on 40PIN (I2C0 Pin 3/5) | `/dev/i2c-0/1` | `srpi-config` to switch mux |
| **RDK X5** | 2 lines on 40PIN (I2C5 Pin 3/5 + I2C0 Pin 27/28) | `/dev/i2c-*` (system lists more) | same; the old "3 lines" was the SoC controller count |
| **RDK S100** | 2 lines on 40PIN (I2C5 Pin 3/5 + I2C4 Pin 27/28) | `/dev/i2c-0..5` | I2C5 muxes with UART2 via **dip switch**; "4 lines" is SoC-level |
| **RDK S600** | **no standard 40PIN** (self-locking, 1.8V) | — | digital IO on 10/12/14-pin self-locking connectors — see rdk-hardware |

> **RDK-specific traps:** ① a 40PIN pin may default to GPIO — on X-series switch the function with `sudo srpi-config` → `3 Interface Options` → `I3 Peripheral bus config` (or the `/app/40pin_samples/` scripts) before `/dev/i2c-X` / `pwmchip` appears. ② The RDK rows above are the **40PIN-exposed** count; the SoC has more buses (on MCU / camera expansion ports). Diagnose: `ls /dev/i2c-*` → bus missing → run srpi-config / script → recheck.
> S100 verified: 40PIN defaults to I2C5 (Pin 3/5) + I2C4 (Pin 27/28), 3.3V; `test_i2c.py` lists `/dev/i2c-0 .. /dev/i2c-5` (rdk_s_doc 40pin_user_guide/01_s100/05_i2c.md).

### PWM channels & `pwmchip` path (key for servos / motor speed)

| Platform | HW PWM channels | Control path | How to enable |
|----------|-----------------|--------------|---------------|
| RPi | 2 (PWM0 / PWM1) | `/sys/class/pwm/pwmchip0/pwm{0,1}/` | `dtoverlay=pwm-2chan` |
| Jetson Orin Nano | 3 | `/sys/class/pwm/pwmchip*/` | **must run `sudo /opt/nvidia/jetson-io/jetson-io.py`** to change pinmux |
| RK3588 | several (PWM14/15 common) | `/sys/class/pwm/pwmchipN/` | overlay required |
| **RDK X3** | 2 on 40PIN | `/sys/class/pwm/pwmchipN/pwmM/` | `srpi-config` mux |
| **RDK X5** | a few on 40PIN (SoC-level 8) | same | `srpi-config` mux |
| **RDK S100** | 2 LPWM on 40PIN (Pin 32/33, 48KHz~192MHz), `Hobot.GPIO` | — | "8 lines" is SoC-level; MCU-domain PWM is in firmware, not on 40PIN |

> **Conclusion for ≥3 servos:** all four vendors recommend PCA9685 + I2C — it saves board PWM, is portable across boards, and has mature Python libraries (see Servos).

### UART / serial mapping

| Platform | 40PIN UART | Node | Trap |
|----------|-----------|------|------|
| RPi | Pin 8/10 | `/dev/ttyS0` (mini UART) / `/dev/ttyAMA0` | `dtoverlay=disable-bt` to free the main UART |
| Jetson Orin Nano | Pin 8/10 | `/dev/ttyTHS1` | root holds it by default → `systemctl disable nvgetty` |
| RK3588 | Pin 8/10 | `/dev/ttyS0/3` | overlay required |
| **RDK X5** | 1 line on 40PIN (UART1 Pin 8/10, `/dev/ttyS1`) | `ttyS0` is the system debug port | "5 lines" is SoC-level; `ttyS` normal / `ttyHS` high-speed |
| **RDK S100** | 1 line on 40PIN (UART2 Pin 8/10, not enabled by default, muxed with I2C5 via dip switch) + a separate MCU-domain UART debug port | `/dev/ttyS2` | "6 lines" is SoC-level; don't confuse the Main vs MCU debug ports |

> **Universal fallback:** a USB-to-TTL adapter (`/dev/ttyUSB0`) works the same on every platform. Dynamixel / Feetech bus servos, GPS, LoRa modules almost all attach over USB — no need to fight over board UART.
> S100/S600 serial verified (rdk_s_doc 04_uart): test X5 → `/dev/ttyS1`, S100 → `/dev/ttyS2`, S600 → `/dev/ttyS6` or `/dev/ttyS7`. `/dev/ttyS0` is the system debug port — don't test it.

### SPI / CAN / Audio / CSI essentials

| Capability | Note |
|------------|------|
| SPI | RDK X3 has 1 line / X5 has 2; node `/dev/spidev0.0`; **WS2812 strips ride SPI MOSI to emulate the timing** (see LEDs) |
| **CAN** | RPi has none on-board (needs an MCP2515 HAT); **X5 = standard Linux SocketCAN** (integrated TCAN4550, `ip link set can0 ... fd on` + `cansend`/`candump`, classic CAN 1M / CAN FD data phase 2M); **S100 / S600 CAN is in the MCU domain** — not SocketCAN — via CANHAL/IPC + the `/app/Can` sample (see [rdk-can-and-board-io.md](rdk-can-and-board-io.md)); X3/Ultra have no on-board CAN |
| Audio | **Jetson has no on-board audio** (the classic Jetson gotcha); RPi 4 has a 3.5mm jack, RPi 5 dropped it; most RDK models reach audio over 40PIN I2S to a HAT or via a USB sound card (see Audio) |
| CSI camera | RPi / Jetson use a 22-pin ribbon; RDK X5 is 4-lane, X3 only 2-lane; **S100 has GMSL2 automotive cameras** via an expansion board |

> Full hands-on for **CAN / S100 dip switch / S600 self-locking IO** (X5 SocketCAN arbitration+data phase `ip link`, S100/S600 MCU-domain CAN channel mapping and CANHAL, S100 I2C5↔UART2 dip mux, S600 1.8V self-locking GPIO/UART6-7/SPI1) is in [rdk-can-and-board-io.md](rdk-can-and-board-io.md).

---

## libgpiod: the universal cross-platform GPIO API

> All four boards (RPi / Jetson / Rockchip / RDK) support `libgpiod`, the Linux 4.8+ recommended user-space GPIO API that replaces the deprecated `/sys/class/gpio`. For cross-board scripts or when unsure of the numbering, prefer this.

**Install** (same on every platform):
```bash
sudo apt install gpiod python3-libgpiod   # CLI tools + Python bindings
```

**Four core commands:**
```bash
gpiodetect                    # list every gpiochip (gpiochip0, gpiochip1, ...)
gpioinfo gpiochip0            # each line's name (named lines can be addressed directly)
gpioset gpiochip0 17=1        # drive line 17 high
gpioget gpiochip0 17          # read level
```

**Operate by name** (most portable):
```bash
gpiofind "GPIO17"                          # resolve which chip & line
gpioset $(gpiofind "GPIO17")=1             # drive high in one line
```

**Minimal Python** (runs on RPi / Jetson / RK / RDK):
```python
import gpiod, time
chip = gpiod.Chip('gpiochip0')
line = chip.get_line(17)
line.request(consumer='blink', type=gpiod.LINE_REQ_DIR_OUT)
for _ in range(10):
    line.set_value(1); time.sleep(0.5)
    line.set_value(0); time.sleep(0.5)
line.release()
```

**libgpiod vs other APIs:**

| Scenario | Recommended |
|----------|-------------|
| Compatibility with existing RPi tutorial code | `Hobot.GPIO` (RDK) / `Jetson.GPIO` (Jetson) — both copy `RPi.GPIO` |
| One script across multiple platforms | **`libgpiod`** |
| Real-time / low jitter (<1ms) | C calling `libgpiod` or `x5-hobot-io` (X5-only) |
| Simple blink / button read | `gpioset` / `gpioget` one-liners |

> For "GPIO not working" problems: `gpiodetect` → `gpioinfo <chip>`, then address by **name** — don't make the user dig through a BCM table. `import Hobot.GPIO` works on **system Python only** (fails inside conda/venv).

---

## Servos: single servo to multi-channel PCA9685

### Single servo (1–2 ch) — on-board hardware PWM

Servo signal = **50Hz (20ms period) + a 1.0ms (0°) to 2.0ms (180°) positive pulse** (SG90 etc.). Cross-platform sysfs control (after switching the pin to PWM mode, giving `/sys/class/pwm/pwmchipN/`):

```bash
cd /sys/class/pwm/pwmchip0              # N differs by board — confirm with ls
echo 0 > export
echo 20000000 > pwm0/period             # 20ms = 50Hz
echo 1500000  > pwm0/duty_cycle         # 1.5ms = 90° (center)
echo 1        > pwm0/enable
```

Angle → duty_cycle (ns):
```
duty_cycle = 1_000_000 + (angle / 180) * 1_000_000   # 1ms to 2ms
```

> **Safety rule:** never power a servo from 40PIN Pin 2/4, even one SG90 — instantaneous stall current can reach ~1A and brown out the board. Always external 5V/6V, signal line and board sharing GND.

### Multiple servos (≥3 ch) — PCA9685 + I2C (the de-facto standard)

| Parameter | Value |
|-----------|-------|
| Hardware | PCA9685 16-channel PWM expander (common low-cost module, usually with a 5V LDO) |
| Wiring | I2C SDA/SCL/VCC/GND + a separate V+ supply for the servos |
| Default I2C address | **`0x40`** (A0–A5 jumpers change it; up to 62 boards chained) |
| Frequency | `set_pwm_freq(50)` for standard servos; 1000 for LED dimming |
| Resolution | 12-bit (0–4095) |

```bash
sudo apt install python3-smbus2
pip3 install adafruit-circuitpython-servokit   # or raw Adafruit_PCA9685
```

```python
import board, busio
from adafruit_pca9685 import PCA9685
from adafruit_motor import servo

i2c = busio.I2C(board.SCL, board.SDA)          # default i2c-1; on RDK X5 use the actual bus number
pca = PCA9685(i2c); pca.frequency = 50
ch0 = servo.Servo(pca.channels[0], min_pulse=500, max_pulse=2500)
ch0.angle = 90
```

**PCA9685 troubleshooting (3 steps):**
1. `i2cdetect -y <bus>` → confirm `0x40` appears; missing = wiring / I2C bus not enabled.
2. Heavy servo jitter = insufficient supply (PCA9685's V+ carries the load; **servo power must go to the V+ screw terminal, not the 40PIN rail**).
3. Stutter when multiple servos move = external supply too weak; raise to 5V/5A or use an RC BEC.

**Bus servos** (Dynamixel / Feetech STS / LX-16A): TTL serial or RS-485 (`/dev/ttyUSB0` via USB-TTL is most reliable), `dynamixel-sdk` / `feetech-servo-sdk`. One wire chains dozens of ID-addressed servos that report angle/current/temperature. Use these for legged robots / arms; PWM servos like SG90 are toy-grade.

---

## Motors: the three driving paradigms

Ask **which motor + which driver** first, then go to the board level.

**Paradigm 1: DC motor = H-bridge + PWM speed + GPIO direction**

| Driver | For | Wiring summary |
|--------|-----|----------------|
| **TB6612FNG** | 2-wheel car, ~1.2A/ch | PWMA/PWMB for PWM, AIN1/AIN2/BIN1/BIN2 for direction (4 GPIO), STBY high |
| **DRV8833** | smaller current (~1.5A peak) | similar to TB6612 |
| **BTS7960** | high current (43A) | R_EN/L_EN + RPWM/LPWM |

```python
# one wheel: GPIO17/18 set direction + pwmchip0/pwm0 set speed
gpio.set(17, 1); gpio.set(18, 0)    # forward
set_pwm_duty("pwmchip0/pwm0", 50)   # 50% duty
```

**Paradigm 2: stepper = dedicated driver + STEP/DIR (no PWM needed)**

| Driver | Trait |
|--------|-------|
| A4988 | cheapest, 1.5A, noisy |
| DRV8825 | 2.2A, 32 microsteps |
| **TMC2209** | silent (important), UART-configurable, mainstream for 3D printers |

```python
for _ in range(200):                  # 200 steps = one revolution (1.8°/step)
    gpio.set(STEP, 1); time.sleep(0.001)
    gpio.set(STEP, 0); time.sleep(0.001)
```

**Paradigm 3: BLDC = ESC or smart driver**

| Approach | Note |
|----------|------|
| RC ESC | 50Hz PWM like a servo (1.0ms stop to 2.0ms full); can reuse PCA9685 |
| **ODrive / VESC** | encoder closed-loop, commanded over UART/USB/CAN; `odrive` / `pyvesc` Python libs |
| D-Robotics S100 path | MCU (R52+) drives directly over IPC; kHz-class loop, steadier than a Linux RT thread |

> For "robot joint motor" questions: toy/teaching → DC + TB6612 or PWM servo; desktop arm / quadruped → **bus servos (Feetech STS3215 / Dynamixel XL)**; biped / industrial joint → BLDC + ODrive/VESC or a vendor integrated joint module. This is dictated by **motor class**, not anything RDK-specific.

---

## LEDs: single-color to WS2812 strip

| Type | Wiring | Control |
|------|--------|---------|
| Single-color LED | 330Ω resistor + GPIO | GPIO level via `gpioset`; PWM dimming same as servos |
| **WS2812 / WS2815 RGB strip** | 5V + GND + DIN | **strict 800kHz timing**, GPIO bitbang is unreliable → use SPI MOSI emulation |
| I2C LED matrix (HT16K33 / MAX7219) | I2C 4 wires | `luma.led_matrix` cross-platform Python |

**WS2812 cross-platform method — SPI emulation** (RPi / Jetson / RK / RDK all use this):

Encode 1 WS2812 bit with 4 SPI bits:
- WS2812 "1" = ~0.8µs high + ~0.45µs low → SPI outputs `1110`
- WS2812 "0" = ~0.4µs high + ~0.85µs low → SPI outputs `1000`
- SPI rate = **2.4 MHz** (= 800kHz × 3; 3.2MHz also works in practice)

```bash
pip3 install Adafruit-CircuitPython-NeoPixel-SPI
```

```python
import board, neopixel_spi
pixels = neopixel_spi.NeoPixel_SPI(board.SPI(), 30, pixel_order=neopixel_spi.GRB)
pixels[0] = (255, 0, 0)    # pixel 0 red
pixels.show()
```

> **Power trap:** 30 WS2812 at full white ≈ 1.8A — **never from 40PIN Pin 2/4**; external 5V + common GND. The DIN data line off the 40PIN MOSI pin is fine (tiny signal current).
> RPi's native `rpi_ws281x` needs root + the PWM0 pin (physical Pin 12 / GPIO18) and **only works on RPi** — on RDK / Jetson / RK use SPI emulation.

---

## Audio: the ALSA fallback path

> RDK's `hobot_audio` is only available with TROS installed and the official mic-array board attached. **When those aren't present**, use the standard Linux ALSA path — identical on RPi / Jetson / RK / RDK.

**Is the audio hardware there — 3-step probe:**
```bash
aplay -l       # output devices: card X, device Y
arecord -l     # input devices
lsusb          # USB sound card / mic present?
dmesg | grep -i "audio\|sound\|snd"
alsamixer      # raise volume, press M to unmute (MM in red = muted)
```

**Play WAV / MP3:**
```bash
aplay test.wav
aplay -D plughw:1,0 test.wav                # card 1 device 0
aplay -D plughw:CARD=UAC1,DEV=0 test.wav    # by USB card name
sudo apt install mpg123 sox
mpg123 song.mp3
sox song.mp3 -d                             # auto-play any format
```

**Record:**
```bash
arecord -D plughw:1,0 -f S16_LE -r 16000 -c 1 -d 5 test.wav   # 5s 16kHz mono
arecord -vv -f S16_LE -r 16000 -c 1 /dev/null                # live level meter
```

**PulseAudio / PipeWire:**
```bash
pactl list short sinks
pactl list short sources
paplay test.wav
parecord -d 5 test.wav
```

> **USB sound card = universal fallback:** on any board, plug in a USB sound card (with 3.5mm) or USB mic; the kernel auto-loads `snd-usb-audio` and `aplay -l` shows it immediately. On Jetson (no on-board audio) this is the only recommended path; on RDK without an I2S HAT, also use this.

**Common errors → diagnosis:**

| Error / symptom | Diagnosis |
|-----------------|-----------|
| `aplay -l` → "no soundcards found" | hardware not detected — check USB card / I2S overlay |
| `ALSA lib pcm.c ... unable to open slave` | device busy — `sudo fuser /dev/snd/*`, or `systemctl stop pulseaudio` to release |
| Sound plays but very faint / distorted | `alsamixer` raise volume; or `amixer sset Master 80%` |
| Mic recording is all noise | `arecord -l` to select the right device; a USB mic is steadier than board-noise input |
| `aplay: Dac failed: Device or resource busy` | another process (PulseAudio / TROS) holds it → `pactl suspend-sink 0` or use the PulseAudio API |

---

## Zero-driver diagnosis SOP

> When the user says "I plugged in X, don't know how to use it / board doesn't recognize it / no driver" — don't guess, walk the 9 steps. 100% portable across RDK / RPi / Jetson / RK, no vendor tools needed.

```
Step 1. dmesg | tail -50              what the kernel just recognized (watch on plug/unplug)
Step 2. lsusb                          USB enumeration (sound card / mic / camera / USB-TTL)
Step 3. ls /dev/                       device nodes:
        /dev/tty*       serial (ttyUSB0 / ttyACM0 / ttyS* / ttyHS*)
        /dev/video*     V4L2 cameras
        /dev/i2c-*      I2C buses
        /dev/spidev*    SPI
        /dev/snd/       audio (card0 / pcmC0D0p)
        /dev/input/     input (buttons / gamepads)
Step 4. i2cdetect -l  then  i2cdetect -y <bus>     list buses, scan addresses
Step 5. v4l2-ctl --list-devices        cameras
Step 6. aplay -l / arecord -l          audio
Step 7. lsmod | grep <keyword>         is the kernel module loaded
Step 8. modinfo <mod> / modprobe <mod> module info / manual load
Step 9. cat /proc/device-tree/…        device-tree nodes (RPi/RK/RDK all have these)
```

**Symptom → diagnosis:**

| Symptom | Check first | Common cause |
|---------|-------------|--------------|
| Device plugged in, board doesn't recognize | Step 1 (dmesg) + Step 2 (lsusb) | insufficient power / bad USB port / USB 3.0 compatibility |
| "No such device" on `/dev/i2c-X` | Step 3 + Step 4 | I2C bus not enabled / pinmux not switched (RDK-specific) |
| `permission denied: /dev/ttyUSB0` | `ls -l /dev/ttyUSB0` | user not in `dialout` → `sudo usermod -aG dialout $USER` |
| `ALSA lib ... unable to open slave` | Step 6 + `fuser` | device held by another process |
| PWM no response | `ls /sys/class/pwm/` | pinmux not switched / out of PWM channels |
| `import Hobot.GPIO` fails | `which python3` | running conda/venv — `Hobot.GPIO` is system-Python only |

**Three orthogonal fix paths (low → high risk):**
1. **User-space packages (safest):** `apt install` / `pip install` / `git clone + colcon build`.
2. **Temporary kernel module (medium):** `modprobe <mod>` / `insmod ./xxx.ko` / `rmmod <mod>` for the current session only, then check `dmesg`.
3. **Persistent kernel/boot chain (highest, destructive):** `/etc/modules-load.d/*.conf`, `/boot` device tree, `/lib/modules`, initramfs / miniboot / bootloader / MCU firmware — **on RDK, don't advise users to touch these unless absolutely necessary**; reserve for official flows and manual recovery.

**Answer template (peripheral issues):**
1. Ask for **board model + interface (USB / 40PIN I2C / 40PIN UART / MIPI) + device model**.
2. Have the user run Steps 1–3 and paste back.
3. Walk the symptom→diagnosis table to one specific cause.
4. Give the **smallest verifiable command** (`i2cdetect -y 1` shows 0x40 / `aplay -l` shows card 1 / `gpioinfo gpiochip0`).
5. Only after that, discuss "wrap as a ROS2 node / Python script / autostart".
