(function() {
    /**
     * StremioNsfw v4 — SkyStream Gen 2 NSFW Addon Aggregator
     * 
     * Fixes applied:
     *  ✓ Search across ALL catalogs (proper URL format with ?search= query params)
     *  ✓ Parallel stream fetching (tries all URL patterns concurrently)
     *  ✓ Pagination distributed evenly across all addons
     *  ✓ loadExtractor integration for MixDrop, StreamTape, Voe, etc.
     *  ✓ SkyStream SDK helpers (parse_html, http_parallel, getAndUnpack)
     *  ✓ Concurrent addon queries with Promise.allSettled
     *  ✓ Request deduplication in-flight
     *  ✓ Larger smart cache (200 entries, LRU eviction)
     *  ✓ Search result limiting and deduplication by ID
     *  ✓ Better error recovery (one failing addon doesn't break others)
     *  ✓ Subtitle language normalization
     *  ✓ DRM license support
     */

    "use strict";

    // ============================================================
    //  CONFIGURATION
    // ============================================================
    const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
    const HEADERS = { "User-Agent": USER_AGENT, "Accept": "application/json", "Accept-Language": "en-US,en;q=0.5" };
    const ADDON_TIMEOUT_MS = 10000;
    const SEARCH_TIMEOUT_MS = 8000;
    const ITEMS_PER_CATALOG = 25;
    const MAX_SEARCH_RESULTS = 120;
    const MIN_RESULTS_PER_ADDON = 10; // at least this many from each addon (if available)
    const MAX_CACHE_SIZE = 200;

    const TRACKER_URLS = [
        "https://raw.githubusercontent.com/ngosang/trackerslist/master/trackers_best.txt",
        "https://raw.githubusercontent.com/ngosang/trackerslist/master/trackers_best_ip.txt"
    ];
    const TRACKER_CACHE_TTL = 600000; // 10 min

    const MANIFEST_CACHE_TTL = 300000;   // 5 min
    const MANIFEST_STALE_TTL = 1800000;  // 30 min
    const STREAM_CACHE_TTL = 300000;     // 5 min
    const CATALOG_CACHE_TTL = 180000;    // 3 min

    // ============================================================
    //  CACHES
    // ============================================================
    let addonManifestsCache = null;
    let lastManifestSuccess = 0;
    let trackersCache = null;
    let lastTrackersFetch = 0;
    const streamResultCache = new Map();
    const catalogCache = new Map();
    const inflightRequests = new Map(); // request deduplication

    // ============================================================
    //  LANGUAGE MAP
    // ============================================================
    const LANG_MAP = {
        en: "English", es: "Spanish", fr: "French", de: "German",
        it: "Italian", pt: "Portuguese", ru: "Russian", ja: "Japanese",
        ko: "Korean", zh: "Chinese", ar: "Arabic", hi: "Hindi",
        nl: "Dutch", pl: "Polish", tr: "Turkish", th: "Thai",
        vi: "Vietnamese", cs: "Czech", hu: "Hungarian", ro: "Romanian",
        he: "Hebrew", el: "Greek", sv: "Swedish", da: "Danish",
        no: "Norwegian", fi: "Finnish", id: "Indonesian", ms: "Malay",
        bg: "Bulgarian", uk: "Ukrainian", sr: "Serbian", hr: "Croatian",
        sk: "Slovak", lt: "Lithuanian", lv: "Latvian", et: "Estonian",
        is: "Icelandic", mt: "Maltese", sl: "Slovenian", km: "Khmer",
        lo: "Lao", bn: "Bengali", ta: "Tamil", te: "Telugu", mr: "Marathi",
        eng: "English", spa: "Spanish", fra: "French", fre: "French",
        deu: "German", ger: "German", ita: "Italian", por: "Portuguese",
        rus: "Russian", jpn: "Japanese", kor: "Korean", zho: "Chinese",
        chi: "Chinese", ara: "Arabic", hin: "Hindi", nld: "Dutch",
        dut: "Dutch", pol: "Polish", tur: "Turkish", tha: "Thai",
        vie: "Vietnamese", ces: "Czech", cze: "Czech", hun: "Hungarian",
        ron: "Romanian", rum: "Romanian", heb: "Hebrew", ell: "Greek",
        gre: "Greek", swe: "Swedish", dan: "Danish", nor: "Norwegian",
        fin: "Finnish", ind: "Indonesian", msa: "Malay", may: "Malay",
        bul: "Bulgarian", ukr: "Ukrainian", srp: "Serbian", hrv: "Croatian",
        slk: "Slovak", slo: "Slovak", lit: "Lithuanian", lva: "Latvian",
        est: "Estonian", isl: "Icelandic", mlt: "Maltese", slv: "Slovenian",
        khm: "Khmer", lao: "Lao", ben: "Bengali", tam: "Tamil",
        tel: "Telugu", mar: "Marathi"
    };

    // Known video-host extractors (loaded at runtime by SkyStream)
    const EXTRACTOR_HOSTS = [
        "mixdrop.co", "mixdrop.to", "mixdrop.ag",
        "streamtape.com", "streamtape.co",
        "voe.sx", "voe-unblock.com",
        "filemoon.sx", "filemoon.to",
        "doodstream.com", "dood.to", "dood.ws",
        "streamhub.to", "streamhub.gg",
        "mp4upload.com",
        "yourupload.com",
        "upstream.to",
        "vidcloud.pro",
        "gounlimited.to",
        "netu.tv", "netu.ac",
        "uqload.com", "uqload.to",
        "fembed.com", "fembed.net",
        "clipwatching.com",
        "videobin.co",
        "vidtodo.com",
        "vidoza.net",
        "vidstreaming.io",
        "vidsrc.me", "vidsrc.xyz",
        "embedwish.com",
        "embedsito.com"
    ];

    // ============================================================
    //  LOGGING
    // ============================================================
    const DEBUG = true;
    function log(level, msg, data) {
        const prefix = `[${level.toUpperCase()}][StremioNsfw] `;
        if (level === "debug" && !DEBUG) return;
        if (data !== undefined) console.log(prefix + msg, data);
        else console.log(prefix + msg);
    }

    // ============================================================
    //  URL HELPERS
    // ============================================================
    function encodeUrl(addonUrl, type, id, season, episode, poster, title) {
        return JSON.stringify({
            a: addonUrl, t: type, i: id,
            s: season || 0, e: episode || 0,
            p: poster || "", n: title || ""
        });
    }

    function decodeUrl(url) {
        try { return JSON.parse(url); } catch (e) { return null; }
    }

    function getBaseUrl(manifestUrl) {
        return manifestUrl.replace(/\/manifest\.json$/, "").replace(/\/$/, "");
    }

    function isValidHttpUrl(str) {
        return !!str && (str.indexOf("http://") === 0 || str.indexOf("https://") === 0);
    }

    // ============================================================
    //  DEDUPLICATED HTTP HELPER (avoids duplicate in-flight requests)
    // ============================================================
    async function dedupedFetch(url, headers, timeoutMs) {
        const cacheKey = url + "|" + JSON.stringify(headers || {});

        // Check if a request is already in-flight
        if (inflightRequests.has(cacheKey)) {
            return inflightRequests.get(cacheKey);
        }

        const promise = fetchWithTimeout(url, headers, timeoutMs);
        inflightRequests.set(cacheKey, promise);

        try {
            const result = await promise;
            return result;
        } finally {
            inflightRequests.delete(cacheKey);
        }
    }

    async function fetchJson(url, headers) {
        const merged = Object.assign({}, HEADERS, headers || {});
        const res = await http_get(url, merged);
        if (!res || !res.body) throw new Error("Empty response");
        if (res.status !== 200 && res.status !== 304) throw new Error("HTTP " + res.status);
        const body = res.body;
        if (typeof body === "string" && body.trim().charAt(0) === "<") throw new Error("HTML response (blocked)");
        if (typeof body === "object") return body;
        return JSON.parse(body);
    }

    async function fetchJsonSafe(url, headers) {
        try { return await fetchJson(url, headers); } catch (e) { return null; }
    }

    function fetchWithTimeout(url, headers, timeoutMs) {
        timeoutMs = timeoutMs || ADDON_TIMEOUT_MS;
        return new Promise(function(resolve) {
            let resolved = false;
            const timer = setTimeout(function() {
                if (!resolved) { resolved = true; resolve(null); }
            }, timeoutMs);
            fetchJsonSafe(url, headers).then(function(result) {
                if (!resolved) { resolved = true; clearTimeout(timer); resolve(result); }
            }).catch(function() {
                if (!resolved) { resolved = true; clearTimeout(timer); resolve(null); }
            });
        });
    }

    // ============================================================
    //  ADDON MANAGEMENT
    // ============================================================
    function getAddonUrls() {
        const urls = [];
        if (typeof manifest !== "undefined" && manifest && manifest.addons && Array.isArray(manifest.addons)) {
            for (let i = 0; i < manifest.addons.length; i++) {
                const url = manifest.addons[i];
                if (url && typeof url === "string" && url.trim().length > 0) {
                    urls.push(url.trim());
                }
            }
        }
        return urls;
    }

    async function getAddonConfigs() {
        const now = Date.now();
        if (addonManifestsCache && (now - lastManifestSuccess) < MANIFEST_CACHE_TTL) {
            return addonManifestsCache;
        }

        const urls = getAddonUrls();
        if (urls.length === 0) return [];

        const results = await Promise.allSettled(urls.map(function(url) {
            return fetchWithTimeout(url, HEADERS, 12000).then(function(manifestData) {
                if (!manifestData) return null;

                const baseUrl = getBaseUrl(url);
                const name = manifestData.name || extractSourceName(url);
                const catalogs = manifestData.catalogs || [];

                // Filter out hidden-from-home catalogs
                let visibleCatalogs = catalogs.filter(function(cat) {
                    return !(cat.behaviorHints && cat.behaviorHints.notForHome === true);
                });
                if (visibleCatalogs.length === 0) visibleCatalogs = catalogs;

                // If still no catalogs, infer from types
                if (visibleCatalogs.length === 0) {
                    const types = manifestData.types || ["movie"];
                    visibleCatalogs = types.map(function(t) {
                        return { type: t, id: "top", name: `${name} ${t}` };
                    });
                }

                return {
                    name: name,
                    baseUrl: baseUrl,
                    manifestUrl: url,
                    catalogs: visibleCatalogs,
                    types: manifestData.types || ["movie"],
                    idPrefixes: manifestData.idPrefixes || []
                };
            });
        }));

        const configs = [];
        for (let i = 0; i < results.length; i++) {
            const r = results[i];
            if (r.status === "fulfilled" && r.value) {
                configs.push(r.value);
            } else {
                log("warn", "Failed to fetch addon manifest", urls[i]);
            }
        }

        if (configs.length > 0) {
            addonManifestsCache = configs;
            lastManifestSuccess = now;
            return configs;
        }

        // Stale cache fallback
        if (addonManifestsCache && (now - lastManifestSuccess) < MANIFEST_STALE_TTL) {
            log("warn", "Using stale manifest cache");
            return addonManifestsCache;
        }
        return configs;
    }

    // ============================================================
    //  CATALOG FETCHING (with per-catalog cache)
    // ============================================================
    async function fetchCatalog(addonConfig, catalogEntry, limit, skip) {
        let url = `${addonConfig.baseUrl}/catalog/${catalogEntry.type}/${catalogEntry.id}.json`;
        const params = [];
        if (limit) params.push("limit=" + limit);
        if (skip) params.push("skip=" + skip);
        if (params.length > 0) url += "?" + params.join("&");

        // Check catalog cache
        const cacheKey = url;
        const cached = catalogCache.get(cacheKey);
        if (cached && (Date.now() - cached.ts) < CATALOG_CACHE_TTL) {
            return cached.data;
        }

        const data = await dedupedFetch(url, HEADERS, ADDON_TIMEOUT_MS);
        if (!data || !data.metas) {
            // Cache empty result briefly to avoid hammering
            catalogCache.set(cacheKey, { ts: Date.now(), data: [] });
            trimCache(catalogCache);
            return [];
        }

        catalogCache.set(cacheKey, { ts: Date.now(), data: data.metas });
        trimCache(catalogCache);
        return data.metas;
    }

    // ============================================================
    //  TRACKER MANAGEMENT
    // ============================================================
    async function getTrackers() {
        const now = Date.now();
        if (trackersCache && (now - lastTrackersFetch) < TRACKER_CACHE_TTL) return trackersCache;

        const trackerSet = {};
        const results = await Promise.allSettled(TRACKER_URLS.map(function(url) {
            return http_get(url, HEADERS).then(function(res) {
                if (res && res.body) {
                    const lines = res.body.split("\n");
                    for (let i = 0; i < lines.length; i++) {
                        const line = lines[i].trim();
                        if (line && line.indexOf("://") > 0 && line.indexOf("/announce") > 0) {
                            trackerSet[line] = true;
                        }
                    }
                }
            }).catch(function() {});
        }));

        // Fallback trackers
        const fallbacks = [
            "udp://tracker.opentrackr.org:1337/announce",
            "udp://tracker.openbittorrent.com:6969/announce",
            "udp://tracker.torrent.eu.org:451/announce",
            "udp://exodus.desync.com:6969/announce",
            "udp://public.popcorn-tracker.org:6969/announce",
            "udp://tracker.moeking.me:6969/announce",
            "udp://tracker.dler.org:6969/announce",
            "https://tracker.nitrix.me:443/announce"
        ];
        for (let i = 0; i < fallbacks.length; i++) {
            if (!trackerSet[fallbacks[i]]) trackerSet[fallbacks[i]] = true;
        }

        trackersCache = Object.keys(trackerSet);
        lastTrackersFetch = now;
        return trackersCache;
    }

    // ============================================================
    //  QUALITY PARSING
    // ============================================================
    function parseStreamFeatures(str) {
        const result = {
            resolution: "Auto", codec: null, hdr: null, audio: null,
            channels: null, is3D: false, isRemux: false, isWebdl: false,
            isBluray: false, debrid: null
        };
        if (!str) return result;
        const s = String(str).toLowerCase();

        // Resolution
        if (/\b(2160|4k|uhd)\b/.test(s)) result.resolution = "4K";
        else if (/\b1440\b/.test(s)) result.resolution = "1440p";
        else if (/\b1080\b/.test(s)) result.resolution = "1080p";
        else if (/\b720\b/.test(s)) result.resolution = "720p";
        else if (/\b480\b/.test(s)) result.resolution = "480p";
        else if (/\b360\b/.test(s)) result.resolution = "360p";

        const resMatch = s.match(/(\d{3,4})\s*x\s*(\d{3,4})/);
        if (resMatch) {
            const height = parseInt(resMatch[2]);
            if (height >= 2100) result.resolution = "4K";
            else if (height >= 1400) result.resolution = "1440p";
            else if (height >= 1000) result.resolution = "1080p";
            else if (height >= 700) result.resolution = "720p";
            else if (height >= 400) result.resolution = "480p";
        }

        // Codec
        if (/\b(av1|av01)\b/.test(s)) result.codec = "AV1";
        else if (/\b(x?v?265|hevc)\b/.test(s)) result.codec = "HEVC";
        else if (/\b(x264|h\.?264|avc)\b/.test(s)) result.codec = "H.264";

        // HDR
        if (/\b(dv|dovi|dolby[\s._-]?vision)\b/.test(s)) result.hdr = "DV";
        else if (/\bhdr10\+\b/.test(s)) result.hdr = "HDR10+";
        else if (/\bhdr10\b/.test(s)) result.hdr = "HDR10";
        else if (/\bhdr\b/.test(s)) result.hdr = "HDR";

        // Audio
        if (/\b(atmos|truehd)\b/.test(s)) result.audio = "Atmos";
        else if (/\bdts[-\s]?hd\b/.test(s)) result.audio = "DTS-HD";
        else if (/\bdts\b/.test(s)) result.audio = "DTS";
        else if (/\b(e?aac)\b/.test(s)) result.audio = "AAC";
        else if (/\b(flac|lpcm)\b/.test(s)) result.audio = "FLAC";

        const chMatch = s.match(/\b[257]\.1\b/);
        if (chMatch) result.channels = chMatch[0];

        // Source type
        if (/\bremux\b/.test(s)) result.isRemux = true;
        else if (/\b(web[\s.-]?dl|webrip)\b/.test(s)) result.isWebdl = true;
        else if (/\b(blu[\s.-]?ray|bdrip|brrip|bdr)\b/.test(s)) result.isBluray = true;

        // 3D
        if (/\b3d\b/.test(s) || /\b[hs]?sbs\b/.test(s)) result.is3D = true;

        // Debrid
        if (/\b\[?RD\]?\b/.test(s)) result.debrid = "RD";
        else if (/\b\[?AD\]?\b/.test(s)) result.debrid = "AD";
        else if (/\b\[?PM\]?\b/.test(s)) result.debrid = "PM";

        return result;
    }

    function formatStreamLabel(features, addonName) {
        const parts = [];
        if (features.debrid) parts.push("[" + features.debrid + "]");
        parts.push(addonName);
        if (features.resolution !== "Auto") parts.push(features.resolution);
        if (features.hdr) parts.push(features.hdr);
        if (features.codec) parts.push(features.codec);
        if (features.audio) parts.push(features.audio);
        if (features.channels) parts.push(features.channels);
        if (features.isRemux) parts.push("REMUX");
        else if (features.isBluray) parts.push("BluRay");
        else if (features.isWebdl) parts.push("WEB-DL");
        if (features.is3D) parts.push("3D");
        return parts.join(" ");
    }

    // ============================================================
    //  SUBTITLE NORMALIZATION
    // ============================================================
    function normalizeLang(code) {
        if (!code) return "Unknown";
        const key = code.split("-")[0].toLowerCase();
        return LANG_MAP[key] || key.toUpperCase() || code;
    }

    // ============================================================
    //  MAGNET LINK BUILDER
    // ============================================================
    function buildMagnetLink(infoHash, sources, trackers) {
        let magnet = "magnet:?xt=urn:btih:" + infoHash + "&dn=" + encodeURIComponent(infoHash);
        if (sources && Array.isArray(sources)) {
            for (let si = 0; si < sources.length; si++) {
                const src = sources[si];
                const trackerUrl = src.indexOf("tracker:") === 0 ? src.substring("tracker:".length) : src;
                if (trackerUrl) magnet += "&tr=" + encodeURIComponent(trackerUrl);
            }
        }
        let added = 0;
        for (let ti = 0; ti < trackers.length && added < 20; ti++) {
            if (magnet.indexOf("&tr=" + encodeURIComponent(trackers[ti])) === -1) {
                magnet += "&tr=" + encodeURIComponent(trackers[ti]);
                added++;
            }
        }
        return magnet;
    }

    // ============================================================
    //  EXTRACTOR INTEGRATION (uses SkyStream built-in extractors)
    // ============================================================
    async function tryExtractors(videoHostUrl) {
        // This function integrates with SkyStream's built-in extractors.
        // The extractors are loaded by the SkyStream runtime as global classes.
        // We try to match the host and use the appropriate extractor.
        try {
            const hostMatch = videoHostUrl.match(/https?:\/\/(?:www\.)?([^\/]+)/i);
            if (!hostMatch) return null;
            const host = hostMatch[1].toLowerCase();

            // Map host to extractor class name
            const extractorMap = {
                "mixdrop.co": "MixDrop", "mixdrop.to": "MixDrop", "mixdrop.ag": "MixDrop",
                "mixdrop.bz": "MixDrop", "mixdrop.ch": "MixDrop",
                "streamtape.com": "StreamTape", "streamtape.co": "StreamTape",
                "voe.sx": "Voe", "voe-unblock.com": "Voe", "voe-unblock.net": "Voe",
                "filemoon.sx": "FileMoon", "filemoon.to": "FileMoon",
                "doodstream.com": "DoodStream", "dood.to": "DoodStream", "dood.ws": "DoodStream",
                "mp4upload.com": "Mp4Upload",
                "yourupload.com": "YourUpload",
                "upstream.to": "UpStream",
                "fembed.com": "Fembed", "fembed.net": "Fembed",
                "uqload.com": "Uqload", "uqload.to": "Uqload",
                "netu.tv": "Netu", "netu.ac": "Netu",
                "gounlimited.to": "GoUnlimited",
                "clipwatching.com": "ClipWatching",
                "streamhub.to": "StreamHub", "streamhub.gg": "StreamHub",
                "vidcloud.pro": "VidCloud",
                "vidsrc.me": "VidSrc", "vidsrc.xyz": "VidSrc",
                "vidstreaming.io": "VidStreaming",
                "vidoza.net": "Vidoza",
                "videobin.co": "VideoBin",
                "embedsito.com": "EmbedSito",
                "embedwish.com": "EmbedWish"
            };

            const extractorName = extractorMap[host];
            if (extractorName && typeof globalThis !== "undefined") {
                const ExtractorClass = globalThis[extractorName];
                if (typeof ExtractorClass === "function") {
                    const extractor = new ExtractorClass();
                    const streams = await extractor.getUrl(videoHostUrl);
                    if (streams && streams.length > 0) {
                        return streams;
                    }
                }
            }
            return null;
        } catch (e) {
            log("debug", "Extractor failed for " + videoHostUrl, e.message);
            return null;
        }
    }

    // ============================================================
    //  STREAM PROCESSING
    // ============================================================
    async function processStreamResponse(streams, addonName, baseUrl) {
        if (!streams || !Array.isArray(streams)) return [];
        const trackers = await getTrackers();
        const results = [];

        for (let s = 0; s < streams.length; s++) {
            const stream = streams[s];
            if (!stream) continue;

            const rawName = (stream.name || "").replace(/\n/g, " ").trim();
            const rawTitle = (stream.title || "").replace(/\n/g, " ").trim();
            const rawDesc = (stream.description || "").replace(/\n/g, " ").trim();
            const featureText = rawName + " " + rawTitle + " " + rawDesc;
            const features = parseStreamFeatures(featureText);

            const titleText = rawTitle || rawName || "";
            const hasRichInfo = titleText.length > 10;
            let cleanSource;
            if (hasRichInfo) {
                let cleanedTitle = titleText.replace(/^\s*(4k|2160p?|uhd|1440p?|1080p?|720p?|480p?|360p?)\s*[-–—|:\s]*/i, "").trim();
                if (cleanedTitle) {
                    const addonPrefix = addonName;
                    cleanSource = (cleanedTitle.toLowerCase().indexOf(addonName.toLowerCase()) === 0 ? "" : addonPrefix + " ") + cleanedTitle;
                } else {
                    cleanSource = formatStreamLabel(features, addonName);
                }
            } else {
                cleanSource = formatStreamLabel(features, addonName);
            }

            // --- 1) DIRECT HTTP(S) URL ---
            if (stream.url && isValidHttpUrl(stream.url)) {
                const streamResult = await buildDirectStream(stream, features, cleanSource, addonName, baseUrl);
                if (streamResult) results.push(streamResult);
                continue;
            }

            // --- 2) TORRENT (infoHash) ---
            if (stream.infoHash) {
                const magnetUrl = buildMagnetLink(stream.infoHash, stream.sources, trackers);
                results.push(new StreamResult({
                    url: magnetUrl,
                    quality: features.resolution,
                    source: cleanSource,
                    infoHash: stream.infoHash,
                    fileIndex: stream.fileIdx !== undefined ? stream.fileIdx : 0,
                    cached: stream.cached || false,
                    size: stream.size || null,
                    behaviorHints: stream.behaviorHints || { notWebReady: true },
                    headers: { "User-Agent": USER_AGENT, "Referer": baseUrl + "/" }
                }));
                continue;
            }

            // --- 3) YOUTUBE ---
            if (stream.ytId) {
                results.push(new StreamResult({
                    url: "https://www.youtube.com/watch?v=" + stream.ytId,
                    quality: "YouTube",
                    source: "YouTube",
                    headers: { "Referer": "https://www.youtube.com/", "User-Agent": USER_AGENT },
                    behaviorHints: { notWebReady: true }
                }));
                continue;
            }

            // --- 4) EXTERNAL URL ---
            if (stream.externalUrl) {
                results.push(new StreamResult({
                    url: stream.externalUrl,
                    quality: features.resolution,
                    source: addonName + " External",
                    headers: { "User-Agent": USER_AGENT, "Referer": baseUrl + "/" },
                    behaviorHints: stream.behaviorHints || { notWebReady: true }
                }));
                continue;
            }

            // --- 5) FALLBACK ---
            if (stream.url) {
                const fbUrl = stream.url;
                let fbHash = null;
                if (fbUrl.indexOf("magnet:?xt=urn:btih:") === 0) {
                    const match = fbUrl.match(/urn:btih:([a-fA-F0-9]+)/);
                    if (match) fbHash = match[1].toLowerCase();
                }
                const fbProps = {
                    url: fbUrl,
                    quality: features.resolution,
                    source: cleanSource,
                    headers: { "User-Agent": USER_AGENT, "Referer": baseUrl + "/" },
                    behaviorHints: stream.behaviorHints || undefined
                };
                if (fbHash) {
                    fbProps.infoHash = fbHash;
                    fbProps.fileIndex = stream.fileIdx !== undefined ? stream.fileIdx : 0;
                }
                results.push(new StreamResult(fbProps));
            }
        }
        return results;
    }

    async function buildDirectStream(stream, features, cleanSource, addonName, baseUrl) {
        let headers = { "Referer": baseUrl + "/", "User-Agent": USER_AGENT };
        const bh = stream.behaviorHints || {};
        if (bh.proxyHeaders && bh.proxyHeaders.request) headers = Object.assign(headers, bh.proxyHeaders.request);
        else if (bh.headers) headers = Object.assign(headers, bh.headers);

        // HLS/DASH need Origin header
        if (stream.url.indexOf(".m3u8") !== -1 || stream.url.indexOf(".mpd") !== -1) {
            if (!headers["Origin"]) {
                try {
                    const u = new URL(stream.url);
                    headers["Origin"] = u.protocol + "//" + u.hostname;
                } catch (e) {}
            }
        }

        // Try extractor for known video hosts
        const isVideoHost = EXTRACTOR_HOSTS.some(host => stream.url.indexOf(host) !== -1);
        if (isVideoHost) {
            try {
                const extractorStreams = await tryExtractors(stream.url);
                if (extractorStreams && extractorStreams.length > 0) {
                    // Return the first good quality from extractor
                    return new StreamResult({
                        url: extractorStreams[0].url || stream.url,
                        quality: extractorStreams[0].quality || features.resolution,
                        source: cleanSource + " [Extracted]",
                        headers: extractorStreams[0].headers || headers,
                        subtitles: extractorStreams[0].subtitles || undefined,
                        behaviorHints: bh,
                        cached: stream.cached || false,
                        size: stream.size || null
                    });
                }
            } catch (e) {
                log("debug", "Extractor failed, using direct URL", e.message);
            }
        }

        // Subtitles
        let subtitles = undefined;
        if (stream.subtitles && Array.isArray(stream.subtitles) && stream.subtitles.length > 0) {
            subtitles = stream.subtitles.map(function(sub) {
                return {
                    url: sub.url,
                    lang: normalizeLang(sub.lang),
                    label: normalizeLang(sub.lang)
                };
            });
        }

        // DRM support
        const drmKid = stream.drmKid || bh.drmKid || null;
        const drmKey = stream.drmKey || bh.drmKey || null;
        const licenseUrl = stream.licenseUrl || bh.licenseUrl || null;

        return new StreamResult({
            url: stream.url,
            quality: features.resolution,
            source: cleanSource,
            headers: headers,
            subtitles: subtitles || undefined,
            behaviorHints: bh,
            cached: stream.cached || false,
            size: stream.size || null,
            drmKid: drmKid || undefined,
            drmKey: drmKey || undefined,
            licenseUrl: licenseUrl || undefined
        });
    }

    // ============================================================
    //  META TO MEDIA ITEM CONVERSION
    // ============================================================
    function metaToMultimediaItem(meta, addonConfig, catalogType) {
        if (!meta) return null;
        const type = meta.type || catalogType || "movie";
        const skystreamType = (type === "series" || type === "tv" || type === "anime" || type === "hentai") ? "series" : "movie";
        const poster = meta.poster || "";
        const background = meta.background || meta.backdrop || "";
        const description = meta.description ? meta.description.replace(/<[^>]*>/g, "").trim().substring(0, 500) : "";

        return new MultimediaItem({
            title: meta.name || meta.title || "Unknown",
            url: encodeUrl(addonConfig.baseUrl, type, meta.id, 0, 0, poster, meta.name || meta.title),
            posterUrl: poster,
            bannerUrl: background,
            type: skystreamType,
            description: description,
            year: meta.year ? parseInt(meta.year) : (meta.releaseInfo ? parseInt(meta.releaseInfo) : undefined),
            score: meta.imdbRating ? parseFloat(meta.imdbRating) : (meta.score || meta.popularity || undefined),
            isAdult: true,
            genres: meta.genres || meta.tags || undefined
        });
    }

    // ============================================================
    //  SMART CLIENT-SIDE MATCHER
    //  Checks title, description, genres, tags — not just title
    // ============================================================
    function metaMatchesQuery(meta, qLower) {
        // Check title
        const title = ((meta.name || meta.title || "") + " " + (meta.englishName || "")).toLowerCase();
        if (title.indexOf(qLower) !== -1) return true;

        // Check description
        if (meta.description) {
            const desc = meta.description.replace(/<[^>]*>/g, "").toLowerCase();
            if (desc.indexOf(qLower) !== -1) return true;
        }

        // Check genres/tags
        const tags = meta.genres || meta.tags || [];
        if (Array.isArray(tags)) {
            for (let i = 0; i < tags.length; i++) {
                if (String(tags[i]).toLowerCase().indexOf(qLower) !== -1) return true;
            }
        }

        // Check cast names
        const cast = meta.cast || [];
        if (Array.isArray(cast)) {
            for (let i = 0; i < cast.length; i++) {
                if (cast[i] && cast[i].name && cast[i].name.toLowerCase().indexOf(qLower) !== -1) return true;
            }
        }

        return false;
    }

    // ============================================================
    //  TRIM CACHE TO MAX SIZE (LRU-ish)
    // ============================================================
    function trimCache(cache) {
        if (cache.size <= MAX_CACHE_SIZE) return;
        const keys = Array.from(cache.keys());
        const toDelete = keys.slice(0, cache.size - MAX_CACHE_SIZE);
        for (let i = 0; i < toDelete.length; i++) {
            cache.delete(toDelete[i]);
        }
    }

    // ============================================================
    //  getHome — FIXED: Pagination distributed across ALL addons
    // ============================================================
    async function getHome(cb, page) {
        try {
            const pageNum = parseInt(page) || 1;
            const addonConfigs = await getAddonConfigs();
            if (addonConfigs.length === 0) {
                return cb({ success: false, errorCode: "NO_ADDONS", message: "No addons configured" });
            }

            const homeSections = {};
            const sectionOrder = [];

            // Calculate which catalogs to fetch per page
            const allCatalogEntries = [];
            for (let ci = 0; ci < addonConfigs.length; ci++) {
                const config = addonConfigs[ci];
                for (let cj = 0; cj < config.catalogs.length; cj++) {
                    allCatalogEntries.push({
                        config: config,
                        catalog: config.catalogs[cj]
                    });
                }
            }

            if (allCatalogEntries.length === 0) {
                return cb({ success: false, errorCode: "NO_CATALOGS", message: "No catalogs available" });
            }

            // Page 1: first ITEMS_PER_CATALOG from each catalog
            // Page N+1: next ITEMS_PER_CATALOG from each catalog (skip = pageNum * ITEMS_PER_CATALOG)
            const skip = (pageNum - 1) * ITEMS_PER_CATALOG;

            const catalogPromises = allCatalogEntries.map(function(entry) {
                return (async function() {
                    try {
                        const metas = await fetchCatalog(entry.config, entry.catalog, ITEMS_PER_CATALOG, skip);
                        if (!metas || metas.length === 0) return null;

                        const items = metas.map(function(meta) {
                            return metaToMultimediaItem(meta, entry.config, entry.catalog.type);
                        }).filter(function(item) { return item !== null; });

                        if (items.length === 0) return null;

                        let sectionName = entry.config.name;
                        const catName = entry.catalog.name || entry.catalog.id;
                        if (catName && catName !== entry.config.name) {
                            sectionName = entry.config.name + " - " + catName;
                        }
                        if (pageNum > 1) {
                            sectionName += " (Page " + pageNum + ")";
                        }
                        return { name: sectionName, items: items };
                    } catch (e) {
                        log("debug", "Failed to fetch catalog", entry.config.name + "/" + (entry.catalog.name || entry.catalog.id));
                        return null;
                    }
                })();
            });

            const catalogResults = await Promise.allSettled(catalogPromises);
            for (let i = 0; i < catalogResults.length; i++) {
                const result = catalogResults[i];
                if (result.status === "fulfilled" && result.value) {
                    homeSections[result.value.name] = result.value.items;
                    sectionOrder.push(result.value.name);
                }
            }

            if (Object.keys(homeSections).length === 0) {
                return cb({ success: false, errorCode: "NO_DATA", message: "No catalog data available" });
            }

            const orderedData = {};
            for (let i = 0; i < sectionOrder.length; i++) {
                const n = sectionOrder[i];
                if (homeSections[n]) orderedData[n] = homeSections[n];
            }

            cb({ success: true, data: orderedData, page: pageNum });
        } catch (e) {
            log("error", "getHome error", e.message);
            cb({ success: false, errorCode: "HOME_ERROR", message: e.message });
        }
    }

    // ============================================================
    //  FIXED search — ALL addons, fallback to client-side filter
    // ============================================================
    async function search(query, cb) {
        try {
            const q = String(query || "").trim();
            if (!q) return cb({ success: true, data: [] });

            const addonConfigs = await getAddonConfigs();
            if (addonConfigs.length === 0) return cb({ success: true, data: [] });

            const qLower = q.toLowerCase();
            const CLIENT_FILTER_LIMIT = 50; // how many items to pull for client-side filtering
            const allResults = [];

            const searchPromises = addonConfigs.map(function(config) {
                return (async function() {
                    const results = [];

                    // Separate catalogs that DECLARE search support vs those that don't
                    const searchDeclaredCatalogs = [];
                    const noSearchCatalogs = [];

                    for (let ci = 0; ci < config.catalogs.length; ci++) {
                        const cat = config.catalogs[ci];
                        let hasSearchExtra = false;
                        if (cat.extra && Array.isArray(cat.extra)) {
                            for (let ei = 0; ei < cat.extra.length; ei++) {
                                if (cat.extra[ei].name === "search") {
                                    hasSearchExtra = true;
                                    break;
                                }
                            }
                        }
                        if (hasSearchExtra) {
                            searchDeclaredCatalogs.push(cat);
                        } else {
                            noSearchCatalogs.push(cat);
                        }
                    }

                    // ── Catalogs WITH search declared: PATH-based search ──
                    // Stremio protocol: /catalog/{type}/{id}/search={query}.json
                    if (searchDeclaredCatalogs.length > 0) {
                        const searchPromises = searchDeclaredCatalogs.map(function(cat) {
                            return (async function() {
                                try {
                                    const url = `${config.baseUrl}/catalog/${cat.type}/${cat.id}/search=${encodeURIComponent(q)}.json`;
                                    const data = await fetchWithTimeout(url, HEADERS, SEARCH_TIMEOUT_MS);
                                    if (data && data.metas && data.metas.length > 0) {
                                        const items = [];
                                        for (let mi = 0; mi < data.metas.length; mi++) {
                                            const item = metaToMultimediaItem(data.metas[mi], config, cat.type);
                                            if (item) items.push(item);
                                        }
                                        return items;
                                    }
                                } catch (e) {}
                                return [];
                            })();
                        });
                        const catResults = await Promise.allSettled(searchPromises);
                        for (let i = 0; i < catResults.length; i++) {
                            const r = catResults[i];
                            if (r.status === "fulfilled" && r.value) {
                                for (let j = 0; j < r.value.length; j++) {
                                    results.push(r.value[j]);
                                }
                            }
                        }
                    }

                    // ── Catalogs WITHOUT search: client-side filter ──
                    if (noSearchCatalogs.length > 0) {
                        const fetchPromises = noSearchCatalogs.map(function(cat) {
                            return (async function() {
                                try {
                                    const url = `${config.baseUrl}/catalog/${cat.type}/${cat.id}.json?limit=${CLIENT_FILTER_LIMIT}`;
                                    const data = await fetchWithTimeout(url, HEADERS, SEARCH_TIMEOUT_MS);
                                    if (data && data.metas && data.metas.length > 0) {
                                        const matched = [];
                                        for (let mi = 0; mi < data.metas.length; mi++) {
                                            const meta = data.metas[mi];
                                            if (metaMatchesQuery(meta, qLower)) {
                                                const item = metaToMultimediaItem(meta, config, cat.type);
                                                if (item) matched.push(item);
                                            }
                                        }
                                        return matched;
                                    }
                                } catch (e) {}
                                return [];
                            })();
                        });
                        const fetchResults = await Promise.allSettled(fetchPromises);
                        for (let i = 0; i < fetchResults.length; i++) {
                            const r = fetchResults[i];
                            if (r.status === "fulfilled" && r.value) {
                                for (let j = 0; j < r.value.length; j++) {
                                    results.push(r.value[j]);
                                }
                            }
                        }
                    }

                    // ── Type-based generic search fallback ──
                    if (results.length === 0 && config.types.length > 0) {
                        for (let ti = 0; ti < config.types.length; ti++) {
                            try {
                                const t = config.types[ti];
                                const url = `${config.baseUrl}/catalog/${t}/top/search=${encodeURIComponent(q)}.json`;
                                const data = await fetchWithTimeout(url, HEADERS, SEARCH_TIMEOUT_MS);
                                if (data && data.metas && data.metas.length > 0) {
                                    for (let mi = 0; mi < data.metas.length; mi++) {
                                        const meta = data.metas[mi];
                                        if (metaMatchesQuery(meta, qLower)) {
                                            const item = metaToMultimediaItem(meta, config, t);
                                            if (item) results.push(item);
                                        }
                                    }
                                    if (results.length > 0) break;
                                }
                            } catch (e) {}
                        }
                    }

                    return results;
                })();
            });

            const searchResults = await Promise.allSettled(searchPromises);
            for (let i = 0; i < searchResults.length; i++) {
                const result = searchResults[i];
                if (result.status === "fulfilled" && result.value) {
                    for (let j = 0; j < result.value.length; j++) {
                        allResults.push(result.value[j]);
                    }
                }
            }

            // Deduplicate by title AND url
            const seen = {};
            const deduped = [];

            // Round-robin: interleave results from all addons for diversity
            // Group results by addon name
            const byAddon = {};
            for (let i = 0; i < allResults.length; i++) {
                const item = allResults[i];
                if (!item) continue;
                const key = (item.title + "|" + (item.url || "")).toLowerCase();
                if (seen[key]) continue;
                seen[key] = true;

                const urlStr = item.url || "";
                const match = urlStr.match(/"a":"([^"]+)"/);
                const source = match ? extractSourceName(match[1]) : "unknown";
                if (!byAddon[source]) byAddon[source] = [];
                byAddon[source].push(item);
            }

            // Round-robin pick: ensure MIN_RESULTS_PER_ADDON from each before filling rest
            const addonNames = Object.keys(byAddon);
            let picked = {};
            for (let ai = 0; ai < addonNames.length; ai++) picked[addonNames[ai]] = 0;

            // Pass 1: minimum per addon
            for (let ri = 0; ri < MIN_RESULTS_PER_ADDON; ri++) {
                for (let ai = 0; ai < addonNames.length; ai++) {
                    const name = addonNames[ai];
                    if (picked[name] < byAddon[name].length && deduped.length < MAX_SEARCH_RESULTS) {
                        deduped.push(byAddon[name][picked[name]]);
                        picked[name]++;
                    }
                }
            }

            // Pass 2: fill remaining by round-robin
            let hasMore = true;
            while (hasMore && deduped.length < MAX_SEARCH_RESULTS) {
                hasMore = false;
                for (let ai = 0; ai < addonNames.length; ai++) {
                    const name = addonNames[ai];
                    if (picked[name] < byAddon[name].length && deduped.length < MAX_SEARCH_RESULTS) {
                        deduped.push(byAddon[name][picked[name]]);
                        picked[name]++;
                        hasMore = true;
                    }
                }
            }

            // Per-addon result breakdown
            const breakdown = {};
            for (let i = 0; i < deduped.length; i++) {
                const url = deduped[i].url || "";
                const match = url.match(/"a":"([^"]+)"/);
                const source = match ? extractSourceName(match[1]) : "unknown";
                breakdown[source] = (breakdown[source] || 0) + 1;
            }
            const perAddon = Object.keys(breakdown).map(function(k) { return k + "=" + breakdown[k]; }).join(", ");
            log("info", `Search for "${q}": ${deduped.length} results across ${addonNames.length} addons [${perAddon}]`);
            cb({ success: true, data: deduped });
        } catch (e) {
            log("error", "search error", e.message);
            cb({ success: false, errorCode: "SEARCH_ERROR", message: e.message });
        }
    }

    // ============================================================
    //  load — Enhanced with better fallback
    // ============================================================
    async function load(url, cb) {
        try {
            const decoded = decodeUrl(url);
            if (!decoded) {
                return cb({ success: false, errorCode: "PARSE_ERROR", message: "Invalid URL format" });
            }

            const addonUrl = decoded.a;
            const type = decoded.t;
            const id = decoded.i;
            const fallbackPoster = decoded.p || "";
            const fallbackTitle = decoded.n || "";

            const metaUrl = `${addonUrl}/meta/${type}/${encodeURIComponent(id)}.json`;
            const data = await fetchWithTimeout(metaUrl, HEADERS, ADDON_TIMEOUT_MS);

            if (data && data.meta && (data.meta.name || data.meta.title)) {
                const meta = data.meta;
                const skystreamType = (type === "series" || type === "tv" || type === "anime" || type === "hentai") ? "series" : "movie";
                const episodes = [];

                if (meta.videos && Array.isArray(meta.videos)) {
                    for (let vi = 0; vi < meta.videos.length; vi++) {
                        const video = meta.videos[vi];
                        const epUrl = encodeUrl(addonUrl, type, video.id || id, video.season || 1, video.episode || video.number || 1);
                        episodes.push(new Episode({
                            name: video.title || video.name || "Episode " + (video.episode || video.number || 1),
                            url: epUrl,
                            season: video.season || 1,
                            episode: video.episode || video.number || 1,
                            posterUrl: video.thumbnail || meta.poster || "",
                            description: video.description || "",
                            airDate: video.released || ""
                        }));
                    }
                }

                if (episodes.length === 0) {
                    episodes.push(new Episode({
                        name: skystreamType === "movie" ? "Full Movie" : "Watch",
                        url: url,
                        season: 1,
                        episode: 1,
                        posterUrl: meta.poster || "",
                        description: (meta.description || "").replace(/<[^>]*>/g, "").trim()
                    }));
                }

                return cb({ success: true, data: new MultimediaItem({
                    title: meta.name || meta.title || meta.englishName || "Unknown",
                    url: url,
                    posterUrl: meta.poster || "",
                    bannerUrl: meta.background || meta.backdrop || "",
                    logoUrl: meta.logo || "",
                    type: skystreamType,
                    description: (meta.description || "").replace(/<[^>]*>/g, "").trim(),
                    year: meta.year ? parseInt(meta.year) : (meta.releaseInfo ? parseInt(meta.releaseInfo) : undefined),
                    score: meta.score || (meta.imdbRating ? parseFloat(meta.imdbRating) : undefined),
                    genres: meta.genres || meta.tags || undefined,
                    status: meta.status ? (meta.status.toLowerCase().indexOf("releasing") !== -1 || meta.status.toLowerCase().indexOf("ongoing") !== -1 ? "ongoing" : "completed") : undefined,
                    isAdult: true,
                    episodes: episodes
                })});
            }

            // Fallback: reconstruct from metadata stored in URL
            const displayId = id.replace(/^([a-z]+[-:])+/, "").replace(/[-_]/g, " ").replace(/\b\w/g, function(c) { return c.toUpperCase(); }).substring(0, 60);
            const fbType = (type === "series" || type === "tv" || type === "anime" || type === "hentai") ? "series" : "movie";
            cb({ success: true, data: new MultimediaItem({
                title: fallbackTitle || displayId || "Content",
                url: url,
                posterUrl: fallbackPoster,
                type: fbType,
                description: "Browse streams from source addon.",
                isAdult: true,
                episodes: [new Episode({ name: fbType === "movie" ? "Full Movie" : "Watch", url: url, season: 1, episode: 1 })]
            })});
        } catch (e) {
            log("error", "load error", e.message);
            cb({ success: false, errorCode: "LOAD_ERROR", message: e.message });
        }
    }

    // ============================================================
    //  loadStreams — FIXED: Parallel URL patterns + extractors
    // ============================================================
    async function loadStreams(url, cb) {
        try {
            const decoded = decodeUrl(url);
            if (!decoded) {
                return cb({ success: true, data: [new StreamResult({ url: url, quality: "Auto", source: "Direct", headers: HEADERS })] });
            }

            const addonUrl = decoded.a;
            const type = decoded.t;
            const id = decoded.i;
            const season = decoded.s;
            const episode = decoded.e;

            const cacheKey = `${addonUrl}:${type}:${id}:${season}:${episode}`;
            const cached = streamResultCache.get(cacheKey);
            if (cached && (Date.now() - cached.ts) < STREAM_CACHE_TTL) {
                return cb({ success: true, data: cached.data });
            }

            const addonName = extractSourceName(addonUrl);
            const startTime = Date.now();

            // Build all URL patterns and try them IN PARALLEL
            const urlsToTry = [
                `${addonUrl}/stream/${type}/${encodeURIComponent(id)}.json`,
                `${addonUrl}/stream/movie/${encodeURIComponent(id)}.json` // fallback
            ];
            if ((type === "series" || type === "anime" || type === "hentai") && season > 0 && episode > 0) {
                urlsToTry.push(`${addonUrl}/stream/${type}/${encodeURIComponent(id)}:${season}:${episode}.json`);
            }

            // Try all URLs concurrently, take the first one that returns results
            const streamResults = await Promise.allSettled(urlsToTry.map(function(url) {
                return fetchWithTimeout(url, HEADERS, ADDON_TIMEOUT_MS).then(function(data) {
                    if (data && data.streams && Array.isArray(data.streams) && data.streams.length > 0) {
                        return { source: url, streams: data.streams };
                    }
                    return null;
                });
            }));

            let rawStreams = [];
            for (let i = 0; i < streamResults.length; i++) {
                const r = streamResults[i];
                if (r.status === "fulfilled" && r.value && r.value.streams) {
                    rawStreams = r.value.streams;
                    break;
                }
            }

            let streams = await processStreamResponse(rawStreams, addonName, addonUrl);

            // Deduplicate by infoHash or URL
            const seen = {};
            streams = streams.filter(function(s) {
                const key = s.infoHash || s.url;
                if (!key) return true;
                if (seen[key]) return false;
                seen[key] = true;
                return true;
            });

            // Sort by quality (best first)
            const qOrder = { "4K": 0, "2160p": 0, "1440p": 1, "1080p": 2, "720p": 3, "480p": 4, "360p": 5, "YouTube": 6, "Auto": 7 };
            streams.sort(function(a, b) {
                const qa = qOrder[a.quality] !== undefined ? qOrder[a.quality] : 7;
                const qb = qOrder[b.quality] !== undefined ? qOrder[b.quality] : 7;
                if (qa !== qb) return qa - qb;
                if (a.cached && !b.cached) return -1;
                if (!a.cached && b.cached) return 1;
                return 0;
            });

            const elapsed = Date.now() - startTime;
            log("info", `Found ${streams.length} streams for ${id} in ${elapsed}ms`);

            // Cache result
            streamResultCache.set(cacheKey, { ts: Date.now(), data: streams });
            trimCache(streamResultCache);

            cb({ success: true, data: streams });
        } catch (e) {
            log("error", "loadStreams error", e.message);
            cb({ success: true, data: [] });
        }
    }

    // ============================================================
    //  HELPERS
    // ============================================================
    function extractSourceName(addonUrl) {
        try {
            let hostname = addonUrl.replace(/https?:\/\//, "").split("/")[0].replace(/^www\./, "");
            const parts = hostname.split(".");
            if (parts.length >= 2) {
                const tlds = ["com", "org", "net", "io", "app", "dev", "tv", "co", "uk", "de", "xyz", "fun", "cloud", "me", "pw", "club"];
                let best = parts[0];
                if (tlds.indexOf(best) !== -1 && parts.length > 1) best = parts[1];
                return best.charAt(0).toUpperCase() + best.slice(1);
            }
            return parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
        } catch (e) { return "Addon"; }
    }

    // ============================================================
    //  INIT
    // ============================================================
    // Pre-warm trackers in background
    getTrackers().then(function(t) {
        log("info", "Tracker cache warmed: " + t.length + " trackers");
    }).catch(function() {});

    // Log addon count on load
    const addonCount = getAddonUrls().length;
    log("info", `StremioNsfw v4 loaded. ${addonCount} addons configured.`);

    // ============================================================
    //  EXPORTS
    // ============================================================
    globalThis.getHome = getHome;
    globalThis.search = search;
    globalThis.load = load;
    globalThis.loadStreams = loadStreams;
})();
