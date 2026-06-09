(function () {
	"use strict";

	var TAG = "NuvioBridge";

	// ---- Config ----------------------------------------------------------------

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

	var T_MANIFEST = 10000;
	var T_CODE = 10000;
	var T_PROVIDER = 12000;
	var T_TOTAL = 70000;
	var T_TMDB = 6000;
	var T_HOME_TOTAL = 10000;
	var T_HOME_CAT = 5000;
	var T_SEARCH = 7000;
	var T_DETAIL = 12000;
	var T_SEASON = 5000;

	var PROVIDER_CONCURRENCY = 6;

	var CACHE_TTL = {
		manifest: 30 * 60 * 1000,
		code: 60 * 60 * 1000,
		streams: 30 * 60 * 1000,
	};

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
	var _failedProviderTTL = 10 * 60 * 1000;

	// ---- Logging ---------------------------------------------------------------

	function log() {
		try {
			console.log.apply(
				console,
				["[" + TAG + "]"].concat([].slice.call(arguments)),
			);
		} catch (e) {}
	}
	function warn() {
		try {
			console.warn.apply(
				console,
				["[" + TAG + "]"].concat([].slice.call(arguments)),
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
		function hexOf(buf) {
			var u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
			var s = "";
			for (var i = 0; i < u8.length; i++)
				s += (u8[i] < 16 ? "0" : "") + u8[i].toString(16);
			return s;
		}
		function strToUtf8(s) {
			var b = [];
			for (var i = 0; i < s.length; i++) {
				var c = s.charCodeAt(i);
				if (c < 0x80) b.push(c);
				else if (c < 0x800) {
					b.push(0xc0 | (c >> 6));
					b.push(0x80 | (c & 0x3f));
				} else {
					b.push(0xe0 | (c >> 12));
					b.push(0x80 | ((c >> 6) & 0x3f));
					b.push(0x80 | (c & 0x3f));
				}
			}
			return new Uint8Array(b);
		}
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

	function httpPost(url, headers, body, ms) {
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
					http_post(url, headers, body || "", function (r) {
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

	var _codeCache = {};
	var _codeCacheKeys = [];
	var _codeCacheCap = 64;

	function fetchProviderCode(url) {
		var hit = _codeCache[url];
		if (hit && Date.now() - hit.at < CACHE_TTL.code)
			return Promise.resolve(hit.body);
		return httpGet(url, HDR_HTML, T_CODE).then(function (r) {
			if (r.status < 200 || r.status >= 300 || !r.body) return null;
			if (!_codeCache[url]) {
				_codeCache[url] = { body: r.body, at: Date.now() };
				_codeCacheKeys.push(url);
				while (_codeCacheKeys.length > _codeCacheCap)
					delete _codeCache[_codeCacheKeys.shift()];
			} else {
				_codeCache[url].at = Date.now();
			}
			return r.body;
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

	// ---- Per-provider runner --------------------------------------------------

	function runProvider(p, ctx) {
		return new Promise(function (resolve) {
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
						resolve({ provider: p, streams: [], error: new Error("code-404") });
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
										resolve({ provider: p, streams: [], error: e });
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
							_failedProviders[p.url] = Date.now();
							resolve({ provider: p, streams: [], error: e });
						}
					}
				})
				.catch(function (e) {
					if (!done) {
						clearTimeout(t);
						done = true;
						resolve({ provider: p, streams: [], error: e });
					}
				});
		});
	}

	// ---- Batched runner -------------------------------------------------------

	function runProvidersBatched(providers, ctx) {
		return new Promise(function (resolve) {
			var settled = false;
			var globalT = setTimeout(function () {
				if (!settled) {
					settled = true;
					log(
						"loadStreams: global timeout (70s) — returning " +
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
					idx < providers.length &&
					_failedProviders[providers[idx].url] &&
					Date.now() - _failedProviders[providers[idx].url] < _failedProviderTTL
				) {
					idx++;
				}
				if (idx >= providers.length) {
					if (inFlight === 0) {
						clearTimeout(globalT);
						settled = true;
						resolve(results);
					}
					return;
				}
				var p = providers[idx++];
				inFlight++;
				runProvider(p, ctx)
					.then(function (r) {
						inFlight--;
						if (r.streams && r.streams.length) results.push(r);
						startNext();
					})
					.catch(function () {
						inFlight--;
						startNext();
					});
			}

			for (var i = 0; i < Math.min(PROVIDER_CONCURRENCY, providers.length); i++)
				startNext();
		});
	}

	// ---- Stream normaliser + dedup -------------------------------------------

	function safeStreamUrl(raw) {
		if (!raw) return null;
		var u = raw.url && typeof raw.url === "string" ? raw.url : raw;
		if (typeof u !== "string") return null;
		u = u.trim();
		if (u.length > 4096) return null;
		if (/^(https?|ftp|magnet):\/\//i.test(u)) return u;
		if (/^magic_proxy_v[12]_/i.test(u)) return u;
		if (/^magic_m3u8:/i.test(u)) return u;
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
		if (s.headers && typeof s.headers === "object") out.headers = s.headers;
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
		var results = Object.create(null),
			pending = HOME_CATEGORIES.length,
			done = false,
			start = Date.now();
		function maybeFinish() {
			if (!done) {
				done = true;
				log(
					"getHome: " +
						Object.keys(results).length +
						"/" +
						HOME_CATEGORIES.length +
						" categories in " +
						(Date.now() - start) +
						"ms",
				);
				cb({ success: true, data: results, page: pn });
			}
		}
		var hardTimer = setTimeout(maybeFinish, T_HOME_TOTAL);
		HOME_CATEGORIES.forEach(function (cat) {
			var budget = Math.max(
				2000,
				Math.min(T_HOME_CAT, T_HOME_TOTAL - (Date.now() - start) - 500),
			);
			var budgetTimer = 0;
			Promise.race([
				cat.build(),
				new Promise(function (res) {
					budgetTimer = setTimeout(function () {
						res({ items: [] });
					}, budget);
				}),
			])
				.then(function (r) {
					if (r && r.items && r.items.length) results[cat.name] = r.items;
				})
				.catch(function () {})
				.then(function () {
					if (budgetTimer) clearTimeout(budgetTimer);
					if (--pending === 0) {
						clearTimeout(hardTimer);
						maybeFinish();
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
		var p1 = tmdbGet("search/multi", {
			query: q,
			page: 1,
			include_adult: false,
		});
		var p2 = Promise.all([
			tmdbGet("search/movie", { query: q, page: 1, include_adult: false }),
			tmdbGet("search/tv", { query: q, page: 1, include_adult: false }),
		]);
		Promise.race([
			Promise.all([p1, p2]).then(function (rs) {
				var seen = {},
					out = [];
				function addAll(items) {
					for (var i = 0; i < items.length; i++)
						if (!seen[items[i].url]) {
							seen[items[i].url] = true;
							out.push(items[i]);
						}
				}
				addAll(fromResults(rs[0]));
				addAll(fromResults(rs[1][0], "movie"));
				addAll(fromResults(rs[1][1], "series"));
				return out.slice(0, 60);
			}),
			new Promise(function (res) {
				setTimeout(function () {
					res(null);
				}, T_SEARCH);
			}),
		])
			.then(function (out) {
				if (out && out.length) return cb({ success: true, data: out });
				p1.then(function (d) {
					cb({ success: true, data: fromResults(d).slice(0, 60) });
				}).catch(function () {
					cb({ success: true, data: [] });
				});
			})
			.catch(function () {
				cb({ success: true, data: [] });
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
			function safe(r) {
				if (!settled) {
					settled = true;
					clearTimeout(t);
					cb(r);
				}
			}
			var t = setTimeout(function () {
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
						pending = real.length,
						seasonIdx = 0,
						seasonInFlight = 0,
						SEASON_CONCURRENCY = 6;
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
										if (--pending === 0) {
											allEps.sort(function (a, b) {
												return a.season - b.season || a.episode - b.episode;
											});
											finish(allEps);
											return;
										}
										startNextSeason();
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

	// ---- loadStreams ---------------------------------------------------------

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

		var done = false;
		function safe(streams) {
			if (done) return;
			done = true;
			var deduped = dedupStreams(streams || []);
			if (deduped.length) setCachedStreams(key, deduped);
			log("loadStreams: " + deduped.length + " unique streams");
			cb({ success: true, data: deduped });
		}

		getProviders()
			.then(function (providers) {
				if (!providers || !providers.length) {
					warn("loadStreams: no providers");
					safe([]);
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

				log(
					"loadStreams: fanning out to " +
						matching.length +
						" providers for " +
						ctx.mediaType +
						" " +
						ctx.tmdbId +
						" (70s timeout)",
				);
				runProvidersBatched(matching, ctx).then(function (results) {
					var all = [];
					for (var i = 0; i < results.length; i++) {
						var r = results[i];
						if (!r || !Array.isArray(r.streams)) continue;
						for (var j = 0; j < r.streams.length; j++) {
							var s = normalizeStream(r.streams[j], r.provider);
							if (s) all.push(s);
						}
					}
					safe(all);
				});
			})
			.catch(function (e) {
				warn("loadStreams: getProviders failed " + (e.message || e));
				safe([]);
			});
	}

	// ---- Exports --------------------------------------------------------------

	globalThis.getHome = getHome;
	globalThis.search = search;
	globalThis.load = load;
	globalThis.loadStreams = loadStreams;

	var manCount =
		typeof manifest !== "undefined" && Array.isArray(manifest.nuvioManifests)
			? manifest.nuvioManifests.length
			: 0;
	log(
		"loaded (manifests=" +
			manCount +
			", providers timeout=12s, total=70s, concurrency=" +
			PROVIDER_CONCURRENCY +
			")",
	);
})();
