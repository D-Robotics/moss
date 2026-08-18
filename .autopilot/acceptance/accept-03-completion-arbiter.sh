#!/bin/bash
set -euo pipefail
npm run build -w @rdk-moss/agent
npm run test:filter -w @rdk-moss/agent -- --filter completion-arbiter

