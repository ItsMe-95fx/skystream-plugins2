(function () {
	"use strict";

	var TAG = "NuvioBridge";
	var VERSION = "5.0.0";

	// ---- Config reader ---------------------------------------------------------
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

	// ---- Naming config (hardcoded in JS) ------------------------------------
	// Format template. Variables: {resolution}, {quality}, {size}, {audioLang},
	// {codec}, {extra}, {plugin} (=provider name), {provider}, {manifest} (=Nuvio
	// manifest name), {audioChannels}, {hdr}.
	var NAMING_CFG = {
		format:
			"{resolution} - {size} - {audioLang} - {codec} - {extra} [{provider}] [{manifest}]",
		showPluginSuffix: true,
	};
	var NAME_SEP = " · ";
	var _pluginName = "NuvioBridge";

	// ---- Timeouts (ms) ---------------------------------------------------------
	// Aggressive: 8 manifests × ~24 providers each = ~192 providers total.
	// T_TOTAL must be long enough for all providers to respond. T_PROVIDER per
	// single provider fetch. T_CODE for downloading provider JS code (can be large).
	var T_MANIFEST = cfg("timeouts.manifest", 15000);
	var T_CODE = cfg("timeouts.providerCode", 20000);
	var T_PROVIDER = cfg("timeouts.provider", 25000);
	var T_TOTAL = cfg("timeouts.total", 180000);
	var T_TMDB = cfg("timeouts.tmdb", 6000);
	var T_HOME_TOTAL = cfg("timeouts.homeTotal", 12000);
	var T_HOME_CAT = cfg("timeouts.homeCategory", 6000);
	var T_SEARCH = cfg("timeouts.search", 7000);
	var T_DETAIL = cfg("timeouts.detail", 15000);
	var T_SEASON = cfg("timeouts.season", 5000);

	// ---- Concurrency & retries -------------------------------------------------
	var PROVIDER_CONCURRENCY = cfg("concurrency.providers", 16);
	var PROVIDER_RETRIES = cfg("retries.provider", 2);

	// ---- Cache TTLs (ms) -------------------------------------------------------
	var CACHE_TTL = {
		manifest: cfg("cache.manifestTTL", 1800000),
		code: cfg("cache.codeTTL", 3600000),
		streams: cfg("cache.streamTTL", 1800000),
	};
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

	// ---- Auto-prune state ------------------------------------------------------
	var PRUNE_THRESHOLD = cfg("limits.providerPruneThreshold", 5);
	var _prunedProviders = null;

	function _loadPruned() {
		if (_prunedProviders) return;
		try {
			if (typeof globalThis.getPreference === "function") {
				var raw = globalThis.getPreference("nb_pruned");
				if (raw) _prunedProviders = JSON.parse(raw);
			}
		} catch (e) {
			/* ignore */
		}
		if (!_prunedProviders) _prunedProviders = {};
	}

	function _savePruned() {
		try {
			if (typeof globalThis.setPreference === "function")
				globalThis.setPreference("nb_pruned", JSON.stringify(_prunedProviders));
		} catch (e) {
			/* ignore */
		}
	}

	function _isPruned(url) {
		_loadPruned();
		return _prunedProviders[url] && _prunedProviders[url] >= PRUNE_THRESHOLD;
	}

	function _recordPruneResult(url, hadError, hadStreams) {
		if (hadStreams) return;
		if (!hadError) return;
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
	var HEALTH_CFG = {
		enabled: cfg("healthScoring.enabled", true),
		successWeight: cfg("healthScoring.successWeight", 0.5),
		latencyWeight: cfg("healthScoring.latencyWeight", 0.3),
		yieldWeight: cfg("healthScoring.yieldWeight", 0.2),
		decayRate: cfg("healthScoring.decayRate", 0.9),
	};
	var _providerHealth = {};

	// ---- Adaptive concurrency (aggressive AIMD) --------------------------------
	// Additive-increase/multiplicative-decrease: incStep=4 means fast regain after
	// backoff; adjustMs=20s means quick reaction to latency changes. Target 5s per
	// provider. Bounds: 16-96 concurrent. 96 max gives ~2 rounds for 192 providers
	// in ~25s (fast), 16 min ensures slow providers don't stall too long.
	var ADAPT_CFG = {
		enabled: cfg("adaptiveConcurrency.enabled", true),
		targetMs: cfg("adaptiveConcurrency.targetLatencyMs", 5000),
		adjustMs: cfg("adaptiveConcurrency.adjustIntervalMs", 20000),
		incStep: cfg("adaptiveConcurrency.increaseStep", 4),
		decStep: cfg("adaptiveConcurrency.decreaseStep", 1),
	};
	var CONCUR_INITIAL = cfg("concurrency.initial", 32);
	var CONCUR_MIN = cfg("concurrency.min", 16);
	var CONCUR_MAX = cfg("concurrency.max", 96);
	var _currentConcurrency = CONCUR_INITIAL;
	var _concurrencyLastAdj = Date.now();

	// ---- Cache warming ---------------------------------------------------------
	var WARM_CFG = {
		enabled: cfg("cacheWarming.enabled", true),
		maxItems: cfg("cacheWarming.maxItems", 3),
	};

	// ---- Size limits -----------------------------------------------------------
	var LIMIT_PROVIDER_CODE = cfg("limits.providerCodeSize", 3145728);
	var LIMIT_STREAM_URL = cfg("limits.maxStreamUrlLength", 4096);
	var LIMIT_SEARCH = cfg("limits.maxSearchResults", 60);

	// ---- Logging ---------------------------------------------------------------
	function log() {
		try {
			console.log.apply(
				console,
				["[" + TAG + "]", "[" + VERSION + "]"].concat([].slice.call(arguments)),
			);
		} catch (e) {
			/* ignore */
		}
	}
	function warn() {
		try {
			console.warn.apply(
				console,
				["[" + TAG + "]", "[" + VERSION + "]"].concat([].slice.call(arguments)),
			);
		} catch (e) {
			/* ignore */
		}
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
				s = String(s).replace(/[^A-Za-z0-9+/=]/g, "");
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
	} catch (e) {
		/* ignore */
	}
	try {
		if (typeof globalThis.window === "undefined")
			globalThis.window = globalThis;
	} catch (e) {
		/* ignore */
	}
	try {
		if (typeof globalThis.self === "undefined") globalThis.self = globalThis;
	} catch (e) {
		/* ignore */
	}

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
					var dk = decodeURIComponent(k.replace(/\+/g, " "));
					if (dk === "__proto__" || dk === "constructor" || dk === "prototype")
						return;
					this._d[dk] = decodeURIComponent(v.replace(/\+/g, " "));
				}, this);
			}
			this.get = function (k) {
				return Object.prototype.hasOwnProperty.call(this._d, k)
					? this._d[k]
					: null;
			};
			this.set = function (k, v) {
				if (k === "__proto__" || k === "constructor" || k === "prototype")
					return;
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

		// ---- HTML Parser ----------------------------------------------------
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
					/* skip script/style content */
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

		// ---- cheerio shim ----------------------------------------------------
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
			} catch (e) {
				/* ignore */
			}
			return parseHtmlToDom(html);
		}
		function buildCheerio(doc) {
			function $(sel, ctx) {
				if (!sel) return new C([]);
				if (typeof sel === "function") {
					try {
						sel();
					} catch (e) {
						/* ignore */
					}
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

		// ---- crypto-js ----------------------------------------------------
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
						} catch (e) {
							/* ignore */
						}
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
						} catch (e) {
							/* ignore */
						}
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

		// ---- No-op shims ----------------------------------------------------
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
						var k = decodeURIComponent(i < 0 ? p : p.slice(0, i));
						// Prototype pollution prevention
						if (k === "__proto__" || k === "constructor" || k === "prototype")
							return;
						o[k] = decodeURIComponent(i < 0 ? "" : p.slice(i + 1));
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
			try {
				http_get(url, headers, function (r) {
					finish(r);
				});
			} catch (e) {
				finish({ status: 0, body: "", headers: {}, error: e });
			}
		});
	}

	// ==========================================================================
	// ENHANCED STREAM METADATA EXTRACTION ENGINE
	// ==========================================================================

	/**
	 * Language code mapping: full language name → ISO 639-2 3-letter code
	 */
	var LANG_MAP = {
		english: "eng",
		en: "eng",
		eng: "eng",
		hindi: "hin",
		hi: "hin",
		hin: "hin",
		telugu: "tel",
		te: "tel",
		tel: "tel",
		tamil: "tam",
		ta: "tam",
		tam: "tam",
		malayalam: "mal",
		ml: "mal",
		mal: "mal",
		kannada: "kan",
		kn: "kan",
		kan: "kan",
		bengali: "ben",
		bn: "ben",
		ben: "ben",
		marathi: "mar",
		mr: "mar",
		mar: "mar",
		gujarati: "guj",
		gu: "guj",
		guj: "guj",
		punjabi: "pan",
		pa: "pan",
		pan: "pan",
		urdu: "urd",
		ur: "urd",
		urd: "urd",
		odia: "ori",
		or: "ori",
		ori: "ori",
		spanish: "spa",
		es: "spa",
		spa: "spa",
		french: "fra",
		fr: "fra",
		fra: "fra",
		german: "deu",
		de: "deu",
		deu: "deu",
		japanese: "jpn",
		ja: "jpn",
		jpn: "jpn",
		korean: "kor",
		ko: "kor",
		kor: "kor",
		chinese: "zho",
		zh: "zho",
		zho: "zho",
		russian: "rus",
		ru: "rus",
		rus: "rus",
		arabic: "ara",
		ar: "ara",
		ara: "ara",
		portuguese: "por",
		pt: "por",
		por: "por",
		italian: "ita",
		it: "ita",
		ita: "ita",
		dutch: "nld",
		nl: "nld",
		nld: "nld",
		polish: "pol",
		pl: "pol",
		pol: "pol",
		turkish: "tur",
		tr: "tur",
		tur: "tur",
		thai: "tha",
		th: "tha",
		tha: "tha",
		vietnamese: "vie",
		vi: "vie",
		vie: "vie",
		indonesian: "ind",
		id: "ind",
		ind: "ind",
		multi: "Multi",
		multiple: "Multi",
	};

	/**
	 * Extract rich metadata from a Stremio-format stream object.
	 * Returns a normalized metadata object with resolution, quality, codec,
	 * audioChannels, audioLang, hdr, size, group, extra, and source fields.
	 */
	function extractStreamMetadata(s) {
		if (!s || typeof s !== "object") return {};
		var meta = {};

		// ---- Collect searchable text from all fields ----
		var searchText = "";
		var textFields = [
			s.name,
			s.title,
			s.description,
			s.source,
			s.label,
			s.server,
			s.filename,
		];
		for (var ti = 0; ti < textFields.length; ti++) {
			if (textFields[ti]) searchText += " " + String(textFields[ti]);
		}

		// ---- Extract from behaviorHints ----
		var bh = s.behaviorHints || s.behaviourHints || {};
		if (bh.videoSize > 0) meta.size = bh.videoSize;
		if (bh.filename) {
			searchText += " " + bh.filename;
			meta.filename = bh.filename;
		}
		if (bh.videoHash) meta.videoHash = bh.videoHash;
		if (bh.bingeGroup) meta.bingeGroup = bh.bingeGroup;

		// ---- Extract from clientResolve (debrid metadata) ----
		var cr = s.clientResolve || {};
		if (cr.raw && cr.raw.parsed) {
			var parsed = cr.raw.parsed;
			if (parsed.resolution) meta.resolution = String(parsed.resolution);
			if (parsed.quality) meta.quality = String(parsed.quality);
			if (parsed.codec) meta.codec = String(parsed.codec);
			if (Array.isArray(parsed.hdr) && parsed.hdr.length) meta.hdr = parsed.hdr;
			if (Array.isArray(parsed.audio) && parsed.audio.length)
				meta.audioTags = parsed.audio;
			if (Array.isArray(parsed.channels) && parsed.channels.length)
				meta.audioChannels = parsed.channels;
			if (Array.isArray(parsed.languages) && parsed.languages.length)
				meta.languages = parsed.languages;
			if (parsed.group) meta.group = String(parsed.group);
			if (parsed.edition) meta.edition = String(parsed.edition);
			if (parsed.raw_title) meta.rawTitle = String(parsed.raw_title);
			if (parsed.bit_depth) meta.bitDepth = String(parsed.bit_depth);
		}
		if (cr.type === "debrid" && cr.service) meta.debridService = cr.service;
		if (cr.isCached !== undefined) meta.isCached = cr.isCached;

		// ---- Size extraction from title (e.g. "2.5 GB", "850 MB", "1,234 MB") ----
		if (!meta.size) {
			var sizeMatch = searchText.match(
				/(\d+(?:[.,]\d+)?)\s*(GB|GiB|MB|MiB)\b/i,
			);
			if (sizeMatch) {
				var numStr = sizeMatch[1].replace(/,/g, "");
				var num = parseFloat(numStr);
				if (!isNaN(num) && num > 0) {
					var unit = sizeMatch[2].toUpperCase();
					meta.size =
						unit === "GB" || unit === "GIB"
							? Math.round(num * 1073741824)
							: Math.round(num * 1048576);
				}
			}
		}

		// ---- Resolution extraction ----
		// Priority: parsed field > name/title extraction > search text
		if (!meta.resolution) {
			var resMatch = searchText.match(
				/\b(2160|1440|1080|720|576|480|360)\s*p\b/i,
			);
			if (resMatch) meta.resolution = resMatch[1] + "p";
		}
		if (!meta.resolution) {
			var resMatch2 = searchText.match(/\b(4K|2K|HD|SD|FHD|UHD)\b/i);
			if (resMatch2) {
				var resLabel = resMatch2[1].toUpperCase();
				if (resLabel === "4K" || resLabel === "UHD") meta.resolution = "2160p";
				else if (resLabel === "2K") meta.resolution = "1440p";
				else if (resLabel === "FHD") meta.resolution = "1080p";
				else if (resLabel === "HD") meta.resolution = "720p";
				else if (resLabel === "SD") meta.resolution = "480p";
			}
		}

		// ---- Quality extraction (WEB-DL, BluRay, WEBRip, etc.) ----
		if (!meta.quality) {
			var qualMatch = searchText.match(
				/\b(BLURAY|BluRay|WEB[-._ ]?DL|WEBRip|HDTV|DVDRip|HDRip|CAM|TS|TC|SCR|REMUX)\b/i,
			);
			if (qualMatch) {
				meta.quality = qualMatch[1].replace(/[-_. ]/g, "");
				// Normalize quality names
				var qMap = {
					BLURAY: "BluRay",
					WEBDL: "WEB-DL",
					"WEB.DL": "WEB-DL",
					WEBRIP: "WEBRip",
					HDTV: "HDTV",
					HDRIP: "HDRip",
					DVDRIP: "DVDRip",
					REMUX: "REMUX",
				};
				meta.quality = qMap[meta.quality.toUpperCase()] || meta.quality;
			}
		}

		// ---- Codec extraction ----
		if (!meta.codec) {
			var codecMatch = searchText.match(
				/\b(H\.?264|H\.?265|HEVC|AVC|x264|x265|AV1|VP9|MPEG-?2|DIVX|XVID)\b/i,
			);
			if (codecMatch) {
				var c = codecMatch[1];
				// Normalize
				if (/^H\.?264$/i.test(c)) meta.codec = "H.264";
				else if (/^H\.?265$/i.test(c) || /^HEVC$/i.test(c)) meta.codec = "HEVC";
				else if (/^AVC$/i.test(c)) meta.codec = "AVC";
				else if (/^x264$/i.test(c)) meta.codec = "x264";
				else if (/^x265$/i.test(c)) meta.codec = "x265";
				else if (/^AV1$/i.test(c)) meta.codec = "AV1";
				else if (/^VP9$/i.test(c)) meta.codec = "VP9";
				else meta.codec = c.toUpperCase();
			}
		}

		// ---- Audio channels extraction (only known channel configs) ----
		if (!meta.audioChannels || !meta.audioChannels.length) {
			var chMatch = searchText.match(
				/\b(7\.1[04]?|5\.1[04]?|2\.0|6\.1|3\.0)\b/,
			);
			if (chMatch) meta.audioChannels = [chMatch[1]];
		}
		// Also check for Atmos
		if (!meta.audioTags || !meta.audioTags.length) {
			if (/\bAtmos\b/i.test(searchText)) meta.audioTags = ["Atmos"];
			if (/\bDDP\d*\.?\d*\b/i.test(searchText)) {
				if (!meta.audioTags) meta.audioTags = [];
				meta.audioTags.push("DD+");
			}
			if (/\b(AC3|AAC|DTS|FLAC|OPUS)\b/i.test(searchText)) {
				if (!meta.audioTags) meta.audioTags = [];
				var am = searchText.match(/\b(AC3|AAC|DTS|FLAC|OPUS)\b/i);
				if (am) meta.audioTags.push(am[1].toUpperCase());
			}
		}

		// ---- Language detection ----
		if (!meta.languages || !meta.languages.length) {
			// Detect from name/title
			meta.languages = [];
			var lowerText = searchText.toLowerCase();
			// Check for language names or codes in text
			if (/\b(hindi|hin)\b/i.test(lowerText)) meta.languages.push("hin");
			if (/\b(telugu|tel)\b/i.test(lowerText)) meta.languages.push("tel");
			if (/\b(tamil|tam)\b/i.test(lowerText)) meta.languages.push("tam");
			if (/\b(malayalam|mal)\b/i.test(lowerText)) meta.languages.push("mal");
			if (/\b(kannada|kan)\b/i.test(lowerText)) meta.languages.push("kan");
			if (/\b(english|eng)\b/i.test(lowerText)) meta.languages.push("eng");
			if (/\b(japanese|jpn|ja)\b/i.test(lowerText)) meta.languages.push("jpn");
			if (/\b(korean|kor|ko)\b/i.test(lowerText)) meta.languages.push("kor");
			// Multi / dual audio flag
			if (/\b(multi|dual)\s*(audio|lang|dubbed)\b/i.test(lowerText)) {
				if (meta.languages.length > 1) {
					/* already have multiple */
				} else if (!meta.languages.length) meta.languages.push("Multi");
			}
			// Deduplicate languages
			meta.languages = meta.languages.filter(function (l, i, a) {
				return a.indexOf(l) === i;
			});
		}

		// ---- HDR flags ----
		if (!meta.hdr || !meta.hdr.length) {
			meta.hdr = [];
			if (/\bHDR10\b/i.test(searchText)) meta.hdr.push("HDR10");
			if (/\b(DoVi|Dolby[_\s]?Vision|DV)\b/i.test(searchText))
				meta.hdr.push("DV");
			if (/\bHDR10\+/i.test(searchText)) meta.hdr.push("HDR10+");
			if (/\bHLG\b/i.test(searchText)) meta.hdr.push("HLG");
			if (/\bIMAX\b/i.test(searchText)) meta.hdr.push("IMAX");
			if (/\b3D\b/i.test(searchText)) meta.hdr.push("3D");
			if (/\b10\s*bit\b/i.test(searchText)) meta.hdr.push("10bit");
			if (meta.hdr.length === 0 && /\bHDR\b/i.test(searchText))
				meta.hdr.push("HDR");
		}

		// ---- Extract "extra" info (remaining descriptive text) ----
		var extraParts = [];
		if (meta.group) extraParts.push(meta.group);
		if (meta.edition) extraParts.push(meta.edition);
		if (meta.bitDepth) extraParts.push(meta.bitDepth + "bit");
		if (meta.debridService) extraParts.push(meta.debridService);
		if (meta.isCached !== undefined)
			extraParts.push(meta.isCached ? "Cached" : "Uncached");

		// Extract release group from filename patterns
		if (!meta.group) {
			var groupMatch = searchText.match(/- ([A-Z0-9]+)$/);
			if (groupMatch) {
				meta.group = groupMatch[1];
				extraParts.push(meta.group);
			}
		}

		meta.extra = extraParts.length ? extraParts.join(" ") : "";

		return meta;
	}

	/**
	 * Format a stream name using the user's requested format:
	 * {resolution or quality} - {size} - {audioLang} - {codec} - {extra} [{plugin}]
	 */
	function formatStreamName(meta, providerName, manifestName) {
		if (!meta || !Object.keys(meta).length) return providerName || "Stream";

		// ---- Resolution label (use actual number e.g. "2160p", "1080p") ----
		var resLabel = "";
		if (meta.resolution) {
			resLabel = meta.resolution;
		} else if (meta.quality) {
			resLabel = meta.quality;
		}

		// ---- Size formatting ----
		var sizeLabel = "";
		if (meta.size > 0) {
			var bytes = meta.size;
			if (bytes >= 1073741824) {
				sizeLabel = (bytes / 1073741824).toFixed(1) + "GB";
			} else if (bytes >= 1048576) {
				sizeLabel = (bytes / 1048576).toFixed(0) + "MB";
			} else if (bytes >= 1024) {
				sizeLabel = (bytes / 1024).toFixed(0) + "KB";
			} else {
				sizeLabel = bytes + "B";
			}
		}

		// ---- Audio language (3-letter code) ----
		var audioLangLabel = "";
		if (meta.languages && meta.languages.length) {
			// Use first language that's a 3-letter code
			for (var li = 0; li < meta.languages.length; li++) {
				var lang = meta.languages[li].toLowerCase();
				if (lang.length === 3 && LANG_MAP[lang]) {
					audioLangLabel = lang.charAt(0).toUpperCase() + lang.slice(1);
					break;
				}
			}
			if (!audioLangLabel) {
				// Translate any language name to 3-letter code
				var firstLang = String(meta.languages[0]).toLowerCase();
				if (LANG_MAP[firstLang]) {
					var code = LANG_MAP[firstLang];
					audioLangLabel = code.charAt(0).toUpperCase() + code.slice(1);
				} else {
					audioLangLabel = firstLang.substring(0, 3);
					audioLangLabel =
						audioLangLabel.charAt(0).toUpperCase() + audioLangLabel.slice(1);
				}
			}
		}

		// ---- Codec label ----
		var codecLabel = meta.codec || "";

		// ---- Extra info ----
		var extraLabel = meta.extra || "";

		// ---- Build the formatted name ----
		var parts = [];
		if (resLabel) parts.push(resLabel);
		if (sizeLabel) parts.push(sizeLabel);
		if (audioLangLabel) parts.push(audioLangLabel);
		if (codecLabel) parts.push(codecLabel);
		if (extraLabel) parts.push(extraLabel);

		// ---- Template-based rendering (uses NAMING_CFG.format) ----
		var fmt = NAMING_CFG.format;
		if (fmt && fmt.indexOf("{") >= 0) {
			var vals = {
				"{resolution}": resLabel,
				"{quality}": meta.quality || "",
				"{size}": sizeLabel,
				"{audioLang}": audioLangLabel,
				"{codec}": codecLabel,
				"{extra}": extraLabel,
				"{plugin}": providerName || _pluginName,
				"{provider}": providerName || "",
				"{manifest}": manifestName || providerName || "",
				"{audioChannels}":
					meta.audioChannels && meta.audioChannels.length
						? meta.audioChannels.join("/")
						: "",
				"{hdr}": meta.hdr && meta.hdr.length ? meta.hdr.join("/") : "",
			};
			var name = fmt;
			for (var vk in vals) {
				if (Object.prototype.hasOwnProperty.call(vals, vk) && vals[vk]) {
					name = name.split(vk).join(vals[vk]);
				}
			}
			// Remove any remaining unreplaced template placeholders
			name = name.replace(/\{[^}]+\}/g, "").trim();
			// Clean up double separators and extra whitespace
			name = name
				.replace(/\s*-\s*-\s*/g, " - ")
				.replace(/\s*-\s+(?=\[)/g, " ") // remove trailing - before [provider] etc.
				.replace(/\s+/g, " ")
				.trim();
			// Remove leading/trailing separator artifacts
			name = name
				.replace(/^[-·.\s]+/, "")
				.replace(/[-·.\s]+$/, "")
				.trim();
			if (!name) name = providerName || "Stream";
			return name;
		}

		// ---- Fallback: programmatic format ----
		var parts = [];
		if (resLabel) parts.push(resLabel);
		if (sizeLabel) parts.push(sizeLabel);
		if (audioLangLabel) parts.push(audioLangLabel);
		if (codecLabel) parts.push(codecLabel);
		if (extraLabel) parts.push(extraLabel);

		var name = parts.join(NAME_SEP);

		// ---- Append manifest name as suffix ----
		if (NAMING_CFG.showPluginSuffix) {
			name += " [" + (manifestName || providerName || _pluginName) + "]";
		}

		return name || providerName || "Stream";
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
	function isValidStreamUrl(url) {
		if (!url || typeof url !== "string") return false;
		if (url.indexOf("https://") !== 0 && url.indexOf("http://") !== 0)
			return false;
		var host;
		try {
			var parsed = new URL(url);
			host = parsed.hostname.toLowerCase();
		} catch (e) {
			return false;
		}
		// Block localhost and unspecified
		if (host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0")
			return false;
		// Block IPv4 private ranges
		if (
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
		// Block IPv6 loopback (::1), unspecified (::), and mapped-IPv4
		if (
			host === "::1" ||
			host === "::" ||
			host === "0:0:0:0:0:0:0:1" ||
			host === "0:0:0:0:0:0:0:0"
		)
			return false;
		// Block IPv6 Unique Local Addresses (ULA fc00::/7)
		if (host.indexOf("fc") === 0 && host.indexOf(":") > 2) return false;
		if (host.indexOf("fd") === 0 && host.indexOf(":") > 2) return false;
		// Block IPv6 link-local addresses (fe80::/10)
		if (/^fe[89ab][0-9a-f]:/i.test(host)) return false;
		// Block IPv6-mapped IPv4 ::ffff:x.x.x.x
		if (host.indexOf("::ffff:") === 0 && host.lastIndexOf(".") > 7) {
			var ipv4Part = host.substring(7);
			var octets = ipv4Part.split(".");
			if (octets.length === 4) {
				if (octets[0] === "127" || octets[0] === "0" || octets[0] === "10")
					return false;
				if (octets[0] === "192" && octets[1] === "168") return false;
				if (
					octets[0] === "172" &&
					parseInt(octets[1], 10) >= 16 &&
					parseInt(octets[1], 10) <= 31
				)
					return false;
			}
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
		} catch (e) {
			/* ignore */
		}
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
						var srcName = (data && (data.name || data.author)) || "";
						if (!srcName) {
							// Extract human-readable name from URL using URL parser
							try {
								var u = new URL(res.url);
								var parts = u.pathname.split("/").filter(Boolean);
								// GitHub raw URLs: raw.githubusercontent.com/OWNER/REPO/refs/... → REPO
								// GitHub web URLs: github.com/OWNER/REPO/raw/... → REPO
								if (
									u.hostname === "raw.githubusercontent.com" ||
									u.hostname === "github.com"
								) {
									if (parts.length >= 2) {
										srcName = parts[1]; // repo name is always second segment
									}
								} else {
									// Generic: last non-empty, non-extension segment
									for (var ri = parts.length - 1; ri >= 0; ri--) {
										if (parts[ri] && !parts[ri].includes(".")) {
											srcName = parts[ri];
											break;
										}
									}
								}
							} catch (e) {
								// URL parsing failed, fallback to string split
								var urlParts = res.url.split("/");
								for (var ri = urlParts.length - 1; ri >= 0; ri--) {
									if (urlParts[ri] && !urlParts[ri].includes(".")) {
										srcName = urlParts[ri];
										break;
									}
								}
							}
							if (!srcName) srcName = "Unknown";
						}
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
						resolve({
							provider: p,
							streams: [],
							error: new Error("timeout"),
						});
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
												resolve({
													provider: p,
													streams: [],
													error: e,
												});
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
		if (!h || h.calls < 2) return 0.9;
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
			_currentConcurrency = Math.min(
				CONCUR_MAX,
				_currentConcurrency + ADAPT_CFG.incStep,
			);
		} else if (recentLatencyMs > ADAPT_CFG.targetMs * 1.4) {
			_currentConcurrency = Math.max(
				CONCUR_MIN,
				_currentConcurrency - ADAPT_CFG.decStep,
			);
		}
	}

	// ---- Batched runner -------------------------------------------------------
	function runProvidersBatched(providers, ctx) {
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

	// ==========================================================================
	// ENHANCED STREAM NORMALIZER + DEDUP
	// ==========================================================================

	function safeStreamUrl(raw) {
		if (!raw) return null;
		var u = raw.url && typeof raw.url === "string" ? raw.url : raw;
		if (typeof u !== "string") return null;
		u = u.trim();
		if (u.length > LIMIT_STREAM_URL) return null;
		if (/^magic_proxy_v[12]_/i.test(u)) return u;
		if (/^magic_m3u8:/i.test(u)) return u;
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

	/**
	 * Normalize a stream from a provider into a SkyStream StreamResult.
	 * Enhanced with rich metadata extraction and custom naming.
	 */
	function normalizeStream(s, p) {
		if (!s || typeof s !== "object") return null;

		// --- Extract URL from various possible fields ---
		var url = safeStreamUrl(
			s.url || s.streamUrl || s.link || s.file || s.src || s.externalUrl,
		);
		if (!url) return null;

		// --- Extract rich metadata from the Stremio-format stream object ---
		var meta = extractStreamMetadata(s);

		// --- Build the stream source/name using custom naming format ---
		var providerName = p ? p.name || "Unknown" : "Unknown";
		var manifestName = p ? p.sourceName || "" : "";
		var sourceName = formatStreamName(meta, providerName, manifestName);

		// --- Build output StreamResult ---
		var out = {
			url: url,
			source: sourceName,
		};

		// --- Preserve original quality field for sorting ---
		if (meta.resolution) out.quality = meta.resolution;
		else if (meta.quality) out.quality = meta.quality;
		else {
			var fallbackQuality = extractQuality(sourceName);
			if (fallbackQuality) out.quality = fallbackQuality;
		}

		// --- Headers sanitization ---
		if (s.headers && typeof s.headers === "object") {
			var SAFE_HDRS_MAP = {
				"user-agent": 1,
				referer: 1,
				origin: 1,
				accept: 1,
				"accept-language": 1,
				"x-requested-with": 1,
				"x-request-x": 1,
				cookie: 1,
				authorization: 1,
			};
			var clean = {};
			for (var hk in s.headers) {
				if (Object.prototype.hasOwnProperty.call(s.headers, hk)) {
					var hkLower = String(hk).toLowerCase();
					if (
						hkLower === "range" ||
						hkLower === "connection" ||
						hkLower === "keep-alive"
					)
						continue;
					if (SAFE_HDRS_MAP[hkLower]) {
						clean[hk] = s.headers[hk];
					}
				}
			}
			if (Object.keys(clean).length) out.headers = clean;
		}

		// --- Stream type detection ---
		var ul = String(url).toLowerCase();
		if (ul.indexOf(".m3u8") > 0) out.type = "hls";
		else if (ul.indexOf(".mp4") > 0) out.type = "mp4";
		else if (ul.indexOf(".mkv") > 0) out.type = "mkv";
		else if (ul.indexOf(".webm") > 0) out.type = "webm";

		// --- DRM ---
		if (s.drmKid) out.drmKid = s.drmKid;
		if (s.drmKey) out.drmKey = s.drmKey;
		if (s.licenseUrl || s.license || s.drmLicenseUrl)
			out.licenseUrl = s.licenseUrl || s.license || s.drmLicenseUrl;

		// --- Subtitles ---
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

		return out;
	}

	function extractQuality(name) {
		var s = String(name || "");
		var m = s.match(/(2160p|1440p|1080p|720p|480p|360p|4K|2K|HD|SD)/i);
		return m ? m[1] : "";
	}

	function urlFingerprint(u) {
		var s = String(u).split("#")[0];
		return s
			.replace(/[?&]_=\d+/g, "")
			.replace(/[?&]t=\d+/g, "")
			.replace(/[?&]e=\d+/g, "")
			.replace(/[?&]exp=\d+/g, "");
	}

	/**
	 * Enhanced deduplication: preserve streams that have unique metadata
	 * even if they share the same URL (e.g., different audio tracks,
	 * different codecs for same resolution).
	 */
	function dedupStreams(streams) {
		var seen = {},
			out = [];
		for (var i = 0; i < streams.length; i++) {
			var s = streams[i];
			if (!s || !s.url || !s.source) continue;

			// Use source (formatted name) + URL fingerprint for dedup key
			// This preserves streams with different metadata/names
			// pointing to the same URL
			var fp = urlFingerprint(s.url);
			// Normalize source for comparison
			var srcNorm = String(s.source).toLowerCase().trim();
			// Remove [pluginname] suffix for comparison
			srcNorm = srcNorm.replace(/\s*\[.*?\]\s*$/, "").trim();
			var key = srcNorm + "|" + fp;

			// Fallback: if same URL but different quality, keep both
			if (seen[key]) {
				// Check if different quality
				var existingQ = seen[key].quality || "";
				var thisQ = s.quality || "";
				if (thisQ && thisQ !== existingQ) {
					var keyWithQ = key + "|" + thisQ;
					if (seen[keyWithQ]) continue;
					seen[keyWithQ] = s;
				} else {
					continue;
				}
			} else {
				seen[key] = s;
			}
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
		var hardTimer = setTimeout(finish, T_HOME_TOTAL);
		HOME_CATEGORIES.forEach(function (cat) {
			var elapsed = Date.now() - startTime;
			var remaining = Math.max(2000, T_HOME_TOTAL - elapsed - 500);
			var budget = Math.min(T_HOME_CAT, remaining);
			var budgetTimer = setTimeout(function () {}, budget);
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
				tmdbGet("search/movie", {
					query: q,
					page: 1,
					include_adult: false,
				}),
				tmdbGet("search/tv", {
					query: q,
					page: 1,
					include_adult: false,
				}),
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
			return {
				tmdbId: m[1],
				mediaType: "movie",
				season: null,
				episode: null,
			};
		if ((m = s.match(/^tmdb:(movie|series|tv):(\d+)/i)))
			return {
				tmdbId: m[2],
				mediaType: m[1].toLowerCase() === "movie" ? "movie" : "series",
				season: null,
				episode: null,
			};
		if ((m = s.match(/^(\d+)$/)))
			return {
				tmdbId: m[1],
				mediaType: "movie",
				season: null,
				episode: null,
			};
		if ((m = s.match(/(\d{2,})/)))
			return {
				tmdbId: m[1],
				mediaType: "movie",
				season: null,
				episode: null,
			};
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
			var timeoutTimer = setTimeout(function () {
				log("load: timeout (" + T_DETAIL + "ms), returning minimal item");
				safe({ success: true, data: minimalItem(parsed, tmdbId) });
			}, T_DETAIL);
			tmdbGet(apiType + "/" + tmdbId, {
				append_to_response: "credits,videos,external_ids",
			})
				.then(function (data) {
					if (!data)
						return safe({
							success: true,
							data: minimalItem(parsed, tmdbId),
						});
					var isSeries = apiType === "tv";
					var title =
						data.title ||
						data.name ||
						data.original_title ||
						data.original_name ||
						"Unknown";
					var year = parseInt(
						(data.release_date || data.first_air_date || "").split("-")[0],
						10,
					);
					if (year && (year <= 1900 || year >= 2200)) year = undefined;
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
								year: year || undefined,
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

	// ---- loadStreams -----------------------------------------------------------
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
			try {
				var normalized = [];
				for (var si = 0; si < allStreams.length; si++) {
					var ns = normalizeStream(
						allStreams[si].stream,
						allStreams[si].provider,
					);
					if (ns) normalized.push(ns);
				}
				var deduped = dedupStreams(normalized);
				if (deduped.length) {
					setCachedStreams(key, deduped);
					log(
						"loadStreams: delivering " +
							deduped.length +
							" unique streams (from " +
							normalized.length +
							" normalized, " +
							allStreams.length +
							" raw)",
					);
					cb({ success: true, data: deduped });
				} else {
					log("loadStreams: no streams found");
					cb({ success: true, data: [] });
				}
			} catch (e) {
				warn("deliver error: " + (e.message || e));
				cb({ success: true, data: [] });
			}
		}

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
				prefetchAllProviderCodes(matching);
				runProvidersBatched(matching, ctx).then(function (results) {
					for (var i = 0; i < results.length; i++) {
						var r = results[i];
						if (!r || !Array.isArray(r.streams)) continue;
						for (var j = 0; j < r.streams.length; j++) {
							if (settled) break; // Guard against concurrent race
							allStreams.push({
								stream: r.streams[j],
								provider: r.provider,
							});
						}
						if (settled) break;
					}
					if (!settled) deliver();
				});
			})
			.catch(function (e) {
				warn("loadStreams: getProviders failed " + (e.message || e));
				deliver();
			});
	}

	// ---- Health Check API -----------------------------------------------------
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
				naming: {
					format: NAMING_CFG.format,
					showPluginSuffix: NAMING_CFG.showPluginSuffix,
				},
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
		if (_warmingQueue.length >= WARM_CFG.maxItems * 2) return;
		_warmingQueue.push(url);
		_processWarmingQueue();
	}

	function _processWarmingQueue() {
		if (_warmingActive || !_warmingQueue.length) return;
		_warmingActive = true;
		var url = _warmingQueue.shift();
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
		if (getCachedStreams(key)) {
			_warmingActive = false;
			_processWarmingQueue();
			return;
		}
		log("cache warming: pre-fetching streams for " + url);
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
					var rawStreams = [];
					for (var i = 0; i < results.length; i++) {
						var r = results[i];
						if (!r || !Array.isArray(r.streams)) continue;
						for (var j = 0; j < r.streams.length; j++) {
							rawStreams.push({
								stream: r.streams[j],
								provider: r.provider,
							});
						}
					}
					var normalized = [];
					for (var si = 0; si < rawStreams.length; si++) {
						var ns = normalizeStream(
							rawStreams[si].stream,
							rawStreams[si].provider,
						);
						if (ns) normalized.push(ns);
					}
					var deduped = dedupStreams(normalized);
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
