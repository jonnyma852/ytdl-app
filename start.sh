#!/bin/bash
# ytdl-app startup script
# Opens bgutil PO token server in a new Terminal window, then starts the app

echo "🚀 Starting ytdl-app..."

# Kill any existing bgutil instance
pkill -f "bgutil-ytdlp-pot-provider/server/build/main.js" 2>/dev/null

# Open bgutil server in a new Terminal window
osascript -e 'tell application "Terminal" to do script "echo \"🔑 bgutil PO token server\" && cd ~/bgutil-ytdlp-pot-provider/server && node build/main.js"'

echo "⏳ Waiting for bgutil server..."
sleep 3

if curl -s --max-time 2 http://127.0.0.1:4416/ping > /dev/null 2>&1; then
  echo "✓ bgutil server running"
else
  echo "⚠ bgutil may still be starting — check the other Terminal window"
fi

echo "🎬 Starting app at http://localhost:3737"
cd "$(dirname "$0")"
npm start
