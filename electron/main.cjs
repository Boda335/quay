const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, powerSaveBlocker, Notification } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { fileURLToPath } = require('node:url');
const YTDlpWrap = require('yt-dlp-wrap').default || require('yt-dlp-wrap');
const engine = require('./downloader.cjs');
const { openDatabase } = require('./database.cjs');
const { ProviderRegistry, normalizeUrl } = require('./providers.cjs');
const { TaskScheduler } = require('./scheduler.cjs');
const { TaskOrchestrator } = require('./orchestrator.cjs');
const validation = require('./validation.cjs');

let mainWindow = null;
let ytDlpPath = null;
let ensuring = null;
const scheduler = new TaskScheduler({ concurrency: 1 });
let database = null;
const providers = new ProviderRegistry();
let orchestrator = null;

// Keep the pre-Droplist data directory used by the existing Windows install.
app.setPath('userData', path.join(app.getPath('appData'), 'Playlist Downloader'));

const send = (channel, data) => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, data);
};

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 820,
    minHeight: 640,
    backgroundColor: '#eceef3',
    title: 'Droplist',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, target) => {
    let allowed = false;
    try {
      const parsed = new URL(target);
      allowed = app.isPackaged ? parsed.protocol === 'file:' && path.resolve(fileURLToPath(parsed)) === path.resolve(path.join(__dirname, '..', 'dist', 'index.html'))
        : parsed.origin === 'http://127.0.0.1:5173';
    } catch { /* deny malformed targets */ }
    if (!allowed) event.preventDefault();
  });
  if (!app.isPackaged) mainWindow.loadURL('http://127.0.0.1:5173');
  else mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
}

/* ---------- yt-dlp / ffmpeg ---------- */

function binaryPath() {
  const folder = path.join(app.getPath('userData'), 'bin');
  fs.mkdirSync(folder, { recursive: true });
  return path.join(folder, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
}

async function versionOf(bin) {
  try { return (await engine.exec(bin, ['--version'], { timeout: 15000 })).stdout.trim(); }
  catch (_) { return ''; }
}

function ensureYtDlp() {
  if (ensuring) return ensuring;
  ensuring = (async () => {
    const target = binaryPath();
    if (!fs.existsSync(target)) {
      send('engine:state', { state: 'installing' });
      try { await YTDlpWrap.downloadFromGithub(target); }
      catch (error) {
        throw new Error(`Could not install the download engine. Check your internet connection and try again. (${error.message})`);
      }
      if (!fs.existsSync(target)) throw new Error('The download engine did not finish installing. Restart the app and try again.');
      if (process.platform !== 'win32') fs.chmodSync(target, 0o755);
    }
    ytDlpPath = target;
    const version = await versionOf(target);
    send('engine:state', { state: 'ready', version });
    return target;
  })().catch((error) => {
    ensuring = null;
    send('engine:state', { state: 'error', message: error.message });
    throw error;
  });
  return ensuring;
}

function ffmpegPath() {
  try {
    const candidate = require('ffmpeg-static');
    if (!candidate) return null;
    // Packaged builds keep the binary outside app.asar (see asarUnpack); executables can't run from inside an archive.
    const real = candidate.replace('app.asar', 'app.asar.unpacked');
    if (fs.existsSync(real)) return real;
    if (fs.existsSync(candidate)) return candidate;
  } catch (_) { /* fall through */ }
  return null;
}

/* ---------- IPC ---------- */

function trustedSender(event) {
  const frame = event.senderFrame;
  if (!frame || frame !== event.sender.mainFrame) return false;
  try {
    const url = new URL(frame.url);
    return app.isPackaged ? url.protocol === 'file:' : url.origin === 'http://127.0.0.1:5173';
  } catch { return false; }
}

function handle(channel, handler) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!trustedSender(event)) throw new Error('Untrusted IPC sender.');
    return handler(event, ...args);
  });
}

handle('app:defaults', () => ({ downloads: app.getPath('downloads'), version: app.getVersion() }));
handle('queue:load', () => ({ tasks: database.listTasks(), history: database.readHistory(), settings: database.readSettings() }));
handle('legacy:migrate', (_event, data) => {
  return database.migrateLegacy(validation.validateLegacy(data));
});
handle('queue:save', (_event, tasks) => {
  database.saveTasks(validation.validateQueue(tasks));
  return true;
});
handle('queue:remove', (_event, id) => { if (typeof id !== 'string' || id.length > 100) throw new Error('Invalid task ID.'); database.removeTask(id); return true; });
handle('history:save', (_event, entries) => { database.saveHistory(validation.validateHistory(entries)); return true; });
handle('settings:save', (_event, settings) => { for (const [key, value] of Object.entries(validation.validateSettings(settings))) database.setSetting(key, value); return true; });

handle('dialog:choose-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose where to save',
    properties: ['openDirectory', 'createDirectory']
  });
  return result.canceled ? null : result.filePaths[0];
});

handle('clipboard:read', () => clipboard.readText().trim().slice(0, 100000));

handle('folder:open', async (_e, folder) => {
  if (typeof folder === 'string' && folder.length < 32768 && path.isAbsolute(folder) && fs.existsSync(folder) && fs.statSync(folder).isDirectory()) await shell.openPath(folder);
});

handle('engine:prepare', async () => { await ensureYtDlp(); return true; });

handle('engine:update', async () => {
  const bin = await ensureYtDlp();
  const before = await versionOf(bin);
  await engine.exec(bin, ['-U'], { allowNonZero: true, timeout: 120000 });
  const after = await versionOf(bin);
  send('engine:state', { state: 'ready', version: after });
  return { before, after, changed: before !== after };
});

