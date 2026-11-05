import React, { useEffect, useMemo, useRef, useState } from 'react';
import { validateDownloadRequest } from './ipc-contracts';
import {
  ArrowDownToLine, Check, CircleAlert, CircleCheck, ClipboardPaste, Clock3, Film, Folder,
  FolderOpen, History, ListPlus, LoaderCircle, Minus, Music2, RefreshCw, RotateCcw,
  Settings2, Square, Trash2, X
} from 'lucide-react';

/* ---------- constants & helpers ---------- */

const DEFAULT_SETTINGS = { retries: 5, skipExisting: true, subfolder: true, numbering: false, deepVerify: false, subtitles: false, automaticCaptions: false, subtitleLanguages: 'all', thumbnails: false, metadataSidecar: false };
const QUALITIES = [
  ['best', 'Best available'], ['2160', '2160p (4K)'], ['1440', '1440p'],
  ['1080', '1080p'], ['720', '720p'], ['480', '480p']
];
const PHASE_LABEL = {
  preparing: 'Getting ready', video: 'Downloading video', audio: 'Downloading audio', download: 'Downloading',
  merging: 'Merging video and audio', converting: 'Converting', finishing: 'Finishing up', verifying: 'Checking files'
};

const readStored = (key, fallback) => {
  try { const v = JSON.parse(localStorage.getItem(key)); return v ?? fallback; } catch { return fallback; }
};
const pad = (n) => String(n).padStart(2, '0');
const formatDuration = (s) => {
  if (!s) return '';
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
};
const formatTotal = (s) => {
  if (!s) return '';
  const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
  return h ? `${h} h ${m} min` : `${Math.max(1, m)} min`;
};
const formatBytes = (n) => {
  if (!Number.isFinite(n) || n <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / (1024 ** index)).toFixed(index ? 1 : 0)} ${units[index]}`;
};
const shortPath = (p) => {
  if (!p) return '';
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.length <= 2 ? p : `…/${parts.slice(-2).join('/')}`;
};
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const qualityLabel = (item) => (item.format === 'mp3' ? 'MP3' : `MP4 · ${item.quality === 'best' ? 'best' : `${item.quality}p`}`);
const isPending = (item) => ['waiting', 'failed', 'cancelled', 'interrupted'].includes(item.status);

/* ---------- small components ---------- */

function Switch({ checked, onChange, label }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label}
      className={`switch ${checked ? 'on' : ''}`} onClick={() => onChange(!checked)}><i /></button>
  );
}

function Logo() {
  return (
    <span className="logo" aria-hidden="true">
      <svg viewBox="0 0 24 24" width="22" height="22">
        <rect x="2" y="3.5" width="20" height="3.4" rx="1.7" fill="currentColor" />
        <rect x="2" y="9.4" width="20" height="3.4" rx="1.7" fill="currentColor" />
        <rect x="2" y="15.3" width="20" height="3.4" rx="1.7" fill="currentColor" />
        <rect x="2" y="15.3" width="11" height="3.4" rx="1.7" fill="var(--orange)" />
      </svg>
    </span>
  );
}

function Stepper({ step }) {
  const steps = ['Paste link', 'Pick videos', 'Download'];
  return (
    <ol className="stepper" aria-label="Progress">
      {steps.map((label, i) => {
        const n = i + 1;
        const state = n < step ? 'done' : n === step ? 'active' : 'todo';
        return (
          <li key={label} className={`step ${state}`} aria-current={state === 'active' ? 'step' : undefined}>
            <span className="step-dot">{state === 'done' ? <Check size={12} strokeWidth={3} /> : n}</span>
            <span className="step-label">{label}</span>
          </li>
        );
      })}
    </ol>
  );
}

/** One segment per video. Done = filled, current = fills with that video's progress. */
function Tape({ total, current, percent, overall, finishing }) {
  const n = Math.max(1, total || 1);
  if (n > 60) {
    return <div className="tape-bar" role="progressbar" aria-valuenow={Math.round(overall)} aria-valuemin={0} aria-valuemax={100}><i style={{ width: `${overall}%` }} /></div>;
  }
  return (
    <div className="tape" role="progressbar" aria-valuenow={Math.round(overall)} aria-valuemin={0} aria-valuemax={100}>
      {Array.from({ length: n }, (_, i) => {
        const done = finishing || i < current - 1;
        const active = !finishing && i === current - 1;
        return <span key={i} className={`seg ${done ? 'done' : ''} ${active ? 'active' : ''}`}><i style={active ? { width: `${percent}%` } : undefined} /></span>;
      })}
    </div>
  );
}

function SettingsDialog({ open, onClose, settings, setSettings, engine, onUpdate, onForget }) {
  const ref = useRef(null);
  const [engineNote, setEngineNote] = useState('');
  const [updating, setUpdating] = useState(false);
  const [forgetNote, setForgetNote] = useState('');

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  const set = (key) => (value) => setSettings((s) => ({ ...s, [key]: value }));

  async function update() {
    setUpdating(true); setEngineNote('');
    try {
      const r = await onUpdate();
      setEngineNote(r.changed ? `Updated to ${r.after}` : 'Already up to date');
    } catch (e) { setEngineNote(e.message || 'Update failed. Check your connection.'); }
    setUpdating(false);
  }
  async function forget() { await onForget(); setForgetNote('Done. Everything can be downloaded again.'); }

  return (
    <dialog ref={ref} className="dialog" onClose={onClose} onClick={(e) => { if (e.target === ref.current) onClose(); }}>
      <div className="dialog-card">
        <header className="dialog-head">
          <h2>Settings</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close settings"><X size={18} /></button>
        </header>

        <section className="setting-group">
          <h3>Saving</h3>
          <div className="setting-row"><div><strong>Give each playlist its own folder</strong><span>Keeps playlists from mixing together.</span></div><Switch checked={settings.subfolder} onChange={set('subfolder')} label="Give each playlist its own folder" /></div>
          <div className="setting-row"><div><strong>Number files in playlist order</strong><span>Puts the video’s position number before each file name.</span></div><Switch checked={settings.numbering} onChange={set('numbering')} label="Number files in playlist order" /></div>
          <div className="setting-row"><div><strong>Skip videos I already downloaded</strong><span>Remembers each video, separately for MP4 and MP3.</span></div><Switch checked={settings.skipExisting} onChange={set('skipExisting')} label="Skip videos I already downloaded" /></div>
          <div className="setting-row slim"><button className="btn btn-quiet small" onClick={forget}>Forget downloaded videos</button><span className="note-inline">{forgetNote}</span></div>
        </section>

        <section className="setting-group">
          <h3>Reliability</h3>
          <div className="setting-row"><div><strong>Retry failed downloads</strong><span>How many times each file is retried.</span></div>
            <select className="select" value={settings.retries} onChange={(e) => set('retries')(Number(e.target.value))} aria-label="Retries">
              {[2, 3, 5, 10].map((n) => <option key={n} value={n}>{n} times</option>)}
            </select></div>
          <div className="setting-row"><div><strong>Full file check after download</strong><span>Plays through each file to catch damage. Slower on long videos.</span></div><Switch checked={settings.deepVerify} onChange={set('deepVerify')} label="Full file check after download" /></div>
        </section>

        <section className="setting-group">
          <h3>Download engine</h3>
          <div className="setting-row"><div><strong>yt-dlp {engine.version || ''}</strong><span>{engineNote || 'If downloads suddenly fail, updating usually fixes it.'}</span></div>
            <button className="btn btn-quiet small" onClick={update} disabled={updating || engine.state !== 'ready'}>{updating ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}Update</button></div>
        </section>
      </div>
    </dialog>
  );
}

/* ---------- app ---------- */

export default function App() {
  const [url, setUrl] = useState('');
  const [folder, setFolder] = useState(() => readStored('droplist-folder', ''));
  const [format, setFormat] = useState(() => readStored('droplist-format', 'mp4'));
  const [quality, setQuality] = useState(() => readStored('droplist-quality', '1080'));
  const [settings, setSettings] = useState(() => ({ ...DEFAULT_SETTINGS, ...readStored('droplist-settings', {}) }));
  const [history, setHistory] = useState(() => readStored('droplist-history', []));
  const [queue, setQueue] = useState([]);
  const [queueReady, setQueueReady] = useState(false);

  const [preview, setPreview] = useState(null);
  const [inspectionFailures, setInspectionFailures] = useState([]);
  const [selected, setSelected] = useState(() => new Set());
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState(null);       // { tone: 'error' | 'info', text, hint }
  const [engine, setEngine] = useState({ state: 'idle', version: '' });
  const [running, setRunning] = useState(false);
  const [live, setLive] = useState(null);
  const [tab, setTab] = useState('queue');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [flashId, setFlashId] = useState(null);

  const lastClicked = useRef(null);
  const cancelRef = useRef(false);
  const queueRef = useRef(queue);
  queueRef.current = queue;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  useEffect(() => localStorage.setItem('droplist-folder', JSON.stringify(folder)), [folder]);
  useEffect(() => localStorage.setItem('droplist-format', JSON.stringify(format)), [format]);
  useEffect(() => localStorage.setItem('droplist-quality', JSON.stringify(quality)), [quality]);
  useEffect(() => localStorage.setItem('droplist-settings', JSON.stringify(settings)), [settings]);
  useEffect(() => localStorage.setItem('droplist-history', JSON.stringify(history.slice(0, 40))), [history]);
  useEffect(() => { if (queueReady) window.downloader.saveQueue(queue).catch(() => {}); }, [queue, queueReady]);
  useEffect(() => { if (queueReady) window.downloader.saveHistory(history.slice(0, 100)).catch(() => {}); }, [history, queueReady]);
  useEffect(() => { if (queueReady) window.downloader.saveSettings({ folder, format, quality, ...settings }).catch(() => {}); }, [folder, format, quality, settings, queueReady]);

  useEffect(() => {
    Promise.all([window.downloader.getDefaults(), window.downloader.migrateLegacy({
      settings: { folder, format, quality, ...settings }, history: readStored('droplist-history', [])
    })]).then(([d, saved]) => {
      setFolder((value) => saved.settings.folder || value || d.downloads);
      setQueue((saved.tasks || []).map((task) => task.status === 'running' ? { ...task, status: 'interrupted', note: 'The app closed before this task finished. Retry it to continue.' } : task));
      setHistory(saved.history || []);
      setFormat(saved.settings.format || 'mp4');
      setQuality(saved.settings.quality || '1080');
      const { folder: _folder, format: _format, quality: _quality, ...savedPreferences } = saved.settings;
      setSettings((value) => ({ ...value, ...savedPreferences }));
      setQueueReady(true);
    }).catch((error) => { setNotice({ tone: 'error', text: 'Could not load the saved queue.', hint: error.message || 'Stored tasks were left untouched. Restart the app and retry.' }); });
    return window.downloader.onEngine((e) => setEngine((prev) => ({ ...prev, ...e })));
  }, []);

  useEffect(() => window.downloader.onProgress((ev) => {
    setLive((prev) => {
      if (!prev) return prev;
      switch (ev.type) {
        case 'item': return { ...prev, title: ev.title, current: ev.current, total: ev.total || prev.total, percent: 0, speed: '', eta: '', phase: 'video' };
        case 'phase': return { ...prev, phase: ev.phase };
        case 'progress': return { ...prev, percent: ev.percent, overall: ev.overall, speed: ev.speed || prev.speed, eta: ev.eta || prev.eta, current: ev.current || prev.current, total: ev.total || prev.total };
        case 'verify': return { ...prev, phase: 'verifying', verify: { index: ev.index, total: ev.total } };
        default: return prev;
      }
    });
  }), []);

  const pending = queue.filter(isPending);
  const hasFinished = queue.some((i) => i.status === 'done');
  const step = running ? 3 : preview ? 2 : pending.length ? 3 : 1;

  const selectedList = useMemo(() => (preview ? preview.entries.filter((e) => selected.has(e.index)) : []), [preview, selected]);
  const selectedSeconds = selectedList.reduce((sum, e) => sum + (e.duration || 0), 0);
  const totalSeconds = preview ? preview.entries.reduce((sum, e) => sum + (e.duration || 0), 0) : 0;
  const allSelected = preview && selected.size === preview.entries.length;
  const previewSources = preview ? (preview.sources || [preview]) : [];
  const selectedSources = previewSources.filter((source, sourceIndex) => !preview?.sources || preview.entries.some((entry) => entry.sourceIndex === sourceIndex && selected.has(entry.index)));
  const hasMediaSelection = selectedSources.some((source) => source.providerId === 'yt-dlp');
  const hasVideoFormats = selectedSources.some((source) => source.capabilities?.videoFormats);
  const hasAudioFormats = selectedSources.some((source) => source.capabilities?.audioFormats);
  const availableQualities = [...new Set(selectedSources.flatMap((source) => source.qualities || []))].sort((a, b) => b - a);
  const supportsItemSelection = selectedSources.some((source) => source.capabilities?.itemSelection);
  const supportsSubtitles = selectedSources.some((source) => source.capabilities?.subtitles);
  const supportsAutomaticCaptions = selectedSources.some((source) => source.capabilities?.automaticCaptions);
  const supportsThumbnails = selectedSources.some((source) => source.capabilities?.thumbnailExtraction);
  const supportsMetadataSidecar = selectedSources.some((source) => source.capabilities?.metadataExtraction && source.providerId === 'yt-dlp');

  useEffect(() => {
    const heights = selectedSources.flatMap((source) => source.qualities || []);
    if (format === 'mp4' && heights.length && quality !== 'best' && !heights.includes(Number(quality))) setQuality('best');
  }, [preview, selected.size, format]);

  /* ----- actions ----- */

  async function inspect(raw = url) {
    const links = [...new Set(raw.split(/[\r\n]+/).map((value) => value.trim()).filter(Boolean))];
    setNotice(null);
    if (!links.length) return setNotice({ tone: 'error', text: 'Paste one or more links first.' });
    if (links.length > 50) return setNotice({ tone: 'error', text: 'Add up to 50 links at a time.' });
    setLoading(true); setPreview(null); setInspectionFailures([]);
    try {
      const inspected = await window.downloader.inspectSources(links);
      const successful = inspected.flatMap((item) => item.status === 'fulfilled' ? [{ ...item.result, inputUrl: item.url }] : []);
      const failures = inspected.flatMap((item) => item.status === 'failed' || item.status === 'duplicate' ? [{ url: item.url, message: item.status === 'duplicate' ? `Duplicate of link ${item.duplicateOf + 1} in this batch.` : `${item.category}: ${item.message}` }] : []);
      const sources = [...new Map(successful.map((source) => [source.url, source])).values()];
      setInspectionFailures(failures);
      if (!sources.length) {
        setPreview(null);
        setNotice({ tone: 'error', text: `Could not inspect any of the ${links.length} links.`, hint: failures[0]?.message || 'Check the link and try again.' });
        return;
      }
      const entries = sources.flatMap((info, sourceIndex) => info.entries.map((entry) => ({ ...entry, sourceItemIndex: entry.index, sourceSize: info.size, sourceMimeType: info.mimeType, index: 0, sourceIndex })));
      entries.forEach((entry, index) => { entry.index = index + 1; });
      const info = sources.length === 1 ? { ...sources[0], entries, sources } : { kind: 'inbox', title: `${sources.length} links ready for review`, uploader: 'Multiple sources', count: entries.length, entries, sources };
      if (!info.entries.length) throw new Error('No downloadable items were found at these links.');
      setPreview(info);
      setSelected(new Set(info.entries.map((e) => e.index)));
      lastClicked.current = null;
    } catch (e) {
      setNotice({ tone: 'error', text: (e.message || 'Could not read these links.').replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), hint: 'Unsupported, private, or temporarily unavailable sources are reported here.' });
    } finally { setLoading(false); }
  }

  async function pasteFromClipboard() {
    const text = await window.downloader.readClipboard();
    if (!text) return setNotice({ tone: 'error', text: 'The clipboard is empty.' });
    setUrl(text);
    inspect(text);
  }

  function onUrlPaste(e) {
    const text = e.clipboardData.getData('text').trim();
    if (/https?:\/\//i.test(text)) { e.preventDefault(); setUrl(text); inspect(text); }
  }

  function clearSource() { setUrl(''); setPreview(null); setInspectionFailures([]); setNotice(null); setSelected(new Set()); }

  function toggleEntry(index, shift) {
    setSelected((prev) => {
      const next = new Set(prev);
      const turnOn = !prev.has(index);
      if (shift && lastClicked.current !== null) {
        const [a, b] = [lastClicked.current, index].sort((x, y) => x - y);
        for (let i = a; i <= b; i++) turnOn ? next.add(i) : next.delete(i);
      } else {
        turnOn ? next.add(index) : next.delete(index);
      }
      return next;
    });
    lastClicked.current = index;
  }

  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(preview.entries.map((e) => e.index)));
  }

  async function chooseFolder() {
    const picked = await window.downloader.chooseFolder();
    if (picked) setFolder(picked);
  }

  function addToQueue() {
    if (!preview || !selected.size) return;
    const sources = preview.sources || [preview];
    const additions = [];
    sources.forEach((source, sourceIndex) => {
      const sourceEntries = preview.entries.filter((entry) => (preview.sources ? entry.sourceIndex === sourceIndex : true));
      const chosen = sourceEntries.filter((entry) => selected.has(entry.index));
      if (!chosen.length) return;
      const media = source.providerId === 'yt-dlp';
      const sourceFormat = media && source.mediaType === 'image' ? 'image' : media && !source.capabilities?.videoFormats && source.capabilities?.audioFormats ? 'mp3' : format;
      const isWhole = chosen.length === sourceEntries.length;
      const itemUrl = source.url || url.trim();
      if (queue.some((item) => item.url === itemUrl && (isPending(item) || item.status === 'done')) || history.some((entry) => entry.url === itemUrl) || additions.some((item) => item.url === itemUrl)) return;
      additions.push({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}-${sourceIndex}`,
        providerId: source.providerId, url: itemUrl, kind: source.kind, title: source.title, uploader: source.uploader,
        total: chosen.length, selected: isWhole || !media ? null : chosen.map((entry) => entry.sourceItemIndex), format: media ? sourceFormat : 'mp4', quality: media ? quality : 'best', folder,
        subfolder: media && ['playlist', 'channel', 'imageCollection'].includes(source.kind) && settings.subfolder ? source.title : '',
        subtitles: !!(settings.subtitles && source.capabilities?.subtitles), automaticCaptions: !!(settings.automaticCaptions && source.capabilities?.automaticCaptions),
        subtitleLanguages: settings.subtitleLanguages || 'all', thumbnails: !!(settings.thumbnails && source.capabilities?.thumbnailExtraction),
        metadataSidecar: !!(settings.metadataSidecar && source.capabilities?.metadataExtraction && media),
        mediaInfo: { extractor: source.extractor || (media ? 'yt-dlp' : 'HTTP'), sourceWebsite: source.sourceWebsite || '', mediaType: source.mediaType || source.kind,
          originalTitle: source.originalTitle || source.title, duration: source.duration || null, thumbnail: source.thumbnail || null,
          playlistId: source.playlistId || null, metadata: source.metadata || {},
          entries: chosen.map((entry) => ({ id: entry.id, title: entry.title, duration: entry.duration, mediaType: entry.mediaType })) },
        status: 'waiting', note: '' });
    });
    if (!additions.length) return setNotice({ tone: 'info', text: 'These links are already queued or none are selected.' });
    setQueue((items) => [...items, ...additions]);
    const id = additions[0].id;
    setFlashId(id); setTimeout(() => setFlashId(null), 1400);
    setTab('queue'); clearSource();
  }

  const patchItem = (id, patch) => setQueue((items) => items.map((i) => (i.id === id ? { ...i, ...patch } : i)));
  const removeItem = (id) => setQueue((items) => items.filter((i) => i.id !== id));

  async function startQueue() {
    if (running) return;
    if (!folder) return setNotice({ tone: 'error', text: 'Choose a save folder first.' });
    cancelRef.current = false;
    setRunning(true); setTab('queue'); setNotice(null);
    let completed = 0, failed = 0;

    for (const id of queueRef.current.filter(isPending).map((i) => i.id)) {
      if (cancelRef.current) break;
      const item = queueRef.current.find((i) => i.id === id);
      if (!item) continue;
      patchItem(id, { status: 'running', note: '' });
      setLive({ itemId: id, providerId: item.providerId, title: item.title, current: 0, total: item.total, percent: 0, overall: 0, phase: 'preparing', speed: '', eta: '' });

      let result;
      try {
        result = await window.downloader.run(validateDownloadRequest({
          id: item.id, title: item.title, url: item.url, providerId: item.providerId, folder: item.folder || folder, subfolder: item.subfolder, quality: item.quality, format: item.format,
          selected: item.selected, expectedTotal: item.total, retries: settingsRef.current.retries,
          skipExisting: settingsRef.current.skipExisting, numbering: settingsRef.current.numbering, deepVerify: settingsRef.current.deepVerify,
          subtitles: item.subtitles, automaticCaptions: item.automaticCaptions, subtitleLanguages: item.subtitleLanguages,
          thumbnails: item.thumbnails, metadataSidecar: item.metadataSidecar, mediaInfo: item.mediaInfo
        }));
      } catch (e) {
        result = { status: 'error', message: (e.message || 'Download failed').replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), hint: '' };
      }

      if (result.status === 'completed') {
        completed += 1;
        const issues = result.issues?.length ? ` · ${plural(result.issues.length, 'file')} need a look: ${result.issues[0]}` : '';
        patchItem(id, { status: 'done', note: `${result.message}${issues}`, outFolder: result.folder });
        setHistory((h) => [{ id: item.id, taskId: item.id, providerId: item.providerId, url: item.url, kind: item.kind, title: item.title, count: result.done + result.skipped || 1, date: new Date().toISOString(), folder: result.folder, format: item.format, files: result.files || [], mediaInfo: item.mediaInfo }, ...h].slice(0, 40));
      } else if (result.status === 'cancelled') {
        patchItem(id, { status: 'cancelled', note: result.message });
        break;
      } else {
        failed += 1;
        patchItem(id, { status: 'failed', note: [result.message, result.hint].filter(Boolean).join(' ') });
      }
    }

    setRunning(false); setLive(null);
    if (!cancelRef.current) {
      window.downloader.notify({ title: 'Droplist', body: failed ? `${completed} finished, ${failed} need attention.` : 'All downloads are finished.' });
    }
  }

  async function cancel() { cancelRef.current = true; await window.downloader.cancel(live?.itemId); }

  /* ----- render ----- */

  const folderMissing = !folder;
  const startLabel = pending.length && pending.every((i) => i.status === 'waiting')
    ? `Start ${plural(pending.length, 'download')}` : `Run ${pending.length} unfinished`;
  const overall = live?.overall ?? 0;

  return (
    <div className="shell">
      <main className="sheet">
        <header className="sheet-head">
          <div className="brand"><Logo /><span className="wordmark">droplist</span></div>
          <Stepper step={step} />
          <div className="head-tools">
            <span className={`engine-chip ${engine.state}`} title={engine.message || ''}>
              {engine.state === 'idle' && <>yt-dlp will install when needed</>}
              {engine.state === 'installing' && <><LoaderCircle className="spin" size={13} /> Setting up engine</>}
              {engine.state === 'ready' && <><i /> Engine {engine.version}</>}
              {engine.state === 'error' && <button onClick={() => { setEngine({ state: 'installing', version: '' }); window.downloader.prepareEngine().catch(() => {}); }}><CircleAlert size={13} /> Engine problem · Retry</button>}
            </span>
            <button className="icon-btn" onClick={() => setSettingsOpen(true)} aria-label="Open settings"><Settings2 size={18} /></button>
          </div>
        </header>

        <section className="source" aria-label="Link">
          <div className={`url-field ${loading ? 'busy' : ''}`}>
            <textarea id="url" value={url} placeholder="Paste a video, playlist, or direct file link" spellCheck={false} autoFocus rows={1}
              onChange={(e) => setUrl(e.target.value)} onPaste={onUrlPaste} onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && (e.preventDefault(), inspect())} aria-label="Links to inspect" />
            {url && <button className="icon-btn" onClick={clearSource} aria-label="Clear link"><X size={16} /></button>}
            <button className="btn btn-ink" onClick={url.trim() ? () => inspect() : pasteFromClipboard} disabled={loading}>
              {loading ? <><LoaderCircle className="spin" size={16} /> Reading…</> : url.trim() ? 'Preview' : <><ClipboardPaste size={16} /> Paste link</>}
            </button>
          </div>

          <div className="save-bar">
            <div className="field grow">
              <span className="field-label">Save to</span>
              <button className={`folder-btn ${folderMissing ? 'missing' : ''}`} onClick={chooseFolder} title={folder}>
                <Folder size={16} /><span>{folder ? shortPath(folder) : 'Choose a folder'}</span><em>Change</em>
              </button>
            </div>
            {(!preview || hasMediaSelection) && <div className="field">
              <span className="field-label">Format</span>
              <div className="seg-control" role="radiogroup" aria-label="Format">
                {(!preview || hasVideoFormats) && <button role="radio" aria-checked={format === 'mp4'} className={format === 'mp4' ? 'on' : ''} onClick={() => setFormat('mp4')}><Film size={15} /> MP4</button>}
                {(!preview || hasAudioFormats) && <button role="radio" aria-checked={format === 'mp3'} className={format === 'mp3' ? 'on' : ''} onClick={() => setFormat('mp3')}><Music2 size={15} /> MP3</button>}
              </div>
            </div>}
            {(!preview || (hasMediaSelection && hasVideoFormats && format === 'mp4')) && <div className="field">
              <span className="field-label">Quality</span>
              {format === 'mp4'
                ? <select className="select" value={quality} onChange={(e) => setQuality(e.target.value)} aria-label="Video quality">{availableQualities.length ? [['best', 'Best available'], ...availableQualities.map((height) => [String(height), `${height}p`])].map(([v, label]) => <option key={v} value={v}>{label}</option>) : QUALITIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
                : <span className="select static">Highest (V0)</span>}
            </div>}
          </div>

          {(supportsSubtitles || supportsAutomaticCaptions || supportsThumbnails || supportsMetadataSidecar) && <div className="asset-options" aria-label="Optional media assets">
            <span className="field-label">Also save</span>
            {supportsSubtitles && <label><input type="checkbox" checked={settings.subtitles} onChange={(event) => setSettings((value) => ({ ...value, subtitles: event.target.checked }))} /> Subtitles</label>}
            {supportsAutomaticCaptions && <label><input type="checkbox" checked={settings.automaticCaptions} onChange={(event) => setSettings((value) => ({ ...value, automaticCaptions: event.target.checked }))} /> Auto captions</label>}
            {((supportsSubtitles && settings.subtitles) || (supportsAutomaticCaptions && settings.automaticCaptions)) && <label className="language-option">Language <input aria-label="Subtitle languages" value={settings.subtitleLanguages || 'all'} onChange={(event) => setSettings((value) => ({ ...value, subtitleLanguages: event.target.value }))} placeholder="all or en,fr" /></label>}
            {supportsThumbnails && <label><input type="checkbox" checked={settings.thumbnails} onChange={(event) => setSettings((value) => ({ ...value, thumbnails: event.target.checked }))} /> Thumbnail</label>}
            {supportsMetadataSidecar && <label><input type="checkbox" checked={settings.metadataSidecar} onChange={(event) => setSettings((value) => ({ ...value, metadataSidecar: event.target.checked }))} /> Metadata sidecar</label>}
          </div>}

          {notice && (
            <div className={`notice ${notice.tone}`} role="alert">
              <CircleAlert size={17} />
              <div><strong>{notice.text}</strong>{notice.hint && <span>{notice.hint}</span>}</div>
              <button className="icon-btn" onClick={() => setNotice(null)} aria-label="Dismiss"><X size={15} /></button>
            </div>
          )}
        </section>

        <section className="sheet-body">
          {!preview && !loading && (
            <div className="empty">
              <div className="empty-art" aria-hidden="true"><span /><span /><span /><span /></div>
              <h2>Paste a link to see what’s inside</h2>
              <p>Paste a YouTube playlist or direct file link, or add several links on separate lines. Review them before anything downloads.</p>
            </div>
          )}
          {loading && (
            <div className="inspection-loading" role="status" aria-live="polite">
              <span className="sr-only">Inspecting each link independently</span>
              {[0, 1, 2].map((index) => <div className="source-skeleton" key={index}><i /><span /><span /></div>)}
            </div>
          )}
          {preview && (
            <div className="preview">
              <div className="preview-head">
                <div className="preview-title"><h2>{preview.title}</h2>
                  <p>{preview.uploader} · {preview.kind === 'file' ? 'Direct file' : preview.kind === 'inbox' ? plural(preview.entries.length, 'item') : plural(preview.entries.length, 'video')}{preview.kind === 'file' && preview.mimeType ? ` · ${preview.mimeType}` : ''}{preview.kind === 'file' && preview.size ? ` · ${formatBytes(preview.size)}` : ''}{totalSeconds ? ` · ${formatTotal(totalSeconds)}` : ''}</p></div>
                <button className="check-all" role="checkbox" aria-checked={allSelected ? true : selected.size ? 'mixed' : false} onClick={toggleAll}>
                  <span className={`box ${selected.size ? 'on' : ''}`}>{allSelected ? <Check size={13} strokeWidth={3} /> : selected.size ? <Minus size={13} strokeWidth={3} /> : null}</span>
                  {allSelected ? 'Deselect all' : 'Select all supported'}
                </button>
              </div>
              <div className="source-cards" aria-label="Inspected sources">
                {previewSources.map((source, index) => <article className="source-card" key={`${source.url}-${index}`}>
                  {source.thumbnail && <img className="source-card-thumb" src={source.thumbnail} alt="" loading="lazy" referrerPolicy="no-referrer" />}
                  <div className="source-card-copy">
                    <div className="source-card-kicker"><span className={`provider-dot ${source.providerId}`} />{source.extractor || (source.providerId === 'http' ? 'Direct file' : 'yt-dlp')} · {source.sourceWebsite || new URL(source.url).hostname}</div>
                    <h3>{source.title}</h3>
                    <p>{source.uploader}{source.duration ? ` · ${formatDuration(source.duration)}` : ''}{source.estimatedSize || source.size ? ` · ${formatBytes(source.estimatedSize || source.size)}` : ''}{source.count > 1 ? ` · ${plural(source.count, 'item')}` : ''}</p>
                    <div className="capability-chips">
                      {source.capabilities?.videoFormats && <span>Video</span>}{source.capabilities?.audioFormats && <span>Audio</span>}
                      {source.capabilities?.subtitles && <span>Subtitles</span>}{source.capabilities?.automaticCaptions && <span>Auto captions</span>}
                      {source.capabilities?.formatMerging && <span>FFmpeg merge</span>}{source.supportsRange && <span>Resume</span>}
                      {source.qualities?.length > 0 && <span>{source.qualities.slice(0, 4).map((height) => `${height}p`).join(' · ')}</span>}
                    </div>
                    {source.formats?.length > 0 && <p className="source-languages">Formats: {[...new Set(source.formats.map((format) => format.ext).filter(Boolean))].slice(0, 6).join(', ')}</p>}
                    {source.subtitles?.length > 0 && <p className="source-languages">Subtitles: {source.subtitles.slice(0, 8).join(', ')}{source.subtitles.length > 8 ? '…' : ''}</p>}
                    {source.unavailableCount > 0 && <p className="source-languages">{plural(source.unavailableCount, 'unavailable entry')} excluded</p>}
                    {(source.kind === 'file' || source.kind === 'image') && <p className="source-languages">{source.extension ? `.${source.extension}` : ''}{source.mimeType ? ` · ${source.mimeType}` : ''}{source.size ? ` · ${formatBytes(source.size)}` : ''}{source.supportsRange ? ' · Resumable' : ''}</p>}
                  </div>
                </article>)}
              </div>
              {inspectionFailures.length > 0 && <div className="inspection-failures" role="status">
                <strong>{plural(inspectionFailures.length, 'link')} could not be inspected</strong>
                {inspectionFailures.map((failure) => <p key={failure.url}><span>{failure.url}</span>{failure.message}</p>)}
              </div>}
              <ul className="video-list">
                {preview.entries.map((e) => (
                  <li key={`${e.id}-${e.index}`}>
                    <label className={`video-row ${selected.has(e.index) ? 'on' : ''}`}>
                      <input type="checkbox" checked={selected.has(e.index)} onChange={() => {}} onClick={(ev) => toggleEntry(e.index, ev.shiftKey)} />
                      <span className="box">{selected.has(e.index) && <Check size={13} strokeWidth={3} />}</span>
                      <span className="vnum">{e.index}</span>
                      <span className="thumb">{e.thumbnail && <img src={e.thumbnail} alt="" loading="lazy" draggable="false" />}</span>
                      <span className="vtitle">{e.title}</span>
                      <span className="vdur">{e.sourceSize ? formatBytes(e.sourceSize) : formatDuration(e.duration)}</span>
                    </label>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>

        {preview && (
          <footer className="sheet-foot">
            <div className="foot-info">
              <strong>{supportsItemSelection ? `${selected.size} of ${preview.entries.length} selected` : `${plural(preview.entries.length, preview.kind === 'inbox' ? 'item' : 'file')} ready`}</strong>
              <span>{preview.kind === 'file' ? `${preview.mimeType || 'File'}${preview.size ? ` · ${formatBytes(preview.size)}` : ''}` : selectedSeconds ? formatTotal(selectedSeconds) : 'Hold Shift to select a range'}</span>
            </div>
            <button className="btn btn-orange" onClick={addToQueue} disabled={!selected.size}><ListPlus size={18} /> Add {selected.size === 1 ? (preview.kind === 'file' ? 'file' : '1 item') : `${selected.size} items`} to queue</button>
          </footer>
        )}
      </main>

      <aside className="rail" aria-label="Queue">
        <header className="rail-head">
          <div className="rail-tabs" role="tablist">
            <button role="tab" aria-selected={tab === 'queue'} className={tab === 'queue' ? 'on' : ''} onClick={() => setTab('queue')}>Queue{queue.length > 0 && <b>{queue.length}</b>}</button>
            <button role="tab" aria-selected={tab === 'history'} className={tab === 'history' ? 'on' : ''} onClick={() => setTab('history')}><History size={14} /> History</button>
          </div>
          {tab === 'queue' && hasFinished && !running && <button className="link-btn" onClick={() => setQueue((q) => q.filter((i) => i.status !== 'done'))}>Clear finished</button>}
        </header>

        {running && live && (
          <section className="now" aria-live="polite">
            <p className="now-count">{live.providerId === 'http' ? 'Direct file download' : live.phase === 'preparing' ? 'Getting ready' : live.phase === 'verifying' ? 'Almost done' : `Video ${Math.max(1, live.current)} of ${live.total || '?'}`}</p>
            <h3 className="now-title">{live.title}</h3>
            <Tape total={live.total} current={live.current} percent={live.percent} overall={overall} finishing={live.phase === 'verifying'} />
            <div className="now-meta">
              <span>{live.phase === 'verifying' && live.verify ? `Checking file ${live.verify.index} of ${live.verify.total}` : PHASE_LABEL[live.phase] || 'Downloading'}{['video', 'audio', 'download'].includes(live.phase) ? ` · ${Math.round(live.percent)}%` : ''}</span>
              <span>{live.speed}{live.speed && live.eta ? ' · ' : ''}{live.eta && <><Clock3 size={12} /> {live.eta}</>}</span>
            </div>
          </section>
        )}

        <div className="rail-body">
          {tab === 'queue' && (queue.length ? (
            <ul className="q-list">
              {queue.map((item) => (
                <li key={item.id} className={`q-item ${item.status} ${flashId === item.id ? 'flash' : ''}`}>
                  <span className="q-state" aria-label={item.status}>
                    {item.status === 'done' ? <CircleCheck size={18} /> : item.status === 'failed' ? <CircleAlert size={18} /> : item.status === 'running' ? <LoaderCircle className="spin" size={18} /> : item.status === 'cancelled' ? <Square size={14} /> : <i />}
                  </span>
                  <div className="q-copy">
                    <strong>{item.title}</strong>
                    <span>{item.providerId === 'http' ? 'Direct file · HTTP(S)' : `${plural(item.total, 'video')} · ${qualityLabel(item)}`}</span>
                    {item.note && <em className={item.status === 'failed' ? 'bad' : ''}>{item.note}</em>}
                  </div>
                  <div className="q-actions">
                    {item.status === 'done' && item.outFolder && <button className="icon-btn dark" onClick={() => window.downloader.openFolder(item.outFolder)} aria-label="Open folder" title="Open folder"><FolderOpen size={16} /></button>}
                    {item.status !== 'running' && <button className="icon-btn dark" onClick={() => removeItem(item.id)} aria-label={`Remove ${item.title}`} title="Remove"><Trash2 size={16} /></button>}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <div className="rail-empty"><ArrowDownToLine size={22} /><strong>Nothing queued yet</strong><span>Playlists you add show up here and download one after another.</span></div>
          ))}

          {tab === 'history' && (history.length ? (
            <ul className="q-list">
              {history.map((h, i) => (
                <li key={`${h.date}-${i}`} className="q-item done">
                  <span className="q-state"><CircleCheck size={18} /></span>
                  <div className="q-copy"><strong>{h.title}</strong><span>{h.providerId === 'http' ? 'Direct file' : `${plural(h.count, 'item')} · ${h.format === 'mp3' ? 'MP3' : 'MP4'}`} · {new Date(h.date).toLocaleDateString()}</span></div>
                  <div className="q-actions"><button className="icon-btn dark" onClick={() => window.downloader.openFolder(h.folder)} aria-label="Open folder" title="Open folder"><FolderOpen size={16} /></button></div>
                </li>
              ))}
            </ul>
          ) : (
            <div className="rail-empty"><History size={22} /><strong>No history yet</strong><span>Finished downloads are listed here.</span></div>
          ))}
        </div>

        <footer className="rail-foot">
          {running ? (
            <button className="btn btn-stop" onClick={cancel}><Square size={14} fill="currentColor" /> Cancel download</button>
          ) : (
            <button className="btn btn-orange wide" onClick={startQueue} disabled={!pending.length || folderMissing || (engine.state === 'error' && pending.some((item) => item.providerId === 'yt-dlp'))}>
              {pending.length ? <><ArrowDownToLine size={18} /> {startLabel}</> : 'Queue is empty'}
            </button>
          )}
          <p className="foot-note">
            {running ? 'Closing the app interrupts this. Resume is available when the source supports it.'
              : folderMissing ? 'Choose a save folder to begin.'
              : pending.some((i) => i.status !== 'waiting') ? <><RotateCcw size={12} /> Interrupted and failed items can be retried.</>
              : <>Saving to {shortPath(folder)}</>}
          </p>
        </footer>
      </aside>

      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} settings={settings} setSettings={setSettings}
        engine={engine} onUpdate={() => window.downloader.updateEngine()} onForget={() => window.downloader.clearArchive()} />
    </div>
  );
}
