---
name: rdk-system-config
description: How-to workflows for RDK board system configuration — wired/Wi-Fi/Bluetooth networking (nmcli, wifi_connect, NetworkManager vs /etc/network/interfaces), DNS/proxy, the /boot/config.txt boot file (X-series dtparam/gpio/arm_boost/filters vs S-series bootargs/fdt-enable/dtbo), CPU frequency locking and overclock, thermal trip points and emc2305 fan control, boot self-start services, Samba/NFS file sharing, and the srpi-config TUI. Use whenever a user asks "how do I configure X on this board" and wants concrete steps (commands / menus / config-file edits), the right per-board method, and the X-vs-S difference. 触发词:配网/连WiFi/有线静态IP/改config.txt/改启动配置/CPU锁频/降频/超频/调频/风扇控制/温控/开机自启/自启动/Samba/NFS共享/srpi-config菜单/蓝牙配对/DNS/代理. Routing — single-command syntax lookup → rdk-command-manual; camera/GPIO/I2C/SPI/UART/PWM device drivers → rdk-peripheral-cookbook; errors AFTER configuring → rdk-board-knowledge; doc-site URLs/chapters → rdk-doc-finder; pure pin/hardware facts → rdk-hardware.
---

# RDK System Configuration

Turn a "how do I configure …" question into the exact commands, srpi-config menu path, or `/boot/config.txt` edit for the user's board — and never let an X-series recipe leak onto an S-series board (or vice versa). **The single thing that matters most: X-series and S-series are two different systems.** Confirm which family you are on before quoting any method.

> Sources: official D-Robotics docs `D-Robotics/rdk_x_doc` and `D-Robotics/rdk_s_doc`, directory `docs/02_System_configuration` (X: 5 files network_blueteeth / srpi-config / config_txt / frequency_management / self_start; S: 7 files, additionally gui_network_config and share_file_tool). Every non-trivial fact below was re-verified against these files; nothing is invented.

## Confirm the board first

X and S diverge on networking, config.txt syntax, frequencies, thermal zones, and which tools exist. Probe before answering:

```bash
cat /sys/class/socinfo/board_id   # or: cat /etc/version, hrut_somstatus
which srpi-config                  # exists on X3/X5/X3 Module; S100 too; NOT on Ultra
cat /boot/config.txt              # X and S use the SAME path, COMPLETELY different syntax
nmcli device                      # network manager present?
```

## Board baseline cheat-sheet (decides which recipe to use)

| Dimension | X-series (`rdk_x_doc`) | S-series (`rdk_s_doc`) |
|---|---|---|
| Boards | X3 (Bernoulli2), X5 (Bayes-e), Ultra (Bayes) | S100 (Nash-e) / S100P (Nash-m), S600 (Nash-p) |
| OS / ROS | Ubuntu 22.04 + Humble | S100/S100P: 22.04 + Humble · S600: **24.04 + Jazzy** |
| Wired net | New: NetworkManager · Old: `/etc/network/interfaces` | NetworkManager + Netplan / nmcli only; **no ifup/ifdown** |
| Soft AP | Supported (hostapd or NM Hotspot; X5 can do 5G) | Doc marks **"not yet available"** |
| config.txt | `/boot/config.txt` (uboot) — `dtparam`/`gpio`/`arm_boost`/`[filters]` | `/boot/config.txt` (D-Robotics Uboot) — `bootargs`/`fdt-enable`/`dtbo`; **syntax totally different** |
| srpi-config | X3 / X5 / X3 Module (**NOT Ultra**) | Doc example is S100 (no Display, no Sensor Profiles menu) |
| GUI config / file share | No standalone doc chapter | Has its own 2.6 GUI networking + 2.7 Samba/NFS |

> Canonical board fact (carry consistent across all skills): the **S100/S600 management port `eth1` is factory-fixed at `192.168.127.10`**; X-series default wired IP is also `192.168.127.10`. The S-series doc's nmcli examples use a sample `192.168.10.100/24` connection named `eth1_cfg` — substitute the real connection name from `nmcli connection show`.

## Task → route map

Full commands, menus, config-file bodies, item-by-item X/S differences, and provenance are in **[system-config.md](references/system-config.md)**. A deterministic lookup for "which sysfs path / value for thermal & CPU freq on board X" is `scripts/sysconf_lookup.py`.

