#!/data/data/com.termux/files/usr/bin/bash
set -e
pkg update -y
pkg upgrade -y
pkg install -y python ffmpeg git curl
pip install --upgrade yt-dlp flask
if [ ! -d "$HOME/storage" ]; then
  termux-setup-storage
fi
echo
echo "Installed. Start the app with: bash run.sh"
