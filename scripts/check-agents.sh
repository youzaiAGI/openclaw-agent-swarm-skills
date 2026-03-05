#!/usr/bin/env bash
set -euo pipefail
python3 /root/openclaw-skills/openclaw-agent-swarm/scripts/swarm.py check --changes-only
