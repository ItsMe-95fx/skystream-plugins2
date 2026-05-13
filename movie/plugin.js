(function () {
  /**
   * 5Movierulz SkyStream Gen 2 Plugin — Telugu Focus
   * Full streaming: embed extraction, packed JS unpacking,
   * torrent/magnet fallback (≤1080p), multi-audio support
   */

  const UA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36";

  function getBaseUrl() {
    return (manifest && manifest.baseUrl) || "https://www.5movierulz.army";
  }

  function getHeaders(extra) {
    return Object.assign(
      {
        "User-Agent": UA,
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        Referer: getBaseUrl() + "/",
      },
      extra || {}
    );
  }

  // ─── URL Helpers ──────────────────────────────────────────────

  function normalizeUrl(url, base) {
    if (!url) return "";
    const raw = String(url).trim();
    if (!raw) return "";
    if (raw.startsWith("//")) return "https:" + raw;
    if (/^https?:\/\//i.test(raw)) return raw;
    if (raw.startsWith("/")) return (base || getBaseUrl()) + raw;
    return (base || getBaseUrl()) + "/" + raw;
  }

  function getOrigin(url) {
    try {
      return new URL(url).origin;
    } catch (_) {
      return "";
    }
  }

  // ─── Text Helpers ─────────────────────────────────────────────

  function htmlDecode(text) {
    if (!text) return "";
    return String(text)
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .replace(/&#039;/g, "'")
      .replace(/&apos;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&#(\d+);/g, (_, c) => String.fromCharCode(parseInt(c, 10)));
  }

  function textOf(el) {
    return htmlDecode((el?.textContent || "").replace(/\s+/g, " ").trim());
  }

  function getAttr(el, ...attrs) {
    if (!el) return "";
    for (const attr of attrs) {
      const v = el.getAttribute(attr);
      if (v && String(v).trim()) return String(v).trim();
    }
    return "";
  }

  function parseYear(text) {
    const m = String(text || "").match(/\b(19\d{2}|20\d{2})\b/);
    return m ? parseInt(m[1], 10) : undefined;
  }

  function cleanTitle(raw) {
    return htmlDecode(String(raw || ""))
      .replace(/\s+/g, " ")
      .trim();
  }

  function uniqueByUrl(items) {
    const out = [];
    const seen = new Set();
    for (const it of items || []) {
      if (!it?.url || seen.has(it.url)) continue;
      seen.add(it.url);
      out.push(it);
    }
    return out;
  }

  function extractQuality(text) {
    if (!text) return "";
    const t = text.toLowerCase();
    if (t.includes("2160") || t.includes("4k")) return "4K";
    if (t.includes("8k")) return "8K";
    if (t.includes("2k")) return "2K";
    if (t.includes("1080")) return "1080p";
    if (t.includes("720")) return "720p";
    if (t.includes("480")) return "480p";
    if (t.includes("360")) return "360p";
    if (t.includes("hdrip")) return "HDRip";
    if (t.includes("dvdscr")) return "DVDScr";
    if (t.includes("brrip")) return "BRRip";
    return "";
  }

  function isQualityTooHigh(quality) {
    if (!quality) return false;
    const q = quality.toLowerCase();
    return q === "4k" || q === "2k" || q === "8k" ||
           q.includes("2160") || q.includes("4320");
  }

  function extractLanguage(text) {
    if (!text) return "";
    const t = text.toLowerCase();
    if (t.includes("telugu")) return "Telugu";
    if (t.includes("tamil")) return "Tamil";
    if (t.includes("hindi")) return "Hindi";
    if (t.includes("malayalam")) return "Malayalam";
    if (t.includes("kannada")) return "Kannada";
    if (t.includes("bengali")) return "Bengali";
    if (t.includes("english")) return "English";
    if (t.includes("punjabi")) return "Punjabi";
    if (t.includes("dual audio") || t.includes("multi audio"))
      return "Multi Audio";
    return "";
  }

  // ─── HTTP Helpers ─────────────────────────────────────────────

  async function request(url, headers) {
    return http_get(url, { headers: getHeaders(headers) });
  }

  async function loadDoc(url, headers) {
    const res = await request(url, headers);
    return parseHtml(res.body);
  }

  async function fetchRawBody(url, headers) {
    const res = await request(url, headers);
    return res.body || "";
  }

  // ─── Dean Edwards Packer Unpacker ─────────────────────────────

  function itoaBase(num, radix) {
    const digits =
      "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
    if (num === 0) return "0";
    let result = "";
    while (num > 0) {
      result = digits[num % radix] + result;
      num = Math.floor(num / radix);
    }
    return result;
  }

  function unpackAll(html) {
    const results = [];
    const regex =
      /eval\(function\(p,a,c,k,e,(?:d|r)\)\{[^}]*\}\('((?:[^'\\]|\\.)*)'\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*'([^']*)'/g;
    let m;
    while ((m = regex.exec(html)) !== null) {
      try {
        let p = m[1].replace(/\\'/g, "'").replace(/\\\\/g, "\\");
        const a = parseInt(m[2], 10);
        let c = parseInt(m[3], 10);
        const k = m[4].split("|");
        while (c--) {
          if (k[c]) {
            const encoded = itoaBase(c, a);
            p = p.replace(new RegExp("\\b" + encoded + "\\b", "g"), k[c]);
          }
        }
        results.push(p);
      } catch (_) {}
    }
    return results;
  }

  // ─── Video URL extraction from text ───────────────────────────

  function extractVideoUrlsFromText(text) {
    const urls = [];
    const seen = new Set();
    if (!text) return urls;

    function addUrl(u) {
      u = u.replace(/\\\//g, "/");
      if (!seen.has(u) && u.startsWith("http")) {
        seen.add(u);
        urls.push(u);
      }
    }

    const patterns = [
      /file\s*:\s*"(https?:\/\/[^"]+)"/gi,
      /file\s*:\s*'(https?:\/\/[^']+)'/gi,
      /sources\s*:\s*\[\s*\{\s*file\s*:\s*"(https?:\/\/[^"]+)"/gi,
      /sources\s*:\s*\[\s*\{\s*file\s*:\s*'(https?:\/\/[^']+)'/gi,
      /src\s*:\s*"(https?:\/\/[^"]+\.(?:m3u8|mp4)[^"]*)"/gi,
      /src\s*:\s*'(https?:\/\/[^']+\.(?:m3u8|mp4)[^']*)'/gi,
      /source\s*:\s*"(https?:\/\/[^"]+\.(?:m3u8|mp4)[^"]*)"/gi,
    ];

    for (const pat of patterns) {
      let match;
      while ((match = pat.exec(text)) !== null) addUrl(match[1]);
    }

    const directPat =
      /https?:\/\/[^\s"'<>\\]+\.(?:m3u8|mp4)(?:\?[^\s"'<>\\]*)?/gi;
    let dm;
    while ((dm = directPat.exec(text)) !== null) addUrl(dm[0]);

    return urls;
  }

  // ─── Torrent / Magnet extraction (≤1080p only) ────────────────

  function extractTorrentLinks(doc, rawBody) {
    const torrents = [];
    const seen = new Set();

    function addTorrent(url, name) {
      if (!url || seen.has(url)) return;
      // Filter out high quality torrents
      const q = extractQuality(url + " " + name);
      if (isQualityTooHigh(q)) {
        console.log("[5Movierulz] Skipping high-quality torrent: " + q + " " + name);
        return;
      }
      seen.add(url);
      torrents.push({ url, name: name || "Torrent", type: "torrent", quality: q });
    }

    // Magnet links from raw HTML
    const magnetLinks = rawBody.match(/magnet:\?xt=[^\s"'<>]+/gi) || [];
    for (const mag of magnetLinks) {
      let name = "Torrent";
      const dnMatch = mag.match(/dn=([^&]+)/);
      if (dnMatch) name = decodeURIComponent(dnMatch[1].replace(/\+/g, " "));
      addTorrent(mag, name);
    }

    // <a> tags with magnet or .torrent
    const allAnchors = Array.from(doc.querySelectorAll("a[href]"));
    for (const a of allAnchors) {
      const href = getAttr(a, "href");
      if (!href) continue;
      if (href.startsWith("magnet:")) {
        addTorrent(href, textOf(a) || "Magnet Link");
      } else if (href.endsWith(".torrent") || href.includes("/torrent/")) {
        addTorrent(normalizeUrl(href), textOf(a) || "Torrent File");
      }
    }

    // Magnet in onclick/data attributes
    const magnetInAttrs =
      rawBody.match(/(?:href|onclick|data-url)\s*=\s*["'](magnet:\?xt=[^"']+)/gi) || [];
    for (const m of magnetInAttrs) {
      const urlMatch = m.match(/(magnet:\?xt=[^"']+)/);
      if (urlMatch) addTorrent(urlMatch[1], "Magnet");
    }

    return torrents;
  }

  // ─── Multi-audio detection ────────────────────────────────────

  function detectAudioInfo(doc, rawBody) {
    const headings = Array.from(doc.querySelectorAll("h2, h3, h4, h5, strong, b"));
    let language = "";
    let quality = "";
    for (const h of headings) {
      const text = textOf(h);
      if (!text) continue;
      const langMatch = text.match(
        /(?:single\s*links?|watch\s*online)\s*[-\u2013\u2014(]\s*([^)]+)/i
      );
      if (langMatch) {
        const info = langMatch[1].trim();
        quality = extractQuality(info) || quality;
        language = extractLanguage(text) || language;
      }
      if (/multi\s*audio|dual\s*audio/i.test(text)) language = "Multi Audio";
    }
    if (!language) language = extractLanguage(rawBody.substring(0, 3000));
    if (!quality) quality = extractQuality(rawBody.substring(0, 3000));
    return { language, quality };
  }

  // ─── Parsing: Movie cards ─────────────────────────────────────

  function parseBoxedFilm(card) {
    if (!card) return null;
    const a = card.querySelector("a[href]");
    if (!a) return null;
    const href = normalizeUrl(getAttr(a, "href"));
    if (!href || href === getBaseUrl() + "/" || href === getBaseUrl()) return null;
    if (
      href.includes("/category/") || href.includes("/language/") ||
      href.includes("/quality/") || href.includes("/download-movierulz") ||
      href.includes("#") || href.includes("/movies?")
    )
      return null;

    const img = card.querySelector("img");
    const title = cleanTitle(
      textOf(card.querySelector("p b, p strong")) ||
        getAttr(a, "title") ||
        getAttr(img, "alt", "title") ||
        textOf(a)
    );
    if (!title || title.length < 3) return null;

    const posterUrl = normalizeUrl(
      getAttr(img, "src", "data-src", "data-lazy-src")
    );
    const type = /series|season|episode/i.test(href + " " + title) ? "series" : "movie";

    return new MultimediaItem({
      title,
      url: href,
      posterUrl,
      type,
      contentType: type,
      year: parseYear(title),
    });
  }

  /**
   * Collect items from any page — handles both homepage (.boxed.film)
   * and category/search pages which may use different structures.
   */
  function collectItems(doc) {
    let found = [];

    // Primary: .boxed.film cards (homepage + category pages)
    const boxedCards = Array.from(doc.querySelectorAll(".boxed.film"));
    for (const card of boxedCards) {
      const item = parseBoxedFilm(card);
      if (item) found.push(item);
    }

    // Category page structure: li > div.boxed.film
    if (found.length < 3) {
      const lis = Array.from(
        doc.querySelectorAll(
          "#list li, .content li, .films li, .featured li, ul li"
        )
      );
      for (const li of lis) {
        const item = parseBoxedFilm(li);
        if (item) found.push(item);
      }
    }

    // Some category pages use .cont_display a directly
    if (found.length < 3) {
      const contDisplays = Array.from(doc.querySelectorAll(".cont_display"));
      for (const cd of contDisplays) {
        const parent = cd.closest("li") || cd.closest("div") || cd;
        const item = parseBoxedFilm(parent);
        if (item) found.push(item);
      }
    }

    // Fallback: any anchor with movie-like URL pattern
    if (found.length < 3) {
      const movieLinks = Array.from(
        doc.querySelectorAll('a[href*="movie-watch-online"]')
      );
      for (const a of movieLinks) {
        const container = a.closest("li") || a.closest("div") || a;
        const item = parseBoxedFilm(container);
        if (item) found.push(item);
      }
    }

    return uniqueByUrl(found);
  }

  // ─── getHome ──────────────────────────────────────────────────

  async function getHome(cb) {
    try {
      const base = getBaseUrl();
      const sections = [
        { name: "Telugu Featured", path: "/category/telugu-featured" },
        { name: "Telugu Featured (2)", path: "/category/telugu-featured/page/2" },
        { name: "Telugu Featured (3)", path: "/category/telugu-featured/page/3" },
        { name: "Telugu 2026", path: "/category/telugu-movies-2026" },
        { name: "Telugu 2025", path: "/category/telugu-movies-2025" },
        { name: "Telugu 2024", path: "/category/telugu-movies-2024" },
        { name: "Telugu Dubbed", path: "/language/telugu-dubbed" },
        { name: "Telugu Dubbed (2)", path: "/language/telugu-dubbed/page/2" },
        { name: "Latest", path: "" },
        { name: "Hollywood", path: "/category/hollywood-featured" },
      ];

      const homeData = {};

      for (const section of sections) {
        try {
          const url = section.path ? base + section.path : base;
          const doc = await loadDoc(url);
          const items = collectItems(doc);
          if (items.length > 0) {
            homeData[section.name] = items.slice(0, 30);
          }
        } catch (err) {
          console.error("[5Movierulz] getHome section error: " + section.name, err);
          homeData[section.name] = [];
        }
      }

      cb({ success: true, data: homeData });
    } catch (e) {
      cb({
        success: false,
        errorCode: "HOME_ERROR",
        message: String(e?.message || e),
      });
    }
  }

  // ─── search ───────────────────────────────────────────────────

  async function search(query, cb) {
    try {
      const raw = String(query || "").trim();
      if (!raw) return cb({ success: true, data: [] });
      const q = encodeURIComponent(raw);
      const searchUrl = getBaseUrl() + "/search_movies?s=" + q;
      const doc = await loadDoc(searchUrl);
      const items = collectItems(doc);
      cb({ success: true, data: uniqueByUrl(items).slice(0, 40) });
    } catch (e) {
      cb({
        success: false,
        errorCode: "SEARCH_ERROR",
        message: String(e?.message || e),
      });
    }
  }

  // ─── load ─────────────────────────────────────────────────────

  async function load(url, cb) {
    try {
      const target = normalizeUrl(url);
      const res = await request(target);
      const rawBody = res.body || "";
      const doc = await parseHtml(rawBody);

      const title = cleanTitle(
        textOf(doc.querySelector("h2.entry-title")) ||
          textOf(doc.querySelector("h1")) ||
          getAttr(doc.querySelector('meta[property="og:title"]'), "content") ||
          "Unknown"
      );

      const posterUrl = normalizeUrl(
        getAttr(doc.querySelector('meta[property="og:image"]'), "content") ||
          getAttr(
            doc.querySelector("article img, .entry-content img, #post img"),
            "src", "data-src"
          )
      );

      const description = cleanTitle(
        getAttr(doc.querySelector('meta[property="og:description"]'), "content") || ""
      );

      const contentType =
        /series|season|episode/i.test(target + " " + title) ? "series" : "movie";
      const year = parseYear(title + " " + description);

      const audioInfo = detectAudioInfo(doc, rawBody);
      const streamData = extractStreamDataFromPage(doc, rawBody, target);
      const torrentData = extractTorrentLinks(doc, rawBody);

      const allData = {
        streams: streamData,
        torrents: torrentData,
        pageUrl: target,
        language: audioInfo.language,
        quality: audioInfo.quality || extractQuality(title),
      };

      const item = new MultimediaItem({
        title,
        url: target,
        posterUrl,
        bannerUrl: posterUrl,
        description,
        type: contentType,
        contentType,
        year,
        episodes: [
          new Episode({
            name: title,
            url: JSON.stringify(allData),
            season: 1,
            episode: 1,
            posterUrl,
          }),
        ],
      });

      cb({ success: true, data: item });
    } catch (e) {
      cb({
        success: false,
        errorCode: "LOAD_ERROR",
        message: String(e?.message || e),
      });
    }
  }

  // ─── Stream data extraction from movie page ───────────────────

  function extractStreamDataFromPage(doc, rawBody, pageUrl) {
    const streams = [];
    const seen = new Set();

    function addStream(url, name, extra) {
      if (!url || seen.has(url)) return;
      const base = getBaseUrl();
      if (url.startsWith(base) && !url.includes("video")) return;
      if (url === "#" || url.endsWith("#")) return;
      seen.add(url);
      streams.push(Object.assign({ url, name: name || guessHostName(url) }, extra || {}));
    }

    // 1. var locations = [...]
    const locMatch = rawBody.match(/var\s+locations\s*=\s*\[([\s\S]*?)\]/i);
    if (locMatch) {
      const urlMatches = locMatch[1].match(/"([^"]+)"/g) || [];
      urlMatches.forEach((m, idx) => {
        let u = m.replace(/^"|"$/g, "").replace(/\\\//g, "/");
        addStream(u, "Player " + (idx + 1), { priority: 1 });
      });
    }

    // 2. Known host links
    const knownHosts = [
      "streamlare", "uperbox", "easysyncr", "streamwish",
      "filelions", "streamvin", "vcdnlare", "streamtape",
      "doodstream", "mixdrop", "upstream", "vtube", "vidoza",
      "supervideo", "fembed", "gdplayer", "embedsito",
      "watchfree", "123onlinewatch", "hubcloud", "gdflix",
      "gdlink", "hgcloud", "minochinos", "huntrexus",
      "vidhide", "streamruby", "embedwish", "wishembed",
      "strwish", "swdyu", "sfastwish", "flaswish",
    ];

    const allAnchors = Array.from(doc.querySelectorAll("a[href]"));
    for (const a of allAnchors) {
      const href = getAttr(a, "href");
      if (!href || !href.startsWith("http")) continue;
      const hrefLower = href.toLowerCase();
      const isKnownHost = knownHosts.some((h) => hrefLower.includes(h));
      if (isKnownHost) {
        const linkText = textOf(a) || "";
        let name = "";
        const dashMatch = linkText.match(
          /(?:watch\s*online|download)\s*[-\u2013\u2014]\s*(.+)/i
        );
        if (dashMatch) {
          name = dashMatch[1].trim();
        } else {
          name = guessHostName(href);
        }
        const parentText = textOf(a.parentElement) || "";
        const lang = extractLanguage(parentText + " " + linkText);
        addStream(href, name, { language: lang, priority: 2 });
      }
    }

    // 3. mv_button_css links
    const buttons = Array.from(doc.querySelectorAll("a.mv_button_css"));
    for (const btn of buttons) {
      const href = getAttr(btn, "href");
      if (href && href.startsWith("http")) {
        addStream(href, textOf(btn) || guessHostName(href), { priority: 2 });
      }
    }

    // 4. iframe sources
    const iframes = Array.from(doc.querySelectorAll("iframe[src]"));
    for (const iframe of iframes) {
      const src = getAttr(iframe, "src");
      if (src && src.startsWith("http")) {
        addStream(src, "Embedded Player", { priority: 1 });
      }
    }

    // 5. Fallback external links
    if (streams.length === 0) {
      const articleLinks = Array.from(
        doc.querySelectorAll("article a[href], .entry-content a[href], #post a[href]")
      );
      for (const a of articleLinks) {
        const href = getAttr(a, "href");
        if (!href || !href.startsWith("http")) continue;
        const base = getBaseUrl();
        if (href.startsWith(base)) continue;
        if (href.includes("google") || href.includes("facebook")) continue;
        addStream(href, textOf(a) || guessHostName(href), { priority: 3 });
      }
    }

    if (streams.length === 0) {
      streams.push({ url: pageUrl, name: "Page", isPageUrl: true });
    }

    streams.sort((a, b) => (a.priority || 99) - (b.priority || 99));
    return streams;
  }

  function guessHostName(url) {
    try {
      const hostname = new URL(url).hostname
        .replace(/^www\./, "")
        .replace(/^ww\d+\./, "");
      const parts = hostname.split(".");
      return parts.length > 1
        ? parts[parts.length - 2].charAt(0).toUpperCase() +
            parts[parts.length - 2].slice(1)
        : hostname;
    } catch (_) {
      return "Unknown";
    }
  }

  // ─── loadStreams ──────────────────────────────────────────────

  async function loadStreams(url, cb) {
    try {
      const streams = [];
      let payload;

      try {
        payload = JSON.parse(url);
      } catch (_) {
        payload = { streams: [{ url: url, name: "Direct" }], torrents: [] };
      }

      if (Array.isArray(payload)) {
        payload = { streams: payload, torrents: [] };
      }

      const streamItems = payload.streams || [];
      const torrentItems = payload.torrents || [];
      const pageUrl = payload.pageUrl || getBaseUrl();
      const globalLang = payload.language || "";
      const globalQuality = payload.quality || "";

      // ── Process each stream source ──
      for (const item of streamItems) {
        const streamUrl = typeof item === "string" ? item : item.url || "";
        const streamName = typeof item === "string" ? "Direct" : item.name || "Direct";
        const isPageUrl = item.isPageUrl === true;
        const itemLang = item.language || globalLang;

        if (!streamUrl) continue;

        const langTag = itemLang ? " [" + itemLang + "]" : "";
        const qualTag = globalQuality ? " [" + globalQuality + "]" : "";

        try {
          if (isPageUrl) {
            const ps = await extractStreamsFromMoviePage(streamUrl);
            streams.push(...ps);
          } else if (streamUrl.includes(".m3u8") || streamUrl.includes("t=hls")) {
            streams.push(
              new StreamResult({
                url: streamUrl,
                source: streamName + " (HLS)" + qualTag + langTag,
                headers: { Referer: pageUrl, "User-Agent": UA },
              })
            );
          } else if (streamUrl.includes(".mp4")) {
            streams.push(
              new StreamResult({
                url: streamUrl,
                source: streamName + " (MP4)" + qualTag + langTag,
                headers: { Referer: pageUrl, "User-Agent": UA },
              })
            );
          } else {
            const extracted = await extractFromEmbedPage(
              streamUrl, streamName, itemLang, globalQuality
            );
            if (extracted.length > 0) {
              streams.push(...extracted);
            } else {
              streams.push(
                new StreamResult({
                  url: streamUrl,
                  source: streamName + qualTag + langTag,
                  headers: { Referer: pageUrl, "User-Agent": UA },
                })
              );
            }
          }
        } catch (err) {
          console.error("[5Movierulz] Stream processing error: " + streamUrl, err);
          streams.push(
            new StreamResult({
              url: streamUrl,
              source: streamName + " (Fallback)" + qualTag + langTag,
              headers: { Referer: pageUrl, "User-Agent": UA },
            })
          );
        }
      }

      // ── Torrent fallback (≤1080p only) ──
      // Filter out any 2K/4K/8K torrents
      const filteredTorrents = torrentItems.filter((t) => {
        const q = extractQuality((t.url || "") + " " + (t.name || ""));
        return !isQualityTooHigh(q);
      });

      if (streams.length === 0 && filteredTorrents.length > 0) {
        // No streams at all → use torrents as primary
        console.log(
          "[5Movierulz] No streams found, using " +
            filteredTorrents.length +
            " torrent(s) as fallback"
        );
        for (const t of filteredTorrents) {
          const qualTag = t.quality ? " [" + t.quality + "]" : "";
          streams.push(
            new StreamResult({
              url: t.url,
              source: "🧲 Torrent - " + (t.name || "Magnet") + qualTag,
              headers: {},
            })
          );
        }
      } else if (filteredTorrents.length > 0) {
        // Also add torrents as extra options below streams
        for (const t of filteredTorrents) {
          const qualTag = t.quality ? " [" + t.quality + "]" : "";
          streams.push(
            new StreamResult({
              url: t.url,
              source: "🧲 Torrent - " + (t.name || "Magnet") + qualTag,
              headers: {},
            })
          );
        }
      }

      cb({ success: true, data: streams });
    } catch (e) {
      cb({
        success: false,
        errorCode: "STREAM_ERROR",
        message: String(e?.message || e),
      });
    }
  }

  // ─── Re-fetch movie page for streams ──────────────────────────

  async function extractStreamsFromMoviePage(pageUrl) {
    const streams = [];
    try {
      const body = await fetchRawBody(pageUrl);
      const doc = await parseHtml(body);
      const streamData = extractStreamDataFromPage(doc, body, pageUrl);

      for (const item of streamData) {
        if (item.isPageUrl) continue;
        if (item.url.includes(".m3u8") || item.url.includes("t=hls")) {
          streams.push(
            new StreamResult({
              url: item.url,
              source: item.name + " (HLS)",
              headers: { Referer: pageUrl, "User-Agent": UA },
            })
          );
        } else {
          const extracted = await extractFromEmbedPage(item.url, item.name, "", "");
          if (extracted.length > 0) {
            streams.push(...extracted);
          } else {
            streams.push(
              new StreamResult({
                url: item.url,
                source: item.name,
                headers: { Referer: pageUrl, "User-Agent": UA },
              })
            );
          }
        }
      }

      if (streams.length === 0) {
        const torrents = extractTorrentLinks(doc, body);
        const filtered = torrents.filter(
          (t) => !isQualityTooHigh(extractQuality((t.url || "") + " " + (t.name || "")))
        );
        for (const t of filtered) {
          streams.push(
            new StreamResult({
              url: t.url,
              source: "🧲 Torrent - " + t.name,
              headers: {},
            })
          );
        }
      }
    } catch (err) {
      console.error("[5Movierulz] extractStreamsFromMoviePage error:", err);
    }
    return streams;
  }

  // ─── Deep embed page extraction ──────────────────────────────

  async function extractFromEmbedPage(embedUrl, name, language, quality) {
    const streams = [];
    const langTag = language ? " [" + language + "]" : "";
    const qualTag = quality ? " [" + quality + "]" : "";

    try {
      let finalBody = await fetchRawBody(embedUrl, { Referer: getBaseUrl() + "/" });
      let finalUrl = embedUrl;

      // ── Step 1: Follow loading-page redirects ──
      if (
        finalBody.includes("loading-container") ||
        finalBody.includes("Page is loading")
      ) {
        const metaRefresh = finalBody.match(
          /<meta[^>]*http-equiv\s*=\s*["']refresh["'][^>]*url=(https?:\/\/[^"'\s>]+)/i
        );
        if (metaRefresh) {
          try {
            finalBody = await fetchRawBody(metaRefresh[1], { Referer: embedUrl });
            finalUrl = metaRefresh[1];
          } catch (_) {}
        }
        if (finalBody.includes("loading-container")) {
          try {
            const res2 = await request(embedUrl, { Referer: embedUrl });
            if (res2.body && !res2.body.includes("loading-container")) {
              finalBody = res2.body;
            }
          } catch (_) {}
        }
      }

      // ── Step 2: Try /e/ or /embed/ variant ──
      const fileCodeMatch = embedUrl.match(/\/(?:file|f|d|w|v)\/([a-zA-Z0-9]+)/);
      if (
        fileCodeMatch &&
        !finalBody.includes("jwplayer") &&
        !finalBody.includes("eval(function")
      ) {
        const fileCode = fileCodeMatch[1];
        const origin = getOrigin(embedUrl);
        for (const path of ["/e/", "/embed/"]) {
          try {
            const vBody = await fetchRawBody(origin + path + fileCode, {
              Referer: embedUrl,
            });
            if (
              vBody.includes("jwplayer") ||
              vBody.includes("eval(function") ||
              vBody.includes("file:")
            ) {
              finalBody = vBody;
              finalUrl = origin + path + fileCode;
              break;
            }
          } catch (_) {}
        }
      }

      // ── Step 3: streamvin /video/ → /e/ ──
      if (embedUrl.includes("streamvin") && !finalBody.includes("eval(function")) {
        const vidMatch = embedUrl.match(/\/video\/([a-zA-Z0-9]+)/);
        if (vidMatch) {
          try {
            const eUrl = getOrigin(embedUrl) + "/e/" + vidMatch[1];
            const eBody = await fetchRawBody(eUrl, { Referer: embedUrl });
            if (eBody.includes("eval(function") || eBody.includes("file:")) {
              finalBody = eBody;
              finalUrl = eUrl;
            }
          } catch (_) {}
        }
      }

      // ── Step 4: vcdnlare HLS URL (direct in URL param) ──
      if (embedUrl.includes("vcdnlare") && embedUrl.includes("t=hls")) {
        streams.push(
          new StreamResult({
            url: embedUrl,
            source: name + " (HLS)" + qualTag + langTag,
            headers: { Referer: getBaseUrl() + "/", "User-Agent": UA },
          })
        );
        return streams;
      }

      // ── Step 5: Unpack eval(function(p,a,c,k,e,d)) ──
      const unpackedBlocks = unpackAll(finalBody);
      const allText = unpackedBlocks.join("\n") + "\n" + finalBody;
      const videoUrls = extractVideoUrlsFromText(allText);

      for (const vu of videoUrls) {
        // Filter out high quality
        const vuQual = extractQuality(vu);
        // Don't filter streaming URLs by quality — only torrents
        const isHLS = vu.includes(".m3u8");
        streams.push(
          new StreamResult({
            url: vu,
            source:
              name +
              (isHLS ? " (HLS)" : " (MP4)") +
              (vuQual ? " [" + vuQual + "]" : qualTag) +
              langTag,
            headers: {
              Referer: finalUrl,
              Origin: getOrigin(finalUrl),
              "User-Agent": UA,
            },
          })
        );
      }

      // ── Step 6: Download links on host page ──
      if (streams.length === 0) {
        const doc = await parseHtml(finalBody);
        const dlSelectors = [
          'a[href*="/download/"]',
          'a[href*="/f/"]',
          "a.videoplayer-download",
          'a.btn[href*="/d/"]',
          'a.btn-gradient[href*="/download"]',
        ];
        for (const sel of dlSelectors) {
          const dlLinks = Array.from(doc.querySelectorAll(sel));
          for (const dl of dlLinks) {
            let href = getAttr(dl, "href");
            if (!href) continue;
            if (href.startsWith("/")) href = getOrigin(finalUrl) + href;
            if (href.startsWith("http")) {
              streams.push(
                new StreamResult({
                  url: href,
                  source: name + " (Download)" + qualTag + langTag,
                  headers: { Referer: finalUrl, "User-Agent": UA },
                })
              );
            }
          }
        }
      }

      // ── Step 7: <source> and <video> tags ──
      if (streams.length === 0) {
        const doc = await parseHtml(finalBody);
        const sources = Array.from(doc.querySelectorAll("source[src], video[src]"));
        for (const s of sources) {
          const src = getAttr(s, "src");
          if (src && src.startsWith("http")) {
            streams.push(
              new StreamResult({
                url: src,
                source: name + qualTag + langTag,
                headers: { Referer: finalUrl, "User-Agent": UA },
              })
            );
          }
        }
      }

      // ── Step 8: Nested iframes (one level deep) ──
      if (streams.length === 0) {
        const doc = await parseHtml(finalBody);
        const nestedIframes = Array.from(doc.querySelectorAll("iframe[src]"));
        for (const iframe of nestedIframes) {
          const src = getAttr(iframe, "src");
          if (src && src.startsWith("http") && src !== embedUrl && src !== finalUrl) {
            try {
              const nested = await extractFromEmbedPage(
                src, name + " (Nested)", language, quality
              );
              streams.push(...nested);
            } catch (_) {}
          }
        }
      }
    } catch (err) {
      console.error("[5Movierulz] extractFromEmbedPage error for " + embedUrl, err);
    }
    return streams;
  }

  // ─── Register ─────────────────────────────────────────────────

  globalThis.getHome = getHome;
  globalThis.search = search;
  globalThis.load = load;
  globalThis.loadStreams = loadStreams;
})();
