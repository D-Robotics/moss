# Device task benchmark (2026-10-09)

Board-task success rate for Moss. Every later round can be judged by the number
this harness writes under `bench/results/`. PASS comes only from Moss's verdict
provider (`src/core/task/verdict.ts` via `runTask` / `moss task run`). Agent
prose is not a score.

The real target is an RDK S600 at `root@rdk-sandbox.d-robotics.cc:40018`
(`StrictHostKeyChecking=no`, `UserKnownHostsFile=/dev/null`). The password is
read at run time from `RDK_S600_PASSWORD` (or `MOSS_DEVICE_PASSWORD`, or
`MOSS_DEVICE_KEY`) and is never written to disk, argv, logs, or the result
JSON. The bench does not require that host to be reachable: CI uses `--dry`
(no model, no SSH) or `--target sim` (local ssh2 sandbox). The real board is
opt-in.

## Goal

Measure whether Moss can finish realistic board work through Task OS:

`draft → planning → executing → verifying → diagnosing → repairing → reverifying → accepted | failed`

Artifacts stay in the workspace `.moss/*.jsonl`. A row is a pass only when the
engine outcome is `pass`, which happens only after the command verdict exits 0.
Missing evidence is reported as `falseSuccess` when a command pass has no
`result: "pass"` evidence record for that task.

## How to run

```bash
npm run bench:device -- --dry
npm run bench:device -- --dry --task report-identity
npm run bench:device -- --target sim --model <id> --base-url <url>
npm run bench:device -- --target real
```

