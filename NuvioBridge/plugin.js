(function () {
  // ===========================================================================
  // NUVIO BRIDGE + STREMIO HUB — SkyStream Plugin v7
  // Unified plugin: Nuvio providers + Stremio addons + full catalog support
  //
  // FEATURES:
  //  • Nuvio provider discovery from multiple manifests (150+ providers)
  //  • Stremio addon support (catalogueAddons, streamingAddons)
  //  • getHome: Stremio catalogs (catalogueAddons)
  //  • search: Stremio catalog search
  //  • load: Stremio metadata + episode listing
  //  • loadStreams: Nuvio providers + Stremio streaming addons merged
  //  • Parallel batch processing, quality sorting, MAGIC_PROXY_v1
  //  • Persistent cache, rate limit backoff, pre-fetching
  // ===========================================================================

  var TAG = 'NuvioBridge';

  // --- Stremio addon sources from plugin.json ---
  function getCatalogueAddons() {
    try { if (manifest && Array.isArray(manifest.catalogueAddons)) return manifest.catalogueAddons; } catch (e) {}
    return [];
  }
  function getStreamingAddons() {
    try { if (manifest && Array.isArray(manifest.streamingAddons)) return manifest.streamingAddons; } catch (e) {}
    return [];
  }


  // --- Nuvio manifest sources from plugin.json ---
  function deriveSourceFromUrl(url) {
    var match = url.match(/github(?:usercontent)?\.com\/([^/]+)\/([^/]+)/);
    if (!match) return null;
    var username = match[1];
    return { id: username.toLowerCase(), name: username.charAt(0).toUpperCase() + username.slice(1), url: url };
  }

  var NUVIO_SOURCES = (typeof manifest !== 'undefined' && manifest.nuvioManifests)
    ? manifest.nuvioManifests.map(deriveSourceFromUrl).filter(function(s) { return s !== null; })
    : [];

  // --- User-Agent strings ---
  var UA_DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
  var UA_MOBILE  = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.134 Mobile Safari/537.36';

  // --- Common headers ---
  var H_EXTERNAL = { 'User-Agent': UA_DESKTOP, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.5', 'Connection': 'keep-alive' };
  var H_JSON = { 'User-Agent': UA_DESKTOP, 'Accept': 'application/json' };
  var H_MOBILE = { 'User-Agent': UA_MOBILE, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9' };

  // --- Performance tuning ---
  var FETCH_CODE_TIMEOUT   = 8000;
  var PROVIDER_TIMEOUT     = 12000;
  var BATCH_SIZE           = 50;
  var EARLY_EXIT_STREAMS   = 300;
  var MAX_RETRIES          = 1;
  var CACHE_TTL            = 600000;

  // --- Quality detection ---
  var QUALITY_RULES = [
    { re: /(2160p|4k|uhd)/i,            label: '4K' },
    { re: /(1440p|2k)/i,                label: '1440p' },
    { re: /(1080p|fhd|full\s*hd)/i,    label: '1080p' },
    { re: /(720p|hd)/i,                 label: '720p' },
    { re: /(480p|sd)/i,                 label: '480p' },
    { re: /(360p)/i,                    label: '360p' }
  ];

  // --- Rate limit backoff ---
  var _rateLimits = {};
  var RATE_BACKOFF_MS = 300000;
  var RATE_MAX_FAILS = 3;

  // --- State ---
  var _discoveryCache   = null;
  var _discoveryPromise = null;
  var _fnCache          = {};
  var _streamCache      = {};
  var _providerScore    = {};
  var _cache            = {};

  // ===========================================================================
  // SDK CLASS COMPATIBILITY SHIMS
  // ===========================================================================

  if (typeof globalThis.MultimediaItem === 'undefined') {
    globalThis.MultimediaItem = function (props) { if (props) { for (var k in props) { if (props.hasOwnProperty(k)) this[k] = props[k]; } } };
  }
  if (typeof globalThis.Episode === 'undefined') {
    globalThis.Episode = function (props) { if (props) { for (var k in props) { if (props.hasOwnProperty(k)) this[k] = props[k]; } } };
  }
  if (typeof globalThis.StreamResult === 'undefined') {
    globalThis.StreamResult = function (props) { if (props) { for (var k in props) { if (props.hasOwnProperty(k)) this[k] = props[k]; } } };
  }
  if (typeof globalThis.Actor === 'undefined') {
    globalThis.Actor = function (props) { if (props) { for (var k in props) { if (props.hasOwnProperty(k)) this[k] = props[k]; } } };
  }
  if (typeof globalThis.Trailer === 'undefined') {
    globalThis.Trailer = function (props) { if (props) { for (var k in props) { if (props.hasOwnProperty(k)) this[k] = props[k]; } } };
  }

  // ===========================================================================
  // SAFE LOGGING
  // ===========================================================================

  function log(msg) { try { console.log('[' + TAG + '] ' + msg); } catch (e) {} }
  function warn(msg) { try { console.warn('[' + TAG + '] ' + msg); } catch (e) {} }

  // ===========================================================================
  // NATIVE HTTP LAYER — wraps SkyStream http_get / http_post into Promises
  // ===========================================================================

  function httpGet(url, headers) {
    return new Promise(function (resolve) {
      try {
        var result = http_get(url, headers);
        if (result && typeof result.then === 'function') {
          result.then(function (r) { resolve(normalizeResponse(r)); }).catch(function (e) { resolve(errorResponse(e)); });
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
          result.then(function (r) { resolve(normalizeResponse(r)); }).catch(function (e) { resolve(errorResponse(e)); });
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

  function errorResponse(err) { return { status: 0, body: '', error: err }; }

  function httpGetTimed(url, headers, ms) {
    return new Promise(function (resolve) {
      var done = false;
      var timer = setTimeout(function () { if (!done) { done = true; resolve({ status: 0, body: '', error: new Error('timeout') }); } }, ms || 5000);
      httpGet(url, headers).then(function (r) { if (!done) { done = true; clearTimeout(timer); resolve(r); } }).catch(function (e) { if (!done) { done = true; clearTimeout(timer); resolve(errorResponse(e)); } });
    });
  }

  function fetchJson(url, headers) {
    return httpGet(url, headers).then(function (r) {
      if (r.status === 0 || r.status >= 400) return null;
      try { return JSON.parse(r.body); } catch (e) { return null; }
    });
  }

  function fetchText(url, headers) {
    return httpGet(url, headers).then(function (r) { return (r.status === 0 || r.status >= 400) ? null : (r.body || ''); });
  }

  // --- Minimal TMDB for IMDB↔TMDB ID resolution in loadStreams only ---
  var TMDB_KEY = '68e094699525b18a70bab2f86b1fa706';
  var TMDB_BASE = 'https://api.themoviedb.org/3';
  var _idCache = {};

  function tmdbFind(externalId, source) {
    var ck = source + ':' + externalId;
    if (_idCache[ck]) return Promise.resolve(_idCache[ck]);
    var url = TMDB_BASE + '/find/' + encodeURIComponent(externalId) + '?api_key=' + TMDB_KEY + '&external_source=' + source;
    return fetchJson(url, H_JSON).then(function(r) {
      if (!r) return null;
      var results = null;
      if (source === 'imdb_id') {
        results = (r.movie_results && r.movie_results.length) ? { tmdbId: String(r.movie_results[0].id), type: 'movie' }
                  : (r.tv_results && r.tv_results.length) ? { tmdbId: String(r.tv_results[0].id), type: 'tv' }
                  : null;
      } else if (source === 'tmdb_id') {
        results = { tmdbId: String(externalId), type: null };
      }
      if (results) _idCache[ck] = results;
      return results;
    }).catch(function() { return null; });
  }

  // ===========================================================================
  // FETCH POLYFILL — enables Nuvio providers that use global fetch()
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
        if (typeof h.forEach === 'function') { h.forEach(function (v, k) { reqHeaders[k] = v; }); }
        else { for (var k in h) { if (h.hasOwnProperty(k)) reqHeaders[k] = h[k]; } }

        function onNativeResponse(resp) {
          if (!resp) { resolve(emptyFetchResponse(urlStr)); return; }
          var bodyStr = typeof resp.body === 'string' ? resp.body : (resp.body ? JSON.stringify(resp.body) : '');
          var ok = resp.status >= 200 && resp.status < 300;
          resolve({ ok: ok, status: resp.status || (ok ? 200 : 0), statusText: ok ? 'OK' : 'Error', headers: createFetchHeaders(resp.headers), url: urlStr, redirected: false, json: function () { try { return Promise.resolve(JSON.parse(bodyStr)); } catch(e) { return Promise.reject(e); } }, text: function () { return Promise.resolve(bodyStr); } });
        }

        try {
          if (method === 'POST') { http_post(urlStr, reqHeaders, options.body || '', onNativeResponse); }
          else { http_get(urlStr, reqHeaders, onNativeResponse); }
        } catch (e) { resolve(emptyFetchResponse(urlStr, e)); }
      });
    };

    function emptyFetchResponse(urlStr, err) {
      var msg = err ? err.message : 'Unknown error';
      return { ok: false, status: 0, statusText: msg, headers: { get: function () { return null; }, forEach: function () {} }, url: urlStr, redirected: false, json: function () { return Promise.reject(err || new Error(msg)); }, text: function () { return Promise.resolve(''); } };
    }

    function createFetchHeaders(hdrs) {
      if (!hdrs || typeof hdrs !== 'object') return { get: function () { return null; }, forEach: function () {} };
      return { get: function (name) { var v = hdrs[name] || hdrs[name.toLowerCase()] || null; return Array.isArray(v) ? v[0] : v; }, forEach: function (cb) { for (var k in hdrs) { if (hdrs.hasOwnProperty(k)) cb(hdrs[k], k); } } };
    }

    log('fetch polyfill installed (http_get backend)');
  })();

  // --- Polyfill globals ---
  if (typeof global === 'undefined') { globalThis.global = globalThis; }
  if (typeof window === 'undefined') { globalThis.window = globalThis; }
  if (typeof globalThis.self === 'undefined') { globalThis.self = globalThis; }

  // --- Polyfill URLSearchParams ---
  if (typeof globalThis.URLSearchParams === 'undefined') {
    globalThis.URLSearchParams = function (init) {
      this._d = {};
      if (typeof init === 'string') { init.split('&').forEach(function (p) { var kv = p.split('='); if (kv.length >= 2) { this._d[decodeURIComponent(kv[0])] = decodeURIComponent(kv.slice(1).join('=')); } }.bind(this)); }
      this.get = function (n) { return this._d[n] || null; };
      this.set = function (n, v) { this._d[n] = String(v); };
      this.toString = function () { var parts = []; for (var k in this._d) { if (this._d.hasOwnProperty(k)) parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(this._d[k])); } return parts.join('&'); };
    };
  }

  // ===========================================================================
  // PROMISE TIMEOUT WRAPPER
  // ===========================================================================

  function withTimeout(promise, ms, label) {
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () { reject(new Error((label || 'Operation') + ' timed out after ' + ms + 'ms')); }, ms);
      promise.then(function (r) { clearTimeout(timer); resolve(r); }, function (e) { clearTimeout(timer); reject(e); });
    });
  }

  // ===========================================================================
  // URL HELPERS
  // ===========================================================================

  function parseNuvioUrl(url) {
    if (!url || typeof url !== 'string' || url.indexOf('nuvio://') !== 0) return null;
    var parts = url.replace('nuvio://', '').split('/');
    if (parts.length < 2) return null;
    return { mediaType: parts[0], tmdbId: parts[1], season: parts[2] ? parseInt(parts[2], 10) || null : null, episode: parts[3] ? parseInt(parts[3], 10) || null : null };
  }

  function cacheKey(url) {
    var p = parseNuvioUrl(url);
    if (!p) return url;
    if (p.mediaType === 'movie') return 'm:' + p.tmdbId;
    return 't:' + p.tmdbId + ':' + (p.season || '0') + ':' + (p.episode || '0');
  }

  function detectQuality(url, name) {
    var str = (name || '') + ' ' + (url || '');
    for (var i = 0; i < QUALITY_RULES.length; i++) { if (QUALITY_RULES[i].re.test(str)) return QUALITY_RULES[i].label; }
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
  // STREMIO URL HELPERS
  // ===========================================================================

  function baseUrl(m) { return (m || '').replace(/\/manifest\.json$/, '').replace(/\/$/, ''); }
  function addonName(url) {
    try {
      var h = url.replace(/https?:\/\//, '').split('/')[0].replace(/^www\./, '');
      var p = h.split('.');
      if (p.length >= 2) {
        var tlds = ['com','org','net','io','app','dev','tv','co','uk','de','xyz','fun','cloud','me'];
        var b = p[0]; if (tlds.indexOf(b) !== -1 && p.length > 1) b = p[1];
        return b.charAt(0).toUpperCase() + b.slice(1);
      }
      return p[0].charAt(0).toUpperCase() + p[0].slice(1);
    } catch (e) { return 'Addon'; }
  }
  function str(s) { return String(s == null ? '' : s); }
  function safeJson(t, f) { try { return JSON.parse(str(t)); } catch (e) { return f || null; } }
  function skyType(t) { return (t === 'movie' || t === 'short') ? 'movie' : 'series'; }

  // ===========================================================================
  // RATE LIMIT BACKOFF
  // ===========================================================================

  function isRateLimited(url) {
    var rl = _rateLimits[url];
    return rl && rl.fails >= RATE_MAX_FAILS && Date.now() < rl.until;
  }

  function recordRateLimit(url, status) {
    if (status === 429 || status === 503 || status === 502 || status === 504) {
      var rl = _rateLimits[url] || { fails: 0, until: 0 };
      rl.fails++;
      rl.until = Date.now() + RATE_BACKOFF_MS;
      _rateLimits[url] = rl;
      try { setPreference('hub_ratelimit:' + url, JSON.stringify(rl)); } catch (e) {}
    } else if (status >= 200 && status < 300) {
      if (_rateLimits[url]) _rateLimits[url].fails = 0;
    }
  }

  // ===========================================================================
  // PERSISTENT CACHE
  // ===========================================================================

  function pCacheGet(k) {
    var c = _cache[k];
    if (c && (Date.now() - c.ts) < CACHE_TTL) return c.data;
    try {
      var raw = getPreference('hub_cache:' + k);
      if (raw) {
        var parsed = safeJson(raw, null);
        if (parsed && parsed.ts && (Date.now() - parsed.ts) < CACHE_TTL) { _cache[k] = parsed; return parsed.data; }
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
  // STREMIO HTTP BATCH (using http_parallel if available)
  // ===========================================================================

  function httpBatch(urls) {
    if (!urls.length) return Promise.resolve([]);
    var activeUrls = [], activeIndices = [];
    for (var i = 0; i < urls.length; i++) {
      if (!isRateLimited(urls[i])) { activeUrls.push(urls[i]); activeIndices.push(i); }
    }
    if (!activeUrls.length) return Promise.resolve(urls.map(function(u) { return { url: u, ok: false, data: null, status: 429 }; }));

    var reqs = [];
    for (var i = 0; i < activeUrls.length; i++) { reqs.push({ method: 'GET', url: activeUrls[i], headers: H_JSON }); }

    var httpFn = (typeof http_parallel === 'function') ? http_parallel(reqs) : Promise.all(reqs.map(function(r) { return httpGet(r.url, r.headers); }));

    return httpFn.then(function(responses) {
      var results = urls.map(function(u) { return { url: u, ok: false, data: null, status: 0 }; });
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
    }).catch(function() { return urls.map(function(u) { return { url: u, ok: false, data: null, status: 0 }; }); });
  }

  // ===========================================================================
  // STREMIO MANIFEST FETCHER
  // ===========================================================================

  function getManifest(url) {
    var k = 'mf:' + url;
    var cached = pCacheGet(k);
    if (cached) return Promise.resolve(cached);
    if (isRateLimited(url)) return Promise.resolve(null);
    var p = fetchJson(url, H_JSON);
    var t = new Promise(function(r) { setTimeout(function() { r(null); }, 8000); });
    return Promise.race([p, t]).then(function(d) { if (d) pCacheSet(k, d); return d; });
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
      var fetches = NUVIO_SOURCES.map(function (source) {
        var baseUrl = source.url.substring(0, source.url.lastIndexOf('/'));
        return fetchJson(source.url, H_JSON).then(function (manifest) {
          if (!manifest || !manifest.scrapers || !manifest.scrapers.length) { log('Empty manifest: ' + source.name); return; }
          var count = 0;
          manifest.scrapers.forEach(function (scraper) {
            if (scraper.enabled === false) return;
            if (!scraper.filename) return;
            var fileUrl = scraper.filename.indexOf('http') === 0 ? scraper.filename : baseUrl + '/' + scraper.filename;
            all.push({ id: source.id + '/' + (scraper.id || scraper.name || scraper.filename), name: scraper.name || scraper.id || scraper.filename, sourceName: source.name, fileUrl: fileUrl, supportedTypes: scraper.supportedTypes || ['movie', 'tv'] });
            count++;
          });
          log(source.name + ': ' + count + ' providers');
        }).catch(function (e) { log('Manifest error: ' + source.name + ' — ' + (e.message || e)); });
      });
      Promise.allSettled(fetches).then(function () {
        log('Discovery complete: ' + all.length + ' providers');
        _discoveryCache = all;
        resolve(all);
      });
    });
    return _discoveryPromise;
  }

  // ===========================================================================
  // PROVIDER CODE LOADING
  // ===========================================================================

  function loadProviderFn(provider) {
    if (_fnCache[provider.id]) return Promise.resolve(_fnCache[provider.id]);
    return httpGetTimed(provider.fileUrl, H_EXTERNAL, FETCH_CODE_TIMEOUT).then(function (res) {
      if (res.status === 0 || !res.body) { _fnCache[provider.id] = null; return null; }
      var code = res.body.replace(/^["']use strict["'];?\s*/m, '');
      var fn = tryExecStrategy1(code) || tryExecStrategy2(code) || tryExecStrategy3(code);
      _fnCache[provider.id] = fn || null;
      return fn || null;
    }).catch(function () { _fnCache[provider.id] = null; return null; });
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
      var wrap = new Function('return (function(){var module={exports:{}},exports=module.exports;' + code + '\nreturn module.exports;})()');
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

  function callProvider(fn, tmdbId, mediaType, season, episode, label) {
    return withTimeout(fn(tmdbId, mediaType, season, episode), PROVIDER_TIMEOUT, label).then(function (result) { return Array.isArray(result) ? result : []; }).catch(function () { return []; });
  }

  // ===========================================================================
  // NORMALIZE STREAM RESULTS
  // ===========================================================================

  function toStreamResult(s, providerName) {
    if (!s || !s.url) return null;
    if (!isPlayable(s.url) && (!s.headers || typeof s.headers !== 'object' || Object.keys(s.headers).length === 0)) return null;
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

  function deduplicate(streams) {
    var seen = {}, unique = [];
    for (var i = 0; i < streams.length; i++) { var s = streams[i]; if (!s || !s.url) continue; if (!seen[s.url]) { seen[s.url] = true; unique.push(s); } }
    return unique;
  }

  function sortByScore(providers) {
    return providers.slice().sort(function (a, b) {
      var sa = _providerScore[a.id] || 0, sb = _providerScore[b.id] || 0;
      if (sa !== sb) return sb - sa;
      return (a.name || '').localeCompare(b.name || '');
    });
  }

  // ===========================================================================
  // PARALLEL NUVIO STREAM FETCHING
  // ===========================================================================

  function fetchNuvioStreams(tmdbId, mediaType, season, episode) {
    var startTime = Date.now();
    return discoverProviders().then(function (providers) {
      if (!providers || providers.length === 0) return [];
      var valid = [];
      for (var i = 0; i < providers.length; i++) {
        var p = providers[i];
        var types = p.supportedTypes || ['movie', 'tv'];
        if (types.indexOf(mediaType) >= 0) valid.push(p);
      }
      if (valid.length === 0) return [];
      valid = sortByScore(valid);
      log('Nuvio fetch: ' + valid.length + ' providers for ' + mediaType + ' ' + tmdbId);
      return parallelStreamFetch(valid, tmdbId, mediaType, season, episode, startTime);
    });
  }

  function parallelStreamFetch(providers, tmdbId, mediaType, season, episode, startTime) {
    var total = providers.length, cursor = 0, activeCount = 0, stopped = false, allStreams = [];
    return new Promise(function (resolve) {
      function startProvider(provider) {
        activeCount++;
        loadProviderFn(provider).then(function (fn) {
          if (!fn) { activeCount--; scheduleNext(); return; }
          var retries = (_providerScore[provider.id] || 0) > 0 ? MAX_RETRIES : 0;
          function attemptCall(remainingRetries) {
            callProvider(fn, tmdbId, mediaType, season, episode, provider.name).then(function (streams) {
              if (Array.isArray(streams) && streams.length > 0) {
                for (var si = 0; si < streams.length; si++) {
                  if (allStreams.length >= EARLY_EXIT_STREAMS) break;
                  var sr = toStreamResult(streams[si], provider.name);
                  if (sr) { var duplicate = false; for (var di = 0; di < allStreams.length; di++) { if (allStreams[di].url === sr.url) { duplicate = true; break; } } if (!duplicate) allStreams.push(sr); }
                }
                _providerScore[provider.id] = (_providerScore[provider.id] || 0) + streams.length;
              } else if (remainingRetries > 0) { return attemptCall(remainingRetries - 1); }
              activeCount--; scheduleNext();
            }).catch(function () { if (remainingRetries > 0) return attemptCall(remainingRetries - 1); activeCount--; scheduleNext(); });
          }
          attemptCall(retries);
        }).catch(function () { activeCount--; scheduleNext(); });
      }
      function scheduleNext() {
        if (allStreams.length >= EARLY_EXIT_STREAMS) stopped = true;
        while (!stopped && activeCount < BATCH_SIZE && cursor < total) startProvider(providers[cursor++]);
        if (activeCount === 0) { var unique = deduplicate(allStreams); log('Nuvio scraped ' + unique.length + ' streams in ' + (Date.now() - startTime) + 'ms'); resolve(unique); }
      }
      scheduleNext();
    });
  }

  // ===========================================================================
  // STREMIO STREAM FETCHING
  // ===========================================================================

  var LANG = { 'en':'English','es':'Spanish','fr':'French','de':'German','it':'Italian','pt':'Portuguese','ru':'Russian','ja':'Japanese','ko':'Korean','zh':'Chinese','ar':'Arabic','hi':'Hindi','nl':'Dutch','pl':'Polish','tr':'Turkish','th':'Thai','vi':'Vietnamese','cs':'Czech','hu':'Hungarian','ro':'Romanian','he':'Hebrew','el':'Greek','sv':'Swedish','da':'Danish','no':'Norwegian','fi':'Finnish','id':'Indonesian','ms':'Malay','bg':'Bulgarian','uk':'Ukrainian','sr':'Serbian','hr':'Croatian','sk':'Slovak','lt':'Lithuanian','lv':'Latvian','et':'Estonian','is':'Icelandic','sl':'Slovenian','bn':'Bengali','ta':'Tamil','te':'Telugu','mr':'Marathi','ml':'Malayalam','kn':'Kannada','gu':'Gujarati','pa':'Punjabi','ur':'Urdu' };
  function normLang(c) { if (!c) return 'Unknown'; return LANG[c.split('-')[0].toLowerCase()] || c.split('-')[0].toUpperCase() || c; }

  var TRACKERS = ['udp://tracker.opentrackr.org:1337/announce','udp://tracker.openbittorrent.com:6969/announce','udp://tracker.torrent.eu.org:451/announce','udp://exodus.desync.com:6969/announce','udp://public.popcorn-tracker.org:6969/announce'];
  function magnetLink(hash, name) { var m = 'magnet:?xt=urn:btih:' + hash + '&dn=' + encodeURIComponent(name || hash); for (var i = 0, n = 0; i < TRACKERS.length && n < 20; i++) { m += '&tr=' + encodeURIComponent(TRACKERS[i]); n++; } return m; }

  function parseFeatures(s) {
    var r = { resolution:'Auto', codec:null, hdr:null, audio:null, channels:null, sourceType:'unknown', _sortKey: 0 };
    if (!s) return r;
    var str = s.toLowerCase();
    if (/\b(2160|4k|uhd)\b/.test(str)) { r.resolution = '4K'; r._sortKey = 5; }
    else if (/\b1440\b/.test(str)) { r.resolution = '1440p'; r._sortKey = 4; }
    else if (/\b1080\b/.test(str)) { r.resolution = '1080p'; r._sortKey = 3; }
    else if (/\b720\b/.test(str)) { r.resolution = '720p'; r._sortKey = 2; }
    else if (/\b480\b/.test(str)) { r.resolution = '480p'; r._sortKey = 1; }
    else if (/\b360\b/.test(str)) { r.resolution = '360p'; r._sortKey = 1; }
    else if (/\b(cam|ts|tc|scr|workprint|hqcam)\b/.test(str)) { r.resolution = 'CAM'; r._sortKey = 0; }
    if (/\b(av1|av01)\b/.test(str)) r.codec = 'AV1';
    else if (/\b(x?v?265|hevc)\b/.test(str)) r.codec = 'HEVC';
    else if (/\b(x264|h\.?264|avc)\b/.test(str)) r.codec = 'H.264';
    else if (/\b(vp9|vp9\.2)\b/.test(str)) r.codec = 'VP9';
    else if (/\b(vc[\s-]?1|vc1)\b/.test(str)) r.codec = 'VC-1';
    else if (/\b(xvid|divx)\b/.test(str)) r.codec = 'XviD';
    if (/\b(dv|dovi|dolby[\s._-]?vision)\b/.test(str)) r.hdr = 'DV';
    else if (/\bhdr10\+\b/.test(str)) r.hdr = 'HDR10+';
    else if (/\bhdr10\b/.test(str)) r.hdr = 'HDR10';
    else if (/\bhdr\b/.test(str)) r.hdr = 'HDR';
    if (/\bhlg\b/.test(str)) r.hdr = r.hdr ? r.hdr + '+HLG' : 'HLG';
    if (/\b(atmos|truehd)\b/.test(str)) r.audio = 'Atmos';
    else if (/\bdts[-\s]?hd\b/.test(str)) r.audio = 'DTS-HD';
    else if (/\bdts\b/.test(str)) r.audio = 'DTS';
    else if (/\b(flac|lpcm)\b/.test(str)) r.audio = 'FLAC';
    else if (/\b(e?aac)\b/.test(str)) r.audio = 'AAC';
    else if (/\bmp3\b/.test(str)) r.audio = 'MP3';
    else if (/\bopus\b/.test(str)) r.audio = 'Opus';
    var ch = str.match(/\b[257]\.1\b/); if (ch) r.channels = ch[0];
    if (/\btorrent\b/.test(str) || /\binfohash\b/.test(str)) r.sourceType = 'torrent';
    else if (/\bhttp\b/.test(str) || /\bhls\b/.test(str) || /\bm3u8\b/.test(str) || /\bmpd\b/.test(str)) r.sourceType = 'http';
    else if (/\byoutube\b/.test(str) || /\bytId\b/.test(str)) r.sourceType = 'youtube';
    return r;
  }

  var QUALITY_ORDER = { '4K': 5, '1440p': 4, '1080p': 3, '720p': 2, '480p': 1, '360p': 1, 'CAM': 0, 'Auto': 2 };

  function fmtStremioStream(stream, an, bu) {
    try {
      if (!stream) return null;
      var on = str(stream.name).replace(/\n/g, ' ').trim();
      var ot = str(stream.title).replace(/\n/g, ' ').trim();
      var desc = str(stream.description);
      var f = parseFeatures(on + ' ' + ot + ' ' + desc);
      var dn = ot || on || an;
      var hdrs = {};
      if (stream.behaviorHints) {
        if (stream.behaviorHints.proxyHeaders && stream.behaviorHints.proxyHeaders.request) hdrs = Object.assign({}, stream.behaviorHints.proxyHeaders.request);
        else if (stream.behaviorHints.headers) hdrs = Object.assign({}, stream.behaviorHints.headers);
      }
      if (!hdrs['User-Agent']) hdrs['User-Agent'] = UA_DESKTOP;
      if (!hdrs['Referer']) hdrs['Referer'] = bu + '/';
      if (!hdrs['Origin']) hdrs['Origin'] = bu;
      var bh = Object.assign({}, stream.behaviorHints || {});
      delete bh.proxyHeaders; delete bh.headers;

      if (stream.url && (stream.url.indexOf('http://') === 0 || stream.url.indexOf('https://') === 0)) {
        var isDirect = /\.(mp4|mkv|webm|avi|mov)(\?|$)/i.test(stream.url);
        var isStream = /\.(m3u8|mpd)(\?|$)/i.test(stream.url);
        var isProxy = /(extract|proxy|redirect|gateway|fetch|resolve)/i.test(stream.url);
        var hasRestrictiveHeaders = Object.keys(hdrs).length > 1;
        var finalUrl = stream.url;
        if (hasRestrictiveHeaders && !isDirect) finalUrl = 'MAGIC_PROXY_v1' + btoa(stream.url);
        if (!bh.notWebReady && (!isDirect || isProxy || isStream)) bh.notWebReady = true;
        if (bh.notWebReady && Object.keys(bh).length === 1) bh = { notWebReady: true };
        var result = new StreamResult({ url: finalUrl, quality: f.resolution, source: dn, title: dn, cached: !!stream.cached, size: stream.size || null, headers: hdrs, behaviorHints: bh, addonSource: an, resolution: f.resolution !== 'Auto' ? f.resolution : null, _sortKey: f._sortKey });
        if (isStream && !result.headers['Origin']) { try { result.headers['Origin'] = new URL(stream.url).origin; } catch (e) {} }
        if (Array.isArray(stream.subtitles)) result.subtitles = stream.subtitles.map(function(sub) { return { id: sub.id || '', url: sub.url || '', lang: normLang(sub.lang), label: sub.label || normLang(sub.lang) }; });
        return result;
      }
      if (stream.infoHash) {
        var fn = (stream.behaviorHints && stream.behaviorHints.filename) || stream.title || stream.name || '';
        if (!Object.keys(bh).length) bh = { notWebReady: true };
        return new StreamResult({ url: magnetLink(stream.infoHash, fn), infoHash: stream.infoHash, fileIndex: stream.fileIdx !== undefined ? stream.fileIdx : 0, quality: f.resolution, source: dn, title: fn || dn, headers: hdrs, behaviorHints: bh, addonSource: an, resolution: f.resolution !== 'Auto' ? f.resolution : null, _sortKey: f._sortKey });
      }
      if (stream.ytId) return new StreamResult({ url: 'https://www.youtube.com/watch?v=' + stream.ytId, quality: 'YouTube', source: an + ' YouTube', headers: { 'Referer': 'https://www.youtube.com/', 'User-Agent': UA_DESKTOP }, behaviorHints: { notWebReady: true }, _sortKey: 1 });
      if (stream.externalUrl) {
        var eu = stream.externalUrl.toLowerCase();
        var garbage = ['ko-fi.com','patreon.com','buymeacoffee.com','paypal.com','discord.gg','discord.com','facebook.com','twitter.com','x.com','instagram.com','t.me','telegram.org','reddit.com','whatsapp.com','bit.ly','tinyurl.com','goo.gl','ow.ly','tiny.cc','adf.ly','shorte.st'];
        var isGarbage = false;
        for (var gi = 0; gi < garbage.length; gi++) { if (eu.indexOf(garbage[gi]) !== -1) { isGarbage = true; break; } }
        if (!isGarbage) return new StreamResult({ url: stream.externalUrl, quality: f.resolution, source: an + ' External', headers: hdrs, behaviorHints: Object.keys(bh).length ? bh : { notWebReady: true }, _sortKey: f._sortKey });
        return null;
      }
      if (stream.nzbUrl) {
        return new StreamResult({ url: stream.nzbUrl, quality: f.resolution, source: an + ' Usenet', headers: hdrs, behaviorHints: Object.keys(bh).length ? bh : { notWebReady: true }, _sortKey: f._sortKey });
      }
      var archKeys = [{k:'rarUrls',l:'RAR'},{k:'zipUrls',l:'ZIP'},{k:'7zipUrls',l:'7z'},{k:'tgzUrls',l:'TGZ'},{k:'tarUrls',l:'TAR'}];
      for (var ai = 0; ai < archKeys.length; ai++) {
        if (Array.isArray(stream[archKeys[ai].k]) && stream[archKeys[ai].k].length) {
          var src = stream[archKeys[ai].k][0];
          var srcUrl = (typeof src === 'string') ? src : (src.url || '');
          if (srcUrl) {
            return new StreamResult({ url: srcUrl, quality: f.resolution, source: an + ' ' + archKeys[ai].l, headers: hdrs, behaviorHints: Object.keys(bh).length ? bh : { notWebReady: true }, _sortKey: f._sortKey });
          }
        }
      }
      if (stream.url) {
        var hash = null;
        if (stream.url.indexOf('magnet:?xt=urn:btih:') === 0) { var m = stream.url.match(/urn:btih:([a-fA-F0-9]+)/); if (m) hash = m[1].toLowerCase(); }
        if (!Object.keys(bh).length && (hash || stream.url.indexOf('magnet:') === 0)) bh = { notWebReady: true };
        var res = new StreamResult({ url: stream.url, quality: f.resolution, source: dn, headers: hdrs, behaviorHints: bh, title: dn, addonSource: an, resolution: f.resolution !== 'Auto' ? f.resolution : null, _sortKey: f._sortKey });
        if (hash) { res.infoHash = hash; res.fileIndex = 0; }
        return res;
      }
      return null;
    } catch (e) { return null; }
  }

  function processStremioStreams(streams, an, bu) {
    if (!Array.isArray(streams)) return [];
    var out = [];
    for (var i = 0; i < streams.length; i++) { try { var f = fmtStremioStream(streams[i], an, bu); if (f) out.push(f); } catch (e) {} }
    return out;
  }

  async function fetchStremioStreams(tmdbId, mediaType, season, episode) {
    var sAddons = getStreamingAddons();
    if (!sAddons.length) return [];

    var typeStr = (mediaType === 'tv') ? 'series' : 'movie';
    var streamUrls = [], streamInfo = [];
    for (var ai = 0; ai < sAddons.length; ai++) {
      var bu = baseUrl(sAddons[ai]);
      var an = addonName(sAddons[ai]);
      var id = tmdbId;
      if (mediaType === 'tv' && season && episode) id = tmdbId + ':' + season + ':' + episode;
      streamUrls.push(bu + '/stream/' + typeStr + '/' + encodeURIComponent(id) + '.json');
      streamInfo.push({ addonIdx: ai, addonName: an, baseUrl: bu });
    }

    var allStreams = [], addonStreams = {};

    // Phase 1: Fast fetch
    var phase1Results = await httpBatch(streamUrls);
    for (var ri = 0; ri < phase1Results.length; ri++) {
      var sr = phase1Results[ri];
      var info = streamInfo[ri];
      if (!sr.ok || !sr.data || !Array.isArray(sr.data.streams) || !sr.data.streams.length) continue;
      var idx = info.addonIdx;
      if (!addonStreams[idx]) addonStreams[idx] = { addonName: info.addonName, baseUrl: info.baseUrl, streams: [] };
      var processed = processStremioStreams(sr.data.streams, info.addonName, info.baseUrl);
      addonStreams[idx].streams = addonStreams[idx].streams.concat(processed);
    }
    for (var ai = 0; ai < sAddons.length; ai++) { if (addonStreams[ai]) allStreams = allStreams.concat(addonStreams[ai].streams); }

    // Phase 2: Wait for delayed addons (only if < 10 streams)
    if (allStreams.length < 10) {
      try {
        var slowUrls = [], slowInfo = [];
        for (var si = 0; si < streamUrls.length; si++) {
          var sr = phase1Results[si];
          if (!sr.ok || !sr.data || !Array.isArray(sr.data.streams) || !sr.data.streams.length) {
            slowUrls.push(streamUrls[si]);
            slowInfo.push(streamInfo[si]);
          }
        }
        if (slowUrls.length) {
          var phase2Promise = new Promise(function(resolve) {
            setTimeout(function() {
              httpBatch(slowUrls).then(function(results) {
                for (var ri = 0; ri < results.length; ri++) {
                  var sr = results[ri];
                  var info = slowInfo[ri];
                  if (!sr.ok || !sr.data || !Array.isArray(sr.data.streams) || !sr.data.streams.length) continue;
                  var idx = info.addonIdx;
                  if (!addonStreams[idx]) addonStreams[idx] = { addonName: info.addonName, baseUrl: info.baseUrl, streams: [] };
                  var processed = processStremioStreams(sr.data.streams, info.addonName, info.baseUrl);
                  addonStreams[idx].streams = addonStreams[idx].streams.concat(processed);
                }
                var extra = [];
                for (var ai = 0; ai < sAddons.length; ai++) { if (addonStreams[ai]) extra = extra.concat(addonStreams[ai].streams); }
                resolve(extra);
              }).catch(function() { resolve([]); });
            }, 15000);
          });
          var extraStreams = await Promise.race([phase2Promise, new Promise(function(r) { setTimeout(function() { r([]); }, 45000); })]);
          if (extraStreams.length) {
            allStreams = [];
            for (var ai = 0; ai < sAddons.length; ai++) { if (addonStreams[ai]) allStreams = allStreams.concat(addonStreams[ai].streams); }
          }
        }
      } catch (e) { /* phase 2 is best-effort */ }
    }

    return allStreams;
  }

  // ===========================================================================
  // STREMIO META → MULTIMEDIA ITEM
  // ===========================================================================

  function parseYear(meta) {
    if (!meta) return undefined;
    if (meta.year != null) { var y = parseInt(meta.year, 10); if (y > 1900 && y < 2100) return y; }
    if (meta.releaseInfo) { var parts = str(meta.releaseInfo).split(/[–-]/).shift().trim(); var y = parseInt(parts, 10); if (y > 1900 && y < 2100) return y; }
    return undefined;
  }
  function parseRating(meta) {
    if (meta.imdbRating != null) { var r = parseFloat(meta.imdbRating); if (!isNaN(r) && r >= 0 && r <= 10) return r; }
    if (meta.score != null) { var r = parseFloat(meta.score); if (!isNaN(r) && r >= 0 && r <= 10) return r; }
    return undefined;
  }
  function parseGenres(meta) { var g = meta.genres || meta.genre || meta.tags; return (Array.isArray(g) && g.length) ? g : undefined; }

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
        description: str(m.description || m.overview || m.synopsis || '').replace(/<[^>]*>/g, '').trim().substring(0, 500),
        year: parseYear(m), score: parseRating(m), genres: parseGenres(m)
      });
    } catch (e) { return null; }
  }

  function parseVideoId(raw) {
    if (!raw) return null;
    var p = safeJson(raw, null);
    if (p && p.i !== undefined) return { id: str(p.i), type: p.t || null, season: p.s || 0, episode: p.e || 0 };
    if (p && p.tmdbId !== undefined) return { id: str(p.tmdbId), type: p.mediaType || null, season: p.seasonNumber || 0, episode: p.episodeNumber || 0 };
    if (raw.indexOf(':') !== -1) {
      var parts = raw.split(':');
      var first = parts[0];
      if (/^tt\d+$/.test(first) && parts.length >= 3) { var sn = parseInt(parts[1], 10); var en = parseInt(parts[2], 10); return { id: first, type: 'series', season: isNaN(sn) ? 0 : sn, episode: isNaN(en) ? 0 : en }; }
      if (first.indexOf('_') !== -1 || first.indexOf('-') !== -1) return { id: raw, type: 'series', season: 0, episode: 0 };
      // Service-prefixed ID like "kitsu:7442" or "tmdb:1234" — don't guess type
      if (/^[a-zA-Z]+$/.test(first) && parts.length >= 2) return { id: raw, type: null, season: 0, episode: 0 };
    }
    // Bare ID — type unknown, let load() try all types
    return { id: raw, type: null, season: 0, episode: 0 };
  }

  // ===========================================================================
  // CORE PLUGIN FUNCTIONS
  // ===========================================================================

  // ----- getHome() → Stremio catalogs only (like StremioTest) -----
  async function getHome(cb, page) {
    try {
      var pn = parseInt(page) || 1;
      var urls = getCatalogueAddons();
      if (!urls.length) return cb({ success: false, errorCode: 'NO_ADDONS', message: 'No catalogueAddons' });

      var results = { data: {}, order: [] };

      var manifestResults = [];
      var uncachedUrls = [];
      var uncachedIndices = [];
      for (var i = 0; i < urls.length; i++) {
        var cached = pCacheGet('mf:' + urls[i]);
        if (cached) {
          manifestResults[i] = cached;
        } else {
          uncachedUrls.push(urls[i]);
          uncachedIndices.push(i);
        }
      }

      if (uncachedUrls.length) {
        var mfBatch = await httpBatch(uncachedUrls);
        for (var j = 0; j < mfBatch.length; j++) {
          var idx = uncachedIndices[j];
          if (mfBatch[j].ok && mfBatch[j].data) {
            manifestResults[idx] = mfBatch[j].data;
            pCacheSet('mf:' + uncachedUrls[j], mfBatch[j].data);
          }
        }
      }

      var catalogUrls = [];
      for (var ai = 0; ai < urls.length; ai++) {
        var mf = manifestResults[ai];
        if (!mf || !Array.isArray(mf.catalogs) || !mf.catalogs.length) continue;
        var bu = baseUrl(urls[ai]);
        var an = addonName(urls[ai]);
        for (var ci = 0; ci < mf.catalogs.length; ci++) {
          var cat = mf.catalogs[ci];
          if (!cat || !cat.id || !cat.type) continue;
          var extras = cat.extra || [];
          if (extras.some(function(e) { return e && e.name === 'search' && e.isRequired === true; })) continue;

          var catUrl = bu + '/catalog/' + cat.type + '/' + cat.id + '.json';
          if (pn > 1) catUrl += (catUrl.indexOf('?') === -1 ? '?' : '&') + 'skip=' + ((pn - 1) * 20);

          catalogUrls.push({
            url: catUrl, addonIdx: ai, addonName: an,
            catName: cat.name || cat.id, catType: cat.type, totalAddons: urls.length
          });
        }
      }

      if (!catalogUrls.length) return cb({ success: false, errorCode: 'NO_DATA', message: 'No catalogs' });

      var catUrlsArr = catalogUrls.map(function(c) { return c.url; });
      var catResults = await httpBatch(catUrlsArr);

      for (var ri = 0; ri < catResults.length; ri++) {
        var cr = catResults[ri];
        var info = catalogUrls[ri];
        if (!cr.ok || !cr.data || !Array.isArray(cr.data.metas) || !cr.data.metas.length) continue;

        var items = cr.data.metas.map(function(m) { return stremioToItem(m, info.catType); }).filter(Boolean);
        if (!items.length) continue;

        var catLabel = info.catName;
        if (!results.data[catLabel]) {
          results.data[catLabel] = items;
          results.order.push(catLabel);
        }
      }

      if (!Object.keys(results.data).length) return cb({ success: false, errorCode: 'NO_DATA', message: 'No catalog data' });
      var out = {};
      for (var i = 0; i < results.order.length; i++) { if (results.data[results.order[i]]) out[results.order[i]] = results.data[results.order[i]]; }
      log('getHome: ' + Object.keys(out).length + ' categories');
      cb({ success: true, data: out, page: pn });
    } catch (e) {
      warn('getHome error: ' + (e.message || e));
      cb({ success: false, errorCode: 'HOME_ERROR', message: e.message || 'Error' });
    }
  }

  // ----- search(query) → Stremio catalogs only (like StremioTest) -----
  async function search(query, cb) {
    try {
      var q = str(query).trim().toLowerCase();
      if (!q) return cb({ success: true, data: [] });

      var urls = getCatalogueAddons();
      if (!urls.length) return cb({ success: true, data: [] });

      var all = [];
      var seen = {};
      function addItem(item) { if (item && item.url && !seen[item.url]) { seen[item.url] = true; all.push(item); } }

      var manifests = [];
      var uncachedUrls = [], uncachedIdx = [];
      for (var i = 0; i < urls.length; i++) {
        var c = pCacheGet('mf:' + urls[i]);
        if (c) { manifests[i] = c; }
        else { uncachedUrls.push(urls[i]); uncachedIdx.push(i); }
      }
      if (uncachedUrls.length) {
        var mfRes = await httpBatch(uncachedUrls);
        for (var j = 0; j < mfRes.length; j++) {
          if (mfRes[j].ok && mfRes[j].data) {
            manifests[uncachedIdx[j]] = mfRes[j].data;
            pCacheSet('mf:' + uncachedUrls[j], mfRes[j].data);
          }
        }
      }

      var searchUrls = [];
      for (var ai = 0; ai < urls.length; ai++) {
        var mf = manifests[ai];
        if (!mf || !Array.isArray(mf.catalogs) || !mf.catalogs.length) continue;
        var bu = baseUrl(urls[ai]);

        var searchCats = [], browseCats = [];
        for (var ci = 0; ci < mf.catalogs.length; ci++) {
          var cat = mf.catalogs[ci];
          if (!cat || !cat.id || !cat.type) continue;
          var extras = cat.extra || [];
          if (extras.some(function(e) { return e && e.name === 'search'; })) searchCats.push(cat);
          else if (browseCats.length < 5) browseCats.push(cat);
        }

        for (var si = 0; si < searchCats.length; si++) {
          searchUrls.push({
            url: bu + '/catalog/' + searchCats[si].type + '/' + searchCats[si].id + '/search=' + encodeURIComponent(query) + '.json',
            catType: searchCats[si].type, isSearch: true
          });
        }
        for (var bi = 0; bi < browseCats.length; bi++) {
          searchUrls.push({
            url: bu + '/catalog/' + browseCats[bi].type + '/' + browseCats[bi].id + '.json',
            catType: browseCats[bi].type, isSearch: false
          });
        }
      }

      if (!searchUrls.length) return cb({ success: true, data: [] });

      var sUrls = searchUrls.map(function(s) { return s.url; });
      var sResults = await httpBatch(sUrls);

      var foundSearch = false;
      for (var ri = 0; ri < sResults.length && all.length < 50; ri++) {
        var sr = sResults[ri];
        var info = searchUrls[ri];
        if (!sr.ok || !sr.data) continue;
        if (info.isSearch) {
          if (Array.isArray(sr.data.metas) && sr.data.metas.length) {
            foundSearch = true;
            for (var mi = 0; mi < sr.data.metas.length && all.length < 50; mi++) {
              addItem(stremioToItem(sr.data.metas[mi], info.catType));
            }
          }
        }
      }

      if (!foundSearch) {
        for (var ri = 0; ri < sResults.length && all.length < 50; ri++) {
          var sr = sResults[ri];
          var info = searchUrls[ri];
          if (info.isSearch || !sr.ok || !sr.data || !Array.isArray(sr.data.metas)) continue;
          for (var mi = 0; mi < sr.data.metas.length && all.length < 50; mi++) {
            var m = sr.data.metas[mi];
            if (str(m.name || m.title || '').toLowerCase().indexOf(q) !== -1) {
              addItem(stremioToItem(m, info.catType));
            }
          }
        }
      }

      cb({ success: true, data: all.slice(0, 50) });
    } catch (e) {
      warn('search error: ' + (e.message || e));
      cb({ success: true, data: [] });
    }
  }

  // ----- load(url) → Stremio metadata with pre-fetch (like StremioTest) -----
  async function load(url, cb) {
    try {
      var rawInput = str(url).trim();
      if (!rawInput) return cb({ success: false, errorCode: 'PARSE_ERROR', message: 'No ID' });

      var vp = parseVideoId(rawInput);
      var metaId = vp ? vp.id : rawInput;
      var knownType = vp ? vp.type : null;
      if (!metaId) return cb({ success: false, errorCode: 'PARSE_ERROR', message: 'No ID' });

      // Resolve TMDB ID to IMDB for metadata lookup
      var tmdbMatch = rawInput.match(/^tmdb:(movie|series|tv):(\d+)$/);
      if (tmdbMatch) {
        var tmdbId = tmdbMatch[2];
        var tmdbType = tmdbMatch[1];
        var apiType = (tmdbType === 'movie') ? 'movie' : 'tv';
        var extResult = await fetchJson(TMDB_BASE + '/' + apiType + '/' + tmdbId + '/external_ids?api_key=' + TMDB_KEY, H_JSON).catch(function() { return null; });
        if (extResult && extResult.imdb_id) {
          metaId = extResult.imdb_id;
          knownType = (tmdbType === 'movie') ? 'movie' : 'series';
        }
      }

      var addonUrls = getCatalogueAddons();
      if (!addonUrls.length) return respondMeta({ name: 'Content', id: metaId, type: knownType || 'movie' }, metaId, cb);

      var eid = encodeURIComponent(metaId);
      var tryTypes = knownType ? [knownType, 'movie', 'series', 'anime', 'channel', 'tv']
                                : ['movie', 'series', 'anime', 'channel', 'tv'];

      var metaUrls = [];
      var metaInfo = [];
      for (var ai = 0; ai < addonUrls.length; ai++) {
        var bu = baseUrl(addonUrls[ai]);
        for (var ti = 0; ti < tryTypes.length; ti++) {
          metaUrls.push(bu + '/meta/' + tryTypes[ti] + '/' + eid + '.json');
          metaInfo.push({ addonUrl: addonUrls[ai], type: tryTypes[ti] });
        }
      }

      var metaResults = await httpBatch(metaUrls);

      var foundMeta = null;
      for (var ri = 0; ri < metaResults.length; ri++) {
        var mr = metaResults[ri];
        if (!mr.ok || !mr.data) continue;
        var metaInfoEntry = metaInfo[ri];
        var isNonMovie = metaInfoEntry && metaInfoEntry.type !== 'movie';
        if (mr.data.meta && mr.data.meta.id) {
          // Prefer non-movie results (series/anime/tv) — movie addons often return
          // fallback data for unknown IDs, overriding the correct series metadata
          if (isNonMovie) { foundMeta = mr.data.meta; break; }
          if (!foundMeta) foundMeta = mr.data.meta;
        }
        if (Array.isArray(mr.data.metas) && mr.data.metas.length && mr.data.metas[0].id) {
          if (isNonMovie) { foundMeta = mr.data.metas[0]; break; }
          if (!foundMeta) foundMeta = mr.data.metas[0];
        }
      }

      if (foundMeta) {
        // Derive a TMDB-friendly ID for stream pre-fetching
        var streamPrefetchId = metaId;
        if (foundMeta.imdb_id && /^tt\d+$/i.test(foundMeta.imdb_id)) streamPrefetchId = foundMeta.imdb_id;
        else if (foundMeta.id && /^tt\d+$/i.test(foundMeta.id)) streamPrefetchId = foundMeta.id;
        respondMeta(foundMeta, metaId, cb);

        // Pre-fetch streams using TMDB-friendly ID for Nuvio compatibility
        try {
          loadStreams(streamPrefetchId, function() {
            pCacheSet('streams:' + metaId, arguments[0]);
          });
        } catch (e) { /* pre-fetch is best-effort */ }
      } else {
        var isSeries = (knownType === 'series' || knownType === 'anime' || knownType === 'tv' || knownType === 'channel');
        respondMeta({ name: 'Content', id: metaId, type: isSeries ? 'series' : 'movie' }, metaId, cb);

        // Pre-fetch streams in background
        try {
          loadStreams(rawInput, function() {
            pCacheSet('streams:' + metaId, arguments[0]);
          });
        } catch (e) { /* pre-fetch is best-effort */ }
      }
    } catch (e) {
      warn('load error: ' + (e.message || e));
      try { respondMeta({ name: 'Unknown', id: rawInput, type: 'movie' }, rawInput, cb); } catch (f) {
        cb({ success: false, errorCode: 'LOAD_ERROR', message: e.message || 'Error' });
      }
    }
  }

  function respondMeta(meta, metaId, cb) {
    try {
      var t = meta.type || 'movie';
      var st = skyType(t);
      var y = parseYear(meta);
      var s = parseRating(meta);
      var desc = str(meta.description || meta.overview || meta.synopsis || '').replace(/<[^>]*>/g, '').trim();
      var eps = [], isSeries = (st !== 'movie');

      // Derive a TMDB/IMDB-friendly ID for episode URLs so loadStreams can
      // resolve to TMDB for Nuvio providers. Priority: explicit imdb_id > tt-prefixed id > original
      var streamId = metaId;
      if (meta.imdb_id && /^tt\d+$/i.test(meta.imdb_id)) streamId = meta.imdb_id;
      else if (meta.id && /^tt\d+$/i.test(meta.id)) streamId = meta.id;

      if (isSeries && Array.isArray(meta.videos) && meta.videos.length) {
        for (var vi = 0; vi < meta.videos.length; vi++) {
          try {
            var v = meta.videos[vi];
            if (!v || !v.id) continue;
            var sn = v.season || 1, en = v.episode || v.number || 1;
            eps.push(new Episode({ name: v.name || v.title || 'Episode ' + en, url: streamId + ':' + sn + ':' + en, season: sn, episode: en, posterUrl: v.thumbnail || v.poster || meta.poster || '', description: v.overview || v.description || '', airDate: v.released || v.firstAired || '' }));
          } catch (e) {}
        }
      }
      if (!eps.length) { var vid = isSeries ? (streamId + ':1:1') : streamId; eps.push(new Episode({ name: st === 'movie' ? 'Full Movie' : 'Watch', url: vid, season: 1, episode: 1, posterUrl: meta.poster || '' })); }
      var cast = undefined;
      if (Array.isArray(meta.cast) && meta.cast.length) {
        cast = [];
        for (var ci = 0; ci < meta.cast.length; ci++) {
          try { var c = meta.cast[ci]; if (!c) continue; cast.push(typeof c === 'string' ? new Actor({ name: c, role: '', image: '' }) : new Actor({ name: c.name || c.fullName || c.person || '', role: c.role || c.character || '', image: c.image || c.picture || c.photo || c.profile || c.profile_path || '' })); } catch (e) {}
        }
        if (!cast.length) cast = undefined;
      }
      var trailers = undefined;
      if (Array.isArray(meta.trailers) && meta.trailers.length) {
        trailers = [];
        for (var tri = 0; tri < meta.trailers.length; tri++) {
          try { var tr = meta.trailers[tri]; if (!tr) continue; var src = tr.source || tr.url || ''; var trUrl = (src.indexOf('http') === 0) ? src : 'https://www.youtube.com/watch?v=' + src; trailers.push(new Trailer({ url: trUrl, name: tr.name || tr.type || 'Trailer' })); } catch (e) {}
        }
        if (!trailers.length) trailers = undefined;
      }
      var director = undefined;
      if (meta.director) { director = Array.isArray(meta.director) ? meta.director.filter(Boolean).join(', ') : str(meta.director); if (!director) director = undefined; }
      var status = undefined;
      if (meta.status) { var sv = str(meta.status).toLowerCase(); if (sv === 'ended') status = 'completed'; else if (sv === 'returning series' || sv === 'continuing' || sv === 'ongoing') status = 'ongoing'; else if (sv === 'in production' || sv === 'planned') status = 'upcoming'; }
      cb({ success: true, data: new MultimediaItem({ title: meta.name || meta.title || 'Unknown', url: metaId, posterUrl: meta.poster || meta.posterUrl || '', posterShape: meta.posterShape || 'poster', bannerUrl: meta.background || meta.backdrop || meta.banner || '', logoUrl: meta.logo || meta.logoUrl || '', type: st, description: desc, year: y, score: s, genres: parseGenres(meta), cast: cast, director: director, trailers: trailers, runtime: meta.runtime ? str(meta.runtime) : undefined, language: meta.language || undefined, country: meta.country || undefined, awards: meta.awards || undefined, website: meta.website || undefined, status: status, episodes: eps })});
    } catch (e) {
      console.error('[' + TAG + '] respondMeta:', e.message);
      var ft = skyType(meta.type || 'movie');
      var fallbackStreamId = metaId;
      if (meta.imdb_id && /^tt\d+$/i.test(meta.imdb_id)) fallbackStreamId = meta.imdb_id;
      else if (meta.id && /^tt\d+$/i.test(meta.id)) fallbackStreamId = meta.id;
      cb({ success: true, data: new MultimediaItem({ title: meta.name || meta.title || 'Unknown', url: metaId, type: ft, episodes: [new Episode({ name: 'Play', url: ft === 'movie' ? fallbackStreamId : fallbackStreamId + ':1:1', season: 1, episode: 1 })] })});
    }
  }

  // ----- loadStreams(url) → Nuvio providers only -----
  function loadStreams(url, cb) {
    log('loadStreams: ' + url);

    // Parse Nuvio URL (TMDB-based)
    var nuvioP = parseNuvioUrl(url);
    if (nuvioP) {
      var key = cacheKey(url);
      if (_streamCache[key]) { log('Cache hit: ' + _streamCache[key].length + ' streams'); return cb({ success: true, data: _streamCache[key] }); }
      var typeStr = (nuvioP.mediaType === 'tv') ? 'series' : 'movie';
      fetchAllStreams(nuvioP.tmdbId, typeStr, nuvioP.season || 0, nuvioP.episode || 0).then(function(streams) {
        _streamCache[key] = streams;
        log('loadStreams returning ' + streams.length + ' streams');
        cb({ success: true, data: streams });
      }).catch(function(e) { warn('loadStreams error: ' + (e.message || e)); cb({ success: true, data: [] }); });
      return;
    }

    // Extract TMDB ID from various URL formats
    var tmdbId = null, typeStr = 'movie', season = 0, episode = 0;
    var raw = str(url).trim();

    // Format: tmdb:movie:550 or tmdb:series:1668
    var tmdbMatch = raw.match(/^tmdb:(movie|series|tv):(\d+)$/);
    if (tmdbMatch) {
      tmdbId = tmdbMatch[2];
      typeStr = (tmdbMatch[1] === 'movie') ? 'movie' : 'series';
    }

    // Format: numericId:season:episode (e.g. 1668:1:2)
    if (!tmdbId) {
      var epMatch = raw.match(/^(\d+):(\d+):(\d+)$/);
      if (epMatch) {
        tmdbId = epMatch[1];
        typeStr = 'series';
        season = parseInt(epMatch[2], 10) || 0;
        episode = parseInt(epMatch[3], 10) || 0;
      }
    }

    // Format: plain numeric TMDB ID (e.g. 550)
    if (!tmdbId && /^\d+$/.test(raw)) {
      tmdbId = raw;
      typeStr = 'movie';
    }

    // Format: IMDB ID (e.g. tt0137523 or tt0137523:1:2)
    var imdbMatch = raw.match(/^(tt\d+)(?::(\d+):(\d+))?$/);
    if (imdbMatch) {
      var imdbId = imdbMatch[1];
      season = parseInt(imdbMatch[2], 10) || 0;
      episode = parseInt(imdbMatch[3], 10) || 0;
      var cached = pCacheGet('streams:' + imdbId);
      if (cached && cached.success && cached.data && cached.data.length) { cb({ success: true, data: cached.data }); return; }
      tmdbFind(imdbId, 'imdb_id').then(function(found) {
        var tid = found ? found.tmdbId : null;
        // Use TMDB-resolved type (tv/movie) instead of guessing from season/episode
        var resolvedType = found ? found.type : null;
        var finalType = (resolvedType === 'tv') ? 'series' : (season || episode) ? 'series' : 'movie';
        return fetchAllStreams(tid, finalType, season, episode);
      }).then(function(streams) {
        pCacheSet('streams:' + imdbId, { success: true, data: streams });
        log('loadStreams returning ' + streams.length + ' streams');
        cb({ success: true, data: streams });
      }).catch(function(e) { warn('loadStreams error: ' + (e.message || e)); cb({ success: true, data: [] }); });
      return;
    }

    // Fallback: resolve non-TMDB IDs through TMDB if possible
    function resolveAndFetch(id, type, s, e) {
      // If it's an IMDB-looking ID, try TMDB resolution first
      if (/^tt\d+$/i.test(id)) {
        tmdbFind(id, 'imdb_id').then(function(found) {
          var tid = found ? found.tmdbId : id;
          var resolvedType = found ? found.type : type;
          var ft = (resolvedType === 'tv') ? 'series' : (s || e) ? 'series' : 'movie';
          return fetchAllStreams(tid, ft, s, e);
        }).then(handleResult).catch(function() {
          fetchAllStreams(id, type, s, e).then(handleResult).catch(function(e2) { warn('loadStreams error: ' + (e2.message || e2)); cb({ success: true, data: [] }); });
        });
      } else {
        fetchAllStreams(id, type, s, e).then(handleResult).catch(function(e2) { warn('loadStreams error: ' + (e2.message || e2)); cb({ success: true, data: [] }); });
      }
    }

    if (!tmdbId) {
      var vp = parseVideoId(raw);
      if (vp) { tmdbId = vp.id; typeStr = (vp.type === 'tv' || vp.type === 'series' || vp.type === 'anime') ? 'series' : 'movie'; season = vp.season || 0; episode = vp.episode || 0; }
      else { tmdbId = raw; }
    }

    var cacheKey2 = 'streams:' + tmdbId;
    var cached2 = pCacheGet(cacheKey2);
    if (cached2 && cached2.success && cached2.data && cached2.data.length) { cb({ success: true, data: cached2.data }); return; }

    function handleResult(streams) {
      pCacheSet(cacheKey2, { success: true, data: streams });
      log('loadStreams returning ' + streams.length + ' streams');
      cb({ success: true, data: streams });
    }

    resolveAndFetch(tmdbId, typeStr, season, episode);
  }

  function fetchAllStreams(tmdbId, typeStr, season, episode) {
    if (!tmdbId) return Promise.resolve([]);
    var nuvioType = (typeStr === 'series') ? 'tv' : typeStr;
    var promises = [];
    // Fetch from Nuvio providers
    promises.push(fetchNuvioStreams(tmdbId, nuvioType, season, episode).catch(function() { return []; }));
    // Also fetch from Stremio streaming addons (was previously unused dead code)
    promises.push(fetchStremioStreams(tmdbId, typeStr, season, episode).catch(function() { return []; }));
    return Promise.all(promises).then(function(results) {
      var combined = [];
      for (var ri = 0; ri < results.length; ri++) combined = combined.concat(results[ri]);
      var seen = {}, unique = [];
      for (var i = 0; i < combined.length; i++) {
        var s = combined[i];
        if (!s || !s.url) continue;
        var key = s.url;
        if (!seen[key]) { seen[key] = true; unique.push(s); }
      }
      unique.sort(function(a, b) {
        var ka = QUALITY_ORDER[(a && a.quality) || 'Auto'] || 2;
        var kb = QUALITY_ORDER[(b && b.quality) || 'Auto'] || 2;
        return kb - ka;
      });
      return unique;
    });
  }

  // ===========================================================================
  // UTILITY
  // ===========================================================================

  function pad(n, width) { var s = String(n); while (s.length < width) { s = '0' + s; } return s; }

  // ===========================================================================
  // EXPORTS
  // ===========================================================================

  globalThis.getHome = getHome;
  globalThis.search = search;
  globalThis.load = load;
  globalThis.loadStreams = loadStreams;

  log('Plugin v7 loaded — ' + NUVIO_SOURCES.length + ' Nuvio sources, ' + getCatalogueAddons().length + ' Stremio catalog addons, ' + getStreamingAddons().length + ' Stremio streaming addons');
})();
