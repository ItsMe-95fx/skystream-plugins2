(function () {
	"use strict";

	const UA =
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

	// ─── Torrent Magnet Helpers ──────────────────────────────────────────
	const FALLBACK_TRACKERS = [
		"udp://tracker.opentrackr.org:1337/announce",
		"udp://open.demonii.com:1337/announce",
		"udp://tracker.torrent.eu.org:451/announce",
		"udp://tracker.dler.org:6969/announce",
		"udp://exodus.desync.com:6969/announce",
		"udp://opentracker.i2p.rocks:6969/announce",
		"udp://open.stealth.si:80/announce",
		"udp://tracker.moeking.me:6969/announce",
		"https://trackers.opentracker.pp.ua:443/announce",
		"http://tracker.openbittorrent.com:80/announce",
		"http://tracker.dler.org:80/announce",
	];

	const TRACKER_FETCH_TIMEOUT = 10000;
	const TRACKERS_LIST_URLS = [
		"https://raw.githubusercontent.com/ngosang/trackerslist/master/trackers_all.txt",
		"https://raw.githubusercontent.com/XIU2/TrackersListCollection/master/all.txt",
		"https://raw.githubusercontent.com/XIU2/TrackersListCollection/master/best.txt",
		"https://raw.githubusercontent.com/ngosang/trackerslist/master/trackers_best.txt",
	];

	let TRACKERS = FALLBACK_TRACKERS.slice();
	let _trackersPromise = null;

	const MAX_MAGNET_TRACKERS = 60;

	/**
	 * Fetch tracker lists from GitHub in the background and merge with fallbacks.
	 * Non-blocking — TRACKERS starts with FALLBACK_TRACKERS, gets enriched.
	 */
	function initTrackers() {
		if (_trackersPromise) return _trackersPromise;
		_trackersPromise = new Promise(function (resolve) {
			let timer = setTimeout(function () {
				resolve(FALLBACK_TRACKERS);
			}, TRACKER_FETCH_TIMEOUT);

			Promise.all(
				TRACKERS_LIST_URLS.map(function (url) {
					return http_get(url, JSON_HEADERS).then(function (resp) {
						if (resp && resp.status === 200 && resp.body) {
							let text =
								typeof resp.body === "string" ? resp.body : String(resp.body);
							return text.split("\n").map(function (line) {
								return line.trim();
							});
						}
						return [];
					});
				}),
			)
				.then(function (lists) {
					clearTimeout(timer);
					let all = [];
					lists.forEach(function (list) {
						list.forEach(function (tr) {
							if (
								tr &&
								(tr.indexOf("udp://") === 0 ||
									tr.indexOf("http://") === 0 ||
									tr.indexOf("https://") === 0)
							) {
								all.push(tr);
							}
						});
					});
					// Deduplicate and merge with fallbacks
					let seen = {};
					let merged = FALLBACK_TRACKERS.slice();
					all.forEach(function (tr) {
						if (!seen[tr]) {
							seen[tr] = true;
							merged.push(tr);
						}
					});
					TRACKERS = merged;
					resolve(TRACKERS);
				})
				.catch(function () {
					clearTimeout(timer);
					resolve(FALLBACK_TRACKERS);
				});
		});
		return _trackersPromise;
	}

	function buildMagnet(infoHash, filename, sources) {
		try {
			if (!infoHash) return "";
			let hash = String(infoHash)
				.replace(/[^a-fA-F0-9]/g, "")
				.toLowerCase();
			if (hash.length !== 40) return "";
			let magnet = "magnet:?xt=urn:btih:" + hash;
			if (filename)
				magnet += "&dn=" + encodeURIComponent(String(filename).trim());
			let trackers =
				Array.isArray(sources) && sources.length > 0 ? sources : TRACKERS;
			let count = 0;
			for (
				let ti = 0;
				ti < trackers.length && count < MAX_MAGNET_TRACKERS;
				ti++
			) {
				let tr = String(trackers[ti] || "").trim();
				if (tr.indexOf("tracker:") === 0) tr = tr.substring(8);
				else if (tr.indexOf("dht:") === 0) continue;
				if (
					tr &&
					(tr.indexOf("udp://") === 0 ||
						tr.indexOf("http://") === 0 ||
						tr.indexOf("https://") === 0)
				) {
					magnet += "&tr=" + encodeURIComponent(tr);
					count++;
				}
			}
			return magnet;
		} catch (e) {
			console.warn("[StremioHub] buildMagnet error:", e.message);
			return "";
		}
	}

	const JSON_HEADERS = {
		"User-Agent": UA,
		Accept: "application/json",
		"Accept-Language": "en-US,en;q=0.5",
	};

	// Kick off tracker fetch in background (non-blocking, JSON_HEADERS now available)
	initTrackers();

	// Timeouts
	const ADDON_TIMEOUT = 60000; // 60s per-addon stream fetch (slow addons need time)
	const MANIFEST_TIMEOUT = 15000; // 15s manifest fetch
	const META_FETCH_TIMEOUT = 10000; // 10s metadata fetch

	// Cache TTLs
	const STREAM_RESPONSE_TTL = 1800000; // 30 min — stream response cache (instant replay)
	const MANIFEST_CACHE_TTL = 600000; // 10 min — manifest cache
	const SEARCH_CACHE_TTL = 120000; // 2 min — search cache

	const MAX_SEARCH_RESULTS = 50;
	const MAX_SEARCH_QUERY_LENGTH = 200;
	const CATALOG_PAGE_SIZE = 20;

	// ───── Rate limiting (per-URL) ─────
	const RATE_BACKOFF_MS = 180000; // 3 min backoff
	const RATE_MAX_FAILS = 3;
	let _rateLimits = {};

	// ───── In-memory cache ─────
	let _cache = new Map();
	const CACHE_MAX = 300;

	// ────────────────────────────────────────────────────────────────
	//  SECTION 2: UTILITY FUNCTIONS
	// ────────────────────────────────────────────────────────────────

	function safeStr(s) {
		return String(s == null ? "" : s);
	}

	function safeJson(text, fallback) {
		try {
			return JSON.parse(safeStr(text));
		} catch (e) {
			return fallback !== undefined ? fallback : null;
		}
	}

	function isHttp(s) {
		return s && (s.indexOf("http://") === 0 || s.indexOf("https://") === 0);
	}

	function skyType(t) {
		return t === "movie" || t === "short" ? "movie" : "series";
	}

	function baseUrl(manifestUrl) {
		return (manifestUrl || "")
			.replace(/\/manifest\.json$/, "")
			.replace(/\/$/, "");
	}

	function addonName(url) {
		try {
			let parts = url
				.replace(/https?:\/\//, "")
				.split("/")[0]
				.replace(/^www\./, "")
				.split(".");
			let name = parts[0] || "";
			if (/^[a-f0-9]{8,}$/i.test(name) && parts.length >= 2) {
				name = parts[parts.length - 2];
			}
			name = name.replace(/^[a-f0-9]{6,}-/i, "");
			let tlds = [
				"com",
				"org",
				"net",
				"io",
				"app",
				"dev",
				"tv",
				"co",
				"uk",
				"de",
				"xyz",
				"fun",
				"cloud",
				"me",
				"in",
			];
			if (tlds.indexOf(name) !== -1 || name.length <= 2) {
				for (let ni = 1; ni < parts.length - 1; ni++) {
					if (tlds.indexOf(parts[ni]) === -1 && parts[ni].length > 2) {
						name = parts[ni];
						break;
					}
				}
			}
			name = name.replace(/[-_]/g, " ").replace(/\b\w/g, function (c) {
				return c.toUpperCase();
			});
			return name.trim() || "Addon";
		} catch (e) {
			return "Addon";
		}
	}

	/**
	 * Validate a stream URL — reject empty, data:, private IPs, login pages.
	 */
	function isValidStreamUrl(url) {
		if (!url || typeof url !== "string") return false;
		let trimmed = url.trim();
		if (!trimmed) return false;
		// Reject data: URLs
		if (trimmed.indexOf("data:") === 0) return false;
		// Reject login/logout pages
		if (/\/(login|logout|signin|signup)\.?\w*$/i.test(trimmed)) return false;
		// Must have valid protocol
		if (
			!/^https?:\/\//i.test(trimmed) &&
			trimmed.indexOf("magnet:") !== 0 &&
			trimmed.indexOf("MAGIC_PROXY") !== 0
		)
			return false;
		// Reject private IPs for http/https
		try {
			if (/^https?:\/\//i.test(trimmed)) {
				let u = new URL(trimmed);
				let hn = u.hostname;
				if (
					hn === "localhost" ||
					hn === "127.0.0.1" ||
					hn === "0.0.0.0" ||
					/^10\./.test(hn) ||
					/^172\.(1[6-9]|2\d|3[01])\./.test(hn) ||
					/^192\.168\./.test(hn) ||
					/^169\.254\./.test(hn)
				)
					return false;
			}
		} catch (e) {
			console.warn("[StremioHub] invalid URL check failed:", e.message);
		}
		return true;
	}

	/**
	 * Detect resolution from stream text. Returns { resolution, sortKey }.
	 * sortKey is a numeric priority for sorting (higher = better).
	 */
	function detectResolution(text, lower) {
		let resolution = "Auto";
		let sortKey = 2;

		// Resolution detection (highest priority)
		// Note: avoid \b between digits and 'p' — both are \w in JS
		if (/\b(2160|4k|uhd)\b/i.test(lower) || /2160p?\b/i.test(lower)) {
			resolution = "4K";
			sortKey = 5;
		} else if (/1440p?\b/i.test(lower)) {
			resolution = "1440p";
			sortKey = 4;
		} else if (/1080p?\b|1080i\b/i.test(lower)) {
			resolution = "1080p";
			sortKey = 3;
		} else if (/720p?\b/i.test(lower)) {
			resolution = "720p";
			sortKey = 2;
		} else if (/480p?\b|dvd\b/i.test(lower)) {
			resolution = "480p";
			sortKey = 1;
		} else if (/360p?\b/i.test(lower)) {
			resolution = "360p";
			sortKey = 1;
		} else if (/\b(cam|ts|tc|scr|hqcam)\b/i.test(lower)) {
			resolution = "CAM";
			sortKey = 0;
		}

		// if result has no resolution but has a name, use the name itself as resolution label
		if (resolution === "Auto" && text.length > 1) {
			// Try to use the first meaningful segment of the name
			let firstSeg = text.split(" | ")[0] || text;
			if (firstSeg.length > 1 && firstSeg.length < 20) {
				resolution = firstSeg;
			}
		}

		return { resolution, sortKey };
	}

	function detectCodec(lower) {
		if (/\b(av1|av01)\b/.test(lower)) return "AV1";
		if (/\b(x?v?265|hevc)\b/.test(lower)) return "HEVC";
		if (/\b(x264|h\.?264|avc)\b/.test(lower)) return "H.264";
		if (/\b(vp9)\b/.test(lower)) return "VP9";
		return null;
	}

	function detectHdr(lower) {
		if (/\b(dv|dovi|dolby[\s._-]?vision)\b/.test(lower)) return "DV";
		if (/\bhdr10\+\b/.test(lower)) return "HDR10+";
		if (/\bhdr10\b/.test(lower)) return "HDR10";
		if (/\bhdr\b/.test(lower)) return "HDR";
		return null;
	}

	function detectAudio(lower) {
		if (/\b(atmos|truehd)\b/.test(lower)) return "Atmos";
		if (/\bdts[-\s]?hd\b/.test(lower)) return "DTS-HD";
		if (/\bdts\b/.test(lower)) return "DTS";
		if (/\b(flac|lpcm)\b/.test(lower)) return "FLAC";
		if (/\b(e?aac)\b/.test(lower)) return "AAC";
		if (/\bmp3\b/.test(lower)) return "MP3";
		if (/\bopus\b/.test(lower)) return "Opus";
		return null;
	}

	function detectChannels(lower) {
		let ch = lower.match(/\b[257]\.1\b/);
		return ch ? ch[0] : null;
	}

	function detectSize(text, stream) {
		// Size (GB/MB)
		let sizeMatch = text.match(/(\d+(?:\.\d+)?)\s*(GB|GiB|MB|MiB)/i);
		if (sizeMatch) return sizeMatch[0];
		// Also try stream.size directly
		if (stream.size) return String(stream.size);
		return null;
	}

	function extractPeers(text, stream) {
		// Peers (from direct field or text match for 👥/ peers keyword)
		let peers = stream.peers != null ? Number(stream.peers) : null;
		if (peers == null || peers === 0) {
			let peersMatch = text.match(/👥\s*(\d+)/);
			if (peersMatch) peers = parseInt(peersMatch[1], 10);
		}
		if (peers == null || peers === 0) {
			let peersMatch2 = text.match(
				/(?:^|\s)(\d{2,})\s*(?:peers?|leechers?)\b/i,
			);
			if (peersMatch2) peers = parseInt(peersMatch2[1], 10);
		}
		return peers;
	}

	function extractSeeders(text, stream) {
		// Seeders (from direct field or text match for 🌱/👤 emoji or "seeders" keyword)
		let seeders = stream.seeders != null ? Number(stream.seeders) : null;
		if (seeders == null || seeders === 0) {
			let seedersMatch = text.match(/🌱\s*(\d+)/);
			if (seedersMatch) seeders = parseInt(seedersMatch[1], 10);
		}
		if (seeders == null || seeders === 0) {
			let seedersMatch2 = text.match(/👤\s*(\d+)/);
			if (seedersMatch2) seeders = parseInt(seedersMatch2[1], 10);
		}
		if (seeders == null || seeders === 0) {
			let seedersMatch3 = text.match(/(?:^|\s)(\d{2,})\s*seeders?\b/i);
			if (seedersMatch3) seeders = parseInt(seedersMatch3[1], 10);
		}
		return seeders;
	}

	function detectLanguage(text, lower) {
		// Language tags commonly found in stream names — maps to 3-letter codes
		let langMap = [
			{ regex: /\bmulti\b/i, code: "Mul" },
			{ regex: /\bdual[\s._-]?audio\b/i, code: "Dual" },
			{ regex: /\bhindi\b/i, code: "Hin" },
			{ regex: /\btamil\b/i, code: "Tam" },
			{ regex: /\btelugu\b/i, code: "Tel" },
			{ regex: /\bmalayalam\b/i, code: "Mal" },
			{ regex: /\bkannada\b/i, code: "Kan" },
			{ regex: /\bbengali\b/i, code: "Ben" },
			{ regex: /\bmarathi\b/i, code: "Mar" },
			{ regex: /\bgujarati\b/i, code: "Guj" },
			{ regex: /\bpunjabi\b/i, code: "Pun" },
			{ regex: /\burdu\b/i, code: "Urd" },
			{ regex: /\bjapanese?\b/i, code: "Jpn" },
			{ regex: /\bkorean?\b/i, code: "Kor" },
			{ regex: /\bchinese?\b/i, code: "Chi" },
			{ regex: /\bfrench?\b/i, code: "Fre" },
			{ regex: /\bgerman?\b/i, code: "Ger" },
			{ regex: /\brussian?\b/i, code: "Rus" },
			{ regex: /\bspanish?\b/i, code: "Spa" },
			{ regex: /\benglish\b/i, code: "Eng" },
		];

		// Collect ALL matching languages (not just the first)
		let found = [];
		for (let li = 0; li < langMap.length; li++) {
			if (langMap[li].regex.test(text) || langMap[li].regex.test(lower)) {
				let code = langMap[li].code;
				if (found.indexOf(code) === -1) found.push(code);
			}
		}
		return found.length > 0 ? found.join(" + ") : null;
	}

	/**
	 * Extract quality/resolution and features from a stream's name/title/description.
	 * Uses the stream's NAME attribute directly (no hardcoded mapping beyond pattern detection).
	 */
	function extractStreamInfo(stream) {
		let result = {
			resolution: "Auto",
			codec: null,
			audio: null,
			channels: null,
			hdr: null,
			size: null,
			language: null,
			_sortKey: 2,
		};

		// Build combined text from stream metadata
		let parts = [];
		if (stream.name) parts.push(safeStr(stream.name));
		if (stream.title) parts.push(safeStr(stream.title));
		if (stream.description) parts.push(safeStr(stream.description));
		let text = parts
			.join(" | ")
			.replace(/\n/g, " ")
			.replace(/\s+/g, " ")
			.trim();
		if (!text) return result;

		let lower = text.toLowerCase();

		// Delegate to focused helper functions
		let res = detectResolution(text, lower);
		result.resolution = res.resolution;
		result._sortKey = res.sortKey;
		result.codec = detectCodec(lower);
		result.hdr = detectHdr(lower);
		result.audio = detectAudio(lower);
		result.channels = detectChannels(lower);
		result.size = detectSize(text, stream);
		result.language = detectLanguage(text, lower);
		result.peers = extractPeers(text, stream);
		result.seeders = extractSeeders(text, stream);

		return result;
	}

	/**
	 * Build the tech-info base label (no codec/extras — those are positioned
	 * in display order by assembleStreamResult).
	 * Format: "Size | Resolution"
	 */
	function buildStreamLabel(info) {
		let labelParts = [];

		// Size
		if (info.size) labelParts.push("💾" + info.size);

		// Resolution
		if (info.resolution && info.resolution !== "Auto") {
			labelParts.push("📺" + info.resolution);
		}

		return labelParts.join(" | ").trim();
	}

	// ────────────────────────────────────────────────────────────────
	//  SECTION 3: CACHE SYSTEM (simple in-memory)
	// ────────────────────────────────────────────────────────────────

	function cacheGet(key) {
		if (_cache.has(key)) {
			let entry = _cache.get(key);
			if (Date.now() < entry.expires) {
				// LRU move to end
				_cache.delete(key);
				_cache.set(key, entry);
				return entry.data;
			}
			_cache.delete(key);
		}
		return null;
	}

	function cacheSet(key, data, ttlMs) {
		ttlMs = ttlMs || 60000;
		if (_cache.size >= CACHE_MAX) {
			let oldest = _cache.keys().next().value;
			if (oldest) _cache.delete(oldest);
		}
		_cache.set(key, { data: data, expires: Date.now() + ttlMs });
	}

	// ────────────────────────────────────────────────────────────────
	//  SECTION 4: RATE LIMITING
	// ────────────────────────────────────────────────────────────────

	function rateLimitKey(url) {
		try {
			let u = new URL(url);
			return u.origin + u.pathname;
		} catch (e) {
			return url;
		}
	}

	function isRateLimited(url) {
		let key = rateLimitKey(url);
		let rl = _rateLimits[key];
		return rl && rl.fails >= RATE_MAX_FAILS && Date.now() < rl.until;
	}

	function recordResponseStatus(url, status) {
		let key = rateLimitKey(url);
		if (status === 429 || status === 503 || status === 502 || status === 504) {
			let rl = _rateLimits[key] || { fails: 0, until: 0 };
			rl.fails++;
			rl.until =
				Date.now() + RATE_BACKOFF_MS + Math.floor(Math.random() * 15000);
			_rateLimits[key] = rl;
		} else if (status >= 200 && status < 300) {
			if (_rateLimits[key]) _rateLimits[key].fails = 0;
		}
	}

	// ────────────────────────────────────────────────────────────────
	//  SECTION 5: HTTP LAYER
	// ────────────────────────────────────────────────────────────────

	function buildRequest(url) {
		return { method: "GET", url: url, headers: JSON_HEADERS };
	}

	/**
	 * Batch HTTP GET requests in parallel via http_parallel.
	 * Rate-limited URLs are skipped with 429 status.
	 */
	function httpBatch(urls) {
		if (!urls || !urls.length) return Promise.resolve([]);

		let results = [];
		let active = [];
		let activeIdx = [];

		for (let i = 0; i < urls.length; i++) {
			if (isRateLimited(urls[i])) {
				results.push({ url: urls[i], ok: false, data: null, status: 429 });
			} else {
				results.push({ url: urls[i], ok: false, data: null, status: 0 });
				active.push(urls[i]);
				activeIdx.push(i);
			}
		}

		if (active.length === 0) return Promise.resolve(results);

		return http_parallel(
			active.map(function (u) {
				return buildRequest(u);
			}),
		)
			.then(function (responses) {
				for (let ri = 0; ri < responses.length; ri++) {
					let resp = responses[ri];
					let idx = activeIdx[ri];
					let status = resp ? resp.status || resp.code || 0 : 0;

					recordResponseStatus(active[ri], status);

					let entry = {
						url: active[ri],
						ok: false,
						data: null,
						status: status,
					};
					if (resp && resp.body && (status === 200 || status === 206)) {
						try {
							if (typeof resp.body === "string") {
								let trimmed = resp.body.trim();
								if (trimmed && trimmed.charAt(0) !== "<") {
									entry.data = JSON.parse(trimmed);
									entry.ok = true;
								}
							} else if (typeof resp.body === "object") {
								entry.data = resp.body;
								entry.ok = true;
							}
						} catch (e) {
							console.warn("[StremioHub] not JSON from", url, ":", e.message);
						}
					}
					results[idx] = entry;
				}
				return results;
			})
			.catch(function () {
				return results;
			});
	}

	/**
	 * Fetch JSON with timeout + retry for transient failures.
	 */
	function fetchJson(url, timeoutMs, maxRetries) {
		timeoutMs = timeoutMs || MANIFEST_TIMEOUT;
		maxRetries = maxRetries || 1;

		function attempt(remainingRetries) {
			return new Promise(function (resolve, reject) {
				let timedOut = false;
				let timer = setTimeout(function () {
					timedOut = true;
					reject(new Error("Timeout: " + url));
				}, timeoutMs);

				http_get(url, JSON_HEADERS)
					.then(function (response) {
						if (timedOut) return;
						clearTimeout(timer);
						if (!response || !response.body)
							return reject(new Error("Empty response"));
						recordResponseStatus(url, response.status || 0);
						if (
							response.status !== 200 &&
							response.status !== 206 &&
							response.status !== 304
						) {
							return reject(new Error("HTTP " + response.status));
						}
						try {
							let body =
								typeof response.body === "string"
									? response.body.trim()
									: response.body;
							if (typeof body === "string" && body.charAt(0) === "<")
								return reject(new Error("HTML response"));
							let parsed = typeof body === "string" ? JSON.parse(body) : body;
							resolve(parsed);
						} catch (e) {
							reject(new Error("Parse error"));
						}
					})
					.catch(function (err) {
						if (timedOut) return;
						clearTimeout(timer);
						reject(err);
					});
			}).catch(function (err) {
				if (remainingRetries > 0) {
					let delay = Math.pow(2, maxRetries - remainingRetries + 1) * 300;
					return new Promise(function (r) {
						setTimeout(r, delay);
					}).then(function () {
						return attempt(remainingRetries - 1);
					});
				}
				throw err;
			});
		}

		return attempt(maxRetries);
	}

	// ────────────────────────────────────────────────────────────────
	//  SECTION 6: ADDON MANIFEST ACCESSORS
	// ────────────────────────────────────────────────────────────────

	function getCatalogueAddons() {
		try {
			if (manifest && Array.isArray(manifest.catalogueAddons))
				return manifest.catalogueAddons;
		} catch (e) {
			console.warn("[StremioHub] getCatalogueAddons error:", e.message);
		}
		return [];
	}

	function getStreamingAddons() {
		try {
			if (manifest && Array.isArray(manifest.streamingAddons))
				return manifest.streamingAddons;
		} catch (e) {
			console.warn("[StremioHub] getStreamingAddons error:", e.message);
		}
		return [];
	}

	function getMetaAddons() {
		try {
			if (
				manifest &&
				Array.isArray(manifest.metaAddons) &&
				manifest.metaAddons.length > 0
			)
				return manifest.metaAddons;
		} catch (e) {
			console.warn("[StremioHub] getMetaAddons error:", e.message);
		}
		return getCatalogueAddons();
	}

	function getManifest(url) {
		let cacheKey = "mf:" + url;
		let cached = cacheGet(cacheKey);
		if (cached) return Promise.resolve(cached);
		if (isRateLimited(url)) return Promise.resolve(null);

		return fetchJson(url, MANIFEST_TIMEOUT)
			.then(function (data) {
				if (data) cacheSet(cacheKey, data, MANIFEST_CACHE_TTL);
				return data;
			})
			.catch(function () {
				return null;
			});
	}

	function fetchManifests(urls) {
		let results = [];
		let uncached = [];
		let uncachedIdx = [];

		for (let i = 0; i < urls.length; i++) {
			let cached = cacheGet("mf:" + urls[i]);
			if (cached) {
				results[i] = { url: urls[i], manifest: cached, index: i };
			} else {
				results[i] = null;
				uncached.push(urls[i]);
				uncachedIdx.push(i);
			}
		}

		if (uncached.length === 0)
			return Promise.resolve(
				results.filter(function (r) {
					return r !== null;
				}),
			);

		return httpBatch(uncached).then(function (batchResults) {
			for (let j = 0; j < batchResults.length; j++) {
				let idx = uncachedIdx[j];
				if (batchResults[j].ok && batchResults[j].data) {
					cacheSet(
						"mf:" + uncached[j],
						batchResults[j].data,
						MANIFEST_CACHE_TTL,
					);
					results[idx] = {
						url: uncached[j],
						manifest: batchResults[j].data,
						index: idx,
					};
				}
			}
			return results.filter(function (r) {
				return r !== null;
			});
		});
	}

	// ────────────────────────────────────────────────────────────────
	//  SECTION 7: STREAM ENGINE
	// ────────────────────────────────────────────────────────────────

	/**
	 * Format a single Stremio stream into a SkyStream StreamResult.
	 * Validates URL, extracts quality, builds label, applies MAGIC_PROXY if needed.
	 */
	function deleteNullKeys(obj) {
		// Return clean copy — no null/undefined values (Dart crashes on json['field'] as String)
		let clean = {};
		for (let k in obj) {
			if (Object.prototype.hasOwnProperty.call(obj, k)) {
				if (obj[k] !== null && obj[k] !== undefined) clean[k] = obj[k];
			}
		}
		return clean;
	}

	/**
	 * Resolve the stream source from a stream object.
	 * Returns { sourceUrl, sourceType, infoHash, fileIdx } or null if the
	 * stream has an explicitly-invalid HTTP URL.
	 */
	function resolveStreamSource(stream) {
		let sourceUrl = null;
		let sourceType = "http";
		let infoHash = null;
		let fileIdx = 0;

		if (stream.url && isHttp(stream.url)) {
			if (!isValidStreamUrl(stream.url)) {
				return null;
			}
			sourceUrl = stream.url;
			sourceType = "http";
		} else if (stream.url && stream.url.indexOf("magnet:") === 0) {
			sourceUrl = stream.url;
			sourceType = "magnet";
			let mh = stream.url.match(/urn:btih:([a-fA-F0-9]+)/);
			if (mh) infoHash = mh[1].toLowerCase();
		} else if (stream.infoHash) {
			sourceType = "torrent";
			infoHash = stream.infoHash;
			fileIdx = stream.fileIdx !== undefined ? stream.fileIdx : 0;
		} else if (stream.ytId) {
			sourceUrl = "https://www.youtube.com/watch?v=" + stream.ytId;
			sourceType = "youtube";
		} else if (stream.externalUrl) {
			sourceUrl = stream.externalUrl;
			sourceType = "external";
		} else if (stream.nzbUrl) {
			sourceUrl = stream.nzbUrl;
			sourceType = "usenet";
		} else {
			// Archive-based streams
			let archTypes = [
				{ key: "rarUrls", label: "RAR" },
				{ key: "zipUrls", label: "ZIP" },
				{ key: "7zipUrls", label: "7z" },
				{ key: "tgzUrls", label: "TGZ" },
				{ key: "tarUrls", label: "TAR" },
			];
			for (let ai = 0; ai < archTypes.length; ai++) {
				let at = archTypes[ai];
				if (Array.isArray(stream[at.key]) && stream[at.key].length) {
					let src = stream[at.key][0];
					let srcUrl = typeof src === "string" ? src : src.url || "";
					if (srcUrl) {
						sourceUrl = srcUrl;
						sourceType = at.label;
						break;
					}
				}
			}
		}

		return { sourceUrl, sourceType, infoHash, fileIdx };
	}

	/**
	 * Build HTTP headers for a stream request.
	 * Copies proxyHeaders from stream.behaviorHints, then fills in
	 * User-Agent, Referer, and Origin defaults.
	 */
	function buildStreamHeaders(stream, addonBaseUrl) {
		let headers = {};
		if (
			stream.behaviorHints &&
			stream.behaviorHints.proxyHeaders &&
			stream.behaviorHints.proxyHeaders.request
		) {
			let srcHeaders = stream.behaviorHints.proxyHeaders.request;
			for (let hk in srcHeaders) {
				if (Object.prototype.hasOwnProperty.call(srcHeaders, hk))
					headers[hk] = srcHeaders[hk];
			}
		}
		if (!headers["User-Agent"]) headers["User-Agent"] = UA;
		if (!headers["Referer"]) headers["Referer"] = addonBaseUrl + "/";
		if (!headers["Origin"]) headers["Origin"] = addonBaseUrl;
		return headers;
	}

	/**
	 * Extract behavior hints from stream.behaviorHints (excluding proxyHeaders).
	 */
	function extractBehaviorHints(stream) {
		let bh = {};
		if (stream.behaviorHints) {
			for (let bk in stream.behaviorHints) {
				if (
					Object.prototype.hasOwnProperty.call(stream.behaviorHints, bk) &&
					bk !== "proxyHeaders"
				) {
					bh[bk] = stream.behaviorHints[bk];
				}
			}
		}
		return bh;
	}

	/**
	 * Parse subtitles from stream.subtitles.
	 * Returns an array of { url, label, lang } or null.
	 */
	function parseStreamSubtitles(stream) {
		if (
			stream.subtitles &&
			Array.isArray(stream.subtitles) &&
			stream.subtitles.length > 0
		) {
			let subs = [];
			for (let si = 0; si < stream.subtitles.length; si++) {
				let sub = stream.subtitles[si];
				if (sub && sub.url && sub.lang)
					subs.push({ url: sub.url, label: sub.lang, lang: sub.lang });
			}
			return subs.length > 0 ? subs : null;
		}
		return null;
	}

	/**
	 * Apply MAGIC_PROXY_v1 prefix to HLS/DASH/playlist URLs or when extra
	 * headers are needed.  Also sets bh.notWebReady for non-direct-media URLs.
	 * Returns { sourceUrl, bh }.
	 */
	function applyMagicProxy(sourceUrl, sourceType, headers, bh) {
		if (sourceType === "http" && sourceUrl) {
			let isStreamingPlaylist = /\.(m3u8|mpd)(\?|$)/i.test(sourceUrl);
			let isDirectMedia = /\.(mp4|mkv|webm|avi|mov)(\?|$)/i.test(sourceUrl);
			let hasExtraHeaders = Object.keys(headers).length > 1;
			let isMaybeProxied =
				/(extract|proxy|redirect|gateway|fetch|resolve)/i.test(sourceUrl);

			// Use MAGIC_PROXY for HLS/DASH/playlist URLs OR when extra headers are needed
			if (
				(isStreamingPlaylist || isMaybeProxied || hasExtraHeaders) &&
				!isDirectMedia
			) {
				if (typeof btoa !== "undefined") {
					sourceUrl = "MAGIC_PROXY_v1" + btoa(sourceUrl);
				}
				bh.notWebReady = true;
			} else if (!isDirectMedia) {
				bh.notWebReady = true;
			}
		}
		return { sourceUrl, bh };
	}

	/**
	 * Assemble the final SkyStream StreamResult object from all extracted pieces.
	 * Copies original stream properties, sets enrichment fields, builds display
	 * name, URL, headers, behaviorHints, subtitles, infoHash overrides, and title.
	 */
	function assembleStreamResult(
		stream,
		info,
		label,
		sourceUrl,
		headers,
		bh,
		subs,
		infoHash,
		fileIdx,
		sourceType,
		addonDisplayName,
	) {
		// Start with ALL original stream properties (v5 compatible)
		let result = {};
		for (let pk in stream) {
			if (Object.prototype.hasOwnProperty.call(stream, pk))
				result[pk] = stream[pk];
		}

		// Computed enrichment fields (always set, never null — Dart expects non-null)
		result.addonName = addonDisplayName;
		result._sortKey = info._sortKey;
		result.resolution =
			info.resolution && info.resolution !== "Auto" ? info.resolution : "";
		result.codec = info.codec || "";
		result.hdr = info.hdr || "";
		result.audio = info.audio || "";
		result.channels = info.channels || "";
		result.language = info.language || "";
		result.size = info.size || "";
		result.peers = info.peers || 0;
		result.seeders = info.seeders || 0;

		// Build display name — order: Size | Res | Codec | 🔊Audio | 👥Peers | 🌱Seeders | 🎨HDR | 🌐Lang [AddonName]
		let displayParts = [];
		if (label) displayParts.push(label);
		if (info.codec) displayParts.push(info.codec);
		if (info.audio) {
			let au = "🔊" + info.audio;
			if (info.channels) au += " " + info.channels;
			displayParts.push(au);
		}
		if (info.peers > 0) displayParts.push("👥" + info.peers);
		if (info.seeders > 0) displayParts.push("🌱" + info.seeders);
		if (info.hdr) displayParts.push("🎨" + info.hdr);
		if (info.language) displayParts.push("🔊" + info.language);
		let displayStr = displayParts.join(" | ");
		if (addonDisplayName) {
			if (displayStr) {
				displayStr += " [" + addonDisplayName + "]";
			} else {
				displayStr = addonDisplayName;
			}
		} else if (!displayStr) {
			displayStr = "Stream";
		}
		result.name = displayStr;
		result.source = result.name;
		result.quality =
			info.resolution && info.resolution !== "Auto" ? info.resolution : "";

		// URL — ALWAYS a non-null string (Dart crashes on null as String)
		// For HTTP/magnet: use sourceUrl
		// For infoHash-only: build magnet URL
		if (sourceUrl) {
			result.url = sourceUrl;
		} else if (infoHash) {
			result.url = buildMagnet(
				infoHash,
				stream.name || stream.title || "",
				stream.sources,
			);
		} else {
			result.url = "";
		}

		// Headers
		if (Object.keys(headers).length > 0) result.headers = headers;

		// behaviorHints must always be an object (Dart expects Map, not null)
		if (Object.keys(bh).length > 0) {
			result.behaviorHints = bh;
		} else if (
			!result.behaviorHints ||
			typeof result.behaviorHints !== "object"
		) {
			result.behaviorHints = {};
		}

		// Subtitles
		if (subs) result.subtitles = subs;

		// InfoHash overrides
		if (infoHash) {
			result.infoHash = infoHash;
			result.fileIndex = fileIdx;
			result.behaviorHints = result.behaviorHints || {};
			result.behaviorHints.notWebReady = true;
		}

		// ── 9. Build title with extra details (single line) ──
		let titleParts = [];
		if (info.hdr) titleParts.push("🎨" + info.hdr);
		if (info.audio) {
			let a = "🔊" + info.audio;
			if (info.channels) a += " " + info.channels;
			titleParts.push(a);
		}
		if (info.language) titleParts.push("🔊" + info.language);
		if (info.peers != null && info.peers > 0)
			titleParts.push("👥" + info.peers);
		if (info.seeders != null && info.seeders > 0)
			titleParts.push("🌱" + info.seeders);
		// Title — ALWAYS non-null String (Dart app expects non-null String)
		result.title = titleParts.length > 0 ? titleParts.join(" | ") : "";

		// Strip null/undefined values — Dart app crashes on json['field'] as String
		deleteNullKeys(result);

		return result;
	}

	function formatStream(stream, addonIndex, addonBaseUrl, addonDisplayName) {
		try {
			if (!stream) return null;

			// ── 1. Validate URL or extract stream source ──
			let resolved = resolveStreamSource(stream);
			if (!resolved) return null;
			let sourceUrl = resolved.sourceUrl;
			let sourceType = resolved.sourceType;
			let infoHash = resolved.infoHash;
			let fileIdx = resolved.fileIdx;

			if (!sourceUrl && !infoHash) return null;

			// ── 2. Extract quality/features from stream metadata ──
			let info = extractStreamInfo(stream);

			// ── 3. Build headers ──
			let headers = buildStreamHeaders(stream, addonBaseUrl);

			// ── 4. Extract behavior hints ──
			let bh = extractBehaviorHints(stream);

			// ── 5. Parse subtitles ──
			let subs = parseStreamSubtitles(stream);

			// ── 6. Build source label ──
			let label = buildStreamLabel(info);

			// ── 7. Apply MAGIC_PROXY for HLS/DASH/playlist URLs that need custom headers ──
			let magicResult = applyMagicProxy(sourceUrl, sourceType, headers, bh);
			sourceUrl = magicResult.sourceUrl;
			bh = magicResult.bh;

			// ── 8. Build stream result object ──
			return assembleStreamResult(
				stream,
				info,
				label,
				sourceUrl,
				headers,
				bh,
				subs,
				infoHash,
				fileIdx,
				sourceType,
				addonDisplayName,
			);
		} catch (e) {
			console.warn(
				"[StremioHub] formatStream error:",
				e.message,
				"for",
				addonDisplayName,
			);
			return null;
		}
	}

	function processStreams(streams, addonIndex, addonBaseUrl, addonDisplayName) {
		if (!Array.isArray(streams)) return [];
		let out = [];
		for (let i = 0; i < streams.length; i++) {
			try {
				let formatted = formatStream(
					streams[i],
					addonIndex,
					addonBaseUrl,
					addonDisplayName,
				);
				if (formatted) out.push(formatted);
			} catch (e) {
				console.warn("[StremioHub] processStreams skip:", e.message);
			}
		}
		return out;
	}

	/**
	 * Fetch streams from a single addon with retry on empty results.
	 */
	function fetchAddonStreams(
		addonBaseUrl,
		streamId,
		streamTypes,
		addonIndex,
		addonDisplayName,
	) {
		return new Promise(function (resolve) {
			let allStreams = [];
			let pending = streamTypes.length;
			let resolved = false;

			if (pending === 0) return resolve([]);

			function safeResolve(data) {
				if (!resolved) {
					resolved = true;
					resolve(data);
				}
			}

			function onResult(streams) {
				for (let i = 0; i < streams.length; i++) {
					allStreams.push(streams[i]);
				}
			}

			for (let ti = 0; ti < streamTypes.length; ti++) {
				let type = streamTypes[ti];
				let reqUrl =
					addonBaseUrl +
					"/stream/" +
					type +
					"/" +
					encodeURIComponent(streamId) +
					".json";

				(function (url, addonIdx, displayName) {
					let timer = setTimeout(function () {
						pending--;
						if (pending <= 0) safeResolve(allStreams);
					}, ADDON_TIMEOUT);

					http_get(url, JSON_HEADERS)
						.then(function (resp) {
							clearTimeout(timer);
							if (resp && resp.status === 200 && resp.body) {
								try {
									let body =
										typeof resp.body === "string"
											? resp.body.trim()
											: JSON.stringify(resp.body);
									if (body && body.charAt(0) !== "<") {
										let parsed = JSON.parse(body);
										let streams = parsed.streams || [];
										let processed = processStreams(
											streams,
											addonIdx,
											addonBaseUrl,
											displayName,
										);
										onResult(processed);
									}
								} catch (e) {
									console.warn(
										"[StremioHub] parse error from",
										displayName,
										":",
										e.message,
									);
								}
							}
							pending--;
							if (pending <= 0) safeResolve(allStreams);
						})
						.catch(function () {
							clearTimeout(timer);
							pending--;
							if (pending <= 0) safeResolve(allStreams);
						});
				})(reqUrl, addonIndex, addonDisplayName);
			}
		});
	}

	// ────────────────────────────────────────────────────────────────
	//  SECTION 8: getHome() — Dashboard Catalogs
	// ────────────────────────────────────────────────────────────────

	async function getHome(cb, page) {
		try {
			let pageNum = parseInt(page) || 1;
			let addonUrls = getCatalogueAddons();

			if (!addonUrls.length) {
				return cb({
					success: false,
					errorCode: "NO_ADDONS",
					message: "No catalogueAddons configured",
				});
			}

			let manifests = await fetchManifests(addonUrls);
			if (!manifests.length) {
				return cb({
					success: false,
					errorCode: "NO_DATA",
					message: "Could not fetch any addon manifests",
				});
			}

			let catalogJobs = [];
			for (let mi = 0; mi < manifests.length; mi++) {
				let mf = manifests[mi].manifest;
				let addonBase = baseUrl(manifests[mi].url);
				if (!mf || !Array.isArray(mf.catalogs) || !mf.catalogs.length) continue;

				for (let ci = 0; ci < mf.catalogs.length; ci++) {
					let cat = mf.catalogs[ci];
					if (!cat || !cat.id || !cat.type) continue;
					let extras = cat.extra || [];
					if (
						extras.some(function (e) {
							return e && e.name === "search" && e.isRequired === true;
						})
					)
						continue;

					let catUrl =
						addonBase + "/catalog/" + cat.type + "/" + cat.id + ".json";
					if (pageNum > 1) {
						let skip = (pageNum - 1) * CATALOG_PAGE_SIZE;
						catUrl += (catUrl.indexOf("?") === -1 ? "?" : "&") + "skip=" + skip;
					}
					catalogJobs.push({
						url: catUrl,
						categoryName: cat.name || cat.id,
						categoryType: cat.type,
					});
				}
			}

			if (!catalogJobs.length) {
				return cb({
					success: false,
					errorCode: "NO_DATA",
					message: "No browsable catalogs found",
				});
			}

			let catCacheKey = "catalog:p" + pageNum;
			let catalogResponses = cacheGet(catCacheKey);
			if (!catalogResponses) {
				catalogResponses = await httpBatch(
					catalogJobs.map(function (j) {
						return j.url;
					}),
				);
				cacheSet(catCacheKey, catalogResponses, 60000);
			}

			let organized = {};
			let order = [];

			for (let ri = 0; ri < catalogResponses.length; ri++) {
				let resp = catalogResponses[ri];
				let job = catalogJobs[ri];
				if (
					!resp.ok ||
					!resp.data ||
					!Array.isArray(resp.data.metas) ||
					!resp.data.metas.length
				)
					continue;

				let items = resp.data.metas
					.map(function (m) {
						return toItem(m, job.categoryType);
					})
					.filter(Boolean);
				if (!items.length) continue;

				if (!organized[job.categoryName]) {
					organized[job.categoryName] = items;
					order.push(job.categoryName);
				}
			}

			if (!order.length) {
				return cb({
					success: false,
					errorCode: "NO_DATA",
					message: "No catalog data returned",
				});
			}

			let finalData = {};
			for (let oi = 0; oi < order.length; oi++) {
				if (organized[order[oi]]) finalData[order[oi]] = organized[order[oi]];
			}

			cb({ success: true, data: finalData, page: pageNum });
		} catch (e) {
			cb({
				success: false,
				errorCode: "HOME_ERROR",
				message: safeStr(e.message || e),
			});
		}
	}

	// ────────────────────────────────────────────────────────────────
	//  SECTION 9: search()
	// ────────────────────────────────────────────────────────────────

	async function search(query, cb) {
		try {
			let q = safeStr(query).trim().toLowerCase();
			if (!q) return cb({ success: true, data: [] });
			if (q.length > MAX_SEARCH_QUERY_LENGTH)
				q = q.substring(0, MAX_SEARCH_QUERY_LENGTH);

			let addonUrls = getMetaAddons();
			let allItems = [];
			let seenUrls = {};

			function addItem(item) {
				if (item && item.url && !seenUrls[item.url]) {
					seenUrls[item.url] = true;
					allItems.push(item);
				}
			}

			if (addonUrls.length > 0) {
				let manifests = await fetchManifests(addonUrls);
				let searchJobs = [];

				for (let mi = 0; mi < manifests.length; mi++) {
					let mf = manifests[mi].manifest;
					let addonBase = baseUrl(manifests[mi].url);
					if (!mf || !Array.isArray(mf.catalogs)) continue;

					for (let ci = 0; ci < mf.catalogs.length; ci++) {
						let cat = mf.catalogs[ci];
						if (!cat || !cat.id || !cat.type) continue;
						let extras = cat.extra || [];
						if (
							extras.some(function (e) {
								return e && e.name === "search";
							})
						) {
							searchJobs.push({
								url:
									addonBase +
									"/catalog/" +
									cat.type +
									"/" +
									cat.id +
									"/search=" +
									encodeURIComponent(q) +
									".json",
								catType: cat.type,
							});
						}
					}
				}

				if (searchJobs.length > 0) {
					let cacheKey = "search:" + q;
					let responses = cacheGet(cacheKey);
					if (!responses) {
						responses = await httpBatch(
							searchJobs.map(function (j) {
								return j.url;
							}),
						);
						cacheSet(cacheKey, responses, SEARCH_CACHE_TTL);
					}

					for (
						let ri = 0;
						ri < responses.length && allItems.length < MAX_SEARCH_RESULTS;
						ri++
					) {
						let resp = responses[ri];
						let job = searchJobs[ri];
						if (resp.ok && resp.data && Array.isArray(resp.data.metas)) {
							for (
								let si = 0;
								si < resp.data.metas.length &&
								allItems.length < MAX_SEARCH_RESULTS;
								si++
							) {
								addItem(toItem(resp.data.metas[si], job.catType));
							}
						}
					}
				}
			}

			cb({ success: true, data: allItems.slice(0, MAX_SEARCH_RESULTS) });
		} catch (e) {
			cb({ success: true, data: [] });
		}
	}

	// ────────────────────────────────────────────────────────────────
	//  SECTION 10: load() — Metadata Loading
	// ────────────────────────────────────────────────────────────────

	async function load(url, cb) {
		try {
			let rawInput = safeStr(url).trim();
			if (!rawInput)
				return cb({
					success: false,
					errorCode: "PARSE_ERROR",
					message: "No video ID",
				});

			let knownType = null;
			let season = 0;
			let episode = 0;
			let metaId = rawInput;
			let idPrefix = "unknown";

			// ── Parse ID ──
			let parsed = parseVideoId(rawInput);
			if (parsed) {
				metaId = parsed.id;
				knownType = parsed.type;
				idPrefix = parsed.idPrefix;
				season = parsed.season;
				episode = parsed.episode;
			}

			let callbackCalled = false;
			function safeCb(result) {
				if (!callbackCalled) {
					callbackCalled = true;
					cb(result);
				}
			}

			let addonUrls = getMetaAddons();

			// ── TMDB pipe format ──
			if (idPrefix === "tmdb:" && rawInput.indexOf("||") !== -1) {
				let pipeParts = rawInput.split("||");
				if (pipeParts.length >= 4) {
					let cleanTmdb = pipeParts[0];
					let pipeType = (pipeParts[3] || "").toLowerCase();
					let imdbId = await resolveTmdbToImdb(cleanTmdb, pipeType);
					if (imdbId) {
						let pipeSeason = pipeParts.length >= 7 ? pipeParts[6] : "";
						let pipeEpisode = pipeParts.length >= 8 ? pipeParts[7] : "";
						let resolvedId =
							imdbId +
							(pipeSeason ? ":" + pipeSeason : "") +
							(pipeEpisode ? ":" + pipeEpisode : "");
						let resolvedParsed = parseVideoId(resolvedId);
						if (resolvedParsed) {
							metaId = resolvedParsed.id;
							knownType =
								resolvedParsed.type ||
								(pipeType === "series" ? "series" : "movie");
							idPrefix = "tt";
							season = resolvedParsed.season;
							episode = resolvedParsed.episode;
						}
					} else {
						respondPipeMetadata(pipeParts, metaId, safeCb, rawInput);
						return;
					}
				}
			}

			// ── Fetch from meta addons ──
			let bestMeta = null;
			if (addonUrls.length > 0) {
				let metaCalls = [];
				for (let i = 0; i < addonUrls.length; i++) {
					if (!isRateLimited(addonUrls[i])) {
						metaCalls.push(fetchMeta(baseUrl(addonUrls[i]), metaId, knownType));
					}
				}
				if (metaCalls.length > 0) {
					let metaResults = await Promise.allSettled(metaCalls);
					for (let mi = 0; mi < metaResults.length; mi++) {
						if (
							metaResults[mi].status === "fulfilled" &&
							metaResults[mi].value
						) {
							bestMeta = metaResults[mi].value;
							break;
						}
					}
				}
			}

			if (bestMeta) {
				respondMeta(bestMeta, metaId, safeCb, knownType, season, episode);
				return;
			}

			// ── Fallback ──
			respondFallback(rawInput, knownType, season, episode, safeCb);
		} catch (e) {
			try {
				respondFallback(rawInput || url, knownType, season, episode, cb);
			} catch (e2) {
				cb({
					success: false,
					errorCode: "LOAD_ERROR",
					message: safeStr(e.message || e),
				});
			}
		}
	}

	function parseVideoId(raw) {
		if (!raw) return null;
		let parsed = safeJson(raw, null);
		if (parsed && parsed.i !== undefined) {
			return {
				id: safeStr(parsed.i),
				type: parsed.t || null,
				season: parsed.s || 0,
				episode: parsed.e || 0,
				idPrefix: detectPrefix(safeStr(parsed.i)),
			};
		}
		if (raw.indexOf(":") !== -1) {
			let parts = raw.split(":");
			let first = parts[0];
			if (/^tt\d+$/.test(first) && parts.length >= 3) {
				return {
					id: first,
					type: "series",
					season: parseInt(parts[1]) || 0,
					episode: parseInt(parts[2]) || 0,
					idPrefix: "tt",
				};
			}
			if (first === "tmdb" && parts.length >= 4) {
				let tmdbRaw = parts[1];
				let pipeIdx = tmdbRaw.indexOf("||");
				if (pipeIdx !== -1) tmdbRaw = tmdbRaw.substring(0, pipeIdx);
				return {
					id: "tmdb:" + tmdbRaw,
					type: "series",
					season: parseInt(parts[2]) || 0,
					episode: parseInt(parts[3]) || 0,
					idPrefix: "tmdb:",
				};
			}
			if (/^[a-zA-Z]+$/.test(first) && parts.length >= 2) {
				if (first === "tmdb") {
					let sp = parts[1];
					let pi = sp.indexOf("||");
					if (pi !== -1) sp = sp.substring(0, pi);
					let metaParts = parts[1].split("||");
					let typeHint =
						metaParts.length >= 4
							? metaParts[3] === "series"
								? "series"
								: "movie"
							: null;
					return {
						id: "tmdb:" + sp,
						type: typeHint,
						season: 0,
						episode: 0,
						idPrefix: "tmdb:",
					};
				}
				return {
					id: raw,
					type: null,
					season: 0,
					episode: 0,
					idPrefix: detectPrefix(raw),
				};
			}
		}
		if (/^tt\d+$/.test(raw))
			return { id: raw, type: null, season: 0, episode: 0, idPrefix: "tt" };
		return {
			id: raw,
			type: null,
			season: 0,
			episode: 0,
			idPrefix: detectPrefix(raw),
		};
	}

	function detectPrefix(raw) {
		if (!raw) return "unknown";
		let r = raw.toLowerCase();
		if (/^tt\d+/.test(r)) return "tt";
		if (r.indexOf("tmdb:") === 0) return "tmdb:";
		return "unknown";
	}

	function fetchMeta(addonBase, id, typeHint) {
		return new Promise(function (resolve) {
			if (typeHint === "movie" || typeHint === "series") {
				let qUrl =
					addonBase +
					"/meta/" +
					typeHint +
					"/" +
					encodeURIComponent(id) +
					".json";
				let timer = setTimeout(function () {
					resolve(null);
				}, META_FETCH_TIMEOUT);
				http_get(qUrl, JSON_HEADERS)
					.then(function (resp) {
						clearTimeout(timer);
						let meta = extractMetaFromResponse(resp);
						resolve(meta);
					})
					.catch(function () {
						clearTimeout(timer);
						resolve(null);
					});
			} else {
				let results = {};
				let pending = 2;
				let done = false;
				let timers = {};
				function tryType(typeName) {
					let qUrl =
						addonBase +
						"/meta/" +
						typeName +
						"/" +
						encodeURIComponent(id) +
						".json";
					timers[typeName] = setTimeout(function () {
						if (!done) {
							pending--;
							if (pending <= 0) finalize();
						}
					}, META_FETCH_TIMEOUT);
					http_get(qUrl, JSON_HEADERS)
						.then(function (resp) {
							if (done) return;
							clearTimeout(timers[typeName]);
							let meta = extractMetaFromResponse(resp);
							if (meta && meta.id) results[typeName] = meta;
							pending--;
							if (pending <= 0 && !done) finalize();
						})
						.catch(function () {
							if (done) return;
							clearTimeout(timers[typeName]);
							pending--;
							if (pending <= 0 && !done) finalize();
						});
				}
				function finalize() {
					if (done) return;
					done = true;
					if (results.series) return resolve(results.series);
					if (results.movie) return resolve(results.movie);
					resolve(null);
				}
				tryType("series");
				tryType("movie");
			}
		});
	}

	function extractMetaFromResponse(resp) {
		if (!resp || !resp.body) return null;
		if (resp.status !== 200 && resp.status !== 206) return null;
		try {
			let parsed =
				typeof resp.body === "string"
					? JSON.parse(resp.body.trim())
					: resp.body;
			return (
				parsed.meta || (Array.isArray(parsed.metas) ? parsed.metas[0] : null)
			);
		} catch (e) {
			return null;
		}
	}

	// ── TMDB Resolution ──
	// API keys — these are free/public TMDB keys used for IMDb→TMDB resolution.
	// If rate-limited, add keys to plugin.json as tmdbApiKeys or replace below.
	let TMDB_API_KEYS = [
		"af3a53eb387d57fc935e9128468b1899",
		"68e094699525b18a70bab2f86b1fa706",
	];
	let _tmdbKeyIndex = 0;
	let TMDB_API_TIMEOUT = 5000;
	let TMDB_CACHE_TTL = 86400000;

	function getTmdbApiKey() {
		return TMDB_API_KEYS[_tmdbKeyIndex++ % TMDB_API_KEYS.length];
	}

	function resolveTmdbToImdb(tmdbId, type) {
		let cacheKey = "tmdb2imdb:" + tmdbId;
		let cached = cacheGet(cacheKey);
		if (cached !== null && cached !== undefined) return Promise.resolve(cached);

		let tmdbType = type === "series" || type === "tv" ? "tv" : "movie";
		let apiKey = getTmdbApiKey();
		let baseUrlStr = "https://api.themoviedb.org/3/" + tmdbType + "/" + tmdbId;

		return new Promise(function (resolve) {
			let timer = setTimeout(function () {
				resolve(null);
			}, TMDB_API_TIMEOUT);
			http_get(baseUrlStr + "?api_key=" + apiKey + "&language=en", JSON_HEADERS)
				.then(function (resp) {
					clearTimeout(timer);
					if (resp && resp.status === 200 && resp.body) {
						try {
							let body =
								typeof resp.body === "string"
									? JSON.parse(resp.body)
									: resp.body;
							if (body.imdb_id) {
								cacheSet(cacheKey, body.imdb_id, TMDB_CACHE_TTL);
								return resolve(body.imdb_id);
							}
							if (tmdbType === "tv") {
								resolveExternalIds(tmdbId, apiKey, baseUrlStr, resolve);
							} else {
								resolve(null);
							}
						} catch (e) {
							if (tmdbType === "tv")
								resolveExternalIds(tmdbId, apiKey, baseUrlStr, resolve);
							else resolve(null);
						}
					} else {
						resolve(null);
					}
				})
				.catch(function () {
					clearTimeout(timer);
					resolve(null);
				});
		});

		function resolveExternalIds(tvId, key, base, cb) {
			let extTimer = setTimeout(function () {
				cb(null);
			}, TMDB_API_TIMEOUT);
			http_get(base + "/external_ids?api_key=" + key, JSON_HEADERS)
				.then(function (extResp) {
					clearTimeout(extTimer);
					if (extResp && extResp.status === 200 && extResp.body) {
						try {
							let extBody =
								typeof extResp.body === "string"
									? JSON.parse(extResp.body)
									: extResp.body;
							if (extBody.imdb_id) {
								cacheSet(cacheKey, extBody.imdb_id, TMDB_CACHE_TTL);
								return cb(extBody.imdb_id);
							}
						} catch (e) {
							console.warn(
								"[StremioHub] TMDB external ID parse error:",
								e.message,
							);
						}
					}
					cb(null);
				})
				.catch(function () {
					clearTimeout(extTimer);
					cb(null);
				});
		}
	}

	// ── Metadata response builders ──

	function respondPipeMetadata(pipeParts, metaId, cb, rawInput) {
		let pipeName = pipeParts[1] || metaId;
		let pipeYear = parseInt(pipeParts[2], 10);
		let pipeType = (pipeParts[3] || "").toLowerCase();
		let pipePoster = pipeParts[4] || "";
		let pipeDesc = pipeParts.length >= 6 ? pipeParts[5] || "" : "";
		let isSeries = pipeType === "series" || pipeType === "tv";
		cb({
			success: true,
			data: new MultimediaItem({
				title: pipeName,
				url: metaId,
				posterUrl: pipePoster,
				type: isSeries ? "series" : "movie",
				description: pipeDesc.replace(/<[^>]*>/g, "").trim(),
				year: pipeYear > 1900 && pipeYear < 2100 ? pipeYear : undefined,
				episodes: [
					new Episode({
						name: isSeries ? "Watch" : "Full Movie",
						url: metaId,
						season: 1,
						episode: 1,
						posterUrl: pipePoster,
					}),
				],
			}),
		});
	}

	// ── Helper: Extract type, description, year, rating from meta ──
	function extractMetaBasics(meta, metaId, knownType) {
		let skyTypeVal = skyType(meta.type || knownType || "movie");
		let isSeries = skyTypeVal === "series";
		let description = safeStr(
			meta.description || meta.overview || meta.synopsis || "",
		)
			.replace(/<[^>]*>/g, "")
			.trim()
			.substring(0, 1000);
		let year = meta
			? (function () {
					if (meta.year != null) {
						let y = parseInt(meta.year, 10);
						if (y > 1900 && y < 2100) return y;
					}
					return undefined;
				})()
			: undefined;
		let score = meta
			? (function () {
					if (meta.imdbRating != null) {
						let r = parseFloat(meta.imdbRating);
						if (!isNaN(r) && r >= 0 && r <= 10) return r;
					}
					return undefined;
				})()
			: undefined;
		return { skyTypeVal, isSeries, description, year, score };
	}

	// ── Helper: Build episodes array from meta.videos ──
	function buildEpisodesList(meta, metaId, isSeries) {
		let episodes = [];
		if (isSeries && Array.isArray(meta.videos)) {
			episodes = meta.videos
				.map(function (v) {
					try {
						return new Episode({
							name:
								v.name ||
								v.title ||
								"S" + (v.season || 1) + "E" + (v.episode || 1),
							url: meta.id
								? meta.id + ":" + (v.season || 1) + ":" + (v.episode || 1)
								: v.id || v.imdb_id || "",
							season: v.season || 1,
							episode: v.episode || 1,
							rating: v.rating ? parseFloat(v.rating) : undefined,
							runtime: v.runtime ? parseInt(v.runtime, 10) : undefined,
							airDate: v.released || v.airDate || v.firstAired || undefined,
							posterUrl: v.thumbnail || v.poster || meta.poster || "",
						});
					} catch (e) {
						return null;
					}
				})
				.filter(Boolean);
		}

		if (!episodes.length) {
			episodes.push(
				new Episode({
					name: isSeries ? "Watch" : "Full Movie",
					url: isSeries ? (meta.id || metaId) + ":1:1" : meta.id || metaId,
					season: 1,
					episode: 1,
					posterUrl: meta.poster || "",
				}),
			);
		}

		return episodes;
	}

	// ── Helper: Extract cast array from meta (delegates to extractCast) ──
	function extractCastList(meta) {
		if (Array.isArray(meta.cast) && meta.cast.length > 0)
			return extractCast(meta.cast);
		if (Array.isArray(meta.credits_cast) && meta.credits_cast.length > 0)
			return extractCast(meta.credits_cast);
		return undefined;
	}

	// ── Helper: Extract trailers array from meta ──
	function extractTrailers(meta) {
		if (!Array.isArray(meta.trailers) || !meta.trailers.length)
			return undefined;
		let trailers = [];
		for (let ti = 0; ti < meta.trailers.length; ti++) {
			try {
				let tr = meta.trailers[ti];
				let src = tr.source || tr.url || "";
				let trUrl =
					src.indexOf("http") === 0
						? src
						: "https://www.youtube.com/watch?v=" + src;
				trailers.push(
					new Trailer({
						url: trUrl,
						name: tr.name || tr.type || "Trailer",
					}),
				);
			} catch (e) {
				console.warn("[StremioHub] trailer parse error:", e.message);
			}
		}
		return trailers.length > 0 ? trailers : undefined;
	}

	// ── Helper: Extract genres array from meta ──
	function extractGenres(meta) {
		let g = meta.genres || meta.genre || meta.tags;
		if (Array.isArray(g) && g.length > 0) {
			if (typeof g[0] === "object" && g[0].name)
				return g.map(function (x) {
					return x.name;
				});
			return g;
		}
		return undefined;
	}

	function respondMeta(meta, metaId, cb, knownType, season, episode) {
		try {
			let { skyTypeVal, isSeries, description, year, score } =
				extractMetaBasics(meta, metaId, knownType);
			let episodes = buildEpisodesList(meta, metaId, isSeries);
			let cast = extractCastList(meta);
			let trailers = extractTrailers(meta);
			let genres = extractGenres(meta);

			cb({
				success: true,
				data: new MultimediaItem({
					title: meta.name || meta.title || "Unknown",
					url: metaId,
					posterUrl: meta.poster || meta.posterUrl || "",
					bannerUrl: meta.background || meta.backdrop || meta.banner || "",
					logoUrl: meta.logo || meta.logoUrl || "",
					type: skyTypeVal,
					description: description,
					year: year,
					score: score,
					genres: genres,
					cast: cast,
					trailers: trailers,
					runtime: meta.runtime ? safeStr(meta.runtime) : undefined,
					status: (function (s) {
						if (!s) return undefined;
						let sv = safeStr(s).toLowerCase();
						if (sv === "ended" || sv === "canceled") return "completed";
						if (
							sv === "returning series" ||
							sv === "continuing" ||
							sv === "ongoing"
						)
							return "ongoing";
						return undefined;
					})(meta.status),
					episodes: episodes,
				}),
			});
		} catch (e) {
			let safeMeta = meta || {};
			cb({
				success: true,
				data: new MultimediaItem({
					title: safeMeta.name || safeMeta.title || "Unknown",
					url: metaId,
					type: skyType(safeMeta.type || "movie"),
					episodes: [
						new Episode({
							name:
								skyType(safeMeta.type || "movie") === "movie"
									? "Full Movie"
									: "Watch",
							url:
								skyType(safeMeta.type || "movie") === "movie"
									? metaId
									: metaId + ":1:1",
							season: 1,
							episode: 1,
						}),
					],
				}),
			});
		}
	}

	function extractCast(castList) {
		let result = [];
		for (let ci = 0; ci < Math.min(castList.length, 20); ci++) {
			try {
				let c = castList[ci];
				if (!c || (!c.name && !c.role && !c.character)) continue;
				let img = c.image || c.photo || c.profile_path || c.imageUrl || "";
				if (img && img.indexOf("http") !== 0)
					img = "https://image.tmdb.org/t/p/w185" + img;
				result.push(
					new Actor({
						name: c.name || c.actor || "Unknown",
						role: c.role || c.character || "",
						image: img || undefined,
					}),
				);
			} catch (e) {
				console.warn("[StremioHub] extractCast error:", e.message);
			}
		}
		return result.length > 0 ? result : undefined;
	}

	function respondFallback(rawInput, knownType, season, episode, cb) {
		try {
			let ft = skyType(knownType || "movie");
			let fs = season > 0 ? season : 1;
			let fe = episode > 0 ? episode : 1;
			cb({
				success: true,
				data: new MultimediaItem({
					title: rawInput,
					url: rawInput,
					type: ft,
					episodes: [
						new Episode({
							name: ft === "movie" ? "Full Movie" : "Watch",
							url: ft === "movie" ? rawInput : rawInput + ":" + fs + ":" + fe,
							season: fs,
							episode: fe,
						}),
					],
				}),
			});
		} catch (e) {
			cb({
				success: false,
				errorCode: "FALLBACK_ERROR",
				message: safeStr(e.message || e),
			});
		}
	}

	// ──── Metadata converter for catalogs ────
	function toItem(m, fallbackType) {
		try {
			if (!m || !m.id) return null;
			let year = undefined;
			if (m.year != null) {
				let y = parseInt(m.year, 10);
				if (y > 1900 && y < 2100) year = y;
			}
			let rating = undefined;
			if (m.imdbRating != null) {
				let r = parseFloat(m.imdbRating);
				if (!isNaN(r) && r >= 0 && r <= 10) rating = r;
			} else if (m.score != null) {
				let r2 = parseFloat(m.score);
				if (!isNaN(r2) && r2 >= 0 && r2 <= 10) rating = r2;
			}
			let genres = undefined;
			let g = m.genres || m.genre || m.tags;
			if (Array.isArray(g) && g.length > 0) {
				if (typeof g[0] === "object" && g[0].name)
					genres = g.map(function (x) {
						return x.name;
					});
				else genres = g;
			}

			return new MultimediaItem({
				title:
					m.name || m.title || m.originalName || m.original_title || "Unknown",
				url: m.id || "",
				posterUrl:
					m.poster || m.posterUrl || m.poster_path || m.thumbnail || "",
				bannerUrl:
					m.background ||
					m.backdrop ||
					m.banner ||
					m.bannerUrl ||
					m.backdrop_path ||
					"",
				logoUrl: m.logo || m.logoUrl || "",
				type: skyType(m.type || fallbackType || "movie"),
				description: safeStr(m.description || m.overview || m.synopsis || "")
					.replace(/<[^>]*>/g, "")
					.trim()
					.substring(0, 500),
				year: year,
				score: rating,
				genres: genres,
			});
		} catch (e) {
			return null;
		}
	}

	// ────────────────────────────────────────────────────────────────
	//  SECTION 11: loadStreams() — THE CORE FUNCTION
	// ────────────────────────────────────────────────────────────────

	function cleanStreamId(input) {
		let pipeIdx = input.indexOf("||");
		return pipeIdx !== -1 ? input.substring(0, pipeIdx) : input;
	}

	async function loadStreams(url, cb) {
		let served = false;
		try {
			let rawInput = safeStr(url).trim();
			if (!rawInput) return cb({ success: true, data: [] });

			// Strip pipe-delimited metadata
			rawInput = cleanStreamId(rawInput);

			// Resolve TMDB → IMDb for stream addon compatibility (most addons want tt- prefix)
			if (/^tmdb:(\d+)/i.test(rawInput)) {
				let tmdbMatch = rawInput.match(/^tmdb:(\d+)/i);
				if (tmdbMatch) {
					let tmdbId = tmdbMatch[1];
					let hasSeasonEp = /:\d+:\d+$/.test(rawInput);
					let type = hasSeasonEp ? "tv" : "movie";
					let imdbId = await resolveTmdbToImdb(tmdbId, type);
					if (imdbId) {
						let suffix = hasSeasonEp ? rawInput.match(/:\d+:\d+$/)[0] : "";
						rawInput = imdbId + (suffix || "");
					}
				}
			}

			// ── Serve-stale cache: return instantly if we have it, refresh in background ──
			let cacheKey = "streams:" + rawInput;
			let cached = cacheGet(cacheKey);
			let served = false;
			if (cached) {
				served = true;
				try {
					cb({ success: true, data: cached });
				} catch (_) {}
				// Don't return — continue to refresh cache in background
			}

			// Determine stream type(s) based on ID
			let isSeries = /:\d+:\d+$/.test(rawInput);
			let streamTypes = isSeries ? ["series"] : ["movie", "series"];

			let addonUrls = getStreamingAddons();
			if (!addonUrls.length) {
				if (!served) return cb({ success: true, data: [] });
				return;
			}

			// Fetch manifests to discover addon capabilities
			let manifests = await fetchManifests(addonUrls);

			// Build parallel addon fetch promises
			let addonPromises = [];

			for (let mi = 0; mi < manifests.length; mi++) {
				let mf = manifests[mi];
				if (!mf || !mf.manifest) continue;

				let addonManifest = mf.manifest;
				let addonBase = baseUrl(mf.url);
				let addonDisplayName = addonName(mf.url);

				// Check if addon supports streaming
				if (!addonManifest.resources || !Array.isArray(addonManifest.resources))
					continue;
				let supportsStream = false;
				for (let ri = 0; ri < addonManifest.resources.length; ri++) {
					let res = addonManifest.resources[ri];
					if (
						typeof res === "string"
							? res === "stream"
							: res.name === "stream" || res.id === "stream"
					) {
						supportsStream = true;
						break;
					}
				}
				if (!supportsStream) continue;

				// Create a fetch promise for this addon (handles all stream types internally)
				addonPromises.push(
					fetchAddonStreams(
						addonBase,
						rawInput,
						streamTypes,
						mi,
						addonDisplayName,
					),
				);
			}

			// Wait for ALL addons to complete (Promise.allSettled for resilience)
			let allResults = await Promise.allSettled(addonPromises);

			// Merge and dedup
			let merged = [];
			let seenDedup = {};

			for (let pi = 0; pi < allResults.length; pi++) {
				let arr =
					allResults[pi].status === "fulfilled"
						? allResults[pi].value || []
						: [];
				for (let ii = 0; ii < arr.length; ii++) {
					let st = arr[ii];
					if (!st) continue;
					// Dedup key
					let prefix = "";
					let dk = st.url || "";
					if (st.infoHash) dk = st.infoHash.toLowerCase();
					else
						dk = dk
							.replace(/^https?:\/\//, "")
							.replace(/\/+$/, "")
							.split("#")[0]
							.toLowerCase();
					if (!dk) continue;
					if (!seenDedup[prefix + dk]) {
						seenDedup[prefix + dk] = true;
						merged.push(st);
					}
				}
			}

			// Sort by quality (best first), then by seeders (most first)
			merged.sort(function (a, b) {
				let diff = (b._sortKey || 0) - (a._sortKey || 0);
				if (diff !== 0) return diff;
				return (b.seeders || 0) - (a.seeders || 0);
			});

			// Cache for 30 min — covers re-select within same session
			cacheSet(cacheKey, merged, STREAM_RESPONSE_TTL);

			// If we served stale cache, background refresh is done silently
			if (!served) {
				cb({ success: true, data: merged });
			}
		} catch (e) {
			if (!served) {
				cb({ success: true, data: [] });
			}
			// If we served cached data, a background refresh error is non-fatal — ignore
		}
	}

	// ────────────────────────────────────────────────────────────────
	//  SECTION 12: EXPORTS
	// ────────────────────────────────────────────────────────────────

	let g = typeof globalThis !== "undefined" ? globalThis : null;
	if (!g && typeof self !== "undefined") g = self;
	if (!g && typeof window !== "undefined") g = window;
	if (!g && typeof global !== "undefined") g = global;

	if (g) {
		g.getHome = getHome;
		g.search = search;
		g.load = load;
		g.loadStreams = loadStreams;
	} else {
		console.error(
			"[StremioHub] Could not register plugin — no global scope found",
		);
	}
})();
