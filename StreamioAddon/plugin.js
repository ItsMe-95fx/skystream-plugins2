(function() {
    /**
     * Stremio Addon Plugin for SkyStream v2
     * Streams from ALL configured addons - sorted by quality (4K > 1080p > etc)
     * Only DDL/M3U8 links returned (no torrents)
     * Enhanced with user agents, subtitles, audio tracks, resolutions, pagination
     * Configure addons in plugin.json addons array
     */

    // TMDB API Configuration
    const TMDB_API = "https://api.themoviedb.org/3";
    const TMDB_KEY = "68e094699525b18a70bab2f86b1fa706";
    const TMDB_IMG = "https://image.tmdb.org/t/p/w500";
    const TMDB_IMG_ORIG = "https://image.tmdb.org/t/p/original";
    const LANG = "en-US";
    const REFERER = "https://www.themoviedb.org/";

    // User Agents for better streaming compatibility
    const USER_AGENTS = [
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0.6099.119 Mobile/15E148 Safari/604.1"
    ];

    function getRandomUserAgent() {
        return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
    }

    // Cache
    const manifestCache = {};
    const STREAM_CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

    function getBaseUrl() {
        return manifest?.baseUrl || "https://torrentio.strem.fun";
    }

    // Get addons from plugin.json manifest
    function getAllAddons() {
        var addons = [];

        // Primary addons from manifest
        if (manifest?.addons && Array.isArray(manifest.addons)) {
            manifest.addons.forEach(function(url) {
                if (url && typeof url === 'string' && url.startsWith('http')) {
                    // Extract base URL from manifest URL
                    var baseUrl = url.replace(/\/manifest\.json$/, '');
                    if (addons.indexOf(baseUrl) === -1) {
                        addons.push(baseUrl);
                    }
                }
            });
        }

        return addons;
    }

    function buildUrl(path, params) {
        var url = TMDB_API + path + "?api_key=" + TMDB_KEY + "&language=" + LANG;
        if (params) {
            for (var key in params) {
                if (params.hasOwnProperty(key) && params[key] !== undefined && params[key] !== null) {
                    url = url + "&" + key + "=" + encodeURIComponent(params[key]);
                }
            }
        }
        return url;
    }

    function img(path) {
        if (!path) return "";
        if (path.indexOf("http") === 0) return path;
        return TMDB_IMG + path;
    }

    function origImg(path) {
        if (!path) return "";
        if (path.indexOf("http") === 0) return path;
        return TMDB_IMG_ORIG + path;
    }

    async function api(path, params) {
        var url = buildUrl(path, params);
        var res = await http_get(url, {
            "User-Agent": getRandomUserAgent(),
            "Accept": "application/json",
            "Referer": REFERER
        });
        var body = res.body || "";
        if (!body) throw new Error("Empty response");
        if (res.status === 401) throw new Error("Unauthorized");
        if (body.indexOf("<") === 0) throw new Error("Invalid response");
        return JSON.parse(body);
    }

    async function fetchStream(baseUrl, type, id, season, episode, idType) {
        var streamUrl;
        // Use proper Stremio ID format: imdb:tt..., tmdb:19995, or series:xxx
        var streamId = id;

        if (idType === "imdb") {
            streamId = id; // Already IMDb format
        } else if (idType === "tmdb") {
            streamId = "tmdb:" + id; // TMDB prefix
        } else {
            streamId = "tmdb:" + id; // Default TMDB format for most addons
        }

        if (type === "movie") {
            streamUrl = baseUrl + "/stream/" + type + "/" + encodeURIComponent(streamId) + ".json";
        } else {
            streamUrl = baseUrl + "/stream/" + type + "/" + encodeURIComponent(streamId) + ":" + (season || 1) + ":" + (episode || 1) + ".json";
        }

        var userAgent = getRandomUserAgent();

        try {
            var res = await http_get(streamUrl, {
                "User-Agent": userAgent,
                "Accept": "application/json",
                "Referer": baseUrl + "/",
                "Origin": baseUrl,
                "Accept-Language": "en-US,en;q=0.9"
            });

            if (res && res.body) {
                var data = JSON.parse(res.body);
                if (data && data.streams) {
                    data._userAgent = userAgent;
                    data._baseUrl = baseUrl;
                }
                return data;
            }
        } catch (e) {
            // Silently fail
        }
        return null;
    }

    function makeItem(item, type) {
        var t = type === "tv" || type === "series" ? "series" : "movie";
        var dateStr = item.release_date || item.first_air_date || "";
        var year = dateStr ? parseInt(dateStr.split("-")[0]) : undefined;
        var title = item.title || item.name || item.original_title || item.original_name || "Unknown";

        return new MultimediaItem({
            title: title,
            url: JSON.stringify({ id: item.id, type: type }),
            posterUrl: img(item.poster_path),
            bannerUrl: origImg(item.backdrop_path),
            year: year,
            score: item.vote_average ? parseFloat(item.vote_average.toFixed(1)) : undefined,
            description: item.overview || "",
            type: t,
            contentType: t
        });
    }

    async function getHome(cb, page) {
        try {
            var pageNum = parseInt(page) || 1;
            var sections = {};

            // Use TMDB for home content (reliable) with pagination
            try {
                var requests = [];
                var pages = [pageNum, pageNum + 1, pageNum + 2]; // Preload next pages

                requests.push(api("/trending/movie/week", { page: pages[0] }));
                requests.push(api("/trending/tv/week", { page: pages[0] }));
                requests.push(api("/movie/popular", { page: pages[0] }));
                requests.push(api("/tv/popular", { page: pages[0] }));

                var tmdbResults = await Promise.allSettled(requests);

                if (tmdbResults[0].status === "fulfilled" && tmdbResults[0].value.results) {
                    sections["Trending Movies"] = tmdbResults[0].value.results.slice(0, 20).map(function(i) { return makeItem(i, "movie"); });
                }
                if (tmdbResults[1].status === "fulfilled" && tmdbResults[1].value.results) {
                    var tvResults = tmdbResults[1].value.results.filter(function(i) { return i.media_type === "tv"; });
                    sections["Trending TV"] = tvResults.slice(0, 20).map(function(i) { return makeItem(i, "tv"); });
                }
                if (tmdbResults[2].status === "fulfilled" && tmdbResults[2].value.results) {
                    sections["Popular Movies"] = tmdbResults[2].value.results.slice(0, 20).map(function(i) { return makeItem(i, "movie"); });
                }
                if (tmdbResults[3].status === "fulfilled" && tmdbResults[3].value.results) {
                    sections["Popular TV"] = tmdbResults[3].value.results.slice(0, 20).map(function(i) { return makeItem(i, "tv"); });
                }
            } catch (e) {
                console.log("TMDB error:", e.message);
            }

            if (Object.keys(sections).length === 0) {
                cb({ success: false, errorCode: "NO_DATA", message: "No content found" });
                return;
            }

            cb({ success: true, data: sections, page: pageNum });
        } catch (e) {
            cb({ success: false, errorCode: "HOME_ERROR", message: String(e.message || e) });
        }
    }

    async function search(query, cb, page) {
        try {
            var q = String(query || "").trim();
            var pageNum = parseInt(page) || 1;

            if (!q) {
                cb({ success: true, data: [], page: 1 });
                return;
            }

            try {
                var data = await api("/search/multi", { query: q, page: pageNum });
                var results = (data.results || [])
                    .filter(function(i) { return i.media_type === "movie" || i.media_type === "tv"; })
                    .slice(0, 30)
                    .map(function(i) { return makeItem(i, i.media_type); });

                cb({ success: true, data: results, page: pageNum, totalPages: data.total_pages });
            } catch (e) {
                cb({ success: false, errorCode: "SEARCH_ERROR", message: String(e.message || e) });
            }
        } catch (e) {
            cb({ success: false, errorCode: "SEARCH_ERROR", message: String(e.message || e) });
        }
    }

    async function load(url, cb) {
        try {
            var parsed = JSON.parse(url);
            var id = parsed.id;
            var type = parsed.type;

            var detail = await api(type === "movie" ? "/movie/" + id : "/tv/" + id, {});

            if (type === "series" || type === "tv") {
                var eps = [];
                var seasons = detail.seasons || [];

                for (var s = 0; s < seasons.length; s++) {
                    var season = seasons[s];
                    if (season.season_number === 0) continue;

                    try {
                        var sDetail = await api("/tv/" + id + "/season/" + season.season_number, {});
                        var episodes = sDetail.episodes || [];

                        for (var e = 0; e < episodes.length; e++) {
                            var ep = episodes[e];
                            eps.push(new Episode({
                                name: ep.name || "Episode " + ep.episode_number,
                                url: JSON.stringify({ id: id, type: "series", season: season.season_number, episode: ep.episode_number }),
                                season: season.season_number,
                                episode: ep.episode_number,
                                posterUrl: img(ep.still_path),
                                description: ep.overview || ""
                            }));
                        }
                    } catch (_) {}
                }

                if (eps.length === 0) {
                    eps.push(new Episode({ name: detail.name || "Watch", url: url, season: 1, episode: 1 }));
                }

                cb({
                    success: true,
                    data: new MultimediaItem({
                        title: detail.name || detail.original_name || "Unknown",
                        url: url,
                        posterUrl: img(detail.poster_path),
                        bannerUrl: origImg(detail.backdrop_path),
                        description: detail.overview || "",
                        type: "series",
                        contentType: "series",
                        year: detail.first_air_date ? parseInt(detail.first_air_date.split("-")[0]) : undefined,
                        score: detail.vote_average ? parseFloat(detail.vote_average.toFixed(1)) : undefined,
                        status: detail.status === "Returning Series" ? "ongoing" : "completed",
                        episodes: eps
                    })
                });
            } else {
                cb({
                    success: true,
                    data: new MultimediaItem({
                        title: detail.title || detail.original_title || "Unknown",
                        url: url,
                        posterUrl: img(detail.poster_path),
                        bannerUrl: origImg(detail.backdrop_path),
                        description: detail.overview || "",
                        type: "movie",
                        contentType: "movie",
                        year: detail.release_date ? parseInt(detail.release_date.split("-")[0]) : undefined,
                        score: detail.vote_average ? parseFloat(detail.vote_average.toFixed(1)) : undefined,
                        duration: detail.runtime || undefined,
                        episodes: [new Episode({ name: "Watch", url: url, season: 1, episode: 1 })]
                    })
                });
            }
        } catch (e) {
            cb({ success: false, errorCode: "LOAD_ERROR", message: String(e.message || e) });
        }
    }

    async function loadStreams(url, cb) {
        try {
            var data = JSON.parse(url);
            var id = data.id;
            var type = data.type;
            var season = data.season;
            var episode = data.episode;

            var allStreams = [];
            var allSubtitles = [];
            var streamStats = { total: 0, addons: 0, successful: 0 };

            // Get IMDb ID from TMDB for proper Stremio addon format
            var imdbId = null;
            var idType = "tmdb";
            try {
                var tmdbData = await api("/" + (type === "movie" ? "movie/" + id : "tv/" + id), {});
                if (tmdbData && tmdbData.imdb_id) {
                    imdbId = tmdbData.imdb_id; // e.g., "tt0499549"
                    idType = "imdb";
                }
            } catch (e) {
                console.log("TMDB lookup failed:", e.message);
            }

            // Get ALL addons from manifest
            var addons = getAllAddons();
            var typeStr = type === "series" ? "series" : "movie";
            streamStats.total = addons.length;

            // Query ALL addons in parallel with both IMDb and TMDB IDs
            var promises = addons.map(async function(addonUrl) {
                streamStats.addons++;
                var streamData = null;

                // Try with IMDb ID first (preferred by most addons)
                if (imdbId) {
                    streamData = await fetchStream(addonUrl, typeStr, imdbId, season, episode, "imdb");
                }

                // If no results, try with TMDB format
                if (!streamData || !streamData.streams || streamData.streams.length === 0) {
                    streamData = await fetchStream(addonUrl, typeStr, id, season, episode, "tmdb");
                }

                if (streamData && streamData.streams && streamData.streams.length > 0) {
                    streamStats.successful++;

                    // Process each stream - DDL/M3U8 links ONLY
                    return streamData.streams.map(function(stream) {
                        var headers = {};
                        var userAgent = streamData._userAgent || getRandomUserAgent();

                        // Extract headers from behaviorHints
                        if (stream.behaviorHints && stream.behaviorHints.proxyHeaders && stream.behaviorHints.proxyHeaders.request) {
                            headers = stream.behaviorHints.proxyHeaders.request;
                        } else if (stream.behaviorHints && stream.behaviorHints.headers) {
                            headers = stream.behaviorHints.headers;
                        }

                        var addonName = extractName(addonUrl);

                        // Handle direct URL streams (m3u8, mp4, etc.) - DDL ONLY
                        if (stream.url) {
                            var quality = extractQuality(stream.name || stream.title || stream.description || stream.url);
                            var title = stream.title || stream.name || stream.description || "";

                            // Extract audio info
                            var audioTracks = [];
                            if (stream.audioTracks) {
                                audioTracks = stream.audioTracks.map(function(audio) {
                                    return {
                                        name: audio.name || "Audio Track",
                                        lang: audio.lang || "en",
                                        url: audio.url || ""
                                    };
                                });
                            }

                            // Extract subtitle info
                            var subtitles = [];
                            if (stream.subtitles && stream.subtitles.length > 0) {
                                subtitles = stream.subtitles.map(function(sub) {
                                    return {
                                        url: sub.url,
                                        lang: sub.lang || "Unknown",
                                        title: sub.title || sub.lang || "Subtitle"
                                    };
                                });
                                allSubtitles = allSubtitles.concat(subtitles);
                            }

                            // Build enhanced headers with user agent
                            var enhancedHeaders = Object.assign({}, headers);
                            if (!enhancedHeaders["User-Agent"]) {
                                enhancedHeaders["User-Agent"] = userAgent;
                            }
                            if (!enhancedHeaders["Referer"]) {
                                enhancedHeaders["Referer"] = addonUrl + "/";
                            }

                            // Extract resolution from URL or title
                            var resolution = extractResolution(stream.url || title);

                            // Build source name with quality and resolution
                            var sourceName = addonName;
                            if (quality !== "Auto") {
                                sourceName += " " + quality;
                            }
                            if (resolution && resolution !== "Auto") {
                                sourceName += " " + resolution;
                            }
                            if (audioTracks.length > 0) {
                                var mainAudio = audioTracks.find(function(a) { return a.lang === "en"; }) || audioTracks[0];
                                sourceName += " [" + (mainAudio.lang || "Audio") + "]";
                            }
                            if (subtitles.length > 0) {
                                sourceName += " [CC]";
                            }

                            return new StreamResult({
                                url: stream.url,
                                quality: quality,
                                source: sourceName,
                                title: title,
                                headers: enhancedHeaders,
                                subtitles: subtitles,
                                audioTracks: audioTracks,
                                addonSource: addonName,
                                resolution: resolution,
                                cached: stream.cached || false,
                                size: stream.size || null
                            });
                        }

                        // Handle YouTube embeds
                        if (stream.ytId) {
                            return new StreamResult({
                                url: "https://www.youtube.com/watch?v=" + stream.ytId,
                                quality: "YouTube",
                                source: "YouTube",
                                headers: {
                                    "Referer": "https://www.youtube.com/",
                                    "User-Agent": userAgent
                                }
                            });
                        }

                        // Handle torrents - return infoHash as stream source for Stremio
                        if (stream.infoHash) {
                            var filename = "";
                            if (stream.behaviorHints && stream.behaviorHints.filename) {
                                filename = stream.behaviorHints.filename;
                            } else if (stream.title) {
                                filename = stream.title;
                            } else if (stream.name) {
                                filename = stream.name;
                            }
                            var torrentQuality = extractQuality(stream.name || filename);
                            var sourceName = addonName;
                            if (torrentQuality !== "Auto") {
                                sourceName += " " + torrentQuality;
                            }
                            return new StreamResult({
                                url: "torrent:" + stream.infoHash + ":" + (stream.fileIdx || 0),
                                quality: torrentQuality,
                                source: sourceName,
                                title: filename,
                                headers: {
                                    "User-Agent": userAgent,
                                    "Referer": addonUrl + "/"
                                },
                                cached: stream.cached || false,
                                size: stream.size || null,
                                infoHash: stream.infoHash,
                                fileIndex: stream.fileIdx || 0
                            });
                        }

                        return null;
                    }).filter(function(s) { return s !== null; });
                }
                return [];
            });

            var results = await Promise.allSettled(promises);
            results.forEach(function(result) {
                if (result.status === "fulfilled" && Array.isArray(result.value)) {
                    allStreams = allStreams.concat(result.value);
                }
            });

            // Deduplicate by URL
            var seen = {};
            allStreams = allStreams.filter(function(stream) {
                if (!seen[stream.url]) {
                    seen[stream.url] = true;
                    return true;
                }
                return false;
            });

            // Sort by quality (4K > 2160p > 1440p > 1080p > 720p > 480p > 360p > Auto > YouTube)
            allStreams.sort(function(a, b) {
                var qualityOrder = {
                    "4K": 0,
                    "2160p": 0,
                    "1440p": 1,
                    "1080p": 2,
                    "720p": 3,
                    "480p": 4,
                    "360p": 5,
                    "Auto": 6,
                    "YouTube": 7
                };
                var aOrder = qualityOrder[a.quality] || 6;
                var bOrder = qualityOrder[b.quality] || 6;
                return aOrder - bOrder;
            });

            // Group streams by quality for better organization
            var streamsByQuality = {};
            allStreams.forEach(function(stream) {
                var q = stream.quality || "Auto";
                if (!streamsByQuality[q]) {
                    streamsByQuality[q] = [];
                }
                streamsByQuality[q].push(stream);
            });

            if (allStreams.length === 0) {
                allStreams.push(new StreamResult({
                    url: "https://torrentio.strem.fun/manifest.json",
                    quality: "Configure",
                    source: "No streams found - addons may be unavailable",
                    headers: { "Referer": "https://torrentio.strem.fun" }
                }));
            }

            cb({
                success: true,
                data: allStreams,
                stats: streamStats,
                subtitles: allSubtitles,
                grouped: streamsByQuality
            });
        } catch (e) {
            cb({ success: false, errorCode: "STREAM_ERROR", message: String(e.message || e) });
        }
    }

    function extractName(url) {
        try {
            var parsed = new URL(url);
            return parsed.hostname.replace("www.", "").split(".")[0];
        } catch (e) {
            return "Addon";
        }
    }

    function extractQuality(str) {
        if (!str) return "Auto";
        var s = str.toLowerCase();
        if (s.includes("2160") || s.includes("4k") || s.includes("uhd")) return "4K";
        if (s.includes("1440")) return "1440p";
        if (s.includes("1080")) return "1080p";
        if (s.includes("720")) return "720p";
        if (s.includes("480")) return "480p";
        if (s.includes("360")) return "360p";
        if (s.includes("youtube")) return "YouTube";
        return "Auto";
    }

    function extractResolution(str) {
        if (!str) return null;
        var s = str.toLowerCase();
        if (s.includes("2160") || s.includes("4k")) return "2160p";
        if (s.includes("1440")) return "1440p";
        if (s.includes("1080")) return "1080p";
        if (s.includes("720")) return "720p";
        if (s.includes("480")) return "480p";
        if (s.includes("360")) return "360p";
        return null;
    }

    // Export functions
    globalThis.getHome = getHome;
    globalThis.search = search;
    globalThis.load = load;
    globalThis.loadStreams = loadStreams;
})();
