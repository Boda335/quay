export type TaskStatus = 'waiting' | 'running' | 'interrupted' | 'failed' | 'cancelled' | 'done';
export type ProviderId = 'yt-dlp' | 'http';

export interface ProviderCapabilities {
  inspect: boolean;
  playlists: boolean;
  itemSelection: boolean;
  videoFormats: boolean;
  audioFormats: boolean;
  imageFormats: boolean;
  qualitySelection: boolean;
  formatSelection: boolean;
  subtitles: boolean;
  automaticCaptions: boolean;
  thumbnailExtraction: boolean;
  metadataExtraction: boolean;
  resume: boolean;
  pause: boolean;
  directFile: boolean;
  formatMerging: boolean;
}

export interface SourceEntry {
  id: string;
  index: number;
  title: string;
  duration: number | null;
  thumbnail: string | null;
  sourceIndex?: number;
  sourceItemIndex?: number;
  availability?: string;
  mediaType?: string;
  size?: number | null;
}

export interface SourcePreview {
  url: string;
  providerId: ProviderId;
  capabilities: ProviderCapabilities;
  kind: 'video' | 'playlist' | 'file' | 'inbox';
  title: string;
  uploader: string;
  count: number;
  unavailableCount?: number;
  entries: SourceEntry[];
  size?: number | null;
  mimeType?: string;
  supportsRange?: boolean;
  sourceType?: string;
  mediaType?: string;
  originalTitle?: string;
  sourceWebsite?: string;
  extractor?: string;
  extractorKey?: string;
  playlistId?: string | null;
  duration?: number | null;
  thumbnail?: string | null;
  estimatedSize?: number | null;
  extension?: string;
  formats?: Array<{ id: string; ext: string; note?: string; height?: number | null; size?: number | null }>;
  qualities?: number[];
  subtitles?: string[];
  automaticCaptions?: string[];
  metadata?: Record<string, unknown>;
  sources?: SourcePreview[];
}

export interface Task {
  id: string;
  providerId: ProviderId;
  url: string;
  title: string;
  status: TaskStatus;
  folder: string;
  total: number;
  selected: number[] | null;
  createdAt?: string;
  note?: string;
}

export interface TaskEvent {
  type: 'item' | 'progress' | 'phase' | 'verify' | 'video-complete' | 'video-error';
  title?: string;
  phase?: string;
  percent?: number;
  overall?: number;
  received?: number;
  size?: number | null;
  indeterminate?: boolean;
  message?: string;
}

export interface TaskResult {
  status: 'completed' | 'cancelled' | 'error';
  done: number;
  skipped: number;
  failed: number;
  files: string[];
  issues: string[];
  message: string;
  folder?: string;
}

export interface FileMetadata {
  path: string;
  size: number;
  mimeType: string;
  modifiedAt: string;
  sourceId?: string;
  taskId?: string;
  duration?: number | null;
  width?: number | null;
  height?: number | null;
  codec?: string | null;
}

export interface DownloaderBridge {
  getDefaults(): Promise<{ downloads: string; version: string }>;
  loadQueue(): Promise<{ tasks: Task[]; history: unknown[]; settings: Record<string, unknown> }>;
  migrateLegacy(data: { settings: Record<string, unknown>; history: unknown[] }): Promise<{ tasks: Task[]; history: unknown[]; settings: Record<string, unknown> }>;
  saveQueue(tasks: Task[]): Promise<boolean>;
  removeTask(id: string): Promise<boolean>;
  saveHistory(entries: unknown[]): Promise<boolean>;
  saveSettings(settings: Record<string, unknown>): Promise<boolean>;
  inspectSource(url: string): Promise<SourcePreview>;
  inspectSources(urls: string[]): Promise<Array<{ url: string; status: 'fulfilled' | 'failed' | 'duplicate'; result?: SourcePreview; category?: string; message?: string; duplicateOf?: number }>>;
  run(task: Task & Record<string, unknown>): Promise<TaskResult>;
  cancel(taskId?: string): Promise<boolean>;
  onProgress(callback: (event: TaskEvent) => void): () => void;
}

declare global {
  interface Window { downloader: DownloaderBridge }
}

export {};
