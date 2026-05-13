(function() {
    "use strict";

    const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36";
    const EXTERNAL_HEADERS = {
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
        "Cache-Control": "no-cache"
    };

    // Maximum pages to fetch per category for pagination
    const MAX_PAGES = 3;

    function getBaseUrl() {
        return (manifest && manifest.baseUrl) || "https://www.moviezwap.love";
    }

    function fixUrl(url) {
        if (!url) return "";
        if (url.startsWith("//")) return "https:" + url;
        if (url.startsWith("/")) {
            var base = getBaseUrl().replace(/\/+$/, "");
            return base + url;
        }
        return url;
    }

    function decodeHtml(html) {
        if (!html) return "";
        return html
            .replace(/&amp;/g, "&")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/&quot;/g, '"')
            .replace(/&#039;/g, "'")
            .replace(/&#39;/g, "'")
            .replace(/&apos;/g, "'")
            .replace(/&#(\d+);/g, function(_, d) { return String.fromCharCode(Number(d)); })
            .replace(/&nbsp;/g, " ");
    }

    function extractQuality(text) {
        if (!text) return "Auto";
        var lower = text.toLowerCase();
        if (lower.indexOf("2160") !== -1 || lower.indexOf("4k") !== -1) return "2160p";
        if (lower.indexOf("1080") !== -1) return "1080p";
        if (lower.indexOf("720") !== -1) return "720p";
        if (lower.indexOf("480") !== -1) return "480p";
        if (lower.indexOf("360") !== -1) return "360p";
        if (lower.indexOf("320") !== -1) return "320p";
        if (lower.indexOf("240") !== -1) return "240p";
        if (lower.indexOf("3gp") !== -1) return "3gp";
        return "Auto";
    }

    function formatSize(sizeStr) {
        if (!sizeStr) return "";
        var trimmed = sizeStr.trim();
        if (/[\d.]+\s*(MB|GB|KB)/i.test(trimmed)) return trimmed;
        return "";
    }

    function isSeriesContent(title, url) {
        var lower = ((title || "") + " " + (url || "")).toLowerCase();
        return /season|episodes?|eps|all episodes|web series|hot web series/i.test(lower);
    }

    // ---- HTTP helper with retry ----
    async function fetchUrl(url, retries) {
        if (retries === undefined) retries = 2;
        for (var attempt = 0; attempt <= retries; attempt++) {
            try {
                var res = await http_get(url, EXTERNAL_HEADERS);
                if (res && (res.status === 200 || res.statusCode === 200)) {
                    return res.body || "";
                }
                if (attempt < retries) {
                    console.warn("Retry " + (attempt + 1) + " for: " + url);
                }
            } catch (e) {
                if (attempt < retries) {
                    console.warn("Error (attempt " + (attempt + 1) + "): " + e.message);
                } else {
                    console.error("Failed after " + (retries + 1) + " attempts: " + e.message);
                }
            }
        }
        return "";
    }

    // ---- Parse movie listing from HTML ----
    function parseMovieList(html, baseUrl) {
        var results = [];
        var seenUrls = {};
        var base = baseUrl || getBaseUrl();

        // Pattern 1: <a href='/movie/...html'>Title</a> (from category pages)
        var linkRegex = /<a[^>]+href=["'](\/movie\/[^"']*\.html)["'][^>]*>([\s\S]*?)<\/a>/gi;
        var match;

        while ((match = linkRegex.exec(html)) !== null) {
            var href = match[1];
            var rawTitle = match[2].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
            var title = decodeHtml(rawTitle);

            // Skip generic links (categories, etc.)
            if (!title || title.length < 3) continue;
            if (title.indexOf("Download") !== -1 || title.indexOf("Home") !== -1 || title.indexOf("Join") !== -1) continue;
            if (title.indexOf("Movies") !== -1 && title.indexOf(")") === -1) continue;
            if (href.indexOf("/movie/") !== 0) continue;

            // Clean title - remove leading "» " or "►" etc
            title = title.replace(/^[»►]\s*/, "").trim();

            if (seenUrls[href]) continue;
            seenUrls[href] = true;

            var isSeries = isSeriesContent(title, href);

            results.push(new MultimediaItem({
                title: title,
                url: fixUrl(href),
                posterUrl: "",
                type: isSeries ? "series" : "movie"
            }));
        }

        // Pattern 2: Also parse from homepage style listing with arrows
        var arrowRegex = /<a[^>]+href=["'](\/movie\/[^"']*\.html)["']>([^<]+)<\/a>/gi;
        while ((match = arrowRegex.exec(html)) !== null) {
            var href2 = match[1];
            var title2 = decodeHtml(match[2].trim());
            title2 = title2.replace(/^[»►]\s*/, "").trim();

            if (title2.length < 3) continue;
            if (seenUrls[href2]) continue;
            if (href2.indexOf("/movie/") !== 0) continue;
            seenUrls[href2] = true;

            var isSeries2 = isSeriesContent(title2, href2);

            results.push(new MultimediaItem({
                title: title2,
                url: fixUrl(href2),
                posterUrl: "",
                type: isSeries2 ? "series" : "movie"
            }));
        }

        return results;
    }

    // ---- Parse movie listing from search results ----
    function parseSearchResults(html, baseUrl) {
        var results = [];
        var seenUrls = {};
        var base = baseUrl || getBaseUrl();

        // On moviezwap, search results show movie links similar to category pages
        var regex = /<a[^>]+href=["'](\/movie\/[^"']*\.html)["']>([\s\S]*?)<\/a>/gi;
        var match;

        while ((match = regex.exec(html)) !== null) {
            var href = match[1];
            var rawTitle = match[2].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
            var title = decodeHtml(rawTitle);

            if (!title || title.length < 3) continue;
            if (href.indexOf("/movie/") !== 0) continue;
            if (seenUrls[href]) continue;
            seenUrls[href] = true;

            var isSeries = isSeriesContent(title, href);

            results.push(new MultimediaItem({
                title: title,
                url: fixUrl(href),
                posterUrl: "",
                type: isSeries ? "series" : "movie"
            }));
        }

        return results;
    }

    // ---- Check if a category page has a "Next" page link ----
    function getNextPageUrl(html) {
        // Look for pagination links
        // Common patterns: href="/category/...html?page=2" or "Next" text
        var nextMatch = /<a[^>]+href=["']([^"']+\?page=(\d+)[^"']*)["'][^>]*>Next/i.exec(html);
        if (nextMatch) return nextMatch[1];

        // Alternative: page links at bottom
        var pageLinkMatch = /<a[^>]+href=["']([^"']*page=(\d+)[^"']*)["'][^>]*>\d+<\/a>/gi;
        var links = [];
        var m;
        while ((m = pageLinkMatch.exec(html)) !== null) {
            links.push({ url: m[1], page: parseInt(m[2]) });
        }
        if (links.length > 0) {
            // Find the highest page number link
            var maxPage = 0;
            var maxUrl = null;
            for (var i = 0; i < links.length; i++) {
                if (links[i].page > maxPage) {
                    maxPage = links[i].page;
                    maxUrl = links[i].url;
                }
            }
            return maxUrl;
        }

        return null;
    }

    // ---- Get Home ----
    async function getHome(cb) {
        try {
            var categories = [
                { name: "Telugu (2026) Movies", path: "/category/Telugu-(2026)-Movies.html" },
                { name: "Telugu (2025) Movies", path: "/category/Telugu-(2025)-Movies.html" },
                { name: "Tamil (2026) Movies", path: "/category/Tamil-(2026)-Movies.html" },
                { name: "Tamil (2025) Movies", path: "/category/Tamil-(2025)-Movies.html" },
                { name: "Telugu Dubbed Hollywood", path: "/category/Telugu-Dubbed-Movies-[Hollywood].html" },
                { name: "Telugu Dubbed Complete", path: "/category/Telugu-Dubbed-Hollywood-Movies-Complete-Set.html" },
                { name: "HOT Web Series", path: "/category/HOT-Web-Series.html" },
                { name: "Telugu Web Series", path: "/category/Telugu-Web-Series.html" }
            ];

            var homeData = {};

            // Also fetch latest from homepage
            try {
                var homeHtml = await fetchUrl(getBaseUrl() + "/", 2);
                if (homeHtml) {
                    var latestItems = parseMovieList(homeHtml);
                    if (latestItems.length > 0) {
                        // Limit to most recent items for Trending
                        homeData["Trending"] = latestItems.slice(0, 25);
                    }
                }
            } catch (e) {
                console.error("Error fetching homepage:", e.message);
            }

            // Fetch each category with pagination
            for (var ci = 0; ci < categories.length; ci++) {
                var cat = categories[ci];
                var allItems = [];
                try {
                    var catHtml = await fetchUrl(getBaseUrl() + cat.path, 2);
                    if (catHtml) {
                        var items = parseMovieList(catHtml);
                        for (var ii = 0; ii < items.length; ii++) {
                            allItems.push(items[ii]);
                        }

                        // Try to fetch additional pages (pagination)
                        for (var pg = 2; pg <= MAX_PAGES; pg++) {
                            var pageUrl = cat.path + "?page=" + pg;
                            var pageHtml = await fetchUrl(getBaseUrl() + pageUrl, 1);
                            if (pageHtml) {
                                var pageItems = parseMovieList(pageHtml);
                                if (pageItems.length === 0) break; // No more items
                                for (var pi = 0; pi < pageItems.length; pi++) {
                                    allItems.push(pageItems[pi]);
                                }
                            } else {
                                break; // Page didn't load
                            }
                        }
                    }
                } catch (e) {
                    console.error("Error fetching " + cat.name + ":", e.message);
                }

                if (allItems.length > 0) {
                    homeData[cat.name] = allItems;
                    console.log("Loaded " + allItems.length + " items for " + cat.name);
                }
            }

            if (Object.keys(homeData).length === 0) {
                cb({ success: false, errorCode: "SITE_OFFLINE", message: "Could not load any categories. Site may be offline." });
            } else {
                cb({ success: true, data: homeData });
            }
        } catch (e) {
            console.error("getHome fatal error:", e.message);
            cb({ success: false, errorCode: "PARSE_ERROR", message: e.message });
        }
    }

    // ---- Search ----
    async function search(query, cb) {
        try {
            var searchUrl = getBaseUrl() + "/search.php?q=" + encodeURIComponent(query.replace(/\s+/g, "+"));
            var html = await fetchUrl(searchUrl, 2);

            if (!html) {
                cb({ success: true, data: [] });
                return;
            }

            var items = parseSearchResults(html);
            cb({ success: true, data: items });
        } catch (e) {
            console.error("Search error:", e.message);
            cb({ success: true, data: [] });
        }
    }

    // ---- Load (detail page) ----
    async function load(url, cb) {
        try {
            var html = await fetchUrl(url, 2);

            if (!html || html.length < 200) {
                cb({ success: false, errorCode: "SITE_OFFLINE", message: "Failed to load movie page" });
                return;
            }

            // Extract Title
            var titleMatch = /<h2[^>]*>([^<]+)<\/h2>/i.exec(html) ||
                           /<title>([^<]+)/i.exec(html) ||
                           /<h1[^>]*>([^<]+)<\/h1>/i.exec(html);
            var title = titleMatch ? decodeHtml(titleMatch[1].trim()) : "Unknown Title";
            // Clean title - remove trailing "Download" etc
            title = title.split("Download")[0].trim();
            title = title.split("Free")[0].trim();
            title = title.replace(/<[^>]+>/g, "").trim();

            // Extract Poster
            var posterMatch = /<img[^>]+src=["']([^"']*\/poster\/[^"']*)["'][^>]*>/i.exec(html) ||
                             /og:image["']\s*content=["']([^"']+)["']/i.exec(html) ||
                             /<img[^>]+src=["']([^"']+(?:poster|movie)[^"']*(?:jpg|jpeg|png))["']/i.exec(html);
            var poster = posterMatch ? posterMatch[1] : "";

            // Extract Description
            var description = "";
            var descMatch = /Desc\/Plot[^<]*<\/td>\s*<td[^>]*>([^<]+)/i.exec(html) ||
                           /<p[^>]*>([\s\S]{10,500}?)<\/p>/i.exec(html);
            if (descMatch) {
                description = decodeHtml(descMatch[1].replace(/<[^>]+>/g, ""));
            }

            // Extract Year
            var year = null;
            var yearMatch = /(\d{4})/.exec(html);
            if (yearMatch) {
                year = parseInt(yearMatch[1]);
            }

            // Extract rating/score
            var score = null;
            var ratingMatch = html.match(/Rating[^:]*:\s*([\d.]+)\/10/i);
            if (ratingMatch) {
                score = parseFloat(ratingMatch[1]);
            }

            var isSeries = isSeriesContent(title, url);

            // ---- Download / Download Links ----
            // Moviezwap lists download links on the movie page:
            // <a href='/dwload.php?file=81053'>filename.mp4</a> &nbsp; (328 MB)
            var downloadLinks = [];
            var dlRegex = /href=["']([^"']*dwload\.php[^"']*)["'][^>]*>([^<]+)<\/a>\s*&nbsp;\s*\(([^)]*)\)/gi;
            var dlMatch;

            while ((dlMatch = dlRegex.exec(html)) !== null) {
                var dwUrl = dlMatch[1];
                var fileName = decodeHtml(dlMatch[2].trim());
                var fileSize = dlMatch[3].trim();
                var quality = extractQuality(fileName);

                // Transform dwload.php -> download.php for the actual stream
                var streamUrl = dwUrl.replace("dwload.php", "download.php");
                // Also try direct dwload.php as fallback
                var directDwUrl = dwUrl;

                downloadLinks.push({
                    url: fixUrl(streamUrl),
                    dwUrl: fixUrl(directDwUrl),
                    quality: quality,
                    fileName: fileName,
                    fileSize: fileSize
                });
            }

            // If the specific dwload pattern didn't match, try a broader one
            if (downloadLinks.length === 0) {
                var dlRegex2 = /href=["']([^"']*dwload\.php[^"']*)["'][^>]*>([^<]+)</gi;
                while ((dlMatch = dlRegex2.exec(html)) !== null) {
                    var dwUrl2 = dlMatch[1];
                    var fileName2 = decodeHtml(dlMatch[2].trim());
                    var quality2 = extractQuality(fileName2);
                    var streamUrl2 = dwUrl2.replace("dwload.php", "download.php");

                    downloadLinks.push({
                        url: fixUrl(streamUrl2),
                        dwUrl: fixUrl(dwUrl2),
                        quality: quality2,
                        fileName: fileName2,
                        fileSize: ""
                    });
                }
            }

            if (isSeries) {
                // For series: create episodes from download links
                if (downloadLinks.length > 0) {
                    var episodes = [];
                    for (var ei = 0; ei < downloadLinks.length; ei++) {
                        var dl = downloadLinks[ei];
                        var seasonMatch = dl.fileName.match(/[Ss]eason\s*(\d+)/i) ||
                                         dl.fileName.match(/[Ss](\d+)/i);
                        var episodeMatch = dl.fileName.match(/[Ee]p(?:isode)?\s*(\d+)/i) ||
                                          dl.fileName.match(/[Ee](\d+)/i);

                        var season = seasonMatch ? parseInt(seasonMatch[1]) : 1;
                        var episodeNum = episodeMatch ? parseInt(episodeMatch[1]) : (ei + 1);

                        episodes.push(new Episode({
                            name: "S" + String(season).padStart(2, "0") + "E" + String(episodeNum).padStart(2, "0") + " - " + dl.fileName,
                            url: dl.url,
                            season: season,
                            episode: episodeNum
                        }));
                    }

                    episodes.sort(function(a, b) {
                        if (a.season !== b.season) return a.season - b.season;
                        return a.episode - b.episode;
                    });

                    cb({
                        success: true,
                        data: new MultimediaItem({
                            title: title,
                            url: url,
                            posterUrl: poster ? fixUrl(poster) : "",
                            type: "series",
                            description: description,
                            year: year,
                            score: score,
                            episodes: episodes
                        })
                    });
                } else {
                    // Series without explicit episodes - use the page URL itself
                    cb({
                        success: true,
                        data: new MultimediaItem({
                            title: title,
                            url: url,
                            posterUrl: poster ? fixUrl(poster) : "",
                            type: "series",
                            description: description,
                            year: year,
                            score: score,
                            episodes: [new Episode({
                                name: "Watch Series",
                                url: url,
                                season: 1,
                                episode: 1
                            })]
                        })
                    });
                }
            } else {
                // Movie: store download links as stream data
                var episodeData;
                if (downloadLinks.length > 0) {
                    // Store the download links to be resolved by loadStreams
                    episodeData = new Episode({
                        name: "Full Movie",
                        url: JSON.stringify(downloadLinks.map(function(dl) {
                            return { url: dl.url, quality: dl.quality, fileName: dl.fileName, fileSize: dl.fileSize };
                        })),
                        season: 1,
                        episode: 1
                    });
                } else {
                    episodeData = new Episode({
                        name: "Full Movie",
                        url: url,
                        season: 1,
                        episode: 1
                    });
                }

                cb({
                    success: true,
                    data: new MultimediaItem({
                        title: title,
                        url: url,
                        posterUrl: poster ? fixUrl(poster) : "",
                        type: "movie",
                        description: description,
                        year: year,
                        score: score,
                        episodes: [episodeData]
                    })
                });
            }
        } catch (e) {
            console.error("Load error:", e.message);
            cb({ success: false, errorCode: "PARSE_ERROR", message: e.message });
        }
    }

    // ---- Extract actual video URL from download page ----
    async function extractStreamUrl(downloadUrl, quality) {
        try {
            var html = await fetchUrl(downloadUrl, 2);
            if (!html) return null;

            // Pattern 1: Fast Download Server link with mp4/mkv URL
            // <a href='https://cdn.example.com/video.mp4?st=...&e=...'><...>Fast Download Server</b></a>
            var fastDlMatch = /<a[^>]+href=["'](https?:\/\/[^"']+\.(?:mp4|mkv)[^"']*)["'][\s\S]*?Fast Download Server/i.exec(html);
            if (fastDlMatch) {
                return { url: fastDlMatch[1], quality: extractQuality(fastDlMatch[1]), size: "" };
            }

            // Pattern 2: Any direct video URL (.mp4 or .mkv)
            var directVideoMatch = /href=["'](https?:\/\/[^"']+\.(?:mp4|mkv)[^"']*)["']/i.exec(html);
            if (directVideoMatch) {
                return { url: directVideoMatch[1], quality: extractQuality(directVideoMatch[1]), size: "" };
            }

            // Pattern 3: Any href to HTTP(S) that might be a download link (contains "movie" or "download" in path)
            var anyDlMatch = /<a[^>]+href=["'](https?:\/\/[^"']+)["'][^>]*>\s*(?:<[^>]*>\s*)*Download/i.exec(html);
            if (anyDlMatch) {
                return { url: anyDlMatch[1], quality: quality, size: "" };
            }

            // Pattern 4: Extract from obfuscated JavaScript - look for window.location or similar
            var jsRedirectMatch = /window\.location(?:\s*=\s*["']([^"']+)["']|\.href\s*=\s*["']([^"']+)["'])/i.exec(html);
            if (jsRedirectMatch) {
                var redirectUrl = jsRedirectMatch[1] || jsRedirectMatch[2];
                if (redirectUrl) return { url: fixUrl(redirectUrl), quality: extractQuality(redirectUrl), size: "" };
            }

            // Pattern 5: Extract file size from the page
            var sizeMatch = /File\s*Size\s*:?\s*([^<]*)/i.exec(html);
            var fileSize = sizeMatch ? sizeMatch[1].trim() : "";

            // If we found nothing, return the download URL itself (may work as direct link)
            return { url: downloadUrl, quality: quality, size: fileSize };
        } catch (e) {
            console.error("extractStreamUrl error:", e.message);
            return null;
        }
    }

    // ---- Load Streams ----
    async function loadStreams(dataStr, cb) {
        try {
            var streams = [];

            // Parse the data - it could be JSON array of links or a plain URL
            var linksToProcess = [];

            try {
                var parsed = JSON.parse(dataStr);
                if (Array.isArray(parsed)) {
                    linksToProcess = parsed;
                } else {
                    linksToProcess = [dataStr];
                }
            } catch (e) {
                linksToProcess = [dataStr];
            }

            var processingTasks = [];

            for (var si = 0; si < linksToProcess.length; si++) {
                var item = linksToProcess[si];
                if (typeof item === "string") {
                    processingTasks.push(resolveStream(item, "Auto"));
                } else if (item && item.url) {
                    var qual = item.quality || extractQuality(item.fileName || item.url);
                    processingTasks.push(resolveStream(item.url, qual));
                }
            }

            var results = await Promise.all(processingTasks);

            for (var ri = 0; ri < results.length; ri++) {
                var result = results[ri];
                if (result && result.url) {
                    var label = "Moviezwap";
                    if (result.quality && result.quality !== "Auto") label += " (" + result.quality + ")";
                    if (result.size) label += " [" + result.size + "]";

                    streams.push(new StreamResult({
                        url: result.url,
                        quality: result.quality || "Auto",
                        source: label,
                        headers: {
                            "User-Agent": USER_AGENT,
                            "Referer": getBaseUrl() + "/",
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
            console.error("loadStreams error:", e.message);
            cb({ success: true, data: [] });
        }
    }

    // ---- Resolve a single stream URL ----
    async function resolveStream(url, quality) {
        try {
            if (!url || typeof url !== "string") {
                return null;
            }

            // If it's a download.php URL, extract the actual video link
            if (url.indexOf("download.php") !== -1) {
                return await extractStreamUrl(url, quality);
            }

            // If it's already a direct video URL (.mp4, .mkv, .m3u8)
            if (/\.(mp4|mkv|m3u8)(\?|$)/i.test(url)) {
                return { url: url, quality: quality || extractQuality(url), size: "" };
            }

            // If it's a dwload.php URL (direct), fetch it to get the download.php redirect
            if (url.indexOf("dwload.php") !== -1) {
                var html = await fetchUrl(url, 2);
                if (html) {
                    var downloadLinkMatch = /<a[^>]+href=["']([^"']*download\.php[^"']*)["']/i.exec(html);
                    if (downloadLinkMatch) {
                        return await extractStreamUrl(fixUrl(downloadLinkMatch[1]), quality);
                    }

                    // Try direct video link on the dwload page
                    var directMatch = /<a[^>]+href=["'](https?:\/\/[^"']+\.(?:mp4|mkv)[^"']*)["']/i.exec(html);
                    if (directMatch) {
                        return { url: directMatch[1], quality: extractQuality(directMatch[1]), size: "" };
                    }
                }
                return { url: url, quality: quality, size: "" };
            }

            // Otherwise, try to fetch the URL and look for video links
            var html = await fetchUrl(url, 1);
            if (html) {
                var videoMatch = /href=["'](https?:\/\/[^"']+\.(?:mp4|mkv|m3u8)[^"']*)["']/i.exec(html);
                if (videoMatch) {
                    return { url: videoMatch[1], quality: extractQuality(videoMatch[1]), size: "" };
                }
            }

            // Return as-is if nothing found
            return { url: url, quality: quality, size: "" };
        } catch (e) {
            console.error("resolveStream error:", e.message);
            return { url: url, quality: quality, size: "" };
        }
    }

    // Export functions
    globalThis.getHome = getHome;
    globalThis.search = search;
    globalThis.load = load;
    globalThis.loadStreams = loadStreams;
})();
