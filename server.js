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
const BGUTIL_SERVER = path.join(os.homedir(), 'bgutil-ytdlp-pot-provider/server/build/main.js');
const APP_URL = `http://localhost:${PORT}`;

function isYTMusic(url) { return url.includes('music.youtube.com'); }
function isPlaylist(url) {
  return url.includes('playlist?list=') || url.includes('browse/') ||
         (url.includes('list=') && !url.includes('watch?v='));
}
function isBgutilRunning() {
  try { execSync('curl -s --max-time 1 http://127.0.0.1:4416/ping', { timeout: 2000 }); return true; } catch { return false; }
}

// ── Auto-start bgutil as a child of this process ──────────────────────────────
let bgutilProc = null;

function startBgutilChild() {
  if (!fs.existsSync(BGUTIL_SERVER)) {
    console.log('   bgutil:  ✗ not found at ' + BGUTIL_SERVER);
    return;
  }
  if (isBgutilRunning()) {
    console.log('   bgutil:  ✓ already running on :4416');
    return;
  }
  const node = findBin('node');
  bgutilProc = spawn(node, [BGUTIL_SERVER], { env: ENV, stdio: ['ignore', 'pipe', 'pipe'] });
  bgutilProc.on('error', e => console.error('   bgutil:  ✗ failed to start:', e.message));
  bgutilProc.on('exit', code => { if (code !== 0 && code !== null) console.warn(`   bgutil:  exited (${code})`); bgutilProc = null; });
  let waited = 0;
  const check = setInterval(() => {
    waited += 500;
    if (isBgutilRunning()) { clearInterval(check); console.log('   bgutil:  ✓ running on :4416'); }
    else if (waited >= 8000) { clearInterval(check); console.warn('   bgutil:  ✗ did not start within 8s'); }
  }, 500);
}

process.on('exit', () => { if (bgutilProc) bgutilProc.kill(); });
process.on('SIGINT', () => process.exit());
process.on('SIGTERM', () => process.exit());
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/status
app.get('/api/status', (req, res) => {
  let ytdlpVersion = null;
  try { ytdlpVersion = execSync(`${YTDLP()} --version`, { env: ENV }).toString().trim(); } catch {}
  const bgutil = isBgutilRunning();
  const cookiesOk = fs.existsSync(COOKIES_PATH);
  let cookiesAge = null;
  if (cookiesOk) {
    const ageHours = (Date.now() - fs.statSync(COOKIES_PATH).mtimeMs) / 1000 / 3600;
    cookiesAge = Math.round(ageHours);
  }
  res.json({ ytdlp: { available: !!ytdlpVersion, version: ytdlpVersion }, bgutil, cookies: cookiesOk, cookiesAge });
});

const ARC_COOKIE_SCRIPT = path.join(__dirname, 'arc_cookie_export.py');

function findArcProfile() {
  const arcBase = path.join(os.homedir(), 'Library/Application Support/Arc/User Data');
  for (const profile of ['Default', 'Profile 1', 'Profile 2']) {
    const profilePath = path.join(arcBase, profile);
    if (fs.existsSync(path.join(profilePath, 'Cookies'))) return profilePath;
  }
  return null;
}

