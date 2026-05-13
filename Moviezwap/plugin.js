(function() {
    "use strict";

    const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36";
    const HEADERS = {
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
        "Cache-Control": "no-cache"
    };

    const MAX_PAGES = 2; // Fetch up to 2 pages per category (keep it fast)

    const HOME_CATEGORIES = [
        { name: "Telugu (2026) Movies", path: "/category/Telugu-(2026)-Movies.html" },
        { name: "Telugu (2025) Movies", path: "/category/Telugu-(2025)-Movies.html" },
        { name: "Tamil (2026) Movies",  path: "/category/Tamil-(2026)-Movies.html" },
        { name: "Tamil (2025) Movies",  path: "/category/Tamil-(2025)-Movies.html" },
        { name: "Telugu Dubbed Hollywood", path: "/category/Telugu-Dubbed-Movies-[Hollywood].html" },
        { name: "HOT Web Series",       path: "/category/HOT-Web-Series.html" },
        { name: "Telugu Web Series",    path: "/category/Telugu-Web-Series.html" }
    ];

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

    function decodeHtml(str) {
        if (!str) return "";
        return str
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

    function isSeriesContent(title, url) {
        var lower = ((title || "") + " " + (url || "")).toLowerCase();
        return /season|episodes?|eps|all episodes|web series|hot web series/i.test(lower);
    }

    // ---- Fetch with timeout ----
    async function fetchUrl(url, timeoutMs) {
        if (timeoutMs === undefined) timeoutMs = 15000;
        for (var attempt = 0; attempt <= 2; attempt++) {
            try {
                var result = await Promise.race([
                    http_get(url, HEADERS),
                    new Promise(function(_, reject) {
                        setTimeout(function() { reject(new Error("Timeout")); }, timeoutMs);
                    })
                ]);
                if (result && (result.status === 200 || result.statusCode === 200)) {
                    return result.body || "";
                }
                if (attempt < 2) {
                    await new Promise(function(r) { setTimeout(r, 500); });
                }
            } catch (e) {
                if (attempt >= 2) return "";
                await new Promise(function(r) { setTimeout(r, 500 * (attempt + 1)); });
            }
        }
        return "";
    }

    // ---- Parse movie links from HTML ----
    function parseMovieList(html) {
        var results = [];
        var seenUrls = {};

        // Pattern: <a href='/movie/Title.html'>» Title <font...>...</font></a>
        var regex = /<a[^>]+href=["'](\/movie\/[^"']*\.html)["'][^>]*>([\s\S]*?)<\/a>/gi;
        var match;

        while ((match = regex.exec(html)) !== null) {
            var href = match[1];
            var rawTitle = match[2].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
            var title = decodeHtml(rawTitle);

            if (!title || title.length < 3) continue;
            if (/^Download|^Home|^Join/i.test(title)) continue;
            if (title.indexOf("Movies") !== -1 && title.indexOf(")") === -1) continue;
            if (href.indexOf("/movie/") !== 0) continue;

            // Clean title
            title = title.replace(/^[»►]\s*/, "").trim();

            if (seenUrls[href]) continue;
            seenUrls[href] = true;

            results.push(new MultimediaItem({
                title: title,
                url: fixUrl(href),
                posterUrl: "",
                type: isSeriesContent(title, href) ? "series" : "movie"
            }));
        }
        return results;
    }

    // ---- Search results parser ----
    function parseSearchResults(html) {
        return parseMovieList(html);
    }

    // ---- Fetch a category page (including paginated pages in PARALLEL) ----
    async function fetchCategory(cat) {
        var allItems = [];
        var pageTasks = [];

        for (var pg = 1; pg <= MAX_PAGES; pg++) {
            var pageUrl = pg === 1 ? cat.path : cat.path + "?page=" + pg;
            pageTasks.push(
                fetchUrl(getBaseUrl() + pageUrl, 15000).then(function(html) {
                    if (html) return parseMovieList(html);
                    return [];
                }).catch(function() { return []; })
            );
        }

        var results = await Promise.all(pageTasks);
        for (var i = 0; i < results.length; i++) {
            allItems = allItems.concat(results[i]);
        }

        return allItems;
    }

    // ---- Get Home (ALL categories fetched in PARALLEL) ----
    async function getHome(cb) {
        try {
            // Fetch homepage for Trending
            var homeTask = fetchUrl(getBaseUrl() + "/", 15000)
                .then(function(html) {
                    if (html) return parseMovieList(html).slice(0, 25);
                    return [];
                }).catch(function() { return []; });

            // Fetch all categories in parallel
            var catTasks = HOME_CATEGORIES.map(function(cat) {
                return fetchCategory(cat).then(function(items) {
                    return { name: cat.name, items: items };
                }).catch(function() {
                    return { name: cat.name, items: [] };
                });
            });

            var allResults = await Promise.all([homeTask].concat(catTasks));
            var homeData = {};

            // Homepage / Trending (first result)
            var trending = allResults[0];
            if (trending.length > 0) {
                homeData["Trending"] = trending;
            }

            // Category results (results 1..N)
            for (var i = 1; i < allResults.length; i++) {
                var result = allResults[i];
                if (result.items.length > 0) {
                    homeData[result.name] = result.items;
                }
            }

            if (Object.keys(homeData).length === 0) {
                cb({ success: false, errorCode: "SITE_OFFLINE",
                     message: "Could not load any categories. Site may be offline." });
            } else {
                cb({ success: true, data: homeData });
            }
        } catch (e) {
            console.error("getHome error:", e.message);
            cb({ success: false, errorCode: "PARSE_ERROR", message: e.message });
        }
    }

    // ---- Search ----
    async function search(query, cb) {
        try {
            var searchUrl = getBaseUrl() + "/search.php?q=" + encodeURIComponent(query.replace(/\s+/g, "+"));
            var html = await fetchUrl(searchUrl, 15000);
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

    // ---- Load (Movie Detail Page) ----
    async function load(url, cb) {
        try {
            var html = await fetchUrl(url, 20000);

            if (!html || html.length < 200) {
                cb({ success: false, errorCode: "LOAD_ERROR",
                     message: "Failed to load movie page" });
                return;
            }

            // Extract title
            var title = "Unknown Title";
            var titleMatch = /<h2[^>]*>([^<]+)<\/h2>/i.exec(html) ||
                            /<title>([^<]+)/i.exec(html) ||
                            /<h1[^>]*>([^<]+)<\/h1>/i.exec(html);
            if (titleMatch) {
                title = decodeHtml(titleMatch[1].trim());
                title = title.split("Download")[0].split("Free")[0].trim();
                title = title.replace(/<[^>]+>/g, "").trim();
            }

            // Extract poster
            var poster = "";
            var posterMatch = /<img[^>]+src=["']([^"']*\/poster\/[^"']*)["'][^>]*>/i.exec(html) ||
                             /og:image["']\s*content=["']([^"']+)["']/i.exec(html) ||
                             /<img[^>]+src=["']([^"']+(?:poster|movie)[^"']*(?:jpg|jpeg|png))["']/i.exec(html);
            if (posterMatch) poster = posterMatch[1];

            // Extract description
            var description = "";
            var descMatch = /Desc\/Plot[^<]*<\/td>\s*<td[^>]*>([^<]+)/i.exec(html) ||
                           /<p[^>]*>([\s\S]{10,500}?)<\/p>/i.exec(html);
            if (descMatch) {
                description = decodeHtml(descMatch[1].replace(/<[^>]+>/g, ""));
            }

            // Extract year
            var year = null;
            var yearMatch = /(\d{4})/.exec(html);
            if (yearMatch) year = parseInt(yearMatch[1]);

            // Extract rating
            var score = null;
            var ratingMatch = html.match(/Rating[^:]*:\s*([\d.]+)\/10/i);
            if (ratingMatch) score = parseFloat(ratingMatch[1]);

            var isSeries = isSeriesContent(title, url);

            // ---- Extract ALL download links ----
            var downloadLinks = [];

            // Pattern 1: <a href='/dwload.php?file=NUM'>filename.mp4</a> &nbsp; (SIZE)
            var dlRegex = /href=["']([^"']*dwload\.php[^"']*)["'][^>]*>([^<]+)<\/a>\s*&nbsp;\s*\(([^)]*)\)/gi;
            var dlMatch;
            while ((dlMatch = dlRegex.exec(html)) !== null) {
                downloadLinks.push({
                    dwUrl: fixUrl(dlMatch[1]),
                    fileName: decodeHtml(dlMatch[2].trim()),
                    fileSize: dlMatch[3].trim()
                });
            }

            // Pattern 2: <a href='/dwload.php?file=NUM'>filename.mp4</a> (no size)
            if (downloadLinks.length === 0) {
                var dlRegex2 = /href=["']([^"']*dwload\.php[^"']*)["'][^>]*>([^<]+)<\/a>/gi;
                while ((dlMatch = dlRegex2.exec(html)) !== null) {
                    downloadLinks.push({
                        dwUrl: fixUrl(dlMatch[1]),
                        fileName: decodeHtml(dlMatch[2].trim()),
                        fileSize: ""
                    });
                }
            }

            if (isSeries) {
                // Series: create episodes from download links
                if (downloadLinks.length > 0) {
                    var episodes = [];
                    for (var ei = 0; ei < downloadLinks.length; ei++) {
                        var dl = downloadLinks[ei];
                        var sMatch = dl.fileName.match(/[Ss](?:eason)?\s*(\d+)/i);
                        var eMatch = dl.fileName.match(/[Ee]p(?:isode)?\s*(\d+)/i) ||
                                    dl.fileName.match(/[Ee](\d+)/i);
                        var season = sMatch ? parseInt(sMatch[1]) : 1;
                        var epNum = eMatch ? parseInt(eMatch[1]) : (ei + 1);

                        episodes.push(new Episode({
                            name: "S" + String(season).padStart(2, "0") +
                                  "E" + String(epNum).padStart(2, "0") + " - " + dl.fileName,
                            url: dl.dwUrl,
                            season: season,
                            episode: epNum
                        }));
                    }

                    episodes.sort(function(a, b) {
                        if (a.season !== b.season) return a.season - b.season;
                        return a.episode - b.episode;
                    });

                    cb({ success: true,
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
                    cb({ success: true,
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
                                season: 1, episode: 1
                            })]
                        })
                    });
                }
            } else {
                // Movie: store ALL download links as JSON in episode URL
                var episodeData;
                if (downloadLinks.length > 0) {
                    episodeData = new Episode({
                        name: "Full Movie",
                        url: JSON.stringify(downloadLinks.map(function(dl) {
                            return {
                                dwUrl: dl.dwUrl,
                                fileName: dl.fileName,
                                fileSize: dl.fileSize,
                                quality: extractQuality(dl.fileName)
                            };
                        })),
                        season: 1, episode: 1
                    });
                } else {
                    episodeData = new Episode({
                        name: "Full Movie",
                        url: url,
                        season: 1, episode: 1
                    });
                }

                cb({ success: true,
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

    // ---- Extract actual video URL from download.php page ----
    async function extractStreamUrl(dlUrl, quality) {
        try {
            var html = await fetchUrl(dlUrl, 15000);
            if (!html) return null;

            // Pattern 1: Fast Download Server link
            var m = /<a[^>]+href=["'](https?:\/\/[^"']+\.(?:mp4|mkv)[^"']*)["'][\s\S]*?Fast Download Server/i.exec(html);
            if (m) return { url: m[1], quality: extractQuality(m[1]), size: "" };

            // Pattern 2: Any direct video URL
            m = /href=["'](https?:\/\/[^"']+\.(?:mp4|mkv)[^"']*)["']/i.exec(html);
            if (m) return { url: m[1], quality: extractQuality(m[1]), size: "" };

            // Pattern 3: Download button
            m = /<a[^>]+href=["'](https?:\/\/[^"']+)["'][^>]*>Download/i.exec(html);
            if (m) return { url: m[1], quality: quality, size: "" };

            // Pattern 4: JavaScript redirect
            m = /window\.location(?:\s*=\s*["']([^"']+)["']|\.href\s*=\s*["']([^"']+)["'])/i.exec(html);
            if (m) {
                var redirect = m[1] || m[2];
                if (redirect) return { url: fixUrl(redirect), quality: extractQuality(redirect), size: "" };
            }

            // Return raw URL as fallback
            return { url: dlUrl, quality: quality, size: "" };
        } catch (e) {
            return { url: dlUrl, quality: quality, size: "" };
        }
    }

    // ---- Resolve a single stream (from dwload to actual video URL) ----
    async function resolveStream(item) {
        try {
            var url = item.dwUrl || item.url;
            var quality = item.quality || extractQuality(item.fileName || url);

            if (!url) return null;

            // If it's a download.php URL, fetch and extract the real video link
            if (url.indexOf("download.php") !== -1) {
                return await extractStreamUrl(url, quality);
            }

            // If it's a dwload.php URL, try download.php equivalent
            if (url.indexOf("dwload.php") !== -1) {
                var downloadUrl = url.replace("dwload.php", "download.php");
                var result = await extractStreamUrl(downloadUrl, quality);
                if (result && result.url) return result;

                // Try original dwload URL
                result = await extractStreamUrl(url, quality);
                if (result && result.url) return result;

                return { url: url, quality: quality, size: "" };
            }

            // Already a direct video URL
            if (/\.(mp4|mkv|m3u8)(\?|$)/i.test(url)) {
                return { url: url, quality: quality, size: "" };
            }

            // Unknown format - try fetching as page
            var html = await fetchUrl(url, 10000);
            if (html) {
                var m = /href=["'](https?:\/\/[^"']+\.(?:mp4|mkv|m3u8)[^"']*)["']/i.exec(html);
                if (m) return { url: m[1], quality: extractQuality(m[1]), size: "" };
            }

            return { url: url, quality: quality, size: "" };
        } catch (e) {
            return { url: item.dwUrl || item.url, quality: quality, size: "" };
        }
    }

    // ---- Load Streams (ALL streams resolved in PARALLEL) ----
    async function loadStreams(dataStr, cb) {
        try {
            var linksToProcess = [];

            try {
                var parsed = JSON.parse(dataStr);
                if (Array.isArray(parsed)) {
                    linksToProcess = parsed;
                } else {
                    linksToProcess = [{ dwUrl: dataStr }];
                }
            } catch (e) {
                linksToProcess = [{ dwUrl: dataStr }];
            }

            // Resolve ALL streams in PARALLEL
            var tasks = linksToProcess.map(function(item) { return resolveStream(item); });
            var results = await Promise.all(tasks);

            var streams = [];
            for (var i = 0; i < results.length; i++) {
                var result = results[i];
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

            cb({ success: true, data: streams });
        } catch (e) {
            console.error("loadStreams error:", e.message);
            cb({ success: true, data: [] });
        }
    }

    globalThis.getHome = getHome;
    globalThis.search = search;
    globalThis.load = load;
    globalThis.loadStreams = loadStreams;
})();
