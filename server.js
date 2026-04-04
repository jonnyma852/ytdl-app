const express = require('express');
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const app = express();
const PORT = 3737;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const ENV = {
  ...process.env,
  PATH: [process.env.PATH, '/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin',
    path.join(os.homedir(), 'anaconda3/bin'),
  ].join(':')
};

function findBin(name) {
  try { return execSync(`which ${name}`, { env: ENV }).toString().trim(); } catch {}
  for (const c of [`/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`, path.join(os.homedir(), `anaconda3/bin/${name}`)]) {
    if (fs.existsSync(c)) return c;
  }
  return name;
}

const jobs = {};
function makeJobId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

const YTDLP = () => findBin('yt-dlp');
const PYTHON = () => findBin('python3');
const YTMUSIC_SCRIPT = path.join(__dirname, 'ytmusic_dl.py');
const COOKIES_PATH = path.join(os.homedir(), 'Documents/SANDBOX/ytdl-app/cookies.txt');

function isYTMusic(url) {
  return url.includes('music.youtube.com');
}

function isPlaylist(url) {
  return url.includes('playlist?list=') || url.includes('browse/') || 
         (url.includes('list=') && !url.includes('watch?v='));
}

// GET /api/status
app.get('/api/status', (req, res) => {
  let ytdlpVersion = null, bgutilRunning = false;
  try { ytdlpVersion = execSync(`${YTDLP()} --version`, { env: ENV }).toString().trim(); } catch {}
  try { execSync('curl -s --max-time 1 http://127.0.0.1:4416/ping', { timeout: 2000 }); bgutilRunning = true; } catch {}
  const cookiesOk = fs.existsSync(COOKIES_PATH);
  res.json({ ytdlp: { available: !!ytdlpVersion, version: ytdlpVersion }, bgutil: bgutilRunning, cookies: cookiesOk });
});

