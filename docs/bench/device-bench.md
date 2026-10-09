# 设备任务基准 / Device task bench

Board-task success rate for Moss. Results go to `bench/results/` and are not committed. A row passes only when Moss's verdict passes and an independent probe matches recorded evidence. `falseSuccess` is reported separately and does not count as a pass.

Schema: `summary.json` has `schemaVersion: 1`. Compare `successRate`, `core.successRate`, `falseSuccess`, and `repeat.mean` / `repeat.spread` across rounds.

## 模拟 / Simulated

No model and no device. The scripted oracle drives Task OS and the same acceptance command a live run uses:

```bash
npm run bench:device -- --dry
npm run bench:device -- --dry --repeat 3
npm run bench:device -- --dry --task report-identity
```

In-process SSH, still on this machine. Needs a moss config (see below) and does not need the RDK:

```bash
npm run bench:device -- --target sim --sim-camera --sim-ros
npm run bench:device -- --target sim --model <id> --base-url <url>
```

`--sim-camera` and `--sim-ros` score the camera and ROS2 tasks instead of skipping them.

## 真机 / Real board

The password is read at run time from `RDK_S600_PASSWORD` (or `MOSS_DEVICE_PASSWORD`, or `MOSS_DEVICE_KEY`). It is never printed, logged, or written into the summary.

```bash
export MOSS_DEVICE_HOST=rdk-sandbox.d-robotics.cc
export MOSS_DEVICE_PORT=40018
export MOSS_DEVICE_USER=root
export MOSS_DEVICE_KIND=rdk
export RDK_S600_PASSWORD
npm run bench:device -- --target real
```

SSH options the bench expects on the device: `StrictHostKeyChecking=no`, `UserKnownHostsFile=/dev/null`. The runner does not reboot, reflash, change passwords, or edit SSH or network configuration. Every mutating task runs its cleanup.

## 模型配置 / Model config

Live runs resolve the model the same way the `moss` CLI does:

| Input                                         | Role                                                                                          |
| --------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `MOSS_CONFIG_DIR`                             | directory containing `config.json` (default `~/.config/moss`, or `%APPDATA%\moss` on Windows) |
| `MOSS_CONFIG_FILE` or `MOSS_CONFIG_PATH`      | explicit config file                                                                          |
| `XDG_CONFIG_HOME`                             | POSIX config root when `MOSS_CONFIG_DIR` is unset                                             |
| `--model`, `--base-url`                       | override the config file                                                                      |
| `apiKey`, `model`, `baseUrl` inside that file | what the CLI actually loads                                                                   |

These environment variables are ignored, matching the CLI: `MOSS_API_KEY`, `MOSS_MODEL`, `MOSS_BASE_URL`, `OPENAI_API_KEY`, `DEEPSEEK_API_KEY`, `ANTHROPIC_API_KEY`.

Optional cost: `MOSS_BENCH_USD_PER_MILLION_TOKENS`. `moss task run` prints an `llm_usage` JSON line when the agent reports tokens.

## 指标 / Metrics

- `successRate` = passes / (passes + fails + falseSuccess). Skips are excluded.
- `core.successRate` uses a fixed denominator: tasks that need only SSH, coreutils, and python3 (`report-identity`, `python-program`, `localhost-port`, `rollback-state`). A core skip counts as a miss.
- `optional.successRate` excludes skips (camera, ROS2, gcc, dpkg, systemd, procfs probes).
- `meta.board` records `model`, `os`, and `kernel`.
- `repeat.mean` and `repeat.spread` are the mean and population standard deviation of the per-run success rates (`--repeat N`).
- Exit 0 when every scored row passed. Exit 1 when any row failed or is `falseSuccess`. Exit 2 when the live target has no moss config.

Approvals stay pluggable: `MOSS_DEVICE_BENCH_APPROVAL=full` (default), `inherit`, or `manual`. `inherit` is how another stream's device-safety policy applies.
