(function() {
    "use strict";

    var USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36";
    var HEADERS = {
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9"
    };

    // Primary source: movieswood.cloud file server (direct MKV files)
    // Fallback: tellybiz.in (unreliable)
    var MW_BASE = "https://movieswood.cloud";
    var TB_BASE = "https://tellybiz.in";

    // Sections with their paths on movieswood.cloud
    var HOME_SECTIONS = [
        { name: "Telugu Movies", path: "/telugu/", source: "movieswood" },
        { name: "Bollywood", path: "/bolly/", source: "movieswood" },
        { name: "Web Series", path: "/web/", source: "movieswood" },
        { name: "Malayalam", path: "/malayalam/", source: "movieswood" },
        { name: "Kannada", path: "/kannada/", source: "movieswood" }
    ];

    function getBaseUrl() {
        return (manifest && manifest.baseUrl) || MW_BASE;
    }

    function decodeHtmlEntities(str) {
        if (!str) return "";
        return String(str)
            .replace(/&#(\d+);/g, function(_, d) { return String.fromCharCode(Number(d)); })
            .replace(/&#x([0-9a-f]+);/gi, function(_, h) { return String.fromCharCode(parseInt(h, 16)); })
            .replace(/&amp;/gi, "&")
            .replace(/&quot;/gi, '"')
            .replace(/&#039;/gi, "'")
            .replace(/&#39;/gi, "'")
            .replace(/&lt;/gi, "<")
            .replace(/&gt;/gi, ">")
            .replace(/&nbsp;/gi, " ")
            .replace(/\+/g, " ");
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

    function formatSize(sizeStr) {
        if (!sizeStr) return "";
        var match = /([\d.]+)\s*(k|M|G)/i.exec(sizeStr);
        if (!match) return "";
        var val = parseFloat(match[1]);
        var unit = match[2].toUpperCase();
        if (unit === "G") return val.toFixed(1) + " GB";
        if (unit === "M") return Math.round(val / 1024) + " MB"; // AutoIndex uses 'k' for kilobytes
        if (unit === "K") {
            if (val > 1048576) return (val / 1048576).toFixed(1) + " GB";
            if (val > 1024) return Math.round(val / 1024) + " MB";
            return Math.round(val) + " KB";
        }
        return sizeStr;
    }

    async function fetchWithRetry(url, retries) {
        if (retries === undefined) retries = 2;
        for (var attempt = 0; attempt <= retries; attempt++) {
            try {
                var res = await http_get(url, HEADERS);
                if (res && (res.status === 200 || res.statusCode === 200)) {
                    var body = res.body || "";
                    if (body.length > 200) return body;
                }
            } catch (e) {
                if (attempt === retries) {
                    console.error("fetch failed after " + (retries + 1) + " attempts: " + url + " - " + e.message);
                }
            }
            if (attempt < retries) {
                // Simple backoff
                await new Promise(function(r) { setTimeout(r, 500 * (attempt + 1)); });
            }
        }
        return "";
    }

    // ---- Parse AutoIndex directory listing (LiteSpeed format) ----
    // AutoIndex generates:
    // <tr><td data-sort="*movie_name_(year)"><a href="/section/Movie_Name_(year)/">
    //   <img...>Movie_Name_(year)</a></td>...</tr>
    // For files:
    // <tr><td data-sort="movie_name_year_quality.mkv">
    //   <a href="/section/Movie_Name_(year)/file_quality.mkv"><img...>file_quality.mkv</a></td>...</tr>

    function parseDirectoryListing(html, sectionBase) {
        var items = [];
        var seenNames = {};
        var base = sectionBase || MW_BASE;

        // Parse folder entries (movie folders)
        var folderRegex = /<tr[^>]*>[\s\S]*?<a\s+href=["']([^"']+\/[^"']*?)["'][^>]*>[\s\S]*?<img[^>]*>\s*([^<]+)\s*<\/a>[\s\S]*?<\/tr>/gi;
        var match;

        while ((match = folderRegex.exec(html)) !== null) {
            var href = match[1];
            var displayName = decodeHtmlEntities(match[2].trim());

            // Skip parent directory link
            if (displayName === "Parent Directory" || href.indexOf("Parent") !== -1) continue;
            if (!href || href === "/") continue;

            // Build full URL
            var fullUrl;
            if (href.indexOf("http") === 0) {
                fullUrl = href;
            } else if (href.indexOf("/") === 0) {
                fullUrl = base + href;
            } else {
                fullUrl = base + "/" + href;
            }

            // Extract title and year from display name
            // Format: "Movie_Name_(year)" or "Movie_Name_(year)_Language"
            var title = displayName;
            var year = null;

            var yearMatch = displayName.match(/\((\d{4})\)/);
            if (yearMatch) {
                year = parseInt(yearMatch[1]);
                title = displayName.replace(/[(_]\d{4}[)]/g, "").replace(/_/g, " ").trim();
            } else {
                title = displayName.replace(/_/g, " ").trim();
            }

            // Check if it's a series (has "web series", "season" etc)
            var isSeries = /season|episode|web.?series/i.test(title) ||
                          (href.indexOf("/web/") !== -1);

            var key = fullUrl;
            if (seenNames[key]) continue;
            seenNames[key] = true;

            items.push(new MultimediaItem({
                title: title,
                url: fullUrl,
                posterUrl: "",
                type: isSeries ? "series" : "movie",
                year: year
            }));
        }

        // If no folders found, try parsing the simpler table rows
        if (items.length === 0) {
            var simpleRegex = /<a\s+href=["'](\/[^"']*?\/)["'][^>]*>[\s\S]*?<img[^>]*>\s*([^<]+)\s*<\/a>/gi;
            while ((match = simpleRegex.exec(html)) !== null) {
                var shref = match[1];
                var sname = decodeHtmlEntities(match[2].trim());
                if (sname === "Parent Directory" || shref === "/") continue;

                var syear = null;
                var syearMatch = sname.match(/\((\d{4})\)/);
                if (syearMatch) syear = parseInt(syearMatch[1]);
                var stitle = sname.replace(/[(_]\d{4}[)]/g, "").replace(/_/g, " ").trim();

                var sIsSeries = /season|episode|web.?series/i.test(stitle) ||
                               (shref.indexOf("/web/") !== -1);

                var sKey = shref;
                if (seenNames[sKey]) continue;
                seenNames[sKey] = true;

                items.push(new MultimediaItem({
                    title: stitle,
                    url: base + shref,
                    posterUrl: "",
                    type: sIsSeries ? "series" : "movie",
                    year: syear
                }));
            }
        }

        return items;
    }

    // ---- Parse movie detail page (AutoIndex file listing) ----
    function parseMovieFiles(html, folderUrl) {
        var files = [];
        var base = getBaseUrl();

        // Parse file entries (video files inside movie folder)
        var fileRegex = /<tr[^>]*>[\s\S]*?<a\s+href=["']([^"']+)["'][^>]*>[\s\S]*?<img[^>]*>\s*([^<]+)\s*<\/a>[\s\S]*?<\/tr>/gi;
        var match;

        while ((match = fileRegex.exec(html)) !== null) {
            var href = match[1];
            var fileName = decodeHtmlEntities(match[2].trim());

            if (fileName === "Parent Directory" || !fileName) continue;

            // Only include video files
            if (!/\.(mp4|mkv|avi|m3u8|webm)$/i.test(fileName)) continue;

            var fullUrl;
            if (href.indexOf("http") === 0) {
                fullUrl = href;
            } else if (href.indexOf("/") === 0) {
                fullUrl = base + href;
            } else {
                fullUrl = (folderUrl.endsWith("/") ? folderUrl : folderUrl + "/") + href;
            }

            var quality = extractQuality(fileName);

            files.push({
                url: fullUrl,
                quality: quality,
                fileName: fileName
            });
        }

        // Also try to extract from the data-sort attributes
        if (files.length === 0) {
            var dataSortRegex = /data-sort=["']([^"']*\.(?:mp4|mkv|avi|webm))["'][^>]*>[\s\S]*?<a\s+href=["']([^"']+)["']/gi;
            while ((match = dataSortRegex.exec(html)) !== null) {
                var sortName = match[1];
                var fileHref = match[2];

                var fileFullUrl;
                if (fileHref.indexOf("http") === 0) {
                    fileFullUrl = fileHref;
                } else if (fileHref.indexOf("/") === 0) {
                    fileFullUrl = base + fileHref;
                } else {
                    fileFullUrl = (folderUrl.endsWith("/") ? folderUrl : folderUrl + "/") + fileHref;
                }

                var fileQuality = extractQuality(sortName);

                files.push({
                    url: fileFullUrl,
                    quality: fileQuality,
                    fileName: sortName
                });
            }
        }

        return files;
    }

    // ---- Get Home ----
    async function getHome(cb) {
        try {
            var categories = {};

            for (var si = 0; si < HOME_SECTIONS.length; si++) {
                var section = HOME_SECTIONS[si];
                try {
                    var url = MW_BASE + section.path;
                    var html = await fetchWithRetry(url, 2);

                    if (html && html.length > 300) {
                        var items = parseDirectoryListing(html, MW_BASE);
                        if (items.length > 0) {
                            categories[section.name] = items;
                            console.log("Loaded " + items.length + " items from " + section.name);
                        }
                    }
                } catch (e) {
                    console.error("Error loading " + section.name + ": " + e.message);
                }
            }

            if (Object.keys(categories).length === 0) {
                cb({ success: false, errorCode: "HOME_ERROR", message: "Could not load any categories from movieswood.cloud" });
            } else {
                cb({ success: true, data: categories });
            }
        } catch (e) {
            console.error("getHome error: " + e.message);
            cb({ success: false, errorCode: "HOME_ERROR", message: e.message });
        }
    }

    // ---- Search ----
    async function search(query, cb) {
        try {
            var results = [];
            var q = query.toLowerCase();

            // Search through movieswood.cloud sections
            for (var si = 0; si < HOME_SECTIONS.length; si++) {
                var section = HOME_SECTIONS[si];
                try {
                    var url = MW_BASE + section.path;
                    var html = await fetchWithRetry(url, 2);
                    if (html && html.length > 300) {
                        var items = parseDirectoryListing(html, MW_BASE);
                        // Filter by query
                        for (var ii = 0; ii < items.length; ii++) {
                            var item = items[ii];
                            if (item.title.toLowerCase().indexOf(q) !== -1) {
                                results.push(item);
                            }
                        }
                    }
                } catch (e) {
                    console.error("Search error in " + section.name + ": " + e.message);
                }
            }

            cb({ success: true, data: results });
        } catch (e) {
            console.error("search error: " + e.message);
            cb({ success: true, data: [] });
        }
    }

    // ---- Load (Movie Detail) ----
    async function load(url, cb) {
        try {
            var html = await fetchWithRetry(url, 2);

            if (!html || html.length < 200) {
                cb({ success: false, errorCode: "LOAD_ERROR", message: "Failed to load movie folder" });
                return;
            }

            // Parse video files from the movie folder
            var files = parseMovieFiles(html, url);

            // Extract title from URL path
            var pathParts = url.replace(/\/+$/, "").split("/");
            var folderName = decodeURIComponent(pathParts[pathParts.length - 1] || "");
            var title = folderName.replace(/_/g, " ").trim();

            // Extract year
            var year = null;
            var yearMatch = title.match(/\((\d{4})\)/);
            if (yearMatch) {
                year = parseInt(yearMatch[1]);
                title = title.replace(/\(\d{4}\)/, "").trim();
            }

            var isSeries = /season|episode|web.?series/i.test(title) ||
                          (url.indexOf("/web/") !== -1);

            if (files.length > 0) {
                // Build streams array for the episode
                var streamData = [];
                for (var fi = 0; fi < files.length; fi++) {
                    streamData.push({
                        url: files[fi].url,
                        quality: files[fi].quality,
                        fileName: files[fi].fileName
                    });
                }

                var item = new MultimediaItem({
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
                });

                cb({ success: true, data: item });
            } else {
                // No files found, return the URL as a fallback
                cb({
                    success: true,
                    data: new MultimediaItem({
                        title: title || "Unknown",
                        url: url,
                        posterUrl: "",
                        type: isSeries ? "series" : "movie",
                        year: year,
                        episodes: [new Episode({
                            name: "Watch",
                            url: url,
                            season: 1,
                            episode: 1
                        })]
                    })
                });
            }
        } catch (e) {
            console.error("load error: " + e.message);
            cb({ success: false, errorCode: "LOAD_ERROR", message: e.message });
        }
    }

    // ---- Load Streams ----
    async function loadStreams(dataStr, cb) {
        try {
            var streams = [];

            var streamData = [];
            try {
                var parsed = JSON.parse(dataStr);
                if (Array.isArray(parsed)) {
                    streamData = parsed;
                }
            } catch (e) {
                // Not JSON, try as direct URL
                if (dataStr && typeof dataStr === "string") {
                    streamData = [{ url: dataStr, quality: "Auto" }];
                }
            }

            for (var si = 0; si < streamData.length; si++) {
                var sd = streamData[si];
                if (sd && sd.url) {
                    var quality = sd.quality || extractQuality(sd.fileName || sd.url) || "Auto";

                    streams.push(new StreamResult({
                        url: sd.url,
                        quality: quality,
                        source: "TellyBiz [" + quality + "]",
                        headers: {
                            "User-Agent": USER_AGENT,
                            "Referer": MW_BASE + "/",
                            "Accept": "*/*"
                        }
                    }));
                }
            }

            if (streams.length === 0) {
                cb({ success: true, data: [] });
            } else {
                cb({ success: true, data: streams });
            }
        } catch (e) {
            console.error("loadStreams error: " + e.message);
            cb({ success: true, data: [] });
        }
    }

    globalThis.getHome = getHome;
    globalThis.search = search;
    globalThis.load = load;
    globalThis.loadStreams = loadStreams;
})();
