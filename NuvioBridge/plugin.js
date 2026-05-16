(function () {

  var TAG = 'NuvioBridge';

  // ===========================================================================
  // MANIFEST SOURCES
  // ===========================================================================

  function getCatalogueAddons() {
    try { if (manifest && Array.isArray(manifest.catalogueAddons)) return manifest.catalogueAddons; } catch (e) {}
    return [];
  }

  function deriveSourceFromUrl(url) {
    var match = url.match(/github(?:usercontent)?\.com\/([^/]+)\/([^/]+)/);
    if (!match) return null;
    var username = match[1];
    return { id: username.toLowerCase(), name: username.charAt(0).toUpperCase() + username.slice(1), url: url };
  }

  var NUVIO_SOURCES = (typeof manifest !== 'undefined' && manifest.nuvioManifests)
    ? manifest.nuvioManifests.map(deriveSourceFromUrl).filter(function(s) { return s !== null; })
    : [];

  // ===========================================================================
  // USER-AGENT & HEADERS
  // ===========================================================================

  var UA_DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
  var UA_MOBILE  = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.134 Mobile Safari/537.36';

  var H_EXTERNAL = {
    'User-Agent': UA_DESKTOP,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5',
    'Connection': 'keep-alive'
  };
  var H_JSON = {
    'User-Agent': UA_DESKTOP,
    'Accept': 'application/json'
  };
  var H_MOBILE = {
    'User-Agent': UA_MOBILE,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9'
  };

  // ===========================================================================
  // TUNABLES
  // ===========================================================================

  var FETCH_CODE_TIMEOUT   = 20000;  // 20s to download a provider JS file
  var PROVIDER_TIMEOUT     = 25000;  // 25s for a provider to return streams
  var MANIFEST_TIMEOUT     = 18000;  // 18s to fetch a manifest
  var BATCH_SIZE           = 999;    // unlimited — all providers fire at once
  var STAGGER_MS           = 0;      // no stagger — all start simultaneously
  var FIRST_BATCH_MS       = 300000; // unused (soft deadline removed)
  var STREAM_TIMEOUT       = parseInt(getPreference('hub_stream_timeout')) || 300000; // 5 min — wait for all providers
  var MAX_RETRIES          = 0;      // no retries — fresh call per provider
  var CACHE_TTL            = 900000; // 15 min cache

  // ===========================================================================
  // QUALITY DETECTION
  // ===========================================================================

  var QUALITY_RULES = [
    { re: /(2160p|4k|uhd)/i,            label: '4K' },
    { re: /(1440p|2k)/i,                label: '1440p' },
    { re: /(1080p|fhd|full\s*hd)/i,    label: '1080p' },
    { re: /(720p|hd)/i,                 label: '720p' },
    { re: /(480p|sd)/i,                 label: '480p' },
    { re: /(360p)/i,                    label: '360p' }
  ];

  var QUALITY_ORDER = {
    '4K': 5, '2160p': 5,
    '1440p': 4, '2K': 4,
    '1080p': 3, 'FHD': 3,
    '720p': 2, 'HD': 2,
    '480p': 1, 'SD': 1,
    '360p': 0, 'CAM': 0
  };

  // ===========================================================================
  // RATE LIMIT BACKOFF
  // ===========================================================================

  var _rateLimits = {};
  var RATE_BACKOFF_MS = 300000;  // 5 min backoff
  var RATE_MAX_FAILS = 3;

  function isRateLimited(url) {
    var rl = _rateLimits[url];
    return rl && rl.fails >= RATE_MAX_FAILS && Date.now() < rl.until;
  }

  function recordRateLimit(url, status) {
    if (status === 429 || status === 503 || status === 502 || status === 504) {
      var rl = _rateLimits[url] || { fails: 0, until: 0 };
      rl.fails = (rl.fails || 0) + 1;
      rl.until = Date.now() + RATE_BACKOFF_MS;
      _rateLimits[url] = rl;
      try { setPreference('hub_ratelimit:' + url, JSON.stringify(rl)); } catch (e) {}
    } else if (status >= 200 && status < 300) {
      if (_rateLimits[url]) _rateLimits[url].fails = 0;
    }
  }

  // ===========================================================================
  // SDK CLASS COMPATIBILITY SHIMS (must be before any usage)
  // ===========================================================================

  if (typeof globalThis.MultimediaItem === 'undefined') {
    globalThis.MultimediaItem = function (props) {
      if (props) { for (var k in props) { if (props.hasOwnProperty(k)) this[k] = props[k]; } }
    };
  }
  if (typeof globalThis.Episode === 'undefined') {
    globalThis.Episode = function (props) {
      if (props) { for (var k in props) { if (props.hasOwnProperty(k)) this[k] = props[k]; } }
    };
  }
  if (typeof globalThis.StreamResult === 'undefined') {
    globalThis.StreamResult = function (props) {
      if (props) { for (var k in props) { if (props.hasOwnProperty(k)) this[k] = props[k]; } }
    };
  }
  if (typeof globalThis.Actor === 'undefined') {
    globalThis.Actor = function (props) {
      if (props) { for (var k in props) { if (props.hasOwnProperty(k)) this[k] = props[k]; } }
    };
  }
  if (typeof globalThis.Trailer === 'undefined') {
    globalThis.Trailer = function (props) {
      if (props) { for (var k in props) { if (props.hasOwnProperty(k)) this[k] = props[k]; } }
    };
  }

  // ===========================================================================
  // POLYFILLS (fetch, URLSearchParams, globals)
  // ===========================================================================

  if (typeof global === 'undefined') { globalThis.global = globalThis; }
  if (typeof window === 'undefined') { globalThis.window = globalThis; }
  if (typeof globalThis.self === 'undefined') { globalThis.self = globalThis; }

  if (typeof globalThis.URLSearchParams === 'undefined') {
    globalThis.URLSearchParams = function (init) {
      this._d = {};
      if (typeof init === 'string') {
        init.split('&').forEach(function (p) {
          var kv = p.split('=');
          if (kv.length >= 2) {
            this._d[decodeURIComponent(kv[0])] = decodeURIComponent(kv.slice(1).join('='));
          }
        }.bind(this));
      }
      this.get = function (n) { return this._d[n] || null; };
      this.set = function (n, v) { this._d[n] = String(v); };
      this.toString = function () {
        var parts = [];
        for (var k in this._d) {
          if (this._d.hasOwnProperty(k)) parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(this._d[k]));
        }
        return parts.join('&');
      };
    };
  }

  // ===========================================================================
  // SAFE LOGGING
  // ===========================================================================

  function log(msg) {
    try { console.log('[' + TAG + '] ' + msg); } catch (e) {}
  }
  function warn(msg) {
    try { console.warn('[' + TAG + '] ' + msg); } catch (e) {}
  }

  // ===========================================================================
  // NATIVE HTTP LAYER
  // ===========================================================================

  function normalizeResponse(r) {
    if (!r) return { status: 0, body: '' };
    var body = typeof r.body === 'string' ? r.body : (r.body ? JSON.stringify(r.body) : '');
    return { status: r.status || 0, body: body, headers: r.headers || {} };
  }

  function errorResponse(err) {
    return { status: 0, body: '', error: err };
  }

  function httpGet(url, headers) {
    return new Promise(function (resolve) {
      try {
        var result = http_get(url, headers);
        if (result && typeof result.then === 'function') {
          result.then(function (r) { resolve(normalizeResponse(r)); })
                .catch(function (e) { resolve(errorResponse(e)); });
        } else if (result && typeof result.status !== 'undefined') {
          resolve(normalizeResponse(result));
        } else {
          http_get(url, headers, function (r) { resolve(normalizeResponse(r || {})); });
        }
      } catch (e) {
        try { http_get(url, headers, function (r) { resolve(normalizeResponse(r || {})); }); }
        catch (e2) { resolve(errorResponse(e2)); }
      }
    });
  }

  function httpPost(url, headers, body) {
    return new Promise(function (resolve) {
      try {
        var result = http_post(url, headers, body);
        if (result && typeof result.then === 'function') {
          result.then(function (r) { resolve(normalizeResponse(r)); })
                .catch(function (e) { resolve(errorResponse(e)); });
        } else if (result && typeof result.status !== 'undefined') {
          resolve(normalizeResponse(result));
        } else {
          http_post(url, headers, body, function (r) { resolve(normalizeResponse(r || {})); });
        }
      } catch (e) {
        try { http_post(url, headers, body, function (r) { resolve(normalizeResponse(r || {})); }); }
        catch (e2) { resolve(errorResponse(e2)); }
      }
    });
  }

  function httpGetTimed(url, headers, ms) {
    return new Promise(function (resolve) {
      var done = false;
      var timer = setTimeout(function () {
        if (!done) { done = true; resolve({ status: 0, body: '', error: new Error('timeout') }); }
      }, ms || 5000);
      httpGet(url, headers).then(function (r) {
        if (!done) { done = true; clearTimeout(timer); resolve(r); }
      }).catch(function (e) {
        if (!done) { done = true; clearTimeout(timer); resolve(errorResponse(e)); }
      });
    });
  }

  function fetchJson(url, headers) {
    return httpGet(url, headers).then(function (r) {
      if (r.status === 0 || r.status >= 400) return null;
      try { return JSON.parse(r.body); } catch (e) { return null; }
    });
  }

  function fetchText(url, headers) {
    return httpGet(url, headers).then(function (r) {
      return (r.status === 0 || r.status >= 400) ? null : (r.body || '');
    });
  }

  // ===========================================================================
  // FETCH POLYFILL — for Nuvio providers that use global fetch()
  // ===========================================================================

  (function installFetchPolyfill() {
    if (typeof globalThis.fetch !== 'undefined' && String(globalThis.fetch).indexOf('http_get') >= 0) return;

    globalThis.fetch = function (url, opts) {
      return new Promise(function (resolve) {
        var urlStr = (typeof url === 'object' && url.url) ? url.url : String(url);
        var options = opts || {};
        var method = (options.method || 'GET').toUpperCase();
        var reqHeaders = {};
        for (var k in H_MOBILE) { if (H_MOBILE.hasOwnProperty(k)) reqHeaders[k] = H_MOBILE[k]; }
        var h = options.headers || {};
        if (typeof h.forEach === 'function') {
          h.forEach(function (v, k) { reqHeaders[k] = v; });
        } else {
          for (var k in h) { if (h.hasOwnProperty(k)) reqHeaders[k] = h[k]; }
        }

        function onNativeResponse(resp) {
          if (!resp) { resolve(emptyFetchResponse(urlStr)); return; }
          var bodyStr = typeof resp.body === 'string' ? resp.body : (resp.body ? JSON.stringify(resp.body) : '');
          var ok = resp.status >= 200 && resp.status < 300;
          resolve({
            ok: ok,
            status: resp.status || (ok ? 200 : 0),
            statusText: ok ? 'OK' : 'Error',
            headers: createFetchHeaders(resp.headers),
            url: urlStr,
            redirected: false,
            json: function () { try { return Promise.resolve(JSON.parse(bodyStr)); } catch(e) { return Promise.reject(e); } },
            text: function () { return Promise.resolve(bodyStr); }
          });
        }

        try {
          if (method === 'POST') {
            http_post(urlStr, reqHeaders, options.body || '', onNativeResponse);
          } else {
            http_get(urlStr, reqHeaders, onNativeResponse);
          }
        } catch (e) {
          resolve(emptyFetchResponse(urlStr, e));
        }
      });
    };

    function emptyFetchResponse(urlStr, err) {
      var msg = err ? err.message : 'Unknown error';
      return {
        ok: false, status: 0, statusText: msg,
        headers: { get: function () { return null; }, forEach: function () {} },
        url: urlStr, redirected: false,
        json: function () { return Promise.reject(err || new Error(msg)); },
        text: function () { return Promise.resolve(''); }
      };
    }

    function createFetchHeaders(hdrs) {
      if (!hdrs || typeof hdrs !== 'object') {
        return { get: function () { return null; }, forEach: function () {} };
      }
      return {
        get: function (name) {
          var v = hdrs[name] || hdrs[name.toLowerCase()] || null;
          return Array.isArray(v) ? v[0] : v;
        },
        forEach: function (cb) {
          for (var k in hdrs) { if (hdrs.hasOwnProperty(k)) cb(hdrs[k], k); }
        }
      };
    }

    log('fetch polyfill installed');
  })();

  // ===========================================================================
  // PERSISTENT CACHE
  // ===========================================================================

  var _cache = {};

  function pCacheGet(k) {
    var c = _cache[k];
    if (c && (Date.now() - c.ts) < CACHE_TTL) return c.data;
    try {
      var raw = getPreference('hub_cache:' + k);
      if (raw) {
        var parsed = safeJson(raw, null);
        if (parsed && parsed.ts && (Date.now() - parsed.ts) < CACHE_TTL) {
          _cache[k] = parsed;
          return parsed.data;
        }
      }
    } catch (e) {}
    return null;
  }

  function pCacheSet(k, d) {
    var entry = { ts: Date.now(), data: d };
    _cache[k] = entry;
    try { setPreference('hub_cache:' + k, JSON.stringify(entry)); } catch (e) {}
  }

  // ===========================================================================
  // HTTP BATCH (parallel requests via http_parallel when available)
  // ===========================================================================

  function httpBatch(urls) {
    if (!urls.length) return Promise.resolve([]);

    var activeUrls = [], activeIndices = [];
    for (var i = 0; i < urls.length; i++) {
      if (!isRateLimited(urls[i])) {
        activeUrls.push(urls[i]);
        activeIndices.push(i);
      }
    }
    if (!activeUrls.length) {
      return Promise.resolve(urls.map(function (u) {
        return { url: u, ok: false, data: null, status: 429 };
      }));
    }

    var reqs = [];
    for (var i = 0; i < activeUrls.length; i++) {
      reqs.push({ method: 'GET', url: activeUrls[i], headers: H_JSON });
    }

    var httpFn = (typeof http_parallel === 'function')
      ? http_parallel(reqs)
      : Promise.all(reqs.map(function (r) { return httpGet(r.url, r.headers); }));

    return httpFn.then(function (responses) {
      var results = urls.map(function (u) {
        return { url: u, ok: false, data: null, status: 0 };
      });
      for (var i = 0; i < responses.length; i++) {
        var r = responses[i];
        var idx = activeIndices[i];
        var status = r ? (r.status || 0) : 0;
        if (typeof r === 'object' && r.status !== undefined) status = r.status;
        recordRateLimit(activeUrls[i], status);
        var body = r.body || r;
        var entry = { url: activeUrls[i], ok: false, data: null, status: status };
        if (body && status === 200) {
          try {
            var b = typeof body === 'string' ? body : JSON.stringify(body);
            b = b.trim();
            if (b && b.charAt(0) !== '<') { entry.data = JSON.parse(b); entry.ok = true; }
          } catch (e) {}
        }
        results[idx] = entry;
      }
      return results;
    }).catch(function () {
      return urls.map(function (u) { return { url: u, ok: false, data: null, status: 0 }; });
    });
  }

  // ===========================================================================
  // STREMIO URL HELPERS
  // ===========================================================================

  function baseUrl(m) {
    return (m || '').replace(/\/manifest\.json$/, '').replace(/\/$/, '');
  }

  function addonName(url) {
    try {
      var h = url.replace(/https?:\/\//, '').split('/')[0].replace(/^www\./, '');
      var p = h.split('.');
      if (p.length >= 2) {
        var tlds = ['com','org','net','io','app','dev','tv','co','uk','de','xyz','fun','cloud','me'];
        var b = p[0];
        if (tlds.indexOf(b) !== -1 && p.length > 1) b = p[1];
        return b.charAt(0).toUpperCase() + b.slice(1);
      }
      return p[0].charAt(0).toUpperCase() + p[0].slice(1);
    } catch (e) { return 'Addon'; }
  }

  function str(s) { return String(s == null ? '' : s); }
  function safeJson(t, f) {
    try { return JSON.parse(str(t)); } catch (e) { return f || null; }
  }
  function skyType(t) { return (t === 'movie' || t === 'short') ? 'movie' : 'series'; }

  // ===========================================================================
  // TMDB HELPERS (for ID resolution)
  // ===========================================================================

  var TMDB_KEY = '68e094699525b18a70bab2f86b1fa706';
  var TMDB_BASE = 'https://api.themoviedb.org/3';
  var _idCache = {};

  function tmdbFind(externalId, source) {
    var ck = source + ':' + externalId;
    if (_idCache[ck]) return Promise.resolve(_idCache[ck]);
    var url = TMDB_BASE + '/find/' + encodeURIComponent(externalId) +
              '?api_key=' + TMDB_KEY + '&external_source=' + source;
    return fetchJson(url, H_JSON).then(function (r) {
      if (!r) return null;
      var results = null;
      if (source === 'imdb_id') {
        results = (r.movie_results && r.movie_results.length)
          ? { tmdbId: String(r.movie_results[0].id), type: 'movie' }
          : (r.tv_results && r.tv_results.length)
            ? { tmdbId: String(r.tv_results[0].id), type: 'tv' }
            : null;
      } else if (source === 'tvdb_id') {
        results = (r.tv_results && r.tv_results.length)
          ? { tmdbId: String(r.tv_results[0].id), type: 'tv' }
          : (r.movie_results && r.movie_results.length)
            ? { tmdbId: String(r.movie_results[0].id), type: 'movie' }
            : null;
      }
      if (results) _idCache[ck] = results;
      return results;
    }).catch(function () { return null; });
  }

  function tmdbResolve(tmdbId, mediaType) {
    var ck = 'tmdb:' + mediaType + ':' + tmdbId;
    if (_idCache[ck]) return Promise.resolve(_idCache[ck]);
    var apiType = (mediaType === 'movie') ? 'movie' : 'tv';
    var url = TMDB_BASE + '/' + apiType + '/' + tmdbId + '?api_key=' + TMDB_KEY;
    return fetchJson(url, H_JSON).then(function (r) {
      if (!r) return null;
      var result = {
        tmdbId: String(tmdbId),
        imdbId: r.imdb_id || null,
        type: mediaType,
        title: r.title || r.name || '',
        year: (r.release_date || r.first_air_date || '').split('-')[0]
      };
      _idCache[ck] = result;
      return result;
    }).catch(function () { return null; });
  }

  // ===========================================================================
  // NUVIO URL HELPERS
  // ===========================================================================

  function parseNuvioUrl(url) {
    if (!url || typeof url !== 'string' || url.indexOf('nuvio://') !== 0) return null;
    var parts = url.replace('nuvio://', '').split('/');
    if (parts.length < 2) return null;
    return {
      mediaType: parts[0],
      tmdbId: parts[1],
      season: parts[2] ? parseInt(parts[2], 10) || null : null,
      episode: parts[3] ? parseInt(parts[3], 10) || null : null
    };
  }

  function cacheKey(url) {
    var p = parseNuvioUrl(url);
    if (!p) return url;
    if (p.mediaType === 'movie') return 'm:' + p.tmdbId;
    return 't:' + p.tmdbId + ':' + (p.season || '0') + ':' + (p.episode || '0');
  }

  function detectQuality(url, name, title) {
    var str = (name || '') + ' ' + (title || '') + ' ' + (url || '');
    for (var i = 0; i < QUALITY_RULES.length; i++) {
      if (QUALITY_RULES[i].re.test(str)) return QUALITY_RULES[i].label;
    }
    return null;
  }

  function isPlayable(url) {
    if (!url || typeof url !== 'string' || url.length < 5) return false;
    var u = url.toLowerCase().trim();
    if (/\.(m3u8?|mp4|mkv|webm|mpd)$/i.test(u)) return true;
    if (/\/(hls|dash)\//.test(u)) return true;
    if (u.indexOf('http://') !== 0 && u.indexOf('https://') !== 0) return false;
    return true;
  }

  // ===========================================================================
  // PROMISE HELPERS
  // ===========================================================================

  function withTimeout(promise, ms, label) {
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        reject(new Error((label || 'Operation') + ' timed out after ' + ms + 'ms'));
      }, ms);
      promise.then(function (r) { clearTimeout(timer); resolve(r); },
                   function (e) { clearTimeout(timer); reject(e); });
    });
  }

  function allSettled(promises) {
    if (!promises.length) return Promise.resolve([]);
    return Promise.all(promises.map(function (p) {
      return p.then(function (v) { return { status: 'fulfilled', value: v }; })
              .catch(function (e) { return { status: 'rejected', reason: e }; });
    }));
  }

  function pad(n, width) {
    var s = String(n);
    while (s.length < width) { s = '0' + s; }
    return s;
  }

  // ===========================================================================
  // PROVIDER DISCOVERY + CACHING
  // ===========================================================================

  var _discoveryCache = null;
  var _discoveryPromise = null;
  var _fnCache = {};
  var _streamCache = {};
  var _providerScore = {};
  var _discoveryWarmed = false;

  function getManifest(url) {
    var k = 'mf:' + url;
    var cached = pCacheGet(k);
    if (cached) return Promise.resolve(cached);
    if (isRateLimited(url)) return Promise.resolve(null);
    var p = fetchJson(url, H_JSON);
    var t = new Promise(function (r) { setTimeout(function () { r(null); }, MANIFEST_TIMEOUT); });
    return Promise.race([p, t]).then(function (d) {
      if (d) pCacheSet(k, d);
      return d;
    });
  }

  function discoverProviders() {
    if (_discoveryCache) return Promise.resolve(_discoveryCache);
    if (_discoveryPromise) return _discoveryPromise;

    _discoveryPromise = new Promise(function (resolve) {
      log('Discovering providers from ' + NUVIO_SOURCES.length + ' manifests...');
      var all = [];
      var fetches = NUVIO_SOURCES.map(function (source) {
        var baseUrl = source.url.substring(0, source.url.lastIndexOf('/'));
        return getManifest(source.url).then(function (manifest) {
          if (!manifest || !manifest.scrapers || !manifest.scrapers.length) {
            log('Empty manifest: ' + source.name);
            return;
          }
          var count = 0;
          manifest.scrapers.forEach(function (scraper) {
            if (scraper.enabled === false) return;
            if (!scraper.filename) return;
            var fileUrl = scraper.filename.indexOf('http') === 0
              ? scraper.filename
              : baseUrl + '/' + scraper.filename;
            all.push({
              id: source.id + '/' + (scraper.id || scraper.name || scraper.filename),
              name: scraper.name || scraper.id || scraper.filename,
              sourceName: source.name,
              fileUrl: fileUrl,
              supportedTypes: scraper.supportedTypes || ['movie', 'tv'],
              language: scraper.contentLanguage || ['en']
            });
            count++;
          });
          log(source.name + ': ' + count + ' providers');
        }).catch(function (e) {
          log('Manifest error: ' + source.name + ' — ' + (e.message || e));
        });
      });

      allSettled(fetches).then(function () {
        log('Discovery complete: ' + all.length + ' providers');
        _discoveryCache = all;
        _discoveryWarmed = true;
        resolve(all);
      });
    });
    return _discoveryPromise;
  }

  // ===========================================================================
  // WARM UP — Pre-warm provider discovery and cache code
  // ===========================================================================

  var _warmUpPromise = null;

  function warmUpProviders() {
    if (_warmUpPromise) return _warmUpPromise;
    if (_discoveryWarmed && Object.keys(_fnCache).length > 0) return Promise.resolve();

    _warmUpPromise = discoverProviders().then(function (providers) {
      if (!providers || !providers.length) return;
      log('Warming up ' + providers.length + ' providers...');
      // Load first batch of provider code in background
      var batch = providers.slice(0, Math.min(20, providers.length));
      var loadPromises = batch.map(function (p) {
        return loadProviderFn(p).then(function (fn) {
          if (fn) log('Warmed: ' + p.id);
          return fn;
        }).catch(function () { return null; });
      });
      return allSettled(loadPromises);
    }).then(function () {
      log('Provider warm-up complete');
    }).catch(function (e) {
      log('Warm-up error: ' + (e.message || e));
    });
    return _warmUpPromise;
  }

  // ===========================================================================
  // PROVIDER CODE LOADING
  // ===========================================================================

  function loadProviderFn(provider) {
    if (_fnCache[provider.id] !== undefined) {
      return Promise.resolve(_fnCache[provider.id]);
    }
    return httpGetTimed(provider.fileUrl, H_EXTERNAL, FETCH_CODE_TIMEOUT)
      .then(function (res) {
        if (res.status === 0 || !res.body) {
          _fnCache[provider.id] = null;
          return null;
        }
        var code = res.body.replace(/^["']use strict["'];?\s*/m, '');
        var fn = tryExecStrategy1(code) ||
                 tryExecStrategy2(code) ||
                 tryExecStrategy3(code);
        _fnCache[provider.id] = fn || null;
        return fn || null;
      })
      .catch(function () {
        _fnCache[provider.id] = null;
        return null;
      });
  }

  function tryExecStrategy1(code) {
    try {
      var mod = { exports: {} };
      // Strategy: wrap in function(module) { ... }; return module.exports
      var wrap = new Function('return (function(module){' + code + '\nreturn module.exports;})')();
      var exports = wrap(mod);
      if (exports && typeof exports.getStreams === 'function') return exports.getStreams;
    } catch (e) {}
    return null;
  }

  function tryExecStrategy2(code) {
    try {
      // Strategy: define module + exports in scope
      var wrap = new Function(
        'return (function(){var module={exports:{}},exports=module.exports;'
        + code + '\nreturn module.exports;})()'
      );
      var exports = wrap();
      if (exports && typeof exports.getStreams === 'function') return exports.getStreams;
    } catch (e) {}
    return null;
  }

  function tryExecStrategy3(code) {
    try {
      // Strategy: pass module as arg
      var wrap = new Function('return (function(m){' + code + '\nreturn m.exports||{};})');
      var exports = wrap({ exports: {} });
      if (exports && typeof exports.getStreams === 'function') return exports.getStreams;
    } catch (e) {}
    return null;
  }

  function callProvider(fn, tmdbId, mediaType, season, episode, label) {
    return withTimeout(
      fn(tmdbId, mediaType, season, episode),
      PROVIDER_TIMEOUT,
      label
    ).then(function (result) {
      return Array.isArray(result) ? result : [];
    }).catch(function () {
      return [];
    });
  }

  // ===========================================================================
  // STREAM RESULT NORMALIZATION — IMPROVED
  // ===========================================================================

  /**
   * Build a rich display label from a Nuvio provider stream result.
   * Nuvio providers return streams with:
   *   name:   e.g. "4KHDHub - FSL 1080p [Hindi DD5.1]"
   *   title:  e.g. "Movie.2024.1080p.WEBRip\n1.45 GB"
   *   quality: e.g. "1080p"
   *   subtitles: optional array of { url, language }
   *   headers: optional object
   *
   * SkyStream displays:
   *   source: the label shown in the stream list
   *   quality: used for grouping/sorting
   *   subtitles: optional
   */
  function toStreamResult(s, providerName) {
    if (!s || !s.url) return null;

    // Filter out non-playable URLs (unless they have headers that make them playable)
    if (!isPlayable(s.url) && (!s.headers || typeof s.headers !== 'object' || Object.keys(s.headers).length === 0)) {
      return null;
    }

    // Extract quality from provider's `quality` field, or detect from name/title/url
    var quality = s.quality || detectQuality(s.url, s.name, s.title) || null;

    // ---- Build a descriptive source label ----
    // Format: "ProviderName • Quality • AudioInfo"
    var label = providerName || '';

    // Include the provider's original name if it differs and is informative
    var originalName = (s.name || '').trim();
    if (originalName && originalName.indexOf(providerName) === -1) {
      // The provider's name has extra info (e.g. server name, audio)
      label = originalName;
    } else if (quality) {
      label += ' \u2022 ' + quality;
    }

    // Append size if available
    if (s.size) {
      label += ' \u2022 ' + s.size;
    }

    // Append language info from provider title if available
    // Many Nuvio providers include [Hindi], [Tamil], [English] etc. in their name/title
    var langMatch = (originalName + ' ' + str(s.title || '')).match(/\[([^\]]*(?:hindi|tamil|telugu|malayalam|kannada|english|japanese|korean|chinese|dubbed|dual)[^\]]*)\]/i);
    if (langMatch && label.indexOf(langMatch[1]) === -1) {
      label += ' \u2022 [' + langMatch[1] + ']';
    }

    // Audio info
    var audioMatch = (originalName + ' ' + str(s.title || '')).match(/(DD5\.1|Dolby|AAC|5\.1|2\.0|HD[\s-]?Audio)/i);
    if (audioMatch && label.indexOf(audioMatch[1]) === -1) {
      label += ' \u2022 ' + audioMatch[1];
    }

    // ---- Build result ----
    var result = {
      url: s.url,
      source: label,
      quality: quality,
      headers: s.headers || {}
    };

    // Subtitles passthrough
    var subs = s.subtitles || s.subs || undefined;
    if (subs) {
      result.subtitles = Array.isArray(subs) ? subs : [subs];
    }

    // If provider has infoHash (torrent support), pass it through
    if (s.infoHash) result.infoHash = s.infoHash;
    if (s.fileIdx !== undefined) result.fileIdx = s.fileIdx;

    return result;
  }

  function sortByScore(providers) {
    return providers.slice().sort(function (a, b) {
      var sa = _providerScore[a.id] || 0;
      var sb = _providerScore[b.id] || 0;
      if (sa !== sb) return sb - sa;
      return (a.name || '').localeCompare(b.name || '');
    });
  }

  // ===========================================================================
  // PARALLEL NUVIO STREAM FETCHING — IMPROVED with staggering + warm-up
  // ===========================================================================

  function fetchNuvioStreams(tmdbId, mediaType, season, episode) {
    var startTime = Date.now();
    return discoverProviders().then(function (providers) {
      if (!providers || providers.length === 0) return [];

      // Filter to matching providers
      var valid = [];
      for (var i = 0; i < providers.length; i++) {
        var p = providers[i];
        var types = p.supportedTypes || ['movie', 'tv'];
        if (types.indexOf(mediaType) >= 0) valid.push(p);
      }
      if (valid.length === 0) return [];

      // Sort by score (previously successful providers first)
      valid = sortByScore(valid);

      log('Nuvio fetch: ' + valid.length + ' providers for ' + mediaType + ' ' + tmdbId);
      return parallelStreamFetch(valid, tmdbId, mediaType, season, episode, startTime);
    });
  }

  function parallelStreamFetch(providers, tmdbId, mediaType, season, episode, startTime) {
    var total = providers.length;
    var cursor = 0;
    var activeCount = 0;
    var allStreams = [];
    var seenUrls = {};
    var hardDeadline = STREAM_TIMEOUT;
    var done = false;
    var scheduledCount = 0;

    return new Promise(function (resolve) {
      // Hard deadline: always resolve (no soft deadline — wait for all providers)
      var hardTimer = setTimeout(function () {
        if (!done) {
          done = true;
          log('Nuvio deadline: ' + allStreams.length + ' streams at ' +
              (Date.now() - startTime) + 'ms');
          resolve(allStreams);
        }
      }, hardDeadline);

      function startProvider(provider) {
        var idx = scheduledCount++;
        activeCount++;

        // Stagger start to avoid hammering servers
        var delay = idx * STAGGER_MS;

        function doStart() {
          loadProviderFn(provider).then(function (fn) {
            if (!fn) { activeCount--; scheduleNext(); return; }

            var retries = (_providerScore[provider.id] || 0) > 0 ? MAX_RETRIES : 0;

            function attemptCall(remainingRetries) {
              callProvider(fn, tmdbId, mediaType, season, episode, provider.name)
                .then(function (streams) {
                  if (Array.isArray(streams) && streams.length > 0) {
                    var added = 0;
                    for (var si = 0; si < streams.length; si++) {
                      var sr = toStreamResult(streams[si], provider.name);
                      if (sr && !seenUrls[sr.url]) {
                        seenUrls[sr.url] = true;
                        allStreams.push(sr);
                        added++;
                      }
                    }
                    // Score based on unique streams contributed
                    _providerScore[provider.id] = (_providerScore[provider.id] || 0) + added;
                    if (added > 0) {
                      log(provider.name + ': ' + added + ' streams');
                    }
                  } else if (remainingRetries > 0) {
                    // Retry if empty result from a provider that previously worked
                    setTimeout(function () { attemptCall(remainingRetries - 1); }, 500);
                    return;
                  }
                  activeCount--; scheduleNext();
                })
                .catch(function () {
                  if (remainingRetries > 0) {
                    setTimeout(function () { attemptCall(remainingRetries - 1); }, 500);
                    return;
                  }
                  activeCount--; scheduleNext();
                });
            }
            attemptCall(retries);
          }).catch(function () {
            activeCount--; scheduleNext();
          });
        }

        if (delay > 0) {
          setTimeout(doStart, delay);
        } else {
          doStart();
        }
      }

      function scheduleNext() {
        while (!done && activeCount < BATCH_SIZE && cursor < total) {
          startProvider(providers[cursor++]);
        }
        if (activeCount === 0 && !done) {
          done = true;
          clearTimeout(hardTimer);
          log('Nuvio done: ' + allStreams.length + ' streams in ' +
              (Date.now() - startTime) + 'ms');
          resolve(allStreams);
        }
      }

      scheduleNext();
    });
  }

  // ===========================================================================
  // STREMIO META → MULTIMEDIA ITEM
  // ===========================================================================

  function parseYear(meta) {
    if (!meta) return undefined;
    if (meta.year != null) {
      var y = parseInt(meta.year, 10);
      if (y > 1900 && y < 2100) return y;
    }
    if (meta.releaseInfo) {
      var parts = str(meta.releaseInfo).split(/[–-]/).shift().trim();
      var y = parseInt(parts, 10);
      if (y > 1900 && y < 2100) return y;
    }
    return undefined;
  }

  function parseRating(meta) {
    if (meta.imdbRating != null) {
      var r = parseFloat(meta.imdbRating);
      if (!isNaN(r) && r >= 0 && r <= 10) return r;
    }
    if (meta.score != null) {
      var r = parseFloat(meta.score);
      if (!isNaN(r) && r >= 0 && r <= 10) return r;
    }
    return undefined;
  }

  function parseGenres(meta) {
    var g = meta.genres || meta.genre || meta.tags;
    return (Array.isArray(g) && g.length) ? g : undefined;
  }

  function stremioToItem(m, fallbackType) {
    try {
      if (!m || !m.id) return null;
      return new MultimediaItem({
        title: m.name || m.title || m.originalName || 'Unknown',
        url: m.id || '',
        posterUrl: m.poster || m.posterUrl || m.thumbnail || '',
        bannerUrl: m.background || m.backdrop || m.banner || m.bannerUrl || '',
        logoUrl: m.logo || m.logoUrl || '',
        type: skyType(m.type || fallbackType || 'movie'),
        description: str(m.description || m.overview || m.synopsis || '')
                      .replace(/<[^>]*>/g, '').trim().substring(0, 500),
        year: parseYear(m),
        score: parseRating(m),
        genres: parseGenres(m)
      });
    } catch (e) { return null; }
  }

  function parseVideoId(raw) {
    if (!raw) return null;
    var p = safeJson(raw, null);
    if (p && p.i !== undefined) {
      return { id: str(p.i), type: p.t || null, season: p.s || 0, episode: p.e || 0 };
    }
    if (p && p.tmdbId !== undefined) {
      return {
        id: str(p.tmdbId),
        type: p.mediaType || null,
        season: p.seasonNumber || 0,
        episode: p.episodeNumber || 0
      };
    }
    if (raw.indexOf(':') !== -1) {
      var parts = raw.split(':');
      var first = parts[0];
      if (/^tt\d+$/.test(first) && parts.length >= 3) {
        var sn = parseInt(parts[1], 10);
        var en = parseInt(parts[2], 10);
        return { id: first, type: 'series', season: isNaN(sn) ? 0 : sn, episode: isNaN(en) ? 0 : en };
      }
      if (first.indexOf('_') !== -1 || first.indexOf('-') !== -1) {
        return { id: raw, type: 'series', season: 0, episode: 0 };
      }
      if (/^[a-zA-Z]+$/.test(first) && parts.length >= 2) {
        return { id: raw, type: null, season: 0, episode: 0 };
      }
    }
    return { id: raw, type: null, season: 0, episode: 0 };
  }

  // ===========================================================================
  // normalizeId — resolve any ID to a canonical TMDB numeric ID
  // ===========================================================================

  function normalizeId(rawInput) {
    var raw = str(rawInput).trim();
    if (!raw) return Promise.resolve({ tmdbId: null, mediaType: 'movie', season: 0, episode: 0 });

    var season = 0, episode = 0;
    var mediaType = 'movie';
    var tmdbId = null;
    var imdbId = null;

    // Extract season/episode from various formats
    var epParts = raw.match(/^(.+?)(?::(\d+):(\d+))?$/);
    var baseId = epParts ? epParts[1] : raw;
    if (epParts && epParts[2]) season = parseInt(epParts[2], 10) || 0;
    if (epParts && epParts[3]) episode = parseInt(epParts[3], 10) || 0;

    // nuvio:// URL format
    var nuvioP = parseNuvioUrl(raw);
    if (nuvioP) {
      tmdbId = nuvioP.tmdbId;
      mediaType = (nuvioP.mediaType === 'tv') ? 'series' : 'movie';
      season = nuvioP.season || 0;
      episode = nuvioP.episode || 0;
      return Promise.resolve({ tmdbId: tmdbId, mediaType: mediaType, season: season, episode: episode, isNuvio: true });
    }

    // tmdb:movie:550 or tmdb:series:1668
    var tmdbMatch = baseId.match(/^tmdb:(movie|series|tv):(\d+)$/);
    if (tmdbMatch) {
      tmdbId = tmdbMatch[2];
      mediaType = (tmdbMatch[1] === 'movie') ? 'movie' : 'series';
      if (season || episode) mediaType = 'series';
      return Promise.resolve({ tmdbId: tmdbId, mediaType: mediaType, season: season, episode: episode });
    }

    // IMDB ID: tt0137523 or tt0137523:1:2
    var imdbMatch = baseId.match(/^(tt\d+)$/i);
    if (imdbMatch) {
      imdbId = imdbMatch[1];
      return tmdbFind(imdbId, 'imdb_id').then(function (found) {
        if (found) {
          return {
            tmdbId: found.tmdbId,
            mediaType: (found.type === 'tv') ? 'series' : (season || episode) ? 'series' : 'movie',
            season: season,
            episode: episode,
            imdbId: imdbId
          };
        }
        return { tmdbId: imdbId, mediaType: (season || episode) ? 'series' : 'movie', season: season, episode: episode, imdbId: imdbId };
      });
    }

    // Plain numeric TMDB ID
    if (/^\d+$/.test(baseId)) {
      tmdbId = baseId;
      mediaType = (season || episode) ? 'series' : 'movie';
      return Promise.resolve({ tmdbId: tmdbId, mediaType: mediaType, season: season, episode: episode });
    }

    // Fallback: use as-is
    return Promise.resolve({ tmdbId: baseId, mediaType: (season || episode) ? 'series' : 'movie', season: season, episode: episode });
  }

  // ===========================================================================
  // GET HOME
  // ===========================================================================

  async function getHome(cb, page) {
    try {
      var pn = parseInt(page) || 1;
      var urls = getCatalogueAddons();
      if (!urls.length) {
        return cb({ success: false, errorCode: 'NO_ADDONS', message: 'No catalogueAddons' });
      }

      var results = { data: {}, order: [] };

      // Fetch manifests (batched)
      var manifests = {};
      var uncached = [];
      for (var i = 0; i < urls.length; i++) {
        var cached = pCacheGet('mf:' + urls[i]);
        if (cached) {
          manifests[urls[i]] = cached;
        } else {
          uncached.push(urls[i]);
        }
      }
      if (uncached.length) {
        var mfRes = await httpBatch(uncached);
        for (var j = 0; j < mfRes.length; j++) {
          if (mfRes[j].ok && mfRes[j].data) {
            manifests[uncached[j]] = mfRes[j].data;
            pCacheSet('mf:' + uncached[j], mfRes[j].data);
          }
        }
      }

      // Build catalog URLs
      var catalogEntries = [];
      for (var ai = 0; ai < urls.length; ai++) {
        var mf = manifests[urls[ai]];
        if (!mf || !Array.isArray(mf.catalogs) || !mf.catalogs.length) continue;
        var bu = baseUrl(urls[ai]);
        for (var ci = 0; ci < mf.catalogs.length; ci++) {
          var cat = mf.catalogs[ci];
          if (!cat || !cat.id || !cat.type) continue;
          var extras = cat.extra || [];
          if (extras.some(function (e) { return e && e.name === 'search' && e.isRequired === true; })) continue;
          var catUrl = bu + '/catalog/' + cat.type + '/' + cat.id + '.json';
          if (pn > 1) catUrl += (catUrl.indexOf('?') === -1 ? '?' : '&') + 'skip=' + ((pn - 1) * 20);
          catalogEntries.push({
            url: catUrl,
            catName: cat.name || cat.id,
            catType: cat.type
          });
        }
      }

      if (!catalogEntries.length) {
        return cb({ success: false, errorCode: 'NO_DATA', message: 'No catalogs' });
      }

      var catResults = await httpBatch(catalogEntries.map(function (c) { return c.url; }));

      for (var ri = 0; ri < catResults.length; ri++) {
        var cr = catResults[ri];
        var info = catalogEntries[ri];
        if (!cr.ok || !cr.data || !Array.isArray(cr.data.metas) || !cr.data.metas.length) continue;
        var items = cr.data.metas.map(function (m) { return stremioToItem(m, info.catType); }).filter(Boolean);
        if (!items.length) continue;
        if (!results.data[info.catName]) {
          results.data[info.catName] = items;
          results.order.push(info.catName);
        }
      }

      if (!Object.keys(results.data).length) {
        return cb({ success: false, errorCode: 'NO_DATA', message: 'No catalog data' });
      }

      var out = {};
      for (var i = 0; i < results.order.length; i++) {
        if (results.data[results.order[i]]) out[results.order[i]] = results.data[results.order[i]];
      }
      log('getHome: ' + Object.keys(out).length + ' categories');
      cb({ success: true, data: out, page: pn });
    } catch (e) {
      warn('getHome error: ' + (e.message || e));
      cb({ success: false, errorCode: 'HOME_ERROR', message: e.message || 'Error' });
    }
  }

  // ===========================================================================
  // SEARCH
  // ===========================================================================

  async function search(query, cb) {
    try {
      var q = str(query).trim().toLowerCase();
      if (!q) return cb({ success: true, data: [] });

      var urls = getCatalogueAddons();
      if (!urls.length) return cb({ success: true, data: [] });

      var all = [];
      var seen = {};
      function addItem(item) {
        if (item && item.url && !seen[item.url]) { seen[item.url] = true; all.push(item); }
      }

      // Fetch manifests
      var manifests = {};
      var uncached = [];
      for (var i = 0; i < urls.length; i++) {
        var c = pCacheGet('mf:' + urls[i]);
        if (c) { manifests[urls[i]] = c; }
        else { uncached.push(urls[i]); }
      }
      if (uncached.length) {
        var mfRes = await httpBatch(uncached);
        for (var j = 0; j < mfRes.length; j++) {
          if (mfRes[j].ok && mfRes[j].data) {
            manifests[uncached[j]] = mfRes[j].data;
            pCacheSet('mf:' + uncached[j], mfRes[j].data);
          }
        }
      }

      // Build search URLs
      var searchEntries = [];
      for (var ai = 0; ai < urls.length; ai++) {
        var mf = manifests[urls[ai]];
        if (!mf || !Array.isArray(mf.catalogs) || !mf.catalogs.length) continue;
        var bu = baseUrl(urls[ai]);
        for (var ci = 0; ci < mf.catalogs.length; ci++) {
          var cat = mf.catalogs[ci];
          if (!cat || !cat.id || !cat.type) continue;
          var extras = cat.extra || [];
          if (extras.some(function (e) { return e && e.name === 'search'; })) {
            searchEntries.push({
              url: bu + '/catalog/' + cat.type + '/' + cat.id + '/search=' + encodeURIComponent(query) + '.json',
              catType: cat.type,
              isSearch: true
            });
          } else if (searchEntries.length < 20) {
            // Also check browse catalogs for title matching
            searchEntries.push({
              url: bu + '/catalog/' + cat.type + '/' + cat.id + '.json',
              catType: cat.type,
              isSearch: false
            });
          }
        }
      }

      if (!searchEntries.length) return cb({ success: true, data: [] });

      var sResults = await httpBatch(searchEntries.map(function (s) { return s.url; }));

      var foundSearch = false;
      for (var ri = 0; ri < sResults.length; ri++) {
        var sr = sResults[ri];
        var info = searchEntries[ri];
        if (!sr.ok || !sr.data) continue;
        if (info.isSearch) {
          if (Array.isArray(sr.data.metas) && sr.data.metas.length) {
            foundSearch = true;
            for (var mi = 0; mi < sr.data.metas.length; mi++) {
              addItem(stremioToItem(sr.data.metas[mi], info.catType));
            }
          }
        }
      }

      // Fallback: filter browse catalogs by name match
      if (!foundSearch) {
        for (var ri = 0; ri < sResults.length; ri++) {
          var sr = sResults[ri];
          var info = searchEntries[ri];
          if (info.isSearch || !sr.ok || !sr.data || !Array.isArray(sr.data.metas)) continue;
          for (var mi = 0; mi < sr.data.metas.length; mi++) {
            var m = sr.data.metas[mi];
            if (str(m.name || m.title || '').toLowerCase().indexOf(q) !== -1) {
              addItem(stremioToItem(m, info.catType));
            }
          }
        }
      }

      cb({ success: true, data: all });
    } catch (e) {
      warn('search error: ' + (e.message || e));
      cb({ success: true, data: [] });
    }
  }

  // ===========================================================================
  // LOAD (metadata) — with provider warm-up
  // ===========================================================================

  async function load(url, cb) {
    try {
      var rawInput = str(url).trim();
      if (!rawInput) return cb({ success: false, errorCode: 'PARSE_ERROR', message: 'No ID' });

      // Resolve the ID to its canonical form
      var resolved = await normalizeId(rawInput);
      var metaId = resolved.tmdbId;
      var knownType = resolved.mediaType;
      var season = resolved.season;
      var episode = resolved.episode;

      if (!metaId) return cb({ success: false, errorCode: 'PARSE_ERROR', message: 'No ID' });

      // Try to resolve TMDB ID to IMDB for metadata lookup (Stremio addons
      // work better with IMDB IDs)
      var metaLookupId = metaId;
      if (/^\d+$/.test(metaId)) {
        var info = await tmdbResolve(metaId, knownType === 'series' ? 'tv' : 'movie');
        if (info && info.imdbId) {
          metaLookupId = info.imdbId;
        }
      }

      // Pre-warm Nuvio provider discovery & code loading in background
      warmUpProviders();

      var addonUrls = getCatalogueAddons();
      if (!addonUrls.length) {
        return respondMeta({ name: 'Content', id: metaLookupId, type: knownType || 'movie' }, metaId, cb);
      }

      // Fetch metadata from Stremio addons
      var eid = encodeURIComponent(metaLookupId);
      var tryTypes = knownType
        ? [knownType, 'movie', 'series', 'anime', 'channel', 'tv']
        : ['movie', 'series', 'anime', 'channel', 'tv'];

      var metaBatchUrls = [];
      var metaBatchInfo = [];
      for (var ai = 0; ai < addonUrls.length; ai++) {
        var bu = baseUrl(addonUrls[ai]);
        for (var ti = 0; ti < tryTypes.length; ti++) {
          metaBatchUrls.push(bu + '/meta/' + tryTypes[ti] + '/' + eid + '.json');
          metaBatchInfo.push({ type: tryTypes[ti] });
        }
      }

      var metaResults = await httpBatch(metaBatchUrls);

      var foundMeta = null;
      for (var ri = 0; ri < metaResults.length; ri++) {
        var mr = metaResults[ri];
        if (!mr.ok || !mr.data) continue;
        var infoEntry = metaBatchInfo[ri];
        var isNonMovie = infoEntry && infoEntry.type !== 'movie';
        if (mr.data.meta && mr.data.meta.id) {
          if (isNonMovie) { foundMeta = mr.data.meta; break; }
          if (!foundMeta) foundMeta = mr.data.meta;
        }
        if (Array.isArray(mr.data.metas) && mr.data.metas.length && mr.data.metas[0].id) {
          if (isNonMovie) { foundMeta = mr.data.metas[0]; break; }
          if (!foundMeta) foundMeta = mr.data.metas[0];
        }
      }

      // Determine the stream ID to use for Nuvio provider calls
      // Nuvio providers expect TMDB numeric IDs
      var streamTmdbId = resolved.isNuvio ? resolved.tmdbId : null;
      var streamMediaType = knownType;
      var streamSeason = season;
      var streamEpisode = episode;

      if (!streamTmdbId) {
        // Derive TMDB ID from metadata
        if (foundMeta) {
          // Prefer explicit tmdb_id from metadata
          if (foundMeta.tmdb_id) {
            streamTmdbId = String(foundMeta.tmdb_id);
          } else if (foundMeta.id && /^\d+$/.test(foundMeta.id)) {
            streamTmdbId = foundMeta.id;
          } else if (foundMeta.imdb_id && /^tt\d+$/i.test(foundMeta.imdb_id)) {
            // Resolve IMDB to TMDB
            var im = await tmdbFind(foundMeta.imdb_id, 'imdb_id');
            if (im && im.tmdbId) streamTmdbId = im.tmdbId;
          }
        }
        if (!streamTmdbId) streamTmdbId = metaId;
      }

      if (foundMeta) {
        respondMeta(foundMeta, metaLookupId, cb);
      } else {
        var isSeries = (knownType === 'series' || knownType === 'anime' || knownType === 'tv');
        respondMeta({ name: 'Content', id: metaLookupId, type: isSeries ? 'series' : 'movie' }, metaLookupId, cb);
      }

      // (pre-fetch removed — all streams fetched fresh on play)
    } catch (e) {
      warn('load error: ' + (e.message || e));
      try {
        respondMeta({ name: 'Unknown', id: str(url).trim(), type: 'movie' }, str(url).trim(), cb);
      } catch (f) {
        cb({ success: false, errorCode: 'LOAD_ERROR', message: e.message || 'Error' });
      }
    }
  }

  // ===========================================================================
  // RESPOND META
  // ===========================================================================

  function respondMeta(meta, metaId, cb) {
    try {
      var t = meta.type || 'movie';
      var st = skyType(t);
      var y = parseYear(meta);
      var s = parseRating(meta);
      var desc = str(meta.description || meta.overview || meta.synopsis || '')
                  .replace(/<[^>]*>/g, '').trim();
      var eps = [];
      var isSeries = (st !== 'movie');

      // Build stream ID for episode URLs
      var streamId = metaId;
      if (meta.imdb_id && /^tt\d+$/i.test(meta.imdb_id)) streamId = meta.imdb_id;
      else if (meta.id && /^tt\d+$/i.test(meta.id)) streamId = meta.id;

      // Also try to include TMDB id for nuvio providers
      var nuvioStreamId = meta.tmdb_id ? String(meta.tmdb_id) : streamId;

      if (isSeries && Array.isArray(meta.videos) && meta.videos.length) {
        for (var vi = 0; vi < meta.videos.length; vi++) {
          try {
            var v = meta.videos[vi];
            if (!v || !v.id) continue;
            var sn = v.season || 1;
            var en = v.episode || v.number || 1;
            // Pack TMDB ID + season/episode into url for Nuvio providers
            var epUrl = nuvioStreamId + ':' + sn + ':' + en;
            eps.push(new Episode({
              name: v.name || v.title || 'Episode ' + en,
              url: epUrl,
              season: sn,
              episode: en,
              posterUrl: v.thumbnail || v.poster || meta.poster || '',
              description: v.overview || v.description || '',
              airDate: v.released || v.firstAired || ''
            }));
          } catch (e) {}
        }
      }

      if (!eps.length) {
        var vid = isSeries ? (nuvioStreamId + ':1:1') : nuvioStreamId;
        eps.push(new Episode({
          name: st === 'movie' ? 'Full Movie' : 'Watch',
          url: vid,
          season: 1,
          episode: 1,
          posterUrl: meta.poster || ''
        }));
      }

      // Cast
      var cast = undefined;
      if (Array.isArray(meta.cast) && meta.cast.length) {
        cast = [];
        for (var ci = 0; ci < meta.cast.length; ci++) {
          try {
            var c = meta.cast[ci];
            if (!c) continue;
            cast.push(typeof c === 'string'
              ? new Actor({ name: c, role: '', image: '' })
              : new Actor({
                  name: c.name || c.fullName || c.person || '',
                  role: c.role || c.character || '',
                  image: c.image || c.picture || c.photo || c.profile || c.profile_path || ''
                }));
          } catch (e) {}
        }
        if (!cast.length) cast = undefined;
      }

      // Trailers
      var trailers = undefined;
      if (Array.isArray(meta.trailers) && meta.trailers.length) {
        trailers = [];
        for (var tri = 0; tri < meta.trailers.length; tri++) {
          try {
            var tr = meta.trailers[tri];
            if (!tr) continue;
            var src = tr.source || tr.url || '';
            var trUrl = (src.indexOf('http') === 0) ? src : 'https://www.youtube.com/watch?v=' + src;
            trailers.push(new Trailer({ url: trUrl, name: tr.name || tr.type || 'Trailer' }));
          } catch (e) {}
        }
        if (!trailers.length) trailers = undefined;
      }

      // Director
      var director = undefined;
      if (meta.director) {
        director = Array.isArray(meta.director)
          ? meta.director.filter(Boolean).join(', ')
          : str(meta.director);
        if (!director) director = undefined;
      }

      // Status
      var status = undefined;
      if (meta.status) {
        var sv = str(meta.status).toLowerCase();
        if (sv === 'ended') status = 'completed';
        else if (sv === 'returning series' || sv === 'continuing' || sv === 'ongoing') status = 'ongoing';
        else if (sv === 'in production' || sv === 'planned') status = 'upcoming';
      }

      cb({
        success: true,
        data: new MultimediaItem({
          title: meta.name || meta.title || 'Unknown',
          url: metaId,
          posterUrl: meta.poster || meta.posterUrl || '',
          posterShape: meta.posterShape || 'poster',
          bannerUrl: meta.background || meta.backdrop || meta.banner || '',
          logoUrl: meta.logo || meta.logoUrl || '',
          type: st,
          description: desc,
          year: y,
          score: s,
          genres: parseGenres(meta),
          cast: cast,
          director: director,
          trailers: trailers,
          runtime: meta.runtime ? str(meta.runtime) : undefined,
          language: meta.language || undefined,
          country: meta.country || undefined,
          awards: meta.awards || undefined,
          website: meta.website || undefined,
          status: status,
          episodes: eps
        })
      });
    } catch (e) {
      warn('respondMeta error: ' + (e.message || e));
      var ft = skyType(meta.type || 'movie');
      cb({
        success: true,
        data: new MultimediaItem({
          title: meta.name || meta.title || 'Unknown',
          url: metaId,
          type: ft,
          episodes: [new Episode({
            name: 'Play',
            url: ft === 'movie' ? metaId : (metaId + ':1:1'),
            season: 1,
            episode: 1
          })]
        })
      });
    }
  }

  // ===========================================================================
  // LOAD STREAMS
  // ===========================================================================

  function loadStreams(url, cb) {
    log('loadStreams: ' + url);

    var called = false;
    function once(data) {
      if (!called) { called = true; cb(data); }
    }

    function withTimeout_(promise) {
      return withTimeout(promise, STREAM_TIMEOUT, 'Stream fetch')
        .catch(function () { return []; });
    }

    function bgFetch(promise, cacheKey) {
      promise.then(function (streams) {
        if (Array.isArray(streams) && streams.length) {
          pCacheSet(cacheKey, { success: true, data: streams });
        }
      }).catch(function () {});
      return promise;
    }

    // ---- Nuvio URL format ----
    var nuvioP = parseNuvioUrl(url);
    if (nuvioP) {
      var key = cacheKey(url);
      if (_streamCache[key]) {
        log('Cache hit (mem): ' + _streamCache[key].length + ' streams');
        return once({ success: true, data: _streamCache[key] });
      }
      var pcached = pCacheGet('streams:' + key);
      if (pcached && pcached.success && pcached.data && pcached.data.length) {
        _streamCache[key] = pcached.data;
        log('Cache hit (persist): ' + pcached.data.length + ' streams');
        return once({ success: true, data: pcached.data });
      }
      var typeStr = (nuvioP.mediaType === 'tv') ? 'series' : 'movie';
      var real = fetchAllStreams(nuvioP.tmdbId, typeStr, nuvioP.season || 0, nuvioP.episode || 0);
      bgFetch(real, 'streams:' + key);
      withTimeout_(real).then(function (streams) {
        _streamCache[key] = streams;
        once({ success: true, data: streams });
      });
      return;
    }

    // ---- Normalize to TMDB ID ----
    var raw = str(url).trim();
    normalizeId(raw).then(function (resolved) {
      var tmdbId = resolved.tmdbId;
      var mediaType = resolved.mediaType;
      var season = resolved.season;
      var episode = resolved.episode;

      if (!tmdbId) {
        return once({ success: true, data: [] });
      }

      // Check cache
      var cacheKeyStr = 'streams:' + tmdbId + ':' + mediaType + ':' + season + ':' + episode;
      if (_streamCache[cacheKeyStr]) {
        return once({ success: true, data: _streamCache[cacheKeyStr] });
      }
      var pcached = pCacheGet('streams:' + cacheKeyStr);
      if (pcached && pcached.success && pcached.data && pcached.data.length) {
        _streamCache[cacheKeyStr] = pcached.data;
        return once({ success: true, data: pcached.data });
      }

      // Warm up providers if not already done
      warmUpProviders();

      // Fetch streams
      var nuvioType = (mediaType === 'series') ? 'tv' : 'movie';
      var real = fetchAllStreams(tmdbId, nuvioType, season, episode);

      // Background cache
      bgFetch(real, 'streams:' + cacheKeyStr);

      // Timeout + respond
      withTimeout_(real).then(function (streams) {
        _streamCache[cacheKeyStr] = streams;
        once({ success: true, data: streams });
      });
    }).catch(function (e) {
      warn('loadStreams error: ' + (e.message || e));
      once({ success: true, data: [] });
    });
  }

  // ===========================================================================
  // FETCH ALL STREAMS (aggregate + sort)
  // ===========================================================================

  function fetchAllStreams(tmdbId, mediaType, season, episode) {
    if (!tmdbId) return Promise.resolve([]);
    // Nuvio expects 'tv' for series, 'movie' for movies
    var nuvioType = (mediaType === 'movie') ? 'movie' : 'tv';
    log('fetchAllStreams: tmdbId=' + tmdbId + ' type=' + nuvioType + ' s=' + season + ' e=' + episode);

    return fetchNuvioStreams(tmdbId, nuvioType, season, episode).then(function (streams) {
      if (!Array.isArray(streams)) return [];
      // Sort by quality (best first)
      streams.sort(function (a, b) {
        var ka = QUALITY_ORDER[(a && a.quality) || 'Auto'] || 2;
        var kb = QUALITY_ORDER[(b && b.quality) || 'Auto'] || 2;
        return kb - ka;
      });
      return streams;
    });
  }

  // ===========================================================================
  // EXPORTS
  // ===========================================================================

  globalThis.getHome = getHome;
  globalThis.search = search;
  globalThis.load = load;
  globalThis.loadStreams = loadStreams;

  log('Plugin v2 loaded — ' + NUVIO_SOURCES.length + ' Nuvio sources, ' +
      getCatalogueAddons().length + ' Stremio catalog addons');
})();
