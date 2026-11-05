# Architecture and migration

## Current request flow

The React renderer sends only narrow preload methods. Electron checks that IPC comes from the main frame of the packaged file page or the local Vite development origin. `ProviderRegistry` normalizes public HTTP(S) URLs and selects a provider in fixed order: YouTube through yt-dlp, then ordinary HTTP(S) files.

The yt-dlp adapter keeps playlist and format behavior in `electron/downloader.cjs`. The HTTP provider inspects response headers and streams to a temporary `.part` file. It persists ETag/Last-Modified metadata and only appends bytes after a matching ETag, a `206` response, and a matching Content-Range. It rejects an existing final filename. A response without a known length reports indeterminate progress.

## Persistence and recovery

SQLite is the local source of truth for queued tasks, history, and saved preferences. `electron/database.cjs` creates `userData/data/droplist.sqlite`, enables WAL and foreign keys, and applies idempotent schema version 1. Queue snapshots are committed in a transaction. At startup, tasks last recorded as running become interrupted and can be retried. Live process handles are never persisted.

The app keeps the legacy `Playlist Downloader` user data directory while the visible product is renamed Droplist. Existing localStorage preferences and history are used as fallback values on first database initialization and are copied into SQLite as they are next saved. A separate export/backup and full migration of old browser state is still needed before future schema changes.

## Security boundaries

The renderer has context isolation, sandboxing, disabled Node integration, a restrictive CSP, and a typed-by-shape narrow bridge. IPC handlers check the main frame origin. URLs are limited to HTTP(S) and credentials embedded in URLs are rejected. External engines are launched with argument arrays, never through a shell. File-open requests accept only a path string supplied by the UI and operate through the OS shell API.

## Current scheduler and follow-up

The existing queue runner processes one top-level task at a time. This is intentionally conservative while persistent task transitions and provider behavior are established. The next scheduler change should move orchestration into the main process, add global/per-host concurrency, and persist each transition and sanitized task event. Pause remains unavailable; stop/cancel is the truthful action.

Next priorities: main-process scheduler and recovery actions; full typed IPC contracts and runtime schemas; safe localStorage backup/import; startup/quit integration testing; direct HTTP timeout/retry and server-change fixtures; Library indexing; gallery/feed providers only after the current queue is reliable.
