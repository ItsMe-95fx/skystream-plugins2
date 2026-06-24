(function () {
	"use strict";

	// ============================================================================
	// NuvioBridge — SkyStream plugin that bridges Nuvio streaming providers
	// Version: 4.0.0
	// ============================================================================

	var TAG = "NuvioBridge";
	var VERSION = "4.0.0";

	// ---- Config reader ---------------------------------------------------------
	// Reads from manifest.config (plugin.json) if present, otherwise uses the
	// hardcoded default (second argument). Since plugin.json no longer has a
	// `config` block, the defaults below ARE the active values.
	// Dot notation: cfg("timeouts.total", 30000) → manifest.config.timeouts?.total ?? 30000

	var CFG =
		(typeof manifest !== "undefined" && manifest && manifest.config) || {};
	function cfg(path, def) {
		var parts = String(path).split(".");
		var cur = CFG;
		for (var i = 0; i < parts.length; i++) {
			if (cur == null || typeof cur !== "object") return def;
			cur = cur[parts[i]];
		}
		return cur !== undefined ? cur : def;
	}

	// ---- TMDB config (kept in code — shared infra keys, not user-configurable) -

	var TMDB_KEYS = [
		"68e094699525b18a70bab2f86b1fa706",
		"af3a53eb387d57fc935e9128468b1899",
		"0142a22c560ce3efb1cfd6f3b2faab77",
	];
	var TMDB_BASE = "https://api.themoviedb.org/3";
	var TMDB_IMG = "https://image.tmdb.org/t/p";
	var IMG_POSTER = "w500";
	var IMG_BACK = "w780";
	var IMG_STILL = "w300";
	var IMG_PROF = "w185";
	var _tmdbKeyIdx = 0;

	// ---- Timeouts (ms) ---------------------------------------------------------

	// Timeout for fetching a Nuvio provider manifest (ms) — 10s
	var T_MANIFEST = cfg("timeouts.manifest", 10000);

	// Timeout for fetching a single provider's JS code file (ms) — 10s
	var T_CODE = cfg("timeouts.providerCode", 10000);

	// Max time a single provider gets to produce streams (ms) — 15s.
	// Tuned: 10s killed Peachify (lost 21 streams), 20s let slow providers hog slots.
	// 15s is the sweet spot: fast providers finish, slow ones get cut cleanly.
	var T_PROVIDER = cfg("timeouts.provider", 15000);

	// **GLOBAL HARD TIMEOUT** — total time from loadStreams() call to cb() delivery (ms).
	// Tuned across many experiments: concurrency 16 + 30s total = best results.
	// Sweet spot: 30 000ms — yields 12-23 providers / 90-108 streams.
	// NOTE: Must be <= SkyStream plugin timeout (usually 35s).
	var T_TOTAL = cfg("timeouts.total", 30000);

	// Timeout for a single TMDB API call (ms) — 6s
	var T_TMDB = cfg("timeouts.tmdb", 6000);

	// Total time budget for getHome() including all categories (ms) — 12s
	var T_HOME_TOTAL = cfg("timeouts.homeTotal", 12000);

	// Time budget per home category (ms) — 6s
	var T_HOME_CAT = cfg("timeouts.homeCategory", 6000);

	// Max time for a search() call (ms) — 7s
	var T_SEARCH = cfg("timeouts.search", 7000);

	// Max time for a load() detail fetch (ms) — 15s
	var T_DETAIL = cfg("timeouts.detail", 15000);

	// Timeout per season fetch in load() (ms) — 5s
	var T_SEASON = cfg("timeouts.season", 5000);

	// ---- Concurrency & retries -------------------------------------------------

	// How many providers run in parallel during loadStreams().
	// Tuned: 8→16 improved from 11→14 providers. 24/32/48 WORSE (network congestion).
	// Sweet spot: 16 — saturates the network without overloading it.
	var PROVIDER_CONCURRENCY = cfg("concurrency.providers", 16);

	// How many times to retry a provider that fails on Hermes eval/parse.
	// First eval of raw GitHub code often fails due to async/await in Hermes.
	// Retry (2 attempts) is critical — most providers work on second attempt.
	var PROVIDER_RETRIES = cfg("retries.provider", 2);

	// ---- Cache TTLs (ms) -------------------------------------------------------

	// All cache TTLs default to 30min for manifests/streams, 60min for code.
	// Manifest rarely changes — safe to cache 30min.
	// Code can change on repo push — 60min balances freshness vs repeat fetches.
	// Streams are title-specific, 30min is fine (cached per session).
	var CACHE_TTL = {
		manifest: cfg("cache.manifestTTL", 1800000), // 30 min
		code: cfg("cache.codeTTL", 3600000), // 60 min
		streams: cfg("cache.streamTTL", 1800000), // 30 min
	};

	// How long a provider stays in the "failed" cooldown list (ms).
	// 10 min prevents re-trying providers that are down mid-session.
	var _failedProviderTTL = cfg("cache.failedProviderTTL", 600000);

	// ---- HTTP helpers ----------------------------------------------------------

	var UA =
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36";
	var HDR_JSON = {
		"User-Agent": UA,
		Accept: "application/json,text/plain,*/*",
	};
	var HDR_HTML = {
		"User-Agent": UA,
		Accept: "text/html,application/xhtml+xml,*/*;q=0.8",
		"Accept-Language": "en-US,en;q=0.5",
	};

	var _failedProviders = {};

	// ---- Auto-prune state (persistent across sessions via getPreference) --------

	// Number of consecutive failures before a provider is auto-skipped.
	// 5 prevents flukes from banning a provider — needs consistent failures.
	var PRUNE_THRESHOLD = cfg("limits.providerPruneThreshold", 5);
	var _prunedProviders = null;

	function _loadPruned() {
		if (_prunedProviders) return;
		try {
			if (typeof globalThis.getPreference === "function") {
				var raw = globalThis.getPreference("nb_pruned");
				if (raw) _prunedProviders = JSON.parse(raw);
			}
		} catch (e) {}
		if (!_prunedProviders) _prunedProviders = {};
	}

	function _savePruned() {
		try {
			if (typeof globalThis.setPreference === "function")
				globalThis.setPreference("nb_pruned", JSON.stringify(_prunedProviders));
		} catch (e) {}
	}

	function _isPruned(url) {
		_loadPruned();
		return _prunedProviders[url] && _prunedProviders[url] >= PRUNE_THRESHOLD;
	}

	function _recordPruneResult(url, hadError, hadStreams) {
		if (hadStreams) return; // returned streams = healthy, skip tracking
		if (!hadError) return; // returned 0 streams but no error = movie unavailable, not a provider failure
		_loadPruned();
		_prunedProviders[url] = (_prunedProviders[url] || 0) + 1;
		_savePruned();
	}

	function _clearPruned(url) {
		_loadPruned();
		if (_prunedProviders[url]) {
			delete _prunedProviders[url];
			_savePruned();
		}
	}

	// ---- Provider health scoring ------------------------------------------------
	// Ranks providers by success rate, latency, and stream yield.
	// Sorted by score (best first) before execution in runProvidersBatched.
	// Weights: success 50%, latency 30%, stream yield 20%.
	// Decay rate 0.9 smooths out single-run outliers.

	var HEALTH_CFG = {
		enabled: cfg("healthScoring.enabled", true),
		successWeight: cfg("healthScoring.successWeight", 0.5),
		latencyWeight: cfg("healthScoring.latencyWeight", 0.3),
		yieldWeight: cfg("healthScoring.yieldWeight", 0.2),
		decayRate: cfg("healthScoring.decayRate", 0.9),
	};
	var _providerHealth = {};

	// ---- Adaptive concurrency --------------------------------------------------
	// Adjusts concurrency every 30s based on observed provider latency.
	// Target: keep avg latency under 5000ms.
	// Increase by 2 when fast, decrease by 1 when slow.
	// Bounded by CONCUR_MIN (8) and CONCUR_MAX (24).

	var ADAPT_CFG = {
		enabled: cfg("adaptiveConcurrency.enabled", true),
		targetMs: cfg("adaptiveConcurrency.targetLatencyMs", 5000),
		adjustMs: cfg("adaptiveConcurrency.adjustIntervalMs", 30000),
		incStep: cfg("adaptiveConcurrency.increaseStep", 2),
		decStep: cfg("adaptiveConcurrency.decreaseStep", 1),
	};

	// Starting concurrency for loadStreams().
	// Tuned across experiments: 16 is the sweet spot.
	// 8→16 improved from 11→14 providers; 24/32/48 worse (network congestion).
	var CONCUR_INITIAL = cfg("concurrency.initial", 16);

	// Floor — never go below 8 concurrent providers
	var CONCUR_MIN = cfg("concurrency.min", 8);
	// Ceiling — never go above 24 concurrent providers
	var CONCUR_MAX = cfg("concurrency.max", 24);
	var _currentConcurrency = CONCUR_INITIAL;
	var _concurrencyLastAdj = Date.now();

	// ---- Cache warming ---------------------------------------------------------
	// When search() runs, it queues top-N results for background pre-fetch.
	// This warms the stream cache so load() feels instant on those titles.
	// Default: enabled, max 3 items to keep overhead low.

	var WARM_CFG = {
		enabled: cfg("cacheWarming.enabled", true),
		maxItems: cfg("cacheWarming.maxItems", 3),
	};

	// ---- Size limits -----------------------------------------------------------

	// Max size of a single provider JS code file. 3 MB (3 145 728 bytes).
	// Raised from 1MB to 3MB to include VixSrc (1055KB).
	// No provider comes close to 3MB — largest measured is VixSrc at 1055KB.
	var LIMIT_PROVIDER_CODE = cfg("limits.providerCodeSize", 3145728);

	// Max length of a stream URL before we discard it (defense against garbage)
	var LIMIT_STREAM_URL = cfg("limits.maxStreamUrlLength", 4096);

	// Max search results returned by search()
	var LIMIT_SEARCH = cfg("limits.maxSearchResults", 60);

	// ---- Logging ---------------------------------------------------------------

	function log() {
		try {
			console.log.apply(
				console,
				["[" + TAG + "]", "[" + VERSION + "]"].concat([].slice.call(arguments)),
			);
		} catch (e) {}
	}
	function warn() {
		try {
			console.warn.apply(
				console,
				["[" + TAG + "]", "[" + VERSION + "]"].concat([].slice.call(arguments)),
			);
		} catch (e) {}
	}

	// ---- btoa / atob polyfill --------------------------------------------------

	if (typeof btoa === "undefined") {
		(function () {
			var A =
				"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
			globalThis.btoa = function (s) {
				s = String(s);
				var out = "",
					i = 0;
				while (i < s.length) {
					var a = s.charCodeAt(i++),
						b = i < s.length ? s.charCodeAt(i++) : 0,
						c = i < s.length ? s.charCodeAt(i++) : 0;
					var t = (a << 16) | (b << 8) | c;
					out +=
						A.charAt((t >> 18) & 63) +
						A.charAt((t >> 12) & 63) +
						(i - 2 > s.length ? "=" : A.charAt((t >> 6) & 63)) +
						(i - 1 > s.length ? "=" : A.charAt(t & 63));
				}
				return out;
			};
			globalThis.atob = function (s) {
				s = String(s).replace(/[^A-Za-z0-9+/]/g, "");
				var out = "",
					i = 0;
				while (i < s.length) {
					var a = A.indexOf(s.charAt(i++)),
						b = A.indexOf(s.charAt(i++));
					var c = A.indexOf(s.charAt(i++)),
						d = A.indexOf(s.charAt(i++));
					var t = (a << 18) | (b << 12) | ((c & 63) << 6) | d;
					out += String.fromCharCode((t >> 16) & 255);
					if (c !== -1 && c !== 64) out += String.fromCharCode((t >> 8) & 255);
					if (d !== -1 && d !== 64) out += String.fromCharCode(t & 255);
				}
				return out;
			};
		})();
	}

	// ---- Global aliases -------------------------------------------------------

	try {
		if (typeof globalThis.global === "undefined")
			globalThis.global = globalThis;
	} catch (e) {}
	try {
		if (typeof globalThis.window === "undefined")
			globalThis.window = globalThis;
	} catch (e) {}
	try {
		if (typeof globalThis.self === "undefined") globalThis.self = globalThis;
	} catch (e) {}

	// ---- URLSearchParams shim --------------------------------------------------

	if (typeof URLSearchParams === "undefined") {
		globalThis.URLSearchParams = function (init) {
			this._d = {};
			if (typeof init === "string") {
				init.split("&").forEach(function (p) {
					if (!p) return;
					var i = p.indexOf("="),
						k,
						v;
					if (i < 0) {
						k = p;
						v = "";
					} else {
						k = p.slice(0, i);
						v = p.slice(i + 1);
					}
					this._d[decodeURIComponent(k.replace(/\+/g, " "))] =
						decodeURIComponent(v.replace(/\+/g, " "));
				}, this);
			}
			this.get = function (k) {
				return Object.prototype.hasOwnProperty.call(this._d, k)
					? this._d[k]
					: null;
			};
			this.set = function (k, v) {
				this._d[k] = String(v);
			};
			this.toString = function () {
				var p = [];
				for (var k in this._d)
					if (Object.prototype.hasOwnProperty.call(this._d, k))
						p.push(
							encodeURIComponent(k) + "=" + encodeURIComponent(this._d[k]),
						);
				return p.join("&");
			};
		};
	}

	if (typeof AbortController === "undefined") {
		globalThis.AbortController = function () {
			this.signal = {
				aborted: false,
				addEventListener: function () {},
				removeEventListener: function () {},
			};
			this.abort = function () {
				this.signal.aborted = true;
			};
		};
	}

	if (typeof console === "undefined") {
		globalThis.console = {
			log: function () {},
			warn: function () {},
			error: function () {},
			info: function () {},
			debug: function () {},
		};
	}

	// ---- fetch polyfill --------------------------------------------------------

	(function installFetch() {
		if (typeof globalThis.fetch === "function" && globalThis.fetch.__nb) return;
		function resp(url, status, body, headers) {
			var ok = status >= 200 && status < 300;
			return {
				ok: ok,
				status: status,
				statusText: ok ? "OK" : "ERR",
				url: url,
				headers: {
					get: function (n) {
						if (!headers) return null;
						for (var k in headers)
							if (
								Object.prototype.hasOwnProperty.call(headers, k) &&
								k.toLowerCase() === String(n).toLowerCase()
							)
								return headers[k];
						return null;
					},
					forEach: function (cb) {
						if (headers) for (var k in headers) cb(headers[k], k);
					},
				},
				text: function () {
					return Promise.resolve(String(body || ""));
				},
				json: function () {
					try {
						return Promise.resolve(JSON.parse(String(body || "")));
					} catch (e) {
						return Promise.reject(new Error("JSON: " + e.message));
					}
				},
				arrayBuffer: function () {
					return Promise.resolve(new Uint8Array(0));
				},
			};
		}
		globalThis.fetch = function (url, opts) {
			opts = opts || {};
			var method = (opts.method || "GET").toUpperCase();
			var headers = {};
			for (var k in HDR_JSON)
				if (Object.prototype.hasOwnProperty.call(HDR_JSON, k))
					headers[k] = HDR_JSON[k];
			var h = opts.headers;
			if (h) {
				if (typeof h.forEach === "function")
					h.forEach(function (v, k) {
						headers[k] = v;
					});
				else
					for (var k2 in h)
						if (Object.prototype.hasOwnProperty.call(h, k2))
							headers[k2] = h[k2];
			}
			return new Promise(function (resolve) {
				function done(r) {
					if (!r) return resolve(resp(url, 0, "", {}));
					var body = "";
					if (typeof r.body === "string") body = r.body;
					else if (r.body && typeof r.body === "object") {
						try {
							body = JSON.stringify(r.body);
						} catch (e) {
							body = String(r.body);
						}
					}
					resolve(resp(url, r.status || 0, body, r.headers || {}));
				}
				try {
					if (method === "POST" || method === "PUT" || method === "PATCH") {
						http_post(
							url,
							headers,
							typeof opts.body === "string"
								? opts.body
								: opts.body
									? JSON.stringify(opts.body)
									: "",
							done,
						);
					} else {
						http_get(url, headers, done);
					}
				} catch (e) {
					resolve(resp(url, 0, "", {}));
				}
			});
		};
		globalThis.fetch.__nb = true;
	})();

	// ---- require polyfill ------------------------------------------------------

	(function installRequire() {
		if (typeof globalThis.require === "function" && globalThis.require.__nb)
			return;
		var cache = {};

		// ---- HTML Parser (standalone, no parse_html dependency) ----
		function HtmlNode(tag, attrs, parent) {
			this.tag = tag;
			this.attrs = attrs || {};
			this.parent = parent || null;
			this.children = [];
			this.text = "";
		}
		HtmlNode.prototype.getAttribute = function (n) {
			return this.attrs[n] !== undefined ? this.attrs[n] : null;
		};
		HtmlNode.prototype.querySelectorAll = function (sel) {
			return select(this, sel);
		};
		HtmlNode.prototype.querySelector = function (sel) {
			return select(this, sel)[0] || null;
		};
		HtmlNode.prototype.matches = function (sel) {
			return matchesSel(this, sel);
		};
		HtmlNode.prototype.textContent = function () {
			if (!this.tag) return this.text || "";
			var t = "";
			for (var i = 0; i < this.children.length; i++)
				t += this.children[i].textContent();
			return t;
		};

		function parseHtmlToDom(html) {
			var root = new HtmlNode("root", {}, null);
			var current = root;
			var re =
				/<\/?([a-zA-Z0-9-]+)((?:\s+[a-zA-Z0-9-]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*\/?>|[^<]+/g;
			var voidTags = {
				area: 1,
				base: 1,
				br: 1,
				col: 1,
				embed: 1,
				hr: 1,
				img: 1,
				input: 1,
				link: 1,
				meta: 1,
				param: 1,
				source: 1,
				track: 1,
				wbr: 1,
			};
			var m;
			while ((m = re.exec(html)) !== null) {
				var token = m[0];
				if (token.charAt(0) !== "<") {
					var t = token.trim();
					if (t) {
						var tn = new HtmlNode(null, {}, current);
						tn.text = t;
						current.children.push(tn);
					}
					continue;
				}
				if (token.charAt(1) === "/") {
					if (current.parent) current = current.parent;
					continue;
				}
				var tagName = m[1].toLowerCase();
				var attrsStr = m[2] || "";
				var selfClosing = !!voidTags[tagName] || token.slice(-2) === "/>";
				var attrs = {};
				var attrRe =
					/([a-zA-Z0-9_-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+)))?/g;
				var am;
				while ((am = attrRe.exec(attrsStr)) !== null) {
					attrs[am[1].toLowerCase()] =
						am[2] !== undefined
							? am[2]
							: am[3] !== undefined
								? am[3]
								: am[4] !== undefined
									? am[4]
									: "";
				}
				var node = new HtmlNode(tagName, attrs, current);
				current.children.push(node);
				if (tagName === "script" || tagName === "style") {
					var et = "</" + tagName + ">";
					var ei = html.indexOf(et, re.lastIndex);
					if (ei !== -1) {
						var content = html.substring(re.lastIndex, ei);
						if (content) {
							var tn2 = new HtmlNode(null, {}, node);
							tn2.text = content;
							node.children.push(tn2);
						}
						re.lastIndex = ei + et.length;
					}
					continue;
				}
				if (!selfClosing) current = node;
			}
			return root;
		}

		function matchesSel(node, sel) {
			if (!node || !node.tag) return false;
			sel = String(sel || "").trim();
			if (!sel) return false;
			var tagMatch = sel.match(/^([a-zA-Z0-9_-]*)/)[1];
			if (tagMatch && node.tag !== tagMatch.toLowerCase()) return false;
			var idMatch = sel.match(/#([a-zA-Z0-9_-]+)/);
			if (idMatch && node.attrs.id !== idMatch[1]) return false;
			var classMatch = sel.match(/\.([a-zA-Z0-9_-]+)/g);
			if (classMatch) {
				var cls = (node.attrs.class || "").split(/\s+/);
				for (var i = 0; i < classMatch.length; i++) {
					var c = classMatch[i].substring(1),
						found = false;
					for (var j = 0; j < cls.length; j++) {
						if (cls[j] === c) {
							found = true;
							break;
						}
					}
					if (!found) return false;
				}
			}
			var attrSel = sel.match(/\[([a-zA-Z0-9_-]+)(?:=(["']?)([^\]]*?)\2)?\]/);
			if (attrSel) {
				var av = node.attrs[attrSel[1].toLowerCase()];
				if (av === undefined) return false;
				if (attrSel[3] !== undefined && av !== attrSel[3]) return false;
			}
			return true;
		}

		function select(node, sel) {
			var results = [];
			if (!sel || !sel.trim()) return results;
			sel = String(sel).trim();
			var parts = sel.split(/\s+/).filter(Boolean);
			if (parts.length > 1) {
				var currentSet = [node];
				for (var pi = 0; pi < parts.length; pi++) {
					var nextSet = [];
					for (var ci = 0; ci < currentSet.length; ci++)
						collectDescendants(currentSet[ci], parts[pi], nextSet);
					currentSet = nextSet;
				}
				return currentSet;
			}
			collectDescendants(node, sel, results);
			return results;
		}

		function collectDescendants(node, sel, results) {
			for (var i = 0; i < node.children.length; i++) {
				var child = node.children[i];
				if (child.tag && matchesSel(child, sel)) results.push(child);
				collectDescendants(child, sel, results);
			}
		}

		// ---- cheerio ----
		function $qsa(root, sel) {
			if (
				root &&
				root.querySelectorAll &&
				typeof root.querySelectorAll === "function"
			)
				return Array.prototype.slice.call(root.querySelectorAll(sel));
			return [];
		}
		function C(els) {
			this._els = els || [];
			this.length = this._els.length;
		}
		C.prototype._one = function () {
			return this._els[0] || null;
		};
		C.prototype.find = function (s) {
			var o = [];
			for (var i = 0; i < this._els.length; i++) {
				var f = $qsa(this._els[i], s);
				for (var j = 0; j < f.length; j++) o.push(f[j]);
			}
			return new C(o);
		};
		C.prototype.text = function () {
			if (!this._els.length) return "";
			var p = [];
			for (var i = 0; i < this._els.length; i++)
				p.push(this._els[i].textContent());
			return p.join("");
		};
		C.prototype.attr = function (n) {
			var e = this._one();
			return e ? e.getAttribute(n) : undefined;
		};
		C.prototype.html = function () {
			var e = this._one();
			return e ? e.innerHTML || "" : "";
		};
		C.prototype.each = function (fn) {
			for (var i = 0; i < this._els.length; i++)
				fn.call(this._els[i], i, this._els[i]);
			return this;
		};
		C.prototype.first = function () {
			return new C(this._els.length ? [this._els[0]] : []);
		};
		C.prototype.eq = function (i) {
			var k = i < 0 ? this._els.length + i : i;
			return new C(k >= 0 && k < this._els.length ? [this._els[k]] : []);
		};
		C.prototype.parent = function () {
			var o = [];
			for (var i = 0; i < this._els.length; i++)
				if (this._els[i].parent) o.push(this._els[i].parent);
			return new C(o);
		};
		C.prototype.toArray = function () {
			return this._els.slice();
		};
		C.prototype.get = function (i) {
			return this._els[i];
		};
		C.prototype.map = function (fn) {
			var r = [];
			for (var i = 0; i < this._els.length; i++) {
				var v = fn.call(this._els[i], i, this._els[i]);
				if (v != null) r.push(v);
			}
			return r;
		};

		function makeDoc(html) {
			try {
				if (typeof parse_html === "function") {
					var d = parse_html(html);
					if (d && typeof d.querySelectorAll === "function") return d;
				}
			} catch (e) {}
			return parseHtmlToDom(html);
		}
		function buildCheerio(doc) {
			function $(sel, ctx) {
				if (!sel) return new C([]);
				if (typeof sel === "function") {
					try {
						sel();
					} catch (e) {}
					return new C([]);
				}
				if (sel instanceof C) return sel;
				if (sel && sel.tag) return new C([sel]);
				if (typeof sel !== "string") return new C([]);
				if (sel.trim().charAt(0) === "<") return new C([]);
				if (ctx) {
					var c = ctx instanceof C ? ctx._els : [ctx];
					var out = [];
					for (var i = 0; i < c.length; i++) {
						if (c[i]) {
							var f = $qsa(c[i], sel);
							for (var j = 0; j < f.length; j++) out.push(f[j]);
						}
					}
					return new C(out);
				}
				return new C($qsa(doc, sel));
			}
			return $;
		}
		var cheerioModule = {
			load: function (html) {
				return buildCheerio(makeDoc(html));
			},
		};
		cache["cheerio-without-node-native"] = cheerioModule;
		cache["cheerio"] = cheerioModule;
		globalThis.cheerio = cheerioModule;
		globalThis["cheerio-without-node-native"] = cheerioModule;

		// ---- crypto-js ----
		var cryptoJs = {
			lib: {
				WordArray: function (w, n) {
					this.words = w || [];
					this.sigBytes = n || this.words.length * 4;
				},
			},
			enc: {
				Utf8: {
					parse: function (s) {
						return s;
					},
					stringify: function (w) {
						return String(w);
					},
				},
				Base64: {
					parse: function (s) {
						try {
							return atob(String(s).replace(/[^A-Za-z0-9+/=]/g, ""));
						} catch (e) {
							return s;
						}
					},
					stringify: function (w) {
						try {
							return btoa(String(w));
						} catch (e) {
							return "";
						}
					},
				},
				Hex: {
					parse: function (s) {
						return s;
					},
					stringify: function (w) {
						return String(w);
					},
				},
			},
			MD5: function (msg) {
				return {
					toString: function () {
						return "";
					},
				};
			},
			SHA1: function (msg) {
				return {
					toString: function () {
						return "";
					},
				};
			},
			SHA256: function (msg) {
				return {
					toString: function () {
						return "";
					},
				};
			},
			HmacSHA1: function () {
				return {
					toString: function () {
						return "";
					},
				};
			},
			HmacSHA256: function () {
				return {
					toString: function () {
						return "";
					},
				};
			},
			AES: {
				encrypt: function (d, k) {
					var s = String(d);
					if (typeof crypto !== "undefined" && crypto && crypto.encryptAES) {
						try {
							return {
								toString: function () {
									return crypto.encryptAES(s, String(k));
								},
							};
						} catch (e) {}
					}
					return {
						toString: function () {
							try {
								return btoa(s);
							} catch (e) {
								return s;
							}
						},
					};
				},
				decrypt: function (d, k) {
					var s = String(d);
					if (typeof crypto !== "undefined" && crypto && crypto.decryptAES) {
						try {
							return {
								toString: function () {
									return crypto.decryptAES(s, String(k));
								},
							};
						} catch (e) {}
					}
					return {
						toString: function () {
							try {
								return atob(s);
							} catch (e) {
								return s;
							}
						},
					};
				},
			},
			mode: { ECB: {}, CBC: {} },
			pad: { Pkcs7: {}, NoPadding: {} },
		};
		cache["crypto-js"] = cryptoJs;
		globalThis.CryptoJS = cryptoJs;

		// ---- No-op shims ----
		cache["axios"] = {
			get: function () {
				return Promise.reject(new Error("axios shim"));
			},
			post: function () {
				return Promise.reject(new Error("axios shim"));
			},
			create: function () {
				return cache["axios"];
			},
		};
		cache["node-fetch"] = globalThis.fetch;
		cache["buffer"] = {
			Buffer: {
				from: function (d) {
					return {
						toString: function () {
							return String(d);
						},
						length: String(d).length,
					};
				},
				isBuffer: function () {
					return false;
				},
				byteLength: function (s) {
					return String(s).length;
				},
			},
		};
		cache["stream"] = {
			Readable: function () {},
			Writable: function () {},
			Transform: function () {},
		};
		cache["path"] = {
			join: function () {
				return Array.prototype.slice
					.call(arguments)
					.join("/")
					.replace(/\/+/g, "/");
			},
			resolve: function () {
				return Array.prototype.slice.call(arguments).join("/");
			},
			basename: function (p) {
				var s = String(p || "");
				return s.split("/").pop() || s;
			},
			extname: function (p) {
				var s = String(p || "");
				var i = s.lastIndexOf(".");
				return i >= 0 ? s.substring(i) : "";
			},
		};
		cache["os"] = {
			platform: function () {
				return "android";
			},
			homedir: function () {
				return "/";
			},
		};
		cache["querystring"] = {
			stringify: function (o) {
				var p = [];
				for (var k in o)
					if (Object.prototype.hasOwnProperty.call(o, k))
						p.push(encodeURIComponent(k) + "=" + encodeURIComponent(o[k]));
				return p.join("&");
			},
			parse: function (s) {
				var o = {};
				String(s || "")
					.split("&")
					.forEach(function (p) {
						var i = p.indexOf("=");
						o[decodeURIComponent(i < 0 ? p : p.slice(0, i))] =
							decodeURIComponent(i < 0 ? "" : p.slice(i + 1));
					});
				return o;
			},
		};
		cache["url"] = {
			parse: function (u) {
				var s = String(u || "");
				try {
					var x = new URL(s);
					return {
						href: s,
						protocol: x.protocol,
						hostname: x.hostname,
						pathname: x.pathname,
					};
				} catch (e) {
					return { href: s };
				}
			},
			format: function (o) {
				return (o && o.href) || "";
			},
		};
		cache["events"] = {
			EventEmitter: function () {
				this.on = function () {};
				this.emit = function () {};
			},
		};
		cache["util"] = {
			inherits: function (c, s) {
				c.prototype = Object.create(s.prototype);
				c.prototype.constructor = c;
			},
			promisify: function (fn) {
				return function () {
					var a = [].slice.call(arguments);
					return new Promise(function (res, rej) {
						a.push(function (e, v) {
							e ? rej(e) : res(v);
						});
						fn.apply(null, a);
					});
				};
			},
		};
		cache["zlib"] = {
			inflateSync: function () {
				return {
					toString: function () {
						return "";
					},
				};
			},
			deflateSync: function () {
				return {
					toString: function () {
						return "";
					},
				};
			},
		};
		cache["https"] = {
			request: function () {
				return {
					on: function () {
						return this;
					},
					end: function () {},
				};
			},
		};
		cache["http"] = cache["https"];
		cache["process"] = {
			env: {},
			platform: "android",
			version: "",
			versions: {},
			nextTick: function (fn) {
				return Promise.resolve().then(fn);
			},
			browser: true,
			cwd: function () {
				return "/";
			},
		};

		function req(name) {
			if (cache[name]) return cache[name];
			warn("require: unknown module '" + name + "' (returning empty shim)");
			return {};
		}
		req.__nb = true;
		globalThis.require = req;
	})();

	// ---- HTTP layer (Promise-wrapped) -----------------------------------------

	function normalizeHttp(r) {
		if (!r) return { status: 0, body: "", headers: {} };
		if (r instanceof Error)
			return { status: 0, body: "", headers: {}, error: r };
		var body = "";
		if (typeof r.body === "string") body = r.body;
		else if (r.body && typeof r.body === "object") {
			try {
				body = JSON.stringify(r.body);
			} catch (e) {
				body = String(r.body);
			}
		} else if (typeof r === "string") body = r;
		return {
			status: r.status || r.statusCode || (body ? 200 : 0),
			body: body,
			headers: r.headers || {},
		};
	}

	function httpGet(url, headers, ms) {
		ms = ms || 8000;
		return new Promise(function (resolve) {
			var done = false;
			var t = setTimeout(function () {
				if (!done) {
					done = true;
					resolve({
						status: 0,
						body: "",
						headers: {},
						error: new Error("timeout"),
					});
				}
			}, ms);
			function finish(r) {
				if (!done) {
					done = true;
					clearTimeout(t);
					resolve(normalizeHttp(r));
				}
			}
			function tryCb() {
				try {
					http_get(url, headers, function (r) {
						finish(r);
					});
				} catch (e) {
					finish({ status: 0, body: "", headers: {}, error: e });
				}
			}
			try {
				tryCb();
			} catch (e) {
				finish({ status: 0, body: "", headers: {}, error: e });
			}
		});
	}

	// ---- TMDB -----------------------------------------------------------------

	function nextTmdbKey() {
		var k = TMDB_KEYS[_tmdbKeyIdx % TMDB_KEYS.length];
		_tmdbKeyIdx++;
		return k;
	}

	function tmdbGet(endpoint, params, ms) {
		var qs = [];
		if (params)
			for (var k in params)
				if (
					Object.prototype.hasOwnProperty.call(params, k) &&
					params[k] != null
				)
					qs.push(encodeURIComponent(k) + "=" + encodeURIComponent(params[k]));
		var url =
			TMDB_BASE +
			"/" +
			endpoint +
			"?api_key=" +
			nextTmdbKey() +
			(qs.length ? "&" + qs.join("&") : "");
		function tryKey(remaining) {
			return httpGet(url, HDR_JSON, ms || T_TMDB).then(function (r) {
				if (r.status >= 200 && r.status < 300) {
					try {
						return JSON.parse(r.body);
					} catch (e) {
						return null;
					}
				}
				if (
					(r.status === 401 || r.status === 429 || r.status === 0) &&
					remaining > 0
				) {
					url =
						TMDB_BASE +
						"/" +
						endpoint +
						"?api_key=" +
						nextTmdbKey() +
						(qs.length ? "&" + qs.join("&") : "");
					return tryKey(remaining - 1);
				}
				return null;
			});
		}
		return tryKey(TMDB_KEYS.length - 1);
	}

	function img(size, p) {
		return p ? TMDB_IMG + "/" + size + p : "";
	}

	function tmdbToItem(r, fallbackType) {
		try {
			var title = r.title || r.name || r.original_title || r.original_name;
			if (!title) return null;
			var mt = r.media_type || fallbackType || "movie";
			if (mt === "tv") mt = "series";
			var poster = r.poster_path
				? img(IMG_POSTER, r.poster_path)
				: r.backdrop_path
					? img(IMG_BACK, r.backdrop_path)
					: "";
			var yearStr = (r.release_date || r.first_air_date || "").split("-")[0];
			var item = {
				title: title,
				url: "tmdb:" + mt + ":" + r.id,
				posterUrl: poster,
				bannerUrl: r.backdrop_path ? img(IMG_BACK, r.backdrop_path) : poster,
				type: mt,
				contentType: mt,
			};
			var y = parseInt(yearStr, 10);
			if (y && y > 1900 && y < 2200) item.year = y;
			if (r.vote_average) item.score = parseFloat(r.vote_average);
			return item;
		} catch (e) {
			return null;
		}
	}

	// ---- URL Validation --------------------------------------------------------

	/**
	 * Validate that a URL is a playable stream URL.
	 * Rejects: empty, non-http(s), localhost, private IPs, link-local, too short hosts.
	 */
	function isValidStreamUrl(url) {
		if (!url || typeof url !== "string") return false;
		if (url.indexOf("data:") === 0) return true;
		if (url.indexOf("https://") !== 0 && url.indexOf("http://") !== 0)
			return false;
		var hostMatch = url.match(/^https?:\/\/([^/]+)/);
		if (!hostMatch) return false;
		var host = hostMatch[1].toLowerCase();
		if (
			host === "localhost" ||
			host === "127.0.0.1" ||
			host.indexOf("169.254.") === 0 ||
			host.indexOf("10.") === 0 ||
			host.indexOf("192.168.") === 0
		)
			return false;
		var ipv4Match = host.match(/^172\.(\d+)\./);
		if (ipv4Match) {
			var secondOctet = parseInt(ipv4Match[1], 10);
			if (secondOctet >= 16 && secondOctet <= 31) return false;
		}
		if (host.length < 3) return false;
		return true;
	}

	// ---- Nuvio manifest layer -------------------------------------------------

	var _providers = null;
	var _providersAt = 0;
	var _providersInflight = null;

	function getManifests() {
		try {
			if (
				typeof manifest !== "undefined" &&
				Array.isArray(manifest.nuvioManifests) &&
				manifest.nuvioManifests.length
			)
				return manifest.nuvioManifests.slice();
		} catch (e) {}
		return [];
	}

	function getProviders() {
		if (_providers && Date.now() - _providersAt < CACHE_TTL.manifest)
			return Promise.resolve(_providers);
		if (_providersInflight) return _providersInflight;
		_providersInflight = (function () {
			var urls = getManifests();
			log("fetching " + urls.length + " Nuvio manifests…");
			return Promise.all(
				urls.map(function (u) {
					return httpGet(u, HDR_JSON, T_MANIFEST)
						.then(function (r) {
							if (r.status < 200 || r.status >= 300 || !r.body) {
								warn("manifest " + u + " -> HTTP " + r.status);
								return null;
							}
							try {
								return { url: u, data: JSON.parse(r.body) };
							} catch (e) {
								warn("manifest " + u + " -> JSON parse error");
								return null;
							}
						})
						.catch(function (e) {
							warn("manifest " + u + " -> " + (e.message || e));
							return null;
						});
				}),
			)
				.then(function (results) {
					var seen = {},
						out = [],
						ok = 0;
					for (var i = 0; i < results.length; i++) {
						var res = results[i];
						if (!res) continue;
						var data = res.data;
						var list = data && (data.scrapers || data.providers);
						if (!Array.isArray(list)) {
							warn("manifest " + res.url + " -> no scrapers[]");
							continue;
						}
						ok++;
						var base = res.url
							.replace(/\/manifest\.json.*$/i, "")
							.replace(/\/+$/, "");
						var srcName = (data && (data.name || data.author)) || "Unknown";
						for (var j = 0; j < list.length; j++) {
							var p = list[j];
							if (!p || !p.id || !p.filename) continue;
							if (p.enabled === false) continue;
							var url = base + "/" + String(p.filename).replace(/^\/+/, "");
							if (seen[url]) continue;
							seen[url] = true;
							out.push({
								id: p.id,
								name: p.name || p.id,
								url: url,
								supportedTypes:
									Array.isArray(p.supportedTypes) && p.supportedTypes.length
										? p.supportedTypes
										: ["movie", "tv"],
								enabled: p.enabled !== false,
								limited: p.limited === true,
								languages: Array.isArray(p.contentLanguage)
									? p.contentLanguage
									: ["en"],
								formats: Array.isArray(p.formats) ? p.formats : [],
								logo: p.logo || "",
								sourceName: srcName,
							});
						}
					}
					log(
						"loaded " +
							out.length +
							" unique providers from " +
							ok +
							"/" +
							urls.length +
							" manifests",
					);
					_providers = out;
					_providersAt = Date.now();
					_providersInflight = null;
					return out;
				})
				.catch(function (e) {
					_providersInflight = null;
					warn("getProviders failed: " + (e.message || e));
					return _providers || [];
				});
		})();
		return _providersInflight;
	}

	// ---- Provider code cache --------------------------------------------------
	// Holds fetched JS code for each provider URL (keyed by URL).
	// _codeCacheCap: max entries before evicting oldest (LRU-ish via fifo queue).
	// Default 128 — enough for all 143 providers plus headroom.

	var _codeCache = {};
	var _codeCacheKeys = [];
	var _codeCacheCap = cfg("cache.codeCacheCap", 128);

	function _setCodeCache(url, body) {
		if (!_codeCache[url]) {
			_codeCache[url] = { body: body, at: Date.now() };
			_codeCacheKeys.push(url);
			while (_codeCacheKeys.length > _codeCacheCap)
				delete _codeCache[_codeCacheKeys.shift()];
		} else {
			_codeCache[url].at = Date.now();
		}
	}

	function fetchProviderCode(url) {
		var hit = _codeCache[url];
		if (hit && Date.now() - hit.at < CACHE_TTL.code)
			return Promise.resolve(hit.body);
		return httpGet(url, HDR_HTML, T_CODE).then(function (r) {
			if (r.status < 200 || r.status >= 300 || !r.body) return null;
			if (r.body.length > LIMIT_PROVIDER_CODE) {
				warn(
					"fetchProviderCode: " +
						url +
						" body too large (" +
						r.body.length +
						" > " +
						LIMIT_PROVIDER_CODE +
						" bytes) — truncating",
				);
				r.body = r.body.substring(0, LIMIT_PROVIDER_CODE);
			}
			_setCodeCache(url, r.body);
			return r.body;
		});
	}

	// ---- Parallel code prefetcher ----------------------------------------------
	// Fetches ALL provider code files at once via http_parallel (runtime batch HTTP).
	// Returns a promise. We await it before starting providers so there's zero
	// network contention between code fetching and provider execution.
	// After prefetch, every provider's fetchProviderCode() call hits _codeCache
	// instantly — the per-slot HTTP fetch is eliminated.
	// A hard timeout (half of T_TOTAL) force-resolves so we never block providers.

	function prefetchAllProviderCodes(providers) {
		var urls = [],
			seen = {};
		for (var i = 0; i < providers.length; i++) {
			var u = providers[i].url;
			if (!seen[u]) {
				seen[u] = true;
				urls.push(u);
			}
		}
		if (!urls.length) return Promise.resolve();
		log(
			"prefetch: fetching " + urls.length + " provider code files in parallel…",
		);
		var start = Date.now();

		function cacheBody(u, body) {
			if (!body) return;
			if (body.length > LIMIT_PROVIDER_CODE) {
				warn(
					"prefetch: " +
						u +
						" too large (" +
						body.length +
						" > " +
						LIMIT_PROVIDER_CODE +
						") — truncating",
				);
				body = body.substring(0, LIMIT_PROVIDER_CODE);
			}
			_setCodeCache(u, body);
		}

		// Build the fetch promise (http_parallel or Promise.all fallback)
		var fetchPromise;
		if (typeof globalThis.http_parallel === "function") {
			var reqs = [];
			for (var i = 0; i < urls.length; i++) {
				reqs.push({
					url: urls[i],
					method: "GET",
					headers: HDR_HTML,
					timeout: T_CODE,
				});
			}
			fetchPromise = globalThis.http_parallel(reqs).then(
				function (responses) {
					for (var i = 0; i < responses.length; i++) {
						var r = responses[i];
						if (r && r.status >= 200 && r.status < 300 && r.body)
							cacheBody(urls[i], r.body);
					}
				},
				function () {},
			);
		} else {
			var promises = [];
			for (var i = 0; i < urls.length; i++) {
				(function (u) {
					promises.push(
						httpGet(u, HDR_HTML, T_CODE).then(function (r) {
							if (r.status >= 200 && r.status < 300 && r.body)
								cacheBody(u, r.body);
						}),
					);
				})(urls[i]);
			}
			fetchPromise = Promise.all(promises).then(null, function () {});
		}

		// Race the fetch against a timeout so we never block providers forever
		var prefetchMs = Math.min(T_CODE * 2, Math.floor(T_TOTAL * 0.5));
		return Promise.race([
			fetchPromise,
			new Promise(function (resolve) {
				setTimeout(function () {
					log(
						"prefetch: timeout after " +
							(Date.now() - start) +
							"ms (limit=" +
							prefetchMs +
							"ms)",
					);
					resolve();
				}, prefetchMs);
			}),
		]).then(function () {
			log(
				"prefetch: " + urls.length + " files in " + (Date.now() - start) + "ms",
			);
		});
	}

	// ---- Provider code pre-processor ------------------------------------------

	function preprocessProviderCode(raw) {
		if (!raw) return "";
		var code = String(raw);
		code = code.replace(
			/^\s*import\s+(?:[\s\S]+?from\s+)?['"][^'"]+['"];?/gm,
			"",
		);
		code = code.replace(/export\s+default\s+/g, "module.exports = ");
		code = code.replace(/export\s+async\s+function\s+/g, "async function ");
		code = code.replace(/export\s+function\s+/g, "function ");
		code = code.replace(/export\s+const\s+/g, "const ");
		code = code.replace(/export\s+let\s+/g, "let ");
		code = code.replace(/export\s+var\s+/g, "var ");
		code = code.replace(/export\s*\{[^}]*\};?/g, "");
		code = code.replace(
			/Object\.defineProperty\(exports,\s*"__esModule",\s*\{[^}]*\}\);?/g,
			"",
		);
		// Remove "use strict" if inside a function body (can cause issues with eval)
		code = code.replace(/['"]use strict['"];?/g, "");
		return code;
	}

	// ---- Provider executor ----------------------------------------------------

	function compileProvider(code) {
		try {
			var body = preprocessProviderCode(code);
			var fn = new Function("module", "exports", "require", body);
			var mod = { exports: {} };
			fn(mod, mod.exports, globalThis.require);
			var exp = mod.exports;
			if (!exp || typeof exp !== "object") return null;
			var get = exp.getStreams;
			if (typeof get !== "function" && exp.default) {
				if (typeof exp.default === "function") get = exp.default;
				else if (exp.default && typeof exp.default.getStreams === "function")
					get = exp.default.getStreams;
			}
			return typeof get === "function" ? get : null;
		} catch (e) {
			warn("compileProvider failed: " + (e.message || e));
			return null;
		}
	}

	// ---- Per-provider runner (with retry) -------------------------------------

	function runProvider(p, ctx) {
		return new Promise(function (resolve) {
			var attempts = 0;
			var maxAttempts = PROVIDER_RETRIES;

			function attempt() {
				var done = false;
				var t = setTimeout(function () {
					if (!done) {
						done = true;
						resolve({ provider: p, streams: [], error: new Error("timeout") });
					}
				}, T_PROVIDER);

				fetchProviderCode(p.url)
					.then(function (code) {
						if (done) return;
						if (!code) {
							clearTimeout(t);
							done = true;
							resolve({
								provider: p,
								streams: [],
								error: new Error("code-404"),
							});
							return;
						}

						var get = compileProvider(code);
						if (!get) {
							clearTimeout(t);
							done = true;
							_failedProviders[p.url] = Date.now();
							resolve({
								provider: p,
								streams: [],
								error: new Error("no-getStreams"),
							});
							return;
						}

						try {
							var res = get(ctx.tmdbId, ctx.mediaType, ctx.season, ctx.episode);
							if (res && typeof res.then === "function") {
								res
									.then(function (arr) {
										if (!done) {
											clearTimeout(t);
											done = true;
											resolve({
												provider: p,
												streams: Array.isArray(arr) ? arr : [],
											});
										}
									})
									.catch(function (e) {
										if (!done) {
											clearTimeout(t);
											done = true;
											if (attempts < maxAttempts) {
												attempts++;
												log(
													"retry provider " +
														p.name +
														" (" +
														attempts +
														"/" +
														maxAttempts +
														") after error: " +
														(e.message || e),
												);
												attempt();
											} else {
												resolve({ provider: p, streams: [], error: e });
											}
										}
									});
							} else if (Array.isArray(res)) {
								clearTimeout(t);
								done = true;
								resolve({ provider: p, streams: res });
							} else {
								clearTimeout(t);
								done = true;
								resolve({ provider: p, streams: [] });
							}
						} catch (e) {
							if (!done) {
								clearTimeout(t);
								done = true;
								if (attempts < maxAttempts) {
									attempts++;
									log(
										"retry provider " +
											p.name +
											" (" +
											attempts +
											"/" +
											maxAttempts +
											") after error: " +
											(e.message || e),
									);
									attempt();
								} else {
									_failedProviders[p.url] = Date.now();
									resolve({ provider: p, streams: [], error: e });
								}
							}
						}
					})
					.catch(function (e) {
						if (!done) {
							clearTimeout(t);
							done = true;
							if (attempts < maxAttempts) {
								attempts++;
								log(
									"retry provider " +
										p.name +
										" (" +
										attempts +
										"/" +
										maxAttempts +
										") after fetch error: " +
										(e.message || e),
								);
								attempt();
							} else {
								resolve({ provider: p, streams: [], error: e });
							}
						}
					});
			}

			attempt();
		});
	}

	// ---- Provider health scoring ----------------------------------------------

	function _trackProviderResult(p, latencyMs, streamCount, error) {
		if (!HEALTH_CFG.enabled) return;
		var id = p.url;
		var prev = _providerHealth[id];
		if (!prev) {
			prev = {
				calls: 0,
				successes: 0,
				failures: 0,
				totalStreams: 0,
				totalTimeMs: 0,
				lastCall: 0,
			};
			_providerHealth[id] = prev;
		}
		prev.calls++;
		prev.totalTimeMs += latencyMs;
		prev.lastCall = Date.now();
		if (error) {
			prev.failures++;
		} else {
			prev.successes++;
			prev.totalStreams += streamCount;
		}
	}

	function _getProviderScore(p) {
		if (!HEALTH_CFG.enabled) return 1;
		var h = _providerHealth[p.url];
		if (!h || h.calls < 2) return 0.9; // New/unproven — near-default score
		var successRate = h.calls > 0 ? h.successes / h.calls : 0;
		var avgLatency = h.successes > 0 ? h.totalTimeMs / h.successes : 99999;
		var avgYield = h.calls > 0 ? h.totalStreams / h.calls : 0;
		var latencyScore = Math.max(0, 1 - avgLatency / 20000);
		var yieldScore = Math.min(1, avgYield / 10);
		return (
			successRate * HEALTH_CFG.successWeight +
			latencyScore * HEALTH_CFG.latencyWeight +
			yieldScore * HEALTH_CFG.yieldWeight
		);
	}

	// ---- Adaptive concurrency helper ------------------------------------------

	function _maybeAdjustConcurrency(recentLatencyMs) {
		if (!ADAPT_CFG.enabled) return;
		if (Date.now() - _concurrencyLastAdj < ADAPT_CFG.adjustMs) return;
		_concurrencyLastAdj = Date.now();
		if (recentLatencyMs < ADAPT_CFG.targetMs * 0.6) {
			// Fast responses — increase concurrency
			_currentConcurrency = Math.min(
				CONCUR_MAX,
				_currentConcurrency + ADAPT_CFG.incStep,
			);
		} else if (recentLatencyMs > ADAPT_CFG.targetMs * 1.4) {
			// Slow responses — decrease concurrency
			_currentConcurrency = Math.max(
				CONCUR_MIN,
				_currentConcurrency - ADAPT_CFG.decStep,
			);
		}
	}

	// ---- Batched runner -------------------------------------------------------

	function runProvidersBatched(providers, ctx) {
		// Sort providers by health score (best first) so high-quality providers run first
		var sorted = providers.slice().sort(function (a, b) {
			return _getProviderScore(b) - _getProviderScore(a);
		});
		if (HEALTH_CFG.enabled) {
			var best = _getProviderScore(sorted[0]) || 0;
			var worst = _getProviderScore(sorted[sorted.length - 1]) || 0;
			log(
				"runProvidersBatched: " +
					sorted.length +
					" providers sorted by health (best=" +
					best.toFixed(2) +
					" worst=" +
					worst.toFixed(2) +
					" concurrency=" +
					_currentConcurrency +
					")",
			);
		}

		return new Promise(function (resolve) {
			var settled = false;
			var totalStart = Date.now();
			var latencies = [];

			var globalT = setTimeout(function () {
				if (!settled) {
					settled = true;
					log(
						"loadStreams: global timeout (" +
							Math.round(T_TOTAL / 1000) +
							"s) — returning " +
							results.length +
							" provider results",
					);
					resolve(results);
				}
			}, T_TOTAL);

			var idx = 0,
				inFlight = 0,
				results = [];

			function startNext() {
				if (settled) return;
				while (
					idx < sorted.length &&
					_failedProviders[sorted[idx].url] &&
					Date.now() - _failedProviders[sorted[idx].url] < _failedProviderTTL
				) {
					idx++;
				}
				if (idx >= sorted.length) {
					if (inFlight === 0) {
						clearTimeout(globalT);
						settled = true;
						_maybeAdjustConcurrency(
							latencies.length
								? latencies.reduce(function (a, b) {
										return a + b;
									}) / latencies.length
								: ADAPT_CFG.targetMs,
						);
						resolve(results);
					}
					return;
				}
				var p = sorted[idx++];
				var pStart = Date.now();
				inFlight++;
				runProvider(p, ctx)
					.then(function (r) {
						var elapsed = Date.now() - pStart;
						inFlight--;
						latencies.push(elapsed);
						_trackProviderResult(
							p,
							elapsed,
							r.streams ? r.streams.length : 0,
							r.error,
						);
						if (r.streams && r.streams.length) {
							results.push(r);
							_clearPruned(p.url);
						} else {
							_recordPruneResult(p.url, !!r.error, false);
						}
						_maybeAdjustConcurrency(
							latencies.length
								? latencies.reduce(function (a, b) {
										return a + b;
									}) / latencies.length
								: ADAPT_CFG.targetMs,
						);
						startNext();
					})
					.catch(function (e) {
						var elapsed = Date.now() - pStart;
						inFlight--;
						latencies.push(elapsed);
						_trackProviderResult(p, elapsed, 0, e);
						_recordPruneResult(p.url, true, false);
						startNext();
					});
			}

			for (
				var i = 0;
				i < Math.min(Math.max(_currentConcurrency, CONCUR_MIN), sorted.length);
				i++
			)
				startNext();
		});
	}

	// ---- Stream normaliser + dedup + validation --------------------------------

	function safeStreamUrl(raw) {
		if (!raw) return null;
		var u = raw.url && typeof raw.url === "string" ? raw.url : raw;
		if (typeof u !== "string") return null;
		u = u.trim();
		if (u.length > LIMIT_STREAM_URL) return null;
		// Always allow magic proxy URLs
		if (/^magic_proxy_v[12]_/i.test(u)) return u;
		if (/^magic_m3u8:/i.test(u)) return u;
		// For standard URLs, validate thoroughly
		if (/^(https?|ftp|magnet):\/\//i.test(u)) {
			if (!isValidStreamUrl(u)) {
				warn(
					"safeStreamUrl: rejected invalid/private URL: " + u.substring(0, 80),
				);
				return null;
			}
			return u;
		}
		return null;
	}

	function normalizeStream(s, p) {
		if (!s || typeof s !== "object") return null;
		var url = safeStreamUrl(s.url || s.streamUrl || s.link || s.file || s.src);
		if (!url) return null;
		var src = s.name || s.source || s.label || s.title || s.server || p.name;
		var q = s.quality || s.qualityLabel || "";
		if (q && String(src).toLowerCase().indexOf(String(q).toLowerCase()) < 0)
			src = src + " " + q;
		var out = { url: url, source: String(src).trim() || p.name };
		// Copy headers, filtering out transport-level ones that break the player's
		// first request. "Range" makes the server return 206 Partial Content which
		// some video players don't handle on initial load. "Connection" is managed
		// by the player's own HTTP client.
		if (s.headers && typeof s.headers === "object") {
			var SAFE_HDRS = [
				"User-Agent",
				"Referer",
				"Origin",
				"Accept",
				"Accept-Language",
				"X-Requested-With",
				"x-request-x",
				"Cookie",
				"Authorization",
			];
			var clean = {};
			for (var hk in s.headers) {
				if (Object.prototype.hasOwnProperty.call(s.headers, hk)) {
					var hkLower = String(hk).toLowerCase();
					// Skip transport-level headers that the player manages
					if (
						hkLower === "range" ||
						hkLower === "connection" ||
						hkLower === "keep-alive"
					)
						continue;
					// Only keep known-safe header names (case-insensitive match)
					for (var si = 0; si < SAFE_HDRS.length; si++) {
						if (hkLower === SAFE_HDRS[si].toLowerCase()) {
							clean[hk] = s.headers[hk];
							break;
						}
					}
				}
			}
			if (Object.keys(clean).length) out.headers = clean;
		}
		// Set stream type hint so the player doesn't need to probe.
		// Helps first-play succeed — player knows it's HLS, MP4, etc. upfront.
		var ul = String(url).toLowerCase();
		if (ul.indexOf(".m3u8") > 0) out.type = "hls";
		else if (ul.indexOf(".mp4") > 0) out.type = "mp4";
		else if (ul.indexOf(".mkv") > 0) out.type = "mkv";
		else if (ul.indexOf(".webm") > 0) out.type = "webm";
		if (s.drmKid) out.drmKid = s.drmKid;
		if (s.drmKey) out.drmKey = s.drmKey;
		if (s.licenseUrl || s.license || s.drmLicenseUrl)
			out.licenseUrl = s.licenseUrl || s.license || s.drmLicenseUrl;
		if (Array.isArray(s.subtitles) && s.subtitles.length) {
			out.subtitles = s.subtitles
				.map(function (sub) {
					if (typeof sub === "string") return { url: sub, label: "Subtitle" };
					return {
						url: sub.url || sub.file || "",
						label: sub.label || sub.name || "Subtitle",
						lang: sub.lang || sub.language || sub.code || null,
					};
				})
				.filter(function (x) {
					return !!x.url;
				});
		}
		// Detect and set quality field from source label
		if (!out.quality) {
			out.quality = extractQuality(out.source) || "";
		}
		return out;
	}

	function extractQuality(name) {
		var s = String(name || "");
		var m = s.match(/(2160p|1440p|1080p|720p|480p|360p|4K|2K|HD|SD)/i);
		return m ? m[1] : "";
	}

	function urlFingerprint(u) {
		var s = String(u).split("#")[0];
		return s.replace(/[?&]_=\d+/g, "").replace(/[?&]t=\d+/g, "");
	}

	function dedupStreams(streams) {
		var seen = {},
			out = [];
		for (var i = 0; i < streams.length; i++) {
			var s = streams[i];
			if (!s || !s.url || !s.source) continue;
			var key =
				s.source.toLowerCase() +
				"|" +
				(extractQuality(s.source) || "") +
				"|" +
				urlFingerprint(s.url);
			if (seen[key]) continue;
			seen[key] = true;
			out.push(s);
		}
		return out;
	}

	// ---- Stream cache ---------------------------------------------------------

	var _streamCache = {},
		_streamCacheKeys = [],
		_streamCacheCap = 128;
	function streamCacheKey(ctx) {
		return (
			ctx.tmdbId +
			":" +
			ctx.mediaType +
			":" +
			(ctx.season || 0) +
			":" +
			(ctx.episode || 0)
		);
	}
	function getCachedStreams(key) {
		var h = _streamCache[key];
		if (h && Date.now() - h.at < CACHE_TTL.streams) return h.streams;
		return null;
	}
	function setCachedStreams(key, streams) {
		if (!_streamCache[key]) _streamCacheKeys.push(key);
		_streamCache[key] = { streams: streams, at: Date.now() };
		while (_streamCacheKeys.length > _streamCacheCap)
			delete _streamCache[_streamCacheKeys.shift()];
	}

	// ---- getHome --------------------------------------------------------------

	var HOME_CATEGORIES = [
		{
			name: "Trending Now",
			build: function () {
				return merge(
					[
						{ ep: "trending/movie/week", type: "movie" },
						{ ep: "trending/tv/week", type: "series" },
					],
					50,
				);
			},
		},
		{
			name: "Trending Movies",
			build: function () {
				return list("trending/movie/week", "movie", 50);
			},
		},
		{
			name: "Trending Series",
			build: function () {
				return list("trending/tv/week", "series", 50);
			},
		},
		{
			name: "Airing Today",
			build: function () {
				return list("tv/airing_today", "series", 50);
			},
		},
		{
			name: "Top Rated Movies",
			build: function () {
				return list("movie/top_rated", "movie", 50);
			},
		},
		{
			name: "Top Rated Series",
			build: function () {
				return list("tv/top_rated", "series", 50);
			},
		},
	];

	function list(ep, type, n, extra) {
		n = n || 50;
		var pages = Math.max(1, Math.ceil(n / 20)),
			ps = [];
		for (var i = 1; i <= pages; i++) {
			var p = Object.assign({}, extra || {}, { page: i });
			ps.push(tmdbGet(ep, p));
		}
		return Promise.all(ps).then(function (rs) {
			var seen = {},
				out = [];
			for (var r = 0; r < rs.length; r++) {
				var d = rs[r];
				if (!d || !Array.isArray(d.results)) continue;
				for (var j = 0; j < d.results.length; j++) {
					var item = tmdbToItem(d.results[j], type);
					if (item && !seen[item.url]) {
						seen[item.url] = true;
						out.push(item);
					}
					if (out.length >= n) break;
				}
				if (out.length >= n) break;
			}
			return { items: out };
		});
	}

	function merge(rows, n) {
		var ps = [];
		rows.forEach(function (row) {
			var pages = Math.max(1, Math.ceil(n / 20));
			for (var p = 1; p <= pages; p++) {
				var params = Object.assign({}, row.extra || {}, { page: p });
				ps.push(
					tmdbGet(row.ep, params).then(function (d) {
						return { row: row, d: d };
					}),
				);
			}
		});
		return Promise.all(ps).then(function (rs) {
			var seen = {},
				out = [];
			for (var i = 0; i < rs.length; i++) {
				var d = rs[i].d,
					row = rs[i].row;
				if (!d || !Array.isArray(d.results)) continue;
				for (var j = 0; j < d.results.length; j++) {
					var item = tmdbToItem(d.results[j], row.type);
					if (item && !seen[item.url]) {
						seen[item.url] = true;
						out.push(item);
					}
				}
			}
			out.sort(function (a, b) {
				return (b.score || 0) - (a.score || 0);
			});
			return { items: out.slice(0, n) };
		});
	}

	function getHome(cb, page) {
		var pn = parseInt(page) || 1;
		log("getHome(page=" + pn + ")");

		var results = {};
		var totalCategories = HOME_CATEGORIES.length;
		var completedCategories = 0;
		var settled = false;
		var startTime = Date.now();

		function finish() {
			if (settled) return;
			settled = true;
			log(
				"getHome: " +
					Object.keys(results).length +
					"/" +
					totalCategories +
					" categories in " +
					(Date.now() - startTime) +
					"ms",
			);
			cb({ success: true, data: results, page: pn });
		}

		// Hard timeout - guarantee callback after T_HOME_TOTAL ms
		var hardTimer = setTimeout(finish, T_HOME_TOTAL);

		HOME_CATEGORIES.forEach(function (cat) {
			// Calculate remaining time budget for this category
			var elapsed = Date.now() - startTime;
			var remaining = Math.max(2000, T_HOME_TOTAL - elapsed - 500);
			var budget = Math.min(T_HOME_CAT, remaining);

			var budgetTimer = setTimeout(function () {
				// Category timed out - just skip it
				if (--completedCategories === totalCategories - 1) {
					// All categories done (even if some timed out)
				}
			}, budget);

			cat
				.build()
				.then(function (r) {
					clearTimeout(budgetTimer);
					if (r && r.items && r.items.length) {
						results[cat.name] = r.items;
					}
				})
				.catch(function () {
					clearTimeout(budgetTimer);
				})
				.then(function () {
					completedCategories++;
					if (completedCategories === totalCategories && !settled) {
						clearTimeout(hardTimer);
						finish();
					}
				});
		});
	}

	// ---- search ---------------------------------------------------------------

	function search(query, cb) {
		var q = String(query || "").trim();
		if (!q) return cb({ success: true, data: [] });
		log('search("' + q + '")');

		function fromResults(data, fallbackType) {
			var items = [];
			if (!data || !Array.isArray(data.results)) return items;
			for (var i = 0; i < data.results.length; i++) {
				var r = data.results[i];
				if (r.media_type && r.media_type !== "movie" && r.media_type !== "tv")
					continue;
				var t = r.media_type
					? r.media_type === "tv"
						? "series"
						: "movie"
					: fallbackType;
				var item = tmdbToItem(r, t);
				if (item) items.push(item);
			}
			return items;
		}

		var settled = false;
		var searchTimer = setTimeout(function () {
			if (!settled) {
				settled = true;
				cb({ success: true, data: [] });
			}
		}, T_SEARCH);

		Promise.all([
			tmdbGet("search/multi", {
				query: q,
				page: 1,
				include_adult: false,
			}),
			Promise.all([
				tmdbGet("search/movie", { query: q, page: 1, include_adult: false }),
				tmdbGet("search/tv", { query: q, page: 1, include_adult: false }),
			]),
		])
			.then(function (results) {
				if (settled) return;
				clearTimeout(searchTimer);
				settled = true;
				var seen = {},
					out = [];
				function addAll(items) {
					for (var i = 0; i < items.length; i++)
						if (!seen[items[i].url]) {
							seen[items[i].url] = true;
							out.push(items[i]);
						}
				}
				addAll(fromResults(results[0]));
				addAll(fromResults(results[1][0], "movie"));
				addAll(fromResults(results[1][1], "series"));
				var truncated = out.slice(0, LIMIT_SEARCH);
				cb({ success: true, data: truncated });

				// Trigger cache warming for top N results
				if (WARM_CFG.enabled && truncated.length) {
					var warmed = 0;
					for (
						var wi = 0;
						wi < truncated.length && warmed < WARM_CFG.maxItems;
						wi++
					) {
						if (truncated[wi] && truncated[wi].url) {
							_warmStreams(truncated[wi].url);
							warmed++;
						}
					}
					if (warmed) {
						log(
							"search: queued " +
								warmed +
								" items for cache warming (limit=" +
								WARM_CFG.maxItems +
								")",
						);
					}
				}
			})
			.catch(function () {
				if (!settled) {
					clearTimeout(searchTimer);
					settled = true;
					cb({ success: true, data: [] });
				}
			});
	}

	// ---- load -----------------------------------------------------------------

	function parseContentRef(s) {
		if (s == null) return null;
		s = String(s).trim();
		if (!s) return null;
		var m;
		if ((m = s.match(/^nuvio:\/\/tv\/(\d+)(?:\/(\d+)(?:\/(\d+))?)?$/i)))
			return {
				tmdbId: m[1],
				mediaType: "series",
				season: m[2] ? +m[2] : null,
				episode: m[3] ? +m[3] : null,
			};
		if ((m = s.match(/^nuvio:\/\/movie\/(\d+)$/i)))
			return { tmdbId: m[1], mediaType: "movie", season: null, episode: null };
		if ((m = s.match(/^tmdb:(movie|series|tv):(\d+)/i)))
			return {
				tmdbId: m[2],
				mediaType: m[1].toLowerCase() === "movie" ? "movie" : "series",
				season: null,
				episode: null,
			};
		if ((m = s.match(/^(\d+)$/)))
			return { tmdbId: m[1], mediaType: "movie", season: null, episode: null };
		if ((m = s.match(/(\d{2,})/)))
			return { tmdbId: m[1], mediaType: "movie", season: null, episode: null };
		return null;
	}

	function minimalItem(parsed, tmdbId) {
		var isSeries = parsed.mediaType === "series";
		return {
			title: "Content",
			url: "tmdb:" + (isSeries ? "series" : "movie") + ":" + tmdbId,
			posterUrl: "",
			type: isSeries ? "series" : "movie",
			contentType: isSeries ? "series" : "movie",
			episodes: [
				{
					name: isSeries ? "Season 1 Episode 1" : "Play",
					url: isSeries
						? "nuvio://tv/" + tmdbId + "/1/1"
						: "nuvio://movie/" + tmdbId,
					season: 1,
					episode: 1,
				},
			],
		};
	}

	function load(url, cb) {
		try {
			var parsed = parseContentRef(url);
			if (!parsed || !parsed.tmdbId)
				return cb({
					success: false,
					errorCode: "PARSE_ERROR",
					message: "Cannot parse: " + url,
				});
			var tmdbId = parsed.tmdbId,
				apiType = parsed.mediaType === "series" ? "tv" : "movie";
			log("load(" + apiType + " tmdb:" + tmdbId + ")");

			var settled = false;
			var loadStart = Date.now();

			function safe(r) {
				if (!settled) {
					settled = true;
					clearTimeout(timeoutTimer);
					cb(r);
				}
			}

			// Hard timeout: return minimal item if TMDB takes too long
			var timeoutTimer = setTimeout(function () {
				log("load: timeout (" + T_DETAIL + "ms), returning minimal item");
				safe({ success: true, data: minimalItem(parsed, tmdbId) });
			}, T_DETAIL);

			tmdbGet(apiType + "/" + tmdbId, {
				append_to_response: "credits,videos,external_ids",
			})
				.then(function (data) {
					if (!data)
						return safe({ success: true, data: minimalItem(parsed, tmdbId) });

					var isSeries = apiType === "tv";
					var title =
						data.title ||
						data.name ||
						data.original_title ||
						data.original_name ||
						"Unknown";
					var year =
						parseInt(
							(data.release_date || data.first_air_date || "").split("-")[0],
							10,
						) || undefined;
					var score = data.vote_average
						? parseFloat(data.vote_average)
						: undefined;
					var desc = (data.overview || "")
						.replace(/<[^>]*>/g, "")
						.trim()
						.substring(0, 500);
					var poster = data.poster_path
						? img(IMG_POSTER, data.poster_path)
						: data.backdrop_path
							? img(IMG_BACK, data.backdrop_path)
							: "";
					var banner = data.backdrop_path
						? img(IMG_BACK, data.backdrop_path)
						: poster;
					var runtime =
						data.runtime ||
						(Array.isArray(data.episode_run_time) &&
							data.episode_run_time[0]) ||
						undefined;
					var cast = undefined;
					if (
						data.credits &&
						Array.isArray(data.credits.cast) &&
						data.credits.cast.length
					)
						cast = data.credits.cast.slice(0, 20).map(function (c) {
							return {
								name: c.name || c.character || "Unknown",
								role: c.character || "",
								image: c.profile_path ? img(IMG_PROF, c.profile_path) : "",
							};
						});
					var trailers = undefined;
					if (
						data.videos &&
						Array.isArray(data.videos.results) &&
						data.videos.results.length
					) {
						trailers = [];
						for (var vi = 0; vi < data.videos.results.length; vi++) {
							var v = data.videos.results[vi];
							if (
								v &&
								v.site === "YouTube" &&
								v.key &&
								(v.type === "Trailer" || v.type === "Teaser")
							) {
								trailers.push({
									url: "https://www.youtube.com/watch?v=" + v.key,
									name: v.name || v.type || "Trailer",
								});
								if (trailers.length >= 5) break;
							}
						}
						if (!trailers.length) trailers = undefined;
					}
					var genres = undefined;
					if (Array.isArray(data.genres) && data.genres.length)
						genres = data.genres.map(function (g) {
							return g.name || String(g.id);
						});
					var status = undefined;
					if (data.status) {
						var sv = String(data.status).toLowerCase();
						if (sv === "ended" || sv === "canceled") status = "completed";
						else if (
							sv === "returning series" ||
							sv === "continuing" ||
							sv === "in production"
						)
							status = "ongoing";
					}

					function finish(episodes) {
						if (!episodes || !episodes.length)
							episodes = [
								{
									name: isSeries ? "Season 1 Episode 1" : "Play",
									url: isSeries
										? "nuvio://tv/" + tmdbId + "/1/1"
										: "nuvio://movie/" + tmdbId,
									season: 1,
									episode: 1,
									posterUrl: poster,
								},
							];
						safe({
							success: true,
							data: {
								title: title,
								url: "tmdb:" + (isSeries ? "series" : "movie") + ":" + tmdbId,
								posterUrl: poster,
								bannerUrl: banner,
								description: desc,
								type: isSeries ? "series" : "movie",
								contentType: isSeries ? "series" : "movie",
								year: year && year > 1900 && year < 2200 ? year : undefined,
								score: score,
								duration: runtime,
								genres: genres,
								cast: cast,
								trailers: trailers,
								status: status,
								episodes: episodes,
							},
						});
					}

					if (!isSeries) {
						finish(null);
						return;
					}

					var seasons = Array.isArray(data.seasons) ? data.seasons : [];
					var real = seasons.filter(function (s) {
						return s && s.season_number > 0;
					});
					if (!real.length) {
						finish(null);
						return;
					}

					var allEps = [],
						pendingSeasons = real.length,
						seasonIdx = 0,
						seasonInFlight = 0,
						// How many season episodes fetch in parallel — 4 keeps TMDB happy
						SEASON_CONCURRENCY = cfg("concurrency.seasons", 4);

					function startNextSeason() {
						while (
							seasonInFlight < SEASON_CONCURRENCY &&
							seasonIdx < real.length
						) {
							(function (sn) {
								seasonInFlight++;
								tmdbGet("tv/" + tmdbId + "/season/" + sn, null, T_SEASON)
									.then(function (sd) {
										if (sd && Array.isArray(sd.episodes)) {
											for (var ei = 0; ei < sd.episodes.length; ei++) {
												var ep = sd.episodes[ei];
												if (!ep || !ep.episode_number) continue;
												allEps.push({
													name: ep.name || "E" + ep.episode_number,
													url:
														"nuvio://tv/" +
														tmdbId +
														"/" +
														sn +
														"/" +
														ep.episode_number,
													season: sn,
													episode: ep.episode_number,
													posterUrl: ep.still_path
														? img(IMG_STILL, ep.still_path)
														: "",
													description: (ep.overview || "").substring(0, 300),
													airDate: ep.air_date || "",
												});
											}
										}
									})
									.catch(function () {})
									.then(function () {
										seasonInFlight--;
										if (--pendingSeasons === 0) {
											allEps.sort(function (a, b) {
												return a.season - b.season || a.episode - b.episode;
											});
											finish(allEps);
										} else {
											startNextSeason();
										}
									});
							})(real[seasonIdx++].season_number);
						}
					}
					startNextSeason();
				})
				.catch(function (e) {
					warn("load: TMDB error " + (e.message || e));
					safe({ success: true, data: minimalItem(parsed, tmdbId) });
				});
		} catch (e) {
			cb({
				success: false,
				errorCode: "LOAD_ERROR",
				message: e.message || String(e),
			});
		}
	}

	// ---- loadStreams (single delivery) ----------------------------------------
	// Collects ALL provider results then calls cb() exactly ONCE with the
	// complete deduplicated stream set. SkyStream application ignores
	// subsequent callbacks, so streaming per-provider loses all but the
	// first 2-3 streams. A safety timeout prevents hanging.

	function loadStreams(url, cb) {
		log("loadStreams(" + url + ")");

		var parsed = parseContentRef(url);
		if (!parsed || !parsed.tmdbId) {
			warn("loadStreams: cannot parse '" + url + "'");
			return cb({
				success: false,
				errorCode: "PARSE_ERROR",
				message: "Cannot parse: " + url,
			});
		}

		var ctx = {
			tmdbId: parsed.tmdbId,
			mediaType: parsed.mediaType === "series" ? "tv" : "movie",
			season: parsed.season,
			episode: parsed.episode,
		};

		var key = streamCacheKey(ctx);
		var cached = getCachedStreams(key);
		if (cached) {
			log("loadStreams: cache hit -> " + cached.length + " streams");
			return cb({ success: true, data: cached });
		}

		var settled = false;
		var allStreams = [];

		function deliver() {
			if (settled) return;
			settled = true;

			var deduped = dedupStreams(
				allStreams
					.map(function (s) {
						return normalizeStream(s.stream, s.provider);
					})
					.filter(Boolean),
			);

			if (deduped.length) {
				setCachedStreams(key, deduped);
				log("loadStreams: delivering " + deduped.length + " unique streams");
				cb({ success: true, data: deduped });
			} else {
				log("loadStreams: no streams found");
				cb({ success: true, data: [] });
			}
		}

		// Start provider fetching
		getProviders()
			.then(function (providers) {
				if (!providers || !providers.length) {
					warn("loadStreams: no providers");
					deliver();
					return;
				}

				var matching = providers.filter(function (p) {
					if (!p.enabled) return false;
					if (_isPruned(p.url)) return false;
					if (!Array.isArray(p.supportedTypes) || !p.supportedTypes.length)
						return true;
					for (var i = 0; i < p.supportedTypes.length; i++) {
						var t = String(p.supportedTypes[i]).toLowerCase();
						if (t === ctx.mediaType || t === "all") return true;
					}
					return false;
				});

				log(
					"loadStreams: fanning out to " +
						matching.length +
						" providers for " +
						ctx.mediaType +
						" " +
						ctx.tmdbId,
				);

				// Fire background prefetch of all provider code files — populates
				// _codeCache so subsequent fetchProviderCode() calls hit cache.
				// NOT awaited — providers start immediately and benefit from
				// whatever cache entries arrive before they need them.
				prefetchAllProviderCodes(matching);

				runProvidersBatched(matching, ctx).then(function (results) {
					for (var i = 0; i < results.length; i++) {
						var r = results[i];
						if (!r || !Array.isArray(r.streams)) continue;
						for (var j = 0; j < r.streams.length; j++) {
							allStreams.push({ stream: r.streams[j], provider: r.provider });
						}
					}
					deliver();
				});
			})
			.catch(function (e) {
				warn("loadStreams: getProviders failed " + (e.message || e));
				deliver();
			});
	}

	// ---- Health Check API -----------------------------------------------------
	// SkyStream convention: check(query, callback)
	// Optional query argument — when absent, run full diagnostics

	function check(query, cb) {
		if (typeof query === "function") {
			cb = query;
			query = "";
		}
		if (typeof cb !== "function") {
			log("check() called without callback — returning diagnostics");
			return;
		}
		query = String(query || "").trim();

		log("check() — running provider health diagnostics…");
		var diag = {
			version: VERSION,
			timestamp: new Date().toISOString(),
			config: {
				manifestCount: 0,
				providerCount: _providers ? _providers.length : 0,
				concurrency: {
					base: PROVIDER_CONCURRENCY,
					current: _currentConcurrency,
					min: CONCUR_MIN,
					max: CONCUR_MAX,
				},
				timeouts: {
					provider: T_PROVIDER,
					total: T_TOTAL,
					safety: T_TOTAL,
				},
				retries: PROVIDER_RETRIES,
				healthEnabled: HEALTH_CFG.enabled,
				adaptiveEnabled: ADAPT_CFG.enabled,
				warmingEnabled: WARM_CFG.enabled,
				failedProviderTTL: _failedProviderTTL,
			},
			health: {
				trackedProviders: 0,
				healthyCount: 0,
				degradedCount: 0,
				deadCount: 0,
				summary: [],
			},
			cache: {
				codeCacheEntries: _codeCacheKeys.length,
				codeCacheCap: _codeCacheCap,
				streamCacheEntries: _streamCacheKeys.length,
				streamCacheCap: _streamCacheCap,
			},
			failedProviders: [],
			errors: [],
		};

		// Gather health stats
		if (HEALTH_CFG.enabled) {
			var ids = Object.keys(_providerHealth);
			diag.health.trackedProviders = ids.length;
			for (var i = 0; i < ids.length; i++) {
				var h = _providerHealth[ids[i]];
				var score =
					successRate(h) * HEALTH_CFG.successWeight +
					latencyScore(h) * HEALTH_CFG.latencyWeight +
					yieldScore(h) * HEALTH_CFG.yieldWeight;
				var status =
					score >= 0.7 ? "healthy" : score >= 0.3 ? "degraded" : "dead";
				if (status === "healthy") diag.health.healthyCount++;
				else if (status === "degraded") diag.health.degradedCount++;
				else diag.health.deadCount++;
				if (diag.health.summary.length < 20) {
					diag.health.summary.push({
						providerId: ids[i],
						score: score.toFixed(3),
						status: status,
						calls: h.calls,
						successes: h.successes,
						failures: h.failures,
						avgLatencyMs: Math.round(
							h.successes ? h.totalTimeMs / h.successes : 0,
						),
						totalStreams: h.totalStreams,
					});
				}
			}

			function successRate(h) {
				return h.calls > 0 ? h.successes / h.calls : 0;
			}
			function latencyScore(h) {
				return Math.max(
					0,
					1 - (h.successes > 0 ? h.totalTimeMs / h.successes : 99999) / 20000,
				);
			}
			function yieldScore(h) {
				return Math.min(1, (h.calls > 0 ? h.totalStreams / h.calls : 0) / 10);
			}
		}

		// List currently failed providers
		var now = Date.now();
		var failedUrls = Object.keys(_failedProviders);
		for (var j = 0; j < failedUrls.length; j++) {
			var expiresAt = _failedProviders[failedUrls[j]] + _failedProviderTTL;
			if (expiresAt > now) {
				diag.failedProviders.push({
					url: failedUrls[j],
					expiresAt: new Date(expiresAt).toISOString(),
					remainingMs: expiresAt - now,
				});
			}
		}

		// Ping manifests
		var manifestUrls = getManifests();
		diag.config.manifestCount = manifestUrls.length;
		Promise.all(
			manifestUrls.map(function (u) {
				return httpGet(u, HDR_JSON, 5000)
					.then(function (r) {
						if (r.status >= 200 && r.status < 300 && r.body) {
							try {
								var d = JSON.parse(r.body);
								return {
									url: u.substring(0, 80),
									status: "ok",
									providers: (d.scrapers || d.providers || []).length,
								};
							} catch (e) {
								return { url: u.substring(0, 80), status: "parse-error" };
							}
						}
						return { url: u.substring(0, 80), status: "http-" + r.status };
					})
					.catch(function () {
						return { url: u.substring(0, 80), status: "unreachable" };
					});
			}),
		).then(function (manifestResults) {
			diag.manifests = manifestResults;
			cb({ success: true, data: diag });
		});
	}

	// ---- Cache warming --------------------------------------------------------

	var _warmingQueue = [];
	var _warmingActive = false;

	function _warmStreams(url) {
		if (!WARM_CFG.enabled) return;
		if (_warmingQueue.length >= WARM_CFG.maxItems * 2) return; // cap queue
		_warmingQueue.push(url);
		_processWarmingQueue();
	}

	function _processWarmingQueue() {
		if (_warmingActive || !_warmingQueue.length) return;
		_warmingActive = true;
		var url = _warmingQueue.shift();

		// Use a silent loadStreams call that caches the result
		var parsed = parseContentRef(url);
		if (!parsed || !parsed.tmdbId) {
			_warmingActive = false;
			_processWarmingQueue();
			return;
		}

		var ctx = {
			tmdbId: parsed.tmdbId,
			mediaType: parsed.mediaType === "series" ? "tv" : "movie",
			season: parsed.season,
			episode: parsed.episode,
		};
		var key = streamCacheKey(ctx);

		// Skip if already cached
		if (getCachedStreams(key)) {
			_warmingActive = false;
			_processWarmingQueue();
			return;
		}

		log("cache warming: pre-fetching streams for " + url);

		// Use a temporary callback that does nothing except update the cache
		getProviders()
			.then(function (providers) {
				if (!providers || !providers.length) {
					_warmingActive = false;
					_processWarmingQueue();
					return;
				}
				var matching = providers.filter(function (p) {
					if (!p.enabled) return false;
					if (!Array.isArray(p.supportedTypes) || !p.supportedTypes.length)
						return true;
					for (var i = 0; i < p.supportedTypes.length; i++) {
						var t = String(p.supportedTypes[i]).toLowerCase();
						if (t === ctx.mediaType || t === "all") return true;
					}
					return false;
				});
				if (!matching.length) {
					_warmingActive = false;
					_processWarmingQueue();
					return;
				}
				runProvidersBatched(matching, ctx).then(function (results) {
					var allStreams = [];
					for (var i = 0; i < results.length; i++) {
						var r = results[i];
						if (!r || !Array.isArray(r.streams)) continue;
						for (var j = 0; j < r.streams.length; j++) {
							allStreams.push({ stream: r.streams[j], provider: r.provider });
						}
					}
					var deduped = dedupStreams(
						allStreams
							.map(function (s) {
								return normalizeStream(s.stream, s.provider);
							})
							.filter(Boolean),
					);
					if (deduped.length) {
						setCachedStreams(key, deduped);
						log(
							"cache warming: cached " + deduped.length + " streams for " + url,
						);
					}
					_warmingActive = false;
					_processWarmingQueue();
				});
			})
			.catch(function () {
				_warmingActive = false;
				_processWarmingQueue();
			});
	}

	// ---- Exports --------------------------------------------------------------

	globalThis.getHome = getHome;
	globalThis.search = search;
	globalThis.load = load;
	globalThis.loadStreams = loadStreams;
	globalThis.check = check;

	var manCount =
		typeof manifest !== "undefined" && Array.isArray(manifest.nuvioManifests)
			? manifest.nuvioManifests.length
			: 0;
	log(
		"loaded v" +
			VERSION +
			" (manifests=" +
			manCount +
			", providers=" +
			(_providers ? _providers.length : 0) +
			", timeout=" +
			Math.round(T_PROVIDER / 1000) +
			"s, total=" +
			Math.round(T_TOTAL / 1000) +
			"s, concur=" +
			PROVIDER_CONCURRENCY +
			"/" +
			_currentConcurrency +
			", retries=" +
			PROVIDER_RETRIES +
			", health=" +
			HEALTH_CFG.enabled +
			", adapt=" +
			ADAPT_CFG.enabled +
			", warm=" +
			WARM_CFG.enabled +
			")",
	);
})();
