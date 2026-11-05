'use strict';

const assert = require('node:assert/strict');
const { parseYtDlpMetadata } = require('../electron/http-download.cjs');
const { validatePreview } = require('../electron/validation.cjs');

const base = 'https://media.example/watch/one';
const videoFormat = { format_id: '137', url: 'https://cdn.example/video.mp4', ext: 'mp4', vcodec: 'avc1', acodec: 'none', height: 720, filesize_approx: 1000000 };
const audioFormat = { format_id: '140', url: 'https://cdn.example/audio.m4a', ext: 'm4a', vcodec: 'none', acodec: 'mp4a', filesize_approx: 150000 };

function main() {
  const video = parseYtDlpMetadata({
    id: 'one', title: 'A title', uploader: 'Creator', extractor_key: 'Example', webpage_url: base,
    duration: 32, thumbnail: 'https://img.example/one.jpg', formats: [videoFormat, audioFormat],
    subtitles: { en: [{ ext: 'vtt' }] }, automatic_captions: { es: [{ ext: 'vtt' }] },
    upload_date: '20261105', width: 1280, height: 720, fps: 30
  }, base);
  assert.equal(video.kind, 'video');
  assert.equal(video.sourceWebsite, 'media.example');
  assert.equal(video.extractor, 'Example');
  assert.equal(video.capabilities.videoFormats, true);
  assert.equal(video.capabilities.audioFormats, true);
  assert.equal(video.capabilities.qualitySelection, true);
  assert.equal(video.capabilities.formatMerging, true);
  assert.deepEqual(video.subtitles, ['en']);
  assert.deepEqual(video.automaticCaptions, ['es']);
  assert.equal(video.metadata.duration, 32);

  const audio = parseYtDlpMetadata({ id: 'audio', title: 'Audio', extractor_key: 'AudioSite', formats: [audioFormat] }, 'https://audio.example/track');
  assert.equal(audio.kind, 'audio');
  assert.equal(audio.mediaType, 'audio');
  assert.equal(audio.capabilities.videoFormats, false);
  assert.equal(audio.capabilities.audioFormats, true);
  assert.equal(audio.capabilities.qualitySelection, false);

  const playlist = parseYtDlpMetadata({
    _type: 'playlist', id: 'collection-1', title: 'Collection', extractor_key: 'ExamplePlaylist', entries: [
      { id: 'one', title: 'Available', formats: [videoFormat], duration: 10 },
      { id: 'two', title: 'Unavailable', availability: 'unavailable', formats: [videoFormat] },
      { id: 'three', title: 'Needs sign in', availability: 'needs_auth', formats: [videoFormat] }
    ]
  }, 'https://media.example/collection');
  assert.equal(playlist.kind, 'playlist');
  assert.equal(playlist.count, 1);
  assert.equal(playlist.unavailableCount, 2);
  assert.equal(playlist.entries[0].title, 'Available');
  assert.equal(playlist.capabilities.itemSelection, true);

  const images = parseYtDlpMetadata({ _type: 'playlist', id: 'gallery', title: 'Gallery', entries: [
    { id: 'image-1', title: 'First image', url: 'https://img.example/1.jpg', ext: 'jpg' },
    { id: 'image-2', title: 'Second image', url: 'https://img.example/2.jpg', ext: 'jpg' }
  ] }, 'https://images.example/gallery');
  assert.equal(images.kind, 'imageCollection');
  assert.equal(images.count, 2);
  assert.equal(images.capabilities.imageFormats, true);

  assert.throws(() => parseYtDlpMetadata({ id: 'page', title: 'Generic page', url: 'https://site.example/page', _type: 'url' }, 'https://site.example/page'), /downloadable media|usable media stream/);
  const preview = { ...video, providerId: 'yt-dlp', url: base };
  assert.equal(validatePreview(preview).capabilities.automaticCaptions, true);
  console.log('inspection metadata tests passed');
}

try { main(); } catch (error) { console.error(error); process.exitCode = 1; }
