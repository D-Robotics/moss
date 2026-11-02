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

In-process SSH, still on this machine. Needs explicit benchmark model settings (see below) and does not need the RDK:

```bash
export MOSS_BENCH_API_KEY
npm run bench:device -- --target sim --sim-camera --sim-ros --model <id> --base-url <url>
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
export MOSS_BENCH_API_KEY
npm run bench:device -- --target real --model <id> --base-url <url>
```

SSH options the bench expects on the device: `StrictHostKeyChecking=no`, `UserKnownHostsFile=/dev/null`. The runner does not reboot, reflash, change passwords, or edit SSH or network configuration. Every mutating task runs its cleanup.

## 模型配置 / Model config

Live runs require all three inputs together: `MOSS_BENCH_API_KEY` in the process environment, `--model`, and `--base-url`. The key must have at least eight characters because Moss's exact-value output redaction does not cover shorter environment secrets. The launcher does not load `.env` files; supply the key in the environment before launching. Moss configuration files, bundled defaults, `MOSS_API_KEY`, and provider-specific key variables are not used as fallbacks. Missing or too-short inputs cause exit 2 before connecting to a device or provider.

Embedded callers of `runDeviceBench` or `resolveBenchProvider` pass `model` and `baseUrl` options. They may pass `env: { MOSS_BENCH_API_KEY: ... }`; when `env` is supplied it is authoritative, and an absent key does not fall back to the process environment. The key is passed to the Moss process via its environment, referenced by `apiKeyEnv` in the temporary provider config, and removed from ordinary tool subprocess environments. The temporary config contains no key value.

This changes the earlier config-file fallback: callers must explicitly provide the key, model, and endpoint even if Moss already has a configured provider. RSI also requires these inputs and refuses a base device evaluator that predates the explicit benchmark credential contract. The trusted base must include the updated device benchmark before RSI can run it.

Optional cost: `MOSS_BENCH_USD_PER_MILLION_TOKENS`. `moss task run` prints an `llm_usage` JSON line when the agent reports tokens.

## 指标 / Metrics

- `successRate` = passes / (passes + fails + falseSuccess). Skips are excluded.
- `core.successRate` uses a fixed denominator: tasks that need only SSH, coreutils, and python3 (`report-identity`, `python-program`, `localhost-port`, `rollback-state`). A core skip counts as a miss.
- `optional.successRate` excludes skips (camera, ROS2, gcc, dpkg, systemd, procfs probes).
- `meta.board` records `model`, `os`, and `kernel`.
- `repeat.mean` and `repeat.spread` are the mean and population standard deviation of the per-run success rates (`--repeat N`).
- Exit 0 when every scored row passed. Exit 1 when any row failed or is `falseSuccess`. Exit 2 when a live target lacks the explicit model, endpoint, key, or required device settings.

Approvals stay pluggable: `MOSS_DEVICE_BENCH_APPROVAL=full` (default), `inherit`, or `manual`.

`inherit` 让子进程以 full 模式运行，并且不设置 `MOSS_DEVICE_TRUST`。汇总里的 `meta.devicePolicy` 来自 `src/safety/device-risk.ts`：只读和可逆样本 `autoAllow: true`；毁灭性（`reboot`）和敏感读取（`cat /etc/shadow`）不是。headless moss 会拒绝这两档。`full` 用同一交互模式，同样不授予设备信任。`manual` 会询问，headless 下等于拒绝。

`inherit` runs the child in full mode and does not set `MOSS_DEVICE_TRUST`. The summary then includes `meta.devicePolicy` from `src/safety/device-risk.ts`: readonly and reversible samples are `autoAllow: true`; destructive (`reboot`) and sensitive (`cat /etc/shadow`) are not. Headless moss denies those tiers. `full` uses the same interaction mode and also does not grant device trust. `manual` prompts, which headless moss denies.
