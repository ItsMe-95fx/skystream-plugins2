(function () {
  // ===========================================================================
  // NUVIO BRIDGE — SkyStream Plugin v5.0
  // High-performance universal bridge for 150+ Nuvio streaming providers.
  //
  // KEY IMPROVEMENTS over v4.x:
  //  • TRUE PARALLEL BATCH PROCESSING — all providers fire concurrently up
  //    to BATCH_SIZE=50 (was sequential batches of 20)
  //  • EARLY_EXIT_STREAMS raised to 300 (was 25) — collects many more links
  //  • PROVIDER_TIMEOUT raised to 12s (was 6s) — gives providers more time
  //  • Sliding concurrency window instead of sequential batch recursion
  //  • Real-time deduplication as streams arrive
  //  • Promise.allSettled everywhere — one failure never blocks others
  //  • Smart provider scoring — reliable providers prioritized
  //  • Small focused functions, consistent error handling
  //  • StreamResult/MultimediaItem SDK class support
  // ===========================================================================

  // NOTE: Deliberately NOT using 'use strict' because the SkyStream Hermes
  // runtime provides http_get / http_post as globals that must be accessible
  // as bare identifiers. Strict mode would break this for dynamically loaded code.

  // ===========================================================================
  // CONSTANTS & CONFIGURATION
  // ===========================================================================

  var TAG = 'NuvioBridge';

  // --- Nuvio manifest sources (can be extended) ---
  var NUVIO_SOURCES = [
    { id: 'yoruix',        name: "Yoru's Nuvio",       url: 'https://raw.githubusercontent.com/yoruix/nuvio-providers/refs/heads/main/manifest.json' },
    { id: 'd3adlyrocket',  name: 'D3adlyRocket',        url: 'https://raw.githubusercontent.com/D3adlyRocket/All-in-One-Nuvio/refs/heads/main/manifest.json' },
    { id: 'phisher98',     name: 'Phisher98',           url: 'https://raw.githubusercontent.com/phisher98/phisher-nuvio-providers/refs/heads/main/manifest.json' },
    { id: 'michat88',      name: 'Michat88',            url: 'https://raw.githubusercontent.com/michat88/nuvio-providers/refs/heads/main/manifest.json' },
    { id: 'piratezoro9',   name: "Kabir's Providers",   url: 'https://raw.githubusercontent.com/PirateZoro9/nuvio-kabir-providers/refs/heads/main/manifest.json' },
    { id: 'hihihihiray',   name: "Ray's Plugins",       url: 'https://raw.githubusercontent.com/hihihihihiiray/plugins/refs/heads/main/manifest.json' },
    { id: 'abinanthankv',  name: 'NuvioRepo',           url: 'https://raw.githubusercontent.com/Abinanthankv/NuvioRepo/refs/heads/master/manifest.json' }
  ];

  // --- User-Agent strings ---
  var UA_DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
  var UA_MOBILE  = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.134 Mobile Safari/537.36';

  // --- Common headers ---
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

  // --- TMDB ---
  var TMDB_KEY = '68e094699525b18a70bab2f86b1fa706';
  var TMDB_BASE = 'https://api.themoviedb.org/3';
  var TMDB_IMG = 'https://image.tmdb.org/t/p';

  // ========================================================================
  // PERFORMANCE TUNING — these are the key levers for speed vs. quantity
  // ========================================================================
  var FETCH_CODE_TIMEOUT   = 8000;    // ms per provider JS download
  var PROVIDER_TIMEOUT     = 12000;   // ms per getStreams() call
  var BATCH_SIZE           = 50;      // max concurrent providers in flight
  var EARLY_EXIT_STREAMS   = 300;     // stop after this many UNIQUE streams
  var MAX_RETRIES          = 1;       // retries for high-scoring providers
  var MAX_HOME_ITEMS       = 20;      // items per home section

  // --- Quality detection (ordered best → worst) ---
  var QUALITY_RULES = [
    { re: /(2160p|4k|uhd)/i,            label: '4K' },
    { re: /(1440p|2k)/i,                label: '1440p' },
    { re: /(1080p|fhd|full\s*hd)/i,    label: '1080p' },
    { re: /(720p|hd)/i,                 label: '720p' },
    { re: /(480p|sd)/i,                 label: '480p' },
    { re: /(360p)/i,                    label: '360p' }
  ];

  // --- Embed domains that typically resolve to playable video ---
  var EMBED_DOMAINS = [
    'dood.wf', 'dood.so', 'doodstream', 'd000d.com',
    'mp4upload.com', 'embasic.pro', 'rapidshare.cc',
    'mixdrop', 'streamruby', 'embeds.to', 'netmirror',
    'vidmoly', 'streamlare', 'upstream', 'filemoon',
    'gounlimited', 'cloudvideo', 'mystream', 'vidcloud',
    'vidoza', 'vidlox', 'streamtape', 'voe.sx', 'youtube.com'
  ];

  // ===========================================================================
  // STATE
  // ===========================================================================

  var _discoveryCache   = null;
  var _discoveryPromise = null;
  var _fnCache          = {};       // providerId → getStreams function
  var _streamCache      = {};       // cacheKey → StreamResult[]
  var _providerScore    = {};       // providerId → reliability score (higher = faster/more results)

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
  // SDK CLASS COMPATIBILITY SHIMS
  // If the SkyStream runtime does not define these, we provide fallbacks
  // so that downstream code can use the standard API.
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

  // ===========================================================================
  // NATIVE HTTP LAYER — wraps SkyStream http_get / http_post into Promises
  // ===========================================================================

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

  function normalizeResponse(r) {
    if (!r) return { status: 0, body: '' };
    var body = typeof r.body === 'string' ? r.body : (r.body ? JSON.stringify(r.body) : '');
    return { status: r.status || 0, body: body, headers: r.headers || {} };
  }

  function errorResponse(err) {
    return { status: 0, body: '', error: err };
  }

  // --- Time-limited HTTP GET (never hang on a single provider code fetch) ---
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

  // --- Convenience fetchers ---
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

  function tmdbFetch(path) {
    var sep = path.indexOf('?') >= 0 ? '&' : '?';
    return fetchJson(TMDB_BASE + path + sep + 'api_key=' + TMDB_KEY, H_JSON);
  }

  // ===========================================================================
  // FETCH POLYFILL — enables Nuvio providers that use global fetch()
  // Uses SkyStream's native http_get/http_post as backend
  // ===========================================================================

  (function installFetchPolyfill() {
    // Only install if not already ours
    if (typeof globalThis.fetch !== 'undefined' &&
        String(globalThis.fetch).indexOf('http_get') >= 0) {
      return;
    }

    globalThis.fetch = function (url, opts) {
      return new Promise(function (resolve) {
        var urlStr = (typeof url === 'object' && url.url) ? url.url : String(url);
        var options = opts || {};
        var method = (options.method || 'GET').toUpperCase();

        // Merge default mobile headers with caller's headers
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
          var bodyStr = typeof resp.body === 'string' ? resp.body
                       : (resp.body ? JSON.stringify(resp.body) : '');
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

    log('fetch polyfill installed (http_get backend)');
  })();

  // --- Polyfill globals for provider compatibility ---
  if (typeof global === 'undefined') { globalThis.global = globalThis; }
  if (typeof window === 'undefined') { globalThis.window = globalThis; }
  if (typeof globalThis.self === 'undefined') { globalThis.self = globalThis; }

  // --- Polyfill URLSearchParams ---
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
          if (this._d.hasOwnProperty(k)) {
            parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(this._d[k]));
          }
        }
        return parts.join('&');
      };
    };
  }

  // ===========================================================================
  // PROMISE TIMEOUT WRAPPER
  // ===========================================================================

  function withTimeout(promise, ms, label) {
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        reject(new Error((label || 'Operation') + ' timed out after ' + ms + 'ms'));
      }, ms);
      promise.then(
        function (r) { clearTimeout(timer); resolve(r); },
        function (e) { clearTimeout(timer); reject(e); }
      );
    });
  }

  // ===========================================================================
  // URL HELPERS
  // ===========================================================================

  function makeItemUrl(tmdbId, type) {
    return 'nuvio://' + type + '/' + tmdbId;
  }

  function makeEpUrl(tmdbId, type, season, episode) {
    return 'nuvio://' + type + '/' + tmdbId + '/' + (season || 0) + '/' + (episode || 0);
  }

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

  // ===========================================================================
  // IMAGE HELPERS
  // ===========================================================================

  function imgUrl(path, size) { return path ? TMDB_IMG + '/' + (size || 'w185') + path : ''; }
  function imgBanner(path)    { return path ? TMDB_IMG + '/w342' + path : ''; }
  function imgStill(path)     { return path ? TMDB_IMG + '/w300' + path : ''; }

  // ===========================================================================
  // QUALITY DETECTION
  // ===========================================================================

  function detectQuality(url, name) {
    var str = (name || '') + ' ' + (url || '');
    for (var i = 0; i < QUALITY_RULES.length; i++) {
      if (QUALITY_RULES[i].re.test(str)) return QUALITY_RULES[i].label;
    }
    return null;
  }

  // ===========================================================================
  // PLAYABLE URL CHECK
  // ===========================================================================

  function isPlayable(url) {
    if (!url || typeof url !== 'string' || url.length < 5) return false;
    var u = url.toLowerCase().trim();

    // Direct video file extensions
    if (/\.(m3u8?|mp4|mkv|webm|mpd)$/i.test(u)) return true;

    // HLS / DASH paths
    if (/\/(hls|dash)\//.test(u)) return true;

    // Must be http(s)
    if (u.indexOf('http://') !== 0 && u.indexOf('https://') !== 0) return false;

    // Known embed video domains
    for (var i = 0; i < EMBED_DOMAINS.length; i++) {
      if (u.indexOf(EMBED_DOMAINS[i]) >= 0) return true;
    }

    return false;
  }

  // ===========================================================================
  // PROVIDER DISCOVERY — fetch all Nuvio manifests in parallel
  // ===========================================================================

  function discoverProviders() {
    if (_discoveryCache) return Promise.resolve(_discoveryCache);
    if (_discoveryPromise) return _discoveryPromise;

    _discoveryPromise = new Promise(function (resolve) {
      log('Discovering providers from ' + NUVIO_SOURCES.length + ' manifests...');

      var all = [];

      // Fire ALL manifest fetches in parallel
      var fetches = NUVIO_SOURCES.map(function (source) {
        var baseUrl = source.url.substring(0, source.url.lastIndexOf('/'));

        return fetchJson(source.url, H_JSON).then(function (manifest) {
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
              supportedTypes: scraper.supportedTypes || ['movie', 'tv']
            });
            count++;
          });

          log(source.name + ': ' + count + ' providers');
        }).catch(function (e) {
          log('Manifest error: ' + source.name + ' — ' + (e.message || e));
        });
      });

      // Wait for ALL manifests to resolve/reject, then resolve discovery
      Promise.allSettled(fetches).then(function () {
        log('Discovery complete: ' + all.length + ' providers');
        _discoveryCache = all;
        resolve(all);
      });
    });

    return _discoveryPromise;
  }

  // ===========================================================================
  // PROVIDER CODE LOADING — tries multiple eval strategies
  // ===========================================================================

  function loadProviderFn(provider) {
    if (_fnCache[provider.id]) return Promise.resolve(_fnCache[provider.id]);

    return httpGetTimed(provider.fileUrl, H_EXTERNAL, FETCH_CODE_TIMEOUT).then(function (res) {
      if (res.status === 0 || !res.body) {
        _fnCache[provider.id] = null;
        return null;
      }

      // Strip 'use strict' to avoid issues when wrapping in functions
      var code = res.body.replace(/^["']use strict["'];?\s*/m, '');

      var fn = tryExecStrategy1(code)
            || tryExecStrategy2(code)
            || tryExecStrategy3(code);

      _fnCache[provider.id] = fn || null;
      return fn || null;
    }).catch(function () {
      _fnCache[provider.id] = null;
      return null;
    });
  }

  function tryExecStrategy1(code) {
    try {
      var mod = { exports: {} };
      var wrap = new Function('return (function(module){' + code + '\nreturn module.exports;})')();
      var exports = wrap(mod);
      if (exports && typeof exports.getStreams === 'function') return exports.getStreams;
    } catch (e) {}
    return null;
  }

  function tryExecStrategy2(code) {
    try {
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
      var wrap = new Function('return (function(m){' + code + '\nreturn m.exports||{};})');
      var exports = wrap({ exports: {} });
      if (exports && typeof exports.getStreams === 'function') return exports.getStreams;
    } catch (e) {}
    return null;
  }

  // ===========================================================================
  // CALL A SINGLE PROVIDER (with timeout)
  // ===========================================================================

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
  // NORMALIZE A RAW STREAM RESULT FROM A PROVIDER
  // ===========================================================================

  function toStreamResult(s, providerName) {
    if (!s || !s.url) return null;

    // Skip if not playable and has no headers (headers might enable playback)
    if (!isPlayable(s.url) && (!s.headers || typeof s.headers !== 'object' || Object.keys(s.headers).length === 0)) {
      return null;
    }

    var quality = s.quality || detectQuality(s.url, s.name || s.title) || null;
    var label = providerName;
    if (quality) label += ' \u2022 ' + quality;
    if (s.size) label += ' \u2022 ' + s.size;

    var subs = s.subtitles || s.subs || undefined;

    var result = { url: s.url, source: label, headers: s.headers || {} };
    if (subs) result.subtitles = Array.isArray(subs) ? subs : [subs];
    if (quality) result.quality = quality;
    return result;
  }

  // ===========================================================================
  // DEDUPLICATION (by URL)
  // ===========================================================================

  function deduplicate(streams) {
    var seen = {};
    var unique = [];
    for (var i = 0; i < streams.length; i++) {
      var s = streams[i];
      if (!s || !s.url) continue;
      if (!seen[s.url]) {
        seen[s.url] = true;
        unique.push(s);
      }
    }
    return unique;
  }

  // ===========================================================================
  // SORT PROVIDERS BY SCORE (reliable ones first)
  // ===========================================================================

  function sortByScore(providers) {
    return providers.slice().sort(function (a, b) {
      var sa = _providerScore[a.id] || 0;
      var sb = _providerScore[b.id] || 0;
      if (sa !== sb) return sb - sa;
      return (a.name || '').localeCompare(b.name || '');
    });
  }

  // ===========================================================================
  // CORE STREAM FETCHING — FULLY PARALLEL CONCURRENCY POOL
  //
  // KEY DIFFERENCE FROM v4.x: Instead of processing batches sequentially
  // (batch 0 → wait for all → batch 1 → wait for all → ...), we fire up
  // to BATCH_SIZE providers concurrently and start new ones as they finish.
  // This eliminates the sequential bottleneck entirely.
  // ===========================================================================

  function fetchStreams(tmdbId, mediaType, season, episode) {
    var startTime = Date.now();

    return discoverProviders().then(function (providers) {
      if (!providers || providers.length === 0) return [];

      // Filter by media type
      var valid = [];
      for (var i = 0; i < providers.length; i++) {
        var p = providers[i];
        var types = p.supportedTypes || ['movie', 'tv'];
        if (types.indexOf(mediaType) >= 0) {
          valid.push(p);
        }
      }

      if (valid.length === 0) return [];

      // Sort so reliable providers execute first
      valid = sortByScore(valid);

      log('fetchStreams: ' + valid.length + ' valid providers for ' + mediaType + ' ' + tmdbId);

      // Run all providers through a parallel concurrency pool
      return parallelStreamFetch(valid, tmdbId, mediaType, season, episode, startTime);
    });
  }

  // Sliding-window concurrency pool:
  //   - Up to BATCH_SIZE providers run simultaneously
  //   - As one finishes, the next one starts
  //   - If we reach EARLY_EXIT_STREAMS, we stop starting new ones
  //   - In-flight providers are allowed to finish (their results may still be useful)
  function parallelStreamFetch(providers, tmdbId, mediaType, season, episode, startTime) {
    var total = providers.length;
    var cursor = 0;           // next provider index to start
    var activeCount = 0;      // currently in-flight
    var stopped = false;      // early-exit triggered
    var allStreams = [];      // accumulated results

    return new Promise(function (resolve) {

      // Start a single provider: load code → call getStreams → normalize results
      function startProvider(provider) {
        activeCount++;

        loadProviderFn(provider).then(function (fn) {
          if (!fn) {
            activeCount--;
            scheduleNext();
            return;
          }

          // Retry only for previously-successful providers
          var retries = (_providerScore[provider.id] || 0) > 0 ? MAX_RETRIES : 0;

          function attemptCall(remainingRetries) {
            callProvider(fn, tmdbId, mediaType, season, episode, provider.name).then(function (streams) {
              if (Array.isArray(streams) && streams.length > 0) {
                // Normalize & deduplicate into the shared pool
                for (var si = 0; si < streams.length; si++) {
                  if (allStreams.length >= EARLY_EXIT_STREAMS) break;
                  var sr = toStreamResult(streams[si], provider.name);
                  if (sr) {
                    // Deduplicate in real-time
                    var duplicate = false;
                    for (var di = 0; di < allStreams.length; di++) {
                      if (allStreams[di].url === sr.url) { duplicate = true; break; }
                    }
                    if (!duplicate) allStreams.push(sr);
                  }
                }

                // Score provider by how many streams it contributed
                _providerScore[provider.id] = (_providerScore[provider.id] || 0) + streams.length;
              } else if (remainingRetries > 0) {
                return attemptCall(remainingRetries - 1);
              }

              activeCount--;
              scheduleNext();
            }).catch(function () {
              if (remainingRetries > 0) return attemptCall(remainingRetries - 1);
              activeCount--;
              scheduleNext();
            });
          }

          attemptCall(retries);
        }).catch(function () {
          activeCount--;
          scheduleNext();
        });
      }

      // Scheduler: start new providers up to the concurrency limit,
      // or finish if nothing is left running.
      function scheduleNext() {
        // Check early exit
        if (allStreams.length >= EARLY_EXIT_STREAMS) {
          stopped = true;
        }

        // Start new ones while we have capacity
        while (!stopped && activeCount < BATCH_SIZE && cursor < total) {
          startProvider(providers[cursor++]);
        }

        // If everything finished, resolve
        if (activeCount === 0) {
          var unique = deduplicate(allStreams);
          log('Scraped ' + unique.length + ' unique streams from ' + total + ' providers in ' + (Date.now() - startTime) + 'ms');
          resolve(unique);
        }
      }

      // Kick off the first wave
      scheduleNext();
    });
  }

  // ===========================================================================
  // TMDB RESPONSE → SKYSTREAM MULTIMEDIA ITEM
  // ===========================================================================

  function tmdbToItem(d, type) {
    var title = type === 'tv' ? d.name : d.title;
    var date = type === 'tv' ? d.first_air_date : d.release_date;
    var year = date ? parseInt(date.substring(0, 4), 10) : undefined;

    var item = new MultimediaItem({
      title: title || 'Unknown',
      url: makeItemUrl(d.id, type),
      posterUrl: imgUrl(d.poster_path),
      type: type === 'tv' ? 'series' : 'movie',
      year: year,
      score: d.vote_average || undefined,
      description: d.overview || '',
      bannerUrl: imgBanner(d.backdrop_path),
      logoUrl: '',
      cast: [],
      trailers: []
    });

    // SkyStream needs episodes array even for movies to show a play button
    if (type === 'movie') {
      item.episodes = [new Episode({
        name: title || 'Movie',
        url: makeItemUrl(d.id, 'movie'),
        season: 1,
        episode: 1,
        posterUrl: imgUrl(d.poster_path)
      })];
    }

    return item;
  }

  // ===========================================================================
  // CORE PLUGIN FUNCTIONS (the 4 mandatory exports)
  // ===========================================================================

  // ----- getHome() → 10+ TMDB categories -----
  function getHome(cb) {
    log('getHome');

    var categories = [
      { path: '/trending/movie/week', key: 'Trending Movies' },
      { path: '/trending/tv/week',    key: 'Trending TV Shows' },
      { path: '/movie/popular',       key: 'Popular Movies' },
      { path: '/tv/popular',          key: 'Popular TV Shows' },
      { path: '/movie/top_rated',     key: 'Top Rated Movies' },
      { path: '/tv/top_rated',        key: 'Top Rated TV Shows' },
      { path: '/movie/now_playing',   key: 'Now Playing' },
      { path: '/tv/airing_today',     key: 'Airing Today' },
      { path: '/movie/upcoming',      key: 'Upcoming' },
      { path: '/trending/all/week',   key: 'Trending Now' }
    ];

    var allTrending = [];

    // Fire all category fetches in parallel
    Promise.allSettled(categories.map(function (cat) {
      return tmdbFetch(cat.path).then(function (r) { return { key: cat.key, data: r }; });
    })).then(function (results) {
      var data = {};

      for (var ri = 0; ri < results.length; ri++) {
        var result = results[ri];
        if (result.status !== 'fulfilled' || !result.value || !result.value.data || !result.value.data.results) continue;

        var key = result.value.key;
        var response = result.value.data;
        var items = response.results.slice(0, MAX_HOME_ITEMS).map(function (item) {
          var t = item.media_type || (key.indexOf('TV') >= 0 || key.indexOf('Airing') >= 0 || key.indexOf('Shows') >= 0 ? 'tv' : 'movie');
          if (key === 'Trending Now') { t = item.media_type === 'tv' ? 'tv' : 'movie'; }
          return tmdbToItem(item, t);
        });

        if (items.length > 0) {
          data[key] = items;
          if (key.indexOf('Trending') >= 0) {
            allTrending = allTrending.concat(items);
          }
        }
      }

      // Hero carousel
      if (allTrending.length > 0) {
        data['Trending'] = allTrending.slice(0, 12);
      }

      // Warm provider cache in background (user will benefit on next load)
      discoverProviders().catch(function () {});

      log('getHome: ' + Object.keys(data).length + ' categories');
      cb({ success: true, data: data });
    }).catch(function (e) {
      warn('getHome error: ' + (e.message || e));
      cb({ success: false, errorCode: 'INTERNAL_ERROR', message: e.message || String(e) });
    });
  }

  // ----- search(query) → combined movie + TV results -----
  function search(query, cb) {
    log('search: "' + query + '"');

    Promise.allSettled([
      tmdbFetch('/search/movie?query=' + encodeURIComponent(query)),
      tmdbFetch('/search/tv?query=' + encodeURIComponent(query))
    ]).then(function (results) {
      var combined = [];

      // Movies
      if (results[0].status === 'fulfilled' && results[0].value && results[0].value.results) {
        results[0].value.results.slice(0, 10).forEach(function (m) {
          combined.push(tmdbToItem(m, 'movie'));
        });
      }
      // TV shows
      if (results[1].status === 'fulfilled' && results[1].value && results[1].value.results) {
        results[1].value.results.slice(0, 10).forEach(function (t) {
          combined.push(tmdbToItem(t, 'tv'));
        });
      }

      cb({ success: true, data: combined });
    }).catch(function (e) {
      warn('search error: ' + (e.message || e));
      cb({ success: false, errorCode: 'INTERNAL_ERROR', message: e.message || String(e) });
    });
  }

  // ----- load(url) → full item detail with episodes -----
  function load(url, cb) {
    log('load: ' + url);

    var p = parseNuvioUrl(url);
    if (!p) return cb({ success: false, errorCode: 'BAD_REQUEST', message: 'Invalid URL' });

    if (p.mediaType === 'movie') {
      tmdbFetch('/movie/' + p.tmdbId).then(function (d) {
        if (!d) return cb({ success: false, errorCode: 'NOT_FOUND' });
        cb({ success: true, data: tmdbToItem(d, 'movie') });
      }).catch(function (e) {
        warn('load movie error: ' + (e.message || e));
        cb({ success: false, errorCode: 'INTERNAL_ERROR', message: e.message || String(e) });
      });

    } else if (p.mediaType === 'tv') {
      // Fetch TV details + up to 10 seasons in parallel
      var seasonFetches = [];
      for (var s = 1; s <= 10; s++) {
        seasonFetches.push(tmdbFetch('/tv/' + p.tmdbId + '/season/' + s));
      }

      Promise.allSettled([
        tmdbFetch('/tv/' + p.tmdbId)
      ].concat(seasonFetches)).then(function (results) {
        var tvData = results[0].status === 'fulfilled' ? results[0].value : null;
        if (!tvData) return cb({ success: false, errorCode: 'NOT_FOUND' });

        var item = tmdbToItem(tvData, 'tv');
        var episodes = [];

        // Collect episodes from all fetched seasons
        for (var si = 1; si < results.length; si++) {
          var r = results[si];
          if (r.status !== 'fulfilled' || !r.value || !r.value.episodes) continue;
          var seasonData = r.value;

          for (var ei = 0; ei < seasonData.episodes.length; ei++) {
            var ep = seasonData.episodes[ei];
            episodes.push(new Episode({
              name: 'S' + pad(seasonData.season_number, 2) + 'E' + pad(ep.episode_number, 2) + ' - ' + (ep.name || ''),
              url: makeEpUrl(p.tmdbId, 'tv', seasonData.season_number, ep.episode_number),
              season: seasonData.season_number,
              episode: ep.episode_number,
              rating: ep.vote_average,
              runtime: ep.runtime,
              airDate: ep.air_date || '',
              thumbnail: imgStill(ep.still_path)
            }));
          }
        }

        item.episodes = episodes;
        log('load: ' + episodes.length + ' episodes across ' + (results.length - 1) + ' seasons');
        cb({ success: true, data: item });
      }).catch(function (e) {
        warn('load tv error: ' + (e.message || e));
        cb({ success: false, errorCode: 'INTERNAL_ERROR', message: e.message || String(e) });
      });

    } else {
      cb({ success: false, errorCode: 'BAD_REQUEST', message: 'Unknown type: ' + p.mediaType });
    }
  }

  // ----- loadStreams(url) → array of StreamResult (with cache) -----
  function loadStreams(url, cb) {
    log('loadStreams: ' + url);

    var p = parseNuvioUrl(url);
    if (!p) return cb({ success: false, errorCode: 'BAD_REQUEST' });

    var key = cacheKey(url);
    log('Streams key: ' + key);

    // Memory cache hit — instant return
    if (_streamCache[key]) {
      log('Cache hit: ' + _streamCache[key].length + ' streams');
      return cb({ success: true, data: _streamCache[key] });
    }

    fetchStreams(p.tmdbId, p.mediaType, p.season, p.episode).then(function (streams) {
      _streamCache[key] = streams;
      log('Returning ' + streams.length + ' streams');
      cb({ success: true, data: streams });
    }).catch(function (e) {
      warn('loadStreams error: ' + (e.message || e));
      cb({ success: true, data: [] });
    });
  }

  // ===========================================================================
  // UTILITY
  // ===========================================================================

  function pad(n, width) {
    var s = String(n);
    while (s.length < width) { s = '0' + s; }
    return s;
  }

  // ===========================================================================
  // EXPORTS (globalThis necessary for SkyStream Hermes runtime)
  // ===========================================================================

  globalThis.getHome = getHome;
  globalThis.search = search;
  globalThis.load = load;
  globalThis.loadStreams = loadStreams;

  log('Plugin v5.0 loaded — ' + NUVIO_SOURCES.length + ' Nuvio sources, batch=' + BATCH_SIZE + ', earlyExit=' + EARLY_EXIT_STREAMS);
})();
