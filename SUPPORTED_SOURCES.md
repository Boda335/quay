# Supported sources

Droplist uses yt-dlp's extractors for media pages and a separate, guarded HTTP provider for direct files. An extractor existing does not guarantee that every URL works: access, region, age, account, network, and upstream site changes can affect individual items. Droplist does not read browser cookies or bypass DRM.

## Verification status

| Source | Status | Verification | Known limits |
| --- | --- | --- | --- |
| TikTok public video | Verified working | yt-dlp 2026.10.26; inspected and downloaded `@ploonedits/video/7704515051293560078` on 2026-11-05 | Individual videos may be removed, private, region-limited, or temporarily blocked. |
| YouTube public video | Verified working | yt-dlp 2026.10.26; downloaded `Me at the zoo` on 2026-11-05 with FFmpeg audio/video merge | YouTube can require sign-in or change extraction behavior. |
| Direct HTTP(S) media file | Verified working | Samplelib 5-second MP4, inspected and downloaded on 2026-11-05 | Only direct file responses; resumability depends on server byte-range and validators. |
| Other yt-dlp extractors | Extractor available; not individually tested | Uses installed yt-dlp extractor registry; metadata is accepted only when usable media formats or image entries are returned | Support depends on the exact URL and current upstream extractor. |
| Authentication-required sources | Requires authentication; not supported by a credential flow | No cookies or secrets are read or stored | Publicly accessible URLs only. |
| Temporarily unavailable sources | Temporarily broken/unavailable when extraction or network requests fail | Error details are shown per link | Retry later or update yt-dlp when the source site changes. |
| Unsupported webpages, galleries, feeds, and non-HTTP(S) URLs | Unsupported unless yt-dlp returns usable media metadata | Generic extractor acceptance alone is not sufficient | FTP, RSS/Atom, P2P, DRM bypass, and page archiving are not implemented. |

## Troubleshooting

- **Unsupported webpage:** Droplist could not find downloadable media metadata for this URL. Check that it points to a specific public media item or playlist.
- **Authentication required:** Droplist does not import browser sessions. Use content that is available without private account credentials.
- **Network or DNS error:** Check connectivity and try again. Private, reserved, and local network targets are blocked by design.
- **Temporarily unavailable:** Update yt-dlp in Settings and retry later. A site outage, rate limit, region restriction, or extractor change may prevent access.
- **Direct file rejected:** Use a URL that responds with a file MIME type or filename. An HTTP 200 webpage is not treated as a file.

Verification reflects the version and URL listed in the table; it is not a guarantee for every item on that service.
