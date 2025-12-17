#!/bin/bash
# Start Chrome with CDP enabled for simple-console-mcp
# Usage: ./bin/start-chrome.sh [port]

PORT=${1:-9222}

# 驗證 port 必須是 1024-65535 的整數，防止命令注入
if ! [[ "$PORT" =~ ^[0-9]+$ ]]; then
  echo "Error: Port must be a number. Got: $PORT"
  exit 1
fi

if [ "$PORT" -lt 1024 ] || [ "$PORT" -gt 65535 ]; then
  echo "Error: Port must be between 1024 and 65535. Got: $PORT"
  exit 1
fi

echo "Starting Chrome with CDP on port $PORT..."

# macOS
if [[ "$OSTYPE" == "darwin"* ]]; then
  /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
    --remote-debugging-port=$PORT \
    --no-first-run \
    --no-default-browser-check \
    "$@"
# Linux
elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
  google-chrome \
    --remote-debugging-port=$PORT \
    --no-first-run \
    --no-default-browser-check \
    "$@"
# Windows (Git Bash / WSL)
else
  echo "Please start Chrome manually with: --remote-debugging-port=$PORT"
fi
