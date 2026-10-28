# Playlist Cutter

Trim the intro and outro of every video in a YouTube playlist and merge them into one MP4, from your Android phone.

## Install (once)

1. Install Termux from F-Droid (not the Play Store).
2. Copy `playlist-cutter.zip` to your phone's Download folder.
3. In Termux:

```
termux-setup-storage
pkg install -y unzip
unzip ~/storage/downloads/playlist-cutter.zip -d ~
cd ~/playlist-cutter
bash install.sh
```

## Run

```
cd ~/playlist-cutter
bash run.sh
```

The app opens in your browser at http://localhost:8080. Keep Termux running while you use it.
For long jobs, tap "Acquire wakelock" in the Termux notification so Android doesn't stop it (the app also requests one while processing).

When YouTube changes something and downloads start failing, update yt-dlp:

```
bash run.sh --update
```

## Where files go

- Merged videos: `Download/PlaylistCutter/`
- Saved projects: `~/.playlist-cutter/projects/`
- Temporary downloads: `~/.playlist-cutter/work/` (deleted after a successful merge unless "Keep downloaded files" is on)

If processing stops halfway, press Process again: finished videos are reused.
