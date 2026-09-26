#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../apps/voice"
python main.py "$@"
