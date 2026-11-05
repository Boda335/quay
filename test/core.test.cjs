'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { openDatabase } = require('../electron/database.cjs');
const { ProviderRegistry, normalizeUrl, httpProvider } = require('../electron/providers.cjs');
const { safeFilename, downloadDirect } = require('../electron/http-download.cjs');
const { TaskScheduler } = require('../electron/scheduler.cjs');
const { TaskOrchestrator } = require('../electron/orchestrator.cjs');
const validation = require('../electron/validation.cjs');
const { lineReader, reconcileOutputPaths } = require('../electron/downloader.cjs');

async function main() {
  assert.equal(normalizeUrl('https://example.com/file#part'), 'https://example.com/file');
  assert.throws(() => normalizeUrl('file:///etc/passwd'));
  const validRunRequest = { id: 'request-1', title: 'Test', url: 'https://example.test/video', providerId: 'yt-dlp', folder: path.resolve(os.tmpdir()), format: 'mp4', quality: '576', retries: 1, expectedTotal: 1, selected: null, subfolder: '', skipExisting: true, numbering: false, deepVerify: false, subtitles: true, subtitleLanguages: 'en,fr' };
  assert.equal(validation.validateRunTask(validRunRequest).quality, '576');
  assert.throws(() => validation.validateRunTask({ ...validRunRequest, mediaInfo: { thumbnail: 'file:///secret' } }), /Invalid download task/);
  assert.equal(safeFilename('../../bad:name?.zip'), 'bad_name_.zip');
  assert.equal(safeFilename('CON.txt'), '_CON.txt');
  const utf8Lines = [];
  const utf8Reader = lineReader((line) => utf8Lines.push(line));
  const unicodePathLine = Buffer.from('C:\\temp\\The Green Mile ⧸ ploon.mp4\n', 'utf8');
  const splitAt = unicodePathLine.indexOf(Buffer.from('⧸')) + 1;
  utf8Reader.push(unicodePathLine.subarray(0, splitAt));
  utf8Reader.push(unicodePathLine.subarray(splitAt));
  utf8Reader.flush();
  assert.deepEqual(utf8Lines, ['C:\\temp\\The Green Mile ⧸ ploon.mp4']);
  const unicodeOutputFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'droplist-unicode-path-'));
  try {
    const actualUnicodePath = path.join(unicodeOutputFolder, 'The Green Mile ⧸ ploon.mp4');
    fs.writeFileSync(actualUnicodePath, 'fixture');
    assert.deepEqual(reconcileOutputPaths([path.join(unicodeOutputFolder, 'The Green Mile  ploon.mp4')], unicodeOutputFolder), [actualUnicodePath]);
  } finally { fs.rmSync(unicodeOutputFolder, { recursive: true, force: true }); }
  let webpageInspections = 0;
  const fakeCapabilities = { inspect: true, playlists: false, itemSelection: false, videoFormats: true, audioFormats: true, imageFormats: false, qualitySelection: true, formatSelection: true, subtitles: false, automaticCaptions: false, thumbnailExtraction: false, metadataExtraction: true, audioTracks: true, resume: true, pause: false, directFile: false, formatMerging: true, postProcess: true };
  const fakeYoutube = { ...httpProvider, id: 'yt-dlp', match: (url) => url.includes('youtu.be'), async inspect(url) { return { providerId: 'yt-dlp', url, title: 'Video', uploader: '', kind: 'video', entries: [], capabilities: fakeCapabilities }; } };
  const fakeWebpage = { ...fakeYoutube, match: () => true, async inspect(url) { webpageInspections++; return { providerId: 'yt-dlp', url, title: 'Page media', uploader: '', kind: 'video', entries: [], capabilities: fakeCapabilities }; } };
  const registry = new ProviderRegistry({ youtube: fakeYoutube, webpage: fakeWebpage, directFile: httpProvider });
  assert.equal(registry.resolve('https://youtu.be/abcdefghijk').id, 'yt-dlp');
  assert.equal(registry.resolve('https://example.test/file.bin').id, 'http');
  assert.equal(registry.resolve('ftp://example.test/file.bin'), null);
  let activeInspections = 0, peakInspections = 0;
  const boundedDirect = { id: 'http', match: () => true, async inspect(url) {
    activeInspections++; peakInspections = Math.max(peakInspections, activeInspections);
    await new Promise((resolve) => setTimeout(resolve, 8));
    activeInspections--;
    return { url, providerId: 'http', title: 'fixture.bin', uploader: 'fixture.test', kind: 'file', entries: [{ id: 'f', index: 1, title: 'fixture.bin' }], capabilities: {} };
  } };
  const boundedRegistry = new ProviderRegistry({ youtube: { ...fakeYoutube, match: () => false }, webpage: fakeWebpage, directFile: boundedDirect });
  const boundedBatch = await boundedRegistry.inspectBatch(Array.from({ length: 9 }, (_, index) => `https://fixture.test/${index}.bin`));
  assert.equal(boundedBatch.filter((item) => item.status === 'fulfilled').length, 9);
  assert.ok(peakInspections <= 3, `batch inspection concurrency exceeded limit: ${peakInspections}`);
  const scheduler = new TaskScheduler({ concurrency: 1 });
  let resolveScheduled;
  let cancelled = false;
  const running = scheduler.run('one', () => ({ promise: new Promise((resolve) => { resolveScheduled = resolve; }), cancel: () => { cancelled = true; resolveScheduled('cancelled'); } }));
  await assert.rejects(scheduler.run('two', () => ({ promise: Promise.resolve(), cancel() {} })), /active task limit/);
  assert.equal(scheduler.cancel('one'), true);
  assert.equal(await running, 'cancelled');
  assert.equal(cancelled, true);
  assert.equal(scheduler.has('one'), false);

  const bytes = Buffer.from('a deterministic local download fixture\n');
  let requests = 0;
  let flakyRequests = 0;
  const server = http.createServer((req, res) => {
    requests++;
    if (req.url === '/redirect') { res.writeHead(302, { Location: '/file' }).end(); return; }
    if (req.url === '/missing') { res.writeHead(404).end(); return; }
    if (req.url === '/ambiguous') { res.writeHead(200, { 'Content-Type': 'application/octet-stream' }).end(bytes); return; }
    if (req.url === '/flaky' && flakyRequests++ === 0) { res.writeHead(503, { 'Retry-After': '0' }).end(); return; }
    if (req.url === '/unknown') { res.writeHead(200, { 'Content-Disposition': 'attachment; filename="unknown.bin"', 'Transfer-Encoding': 'chunked' }); res.write(bytes.subarray(0, 10)); setTimeout(() => res.end(bytes.subarray(10)), 5); return; }
    if (req.url === '/stream') {
      res.writeHead(200, { 'Content-Length': 100000, 'Content-Disposition': 'attachment; filename="partial.bin"' });
      const timer = setInterval(() => res.write(Buffer.alloc(1024)), 4);
      res.on('close', () => clearInterval(timer));
      return;
    }
    if (req.method === 'HEAD') { res.writeHead(200, { 'Content-Length': bytes.length, 'Content-Type': 'application/octet-stream', 'Content-Disposition': "attachment; filename*=UTF-8''fixture.bin", 'Accept-Ranges': 'bytes', ETag: '"v1"' }).end(); return; }
    const range = req.headers.range;
    if (range) {
      const start = Number(range.match(/bytes=(\d+)-/)[1]);
      res.writeHead(206, { 'Content-Length': bytes.length - start, 'Content-Range': `bytes ${start}-${bytes.length - 1}/${bytes.length}`, ETag: '"v1"' }).end(bytes.subarray(start));
      return;
    }
    res.writeHead(200, { 'Content-Length': bytes.length, ETag: '"v1"', 'Content-Disposition': `attachment; filename="${req.url === '/flaky' ? 'flaky' : 'fixture.bin'}"` });
    res.end(bytes);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'droplist-core-'));
  try {
    const preview = await registry.inspect(`${base}/file`, { allowPrivateAddresses: true });
    assert.equal(preview.providerId, 'http');
    assert.equal(preview.title, 'fixture.bin');
    assert.equal(preview.size, bytes.length);
    const batch = await registry.inspectBatch([`${base}/file`, `${base}/missing`, `${base}/file`, 'file:///invalid'], { allowPrivateAddresses: true });
    assert.deepEqual(batch.map((item) => item.status), ['fulfilled', 'failed', 'duplicate', 'failed']);
    assert.equal(batch[1].category, 'unsupported');
    assert.equal(batch[2].duplicateOf, 0);
    assert.equal(batch[3].category, 'invalid-url');
    await assert.rejects(registry.inspect(`${base}/file`), /private, reserved, or local network/);
    const youtubePreview = await registry.inspect('https://youtu.be/abcdefghijk');
    assert.equal(youtubePreview.providerId, 'yt-dlp');
    const events = [];
    const result = await downloadDirect({ url: `${base}/redirect`, folder: temp, allowPrivateAddresses: true, onEvent: (event) => events.push(event) });
    assert.equal(result.status, 'completed');
    assert.deepEqual(fs.readFileSync(path.join(temp, 'fixture.bin')), bytes);
    assert.ok(events.some((event) => event.type === 'progress' && event.overall < 100));
    assert.equal(await (await fetch(`${base}/missing`)).status, 404);
    await assert.rejects(downloadDirect({ url: `${base}/missing`, folder: temp, retries: 0, allowPrivateAddresses: true }), /HTTP 404/);
    await downloadDirect({ url: `${base}/flaky`, folder: temp, retries: 1, allowPrivateAddresses: true });
    assert.deepEqual(fs.readFileSync(path.join(temp, 'flaky')), bytes);
    const unknownEvents = [];
    await downloadDirect({ url: `${base}/unknown`, folder: temp, allowPrivateAddresses: true, onEvent: (event) => unknownEvents.push(event) });
    assert.equal(fs.readFileSync(path.join(temp, 'unknown.bin')).toString(), bytes.toString());
    assert.ok(unknownEvents.some((event) => event.type === 'progress' && event.indeterminate));

    const resumeUrl = `${base}/file`;
    fs.rmSync(path.join(temp, 'fixture.bin'));
    const resumePath = path.join(temp, 'fixture.bin.part');
    fs.writeFileSync(resumePath, bytes.subarray(0, 9));
    fs.writeFileSync(`${resumePath}.json`, JSON.stringify({ url: resumeUrl, etag: '"v1"' }));
    await downloadDirect({ url: resumeUrl, folder: temp, allowPrivateAddresses: true });
    assert.deepEqual(fs.readFileSync(path.join(temp, 'fixture.bin')), bytes);

    const controller = new AbortController();
    const cancelled = downloadDirect({ url: `${base}/stream`, folder: temp, signal: controller.signal, allowPrivateAddresses: true });
    setTimeout(() => controller.abort(), 100);
    const cancelResult = await cancelled;
    assert.equal(cancelResult.status, 'cancelled');
    assert.ok(fs.existsSync(path.join(temp, 'partial.bin.part')));

    await assert.rejects(registry.inspect(`${base}/missing`, { allowPrivateAddresses: true }), /HTTP 404/);
    await assert.rejects(httpProvider.inspect(`${base}/ambiguous`, { allowPrivateAddresses: true }), /does not identify itself as a downloadable file/);
    const ambiguousPage = await registry.inspect(`${base}/ambiguous`, { allowPrivateAddresses: true });
    assert.equal(ambiguousPage.providerId, 'yt-dlp');
    // HTML pages are classified as yt-dlp sources while direct binary links stay on HTTP.
    const pageServer = http.createServer((_req, res) => res.writeHead(200, { 'Content-Type': 'text/html' }).end('<html>page</html>'));
    await new Promise((resolve) => pageServer.listen(0, '127.0.0.1', resolve));
    try {
      const page = await registry.inspect(`http://127.0.0.1:${pageServer.address().port}/page`, { allowPrivateAddresses: true });
      assert.equal(page.providerId, 'yt-dlp');
      assert.equal(webpageInspections, 2);
    } finally { pageServer.close(); }
    assert.throws(() => validation.validateRunTask({ id: 'x', url: 'file:///bad' }));

    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'droplist-db-'));
    const db = openDatabase(userData);
    const task = { id: 'task-1', url: `${base}/file`, providerId: 'http', title: 'Fixture', status: 'running', createdAt: new Date().toISOString() };
    db.saveTasks([task]);
    db.saveHistory([{ id: 'history-1', title: 'Prior download', date: new Date().toISOString() }]);
    db.close();
    const reopened = openDatabase(userData);
    assert.deepEqual(reopened.migrationVersions(), [1, 2, 3]);
    assert.equal(reopened.listTasks()[0].id, task.id);
    assert.equal(reopened.readHistory()[0].title, 'Prior download');
    const libraryFile = path.join(temp, 'library-fixture.mp4');
    fs.writeFileSync(libraryFile, bytes);
    assert.equal(reopened.recordMediaItems({ id: 'task-1', providerId: 'http', url: `${base}/file`, title: 'Fixture', mediaInfo: { extractor: 'HTTP', originalTitle: 'Original', mediaType: 'video', metadata: { duration: 8 } } }, [{ path: libraryFile, extension: 'mp4', size: bytes.length }]), 1);
    assert.equal(reopened.readMediaItems()[0].originalTitle, 'Original');
    assert.equal(reopened.readMediaItems()[0].filePath, libraryFile);
    reopened.saveTasks([{ ...task, status: 'interrupted' }]);
    assert.equal(reopened.listTasks()[0].status, 'interrupted');
    reopened.upsertTask({ ...task, id: 'recover-me', status: 'running' });
    assert.equal(reopened.recoverInterruptedTasks(), 1);
    assert.equal(reopened.listTasks().find((entry) => entry.id === 'recover-me').status, 'interrupted');
    let transitionEvents = 0;
    const orchestrator = new TaskOrchestrator({ database: reopened, scheduler: new TaskScheduler() });
    const completedTask = { id: 'task-2', url: `${base}/file`, providerId: 'http', title: 'Fixture', status: 'waiting', createdAt: new Date().toISOString() };
    const outcome = await orchestrator.execute(completedTask, async () => ({ promise: Promise.resolve({ status: 'completed', done: 1, folder: temp, message: 'done' }), cancel() {} }), () => transitionEvents++);
    assert.equal(outcome.status, 'completed');
    assert.equal(reopened.listTasks().find((entry) => entry.id === 'task-2').status, 'done');
    assert.equal(transitionEvents, 0);
    assert.deepEqual(reopened.readTaskEvents('task-2').map((event) => event.type), ['state-done', 'state-running', 'state-preparing']);
    const migrationUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'droplist-migration-'));
    const migrationData = openDatabase(migrationUserData);
    const migrated = migrationData.migrateLegacy({ settings: { quality: '720' }, history: [{ id: 'old-history', title: 'Legacy' }] });
    migrationData.migrateLegacy({ settings: { quality: 'best' }, history: [] });
    assert.equal(migrated.settings.quality, '720');
    assert.equal(migrated.history[0].title, 'Legacy');
    assert.equal(fs.readdirSync(path.join(migrationUserData, 'data', 'migration-backups')).length, 1);
    migrationData.close();
    fs.rmSync(migrationUserData, { recursive: true, force: true });
    reopened.close();
    fs.rmSync(userData, { recursive: true, force: true });
    console.log('core tests passed');
  } finally {
    server.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