| Task | X-series method | S-series method |
|---|---|---|
| Static / DHCP wired IP | Edit `netplan-eth0.nmconnection` (new) or `/etc/network/interfaces` (old), then `sudo restart_network` | `nmcli connection modify` ipv4.method/addresses, then `down`/`up` |
| Wi-Fi connect (Server) | `sudo nmcli device wifi rescan`/`list` + `sudo wifi_connect "SSID" "PASSWD"` | Same as X |
| Wi-Fi hotspot (AP) | hostapd + isc-dhcp-server, or NM `Hotspot` (X5 can do 5G) | Not yet available |
| Bluetooth | `/usr/bin/startbt.sh` init + `bluetoothctl` (power on/scan/pair/trust) | `bluetoothctl` (no startbt.sh step; adds `bluetoothctl list`) |
| DNS / proxy | DNS via `/etc/systemd/resolved.conf` | Same DNS; proxy via `~/.bashrc` or `/etc/environment` |
| Edit boot config | `/boot/config.txt`: dtparam buses, gpio mux, arm_boost/governor, throttling/shutdown temp | `/boot/config.txt`: bootargs/loglevel/fdt-enable/fdt-disable/dtbo_file_path |
| CPU freq / lock | `scaling_governor` on `policy0`; boost: X3 1.2→1.5G, X5 1.5→1.8G (**X5H only**) | `cpu0/cpufreq/scaling_governor`; S100 1.5/2.0G, S600 0.525/1.05/2.1G; **no overclock** |
| Thermal / fan | Set `thermal_zoneN/trip_point_*_temp` (X3 1 zone, X5 2 zones) | S100 5 zones, S600 19 zones; fan: set zone `policy=user_space` then write `cooling_deviceN/cur_state` |
| Boot self-start | init.d + `update-rc.d defaults` + `systemctl enable`, or `/etc/rc.local` | **Identical to X** |
| File share | No doc chapter | Samba (`smb.conf [shared]` + `smbpasswd -a sunrise`), NFS client (`mount -t nfs`) |
| GUI networking | No doc chapter | settings → Network: static IP / DNS / Proxy |
| srpi-config TUI | System/Display/Interface/Performance/Localisation/Advanced/Sensor Profiles | System (adds Update Miniboot) / Interface (SSH only) / Performance (ION only) / Localisation / Advanced; **no Display, no Sensor Profiles** |

## Workflows

### Workflow 1 — Network configuration

1. **Probe the family and version.** `nmcli device` (present → NetworkManager path). For X-series, version gates the method: X5 ≥ 3.3.0 / X3 ≥ 3.0.2 use NetworkManager; older use `/etc/network/interfaces`.
2. **Wired static IP.**
   - X new / S: NetworkManager. X edits `netplan-eth0.nmconnection` `[ipv4] address1=…/24,gateway` + `method=manual` + `route-metric=700`, then `sudo restart_network`. S uses `nmcli connection modify "<conn>" ipv4.method manual ipv4.addresses …` then `nmcli connection down/up "<conn>"`.
   - X old: edit `/etc/network/interfaces` `iface eth0 inet static`, then `sudo restart_network`.
   - `route-metric/metric=700` is **intentional** — it lowers wired priority so Wi-Fi wins when both are up. Do not "fix" it.
3. **Wi-Fi (both families).** Desktop: click the tray Wi-Fi icon. Server: `sudo nmcli device wifi rescan` → `list` → `sudo wifi_connect "SSID" "PASSWD"`. `Scanning not allowed immediately…` = scanned too recently, wait; `No network with SSID … found` = rescan.
4. **Soft AP.** X-series only (hostapd+isc-dhcp-server, or NM Hotspot; X5 can host 5G with `channel=36 hw_mode=a`). On S-series the doc says AP mode is **not yet available** — do not hand the user a hostapd recipe.
5. **DNS** (both): add `DNS=…` to `/etc/systemd/resolved.conf`, restart `systemd-resolved`, relink `/etc/resolv.conf`. **Proxy** (S doc): `http_proxy/https_proxy/no_proxy` in `~/.bashrc` (current user) or `/etc/environment` (all users).

