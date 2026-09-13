#!/bin/bash
# Standalone compatibility entry; --resume continues the saved task.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec node "$SCRIPT_DIR/volcengine_transcribe.js" flash "$@"
