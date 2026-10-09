# 设备安全策略：full 模式默认放行可逆操作，毁灭性操作必须显式信任

> 决策日期：2026-10-09。Round 2 stream B。对照 Claude Code / Codex 已公开的审批与沙箱语义
> （见文末「对照与偏离」），在 v0.26「默认 full」之上补一层**设备操作风险分档**。
> 不改版本号。分类器是纯函数（`src/safety/device-risk.ts`）；是否放行只在
> `resolvePermissionDecision` 的决策顺序里（`src/cli/permission-rules.ts` 步骤 4b）。

## 问题

v0.26 起默认交互模式是 `full`。`deriveEngineQuantas('full')` 的 `deviceMutationPolicy`
仍是 `allow`：`device_exec` / `device_file_write` / `device_deploy` 不再询问。
这三件工具经 SSH 作用在真机上。`rm -rf /`、`reboot`、刷写 eMMC、改 `iptables` /
`nmcli`、卸掉 `openssh-server`、改 `/etc` 或 `/boot`，都没有 git 可以回滚，
也没有本机沙箱可以接住。headless 的 `moss task run` 同样走 full，一次误调用就能锁死板子。

本机 `exec` 的 `isCommandDangerous` 硬拦截保持不变。设备侧不能继续用同一条硬拦截：
用户明确信任之后，`reboot` / 刷机必须真的能执行。硬拦截改成**分档 + 显式信任**。

## 威胁模型

攻击者不是远程入侵者。威胁是**代理自己**（模型幻觉、提示注入进了设备命令、链式
`&&` 把无害前缀和 `reboot` 粘在一起）以及**操作者误批**。

资产，按损失排序：

1. 板子还能被 SSH 登录、还能启动（账号、sshd、网络、fstab、bootloader、rootfs）。
2. 用户数据与密钥（`/etc/shadow`、`~/.ssh`、磁盘镜像）。
3. 正在跑的机器人进程（可重启的服务、工作区里的构建产物）。

做不到的事：Moss 不在设备上跑 OS 沙箱。SSH 进去之后，命令就是 root 或登录用户的真实
shell。策略只能在**发出去之前**分类并拦截。脚本正文看不到：普通 `./deploy.sh`、
`python app.py` 保持可逆。文件名或参数明显是刷机 / 格式化 / OTA（`flash`、`burn`、
`xburn`、`ota`、`mkfs`、`upgrade_firmware`、`hb_ota`）则升到毁灭性档。

## 风险档

最高档赢。shell 按未加引号的 `&&` `||` `;` `|` 和换行切开；`$(...)` 和反引号再分类一次。
`sudo` / `doas` / `env` / `timeout` / `nice` / `nohup` 以及 `VAR=value` 前缀剥掉后再看。
`bash -c` 的载荷重新分类（深度 < 4）。路径先把 `~` / `$HOME` 展开再折叠 `..`。

| 档            | 含义                             | 例子                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `readonly`    | 不改设备状态                     | 只读设备工具；`ls` `cat /etc/os-release` `journalctl` `systemctl status` `ip addr` `iptables -L` `fdisk -l` `apt list`                                                                                                                                                                                                                                                                                                                                                                                           |
| `reversible`  | 会改状态，但不至于锁死或很难撤销 | `rm -rf dist`、`rm` 家目录里的文件、`/tmp` 与 `/opt/<app>` 与 `/usr/local/**` 的写入、`apt install` / `apt update`、`systemctl restart\|start\|reload\|enable`、`dd of=/tmp/out.img`、普通 `device_deploy`                                                                                                                                                                                                                                                                                                       |
| `destructive` | 锁死、掉线、或不可逆             | `reboot` / `shutdown` / `poweroff`；`dd`/`mkfs`/`fastboot` 等刷写；重定向或写入 `/boot` `/etc` `/usr`（除 `/usr/local`）`/bin` `/sbin` `/lib` `/root` `/sys` `/proc`；`rm` 掉 `/`、`/boot`、`/etc`、家目录本身、`~`、`$HOME`、这些路径下的 `/*`；`iptables`/`nft`/`ufw` 改规则；`ip`/`nmcli` 改地址或连接；`passwd` 与用户/组命令；`apt`/`dpkg`/`opkg` 等**系统**包的 remove/purge；停掉 ssh / NetworkManager / dbus 等关键单元（其它 unit 的 stop 可逆）；`curl\|sh`、fork bomb。读密钥是 `sensitive`，不是本档 |

刻意不算毁灭性（避免日常开发误报）：

