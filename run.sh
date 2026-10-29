#!/data/data/com.termux/files/usr/bin/bash
main() {
  cd "$(dirname "$0")" || exit 1
  local port="${PORT:-8080}"
  local stamp="$HOME/.playlist-cutter/.yt-dlp-updated"

  if [ -d .git ]; then
    echo "Checking for app updates..."
    timeout 20 git pull --ff-only --quiet || echo "App update skipped (offline or local changes)."
  fi

  if [ "$1" = "--update" ] || [ -z "$(find "$stamp" -mtime -7 2>/dev/null)" ]; then
    echo "Updating yt-dlp..."
    pip install --upgrade --quiet yt-dlp && mkdir -p "$(dirname "$stamp")" && touch "$stamp"
  fi

  (sleep 2 && termux-open-url "http://localhost:$port") &
  exec python app.py --port "$port"
}
main "$@"
