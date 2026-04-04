#!/usr/bin/env python3
"""
ytmusic_dl.py — YouTube Music downloader via yt-dlp + bgutil
Requires bgutil server: node ~/bgutil-ytdlp-pot-provider/server/build/main.js
Usage: python3 ytmusic_dl.py <url> [itag] [outputFormat]
"""

import sys, os, subprocess
from pathlib import Path

COOKIES = "/Users/metic/Documents/SANDBOX/ytdl-app/cookies.txt"
OUTPUT  = str(Path.home() / "Downloads" / "ytdl" / "YouTube Music")
YTDLP   = "/Users/metic/anaconda3/bin/yt-dlp"

def download(url, itag="141", output_format="m4a"):
    Path(OUTPUT).mkdir(parents=True, exist_ok=True)

    if itag == "bestaudio":
        fmt = "bestaudio[ext=m4a]/bestaudio"
    elif itag == "774":
        fmt = "774/bestaudio[ext=webm]/bestaudio"
    else:
        fmt = f"{itag}/141/140/bestaudio[ext=m4a]/bestaudio"

    needs_extract = itag == "774" or output_format in ('mp3', 'opus', 'flac', 'ogg')

    out_tmpl = os.path.join(OUTPUT,
        "%(album_artist|%(artist)s)s - %(album|%(title)s)s",
        "%(track_number|)s%(track_number& - |)s%(title)s.%(ext)s"
    )

    base_args = [
        YTDLP,
        "--cookies", COOKIES,
        "--extractor-args", "youtube:player_client=web_music",
        "--remote-components", "ejs:github",
        "-f", fmt,
        "--add-metadata",
        "--embed-thumbnail",
        "--convert-thumbnails", "jpg",
        "--newline",
        "-o", out_tmpl,
        "--output-na-placeholder", "",
    ]

    if needs_extract:
        base_args += ["-x", "--audio-format", output_format]
    else:
        base_args += ["--postprocessor-args", "EmbedThumbnail:-disposition:v attached_pic"]

    base_args.append(url)

    print(f"▶ {url}  [itag={itag}, format={output_format}]", flush=True)
    result = subprocess.run(base_args)
    return result.returncode == 0

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python3 ytmusic_dl.py <url> [itag] [outputFormat]")
        sys.exit(1)
    url           = sys.argv[1]
    itag          = sys.argv[2] if len(sys.argv) > 2 else "141"
    output_format = sys.argv[3] if len(sys.argv) > 3 else "m4a"
    sys.exit(0 if download(url, itag, output_format) else 1)
