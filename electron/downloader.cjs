'use strict';
/**
 * Download engine. No Electron imports here, so it can be tested with plain Node.
 *
 * File lifecycle (handled entirely by yt-dlp, nothing is renamed by us):
 *   Title.f137.mp4.part  ->  Title.f137.mp4  ->  (merge/convert)  ->  Title.mp4
 * We only read the final path yt-dlp reports after it has moved the file into place.
 */
const path = require('node:path');
const fs = require('node:fs');
const { StringDecoder } = require('node:string_decoder');
const { spawn } = require('node:child_process');

const clamp = (n, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));
const parseNumber = (value) => {
  const n = parseFloat(String(value).replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : null;
};
const cleanStat = (value) => {
  const text = String(value || '').trim();
  return /^(unknown|n\/a|na)\b/i.test(text) ? '' : text;
};

/** Safe folder name for a playlist (Windows-safe, bounded length). */
function safeFolderName(name, fallback = 'Playlist') {
  const cleaned = String(name || '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .trim()
    .slice(0, 100)
    .trim();
  return cleaned || fallback;
}

/** MP4 selector: up to 1080p prefer H.264 + AAC so files play on every device. */
function formatSelector(quality) {
  if (quality === 'best') return 'bv*+ba/b';
  const h = Number(quality) || 1080;
  if (h <= 1080) {
    return `bv*[vcodec^=avc1][height<=${h}]+ba[ext=m4a]/bv*[height<=${h}]+ba/b[height<=${h}]/b`;
  }
  return `bv*[height<=${h}]+ba/b[height<=${h}]/b`;
}

function buildArgs(o) {
  const {
    url, folder, quality = '1080', format = 'mp4', items = '', retries = 5,
    skipExisting = true, numbering = false, archiveFile, ffmpeg, subtitles = false,
    automaticCaptions = false, subtitleLanguages = 'all', thumbnails = false, metadataSidecar = false
  } = o;

  const name = `${numbering ? '%(playlist_index&{} - |)s' : ''}%(title).160B.%(ext)s`;
  const args = [
    '--yes-playlist', '--newline', '--no-colors', '--no-warnings', '--no-quiet',
    '--continue', '--no-mtime', '--windows-filenames', '--embed-metadata',
    '--retries', String(retries), '--fragment-retries', String(retries),
    '--file-access-retries', '3', '--retry-sleep', '1:3',
    '--concurrent-fragments', '4'
  ];
  if (ffmpeg) args.push('--ffmpeg-location', ffmpeg);
  if (subtitles) args.push('--write-subs', '--sub-langs', String(subtitleLanguages || 'all').slice(0, 100));
  if (automaticCaptions) args.push('--write-auto-subs', '--sub-langs', String(subtitleLanguages || 'all').slice(0, 100));
  if (thumbnails) args.push('--write-thumbnail');
  if (metadataSidecar) args.push('--write-info-json');
  if (items) args.push('--playlist-items', items);
  if (skipExisting && archiveFile) args.push('--download-archive', archiveFile, '--no-overwrites');
  args.push(
    '-o', path.join(folder, name),
    '--progress',
    '--progress-template', 'download:__PROGRESS__%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s',
    '--print', 'before_dl:__ITEM__%(id)s|%(title)s',
    '--print', 'after_move:__DONE__%(id)s|%(title)s|%(filepath)s'
  );

  if (format === 'image') {
    args.push('-f', 'best');
  } else if (format === 'mp3') {
    args.push('-f', 'bestaudio/best', '-x', '--audio-format', 'mp3', '--audio-quality', '0');
  } else {
    args.push('-f', formatSelector(quality), '--merge-output-format', 'mp4', '--remux-video', 'mp4');
  }
  args.push(url);
  return args;
}

/** Turns yt-dlp's output lines into typed events. */
function createParser(emit, { total = 0, format = 'mp4' } = {}) {
  const state = {
    total, current: 0, stream: 0, itemLines: 0, sawPlaylistLine: false,
    percent: 0, lastEmit: 0, done: 0, skipped: 0, files: [], mediaFiles: [], errors: []
  };
  const twoStreams = format === 'mp4';

  const overall = (streamPercent) => {
    const per = twoStreams
      ? (state.stream <= 1 ? streamPercent * 0.9 : 90 + streamPercent * 0.1)
      : streamPercent;
    if (state.total > 0) return clamp(((Math.max(1, state.current) - 1 + per / 100) / state.total) * 100);
    return clamp(per);
  };

  function phaseFor() {
    if (!twoStreams) return 'download';
    return state.stream <= 1 ? 'video' : 'audio';
  }

  function handle(rawLine) {
    const line = rawLine.trim();
    if (!line) return;

    let m = line.match(/^\[download\] Downloading item (\d+) of (\d+)/i);
    if (m) {
      state.sawPlaylistLine = true;
      state.current = Number(m[1]);
      state.total = Number(m[2]) || state.total;
      return;
    }

    m = line.match(/__ITEM__([^|]*)\|(.*)$/);
    if (m) {
      if (!state.sawPlaylistLine) { state.itemLines += 1; state.current = state.itemLines; }
      state.stream = 0;
      state.percent = 0;
      emit({ type: 'item', id: m[1], current: state.current, total: state.total, title: m[2].trim() });
      return;
    }

    m = line.match(/__DONE__([^|]*)\|(.*?)\|(.*)$/);
    if (m) {
      const filePath = m[3].trim();
      state.done += 1;
      if (filePath) { state.files.push(filePath); state.mediaFiles.push({ id: m[1], title: m[2].trim(), path: filePath }); }
      emit({ type: 'video-complete', id: m[1], title: m[2].trim(), path: filePath });
      const finished = state.total > 0 ? clamp((Math.max(1, state.current) / state.total) * 100) : 100;
      emit({ type: 'progress', percent: 100, overall: finished, current: state.current, total: state.total, speed: '', eta: '' });
      return;
    }

    m = line.match(/__PROGRESS__(.*?)\|(.*?)\|(.*)$/);
    if (m) {
      const pct = parseNumber(m[1]);
      if (pct === null) return;
      state.percent = clamp(pct);
      const now = Date.now();
      if (now - state.lastEmit < 120 && state.percent < 100) return;
      state.lastEmit = now;
      emit({
        type: 'progress', percent: state.percent, overall: overall(state.percent),
        current: state.current, total: state.total, speed: cleanStat(m[2]), eta: cleanStat(m[3])
      });
      return;
    }

    if (/^\[download\] Destination:/i.test(line)) {
      state.stream += 1;
      emit({ type: 'phase', phase: phaseFor() });
      return;
    }
    if (/^\[Merger\]/i.test(line)) return emit({ type: 'phase', phase: 'merging' });
    if (/^\[(ExtractAudio|VideoRemuxer|VideoConvertor)\]/i.test(line)) return emit({ type: 'phase', phase: 'converting' });
    if (/^\[(Metadata|MoveFiles|EmbedThumbnail)\]/i.test(line)) return emit({ type: 'phase', phase: 'finishing' });

    if (/has already been recorded in the archive/i.test(line)) {
      state.skipped += 1;
      emit({ type: 'skipped', title: line.replace(/^\[download\]\s*/i, '').replace(/:?\s*has already been recorded.*$/i, '') });
      return;
    }
    if (/^ERROR:/i.test(line)) {
      state.errors.push(line.replace(/^ERROR:\s*/i, '').slice(0, 300));
      emit({ type: 'video-error', message: state.errors[state.errors.length - 1] });
    }
  }

  return { handle, summary: () => ({ done: state.done, skipped: state.skipped, files: state.files, mediaFiles: state.mediaFiles, errors: state.errors }) };
}

function lineReader(onLine) {
  let buffer = '';
  const decoder = new StringDecoder('utf8');
  const consume = (text) => {
    buffer += text;
    const lines = buffer.split(/\r?\n|\r/);
    buffer = lines.pop() || '';
    lines.forEach(onLine);
  };
  return {
    push(chunk) { consume(decoder.write(chunk)); },
    flush() { consume(decoder.end()); if (buffer) onLine(buffer); buffer = ''; }
  };
}

const MEDIA_EXTENSIONS = new Set(['.mp4', '.m4v', '.mkv', '.webm', '.mov', '.avi', '.mp3', '.m4a', '.aac', '.ogg', '.opus', '.wav', '.flac']);
function listMediaFiles(folder, depth = 2) {
  if (!folder || !fs.existsSync(folder)) return [];
  const found = [];
  for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
    const fullPath = path.join(folder, entry.name);
    if (entry.isFile() && MEDIA_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) found.push(fullPath);
    else if (entry.isDirectory() && depth > 0) found.push(...listMediaFiles(fullPath, depth - 1));
  }
  return found;
}

function fileMatchKey(filePath) {
  return path.basename(filePath).replace(/\.[^.]+$/, '').normalize('NFKD').replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
}

function reconcileOutputPaths(reportedPaths, folder) {
  const available = listMediaFiles(folder);
  return reportedPaths.map((reportedPath) => {
    if (fs.existsSync(reportedPath)) return reportedPath;
    const expectedKey = fileMatchKey(reportedPath);
    const expectedExtension = path.extname(reportedPath).toLowerCase();
    const matches = available.filter((candidate) => path.extname(candidate).toLowerCase() === expectedExtension && fileMatchKey(candidate) === expectedKey);
    return matches.length === 1 ? matches[0] : reportedPath;
  });
}

function killTree(child) {
  if (!child || child.killed || child.exitCode !== null) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    } else {
      process.kill(-child.pid, 'SIGTERM'); // whole process group (yt-dlp + ffmpeg)
    }
  } catch (_) {
    try { child.kill('SIGTERM'); } catch (__) { /* already gone */ }
  }
}

