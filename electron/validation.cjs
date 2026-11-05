'use strict';

const { normalizeUrl } = require('./providers.cjs');

const fail = (label) => { throw new Error(`Invalid ${label} payload.`); };
const record = (value) => !!value && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const string = (value, max, label) => { if (typeof value !== 'string' || value.length > max) fail(label); return value; };

function validateRunTask(value) {
  if (!record(value)) fail('download task');
  const url = normalizeUrl(string(value.url, 8192, 'download task'));
  if (typeof value.id !== 'string' || value.id.length > 100 || !['yt-dlp', 'http'].includes(value.providerId)) fail('download task');
  if (typeof value.folder !== 'string' || value.folder.length > 32768 || !require('node:path').isAbsolute(value.folder)) fail('download task');
  if (!['mp4', 'mp3', 'image'].includes(value.format) || !(String(value.quality) === 'best' || /^\d{1,5}$/.test(String(value.quality)) && Number(value.quality) > 0)) fail('download task');
  if (!Number.isInteger(value.retries) || value.retries < 0 || value.retries > 10 || !Number.isInteger(value.expectedTotal) || value.expectedTotal < 0 || value.expectedTotal > 2000) fail('download task');
  if (value.subfolder !== undefined && (typeof value.subfolder !== 'string' || value.subfolder.length > 240)) fail('download task');
  if (value.selected !== null && value.selected !== undefined && (!Array.isArray(value.selected) || value.selected.length > 2000 || value.selected.some((n) => !Number.isInteger(n) || n < 1 || n > 2000))) fail('download task');
  for (const key of ['skipExisting', 'numbering', 'deepVerify']) if (typeof value[key] !== 'boolean') fail('download task');
  for (const key of ['subtitles', 'automaticCaptions', 'thumbnails', 'metadataSidecar']) if (value[key] !== undefined && typeof value[key] !== 'boolean') fail('download task');
  if (value.subtitleLanguages !== undefined && (typeof value.subtitleLanguages !== 'string' || value.subtitleLanguages.length > 100 || !/^[\w,.*-]+$/.test(value.subtitleLanguages))) fail('download task');
  if (value.mediaInfo !== undefined && (!record(value.mediaInfo) || JSON.stringify(value.mediaInfo).length > 500000 ||
    (value.mediaInfo.thumbnail && (typeof value.mediaInfo.thumbnail !== 'string' || !/^https:\/\//i.test(value.mediaInfo.thumbnail))) ||
    (value.mediaInfo.metadata !== undefined && !record(value.mediaInfo.metadata)) ||
    (value.mediaInfo.entries !== undefined && (!Array.isArray(value.mediaInfo.entries) || value.mediaInfo.entries.length > 2000 || value.mediaInfo.entries.some((entry) => !record(entry) || typeof entry.id !== 'string' || typeof entry.title !== 'string'))))) fail('download task');
  return { ...value, url };
}

function validateQueue(tasks) {
  if (!Array.isArray(tasks) || tasks.length > 500 || JSON.stringify(tasks).length > 2_000_000) fail('queue');
  for (const task of tasks) {
    if (!record(task) || typeof task.id !== 'string' || task.id.length > 100 || typeof task.url !== 'string' || !['waiting', 'preparing', 'running', 'interrupted', 'failed', 'cancelled', 'done'].includes(task.status)) fail('queue');
    normalizeUrl(task.url);
  }
  return tasks;
}

function validateLegacy(value) {
  if (!record(value) || !record(value.settings) || !Array.isArray(value.history) || value.history.length > 100 || JSON.stringify(value).length > 2_000_000) fail('legacy data');
  return value;
}

function validateSettings(value) {
  if (!record(value) || Object.keys(value).length > 40 || JSON.stringify(value).length > 65536) fail('settings');
  return value;
}

function validateHistory(value) {
  if (!Array.isArray(value) || value.length > 100 || JSON.stringify(value).length > 1_000_000 || value.some((entry) => !record(entry) || typeof entry.title !== 'string' || entry.title.length > 500)) fail('history');
  return value;
}

function validatePreview(value) {
  if (!record(value) || !['yt-dlp', 'http'].includes(value.providerId) || typeof value.url !== 'string' || !Array.isArray(value.entries) || value.entries.length > 2000 || !record(value.capabilities)) fail('provider result');
  for (const key of ['inspect', 'playlists', 'itemSelection', 'videoFormats', 'audioFormats', 'imageFormats', 'qualitySelection', 'formatSelection', 'subtitles', 'automaticCaptions', 'thumbnailExtraction', 'metadataExtraction', 'audioTracks', 'resume', 'pause', 'directFile', 'formatMerging', 'postProcess']) if (typeof value.capabilities[key] !== 'boolean') fail('provider capabilities');
  if (typeof value.title !== 'string' || value.title.length > 1000 || typeof value.uploader !== 'string' || value.uploader.length > 1000) fail('provider result');
  if (value.entries.some((entry) => !record(entry) || typeof entry.title !== 'string' || entry.title.length > 1000 || !Number.isInteger(entry.index) || entry.index < 1)) fail('provider entry');
  if (value.formats !== undefined && (!Array.isArray(value.formats) || value.formats.length > 1000 || value.formats.some((format) => !record(format) || typeof format.id !== 'string' || typeof format.ext !== 'string'))) fail('provider formats');
  if (value.subtitles !== undefined && (!Array.isArray(value.subtitles) || value.subtitles.length > 100)) fail('provider subtitles');
  if (value.automaticCaptions !== undefined && (!Array.isArray(value.automaticCaptions) || value.automaticCaptions.length > 100)) fail('provider captions');
  if (value.thumbnail !== undefined && value.thumbnail !== null && (typeof value.thumbnail !== 'string' || !/^https:\/\//i.test(value.thumbnail))) fail('provider thumbnail');
  if (value.sourceWebsite !== undefined && typeof value.sourceWebsite !== 'string') fail('provider source website');
  if (value.extractor !== undefined && typeof value.extractor !== 'string') fail('provider extractor');
  return value;
}

function validateNotify(value) {
  if (!record(value) || typeof value.title !== 'string' || value.title.length > 120 || typeof value.body !== 'string' || value.body.length > 500) fail('notification');
  return value;
}

module.exports = { validateRunTask, validateQueue, validateLegacy, validateSettings, validateHistory, validatePreview, validateNotify };
