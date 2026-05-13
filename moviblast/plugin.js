(function () {
  /**
   * @type {import('@skystream/sdk').Manifest}
   */
  // manifest is injected at runtime

  // ─── Constants ────────────────────────────────────────────────────────────────
  const BASE_URL = atob("aHR0cHM6Ly9hcHAuY2xvdWQtbWIueHl6");
  const TOKEN    = atob("amR2aGhqdjI1NXZnaGhnZGh2ZmNoMjU2NTY1NmpoZGNnaGZkZg==");

  const COMMON_HEADERS = {
    "User-Agent": "okhttp/5.0.0-alpha.6"
  };

  const PLAYBACK_HEADERS = {
    "Accept-Encoding": "identity",
    "Connection":      "Keep-Alive",
    "Icy-MetaData":    "1",
    "Referer":         "MovieBlast",
    "User-Agent":      "MovieBlast",
    "x-request-x":    atob("Y29tLm1vdmllYmxhc3QNCg==").trim()
  };

  // ─── Helpers ──────────────────────────────────────────────────────────────────

  function httpsify(url) {
    if (!url) return "";
    const s = String(url).trim();
    if (!s) return "";
    if (s.startsWith("http")) return s;
    return "https://" + s;
  }

  function matchQuality(serverLabel) {
    if (!serverLabel) return "Auto";
    const v = String(serverLabel).toLowerCase();
    if (v.includes("2160") || v.includes("4k"))    return "4K";
    if (v.includes("1440"))                         return "1440p";
    if (v.includes("1080") || v.includes("fullhd")) return "1080p";
    if (v.includes("720")  || v.includes("hd"))    return "720p";
    if (v.includes("480"))                          return "480p";
    if (v.includes("360"))                          return "360p";
    return "Auto";
  }

  // ─── HMAC-SHA256 ──────────────────────────────────────────────────────────────

  // Pure-JS HMAC-SHA256 so we don't rely on crypto.subtle availability
  function int32(x) { return x | 0; }

  function safeAdd(x, y) {
    const lsw = (x & 0xffff) + (y & 0xffff);
    const msw = (x >> 16) + (y >> 16) + (lsw >> 16);
    return (msw << 16) | (lsw & 0xffff);
  }

  function bitRotateLeft(num, cnt) {
    return (num << cnt) | (num >>> (32 - cnt));
  }

  function md5cmn(q, a, b, x, s, t) {
    return safeAdd(bitRotateLeft(safeAdd(safeAdd(a, q), safeAdd(x, t)), s), b);
  }
  function md5ff(a,b,c,d,x,s,t){ return md5cmn((b&c)|((~b)&d),a,b,x,s,t); }
  function md5gg(a,b,c,d,x,s,t){ return md5cmn((b&d)|(c&(~d)),a,b,x,s,t); }
  function md5hh(a,b,c,d,x,s,t){ return md5cmn(b^c^d,a,b,x,s,t); }
  function md5ii(a,b,c,d,x,s,t){ return md5cmn(c^(b|(~d)),a,b,x,s,t); }

  // SHA-256 pure JS implementation
  const SHA256_K = [
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,
    0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,
    0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,
    0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,
    0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,
    0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,
    0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,
    0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,
    0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
  ];

  function sha256Block(m, H) {
    let W = new Array(64);
    for (let i = 0; i < 16; i++) W[i] = m[i];
    for (let i = 16; i < 64; i++) {
      const s0 = ((W[i-15]>>>7)|(W[i-15]<<25)) ^
                 ((W[i-15]>>>18)|(W[i-15]<<14)) ^
                 (W[i-15]>>>3);
      const s1 = ((W[i-2]>>>17)|(W[i-2]<<15)) ^
                 ((W[i-2]>>>19)|(W[i-2]<<13)) ^
                 (W[i-2]>>>10);
      W[i] = (W[i-16] + s0 + W[i-7] + s1) >>> 0;
    }
    let [a,b,c,d,e,f,g,h] = H;
    for (let i = 0; i < 64; i++) {
      const S1  = ((e>>>6)|(e<<26)) ^ ((e>>>11)|(e<<21)) ^ ((e>>>25)|(e<<7));
      const ch  = (e & f) ^ ((~e) & g);
      const tmp1= (h + S1 + ch + SHA256_K[i] + W[i]) >>> 0;
      const S0  = ((a>>>2)|(a<<30)) ^ ((a>>>13)|(a<<19)) ^ ((a>>>22)|(a<<10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const tmp2= (S0 + maj) >>> 0;
      h=g; g=f; f=e;
      e=(d+tmp1)>>>0;
      d=c; c=b; b=a;
      a=(tmp1+tmp2)>>>0;
    }
    return [
      (H[0]+a)>>>0,(H[1]+b)>>>0,(H[2]+c)>>>0,(H[3]+d)>>>0,
      (H[4]+e)>>>0,(H[5]+f)>>>0,(H[6]+g)>>>0,(H[7]+h)>>>0
    ];
  }

  function sha256Bytes(msgBytes) {
    const len   = msgBytes.length;
    const bitLen= len * 8;
    // Padding
    const padded = [...msgBytes, 0x80];
    while (padded.length % 64 !== 56) padded.push(0);
    // Append length as 64-bit big-endian
    for (let i = 7; i >= 0; i--) {
      padded.push((bitLen / Math.pow(2, i * 8)) & 0xff);
    }
    let H = [
      0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,
      0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19
    ];
    for (let i = 0; i < padded.length; i += 64) {
      const m = [];
      for (let j = 0; j < 16; j++) {
        m.push(
          ((padded[i + j*4])     << 24) |
          ((padded[i + j*4 + 1]) << 16) |
          ((padded[i + j*4 + 2]) <<  8) |
          ((padded[i + j*4 + 3]))
        );
      }
      H = sha256Block(m, H);
    }
    const out = [];
    for (const h of H) {
      out.push((h>>>24)&0xff,(h>>>16)&0xff,(h>>>8)&0xff,h&0xff);
    }
    return out;
  }

  function strToBytes(str) {
    const bytes = [];
    for (let i = 0; i < str.length; i++) {
      let c = str.charCodeAt(i);
      if (c < 0x80) {
        bytes.push(c);
      } else if (c < 0x800) {
        bytes.push(0xc0|(c>>6), 0x80|(c&0x3f));
      } else {
        bytes.push(0xe0|(c>>12), 0x80|((c>>6)&0x3f), 0x80|(c&0x3f));
      }
    }
    return bytes;
  }

  function hmacSha256Bytes(keyStr, msgStr) {
    const BLOCK = 64;
    let keyBytes = strToBytes(keyStr);
    if (keyBytes.length > BLOCK) keyBytes = sha256Bytes(keyBytes);
    while (keyBytes.length < BLOCK) keyBytes.push(0);

    const ipad = keyBytes.map(b => b ^ 0x36);
    const opad = keyBytes.map(b => b ^ 0x5c);

    const msgBytes = strToBytes(msgStr);
    const inner    = sha256Bytes([...ipad, ...msgBytes]);
    return sha256Bytes([...opad, ...inner]);
  }

  function bytesToBase64(bytes) {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let out = "", i = 0;
    while (i < bytes.length) {
      const b0 = bytes[i++] || 0;
      const b1 = bytes[i++];
      const b2 = bytes[i++];
      out += chars[b0 >> 2];
      out += chars[((b0 & 3) << 4) | ((b1 ?? 0) >> 4)];
      out += b1 !== undefined ? chars[((b1 & 0xf) << 2) | ((b2 ?? 0) >> 6)] : "=";
      out += b2 !== undefined ? chars[b2 & 0x3f] : "=";
    }
    return out;
  }

  // Mirrors Kotlin generateSignedUrl exactly
  function generateSignedUrl(rawUrl) {
    try {
      const url       = httpsify(rawUrl);
      // Extract path (everything after host)
      const pathMatch = url.match(/^https?:\/\/[^/]+(\/.*)?$/);
      const path      = pathMatch && pathMatch[1] ? pathMatch[1] : "/";
      const ts        = Math.floor(Date.now() / 1000).toString();
      const secret    = atob("R0o4cmV5ZGFySTdKcWF0OXJ2YkFKS05ROWdZNERvRVFGMkg1bmZ1STFnaQ==");
      const sigBytes  = hmacSha256Bytes(secret, path + ts);
      const b64       = bytesToBase64(sigBytes);
      const encoded   = encodeURIComponent(b64);
      return `${url}?verify=${ts}-${encoded}`;
    } catch (_) {
      return httpsify(rawUrl);
    }
  }

  // ─── API Helpers ──────────────────────────────────────────────────────────────

  async function apiGet(path, extraHeaders) {
    const url = `${BASE_URL}/${path}`;
    const res = await http_get(url, {
      headers: Object.assign({}, COMMON_HEADERS, extraHeaders || {})
    });
    if (!res || !res.body) throw new Error("Empty response from " + url);
    return JSON.parse(res.body);
  }

  // ─── Item Helpers ─────────────────────────────────────────────────────────────

  function isSeries(raw) {
    const t = String(raw.type         || "").toLowerCase();
    const c = String(raw.content_type || "").toLowerCase();
    return ["series","serie","tv","show"].includes(t) || c === "series";
  }

  function itemToMultimedia(raw) {
    if (!raw || !raw.id) return null;
    const title   = raw.name || raw.title || "Unknown";
    const series  = isSeries(raw);
    const type    = series ? "series" : "movie";
    const apiPath = series
      ? `api/series/show/${raw.id}/${TOKEN}`
      : `api/media/detail/${raw.id}/${TOKEN}`;

    return new MultimediaItem({
      title,
      url:       `${BASE_URL}/${apiPath}`,
      posterUrl: raw.poster_path || "",
      type,
      year:      raw.release_date
                   ? parseInt(String(raw.release_date).split("-")[0], 10)
                   : undefined,
      score:     raw.vote_average != null
                   ? parseFloat(raw.vote_average)
                   : undefined,
      description: raw.overview || ""
    });
  }

  // ─── getHome ──────────────────────────────────────────────────────────────────

  const HOME_SECTIONS = [
    { name: "Trending",         path: `api/genres/trending/all/${TOKEN}` },
    { name: "Latest",           path: `api/genres/pinned/all/${TOKEN}` },
    { name: "Recently Added",   path: `api/genres/new/all/${TOKEN}` },
    { name: "Popular • Movies", path: `api/genres/popularmovies/all/${TOKEN}` },
    { name: "Popular • Series", path: `api/genres/popularseries/all/${TOKEN}` },
    { name: "Latest • Series",  path: `api/media/seriesEpisodesAll/${TOKEN}` },
    { name: "Recommended",      path: `api/genres/recommended/all/${TOKEN}` },
    { name: "New HD Releases",  path: `api/genres/media/names/New%20HD%20Released/${TOKEN}` }
  ];

  async function getHome(cb) {
    try {
      const data = {};

      for (const section of HOME_SECTIONS) {
        try {
          const json  = await apiGet(`${section.path}?page=1`);
          const items = (json.data || [])
            .map(itemToMultimedia)
            .filter(Boolean);

          const seen = new Set();
          const uniq = [];
          for (const it of items) {
            const key = it.url || `${it.title}-${it.posterUrl}`;
            if (seen.has(key)) continue;
            seen.add(key);
            uniq.push(it);
          }

          if (uniq.length > 0) data[section.name] = uniq.slice(0, 30);
        } catch (_) {}
      }

      cb({ success: true, data });
    } catch (e) {
      cb({ success: false, errorCode: "HOME_ERROR", message: String(e?.message || e) });
    }
  }

  // ─── search ───────────────────────────────────────────────────────────────────

  async function search(query, cb) {
    try {
      const raw = String(query || "").trim();
      if (!raw) return cb({ success: true, data: [] });

      const safeQuery = encodeURIComponent(raw);
      const res = await http_get(
        `${BASE_URL}/api/search/${safeQuery}/${TOKEN}`,
        { headers: COMMON_HEADERS }
      );

      if (!res || !res.body) return cb({ success: true, data: [] });

      const json  = JSON.parse(res.body);
      const arr   = json.search || json || [];
      const items = (Array.isArray(arr) ? arr : []).map(item => {
        const series  = String(item.type || "").toLowerCase().includes("serie");
        const type    = series ? "series" : "movie";
        const apiPath = series
          ? `api/series/show/${item.id}/${TOKEN}`
          : `api/media/detail/${item.id}/${TOKEN}`;

        return new MultimediaItem({
          title:     item.name || "Unknown",
          url:       `${BASE_URL}/${apiPath}`,
          posterUrl: item.poster_path || "",
          type,
          score:     item.vote_average != null
                       ? parseFloat(item.vote_average)
                       : undefined
        });
      }).filter(Boolean);

      cb({ success: true, data: items });
    } catch (e) {
      cb({ success: false, errorCode: "SEARCH_ERROR", message: String(e?.message || e) });
    }
  }

  // ─── load ─────────────────────────────────────────────────────────────────────

  async function load(url, cb) {
    try {
      const res = await http_get(url, { headers: COMMON_HEADERS });
      if (!res || !res.body) throw new Error("Empty response");
      const json = JSON.parse(res.body);

      const title       = json.name || json.title || "Unknown";
      const posterUrl   = json.poster_path || "";
      const bannerUrl   = json.backdrop_path_tv || json.backdrop_path || posterUrl;
      const description = json.overview || "";
      const releaseDate = json.first_air_date || json.release_date || "";
      const year        = releaseDate
                           ? parseInt(releaseDate.split("-")[0], 10)
                           : undefined;
      const score       = json.vote_average != null
                           ? parseFloat(json.vote_average)
                           : undefined;

      const cast = (json.casterslist || []).map(c => {
        if (!c || !c.original_name) return null;
        return new Actor({
          name:  c.original_name,
          role:  c.character || "",
          image: c.profile_path || ""
        });
      }).filter(Boolean);

      const seasons   = json.seasons;
      const hasSeries = Array.isArray(seasons) && seasons.length > 0;
      const type      = hasSeries ? "series" : "movie";
      let episodes    = [];

      if (hasSeries) {
        for (const seasonObj of seasons) {
          const seasonNum = seasonObj.season_number || 1;
          for (const ep of (seasonObj.episodes || [])) {
            const videoLinks = (ep.videos || [])
              .filter(v => v && v.link)
              .map(v => ({
                link:   String(v.link).trim(),
                server: v.server || "",
                lang:   v.lang   || ""
              }));

            episodes.push(new Episode({
              name:        ep.name || `Episode ${ep.episode_number || "?"}`,
              url:         JSON.stringify(videoLinks),
              season:      seasonNum,
              episode:     ep.episode_number || 1,
              posterUrl:   ep.still_path_tv || ep.still_path || posterUrl,
              description: ep.overview || ""
            }));
          }
        }
        episodes.sort((a, b) => (a.season - b.season) || (a.episode - b.episode));

      } else {
        const videoLinks = (json.videos || [])
          .filter(v => v && v.link)
          .map(v => ({
            link:   String(v.link).trim(),
            server: v.server || "",
            lang:   v.lang   || ""
          }));

        episodes = [new Episode({
          name:     title,
          url:      JSON.stringify(videoLinks),
          season:   1,
          episode:  1,
          posterUrl
        })];
      }

      cb({
        success: true,
        data: new MultimediaItem({
          title,
          url,
          posterUrl,
          bannerUrl,
          description,
          type,
          year,
          score,
          cast,
          syncData: {
            imdb: json.imdb_external_id || undefined,
            tmdb: json.tmdb_id ? String(json.tmdb_id) : undefined
          },
          episodes
        })
      });
    } catch (e) {
      cb({ success: false, errorCode: "LOAD_ERROR", message: String(e?.message || e) });
    }
  }

  // ─── loadStreams ──────────────────────────────────────────────────────────────

  async function loadStreams(url, cb) {
    try {
      let videoLinks = [];
      try {
        videoLinks = JSON.parse(url);
      } catch (_) {
        videoLinks = [{ link: url, server: "MovieBlast", lang: "" }];
      }

      if (!Array.isArray(videoLinks) || videoLinks.length === 0) {
        return cb({ success: true, data: [] });
      }

      const streams = [];

      for (const item of videoLinks) {
        if (!item || !item.link) continue;

        const rawLink = httpsify(String(item.link).trim());
        if (!rawLink) continue;

        const server  = item.server || "MovieBlast";
        const lang    = item.lang   || "";
        const quality = matchQuality(server);
        const label   = lang ? `${server} • ${lang}` : server;

        // Sign the URL — same algorithm as Kotlin generateSignedUrl
        const signedUrl = generateSignedUrl(rawLink);

        streams.push(new StreamResult({
          url:     signedUrl,
          quality,
          headers: Object.assign({}, PLAYBACK_HEADERS),
          source:  label
        }));
      }

      cb({ success: true, data: streams });
    } catch (e) {
      cb({ success: false, errorCode: "STREAM_ERROR", message: String(e?.message || e) });
    }
  }

  // ─── Export ───────────────────────────────────────────────────────────────────
  globalThis.getHome     = getHome;
  globalThis.search      = search;
  globalThis.load        = load;
  globalThis.loadStreams = loadStreams;

})();
