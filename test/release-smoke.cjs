'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ProviderRegistry, httpProvider } = require('../electron/providers.cjs');

const youtubeUrl = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
const tiktokUrl = 'https://www.tiktok.com/@ploonedits/video/7704515051293560078';
const directUrl = 'https://samplelib.com/lib/preview/mp4/sample-5s.mp4';

function binaries() {
  const ytDlpPath = process.env.DROPLIST_YTDLP_PATH || path.join(process.env.APPDATA || '', 'Playlist Downloader', 'bin', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
  let ffmpegPath = null;
  try { ffmpegPath = require('ffmpeg-static'); } catch (_) { /* reported below */ }
  if (!fs.existsSync(ytDlpPath)) throw new Error(`yt-dlp executable is missing: ${ytDlpPath}`);
  if (!ffmpegPath || !fs.existsSync(ffmpegPath.replace('app.asar', 'app.asar.unpacked'))) throw new Error('ffmpeg-static executable is missing.');
  return { ytDlpPath, ffmpegPath: ffmpegPath.replace('app.asar', 'app.asar.unpacked') };
}

async function runMedia(registry, url, info, context, root) {
  if (info.providerId !== 'yt-dlp') throw new Error(`${url} was not classified as a yt-dlp source (${info.providerId}).`);
  const folder = path.join(root, info.title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 48));
  fs.mkdirSync(folder, { recursive: true });
  const phases = [];
  const provider = registry.forTask(url, info.providerId);
  const task = provider.createTask({
    url, folder, quality: '480', format: 'mp4', retries: 0, skipExisting: false,
    numbering: false, deepVerify: true, expectedTotal: info.count || 1, selected: null,
    onEvent: (event) => { if (event.type === 'phase') phases.push(event.phase); }
  }, context);
  const result = await task.promise;
  if (result.status !== 'completed' || !result.files?.length) throw new Error(`${info.sourceType} download failed: ${result.message}`);
  const files = result.files.map((file) => ({ path: file, bytes: fs.existsSync(file) ? fs.statSync(file).size : null }));
  if (files.some((file) => !file.bytes)) throw new Error(`yt-dlp reported missing or empty output(s): ${JSON.stringify({ message: result.message, issues: result.issues, files, folder: fs.readdirSync(folder) })}`);
  return { providerId: info.providerId, kind: info.kind, title: info.title, files, phases, message: result.message };
}

async function main() {
  const { ytDlpPath, ffmpegPath } = binaries();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'droplist-phase2-release-'));
  const registry = new ProviderRegistry();
  const context = { ytDlpPath, ffmpegPath, timeoutMs: 30000, bodyTimeoutMs: 30000, allowPrivateAddresses: false, archiveFile: path.join(root, 'download-archive.txt') };
  const report = { ytDlpPath, results: [] };
  let passed = false;
  try {
    const tiktok = await registry.inspect(tiktokUrl, context);
    report.inspections = [];
    report.inspections.push({ url: tiktokUrl, providerId: tiktok.providerId, sourceType: tiktok.sourceType, kind: tiktok.kind, title: tiktok.title, count: tiktok.count });
    process.stderr.write('TikTok inspection passed; starting actual download.\n');
    report.results.push(await runMedia(registry, tiktokUrl, tiktok, context, root));

    const youtube = await registry.inspect(youtubeUrl, context);
    report.inspections.push({ url: youtubeUrl, providerId: youtube.providerId, sourceType: youtube.sourceType, kind: youtube.kind, title: youtube.title, count: youtube.count });
    process.stderr.write('YouTube inspection passed; starting actual download and FFmpeg verification.\n');
    const youtubeResult = await runMedia(registry, youtubeUrl, youtube, context, root);
    if (!youtubeResult.phases.includes('merging')) throw new Error('The YouTube run did not report FFmpeg audio/video merging.');
    if (youtubeResult.files.some((file) => path.extname(file.path).toLowerCase() !== '.mp4')) throw new Error('The YouTube merged result is not MP4.');
    report.results.push(youtubeResult);

    const direct = await registry.inspect(directUrl, context);
    report.inspections.push({ url: directUrl, providerId: direct.providerId, sourceType: direct.sourceType, kind: direct.kind, title: direct.title, count: direct.count });
    if (direct.providerId !== 'http' || direct.kind !== 'file') throw new Error(`The direct media fixture was classified unexpectedly: ${direct.providerId}/${direct.kind}.`);
    const directFolder = path.join(root, 'direct');
    fs.mkdirSync(directFolder, { recursive: true });
    const directResult = await httpProvider.createTask({ url: directUrl, folder: directFolder, retries: 0, onEvent() {} }, context).promise;
    if (directResult.status !== 'completed' || !directResult.files?.length) throw new Error(`Direct HTTP download failed: ${directResult.message}`);
    const directStat = fs.statSync(directResult.files[0]);
    if (!directStat.size) throw new Error('Direct HTTP result is empty.');
    report.results.push({ providerId: 'http', title: path.basename(directResult.files[0]), files: [{ path: directResult.files[0], bytes: directStat.size }], message: directResult.message });
    passed = true;
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    if (passed) fs.rmSync(root, { recursive: true, force: true });
    else console.error(`Release smoke artifacts retained for diagnosis: ${root}`);
  }
}

main().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
