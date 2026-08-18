BUILD_CMD="npm run build -w @rdk-moss/agent"
TEST_CMD="npm run test:filter -w @rdk-moss/agent -- --filter orchestration"
FULL_CMD="npm run verify"
FULL_EVERY=2
CONTRACT_PATHS="openspec/changes/unify-long-horizon-execution/"
RUNNER_CMD="codex exec --full-auto"
PROVIDER_PROBES=()
REQUIRED_ENV=()

