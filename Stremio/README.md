# Stremio

TMDB-powered home screen (trending, top rated, anime, K-drama, Telugu) + stream aggregation from 22 Stremio addons with dual ID (tmdb/imdb) support.

## Install

```
https://raw.githubusercontent.com/thegnsme/skystream-plugins/repo/repo.json
```

## Features

- **getHome / search / load** — TMDB catalog (25 categories)
- **loadStreams** — Queries 22 addons in parallel, falls back to Torrentio
- **Dual ID** — Tries both `tmdb:` and IMDb IDs per addon
- **Quality sort** — 4K → 1080p → 720p, then by addon priority in plugin.json
- **60s deadline** — Returns whatever streams arrive within 60s
- **Cached** — TMDB responses cached 5min, stream results 10min, IMDb lookups 24h
- **Subtitles** — OpenSubtitles attached to all streams
- **Tracker lists** — ngosang + XIU2 for magnet links

## Configure

Edit `plugin.json` → `streamAddons` array. First addon = highest priority.
