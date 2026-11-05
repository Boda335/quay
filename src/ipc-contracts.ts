import type { ProviderId } from './contracts';

export interface DownloadRequest {
  id: string;
  title: string;
  url: string;
  providerId: ProviderId;
  folder: string;
  subfolder: string;
  quality: string;
  format: 'mp4' | 'mp3' | 'image';
  selected: number[] | null;
  expectedTotal: number;
  retries: number;
  skipExisting: boolean;
  numbering: boolean;
  deepVerify: boolean;
  subtitles?: boolean;
  automaticCaptions?: boolean;
  subtitleLanguages?: string;
  thumbnails?: boolean;
  metadataSidecar?: boolean;
  mediaInfo?: { extractor?: string; sourceWebsite?: string; mediaType?: string; originalTitle?: string; duration?: number | null; thumbnail?: string | null; playlistId?: string | null; metadata?: Record<string, unknown>; entries?: Array<{ id: string; title: string; duration?: number | null; mediaType?: string }> };
}

/** Reject malformed task objects before they cross the renderer/main IPC boundary. */
export function validateDownloadRequest(value: DownloadRequest): DownloadRequest {
  if (!value || typeof value !== 'object' || typeof value.id !== 'string' || value.id.length > 100 ||
    typeof value.title !== 'string' || value.title.length > 1000 ||
    typeof value.url !== 'string' || value.url.length > 8192 ||
    !['yt-dlp', 'http'].includes(value.providerId) ||
    typeof value.folder !== 'string' || !value.folder || value.folder.length > 32768 ||
    typeof value.subfolder !== 'string' || value.subfolder.length > 240 ||
    !['mp4', 'mp3', 'image'].includes(value.format) ||
    !(value.quality === 'best' || /^\d{1,5}$/.test(value.quality) && Number(value.quality) > 0) ||
    !Number.isInteger(value.expectedTotal) || value.expectedTotal < 0 || value.expectedTotal > 2000 ||
    !Number.isInteger(value.retries) || value.retries < 0 || value.retries > 10 ||
    !['skipExisting', 'numbering', 'deepVerify'].every((key) => typeof value[key as keyof DownloadRequest] === 'boolean') ||
    !['subtitles', 'automaticCaptions', 'thumbnails', 'metadataSidecar'].every((key) => value[key as keyof DownloadRequest] === undefined || typeof value[key as keyof DownloadRequest] === 'boolean') ||
    (value.subtitleLanguages !== undefined && (typeof value.subtitleLanguages !== 'string' || value.subtitleLanguages.length > 100 || !/^[\w,.*-]+$/.test(value.subtitleLanguages))) ||
    (value.mediaInfo !== undefined && (!value.mediaInfo || typeof value.mediaInfo !== 'object' || JSON.stringify(value.mediaInfo).length > 500000)) ||
    (value.selected !== null && (!Array.isArray(value.selected) || value.selected.length > 2000 || value.selected.some((index) => !Number.isInteger(index) || index < 1 || index > 2000)))) {
    throw new Error('Invalid download task. Review the queue settings and try again.');
  }
  const url = new URL(value.url);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Only HTTP(S) links without embedded credentials are supported.');
  }
  return { ...value, url: url.href };
}