`--dry` is the default when `MOSS_DEVICE_HOST` is unset. It needs no model key
and no device. It drives `runTask` with a scripted turn (the task's `oracle`)
and the same acceptance command a live run uses.

`--target sim` starts an in-process ssh2 server on `127.0.0.1`, points
`MOSS_DEVICE_*` at it, and runs `moss task run` headless. Requires
`MOSS_BENCH_API_KEY` or a deepseek entry in `~/.qoder-cn/settings.json`, plus
`--model` and `--base-url` when the key is only in the environment. The key is
written to a `0600` config under a temp `MOSS_CONFIG_DIR` and is not copied
into `bench/results/`.

`--target real` uses:

| Variable               | Role                                                            |
| ---------------------- | --------------------------------------------------------------- |
| `MOSS_DEVICE_HOST`     | required (`rdk-sandbox.d-robotics.cc` for the S600)             |
| `MOSS_DEVICE_PORT`     | default 22; S600 sandbox is `40018`                             |
| `MOSS_DEVICE_USER`     | default `root`                                                  |
| `RDK_S600_PASSWORD`    | password, copied into `MOSS_DEVICE_PASSWORD` for the child only |
| `MOSS_DEVICE_PASSWORD` | used when `RDK_S600_PASSWORD` is unset                          |
| `MOSS_DEVICE_KEY`      | private key path; preferred over a password when set            |
| `MOSS_DEVICE_KIND`     | `rdk` for the S600                                              |

Example:

```bash
export MOSS_DEVICE_HOST=rdk-sandbox.d-robotics.cc
export MOSS_DEVICE_PORT=40018
export MOSS_DEVICE_USER=root
export MOSS_DEVICE_KIND=rdk
export RDK_S600_PASSWORD  # value stays in the environment
export MOSS_BENCH_API_KEY
npm run bench:device -- --target real --model <id> --base-url <url>
```

Approvals are pluggable and are not a risk classifier (that belongs to the
device-safety stream):

| `MOSS_DEVICE_BENCH_APPROVAL` | Effect                                                       |
| ---------------------------- | ------------------------------------------------------------ |
| `full` (default)             | `MOSS_SAFETY_MODE=full-access`, `MOSS_APPROVAL_POLICY=never` |
| `inherit`                    | parent environment unchanged                                 |
| `manual`                     | prompt policy (headless denies mutations)                    |

`--sim-camera` and `--sim-ros` turn on simulated camera and ROS2 so those
tasks are scored instead of skipped. Results:

`bench/results/device-<mode>-<stamp>/summary.json` (gitignored).

Exit 0 when every scored task passed. Exit 1 when any scored task failed.
Exit 2 when the suite is unsafe, the build is missing, or a live target has
no model key. Skips are not failures.

## Task set

Files live in `bench/device-tasks/*.json`. Shell fields use `$MOSS_BENCH_ROOT`,
`$MOSS_BENCH_TOKEN`, `$MOSS_BENCH_PORT`, and `$MOSS_BENCH_STATE`. The runner
exports them for setup, oracle, acceptance, and cleanup. Prompts receive the
concrete `{{ROOT}}`, `{{TOKEN}}`, and `{{PORT}}`.

Paths the agent may create are under `/tmp/moss-bench/<run>/<task>/` on a real
board (the dry/sim root is a private temp directory). The only intentional
exceptions are the package `moss-bench-marker` and the unit
`moss-bench-marker.service`, both removed by cleanup.

| id                  | side effect | prerequisite                                               | acceptance (on the target)                                                               |
| ------------------- | ----------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `report-identity`   | readonly    | none                                                       | evidence `hostname` equals `hostname`                                                    |
| `report-resources`  | readonly    | none                                                       | evidence `mem_total_kb` equals `MemTotal` from `/proc/meminfo`                           |
| `report-network`    | readonly    | none                                                       | evidence `net_iface` equals the first `/sys/class/net` name; no route or address changes |
| `report-processes`  | readonly    | none                                                       | evidence `live_pid` is a pid that exists in `/proc`                                      |
| `camera-presence`   | readonly    | `/dev/video0`, `/sys/class/video4linux`, or `--sim-camera` | evidence `camera_name` matches the live probe                                            |
| `python-program`    | mutating    | `python3`                                                  | `python3 $ROOT/hello.py` prints `moss-bench-python-ok <token>`                           |
| `c-program`         | mutating    | `gcc` or `cc`                                              | `$ROOT/hello` prints `moss-bench-c-ok <token>`                                           |
| `install-local-deb` | mutating    | `dpkg-deb` and `dpkg`                                      | `dpkg -s moss-bench-marker` is installed and the payload file contains the token         |
| `systemd-oneshot`   | mutating    | `systemctl` and systemd (or the sim)                       | `systemctl show -p Result` is `success` and the proof file contains the token            |
| `localhost-port`    | mutating    | `python3`                                                  | a TCP client to `127.0.0.1:$PORT` reads `moss-bench-port-ok <token>`                     |
| `ros2-pubsub`       | mutating    | `ros2` or `/opt/tros` or `/opt/ros` (or `--sim-ros`)       | `ros2 topic echo /moss_bench_demo --once` contains the token                             |
| `rollback-state`    | mutating    | none (setup installs `mutate`)                             | `state.txt` is `v1` and `audit.log` shows `SET v2` before `ROLLBACK`                     |

Each task also requires an evidence record whose `observed` equals a fresh
probe. The acceptance program is `scripts/lib/device-bench-accept.mjs`. Moss
runs it as `--accept` (live) or as the command verdict (dry).

Skipped tasks (prerequisite exit non-zero) stay out of the denominator.

## Metrics

`summary.json`:

- `successRate` = passed / (passed + failed). Skips excluded.
- `passed`, `failed`, `skipped`, `falseSuccess`
- per row: `status`, `phase`, `turns` (engine turns: plan + execute + repair), `steps` (task-event count), `wallMs`, `tokensIn`, `tokensOut`, `costUsd`, `evidence` (paths under the result dir), `cleanup`
- `bySideEffect` for readonly vs mutating

Tokens and cost are `null` until `moss task run` emits usage. Dry rows say
`tokensSource: "dry-no-model"`. Live rows say
`tokensSource: "not-emitted-by-task-cli"`. The harness does not invent a cost.
If `MOSS_BENCH_USD_PER_MILLION_TOKENS` is set and tokens are ever present,
`costUsd` is `tokens/1e6 * rate`.

`falseSuccess` counts command-verdict passes that have no passing evidence
record. The shipped tasks' acceptance commands require that record, so a
faithful run stays at 0. A command that is just `true` still shows the hole.

## Safety

The loader rejects any setup, oracle, acceptance, cleanup, or prerequisite
that mentions reboot/poweroff, password changes, reflash (`dd of=/dev`,
fastboot, rkdeveloptool), `sshd_config` / `/etc/ssh/`, firewall tools, or
`ip link|addr|route` mutations, including `systemctl` restart/stop of ssh.
The sim SSH server applies the same denylist to agent commands so a model
cannot reboot the machine that hosts the sandbox.

Sim/dry prepend `bench/device-tasks/sim/bin` so `systemctl`, `dpkg`, and
`dpkg-deb` hit a state directory under the task root instead of the host.
`ros2` is prepended only with `--sim-ros`. Cleanup always runs, including
after a failed verdict. The bench never reboots, reflashes, changes
passwords, or edits SSH or network configuration.

## What this number does not hide

- `moss task run` does not emit `llm_usage`, so a live success rate has no
  token or dollar cost until the CLI grows a usage tap.
- Command verdicts outrank contract verdicts. A passing shell command accepts
  the task even when criteria are unmet. `falseSuccess` counts the empty
  evidence case; it does not by itself fail the row.
- A root agent can forge on-device logs. Tasks that re-probe (`hostname`,
  the listener, `dpkg -s`, `/proc/<pid>`) are stronger than the rollback
  audit file.
- Camera, ROS2, gcc, or systemd absence becomes a skip, not a zero. Compare
  `skipped` before comparing rates across boards.
- The sim server speaks SSH exec. `device_file_write` (SFTP) is not
  implemented on the sim; live sim runs must write files with `device_exec`.
- Headless `manual` approval denies `device_mutation`. Switching
  `MOSS_DEVICE_BENCH_APPROVAL` to `inherit` is how the device-safety
  classifier shows up in this rate.
