#!/data/data/com.termux/files/usr/bin/bash
cd "$(dirname "$0")"
PORT="${PORT:-8080}"
if [ "$1" = "--update" ]; then
  pip install --upgrade yt-dlp
fi
(sleep 2 && termux-open-url "http://localhost:$PORT") &
exec python app.py --port "$PORT"
