# BPU Toolchain — Host (x86 Docker) Setup

> Sources, item by item:
> - X-series host specs & Docker: `rdk_doc` `docs/07_Advanced_development/04_toolchain_development/overview.md` and `.../intermediate/environment_config.md`
> - S-series Docker image / run flags: `rdk_s_doc` `.../01_algorithm_toolchain/01_overview.md`; `rdk_model_zoo` (`rdk_s` branch) conversion READMEs
>
> **Scope of THIS file: the host environment only** — host specs, Docker images, run flags, the docker group. The actual conversion commands (`hb_mapper checker/makertbin`, `hb_compile`, config.yaml, calibration, `march` values, op support) live in the **rdk-device** skill (`references/toolchain-workflow.md`). Don't duplicate the conversion procedure here.

## 1. Hard rule: host-only, in Docker

Model conversion runs **on an x86 Linux development host inside a Docker container**. The board carries only the runtime. **Never** tell a user to `apt install hb_mapper` / `hb_compile` on the board — those tools do not belong there.

A GPU is **optional**: a CPU-only host converts models fine. GPU only speeds up some steps.

## 2. Host machine requirements (X-series OpenExplorer)

| Item | Requirement |
|---|---|
| CPU | Intel i3+ or equivalent E3 / E5 |
| RAM | **16 GB or more** |
| OS | **Ubuntu 20.04** |
| Docker | **19.03 or newer** (19.03 recommended) |
| GPU (optional) | CUDA 11.6, driver ≥510.39.01 (515.76 recommended); e.g. RTX 3090 / 2080 Ti / TITAN V / V100S / A100 |
| NVIDIA Container Toolkit (GPU only) | 1.13.1–1.13.5 (1.13.5 recommended) |

## 3. Docker prerequisites

Add your non-root user to the `docker` group so root is not required for every command:
```bash
sudo groupadd docker
sudo gpasswd -a ${USER} docker
sudo service docker restart
```

## 4. Pull & run the toolchain image

**Image family follows the board family:**

| Board family | Docker image (example) | Host OS in image |
|---|---|---|
| X5 | `openexplorer/ai_toolchain_ubuntu_20_x5_gpu:{version}` / `..._x5_cpu:{version}` | Ubuntu 20.04 |
| X3 / Ultra (J5-gen) | `openexplorer/ai_toolchain_ubuntu_20_x3j5_gpu:{version}` (CPU variant analogous) | Ubuntu 20.04 |
| S100 / S100P / S600 | `registry.d-robotics.cc/.../ai_toolchain_ubuntu_22_s100_s600_cpu:{version}` (GPU variant analogous) | Ubuntu 22.04 |

> The image suffix follows the board: **X5 → `_x5_`**, **X3 → `_x3j5_`**, **S-series → `_s100_s600_`**. Don't run an X5 model through the `x3j5` image or vice versa.

> Replace `{version}` with the latest from the official Docker Hub / registry page. The local image version can be requested from D-Robotics tech support.

**X-series — CPU host (most common; X5 shown — swap `_x5_` → `_x3j5_` for X3/Ultra):**
```bash
export version=v1.2.8
export ai_toolchain_package_path=/home/users/xxx/ai_toolchain_package
export dataset_path=/home/users/xxx/data/

docker pull openexplorer/ai_toolchain_ubuntu_20_x5_cpu:"${version}"
docker run -it --rm \
  -v "$ai_toolchain_package_path":/open_explorer \
  -v "$dataset_path":/data \
  openexplorer/ai_toolchain_ubuntu_20_x5_cpu:"${version}"
```

**X-series — GPU host:** use the `_gpu` image, add `--gpus all` and `--shm-size=15g`:
```bash
docker run -it --rm \
  --gpus all \
  --shm-size=15g \
  -v "$ai_toolchain_package_path":/open_explorer \
  -v "$dataset_path":/data \
  openexplorer/ai_toolchain_ubuntu_20_x5_gpu:"${version}"
```

**S-series — OpenExplorer (天工开物 OE):** download the OE package, then pull/run the `ai_toolchain_ubuntu_22_s100_s600_*` image, mounting the project and enlarging shared memory:
```bash
docker run -it --rm \
  --network host --shm-size=15g \
  -v "$(pwd)":/workspace --workdir /workspace \
  <s-series-image> /bin/bash
```

## 5. Sanity checks on the host

- `docker --version` → 19.03+.
- `docker run --rm <image> hb_mapper --help` (X-series) or `... hb_compile --help` (S-series) should print usage — proving the toolchain is reachable *inside the container*, not on the board.
- If `--gpus all` errors, the NVIDIA Container Toolkit / driver is missing — drop GPU flags and convert CPU-only.

## 6. Hand-off to the conversion procedure

Once the container runs, the conversion itself — checker → calibration data → `makertbin`/`hb_compile --config` → `.bin`/`.hbm`, plus the correct `march` per board — is documented in **rdk-device** (`references/toolchain-workflow.md`). Canonical board → tool/artifact mapping:

| Board | march | Host tool | Artifact |
|---|---|---|---|
| X3 | `bernoulli2` | `hb_mapper` | `.bin` |
| X5 | `bayes-e` | `hb_mapper` | `.bin` |
| Ultra | `bayes` | `hb_mapper` | `.bin` |
| S100 | `nash-e` | `hb_compile` | `.hbm` |
| S100P | `nash-m` | `hb_compile` | `.hbm` |
| S600 | `nash-p` | `hb_compile` | `.hbm` |

Cross-family artifacts are not interchangeable (`.bin` ≠ `.hbm`).
