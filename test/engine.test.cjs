/**
 * Engine test. Serves three tiny clips from localhost and downloads them with the real yt-dlp,
 * so it covers .part handling, playlist selection, numbering, the skip archive and cancel.
 * Needs yt-dlp and ffmpeg on PATH:  npm test
 */
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const engine = require('../electron/downloader.cjs');
const bundledFfmpeg = (() => { try { return require('ffmpeg-static'); } catch { return ''; } })();

const which = (name) => { try { return execFileSync(process.platform === 'win32' ? 'where' : 'which', [name]).toString().split(/\r?\n/)[0].trim(); } catch { return ''; } };
const installedYtDlp = path.join(process.env.APPDATA || '', 'Playlist Downloader', 'bin', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
const ytDlpPath = process.env.DROPLIST_YTDLP_PATH || (fs.existsSync(installedYtDlp) ? installedYtDlp : which('yt-dlp'));
const ffmpeg = bundledFfmpeg && fs.existsSync(bundledFfmpeg) ? bundledFfmpeg : which('ffmpeg');
if (!ytDlpPath || !ffmpeg) { console.log(`SKIP: integration prerequisites unavailable (yt-dlp: ${ytDlpPath || 'missing'}, ffmpeg: ${ffmpeg || 'missing'})`); process.exit(0); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'droplist-'));
const site = path.join(tmp, 'site');
fs.mkdirSync(site);
for (let i = 1; i <= 3; i++) {
  execFileSync(ffmpeg, ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=25:duration=2',
    '-f', 'lavfi', '-i', `sine=frequency=${300 * i}:duration=2`, '-c:v', 'libx264', '-c:a', 'aac', '-shortest', path.join(site, `clip${i}.mp4`)]);
}
fs.writeFileSync(path.join(site, 'page.html'),
  '<html><head><title>Test Mix</title></head><body>' + [1, 2, 3].map((i) => `<video src="clip${i}.mp4"></video>`).join('') + '</body></html>');

const server = http.createServer((req, res) => {
  const file = path.join(site, path.basename(req.url.split('?')[0]));
  if (!fs.existsSync(file)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': file.endsWith('.html') ? 'text/html' : 'video/mp4' });
  fs.createReadStream(file).pipe(res);
});

async function main() {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/page.html`;
  const out = path.join(tmp, 'out');
  const base = { ytDlpPath, ffmpeg, url, folder: out, format: 'mp4', quality: '720', retries: 2, archiveFile: path.join(tmp, 'archive.txt') };

  assert.strictEqual(engine.toItemRanges([1, 2, 3, 5, 6, 9]), '1-3,5-6,9');
  assert.strictEqual(engine.safeFolderName('Mix: A/B?'), 'Mix_ A_B_');
  const assetArgs = engine.buildArgs({ ...base, subtitles: true, automaticCaptions: true, subtitleLanguages: 'en,fr', thumbnails: true, metadataSidecar: true });
  assert.ok(assetArgs.includes('--write-subs'));
  assert.ok(assetArgs.includes('--write-auto-subs'));
  assert.ok(assetArgs.includes('--write-thumbnail'));
  assert.ok(assetArgs.includes('--write-info-json'));
  assert.ok(assetArgs.includes('en,fr'));
  const imageArgs = engine.buildArgs({ ...base, format: 'image', ffmpeg: null });
  assert.ok(imageArgs.includes('best'));
  assert.ok(!imageArgs.includes('--merge-output-format'));

  const info = await engine.inspect(ytDlpPath, url);
  assert.strictEqual(info.count, 3);

  let r = await engine.runDownload({ ...base, items: '1,3', numbering: true, expectedTotal: 2, deepVerify: true }, () => {}).promise;
  assert.strictEqual(r.status, 'completed'); assert.strictEqual(r.done, 2); assert.deepStrictEqual(r.issues, []);
  const names = fs.readdirSync(out);
  assert.ok(names.every((n) => n.endsWith('.mp4') && !n.endsWith('.part') && !n.endsWith('.nxs')), `unexpected files: ${names}`);

  r = await engine.runDownload({ ...base, items: '1,3', expectedTotal: 2 }, () => {}).promise;
  assert.strictEqual(r.skipped, 2); assert.strictEqual(r.done, 0);

  const events = [];
  r = await engine.runDownload({ ...base, expectedTotal: 3 }, (e) => events.push(e)).promise;
  assert.strictEqual(r.done, 1); assert.strictEqual(r.skipped, 2);
  assert.ok(events.some((e) => e.type === 'progress' && e.overall > 0));

  const cancelOut = path.join(tmp, 'cancel');
  const job = engine.runDownload({ ...base, folder: cancelOut, archiveFile: path.join(tmp, 'archive2.txt'), expectedTotal: 3 }, () => {});
  setTimeout(() => job.cancel(), 700);
  r = await job.promise;
  assert.ok(['cancelled', 'completed'].includes(r.status));

  console.log('engine tests passed');
}

main().then(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); })
  .catch((e) => { console.error(e); server.close(); process.exit(1); });