function explainError(text) {
  const raw = String(text || '').trim();
  const lastError = raw.split(/\r?\n/).reverse().find((l) => /error/i.test(l)) || raw.split(/\r?\n/).pop() || '';
  const message = lastError.replace(/^ERROR:\s*/i, '').slice(0, 400) || 'The download engine stopped unexpectedly.';
  let hint = '';
  if (/sign in to confirm|HTTP Error 40[0-9]|HTTP Error 429|unable to extract|nsig|player/i.test(raw)) {
    hint = 'YouTube changes often. Update the engine in Settings, then try again.';
  } else if (/no space left|ENOSPC/i.test(raw)) {
    hint = 'The drive is full. Free some space or pick another folder.';
  } else if (/getaddrinfo|timed out|network is unreachable|connection (reset|refused)|temporary failure/i.test(raw)) {
    hint = 'Check your internet connection. Partial files are kept, so retrying resumes them.';
  } else if (/private video|members-only|age-restricted|not available in your country|unavailable/i.test(raw)) {
    hint = 'This video is private, restricted, or removed.';
  }
  return { message, hint };
}

function decodeCheck(ffmpeg, file) {
  return new Promise((resolve) => {
    const checker = spawn(ffmpeg, ['-v', 'error', '-i', file, '-f', 'null', '-'], { windowsHide: true });
    let err = '';
    checker.stderr.on('data', (c) => { err += c.toString(); });
    checker.on('error', (e) => resolve(e.message));
    checker.on('close', (code) => resolve(code === 0 && !err.trim() ? '' : (err.trim().split(/\r?\n/)[0] || 'unreadable')));
  });
}

