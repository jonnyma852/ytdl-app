# ytdl-app

A self-hosted local web app for downloading YouTube videos and YouTube Music audio at the highest available quality (up to 256kbps AAC). Runs entirely on your Mac — no cloud, no accounts, no ads.

---

## What it does

- **YouTube** — download any video in up to 4K, or extract audio in MP3/M4A/FLAC/Opus/WAV. Select quality and format before downloading.
- **YouTube Music** — paste a track, album, or playlist link. The app checks whether 256kbps AAC is available for that specific track, shows you the result, and downloads the highest available quality with metadata and album art embedded.

Paste any YouTube or YouTube Music link into the same input — the app auto-detects which mode to use.

---

## Prerequisites

Install all of these before running the app.

### 1. Homebrew
```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

### 2. Node.js
```bash
brew install node
```

### 3. yt-dlp
```bash
brew install yt-dlp
```

### 4. ffmpeg
```bash
brew install ffmpeg
```

### 5. deno (required for YouTube JS challenge solving)
```bash
brew install deno
```

### 6. Anaconda Python (or any Python 3.10+)
The app uses Python for the YouTube Music download script. If you don't have Anaconda:
```bash
brew install python@3.10
```
Then update `YTDLP` and `PYTHON` paths in `server.js` and `ytmusic_dl.py` to match your install.

### 7. bgutil PO Token server (required for YouTube Music 256kbps)
```bash
git clone --single-branch --branch 1.3.1 https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git ~/bgutil-ytdlp-pot-provider
cd ~/bgutil-ytdlp-pot-provider/server
npm ci
npx tsc
```

### 8. bgutil yt-dlp plugin
```bash
pip install bgutil-ytdlp-pot-provider
```

---

## Setup

```bash
git clone https://github.com/jonnyma852/ytdl-app.git
cd ytdl-app
npm install
```

---

## YouTube Music cookies (required for 256kbps)

YouTube Music requires authentication cookies to serve 256kbps streams.

1. Install the **[Open Cookies.txt](https://chrome.google.com/webstore/detail/open-cookiestxt/gdocmgbfkjnnpapoeobnolbbkoibbcif)** extension in your browser
2. Go to **music.youtube.com** while logged into your YouTube Premium account
3. Click the extension → Export cookies
4. Save the file to: `ytdl-app/cookies.txt`

> **Note:** Cookies expire every few days. If 256kbps stops showing up, re-export and overwrite `cookies.txt`. The app's status bar will show a red dot when cookies are missing.

---

## Running the app

You need **two terminal tabs**:

**Tab 1 — bgutil PO token server** (keep this running):
```bash
cd ~/bgutil-ytdlp-pot-provider/server && node build/main.js
```

**Tab 2 — the app:**
```bash
cd ytdl-app && npm start
```

Or use the included start script which opens bgutil in a new Terminal window automatically:
```bash
./start.sh
```

Then open **http://localhost:3737** in your browser.

---

## File paths

By default the app expects:
- **cookies.txt** at `~/Documents/SANDBOX/ytdl-app/cookies.txt`
- **yt-dlp** at `/Users/<you>/anaconda3/bin/yt-dlp`
- **python3** at `/Users/<you>/anaconda3/bin/python3`

If your setup is different, update these at the top of `server.js` and `ytmusic_dl.py`.

---

## Downloads saved to

| Type | Location |
|------|----------|
| YouTube videos | `~/Downloads/ytdl/` |
| YouTube Music tracks | `~/Downloads/ytdl/YouTube Music/Artist - Album/` |

---

## Architecture

```
ytdl-app/
├── server.js          # Express backend — handles all download logic
├── ytmusic_dl.py      # Python script — YouTube Music downloads via yt-dlp
├── public/
│   └── index.html     # Single-page frontend
├── cookies.txt        # Your YouTube cookies (not committed to git)
├── start.sh           # Convenience startup script
└── package.json
```

The backend uses `yt-dlp` as a subprocess. For YouTube Music, it uses the `web_music` player client which requires a GVS PO token — this is generated automatically by the bgutil HTTP server running at `localhost:4416`.

---

## Troubleshooting

**"bgutil offline" status pill** — start the bgutil server in a separate terminal tab (see Running section above)

**256kbps not showing up** — re-export `cookies.txt` from a fresh browser session on music.youtube.com

**"Format not available" error** — the track may genuinely not have a 256kbps stream. Not all YouTube Music tracks are mastered at 256kbps regardless of Premium status.

**yt-dlp errors** — keep yt-dlp updated: `brew upgrade yt-dlp`

---

## Legal

This tool is for personal use only. Respect the terms of service of YouTube and YouTube Music. Do not distribute downloaded content.