handle('archive:clear', () => {
  for (const format of ['mp4', 'mp3']) {
    const file = path.join(app.getPath('userData'), `download-archive-${format}.txt`);
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
  return true;
});

handle('source:inspect', async (_e, url) => {
  const normalized = normalizeUrl(url);
  try {
    const result = await providers.inspect(normalized, { ytDlpPath, ensureYtDlp, ffmpegPath: ffmpegPath(), allowPrivateAddresses: false });
    return validation.validatePreview(result);
  } catch (error) {
    if (error.code === 'SECURITY_BLOCKED') throw new Error(`Security policy blocked this source: ${error.message}`);
    if (['ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ERR_INVALID_IP_ADDRESS'].includes(error.code)) throw new Error(`Network or DNS error while inspecting this source: ${error.message}`);
    if (error.code === 'EXTRACTION_ERROR' || error.code === 'UNSUPPORTED_SOURCE') throw new Error(error.message);
    throw error;
  }
});

handle('source:inspect-batch', async (_e, urls) => {
  const results = await providers.inspectBatch(urls, { ytDlpPath, ensureYtDlp, ffmpegPath: ffmpegPath(), allowPrivateAddresses: false });
  return results.map((item) => item.status === 'fulfilled' ? { ...item, result: validation.validatePreview(item.result) } : item);
});

handle('download:run', async (_e, job) => {
  const taskInput = validation.validateRunTask(job);
  const taskId = taskInput.id;
  if (scheduler.has(taskId)) throw new Error('This task is already running.');
  const normalizedUrl = taskInput.url;
  const provider = providers.forTask(normalizedUrl, taskInput.providerId);
  if (!provider) throw new Error('This source is not supported.');
  const { folder, subfolder = '', quality, format, retries, skipExisting, numbering, deepVerify, selected, expectedTotal } = taskInput;
  if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) throw new Error('The save folder does not exist or is not a folder. Choose another one.');
  const target = subfolder ? path.join(folder, engine.safeFolderName(subfolder)) : folder;
  fs.mkdirSync(target, { recursive: true });
  const task = { ...taskInput, url: normalizedUrl, folder, title: taskInput.title || path.basename(normalizedUrl), status: 'waiting', createdAt: taskInput.createdAt || new Date().toISOString() };
  let taskBlockerId = null;
  try {
    const result = await orchestrator.execute(task, async (onEvent) => {
      taskBlockerId = powerSaveBlocker.start('prevent-app-suspension');
      const ytDlp = taskInput.providerId === 'yt-dlp' ? await ensureYtDlp() : null;
      return provider.createTask({ ...taskInput, url: normalizedUrl, folder: target, onEvent }, {
        ytDlpPath: ytDlp, ffmpegPath: ffmpegPath(), allowPrivateAddresses: false,
        archiveFile: path.join(app.getPath('userData'), `download-archive-${format}.txt`)
      });
    }, (event) => {
        send('download:progress', event);
        if (event.type === 'progress' && mainWindow && !mainWindow.isDestroyed()) {
          const value = event.indeterminate ? -1 : Math.max(0, Math.min(0.999, (event.overall || 0) / 100));
          mainWindow.setProgressBar(value);
        }
      });
    result.folder = target;
    if (result.status === 'completed' && Array.isArray(result.files)) {
      const mediaFiles = new Map((result.mediaFiles || []).map((file) => [path.resolve(file.path), file]));
      const safeFiles = result.files.flatMap((file) => {
        if (typeof file !== 'string') return [];
        const absolute = path.resolve(file);
        const relative = path.relative(path.resolve(target), absolute);
        if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) return [];
        const extension = path.extname(absolute).slice(1).toLowerCase();
        let thumbnailPath = null;
        for (const ext of ['jpg', 'jpeg', 'png', 'webp']) { const candidate = `${absolute.slice(0, -path.extname(absolute).length)}.${ext}`; if (fs.existsSync(candidate)) { thumbnailPath = candidate; break; } }
        const media = mediaFiles.get(absolute);
        const entry = task.mediaInfo?.entries?.find((item) => item.id === media?.id);
        return [{ path: absolute, extension, size: fs.statSync(absolute).size, thumbnailPath,
          originalTitle: media?.title || entry?.title, duration: entry?.duration, mediaType: entry?.mediaType }];
      });
      if (safeFiles.length) database.recordMediaItems(task, safeFiles);
    }
    return result;
  } finally {
    if (taskBlockerId !== null && powerSaveBlocker.isStarted(taskBlockerId)) powerSaveBlocker.stop(taskBlockerId);
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setProgressBar(-1);
  }
});

handle('download:cancel', (_event, taskId) => {
  if (taskId !== undefined && (typeof taskId !== 'string' || taskId.length > 100)) throw new Error('Invalid task ID.');
  return scheduler.cancel(taskId);
});

handle('notify', (_e, payload) => {
  payload = validation.validateNotify(payload);
  if (Notification.isSupported() && mainWindow && !mainWindow.isFocused()) new Notification({ title: payload.title.slice(0, 120), body: payload.body.slice(0, 500) }).show();
});

/* ---------- lifecycle ---------- */

app.whenReady().then(() => {
  database = openDatabase(app.getPath('userData'));
  database.recoverInterruptedTasks();
  orchestrator = new TaskOrchestrator({ database, scheduler });
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('before-quit', () => scheduler.cancelAll());
app.on('will-quit', () => { if (database) database.close(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