/** Light check always; full decode only when requested. Never renames anything. */
async function verifyFiles(files, { deep, ffmpeg, onStep }) {
  const issues = [];
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const name = path.basename(file);
    if (onStep) onStep(i + 1, files.length, name);
    if (!fs.existsSync(file)) { issues.push(`${name}: file is missing`); continue; }
    if (fs.statSync(file).size === 0) { issues.push(`${name}: file is empty`); continue; }
    if (fs.existsSync(`${file}.part`)) { issues.push(`${name}: a .part file is still present`); continue; }
    if (deep) {
      const problem = await decodeCheck(ffmpeg, file);
      if (problem) issues.push(`${name}: ${problem}`);
    }
  }
  return issues;
}

/**
 * Starts one yt-dlp run. Returns { promise, cancel }.
 * The promise always resolves: { status: 'completed' | 'cancelled' | 'error', message, hint, done, skipped, failed, issues }
 */
function runDownload(o, onEvent) {
  const args = buildArgs(o);
  const child = spawn(o.ytDlpPath, args, { windowsHide: true, detached: process.platform !== 'win32' });
  const parser = createParser(onEvent, { total: Number(o.expectedTotal) || 0, format: o.format });
  let cancelled = false;
  let stderrTail = '';

  const out = lineReader(parser.handle);
  const err = lineReader(parser.handle);
  child.stdout.on('data', (c) => out.push(c));
  child.stderr.on('data', (c) => { stderrTail = (stderrTail + c.toString()).slice(-4000); err.push(c); });

  const promise = new Promise((resolve) => {
    child.on('error', (e) => resolve({ status: 'error', message: e.message, hint: '', done: 0, skipped: 0, failed: 0, issues: [] }));
    child.on('close', async (code) => {
      out.flush(); err.flush();
      const s = parser.summary();
      const originalPaths = [...s.files];
      s.files = reconcileOutputPaths(s.files, o.folder);
      const actualByReported = new Map(originalPaths.map((reported, index) => [reported, s.files[index]]));
      s.mediaFiles = s.mediaFiles.map((file) => ({ ...file, path: actualByReported.get(file.path) || file.path }));
      const base = { done: s.done, skipped: s.skipped, failed: s.errors.length, issues: [], files: s.files, mediaFiles: s.mediaFiles };

      if (cancelled) {
        return resolve({ ...base, status: 'cancelled', message: 'Cancelled. Partial .part files were kept, so the next run resumes where it stopped.' });
      }
      const someSucceeded = s.done + s.skipped > 0;
      if (code === 0 || (someSucceeded && s.errors.length)) {
        onEvent({ type: 'phase', phase: 'verifying' });
        base.issues = await verifyFiles(s.files, {
          deep: !!o.deepVerify, ffmpeg: o.ffmpeg,
          onStep: (i, n, name) => onEvent({ type: 'verify', index: i, total: n, name })
        });
        const bits = [];
        if (s.done) bits.push(`${s.done} downloaded`);
        if (s.skipped) bits.push(`${s.skipped} already saved`);
        if (s.errors.length) bits.push(`${s.errors.length} unavailable`);
        if (base.issues.length) bits.push(`${base.issues.length} failed the file check`);
        return resolve({ ...base, status: 'completed', message: bits.join(' · ') || 'Nothing new to download.' });
      }
      const { message, hint } = explainError(stderrTail);
      resolve({ ...base, status: 'error', message, hint });
    });
  });

  return { promise, cancel() { cancelled = true; killTree(child); }, pid: child.pid };
}

