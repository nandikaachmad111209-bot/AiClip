const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const TMP_DIR = path.join(os.tmpdir(), 'achclip-jobs');
fs.mkdirSync(TMP_DIR, { recursive: true });

const MAX_DURATION_SEC = 1500; // 25 menit, sesuai batas aplikasi
const JOB_MAX_AGE_MS = 45 * 60 * 1000; // 45 menit lalu file dihapus otomatis
const POT_PROVIDER_URL = process.env.POT_PROVIDER_URL || '';

/** jobId -> { status, progress, title, duration, error, filePath, thumbDataUrl, createdAt, served } */
const jobs = new Map();

function ytDlpExtractorArgs() {
  const args = [];
  if (POT_PROVIDER_URL) {
    // Dipakai bareng service terpisah "bgutil-ytdlp-pot-provider" biar yt-dlp
    // tidak kena blokir "Sign in to confirm you're not a bot" dari YouTube.
    args.push('--extractor-args', `youtubepot-bgutilhttp:base_url=${POT_PROVIDER_URL}`);
  }
  return args;
}

function runProcess(cmd, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args);
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) {
        const lastLine = stderr.trim().split('\n').filter(Boolean).pop();
        reject(new Error(lastLine || `${cmd} keluar dengan kode ${code}`));
      } else {
        resolve(stdout);
      }
    });
  });
}

async function probeVideo(url) {
  const args = [
    ...ytDlpExtractorArgs(),
    '--no-playlist',
    '--skip-download',
    '--print', '%(title)s|||%(duration)s',
    url
  ];
  const out = await runProcess('yt-dlp', args);
  const lastLine = out.trim().split('\n').filter(Boolean).pop() || '';
  const [title, duration] = lastLine.split('|||');
  return {
    title: (title || 'Video YouTube').trim(),
    duration: parseFloat(duration) || 0
  };
}

function downloadVideo(url, outPathNoExt, onProgress) {
  return new Promise((resolve, reject) => {
    const args = [
      ...ytDlpExtractorArgs(),
      '--no-playlist',
      '--newline',
      '-f', 'bv*[height<=720][ext=mp4]+ba[ext=m4a]/best[height<=720][ext=mp4]/best[height<=720]/best',
      '--merge-output-format', 'mp4',
      '-o', `${outPathNoExt}.%(ext)s`,
      url
    ];
    const proc = spawn('yt-dlp', args);
    let stderrBuf = '';

    proc.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      const m = text.match(/(\d{1,3}(?:\.\d)?)%/);
      if (m) onProgress(Math.min(99, parseFloat(m[1])));
    });
    proc.stderr.on('data', (d) => { stderrBuf += d.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) {
        const lastLine = stderrBuf.trim().split('\n').filter(Boolean).pop();
        return reject(new Error(lastLine || 'yt-dlp gagal mengunduh video.'));
      }
      resolve();
    });
  });
}

function probeDurationFfprobe(filePath) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath
    ]);
    let out = '';
    proc.on('error', reject);
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error('ffprobe gagal membaca durasi.'));
      resolve(parseFloat(out.trim()) || 0);
    });
  });
}

function makeThumbnail(videoPath, thumbPath) {
  return new Promise((resolve) => {
    const proc = spawn('ffmpeg', [
      '-y', '-ss', '1', '-i', videoPath,
      '-frames:v', '1', '-vf', 'scale=320:-1',
      thumbPath
    ]);
    proc.on('close', () => resolve());
    proc.on('error', () => resolve());
  });
}

function findDownloadedFile(outPathNoExt) {
  const dir = path.dirname(outPathNoExt);
  const base = path.basename(outPathNoExt);
  const candidates = fs.readdirSync(dir).filter((f) => f.startsWith(base + '.'));
  if (!candidates.length) return null;
  return path.join(dir, candidates[0]);
}

async function runJob(job, url) {
  const outPathNoExt = path.join(TMP_DIR, job.id);
  const thumbPath = path.join(TMP_DIR, `${job.id}.jpg`);

  try {
    job.status = 'checking';
    const info = await probeVideo(url);
    job.title = info.title;

    if (info.duration && info.duration > MAX_DURATION_SEC) {
      throw new Error(`Video berdurasi ${Math.round(info.duration / 60)} menit, melebihi batas 25 menit.`);
    }
    job.duration = info.duration;

    job.status = 'downloading';
    job.progress = 0;
    await downloadVideo(url, outPathNoExt, (pct) => { job.progress = pct; });

    const finalPath = findDownloadedFile(outPathNoExt);
    if (!finalPath || !fs.existsSync(finalPath)) {
      throw new Error('File hasil unduhan tidak ditemukan di server.');
    }
    job.filePath = finalPath;

    if (!job.duration) {
      job.duration = await probeDurationFfprobe(finalPath).catch(() => 0);
    }

    await makeThumbnail(finalPath, thumbPath);
    if (fs.existsSync(thumbPath)) {
      const buf = fs.readFileSync(thumbPath);
      job.thumbDataUrl = `data:image/jpeg;base64,${buf.toString('base64')}`;
      fs.unlink(thumbPath, () => {});
    }

    job.status = 'ready';
    job.progress = 100;
  } catch (e) {
    job.status = 'error';
    job.error = e.message || String(e);
    if (job.filePath) {
      fs.unlink(job.filePath, () => {});
      job.filePath = null;
    }
  }
}

app.post('/api/youtube/start', (req, res) => {
  const { url } = req.body || {};
  if (!url || !/^https?:\/\/(www\.)?(youtube\.com|youtu\.be|m\.youtube\.com)\//.test(url)) {
    return res.status(400).json({ error: 'URL YouTube tidak valid.' });
  }

  const jobId = crypto.randomUUID();
  const job = {
    id: jobId,
    status: 'checking',
    progress: 0,
    title: null,
    duration: 0,
    error: null,
    filePath: null,
    thumbDataUrl: null,
    createdAt: Date.now(),
    served: false
  };
  jobs.set(jobId, job);
  res.json({ jobId });

  runJob(job, url);
});

app.get('/api/youtube/status/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job tidak ditemukan atau sudah kedaluwarsa.' });
  res.json({
    status: job.status,
    progress: job.progress,
    title: job.title,
    duration: job.duration,
    error: job.error,
    thumbDataUrl: job.thumbDataUrl
  });
});

app.get('/api/youtube/file/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job tidak ditemukan atau sudah kedaluwarsa.' });
  if (job.status !== 'ready' || !job.filePath || !fs.existsSync(job.filePath)) {
    return res.status(409).json({ error: 'Video belum siap.' });
  }

  const stat = fs.statSync(job.filePath);
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Length', stat.size);
  fs.createReadStream(job.filePath).pipe(res);
  job.served = true;
});

app.get('/api/health', (req, res) => res.json({ ok: true, potProvider: !!POT_PROVIDER_URL }));

// Bersihkan job & file lama secara berkala biar disk server tidak penuh
setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs) {
    const isOld = now - job.createdAt > JOB_MAX_AGE_MS;
    const isDoneAndServed = job.status === 'ready' && job.served && (now - job.createdAt > 5 * 60 * 1000);
    if (isOld || isDoneAndServed) {
      if (job.filePath) fs.unlink(job.filePath, () => {});
      jobs.delete(id);
    }
  }
}, 5 * 60 * 1000);

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`achclip backend listening on port ${PORT}`);
  if (!POT_PROVIDER_URL) {
    console.warn('POT_PROVIDER_URL belum diset — yt-dlp mungkin kena blokir bot detection YouTube untuk sebagian video.');
  }
});
