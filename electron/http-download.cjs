'use strict';

const fs = require('node:fs');
const path = require('node:path');
const dns = require('node:dns').promises;
const net = require('node:net');
const http = require('node:http');
const https = require('node:https');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { exec } = require('./downloader.cjs');

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const HTML_MIME = /^(text\/html|application\/(xhtml\+xml|html))\b/i;

function isPrivateAddress(address) {
  if (net.isIPv4(address)) {
    const [a, b] = address.split('.').map(Number);
    const c = Number(address.split('.')[2]);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 0 || b === 168 || b === 88 && c === 99)) ||
      (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19 || b === 51 && c === 100)) ||
      (a === 203 && b === 0 && c === 113) || a >= 224;
  }
  if (!net.isIPv6(address)) return true;
  const words = parseIPv6(address);
  if (!words) return true;
  if (words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff) {
    const mapped = `${words[6] >> 8}.${words[6] & 255}.${words[7] >> 8}.${words[7] & 255}`;
    return isPrivateAddress(mapped);
  }
  const value = words.reduce((sum, word) => (sum << 16n) | BigInt(word), 0n);
  // Only global unicast (2000::/3) is accepted. Special transition, documentation,
  // and protocol-assignment ranges are excluded even though some are globally scoped.
  if ((value >> 125n) !== 1n) return true;
  if (words[0] === 0x2001 && (words[1] <= 0x01ff || words[1] === 0x0db8)) return true;
  if (words[0] === 0x3fff && (words[1] & 0xfff0) === 0) return true;
  if (words[0] === 0x2002 || (words[0] === 0x0064 && words[1] === 0xff9b && words.slice(2, 6).every((word) => word === 0))) return true;
  return false;
}

