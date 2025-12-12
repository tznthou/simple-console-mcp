#!/bin/bash
# Start Chrome with CDP enabled for simple-console-mcp
# Usage: ./bin/start-chrome.sh [port]

PORT=${1:-9222}

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