// POST /api/refresh-cookies — extract cookies from browser store
// Arc requires special handling: it uses "Arc Safe Storage" in macOS Keychain,
// not "Chrome Safe Storage". yt-dlp's --cookies-from-browser chrome uses Chrome's
// key, silently dropping 1400+ Arc cookies including LOGIN_INFO (Premium auth).
// We patch yt-dlp's keyring lookup via arc_cookie_export.py instead.
app.post('/api/refresh-cookies', (req, res) => {
  const requestedBrowser = req.body.browser || 'arc';

  // Ensure output directory exists
  const dir = path.dirname(COOKIES_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  let proc, stderr = '';

  if (requestedBrowser === 'arc') {
    // Arc: use our Python exporter that patches yt-dlp to use Arc's Keychain key
    const arcProfile = findArcProfile();
    const args = arcProfile
      ? [ARC_COOKIE_SCRIPT, COOKIES_PATH, arcProfile]
      : [ARC_COOKIE_SCRIPT, COOKIES_PATH];
    proc = spawn(PYTHON(), args, { env: ENV });
  } else {
    // Other browsers: use yt-dlp's built-in extraction
    const bin = YTDLP();
    proc = spawn(bin, [
      '--cookies-from-browser', requestedBrowser,
      '--cookies', COOKIES_PATH,
      '--skip-download', '--quiet',
      'https://music.youtube.com/watch?v=dQw4w9WgXcQ',
    ], { env: ENV });
  }

  let stdout = '';
  proc.stdout?.on('data', d => stdout += d);
  proc.stderr.on('data', d => stderr += d);
  proc.on('close', () => {
    if (fs.existsSync(COOKIES_PATH)) {
      const content = fs.readFileSync(COOKIES_PATH, 'utf8');
      const allLines = content.split('\n').filter(l => l && !l.startsWith('#'));
      const ytLines = allLines.filter(l => l.includes('youtube.com'));
      if (allLines.length > 0) {
        return res.json({ ok: true, cookieCount: allLines.length, ytCookieCount: ytLines.length });
      }
    }
    res.status(500).json({
      ok: false,
      error: (stderr + stdout).trim() || 'No cookies written — make sure you are logged into music.youtube.com in Arc',
    });
  });
});

// POST /api/fetch — unified info fetch, auto-detects YouTube Music
app.post('/api/fetch', (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL required' });

  const bin = YTDLP();
  const music = isYTMusic(url);
  const hasCookies = fs.existsSync(COOKIES_PATH);

  if (music) {
    if (isPlaylist(url)) {
      let firstTrackArgs = ['--flat-playlist', '--dump-json', '--playlist-end', '1', '--no-warnings'];
      if (hasCookies) firstTrackArgs = ['--cookies', COOKIES_PATH, ...firstTrackArgs];
      firstTrackArgs.push(url.split('&si=')[0]);

      const flatProc = spawn(bin, firstTrackArgs, { env: ENV });
      let flatOut = '';
      flatProc.stdout.on('data', d => flatOut += d);
      flatProc.on('close', () => {
        let firstUrl = null, title = 'Album / Playlist', thumbnail = null, uploader = null;
        try {
          const e = JSON.parse(flatOut.split('\n').filter(Boolean)[0]);
          firstUrl = `https://music.youtube.com/watch?v=${e.id}`;
          title = e.playlist_title || e.title || 'Album / Playlist';
          thumbnail = e.thumbnail || e.thumbnails?.[0]?.url;
          uploader = e.uploader || e.channel;
        } catch {}

        if (!firstUrl) return res.json({ isMusic: true, isPlaylist: true, title, thumbnail, uploader, has256: null, bestKbps: 0, bestItag: '141', audioFormats: [] });

        let checkArgs = ['--extractor-args', 'youtube:player_client=web_music', '--remote-components', 'ejs:github', '--dump-json', '--no-playlist'];
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
              .filter((f, i, arr) => i === 0 || f.kbps !== arr[i - 1].kbps);
            const has256 = audioFormats.some(f => f.kbps >= 200);
            const best256 = audioFormats.find(f => f.id === '141') || audioFormats.find(f => f.kbps >= 200);
            const bestAudio = audioFormats[0];
            res.json({ isMusic: true, isPlaylist: true, title, thumbnail, uploader, has256, bestKbps: bestAudio?.kbps || 0, bestItag: has256 ? (best256?.id || '141') : (bestAudio?.id || '140'), audioFormats: audioFormats.slice(0, 6) });
          } catch {
            res.json({ isMusic: true, isPlaylist: true, title, thumbnail, uploader, has256: null, bestKbps: 0, bestItag: '141', audioFormats: [] });
          }
        });
      });
      return;
    }

    let args = ['--extractor-args', 'youtube:player_client=web_music', '--remote-components', 'ejs:github', '--dump-json', '--no-playlist'];
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
          .filter((f, i, arr) => i === 0 || f.kbps !== arr[i - 1].kbps);
        const has256 = audioFormats.some(f => f.kbps >= 200);
        const best256 = audioFormats.find(f => f.id === '141') || audioFormats.find(f => f.kbps >= 200);
        const bestAudio = audioFormats[0];
        res.json({ isMusic: true, title: info.title, thumbnail: info.thumbnail, duration: info.duration, uploader: info.uploader, has256, bestKbps: bestAudio?.kbps || 0, bestItag: has256 ? (best256?.id || '141') : (bestAudio?.id || '140'), audioFormats: audioFormats.slice(0, 6) });
      } catch (e) { res.status(500).json({ error: 'Parse error', detail: e.message }); }
    });

  } else {
    const ytArgs = ['--dump-json', '--no-playlist'];
    if (hasCookies) ytArgs.push('--cookies', COOKIES_PATH);
    ytArgs.push(url);
    const proc = spawn(bin, ytArgs, { env: ENV });
    let stdout = '', stderr = '';
    proc.stdout.on('data', d => stdout += d);
    proc.stderr.on('data', d => stderr += d);
    proc.on('close', code => {
      if (code !== 0) return res.status(400).json({ error: 'Could not fetch info', detail: stderr });
      try {
        const info = JSON.parse(stdout);
        const videoFormats = [], audioFormats = [];
        (info.formats || []).forEach(f => {
          const hv = f.vcodec && f.vcodec !== 'none', ha = f.acodec && f.acodec !== 'none';
          if (hv && !ha && f.height) videoFormats.push({ format_id: f.format_id, ext: f.ext, height: f.height, fps: f.fps, label: `${f.height}p${f.fps ? ` ${Math.round(f.fps)}fps` : ''} · ${f.ext.toUpperCase()}` });
          else if (ha && !hv) audioFormats.push({ format_id: f.format_id, ext: f.ext, abr: f.abr, acodec: f.acodec, label: `${f.abr ? Math.round(f.abr) + 'kbps' : '?kbps'} · ${f.ext.toUpperCase()}` });
        });
        const seenV = new Set(), seenA = new Set();
        const uV = videoFormats.sort((a, b) => b.height - a.height).filter(f => { const k = `${f.height}-${f.ext}`; if (seenV.has(k)) return false; seenV.add(k); return true; });
        const uA = audioFormats.sort((a, b) => (b.abr || 0) - (a.abr || 0)).filter(f => { const k = `${Math.round(f.abr || 0)}-${f.ext}`; if (seenA.has(k)) return false; seenA.add(k); return true; });
        res.json({ isMusic: false, title: info.title, thumbnail: info.thumbnail, duration: info.duration, uploader: info.uploader, videoFormats: uV, audioFormats: uA });
      } catch (e) { res.status(500).json({ error: 'Parse error', detail: e.message }); }
    });
  }
});

