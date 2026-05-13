(function() {
    "use strict";

    const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36";
    const HEADERS = {
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9"
    };

    const MW_BASE = "https://movieswood.cloud";

    // Only list directories that EXIST and return content on movieswood.cloud
    // Tested: /telugu/ works (8 movies with MKV files)
    //         /tamil/, /malayalam/, /kannada/, /bolly/, /web/ exist but rarely return body (timeout)
    // We try them all in parallel with timeouts
    const HOME_SECTIONS = [
        { name: "Telugu Movies", path: "/telugu/" },
        { name: "Tamil Movies",  path: "/tamil/" },
        { name: "Malayalam",     path: "/malayalam/" },
        { name: "Kannada",       path: "/kannada/" },
        { name: "Bollywood",     path: "/bolly/" },
        { name: "Web Series",    path: "/web/" }
    ];

    function getBaseUrl() {
        return (manifest && manifest.baseUrl) || MW_BASE;
    }

    function decodeHtmlEntities(str) {
        if (!str) return "";
        return String(str)
            .replace(/&#(\d+);/g, function(_, d) { return String.fromCharCode(Number(d)); })
            .replace(/&amp;/gi, "&")
            .replace(/&quot;/gi, '"')
            .replace(/&lt;/gi, "<")
            .replace(/&gt;/gi, ">")
            .replace(/&nbsp;/gi, " ");
    }

    function extractQuality(text) {
        if (!text) return "Auto";
        var lower = text.toLowerCase();
        if (lower.indexOf("2160") !== -1 || lower.indexOf("4k") !== -1) return "4K";
        if (lower.indexOf("1080") !== -1) return "1080p";
        if (lower.indexOf("720") !== -1) return "720p";
        if (lower.indexOf("480") !== -1) return "480p";
        if (lower.indexOf("360") !== -1) return "360p";
        if (lower.indexOf("400mb") !== -1) return "400MB";
        if (lower.indexOf("700mb") !== -1) return "700MB";
        if (lower.indexOf("1gb") !== -1 || lower.indexOf("1000mb") !== -1) return "1GB";
        return "Auto";
    }

    // Fetch with retry and timeout
    async function fetchWithTimeout(url, timeoutMs) {
        if (timeoutMs === undefined) timeoutMs = 15000;
        try {
            var result = await Promise.race([
                http_get(url, HEADERS),
                new Promise(function(_, reject) {
                    setTimeout(function() {
                        reject(new Error("Timeout after " + timeoutMs + "ms"));
                    }, timeoutMs);
                })
            ]);
            if (result && (result.status === 200 || result.statusCode === 200)) {
                var body = result.body || "";
                if (body.length > 200) return body;
            }
            return "";
        } catch (e) {
            return "";
        }
    }

    // ---- Parse AutoIndex directory listing (LiteSpeed format) ----
    // <tr><td data-sort="*movie_name_(year)">
    //   <a href="/telugu/Movie_Name_(year)/"><img...>Movie_Name_(year)</a></td>...</tr>
    function parseDirectoryListing(html) {
        var items = [];
        var seenNames = {};

        // Match folder rows: <tr>...<a href="/telugu/Name_(year)/">...Name_(year)</a>...</tr>
        var regex = /<tr[^>]*>[\s\S]*?<a\s+href=["'](\/[^"']*?\/)["'][^>]*>[\s\S]*?<img[^>]*>\s*([^<]+)\s*<\/a>[\s\S]*?<\/tr>/gi;
        var match;

        while ((match = regex.exec(html)) !== null) {
            var href = match[1];
            var displayName = decodeHtmlEntities(match[2].trim());

            if (displayName === "Parent Directory" || !displayName || href === "/") continue;
            if (seenNames[href]) continue;
            seenNames[href] = true;

            var title = displayName.replace(/_/g, " ").trim();
            var year = null;
            var yearMatch = displayName.match(/\((\d{4})\)/);
            if (yearMatch) {
                year = parseInt(yearMatch[1]);
                title = displayName.replace(/[(_]\d{4}[)]/g, "").replace(/_/g, " ").trim();
            }

            var fullUrl = MW_BASE.replace(/\/+$/, "") + href;
            var isSeries = /season|episode|web.?series/i.test(title) ||
                          (href.indexOf("/web/") !== -1);

            items.push(new MultimediaItem({
                title: title,
                url: fullUrl,
                posterUrl: "",
                type: isSeries ? "series" : "movie",
                year: year
            }));
        }
        return items;
    }

    // ---- Parse movie detail page (AutoIndex file listing with MKV/MP4 files) ----
    function parseMovieFiles(html, folderUrl) {
        var files = [];

        // <tr><td data-sort="file.mkv">
        //   <a href="/telugu/Folder/file.mkv"><img...>file.mkv</a></td>...</tr>
        var regex = /<tr[^>]*>[\s\S]*?<a\s+href=["']([^"']+)["'][^>]*>[\s\S]*?<img[^>]*>\s*([^<]+)\s*<\/a>[\s\S]*?<\/tr>/gi;
        var match;

        while ((match = regex.exec(html)) !== null) {
            var href = match[1];
            var fileName = decodeHtmlEntities(match[2].trim());

            if (fileName === "Parent Directory" || !fileName) continue;
            if (!/\.(mp4|mkv|avi|m3u8|webm)$/i.test(fileName)) continue;

            var fullUrl;
            if (href.indexOf("http") === 0) {
                fullUrl = href;
            } else if (href.indexOf("/") === 0) {
                fullUrl = MW_BASE.replace(/\/+$/, "") + href;
            } else {
                var base = folderUrl.endsWith("/") ? folderUrl : folderUrl + "/";
                fullUrl = base + href;
            }

            var quality = extractQuality(fileName);

            files.push({
                url: fullUrl,
                quality: quality,
                fileName: fileName
            });
        }
        return files;
    }

    // ---- Fetch a single section ----
    async function fetchSection(section) {
        try {
            var html = await fetchWithTimeout(MW_BASE + section.path, 15000);
            if (!html || html.length < 300) return null;
            var items = parseDirectoryListing(html);
            if (items.length === 0) return null;
            return { name: section.name, items: items };
        } catch (e) {
            return null;
        }
    }

    // ---- Get Home (ALL sections fetched in PARALLEL) ----
    async function getHome(cb) {
        try {
            var tasks = HOME_SECTIONS.map(function(s) { return fetchSection(s); });
            var results = await Promise.all(tasks);

            var homeData = {};
            for (var i = 0; i < results.length; i++) {
                if (results[i] !== null) {
                    homeData[results[i].name] = results[i].items;
                }
            }

            if (Object.keys(homeData).length === 0) {
                cb({ success: false, errorCode: "HOME_ERROR",
                     message: "Could not load any movies. All sources timed out." });
            } else {
                cb({ success: true, data: homeData });
            }
        } catch (e) {
            console.error("getHome error: " + e.message);
            cb({ success: false, errorCode: "HOME_ERROR", message: e.message });
        }
    }

    // ---- Search (search across all sections in parallel) ----
    async function search(query, cb) {
        try {
            var q = query.toLowerCase();
            var results = [];

            var tasks = HOME_SECTIONS.map(function(s) {
                return fetchSection(s);
            });
            var sections = await Promise.all(tasks);

            for (var si = 0; si < sections.length; si++) {
                if (!sections[si]) continue;
                var items = sections[si].items;
                for (var ii = 0; ii < items.length; ii++) {
                    if (items[ii].title.toLowerCase().indexOf(q) !== -1) {
                        results.push(items[ii]);
                    }
                }
            }

            cb({ success: true, data: results });
        } catch (e) {
            console.error("search error: " + e.message);
            cb({ success: true, data: [] });
        }
    }

    // ---- Load (Movie Detail - fetches the movie folder for MKV files) ----
    async function load(url, cb) {
        try {
            var html = await fetchWithTimeout(url, 20000);

            if (!html || html.length < 200) {
                cb({ success: false, errorCode: "LOAD_ERROR",
                     message: "Failed to load movie folder" });
                return;
            }

            var files = parseMovieFiles(html, url);

            var pathParts = url.replace(/\/+$/, "").split("/");
            var folderName = decodeURIComponent(pathParts[pathParts.length - 1] || "");
            var title = folderName.replace(/_/g, " ").trim();

            var year = null;
            var yearMatch = title.match(/\((\d{4})\)/);
            if (yearMatch) {
                year = parseInt(yearMatch[1]);
                title = title.replace(/\(\d{4}\)/, "").trim();
            }

            var isSeries = /season|episode|web.?series/i.test(title) ||
                          (url.indexOf("/web/") !== -1);

            if (files.length > 0) {
                // Build streams: pass all MKV files as JSON in episode URL
                var streamData = files.map(function(f) {
                    return { url: f.url, quality: f.quality, fileName: f.fileName };
                });

                cb({
                    success: true,
                    data: new MultimediaItem({
                        title: title,
                        url: url,
                        posterUrl: "",
                        type: isSeries ? "series" : "movie",
                        year: year,
                        episodes: [new Episode({
                            name: isSeries ? "Episode 1" : "Full Movie",
                            url: JSON.stringify(streamData),
                            season: 1,
                            episode: 1
                        })]
                    })
                });
            } else {
                // No video files found - return folder URL as fallback
                cb({
                    success: true,
                    data: new MultimediaItem({
                        title: title || "Unknown",
                        url: url,
                        posterUrl: "",
                        type: isSeries ? "series" : "movie",
                        year: year
                    })
                });
            }
        } catch (e) {
            console.error("load error: " + e.message);
            cb({ success: false, errorCode: "LOAD_ERROR", message: e.message });
        }
    }

    // ---- Load Streams (returns all quality options) ----
    async function loadStreams(dataStr, cb) {
        try {
            var streamData = [];

            try {
                var parsed = JSON.parse(dataStr);
                if (Array.isArray(parsed)) {
                    streamData = parsed;
                }
            } catch (e) {
                // Not JSON - try as direct URL
                if (dataStr && typeof dataStr === "string" && dataStr.length > 5) {
                    streamData = [{ url: dataStr, quality: "Auto" }];
                }
            }

            var streams = streamData.map(function(sd) {
                if (!sd || !sd.url) return null;
                var quality = sd.quality || extractQuality(sd.fileName || sd.url) || "Auto";
                return new StreamResult({
                    url: sd.url,
                    quality: quality,
                    source: "TellyBiz [" + quality + "]",
                    headers: {
                        "User-Agent": USER_AGENT,
                        "Referer": MW_BASE + "/",
                        "Accept": "*/*"
                    }
                });
            }).filter(function(s) { return s !== null; });

            cb({ success: true, data: streams });
        } catch (e) {
            console.error("loadStreams error: " + e.message);
            cb({ success: true, data: [] });
        }
    }

    // ---- Helper for filter method ----
    if (!Array.prototype.filter) {
        Array.prototype.filter = function(fn) {
            var res = [];
            for (var i = 0; i < this.length; i++) {
                if (fn(this[i])) res.push(this[i]);
            }
            return res;
        };
    }

    globalThis.getHome = getHome;
    globalThis.search = search;
    globalThis.load = load;
    globalThis.loadStreams = loadStreams;
})();
