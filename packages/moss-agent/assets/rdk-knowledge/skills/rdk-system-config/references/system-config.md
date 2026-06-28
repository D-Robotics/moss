# RDK System Configuration — Full Reference

> Source: `D-Robotics/rdk_x_doc` and `D-Robotics/rdk_s_doc`, directory `docs/02_System_configuration`. X-series = rdk_x_doc (X3 / X5 / Ultra), S-series = rdk_s_doc (S100 / S100P / S600). Only documented facts are kept; per-board applicability follows the docs' DocScope / info boxes. Every value below was re-verified file-by-file against the official docs.

## Table of contents

- [1. Network and Bluetooth (2.1)](#1-network-and-bluetooth-21)
- [2. srpi-config TUI (2.2)](#2-srpi-config-tui-22)
- [3. config.txt (2.3) — two different mechanisms](#3-configtxt-23--two-different-mechanisms)
- [4. Thermal and CPU frequency (2.4)](#4-thermal-and-cpu-frequency-24)
- [5. Boot self-start (2.5) — identical X / S](#5-boot-self-start-25--identical-x--s)
- [6. GUI network config (2.6) — S-series only](#6-gui-network-config-26--s-series-only)
- [7. File sharing (2.7) — S-series only](#7-file-sharing-27--s-series-only)

---

## 1. Network and Bluetooth (2.1)

### 1.1 Wired network — X-series

Default static IP `192.168.127.10`. Two methods split by system version.

**New (RDK X5 ≥ 3.3.0 / RDK X3 ≥ 3.0.2, NetworkManager)** — file `/etc/NetworkManager/system-connections/netplan-eth0.nmconnection`:
- Static: `[ipv4]` block `address1=192.168.127.10/24,192.168.127.1`, `method=manual`, `route-metric=700` (wired priority deliberately lowered so that when wired + Wi-Fi are both up, Wi-Fi is preferred).
- DHCP: `[ipv4]` keeps only `method=auto` + `route-metric=700`.
- Change MAC: add `cloned-mac-address=12:34:56:78:9A:BA` to `[ethernet]`; requires `reboot`.
- Apply static/DHCP with `sudo restart_network` (MAC change needs `reboot`). Desktop: edit via the network-icon GUI, then click `netplan-eth0` to apply.

**Old (X5 < 3.3.0 / X3 < 3.0.2)** — file `/etc/network/interfaces`:
- Static: `iface eth0 inet static` + `address`/`netmask`/`gateway`/`metric 700`, includes `pre-up /etc/set_mac_address.sh`.
- DHCP: `iface eth0 inet dhcp` + `metric 700`.
- Change MAC: add `pre-up ifconfig eth0 hw ether 00:11:22:9f:51:27`; `reboot` to apply.
- Apply with `sudo restart_network` (MAC change needs `reboot`).

### 1.2 Wired network — S-series

Default framework `NetworkManager + Netplan`. S100 is Ubuntu 22.04, S600 is Ubuntu 24.04; **neither supports `ifup`/`ifdown`**. Use nmcli (the doc's example connection is `eth1_cfg` with `192.168.10.100/24` — substitute the real connection name from `nmcli connection show`):

```shell
# Static (eth1 example)
nmcli connection modify "eth1_cfg" \
  ipv4.method manual \
  ipv4.addresses "192.168.10.100/24" \
  ipv4.gateway "192.168.10.1" \
  ipv4.dns "223.5.5.5 8.8.8.8" \
  ipv4.never-default yes \
  connection.autoconnect yes
nmcli connection down "eth1_cfg"; nmcli connection up "eth1_cfg"

# DHCP: ipv4.method auto, and clear addresses/gateway/dns
# Inspect: nmcli device show eth1
```

Saved config lands in `/etc/NetworkManager/system-connections/`. After editing a `.nmconnection` file directly, apply with `sudo nmcli connection reload` + `sudo nmcli connection up [name]`.

> The S100/S600 **eth1 management port** is factory-fixed at `192.168.127.10` (canonical board fact). Do not reconfigure the port you are SSH'd in through without a fallback.

### 1.3 Wireless network (Station flow, both families)

- Boards integrate / require a 2.4 GHz Wi-Fi module; default Station mode.
- **Desktop:** click the top-right Wi-Fi icon, pick the SSID, enter the password.
- **Server:**
  1. `sudo nmcli device wifi rescan` (`Error: Scanning not allowed immediately following previous scan.` = too frequent, retry later)
  2. `sudo nmcli device wifi list`
  3. `sudo wifi_connect "SSID" "PASSWD"` (`Error: No network with SSID '…' found.` = rescan and retry)

### 1.4 Soft AP mode

- **S-series:** doc explicitly states `Wi-Fi AP mode not yet available` (work in progress). Do not provide a hostapd recipe.
- **X-series (classic hostapd):** `apt install hostapd isc-dhcp-server` → configure `/etc/hostapd.conf` (`interface=wlan0`, `ssid`, `wpa=2`, `wpa_key_mgmt=WPA-PSK`, `wpa_pairwise=CCMP`, `wpa_passphrase`; **X5 can host 5G**: `channel=36`, `hw_mode=a`) → configure `/etc/default/isc-dhcp-server` (`INTERFACESv4="wlan0"`) and `/etc/dhcp/dhcpd.conf` (uncomment `authoritative;` + add a `subnet` block) → `systemctl mask/stop wpa_supplicant`, restart `wlan0` → `sudo hostapd -B /etc/hostapd.conf` → `ifconfig wlan0 10.5.5.1 netmask 255.255.255.0` → `systemctl start/enable isc-dhcp-server`. Back to Station: `killall -9 hostapd`, flush wlan0, `systemctl unmask/restart wpa_supplicant` (**RDK X5 also needs** `rmmod aic8800_fdrv; modprobe aic8800_fdrv`), then `wifi_connect`.
- **X-series (NetworkManager, X5 ≥ 3.3.0 / X3 ≥ 3.0.2):** wireless icon → `Edit Connections…` → `+` → Connection Type `Wi-Fi` → set SSID / Mode=`Hotspot` / Band (`Automatic` / `A (5 GHz)` / `B/G (2.4 GHz)`) → `Wi-Fi Security` tab set encryption + password → reboot or `restart_network`.

### 1.5 DNS (both families)

Add `DNS=8.8.8.8 114.114.114.114` to `/etc/systemd/resolved.conf`, then:

```bash
sudo systemctl restart systemd-resolved
sudo systemctl enable systemd-resolved
sudo mv /etc/resolv.conf /etc/resolv.conf.bak
sudo ln -s /run/systemd/resolve/resolv.conf /etc/
```

### 1.6 Proxy (S-series doc)

Current user → edit `~/.bashrc`; all users → edit `/etc/environment`. Add `http_proxy/https_proxy/ftp_proxy=http://addr:port` and `no_proxy=localhost,127.0.0.1`, then `source ~/.bashrc`.

### 1.7 System update (both families)

`sudo apt update` → `sudo apt full-upgrade` (`full-upgrade` is recommended so dependencies update together; `apt` does not check free disk, run `df -h` first; cached debs live in `/var/cache/apt/archives`, clear with `sudo apt clean`). Upgrades may reinstall drivers/kernel → `sudo reboot`. The S-series doc adds a warning: **do not run before the product is launched.**

### 1.8 Bluetooth

- Since system 3.0.0, Bluetooth starts with the system by default (consistent on X3/X5). If `hciconfig` shows no device, **X-series** runs `/usr/bin/startbt.sh` (init + `hciconfig hci0 up` + `hciconfig hci0 piscan`).
- Check the process: `ps ax | grep "/usr/bin/dbus-daemon\|/usr/lib/bluetooth/bluetoothd"`. The **S-series** doc additionally gives `bluetoothctl list` to view the controller.
- Pairing: `sudo bluetoothctl` → `show` (check `powered`/`discoverable`) → `power on` → `discoverable on` → `scan on`/`scan off` → `pair [MAC]` (confirm `yes`) → `trust [MAC]` for auto-reconnect. See BlueZ docs for more.
- The X-series doc also describes Bluetooth communication interfaces (UART-only two-wire `BT_RX`/`BT_TX` with no flow control; adding `BT_CTS`/`BT_RTS` hardware flow control enables A2DP; PCM sync interface for voice) and USB Bluetooth (`USB2.0-BT` / `CSR8510 A10` drivers integrated; Realtek modules need extra firmware).

---

## 2. srpi-config TUI (2.2)

Open: `sudo srpi-config` (the default `sunrise` user cannot edit system files, so `sudo` is required); on desktop find `RDK Configuration` in the menu. After changes select `Finish`; items needing a reboot prompt for one.

**Applicability:** the X doc states "only applies to RDK X3, RDK X5 and RDK X3 Module" (**not Ultra**); the S doc's srpi-config screenshots and text are all S100.

### 2.1 X-series menus

| Menu | Items |
|---|---|
| System Options | Wireless LAN (SSID/password), Password (default user `sunrise`), Hostname, Boot / Auto login (console vs desktop; autologin uses `sunrise`), Power LED, Browser (default `firefox`; `sudo apt install chromium` for Chromium) |
| Display Options | FB Console Resolution (HDMI resolution under Server/console), Display Chose DSI or HDMI (**only RDK X5 supports switching displays**) |
| Interface Options | SSH (on by default), VNC (X11vnc), Peripheral bus config (toggle 40-pin SPI/I2C/Serial/I2S; X5 adds PWM; directly edits the device-tree `status`, effective after reboot — X5 pin mux below), Configure Wi-Fi antenna (onboard `trace` / external `cable`; check via `cat /boot/config.txt` → `antenna_option`), Audio (install/remove Audio Driver HAT V1/V2, WM8960, etc.) |
| Performance Options | CPU frequency (overclock; needs cooling; X5 → see frequency management), ION memory (default 672 MB; raise for large models / multi-stream codec) |
| Localisation Options | Locale (e.g. `zh_CN.UTF-8`, reboot to apply), Time Zone, Keyboard |
| Advanced Options | Expand Filesystem (grow to the whole TF card), Network Proxy Settings, Boot Order (X3 Module / X5 Module switch eMMC ⇄ SD) |
| Sensor Profiles | Multiple Sensor effect libraries; IMX219 Switch ISP (`1 FOV 79.3°` = Jetson Nano camera, fits 200/160 FOV modules; `2 FOV 120°` = Raspberry Pi 5 camera, fits 120 FOV module) |
| Update / About / Finish | Update the tool / info / finish |

X5 Peripheral-bus pin multiplexing (one row shares pins → only one function active; all disabled → GPIO): `serial3 ↔ i2c5`, `i2c0 ↔ pwm2`, `spi2 ↔ pwm0`, `spi2 ↔ pwm1`, `i2c1 ↔ pwm3`.

> Wi-Fi antenna switching is documented as supported on RDK X3 (V2.1), RDK X5 (V0.1 / V1.0), and RDK X5 MD (< V1.1).

### 2.2 S100 menus (differences from X)

- **System Options:** besides Wireless LAN / Password / Hostname / Boot-Auto login / Power LED / Browser, adds **Update Miniboot** (upgrade the Miniboot partition).
- **Interface Options:** **SSH only**; VNC is "being adapted"; peripheral config is steered to config.txt.
- **Performance Options:** **ION memory only** (no overclock, no CPU lock item).
- Localisation / Advanced (Expand Filesystem defaults to eMMC, Network Proxy) / Update / About / Finish — same as X.
- **No Display Options menu, no Sensor Profiles menu.**

---

## 3. config.txt (2.3) — two different mechanisms

### 3.1 X-series (`/boot/config.txt`, read in the uboot stage)

Applies to X3 / X5 / X3 Module; system ≥ 2.1.0, miniboot ≥ 20231126; edit as root; create the file if missing. Note: a `[filter]` here can mask an srpi-config setting.

- **Device tree:** `dtdebug=1` (serial config log; must come before `dtoverlay`); `dtoverlay=…` (X3 `ion_resize,size=0x40000000` sets ION to 1 GB; X5 `dtoverlay_spi5_spidev` adds `/dev/spidev5.0` — note CAN and spidev both sit on spi5, pick one).
- **X5 ION:** `ion=ion_reserved_size=…` / `ion_carveout_size` / `ion_cma_size` (defaults 320M / 320M / 128M); check with `dmesg | grep "Reserved ion"`.
- **dtparam bus toggles:** `dtparam=uart3=off`, `dtparam=i2c5=on`. X3 supports uart3, spi0/1/2, i2c0–5, i2s0/1; X5 supports uart1/2/3/6, spi1/2, i2c0/1/4/5, dw_i2s1 (mind the pin mux: `uart3↔i2c5`, `i2c0↔pwm2`, `spi2↔pwm0`, `spi2↔pwm1`, `i2c1↔pwm3`).
- **CPU frequency:** `arm_boost=1` (X3 v1.x → 1.5 GHz; X3 V2.0/Module → 1.8 GHz; X5 → 1.8 GHz); `governor=performance` (or conservative/ondemand/userspace/powersave/schedutil); `governor=userspace` + `frequency=1000000` (X3 freqs 240000–1800000; X5 freqs 300000/600000/1200000/1500000).
- **GPIO init:** `gpio=5=f3` (mux f0–f3), `ip`/`op`, `dh`/`dl`, `pu`/`pd`/`pn`; BOARD numbering; ranges `gpio=5-6=f3`.
- **Thermal:** `throttling_temp=86000` (throttle point; CPU floors at 240 MHz, BPU at 400 MHz), `shutdown_temp=112000` (hard shutdown; no auto-restart after).
- **Option filters:** at the file tail use `[all]/[rdkv1]/[rdkv1.2]/[rdkv2]/[rdkmd]/[x5-rdk]` — everything after a filter belongs only to that model.
- **Voltage domain (RDK Module only):** `voltage_domain=3.3V` (or 1.8V; needs the hardware jumper).

### 3.2 S-series (`/boot/config.txt`, D-Robotics Uboot)

Priority `setenv > config file > last saveenv`; format `<key>=<value>` (everything after the first `=` is the value); single line ≤ 1024 chars; unusable when AVB is enabled (AVB off by default).

- `bootargs=isolcpus=1-2` (kernel cmdline); `loglevel=8` (print level).
- `fdt-enable=/soc/uart@394C0000;` / `fdt-disable=…;` (enable/disable dts nodes; the trailing `;` is **mandatory**; get the full node path from `/proc/device-tree` and prepend `/`).
- DTB overlay: `apt install device-tree-compiler` → `dtc -I dts -O dtb -o x.dtbo x.dtso` → copy to `/boot` → `dtbo_file_path=/x.dtbo` (path relative to `/boot`); custom partition `dtbo_dev_part=0:0x10` (partition number from `ls -l /dev/block/platform/by-name/<name>`).
- Custom config file: in Uboot `setenv boot_config_f test.txt` / `boot_config_dev_part 0:0xd` / `boot_config_intf scsi` then `saveenv`. Parser code: Uboot `board/hobot/common/drobot_boot_config.c`.
- **No X-style `dtparam`/`gpio`/`arm_boost`/filter syntax on S-series.**

---

## 4. Thermal and CPU frequency (2.4)

Check state with `sudo hrut_somstatus` on every board. **All `trip_point` settings reset on reboot** — re-apply (e.g. from boot self-start).

### 4.1 X3

- `thermal_zone0` three points: `trip_point_0_temp` (startup, default 80 °C), `trip_point_1_temp` (throttle, default 95 °C → CPU ↓240 MHz / BPU ↓400 MHz), `trip_point_2_temp` (shutdown, default 105 °C, must not exceed 105). `echo 85000 > .../thermal_zone0/trip_point_1_temp`.
- Frequency: `/sys/devices/system/cpu/cpufreq/policy0/scaling_governor` (performance/powersave/ondemand/conservative/userspace/schedutil); under userspace `echo 1000000 > .../scaling_setspeed`.
- Overclock: default `ondemand`; `echo 1 > /sys/devices/system/cpu/cpufreq/boost` (1.2 → 1.5 GHz), `echo 0` to disable.

### 4.2 X5

- Three sensors in `hwmon0`: `temp1`=DDR, `temp2`=BPU (readable only when the BPU subsystem is powered, i.e. running), `temp3`=CPU (0.001 °C precision).
- Two thermal zones: `zone0` covers DDR (1 trip_point, default 95 °C); `zone1` covers CPU/BPU/GPU (`trip_point_1`=throttle 95 °C, `trip_point_2`=shutdown 105 °C; `trip_point_0` reserved). Four cooling devices: cpu/bpu/gpu/ddr. Policy defaults to `step_wise`, switchable to `user_space`.
- Frequency: `echo performance > /sys/devices/system/cpu/cpu0/cpufreq/scaling_governor`; under userspace write `policy0/scaling_setspeed`; freqs 300000/600000/1200000/1500000.
- Overclock: default `schedutil`; `echo 1 > .../cpufreq/boost` + performance (1.5 → 1.8 GHz). **X5H only — X5M cannot overclock** (`cat /sys/class/socinfo/soc_name` → X5M/X5H; X5U = early part with eFUSE not burned, theoretically overclockable but unsupported/unstable, not for mass production).

### 4.3 S100

- 5 temperature sensors (`hwmon0`): `temp1/2`=MAIN domain, `temp3/4`=MCU domain, `temp5`=BPU (0.001 °C). 5 thermal zones (`zone0`–`zone4` bound to the 5 sensors).
- `thermal_zone0` four trip_points: `0`=shutdown 120 °C, `1`=fan 43 °C (levels 2–5), `2`=fan 65 °C (levels 6–10), `3`=CPU Acore throttle 95 °C. `thermal_zone4` two trip_points: `0`=shutdown 120 °C, `1`=BPU throttle 95 °C. `zone1/2/3` each have 1 = shutdown 120 °C.
- 4 cooling devices: `0`=cpu cluster0, `1`=cpu cluster1, `2`=emc2305 fan (levels 0–10), `3`=bpu. CPU/fan bound to `zone0`, BPU to `zone4`.
- Fix fan speed: first `echo user_space > .../thermal_zone0/policy`, then `echo 10 > /sys/class/thermal/cooling_device2/cur_state` (under `step_wise` the system auto-adjusts by temperature).
- CPU frequency: `echo performance > /sys/devices/system/cpu/cpu0/cpufreq/scaling_governor`; under userspace write `policy0/scaling_setspeed`; freqs 1500000 / 2000000 (per chip).

### 4.4 S600

- 19 temperature sensors (`hwmon1`, range −40 to 125 °C): CPU 7 (CMN0-TS0..6), DDR 4 (DDR0..3-TS0), BPU 8 (BPU0..3-TS0[0..1]); 19 thermal zones (`zone0`–`zone18`).
- CPU zones (0–6): `zone2` has 5 trip_points (`0`=fan 45 °C, `1`=fan 65 °C, `2`=CPU Acore throttle 95 °C, `3`=hot 110 °C, `4`=shutdown 115 °C); others have 1 = shutdown 115 °C. DDR zones (7–10): 2 trip_points (hot 110 °C, shutdown 115 °C). BPU zones (11–18): `zone16` has 5 trip_points (`0/1`=fan, `2`=BPU throttle 95 °C, `3`=hot 110, `4`=shutdown 115); others = shutdown 115 °C.
- 11 cooling devices: `0`–`4`=cpu cluster0–4, `5/6`=two emc2305 fans (levels 0–10), `7`–`10`=bpu core0–3.
- Fix fan speed: `echo user_space > .../thermal_zone2/policy` and `.../thermal_zone16/policy`, then `echo 10 > /sys/class/thermal/cooling_device5/cur_state`.
- CPU frequency: same path as S100; freqs 525000 / 1050000 / 2100000 (per chip).

---

## 5. Boot self-start (2.5) — identical X / S

**Method 1 — init.d service:**
1. Write `/etc/init.d/your_script_name` (with `### BEGIN/END INIT INFO` header, `Default-Start: 2 3 4 5`, `Default-Stop: 0 1 6`; body `/path/to/program &` + `exit 0`).
2. `sudo chmod +x /etc/init.d/your_script_name`
3. `sudo update-rc.d your_script_name defaults`
4. `sudo systemctl enable your_script_name`
5. Reboot, verify `systemctl status your_script_name.service` (`active (exited)` = OK).

**Method 2 — rc.local** (a legacy service under systemd): insert the start command before `exit 0` in `/etc/rc.local`.

---

## 6. GUI network config (2.6) — S-series only

Desktop settings → Network for static IP / DNS / Proxy:
- Pick the matching `Ethernet (ethN)` (**S100**: eth0/eth1; **S600**: eth0/eth1/eth3/eth4, each a distinct physical port) → gear → IPV4 → `Manual` → enter IP/mask/gateway → scroll down for DNS.
- One NIC, multiple IPs: click `+` and add another. After configuring on S100, selecting `eth1_cfg` shows a `√` (the UI differs if `/etc/netplan/` has no network entries); on S600 selecting `netplan-eth1` shows a `√`.
- Proxy: settings → Network → Network Proxy (S100) / Proxy (S600) gear → fill in the config.

---

## 7. File sharing (2.7) — S-series only

### Samba

```bash
sudo apt install samba
mkdir ~/shared
# Append a [shared] block to /etc/samba/smb.conf:
#   path=/home/<user>/shared, read only=no, browsable=yes,
#   guest ok=no, create mask=0775, directory mask=0775
sudo smbpasswd -a sunrise        # use a system user as the Samba user, set a password
sudo systemctl restart smbd      # check with: systemctl status smbd
sudo ufw allow samba             # only if ufw is enabled (optional)
```

### NFS (Ubuntu 22.04/24.04 as the client)

Prerequisite: an NFS server already exists.

```bash
sudo apt install nfs-common
sudo mkdir -p /userdata/windows_nfs_share
sudo mount -v -t nfs -o vers=3,proto=tcp 192.168.127.11:/D/NFSShare /userdata/windows_nfs_share
mount | grep windows_nfs_share   # verify
```

Auto-mount on boot: write `/etc/systemd/system/mount-windows-nfs.service` (`Type=oneshot`, `RemainAfterExit=yes`, `After=`/`Wants=network-online.target`, `ExecStartPre=/bin/sleep 10`, `ExecStart=/bin/mount …`, `ExecStop=/bin/umount …`) → `systemctl daemon-reload` → `systemctl enable --now mount-windows-nfs.service`.
