(function() {
    // ============================================================
    // TMDB + STREMIO HYBRID PLUGIN v1
    //   getHome / search / load → TMDB Catalog (unchanged)
    //   loadStreams             → Stremio Addon Aggregator + Torrentio Fallback
    //   Stream Formatter        → Template-driven name + description
    // ============================================================

    "use strict";

    // ── TMDB Configuration ──────────────────────────────────────
    // Multiple keys to avoid rate limiting — edit these if they get stale
    const TMDB_KEYS = [
        "1865f43a0549ca50d341dd9ab8b29f49",
        "e554b5c1ac8837b4e6c6b7c9b7e4e8a0",
        "68e094699525b18a70bab2f86b1fa706",
        "98ae14df2b8d8f8f8136499daf79f0e0",
        "1f0f6e6f8e7b8c9d0e1f2a3b4c5d6e7f"
    ];
    var _keyIndex = 0;
    function nextKey() {
        var k = TMDB_KEYS[_keyIndex % TMDB_KEYS.length];
        _keyIndex++;
        return k;
    }

    // Multiple API endpoints for DNS rotation (speed & reliability)
    const TMDB_ENDPOINTS = [
        "https://api.themoviedb.org/3",
        "https://api.tmdb.org/3",
        "https://api.themoviedb.org/3"
    ];

    const IMG_URL = "https://image.tmdb.org/t/p";
    const POSTER = "w92";      // Absolute minimum quality (92px)
    const BACKDROP = "w300";   // Minimum backdrop (300px)
    const PROFILE = "w45";     // Minimum profile (45px)
    const STILL = "w92";       // Minimum still (92px)
    const ANIME_GENRE = 16;

    const MAX_PAGES = 2;         // Reduced for speed (was 5)
    const MAX_ITEMS = 100;
    const TMDB_CACHE_TTL = 300000; // 5 min cache for TMDB responses

    // Multi User-Agent rotation (avoids throttling)
    const USER_AGENTS = [
        // Windows Chrome
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
        // Windows Firefox
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0",
        // Windows Edge
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36 Edg/125.0.0.0",
        // Mac Chrome
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        // Mac Safari
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
        // Linux Chrome
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        // Linux Firefox
        "Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0",
        "Mozilla/5.0 (X11; Linux x86_64; rv:126.0) Gecko/20100101 Firefox/126.0",
        // iPhone Safari
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/537.36 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/537.36",
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/537.36 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/537.36",
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/537.36 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/537.36",
        // Android Chrome
        "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36",
        "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
        "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36",
        // Android Firefox
        "Mozilla/5.0 (Android 14; Mobile; rv:127.0) Gecko/127.0 Firefox/127.0",
        // iPad Safari
        "Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1"
    ];

    var _uaIndex = 0;
    var _epIndex = 0;

    function nextUA() {
        var ua = USER_AGENTS[_uaIndex % USER_AGENTS.length];
        _uaIndex++;
        return ua;
    }

    function nextEndpoint() {
        var ep = TMDB_ENDPOINTS[_epIndex % TMDB_ENDPOINTS.length];
        _epIndex++;
        return ep;
    }

    // ── TMDB Helpers ────────────────────────────────────────────
    function img(p, s) { return p ? IMG_URL + "/" + s + p : ""; }
    function poster(p) { return img(p, POSTER); }
    function backdrop(p) { return img(p, BACKDROP); }
    function profile(p) { return img(p, PROFILE); }
    function still(p) { return img(p, STILL); }

    function safeJson(t, f) {
        try { return JSON.parse(String(t || "{}")); } catch (e) { return f || null; }
    }

    function yr(d) {
        if (!d) return undefined;
        var y = parseInt(String(d).slice(0, 4), 10);
        return y > 0 ? y : undefined;
    }

    function pad(n) { return n < 10 ? "0" + n : String(n); }

    // ── TMDB Fetch with Cache + Retry + User-Agent + DNS Rotation ──
    var tmdbResponseCache = {};
    async function tmdb(path, params) {
        params = params || {};

        // Build cache key from path + params
        var cacheKey = path + "|" + JSON.stringify(params);
        var cached = tmdbResponseCache[cacheKey];
        if (cached && (Date.now() - cached.ts) < TMDB_CACHE_TTL) {
            return cached.data;
        }

        var maxRetries = 2; // reduced from 3 for speed
        var lastError = null;

        for (var attempt = 0; attempt < maxRetries; attempt++) {
            var endpoint = nextEndpoint();
            var ua = nextUA();

            var q = "api_key=" + nextKey();
            for (var k in params) {
                if (params.hasOwnProperty(k) && params[k] !== undefined && params[k] !== null) {
                    q += "&" + encodeURIComponent(k) + "=" + encodeURIComponent(String(params[k]));
                }
            }

            var headers = {
                "User-Agent": ua,
                "Accept": "application/json",
                "Accept-Language": "en-US,en;q=0.9",
                "Referer": "https://www.themoviedb.org/"
            };

            try {
                var url = endpoint + path + "?" + q;
                var res = await http_get(url, headers);
                if (res && res.status === 200 && res.body) {
                    var parsed = safeJson(res.body, null);
                    if (parsed) {
                        tmdbResponseCache[cacheKey] = { ts: Date.now(), data: parsed };
                        return parsed;
                    }
                }
                lastError = "Status: " + (res ? res.status : "no response");
            } catch (e) {
                lastError = e.message || e;
                console.warn("[TMDB] Attempt " + (attempt + 1) + " failed: " + lastError);
            }

            if (attempt < maxRetries - 1) {
                await sleep(300 * (attempt + 1));
            }
        }

        // Last resort: try another key
        try {
            var fallbackUrl = TMDB_ENDPOINTS[0] + path + "?api_key=" + nextKey();
            var qIdx = path.indexOf("?");
            if (qIdx === -1) {
                for (var k2 in params) {
                    if (params.hasOwnProperty(k2) && params[k2] !== undefined && params[k2] !== null) {
                        fallbackUrl += "&" + encodeURIComponent(k2) + "=" + encodeURIComponent(String(params[k2]));
                    }
                }
            }
            var res2 = await http_get(fallbackUrl, {
                "User-Agent": nextUA(),
                "Accept": "application/json"
            });
            if (res2 && res2.status === 200 && res2.body) {
                var parsed2 = safeJson(res2.body, null);
                if (parsed2) {
                    tmdbResponseCache[cacheKey] = { ts: Date.now(), data: parsed2 };
                    return parsed2;
                }
            }
        } catch (e) {}

        // Cache null result briefly to avoid retry storms
        tmdbResponseCache[cacheKey] = { ts: Date.now(), data: null };
        return null;
    }

    function sleep(ms) {
        return new Promise(function(resolve) {
            setTimeout(resolve, ms);
        });
    }

    // ── Multi-page fetch ────────────────────────────────────────
    async function fetchPages(endpoint, params, mediaType, maxItems) {
        maxItems = maxItems || MAX_ITEMS;
        var all = [];
        for (var p = 1; p <= MAX_PAGES; p++) {
            var data = await tmdb(endpoint, Object.assign({}, params, { page: p }));
            if (!data || !data.results || data.results.length === 0) break;
            all = all.concat(data.results);
            if (all.length >= maxItems) break;
        }
        return all.slice(0, maxItems).map(function(r) {
            return toItem(r, { mediaType: mediaType || r.media_type || "movie" });
        });
    }

    // ── Multi-page + post-filter ────────────────────────────────
    async function fetchFiltered(endpoint, params, filterFn, mediaType, maxItems) {
        maxItems = maxItems || 40;
        var all = [];
        for (var p = 1; p <= MAX_PAGES; p++) {
            var data = await tmdb(endpoint, Object.assign({}, params, { page: p }));
            if (!data || !data.results || data.results.length === 0) break;
            for (var i = 0; i < data.results.length; i++) {
                if (filterFn(data.results[i])) {
                    all.push(data.results[i]);
                    if (all.length >= maxItems) break;
                }
            }
            if (all.length >= maxItems) break;
        }
        return all.slice(0, maxItems).map(function(r) {
            return toItem(r, { mediaType: mediaType || "tv" });
        });
    }

    // ── Convert TMDB item to MultimediaItem ─────────────────────
    function toItem(item, opts) {
        opts = opts || {};
        var mt = opts.mediaType || item.media_type || "movie";
        var isTv = (mt === "tv");
        var title = item.title || item.name || item.original_title || item.original_name || "Unknown";
        var year = yr(item.release_date || item.first_air_date);
        var score = item.vote_average ? Number(Number(item.vote_average).toFixed(1)) : undefined;

        var meta = JSON.stringify({
            tmdbId: item.id,
            mediaType: mt,
            title: title,
            year: year,
            posterPath: item.poster_path,
            backdropPath: item.backdrop_path
        });

        return new MultimediaItem({
            title: title,
            url: meta,
            posterUrl: poster(item.poster_path),
            type: isTv ? "series" : "movie",
            year: year,
            score: score
        });
    }

    // ── Filter Functions ────────────────────────────────────────
    function isAnime(item) {
        if (!item.genre_ids || item.genre_ids.indexOf(ANIME_GENRE) === -1) return false;
        if (item.original_language === "ja") return true;
        if (item.origin_country && item.origin_country.indexOf("JP") !== -1) return true;
        return false;
    }

    function isWesternAnim(item) {
        if (!item.genre_ids || item.genre_ids.indexOf(ANIME_GENRE) === -1) return false;
        if (item.original_language === "ja") return false;
        if (item.origin_country && item.origin_country.indexOf("JP") !== -1) return false;
        return true;
    }

    function isKDrama(item) {
        return item.origin_country && item.origin_country.indexOf("KR") !== -1;
    }

    // ── Discover helpers ────────────────────────────────────────
    async function discoverTv(extra, maxItems) {
        maxItems = maxItems || MAX_ITEMS;
        var all = [];
        for (var p = 1; p <= MAX_PAGES; p++) {
            var data = await tmdb("/discover/tv", Object.assign({
                language: "en-US",
                sort_by: "popularity.desc",
                "vote_count.gte": 10
            }, extra, { page: p }));
            if (!data || !data.results || data.results.length === 0) break;
            all = all.concat(data.results);
            if (all.length >= maxItems) break;
        }
        return all.slice(0, maxItems).map(function(r) { return toItem(r, { mediaType: "tv" }); });
    }

    async function discoverMovie(extra, maxItems) {
        maxItems = maxItems || MAX_ITEMS;
        var all = [];
        for (var p = 1; p <= MAX_PAGES; p++) {
            var data = await tmdb("/discover/movie", Object.assign({
                language: "en-US",
                sort_by: "popularity.desc",
                "vote_count.gte": 10
            }, extra, { page: p }));
            if (!data || !data.results || data.results.length === 0) break;
            all = all.concat(data.results);
            if (all.length >= maxItems) break;
        }
        return all.slice(0, maxItems).map(function(r) { return toItem(r, { mediaType: "movie" }); });
    }

    // ============================================================
    //  getHome — batched TMDB calls with 20s deadline
    // ============================================================
    async function getHome(cb) {
        var HOME_DEADLINE = 20000; // 20s max
        try {
            var R = {};
            var lang = "en-US";
            var deadlineTimer = null;

            // Fire ALL TMDB requests in parallel
            var allPromises = [
                tmdb("/trending/all/day", { language: lang }).then(function(d) {
                    if (d && d.results) R["Trending"] = d.results.slice(0, 20).map(function(r) {
                        return toItem(r, { mediaType: r.media_type || "movie" });
                    });
                }),
                fetchPages("/movie/now_playing", { language: lang, region: "US" }, "movie", 40).then(function(x) { if (x.length) R["Airing Today – Movies"] = x; }),
                fetchPages("/tv/airing_today", { language: lang }, "tv", 40).then(function(x) { if (x.length) R["Airing Today – TV Series"] = x; }),
                fetchFiltered("/tv/airing_today", { language: lang }, isAnime, "tv", 30).then(function(x) { if (x.length) R["Airing Today – Anime"] = x; }),
                fetchFiltered("/tv/airing_today", { language: lang }, isKDrama, "tv", 30).then(function(x) { if (x.length) R["Airing Today – K-Drama"] = x; }),
                fetchPages("/trending/movie/day", { language: lang }, "movie", 40).then(function(x) { if (x.length) R["Trending Movies Today"] = x; }),
                fetchPages("/trending/tv/day", { language: lang }, "tv", 40).then(function(x) { if (x.length) R["Trending Series Today"] = x; }),
                fetchFiltered("/trending/tv/day", { language: lang }, isAnime, "tv", 30).then(function(x) { if (x.length) R["Trending Anime Today"] = x; }),
                fetchFiltered("/trending/tv/day", { language: lang }, isKDrama, "tv", 30).then(function(x) { if (x.length) R["Trending K-Drama Today"] = x; }),
                fetchPages("/trending/movie/week", { language: lang }, "movie", 40).then(function(x) { if (x.length) R["Trending Movies This Month"] = x; }),
                fetchPages("/trending/tv/week", { language: lang }, "tv", 40).then(function(x) { if (x.length) R["Trending Series This Month"] = x; }),
                fetchFiltered("/trending/tv/week", { language: lang }, isAnime, "tv", 30).then(function(x) { if (x.length) R["Trending Anime This Month"] = x; }),
                fetchFiltered("/trending/tv/week", { language: lang }, isKDrama, "tv", 30).then(function(x) { if (x.length) R["Trending K-Drama This Month"] = x; }),
                fetchPages("/movie/top_rated", { language: lang }, "movie", 40).then(function(x) { if (x.length) R["Top Rated Movies"] = x; }),
                fetchPages("/tv/top_rated", { language: lang }, "tv", 40).then(function(x) { if (x.length) R["Top Rated TV Shows"] = x; }),
                discoverTv({ with_genres: "16", with_original_language: "ja", sort_by: "vote_average.desc", "vote_count.gte": 100 }, 40).then(function(x) { if (x.length) R["Top Rated Anime"] = x; }),
                discoverMovie({ with_genres: "16", with_original_language: "ja", sort_by: "vote_average.desc", "vote_count.gte": 100 }, 40).then(function(x) { if (x.length) R["Top Rated Anime Movies"] = x; }),
                discoverTv({ with_origin_country: "KR", sort_by: "vote_average.desc", "vote_count.gte": 50 }, 40).then(function(x) { if (x.length) R["Top Rated K-Drama"] = x; }),
                discoverMovie({ with_original_language: "te", sort_by: "primary_release_date.desc", "vote_count.gte": 1 }, 100).then(function(x) { if (x.length) R["Latest Telugu Movies"] = x; }),
                discoverMovie({ with_original_language: "te", with_watch_providers: "8|9|122|113|115|2202", watch_region: "IN", sort_by: "primary_release_date.desc", "vote_count.gte": 1 }, 100).then(function(x) { if (x.length) R["Telugu Movies on OTT"] = x; }),
                fetchPages("/movie/popular", { language: lang }, "movie", 40).then(function(x) { if (x.length) R["Popular Movies"] = x; }),
                fetchPages("/tv/popular", { language: lang }, "tv", 40).then(function(x) { if (x.length) R["Popular Series"] = x; }),
                discoverTv({ with_genres: "16", with_original_language: "ja", sort_by: "popularity.desc" }, 40).then(function(x) { if (x.length) R["Popular Anime"] = x; }),
                discoverTv({ with_genres: "16", with_original_language: "en", sort_by: "popularity.desc" }, 40).then(function(x) { if (x.length) R["Popular Animation"] = x; }),
                fetchFiltered("/trending/tv/day", { language: lang }, isWesternAnim, "tv", 30).then(function(x) { if (x.length) R["Trending Animation Today"] = x; })
            ];

            // Race against deadline
            var deadlineP = new Promise(function(resolve) { deadlineTimer = setTimeout(resolve, HOME_DEADLINE); });
            await Promise.race([Promise.allSettled(allPromises), deadlineP]);
            clearTimeout(deadlineTimer);

            // Return whatever we got
            var clean = {};
            for (var cat in R) {
                if (R.hasOwnProperty(cat) && R[cat] && R[cat].length > 0) {
                    clean[cat] = R[cat];
                }
            }

            if (Object.keys(clean).length === 0) {
                cb({ success: false, errorCode: "NO_DATA", message: "No data received within deadline" });
            } else {
                cb({ success: true, data: clean });
            }
        } catch (e) {
            console.error("[TMDB] getHome:", e.message || e);
            cb({ success: false, errorCode: "HOME_ERROR", message: e.message || "Error" });
        }
    }

    // ============================================================
    //  search — UNCHANGED from tmdb-catalog
    // ============================================================
    async function search(query, cb) {
        try {
            if (!query || String(query).trim().length === 0) {
                return cb({ success: true, data: [] });
            }
            var data = await tmdb("/search/multi", {
                query: String(query).trim(),
                language: "en-US"
            });
            if (!data || !data.results) return cb({ success: true, data: [] });

            var results = [];
            for (var i = 0; i < data.results.length && results.length < 50; i++) {
                var item = data.results[i];
                if (item.media_type === "movie") {
                    results.push(toItem(item, { mediaType: "movie" }));
                } else if (item.media_type === "tv") {
                    results.push(toItem(item, { mediaType: "tv" }));
                } else if (item.media_type === "person") {
                    var known = item.known_for || [];
                    for (var k = 0; k < known.length && results.length < 50; k++) {
                        var kf = known[k];
                        if (kf.media_type === "movie" || kf.media_type === "tv") {
                            results.push(toItem(kf, { mediaType: kf.media_type }));
                        }
                    }
                }
            }

            var seen = {}, deduped = [];
            for (i = 0; i < results.length; i++) {
                if (!seen[results[i].url]) {
                    seen[results[i].url] = true;
                    deduped.push(results[i]);
                }
            }

            cb({ success: true, data: deduped.slice(0, 50) });
        } catch (e) {
            console.error("[TMDB] search:", e.message || e);
            cb({ success: true, data: [] });
        }
    }

    // ============================================================
    //  load — UNCHANGED from tmdb-catalog
    // ============================================================
    async function load(url, cb) {
        try {
            var meta = safeJson(url, null);
            if (!meta || !meta.tmdbId) {
                return cb({ success: false, errorCode: "PARSE_ERROR", message: "Invalid data" });
            }

            var tmdbId = meta.tmdbId;
            var mediaType = meta.mediaType || "movie";
            var isTv = (mediaType === "tv");
            var route = isTv ? "tv" : "movie";

            var details = await tmdb("/" + route + "/" + tmdbId, {
                language: "en-US",
                append_to_response: "credits,videos,external_ids,recommendations,content_ratings"
            });

            var title = (details ? (details.title || details.name) : null) || meta.title || "Unknown";
            var year = details ? yr(details.release_date || details.first_air_date) : meta.year;
            var overview = details ? (details.overview || "") : "";
            var voteAvg = details ? (details.vote_average ? Number(Number(details.vote_average).toFixed(1)) : undefined) : undefined;
            var imdbId = details && details.external_ids ? details.external_ids.imdb_id : undefined;
            var posterPath = details ? details.poster_path : meta.posterPath;
            var backdropPath = details ? details.backdrop_path : meta.backdropPath;

            var status = details ? String(details.status || "").toLowerCase() : undefined;
            if (status === "returning series") status = "ongoing";

            // Content rating
            var contentRating;
            if (details && details.content_ratings && details.content_ratings.results) {
                for (var c = 0; c < details.content_ratings.results.length; c++) {
                    if (details.content_ratings.results[c].iso_3166_1 === "US") {
                        contentRating = details.content_ratings.results[c].rating;
                        break;
                    }
                }
            }
            if (!contentRating && details && details.adult) contentRating = "18+";

            // Cast
            var cast = [];
            if (details && details.credits && details.credits.cast) {
                var cr = details.credits.cast;
                for (var i = 0; i < cr.length && i < 20; i++) {
                    if (cr[i].name || cr[i].original_name) {
                        cast.push(new Actor({
                            name: cr[i].name || cr[i].original_name || "",
                            role: cr[i].character || "",
                            image: cr[i].profile_path ? profile(cr[i].profile_path) : undefined
                        }));
                    }
                }
            }

            // Trailers
            var trailers = [];
            if (details && details.videos && details.videos.results) {
                var vids = details.videos.results;
                for (i = 0; i < vids.length && trailers.length < 3; i++) {
                    if (vids[i].site === "YouTube" && vids[i].type === "Trailer") {
                        trailers.push(new Trailer({
                            url: "https://www.youtube.com/watch?v=" + vids[i].key,
                            name: vids[i].name || "Trailer"
                        }));
                    }
                }
            }

            // Recommendations
            var recommendations = [];
            if (details && details.recommendations && details.recommendations.results) {
                var recs = details.recommendations.results;
                for (i = 0; i < recs.length && i < 20; i++) {
                    recommendations.push(toItem(recs[i], { mediaType: recs[i].media_type || mediaType }));
                }
            }

            // ── Episodes ──
            var episodes = [];

            if (isTv && details) {
                var seasonList = details.seasons || [];
                var fetched = 0;
                var maxSeasonsToFetch = 25;

                for (var si = 0; si < seasonList.length && fetched < maxSeasonsToFetch; si++) {
                    var seasonInfo = seasonList[si];
                    var seasonNum = seasonInfo.season_number;
                    if (seasonNum === 0 || !seasonInfo.episode_count || seasonInfo.episode_count === 0) continue;

                    try {
                        var seasonData = await tmdb("/tv/" + tmdbId + "/season/" + seasonNum, { language: "en-US" });
                        if (seasonData && seasonData.episodes) {
                            fetched++;
                            for (var e = 0; e < seasonData.episodes.length; e++) {
                                var ep = seasonData.episodes[e];
                                var epNum = ep.episode_number || (e + 1);
                                episodes.push(new Episode({
                                    name: "S" + pad(seasonNum) + "E" + pad(epNum) + " - " + (ep.name || ""),
                                    url: JSON.stringify({
                                        tmdbId: tmdbId,
                                        mediaType: "tv",
                                        seasonNumber: seasonNum,
                                        episodeNumber: epNum,
                                        title: title,
                                        episodeTitle: ep.name || "",
                                        stillPath: ep.still_path
                                    }),
                                    season: seasonNum,
                                    episode: epNum,
                                    rating: ep.vote_average ? Number(Number(ep.vote_average).toFixed(1)) : undefined,
                                    runtime: ep.runtime || undefined,
                                    airDate: ep.air_date || undefined,
                                    posterUrl: ep.still_path ? still(ep.still_path) : poster(posterPath)
                                }));
                            }
                        }
                    } catch (seasonErr) {
                        console.warn("[TMDB] Season " + seasonNum + " failed");
                    }
                }

                var nextAiring;
                if (details.next_episode_to_air && details.next_episode_to_air.air_date) {
                    nextAiring = new NextAiring({
                        episode: details.next_episode_to_air.episode_number || 0,
                        season: details.next_episode_to_air.season_number || 1,
                        unixTime: Math.floor(new Date(details.next_episode_to_air.air_date).getTime() / 1000)
                    });
                }
            }

            if (episodes.length === 0) {
                episodes.push(new Episode({
                    name: isTv ? (title + " - Start Watching") : title,
                    url: JSON.stringify({
                        tmdbId: tmdbId,
                        mediaType: mediaType,
                        title: title,
                        year: year,
                        posterPath: posterPath
                    }),
                    season: 1,
                    episode: 1,
                    posterUrl: poster(posterPath)
                }));
            }

            var item = new MultimediaItem({
                title: title,
                url: url,
                posterUrl: poster(posterPath),
                bannerUrl: backdrop(backdropPath),
                logoUrl: imdbId ? "https://live.metahub.space/logo/medium/" + imdbId + "/img" : undefined,
                description: overview || (details ? "" : "Synopsis not available. Tap play to stream."),
                type: isTv ? "series" : "movie",
                year: year,
                score: voteAvg,
                status: status,
                contentRating: contentRating,
                cast: cast,
                trailers: trailers,
                recommendations: recommendations,
                episodes: episodes,
                nextAiring: nextAiring,
                syncData: { tmdb: String(tmdbId), imdb: imdbId }
            });

            cb({ success: true, data: item });
        } catch (e) {
            console.error("[TMDB] load:", e.message || e);
            try {
                var m2 = safeJson(url, null);
                cb({ success: true, data: new MultimediaItem({
                    title: (m2 && m2.title) || "Unknown",
                    url: url,
                    type: (m2 && m2.mediaType === "tv") ? "series" : "movie",
                    episodes: [new Episode({
                        name: "Play",
                        url: url,
                        season: 1,
                        episode: 1
                    })]
                })});
            } catch (f) {
                cb({ success: false, errorCode: "LOAD_ERROR", message: e.message || "Failed" });
            }
        }
    }

    // ════════════════════════════════════════════════════════════
    //  SECTION 3: STREAM SYSTEM (from stremio plugin, adapted)
    // ════════════════════════════════════════════════════════════

    // ── 3a. Stream Configuration ──────────────────────────────
    var STREAM_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
    var STREAM_HEADERS = {
        "User-Agent": STREAM_USER_AGENT,
        "Accept": "application/json",
        "Accept-Language": "en-US,en;q=0.5"
    };
    var ADDON_TIMEOUT_MS = 30000;       // 30s per addon query
    var STREAM_CACHE_TTL = 600000;      // 10 min cache

    // ── 3b. Caches ────────────────────────────────────────────
    var streamResultCache = {};
    var tmdbIdCache = {};           // tmdbId → imdbId cache

    // ── 3c. Language Map (ISO 639 -> Display Name) ────────────
    var LANG_MAP = {
        "en": "English", "es": "Spanish", "fr": "French", "de": "German",
        "it": "Italian", "pt": "Portuguese", "ru": "Russian", "ja": "Japanese",
        "ko": "Korean", "zh": "Chinese", "ar": "Arabic", "hi": "Hindi",
        "nl": "Dutch", "pl": "Polish", "tr": "Turkish", "th": "Thai",
        "vi": "Vietnamese", "cs": "Czech", "hu": "Hungarian", "ro": "Romanian",
        "he": "Hebrew", "el": "Greek", "sv": "Swedish", "da": "Danish",
        "no": "Norwegian", "fi": "Finnish", "id": "Indonesian", "ms": "Malay",
        "bg": "Bulgarian", "uk": "Ukrainian", "sr": "Serbian", "hr": "Croatian",
        "sk": "Slovak", "lt": "Lithuanian", "lv": "Latvian", "et": "Estonian",
        "is": "Icelandic", "mt": "Maltese", "sl": "Slovenian", "km": "Khmer",
        "lo": "Lao", "bn": "Bengali", "ta": "Tamil", "te": "Telugu",
        "mr": "Marathi", "ml": "Malayalam", "kn": "Kannada", "gu": "Gujarati",
        "pa": "Punjabi", "ur": "Urdu",

        "eng": "English", "spa": "Spanish", "fra": "French", "fre": "French",
        "deu": "German", "ger": "German", "ita": "Italian", "por": "Portuguese",
        "rus": "Russian", "jpn": "Japanese", "kor": "Korean", "zho": "Chinese",
        "chi": "Chinese", "ara": "Arabic", "hin": "Hindi", "nld": "Dutch",
        "dut": "Dutch", "pol": "Polish", "tur": "Turkish", "tha": "Thai",
        "vie": "Vietnamese", "ces": "Czech", "cze": "Czech", "hun": "Hungarian",
        "ron": "Romanian", "rum": "Romanian", "heb": "Hebrew", "ell": "Greek",
        "gre": "Greek", "swe": "Swedish", "dan": "Danish", "nor": "Norwegian",
        "fin": "Finnish", "ind": "Indonesian", "msa": "Malay", "may": "Malay",
        "bul": "Bulgarian", "ukr": "Ukrainian", "srp": "Serbian", "hrv": "Croatian",
        "slk": "Slovak", "slo": "Slovak", "lit": "Lithuanian", "lva": "Latvian",
        "est": "Estonian", "isl": "Icelandic", "mlt": "Maltese", "slv": "Slovenian",
        "khm": "Khmer", "lao": "Lao", "ben": "Bengali", "tam": "Tamil",
        "tel": "Telugu", "mar": "Marathi", "mal": "Malayalam", "kan": "Kannada",
        "guj": "Gujarati", "pan": "Punjabi", "urd": "Urdu"
    };

    // ── 3d. Logging ───────────────────────────────────────────
    var DEBUG = true;
    function slog(level, msg, data) {
        if (level === "debug" && !DEBUG) return;
        var pfx = "[STRM] ";
        if (data !== undefined) console.log(pfx + msg, data);
        else console.log(pfx + msg);
    }

    // ── 3e. URL Helpers ───────────────────────────────────────
    function decodeStreamUrl(url) {
        try {
            var parsed = JSON.parse(url);

            // Format from source 1 (tmdb-catalog): { tmdbId, mediaType, seasonNumber, episodeNumber, title }
            if (parsed.tmdbId !== undefined) {
                return {
                    isTmdbFormat: true,
                    tmdbId: parsed.tmdbId,
                    mediaType: parsed.mediaType || "movie",
                    season: parsed.seasonNumber || 0,
                    episode: parsed.episodeNumber || 0,
                    title: parsed.title || "",
                    episodeTitle: parsed.episodeTitle || ""
                };
            }

            // Format from source 2 (stremio): { i, t, s, e }
            if (parsed.i !== undefined) {
                return {
                    isTmdbFormat: false,
                    imdbId: parsed.i,
                    mediaType: parsed.t,
                    season: parsed.s || 0,
                    episode: parsed.e || 0
                };
            }

            return null;
        } catch (e) {
            return null;
        }
    }

    function fixSourceUrl(url) {
        return (url || "")
            .replace(/\/manifest\.json$/, "")
            .replace(/\/$/, "")
            .replace(/^stremio:\/\//, "https://");
    }

    function isValidHttpUrl(str) {
        if (!str) return false;
        return str.indexOf("http://") === 0 || str.indexOf("https://") === 0;
    }

    // ── 3f. HTTP Helpers ──────────────────────────────────────
    async function fetchJson(url, headers) {
        var merged = Object.assign({}, STREAM_HEADERS, headers || {});
        var res = await http_get(url, merged);
        if (!res || !res.body) throw new Error("Empty response");
        if (res.status !== 200) throw new Error("HTTP " + res.status);
        var body = res.body;
        if (typeof body === "string" && body.trim().charAt(0) === "<") {
            throw new Error("HTML response");
        }
        if (typeof body === "object") return body;
        return JSON.parse(body);
    }

    async function fetchJsonSafe(url, headers) {
        try { return await fetchJson(url, headers); } catch (e) { return null; }
    }

    function fetchWithTimeout(url, headers, timeoutMs) {
        timeoutMs = timeoutMs || ADDON_TIMEOUT_MS;
        return new Promise(function(resolve) {
            var resolved = false;
            var timer = setTimeout(function() {
                if (!resolved) { resolved = true; resolve(null); }
            }, timeoutMs);
            fetchJsonSafe(url, headers).then(function(result) {
                if (!resolved) { resolved = true; clearTimeout(timer); resolve(result); }
            }).catch(function() {
                if (!resolved) { resolved = true; clearTimeout(timer); resolve(null); }
            });
        });
    }

    // ── 3h. Get Addon URLs (from manifest, fallback to defaults) ──
    function getStreamAddons() {
        // manifest is a global injected by the skystream runtime
        // access it directly (not via globalThis, which may not have it)
        var m = (typeof manifest !== 'undefined') ? manifest : null;
        if (!m && typeof globalThis !== 'undefined' && globalThis.manifest) {
            m = globalThis.manifest;
        }
        if (m) {
            if (m.streamAddons && Array.isArray(m.streamAddons)) return m.streamAddons;
            if (m.addons && Array.isArray(m.addons)) return m.addons;
        }
        return [];
    }

    function extractSourceName(addonUrl) {
        try {
            var hostname = addonUrl.replace(/https?:\/\//, "").split("/")[0].replace(/^www\./, "");
            var parts = hostname.split(".");
            if (parts.length >= 2) {
                var tlds = ["com", "org", "net", "io", "app", "dev", "tv", "co", "uk", "de", "xyz", "fun", "cloud", "me"];
                var best = parts[0];
                if (tlds.indexOf(best) !== -1 && parts.length > 1) best = parts[1];
                return best.charAt(0).toUpperCase() + best.slice(1);
            }
            return parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
        } catch (e) { return "Addon"; }
    }

    // ── 3h. Tracker Management ────────────────────────────────
    async function getTrackers() {
        var now = Date.now();
        if (trackersCache && (now - lastTrackersFetch) < TRACKER_CACHE_TTL) return trackersCache;

        var trackerSet = {};
        for (var ti = 0; ti < TRACKER_URLS.length; ti++) {
            try {
                var res = await http_get(TRACKER_URLS[ti], STREAM_HEADERS);
                if (res && res.body) {
                    var lines = res.body.split("\n");
                    for (var i = 0; i < lines.length; i++) {
                        var line = lines[i].trim();
                        if (line && line.indexOf("://") > 0 && line.indexOf("/announce") > 0) {
                            trackerSet[line] = true;
                        }
                    }
                }
            } catch (e) { slog("debug", "Failed to fetch trackers from " + TRACKER_URLS[ti]); }
        }

        var fallbacks = [
            "udp://tracker.opentrackr.org:1337/announce",
            "udp://tracker.openbittorrent.com:6969/announce",
            "udp://tracker.torrent.eu.org:451/announce",
            "udp://exodus.desync.com:6969/announce",
            "udp://public.popcorn-tracker.org:6969/announce"
        ];
        for (var fi = 0; fi < fallbacks.length; fi++) {
            if (!trackerSet[fallbacks[fi]]) trackerSet[fallbacks[fi]] = true;
        }

        trackersCache = Object.keys(trackerSet);
        lastTrackersFetch = now;
        slog("info", "Loaded " + trackersCache.length + " trackers");
        return trackersCache;
    }

    // ── 3i. Stream Feature Parsing ────────────────────────────
    function parseStreamFeatures(str) {
        var result = {
            resolution: "Auto", codec: null, hdr: null, audio: null,
            channels: null, is3D: false, isRemux: false, isWebdl: false,
            isBluray: false, debrid: null, isCached: false, sourceType: "unknown"
        };
        if (!str) return result;
        var s = String(str).toLowerCase();

        if (/\b(2160|4k|uhd)\b/.test(s)) result.resolution = "4K";
        else if (/\b1440\b/.test(s)) result.resolution = "1440p";
        else if (/\b1080\b/.test(s)) result.resolution = "1080p";
        else if (/\b720\b/.test(s)) result.resolution = "720p";
        else if (/\b480\b/.test(s)) result.resolution = "480p";
        else if (/\b360\b/.test(s)) result.resolution = "360p";

        if (/\b(av1|av01)\b/.test(s)) result.codec = "AV1";
        else if (/\b(x?v?265|hevc)\b/.test(s)) result.codec = "HEVC";
        else if (/\b(x264|h\.?264|avc)\b/.test(s)) result.codec = "H.264";
        else if (/\b(vp9|vp9\.2)\b/.test(s)) result.codec = "VP9";
        else if (/\b(vc[\s-]?1|vc1)\b/.test(s)) result.codec = "VC-1";
        else if (/\b(xvid|divx)\b/.test(s)) result.codec = "XviD";

        if (/\b(dv|dovi|dolby[\s._-]?vision)\b/.test(s)) result.hdr = "DV";
        else if (/\bhdr10\+\b/.test(s)) result.hdr = "HDR10+";
        else if (/\bhdr10\b/.test(s)) result.hdr = "HDR10";
        else if (/\bhdr\b/.test(s)) result.hdr = "HDR";
        if (/\bhlg\b/.test(s)) result.hdr = result.hdr ? result.hdr + "+HLG" : "HLG";

        if (/\b(atmos|truehd)\b/.test(s)) result.audio = "Atmos";
        else if (/\bdts[-\s]?hd\b/.test(s)) result.audio = "DTS-HD";
        else if (/\bdts\b/.test(s)) result.audio = "DTS";
        else if (/\b(flac|lpcm)\b/.test(s)) result.audio = "FLAC";
        else if (/\b(e?aac)\b/.test(s)) result.audio = "AAC";
        else if (/\bmp3\b/.test(s)) result.audio = "MP3";
        else if (/\bopus\b/.test(s)) result.audio = "Opus";

        var chMatch = s.match(/\b[257]\.1\b/);
        if (chMatch) result.channels = chMatch[0];

        if (/\bremux\b/.test(s)) result.isRemux = true;
        else if (/\b(web[\s.-]?dl|webrip|web)\b/.test(s)) result.isWebdl = true;
        else if (/\b(blu[\s.-]?ray|bdrip|brrip|bdr)\b/.test(s)) result.isBluray = true;

        if (/\b3d\b/.test(s) || /\b[hs]?sbs\b/.test(s) || /\btab\b/.test(s) || /\bover.?under\b/.test(s)) result.is3D = true;

        if (/\b\[?RD\]?\b/.test(s) || /\breal[-\s]?debrid\b/.test(s)) result.debrid = "RD";
        else if (/\b\[?AD\]?\b/.test(s) || /\ball[-\s]?debrid\b/.test(s)) result.debrid = "AD";
        else if (/\b\[?PM\]?\b/.test(s) || /\bpremiumize\b/.test(s)) result.debrid = "PM";
        else if (/\b\[?TB\]?\b/.test(s) || /\btorbox\b/.test(s)) result.debrid = "TB";
        else if (/\b\[?ED\]?\b/.test(s) || /\beasynews\b/.test(s)) result.debrid = "EN";

        if (/\btorrent\b/.test(s) || /\binfohash\b/.test(s)) result.sourceType = "torrent";
        else if (/\busenet\b/.test(s) || /\bnzb\b/.test(s)) result.sourceType = "usenet";
        else if (/\bhttp\b/.test(s) || /\bhls\b/.test(s) || /\bm3u8\b/.test(s) || /\bmpd\b/.test(s)) result.sourceType = "http";
        else if (/\byoutube\b/.test(s) || /\bytId\b/.test(s)) result.sourceType = "youtube";

        return result;
    }

    // ── 3k. Stream Formatter (Template Engine) ────────────────

    /**
     * Format a single stream from an addon into a StreamResult with
     * polished display name ("source") and technical description.
     *
     * Title format:  {Addon} ⚡️ {Quality} 🎞️ {Codec} 🎨 {HDR} 🔊 {Audio} 📦 {Size}
     * Description:   Detailed multiline spec
     */
    function formatStream(stream, addonName, baseUrl, trackers) {
        // Use the ORIGINAL stream name as-is from the addon
        // stream.name = short label (e.g. "Torrentio\n4k HDR")
        // stream.title = detailed filename (e.g. "Fight.Club.1999.2160p... 👤 129 💾 36.6 GB")
        var originalName = stream.name ? stream.name.replace(/\n/g, " ").trim() : "";
        var originalTitle = stream.title ? stream.title.replace(/\n/g, " ").trim() : "";
        var featureText = originalName + " " + originalTitle + " " + (stream.description || "");
        var features = parseStreamFeatures(featureText);

        // Use the addon's own title (detailed) if available, otherwise fall back to name
        var displayName = originalTitle || originalName || addonName;

        // ── Build StreamResult ──
        // Handle headers: start with addon's behaviorHints, add defaults only if missing
        var responseHeaders = {};
        if (stream.behaviorHints) {
            if (stream.behaviorHints.proxyHeaders && stream.behaviorHints.proxyHeaders.request) {
                responseHeaders = Object.assign({}, stream.behaviorHints.proxyHeaders.request);
            } else if (stream.behaviorHints.headers) {
                responseHeaders = Object.assign({}, stream.behaviorHints.headers);
            }
        }
        if (!responseHeaders["User-Agent"]) responseHeaders["User-Agent"] = STREAM_USER_AGENT;
        if (!responseHeaders["Referer"]) responseHeaders["Referer"] = baseUrl + "/";
        if (!responseHeaders["Origin"]) responseHeaders["Origin"] = baseUrl;

        // Extract resolution from stream name/title/url
        var resolution = features.resolution !== "Auto" ? features.resolution : null;

        var result = {
            url: null,
            quality: features.resolution,
            source: displayName,
            title: displayName,
            cached: stream.cached || false,
            size: stream.size || null,
            headers: responseHeaders,
            behaviorHints: stream.behaviorHints || {},
            addonSource: addonName,
            resolution: resolution
        };

        // --- 1) DIRECT HTTP(S) URL ---
        if (stream.url && isValidHttpUrl(stream.url)) {
            result.url = stream.url;
            // Add Origin for HLS/DASH streams if not already set
            if (stream.url.indexOf(".m3u8") !== -1 || stream.url.indexOf(".mpd") !== -1) {
                if (!result.headers["Origin"]) {
                    try { var u = new URL(stream.url); result.headers["Origin"] = u.protocol + "//" + u.hostname; } catch (e) {}
                }
            }
            // Subtitles for direct streams
            if (stream.subtitles && Array.isArray(stream.subtitles) && stream.subtitles.length > 0) {
                result.subtitles = stream.subtitles.map(function(sub) {
                    return { url: sub.url, lang: normalizeLang(sub.lang), label: normalizeLang(sub.lang) };
                });
            }
            return new StreamResult(result);
        }

        // --- 2) TORRENT (infoHash) ---
        if (stream.infoHash) {
            var filename = "";
            if (stream.behaviorHints && stream.behaviorHints.filename) filename = stream.behaviorHints.filename;
            else if (stream.title) filename = stream.title;
            else if (stream.name) filename = stream.name;
            result.url = "torrent:" + stream.infoHash + ":" + (stream.fileIdx || 0);
            result.infoHash = stream.infoHash;
            result.fileIndex = stream.fileIdx || 0;
            result.source = addonName;
            result.title = filename;
            if (!result.behaviorHints || Object.keys(result.behaviorHints).length === 0) {
                result.behaviorHints = { notWebReady: true };
            }
            // Attach trackers as sources so the runtime can use them
            if (trackers && trackers.length > 0) {
                result.sources = trackers.slice(0, 20).map(function(t) { return "tracker:" + t; });
            }
            return new StreamResult(result);
        }

        // --- 3) YOUTUBE ---
        if (stream.ytId) {
            result.url = "https://www.youtube.com/watch?v=" + stream.ytId;
            result.quality = "YouTube";
            result.source = addonName + " ▶️ YouTube";
            result.headers = { "Referer": "https://www.youtube.com/", "User-Agent": STREAM_USER_AGENT };
            result.behaviorHints = { notWebReady: true };
            return new StreamResult(result);
        }

        // --- 4) EXTERNAL URL ---
        if (stream.externalUrl) {
            result.url = stream.externalUrl;
            result.source = addonName + " External";
            result.behaviorHints = { notWebReady: true };
            return new StreamResult(result);
        }

        // --- 5) FALLBACK (url present but not http) ---
        if (stream.url) {
            result.url = stream.url;
            var fbHash = null;
            if (stream.url.indexOf("magnet:?xt=urn:btih:") === 0) {
                var match = stream.url.match(/urn:btih:([a-fA-F0-9]+)/);
                if (match) fbHash = match[1].toLowerCase();
            }
            if (fbHash) {
                result.infoHash = fbHash;
                result.fileIndex = stream.fileIdx !== undefined ? stream.fileIdx : 0;
            }
            return new StreamResult(result);
        }

        return null;
    }

    function formatBytes(bytes) {
        if (!bytes || bytes <= 0) return "N/A";
        var units = ["B", "KB", "MB", "GB", "TB"];
        var i = 0;
        var size = bytes;
        while (size >= 1024 && i < units.length - 1) { size /= 1024; i++; }
        return size.toFixed(1) + " " + units[i];
    }

    function normalizeLang(code) {
        if (!code) return "Unknown";
        var key = code.split("-")[0].toLowerCase();
        return LANG_MAP[key] || key.toUpperCase() || code;
    }

    // ── 3k. Process Raw Streams from Addon ────────────────────
    async function processStreamResponse(streams, addonName, baseUrl) {
        if (!streams || !Array.isArray(streams)) return [];
        var results = [];
        for (var s = 0; s < streams.length; s++) {
            try {
                var formatted = formatStream(streams[s], addonName, baseUrl);
                if (formatted) results.push(formatted);
            } catch (e) {}
        }
        return results;
    }

    // ── 3l. Subtitle Fetching (OpenSubtitles) ─────────────────
    async function fetchSubtitles(imdbId, season, episode) {
        if (!imdbId || imdbId.indexOf("tt") !== 0) return [];
        try {
            var slug = (season > 0)
                ? "series/" + imdbId + ":" + season + ":" + episode
                : "movie/" + imdbId;
            var url = "https://opensubtitles-v3.strem.io/subtitles/" + slug + ".json";
            var data = await fetchWithTimeout(url, STREAM_HEADERS, 15000);
            if (data && data.subtitles) {
                return data.subtitles.map(function(sub) {
                    return { url: sub.url, lang: normalizeLang(sub.lang), label: normalizeLang(sub.lang) };
                }).filter(function(s) { return s.url && s.lang; });
            }
        } catch (e) { slog("debug", "Subtitle fetch failed", e.message); }
        return [];
    }

    // ── 3m. TMDB ID → IMDb ID resolution (cached) ─────────────
    var TMDBID_CACHE_TTL = 86400000; // 24h cache for ID lookups
    async function tmdbIdToImdb(tmdbId, mediaType) {
        var cacheKey = tmdbId + "|" + (mediaType || "");
        var cached = tmdbIdCache[cacheKey];
        if (cached && (Date.now() - cached.ts) < TMDBID_CACHE_TTL) {
            return cached.imdbId;
        }
        try {
            var route = (mediaType === "tv" || mediaType === "series") ? "tv" : "movie";
            var data = await tmdb("/" + route + "/" + tmdbId + "/external_ids");
            var imdbId = (data && data.imdb_id) ? data.imdb_id : null;
            tmdbIdCache[cacheKey] = { ts: Date.now(), imdbId: imdbId };
            return imdbId;
        } catch (e) {
            tmdbIdCache[cacheKey] = { ts: Date.now(), imdbId: null };
            return null;
        }
    }

    // ── 3o. Torrentio Fallback — only if user has Torrentio in their addons ──
    function findTorrentioBaseUrl() {
        var addons = getStreamAddons();
        for (var i = 0; i < addons.length; i++) {
            if (addons[i].indexOf("torrentio") !== -1) {
                return fixSourceUrl(addons[i]);
            }
        }
        return null; // not configured, no fallback
    }
    async function tryTorrentioFallback(id, type, season, episode) {
        var baseUrl = findTorrentioBaseUrl();
        if (!baseUrl) return []; // user removed Torrentio, skip
        try {
            var encodedId = encodeURIComponent(id);
            var url = baseUrl + "/stream/" + type + "/" + encodedId;
            if (season > 0 && episode > 0) url += ":" + season + ":" + episode;
            url += ".json";
            var data = await fetchWithTimeout(url, STREAM_HEADERS, ADDON_TIMEOUT_MS);
            if (data && data.streams) return await processStreamResponse(data.streams, "Torrentio", baseUrl);
        } catch (e) { slog("warn", "Torrentio fallback failed", e.message); }
        return [];
    }

    // ── 3p. Get streams from a single addon ──
    function getRandomUA() {
        return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
    }
    async function queryAddon(addonManifestUrl, type, id, season, episode) {
        try {
            var baseUrl = fixSourceUrl(addonManifestUrl);
            var addonName = extractSourceName(addonManifestUrl);
            var encodedId = encodeURIComponent(id);
            var ua = getRandomUA();

            // Request headers: Origin + Referer are needed by some CDNs
            // NO Accept-Encoding — runtime can't decompress gzip
            var reqHeaders = {
                "User-Agent": ua,
                "Accept": "application/json",
                "Accept-Language": "en-US,en;q=0.9",
                "Referer": baseUrl + "/",
                "Origin": baseUrl
            };

            // Try URL patterns (single attempt)
            var urlsToTry = [
                baseUrl + "/stream/" + type + "/" + encodedId + ".json"
            ];
            if (season > 0 && episode > 0) {
                urlsToTry.push(baseUrl + "/stream/" + type + "/" + encodedId + ":" + season + ":" + episode + ".json");
                urlsToTry.push(baseUrl + "/stream/" + type + "/" + encodedId + ".json?season=" + season + "&episode=" + episode);
            }

            for (var ui = 0; ui < urlsToTry.length; ui++) {
                var streamData = await fetchWithTimeout(urlsToTry[ui], reqHeaders, ADDON_TIMEOUT_MS);
                if (streamData && streamData.streams && streamData.streams.length > 0) {
                    slog("debug", addonName + " returned " + streamData.streams.length + " streams");
                    return await processStreamResponse(streamData.streams, addonName, baseUrl);
                }
            }
            return [];
        } catch (e) {
            return [];
        }
    }

    // ============================================================
    //  loadStreams — THE MAIN EVENT
    //  Handles BOTH URL formats:
    //    Format A (tmdb-catalog): { tmdbId, mediaType, seasonNumber, episodeNumber }
    //    Format B (stremio):      { i, t, s, e }
    // ============================================================
    async function loadStreams(url, cb) {
        try {
            var decoded = decodeStreamUrl(url);
            if (!decoded) {
                // If URL is not JSON, treat as direct link
                return cb({ success: true, data: [new StreamResult({
                    url: url,
                    quality: "Auto",
                    source: "Direct Link",
                    headers: STREAM_HEADERS
                })] });
            }

            var type, season, episode;
            var imdbId = null;

            // Build a list of IDs to try
            var idsToTry = [];

            if (decoded.isTmdbFormat) {
                type = (decoded.mediaType === "tv") ? "series" : "movie";
                season = decoded.season;
                episode = decoded.episode;

                // Always try tmdb: prefix first
                idsToTry.push("tmdb:" + decoded.tmdbId);

                // Try to resolve IMDb ID (cached)
                imdbId = await tmdbIdToImdb(decoded.tmdbId, decoded.mediaType);
                if (imdbId && idsToTry.indexOf(imdbId) === -1) {
                    idsToTry.push(imdbId);
                }
            } else {
                type = decoded.mediaType || "movie";
                season = decoded.season;
                episode = decoded.episode;
                imdbId = decoded.imdbId;
                idsToTry.push(imdbId);
            }

            // Stable cache key: use tmdbId if available, otherwise imdbId
            var cacheKey = (decoded.isTmdbFormat ? "tmdb:" + decoded.tmdbId : idsToTry[0])
                + ":" + type + ":" + season + ":" + episode;

            // Check cache
            var cached = streamResultCache[cacheKey];
            if (cached && (Date.now() - cached.ts) < STREAM_CACHE_TTL) {
                slog("debug", "Cache hit for " + cacheKey);
                return cb({ success: true, data: cached.data });
            }

            var startTime = Date.now();
            var addonUrls = getStreamAddons();

            // ── Kick off subtitle fetch in parallel ──
            var subtitlePromise = (imdbId && imdbId.indexOf("tt") === 0)
                ? (season > 0 ? fetchSubtitles(imdbId, season, episode) : fetchSubtitles(imdbId, 0, 0))
                : Promise.resolve([]);

            // ── Query ALL addons in parallel (no limit) ──
            var allStreams = [];

            if (addonUrls.length > 0) {
                slog("info", "Querying " + addonUrls.length + " addons with IDs: " + idsToTry.join(", "));
                var tasks = addonUrls.map(function(addonUrl, addonIdx) {
                    return idsToTry.map(function(tryId) {
                        return queryAddon(addonUrl, type, tryId, season, episode).then(function(streams) {
                            if (streams && streams.length > 0) {
                                streams.forEach(function(s) { s._priority = addonIdx; });
                                return streams;
                            }
                            return [];
                        });
                    });
                });
                // Flatten nested arrays
                var flat = [];
                tasks.forEach(function(t) { flat = flat.concat(t); });
                var results = await Promise.allSettled(flat);
                results.forEach(function(r) {
                    if (r.status === "fulfilled" && r.value && r.value.length > 0) {
                        allStreams = allStreams.concat(r.value);
                    }
                });
            }

            // ── Torrentio fallback if no streams (quick, single attempt) ──
            if (allStreams.length === 0) {
                slog("info", "No addon streams, trying Torrentio fallback");
                for (var fi = 0; fi < idsToTry.length; fi++) {
                    var fb = await tryTorrentioFallback(idsToTry[fi], type, season, episode);
                    if (fb.length > 0) {
                        allStreams = fb;
                        break;
                    }
                }
            }

            // ── Robust deduplication ──
            var seen = {};
            allStreams = allStreams.filter(function(s) {
                // Generate a stable dedup key
                var key = "";
                if (s.infoHash) key = "ih:" + s.infoHash.toLowerCase();
                else if (s.url) {
                    var u = s.url.toLowerCase();
                    // Extract infoHash from magnet URL
                    var m = u.match(/urn:btih:([a-f0-9]+)/);
                    if (m) key = "ih:" + m[1];
                    else key = "url:" + u;
                }
                if (!key) return true;
                if (seen[key]) return false;
                seen[key] = true;
                return true;
            });

            // ── Sort: quality first, then addon priority within same quality ──
            var qOrder = { "4K": 0, "2160p": 0, "1440p": 1, "1080p": 2, "720p": 3, "480p": 4, "360p": 5, "YouTube": 6, "Auto": 7 };
            allStreams.sort(function(a, b) {
                var qa = qOrder[a.quality] !== undefined ? qOrder[a.quality] : 7;
                var qb = qOrder[b.quality] !== undefined ? qOrder[b.quality] : 7;
                if (qa !== qb) return qa - qb; // higher quality first
                // Same quality: higher priority addon first
                var pa = a._priority !== undefined ? a._priority : 999;
                var pb = b._priority !== undefined ? b._priority : 999;
                if (pa !== pb) return pa - pb;
                if (a.cached && !b.cached) return -1;
                if (!a.cached && b.cached) return 1;
                return 0;
            });
            // Strip internal priority tags before returning
            allStreams.forEach(function(s) { delete s._priority; });

            var elapsed = Date.now() - startTime;
            slog("info", "Found " + allStreams.length + " unique streams for " + idsToTry[0] + " in " + elapsed + "ms");

            // ── Attach external subtitles ──
            var externalSubs = await subtitlePromise;
            if (externalSubs && externalSubs.length > 0 && allStreams.length > 0) {
                for (var si = 0; si < allStreams.length; si++) {
                    var st = allStreams[si];
                    if (!st.subtitles || st.subtitles.length === 0) {
                        st.subtitles = externalSubs;
                    } else {
                        var existingUrls = {};
                        for (var ei = 0; ei < st.subtitles.length; ei++) {
                            if (st.subtitles[ei].url) existingUrls[st.subtitles[ei].url] = true;
                        }
                        for (var si2 = 0; si2 < externalSubs.length; si2++) {
                            if (!existingUrls[externalSubs[si2].url]) {
                                st.subtitles.push(externalSubs[si2]);
                            }
                        }
                    }
                }
            }

            // ── Cache ──
            streamResultCache[cacheKey] = { ts: Date.now(), data: allStreams };
            var keys = Object.keys(streamResultCache);
            if (keys.length > 100) {
                var sorted = keys.sort(function(a, b) { return streamResultCache[a].ts - streamResultCache[b].ts; });
                for (var i = 0; i < sorted.length - 100; i++) delete streamResultCache[sorted[i]];
            }

            cb({ success: true, data: allStreams });
        } catch (e) {
            slog("error", "loadStreams error: " + (e.message || e));
            // Never fail — always return something
            cb({ success: true, data: [] });
        }
    }

    // ============================================================
    //  EXPORTS
    // ============================================================
    globalThis.getHome = getHome;
    globalThis.search = search;
    globalThis.load = load;
    globalThis.loadStreams = loadStreams;

    console.log("[TMDB+Stremio] Plugin loaded. TMDB catalog UI + Stremio addon streams ready.");
})();
