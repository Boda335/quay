'use strict';

const engine = require('./downloader.cjs');
const direct = require('./http-download.cjs');

const youtubeHosts = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be', 'music.youtube.com']);
const ytCapabilities = { inspect: true, playlists: false, itemSelection: false, videoFormats: false, audioFormats: false, imageFormats: false, qualitySelection: false, formatSelection: false,
  subtitles: false, automaticCaptions: false, thumbnailExtraction: false, metadataExtraction: false, audioTracks: false, resume: true, pause: false,
  directFile: false, formatMerging: false, postProcess: false };
const fileCapabilities = { inspect: true, playlists: false, itemSelection: false, videoFormats: false, audioFormats: false, imageFormats: false, qualitySelection: false,
  formatSelection: false, subtitles: false, automaticCaptions: false, thumbnailExtraction: false, metadataExtraction: true, audioTracks: false,
  resume: true, pause: false, directFile: true, formatMerging: false, postProcess: false };

function providerCapabilities(result, context = {}) {
  const formatMerging = !!result.capabilities?.formatMerging && !!context.ffmpegPath;
  return { ...ytCapabilities, ...(result.capabilities || {}), formatMerging,
    audioTracks: !!result.capabilities?.audioFormats, postProcess: formatMerging };
}

function normalizeUrl(value) {
  if (typeof value !== 'string' || value.length > 8192) throw new Error('Links must be text under 8,192 characters.');
  let url;
  try { url = new URL(value.trim()); } catch { throw new Error('Enter a valid HTTP or HTTPS link.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Only HTTP(S) links without embedded credentials are supported.');
  url.hash = '';
  return url.toString();
}

function isYoutube(value) {
  try { return youtubeHosts.has(new URL(value).hostname.toLowerCase()); } catch { return false; }
}

function createYtDlpTask(options, context) {
  if (!context.ytDlpPath) throw new Error('The video engine is not ready yet.');
  if (options.format !== 'image' && !context.ffmpegPath) throw new Error('FFmpeg is missing. Reinstall the app to restore the bundled media tools.');
  return engine.runDownload({
    ytDlpPath: context.ytDlpPath, ffmpeg: context.ffmpegPath, url: options.url, folder: options.folder,
    quality: options.quality, format: options.format, retries: options.retries, skipExisting: options.skipExisting,
    numbering: options.numbering, deepVerify: options.deepVerify, expectedTotal: options.expectedTotal,
    subtitles: options.subtitles, automaticCaptions: options.automaticCaptions, subtitleLanguages: options.subtitleLanguages,
    thumbnails: options.thumbnails, metadataSidecar: options.metadataSidecar,
    items: Array.isArray(options.selected) && options.selected.length ? engine.toItemRanges(options.selected) : '',
    archiveFile: context.archiveFile
  }, options.onEvent);
}

const ytDlpProvider = {
  id: 'yt-dlp',
  capabilities: ytCapabilities,
  match: isYoutube,
  async inspect(url, context) {
    const ytDlpPath = context.ytDlpPath || await context.ensureYtDlp?.();
    const result = await direct.inspectYtDlp(ytDlpPath, url);
    const capabilities = providerCapabilities(result, context);
    return { ...result, sourceType: 'youtube', capabilities };
  },
  createTask: createYtDlpTask
};

const ytDlpWebProvider = {
  id: 'yt-dlp',
  capabilities: ytCapabilities,
  match(value) { try { return ['http:', 'https:'].includes(new URL(value).protocol) && !isYoutube(value); } catch { return false; } },
  async inspect(url, context) {
    const ytDlpPath = context.ytDlpPath || await context.ensureYtDlp?.();
    const result = await direct.inspectYtDlp(ytDlpPath, url);
    const capabilities = providerCapabilities(result, context);
    return { ...result, sourceType: 'media', capabilities };
  },
  createTask: createYtDlpTask
};

const httpProvider = {
  id: 'http',
  capabilities: fileCapabilities,
  match(value) { try { return ['http:', 'https:'].includes(new URL(value).protocol); } catch { return false; } },
  async inspect(url, context = {}) { return { ...(await direct.inspectDirect(url, context)), capabilities: fileCapabilities, sourceType: 'direct-file' }; },
  createTask(options, context = {}) {
    const controller = new AbortController();
    const promise = direct.downloadDirect({ url: options.url, folder: options.folder, retries: options.retries, signal: controller.signal,
      allowPrivateAddresses: context.allowPrivateAddresses, onEvent: options.onEvent });
    return { promise, cancel: () => controller.abort() };
  }
};

class ProviderRegistry {
  constructor({ youtube = ytDlpProvider, webpage = ytDlpWebProvider, directFile = httpProvider } = {}) {
    this.youtube = youtube;
    this.webpage = webpage;
    this.directFile = directFile;
  }

  resolve(url) {
    if (this.youtube.match(url)) return this.youtube;
    return this.directFile.match(url) ? this.directFile : null;
  }

  async inspect(rawUrl, context = {}) {
    const url = normalizeUrl(rawUrl);
    if (this.youtube.match(url)) return { ...(await this.youtube.inspect(url, context)), url, providerId: this.youtube.id };
    if (!this.directFile.match(url)) throw new Error('This source is unsupported. Only HTTP(S) links are accepted.');
    try { return { ...(await this.directFile.inspect(url, context)), url, providerId: this.directFile.id }; }
    catch (error) {
      const pageCandidate = error.code === 'HTML_PAGE' || error.statusCode === 403 || error.statusCode === 405 || error.statusCode === 406 || error.statusCode === 501;
      if (!pageCandidate) throw error;
      try { return { ...(await this.webpage.inspect(url, context)), url, providerId: this.webpage.id }; }
      catch (extractorError) {
        if (extractorError.code === 'SECURITY_BLOCKED' || ['ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ERR_INVALID_IP_ADDRESS'].includes(extractorError.code)) throw extractorError;
        if (/sign[ -]?in|log[ -]?in|authentication required|members.only|private video|cookies/i.test(extractorError.message || '')) {
          const auth = new Error(`This source requires authentication and cannot be inspected without signing in. ${extractorError.message || ''}`.trim());
          auth.code = 'AUTH_REQUIRED';
          throw auth;
        }
        const reason = extractorError.message || 'No yt-dlp extractor recognized this page.';
        const unsupported = new Error(`yt-dlp extraction failed for this webpage. ${reason}`);
        unsupported.code = 'EXTRACTION_ERROR';
        throw unsupported;
      }
    }
  }

  async inspectBatch(rawUrls, context = {}) {
    if (!Array.isArray(rawUrls) || rawUrls.length < 1 || rawUrls.length > 50 || rawUrls.some((url) => typeof url !== 'string' || url.length > 8192)) {
      throw new Error('Inspect between 1 and 50 links per batch.');
    }
    const normalized = rawUrls.map((raw) => {
      try { return { raw, url: normalizeUrl(raw) }; }
      catch (error) { return { raw, error }; }
    });
    const firstByUrl = new Map();
    const results = new Array(normalized.length);
    const pending = [];
    normalized.forEach((item, index) => {
      if (item.error) { results[index] = { url: item.raw, status: 'failed', category: 'invalid-url', message: item.error.message }; return; }
      const duplicateOf = firstByUrl.get(item.url);
      if (duplicateOf !== undefined) { results[index] = { url: item.url, status: 'duplicate', duplicateOf }; return; }
      firstByUrl.set(item.url, index);
      pending.push({ item, index });
    });
    let cursor = 0;
    const worker = async () => {
      while (cursor < pending.length) {
        const current = pending[cursor++];
        const { item, index } = current;
        try { results[index] = { url: item.url, status: 'fulfilled', result: await this.inspect(item.url, context) }; }
        catch (error) {
          const category = error.code === 'SECURITY_BLOCKED' ? 'security' : ['ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ERR_INVALID_IP_ADDRESS'].includes(error.code) ? 'network' : error.code === 'EXTRACTION_ERROR' ? 'extraction' : error.code === 'AUTH_REQUIRED' || error.statusCode === 401 || error.statusCode === 407 ? 'authentication-required' : 'unsupported';
          results[index] = { url: item.url, status: 'failed', category, message: String(error.message || 'Inspection failed.').slice(0, 500) };
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, pending.length) }, worker));
    return results;
  }

  forTask(url, providerId) {
    if (providerId === 'http') return this.directFile;
    if (providerId === 'yt-dlp') return this.youtube.match(url) ? this.youtube : this.webpage;
    return null;
  }
}

module.exports = { ProviderRegistry, normalizeUrl, isYoutube, ytDlpProvider, ytDlpWebProvider, httpProvider };
