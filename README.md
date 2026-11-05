# Droplist

Droplist is a local-first Windows download workspace. Paste links into the inbox, inspect what each source exposes, review the selection, then queue and manage downloads on your device.

## Supported sources

- **YouTube videos and playlists:** inspected and downloaded through yt-dlp. Extractor coverage changes over time; private, restricted, expired, or unsupported sources can fail inspection.
- **Direct HTTP(S) files:** streamed to disk with progress, safe filenames, duplicate destination protection, and validator-checked Range resume when the server supports it.

Other protocols and gallery, feed, cloud, and archive providers are not currently supported. See [Supported Sources](SUPPORTED_SOURCES.md) for the current capability details.

## First launch and downloads

The app downloads yt-dlp into its user data folder on first launch. FFmpeg is bundled with the app for video/audio processing. Direct file downloads do not require yt-dlp.

The queue, recent history, and preferences are stored locally in SQLite under the existing `Playlist Downloader` user data folder so upgrades keep the current data location. Running tasks are marked interrupted after restart. Retry or resume is offered only through the provider's supported behavior; cancellation is not called pause.

The download engine's `.part` files are retained after interruption. Direct HTTP resume is attempted only when saved validators and the server's partial response confirm the same representation.

## Development

Requirements: Node.js 22.12 or newer, npm, and Windows for installer packaging.

```powershell
npm ci
npm run dev
npm test
npm run build
```

The deterministic core tests use local HTTP fixtures and do not contact public sites. `test/engine.test.cjs` additionally needs yt-dlp and FFmpeg on PATH; it reports a skip when either binary is unavailable.

## Architecture and limits

- [Architecture and migration notes](ARCHITECTURE.md)
- [Supported sources](SUPPORTED_SOURCES.md)
- [Third-party notices](THIRD_PARTY_NOTICES.md)

The app retains the existing Electron application ID and Windows user data location. Download only material you own or are authorized to save, and follow source terms and applicable law. Droplist does not bypass DRM or access controls.