// POST /api/fetch — unified info fetch, auto-detects YouTube Music
app.post('/api/fetch', (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL required' });

  const bin = YTDLP();
  const music = isYTMusic(url);
  const hasCookies = fs.existsSync(COOKIES_PATH);

  if (music) {
    // For playlists/albums — check first track for 256kbps availability
    if (isPlaylist(url)) {
      // Get first track URL from playlist
      let firstTrackArgs = ['--flat-playlist', '--dump-json', '--playlist-end', '1', '--no-warnings'];
      if (hasCookies) firstTrackArgs = ['--cookies', COOKIES_PATH, ...firstTrackArgs];
      firstTrackArgs.push(url.split('&si=')[0]);

      const flatProc = spawn(bin, firstTrackArgs, { env: ENV });
      let flatOut = '', flatErr = '';
      flatProc.stdout.on('data', d => flatOut += d);
      flatProc.stderr.on('data', d => flatErr += d);

      flatProc.on('close', () => {
        let firstUrl = null, title = 'Album / Playlist', thumbnail = null, uploader = null;
        try {
          const firstEntry = JSON.parse(flatOut.split('\n').filter(Boolean)[0]);
          firstUrl = `https://music.youtube.com/watch?v=${firstEntry.id}`;
          title = firstEntry.playlist_title || firstEntry.title || 'Album / Playlist';
          thumbnail = firstEntry.thumbnail || firstEntry.thumbnails?.[0]?.url;
          uploader = firstEntry.uploader || firstEntry.channel;
        } catch {}

        if (!firstUrl) {
          // Fallback — no format check possible
          return res.json({ isMusic: true, isPlaylist: true, title, thumbnail, uploader,
            has256: null, bestKbps: 0, bestItag: '141', audioFormats: [] });
        }

        // Check formats on first track
        let checkArgs = [
          '--extractor-args', 'youtube:player_client=web_music',
          '--remote-components', 'ejs:github',
          '--dump-json', '--no-playlist',
        ];
        if (hasCookies) checkArgs = ['--cookies', COOKIES_PATH, ...checkArgs];
        checkArgs.push(firstUrl);

        const checkProc = spawn(bin, checkArgs, { env: ENV });
        let checkOut = '';
        checkProc.stdout.on('data', d => checkOut += d);
        checkProc.on('close', () => {
          try {
            const info = JSON.parse(checkOut);
            const audioFormats = (info.formats || [])
              .filter(f => f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none'))
              .map(f => ({ id: f.format_id, ext: f.ext, kbps: Math.round(f.abr || 0) }))
              .sort((a, b) => b.kbps - a.kbps)
              .filter((f, i, arr) => i === 0 || f.kbps !== arr[i-1].kbps);

            const has256 = audioFormats.some(f => f.kbps >= 200);
            const best256 = audioFormats.find(f => f.id === '141') || audioFormats.find(f => f.kbps >= 200);
            const bestAudio = audioFormats[0];

            res.json({
              isMusic: true, isPlaylist: true, title, thumbnail, uploader,
              has256, bestKbps: bestAudio?.kbps || 0,
              bestItag: has256 ? (best256?.id || '141') : (bestAudio?.id || '140'),
              audioFormats: audioFormats.slice(0, 6),
            });
          } catch {
            res.json({ isMusic: true, isPlaylist: true, title, thumbnail, uploader,
              has256: null, bestKbps: 0, bestItag: '141', audioFormats: [] });
          }
        });
      });
      return; // response sent inside callbacks above
    }

    // For YouTube Music single tracks: check formats using web_music client
    let args = [
      '--extractor-args', 'youtube:player_client=web_music',
      '--remote-components', 'ejs:github',
      '--dump-json', '--no-playlist',
    ];
    if (hasCookies) args = ['--cookies', COOKIES_PATH, ...args];
    args.push(url.split('&')[0]);

    const proc = spawn(bin, args, { env: ENV });
    let stdout = '', stderr = '';
    proc.stdout.on('data', d => stdout += d);
    proc.stderr.on('data', d => stderr += d);
    proc.on('close', code => {
      if (code !== 0) return res.status(400).json({ error: 'Could not fetch info', detail: stderr });
      try {
        const info = JSON.parse(stdout);
        const audioFormats = (info.formats || [])
          .filter(f => f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none'))
          .map(f => ({ id: f.format_id, ext: f.ext, kbps: Math.round(f.abr || 0), acodec: f.acodec }))
          .sort((a, b) => b.kbps - a.kbps)
          .filter((f, i, arr) => i === 0 || f.kbps !== arr[i-1].kbps); // dedupe by kbps

        const has256 = audioFormats.some(f => f.kbps >= 200);
        const bestAudio = audioFormats[0];
        // Prefer 141 (AAC/M4A) over 774 (Opus/WebM) — M4A supports thumbnail embedding
        const best256 = audioFormats.find(f => f.id === '141') || audioFormats.find(f => f.kbps >= 200);

        res.json({
          isMusic: true,
          title: info.title,
          thumbnail: info.thumbnail,
          duration: info.duration,
          uploader: info.uploader,
          has256,
          bestKbps: bestAudio?.kbps || 0,
          bestItag: has256 ? (best256?.id || '141') : (bestAudio?.id || '140'),
          audioFormats: audioFormats.slice(0, 6),
        });
      } catch(e) { res.status(500).json({ error: 'Parse error', detail: e.message }); }
    });

  } else {
    // Regular YouTube: standard dump-json
    const proc = spawn(bin, ['--dump-json', '--no-playlist', url], { env: ENV });
    let stdout = '', stderr = '';
    proc.stdout.on('data', d => stdout += d);
    proc.stderr.on('data', d => stderr += d);
    proc.on('close', code => {
      if (code !== 0) return res.status(400).json({ error: 'Could not fetch info', detail: stderr });
      try {
        const info = JSON.parse(stdout);
        const videoFormats = [], audioFormats = [];
        (info.formats || []).forEach(f => {
          const hasVideo = f.vcodec && f.vcodec !== 'none';
          const hasAudio = f.acodec && f.acodec !== 'none';
          if (hasVideo && !hasAudio && f.height) {
            videoFormats.push({ format_id: f.format_id, ext: f.ext, height: f.height, fps: f.fps,
              label: `${f.height}p${f.fps ? ` ${Math.round(f.fps)}fps` : ''} · ${f.ext.toUpperCase()}` });
          } else if (hasAudio && !hasVideo) {
            audioFormats.push({ format_id: f.format_id, ext: f.ext, abr: f.abr, acodec: f.acodec,
              label: `${f.abr ? Math.round(f.abr) + 'kbps' : '?kbps'} · ${f.ext.toUpperCase()}` });
          }
        });
        const seenV = new Set();
        const uniqueVideo = videoFormats.sort((a,b) => b.height - a.height)
          .filter(f => { const k=`${f.height}-${f.ext}`; if(seenV.has(k))return false; seenV.add(k); return true; });
        const seenA = new Set();
        const uniqueAudio = audioFormats.sort((a,b) => (b.abr||0)-(a.abr||0))
          .filter(f => { const k=`${Math.round(f.abr||0)}-${f.ext}`; if(seenA.has(k))return false; seenA.add(k); return true; });
        res.json({ isMusic: false, title: info.title, thumbnail: info.thumbnail, duration: info.duration,
          uploader: info.uploader, view_count: info.view_count, videoFormats: uniqueVideo, audioFormats: uniqueAudio });
      } catch(e) { res.status(500).json({ error: 'Parse error', detail: e.message }); }
    });
  }
});

// POST /api/download — regular YouTube download
app.post('/api/download', (req, res) => {
  const { url, videoFormat, audioOutputFormat, audioSourceFormat, audioOnly } = req.body;
  if (!url) return res.status(400).json({ error: 'URL required' });

  const jobId = makeJobId();
  const job = { id: jobId, status: 'running', percent: 0, speed: '', eta: '', size: '', logs: [], statusMsg: '' };
  jobs[jobId] = job;

  const downloadDir = path.join(os.homedir(), 'Downloads', 'ytdl');
  if (!fs.existsSync(downloadDir)) fs.mkdirSync(downloadDir, { recursive: true });

  const bin = YTDLP();
  let args = ['--no-playlist', '--newline', '-o', path.join(downloadDir, '%(title)s.%(ext)s')];
  if (audioOnly) {
    args.push('-f', audioSourceFormat || 'bestaudio');
    args.push('-x', '--audio-format', audioOutputFormat || 'mp3');
  } else {
    args.push('-f', videoFormat ? `${videoFormat}+bestaudio/best` : 'bestvideo+bestaudio/best');
    args.push('--merge-output-format', 'mp4');
  }
  args.push(url);
  job.logs.push(`▶ yt-dlp ${args.join(' ')}`);

  const proc = spawn(bin, args, { env: ENV });
  proc.stdout.on('data', chunk => {
    chunk.toString().split('\n').filter(Boolean).forEach(line => {
      job.logs.push(line);
      if (job.logs.length > 200) job.logs.shift();
      const m = line.match(/\[download\]\s+([\d.]+)%\s+of\s+~?([\d.]+\s*\S+)\s+at\s+([\d.]+\s*\S+\/s)\s+ETA\s+(\S+)/);
      if (m) { job.percent = parseFloat(m[1]); job.size = m[2]; job.speed = m[3]; job.eta = m[4]; }
      else if (line.includes('[Merger]')) job.statusMsg = 'Merging...';
      else if (line.includes('[download] Destination:')) job.statusMsg = 'Downloading: ' + path.basename(line.split('Destination:')[1].trim());
    });
  });
  proc.stderr.on('data', chunk => { chunk.toString().split('\n').forEach(l => { if (l.trim()) job.logs.push('⚠ ' + l.trim()); }); });
  proc.on('close', code => {
    job.percent = code === 0 ? 100 : job.percent;
    job.status = code === 0 ? 'done' : 'error';
    job.statusMsg = code === 0 ? 'Saved to ~/Downloads/ytdl/' : `Failed (exit ${code})`;
    job.logs.push(code === 0 ? '✓ Done!' : `✗ Failed (exit ${code})`);
  });
  setTimeout(() => { delete jobs[jobId]; }, 10 * 60 * 1000);
  res.json({ jobId });
});

// POST /api/ytmusic — YouTube Music download
app.post('/api/ytmusic', (req, res) => {
  const { url, itag, outputFormat } = req.body;
  if (!url) return res.status(400).json({ error: 'URL required' });

  const jobId = makeJobId();
  const job = { id: jobId, status: 'running', percent: 0, speed: '', eta: '', size: '', logs: [], statusMsg: 'Starting...' };
  jobs[jobId] = job;

  const python = PYTHON();
  const args = [YTMUSIC_SCRIPT, url, itag || '141', outputFormat || 'm4a'];
  job.logs.push(`▶ Downloading via ytmusic_dl.py [itag=${itag || '141'}, format=${outputFormat || 'm4a'}]`);

  const proc = spawn(python, args, { env: ENV });
  proc.stdout.on('data', chunk => {
    chunk.toString().split('\n').filter(Boolean).forEach(line => {
      job.logs.push(line);
      if (job.logs.length > 300) job.logs.shift();
      const m = line.match(/\[download\]\s+([\d.]+)%\s+of\s+~?([\d.]+\s*\S+)\s+at\s+([\d.]+\s*\S+\/s)\s+ETA\s+(\S+)/);
      if (m) { job.percent = parseFloat(m[1]); job.size = m[2]; job.speed = m[3]; job.eta = m[4]; }
      else if (line.includes('[download] Destination:')) { job.statusMsg = 'Downloading: ' + path.basename(line.split('Destination:')[1].trim()); if (job.percent === 0) job.percent = 5; }
      else if (line.includes('[pot:bgutil:http]')) { job.statusMsg = 'Authenticating...'; job.percent = 10; }
      else if (line.includes('[jsc:deno]')) { job.statusMsg = 'Solving JS challenge...'; job.percent = 15; }
      else if (line.includes('[FixupM4a]')) { job.statusMsg = 'Fixing container...'; job.percent = 95; }
      else if (line.includes('[Metadata]')) { job.statusMsg = 'Adding metadata...'; job.percent = 97; }
      else if (line.includes('[EmbedThumbnail]')) { job.statusMsg = 'Embedding artwork...'; job.percent = 99; }
    });
  });
  proc.stderr.on('data', chunk => { chunk.toString().split('\n').forEach(l => { if (l.trim()) job.logs.push('⚠ ' + l.trim()); }); });
  proc.on('close', code => {
    job.percent = code === 0 ? 100 : job.percent;
    job.status = code === 0 ? 'done' : 'error';
    job.statusMsg = code === 0 ? 'Saved to ~/Downloads/ytdl/YouTube Music/' : `Failed (exit ${code})`;
    job.logs.push(code === 0 ? '✓ Done!' : `✗ Failed (exit ${code})`);
  });
  setTimeout(() => { delete jobs[jobId]; }, 15 * 60 * 1000);
  res.json({ jobId });
});

// GET /api/job/:id
app.get('/api/job/:id', (req, res) => {
  const job = jobs[req.params.id];
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

app.listen(PORT, () => {
  console.log(`\n🎬 ytdl running at http://localhost:${PORT}`);
  console.log(`   yt-dlp:  ${YTDLP()}`);
  console.log(`   cookies: ${fs.existsSync(COOKIES_PATH) ? '✓' : '✗'} ${COOKIES_PATH}`);
});
