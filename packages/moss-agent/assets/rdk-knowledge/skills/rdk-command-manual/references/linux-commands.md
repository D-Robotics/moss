# Linux command appendix — index (Appendix 9.2)

> Source: `D-Robotics/rdk_doc` `docs/09_Appendix/linux-command-manual/` (branch `main`, `_category_.json` label = `9.2 Linux命令用法`). These are **generic Linux** command write-ups that D-Robotics bundled for beginners. This skill only **indexes back to the official pages** — it does not copy the bodies. For exact usage, give the official link or explain from standard `man` semantics. **Do not invent RDK-specific behavior** for these commands.

Doc-site URL pattern: `https://developer.d-robotics.cc/rdk_doc/Appendix/linux-command-manual/cmd_<name>`

| Command | Category | Official file | Doc-site link |
|---------|----------|---------------|---------------|
| `apt` | package management | `cmd_apt.md` | `.../Appendix/linux-command-manual/cmd_apt` |
| `dpkg` | deb package management | `cmd_dpkg.md` | `.../cmd_dpkg` |
| `dpkg-deb` | deb package inspection | `cmd_dpkg-deb.md` | `.../cmd_dpkg-deb` |
| `dmesg` | kernel log | `cmd_dmesg.md` | `.../cmd_dmesg` |
| `find` | file search | `cmd_find.md` | `.../cmd_find` |
| `grep` | text search | `cmd_grep.md` | `.../cmd_grep` |
| `ps` | process listing | `cmd_ps.md` | `.../cmd_ps` |
| `top` | live process/load | `cmd_top.md` | `.../cmd_top` |
| `nohup` | run detached/no-hangup | `cmd_nohup.md` | `.../cmd_nohup` |
| `mount` | mount filesystems | `cmd_mount.md` | `.../cmd_mount` |
| `tar` | archive/extract | `cmd_tar.md` | `.../cmd_tar` |
| `zip` | compression | `cmd_zip.md` | `.../cmd_zip` |
| `rsync` | incremental sync | `cmd_rsync.md` | `.../cmd_rsync` |
| `scp` | remote copy | `cmd_scp.md` | `.../cmd_scp` |
| `ssh` | remote login | `cmd_ssh.md` | `.../cmd_ssh` |
| `ip` | network config (new) | `cmd_ip.md` | `.../cmd_ip` |
| `ifconfig` | network config (legacy) | `cmd_ifconfig.md` | `.../cmd_ifconfig` |
| `route` | routing table | `cmd_route.md` | `.../cmd_route` |
| `netstat` | connections/ports | `cmd_netstat.md` | `.../cmd_netstat` |

Notes:
- 19 commands total, all standard Linux; D-Robotics includes them for convenience.
- When a real RDK-board problem appears behind one of these (APT public-key failure, TROS package not found, etc.), it is a **symptom** — route to `rdk-board-knowledge`. This appendix is only a syntax reference.
- The S-series tree (`rdk_s_doc` / `rdk_doc docs_s/`) has the same `09_Appendix/linux-command-manual/` directory with overlapping files; no separate listing needed.
