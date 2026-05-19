(function () {

  'use strict';

  var TAG = 'NuvioBridgeV7';

  // ===========================================================================
  // 🔥 FIX #1: Only REAL TMDB API keys (removed fake sequential + dead keys)
  // ===========================================================================
  var TMDB_KEYS = [
    '68e094699525b18a70bab2f86b1fa706',  // Key 1 — most commonly used public key
    'af3a53eb387d57fc935e9128468b1899',  // Key 2 — from xbmc official addon
    '0142a22c560ce3efb1cfd6f3b2faab77',  // Key 3 — legacy xbmc key
  ];
  var TMDB_BASE = 'https://api.themoviedb.org/3';
  var TMDB_IMG_BASE = 'https://image.tmdb.org/t/p';
  var _tmdbKeyIdx = 0;

  // ===========================================================================
  // TMDB IMAGE SIZES REFERENCE
  // ===========================================================================
  // All images are PNG/JPEG from TMDB CDN (image.tmdb.org).
  // Currently using MEDIUM sizes everywhere for best quality/speed balance.
  //
  // POSTER (portrait poster art):
  //   w92 | w154 | w185 | w342 | w500 | w780 | original
  //   ← small ————————— medium ———————— large →
  //   CURRENT: w500 (medium)
  //
  // BACKDROP (landscape hero art):
  //   w300 | w780 | w1280 | original
  //   ← small — medium — large →
  //   CURRENT: w780 (medium)
  //
  // STILL (episode screenshot):
  //   w92 | w185 | w300 | original
  //   CURRENT: w300 (medium)
  //
  // PROFILE (actor headshot):
  //   w45 | w185 | h632 | original
  //   CURRENT: w185 (medium)
  //
  // LOGO (transparent brand logo):
  //   w45 | w92 | w154 | w185 | w300 | w500 | original
  //   CURRENT: not used (set w300 if needed)
  //
  // To switch sizes, replace the segment after TMDB_IMG_BASE + '/'
  // e.g. TMDB_IMG_BASE + '/w342' + poster_path  →  TMDB_IMG_BASE + '/original' + poster_path
  //
  // Quick-size variables (change these to pick a different size everywhere):
  //   IMG_POSTER  — used for movie/show posters and thumbnails
  //   IMG_BACKDROP — used for banner/hero images
  //   IMG_STILL   — used for episode screenshots
  //   IMG_PROFILE — used for actor headshots
  // ===========================================================================
  var IMG_POSTER = 'w500';
  var IMG_BACKDROP = 'w780';
  var IMG_STILL = 'w300';
  var IMG_PROFILE = 'w185';

  // ===========================================================================
  // TUNABLES
  // ===========================================================================
  var FETCH_CODE_TIMEOUT   = 15000;   // 15s to download a provider JS file (files are <50KB)
  var PROVIDER_TIMEOUT     = 20000;   // 20s for a provider to return streams (most respond in 3-8s)
  var MANIFEST_TIMEOUT     = 15000;   // 15s to fetch a manifest (JSON, small)
  var STAGGER_MS           = 200;     // 200ms stagger between provider starts
  var STREAM_TIMEOUT       = 45000;   // 45s — all providers finish within this even on slow internet
  var LOAD_TIMEOUT         = 20000;   // 20s max for loading movie/series details & episodes
  var HOME_TIMEOUT         = 12000;   // 12s total for home categories (must fit within SkyStream app's plugin timeout)
  var CATEGORY_TIMEOUT     = 10000;   // 10s per category
  var STREAM_CACHE_TTL     = 3600000; // 1 hour cache for stream results (prevents re-fetch on navigate back)

  // ===========================================================================
  // USER-AGENT & HEADERS
  // ===========================================================================
  var UA_DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';
  var H_JSON = {
    'User-Agent': UA_DESKTOP,
    'Accept': 'application/json, text/plain, */*'
  };
  var H_EXTERNAL = {
    'User-Agent': UA_DESKTOP,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5'
  };

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

  // ===========================================================================
  // SAFE UTILITIES
  // ===========================================================================
  function log(msg) { try { console.log('[' + TAG + '] ' + msg); } catch (e) {} }
  function warn(msg) { try { console.warn('[' + TAG + '] ' + msg); } catch (e) {} }
  function str(s) { return String(s == null ? '' : s); }
  function padNum(n) { return n < 10 ? '0' + n : String(n); }

  function safeJson(t, f) {
    try { return JSON.parse(str(t)); } catch (e) { return f || null; }
  }

  function skyType(t) {
    return (t === 'movie' || t === 'short') ? 'movie' : 'series';
  }

  function withTimeout(promise, ms, label) {
    return new Promise(function (resolve, reject) {
      var done = false;
      var timer = setTimeout(function () {
        if (!done) { done = true; warn('timeout (' + ms + 'ms) ' + label); reject(new Error('timeout')); }
      }, ms);
      promise.then(function (v) {
        if (!done) { done = true; clearTimeout(timer); resolve(v); }
      }).catch(function (e) {
        if (!done) { done = true; clearTimeout(timer); reject(e); }
      });
    });
  }

  // ===========================================================================
  // SDK CLASS COMPATIBILITY SHIMS
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
  // 🔥 FIX #2: ENVIRONMENT POLYFILLS — Set up global, window, self
  // ===========================================================================
  if (typeof global === 'undefined') { globalThis.global = globalThis; }
  if (typeof window === 'undefined') { globalThis.window = globalThis; }
  if (typeof globalThis.self === 'undefined') { globalThis.self = globalThis; }

  // ===========================================================================
  // Safe wrapper for crypto.decryptAES — prevents null-arg crashes from providers
  // ===========================================================================
  if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.decryptAES) {
    var _origDecryptAES = globalThis.crypto.decryptAES;
    globalThis.crypto.decryptAES = async function (dataB64, keyB64, ivB64, options) {
      if (!dataB64 || !keyB64) { return dataB64 || ''; }
      try { return await _origDecryptAES(dataB64, keyB64, ivB64, options); }
      catch (e) { log('crypto.decryptAES safe wrapper caught: ' + (e.message || e)); return dataB64 || ''; }
    };
  }

  // AbortController polyfill for providers that use it
  if (typeof globalThis.AbortController === 'undefined') {
    globalThis.AbortController = function () {
      this.signal = { aborted: false, addEventListener: function () {}, removeEventListener: function () {} };
      this.abort = function () { this.signal.aborted = true; };
    };
  }

  // ===========================================================================
  // 🔥 FIX #3: ROBUST REQUIRE POLYFILL with all Nuvio modules wired up
  // ===========================================================================
  (function installRequirePolyfill() {
    if (typeof globalThis.require !== 'undefined' && globalThis.require.__polyfilled) return;

    var _moduleCache = {};

    // --- Cheerio polyfill ---
    function queryAll(root, selector) {
      try { return root.querySelectorAll(selector); } catch (e) {
        var containsMatch = selector.match(/:contains\(([^)]+)\)/);
        if (containsMatch) {
          var targetText = containsMatch[1].replace(/['"]/g, '').trim();
          var baseSel = selector.replace(/:contains\([^)]+\)/g, '').trim() || '*';
          var all;
          try { all = root.querySelectorAll(baseSel); } catch (e2) { all = []; }
          var results = [];
          for (var i = 0; i < (all.length || 0); i++) {
            if (all[i] && all[i].textContent !== undefined && all[i].textContent.indexOf(targetText) >= 0) {
              results.push(all[i]);
            }
          }
          return results;
        }
        try { return root.querySelectorAll(selector); } catch (e3) { return []; }
      }
    }

    function CheerioCollection(elements) {
      this._els = [];
      if (elements) {
        for (var i = 0; i < (elements.length || 0); i++) {
          if (elements[i] != null) this._els.push(elements[i]);
        }
      }
      this.length = this._els.length;
    }
    CheerioCollection.prototype._single = function () { return this._els[0] || null; };
    CheerioCollection.prototype.find = function (selector) {
      var collected = [];
      for (var i = 0; i < this._els.length; i++) {
        var found = queryAll(this._els[i], selector);
        for (var j = 0; j < (found.length || 0); j++) collected.push(found[j]);
      }
      return new CheerioCollection(collected);
    };
    CheerioCollection.prototype.text = function () {
      if (!this._els.length) return '';
      var parts = [];
      for (var i = 0; i < this._els.length; i++) {
        var t = this._els[i].textContent;
        if (t != null) parts.push(t);
      }
      return parts.join('');
    };
    CheerioCollection.prototype.attr = function (name) {
      var el = this._single();
      if (!el) return undefined;
      var v = el.getAttribute ? el.getAttribute(name) : el[name];
      return v != null ? v : undefined;
    };
    CheerioCollection.prototype.html = function () {
      var el = this._single();
      if (!el) return '';
      return el.innerHTML || el.outerHTML || '';
    };
    CheerioCollection.prototype.each = function (fn) {
      for (var i = 0; i < this._els.length; i++) { fn.call(this._els[i], i, this._els[i]); }
      return this;
    };
    CheerioCollection.prototype.map = function (fn) {
      var results = [];
      for (var i = 0; i < this._els.length; i++) {
        var val = fn.call(this._els[i], i, this._els[i]);
        if (val !== undefined && val !== null) results.push(val);
      }
      return results;
    };
    CheerioCollection.prototype.get = function () {
      var arr = [];
      for (var i = 0; i < this._els.length; i++) arr.push(this._els[i]);
      return arr;
    };
    CheerioCollection.prototype.first = function () { return new CheerioCollection(this._els.length ? [this._els[0]] : []); };
    CheerioCollection.prototype.last = function () { return new CheerioCollection(this._els.length ? [this._els[this._els.length - 1]] : []); };
    CheerioCollection.prototype.eq = function (idx) {
      var i = idx < 0 ? this._els.length + idx : idx;
      return new CheerioCollection(i >= 0 && i < this._els.length ? [this._els[i]] : []);
    };
    CheerioCollection.prototype.parent = function () {
      var collected = [];
      for (var i = 0; i < this._els.length; i++) { if (this._els[i].parentNode) collected.push(this._els[i].parentNode); }
      return new CheerioCollection(collected);
    };
    CheerioCollection.prototype.children = function (selector) {
      var collected = [];
      for (var i = 0; i < this._els.length; i++) {
        var kids = this._els[i].children || [];
        for (var j = 0; j < kids.length; j++) {
          if (!selector || (kids[j].matches && kids[j].matches(selector))) collected.push(kids[j]);
        }
      }
      return new CheerioCollection(collected);
    };
    CheerioCollection.prototype.prev = function () {
      var collected = [];
      for (var i = 0; i < this._els.length; i++) {
        var prev = this._els[i].previousElementSibling;
        if (prev) collected.push(prev);
      }
      return new CheerioCollection(collected);
    };
    CheerioCollection.prototype.next = function () {
      var collected = [];
      for (var i = 0; i < this._els.length; i++) {
        var next = this._els[i].nextElementSibling;
        if (next) collected.push(next);
      }
      return new CheerioCollection(collected);
    };

    function cheerioLoad(doc) {
      function cheerio(selector, context) {
        if (!selector) return new CheerioCollection([]);
        if (typeof selector === 'function') { try { selector(); } catch (e) {} return new CheerioCollection([]); }
        if (typeof selector === 'string') {
          if (selector.trim().charAt(0) === '<') { return new CheerioCollection([]); }
          if (context) {
            var ctx = (context instanceof CheerioCollection) ? context._els : [context];
            var results = [];
            for (var i = 0; i < ctx.length; i++) {
              if (ctx[i]) {
                var found = queryAll(ctx[i], selector);
                for (var j = 0; j < (found.length || 0); j++) results.push(found[j]);
              }
            }
            return new CheerioCollection(results);
          }
          return new CheerioCollection(queryAll(doc, selector));
        }
        if (selector instanceof CheerioCollection) return selector;
        if (selector.nodeType != null) return new CheerioCollection([selector]);
        return new CheerioCollection(selector);
      }
      cheerio.each = function (arr, fn) { for (var i = 0; i < (arr && arr.length || 0); i++) fn(i, arr[i]); return arr; };
      cheerio.map = function (arr, fn) { var results = []; for (var i = 0; i < (arr && arr.length || 0); i++) results.push(fn(arr[i], i)); return results; };
      cheerio.trim = function (s) { return String(s).trim(); };
      return cheerio;
    }

    function simpleQuery(html) {
      return cheerioLoad({
        querySelectorAll: function (sel) {
          if (sel === 'a') {
            var results = [];
            var re = /<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
            var match;
            while ((match = re.exec(html)) !== null) {
              results.push({
                textContent: match[2].replace(/<[^>]*>/g, '').trim(),
                getAttribute: function (n) { return n === 'href' ? match[1] : null; },
                querySelectorAll: function () { return []; },
                matches: function () { return false; }
              });
            }
            return results;
          }
          return [];
        },
        createElement: function () { return { innerHTML: '' }; }
      });
    }

    var cheerioModule = {
      load: function (html) {
        try {
          if (typeof parseHtml === 'function') {
            var doc = parseHtml(html);
            if (doc) return cheerioLoad(doc);
          }
        } catch (e) {}
        return simpleQuery(html);
      }
    };
    _moduleCache['cheerio-without-node-native'] = cheerioModule;
    _moduleCache['cheerio'] = cheerioModule;

    // --- CryptoJS polyfill with real Base64/UTF-8 ---
    var _base64Chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    function base64Encode(str) {
      var output = '';
      var i = 0;
      while (i < str.length) {
        var a = str.charCodeAt(i++);
        var b = i < str.length ? str.charCodeAt(i++) : 0;
        var c = i < str.length ? str.charCodeAt(i++) : 0;
        var bitmap = (a << 16) | (b << 8) | c;
        output += _base64Chars.charAt((bitmap >> 18) & 63);
        output += _base64Chars.charAt((bitmap >> 12) & 63);
        output += i - 2 > str.length ? '=' : _base64Chars.charAt((bitmap >> 6) & 63);
        output += i - 1 > str.length ? '=' : _base64Chars.charAt(bitmap & 63);
      }
      return output;
    }
    function base64Decode(str) {
      var input = String(str).replace(/=+$/, '').replace(/[^A-Za-z0-9+/]/g, '');
      var output = '';
      var i = 0;
      while (i < input.length) {
        var a = _base64Chars.indexOf(input.charAt(i++));
        var b = _base64Chars.indexOf(input.charAt(i++));
        var c = _base64Chars.indexOf(input.charAt(i++));
        var d = _base64Chars.indexOf(input.charAt(i++));
        var bitmap = (a << 18) | (b << 12) | (c << 6) | d;
        output += String.fromCharCode((bitmap >> 16) & 255);
        if (c !== -1 && c !== 64) output += String.fromCharCode((bitmap >> 8) & 255);
        if (d !== -1 && d !== 64) output += String.fromCharCode(bitmap & 255);
      }
      return output;
    }
    function utf8Encode(str) {
      var encoded = '';
      for (var i = 0; i < str.length; i++) {
        var code = str.charCodeAt(i);
        if (code < 0x80) encoded += String.fromCharCode(code);
        else if (code < 0x800) encoded += String.fromCharCode(0xC0 | (code >> 6), 0x80 | (code & 0x3F));
        else if (code < 0xD800 || code >= 0xE000) encoded += String.fromCharCode(0xE0 | (code >> 12), 0x80 | ((code >> 6) & 0x3F), 0x80 | (code & 0x3F));
        else { i++; code = 0x10000 + (((code & 0x3FF) << 10) | (str.charCodeAt(i) & 0x3FF)); encoded += String.fromCharCode(0xF0 | (code >> 18), 0x80 | ((code >> 12) & 0x3F), 0x80 | ((code >> 6) & 0x3F), 0x80 | (code & 0x3F)); }
      }
      return encoded;
    }
    function utf8Decode(str) {
      var decoded = '';
      var i = 0;
      while (i < str.length) {
        var b1 = str.charCodeAt(i++);
        if (b1 < 0x80) decoded += String.fromCharCode(b1);
        else if (b1 < 0xE0) { var b2 = str.charCodeAt(i++); decoded += String.fromCharCode(((b1 & 0x1F) << 6) | (b2 & 0x3F)); }
        else if (b1 < 0xF0) { var b2 = str.charCodeAt(i++); var b3 = str.charCodeAt(i++); decoded += String.fromCharCode(((b1 & 0x0F) << 12) | ((b2 & 0x3F) << 6) | (b3 & 0x3F)); }
        else { var b2 = str.charCodeAt(i++); var b3 = str.charCodeAt(i++); var b4 = str.charCodeAt(i++); decoded += String.fromCharCode(((b1 & 0x07) << 18) | ((b2 & 0x3F) << 12) | ((b3 & 0x3F) << 6) | (b4 & 0x3F)); }
      }
      return decoded;
    }

    var cryptoJSPolyfill = {
      lib: { WordArray: function (words, sigBytes) { this.words = words || []; this.sigBytes = sigBytes || (this.words.length * 4); } },
      enc: {
        Utf8: { parse: utf8Encode, stringify: function (w) { return typeof w === 'string' ? w : utf8Decode(w); } },
        Base64: { parse: base64Decode, stringify: base64Encode },
        Latin1: { parse: function (s) { return s; }, stringify: function (w) { return String(w); } },
        Hex: { parse: function (s) { return s; }, stringify: function (w) { return String(w); } }
      },
      MD5: function (s) { return { toString: function () { return String(s); } }; },
      HmacMD5: function (k, d) {
        var combined = String(k) + String(d);
        return { toString: function (e) { return e === 'base64' ? base64Encode(combined) : combined; } };
      },
      AES: {
        encrypt: function (d, k) {
          return { toString: function () { return base64Encode(String(d)); }, ciphertext: d };
        },
        decrypt: function (d, k) {
          try { if (typeof crypto !== 'undefined' && crypto.decryptAES) return crypto.decryptAES(d, k, null) || d; } catch (e) {}
          return String(d);
        }
      },
      mode: { ECB: {}, CBC: {} },
      pad: { Pkcs7: {}, NoPadding: {} }
    };
    _moduleCache['crypto-js'] = cryptoJSPolyfill;
    _moduleCache['crypto'] = cryptoJSPolyfill;

    // --- Axios polyfill ---
    var axiosPolyfill = {
      get: function (url, config) {
        return new Promise(function (resolve, reject) {
          var headers = (config && config.headers) || H_JSON;
          try {
            var result = http_get(url, headers);
            function handleResponse(r) {
              if (!r) { reject(new Error('No response')); return; }
              var data = typeof r.body === 'string' ? r.body : (r.body ? JSON.stringify(r.body) : '');
              var status = r.status || 200;
              resolve({
                data: data,
                status: status,
                statusText: status >= 200 && status < 300 ? 'OK' : 'Error',
                headers: r.headers || {},
                config: config
              });
            }
            if (result && typeof result.then === 'function') {
              result.then(handleResponse).catch(reject);
            } else if (result && typeof result.status !== 'undefined') {
              handleResponse(result);
            } else {
              http_get(url, headers, function (r) { handleResponse(r || {}); });
            }
          } catch (e) { reject(e); }
        });
      },
      post: function (url, data, config) {
        return new Promise(function (resolve, reject) {
          var headers = (config && config.headers) || H_JSON;
          try {
            http_post(url, headers, data || '', function (r) {
              if (!r) { reject(new Error('No response')); return; }
              var body = typeof r.body === 'string' ? r.body : (r.body ? JSON.stringify(r.body) : '');
              resolve({ data: body, status: r.status || 200, statusText: 'OK', headers: r.headers || {} });
            });
          } catch (e) { reject(e); }
        });
      },
      create: function () { return axiosPolyfill; },
      defaults: { headers: { common: {} } }
    };
    _moduleCache['axios'] = axiosPolyfill;

    // --- Buffer polyfill ---
    var bufferPolyfill = {
      Buffer: {
        from: function (data, encoding) {
          if (encoding === 'base64') return { toString: function (enc) { return enc === 'utf-8' ? utf8Decode(base64Decode(data)) : base64Decode(data); }, length: data.length };
          return { toString: function () { return String(data); }, length: String(data).length };
        },
        isBuffer: function () { return false; },
        byteLength: function (s) { return String(s).length; }
      }
    };
    _moduleCache['buffer'] = bufferPolyfill;

    // --- stream polyfill ---
    _moduleCache['stream'] = { Readable: function () {}, Writable: function () {}, Transform: function () {} };

    // --- path polyfill ---
    _moduleCache['path'] = {
      join: function () { var parts = []; for (var i = 0; i < arguments.length; i++) parts.push(String(arguments[i])); return parts.join('/'); },
      resolve: function () { var parts = []; for (var i = 0; i < arguments.length; i++) parts.push(String(arguments[i])); return parts.join('/'); },
      basename: function (p) { var s = String(p); return s.split('/').pop() || s; },
      extname: function (p) { var s = String(p); var i = s.lastIndexOf('.'); return i >= 0 ? s.substring(i) : ''; }
    };

    // --- os polyfill ---
    _moduleCache['os'] = { platform: function () { return 'android'; }, homedir: function () { return '/'; } };

    // --- querystring polyfill ---
    _moduleCache['querystring'] = {
      stringify: function (obj) {
        var parts = [];
        for (var k in obj) { if (obj.hasOwnProperty(k)) parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(obj[k])); }
        return parts.join('&');
      },
      parse: function (s) {
        var obj = {};
        String(s).split('&').forEach(function (p) {
          var kv = p.split('=');
          if (kv.length >= 2) obj[decodeURIComponent(kv[0])] = decodeURIComponent(kv.slice(1).join('='));
        });
        return obj;
      }
    };

    // --- url polyfill ---
    _moduleCache['url'] = {
      parse: function (urlStr) {
        var u = String(urlStr);
        return { href: u, protocol: u.split(':')[0] + ':', hostname: u.split('/')[2] || '', pathname: u.split('?')[0] };
      },
      format: function (obj) { return obj.href || ''; }
    };

    // --- events polyfill ---
    _moduleCache['events'] = { EventEmitter: function () {} };

    // --- util polyfill ---
    _moduleCache['util'] = {
      inherits: function (ctor, superCtor) { ctor.prototype = Object.create(superCtor.prototype); ctor.prototype.constructor = ctor; },
      promisify: function (fn) { return function () { var args = arguments; return new Promise(function (resolve, reject) { args = Array.prototype.slice.call(args); args.push(function (err, result) { if (err) reject(err); else resolve(result); }); fn.apply(null, args); }); }; }
    };

    var requirePolyfill = function (id) {
      if (_moduleCache[id]) return _moduleCache[id];
      var resolved = resolveModuleName(id);
      if (_moduleCache[resolved]) return _moduleCache[resolved];
      warn('require: module "' + id + '" not found, returning empty object');
      _moduleCache[id] = {};
      return _moduleCache[id];
    };
    requirePolyfill.__polyfilled = true;

    function resolveModuleName(name) {
      var n = String(name).toLowerCase();
      var aliases = {
        'crypto-js': 'crypto-js',
        'cryptojs': 'crypto-js',
        'crypto': 'crypto-js',
        'cheerio': 'cheerio-without-node-native',
        'cheerio-without-node-native': 'cheerio-without-node-native',
        'axios': 'axios',
        'buffer': 'buffer',
        'stream': 'stream',
        'path': 'path',
        'os': 'os',
        'querystring': 'querystring',
        'url': 'url',
        'events': 'events',
        'util': 'util'
      };
      return aliases[n] || name;
    }

    globalThis.require = requirePolyfill;
    log('Require polyfill installed with all Nuvio modules');
  })();

  // ===========================================================================
  // 🔥 FIX #4: URLSearchParams polyfill
  // ===========================================================================
  if (typeof globalThis.URLSearchParams === 'undefined') {
    globalThis.URLSearchParams = function (init) {
      this._d = {};
      if (typeof init === 'string') {
        init.split('&').forEach(function (p) {
          var kv = p.split('=');
          if (kv.length >= 2) this._d[decodeURIComponent(kv[0])] = decodeURIComponent(kv.slice(1).join('='));
        }.bind(this));
      }
      this.get = function (n) { return this._d[n] || null; };
      this.set = function (n, v) { this._d[n] = String(v); };
      this.toString = function () {
        var parts = [];
        for (var k in this._d) { if (this._d.hasOwnProperty(k)) parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(this._d[k])); }
        return parts.join('&');
      };
    };
  }

  // ===========================================================================
  // 🔥 FIX #5: HTTP LAYER — Fixed callback patterns for SkyStream
  // ===========================================================================
  function normalizeResponse(r) {
    if (!r) return { status: 0, body: '' };

    // Handle Node.js-style callback (err, res) — first arg might be null/undefined on success
    if (r instanceof Error) return { status: 0, body: '', error: r };

    var body = '';
    if (typeof r.body === 'string') body = r.body;
    else if (r.body && typeof r.body === 'object') body = JSON.stringify(r.body);
    else if (typeof r === 'string') body = r;  // Some callbacks pass body directly
    else if (r && typeof r.statusCode === 'number') { body = r.data || r.body || ''; r.status = r.statusCode; }

    return {
      status: r.status || (r.statusCode || (body ? 200 : 0)),
      body: body,
      headers: r.headers || {}
    };
  }

  function errorResponse(err) {
    return { status: 0, body: '', error: err };
  }

  function httpGet(url, headers) {
    return new Promise(function (resolve) {
      try {
        var result = http_get(url, headers);

        // Pattern 1: Returns a Promise
        if (result && typeof result.then === 'function') {
          result.then(function (r) {
            // Handle (err, res) Node-style promise resolution
            if (r && r.length === 2 && r[0] === null) resolve(normalizeResponse(r[1]));
            else resolve(normalizeResponse(r));
          }).catch(function (e) { resolve(errorResponse(e)); });
          return;
        }

        // Pattern 2: Synchronous return
        if (result && typeof result.status !== 'undefined') {
          resolve(normalizeResponse(result));
          return;
        }

        // Pattern 3: Callback style — try both (err, res) and (res) patterns
        http_get(url, headers, function (err, res) {
          if (err) {
            // If first arg is truthy, it's an error
            if (err && typeof err === 'object' && err.status !== undefined) {
              // First arg is actually the response, second is undefined
              resolve(normalizeResponse(err));
            } else {
              resolve(errorResponse(err));
            }
          } else if (res) {
            resolve(normalizeResponse(res));
          } else {
            resolve({ status: 200, body: '', headers: {} });
          }
        });
      } catch (e) {
        try {
          http_get(url, headers, function (r) { resolve(normalizeResponse(r || {})); });
        } catch (e2) {
          resolve(errorResponse(e2));
        }
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
      if (r.status === 0 || r.status >= 400) {
        if (r.error) warn('fetchJson error for ' + url + ': ' + (r.error.message || r.error));
        return null;
      }
      try { return JSON.parse(r.body); } catch (e) { return null; }
    });
  }

  // ===========================================================================
  // 🔥 FIX #6: FETCH POLYFILL — Fixed callback
  // ===========================================================================
  (function installFetchPolyfill() {
    if (typeof globalThis.fetch !== 'undefined' && globalThis.fetch.__polyfilled) return;

    globalThis.fetch = function (url, opts) {
      return new Promise(function (resolve) {
        var urlStr = (typeof url === 'object' && url.url) ? url.url : String(url);
        var options = opts || {};
        var method = (options.method || 'GET').toUpperCase();
        var reqHeaders = {};
        for (var k in H_JSON) { if (H_JSON.hasOwnProperty(k)) reqHeaders[k] = H_JSON[k]; }
        var h = options.headers || {};
        if (typeof h.forEach === 'function') {
          h.forEach(function (v, k) { reqHeaders[k] = v; });
        } else {
          for (var k in h) { if (h.hasOwnProperty(k)) reqHeaders[k] = h[k]; }
        }

        function onNativeResponse(err, res) {
          if (err && !res) {
            // If err looks like a response object
            if (err && err.status !== undefined) res = err;
            else { resolve(emptyFetchResponse(urlStr, typeof err === 'string' ? new Error(err) : err)); return; }
          }
          if (!res && !err) { resolve(emptyFetchResponse(urlStr)); return; }
          var resp = res || err;
          var bodyStr = typeof resp.body === 'string' ? resp.body : (resp.body ? JSON.stringify(resp.body) : '');
          var ok = resp.status >= 200 && resp.status < 300;
          resolve({
            ok: ok,
            status: resp.status || (ok ? 200 : 0),
            statusText: ok ? 'OK' : 'Error',
            headers: createFetchHeaders(resp.headers),
            url: urlStr,
            redirected: false,
            json: function () { try { return Promise.resolve(JSON.parse(bodyStr)); } catch (e) { return Promise.reject(e); } },
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
    globalThis.fetch.__polyfilled = true;

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
  // TMDB FUNCTIONS (unchanged working logic)
  // ===========================================================================
  function getDate() {
    var now = new Date();
    var today = now.getFullYear() + '-' + padNum(now.getMonth() + 1) + '-' + padNum(now.getDate());
    var nextWeek = new Date(now); nextWeek.setDate(nextWeek.getDate() + 7);
    var nextWeekStr = nextWeek.getFullYear() + '-' + padNum(nextWeek.getMonth() + 1) + '-' + padNum(nextWeek.getDate());
    return { today: today, nextWeek: nextWeekStr };
  }

  function getNextTmdbKey() {
    var key = TMDB_KEYS[_tmdbKeyIdx % TMDB_KEYS.length];
    _tmdbKeyIdx++;
    return key;
  }

  function tmdbGet(endpoint, params, cacheTTL) {
    var p = [];
    for (var k in params) { if (params.hasOwnProperty(k)) { p.push(encodeURIComponent(k) + '=' + encodeURIComponent(params[k])); } }
    var qs = p.join('&');
    var url = TMDB_BASE + '/' + endpoint + '?api_key=' + getNextTmdbKey() + (qs ? '&' + qs : '');
    return fetchJson(url, H_JSON).then(function (result) {
      // Retry once with a different key if result is null (key might be rate-limited or dead)
      if (!result) {
        var url2 = TMDB_BASE + '/' + endpoint + '?api_key=' + getNextTmdbKey() + (qs ? '&' + qs : '');
        return fetchJson(url2, H_JSON);
      }
      return result;
    });
  }

  function tmdbSearchMulti(query, page) {
    return tmdbGet('search/multi', { query: query, page: page || 1 });
  }

  function tmdbDetails(id, type) {
    return tmdbGet(type + '/' + id, { append_to_response: 'credits,videos,external_ids' });
  }

  function tmdbSeasonEpisodes(tmdbId, seasonNum) {
    return tmdbGet('tv/' + tmdbId + '/season/' + seasonNum, {});
  }

  function tmdbToItem(r, fallbackType) {
    try {
      var title = r.title || r.name || r.original_title || r.original_name || '';
      if (!title) return null;
      var mediaType = r.media_type || fallbackType || 'movie';
      if (mediaType === 'tv') mediaType = 'series';
      var id = r.id;
      var posterPath = r.poster_path ? TMDB_IMG_BASE + '/' + IMG_POSTER + r.poster_path : (r.backdrop_path ? TMDB_IMG_BASE + '/' + IMG_BACKDROP + r.backdrop_path : '');
      var year = (r.release_date || r.first_air_date || '').split('-')[0];
      return new MultimediaItem({
        title: title,
        url: 'tmdb:' + mediaType + ':' + id,
        posterUrl: posterPath,
        type: mediaType,
        year: parseInt(year, 10) || undefined,
        score: r.vote_average || undefined
      });
    } catch (e) { return null; }
  }

  // ===========================================================================
  // DATE HELPERS for dynamic categories
  // ===========================================================================
  function getDateDaysAgo(days) {
    var d = new Date();
    d.setDate(d.getDate() - days);
    return d.getFullYear() + '-' + padNum(d.getMonth() + 1) + '-' + padNum(d.getDate());
  }

  function genericFetcher(endpoint, params, mediaType) {
    return function (p) {
      var mergedParams = {};
      for (var k in params) { if (params.hasOwnProperty(k)) mergedParams[k] = params[k]; }
      mergedParams.page = p;
      return tmdbGet(endpoint, mergedParams).then(function (d) {
        var items = [];
        if (d && d.results) {
          for (var i = 0; i < d.results.length; i++) {
            var item = tmdbToItem(d.results[i], mediaType || 'movie');
            if (item) items.push(item);
          }
        }
        return { items: items };
      });
    };
  }

  // ===========================================================================
  // Multi-page fetch helper — gets up to N items by requesting multiple TMDB pages
  // TMDB returns 20 items per page, so N=50 requires 3 pages fetched in parallel
  // ===========================================================================
  function fetchUpToN(endpoint, params, mediaType, n) {
    var pagesNeeded = Math.ceil(n / 20);
    var promises = [];
    for (var i = 1; i <= pagesNeeded; i++) {
      var p = {};
      for (var k in params) { if (params.hasOwnProperty(k)) p[k] = params[k]; }
      p.page = i;
      promises.push(tmdbGet(endpoint, p));
    }
    return Promise.all(promises).then(function (results) {
      var items = [];
      var seen = {};
      for (var r = 0; r < results.length; r++) {
        if (results[r] && results[r].results) {
          for (var j = 0; j < results[r].results.length; j++) {
            var item = tmdbToItem(results[r].results[j], mediaType);
            if (item && !seen[item.url]) { seen[item.url] = true; items.push(item); }
          }
        }
      }
      return { items: items.slice(0, n) };
    });
  }

  // Helper for combined movie+TV categories (animation: fetch N from each, merge, dedupe, return N)
  function fetchMergedUpToN(movieEndpoint, movieParams, tvEndpoint, tvParams, n) {
    var moviePages = Math.ceil(n / 20);
    var tvPages = Math.ceil(n / 20);
    var promises = [];

    for (var i = 1; i <= moviePages; i++) {
      var mp = {};
      for (var k in movieParams) { if (movieParams.hasOwnProperty(k)) mp[k] = movieParams[k]; }
      mp.page = i;
      promises.push(tmdbGet(movieEndpoint, mp).then(function (d) { return { type: 'movie', data: d }; }));
    }
    for (var i = 1; i <= tvPages; i++) {
      var tp = {};
      for (var k in tvParams) { if (tvParams.hasOwnProperty(k)) tp[k] = tvParams[k]; }
      tp.page = i;
      promises.push(tmdbGet(tvEndpoint, tp).then(function (d) { return { type: 'series', data: d }; }));
    }

    return Promise.all(promises).then(function (results) {
      var items = [];
      var seen = {};
      for (var r = 0; r < results.length; r++) {
        if (results[r].data && results[r].data.results) {
          for (var j = 0; j < results[r].data.results.length; j++) {
            var item = tmdbToItem(results[r].data.results[j], results[r].type);
            if (item && !seen[item.url]) { seen[item.url] = true; items.push(item); }
          }
        }
      }
      items.sort(function (a, b) { return (b.score || 0) - (a.score || 0); });
      return { items: items.slice(0, n) };
    });
  }

  // ===========================================================================
  // HOME CATEGORIES — 9 dynamic categories updated daily via TMDB
  // Each category fetches 50 items (3 TMDB pages) unless marked otherwise
  // ===========================================================================
  // Note: TMDB trending/*/week updates daily, tv/airing_today updates daily,
  // discover/ and top_rated/ update as new data flows in (daily freshness)
  // ===========================================================================
  var HOME_CATEGORIES = [

    // 1. Trending Movies (Hollywood + Bollywood + Tollywood across all OTT platforms)
    { id: 'trending-movies', name: 'Trending Movies', fetcher: function (p) {
      return fetchUpToN('trending/movie/week', {}, 'movie', 50);
    } },

    // 2. Trending Series (Hollywood + Bollywood + Tollywood across all OTT platforms)
    { id: 'trending-series', name: 'Trending Series', fetcher: function (p) {
      return fetchUpToN('trending/tv/week', {}, 'series', 50);
    } },

    // 3. Airing Today (Hollywood + Bollywood + Tollywood across all OTT platforms)
    { id: 'airing-today', name: 'Airing Today', fetcher: function (p) {
      return fetchUpToN('tv/airing_today', {}, 'series', 50);
    } },

    // 4. Trending Asian Drama (Korean + Chinese + Japanese)
    // Uses discover/tv with Drama genre 18 and Asian language filter (pipe | confirmed by TMDB staff)
    // Excludes animation genre 16 to prevent anime leaking into drama results
    { id: 'trending-asian-drama', name: 'Trending Asian Drama', fetcher: function (p) {
      return fetchUpToN('discover/tv', {
        with_genres: '18',
        without_genres: '16',
        with_original_language: 'ko|zh|ja',
        sort_by: 'popularity.desc'
      }, 'series', 50);
    } },

    // 5. Top Rated Movies (Hollywood + Bollywood + Tollywood across all OTT platforms)
    { id: 'top-rated-movies', name: 'Top Rated Movies', fetcher: function (p) {
      return fetchUpToN('movie/top_rated', {}, 'movie', 50);
    } },

    // 6. Top Rated Series (Hollywood + Bollywood + Tollywood across all OTT platforms)
    { id: 'top-rated-series', name: 'Top Rated Series', fetcher: function (p) {
      return fetchUpToN('tv/top_rated', {}, 'series', 50);
    } },

    // 7. Top Rated K-Drama (Korean + Chinese + Japanese)
    // Uses discover/tv with Drama genre 18, Asian languages, sorted by vote average
    // Excludes animation genre 16 to prevent anime leaking into drama results
    { id: 'top-rated-kdrama', name: 'Top Rated K-Drama', fetcher: function (p) {
      return fetchUpToN('discover/tv', {
        with_genres: '18',
        without_genres: '16',
        with_original_language: 'ko|zh|ja',
        sort_by: 'vote_average.desc',
        'vote_count.gte': '50'
      }, 'series', 50);
    } },

    // 8. Trending Anime & Animation (ALL animation: Hollywood + Anime + Chinese donghua)
    // Genre 16 = Animation (covers ALL animation globally — Disney, Pixar, Ghibli, Toei, Tencent, etc.)
    // Merges movies + series into a single sorted list
    { id: 'trending-anime', name: 'Trending Anime & Animation', fetcher: function (p) {
      return fetchMergedUpToN(
        'discover/movie', { with_genres: '16', sort_by: 'popularity.desc' },
        'discover/tv',   { with_genres: '16', sort_by: 'popularity.desc' },
        50
      );
    } },

    // 9. Popular Anime & Animation (ALL animation: Hollywood + Anime + Chinese donghua)
    { id: 'popular-anime', name: 'Popular Anime & Animation', fetcher: function (p) {
      return fetchMergedUpToN(
        'discover/movie', { with_genres: '16', sort_by: 'vote_count.desc', 'vote_count.gte': '100' },
        'discover/tv',   { with_genres: '16', sort_by: 'vote_count.desc', 'vote_count.gte': '100' },
        50
      );
    } },
  ];

  // ===========================================================================
  // getHome — Parallel fetch with fast retry to fit within SkyStream app timeout
  // ===========================================================================
  function getHome(cb, page) {
    var pn = parseInt(page) || 1;
    log('getHome: fetching page ' + pn + ' from TMDB (' + HOME_CATEGORIES.length + ' categories, timeout: ' + (HOME_TIMEOUT/1000) + 's)...');

    var overallTimedOut = false;
    var finalized = false;
    var overallTimer = setTimeout(function () {
      overallTimedOut = true;
      finalized = true;
      warn('getHome: overall timeout (' + (HOME_TIMEOUT/1000) + 's) reached, returning partial results');
      buildAndReturn();
    }, HOME_TIMEOUT);

    var categoryResults = [];
    var retryQueue = [];

    function buildAndReturn() {
      if (finalized) return;
      finalized = true;
      clearTimeout(overallTimer);
      var out = {};
      var nonEmptyCount = 0;
      for (var i = 0; i < categoryResults.length; i++) {
        if (categoryResults[i].items && categoryResults[i].items.length) {
          out[categoryResults[i].name] = categoryResults[i].items;
          nonEmptyCount++;
        }
      }
      log('getHome: returning ' + nonEmptyCount + '/' + HOME_CATEGORIES.length + ' categories with data');
      cb({ success: true, data: out, page: pn });
    }

    // Fetch ALL categories in parallel for fastest completion
    var mainPromises = HOME_CATEGORIES.map(function (cat) {
      return withTimeout(cat.fetcher(pn), CATEGORY_TIMEOUT, 'home:' + cat.id)
        .then(function (result) {
          var items = (result && result.items) || [];
          categoryResults.push({ name: cat.name, items: items });
          if (!items.length) {
            log('getHome: "' + cat.name + '" empty, queued for fast retry');
            retryQueue.push(cat);
          } else {
            log('getHome: "' + cat.name + '" loaded ' + items.length + ' items');
          }
        })
        .catch(function () {
          categoryResults.push({ name: cat.name, items: [] });
          retryQueue.push(cat);
          warn('getHome: "' + cat.name + '" failed, queued for fast retry');
        });
    });

    Promise.all(mainPromises).then(function () {
      if (overallTimedOut || finalized) return;

      // If some categories failed, retry them immediately (still within timeout window)
      if (retryQueue.length > 0) {
        var remaining = HOME_TIMEOUT - (Date.now() - _getHomeStartTime);
        if (remaining > 2000) {
          log('getHome: retrying ' + retryQueue.length + ' failed categories (' + remaining + 'ms remaining)');
          var retryPromises = retryQueue.map(function (cat) {
            return withTimeout(cat.fetcher(pn), Math.min(remaining - 1000, CATEGORY_TIMEOUT), 'home-retry:' + cat.id)
              .then(function (result) {
                var items = (result && result.items) || [];
                if (items.length) {
                  for (var i = 0; i < categoryResults.length; i++) {
                    if (categoryResults[i].name === cat.name) {
                      categoryResults[i].items = items;
                      log('getHome: retry "' + cat.name + '" succeeded with ' + items.length + ' items');
                      break;
                    }
                  }
                }
              })
              .catch(function () {});
          });
          return Promise.all(retryPromises).then(function () { buildAndReturn(); });
        }
      }
      buildAndReturn();
    }).catch(function () {
      buildAndReturn();
    });

    // Track start time for remaining-time calculation
    _getHomeStartTime = Date.now();
  }
  var _getHomeStartTime = 0;

  // ===========================================================================
  // search
  // ===========================================================================
  function search(query, cb) {
    var q = str(query).trim();
    if (!q) return cb({ success: true, data: [] });
    log('search: "' + q + '"');

    function doMultiSearch(retryPage) {
      return tmdbSearchMulti(q, retryPage).then(function (data) {
        var items = [];
        var seen = {};
        if (data && Array.isArray(data.results)) {
          for (var i = 0; i < data.results.length; i++) {
            var r = data.results[i];
            if (r.media_type === 'movie' || r.media_type === 'tv') {
              var item = tmdbToItem(r, r.media_type === 'tv' ? 'series' : 'movie');
              if (item && !seen[item.url]) { seen[item.url] = true; items.push(item); }
            }
          }
        }
        return items;
      }).catch(function () { return []; });
    }

    function doSeparateSearch() {
      return Promise.all([
        tmdbGet('search/movie', { query: q, page: 1 }),
        tmdbGet('search/tv', { query: q, page: 1 })
      ]).then(function (results) {
        var items = [];
        var seen = {};
        for (var ri = 0; ri < results.length; ri++) {
          var data = results[ri];
          if (!data || !Array.isArray(data.results)) continue;
          for (var i = 0; i < data.results.length; i++) {
            var r = data.results[i];
            var type = ri === 1 ? 'series' : 'movie';
            var item = tmdbToItem(r, type);
            if (item && !seen[item.url]) { seen[item.url] = true; items.push(item); }
          }
        }
        return items;
      }).catch(function () { return []; });
    }

    doMultiSearch(1).then(function (multiResults) {
      if (multiResults.length >= 3) {
        cb({ success: true, data: multiResults.slice(0, 50) });
      } else {
        doSeparateSearch().then(function (sepResults) {
          var combined = {};
          var all = [];
          function addItem(item) { if (item && !combined[item.url]) { combined[item.url] = true; all.push(item); } }
          multiResults.forEach(addItem);
          sepResults.forEach(addItem);
          cb({ success: true, data: all.slice(0, 50) });
        }).catch(function () { cb({ success: true, data: multiResults }); });
      }
    }).catch(function () {
      doSeparateSearch().then(function (items) { cb({ success: true, data: items.slice(0, 50) }); }).catch(function () { cb({ success: true, data: [] }); });
    });
  }

  // ===========================================================================
  // 🔥 FIX #7: URL PARSING — parseNuvioUrl & normalizeId
  // ===========================================================================
  // URL formats:
  //   nuvio://movie/{tmdbId}
  //   nuvio://tv/{tmdbId}/{season}/{episode}
  //   tmdb:movie:{id}
  //   tmdb:series:{id}
  //   {raw number}

  function parseNuvioUrl(url) {
    try {
      var s = str(url).trim();

      // nuvio://tv/12345/1/2
      var nuvioTvMatch = s.match(/^nuvio:\/\/tv\/(\d+)(?:\/(\d+)(?:\/(\d+))?)?$/i);
      if (nuvioTvMatch) {
        return {
          tmdbId: nuvioTvMatch[1],
          mediaType: 'tv',
          season: nuvioTvMatch[2] ? parseInt(nuvioTvMatch[2], 10) : null,
          episode: nuvioTvMatch[3] ? parseInt(nuvioTvMatch[3], 10) : null
        };
      }

      // nuvio://movie/12345
      var nuvioMovieMatch = s.match(/^nuvio:\/\/movie\/(\d+)/i);
      if (nuvioMovieMatch) {
        return {
          tmdbId: nuvioMovieMatch[1],
          mediaType: 'movie',
          season: null,
          episode: null
        };
      }

      // tmdb:movie:123 or tmdb:series:123
      var tmdbMatch = s.match(/^tmdb:(movie|series|tv):(\d+)$/i);
      if (tmdbMatch) {
        return {
          tmdbId: tmdbMatch[2],
          mediaType: (tmdbMatch[1].toLowerCase() === 'series' || tmdbMatch[1].toLowerCase() === 'tv') ? 'tv' : 'movie',
          season: null,
          episode: null
        };
      }

      // Raw number
      var numMatch = s.match(/^(\d+)$/);
      if (numMatch) {
        return { tmdbId: numMatch[1], mediaType: 'movie', season: null, episode: null };
      }

      // Try to extract any number from the URL
      var anyNumMatch = s.match(/(\d+)/);
      if (anyNumMatch) {
        return { tmdbId: anyNumMatch[1], mediaType: 'movie', season: null, episode: null };
      }

      return null;
    } catch (e) {
      warn('parseNuvioUrl error: ' + (e.message || e));
      return null;
    }
  }

  function normalizeId(rawInput) {
    return new Promise(function (resolve) {
      try {
        var parsed = parseNuvioUrl(rawInput);
        if (parsed) {
          resolve(parsed);
        } else {
          // Last resort: try TMDB search
          var numMatch = String(rawInput).match(/(\d+)/);
          resolve({ tmdbId: numMatch ? numMatch[1] : rawInput, mediaType: 'movie', season: null, episode: null });
        }
      } catch (e) {
        resolve({ tmdbId: String(rawInput), mediaType: 'movie', season: null, episode: null });
      }
    });
  }

  // ===========================================================================
  // load
  // ===========================================================================
  function load(url, cb) {
    try {
      var rawInput = str(url).trim();
      if (!rawInput) return cb({ success: false, errorCode: 'PARSE_ERROR', message: 'No ID' });

      var loadTimedOut = false;

      function safeCb(resp) {
        if (loadTimedOut) return;
        loadTimedOut = true;
        clearTimeout(loadTimer);
        cb(resp);
      }

      var loadTimer = setTimeout(function () {
        if (!loadTimedOut) {
          loadTimedOut = true;
          var fallbackType = knownType === 'tv' || knownType === 'series' ? 'series' : 'movie';
          var fallbackUrl = fallbackType === 'series' ? 'nuvio://tv/' + tmdbId + '/1/1' : 'nuvio://movie/' + tmdbId;
          warn('load timed out (' + (LOAD_TIMEOUT/1000) + 's) for: ' + url);
          safeCb({
            success: true,
            data: new MultimediaItem({
              title: 'Content', url: rawInput, type: fallbackType,
              episodes: [new Episode({ name: fallbackType === 'series' ? 'Season 1' : 'Play', url: fallbackUrl, season: 1, episode: 1 })]
            })
          });
        }
      }, LOAD_TIMEOUT);

      normalizeId(rawInput).then(function (resolved) {
        var tmdbId = resolved.tmdbId;
        var knownType = resolved.mediaType;

        if (!tmdbId) return safeCb({ success: false, errorCode: 'PARSE_ERROR', message: 'No ID' });
        log('load: fetching metadata for ' + knownType + ' ' + tmdbId);

        var apiType = (knownType === 'series' || knownType === 'tv') ? 'tv' : 'movie';
        tmdbDetails(tmdbId, apiType).then(function (data) {
          if (!data) {
            return respondMeta({ name: 'Content', id: tmdbId }, tmdbId, safeCb, knownType);
          }

          var episodes = [];
          var isSeries = (knownType === 'series' || knownType === 'tv' || apiType === 'tv' || (data.number_of_seasons && data.number_of_seasons > 0));

          if (isSeries && Array.isArray(data.seasons) && data.seasons.length) {
            log('load: series has ' + data.seasons.length + ' seasons, fetching episode data');
            var seasonPromises = [];
            var seasonIdx = 0;
            for (var si = 0; si < data.seasons.length; si++) {
              var s = data.seasons[si];
              if (!s || s.season_number === 0 || s.season_number === undefined) continue;
              var sn = s.season_number;
              log('load: queuing season ' + sn + ' fetch');
              // Stagger season fetches by 300ms each to avoid TMDB rate limiting
              var delay = seasonIdx * 300;
              seasonIdx++;
              // Use IIFE to capture sn in a closure (avoid var hoisting bug)
              (function(seasonNum, dly) {
                seasonPromises.push(
                  new Promise(function (resolve) {
                    setTimeout(function () {
                      resolve(withTimeout(tmdbSeasonEpisodes(tmdbId, seasonNum), 15000, 'season ' + seasonNum)
                        .then(function (seasonData) {
                          var seasonEps = [];
                          if (!seasonData || !Array.isArray(seasonData.episodes)) {
                            log('load: season ' + seasonNum + ' returned no episodes data');
                            return seasonEps;
                          }
                          log('load: season ' + seasonNum + ' has ' + seasonData.episodes.length + ' episodes');
                          for (var ei = 0; ei < seasonData.episodes.length; ei++) {
                            var ep = seasonData.episodes[ei];
                            if (!ep || !ep.episode_number) continue;
                            try {
                              seasonEps.push(new Episode({
                                name: ep.name || 'Episode ' + ep.episode_number,
                                url: 'nuvio://tv/' + tmdbId + '/' + seasonData.season_number + '/' + ep.episode_number,
                                season: seasonData.season_number,
                                episode: ep.episode_number,
                                posterUrl: ep.still_path ? TMDB_IMG_BASE + '/' + IMG_STILL + ep.still_path : '',
                                description: (ep.overview || '').substring(0, 300),
                                airDate: ep.air_date || ''
                              }));
                            } catch (e) {}
                          }
                          return seasonEps;
                        }).catch(function () { log('load: season ' + seasonNum + ' fetch failed/timed out'); return []; })
                      );
                    }, dly);
                  })
                );
              })(sn, delay);
            }

            Promise.all(seasonPromises).then(function (seasonResults) {
              for (var si = 0; si < seasonResults.length; si++) {
                var seasonEps = seasonResults[si];
                for (var ei = 0; ei < seasonEps.length; ei++) episodes.push(seasonEps[ei]);
              }
              episodes.sort(function (a, b) { if (a.season !== b.season) return a.season - b.season; return a.episode - b.episode; });
              respondMeta(data, tmdbId, safeCb, knownType, episodes);
            }).catch(function () {
              respondMeta(data, tmdbId, safeCb, knownType, episodes);
            });
          } else {
            episodes.push(new Episode({
              name: 'Full Movie',
              url: 'nuvio://movie/' + tmdbId,
              season: 1, episode: 1,
              posterUrl: data.poster_path ? TMDB_IMG_BASE + '/' + IMG_POSTER + data.poster_path : ''
            }));
            respondMeta(data, tmdbId, safeCb, knownType, episodes);
          }
        }).catch(function (e) {
          warn('load TMDB error: ' + (e.message || e));
          respondMeta({ name: 'Unknown', id: rawInput }, rawInput.replace(/[^0-9]/g, ''), safeCb, 'movie', [
            new Episode({ name: 'Play', url: 'nuvio://movie/' + rawInput.replace(/[^0-9]/g, ''), season: 1, episode: 1 })
          ]);
        });
      }).catch(function (e) {
        warn('load resolve error: ' + (e.message || e));
        safeCb({ success: false, errorCode: 'LOAD_ERROR', message: e.message || 'Error' });
      });
    } catch (e) {
      warn('load error: ' + (e.message || e));
      cb({ success: false, errorCode: 'LOAD_ERROR', message: e.message || 'Error' });
    }
  }

  function respondMeta(data, metaId, cb, knownType, episodes) {
    try {
      var apiType = (knownType === 'series' || knownType === 'tv') ? 'tv' : 'movie';
      if (data.media_type === 'tv' || data.media_type === 'series') apiType = 'tv';
      if (data.type === 'series') apiType = 'tv';
      var isSeries = (apiType !== 'movie');
      var st = isSeries ? 'series' : 'movie';
      var title = data.title || data.name || data.original_title || data.original_name || 'Unknown';
      var posterPath = data.poster_path ? TMDB_IMG_BASE + '/' + IMG_POSTER + data.poster_path : (data.poster || data.posterUrl || '');
      if (!posterPath && data.backdrop_path) posterPath = TMDB_IMG_BASE + '/' + IMG_BACKDROP + data.backdrop_path;
      var backdropPath = data.backdrop_path ? TMDB_IMG_BASE + '/' + IMG_BACKDROP + data.backdrop_path : (data.backdrop || data.background || data.banner || '');
      if (!backdropPath && posterPath) backdropPath = posterPath.replace('/' + IMG_POSTER, '/' + IMG_BACKDROP);
      var releaseDate = data.release_date || data.first_air_date || '';
      var year = releaseDate ? parseInt(releaseDate.split('-')[0], 10) : undefined;
      if (year && (year < 1900 || year > 2100)) year = undefined;
      var rating = data.vote_average ? parseFloat(data.vote_average) : undefined;
      var desc = (data.overview || data.description || '').replace(/<[^>]*>/g, '').trim().substring(0, 500);

      var cast = undefined;
      var credits = data.credits;
      if (credits && Array.isArray(credits.cast) && credits.cast.length) {
        cast = [];
        for (var ci = 0; ci < Math.min(credits.cast.length, 30); ci++) {
          try {
            var c = credits.cast[ci];
            if (!c) continue;
            cast.push(new Actor({ name: c.name || c.character || 'Unknown', role: c.character || '', image: c.profile_path ? TMDB_IMG_BASE + '/' + IMG_PROFILE + c.profile_path : '' }));
          } catch (e) {}
        }
        if (!cast.length) cast = undefined;
      }

      var trailers = undefined;
      var videos = data.videos;
      if (videos && Array.isArray(videos.results) && videos.results.length) {
        trailers = [];
        for (var tvi = 0; tvi < videos.results.length; tvi++) {
          try {
            var v = videos.results[tvi];
            if (!v || v.site !== 'YouTube' || !v.key) continue;
            if (v.type !== 'Trailer' && v.type !== 'Teaser') continue;
            trailers.push(new Trailer({ url: 'https://www.youtube.com/watch?v=' + v.key, name: v.name || v.type || 'Trailer' }));
          } catch (e) {}
        }
        if (!trailers.length) trailers = undefined;
      }

      var genres = undefined;
      if (Array.isArray(data.genres) && data.genres.length) {
        genres = data.genres.map(function (g) { return g.name || String(g.id); });
      }

      var status = undefined;
      if (data.status) {
        var sv = str(data.status).toLowerCase();
        if (sv === 'ended' || sv === 'canceled') status = 'completed';
        else if (sv === 'returning series' || sv === 'continuing' || sv === 'in production') status = 'ongoing';
      }

      var director = undefined;
      if (credits && Array.isArray(credits.crew) && credits.crew.length) {
        var directors = [];
        for (var di = 0; di < credits.crew.length; di++) {
          if (credits.crew[di].job === 'Director') directors.push(credits.crew[di].name || credits.crew[di].original_name);
        }
        if (directors.length) director = directors.join(', ');
      }

      var runtime = data.runtime ? str(data.runtime) : undefined;
      if (!runtime && data.episode_run_time && data.episode_run_time.length) runtime = str(data.episode_run_time[0]);

      if (!episodes || !episodes.length) {
        episodes = [];
        episodes.push(new Episode({
          name: isSeries ? 'Season 1' : 'Full Movie',
          url: isSeries ? 'nuvio://tv/' + metaId + '/1/1' : 'nuvio://movie/' + metaId,
          season: 1, episode: 1, posterUrl: posterPath
        }));
      }

      cb({
        success: true,
        data: new MultimediaItem({
          title: title,
          url: 'tmdb:' + st + ':' + metaId,
          posterUrl: posterPath,
          bannerUrl: backdropPath,
          description: desc,
          type: st,
          year: year,
          score: rating,
          genres: genres,
          cast: cast,
          trailers: trailers,
          status: status,
          director: director,
          runtime: runtime,
          episodes: episodes
        })
      });
    } catch (e) {
      warn('respondMeta error: ' + (e.message || e));
      cb({
        success: true,
        data: new MultimediaItem({
          title: data.title || data.name || 'Unknown',
          url: 'tmdb:movie:' + metaId,
          type: 'movie',
          episodes: [new Episode({ name: 'Play', url: 'nuvio://movie/' + metaId, season: 1, episode: 1 })]
        })
      });
    }
  }

  // ===========================================================================
  // 🔥 FIX #8: NUVIO PROVIDER ENGINE — Complete rewrite with proper isolation
  // ===========================================================================

  function deriveSourceFromUrl(url) {
    var match = url.match(/github(?:usercontent)?\.com\/([^/]+)\/([^/]+)/);
    if (!match) return null;
    var username = match[1];
    return { id: username.toLowerCase(), name: username.charAt(0).toUpperCase() + username.slice(1), url: url };
  }

  var NUVIO_SOURCES = (typeof manifest !== 'undefined' && manifest.nuvioManifests)
    ? manifest.nuvioManifests.map(deriveSourceFromUrl).filter(function (s) { return s !== null; })
    : [];

  var _providerCodeCache = {};
  var _providerManifests = null;

  function fetchAllManifests() {
    if (_providerManifests) return Promise.resolve(_providerManifests);

    var manifestUrls = NUVIO_SOURCES.map(function (s) { return s.url; });

    if (!manifestUrls.length) {
      try {
        if (manifest && Array.isArray(manifest.nuvioManifests)) {
          manifestUrls = manifest.nuvioManifests;
        }
      } catch (e) {}
    }

    if (!manifestUrls.length) return Promise.resolve([]);

    log('fetchAllManifests: fetching ' + manifestUrls.length + ' manifest URLs');

    // Fetch all manifests in parallel with individual timeouts
    var fetchPromises = manifestUrls.map(function (url) {
      return httpGetTimed(url, H_JSON, MANIFEST_TIMEOUT).then(function (res) {
        if (res.status === 200 && res.body) {
          try {
            var data = JSON.parse(res.body);
            return { url: url, ok: true, data: data };
          } catch (e) {
            warn('fetchAllManifests: JSON parse error for ' + url);
            return { url: url, ok: false, data: null };
          }
        }
        warn('fetchAllManifests: HTTP ' + res.status + ' for ' + url);
        return { url: url, ok: false, data: null };
      }).catch(function () {
        return { url: url, ok: false, data: null };
      });
    });

    return Promise.all(fetchPromises).then(function (results) {
      var allProviders = [];
      var seenUrls = {};

      for (var i = 0; i < results.length; i++) {
        var res = results[i];
        if (!res.ok || !res.data) continue;

        var manifestData = res.data;
        var scrapers = manifestData.scrapers || manifestData.providers || [];
        var manifestUrl = res.url;

        // 🔥 FIX: Correctly compute base URL from manifest URL
        // Input: https://raw.githubusercontent.com/org/repo/refs/heads/main/manifest.json
        // Output: https://raw.githubusercontent.com/org/repo/refs/heads/main
        var baseUrl = manifestUrl;
        if (baseUrl.indexOf('/manifest.json') >= 0) {
          baseUrl = baseUrl.substring(0, baseUrl.indexOf('/manifest.json'));
        } else if (baseUrl.indexOf('manifest.json') >= 0) {
          baseUrl = baseUrl.replace(/manifest\.json.*$/, '');
        }

        for (var si = 0; si < scrapers.length; si++) {
          var p = scrapers[si];
          if (!p || !p.filename || !p.id) continue;

          // Construct provider URL
          var providerUrl = baseUrl.replace(/\/?$/, '') + '/' + p.filename;

          // Deduplicate
          if (seenUrls[providerUrl]) continue;
          seenUrls[providerUrl] = true;

          allProviders.push({
            id: p.id,
            name: p.name || p.id,
            url: providerUrl,
            supportedTypes: p.supportedTypes || ['movie', 'tv'],
            enabled: p.enabled !== false,
            limited: p.limited === true,
            languages: p.contentLanguage || ['en'],
            formats: p.formats || [],
            logo: p.logo || '',
            sourceName: manifestData.name || 'Unknown'
          });
        }
      }

      _providerManifests = allProviders;
      log('fetchAllManifests: loaded ' + allProviders.length + ' unique providers from ' + manifestUrls.length + ' manifests');
      return allProviders;
    }).catch(function (e) {
      warn('fetchAllManifests error: ' + (e.message || e));
      return [];
    });
  }

  function getProviderCode(url) {
    if (_providerCodeCache[url]) return Promise.resolve(_providerCodeCache[url]);

    return httpGetTimed(url, H_EXTERNAL, FETCH_CODE_TIMEOUT).then(function (res) {
      if (res.status === 200 && res.body) {
        _providerCodeCache[url] = res.body;
        return res.body;
      }
      warn('getProviderCode: HTTP ' + res.status + ' for ' + url);
      return null;
    }).catch(function (e) {
      warn('getProviderCode error for ' + url + ': ' + (e.message || e));
      return null;
    });
  }

  // ===========================================================================
  // 🔥 FIX #9: ISOLATED PROVIDER EXECUTION — Each provider runs in its own scope
  // ===========================================================================
  function extractStreamsFromProvider(code, mediaType, tmdbId, season, episode, providerTimeout) {
    var timeout = providerTimeout || PROVIDER_TIMEOUT;

    return new Promise(function (resolve) {
      var timedOut = false;
      var timer = setTimeout(function () {
        timedOut = true;
        resolve([]);
      }, timeout);

      function done(streams) {
        if (timedOut) return;
        clearTimeout(timer);
        resolve(Array.isArray(streams) ? streams : []);
      }

      try {
        // Save current global state to restore after
        var savedModule, savedExports, savedGetStreams;
        try { savedModule = globalThis.module; } catch (e) {}
        try { savedExports = globalThis.exports; } catch (e) {}
        try { savedGetStreams = globalThis.getStreams; } catch (e) {}

        // Set up module.exports scope
        var mod = { exports: {} };
        globalThis.module = mod;
        globalThis.exports = mod.exports;

        var providerGetStreams = null;

        // Strategy 1: module.exports pattern with proper scope isolation
        if (code.indexOf('module.exports') >= 0 || code.indexOf('exports.') >= 0 || code.indexOf('exports ') >= 0) {
          try {
            // Create a new Function with module, exports, require as parameters
            var wrapperCode = [
              'var module = arguments[0];',
              'var exports = arguments[1];',
              'var require = arguments[2];',
              code,
              ';return module && module.exports ? module.exports : (typeof exports !== "undefined" ? exports : null);'
            ].join('\n');
            var exportsResult = new Function(wrapperCode)(mod, mod.exports, globalThis.require);

            if (exportsResult) {
              if (typeof exportsResult.getStreams === 'function') {
                providerGetStreams = exportsResult.getStreams;
              } else if (typeof exportsResult === 'function') {
                providerGetStreams = exportsResult;
              }
            }

            // Also check module.exports in case the code assigned directly
            if (!providerGetStreams && mod.exports && typeof mod.exports.getStreams === 'function') {
              providerGetStreams = mod.exports.getStreams;
            }
          } catch (e) {
            log('extractStreams: strategy 1 failed: ' + (e.message || e));
          }
        }

        // Strategy 2: Global function definition (function getStreams or async function getStreams)
        if (!providerGetStreams && (code.indexOf('function getStreams') >= 0 || code.indexOf('function* getStreams') >= 0)) {
          try {
            // Clear any previous getStreams
            globalThis.getStreams = undefined;
            (new Function(code))();
            if (typeof globalThis.getStreams === 'function') {
              providerGetStreams = globalThis.getStreams;
            }
          } catch (e) {
            log('extractStreams: strategy 2 failed: ' + (e.message || e));
          }
        }

        // Strategy 3: globalThis.getStreams assignment
        if (!providerGetStreams && code.indexOf('globalThis.getStreams') >= 0) {
          try {
            globalThis.getStreams = undefined;
            (new Function(code))();
            if (typeof globalThis.getStreams === 'function') {
              providerGetStreams = globalThis.getStreams;
            }
          } catch (e) {
            log('extractStreams: strategy 3 failed: ' + (e.message || e));
          }
        }

        // Strategy 4: Export default pattern (ES module transpiled)
        if (!providerGetStreams && code.indexOf('export') >= 0) {
          // Some transpiled providers use exports.default or export default
          if (mod.exports && mod.exports.default && typeof mod.exports.default === 'function') {
            providerGetStreams = mod.exports.default;
          } else if (mod.exports && mod.exports.default && mod.exports.default.getStreams) {
            providerGetStreams = mod.exports.default.getStreams;
          }
        }

        // Strategy 5: Try to find ANY exported function that looks like getStreams
        if (!providerGetStreams) {
          // Check if the entire module.exports is a function
          if (mod.exports && typeof mod.exports === 'function') {
            providerGetStreams = mod.exports;
          }
        }

        // Clean up global state
        try {
          if (savedModule !== undefined) globalThis.module = savedModule; else delete globalThis.module;
          if (savedExports !== undefined) globalThis.exports = savedExports; else delete globalThis.exports;
          if (savedGetStreams !== undefined) globalThis.getStreams = savedGetStreams; else delete globalThis.getStreams;
        } catch (e) {}

        if (typeof providerGetStreams === 'function') {
          try {
            var result = providerGetStreams(tmdbId, mediaType, season || null, episode || null);

            if (result && typeof result.then === 'function') {
              // Async provider
              var promiseTimedOut = false;
              var promiseTimer = setTimeout(function () {
                promiseTimedOut = true;
                done([]);
              }, timeout);

              result.then(function (streams) {
                if (!promiseTimedOut) { clearTimeout(promiseTimer); done(streams); }
              }).catch(function (err) {
                if (!promiseTimedOut) { clearTimeout(promiseTimer); log('extractStreams: provider rejected: ' + (err && err.message || err)); done([]); }
              });
            } else if (result && Array.isArray(result)) {
              done(result);
            } else {
              done([]);
            }
          } catch (callErr) {
            log('extractStreams: provider call failed: ' + (callErr.message || callErr));
            done([]);
          }
        } else {
          log('extractStreams: could not find getStreams function in provider code');
          // Clean up leaked globals again
          try { if (savedModule !== undefined) globalThis.module = savedModule; else delete globalThis.module; } catch (e) {}
          try { if (savedExports !== undefined) globalThis.exports = savedExports; else delete globalThis.exports; } catch (e) {}
          done([]);
        }
      } catch (e) {
        log('extractStreams: unexpected error: ' + (e.message || e));
        done([]);
      }
    });
  }

  // ===========================================================================
  // 🔥 FIX #10: MAGIC PROXY SUPPORT
  // ===========================================================================
  function wrapWithMagicProxy(streamUrl, headers) {
    if (!streamUrl) return streamUrl;

    // If the URL needs special headers, use Magic Proxy
    if (headers && typeof headers === 'object' && Object.keys(headers).length > 0) {
      var needsProxy = false;
      for (var k in headers) {
        if (headers.hasOwnProperty(k) && k.toLowerCase() !== 'user-agent') {
          needsProxy = true;
          break;
        }
      }
      if (needsProxy) {
        try {
          var btoaFn = typeof btoa === 'function' ? btoa : function (s) {
            var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
            var output = '';
            for (var i = 0; i < s.length; i += 3) {
              var a = s.charCodeAt(i);
              var b = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
              var c = i + 2 < s.length ? s.charCodeAt(i + 2) : 0;
              output += chars.charAt(a >> 2);
              output += chars.charAt(((a & 3) << 4) | (b >> 4));
              output += i + 1 < s.length ? chars.charAt(((b & 15) << 2) | (c >> 6)) : '=';
              output += i + 2 < s.length ? chars.charAt(c & 63) : '=';
            }
            return output;
          };
          return 'MAGIC_PROXY_v1' + btoaFn(streamUrl);
        } catch (e) {
          log('Magic Proxy encoding failed: ' + (e.message || e));
        }
      }
    }

    // If stream has no .m3u8 extension but is likely HLS, still use magic proxy
    if (streamUrl.indexOf('.m3u8') >= 0 || streamUrl.indexOf('.mp4') >= 0) {
      return streamUrl;
    }

    return streamUrl;
  }

  // ===========================================================================
  // STREAM RESULT CACHE — Prevents re-fetching streams on navigate back
  // ===========================================================================
  var _streamsCache = {};
  var _streamsCacheTimers = {};

  function getStreamCacheKey(url) {
    try {
      var parsed = parseNuvioUrl(url);
      if (!parsed) return url;
      return parsed.tmdbId + ':' + parsed.mediaType + ':' + (parsed.season || '0') + ':' + (parsed.episode || '0');
    } catch (e) {
      return url;
    }
  }

  function getCachedStreams(url) {
    var key = getStreamCacheKey(url);
    if (_streamsCache[key]) {
      log('loadStreams: CACHE HIT for ' + key + ' (' + _streamsCache[key].length + ' streams)');
      return _streamsCache[key];
    }
    return null;
  }

  function setCachedStreams(url, streams) {
    var key = getStreamCacheKey(url);
    // Clear any existing TTL timer for this key
    if (_streamsCacheTimers[key]) {
      clearTimeout(_streamsCacheTimers[key]);
    }
    _streamsCache[key] = streams;
    // Auto-expire cache after TTL
    _streamsCacheTimers[key] = setTimeout(function () {
      delete _streamsCache[key];
      delete _streamsCacheTimers[key];
    }, STREAM_CACHE_TTL);
    log('loadStreams: cached ' + streams.length + ' streams for ' + key + ' (TTL: ' + (STREAM_CACHE_TTL/1000) + 's)');
  }

  // ===========================================================================
  // 🔥 FIX #11: LOAD STREAMS — Complete rewrite with caching to prevent re-fetch
  // ===========================================================================
  function loadStreams(url, cb) {
    log('loadStreams: fetching ALL streams for: ' + url);

    // Check cache first — if we already fetched these streams, return immediately
    var cached = getCachedStreams(url);
    if (cached) {
      log('loadStreams: returning ' + cached.length + ' cached streams immediately');
      return cb({ success: true, data: cached });
    }

    // Parse the URL
    var parsed = parseNuvioUrl(url);
    if (!parsed) {
      warn('loadStreams: could not parse URL: ' + url);
      return cb({ success: false, errorCode: 'PARSE_ERROR', message: 'Could not parse URL: ' + url });
    }

    var tmdbId = parsed.tmdbId;
    var mediaType = parsed.mediaType;
    var season = parsed.season;
    var episodeNum = parsed.episode;

    if (!tmdbId) {
      warn('loadStreams: no TMDB ID found');
      return cb({ success: false, errorCode: 'PARSE_ERROR', message: 'No TMDB ID in URL' });
    }

    var streamTimedOut = false;
    var allStreams = [];
    var providersTried = 0;
    var providersCompleted = 0;

    function safeCb() {
      if (streamTimedOut) return;
      streamTimedOut = true;
      clearTimeout(streamTimer);

      // Deduplicate streams by URL
      var seen = {};
      var uniqueStreams = [];
      for (var i = 0; i < allStreams.length; i++) {
        var s = allStreams[i];
        var key = s.url || s.streamUrl || '';
        if (key && !seen[key]) {
          seen[key] = true;
          uniqueStreams.push(s);
        }
      }

      // Cache the results so navigating back doesn't re-fetch
      if (uniqueStreams.length > 0) {
        setCachedStreams(url, uniqueStreams);
      }

      log('loadStreams: returning ' + uniqueStreams.length + ' unique streams from ' + providersTried + ' providers (' + providersCompleted + ' completed)');
      cb({ success: true, data: uniqueStreams });
    }

    // Global timeout
    var streamTimer = setTimeout(function () {
      if (!streamTimedOut) {
        warn('loadStreams: ' + (STREAM_TIMEOUT / 1000) + 's timeout reached, returning ' + allStreams.length + ' streams');
        safeCb();
      }
    }, STREAM_TIMEOUT);

    // Fetch manifests
    withTimeout(fetchAllManifests(), 30000, 'fetchAllManifests').then(function (providers) {
      if (!providers || providers.length === 0) {
        warn('loadStreams: no providers found');
        return safeCb();
      }

      // Filter by supported type
      var matchingProviders = providers.filter(function (p) {
        if (!p.enabled) return false;
        if (!p.supportedTypes || !p.supportedTypes.length) return true;
        for (var i = 0; i < p.supportedTypes.length; i++) {
          if (p.supportedTypes[i] === mediaType || p.supportedTypes[i] === 'all') return true;
        }
        return false;
      });

      providersTried = matchingProviders.length;
      log('loadStreams: ' + matchingProviders.length + ' providers for ' + mediaType + ' (of ' + providers.length + ' total)');

      if (matchingProviders.length === 0) {
        warn('loadStreams: no matching providers for type: ' + mediaType);
        return safeCb();
      }

      // Fire ALL providers in parallel with stagger
      var promises = [];
      for (var pi = 0; pi < matchingProviders.length; pi++) {
        var provider = matchingProviders[pi];
        promises.push(new Promise(function (resolveProvider) {
          var pIdx = pi;
          var currentProvider = matchingProviders[pIdx];

          setTimeout(function () {
            getProviderCode(currentProvider.url).then(function (code) {
              if (!code) {
                providersCompleted++;
                return resolveProvider();
              }

              return extractStreamsFromProvider(code, mediaType, tmdbId, season, episodeNum, PROVIDER_TIMEOUT)
                .then(function (streams) {
                  if (streams && streams.length > 0) {
                    for (var si = 0; si < streams.length; si++) {
                      var stream = streams[si];
                      if (!stream) continue;

                      var streamUrl = stream.url || stream.streamUrl || stream.link || '';
                      if (!streamUrl) continue;

                      var streamName = stream.name || stream.source || stream.label || currentProvider.name;
                      var streamQuality = stream.quality || stream.qualityLabel || '';
                      var streamHeaders = stream.headers || {};
                      var sourceName = streamName + (streamQuality ? ' [' + streamQuality + ']' : '');

                      try {
                        // Use Magic Proxy for streams with special headers
                        var finalUrl = wrapWithMagicProxy(streamUrl, streamHeaders);
                        var sr = new StreamResult({
                          url: finalUrl,
                          source: sourceName,
                          headers: streamHeaders
                        });
                        if (sr && sr.url) {
                          allStreams.push(sr);
                        }
                      } catch (e) {
                        log('loadStreams: error creating StreamResult: ' + (e.message || e));
                      }
                    }
                    log('loadStreams: ' + currentProvider.name + ' returned ' + streams.length + ' streams');
                  }
                  providersCompleted++;
                  resolveProvider();
                }).catch(function (e) {
                  log('loadStreams: ' + currentProvider.name + ' error: ' + (e && e.message || e));
                  providersCompleted++;
                  resolveProvider();
                });
            }).catch(function (e) {
              log('loadStreams: fetch error for ' + currentProvider.name + ': ' + (e && e.message || e));
              providersCompleted++;
              resolveProvider();
            });
          }, pIdx * STAGGER_MS);
        }));
      }

      Promise.all(promises).then(function () {
        log('loadStreams: all ' + providersCompleted + '/' + providersTried + ' providers finished');
        if (!streamTimedOut) safeCb();
      }).catch(function () {
        if (!streamTimedOut) safeCb();
      });
    }).catch(function (e) {
      warn('loadStreams: manifest fetch failed: ' + (e.message || e));
      safeCb();
    });
  }

  // ===========================================================================
  // 🔥 EXPORT GLOBALS
  // ===========================================================================
  globalThis.getHome = getHome;
  globalThis.search = search;
  globalThis.load = load;
  globalThis.loadStreams = loadStreams;

  log('NuvioBridge V7 loaded with ' + HOME_CATEGORIES.length + ' categories (India+Anime added), ' + TMDB_KEYS.length + ' TMDB keys, ' + NUVIO_SOURCES.length + ' manifest sources, stream caching enabled');

})();
