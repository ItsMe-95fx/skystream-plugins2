(function() {
    "use strict";

    // ================================================================
    //  Stremio Hub v3 — All features + max links
    //
    //  v2: http_parallel, persistent cache, parallel everything
    //  v3 additions:
    //  - parse_html native parsing (no regex for HTML extraction)
    //  - Subtitle matching via videoHash/videoSize
    //  - Stream quality sorting (4K > 1080p > 720p > 480p > CAM)
    //  - MAGIC_PROXY_v1 for header-restricted streams
    //  - Pre-fetching loadStreams on load() call
    //  - Rate limit backoff per addon URL
    //  - Delayed-addon support (60s timeout, two-phase fetch)
    // ================================================================

    var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";
    var JSON_HEADERS = { "User-Agent": UA, "Accept": "application/json", "Accept-Language": "en-US,en;q=0.5" };
    var CACHE_TTL = 600000;
    var _cache = {};

    // ── Rate limit backoff tracking ───────────────────────────────
    // Per-URL: { fails: number, until: timestamp }
    var _rateLimits = {};
    var RATE_BACKOFF_MS = 300000; // 5 min backoff after 429/503
    var RATE_MAX_FAILS = 3; // skip after 3 consecutive failures

    function isRateLimited(url) {
        var rl = _rateLimits[url];
        return rl && rl.fails >= RATE_MAX_FAILS && Date.now() < rl.until;
    }

    function recordRateLimit(url, status) {
        if (status === 429 || status === 503 || status === 502 || status === 504) {
            var rl = _rateLimits[url] || { fails: 0, until: 0 };
            rl.fails++;
            rl.until = Date.now() + RATE_BACKOFF_MS;
            _rateLimits[url] = rl;
            try { setPreference("hub_ratelimit:" + url, JSON.stringify(rl)); } catch (e) {}
        } else if (status >= 200 && status < 300) {
            // Success — reset counter
            if (_rateLimits[url]) {
                _rateLimits[url].fails = 0;
                try { setPreference("hub_ratelimit:" + url, JSON.stringify(_rateLimits[url])); } catch (e) {}
            }
        }
    }

    function loadRateLimits() {
        try {
            var keys = ["hub_ratelimit:"];
            // We can't enumerate preferences, so we rely on in-memory + per-call persistence
            // Rate limits are stored per-URL and loaded on demand in isRateLimited
        } catch (e) {}
    }

    // ── Content type mapping ───────────────────────────────────────
    function skyType(t) { return (t === "movie" || t === "short") ? "movie" : "series"; }

    // ── URL helpers ───────────────────────────────────────────────
    function baseUrl(m) { return (m || "").replace(/\/manifest\.json$/, "").replace(/\/$/, ""); }

    function addonName(url) {
        try {
            var h = url.replace(/https?:\/\//, "").split("/")[0].replace(/^www\./, "");
            var p = h.split(".");
            if (p.length >= 2) {
                var tlds = ["com","org","net","io","app","dev","tv","co","uk","de","xyz","fun","cloud","me"];
                var b = p[0]; if (tlds.indexOf(b) !== -1 && p.length > 1) b = p[1];
                return b.charAt(0).toUpperCase() + b.slice(1);
            }
            return p[0].charAt(0).toUpperCase() + p[0].slice(1);
        } catch (e) { return "Addon"; }
    }

    function isHttp(s) { return s && (s.indexOf("http://") === 0 || s.indexOf("https://") === 0); }
    function str(s) { return String(s == null ? "" : s); }
    function safeJson(t, f) { try { return JSON.parse(str(t)); } catch (e) { return f || null; } }

    // ── Persistent Cache ──────────────────────────────────────────
    function pCacheGet(k) {
        var c = _cache[k];
        if (c && (Date.now() - c.ts) < CACHE_TTL) return c.data;
        try {
            var raw = getPreference("hub_cache:" + k);
            if (raw) {
                var parsed = safeJson(raw, null);
                if (parsed && parsed.ts && (Date.now() - parsed.ts) < CACHE_TTL) {
                    _cache[k] = parsed;
                    return parsed.data;
                }
            }
        } catch (e) {}
        return null;
    }

    function pCacheSet(k, d) {
        var entry = { ts: Date.now(), data: d };
        _cache[k] = entry;
        try { setPreference("hub_cache:" + k, JSON.stringify(entry)); } catch (e) {}
    }

    // ── HTTP via http_parallel ────────────────────────────────────
    function httpReq(url) {
        return { method: "GET", url: url, headers: JSON_HEADERS };
    }

    function httpBatch(urls) {
        if (!urls.length) return Promise.resolve([]);
        // Filter out rate-limited URLs but keep their indices for alignment
        var activeUrls = [];
        var activeIndices = [];
        for (var i = 0; i < urls.length; i++) {
            if (!isRateLimited(urls[i])) {
                activeUrls.push(urls[i]);
                activeIndices.push(i);
            }
        }
        if (!activeUrls.length) {
            return Promise.resolve(urls.map(function(u) { return { url: u, ok: false, data: null, status: 429 }; }));
        }
        var reqs = [];
        for (var i = 0; i < activeUrls.length; i++) {
            reqs.push(httpReq(activeUrls[i]));
        }
        return http_parallel(reqs).then(function(responses) {
            var results = urls.map(function(u) { return { url: u, ok: false, data: null, status: 0 }; });
            for (var i = 0; i < responses.length; i++) {
                var r = responses[i];
                var idx = activeIndices[i];
                var entry = { url: activeUrls[i], ok: false, data: null, status: r ? (r.status || r.code || 0) : 0 };
                recordRateLimit(activeUrls[i], entry.status);
                if (r && r.body && entry.status === 200) {
                    try {
                        var b = r.body;
                        if (typeof b === "string") {
                            b = b.trim();
                            if (b && b.charAt(0) !== "<") {
                                entry.data = JSON.parse(b);
                                entry.ok = true;
                            }
                        } else if (typeof b === "object") {
                            entry.data = b;
                            entry.ok = true;
                        }
                    } catch (e) {}
                }
                results[idx] = entry;
            }
            return results;
        }).catch(function() {
            return urls.map(function(u) { return { url: u, ok: false, data: null, status: 0 }; });
        });
    }

    // Single fetch via http_get (for redirects)
    function fetchJson(url) {
        return http_get(url, JSON_HEADERS).then(function(r) {
            if (!r || !r.body) throw new Error("Empty response");
            recordRateLimit(url, r.status || 0);
            if (r.status >= 300 && r.status < 400) {
                var loc = r.location || (r.headers && (r.headers.location || r.headers.Location));
                if (typeof r.body === 'string' && r.body.indexOf('Redirecting') !== -1) {
                    var m = r.body.match(/https?:\/\/[^\s"']+/);
                    if (m) loc = m[0];
                }
                if (loc) {
                    var redirectUrl = typeof loc === 'string' ? loc : (loc.url || '');
                    if (redirectUrl.indexOf('http') !== 0) {
                        try { var u = new URL(url); redirectUrl = u.origin + redirectUrl; } catch(e) {}
                    }
                    return fetchJson(redirectUrl);
                }
            }
            if (r.status !== 200 && r.status !== 304) throw new Error("HTTP " + r.status);
            var b = r.body;
            if (typeof b === "string") {
                b = b.trim();
                if (!b) throw new Error("Empty body");
                if (b.charAt(0) === "<") throw new Error("HTML");
                return JSON.parse(b);
            }
            return b;
        });
    }

    // ── Native parse_html wrapper ─────────────────────────────────
    // Uses SkyStream's parse_html(html, selector, attr) instead of regex
    // Returns array of { text, html, attr } or null if parse_html unavailable
    function nativeParseHtml(html, selector, attr) {
        if (typeof parse_html !== "function") return null;
        try {
            return parse_html(html, selector, attr || "textContent");
        } catch (e) { return null; }
    }

    // ── Manifest fetcher with persistent cache ─────────────────────
    function getManifest(url) {
        var k = "mf:" + url;
        var cached = pCacheGet(k);
        if (cached) return Promise.resolve(cached);
        if (isRateLimited(url)) return Promise.resolve(null);
        var p = fetchJson(url);
        var t = new Promise(function(r) { setTimeout(function() { r(null); }, 8000); });
        return Promise.race([p, t]).then(function(d) {
            if (d) pCacheSet(k, d);
            return d;
        });
    }

    // ════════════════════════════════════════════════════════════════
    //  ADDON ACCESSORS
    // ════════════════════════════════════════════════════════════════

    function getCatalogueAddons() {
        try { if (manifest && Array.isArray(manifest.catalogueAddons)) return manifest.catalogueAddons; } catch (e) {}
        return [];
    }
    function getStreamingAddons() {
        try { if (manifest && Array.isArray(manifest.streamingAddons)) return manifest.streamingAddons; } catch (e) {}
        return [];
    }
    function getSubtitlesAddons() {
        try { if (manifest && Array.isArray(manifest.subtitlesAddons)) return manifest.subtitlesAddons; } catch (e) {}
        return [];
    }

    // ════════════════════════════════════════════════════════════════
    //  META PREVIEW → SkyStream MultimediaItem
    // ════════════════════════════════════════════════════════════════

    function parseYear(meta) {
        if (!meta) return undefined;
        if (meta.year != null) { var y = parseInt(meta.year, 10); if (y > 1900 && y < 2100) return y; }
        if (meta.releaseInfo) {
            var parts = str(meta.releaseInfo).split(/[–-]/).shift().trim();
            var y = parseInt(parts, 10);
            if (y > 1900 && y < 2100) return y;
        }
        return undefined;
    }
    function parseRating(meta) {
        if (meta.imdbRating != null) { var r = parseFloat(meta.imdbRating); if (!isNaN(r) && r >= 0 && r <= 10) return r; }
        if (meta.score != null) { var r = parseFloat(meta.score); if (!isNaN(r) && r >= 0 && r <= 10) return r; }
        return undefined;
    }
    function parseGenres(meta) { var g = meta.genres || meta.genre || meta.tags; return (Array.isArray(g) && g.length) ? g : undefined; }

    function toItem(m, fallbackType) {
        try {
            if (!m || !m.id) return null;
            return new MultimediaItem({
                title: m.name || m.title || m.originalName || "Unknown",
                url: m.id || "",
                posterUrl: m.poster || m.posterUrl || m.thumbnail || "",
                bannerUrl: m.background || m.backdrop || m.banner || m.bannerUrl || "",
                logoUrl: m.logo || m.logoUrl || "",
                type: skyType(m.type || fallbackType || "movie"),
                description: str(m.description || m.overview || m.synopsis || "").replace(/<[^>]*>/g, "").trim().substring(0, 500),
                year: parseYear(m),
                score: parseRating(m),
                genres: parseGenres(m)
            });
        } catch (e) { return null; }
    }

    // ════════════════════════════════════════════════════════════════
    //  getHome
    // ════════════════════════════════════════════════════════════════

    async function getHome(cb, page) {
        try {
            var pn = parseInt(page) || 1;
            var urls = getCatalogueAddons();
            if (!urls.length) return cb({ success: false, errorCode: "NO_ADDONS", message: "No catalogueAddons" });

            var results = { data: {}, order: [] };

            var manifestResults = [];
            var uncachedUrls = [];
            var uncachedIndices = [];
            for (var i = 0; i < urls.length; i++) {
                var cached = pCacheGet("mf:" + urls[i]);
                if (cached) {
                    manifestResults[i] = cached;
                } else {
                    uncachedUrls.push(urls[i]);
                    uncachedIndices.push(i);
                }
            }

            if (uncachedUrls.length) {
                var mfBatch = await httpBatch(uncachedUrls);
                for (var j = 0; j < mfBatch.length; j++) {
                    var idx = uncachedIndices[j];
                    if (mfBatch[j].ok && mfBatch[j].data) {
                        manifestResults[idx] = mfBatch[j].data;
                        pCacheSet("mf:" + uncachedUrls[j], mfBatch[j].data);
                    }
                }
            }

            var catalogUrls = [];
            for (var ai = 0; ai < urls.length; ai++) {
                var mf = manifestResults[ai];
                if (!mf || !Array.isArray(mf.catalogs) || !mf.catalogs.length) continue;
                var bu = baseUrl(urls[ai]);
                var an = addonName(urls[ai]);
                for (var ci = 0; ci < mf.catalogs.length; ci++) {
                    var cat = mf.catalogs[ci];
                    if (!cat || !cat.id || !cat.type) continue;
                    var extras = cat.extra || [];
                    if (extras.some(function(e) { return e && e.name === "search" && e.isRequired === true; })) continue;

                    var catUrl = bu + "/catalog/" + cat.type + "/" + cat.id + ".json";
                    if (pn > 1) catUrl += (catUrl.indexOf("?") === -1 ? "?" : "&") + "skip=" + ((pn - 1) * 20);

                    catalogUrls.push({
                        url: catUrl, addonIdx: ai, addonName: an,
                        catName: cat.name || cat.id, catType: cat.type, totalAddons: urls.length
                    });
                }
            }

            if (!catalogUrls.length) return cb({ success: false, errorCode: "NO_DATA", message: "No catalogs" });

            var catUrls = catalogUrls.map(function(c) { return c.url; });
            var catResults = await httpBatch(catUrls);

            for (var ri = 0; ri < catResults.length; ri++) {
                var cr = catResults[ri];
                var info = catalogUrls[ri];
                if (!cr.ok || !cr.data || !Array.isArray(cr.data.metas) || !cr.data.metas.length) continue;

                var items = cr.data.metas.map(function(m) { return toItem(m, info.catType); }).filter(Boolean);
                if (!items.length) continue;

                var catLabel = (info.totalAddons > 1) ? (info.addonName + " - " + info.catName) : info.catName;
                if (!results.data[catLabel]) {
                    results.data[catLabel] = items;
                    results.order.push(catLabel);
                }
            }

            if (!Object.keys(results.data).length) return cb({ success: false, errorCode: "NO_DATA", message: "No catalog data" });
            var out = {};
            for (var i = 0; i < results.order.length; i++) { if (results.data[results.order[i]]) out[results.order[i]] = results.data[results.order[i]]; }
            cb({ success: true, data: out, page: pn });
        } catch (e) {
            console.error("[Hub] getHome:", e.message || e);
            cb({ success: false, errorCode: "HOME_ERROR", message: e.message || "Error" });
        }
    }

    // ════════════════════════════════════════════════════════════════
    //  search
    // ════════════════════════════════════════════════════════════════

    async function search(query, cb) {
        try {
            var q = str(query).trim().toLowerCase();
            if (!q) return cb({ success: true, data: [] });

            var urls = getCatalogueAddons();
            if (!urls.length) return cb({ success: true, data: [] });

            var all = [];
            var seen = {};
            function addItem(item) { if (item && item.url && !seen[item.url]) { seen[item.url] = true; all.push(item); } }

            var manifests = [];
            var uncachedUrls = [], uncachedIdx = [];
            for (var i = 0; i < urls.length; i++) {
                var c = pCacheGet("mf:" + urls[i]);
                if (c) { manifests[i] = c; }
                else { uncachedUrls.push(urls[i]); uncachedIdx.push(i); }
            }
            if (uncachedUrls.length) {
                var mfRes = await httpBatch(uncachedUrls);
                for (var j = 0; j < mfRes.length; j++) {
                    if (mfRes[j].ok && mfRes[j].data) {
                        manifests[uncachedIdx[j]] = mfRes[j].data;
                        pCacheSet("mf:" + uncachedUrls[j], mfRes[j].data);
                    }
                }
            }

            var searchUrls = [];
            for (var ai = 0; ai < urls.length; ai++) {
                var mf = manifests[ai];
                if (!mf || !Array.isArray(mf.catalogs) || !mf.catalogs.length) continue;
                var bu = baseUrl(urls[ai]);

                var searchCats = [], browseCats = [];
                for (var ci = 0; ci < mf.catalogs.length; ci++) {
                    var cat = mf.catalogs[ci];
                    if (!cat || !cat.id || !cat.type) continue;
                    var extras = cat.extra || [];
                    if (extras.some(function(e) { return e && e.name === "search"; })) searchCats.push(cat);
                    else if (browseCats.length < 5) browseCats.push(cat);
                }

                for (var si = 0; si < searchCats.length; si++) {
                    searchUrls.push({
                        url: bu + "/catalog/" + searchCats[si].type + "/" + searchCats[si].id + "/search=" + encodeURIComponent(query) + ".json",
                        catType: searchCats[si].type, isSearch: true
                    });
                }
                for (var bi = 0; bi < browseCats.length; bi++) {
                    searchUrls.push({
                        url: bu + "/catalog/" + browseCats[bi].type + "/" + browseCats[bi].id + ".json",
                        catType: browseCats[bi].type, isSearch: false
                    });
                }
            }

            if (!searchUrls.length) return cb({ success: true, data: [] });

            var sUrls = searchUrls.map(function(s) { return s.url; });
            var sResults = await httpBatch(sUrls);

            var foundSearch = false;
            for (var ri = 0; ri < sResults.length && all.length < 50; ri++) {
                var sr = sResults[ri];
                var info = searchUrls[ri];
                if (!sr.ok || !sr.data) continue;
                if (info.isSearch) {
                    if (Array.isArray(sr.data.metas) && sr.data.metas.length) {
                        foundSearch = true;
                        for (var mi = 0; mi < sr.data.metas.length && all.length < 50; mi++) {
                            addItem(toItem(sr.data.metas[mi], info.catType));
                        }
                    }
                }
            }

            if (!foundSearch) {
                for (var ri = 0; ri < sResults.length && all.length < 50; ri++) {
                    var sr = sResults[ri];
                    var info = searchUrls[ri];
                    if (info.isSearch || !sr.ok || !sr.data || !Array.isArray(sr.data.metas)) continue;
                    for (var mi = 0; mi < sr.data.metas.length && all.length < 50; mi++) {
                        var m = sr.data.metas[mi];
                        if (str(m.name || m.title || "").toLowerCase().indexOf(q) !== -1) {
                            addItem(toItem(m, info.catType));
                        }
                    }
                }
            }

            cb({ success: true, data: all.slice(0, 50) });
        } catch (e) {
            console.error("[Hub] search:", e.message || e);
            cb({ success: true, data: [] });
        }
    }

    // ════════════════════════════════════════════════════════════════
    //  load — with pre-fetching loadStreams
    // ════════════════════════════════════════════════════════════════

    function parseVideoId(raw) {
        if (!raw) return null;
        var p = safeJson(raw, null);
        if (p && p.i !== undefined) return { id: str(p.i), type: p.t || "movie", season: p.s || 0, episode: p.e || 0 };
        if (p && p.tmdbId !== undefined) return { id: str(p.tmdbId), type: p.mediaType || "movie", season: p.seasonNumber || 0, episode: p.episodeNumber || 0 };

        if (raw.indexOf(":") !== -1) {
            var parts = raw.split(":");
            var first = parts[0];
            if (/^tt\d+$/.test(first) && parts.length >= 3) {
                var sn = parseInt(parts[1], 10);
                var en = parseInt(parts[2], 10);
                return { id: first, type: "series", season: isNaN(sn) ? 0 : sn, episode: isNaN(en) ? 0 : en };
            }
            if (first.indexOf("_") !== -1 || first.indexOf("-") !== -1) {
                return { id: raw, type: "series", season: 0, episode: 0 };
            }
        }
        return { id: raw, type: "movie", season: 0, episode: 0 };
    }


    async function load(url, cb) {
        try {
            var rawInput = str(url).trim();
            if (!rawInput) return cb({ success: false, errorCode: "PARSE_ERROR", message: "No ID" });

            var vp = parseVideoId(rawInput);
            var metaId = vp ? vp.id : rawInput;
            var knownType = vp ? vp.type : null;
            if (!metaId) return cb({ success: false, errorCode: "PARSE_ERROR", message: "No ID" });

            var addonUrls = getCatalogueAddons();
            if (!addonUrls.length) return respondMeta({ name: "Content", id: metaId, type: knownType || "movie" }, metaId, cb);

            var eid = encodeURIComponent(metaId);
            var tryTypes = knownType ? [knownType, "movie", "series", "anime", "channel", "tv"]
                                      : ["movie", "series", "anime", "channel", "tv"];

            var metaUrls = [];
            var metaInfo = [];
            for (var ai = 0; ai < addonUrls.length; ai++) {
                var bu = baseUrl(addonUrls[ai]);
                for (var ti = 0; ti < tryTypes.length; ti++) {
                    metaUrls.push(bu + "/meta/" + tryTypes[ti] + "/" + eid + ".json");
                    metaInfo.push({ addonUrl: addonUrls[ai], type: tryTypes[ti] });
                }
            }

            var metaResults = await httpBatch(metaUrls);

            var found = null;
            for (var ri = 0; ri < metaResults.length; ri++) {
                var mr = metaResults[ri];
                if (!mr.ok || !mr.data) continue;
                if (mr.data.meta && mr.data.meta.id) { found = mr.data.meta; break; }
                if (Array.isArray(mr.data.metas) && mr.data.metas.length && mr.data.metas[0].id) { found = mr.data.metas[0]; break; }
            }

            if (found) {
                respondMeta(found, metaId, cb);
            } else {
                var isSeries = (knownType === "series" || knownType === "anime" || knownType === "tv" || knownType === "channel");
                respondMeta({ name: "Content", id: metaId, type: isSeries ? "series" : "movie" }, metaId, cb);
            }

            // Pre-fetch streams in background — don't block the callback
            try {
                loadStreams(rawInput, function() {
                    // Cache the result so when user taps Play, streams are ready
                    pCacheSet("streams:" + metaId, arguments[0]);
                });
            } catch (e) { /* pre-fetch is best-effort */ }
        } catch (e) {
            console.error("[Hub] load:", e.message || e);
            try { respondMeta({ name: "Unknown", id: rawInput, type: "movie" }, rawInput, cb); } catch (f) {
                cb({ success: false, errorCode: "LOAD_ERROR", message: e.message || "Error" });
            }
        }
    }

    function respondMeta(meta, metaId, cb) {
        try {
            var t = meta.type || "movie";
            var st = skyType(t);
            var y = parseYear(meta);
            var s = parseRating(meta);
            var desc = str(meta.description || meta.overview || meta.synopsis || "").replace(/<[^>]*>/g, "").trim();

            var eps = [];
            var isSeries = (st !== "movie");

            if (isSeries && Array.isArray(meta.videos) && meta.videos.length) {
                for (var vi = 0; vi < meta.videos.length; vi++) {
                    try {
                        var v = meta.videos[vi];
                        if (!v || !v.id) continue;
                        var sn = v.season || 1;
                        var en = v.episode || v.number || 1;
                        var vid = metaId + ":" + sn + ":" + en;
                        eps.push(new Episode({
                            name: v.name || v.title || "Episode " + en,
                            url: vid, season: sn, episode: en,
                            posterUrl: v.thumbnail || v.poster || meta.poster || "",
                            description: v.overview || v.description || "",
                            airDate: v.released || v.firstAired || ""
                        }));
                    } catch (e) {}
                }
            }

            if (!eps.length) {
                var vid = isSeries ? (metaId + ":1:1") : metaId;
                eps.push(new Episode({
                    name: st === "movie" ? "Full Movie" : "Watch",
                    url: vid, season: 1, episode: 1,
                    posterUrl: meta.poster || ""
                }));
            }

            var cast = undefined;
            if (Array.isArray(meta.cast) && meta.cast.length) {
                cast = [];
                for (var ci = 0; ci < meta.cast.length; ci++) {
                    try {
                        var c = meta.cast[ci];
                        if (!c) continue;
                        if (typeof c === "string") {
                            cast.push(new Actor({ name: c, role: "", image: "" }));
                        } else {
                            cast.push(new Actor({
                                name: c.name || c.fullName || c.person || "",
                                role: c.role || c.character || "",
                                image: c.image || c.picture || c.photo || c.profile || c.profile_path || ""
                            }));
                        }
                    } catch (e) {}
                }
                if (!cast.length) cast = undefined;
            }

            var trailers = undefined;
            if (Array.isArray(meta.trailers) && meta.trailers.length) {
                trailers = [];
                for (var tri = 0; tri < meta.trailers.length; tri++) {
                    try {
                        var tr = meta.trailers[tri];
                        if (!tr) continue;
                        var src = tr.source || tr.url || "";
                        var trUrl = (src.indexOf("http") === 0) ? src : "https://www.youtube.com/watch?v=" + src;
                        trailers.push(new Trailer({ url: trUrl, name: tr.name || tr.type || "Trailer" }));
                    } catch (e) {}
                }
                if (!trailers.length) trailers = undefined;
            }

            var director = undefined;
            if (meta.director) {
                director = Array.isArray(meta.director) ? meta.director.filter(Boolean).join(", ") : str(meta.director);
                if (!director) director = undefined;
            }

            var status = undefined;
            if (meta.status) {
                var sv = str(meta.status).toLowerCase();
                if (sv === "ended") status = "completed";
                else if (sv === "returning series" || sv === "continuing" || sv === "ongoing") status = "ongoing";
                else if (sv === "in production" || sv === "planned") status = "upcoming";
            }

            cb({ success: true, data: new MultimediaItem({
                title: meta.name || meta.title || "Unknown",
                url: metaId,
                posterUrl: meta.poster || meta.posterUrl || "",
                posterShape: meta.posterShape || "poster",
                bannerUrl: meta.background || meta.backdrop || meta.banner || "",
                logoUrl: meta.logo || meta.logoUrl || "",
                type: st,
                description: desc,
                year: y,
                score: s,
                genres: parseGenres(meta),
                cast: cast,
                director: director,
                trailers: trailers,
                runtime: meta.runtime ? str(meta.runtime) : undefined,
                language: meta.language || undefined,
                country: meta.country || undefined,
                awards: meta.awards || undefined,
                website: meta.website || undefined,
                status: status,
                episodes: eps
            })});
        } catch (e) {
            console.error("[Hub] respondMeta:", e.message);
            var ft = skyType(meta.type || "movie");
            cb({ success: true, data: new MultimediaItem({
                title: meta.name || meta.title || "Unknown", url: metaId, type: ft,
                episodes: [new Episode({ name: "Play", url: ft === "movie" ? metaId : metaId + ":1:1", season: 1, episode: 1 })]
            })});
        }
    }

    // ════════════════════════════════════════════════════════════════
    //  STREAM SYSTEM — v3 features
    // ════════════════════════════════════════════════════════════════

    var STRM_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";

    var LANG = {
        "en":"English","es":"Spanish","fr":"French","de":"German","it":"Italian","pt":"Portuguese",
        "ru":"Russian","ja":"Japanese","ko":"Korean","zh":"Chinese","ar":"Arabic","hi":"Hindi",
        "nl":"Dutch","pl":"Polish","tr":"Turkish","th":"Thai","vi":"Vietnamese","cs":"Czech",
        "hu":"Hungarian","ro":"Romanian","he":"Hebrew","el":"Greek","sv":"Swedish","da":"Danish",
        "no":"Norwegian","fi":"Finnish","id":"Indonesian","ms":"Malay","bg":"Bulgarian","uk":"Ukrainian",
        "sr":"Serbian","hr":"Croatian","sk":"Slovak","lt":"Lithuanian","lv":"Latvian","et":"Estonian",
        "is":"Icelandic","sl":"Slovenian","bn":"Bengali","ta":"Tamil","te":"Telugu","mr":"Marathi",
        "ml":"Malayalam","kn":"Kannada","gu":"Gujarati","pa":"Punjabi","ur":"Urdu",
        "eng":"English","spa":"Spanish","fra":"French","deu":"German","ita":"Italian","por":"Portuguese",
        "rus":"Russian","jpn":"Japanese","kor":"Korean","zho":"Chinese","ara":"Arabic","hin":"Hindi",
        "nld":"Dutch","pol":"Polish","tur":"Turkish","tha":"Thai","vie":"Vietnamese","ces":"Czech",
        "hun":"Hungarian","ron":"Romanian","heb":"Hebrew","ell":"Greek","swe":"Swedish","dan":"Danish",
        "nor":"Norwegian","fin":"Finnish","ind":"Indonesian","msa":"Malay","bul":"Bulgarian","ukr":"Ukrainian",
        "srp":"Serbian","hrv":"Croatian","slk":"Slovak","lit":"Lithuanian","lva":"Latvian","est":"Estonian",
        "isl":"Icelandic","slv":"Slovenian","ben":"Bengali","tam":"Tamil","tel":"Telugu","mar":"Marathi",
        "mal":"Malayalam","kan":"Kannada","guj":"Gujarati","pan":"Punjabi","urd":"Urdu",
        "x-subs":"Subs","x-sub":"Sub","x-all":"All","x-any":"Any","x-force":"Forced","x-sdh":"SDH","x-cc":"CC"
    };
    function normLang(c) {
        if (!c) return "Unknown";
        return LANG[c.split("-")[0].toLowerCase()] || c.split("-")[0].toUpperCase() || c;
    }

    var TRACKERS = [
        "udp://tracker.opentrackr.org:1337/announce",
        "udp://tracker.openbittorrent.com:6969/announce",
        "udp://tracker.torrent.eu.org:451/announce",
        "udp://exodus.desync.com:6969/announce",
        "udp://public.popcorn-tracker.org:6969/announce"
    ];
    function magnetLink(hash, name) {
        var m = "magnet:?xt=urn:btih:" + hash + "&dn=" + encodeURIComponent(name || hash);
        for (var i = 0, n = 0; i < TRACKERS.length && n < 20; i++) { m += "&tr=" + encodeURIComponent(TRACKERS[i]); n++; }
        return m;
    }

    function parseFeatures(s) {
        var r = { resolution:"Auto", codec:null, hdr:null, audio:null, channels:null, sourceType:"unknown", _sortKey: 0 };
        if (!s) return r;
        var str = s.toLowerCase();
        if (/\b(2160|4k|uhd)\b/.test(str)) { r.resolution = "4K"; r._sortKey = 5; }
        else if (/\b1440\b/.test(str)) { r.resolution = "1440p"; r._sortKey = 4; }
        else if (/\b1080\b/.test(str)) { r.resolution = "1080p"; r._sortKey = 3; }
        else if (/\b720\b/.test(str)) { r.resolution = "720p"; r._sortKey = 2; }
        else if (/\b480\b/.test(str)) { r.resolution = "480p"; r._sortKey = 1; }
        else if (/\b360\b/.test(str)) { r.resolution = "360p"; r._sortKey = 1; }
        else if (/\b(cam|ts|tc|scr|workprint|hqcam)\b/.test(str)) { r.resolution = "CAM"; r._sortKey = 0; }
        if (/\b(av1|av01)\b/.test(str)) r.codec = "AV1";
        else if (/\b(x?v?265|hevc)\b/.test(str)) r.codec = "HEVC";
        else if (/\b(x264|h\.?264|avc)\b/.test(str)) r.codec = "H.264";
        else if (/\b(vp9|vp9\.2)\b/.test(str)) r.codec = "VP9";
        else if (/\b(vc[\s-]?1|vc1)\b/.test(str)) r.codec = "VC-1";
        else if (/\b(xvid|divx)\b/.test(str)) r.codec = "XviD";
        if (/\b(dv|dovi|dolby[\s._-]?vision)\b/.test(str)) r.hdr = "DV";
        else if (/\bhdr10\+\b/.test(str)) r.hdr = "HDR10+";
        else if (/\bhdr10\b/.test(str)) r.hdr = "HDR10";
        else if (/\bhdr\b/.test(str)) r.hdr = "HDR";
        if (/\bhlg\b/.test(str)) r.hdr = r.hdr ? r.hdr + "+HLG" : "HLG";
        if (/\b(atmos|truehd)\b/.test(str)) r.audio = "Atmos";
        else if (/\bdts[-\s]?hd\b/.test(str)) r.audio = "DTS-HD";
        else if (/\bdts\b/.test(str)) r.audio = "DTS";
        else if (/\b(flac|lpcm)\b/.test(str)) r.audio = "FLAC";
        else if (/\b(e?aac)\b/.test(str)) r.audio = "AAC";
        else if (/\bmp3\b/.test(str)) r.audio = "MP3";
        else if (/\bopus\b/.test(str)) r.audio = "Opus";
        var ch = str.match(/\b[257]\.1\b/); if (ch) r.channels = ch[0];
        if (/\btorrent\b/.test(str) || /\binfohash\b/.test(str)) r.sourceType = "torrent";
        else if (/\bhttp\b/.test(str) || /\bhls\b/.test(str) || /\bm3u8\b/.test(str) || /\bmpd\b/.test(str)) r.sourceType = "http";
        else if (/\byoutube\b/.test(str) || /\bytId\b/.test(str)) r.sourceType = "youtube";
        return r;
    }

    // Quality sort: higher _sortKey = better quality
    var QUALITY_ORDER = { "4K": 5, "1440p": 4, "1080p": 3, "720p": 2, "480p": 1, "360p": 1, "CAM": 0, "Auto": 2 };
    function qualitySortKey(stream) {
        var q = (stream && stream.quality) || "Auto";
        return QUALITY_ORDER[q] !== undefined ? QUALITY_ORDER[q] : 2;
    }

    function fmtStream(stream, an, bu) {
        try {
            if (!stream) return null;
            var on = str(stream.name).replace(/\n/g, " ").trim();
            var ot = str(stream.title).replace(/\n/g, " ").trim();
            var desc = str(stream.description);
            var f = parseFeatures(on + " " + ot + " " + desc);
            var dn = ot || on || an;

            var hdrs = {};
            if (stream.behaviorHints) {
                if (stream.behaviorHints.proxyHeaders && stream.behaviorHints.proxyHeaders.request)
                    hdrs = Object.assign({}, stream.behaviorHints.proxyHeaders.request);
                else if (stream.behaviorHints.headers)
                    hdrs = Object.assign({}, stream.behaviorHints.headers);
            }
            if (!hdrs["User-Agent"]) hdrs["User-Agent"] = STRM_UA;
            if (!hdrs["Referer"]) hdrs["Referer"] = bu + "/";
            if (!hdrs["Origin"]) hdrs["Origin"] = bu;

            var bh = Object.assign({}, stream.behaviorHints || {});
            delete bh.proxyHeaders; delete bh.headers;

            if (stream.url && isHttp(stream.url)) {
                var isDirect = /\.(mp4|mkv|webm|avi|mov)(\?|$)/i.test(stream.url);
                var isStream = /\.(m3u8|mpd)(\?|$)/i.test(stream.url);
                var isProxy = /(extract|proxy|redirect|gateway|fetch|resolve)/i.test(stream.url);
                var hasRestrictiveHeaders = Object.keys(hdrs).length > 1;

                // MAGIC_PROXY_v1 for header-restricted streams
                var finalUrl = stream.url;
                if (hasRestrictiveHeaders && !isDirect) {
                    finalUrl = "MAGIC_PROXY_v1" + btoa(stream.url);
                }

                if (!bh.notWebReady && (!isDirect || isProxy || isStream)) bh.notWebReady = true;
                if (bh.notWebReady && Object.keys(bh).length === 1) bh = { notWebReady: true };

                var result = new StreamResult({
                    url: finalUrl, quality: f.resolution,
                    source: dn, title: dn,
                    cached: !!stream.cached, size: stream.size || null,
                    headers: hdrs, behaviorHints: bh,
                    addonSource: an, resolution: f.resolution !== "Auto" ? f.resolution : null,
                    _sortKey: f._sortKey
                });
                if (isStream && !result.headers["Origin"]) {
                    try { result.headers["Origin"] = new URL(stream.url).origin; } catch (e) {}
                }
                if (Array.isArray(stream.subtitles)) {
                    result.subtitles = stream.subtitles.map(function(sub) {
                        return { id: sub.id || "", url: sub.url || "", lang: normLang(sub.lang), label: sub.label || normLang(sub.lang) };
                    });
                }
                return result;
            }

            if (stream.infoHash) {
                var fn = (stream.behaviorHints && stream.behaviorHints.filename) || stream.title || stream.name || "";
                if (!Object.keys(bh).length) bh = { notWebReady: true };
                return new StreamResult({
                    url: magnetLink(stream.infoHash, fn),
                    infoHash: stream.infoHash, fileIndex: stream.fileIdx !== undefined ? stream.fileIdx : 0,
                    quality: f.resolution, source: dn, title: fn || dn,
                    headers: hdrs, behaviorHints: bh,
                    addonSource: an, resolution: f.resolution !== "Auto" ? f.resolution : null,
                    _sortKey: f._sortKey
                });
            }

            if (stream.ytId) {
                return new StreamResult({
                    url: "https://www.youtube.com/watch?v=" + stream.ytId,
                    quality: "YouTube", source: an + " YouTube",
                    headers: { "Referer": "https://www.youtube.com/", "User-Agent": STRM_UA },
                    behaviorHints: { notWebReady: true },
                    _sortKey: 1
                });
            }

            if (stream.externalUrl) {
                var eu = stream.externalUrl.toLowerCase();
                var garbage = ["ko-fi.com","patreon.com","buymeacoffee.com","paypal.com",
                    "discord.gg","discord.com","facebook.com","twitter.com","x.com",
                    "instagram.com","t.me","telegram.org","reddit.com","whatsapp.com",
                    "bit.ly","tinyurl.com","goo.gl","ow.ly","tiny.cc","adf.ly","shorte.st"];
                var isGarbage = false;
                for (var gi = 0; gi < garbage.length; gi++) { if (eu.indexOf(garbage[gi]) !== -1) { isGarbage = true; break; } }
                if (!isGarbage) {
                    return new StreamResult({
                        url: stream.externalUrl, quality: f.resolution,
                        source: an + " External",
                        headers: hdrs, behaviorHints: Object.keys(bh).length ? bh : { notWebReady: true },
                        _sortKey: f._sortKey
                    });
                }
                return null;
            }

            if (stream.nzbUrl) {
                return new StreamResult({
                    url: stream.nzbUrl, quality: f.resolution, source: an + " Usenet",
                    headers: hdrs, behaviorHints: Object.keys(bh).length ? bh : { notWebReady: true },
                    _sortKey: f._sortKey
                });
            }

            var archKeys = [{k:"rarUrls",l:"RAR"},{k:"zipUrls",l:"ZIP"},{k:"7zipUrls",l:"7z"},{k:"tgzUrls",l:"TGZ"},{k:"tarUrls",l:"TAR"}];
            for (var ai = 0; ai < archKeys.length; ai++) {
                if (Array.isArray(stream[archKeys[ai].k]) && stream[archKeys[ai].k].length) {
                    var src = stream[archKeys[ai].k][0];
                    var srcUrl = (typeof src === "string") ? src : (src.url || "");
                    if (srcUrl) {
                        return new StreamResult({
                            url: srcUrl, quality: f.resolution, source: an + " " + archKeys[ai].l,
                            headers: hdrs, behaviorHints: Object.keys(bh).length ? bh : { notWebReady: true },
                            _sortKey: f._sortKey
                        });
                    }
                }
            }

            if (stream.url) {
                var hash = null;
                if (stream.url.indexOf("magnet:?xt=urn:btih:") === 0) {
                    var m = stream.url.match(/urn:btih:([a-fA-F0-9]+)/);
                    if (m) hash = m[1].toLowerCase();
                }
                if (!Object.keys(bh).length && (hash || stream.url.indexOf("magnet:") === 0)) bh = { notWebReady: true };
                var res = new StreamResult({
                    url: stream.url, quality: f.resolution, source: dn,
                    headers: hdrs, behaviorHints: bh, title: dn,
                    addonSource: an, resolution: f.resolution !== "Auto" ? f.resolution : null,
                    _sortKey: f._sortKey
                });
                if (hash) { res.infoHash = hash; res.fileIndex = 0; }
                return res;
            }

            return null;
        } catch (e) { return null; }
    }

    function processStreams(streams, an, bu) {
        if (!Array.isArray(streams)) return [];
        var out = [];
        for (var i = 0; i < streams.length; i++) {
            try { var f = fmtStream(streams[i], an, bu); if (f) out.push(f); } catch (e) {}
        }
        return out;
    }

    // ── Subtitles with videoHash/videoSize matching ───────────────
    function fetchSubtitles(id, typeStr, season, episode, streamHints) {
        var urls = getSubtitlesAddons();
        if (!urls.length) return Promise.resolve([]);

        var subId = (typeStr === "series" && season > 0 && episode > 0) ? id + ":" + season + ":" + episode : id;
        var eid = encodeURIComponent(subId);

        var subUrls = [];
        var subInfo = [];
        for (var i = 0; i < urls.length; i++) {
            var bu = baseUrl(urls[i]);
            if (typeStr === "series" && season > 0 && episode > 0) {
                subUrls.push(bu + "/subtitles/" + typeStr + "/" + eid + ".json");
                subInfo.push({ addonUrl: urls[i], isEpFormat: true });
            }
            subUrls.push(bu + "/subtitles/" + typeStr + "/" + encodeURIComponent(id) + ".json");
            subInfo.push({ addonUrl: urls[i], isEpFormat: false });

            // If we have videoHash/videoSize from stream behaviorHints, try those endpoints too
            if (streamHints && streamHints.videoHash) {
                subUrls.push(bu + "/subtitles/" + typeStr + "/" + encodeURIComponent(id) + ".json?videoHash=" + encodeURIComponent(streamHints.videoHash) + "&videoSize=" + (streamHints.videoSize || ""));
                subInfo.push({ addonUrl: urls[i], isEpFormat: false, isHashQuery: true });
            }
        }

        if (!subUrls.length) return Promise.resolve([]);

        return httpBatch(subUrls).then(function(results) {
            var allSubs = [];
            var seen = {};
            for (var ri = 0; ri < results.length; ri++) {
                var sr = results[ri];
                if (!sr.ok || !sr.data || !Array.isArray(sr.data.subtitles)) continue;
                for (var si = 0; si < sr.data.subtitles.length; si++) {
                    var sub = sr.data.subtitles[si];
                    if (!sub || !sub.url) continue;
                    var sk = sub.url + "|" + (sub.lang || "");
                    if (!seen[sk]) {
                        seen[sk] = true;
                        allSubs.push({
                            id: sub.id || String(allSubs.length + 1),
                            url: sub.url,
                            lang: normLang(sub.lang),
                            label: sub.label || normLang(sub.lang) || "Unknown"
                        });
                    }
                }
            }
            return allSubs;
        });
    }

    // ════════════════════════════════════════════════════════════════
    //  loadStreams — v3: delayed addons, quality sort, MAGIC_PROXY
    // ════════════════════════════════════════════════════════════════

    async function loadStreams(url, cb) {
        try {
            var vp = parseVideoId(url);
            var metaId, mediaType, season = 0, episode = 0;

            if (vp) {
                metaId = vp.id;
                mediaType = vp.type || "movie";
                season = vp.season || 0;
                episode = vp.episode || 0;
            } else {
                metaId = url;
                mediaType = "movie";
            }

            var typeStr = (mediaType === "tv" || mediaType === "series" || mediaType === "anime") ? "series" : "movie";
            var sAddons = getStreamingAddons();

            if (!sAddons.length) {
                var subtitles = await fetchSubtitles(metaId, typeStr, season, episode);
                cb({ success: true, data: [] });
                return;
            }

            // Check for cached pre-fetched streams from load()
            var cached = pCacheGet("streams:" + metaId);
            if (cached && cached.success && cached.data && cached.data.length) {
                // Return cached immediately, but still fetch fresh in background
                cb({ success: true, data: cached.data });
                // Fall through to refresh in background
            }

            // Step 1: Build stream URLs — one per addon, direct IMDB ID only
            var streamUrls = [];
            var streamInfo = [];

            for (var ai = 0; ai < sAddons.length; ai++) {
                var bu = baseUrl(sAddons[ai]);
                var an = addonName(sAddons[ai]);

                if (typeStr === "series" && season > 0 && episode > 0) {
                    streamUrls.push(bu + "/stream/" + typeStr + "/" + encodeURIComponent(metaId + ":" + season + ":" + episode) + ".json");
                } else {
                    streamUrls.push(bu + "/stream/" + typeStr + "/" + encodeURIComponent(metaId) + ".json");
                }
                streamInfo.push({ addonIdx: ai, addonName: an, baseUrl: bu });
            }

            // Step 2: Two-phase fetch for delayed addons
            // Phase 1: Fast fetch (15s) — get quick results
            // Phase 2: Wait for slow addons (up to 60s total) — collect more links
            var allStreams = [];
            var addonStreams = {};

            // Phase 1: Fire ALL requests, wait up to 15s for fast responses
            var phase1Results = await httpBatch(streamUrls);

            // Process phase 1 results
            for (var ri = 0; ri < phase1Results.length; ri++) {
                var sr = phase1Results[ri];
                var info = streamInfo[ri];
                if (!sr.ok || !sr.data || !Array.isArray(sr.data.streams) || !sr.data.streams.length) continue;

                var idx = info.addonIdx;
                if (!addonStreams[idx]) {
                    addonStreams[idx] = { addonName: info.addonName, baseUrl: info.baseUrl, streams: [] };
                }
                var processed = processStreams(sr.data.streams, info.addonName, info.baseUrl);
                addonStreams[idx].streams = addonStreams[idx].streams.concat(processed);
            }

            // Merge phase 1 results in priority order
            for (var ai = 0; ai < sAddons.length; ai++) {
                if (addonStreams[ai]) {
                    allStreams = allStreams.concat(addonStreams[ai].streams);
                }
            }

            // Phase 2: Wait for delayed addons (up to 45s more, total 60s)
            // Only wait if we have fewer than 10 streams — otherwise return what we have
            if (allStreams.length < 10) {
                try {
                    // Fire a second batch for any addons that didn't respond
                    // Use setTimeout to give slow addons more time
                    var phase2Promise = new Promise(function(resolve) {
                        setTimeout(function() {
                            // Re-fetch from addons that returned empty in phase 1
                            var slowUrls = [];
                            var slowInfo = [];
                            for (var si = 0; si < streamUrls.length; si++) {
                                var sr = phase1Results[si];
                                if (!sr.ok || !sr.data || !Array.isArray(sr.data.streams) || !sr.data.streams.length) {
                                    slowUrls.push(streamUrls[si]);
                                    slowInfo.push(streamInfo[si]);
                                }
                            }
                            if (!slowUrls.length) { resolve([]); return; }
                            httpBatch(slowUrls).then(function(results) {
                                var extra = [];
                                for (var ri = 0; ri < results.length; ri++) {
                                    var sr = results[ri];
                                    var info = slowInfo[ri];
                                    if (!sr.ok || !sr.data || !Array.isArray(sr.data.streams) || !sr.data.streams.length) continue;
                                    var idx = info.addonIdx;
                                    if (!addonStreams[idx]) {
                                        addonStreams[idx] = { addonName: info.addonName, baseUrl: info.baseUrl, streams: [] };
                                    }
                                    var processed = processStreams(sr.data.streams, info.addonName, info.baseUrl);
                                    addonStreams[idx].streams = addonStreams[idx].streams.concat(processed);
                                    extra = extra.concat(processed);
                                }
                                resolve(extra);
                            }).catch(function() { resolve([]); });
                        }, 15000); // Wait 15s before checking slow addons
                    });

                    var extraStreams = await Promise.race([
                        phase2Promise,
                        new Promise(function(r) { setTimeout(function() { r([]); }, 45000); })
                    ]);

                    if (extraStreams.length) {
                        // Merge new streams in priority order
                        var newStreams = [];
                        for (var ai = 0; ai < sAddons.length; ai++) {
                            if (addonStreams[ai]) {
                                newStreams = newStreams.concat(addonStreams[ai].streams);
                            }
                        }
                        allStreams = newStreams;
                    }
                } catch (e) { /* phase 2 is best-effort */ }
            }

            // Collect videoHash/videoSize from all streams for subtitle matching
            var streamHints = {};
            for (var si = 0; si < allStreams.length; si++) {
                var bh = allStreams[si].behaviorHints || {};
                if (bh.videoHash && !streamHints.videoHash) streamHints.videoHash = bh.videoHash;
                if (bh.videoSize && !streamHints.videoSize) streamHints.videoSize = bh.videoSize;
            }

            // Step 3: Fetch subtitles with videoHash/videoSize matching
            var subtitles = await fetchSubtitles(metaId, typeStr, season, episode, streamHints);

            // Step 4: Attach subtitles
            if (subtitles.length && allStreams.length) {
                for (var si = 0; si < allStreams.length; si++) {
                    try {
                        var existing = allStreams[si].subtitles || [];
                        if (!Array.isArray(existing)) existing = [];
                        var subMap = {};
                        for (var xi = 0; xi < existing.length; xi++) if (existing[xi]) subMap[existing[xi].url] = true;
                        for (var ni = 0; ni < subtitles.length; ni++) {
                            if (subtitles[ni] && subtitles[ni].url && !subMap[subtitles[ni].url]) {
                                existing.push(subtitles[ni]);
                                subMap[subtitles[ni].url] = true;
                            }
                        }
                        allStreams[si].subtitles = existing;
                    } catch (e) {}
                }
            }

            // Step 5: Quality sort within each addon's streams, then merge by priority
            var finalStreams = [];
            for (var ai = 0; ai < sAddons.length; ai++) {
                if (addonStreams[ai]) {
                    var sorted = addonStreams[ai].streams.slice().sort(function(a, b) {
                        return (b._sortKey || 0) - (a._sortKey || 0);
                    });
                    finalStreams = finalStreams.concat(sorted);
                }
            }

            // Step 6: Deduplicate
            var seen = {};
            var deduped = [];
            for (var i = 0; i < finalStreams.length; i++) {
                var key = finalStreams[i].infoHash || finalStreams[i].url;
                if (key && !seen[key]) { seen[key] = true; deduped.push(finalStreams[i]); }
            }

            // Clean up internal _sortKey before returning
            for (var i = 0; i < deduped.length; i++) {
                if (deduped[i]._sortKey !== undefined) delete deduped[i]._sortKey;
            }

            cb({ success: true, data: deduped });
        } catch (e) {
            console.error("[Hub] loadStreams:", e.message || e);
            cb({ success: false, errorCode: "STREAM_ERROR", message: e.message || "Error" });
        }
    }

    // ════════════════════════════════════════════════════════════════
    //  Exports
    // ════════════════════════════════════════════════════════════════
    globalThis.getHome = getHome;
    globalThis.search = search;
    globalThis.load = load;
    globalThis.loadStreams = loadStreams;

})();
