# Playlist Cutter

Trim the intro and outro of every video in a YouTube playlist and merge them into one MP4, from your Android phone.

## Install on the phone (once)

Install Termux from F-Droid, then in Termux:

```
termux-setup-storage
pkg install -y git
git clone https://github.com/FahmiChaar/playlist-cutter ~/playlist-cutter
cd ~/playlist-cutter
bash install.sh
```

## Run

```
bash ~/playlist-cutter/run.sh
```

Each launch pulls the latest version from GitHub, updates yt-dlp once a week, then opens the app at http://localhost:8080.
To force a yt-dlp update right away: `bash run.sh --update`.

## Home-screen shortcut

Install Termux:Widget from F-Droid, then:

```
mkdir -p ~/.shortcuts
cat > ~/.shortcuts/playlist-cutter <<'SH'
#!/data/data/com.termux/files/usr/bin/bash
if curl -s -o /dev/null http://localhost:8080; then
  termux-open-url http://localhost:8080
else
  bash ~/playlist-cutter/run.sh
fi
SH
chmod +x ~/.shortcuts/playlist-cutter
```

## Develop

Push to `main` from your computer. GitHub Actions runs `tests/smoke.sh`, which cuts and merges generated test videos with a fake yt-dlp and checks that Precise mode keeps audio and video in sync. The phone picks up the change on its next launch.

## Where files go

- Merged videos: `Download/PlaylistCutter/`
- Saved projects: `~/.playlist-cutter/projects/`
- Temporary downloads: `~/.playlist-cutter/work/`, deleted after a successful merge unless "Keep downloaded files" is on

If processing stops halfway, press Process again: finished videos are reused.
