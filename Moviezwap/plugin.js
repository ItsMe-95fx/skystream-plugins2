(function() {

    const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
    const EXTERNAL_HEADERS = {
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
        "Connection": "keep-alive"
    };

    function getBaseUrl() {
        return manifest?.baseUrl || "https://www.moviezwap.love";
    }

    function fixUrl(url) {
        if (!url) return "";
        if (url.startsWith("//")) return "https:" + url;
        if (url.startsWith("/")) return getBaseUrl() + url;
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
            .replace(/&apos;/g, "'")
            .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(d))
            .replace(/&nbsp;/g, " ");
    }

    function extractQuality(text) {
        if (!text) return "Auto";
        const lower = text.toLowerCase();
        if (lower.includes("1080p")) return "1080p";
        if (lower.includes("720p")) return "720p";
        if (lower.includes("480p")) return "480p";
        if (lower.includes("360p")) return "360p";
        if (lower.includes("320p")) return "320p";
        if (lower.includes("240p")) return "240p";
        if (lower.includes("3gp")) return "3gp";
        return "Auto";
    }

    function extractSizeFromHtml(html) {
        const cleanHtml = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
        const sizeMatch = /File\s*Size\s*:\s*([\d.]+)\s*(MB|GB|KB)/i.exec(cleanHtml);
        if (sizeMatch) {
            const value = parseFloat(sizeMatch[1]);
            const unit = sizeMatch[2].toUpperCase();
            if (unit === "GB") return Math.round(value * 1073741824);
            if (unit === "MB") return Math.round(value * 1048576);
            if (unit === "KB") return Math.round(value * 1024);
        }
        return 0;
    }

    function formatSize(bytes) {
        if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(1) + " GB";
        if (bytes >= 1048576) return Math.round(bytes / 1048576) + " MB";
        if (bytes >= 1024) return Math.round(bytes / 1024) + " KB";
        return "";
    }

    function isSeriesContent(title, url) {
        const lower = ((title || "") + " " + (url || "")).toLowerCase();
        return /season|episodes?|eps|all episodes|web series/i.test(lower);
    }

    function parseMovieList(html) {
        const results = [];
        const seenUrls = new Set();
        
        const linkRegex = /href=["']([^"']*\/movie\/[^"']*)["'][^>]*>([^<]+)<\/a>/g;
        let match;
        
        while ((match = linkRegex.exec(html)) !== null) {
            const href = match[1];
            if (!href.includes("/movie/")) continue;
            
            let title = decodeHtml(match[2].trim());
            
            if (!title || title.length < 2) {
                title = href.split("/").pop()
                    .replace(".html", "")
                    .replace(/-/g, " ")
                    .replace(/\(/g, " (")
                    .replace(/\s+/g, " ")
                    .trim();
            }
            
            if (!title || title.length < 2) continue;
            if (seenUrls.has(href)) continue;
            seenUrls.add(href);
            
            const isSeries = isSeriesContent(title, href);
            
            results.push(new MultimediaItem({
                title: title,
                url: fixUrl(href),
                posterUrl: "",
                type: isSeries ? "series" : "movie"
            }));
        }
        
        return results;
    }

    async function getHome(cb) {
        try {
            const categories = [
                { name: "Telugu (2026) Movies", path: "/category/Telugu-(2026)-Movies.html" },
                { name: "Telugu (2025) Movies", path: "/category/Telugu-(2025)-Movies.html" },
                { name: "Tamil (2026) Movies", path: "/category/Tamil-(2026)-Movies.html" },
                { name: "Tamil (2025) Movies", path: "/category/Tamil-(2025)-Movies.html" },
                { name: "Telugu Dubbed Hollywood", path: "/category/Telugu-Dubbed-Movies-[Hollywood].html" },
                { name: "HOT Web Series", path: "/category/HOT-Web-Series.html" }
            ];

            const homeData = {};
            
            for (const cat of categories) {
                try {
                    const url = getBaseUrl() + cat.path;
                    const res = await http_get(url, EXTERNAL_HEADERS);
                    
                    if (res.status === 200) {
                        const items = parseMovieList(res.body);
                        if (items.length > 0) {
                            homeData[cat.name] = items;
                        }
                    }
                } catch (e) {
                    console.error(`Error fetching ${cat.name}:`, e.message);
                }
            }

            if (Object.keys(homeData).length === 0) {
                cb({ success: false, errorCode: "SITE_OFFLINE", message: "Could not load any categories" });
            } else {
                cb({ success: true, data: homeData });
            }
        } catch (e) {
            cb({ success: false, errorCode: "PARSE_ERROR", message: e.message });
        }
    }

    async function search(query, cb) {
        try {
            const fixedQuery = query.replace(/\s+/g, "+");
            const searchUrl = getBaseUrl() + "/search.php?q=" + encodeURIComponent(fixedQuery);
            
            const res = await http_get(searchUrl, EXTERNAL_HEADERS);
            
            if (res.status !== 200) {
                cb({ success: true, data: [] });
                return;
            }
            
            const items = parseMovieList(res.body);
            cb({ success: true, data: items });
        } catch (e) {
            console.error("Search error:", e.message);
            cb({ success: true, data: [] });
        }
    }

    async function load(url, cb) {
        try {
            const res = await http_get(url, EXTERNAL_HEADERS);
            
            if (res.status !== 200) {
                cb({ success: false, errorCode: "SITE_OFFLINE" });
                return;
            }
            
            const html = res.body;
            
            const titleMatch = /<h2[^>]*>([^<]+)<\/h2>/i.exec(html) ||
                              /<title>([^<]+)/i.exec(html) ||
                              /<h1[^>]*>([^<]+)<\/h1>/i.exec(html);
            let title = titleMatch ? decodeHtml(titleMatch[1].trim()) : "Unknown Title";
            title = title.split("-")[0].trim();
            
            const posterMatch = /<img[^>]+src=["']([^"']*\/poster\/[^"']*)["'][^>]*>/i.exec(html) ||
                               /og:image["']\s*content=["']([^"']+)["']/i.exec(html);
            const poster = posterMatch ? posterMatch[1] : "";
            
            let description = "";
            const descMatch = /Desc\/Plot[^<]*<\/td>\s*<td[^>]*>([^<]+)/i.exec(html) ||
                             /<p[^>]*>([\s\S]{10,500}?)<\/p>/i.exec(html);
            if (descMatch) {
                description = decodeHtml(descMatch[1].replace(/<[^>]+>/g, "").trim());
            }
            
            let year = null;
            const yearMatch = /(\d{4})/.exec(html);
            if (yearMatch) {
                year = parseInt(yearMatch[1]);
            }
            
            const isSeries = isSeriesContent(title, url);
            
            const seasonLinkRegex = /<a[^>]+href=["']([^"']*\/movie\/[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
            const seasonLinks = [];
            let match;
            while ((match = seasonLinkRegex.exec(html)) !== null) {
                const linkUrl = match[1];
                const linkText = decodeHtml(match[2].replace(/<[^>]+>/g, "").trim());
                if (linkUrl !== url && linkUrl.includes("/movie/")) {
                    seasonLinks.push({ url: fixUrl(linkUrl), text: linkText });
                }
            }
            
            if (isSeries && seasonLinks.length > 0) {
                const episodes = [];
                
                for (const link of seasonLinks) {
                    const episodeTitle = link.text;
                    const episodeUrl = link.url;
                    
                    const seasonMatch = /Season\s*(\d+)/i.exec(episodeTitle);
                    const episodeMatch = /Eps?\s*\(?(\d+)/i.exec(episodeTitle);
                    
                    const season = seasonMatch ? parseInt(seasonMatch[1]) : 1;
                    const episode = episodeMatch ? parseInt(episodeMatch[1]) : episodes.length + 1;
                    
                    episodes.push(new Episode({
                        name: episodeTitle || `Episode ${episodes.length + 1}`,
                        url: episodeUrl,
                        season: season,
                        episode: episode
                    }));
                }
                
                episodes.sort((a, b) => (a.season - b.season) || (a.episode - b.episode));
                
                cb({ 
                    success: true, 
                    data: new MultimediaItem({
                        title: title,
                        url: url,
                        posterUrl: poster ? fixUrl(poster) : "",
                        type: "series",
                        description: description,
                        year: year,
                        episodes: episodes
                    })
                });
            } else {
                const downloadLinks = [];
                
                const downloadLinkRegex = /href=["']([^"']*dwload\.php[^"']*)["'][^>]*>([^<]+)</g;
                let dlMatch;
                while ((dlMatch = downloadLinkRegex.exec(html)) !== null) {
                    const originalHref = dlMatch[1];
                    const transformedHref = originalHref.replace("dwload.php", "download.php");
                    const linkText = decodeHtml(dlMatch[2].trim());
                    const quality = extractQuality(linkText);
                    
                    downloadLinks.push({
                        url: fixUrl(transformedHref),
                        quality: quality,
                        text: linkText
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
                        episodes: [{
                            name: "Full Movie",
                            url: JSON.stringify(downloadLinks),
                            season: 1,
                            episode: 1
                        }]
                    })
                });
            }
        } catch (e) {
            console.error("Load error:", e);
            cb({ success: false, errorCode: "PARSE_ERROR", message: e.message });
        }
    }

    async function extractDownloadLink(pageUrl, quality) {
        try {
            const res = await http_get(pageUrl, EXTERNAL_HEADERS);
            
            if (res.status !== 200) {
                return { url: pageUrl, quality: quality, size: 0 };
            }
            
            const html = res.body;
            const size = extractSizeFromHtml(html);
            
            const fastDownloadMatch = /href=['"]([^'"]+)['"][^>]*>\s*<[^>]*>\s*<[^>]*>\s*Fast Download Server/i.exec(html);
            
            if (fastDownloadMatch && fastDownloadMatch[1]) {
                const url = fixUrl(fastDownloadMatch[1]);
                const urlQuality = extractQuality(url);
                return { url: url, quality: urlQuality, size: size };
            }
            
            const directLinkMatch = /href=['"]([^'"]+\.(?:mp4|mkv|m3u8)[^'"]*)['"]/i.exec(html) ||
                                   /href=['"]([^'"]*10g\d+[^'"]*)['"]/i.exec(html);
            if (directLinkMatch && directLinkMatch[1].startsWith('http')) {
                const url = directLinkMatch[1];
                const urlQuality = extractQuality(url);
                return { url: url, quality: urlQuality, size: size };
            }
            
            return { url: pageUrl, quality: quality, size: size };
        } catch (e) {
            return { url: pageUrl, quality: quality, size: 0 };
        }
    }

    async function loadStreams(dataStr, cb) {
        try {
            const streams = [];
            
            let linksToProcess = [];
            
            try {
                const parsed = JSON.parse(dataStr);
                if (Array.isArray(parsed)) {
                    linksToProcess = parsed;
                } else {
                    linksToProcess = [dataStr];
                }
            } catch (e) {
                linksToProcess = [dataStr];
            }
            
            const processingTasks = [];
            
            for (const item of linksToProcess) {
                if (typeof item === "string") {
                    processingTasks.push(processStreamUrl(item, "Auto"));
                } else if (item.url) {
                    processingTasks.push(processStreamUrl(item.url, extractQuality(item.text || item.url)));
                }
            }
            
            const results = await Promise.all(processingTasks);
            
            for (const result of results) {
                if (result.url) {
                    const sizeStr = result.size > 0 ? " • " + formatSize(result.size) : "";
                    const sourceName = `Moviezwap (${result.quality})${sizeStr}`;
                    
                    streams.push(new StreamResult({
                        url: result.url,
                        quality: result.quality,
                        source: sourceName,
                        headers: EXTERNAL_HEADERS
                    }));
                }
            }
            
            if (streams.length === 0) {
                cb({ success: true, data: [] });
            } else {
                cb({ success: true, data: streams });
            }
        } catch (e) {
            console.error("LoadStreams error:", e);
            cb({ success: true, data: [] });
        }
    }

    async function processStreamUrl(url, quality) {
        try {
            if (!url || typeof url !== "string") {
                return { url: "", quality: quality, size: 0 };
            }
            
            if (url.includes("download.php")) {
                return await extractDownloadLink(url, quality);
            }
            
            if (url.includes("hubcloud") || url.includes("hub.") || url.includes("gamerxyt")) {
                return await extractHubCloud(url, quality);
            }
            
            if (url.includes("streamtape") || url.includes("streamja")) {
                return await extractStreamTape(url, quality);
            }
            
            if (url.includes("pixeldrain")) {
                return await extractPixelDrain(url, quality);
            }
            
            if (url.includes("dood") || url.includes("doodstream")) {
                return { url: url, quality: quality, size: 0 };
            }
            
            if (url.includes("gdrive") || url.includes("drive.google")) {
                return { url: url, quality: quality, size: 0 };
            }
            
            if (url.match(/\.(mp4|mkv|m3u8)$/i)) {
                return { url: url, quality: quality, size: 0 };
            }
            
            const res = await http_get(url, EXTERNAL_HEADERS);
            if (res.status === 200) {
                const linkMatch = /href=["']([^"']+\.(?:mp4|mkv|m3u8)[^"']*)["']/i.exec(res.body);
                if (linkMatch) {
                    return { url: fixUrl(linkMatch[1]), quality: quality, size: 0 };
                }
            }
            
            return { url: url, quality: quality, size: 0 };
        } catch (e) {
            console.error("Process stream error:", e.message);
            return { url: url, quality: quality, size: 0 };
        }
    }

    async function extractHubCloud(url, quality) {
        try {
            const res = await http_get(url, EXTERNAL_HEADERS);
            
            if (res.status !== 200) {
                return { url: url, quality: quality, size: 0 };
            }
            
            const body = res.body;
            
            const varUrlMatch = /var\s+url\s*=\s*['"]([^'"]+)['"]/i.exec(body);
            if (varUrlMatch) {
                return { url: fixUrl(varUrlMatch[1]), quality: quality, size: 0 };
            }
            
            const redirectMatch = /window\.location\.href\s*=\s*["']([^"']+)["']/i.exec(body);
            if (redirectMatch) {
                return await extractHubCloud(fixUrl(redirectMatch[1]), quality);
            }
            
            return { url: url, quality: quality, size: 0 };
        } catch (e) {
            return { url: url, quality: quality, size: 0 };
        }
    }

    async function extractStreamTape(url, quality) {
        try {
            const res = await http_get(url, EXTERNAL_HEADERS);
            
            if (res.status !== 200) {
                return { url: url, quality: quality, size: 0 };
            }
            
            const robotLinkMatch = /getElementById\(['"]robotlink['"]\)\.innerHTML\s*=\s*['"]([^'"]+)['"]/.exec(res.body);
            
            if (robotLinkMatch) {
                let videoUrl = robotLinkMatch[1];
                if (videoUrl.startsWith("//")) {
                    videoUrl = "https:" + videoUrl;
                }
                return { url: videoUrl, quality: quality, size: 0 };
            }
            
            return { url: url, quality: quality, size: 0 };
        } catch (e) {
            return { url: url, quality: quality, size: 0 };
        }
    }

    async function extractPixelDrain(url, quality) {
        try {
            const idMatch = /\/u\/([a-zA-Z0-9]+)/.exec(url);
            
            if (idMatch) {
                const downloadUrl = `https://pixeldrain.com/api/file/${idMatch[1]}?download`;
                return { url: downloadUrl, quality: quality, size: 0 };
            }
            
            return { url: url, quality: quality, size: 0 };
        } catch (e) {
            return { url: url, quality: quality, size: 0 };
        }
    }

    globalThis.getHome = getHome;
    globalThis.search = search;
    globalThis.load = load;
    globalThis.loadStreams = loadStreams;
})();