- `npm` / `pip` / `pnpm` 的 install **和** uninstall（不是系统包管理器）。
- `echo hi > /dev/null`、`2>&1`（重定向到 `/dev/null` 不升级）。
- `grep reboot src/main.py`、`echo "reboot later"`（参数里出现单词不算）。
- `ls ~/.ssh`、`grep root /etc/passwd`（列目录、读 passwd 仍是只读）。
- `command -v reboot`（不执行）。
- 不透明脚本与未识别的 `device_mutation` 工具名（例如测试夹具 `ros2_topic_pub`）保持 `reversible`，full 模式继续自动放行。

`device_deploy` 取 `remote_path`、`start_command`、`health_command` 的最高档。
同档并列时保留先看到的判断（部署到 `/opt/...` 且 `systemctl restart` 的信号是 `write-app-path`）。

## 各模式默认

`deviceMutationPolicy: 'allow'` 这个量化值**不改**（既有 spec 锁着）。新门是决策顺序里的额外一步，不是第二套模式。

| 模式                   | 只读         | 可逆                           | 毁灭性                                                |
| ---------------------- | ------------ | ------------------------------ | ----------------------------------------------------- |
| `full`（默认）         | 放行         | 放行                           | TTY 确认；headless 拒绝。`sensitive` 同此规则         |
| `manual`               | 既有规则     | 询问                           | 询问（文案用毁灭性提示，reason `device-destructive`） |
| `acceptEdits`          | 既有规则     | 询问（设备变更不是工作区编辑） | 同上                                                  |
| `plan` / `--read-only` | 只读工具放行 | 类级拒绝（在分档门之前）       | 类级拒绝                                              |

`/connect` 的 board 模式不再自动放行毁灭性档；可逆档仍按 board 放行。

决策顺序（只在 `resolvePermissionDecision`）：

1. deny 规则（任何模式，含 full 与显式信任）。
2. plan / 只读上限。
3. ask 规则（full 跳过）。
4. allow 规则。匹配到的 allow 是显式授权，**包含毁灭性档**。
   4b. `destructive` 或 `sensitive`，且没有 `deviceFullTrust`、也没有本会话已确认的同一 scope → `ask`（reason `device-destructive` 或 `device-sensitive`）。headless 把 ask 收成拒绝。`sensitive` 在 plan / 只读上限里同样询问，因为它的 side effect 仍是 readonly。
5. full → allow；其余模式走原来的默认。

operand 匹配是前缀通配：`device_exec(reboot*)` 匹配 `reboot` 与 `reboot -f`。
`device_exec(*reboot*)` 不行，因为只有以 `*` 结尾才按前缀比较。

## 如何显式信任

任意一条即可，deny 仍然赢：

| 入口                                                           | 范围                                                                                             | 持久                              |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------- |
| allow 规则，如 `device_exec(reboot)` 或 `device_exec(reboot*)` | 匹配到的调用                                                                                     | 配置或会话，看规则来源            |
| `--trust-device`                                               | 本进程全部毁灭性设备操作                                                                         | 否                                |
| `MOSS_DEVICE_TRUST=full\|1\|true\|yes`                         | 本进程                                                                                           | 否（环境）                        |
| `permissions.deviceTrust=full`                                 | 该配置文件                                                                                       | 是                                |
| `permissions.trustedDevices` 与/或 `MOSS_DEVICE_TRUST_DEVICES` | 逗号分隔的 host 或 device id，匹配 `options.device.host` / `MOSS_DEVICE_HOST` / `MOSS_DEVICE_ID` | 配置是；环境否                    |
| 确认框里选 `a`                                                 | 提示里写明的那一个 scope：电源类命令、同一 unit 的 systemctl restart 或 stop、或同一命令前缀     | 仅本会话，不写入 `trustedDevices` |

`a` 不写整工具 allow，也不把整台设备标成信任。提示文案就是将被信任的范围。

TTY / REPL 的提示在 `src/cli/device-safety-prompt.ts`，填进已有的 `CliApprovalView`。
`src/cli/tui/app.ts` 不改。headless 拒绝文案点名上面的四条 opt-in，**不**说「把模式改成 full」。

SDK 嵌入方如果没挂 CLI hook，工具自身还有一道后闸（`permitDeviceOperation`）：
`destructive` 与 `sensitive` 没有环境信任、设备名单、或与**本次 tool call id** 绑定的 grant，就返回 `Command blocked:`。
hook 在放行时 `grantDeviceOperation(tool, operand, toolCallId)`，工具用同一个 id 消费。
批准了却没执行的调用不能让下一次相同命令漏过去。本机 `exec` 的硬拦截不走这道 grant。