// POST /api/download — regular YouTube
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
  if (fs.existsSync(COOKIES_PATH)) args.push('--cookies', COOKIES_PATH);
  if (audioOnly) { args.push('-f', audioSourceFormat || 'bestaudio', '-x', '--audio-format', audioOutputFormat || 'mp3'); }
  else { args.push('-f', videoFormat ? `${videoFormat}+bestaudio/best` : 'bestvideo+bestaudio/best', '--merge-output-format', 'mp4'); }
  args.push(url);
  job.logs.push(`▶ yt-dlp ${args.join(' ')}`);
  const proc = spawn(bin, args, { env: ENV });
  proc.stdout.on('data', chunk => {
    chunk.toString().split('\n').filter(Boolean).forEach(line => {
      job.logs.push(line); if (job.logs.length > 200) job.logs.shift();
      const m = line.match(/\[download\]\s+([\d.]+)%\s+of\s+~?([\d.]+\s*\S+)\s+at\s+([\d.]+\s*\S+\/s)\s+ETA\s+(\S+)/);
      if (m) { job.percent = parseFloat(m[1]); job.size = m[2]; job.speed = m[3]; job.eta = m[4]; }
      else if (line.includes('[Merger]')) job.statusMsg = 'Merging...';
      else if (line.includes('[download] Destination:')) job.statusMsg = 'Downloading: ' + path.basename(line.split('Destination:')[1].trim());
    });
  });
  proc.stderr.on('data', chunk => chunk.toString().split('\n').forEach(l => { if (l.trim()) job.logs.push('⚠ ' + l.trim()); }));
  proc.on('close', code => {
    job.percent = code === 0 ? 100 : job.percent; job.status = code === 0 ? 'done' : 'error';
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
  const args = [YTMUSIC_SCRIPT, url, itag || '141', outputFormat || 'm4a'];
  job.logs.push(`▶ Downloading [itag=${itag || '141'}, format=${outputFormat || 'm4a'}]`);
  const proc = spawn(PYTHON(), args, { env: ENV });
  proc.stdout.on('data', chunk => {
    chunk.toString().split('\n').filter(Boolean).forEach(line => {
      job.logs.push(line); if (job.logs.length > 300) job.logs.shift();
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
  proc.stderr.on('data', chunk => chunk.toString().split('\n').forEach(l => { if (l.trim()) job.logs.push('⚠ ' + l.trim()); }));
  proc.on('close', code => {
    job.percent = code === 0 ? 100 : job.percent; job.status = code === 0 ? 'done' : 'error';
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
  console.log(`\n🎬 ytdl running at ${APP_URL}`);
  console.log(`   yt-dlp:  ${YTDLP()}`);
  console.log(`   cookies: ${fs.existsSync(COOKIES_PATH) ? '✓' : '✗'} ${COOKIES_PATH}`);

  // Copy app URL to clipboard — printf avoids the "-n" literal bug with echo -n
  try {
    execSync(`printf '%s' '${APP_URL}' | pbcopy`);
    console.log(`   📋  ${APP_URL} copied to clipboard`);
  } catch {}

  startBgutilChild();
});
