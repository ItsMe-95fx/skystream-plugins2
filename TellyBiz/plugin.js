(function() {
    "use strict";

    var USER_AGENT = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Mobile Safari/537.36";
    var HEADERS = {
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9"
    };

    var TB_BASE = "https://tellybiz.in";
    var MW_BASE = "https://movieswood.cloud";
    var MAX_TB_PAGES = 3; // Fetch up to 3 pages from tellybiz

    function getBaseUrl() {
        return (manifest && manifest.baseUrl) || TB_BASE;
    }

    function fixUrl(base, url) {
        if (!url) return "";
        if (url.indexOf("http") === 0) return url;
        if (url.indexOf("/") === 0) return base.replace(/\/+$/, "") + url;
        return base + "/" + url;
    }

    function decodeHtml(str) {
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
        if (lower.indexOf("800mb") !== -1 || lower.indexOf("700mb") !== -1) return "HD";
        if (lower.indexOf("400mb") !== -1) return "SD";
        return "Auto";
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
                    var body = result.body || "";
                    if (body.length > 200) return body;
                }
                return "";
            } catch (e) {
                if (attempt >= 2) return "";
                await new Promise(function(r) { setTimeout(r, 1000); });
            }
        }
        return "";
    }

    // ======== TELLYBIZ.IN SCRAPING ========

    // Parse tellybiz.in homepage: extract movie cards with poster images
    function parseTbMovieCards(html) {
        var items = [];
        var seen = {};

        // Pattern 1: Movie cards WITH poster image
        // <a href="/p?id=XXX" class="movie-card"> ... <img src="TMDB_URL" alt="Title"> ... <h3 class="movie-title">Title</h3> ... <span class="movie-year">2026</span> ... <span class="rating-badge">★ 3.0</span> ... </a>
        var regex = /<a\s+href="(\/p\?id=\w+)"[^>]*>[\s\S]*?<img\s+src="([^"]+)"[^>]*alt="([^"]*)"[\s\S]*?<h3 class="movie-title">([^<]+)<\/h3>[\s\S]*?<span class="movie-year">([^<]+)<\/span>[\s\S]*?(?:<span class="rating-badge">[^<]*([\d.]+)<\/span>)?[\s\S]*?<\/a>/gi;
        var match;
        while ((match = regex.exec(html)) !== null) {
            var href = match[1];
            var posterUrl = match[2].trim();
            var imgAlt = decodeHtml(match[3].trim());
            var title = decodeHtml(match[4].trim());
            var year = match[5].trim();
            var rating = match[6] ? parseFloat(match[6]) : null;

            var finalTitle = title || imgAlt;
            if (!finalTitle || finalTitle.length < 2) continue;
            if (seen[href]) continue;
            seen[href] = true;

            items.push(new MultimediaItem({
                title: finalTitle,
                url: fixUrl(TB_BASE, href),
                posterUrl: posterUrl,
                type: "movie",
                year: parseInt(year) || 0,
                score: rating || 0
            }));
        }

        // Pattern 2: Movie cards WITHOUT poster image (<div class="no-poster">Text</div>)
        var regex2 = /<a\s+href="(\/p\?id=\w+)"[^>]*>[\s\S]*?<div class="no-poster">([^<]+)<\/div>[\s\S]*?<h3 class="movie-title">([^<]+)<\/h3>[\s\S]*?<span class="movie-year">([^<]+)<\/span>[\s\S]*?(?:<span class="rating-badge">[^<]*([\d.]+)<\/span>)?[\s\S]*?<\/a>/gi;
        while ((match = regex2.exec(html)) !== null) {
            var href2 = match[1];
            var noPosterText = decodeHtml(match[2].trim());
            var title2 = decodeHtml(match[3].trim());
            var year2 = match[4].trim();
            var rating2 = match[5] ? parseFloat(match[5]) : null;

            if (!title2 || title2.length < 2) continue;
            if (seen[href2]) continue;
            seen[href2] = true;

            items.push(new MultimediaItem({
                title: title2,
                url: fixUrl(TB_BASE, href2),
                posterUrl: "",
                type: "movie",
                year: parseInt(year2) || 0,
                score: rating2 || 0
            }));
        }

        return items;
    }

    // Parse tellybiz.in movie detail page
    function parseTbDetail(html) {
        var result = { title: "", posterUrl: "", year: null, score: null,
                       description: "", genre: "", language: "", qualities: "",
                       downloadLinks: [] };

        // Title from h1
        var m = /<h1 class="movie-detail-title">([^<]+)<\/h1>/i.exec(html);
        if (m) result.title = decodeHtml(m[1].trim());

        // Poster
        m = /<img\s+src="([^"]+)"\s+alt="[^"]*">/i.exec(html);
        if (m) result.posterUrl = m[1];

        // Meta values (Year, IMDB, Genre, Language, Quality)
        var metaValues = [];
        var metaRegex = /<span class="meta-value">([^<]+)<\/span>/gi;
        while ((m = metaRegex.exec(html)) !== null) {
            metaValues.push(m[1].trim());
        }
        metaValues.forEach(function(v) {
            if (/^\d{4}$/.test(v)) result.year = parseInt(v);
            else if (/^[\d.]+$/.test(v) && v.indexOf(".") !== -1) result.score = parseFloat(v);
        });

        // Genre
        m = /<span class="meta-label">Genre:<\/span>\s*<span class="meta-value">([^<]+)<\/span>/i.exec(html);
        if (m) result.genre = m[1].trim();

        // Language
        m = /<span class="meta-label">Language:<\/span>\s*<span class="meta-value">([^<]+)<\/span>/i.exec(html);
        if (m) result.language = m[1].trim();

        // Quality
        m = /<span class="meta-label">Quality:<\/span>\s*<span class="meta-value">([^<]+)<\/span>/i.exec(html);
        if (m) result.qualities = m[1].trim();

        // Description
        m = /<div class="movie-overview">[\s\S]*?<p>([\s\S]*?)<\/p>/i.exec(html);
        if (m) result.description = decodeHtml(m[1].trim());

        // Download links: <a href="/loanid/ID1/ID2" class="file-link ...">
        // Also get file name and size
        var dlRegex = /<a\s+href="(\/loanid\/\d+\/\d+)"[^>]*>[\s\S]*?<span class="file-name">([^<]+)<\/span>\s*<span class="file-size">([^<]*)<\/span>/gi;
        while ((m = dlRegex.exec(html)) !== null) {
            result.downloadLinks.push({
                loanUrl: fixUrl(TB_BASE, m[1]),
                fileName: m[2].trim(),
                fileSize: m[3].replace(/[()]/g, "").trim()
            });
        }

        return result;
    }

    // Fetch CDN URL from loanid page
    async function resolveLoanUrl(loanUrl) {
        try {
            var html = await fetchUrl(loanUrl, 15000);
            if (html) {
                var m = /https?:\/\/[^"'\s]+\.(?:mp4|mkv)[^"'\]\s]*/i.exec(html);
                if (m) {
                    var cdnUrl = m[0].trim();
                    // Remove trailing quotes or brackets
                    cdnUrl = cdnUrl.replace(/["'\]>].*$/, "");
                    var quality = extractQuality(cdnUrl);
                    return { url: cdnUrl, quality: quality, source: loanUrl };
                }
            }
            return { url: loanUrl, quality: "Auto", source: loanUrl };
        } catch (e) {
            return { url: loanUrl, quality: "Auto", source: loanUrl };
        }
    }

    // Fetch a single tellybiz page
    async function fetchTbPage(pageNum) {
        var url = pageNum === 1 ? TB_BASE + "/" : TB_BASE + "/?page=" + pageNum;
        var html = await fetchUrl(url, 20000);
        if (!html) return [];
        return parseTbMovieCards(html);
    }

    // ======== MOVIESWOOD.CLOUD SCRAPING ========

    function parseMwDirectory(html) {
        var items = [];
        var seen = {};
        var regex = /<tr[^>]*>[\s\S]*?<a\s+href=["'](\/[^"']*?\/)["'][^>]*>[\s\S]*?<img[^>]*>\s*([^<]+)\s*<\/a>[\s\S]*?<\/tr>/gi;
        var match;
        while ((match = regex.exec(html)) !== null) {
            var href = match[1];
            var name = decodeHtml(match[2].trim());
            if (name === "Parent Directory" || !name || href === "/") continue;
            if (seen[href]) continue;
            seen[href] = true;

            var title = name.replace(/_/g, " ").trim();
            var year = null;
            var ym = name.match(/\((\d{4})\)/);
            if (ym) {
                year = parseInt(ym[1]);
                title = name.replace(/[(_]\d{4}[)]/g, "").replace(/_/g, " ").trim();
            }

            items.push(new MultimediaItem({
                title: title,
                url: MW_BASE.replace(/\/+$/, "") + href,
                posterUrl: "",
                type: /season|episode|web.?series/i.test(title) ||
                       href.indexOf("/web/") !== -1 ? "series" : "movie",
                year: year
            }));
        }
        return items;
    }

    function parseMwFiles(html) {
        var files = [];
        var regex = /<tr[^>]*>[\s\S]*?<a\s+href=["']([^"']+)["'][^>]*>[\s\S]*?<img[^>]*>\s*([^<]+)\s*<\/a>[\s\S]*?<\/tr>/gi;
        var match;
        while ((match = regex.exec(html)) !== null) {
            var href = match[1];
            var fileName = decodeHtml(match[2].trim());
            if (fileName === "Parent Directory" || !fileName) continue;
            if (!/\.(mp4|mkv|avi|webm)$/i.test(fileName)) continue;

            var fullUrl;
            if (href.indexOf("http") === 0) fullUrl = href;
            else if (href.indexOf("/") === 0) fullUrl = MW_BASE.replace(/\/+$/, "") + href;
            else fullUrl = MW_BASE + "/" + href;

            files.push({ url: fullUrl, quality: extractQuality(fileName), fileName: fileName });
        }
        return files;
    }

    // ======== GET HOME ========
    async function getHome(cb) {
        try {
            // Fetch tellybiz pages in parallel (up to MAX_TB_PAGES)
            var tbTasks = [];
            for (var pg = 1; pg <= MAX_TB_PAGES; pg++) {
                tbTasks.push(fetchTbPage(pg));
            }

            // Also try movieswood telugu in parallel
            var mwTask = fetchUrl(MW_BASE + "/telugu/", 15000)
                .then(function(html) {
                    if (html) return parseMwDirectory(html);
                    return [];
                }).catch(function() { return []; });

            var allResults = await Promise.all(tbTasks.concat([mwTask]));
            var homeData = {};

            // Collect all tellybiz movies (deduplicate across pages)
            var allTbItems = [];
            var seenTb = {};
            for (var i = 0; i < MAX_TB_PAGES; i++) {
                var pageItems = allResults[i] || [];
                for (var j = 0; j < pageItems.length; j++) {
                    var item = pageItems[j];
                    if (!seenTb[item.url]) {
                        seenTb[item.url] = true;
                        allTbItems.push(item);
                    }
                }
            }

            if (allTbItems.length > 0) {
                homeData["Latest Movies"] = allTbItems;
            }

            // Telugu movies from movieswood
            var mwItems = allResults[allResults.length - 1] || [];
            if (mwItems.length > 0) {
                homeData["Telugu Movies"] = mwItems;
            }

            if (Object.keys(homeData).length === 0) {
                cb({ success: false, errorCode: "HOME_ERROR",
                     message: "All sources failed to load." });
            } else {
                cb({ success: true, data: homeData });
            }
        } catch (e) {
            console.error("getHome error:", e.message);
            cb({ success: false, errorCode: "HOME_ERROR", message: e.message });
        }
    }

    // ======== SEARCH ========
    async function search(query, cb) {
        try {
            var q = query.toLowerCase();
            var results = [];

            // Search tellybiz
            var html = await fetchUrl(TB_BASE + "/search?q=" + encodeURIComponent(query), 15000);
            if (html) {
                // Search results have same card format as homepage
                var items = parseTbMovieCards(html);
                results = results.concat(items);
            }

            // Also search movieswood
            var mwHtml = await fetchUrl(MW_BASE + "/telugu/", 10000);
            if (mwHtml) {
                var mwItems = parseMwDirectory(mwHtml);
                for (var i = 0; i < mwItems.length; i++) {
                    if (mwItems[i].title.toLowerCase().indexOf(q) !== -1) {
                        results.push(mwItems[i]);
                    }
                }
            }

            cb({ success: true, data: results });
        } catch (e) {
            console.error("search error:", e.message);
            cb({ success: true, data: [] });
        }
    }

    // ======== LOAD (Movie Detail) ========
    async function load(url, cb) {
        try {
            // Determine source type
            var isTb = url.indexOf("tellybiz.in") !== -1;
            var isMw = url.indexOf("movieswood.cloud") !== -1;

            if (isTb) {
                // ---- TellyBiz movie ----
                var html = await fetchUrl(url, 20000);
                if (!html || html.length < 200) {
                    cb({ success: false, errorCode: "LOAD_ERROR",
                         message: "Failed to load movie page" });
                    return;
                }

                var detail = parseTbDetail(html);
                var title = detail.title || "Unknown";

                if (detail.downloadLinks.length > 0) {
                    // Store loan URLs as JSON for loadStreams to resolve
                    var episodeData = JSON.stringify(detail.downloadLinks.map(function(dl) {
                        return {
                            loanUrl: dl.loanUrl,
                            fileName: dl.fileName,
                            fileSize: dl.fileSize,
                            quality: extractQuality(dl.fileName)
                        };
                    }));

                    cb({
                        success: true,
                        data: new MultimediaItem({
                            title: title,
                            url: url,
                            posterUrl: detail.posterUrl,
                            type: "movie",
                            year: detail.year || 0,
                            description: detail.description || "",
                            score: detail.score || 0,
                            genres: detail.genre ? detail.genre.split(",").map(function(g) { return g.trim(); }) : [],
                            episodes: [new Episode({
                                name: "Play Movie",
                                url: episodeData,
                                season: 1, episode: 1
                            })]
                        })
                    });
                } else {
                    // No download links found
                    cb({
                        success: true,
                        data: new MultimediaItem({
                            title: title,
                            url: url,
                            posterUrl: detail.posterUrl,
                            type: "movie",
                            year: detail.year || 0,
                            description: detail.description || "",
                            score: detail.score || 0,
                            episodes: [new Episode({
                                name: "Play Movie",
                                url: url,
                                season: 1, episode: 1
                            })]
                        })
                    });
                }
            } else if (isMw) {
                // ---- MoviesWood movie ----
                var html = await fetchUrl(url, 20000);
                if (!html || html.length < 200) {
                    cb({ success: false, errorCode: "LOAD_ERROR",
                         message: "Failed to load movie folder" });
                    return;
                }

                var files = parseMwFiles(html);

                var pathParts = url.replace(/\/+$/, "").split("/");
                var folderName = decodeURIComponent(pathParts[pathParts.length - 1] || "");
                var title = folderName.replace(/_/g, " ").trim();

                var year = null;
                var ym = title.match(/\((\d{4})\)/);
                if (ym) { year = parseInt(ym[1]); title = title.replace(/\(\d{4}\)/, "").trim(); }

                if (files.length > 0) {
                    var streamData = files.map(function(f) {
                        return { url: f.url, quality: f.quality, fileName: f.fileName };
                    });

                    cb({
                        success: true,
                        data: new MultimediaItem({
                            title: title,
                            url: url,
                            posterUrl: "",
                            type: "movie",
                            year: year,
                            episodes: [new Episode({
                                name: "Full Movie",
                                url: JSON.stringify(streamData),
                                season: 1, episode: 1
                            })]
                        })
                    });
                } else {
                    cb({
                        success: true,
                        data: new MultimediaItem({
                            title: title || "Unknown",
                            url: url,
                            posterUrl: "",
                            type: "movie",
                            year: year
                        })
                    });
                }
            } else {
                cb({ success: false, errorCode: "LOAD_ERROR",
                     message: "Unknown source: " + url });
            }
        } catch (e) {
            console.error("load error:", e.message);
            cb({ success: false, errorCode: "LOAD_ERROR", message: e.message });
        }
    }

    // ======== LOAD STREAMS ========
    async function loadStreams(dataStr, cb) {
        try {
            var streamData = [];

            // Try to parse as JSON
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

            if (streamData.length === 0) {
                cb({ success: true, data: [] });
                return;
            }

            // Check if these are tellybiz loan URLs (need CDN resolution)
            var isLoanUrls = streamData.some(function(s) { return s.loanUrl; });

            if (isLoanUrls) {
                // Resolve ALL loan URLs in parallel to get CDN URLs
                var tasks = streamData.map(function(sd) {
                    return resolveLoanUrl(sd.loanUrl).then(function(cdnResult) {
                        return {
                            url: cdnResult.url,
                            quality: sd.quality || cdnResult.quality || extractQuality(sd.fileName),
                            fileName: sd.fileName,
                            fileSize: sd.fileSize
                        };
                    });
                });

                var resolvedStreams = await Promise.all(tasks);

                var streams = resolvedStreams.filter(function(s) { return s && s.url; })
                    .map(function(s) {
                        var quality = s.quality || "Auto";
                        return new StreamResult({
                            url: s.url,
                            quality: quality,
                            source: "TellyBiz [" + quality + "]",
                            headers: {
                                "User-Agent": USER_AGENT,
                                "Referer": TB_BASE + "/",
                                "Accept": "*/*"
                            }
                        });
                    });

                cb({ success: true, data: streams });
            } else {
                // Direct URLs (movieswood or already-resolved)
                var streams = streamData.filter(function(s) { return s && s.url; })
                    .map(function(s) {
                        var quality = s.quality || extractQuality(s.fileName || s.url) || "Auto";
                        var source = "TellyBiz";
                        if (s.url.indexOf("movieswood") !== -1) source += " [MoviesWood]";
                        source += " [" + quality + "]";
                        return new StreamResult({
                            url: s.url,
                            quality: quality,
                            source: source,
                            headers: {
                                "User-Agent": USER_AGENT,
                                "Referer": MW_BASE + "/",
                                "Accept": "*/*"
                            }
                        });
                    });

                cb({ success: true, data: streams });
            }
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
