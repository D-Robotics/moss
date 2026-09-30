# qiaolong-autopilot 任务参数（preflight.sh / gate.sh / relay.sh 读取）

# ---- 门 1：构建门 ----
BUILD_CMD="npm run build"
TEST_CMD="npm run test:filter -- --filter cli"

# ---- 全量门 ----
FULL_CMD="npm run verify"
FULL_EVERY=5

# ---- 契约冻结 ----
CONTRACT_PATHS="test/cli-headless-json-contract.spec.mjs"

# ---- relay runner：本任务由 goal 会话逐棒自执行（RUNNER=self），无外部 relay ----
RUNNER_CMD="self"

# ---- provider 探测 ----
PROVIDER_PROBES=(https://ai-api.d-robotics.cc)

# ---- 必需环境变量（密钥经 ~/.moss-ap-env source，绝不入仓）----
REQUIRED_ENV=()