### Workflow 2 — Edit /boot/config.txt (X and S are two different mechanisms)

**X-series** (X3/X5/X3 Module; system ≥ 2.1.0, miniboot ≥ 20231126; edit as root):
1. Toggle buses: `dtparam=i2c5=on`, `dtparam=uart3=off`. Mind X5 pin multiplexing (one row → one function).
2. CPU freq: `arm_boost=1` (X3→1.5/1.8G, X5→1.8G), `governor=performance`, or `governor=userspace` + `frequency=…`.
3. GPIO init: `gpio=5=f3` (mux), `ip`/`op`, `dh`/`dl`, `pu`/`pd`/`pn` (BOARD numbering).
4. Thermal: `throttling_temp=86000`, `shutdown_temp=112000`.
5. `[all]/[rdkv1]/[rdkv2]/[rdkmd]/[x5-rdk]` filters scope everything **after** them to that model.

**S-series** (D-Robotics Uboot; priority `setenv > config file > last saveenv`; one line ≤1024 chars; unusable when AVB is enabled, which is off by default):
1. `bootargs=isolcpus=1-2` (kernel cmdline), `loglevel=8`.
2. `fdt-enable=/soc/uart@394C0000;` / `fdt-disable=…;` — the trailing `;` is **mandatory**; get the node path from `/proc/device-tree` and prefix `/`.
3. DTB overlay: `dtc -I dts -O dtb -o x.dtbo x.dtso` → copy to `/boot` → `dtbo_file_path=/x.dtbo`.
4. There is **no** X-style `dtparam`/`gpio`/`arm_boost`/filter syntax on S.

### Workflow 3 — CPU frequency, thermal, and fan

1. **Read state:** `sudo hrut_somstatus` on both families. All `trip_point` edits and sysfs governor changes **reset on reboot** — to persist, add to boot self-start (Workflow 5).
2. **Lock the CPU clock:** `echo userspace > .../scaling_governor` then write `scaling_setspeed`. Path differs: X3 uses `cpufreq/policy0/`, X5/S use `cpu0/cpufreq/scaling_governor` + `policy0/scaling_setspeed`. Valid freqs: X3 240000–1800000, X5 300000/600000/1200000/1500000, S100 1500000/2000000, S600 525000/1050000/2100000 (per-chip).
3. **Overclock:** X3 `echo 1 > .../cpufreq/boost` (1.2→1.5G) + performance; X5 boost 1.5→1.8G but **X5H only** (`cat /sys/class/socinfo/soc_name`; X5M cannot, X5U is unlocked but unsupported for mass production). **S-series has no overclock.**
4. **Fix the fan speed (S only):** S100 fan = `cooling_device2`, bound to `thermal_zone0`. S600 fans = `cooling_device5/6`, bound to `thermal_zone2` and `thermal_zone16`. First set the bound zone `policy` to `user_space`, **then** `echo <0-10> > cooling_deviceN/cur_state` — under `step_wise` the system overrides your value by temperature.

### Workflow 4 — Boot self-start (identical on X and S)

1. Create `/etc/init.d/your_script` with an `### BEGIN/END INIT INFO` header (`Default-Start: 2 3 4 5`, `Default-Stop: 0 1 6`), body `/path/to/program &` + `exit 0`.
2. `sudo chmod +x /etc/init.d/your_script`
3. `sudo update-rc.d your_script defaults`
4. `sudo systemctl enable your_script`
5. Reboot, verify `systemctl status your_script.service` (`active (exited)` = OK).
- Alternative: insert commands before `exit 0` in `/etc/rc.local` (legacy under systemd).

### Workflow 5 — File sharing (S-series only)

- **Samba:** `apt install samba` → `mkdir ~/shared` → add `[shared]` block to `/etc/samba/smb.conf` (`read only=no`, `guest ok=no`, masks `0775`) → `sudo smbpasswd -a sunrise` → `sudo systemctl restart smbd`. Open the port with `sudo ufw allow samba` only if ufw is on.
- **NFS client:** `apt install nfs-common` → `mkdir -p /userdata/...` → `sudo mount -v -t nfs -o vers=3,proto=tcp <server>:/path /userdata/...`. For auto-mount on boot, install the `mount-windows-nfs.service` oneshot unit (see reference).

