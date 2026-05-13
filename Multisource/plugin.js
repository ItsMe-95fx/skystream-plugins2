/**
 * @type {import('@skystream/sdk').Manifest}
 * Videasy Plugin for SkyStream - Multi-Source Streaming
 * Integrates 6 streaming sources with full metadata
 */
(function() {
  "use strict";

  const TMDB_API = "https://api.themoviedb.org/3";
  const TMDB_KEY = "68e094699525b18a70bab2f86b1fa706";
  const TMDB_IMG = "https://image.tmdb.org/t/p/w500";
  const TMDB_IMG_ORIG = "https://image.tmdb.org/t/p/original";
  const LANG = "en-US";
  const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36";

  const VIDEASY_TMDB_KEY = "1c29a5198ee1854bd5eb45dbe8d17d92";
  const DECRYPT_API_VIDEASY = "https://enc-dec.app/api/dec-videasy";
  const DECRYPT_API_CLOUDNESTRA = "https://enc-dec.app/api/dec-cloudnestra";
  const ENCRYPT_API_VIDLINK = "https://enc-dec.app/api/enc-vidlink";

  const VIDEASY_HEADERS = {
    'User-Agent': USER_AGENT,
    'Accept': 'application/json, text/plain, */*',
    'Origin': 'https://player.videasy.net',
    'Referer': 'https://player.videasy.net/'
  };

  const SERVERS = {
    'Neon': { url: 'https://api.videasy.net/myflixerzupcloud/sources-with-title' },
    'Yoru': { url: 'https://api.videasy.net/cdn/sources-with-title', moviesOnly: true },
    'Cypher': { url: 'https://api.videasy.net/moviebox/sources-with-title' },
    'Reyna': { url: 'https://api.videasy.net/primewire/sources-with-title' },
    'Omen': { url: 'https://api.videasy.net/onionplay/sources-with-title' },
    'Breach': { url: 'https://api.videasy.net/m4uhd/sources-with-title' },
    'Ghost': { url: 'https://api.videasy.net/primesrcme/sources-with-title' },
    'Sage': { url: 'https://api.videasy.net/1movies/sources-with-title' },
    'Vyse': { url: 'https://api.videasy.net/hdmovie/sources-with-title' },
    'Raze': { url: 'https://api.videasy.net/superflix/sources-with-title' }
  };

  const LANG_NAMES = {
    'en': 'English', 'eng': 'English',
    'es': 'Spanish', 'spa': 'Spanish',
    'fr': 'French', 'fre': 'French', 'fra': 'French',
    'de': 'German', 'ger': 'German', 'deu': 'German',
    'it': 'Italian', 'ita': 'Italian',
    'pt': 'Portuguese', 'por': 'Portuguese', 'pt-br': 'Portuguese (BR)',
    'ru': 'Russian', 'rus': 'Russian',
    'ja': 'Japanese', 'jpn': 'Japanese',
    'ko': 'Korean', 'kor': 'Korean',
    'zh': 'Chinese', 'chi': 'Chinese',
    'ar': 'Arabic', 'ara': 'Arabic',
    'hi': 'Hindi', 'hin': 'Hindi',
    'tr': 'Turkish', 'tur': 'Turkish',
    'pl': 'Polish', 'pol': 'Polish',
    'nl': 'Dutch', 'nld': 'Dutch',
    'sv': 'Swedish', 'swe': 'Swedish',
    'da': 'Danish', 'dan': 'Danish',
    'no': 'Norwegian', 'nor': 'Norwegian',
    'fi': 'Finnish', 'fin': 'Finnish'
  };

  function buildUrl(path, params) {
    var url = TMDB_API + path + "?api_key=" + TMDB_KEY + "&language=" + LANG;
    if (params) {
      for (var key in params) {
        if (params.hasOwnProperty(key) && params[key] !== undefined && params[key] !== null) {
          url += "&" + key + "=" + encodeURIComponent(params[key]);
        }
      }
    }
    return url;
  }

  async function api(path, params) {
    var url = buildUrl(path, params);
    var res = await http_get(url, {
      "User-Agent": USER_AGENT,
      "Accept": "application/json"
    });
    var body = res.body || "";
    if (!body) throw new Error("Empty response");
    if (res.status === 401) throw new Error("Unauthorized");
    if (body.indexOf("<") === 0) throw new Error("Invalid response");
    return JSON.parse(res.body);
  }

  function img(path) {
    if (!path) return "";
    return path.indexOf("http") === 0 ? path : TMDB_IMG + path;
  }

  function origImg(path) {
    if (!path) return "";
    return path.indexOf("http") === 0 ? path : TMDB_IMG_ORIG + path;
  }

  function makeItem(item, type) {
    var t = (type === "tv" || type === "series") ? "series" : "movie";
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

  function normalizeQuality(label) {
    var text = (label || '').toString().toUpperCase();
    if (text.match(/2160P|4K|UHD/)) return "2160p";
    if (text.match(/1440P/)) return "1440p";
    if (text.match(/1080P|FHD/)) return "1080p";
    if (text.match(/720P|HD/)) return "720p";
    if (text.match(/480P/)) return "480p";
    if (text.match(/360P/)) return "360p";
    if (text.match(/240P/)) return "240p";
    return 'Auto';
  }

  function extractAudioLanguages(str) {
    if (!str) return ["ENG"];
    var s = str.toLowerCase();
    var langs = [];
    if (s.match(/multi/)) langs.push("Multi");
    if (s.match(/dual/)) langs.push("Dual");
    if (s.match(/\beng(lish)?\b/)) langs.push("ENG");
    if (s.match(/\bhin(di)?\b/)) langs.push("HIN");
    if (s.match(/\bspa(nish)?\b/)) langs.push("SPA");
    if (s.match(/\bfre(nch)?\b/) || s.match(/\bfra\b/)) langs.push("FRA");
    if (s.match(/\bger(man)?\b/) || s.match(/\bde\b/)) langs.push("GER");
    if (s.match(/\bjpn\b/) || s.match(/\bjapanese\b/)) langs.push("JPN");
    if (s.match(/\bkor(ean)?\b/)) langs.push("KOR");
    if (s.match(/\bchi(nese)?\b/) || s.match(/\bzh\b/)) langs.push("CHI");
    if (s.match(/\brus(sian)?\b/) || s.match(/\bru\b/)) langs.push("RUS");
    if (s.match(/\bara(bic)?\b/)) langs.push("ARA");
    if (s.match(/\bita(lian)?\b/)) langs.push("ITA");
    if (s.match(/\bpor(tuguese)?\b/) || s.match(/\bpt\b/)) langs.push("POR");
    return langs.length > 0 ? langs : ["ENG"];
  }

  function getLangName(code) {
    if (!code) return 'Unknown';
    var lower = code.toLowerCase();
    return LANG_NAMES[lower] || code.toUpperCase();
  }

  function dedupeStreams(streams) {
    var seen = {};
    return (streams || []).filter(function (stream) {
      if (!stream || !stream.url) return false;
      if (seen[stream.url]) return false;
      seen[stream.url] = true;
      return true;
    });
  }

  async function getTmdbMeta(tmdbId, mediaType) {
    var typePath = mediaType === 'tv' ? 'tv' : 'movie';
    var url = 'https://api.themoviedb.org/3/' + typePath + '/' + tmdbId + '?append_to_response=external_ids&api_key=' + VIDEASY_TMDB_KEY;
    try {
      var res = await http_get(url, { 'User-Agent': USER_AGENT });
      if (!res.body) return null;
      return JSON.parse(res.body);
    } catch (e) {
      return null;
    }
  }

  // ==================== RESOLVER 1: VIDEASY SERVERS ====================

  async function resolveVideasyServers(tmdbId, mediaType, season, episode) {
    const type = mediaType === 'tv' || mediaType === 'series' ? 'tv' : 'movie';
    
    try {
      const tmdbUrl = 'https://api.themoviedb.org/3/' + type + '/' + tmdbId + '?api_key=' + VIDEASY_TMDB_KEY + '&append_to_response=external_ids';
      const tmdbRes = await http_get(tmdbUrl, { 'User-Agent': USER_AGENT });
      if (!tmdbRes.body) return [];
      const tmdbData = JSON.parse(tmdbRes.body);

      const details = {
        id: tmdbId.toString(),
        title: tmdbData.title || tmdbData.name,
        year: (tmdbData.release_date || tmdbData.first_air_date || '').split('-')[0],
        imdbId: tmdbData.external_ids ? tmdbData.external_ids.imdb_id : '',
        type: type
      };

      const serverPromises = Object.keys(SERVERS).map(async (name) => {
        const config = SERVERS[name];
        if (details.type === 'tv' && config.moviesOnly) return [];

        let serverUrl = config.url + '?title=' + encodeURIComponent(details.title) +
                        '&mediaType=' + details.type + '&year=' + details.year +
                        '&tmdbId=' + details.id + '&imdbId=' + (details.imdbId || '');
        
        if (details.type === 'tv') {
          serverUrl += '&seasonId=' + (season || 1) + '&episodeId=' + (episode || 1);
        }

        try {
          const serverRes = await http_get(serverUrl, VIDEASY_HEADERS);
          const encryptedText = serverRes.body || "";
          
          if (!encryptedText || encryptedText.length < 20 || encryptedText.startsWith('<!')) {
            return [];
          }

          const decryptRes = await http_post(DECRYPT_API_VIDEASY, {
            'Content-Type': 'application/json'
          }, JSON.stringify({ text: encryptedText, id: details.id }));
          const decryptData = JSON.parse(decryptRes.body || '{}');
          const resData = decryptData.result || decryptData;

          if (!resData || !resData.sources) return [];

          return resData.sources
            .filter(s => s && s.url && !(s.quality || '').toUpperCase().includes('HDR'))
            .map(s => {
              const quality = normalizeQuality(s.quality || '');
              const audio = extractAudioLanguages(s.quality || '');
              
              const subtitles = (resData.subtitles || []).map(sub => ({
                url: sub.url,
                lang: getLangName(sub.lang || 'Unknown'),
                forced: sub.forced || false,
                sdh: sub.sdh || false
              }));

              const qualityTag = quality !== 'Auto' ? ' [' + quality + ']' : '';
              const sourceLabel = 'Videasy ' + name + qualityTag;

              return new StreamResult({
                url: s.url,
                quality: quality,
                source: sourceLabel,
                headers: {
                  'Referer': 'https://player.videasy.net/',
                  'Origin': 'https://player.videasy.net',
                  'User-Agent': USER_AGENT
                },
                audio: audio,
                subtitles: subtitles
              });
            });
        } catch (e) {
          return [];
        }
      });

      const results = await Promise.all(serverPromises);
      return results.flat().filter(Boolean);
    } catch (e) {
      return [];
    }
  }

  // ==================== RESOLVER 2: VIDLINK ====================

  async function resolveVidLink(tmdbId, mediaType, season, episode) {
    try {
      const encRes = await http_get(
        ENCRYPT_API_VIDLINK + '?text=' + encodeURIComponent(String(tmdbId)),
        { 'User-Agent': USER_AGENT }
      );
      const encData = JSON.parse(encRes.body || '{}');
      const encodedTmdb = encData && encData.result;
      if (!encodedTmdb) return [];

      let url;
      if (mediaType === 'tv' || mediaType === 'series') {
        url = 'https://vidlink.pro/api/b/tv/' + encodedTmdb + '/' + (season || 1) + '/' + (episode || 1) + '?multiLang=0';
      } else {
        url = 'https://vidlink.pro/api/b/movie/' + encodedTmdb + '?multiLang=0';
      }

      const res = await http_get(url, {
        'User-Agent': USER_AGENT,
        'Accept': 'application/json',
        'Referer': 'https://vidlink.pro/'
      });
      
      const payload = JSON.parse(res.body || '{}');
      const playlist = payload && payload.stream && payload.stream.playlist;
      if (!playlist) return [];

      return [new StreamResult({
        url: playlist,
        quality: 'Auto',
        source: 'VidLink [Multi-Quality]',
        headers: {
          'Referer': 'https://vidlink.pro/',
          'Origin': 'https://vidlink.pro',
          'User-Agent': USER_AGENT
        },
        audio: ['ENG'],
        subtitles: []
      })];
    } catch (e) {
      console.log('VidLink error: ' + e.message);
      return [];
    }
  }

  // ==================== RESOLVER 3: VIDMODY ====================

  async function resolveVidmody(tmdbId, mediaType, season, episode) {
    try {
      const meta = await getTmdbMeta(tmdbId, mediaType);
      if (!meta) return [];

      const imdbId = mediaType === 'tv' 
        ? (meta.external_ids && meta.external_ids.imdb_id) 
        : meta.imdb_id;
      if (!imdbId) return [];

      let targetUrl = "";
      let displayTitle = (mediaType === 'tv' ? meta.name : meta.title) || "Vidmody";

      if (mediaType === "movie") {
        targetUrl = 'https://vidmody.com/vs/' + imdbId + '#.m3u8';
      } else {
        const sStr = "s" + (season || 1);
        const eNum = episode || 1;
        const eStr = "e" + (eNum < 10 ? "0" + eNum : eNum);
        targetUrl = 'https://vidmody.com/vs/' + imdbId + '/' + sStr + '/' + eStr + '#.m3u8';
        displayTitle += ' - ' + sStr.toUpperCase() + eStr.toUpperCase();
      }

      const testRes = await http_get(targetUrl.replace('#.m3u8', ''), {
        'User-Agent': USER_AGENT,
        'Referer': 'https://vidmody.com/'
      });
      
      if (testRes && testRes.body && testRes.body.length > 0) {
        return [new StreamResult({
          url: targetUrl,
          quality: 'Auto',
          source: displayTitle + ' (Vidmody)',
          headers: {
            'Referer': 'https://vidmody.com/',
            'User-Agent': USER_AGENT
          },
          audio: ['ENG'],
          subtitles: []
        })];
      }
      return [];
    } catch (e) {
      console.log('Vidmody error: ' + e.message);
      return [];
    }
  }

  // ==================== RESOLVER 4: VIDSRC (SIMPLIFIED) ====================

  async function resolveVidSrc(tmdbId, mediaType, season, episode) {
    try {
      console.log('VidSrc: Starting for TMDB ID ' + tmdbId);
      
      const meta = await getTmdbMeta(tmdbId, mediaType);
      if (!meta) {
        console.log('VidSrc: No TMDB metadata');
        return [];
      }

      const imdbId = mediaType === 'tv' 
        ? (meta.external_ids && meta.external_ids.imdb_id) 
        : meta.imdb_id;
      if (!imdbId) {
        console.log('VidSrc: No IMDB ID');
        return [];
      }
      console.log('VidSrc: IMDB ID = ' + imdbId);

      // Step 1: Get embed URL
      let embedUrl;
      if (mediaType === 'tv' || mediaType === 'series') {
        embedUrl = 'https://vsrc.su/embed/tv?imdb=' + imdbId + '&season=' + (season || 1) + '&episode=' + (episode || 1);
      } else {
        embedUrl = 'https://vsrc.su/embed/' + imdbId;
      }
      console.log('VidSrc: Fetching embed URL: ' + embedUrl);

      const embedRes = await http_get(embedUrl, {
        'User-Agent': USER_AGENT,
        'Referer': 'https://vsrc.su/'
      });
      const embedHtml = embedRes.body || "";
      console.log('VidSrc: Embed HTML length: ' + embedHtml.length);
      
      // Step 2: Extract iframe src
      const iframeMatch = embedHtml.match(/<iframe[^>]+src=["']([^"']+?)["']/i);
      const iframeSrc = iframeMatch ? iframeMatch[1] : '';
      if (!iframeSrc) {
        console.log('VidSrc: No iframe found in embed page');
        return [];
      }
      console.log('VidSrc: Iframe URL: ' + iframeSrc);

      // Step 3: Fetch iframe content
      const iframeRes = await http_get('https:' + iframeSrc, {
        'User-Agent': USER_AGENT,
        'Referer': 'https://vsrc.su/'
      });
      const iframeHtml = iframeRes.body || "";
      console.log('VidSrc: Iframe HTML length: ' + iframeHtml.length);

      // Step 4: Extract source URL (format: src: 'URL')
      const srcMatch = iframeHtml.match(/src:\s*['"]([^'"]+?)['"]/i);
      const prorcpSrc = srcMatch ? srcMatch[1] : '';
      if (!prorcpSrc) {
        console.log('VidSrc: No prorcpSrc found');
        return [];
      }
      console.log('VidSrc: ProrcpSrc: ' + prorcpSrc);

      // Step 5: Fetch from cloudnestra
      const cloudRes = await http_get('https://cloudnestra.com' + prorcpSrc, {
        'User-Agent': USER_AGENT,
        'Referer': 'https://cloudnestra.com/'
      });
      const cloudHtml = cloudRes.body || "";
      console.log('VidSrc: Cloud HTML length: ' + cloudHtml.length);

      // Step 6: Simple div extraction - look for pattern: <div id="..." style="display:none">...</div>
      // Extract div with encrypted content
      const divRegex = /<div\s+id=["']([^"']+?)["'][^>]*style=["']display:\s*none;?["'][^>]*>([^<]+?)<\/div>/i;
      const divMatch = cloudHtml.match(divRegex);
      const divId = divMatch ? divMatch[1] : '';
      const divText = divMatch ? divMatch[2] : '';
      
      if (!divId || !divText) {
        console.log('VidSrc: No encrypted div found');
        return [];
      }
      console.log('VidSrc: Div ID: ' + divId);

      // Step 7: Decrypt
      const decryptRes = await http_post(DECRYPT_API_CLOUDNESTRA, {
        'Content-Type': 'application/json'
      }, JSON.stringify({ text: divText, div_id: divId }));
      console.log('VidSrc: Decrypt response status: ' + decryptRes.status);
      
      const decrypted = JSON.parse(decryptRes.body || '{}');
      const urls = decrypted && decrypted.result;
      console.log('VidSrc: URLs found: ' + (urls ? urls.length : 0));
      
      if (!Array.isArray(urls) || urls.length === 0) {
        return [];
      }

      // Step 8: Extract subtitles from decrypted data
      const subtitles = (decrypted.subtitles || []).map(sub => ({
        url: sub.url,
        lang: getLangName(sub.lang || 'Unknown'),
        forced: sub.forced || false,
        sdh: sub.sdh || false
      }));
      console.log('VidSrc: Subtitles found: ' + subtitles.length);

      return urls.map((url, index) => new StreamResult({
        url: url,
        quality: 'Auto',
        source: 'VidSrc [Server ' + (index + 1) + ']',
        headers: {
          'Referer': 'https://cloudnestra.com/',
          'Origin': 'https://cloudnestra.com',
          'User-Agent': USER_AGENT
        },
        audio: ['ENG'],
        subtitles: subtitles
      })).filter(Boolean);
    } catch (e) {
      console.log('VidSrc error: ' + e.message);
      return [];
    }
  }

  // ==================== RESOLVER 5: CINESU ====================

  async function resolveCinesu(tmdbId, mediaType, season, episode) {
    try {
      const baseUrl = 'https://cine.su';
      
      let streamUrl;
      if (mediaType === 'tv' || mediaType === 'series') {
        streamUrl = baseUrl + '/v1/stream/master/tv/' + tmdbId + '/' + (season || 1) + '/' + (episode || 1) + '.m3u8';
      } else {
        streamUrl = baseUrl + '/v1/stream/master/movie/' + tmdbId + '.m3u8';
      }

      const res = await http_get(streamUrl, {
        'User-Agent': USER_AGENT,
        'Accept': 'application/x-mpegURL, application/json, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': baseUrl + '/en/watch',
        'Origin': baseUrl
      });

      const m3u8Content = res.body || "";
      if (!m3u8Content.includes('#EXTM3U')) return [];

      let quality = 'Auto';
      const resMatch = m3u8Content.match(/RESOLUTION=(\d+x\d+)/i);
      if (resMatch) {
        const res = resMatch[1];
        const height = parseInt(res.split('x')[1]);
        if (height >= 2000) quality = '2160p';
        else if (height >= 1000) quality = '1080p';
        else if (height >= 700) quality = '720p';
        else if (height >= 400) quality = '480p';
        else quality = '360p';
      }

      // Extract subtitles from M3U8
      const subtitleMatches = m3u8Content.match(/#EXT-X-MEDIA:TYPE=SUBTITLES[^""]*URI=["']([^"']+?)["'][^""]*LANGUAGE=["']([^"']+?)["']?/gi) || [];
      const subtitles = [];
      for (let i = 0; i < subtitleMatches.length; i++) {
        const match = subtitleMatches[i];
        const uriMatch = match.match(/URI=["']([^"']+?)["']/i);
        const langMatch = match.match(/LANGUAGE=["']([^"']+?)["']/i);
        if (uriMatch) {
          subtitles.push({
            url: uriMatch[1],
            lang: getLangName(langMatch ? langMatch[1] : 'Unknown'),
            forced: match.includes('FORCED=YES'),
            sdh: false
          });
        }
      }

      return [new StreamResult({
        url: streamUrl,
        quality: quality,
        source: 'CineSu [' + quality + ']',
        headers: {
          'Referer': baseUrl + '/en/watch',
          'Origin': baseUrl,
          'User-Agent': USER_AGENT
        },
        audio: ['ENG'],
        subtitles: subtitles
      })];
    } catch (e) {
      console.log('CineSu error: ' + e.message);
      return [];
    }
  }

  // ==================== RESOLVER 6: ICEFY ====================

  async function resolveIcefy(tmdbId, mediaType, season, episode) {
    try {
      const baseUrl = 'https://streams.icefy.top';
      
      let apiUrl;
      if (mediaType === 'tv' || mediaType === 'series') {
        apiUrl = baseUrl + '/tv/' + tmdbId + '/' + (season || 1) + '/' + (episode || 1);
      } else {
        apiUrl = baseUrl + '/movie/' + tmdbId;
      }

      const res = await http_get(apiUrl, {
        'User-Agent': USER_AGENT,
        'Accept': 'application/json',
        'Referer': baseUrl,
        'Origin': baseUrl
      });

      const body = res.body || '';
      
      // Check if response is HTML (Cloudflare challenge)
      if (body.includes('<!DOCTYPE') || body.includes('<html')) {
        console.log('Icefy: Cloudflare challenge detected, skipping');
        return [];
      }

      const data = JSON.parse(body);
      if (!data || !data.stream) return [];

      const streamUrl = data.stream;

      if (!streamUrl || streamUrl.length < 10) return [];

      let quality = 'Auto';
      if (streamUrl.includes('1080') || streamUrl.includes('1920')) quality = '1080p';
      else if (streamUrl.includes('720') || streamUrl.includes('1280')) quality = '720p';
      else if (streamUrl.includes('480') || streamUrl.includes('854')) quality = '480p';

      return [new StreamResult({
        url: streamUrl,
        quality: quality,
        source: 'Icefy [' + quality + ']',
        headers: {
          'Referer': baseUrl,
          'Origin': baseUrl,
          'User-Agent': USER_AGENT,
          'Accept': 'video/*, */*'
        },
        audio: ['ENG'],
        subtitles: []
      })];
    } catch (e) {
      console.log('Icefy error: ' + e.message);
      return [];
    }
  }

  // ==================== PLUGIN CORE FUNCTIONS ====================

  async function getHome(cb) {
    try {
      var sections = {};
      var hasData = false;

      var categories = [
        { key: "Trending Movies", path: "/trending/movie/week", type: "movie" },
        { key: "Trending TV", path: "/trending/tv/week", type: "tv" },
        { key: "Popular Movies", path: "/movie/popular", type: "movie" },
        { key: "Popular TV Shows", path: "/tv/popular", type: "tv" }
      ];

      var results = await Promise.allSettled(categories.map(function (cat) {
        return api(cat.path, { page: 1 });
      }));

      results.forEach(function (result, index) {
        if (result.status === "fulfilled" && result.value && result.value.results) {
          var cat = categories[index];
          var items = result.value.results.slice(0, 20).map(function (i) {
            return makeItem(i, cat.type);
          });
          if (items.length > 0) {
            sections[cat.key] = items;
            hasData = true;
          }
        }
      });

      if (!hasData) {
        cb({ success: false, errorCode: "NO_DATA", message: "No content found" });
        return;
      }

      cb({ success: true, data: sections });
    } catch (e) {
      console.log("getHome error: " + e.message);
      cb({ success: false, errorCode: "HOME_ERROR", message: String(e.message || e) });
    }
  }

  async function search(query, cb) {
    try {
      var q = String(query || "").trim();
      if (!q) {
        cb({ success: true, data: [] });
        return;
      }

      var data = await api("/search/multi", { query: q });
      var results = (data.results || [])
        .filter(function (i) { return i.media_type === "movie" || i.media_type === "tv"; })
        .slice(0, 30)
        .map(function (i) { return makeItem(i, i.media_type); });

      cb({ success: true, data: results });
    } catch (e) {
      console.log("search error: " + e.message);
      cb({ success: false, errorCode: "SEARCH_ERROR", message: String(e.message || e) });
    }
  }

  async function load(url, cb) {
    try {
      var parsed = JSON.parse(url);
      var id = parsed.id;
      var type = parsed.type;
      var eps = [];

      var detail = await api(type === "movie" ? "/movie/" + id : "/tv/" + id, {});

      if (type === "tv" || type === "series") {
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
                description: ep.overview || "",
                score: ep.vote_average ? parseFloat(ep.vote_average.toFixed(1)) : undefined
              }));
            }
          } catch (_) {}
        }
        if (eps.length === 0) {
          eps.push(new Episode({
            name: detail.name || detail.original_name || "Watch",
            url: url,
            season: 1,
            episode: 1
          }));
        }
      } else {
        eps.push(new Episode({
          name: "Full Movie",
          url: url,
          season: 1,
          episode: 1
        }));
      }

      var dateStr = detail.release_date || detail.first_air_date || "";
      var year = dateStr ? parseInt(dateStr.split("-")[0]) : undefined;
      var title = detail.title || detail.name || detail.original_title || detail.original_name || "Unknown";

      cb({
        success: true,
        data: new MultimediaItem({
          title: title,
          url: url,
          posterUrl: img(detail.poster_path),
          bannerUrl: origImg(detail.backdrop_path),
          description: detail.overview || "",
          type: type === "movie" ? "movie" : "series",
          contentType: type === "movie" ? "movie" : "series",
          year: year,
          score: detail.vote_average ? parseFloat(detail.vote_average.toFixed(1)) : undefined,
          duration: type === "movie" ? detail.runtime || undefined : undefined,
          episodes: eps,
          status: detail.status === "Returning Series" ? "ongoing" : "completed"
        })
      });
    } catch (e) {
      console.log("load error: " + e.message);
      cb({ success: false, errorCode: "LOAD_ERROR", message: String(e.message || e) });
    }
  }

  async function loadStreams(url, cb) {
    try {
      const parsed = JSON.parse(url);
      const id = parsed.id;
      const type = parsed.type === 'tv' || parsed.type === 'series' ? 'tv' : 'movie';
      const season = parsed.season;
      const episode = parsed.episode;

      if (!id) {
        cb({ success: false, errorCode: 'INVALID_URL', message: 'Invalid content ID' });
        return;
      }

      console.log('loadStreams: Fetching from all 6 sources for TMDB ID ' + id + ' (' + type + ')');

      const allStreams = [];
      
      const resolvers = [
        { name: 'Videasy', fn: resolveVideasyServers },
        { name: 'VidLink', fn: resolveVidLink },
        { name: 'Vidmody', fn: resolveVidmody },
        { name: 'VidSrc', fn: resolveVidSrc },
        { name: 'CineSu', fn: resolveCinesu },
        { name: 'Icefy', fn: resolveIcefy }
      ];

      for (const resolver of resolvers) {
        try {
          const streams = await resolver.fn(id, type, season, episode);
          if (streams && streams.length > 0) {
            console.log(resolver.name + ': Found ' + streams.length + ' stream(s)');
            allStreams.push(...streams);
          }
        } catch (e) {
          console.log(resolver.name + ' error: ' + e.message);
        }
      }

      const uniqueStreams = dedupeStreams(allStreams);

      const qualityRank = {
        '2160p': 0, '4K': 0, 'UHD': 0,
        '1440p': 1,
        '1080p': 2, 'FHD': 2,
        '720p': 3, 'HD': 3,
        '480p': 4,
        '360p': 5,
        '240p': 6,
        'Auto': 7
      };

      uniqueStreams.sort((a, b) => {
        const aRank = qualityRank[a.quality] !== undefined ? qualityRank[a.quality] : 7;
        const bRank = qualityRank[b.quality] !== undefined ? qualityRank[b.quality] : 7;
        if (aRank !== bRank) return aRank - bRank;
        const aAudioCount = a.audio ? a.audio.length : 0;
        const bAudioCount = b.audio ? b.audio.length : 0;
        if (aAudioCount !== bAudioCount) return bAudioCount - aAudioCount;
        const aSubCount = a.subtitles ? a.subtitles.length : 0;
        const bSubCount = b.subtitles ? b.subtitles.length : 0;
        if (aSubCount !== bSubCount) return bSubCount - aSubCount;
        return (a.source || "").localeCompare(b.source || "");
      });

      if (uniqueStreams.length === 0) {
        console.log("loadStreams: No streams found from any source");
      } else {
        console.log('loadStreams: Total ' + uniqueStreams.length + ' unique stream(s) found');
      }

      cb({ success: true, data: uniqueStreams });
    } catch (e) {
      console.log('loadStreams error: ' + e.message);
      cb({ success: false, errorCode: 'STREAM_ERROR', message: String(e.message || e) });
    }
  }

  // Export functions to SkyStream
  globalThis.getHome = getHome;
  globalThis.search = search;
  globalThis.load = load;
  globalThis.loadStreams = loadStreams;
})();
