#!/bin/bash
# 正式入口: flags 可在任意位置；显式 BASE 只能属于一次 invocation。
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec node "$SCRIPT_DIR/run_transcribe.js" "$@"
