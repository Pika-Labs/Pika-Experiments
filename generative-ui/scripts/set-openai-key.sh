#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT_DIR/.env"

printf "Paste your OpenAI API key. Input will be hidden.\n"
read -r -s OPENAI_KEY
printf "\n"

if [[ -z "$OPENAI_KEY" ]]; then
  printf "No key entered. .env was not changed.\n" >&2
  exit 1
fi

cat > "$ENV_FILE" <<EOF
OPENAI_API_KEY=$OPENAI_KEY
OPENAI_REALTIME_MODEL=gpt-realtime-2
PIKA_MCP_URL=https://mcp.pika.me/api/mcp
PORT=3000
EOF

chmod 600 "$ENV_FILE"
printf "Saved %s with restricted permissions.\n" "$ENV_FILE"