function exec(bin, args, { allowNonZero = false, timeout = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = timeout ? setTimeout(() => killTree(child), timeout) : null;
    child.stdout.on('data', (c) => { stdout += c.toString(); });
    child.stderr.on('data', (c) => { stderr += c.toString(); });
    child.on('error', (e) => { if (timer) clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (code === 0 || allowNonZero) resolve({ stdout, stderr, code });
      else reject(new Error(explainError(stderr || stdout).message));
    });
  });
}

const youtubeHosts = ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be', 'music.youtube.com'];
function validYoutubeUrl(value) {
  try { return youtubeHosts.includes(new URL(value).hostname); } catch (_) { return false; }
}

async function inspect(ytDlpPath, url) {
  const { stdout } = await exec(ytDlpPath, [
    '--yes-playlist', '--flat-playlist', '--dump-single-json', '--no-warnings', '--playlist-end', '2000', url
  ]);
  let data;
  try { data = JSON.parse(stdout.trim()); } catch (_) {
    throw new Error('Could not read playlist information. Make sure the link is public.');
  }
  const isPlaylist = data._type === 'playlist';
  const raw = isPlaylist ? (data.entries || []).filter(Boolean) : [data];
  const entries = raw.map((entry, i) => {
    const id = entry.id || String(i + 1);
    const youtubeId = /^[\w-]{11}$/.test(id);
    return {
      id,
      index: i + 1,
      title: entry.title || `Video ${i + 1}`,
      duration: entry.duration || null,
      thumbnail: youtubeId ? `https://i.ytimg.com/vi/${id}/mqdefault.jpg` : (entry.thumbnail || null)
    };
  });
  return {
    kind: isPlaylist ? 'playlist' : 'video',
    title: data.title || (isPlaylist ? 'YouTube playlist' : 'YouTube video'),
    uploader: data.uploader || data.channel || data.playlist_uploader || 'YouTube',
    count: entries.length,
    entries
  };
}

/** [1,2,3,5,6] -> "1-3,5-6" for --playlist-items */
function toItemRanges(indices) {
  const sorted = [...new Set(indices)].sort((a, b) => a - b);
  const parts = [];
  for (let i = 0; i < sorted.length; i++) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    parts.push(j > i ? `${sorted[i]}-${sorted[j]}` : String(sorted[i]));
    i = j;
  }
  return parts.join(',');
}

module.exports = {
  buildArgs, createParser, lineReader, listMediaFiles, reconcileOutputPaths, runDownload, killTree, verifyFiles, explainError,
  exec, inspect, validYoutubeUrl, safeFolderName, toItemRanges, formatSelector
};