## 证据

每次分类过的设备调用，只要 hook 有 `workspaceDir`，就写一条（失败只吞掉，不改决定）：

- `.moss/evidence.jsonl`：`source` / `metric` = `device_policy`，`expected` 按档分别为 `destructive-requires-explicit-trust`、`sensitive-requires-explicit-trust` 或 `auto-allow`，`observed` = `<tier>:<allow|deny>`，`result` 在 allow 时为 pass、否则 fail。
- 若存在未结束任务，再写一条 `note` 事件（`kind: device_policy`，含 tool / tier / decision / signal）。`note` 是 info 事件，不推 phase。

工具后闸拒绝**不**再写第二条，避免和 hook 重复。没有 workspace 的嵌入调用只拦，不落盘。

## 验收

```bash
npm run test:filter -- --filter device-risk
npm run test:filter -- --filter device-safety
npm run test:filter -- --filter sdk-contract
npm run verify
```

`classifyDeviceOperation` 以及类型 `DeviceRiskTier` / `DeviceRiskClassification` /
`DeviceOperationInput` 是追加到 `src/index.ts` 的导出。不删、不改名既有导出。

## 对照与偏离

公开行为（2026 文档，实现以当时页面为准）：

- **Claude Code**：交互默认 auto mode，分类器审动作；deny/ask 规则仍生效。沙箱里的 bash 可以不询问就跑，但关键路径上的 `rm` / `rmdir` 仍询问。`--dangerously-skip-permissions` 跳过检查。
- **Codex**：沙箱模式 × 审批策略。Auto 预设是 `workspace-write` + `on-request`（工作区内编辑自动，工作区外和网络询问）。`--dangerously-bypass-approvals-and-sandbox` / `--yolo` 是既无沙箱也无审批。auto-review 换的是审阅模型，不是权限。

Moss 对齐的部分：默认仍然快（只读 + 可逆不询问，相当于设备上的 workspace-write）；关键路径 `rm` 仍询问；deny 规则永远赢；显式跳过必须是单独的开关，而不是把 full 再拧松。

偏离，以及为什么：

1. **没有第二模型分类器。** v0.26 已明确不做。设备命令要可单测、可复现，不能靠另一次补全。规则表是分类器。
2. **没有 OS 沙箱。** 命令在板子上执行，Moss 进程的 bubblewrap/seatbelt 包不住 SSH 对端。确认之后就是真的执行。
3. **`--trust-device` 比 yolo 窄。** 它只打开设备毁灭性档。本机 `exec` 硬拦截、路径沙箱、deny 规则都不抬。
4. **headless 比 skip-permissions 严。** 无 TTY 时毁灭性档直接拒绝。机器人任务经常无人值守，不能把「没人回答」当成同意。要跑 reboot，得事先写信任。
5. **`systemctl restart` 与 `daemon-reload` 可逆。** `stop` / `disable` / `mask` 只对关键单元毁灭性：`ssh`、`sshd`、`networking`、`NetworkManager`、`systemd-networkd`、`wpa_supplicant`、`dbus`。其余单元（含操作者部署的服务）和 `--user` 可逆。不记录「本会话写过的 unit 文件」：SSH 侧的文件名可以被冒充，分类器也不该去读任务库。
6. **`apt install` 可逆，`apt remove` 毁灭性。** 装包是日常；卸 ssh 或网络栈会锁死。
7. **`/usr/local` 及其子路径可逆，其余 `/usr` 毁灭性。** 本地安装工具落在 `/usr/local`；动 `/usr/bin` 会拆系统。
8. **确认与拒绝文案跟随 CLI locale。** `LC_ALL` / `LC_MESSAGES` / `LANG` 以 `zh` 开头时用简体中文，否则英文。分类器的 `reason` 仍是稳定英文，进证据；用户看到的标题、问题和 headless 拒绝是本地化的。

## 取舍

- 后闸的 grant 绑定 tool call id。没执行就过期，不能被下一次相同命令花掉。
- 会话级 `a` 信任提示里写明的 scope（电源类、同一 unit 的 restart 或 stop、或命令前缀），不是整台设备的毁灭性档。
- 普通脚本保持可逆。名字或参数像刷机 / OTA / mkfs 的升到毁灭性。不读脚本正文。
- 读取 `/etc/shadow`、私钥、`sshd_config`、`authorized_keys` 是 `sensitive`，不是 `destructive`：同样要确认，但证据和文案说的是读密钥。`/etc/passwd` 的读取仍是只读。写入 `/etc/passwd` 仍是毁灭性重定向。