function parseIPv6(address) {
  let value = address.toLowerCase().split('%')[0];
  if (value.includes('.')) {
    const split = value.lastIndexOf(':');
    const ipv4 = value.slice(split + 1);
    if (!net.isIPv4(ipv4)) return null;
    const [a, b, c, d] = ipv4.split('.').map(Number);
    value = `${value.slice(0, split)}:${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = value.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':').map((part) => parseInt(part, 16)) : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':').map((part) => parseInt(part, 16)) : [];
  const missing = 8 - left.length - right.length;
  if (missing < (halves.length === 2 ? 1 : 0)) return null;
  const result = [...left, ...Array(missing).fill(0), ...right];
  return result.length === 8 && result.every((part) => Number.isInteger(part) && part >= 0 && part <= 0xffff) ? result : null;
}

function makeDnsError(message = 'The source hostname did not resolve to a valid IP address.') {
  const error = new Error(message);
  error.code = 'ENOTFOUND';
  return error;
}

function normalizeAddresses(addresses) {
  if (!Array.isArray(addresses) || !addresses.length) throw makeDnsError('The source hostname returned no IP addresses.');
  const normalized = addresses.map((item) => {
    if (!item || typeof item !== 'object') throw makeDnsError();
    const { address, family } = item;
    const actualFamily = net.isIP(address);
    if (!actualFamily || (family !== 4 && family !== 6) || actualFamily !== family) throw makeDnsError();
    return { address, family: actualFamily };
  });
  return normalized;
}

function createPinnedLookup(addresses) {
  let pinned;
  try { pinned = normalizeAddresses(addresses); } catch (error) {
    return (_hostname, options, callback) => {
      if (typeof options === 'function') callback = options;
      if (typeof callback === 'function') callback(error);
    };
  }
  return (_hostname, options, callback) => {
    if (typeof options === 'function') { callback = options; options = {}; }
    else if (typeof options === 'number') options = { family: options };
    else if (!options || typeof options !== 'object') options = {};
    if (typeof callback !== 'function') return;
    const family = options.family === 4 || options.family === 6 ? options.family : 0;
    const matches = family ? pinned.filter((item) => item.family === family) : pinned;
    if (!matches.length) { callback(makeDnsError('The validated source IP does not match the requested address family.')); return; }
    if (options.all === true) callback(null, matches.map((item) => ({ ...item })));
    else callback(null, matches[0].address, matches[0].family);
  };
}

async function resolveTarget(url, allowPrivateAddresses, lookup = dns.lookup) {
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    const error = new Error('Local network addresses are blocked for downloads.'); error.code = 'SECURITY_BLOCKED'; throw error;
  }
  const literalFamily = net.isIP(hostname);
  let addresses;
  try { addresses = literalFamily ? [{ address: hostname, family: literalFamily }] : await lookup(hostname, { all: true, verbatim: true }); }
  catch (error) { throw error; }
  const validated = normalizeAddresses(addresses);
  if (!allowPrivateAddresses && validated.some(({ address }) => isPrivateAddress(address))) {
    const error = new Error('The source resolves to a private, reserved, or local network address, which Droplist blocks by default.');
    error.code = 'SECURITY_BLOCKED';
    throw error;
  }
  return validated;
}

function rawRequest(url, { method = 'GET', headers = {}, signal, allowPrivateAddresses = false, timeoutMs = 30000, bodyTimeoutMs = 60000, dnsLookup, requestImpl } = {}) {
  return new Promise(async (resolve, reject) => {
    let target;
    try { target = await resolveTarget(url, allowPrivateAddresses, dnsLookup || dns.lookup); } catch (error) { reject(error); return; }
    const transport = url.protocol === 'https:' ? https : http;
    const request = (requestImpl || ((targetTransport, targetUrl, options) => targetTransport.request(targetUrl, options)))(transport, url, {
      method, headers, servername: net.isIP(url.hostname) ? undefined : url.hostname,
      lookup: createPinnedLookup(target),
      timeout: timeoutMs
    });
    const onAbort = () => request.destroy(Object.assign(new Error('Download cancelled.'), { name: 'AbortError' }));
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    request.setTimeout(timeoutMs, () => request.destroy(Object.assign(new Error('The source timed out before receiving headers.'), { code: 'ETIMEDOUT' })));
    request.once('error', (error) => { signal?.removeEventListener('abort', onAbort); reject(error); });
    request.once('response', (response) => {
      signal?.removeEventListener('abort', onAbort);
      response.setTimeout(bodyTimeoutMs, () => response.destroy(Object.assign(new Error('The source timed out while sending data.'), { code: 'ETIMEDOUT' })));
      const responseHeaders = new Headers();
      for (const [key, value] of Object.entries(response.headers)) if (value !== undefined) responseHeaders.set(key, Array.isArray(value) ? value.join(', ') : String(value));
      resolve({ status: response.statusCode || 0, ok: (response.statusCode || 0) >= 200 && (response.statusCode || 0) < 300, statusText: response.statusMessage || '', headers: responseHeaders,
        body: response.statusCode === 204 || response.statusCode === 304 || method === 'HEAD' ? null : Readable.toWeb(response), url: url.href });
    });
    request.end();
  });
}

async function safeFetch(rawUrl, options = {}) {
  let url = new URL(rawUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Only HTTP(S) redirects without embedded credentials are supported.');
  for (let redirects = 0; redirects <= 8; redirects++) {
    const response = await rawRequest(url, options);
    if (!REDIRECTS.has(response.status)) return response;
    const location = response.headers.get('location');
    await response.body?.cancel();
    if (!location || redirects === 8) throw new Error('The source returned an invalid or excessive redirect chain.');
    const next = new URL(location, url);
    if (!['http:', 'https:'].includes(next.protocol) || next.username || next.password) throw new Error('The source redirected to an unsupported URL.');
    if (url.protocol === 'https:' && next.protocol !== 'https:') throw new Error('The source redirected from HTTPS to HTTP; this downgrade is blocked.');
    url = next;
  }
  throw new Error('The source returned an invalid redirect chain.');
}

function safeFilename(value, fallback = 'download') {
  let cleaned = String(value || '').replace(/\\/g, '/').split('/').pop()
    .replace(/[<>:"|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '').trim().slice(0, 180);
  if (!cleaned || /^\.+$/.test(cleaned)) cleaned = fallback;
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(cleaned)) cleaned = `_${cleaned}`;
  return cleaned;
}

function filenameFrom(headers, url) {
  const disposition = headers.get('content-disposition') || '';
  const extended = disposition.match(/(?:^|;)\s*filename\*\s*=\s*(?:UTF-8'')?"?([^;\"]+)"?/i)?.[1]?.trim();
  const quoted = disposition.match(/(?:^|;)\s*filename\s*=\s*"((?:\\.|[^"])*)"/i)?.[1];
  const plain = disposition.match(/(?:^|;)\s*filename\s*=\s*([^;\s]+)/i)?.[1];
  let name = quoted?.replace(/\\([\\"])/g, '$1') || plain;
  if (extended) { try { name = decodeURIComponent(extended); } catch { name = extended; } }
  if (!name) name = path.basename(new URL(url).pathname) || 'download';
  return safeFilename(name);
}

function isHtml(headers, name) {
  if (HTML_MIME.test(headers.get('content-type') || '')) return true;
  return /\.(?:html?|xhtml)$/i.test(name);
}

async function inspectDirect(url, options = {}) {
  let response = await safeFetch(url, { timeoutMs: 12000, bodyTimeoutMs: 12000, ...options, method: 'HEAD' });
  if (response.status === 405 || response.status === 501) {
    await response.body?.cancel();
    response = await safeFetch(url, { timeoutMs: 12000, bodyTimeoutMs: 12000, ...options, headers: { Range: 'bytes=0-0' } });
  }
  if (response.status < 200 || response.status >= 300) {
    await response.body?.cancel();
    const error = new Error(response.status === 401 || response.status === 407 ? `Authentication is required by this source (HTTP ${response.status}).` : `The source returned HTTP ${response.status}.`);
    error.statusCode = response.status;
    if (response.status === 401 || response.status === 407) error.code = 'AUTH_REQUIRED';
    throw error;
  }
  const name = filenameFrom(response.headers, response.url || url);
  if (isHtml(response.headers, name)) { await response.body?.cancel(); const error = new Error('This link is a webpage, not a direct file.'); error.code = 'HTML_PAGE'; throw error; }
  const mimeType = (response.headers.get('content-type') || '').split(';')[0].trim() || 'application/octet-stream';
  const disposition = response.headers.get('content-disposition') || '';
  const specificApplicationType = mimeType.startsWith('application/') && mimeType !== 'application/octet-stream' && mimeType !== 'application/binary';
  const hasFileType = !!path.extname(name) || /attachment/i.test(disposition) || /^(image|video|audio)\//i.test(mimeType) || specificApplicationType || (mimeType === 'text/plain' && /attachment/i.test(disposition));
  if (!hasFileType) { await response.body?.cancel(); const error = new Error('The response does not identify itself as a downloadable file.'); error.code = 'HTML_PAGE'; throw error; }
  const size = Number(response.headers.get('content-range')?.match(/\/(\d+)$/)?.[1] || response.headers.get('content-length')) || null;
  const isImage = mimeType.startsWith('image/');
  const result = { kind: isImage ? 'image' : 'file', mediaType: isImage ? 'image' : 'file', sourceType: 'direct-file', title: name, originalTitle: name,
    extension: path.extname(name).slice(1).toLowerCase(), sourceWebsite: new URL(response.url || url).hostname,
    uploader: new URL(response.url || url).hostname, count: 1, extractor: 'HTTP',
    entries: [{ id: 'file-1', index: 1, title: name, duration: null, thumbnail: null }], size, mimeType,
    supportsRange: response.status === 206 || /bytes/i.test(response.headers.get('accept-ranges') || '') };
  await response.body?.cancel();
  return result;
}

function parseYtDlpMetadata(data, url) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('yt-dlp returned invalid source metadata.');
  const rawEntries = data._type === 'playlist' ? (data.entries || []).filter(Boolean) : [data];
  const entries = rawEntries.flatMap((entry, index) => {
    const availability = String(entry.availability || entry.status || '').toLowerCase();
    if (!entry.id || ['unavailable', 'private', 'needs_auth', 'premium_only', 'subscriber_only'].includes(availability)) return [];
    const entryFormats = Array.isArray(entry.formats) ? entry.formats : [];
    const hasPlayableMedia = entryFormats.some((format) => format?.url && ((format.vcodec && format.vcodec !== 'none') || (format.acodec && format.acodec !== 'none') || ['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(String(format.ext || '').toLowerCase()))) ||
      (!!entry.url && ((entry.vcodec && entry.vcodec !== 'none') || (entry.acodec && entry.acodec !== 'none') || ['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(String(entry.ext || '').toLowerCase()))) || !!entry.images?.length;
    if (!hasPlayableMedia) return [];
    return [{ id: String(entry.id), index: index + 1, title: String(entry.title || `Item ${index + 1}`).slice(0, 1000),
      duration: Number.isFinite(entry.duration) ? entry.duration : null,
      thumbnail: typeof (entry.thumbnail || entry.thumbnails?.at(-1)?.url) === 'string' ? entry.thumbnail || entry.thumbnails.at(-1).url : null,
      availability: availability || 'available', mediaType: entry.images?.length || ['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(String(entry.ext || '').toLowerCase()) ? 'image' : entryFormats.length && entryFormats.every((format) => format.vcodec === 'none') ? 'audio' : 'video',
      size: Number(entry.filesize_approx || entry.filesize) || null }];
  });
  const sourceFormats = Array.isArray(data.formats) ? data.formats : [];
  const usableFormats = sourceFormats.filter((format) => format && (format.format_id || format.url));
  const videoFormats = usableFormats.filter((format) => format.vcodec && format.vcodec !== 'none');
  const audioFormats = usableFormats.filter((format) => format.acodec && format.acodec !== 'none');
  const imageFormats = usableFormats.filter((format) => /^image\//i.test(format.format_note || format.mimetype || '') || ['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(String(format.ext || '').toLowerCase()));
  const isPlaylist = data._type === 'playlist' || (Array.isArray(data.entries) && data.playlist_count !== undefined);
  if (!entries.length) throw new Error('yt-dlp recognized this webpage but found no available, downloadable media.');
  if (!isPlaylist && !usableFormats.length && !data.images?.length) throw new Error('yt-dlp did not find a usable media stream for this webpage.');

  const extractor = String(data.extractor_key || data.extractor || 'yt-dlp');
  const playlistId = String(data.playlist_id || data.id || '');
  const isChannel = isPlaylist && (/Channel|Tab|User/i.test(extractor) || /^UC[\w-]{20,}$/.test(playlistId));
  const isImageCollection = isPlaylist && entries.every((entry) => entry.mediaType === 'image');
  const audioOnly = !isPlaylist && videoFormats.length === 0 && audioFormats.length > 0;
  const kind = isPlaylist ? (isImageCollection ? 'imageCollection' : isChannel ? 'channel' : 'playlist') : imageFormats.length || data.images?.length ? 'image' : audioOnly ? 'audio' : 'video';
  const formats = usableFormats.map((format) => ({
    id: String(format.format_id || ''), ext: String(format.ext || ''),
    note: String(format.format_note || format.resolution || '').slice(0, 80),
    width: Number(format.width) || null, height: Number(format.height) || null,
    videoCodec: String(format.vcodec || ''), audioCodec: String(format.acodec || ''),
    size: Number(format.filesize_approx || format.filesize) || null,
    hasVideo: !!format.vcodec && format.vcodec !== 'none', hasAudio: !!format.acodec && format.acodec !== 'none'
  }));
  const subtitles = data.subtitles && typeof data.subtitles === 'object' ? Object.keys(data.subtitles) : [];
  const automaticCaptions = data.automatic_captions && typeof data.automatic_captions === 'object' ? Object.keys(data.automatic_captions) : [];
  const thumbnail = typeof data.thumbnail === 'string' ? data.thumbnail : (data.thumbnails?.at(-1)?.url || entries[0]?.thumbnail || null);
  const capabilities = {
    inspect: true, playlists: isPlaylist, itemSelection: isPlaylist, videoFormats: videoFormats.length > 0,
    audioFormats: audioFormats.length > 0, imageFormats: imageFormats.length > 0 || entries.some((entry) => entry.mediaType === 'image'),
    qualitySelection: videoFormats.some((format) => Number(format.height) > 0),
    formatSelection: videoFormats.length > 0 || audioFormats.length > 0 || imageFormats.length > 0, subtitles: subtitles.length > 0,
    automaticCaptions: automaticCaptions.length > 0, thumbnailExtraction: !!thumbnail, metadataExtraction: true,
    audioTracks: audioFormats.length > 0, resume: true, pause: false, directFile: false,
    formatMerging: videoFormats.some((format) => !format.acodec || format.acodec === 'none') && audioFormats.some((format) => !format.vcodec || format.vcodec === 'none'),
    postProcess: videoFormats.some((format) => !format.acodec || format.acodec === 'none') && audioFormats.some((format) => !format.vcodec || format.vcodec === 'none')
  };
  return { kind, mediaType: audioOnly ? 'audio' : imageFormats.length || isImageCollection ? 'image' : isPlaylist ? 'collection' : 'video', sourceType: 'media',
    title: String(data.title || data.playlist_title || (isPlaylist ? 'Collection' : 'Media source')).slice(0, 1000),
    originalTitle: String(data.title || data.playlist_title || '').slice(0, 1000),
    uploader: String(data.uploader || data.channel || data.playlist_uploader || data.creator || 'Media source').slice(0, 1000),
    sourceWebsite: new URL(url).hostname, extractor, extractorKey: String(data.extractor_key || ''), playlistId: isPlaylist ? playlistId : null,
    count: entries.length, unavailableCount: isPlaylist ? Math.max(0, rawEntries.length - entries.length) : 0, entries, duration: Number.isFinite(data.duration) ? data.duration : null,
    thumbnail, estimatedSize: Number(data.filesize_approx || data.filesize) || null,
    formats, qualities: [...new Set(videoFormats.map((format) => Number(format.height)).filter(Boolean))].sort((a, b) => b - a),
    subtitles, automaticCaptions, metadata: { id: String(data.id || ''), webpageUrl: String(data.webpage_url || url), uploadDate: String(data.upload_date || ''),
      description: String(data.description || '').slice(0, 1500), width: Number(data.width) || null, height: Number(data.height) || null,
      fps: Number(data.fps) || null, ext: String(data.ext || ''), duration: Number.isFinite(data.duration) ? data.duration : null }, capabilities };
}

async function inspectYtDlp(ytDlpPath, url) {
  const { stdout } = await exec(ytDlpPath, ['--yes-playlist', '--dump-single-json', '--ignore-errors', '--no-warnings', '--playlist-end', '2000', url], { timeout: 60000 });
  let data;
  try { data = JSON.parse(stdout.trim()); } catch { throw new Error('Could not read source information. Make sure the link is accessible.'); }
  return parseYtDlpMetadata(data, url);
}

function createHtmlGuard() {
  let prefix = Buffer.alloc(0);
  let checked = false;
  const inspect = () => {
    if (checked) return;
    checked = true;
    if (/^\s*(?:<!doctype\s+html|<html\b|<head\b|<body\b)/i.test(prefix.toString('utf8'))) {
      const error = new Error('The server returned an HTML webpage instead of a file.'); error.code = 'HTML_PAGE'; throw error;
    }
  };
  return new Transform({ transform(chunk, _encoding, callback) {
    if (!checked) { prefix = Buffer.concat([prefix, chunk.subarray(0, Math.max(0, 512 - prefix.length))]); try { if (prefix.length >= 512) inspect(); } catch (error) { callback(error); return; } }
    callback(null, chunk);
  }, flush(callback) { try { inspect(); callback(); } catch (error) { callback(error); } } });
}

async function downloadDirectAttempt({ url, folder, onEvent = () => {}, signal, allowPrivateAddresses = false, timeoutMs = 30000, bodyTimeoutMs = 60000 }) {
  fs.mkdirSync(folder, { recursive: true });
  let response = await safeFetch(url, { signal, allowPrivateAddresses, timeoutMs, bodyTimeoutMs });
  if (!response.ok) {
    const retryHeader = response.headers.get('retry-after');
    const retrySeconds = Number(retryHeader);
    const retryAfter = Number.isFinite(retrySeconds) && retrySeconds > 0 ? retrySeconds * 1000 : (retryHeader ? Date.parse(retryHeader) - Date.now() : 0);
    const error = new Error(`The source returned HTTP ${response.status}.`);
    error.retryable = response.status === 429 || response.status >= 500;
    error.retryAfterMs = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(30000, retryAfter) : 0;
    await response.body?.cancel();
    throw error;
  }
  const name = filenameFrom(response.headers, response.url || url);
  if (isHtml(response.headers, name)) { await response.body?.cancel(); const error = new Error('The server returned an HTML webpage instead of a file.'); error.code = 'HTML_PAGE'; throw error; }
  const destination = path.join(folder, name);
  if (fs.existsSync(destination)) { await response.body?.cancel(); throw new Error(`A file named ${name} already exists in this folder.`); }
  const temporary = `${destination}.part`;
  const metadataPath = `${temporary}.json`;
  const previous = fs.existsSync(temporary) ? fs.statSync(temporary).size : 0;
  let metadata = {};
  try { metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8')); } catch { /* start a fresh representation */ }

  const validator = metadata.etag ? ['etag', metadata.etag] : metadata.lastModified ? ['last-modified', metadata.lastModified] : null;
  if (previous && metadata.url === response.url && validator && validator[1] === response.headers.get(validator[0])) {
    await response.body?.cancel();
    response = await safeFetch(response.url, { signal, allowPrivateAddresses, timeoutMs, bodyTimeoutMs, headers: { Range: `bytes=${previous}-`, 'If-Range': validator[1] } });
    const range = response.headers.get('content-range') || '';
    const rangeStart = Number(range.match(/^bytes\s+(\d+)-/i)?.[1]);
    if (response.status !== 206 || rangeStart !== previous || response.headers.get(validator[0]) !== validator[1]) {
      await response.body?.cancel();
      response = await safeFetch(url, { signal, allowPrivateAddresses, timeoutMs, bodyTimeoutMs });
      if (!response.ok) throw new Error(`The source returned HTTP ${response.status}.`);
      fs.writeFileSync(temporary, '');
    }
  } else if (previous) fs.writeFileSync(temporary, '');

  if (!response.ok) throw new Error(`The source returned HTTP ${response.status}.`);
  const totalFromHeader = Number(response.headers.get('content-length')) || null;
  const rangeTotal = response.headers.get('content-range')?.match(/\/(\d+)$/)?.[1];
  const total = response.status === 206 ? (Number(rangeTotal) || (totalFromHeader ? previous + totalFromHeader : null)) : totalFromHeader;
  const start = response.status === 206 ? previous : 0;
  fs.writeFileSync(metadataPath, JSON.stringify({ url: response.url, etag: response.headers.get('etag'), lastModified: response.headers.get('last-modified') }));
  let received = start;
  onEvent({ type: 'item', title: name, current: 1, total: 1 });
  const writer = fs.createWriteStream(temporary, { flags: start ? 'a' : 'w' });
  const reader = response.body;
  if (!reader) throw new Error('The source returned an empty response.');
  const stream = Readable.fromWeb(reader);
  let lastEmit = 0;
  stream.on('data', (chunk) => {
    received += chunk.length;
    const percent = total ? Math.min(99.9, received / total * 100) : 0;
    const now = Date.now();
    if (now - lastEmit >= 150 || (total && received >= total)) {
      lastEmit = now;
      onEvent({ type: 'progress', percent, overall: percent, current: 1, total: 1, received, size: total, indeterminate: !total, speed: '', eta: '' });
    }
  });
  await pipeline(stream, createHtmlGuard(), writer, { signal });
  if (signal?.aborted) throw Object.assign(new Error('Download cancelled.'), { name: 'AbortError' });
  const finalSize = fs.statSync(temporary).size;
  if (!finalSize) throw new Error('The downloaded file is empty. The partial file was kept.');
  if (total && finalSize !== total) throw new Error(`The downloaded file size did not match the server response (${finalSize} of ${total} bytes). The partial file was kept.`);
  if (fs.existsSync(destination)) throw new Error(`A file named ${name} appeared in the destination during download.`);
  fs.renameSync(temporary, destination);
  fs.rmSync(metadataPath, { force: true });
  onEvent({ type: 'phase', phase: 'verifying' });
  if (!fs.existsSync(destination) || fs.statSync(destination).size === 0) throw new Error('The downloaded file is empty or missing.');
  onEvent({ type: 'progress', percent: 100, overall: 100, current: 1, total: 1, speed: '', eta: '' });
  onEvent({ type: 'video-complete', title: name, path: destination });
  return { status: 'completed', done: 1, skipped: 0, failed: 0, files: [destination], issues: [], message: 'File downloaded and checked.', folder };
}

async function downloadDirect(options) {
  const retries = Number.isInteger(options.retries) ? Math.max(0, Math.min(8, options.retries)) : 2;
  for (let attempt = 0; ; attempt++) {
    try { return await downloadDirectAttempt(options); }
    catch (error) {
      if (options.signal?.aborted || error.name === 'AbortError') return { status: 'cancelled', done: 0, skipped: 0, failed: 0, files: [], issues: [], message: 'Cancelled. The partial file was kept; resume is offered only when the server validates the same content.' };
      const retryable = error.retryable || error.name === 'TimeoutError' || error.name === 'TypeError' || ['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'UND_ERR_SOCKET'].includes(error.code);
      if (!retryable || attempt >= retries) throw error;
      await new Promise((resolve) => setTimeout(resolve, error.retryAfterMs || Math.min(4000, 250 * (2 ** attempt))));
    }
  }
}

module.exports = { safeFetch, inspectDirect, inspectYtDlp, parseYtDlpMetadata, downloadDirect, safeFilename, filenameFrom, isPrivateAddress, resolveTarget, createPinnedLookup, normalizeAddresses };