## Worked examples

**Example 1 — "S600 上怎么把 CPU 锁到最高频?"**
*"S600 supports 525000 / 1050000 / 2100000 kHz (per chip). Lock the max: `echo userspace > /sys/devices/system/cpu/cpu0/cpufreq/scaling_governor` then `echo 2100000 > /sys/devices/system/cpu/cpufreq/policy0/scaling_setspeed`. Note: S-series has no boost/overclock — 2.1 GHz is the ceiling. The setting resets on reboot, so add it to a boot self-start script if you need it to persist."*

**Example 2 — "我的 X5 风扇一直响,想固定风扇转速怎么搞?"**
First check the board: dedicated fan-speed sysfs control with `cooling_deviceN` is documented for **S100/S600**, not X5 (X5 thermal has cpu/bpu/gpu/ddr cooling devices but no emc2305 fan stage). If they are actually on **S100**: *"Fan is `cooling_device2` bound to `thermal_zone0`. Set the zone to manual first — `echo user_space > /sys/class/thermal/thermal_zone0/policy` — then `echo 10 > /sys/class/thermal/cooling_device2/cur_state` (0=off … 10=full). Under the default `step_wise` policy the system would override your value by temperature."* If it's really X5, route the fan-hardware question to rdk-peripheral-cookbook / rdk-hardware.

**Example 3 — "刚拿到 S600,怎么用命令行给 eth1 配个静态 IP?"**
*"S600 (Ubuntu 24.04) uses NetworkManager + Netplan; `ifup/ifdown` is unsupported. Find the connection name with `nmcli connection show`, then: `nmcli connection modify "<conn>" ipv4.method manual ipv4.addresses 192.168.10.100/24 ipv4.gateway 192.168.10.1 ipv4.dns "223.5.5.5 8.8.8.8" connection.autoconnect yes`, then `nmcli connection down "<conn>"; nmcli connection up "<conn>"`. The factory eth1 management IP is 192.168.127.10 — don't lock yourself off the port you're connected through."*

**Example 4 — "X5 上想关掉 uart3、打开 i2c5,改 config.txt 行不行?"**
*"Yes, on X5 use `/boot/config.txt` dtparam: `dtparam=uart3=off` and `dtparam=i2c5=on`, edit as root, reboot. Watch X5 pin multiplexing — a row shares pins, only one function per row (e.g. uart3↔i2c5, spi2↔pwm0/pwm1). If you previously enabled it via srpi-config, a config.txt `[filter]` can mask that, so keep them consistent. This is S-vs-X specific: on S-series there is no `dtparam`; you'd use `fdt-enable`/`fdt-disable` with the full device-tree node path instead."*

## Common pitfalls

| ❌ Don't | ✅ Do |
|---|---|
| Hand an S-series user a hostapd Soft AP recipe | S Soft AP is "not yet available" — say so; only X-series has it |
| Use `dtparam=`/`gpio=`/`arm_boost=` on S `/boot/config.txt` | S uses `bootargs`/`fdt-enable`/`dtbo`; different mechanism entirely |
| `ifup eth0` / edit `/etc/network/interfaces` on S | S has no ifup/ifdown — use `nmcli connection modify` |
| Tell any X5 it can overclock | Only **X5H** can; check `cat /sys/class/socinfo/soc_name` first |
| `echo` a fan `cur_state` while zone is `step_wise` | Set the zone `policy=user_space` first, else the value is overridden |
| Promise thermal/freq edits survive reboot | They reset — persist via boot self-start |
| Suggest `srpi-config` on RDK Ultra | srpi-config is X3/X5/X3 Module (+S100), not Ultra |
| Drop the trailing `;` in S `fdt-enable=…` | The `;` is mandatory; node path comes from `/proc/device-tree` with a leading `/` |

## Reference map

| Read this | When |
|---|---|
| [system-config.md](references/system-config.md) | Full per-task commands, srpi-config menu trees, config.txt bodies, every X/S difference, thermal-zone/trip-point tables, Samba/NFS unit files, with provenance |
| `scripts/sysconf_lookup.py` | Deterministic "board → CPU freq points / governor path / thermal-zone & fan cooling-device mapping" lookup, so you don't recite per-board sysfs from memory |
