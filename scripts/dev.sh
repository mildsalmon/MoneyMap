#!/usr/bin/env bash
# MoneyMap 기동 스크립트 (D17-eng: 실행은 front/back 분리, 켜고 끄는 건 명령 하나)
# 사용: scripts/dev.sh   — Ctrl+C 한 번이면 두 프로세스가 함께 종료된다.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

trap 'kill 0' EXIT INT TERM

echo "▶ backend: http://127.0.0.1:8765 (API 문서: /docs)"
(cd "$ROOT/backend" && uv run uvicorn moneymap.api:app --port 8765 --reload) &

if [ -d "$ROOT/frontend" ]; then
  echo "▶ frontend: http://127.0.0.1:5173"
  (cd "$ROOT/frontend" && npm run dev) &
else
  echo "· frontend/ 가 아직 없어 백엔드만 기동합니다"
fi

wait
