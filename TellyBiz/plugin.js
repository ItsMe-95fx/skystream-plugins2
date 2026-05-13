(function() {
  "use strict";

  const BASE_URL = manifest.baseUrl || "https://tellybiz.in";
  const MOVIESWOOD_BASE = "https://movieswood.cloud";
  const TMDB_IMG = "https://image.tmdb.org/t/p/w500";
  const TMDB_IMG_ORIG = "https://image.tmdb.org/t/p/original";

  // Minimal headers - proven working with curl
  const MOBILE_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.134 Mobile Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9"
  };

  // Home sections - Telugu from tellybiz.in, rest from movieswood.cloud
  const HOME_SECTIONS = [
    { name: "Telugu", url: BASE_URL + "/", source: "tellybiz", baseUrl: BASE_URL },
    { name: "Dubbed", url: MOVIESWOOD_BASE + "/dubs/", source: "movieswood", baseUrl: MOVIESWOOD_BASE + "/dubs" },
    { name: "English", url: MOVIESWOOD_BASE + "/eng/", source: "movieswood", baseUrl: MOVIESWOOD_BASE + "/eng" },
    { name: "Bollywood", url: MOVIESWOOD_BASE + "/bolly/", source: "movieswood", baseUrl: MOVIESWOOD_BASE + "/bolly" },
    { name: "Webseries", url: MOVIESWOOD_BASE + "/web/", source: "movieswood", baseUrl: MOVIESWOOD_BASE + "/web" },
    { name: "Malayalam", url: MOVIESWOOD_BASE + "/malayalam/", source: "movieswood", baseUrl: MOVIESWOOD_BASE + "/malayalam" },
    { name: "Kannada", url: MOVIESWOOD_BASE + "/kannada/", source: "movieswood", baseUrl: MOVIESWOOD_BASE + "/kannada" }
  ];

  async function fetchHtml(url) {
    try {
      const res = await http_get(url, Object.assign({}, MOBILE_HEADERS));
      return res.body || "";
    } catch (e) {
      console.error("fetchHtml error:", e.message);
      return "";
    }
  }

  // Fetch with automatic fallback to /index.php or movieswood mirror
  async function fetchSmart(url) {
    // Try primary URL first
    try {
      const html = await fetchHtml(url);
      if (html && html.length > 500 && !html.includes('<title></title>')) {
        return html;
      }
    } catch (e) {
      console.warn("Primary URL failed:", url);
    }
    
    // Try with /index.php appended
    var altUrl;
    if (url.endsWith("/")) {
      altUrl = url + "index.php";
    } else if (!url.endsWith(".php")) {
      altUrl = url + "/index.php";
    }
    
    if (altUrl && altUrl !== url) {
      try {
        console.log("Trying:", altUrl);
        const html = await fetchHtml(altUrl);
        if (html && html.length > 500) {
          return html;
        }
      } catch (e) {
        console.warn("Alt URL failed:", altUrl);
      }
    }
    
    // Try https://movieswood.cloud equivalent for tellybiz URLs
    if (url.includes("tellybiz.in")) {
      var mwUrl;
      if (url === BASE_URL + "/" || url === BASE_URL) {
        mwUrl = MOVIESWOOD_BASE + "/telugu/index.php";
      } else {
        mwUrl = url.replace("tellybiz.in", "movieswood.cloud");
        if (!mwUrl.endsWith(".php")) {
          mwUrl = mwUrl.replace(/\/+$/, "") + "/index.php";
        }
      }
      try {
        console.log("Trying movieswood mirror:", mwUrl);
        const html = await fetchHtml(mwUrl);
        if (html && html.length > 500) return html;
      } catch (e) {}
    }
    
    return "";
  }

  // Parse movie cards from HTML
  function parseMovieCards(html, baseUrl) {
    const items = [];

    // Match movie card pattern: <a href="loanid.php?lid=..." class="movie-card">
    const cardRegex = /<a[^>]*href=["']([^"']*loanid\.php\?lid=[^"']*)["'][^>]*class=["']movie-card["']>([\s\S]*?)<\/a>/gi;
    let match;

    while ((match = cardRegex.exec(html)) !== null) {
      const loanUrl = match[1];
      const cardContent = match[2];

      // Extract title
      const titleMatch = cardContent.match(/class=["']movie-title["'][^>]*>([^<]*)/i);
      const title = titleMatch ? titleMatch[1].trim() : "";

      // Extract poster
      const posterMatch = cardContent.match(/<img[^>]*src=["']([^"']+)["'][^>]*class=["']movie-poster["']/i);
      const posterUrl = posterMatch ? posterMatch[1] : "";

      // Extract rating
      const ratingMatch = cardContent.match(/class=["']rating-badge["'][^>]*>★\s*([\d.]+)/i);
      const score = ratingMatch ? parseFloat(ratingMatch[1]) : undefined;

      // Extract year
      const yearMatch = cardContent.match(/class=["']movie-year["'][^>]*>(\d{4})/i);
      const year = yearMatch ? parseInt(yearMatch[1]) : undefined;

      if (title) {
        // Build correct full URL - avoid double slashes
        let fullUrl;
        if (loanUrl.startsWith("http")) {
          fullUrl = loanUrl;
        } else if (loanUrl.startsWith("/")) {
          fullUrl = baseUrl + loanUrl;
        } else {
          fullUrl = baseUrl.replace(/\/+$/, "") + "/" + loanUrl;
        }
        
        items.push(new MultimediaItem({
          title: title,
          url: fullUrl,
          posterUrl: posterUrl || "",
          type: "movie",
          year: year,
          score: score
        }));
      }
    }

    return items;
  }

  // Parse detail page to extract metadata
  function parseDetailPage(html, pageUrl) {
    const info = {};

    // Determine base URL from the page URL
    let baseUrl;
    if (pageUrl.includes("movieswood")) {
      // Extract the subdirectory: /dubs/ /eng/ /telugu/ etc
      const subMatch = pageUrl.match(/(https?:\/\/movieswood\.cloud\/[^\/]+)\//i);
      baseUrl = subMatch ? subMatch[1] : MOVIESWOOD_BASE;
    } else {
      baseUrl = BASE_URL;
    }

    // Title
    const titleMatch = html.match(/class=["']movie-title["'][^>]*>([^<]*)/i) ||
                       html.match(/<title>([^<]*)/i);
    info.title = titleMatch ? titleMatch[1].replace(/\s*-\s*(?:TellyBiz|MoviesWood).*$/, '').trim() : "";

    // Poster
    const posterMatch = html.match(/<img[^>]*src=["']([^"']+(?:tmdb|image)[^"']*)["'][^>]*class=["']poster["']/i) ||
                        html.match(/<img[^>]*src=["']([^"']+tmdb[^"']*)["']/i);
    info.posterUrl = posterMatch ? posterMatch[1] : "";

    // Rating
    const ratingMatch = html.match(/class=["']rating["'][^>]*>★\s*([\d.]+)/i) ||
                        html.match(/class=["']rating["'][^>]*>([\d.]+)/i);
    info.score = ratingMatch ? parseFloat(ratingMatch[1]) : undefined;

    // Year
    const yearMatch = html.match(/(\d{4})/);
    info.year = yearMatch ? parseInt(yearMatch[1]) : undefined;

    // Overview/description
    const overviewMatch = html.match(/class=["']overview["'][^>]*>([\s\S]*?)<\/div>/i);
    info.description = overviewMatch ? overviewMatch[1].replace(/<[^>]*>/g, '').trim() : "";

    // Genres
    const genres = [];
    const genreMatches = html.matchAll(/class=["']genre-tag["'][^>]*>([^<]*)/gi);
    for (const g of genreMatches) {
      genres.push(g[1].trim());
    }
    info.genres = genres;

    // Download links (loanagreement.php?f=0, f=1, f=2 etc)
    const downloadLinks = [];
    const dlRegex = /href=["']([^"']*loanagreement\.php\?lid=[^&]*&f=(\d+)[^"']*)["']/gi;
    let dlMatch;
    const qualityLabels = ["480p", "720p", "1080p", "2160p", "4K"];

    while ((dlMatch = dlRegex.exec(html)) !== null) {
      const dlUrl = dlMatch[1];
      const fIndex = parseInt(dlMatch[2]);

      // Build correct loanagreement URL
      let fullDlUrl;
      if (dlUrl.startsWith("http")) {
        fullDlUrl = dlUrl;
      } else if (dlUrl.startsWith("/")) {
        fullDlUrl = baseUrl + dlUrl;
      } else {
        fullDlUrl = baseUrl.replace(/\/+$/, "") + "/" + dlUrl;
      }

      downloadLinks.push({
        url: fullDlUrl,
        quality: qualityLabels[fIndex] || ("Quality " + (fIndex + 1)),
        fIndex: fIndex
      });
    }
    info.downloadLinks = downloadLinks;
    info.baseUrl = baseUrl;

    return info;
  }

  // Resolve loanagreement.php to get actual download URL
  // Also extracts episode info (season, episode, title) from CDN URL filenames
  async function resolveDownloadUrl(loanagreementUrl, qualityLabel) {
    try {
      const html = await fetchSmart(loanagreementUrl);
      if (!html) return { url: loanagreementUrl, quality: qualityLabel, resolution: "", size: "" };

      // The download link is in the HTML even though it's hidden (display:none)
      // Match: <a href="https://cdn.cdngo.site/..." class="download-btn" ...>
      // Need to handle multiline with [\s\S]*?
      const dlRegex = /<a[^>]*href=["'](https?:\/\/[^"']+\.(?:mkv|mp4|m3u8|avi|webm|mp3)[^"']*)["'][\s\S]*?class=["']download-btn["']/i;
      const dlMatch = html.match(dlRegex);

      // Extract size
      const sizeMatch = html.match(/<p><strong>([\d.]+\s*(?:MB|GB))<\/strong><\/p>/i);
      const size = sizeMatch ? sizeMatch[1] : "";

      // Extract filename from the page (fallback)
      const fileNameMatch = html.match(/<strong>([^<]+\.(?:mkv|mp4|avi|webm|mp3))<\/strong>/i);

      // Extract quality from the ACTUAL CDN URL (most reliable)
      const cdnUrl = dlMatch && dlMatch[1] ? dlMatch[1] : "";
      let resolution = "";
      let actualQuality = "";

      if (cdnUrl) {
        // Check the CDN URL for quality indicators (most reliable)
        const urlLower = cdnUrl.toLowerCase();
        if (urlLower.includes("2160") || urlLower.includes("4k") || urlLower.includes("uhd")) {
          resolution = "4K (2160p)";
          actualQuality = "4K (2160p)";
        } else if (urlLower.includes("1440")) {
          resolution = "QHD (1440p)";
          actualQuality = "QHD (1440p)";
        } else if (urlLower.includes("1080")) {
          resolution = "FHD (1080p)";
          actualQuality = "FHD (1080p)";
        } else if (urlLower.includes("720")) {
          resolution = "HD (720p)";
          actualQuality = "HD (720p)";
        } else if (urlLower.includes("480")) {
          resolution = "SD (480p)";
          actualQuality = "SD (480p)";
        } else if (urlLower.includes("360")) {
          resolution = "360p";
          actualQuality = "360p";
        } else if (urlLower.includes("700mb")) {
          resolution = "700MB";
          actualQuality = "700MB";
        } else if (urlLower.includes("800mb")) {
          resolution = "800MB";
          actualQuality = "800MB";
        } else if (urlLower.includes("1gb") || urlLower.includes("1000mb")) {
          resolution = "1GB";
          actualQuality = "1GB";
        } else if (urlLower.includes("1.4gb") || urlLower.includes("1.5gb")) {
          resolution = "1.5GB";
          actualQuality = "1.5GB";
        } else if (urlLower.includes("2gb") || urlLower.includes("1.8gb") || urlLower.includes("2.0gb")) {
          resolution = "2GB";
          actualQuality = "2GB";
        }
      }

      // Fallback: extract quality from file name on the page
      if (!resolution) {
        const fileName = fileNameMatch ? fileNameMatch[1] : "";
        if (fileName) {
          const nameLower = fileName.toLowerCase();
          if (nameLower.includes("2160") || nameLower.includes("4k") || nameLower.includes("uhd")) {
            resolution = "4K (2160p)";
            actualQuality = "4K (2160p)";
          } else if (nameLower.includes("1440")) {
            resolution = "QHD (1440p)";
            actualQuality = "QHD (1440p)";
          } else if (nameLower.includes("1080")) {
            resolution = "FHD (1080p)";
            actualQuality = "FHD (1080p)";
          } else if (nameLower.includes("720")) {
            resolution = "HD (720p)";
            actualQuality = "HD (720p)";
          } else if (nameLower.includes("480")) {
            resolution = "SD (480p)";
            actualQuality = "SD (480p)";
          } else if (nameLower.includes("360")) {
            resolution = "360p";
            actualQuality = "360p";
          } else if (nameLower.includes("700mb")) {
            resolution = "700MB";
            actualQuality = "700MB";
          } else if (nameLower.includes("800mb")) {
            resolution = "800MB";
            actualQuality = "800MB";
          } else if (nameLower.includes("1gb") || nameLower.includes("1000mb")) {
            resolution = "1GB";
            actualQuality = "1GB";
          }
        }
      }

      // Last fallback: use the original quality label
      if (!actualQuality) {
        if (qualityLabel === "4K" || qualityLabel === "2160p") actualQuality = "4K (2160p)";
        else if (qualityLabel === "1080p") actualQuality = "FHD (1080p)";
        else if (qualityLabel === "720p") actualQuality = "HD (720p)";
        else if (qualityLabel === "480p") actualQuality = "SD (480p)";
        else actualQuality = qualityLabel || "Auto";
      }

      if (!resolution) resolution = actualQuality;

      const actualUrl = cdnUrl || loanagreementUrl;
      const fileName = fileNameMatch ? fileNameMatch[1] : "";

      
      var episodeInfo = null;
      if (cdnUrl) {
        // Extract the filename portion from the URL (last path segment)
        var urlParts = cdnUrl.split("/");
        var fileNameFromUrl = urlParts[urlParts.length - 1];
        var nameForParse = decodeURIComponent(fileNameFromUrl || "").replace(/\.[^.]+$/, ""); // strip extension

        var sNum = null;
        var eNum = null;
        var epTitle = "";

        // Pattern 1: S##_EP_##  (e.g., S02_EP_01)
        var match1 = nameForParse.match(/S(\d+)[_.\- ]+EP[_.\- ]+(\d+)/i);
        if (match1) {
          sNum = parseInt(match1[1], 10);
          eNum = parseInt(match1[2], 10);
        }

        // Pattern 2: S##E##  (e.g., S02E03)
        if (sNum === null) {
          var match2 = nameForParse.match(/S(\d+)E(\d+)/i);
          if (match2) {
            sNum = parseInt(match2[1], 10);
            eNum = parseInt(match2[2], 10);
          }
        }

        // If we found season+episode, try to extract the episode title
        if (sNum !== null && eNum !== null) {
          // For S##E## pattern, title usually follows after: S02E03_The_Scales_and_The_Sword
          var match3 = nameForParse.match(/S\d+E\d+[_.\- ]+(.+)/i);
          if (match3) {
            epTitle = match3[1].replace(/[_.\-]/g, " ").trim();
          }
          // For S##_EP_## pattern, title usually follows after: S02_EP_01_1080p_tel_Tam...
          // Try to get text after EP info
          var match4 = nameForParse.match(/S\d+[_.\- ]+EP[_.\- ]+\d+[_.\- ]+(.+)/i);
          if (match4) {
            epTitle = match4[1].replace(/[_.\-]/g, " ").trim();
            // Remove quality tags from title
            epTitle = epTitle.replace(/\b(1080p|720p|480p|2160p|4K|HD|FHD|SD)\b/gi, "").trim();
            // Remove language tags
            epTitle = epTitle.replace(/\b(tel|tam|hin|eng|mal|kan|dub|dubbed)\b/gi, "").trim();
            // Clean up trailing/leading dashes or spaces
            epTitle = epTitle.replace(/[\s\-]+$/, "").trim();
          }
        }

        if (sNum !== null && eNum !== null) {
          episodeInfo = {
            season: sNum,
            episode: eNum,
            title: epTitle || ""
          };
        }
      }

      console.log("Resolved:", actualUrl, "Quality:", actualQuality, "Size:", size, "Episode:", episodeInfo ? ("S" + episodeInfo.season + "E" + episodeInfo.episode) : "N/A");

      return {
        url: actualUrl,
        quality: actualQuality,
        resolution: resolution,
        size: size,
        fileName: fileName,
        episodeInfo: episodeInfo
      };
    } catch (e) {
      console.error("resolveDownloadUrl error:", e.message);
      return { url: loanagreementUrl, quality: qualityLabel || "Auto", resolution: "", size: "", episodeInfo: null };
    }
  }

  // ============================================================
  // MAIN FUNCTIONS
  // ============================================================

  async function getHome(cb) {
    try {
      const categories = {};
      console.log("=== Tellybiz Plugin: Loading Home ===");

      for (const section of HOME_SECTIONS) {
        try {
          console.log("Loading:", section.name, "from", section.url);
          const html = await fetchSmart(section.url);

          if (html && html.length > 500) {
            const items = parseMovieCards(html, section.baseUrl);
            if (items.length > 0) {
              categories[section.name] = items;
              console.log("  Loaded", items.length, "items");
            } else {
              console.log("  No items parsed for", section.name);
            }
          } else {
            console.log("  Empty response for", section.name, "(" + html.length + " bytes)");
          }
        } catch (e) {
          console.error("Error loading", section.name, ":", e.message);
        }
      }

      // Don't fail if at least one category loaded
      if (Object.keys(categories).length === 0) {
        cb({ success: false, errorCode: "HOME_ERROR", message: "Failed to load any categories. All sources returned empty responses." });
      } else {
        console.log("=== Home: " + Object.keys(categories).length + " categories loaded ===");
        cb({ success: true, data: categories });
      }
    } catch (e) {
      console.error("getHome fatal error:", e.message);
      cb({ success: false, errorCode: "HOME_ERROR", message: e.message });
    }
  }

  async function search(query, cb) {
    try {
      const results = [];
      const q = encodeURIComponent(query);

      // Search tellybiz
      const tellybizHtml = await fetchSmart(BASE_URL + "/?s=" + q);
      if (tellybizHtml && tellybizHtml.length > 500) {
        const items = parseMovieCards(tellybizHtml, BASE_URL);
        results.push(...items);
      }

      // Search each movieswood subdirectory
      for (const section of HOME_SECTIONS) {
        if (section.source === "movieswood") {
          const searchUrl = section.baseUrl + "/?s=" + q;
          const html = await fetchSmart(searchUrl);
          if (html && html.length > 500) {
            const items = parseMovieCards(html, section.baseUrl);
            results.push(...items);
          }
        }
      }

      cb({ success: true, data: results });
    } catch (e) {
      cb({ success: false, errorCode: "SEARCH_ERROR", message: e.message });
    }
  }

  async function load(url, cb) {
    try {
      console.log("Loading:", url);
      const html = await fetchSmart(url);

      if (!html || html.length < 500) {
        cb({ success: false, errorCode: "LOAD_ERROR", message: "Failed to load page" });
        return;
      }

      const info = parseDetailPage(html, url);

      // Only /web/ paths are series - everything else is movie
      const isSeries = url.includes("/web/");

      const item = new MultimediaItem({
        title: info.title || "Unknown",
        url: url,
        posterUrl: info.posterUrl || "",
        type: isSeries ? "series" : "movie",
        year: info.year,
        score: info.score,
        description: info.description,
        genres: info.genres || []
      });

      if (isSeries && info.downloadLinks && info.downloadLinks.length > 0) {
        console.log("Series detected:", info.title);
        
        // For series: resolve ALL download links to extract S##E## from CDN URLs
        // Each f= is a DIFFERENT episode with its own quality
        var episodes = [];
        var seasonNum = 1;

        for (var i = 0; i < info.downloadLinks.length; i++) {
          var dl = info.downloadLinks[i];
          try {
            var resolved = await resolveDownloadUrl(dl.url, dl.quality);
            var s = resolved.episodeInfo ? resolved.episodeInfo.season : null;
            var e = resolved.episodeInfo ? resolved.episodeInfo.episode : null;
            var epTitle = resolved.episodeInfo ? resolved.episodeInfo.title : "";

            if (s != null && e != null) {
              seasonNum = s;
              episodes.push(new Episode({
                name: "S" + String(s).padStart(2, "0") + "E" + String(e).padStart(2, "0") + (epTitle ? " - " + epTitle : "") + " [" + resolved.quality + "]",
                url: resolved.url,
                season: s,
                episode: e
              }));
            } else {
              // Fallback: create episode from CDN URL file name
              var cdnUrl = resolved.url;
              var fileName = "";
              try { fileName = cdnUrl.split("/").pop().split(".")[0]; } catch(e) {}
              
              // Try to extract S##E## from filename
              var sM = fileName.match(/[Ss](\d+)[Ee_](\d+)/i) || fileName.match(/[Ss](\d+)[_-]EP[_-](\d+)/i);
              if (sM) {
                var ss = parseInt(sM[1]);
                var ee = parseInt(sM[2]);
                seasonNum = ss;
                episodes.push(new Episode({
                  name: "S" + String(ss).padStart(2, "0") + "E" + String(ee).padStart(2, "0") + " [" + resolved.quality + "]",
                  url: resolved.url,
                  season: ss,
                  episode: ee
                }));
              } else {
                // Ultimate fallback
                episodes.push(new Episode({
                  name: "Episode " + String(i + 1).padStart(2, "0") + " [" + resolved.quality + "]",
                  url: resolved.url,
                  season: 1,
                  episode: i + 1
                }));
              }
            }
          } catch (e) {
            console.error("Error resolving episode", i, ":", e.message);
          }
        }

        // Sort episodes by season and episode number
        episodes.sort(function(a, b) {
          if (a.season !== b.season) return a.season - b.season;
          return a.episode - b.episode;
        });

        if (episodes.length > 0) {
          item.episodes = episodes;
          console.log("Parsed", episodes.length, "episodes");
        } else {
          // All episodes failed to resolve
          item.episodes = [new Episode({
            name: info.title || "Watch",
            url: url,
            season: 1,
            episode: 1
          })];
        }
      } else {
        // Movies: single episode
        item.episodes = [new Episode({
          name: info.title || "Watch",
          url: url,
          season: 1,
          episode: 1
        })];
      }

      console.log("Loaded:", item.title, "type:", item.type, "episodes:", item.episodes.length);
      cb({ success: true, data: item });
    } catch (e) {
      cb({ success: false, errorCode: "LOAD_ERROR", message: e.message });
    }
  }

  async function loadStreams(url, cb) {
    try {
      console.log("=== loadStreams ===");
      console.log("URL:", url);
      
      const streams = [];

      // If URL is already a loanagreement.php link, resolve it directly
      if (url.includes("loanagreement.php")) {
        console.log("Direct loanagreement URL detected");
        const resolved = await resolveDownloadUrl(url, "Auto");
        const baseUrl = url.includes("movieswood") ? MOVIESWOOD_BASE : BASE_URL;
        
        streams.push(new StreamResult({
          url: resolved.url,
          quality: resolved.quality || "Auto",
          source: (url.includes("movieswood") ? "Movieswood" : "Tellybiz") + (resolved.size ? " [" + resolved.size + "]" : ""),
          headers: {
            "Referer": baseUrl + "/",
            "Origin": baseUrl,
            "User-Agent": MOBILE_HEADERS["User-Agent"],
            "Accept": "*/*"
          }
        }));
        console.log("Resolved:", resolved.url);
        cb({ success: true, data: streams });
        return;
      }

      // Otherwise, fetch the detail page and find download links
      const baseUrl = url.includes("movieswood") ? MOVIESWOOD_BASE : BASE_URL;

      console.log("Fetching page:", url);
      const html = await fetchSmart(url);

      if (!html || html.length < 500) {
        console.error("Page too short:", html.length, "bytes");
        cb({ success: false, errorCode: "STREAM_ERROR", message: "Failed to load page (" + html.length + " bytes)" });
        return;
      }

      console.log("Page size:", html.length, "bytes");
      const info = parseDetailPage(html, url);
      console.log("Title:", info.title);
      console.log("Download links:", info.downloadLinks ? info.downloadLinks.length : 0);
      console.log("Base URL:", info.baseUrl);
      
      if (info.downloadLinks && info.downloadLinks.length > 0) {
        info.downloadLinks.forEach(function(dl, i) {
          console.log("  Link " + (i+1) + ":", dl.url, "-> Quality:", dl.quality);
        });
      }

      const streamBaseUrl = info.baseUrl || (url.includes("movieswood") ? MOVIESWOOD_BASE : BASE_URL);

      // Resolve download links from loanagreement.php pages
      if (info.downloadLinks && info.downloadLinks.length > 0) {
        for (const dl of info.downloadLinks) {
          try {
            const resolved = await resolveDownloadUrl(dl.url, dl.quality);
            
            // Build descriptive source label
            var sourceLabel = url.includes("movieswood") ? "Movieswood" : "Tellybiz";
            var details = [];
            if (resolved.resolution) details.push(resolved.resolution);
            if (resolved.size) details.push(resolved.size);
            if (details.length > 0) sourceLabel += " [" + details.join(" • ") + "]";
            
            streams.push(new StreamResult({
              url: resolved.url,
              quality: resolved.quality || dl.quality || "Auto",
              source: sourceLabel,
              headers: {
                "Referer": streamBaseUrl + "/",
                "Origin": streamBaseUrl,
                "User-Agent": MOBILE_HEADERS["User-Agent"],
                "Accept": "*/*"
              }
            }));
          } catch (e) {
            console.error("Error resolving", dl.url, ":", e.message);
          }
        }
        console.log("Resolved", streams.length, "download links");
      }

      // Fallback: return the page URL itself
      if (streams.length === 0) {
        console.log("No streams resolved, using fallback");
        streams.push(new StreamResult({
          url: url,
          quality: "Auto",
          source: "Page",
          headers: {
            "Referer": streamBaseUrl + "/",
            "Origin": streamBaseUrl,
            "User-Agent": MOBILE_HEADERS["User-Agent"],
            "Accept": "*/*"
          }
        }));
      }

      console.log("=== Total streams:", streams.length, "===");
      cb({ success: true, data: streams });
    } catch (e) {
      cb({ success: false, errorCode: "STREAM_ERROR", message: e.message });
    }
  }

  globalThis.getHome = getHome;
  globalThis.search = search;
  globalThis.load = load;
  globalThis.loadStreams = loadStreams;
})();
