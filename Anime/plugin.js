(function() {
    "use strict";

    // ================================================================
    //  Stremio Hub — Fully Protocol-Compliant SkyStream Plugin
    //
    //  Implements Stremio Addon Protocol exactly as specified at:
    //    https://github.com/Stremio/stremio-addon-sdk
    //    https://github.com/Stremio/stremio-addon-client
    //
    //  Video ID conventions (per Stremio protocol):
    //    Movies:  videoID = metaID  (e.g. "tt1375666")
    //    Series:  videoID = metaID:season:episode  (e.g. "tt0944947:1:1")
    //    Channel: videoID = metaID:videoID  (e.g. "yt_id:UC...:video")
    //
    //  No hardcoded addon logic. Adapts to ANY configuration.
    // ================================================================

    // ── Constants ──────────────────────────────────────────────────
    var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";
    var JSON_HEADERS = { "User-Agent": UA, "Accept": "application/json", "Accept-Language": "en-US,en;q=0.5" };
    var ADDON_TIMEOUT = 30000;
    var CACHE_TTL = 600000;
    var _cache = {};

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

    // ── Cache ──────────────────────────────────────────────────────
    function cGet(k) { var c = _cache[k]; return (c && (Date.now() - c.ts) < CACHE_TTL) ? c.data : null; }
    function cSet(k, d) { _cache[k] = { ts: Date.now(), data: d }; }

    // ── HTTP ────────────────────────────────────────────────────────
    async function fetchJson(url, hdrs, followRedirect) {
        var h = Object.assign({}, JSON_HEADERS, hdrs || {});
        var r = await http_get(url, h);
        if (!r || !r.body) throw new Error("Empty response");
        // Follow redirect for 3xx responses — subtitles addons often redirect
        if (r.status >= 300 && r.status < 400 && followRedirect !== false) {
            var loc = r.location || (r.headers && (r.headers.location || r.headers.Location || r.headers.Location || ''));
            if (typeof r.body === 'string' && r.body.indexOf('Redirecting') !== -1) {
                var m = r.body.match(/https?:\/\/[^\s"']+/);
                if (m) loc = m[0];
            }
            if (loc) {
                var redirectUrl = typeof loc === 'string' ? loc : (loc.url || '');
                if (redirectUrl.indexOf('http') !== 0) {
                    try { var u = new URL(url); redirectUrl = u.origin + redirectUrl; } catch(e) {}
                }
                return fetchJson(redirectUrl, hdrs, false);
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
    }

    function fetchTimeout(url, hdrs, ms) {
        ms = ms || ADDON_TIMEOUT;
        return new Promise(function(res) {
            var done = false;
            var t = setTimeout(function() { if (!done) { done = true; res(null); } }, ms);
            fetchJson(url, hdrs).then(function(v) { if (!done) { done = true; clearTimeout(t); res(v); } }).catch(function() { if (!done) { done = true; clearTimeout(t); res(null); } });
        });
    }

    function getManifest(url) {
        var k = "mf:" + url;
        var c = cGet(k); if (c) return Promise.resolve(c);
        return fetchTimeout(url, null, 8000).then(function(d) { if (d) cSet(k, d); return d; });
    }

    // ════════════════════════════════════════════════════════════════
    //  ADDON ACCESSORS — read from manifest only, no fallbacks
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
    //  META PREVIEW (catalog item) → SkyStream MultimediaItem
    //  Per protocol: id*, type*, name*, poster are required
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
    //  getHome — Fetch ALL catalogs from ALL catalogueAddons
    //  Per protocol: GET /catalog/:type/:id.json → { metas: [...] }
    // ════════════════════════════════════════════════════════════════

    async function getHome(cb, page) {
        try {
            var pn = parseInt(page) || 1;
            var urls = getCatalogueAddons();
            if (!urls.length) return cb({ success: false, errorCode: "NO_ADDONS", message: "No catalogueAddons" });

            // Process ALL addons in parallel with a global deadline
            var DEADLINE = 25000;
            var results = { data: {}, order: [] };

            var addonPromises = urls.map(function(addonUrl, ai) {
                return (async function() {
                    try {
                        var mf = await getManifest(addonUrl);
                        if (!mf || !Array.isArray(mf.catalogs) || !mf.catalogs.length) return;
                        var bu = baseUrl(addonUrl);
                        var an = addonName(addonUrl);

                        // Fetch all catalogs for this addon in PARALLEL
                        var catPromises = [];
                        for (var ci = 0; ci < mf.catalogs.length; ci++) {
                            catPromises.push((function(cat) {
                                return (async function() {
                                    try {
                                        if (!cat || !cat.id || !cat.type) return null;
                                        var extras = cat.extra || [];
                                        if (extras.some(function(e) { return e && e.name === "search" && e.isRequired === true; })) return null;

                                        var url = bu + "/catalog/" + cat.type + "/" + cat.id + ".json";
                                        if (pn > 1) url += (url.indexOf("?") === -1 ? "?" : "&") + "skip=" + ((pn - 1) * 20);

                                        var d = await fetchTimeout(url, null, 5000);
                                        if (!d || !Array.isArray(d.metas) || !d.metas.length) return null;

                                        var items = d.metas.map(function(m) { return toItem(m, cat.type); }).filter(Boolean);
                                        if (!items.length) return null;

                                        return { name: (urls.length > 1) ? (an + " - " + (cat.name || cat.id)) : (cat.name || cat.id), items: items };
                                    } catch (e) { return null; }
                                })();
                            })(mf.catalogs[ci]));
                        }

                        var settled = await Promise.allSettled(catPromises);
                        for (var ri = 0; ri < settled.length; ri++) {
                            var r = settled[ri];
                            if (r.status === "fulfilled" && r.value && !results.data[r.value.name]) {
                                results.data[r.value.name] = r.value.items;
                                results.order.push(r.value.name);
                            }
                        }
                    } catch (e) { /* skip */ }
                })();
            });

            // Race against deadline
            var deadlinePromise = new Promise(function(r) { setTimeout(r, DEADLINE); });
            await Promise.race([Promise.allSettled(addonPromises), deadlinePromise]);

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
    //  search — Search across catalogueAddons
    //  Per protocol: GET /catalog/:type/:id/search=:query.json
    // ════════════════════════════════════════════════════════════════

    async function search(query, cb) {
        try {
            var q = str(query).trim().toLowerCase();
            if (!q) return cb({ success: true, data: [] });

            var all = [];
            var seen = {};
            function addItem(item) { if (item && item.url && !seen[item.url]) { seen[item.url] = true; all.push(item); } }



            // ── Normal text search across catalogue addons ──
            var urls = getCatalogueAddons();
            if (!urls.length) { if (all.length) return cb({ success: true, data: all }); else return cb({ success: true, data: [] }); }

            for (var ai = 0; ai < urls.length && all.length < 50; ai++) {
                try {
                    var mf = await getManifest(urls[ai]);
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

                    var foundSearch = false;
                    for (var si = 0; si < searchCats.length && all.length < 50; si++) {
                        try {
                            var sc = searchCats[si];
                            var surl = bu + "/catalog/" + sc.type + "/" + sc.id + "/search=" + encodeURIComponent(query) + ".json";
                            var d = await fetchTimeout(surl, null, 15000);
                            if (d && Array.isArray(d.metas) && d.metas.length) {
                                foundSearch = true;
                                for (var mi = 0; mi < d.metas.length && all.length < 50; mi++) addItem(toItem(d.metas[mi], sc.type));
                            }
                        } catch (e) { /* skip */ }
                    }

                    if (!foundSearch) {
                        for (var bi = 0; bi < browseCats.length && all.length < 50; bi++) {
                            try {
                                var bc = browseCats[bi];
                                var bUrl = bu + "/catalog/" + bc.type + "/" + bc.id + ".json";
                                var d2 = await fetchTimeout(bUrl, null, 10000);
                                if (d2 && Array.isArray(d2.metas)) {
                                    for (var mi = 0; mi < d2.metas.length && all.length < 50; mi++) {
                                        var m = d2.metas[mi];
                                        if (str(m.name || m.title || "").toLowerCase().indexOf(q) !== -1) addItem(toItem(m, bc.type));
                                    }
                                }
                            } catch (e) { /* skip */ }
                        }
                    }
                } catch (e) { /* skip */ }
            }
            cb({ success: true, data: all.slice(0, 50) });
        } catch (e) {
            console.error("[Hub] search:", e.message || e);
            cb({ success: true, data: [] });
        }
    }

    // ════════════════════════════════════════════════════════════════
    //  load — Load metadata from catalogueAddon meta endpoints
    //
    //  Per protocol:
    //    GET /meta/:type/:id.json → { meta: MetaDetail }
    //    Video ID for movies = meta ID  (e.g. "tt1375666")
    //    Video ID for series = metaID:season:episode  (e.g. "tt0944947:1:1")
    // ════════════════════════════════════════════════════════════════

    // Parse any Stremio video ID format:
    //   "tt1375666"                 → { id: "tt1375666", type: "movie" }
    //   "tt0944947:1:1"             → { id: "tt0944947", type: "series", season: 1, episode: 1 }
    //   {"i":"tt","t":"m","s":1,"e":1}  → { id: "tt", type: "m", season: 1, episode: 1 }
    function parseVideoId(raw) {
        if (!raw) return null;
        // Try JSON format first (our internal format)
        var p = safeJson(raw, null);
        if (p && p.i !== undefined) return { id: str(p.i), type: p.t || "movie", season: p.s || 0, episode: p.e || 0 };
        if (p && p.tmdbId !== undefined) return { id: str(p.tmdbId), type: p.mediaType || "movie", season: p.seasonNumber || 0, episode: p.episodeNumber || 0 };

        // Standard Stremio colon-separated format: "metaId:season:episode"
        if (raw.indexOf(":") !== -1) {
            // Check if it looks like "prefix:season:episode" - the first colon part is the ID
            var parts = raw.split(":");
            var first = parts[0];
            // If starts with "tt" it's an IMDb ID with season/episode
            if (/^tt\d+$/.test(first) && parts.length >= 3) {
                var sn = parseInt(parts[1], 10);
                var en = parseInt(parts[2], 10);
                return { id: first, type: "series", season: isNaN(sn) ? 0 : sn, episode: isNaN(en) ? 0 : en };
            }
            // If starts with a recognized prefix pattern (like "tmdb:", "yt_id:")
            if (first.indexOf("_") !== -1 || first.indexOf("-") !== -1) {
                return { id: raw, type: "series", season: 0, episode: 0 };
            }
        }

        // Raw ID (movie or unknown)
        return { id: raw, type: "movie", season: 0, episode: 0 };
    }

    function isImdbId(id) { return /^tt\d+$/.test(str(id)); }

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

            // Fire ALL meta requests in PARALLEL, collect ALL results, pick the BEST one
            // For series: prefer responses that have videos (episodes)
            // For movies: prefer responses with cast/description (richer metadata)
            var LOAD_DEADLINE = 25000;
            var allPromises = [];
            var results = [];
            var isSeries = (knownType === "series" || knownType === "anime" || knownType === "tv" || knownType === "channel");

            for (var ai = 0; ai < addonUrls.length; ai++) {
                for (var ti = 0; ti < tryTypes.length; ti++) {
                    (function(bu, tt, typeName) {
                        var p = fetchTimeout(bu + "/meta/" + tt + "/" + eid + ".json", null, 15000)
                        .then(function(d) {
                            if (!d) return;
                            var meta = d.meta || (Array.isArray(d.metas) ? d.metas[0] : null);
                            if (meta && meta.id) {
                                results.push({
                                    meta: meta,
                                    type: typeName,
                                    hasVideos: Array.isArray(meta.videos) && meta.videos.length > 0,
                                    hasCast: Array.isArray(meta.cast) && meta.cast.length > 0,
                                    hasDesc: !!(meta.description || meta.overview || "").trim().length
                                });
                            }
                        })
                        .catch(function() {});
                        allPromises.push(p);
                    })(baseUrl(addonUrls[ai]), tryTypes[ti], tryTypes[ti]);
                }
            }

            // Wait for all parallel meta requests to complete (60s max for huge series like One Piece)
            await new Promise(function(r) { setTimeout(r, 60000); });

            // Pick the BEST result by score (videos > cast > description)
            if (results.length) {
                results.sort(function(a, b) {
                    return (b.hasVideos ? 100 : 0) + (b.hasCast ? 10 : 0) + (b.hasDesc ? 1 : 0)
                         - ((a.hasVideos ? 100 : 0) + (a.hasCast ? 10 : 0) + (a.hasDesc ? 1 : 0));
                });
                return respondMeta(results[0].meta, metaId, cb);
            }

            respondMeta({ name: "Content", id: metaId, type: knownType || (isSeries ? "series" : "movie") }, metaId, cb);
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

            // ── Episodes ──
            // Per Stremio protocol:
            //   Movies:  videoID = metaID (no season/episode suffix)
            //   Series:  videoID = metaID:season:episode  (colon-separated)
            var eps = [];
            var isSeries = (st !== "movie");

            if (isSeries && Array.isArray(meta.videos) && meta.videos.length) {
                for (var vi = 0; vi < meta.videos.length; vi++) {
                    try {
                        var v = meta.videos[vi];
                        if (!v || !v.id) continue;
                        var sn = v.season || 1;
                        var en = v.episode || v.number || 1;
                        // Standard Stremio video ID format: metaID:season:episode
                        var vid = metaId + ":" + sn + ":" + en;
                        eps.push(new Episode({
                            name: v.name || v.title || "Episode " + en,
                            url: vid, season: sn, episode: en,
                            posterUrl: v.thumbnail || v.poster || meta.poster || "",
                            description: v.overview || v.description || "",
                            airDate: v.released || v.firstAired || ""
                        }));
                    } catch (e) { /* skip */ }
                }
            }

            if (!eps.length) {
                // Movies: raw ID. Series: ID:1:1 (fallback single episode)
                var vid = isSeries ? (metaId + ":1:1") : metaId;
                eps.push(new Episode({
                    name: st === "movie" ? "Full Movie" : "Watch",
                    url: vid, season: 1, episode: 1,
                    posterUrl: meta.poster || ""
                }));
            }

            // ── Cast (string[] per protocol) ──
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
                    } catch (e) { /* skip */ }
                }
                if (!cast.length) cast = undefined;
            }

            // ── Trailers ({ source, type } per protocol) ──
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
                    } catch (e) { /* skip */ }
                }
                if (!trailers.length) trailers = undefined;
            }

            // ── Director (can be null/string[]) ──
            var director = undefined;
            if (meta.director) {
                director = Array.isArray(meta.director) ? meta.director.filter(Boolean).join(", ") : str(meta.director);
                if (!director) director = undefined;
            }

            // ── Status mapping ──
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
    //  STREAM SYSTEM — Full Stremio Stream Object spec
    //
    //  Source types (one required): url, infoHash+fileIdx, ytId,
    //    externalUrl, nzbUrl+servers, rarUrls, zipUrls, 7zipUrls,
    //    tgzUrls, tarUrls
    //
    //  behaviorHints: notWebReady (true if not https or not MP4),
    //    bingeGroup, countryWhitelist, proxyHeaders, videoHash,
    //    videoSize, filename
    //
    //  Subtitles: attached from subtitlesAddons
    //    fields: id*, url*, lang*  (* required by protocol)
    // ════════════════════════════════════════════════════════════════

    var STRM_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";

    // ── Language Map ──────────────────────────────────────────────
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

    // ── Trackers ──────────────────────────────────────────────────
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

    // ── Stream Feature Parser ─────────────────────────────────────
    function parseFeatures(str) {
        var r = { resolution:"Auto", codec:null, hdr:null, audio:null, channels:null, sourceType:"unknown" };
        if (!str) return r;
        var s = str.toLowerCase();
        if (/\b(2160|4k|uhd)\b/.test(s)) r.resolution = "4K";
        else if (/\b1440\b/.test(s)) r.resolution = "1440p";
        else if (/\b1080\b/.test(s)) r.resolution = "1080p";
        else if (/\b720\b/.test(s)) r.resolution = "720p";
        else if (/\b480\b/.test(s)) r.resolution = "480p";
        else if (/\b360\b/.test(s)) r.resolution = "360p";
        if (/\b(av1|av01)\b/.test(s)) r.codec = "AV1";
        else if (/\b(x?v?265|hevc)\b/.test(s)) r.codec = "HEVC";
        else if (/\b(x264|h\.?264|avc)\b/.test(s)) r.codec = "H.264";
        else if (/\b(vp9|vp9\.2)\b/.test(s)) r.codec = "VP9";
        else if (/\b(vc[\s-]?1|vc1)\b/.test(s)) r.codec = "VC-1";
        else if (/\b(xvid|divx)\b/.test(s)) r.codec = "XviD";
        if (/\b(dv|dovi|dolby[\s._-]?vision)\b/.test(s)) r.hdr = "DV";
        else if (/\bhdr10\+\b/.test(s)) r.hdr = "HDR10+";
        else if (/\bhdr10\b/.test(s)) r.hdr = "HDR10";
        else if (/\bhdr\b/.test(s)) r.hdr = "HDR";
        if (/\bhlg\b/.test(s)) r.hdr = r.hdr ? r.hdr + "+HLG" : "HLG";
        if (/\b(atmos|truehd)\b/.test(s)) r.audio = "Atmos";
        else if (/\bdts[-\s]?hd\b/.test(s)) r.audio = "DTS-HD";
        else if (/\bdts\b/.test(s)) r.audio = "DTS";
        else if (/\b(flac|lpcm)\b/.test(s)) r.audio = "FLAC";
        else if (/\b(e?aac)\b/.test(s)) r.audio = "AAC";
        else if (/\bmp3\b/.test(s)) r.audio = "MP3";
        else if (/\bopus\b/.test(s)) r.audio = "Opus";
        var ch = s.match(/\b[257]\.1\b/); if (ch) r.channels = ch[0];
        if (/\btorrent\b/.test(s) || /\binfohash\b/.test(s)) r.sourceType = "torrent";
        else if (/\bhttp\b/.test(s) || /\bhls\b/.test(s) || /\bm3u8\b/.test(s) || /\bmpd\b/.test(s)) r.sourceType = "http";
        else if (/\byoutube\b/.test(s) || /\bytId\b/.test(s)) r.sourceType = "youtube";
        return r;
    }

    // ── Format a single Stream into StreamResult ──────────────────
    function fmtStream(stream, an, bu) {
        try {
            if (!stream) return null;
            var on = str(stream.name).replace(/\n/g, " ").trim();
            var ot = str(stream.title).replace(/\n/g, " ").trim();
            var desc = str(stream.description);
            var f = parseFeatures(on + " " + ot + " " + desc);
            var dn = ot || on || an;

            // Build headers
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

            // Preserve behaviorHints (for subtitle matching: videoHash, videoSize, filename)
            var bh = Object.assign({}, stream.behaviorHints || {});
            delete bh.proxyHeaders; delete bh.headers;

            // ── 1) HTTP(S) URL ──
            if (stream.url && isHttp(stream.url)) {
                // Per protocol: notWebReady=true if URL is not HTTPS or not MP4
                var isDirect = /\.(mp4|mkv|webm|avi|mov)(\?|$)/i.test(stream.url);
                var isStream = /\.(m3u8|mpd)(\?|$)/i.test(stream.url);
                var isProxy = /(extract|proxy|redirect|gateway|fetch|resolve)/i.test(stream.url);
                if (!bh.notWebReady && (!isDirect || isProxy || isStream)) bh.notWebReady = true;
                if (bh.notWebReady && Object.keys(bh).length === 1) bh = { notWebReady: true };

                var result = new StreamResult({
                    url: stream.url, quality: f.resolution,
                    source: dn, title: dn,
                    cached: !!stream.cached, size: stream.size || null,
                    headers: hdrs, behaviorHints: bh,
                    addonSource: an, resolution: f.resolution !== "Auto" ? f.resolution : null
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

            // ── 2) Torrent (infoHash) ──
            if (stream.infoHash) {
                var fn = (stream.behaviorHints && stream.behaviorHints.filename) || stream.title || stream.name || "";
                if (!Object.keys(bh).length) bh = { notWebReady: true };
                return new StreamResult({
                    url: magnetLink(stream.infoHash, fn),
                    infoHash: stream.infoHash, fileIndex: stream.fileIdx !== undefined ? stream.fileIdx : 0,
                    quality: f.resolution, source: dn, title: fn || dn,
                    headers: hdrs, behaviorHints: bh,
                    addonSource: an, resolution: f.resolution !== "Auto" ? f.resolution : null
                });
            }

            // ── 3) YouTube ──
            if (stream.ytId) {
                return new StreamResult({
                    url: "https://www.youtube.com/watch?v=" + stream.ytId,
                    quality: "YouTube", source: an + " YouTube",
                    headers: { "Referer": "https://www.youtube.com/", "User-Agent": STRM_UA },
                    behaviorHints: { notWebReady: true }
                });
            }

            // ── 4) External URL ──
            // Per protocol: opens in browser (e.g. Netflix link)
            // Filter out clearly non-content URLs (donation, social, tracking)
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
                        headers: hdrs, behaviorHints: Object.keys(bh).length ? bh : { notWebReady: true }
                    });
                }
                return null;
            }

            // ── 5) NZB (usenet) ──
            if (stream.nzbUrl) {
                return new StreamResult({
                    url: stream.nzbUrl, quality: f.resolution, source: an + " Usenet",
                    headers: hdrs, behaviorHints: Object.keys(bh).length ? bh : { notWebReady: true }
                });
            }

            // ── 6) Archive sources ──
            var archKeys = [{k:"rarUrls",l:"RAR"},{k:"zipUrls",l:"ZIP"},{k:"7zipUrls",l:"7z"},{k:"tgzUrls",l:"TGZ"},{k:"tarUrls",l:"TAR"}];
            for (var ai = 0; ai < archKeys.length; ai++) {
                if (Array.isArray(stream[archKeys[ai].k]) && stream[archKeys[ai].k].length) {
                    var src = stream[archKeys[ai].k][0];
                    var srcUrl = (typeof src === "string") ? src : (src.url || "");
                    if (srcUrl) {
                        return new StreamResult({
                            url: srcUrl, quality: f.resolution, source: an + " " + archKeys[ai].l,
                            headers: hdrs, behaviorHints: Object.keys(bh).length ? bh : { notWebReady: true }
                        });
                    }
                }
            }

            // ── 7) Fallback — return url as-is ──
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
                    addonSource: an, resolution: f.resolution !== "Auto" ? f.resolution : null
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
            try { var f = fmtStream(streams[i], an, bu); if (f) out.push(f); } catch (e) { /* skip */ }
        }
        return out;
    }

    // ── Subtitles ─────────────────────────────────────────────────
    // Per protocol:
    //   GET /subtitles/:type/:id.json
    //   Extra params: videoHash, videoSize, filename
    function fetchSubtitles(id, typeStr, season, episode) {
        var urls = getSubtitlesAddons();
        if (!urls.length) return Promise.resolve([]);

        var allSubs = [];
        var seen = {};

        // Build the subtitle request ID per protocol
        // Series episodes use: metaId:season:episode
        // Movies use: metaId
        var subId = (typeStr === "series" && season > 0 && episode > 0) ? id + ":" + season + ":" + episode : id;
        var eid = encodeURIComponent(subId);

        function queryOne(addonUrl) {
            try {
                var bu = baseUrl(addonUrl);
                // Try with episode format first, then plain
                var urlsToTry = [];
                if (typeStr === "series" && season > 0 && episode > 0) {
                    urlsToTry.push(bu + "/subtitles/" + typeStr + "/" + eid + ".json");
                }
                urlsToTry.push(bu + "/subtitles/" + typeStr + "/" + encodeURIComponent(id) + ".json");

                return urlsToTry.reduce(function(chain, surl) {
                    return chain.then(function() {
                        return fetchTimeout(surl, null, 10000).then(function(d) {
                            if (!d || !Array.isArray(d.subtitles)) return;
                            for (var si = 0; si < d.subtitles.length; si++) {
                                try {
                                    var sub = d.subtitles[si];
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
                                } catch (e) { /* skip */ }
                            }
                        });
                    });
                }, Promise.resolve());
            } catch (e) { return Promise.resolve(); }
        }

        return urls.reduce(function(chain, addonUrl) {
            return chain.then(function() { return queryOne(addonUrl); });
        }, Promise.resolve()).then(function() { return allSubs; });
    }

    // ════════════════════════════════════════════════════════════════
    //  loadStreams — Query streamingAddons ONLY
    //  PRIORITY: first addon in array = first streams in results
    //
    //  Per protocol:
    //    Movies:  GET /stream/:type/:metaId.json
    //    Series:  GET /stream/:type/:metaId:season:episode.json
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
            var allStreams = [];

            // ── 1) Fetch streams from ALL addons in PARALLEL ──
            var sAddons = getStreamingAddons();
            if (sAddons.length) {
                var tasks = [];
                for (var ai = 0; ai < sAddons.length; ai++) {
                    (function(addonUrl) {
                        tasks.push((async function() {
                            try {
                                var bu = baseUrl(addonUrl);
                                var an = addonName(addonUrl);
                                var urlsToTry = [];
                                var eid = encodeURIComponent(metaId);

                                if (typeStr === "series" && season > 0 && episode > 0) {
                                    urlsToTry.push(bu + "/stream/" + typeStr + "/" + encodeURIComponent(metaId + ":" + season + ":" + episode) + ".json");
                                }
                                urlsToTry.push(bu + "/stream/" + typeStr + "/" + eid + ".json");
                                if (isImdbId(metaId)) {
                                    urlsToTry.push(bu + "/stream/" + typeStr + "/" + encodeURIComponent("tmdb:" + metaId) + ".json");
                                }

                                for (var ui = 0; ui < urlsToTry.length; ui++) {
                                    var sd = await fetchTimeout(urlsToTry[ui], null, ADDON_TIMEOUT);
                                    if (sd && Array.isArray(sd.streams) && sd.streams.length) {
                                        return { addon: an, streams: processStreams(sd.streams, an, bu) };
                                    }
                                }
                                return null;
                            } catch (e) { return null; }
                        })());
                    })(sAddons[ai]);
                }

                var settled = await Promise.allSettled(tasks);
                for (var ri = 0; ri < settled.length; ri++) {
                    if (settled[ri].status === "fulfilled" && settled[ri].value) {
                        allStreams = allStreams.concat(settled[ri].value.streams);
                    }
                }
            }

            // ── 2) Fetch subtitles ──
            var subtitles = await fetchSubtitles(metaId, typeStr, season, episode);

            // ── 3) Attach subtitles to all streams ──
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
                    } catch (e) { /* skip */ }
                }
            }

            // ── 4) Deduplicate ──
            var seen = {};
            var deduped = [];
            for (var i = 0; i < allStreams.length; i++) {
                var key = allStreams[i].infoHash || allStreams[i].url;
                if (key && !seen[key]) { seen[key] = true; deduped.push(allStreams[i]); }
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
