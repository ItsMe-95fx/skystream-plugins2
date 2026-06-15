(function () {
	"use strict";

	const CONFIG = {
		ADDON_TIMEOUT_MS: 8000,
		MANIFEST_TIMEOUT_MS: 10000,
		SEARCH_TIMEOUT_MS: 6000,
		CATALOG_TIMEOUT_MS: 5000,
		CATALOG_FETCH_LIMIT: 25,
		CLIENT_FILTER_LIMIT: 80,
		MAX_SEARCH_RESULTS: 100,
		MAX_CACHE_SIZE: 200,
		// Soft global timeout — each top-level function must complete within this
		GLOBAL_TIMEOUT_MS: 15000,
		GLOBAL_HOME_TIMEOUT_MS: 45000,
		GLOBAL_SEARCH_TIMEOUT_MS: 45000,
		GLOBAL_LOAD_TIMEOUT_MS: 25000,
		GLOBAL_STREAMS_TIMEOUT_MS: 25000,
		CACHE_TTL_CATALOG: 3 * 60 * 1000, // 3 min
		CACHE_TTL_MANIFEST: 5 * 60 * 1000, // 5 min
		CACHE_TTL_STALE_MANIFEST: 30 * 60 * 1000, // 30 min
	};

	const USER_AGENT =
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

	const DEFAULT_HEADERS = {
		"User-Agent": USER_AGENT,
		Accept: "application/json",
		"Accept-Language": "en-US,en;q=0.5",
	};

	// ──────────────────────────────────────────────
	//  CACHES
	// ──────────────────────────────────────────────
	let manifestCache = { data: null, ts: 0 };
	const catalogCache = new Map();
	const detailCache = new Map();

	// ──────────────────────────────────────────────
	//  HTTP HELPERS
	// ──────────────────────────────────────────────

	/**
	 * Fetch JSON with timeout. Returns { ok, data, error }.
	 * Never throws — always resolves to a result object.
	 * Compatible with SkyStream's custom JS runtime.
	 * Uses resolve-guard pattern to avoid Promise.race rejections
	 * that cause UnhandledPromiseRejection crashes.
	 */
	async function safeFetch(url, headers, timeoutMs) {
		timeoutMs = timeoutMs || CONFIG.ADDON_TIMEOUT_MS;
		const merged = Object.assign({}, DEFAULT_HEADERS, headers || {});

		try {
			// Resolve-guard: never reject, never unhandled rejection
			let completed = false;

			const result = await new Promise(function (resolve) {
				var timer = setTimeout(function () {
					if (completed) return;
					completed = true;
					resolve(null); // null = timed out
				}, timeoutMs);

				http_get(url, merged)
					.then(function (res) {
						if (completed) return;
						completed = true;
						clearTimeout(timer);
						resolve(res);
					})
					.catch(function (err) {
						if (completed) return;
						completed = true;
						clearTimeout(timer);
						resolve({ ok: false, error: err.message || String(err) });
					});
			});

			// Timeout: null means timer fired before fetch completed
			if (result === null) {
				return {
					ok: false,
					error: "Request timed out after " + timeoutMs + "ms",
				};
			}

			// Error object from catch path
			if (!result.ok && result.error) {
				return result;
			}

			if (!result) {
				return { ok: false, error: "Empty response" };
			}

			if (result.status !== 200 && result.status !== 304) {
				return { ok: false, error: "HTTP " + result.status };
			}

			if (!result.body) {
				return { ok: false, error: "Empty body" };
			}

			// Detect HTML response (blocked by Cloudflare etc.)
			if (
				typeof result.body === "string" &&
				result.body.trim().charAt(0) === "<"
			) {
				return { ok: false, error: "HTML response (blocked)" };
			}

			let data;
			if (typeof result.body === "object") {
				data = result.body;
			} else {
				data = JSON.parse(result.body);
			}

			return { ok: true, data: data };
		} catch (err) {
			return { ok: false, error: err.message || String(err) };
		}
	}

	/**
	 * Fetch with timeout, returning the JSON body or null on failure.
	 * (Legacy compatibility for callback-based API)
	 */
	async function fetchWithTimeout(url, headers, timeoutMs) {
		const result = await safeFetch(url, headers, timeoutMs);
		return result.ok ? result.data : null;
	}

	/**
	 * Wraps a callback-based function with a global timeout.
	 * If the function doesn't call cb() within the timeout, calls cb with an error.
	 */
	function withGlobalTimeout(fn, timeoutMs) {
		return function () {
			var args = arguments;
			var cb = args[args.length - 1]; // last arg is always the callback
			var timedOut = false;
			var timer = setTimeout(function () {
				timedOut = true;
				cb({
					success: false,
					errorCode: "TIMEOUT",
					message: "Global timeout exceeded",
				});
			}, timeoutMs || CONFIG.GLOBAL_TIMEOUT_MS);

			// Wrap the original callback to prevent double-call
			var originalCb = cb;
			args[args.length - 1] = function () {
				if (timedOut) return; // Already responded with timeout
				clearTimeout(timer);
				originalCb.apply(null, arguments);
			};

			// Call the function with the wrapped callback
			try {
				fn.apply(null, args);
			} catch (e) {
				if (!timedOut) {
					clearTimeout(timer);
					originalCb({
						success: false,
						errorCode: "EXCEPTION",
						message: e.message || String(e),
					});
				}
			}
		};
	}

	// ──────────────────────────────────────────────
	//  URL HELPERS
	// ──────────────────────────────────────────────

	/** Encode addon meta into an opaque URL string for load/loadStreams */
	function encodeRef(addonUrl, type, id, season, episode, poster, title) {
		return JSON.stringify({
			a: addonUrl,
			t: type,
			i: id,
			s: season || 1,
			e: episode || 1,
			p: poster || "",
			n: title || "",
		});
	}

	/** Decode the opaque URL back to its parts */
	function decodeRef(url) {
		try {
			return JSON.parse(url);
		} catch (e) {
			return null;
		}
	}

	/** Derive base URL from a manifest.json URL */
	function baseFromManifest(manifestUrl) {
		return manifestUrl.replace(/\/manifest\.json$/, "").replace(/\/$/, "");
	}

	/** Safely convert any value to a string */
	function safeStr(s) {
		return String(s == null ? "" : s);
	}

	/**
	 * Derive a human-readable addon name from its manifest URL.
	 * Handles hex hash subdomains, short TLDs, and common patterns.
	 */
	function addonName(url) {
		try {
			var parts = url
				.replace(/https?:\/\//, "")
				.split("/")[0]
				.replace(/^www\./, "")
				.split(".");
			var name = parts[0] || "";
			// If subdomain looks like a hex hash (e.g., a3f8b2c1.example.com)
			if (/^[a-f0-9]{8,}$/i.test(name) && parts.length >= 2) {
				name = parts[parts.length - 2];
			}
			name = name.replace(/^[a-f0-9]{6,}-/i, "");
			var tlds = [
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
				for (var ni = 1; ni < parts.length - 1; ni++) {
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

	/** Check if a string is an HTTP(S) URL */
	function isHttp(s) {
		return s && (s.indexOf("http://") === 0 || s.indexOf("https://") === 0);
	}

	// ──────────────────────────────────────────────
	//  ADDON MANAGEMENT
	// ──────────────────────────────────────────────

	/** Get the list of addon manifest URLs from plugin.json */
	function getAddonUrls() {
		if (typeof manifest === "undefined" || !manifest) return [];

		// Support both "addons" (array) and standard fields
		if (manifest.addons && Array.isArray(manifest.addons)) {
			return manifest.addons
				.map(function (u) {
					return (u || "").trim();
				})
				.filter(Boolean);
		}

		return [];
	}

	/** Fetch and cache all addon manifests */
	async function getAddonConfigs() {
		var now = Date.now();

		// Fresh cache hit
		if (
			manifestCache.data &&
			now - manifestCache.ts < CONFIG.CACHE_TTL_MANIFEST
		) {
			return manifestCache.data;
		}

		var urls = getAddonUrls();
		if (urls.length === 0) return [];

		// Fetch ALL manifests in parallel with per-addon timeout
		var manifestFetches = [];
		for (var ui = 0; ui < urls.length; ui++) {
			manifestFetches.push(
				fetchWithTimeout(urls[ui], null, CONFIG.MANIFEST_TIMEOUT_MS),
			);
		}

		var manifestResults = await Promise.allSettled(manifestFetches);

		var results = [];

		for (var ui2 = 0; ui2 < manifestResults.length; ui2++) {
			var mr = manifestResults[ui2];
			if (mr.status !== "fulfilled" || !mr.value) continue;

			var manifestData = mr.value;
			var url = urls[ui2];
			var baseUrl = baseFromManifest(url);
			var name = manifestData.name || addonName(url);
			var catalogs = manifestData.catalogs || [];

			// Filter hidden catalogs
			var visible = catalogs.filter(function (c) {
				return !(c.behaviorHints && c.behaviorHints.notForHome === true);
			});
			if (visible.length === 0) visible = catalogs;

			// Infer catalogs from types if none
			if (visible.length === 0) {
				var types = manifestData.types || ["movie"];
				for (var ti = 0; ti < types.length; ti++) {
					visible.push({ type: types[ti], id: "top" });
				}
			}

			results.push({
				name: name,
				baseUrl: baseUrl,
				manifestUrl: url,
				catalogs: visible,
				types: manifestData.types || ["movie"],
			});
		}

		if (results.length > 0) {
			manifestCache = { data: results, ts: now };
			return results;
		}

		// Stale fallback
		if (
			manifestCache.data &&
			now - manifestCache.ts < CONFIG.CACHE_TTL_STALE_MANIFEST
		) {
			return manifestCache.data;
		}

		return [];
	}

	// ──────────────────────────────────────────────
	//  CATALOG FETCHING
	// ──────────────────────────────────────────────

	/** Fetch a catalog from a specific addon, with cache */
	async function fetchCatalog(addon, catalogEntry, limit, skip) {
		var url =
			addon.baseUrl +
			"/catalog/" +
			catalogEntry.type +
			"/" +
			catalogEntry.id +
			".json";
		var params = [];
		if (limit) params.push("limit=" + limit);
		if (skip) params.push("skip=" + skip);
		if (params.length > 0) url += "?" + params.join("&");

		// Cache check
		var cached = catalogCache.get(url);
		if (cached && Date.now() - cached.ts < CONFIG.CACHE_TTL_CATALOG) {
			return cached.data;
		}

		var result = await safeFetch(url, null, CONFIG.ADDON_TIMEOUT_MS);
		var metas =
			result.ok && result.data && result.data.metas ? result.data.metas : [];

		catalogCache.set(url, { ts: Date.now(), data: metas });
		if (catalogCache.size > 200) {
			var keys = Array.from(catalogCache.keys());
			for (var ki = 0; ki < keys.length - 150; ki++) {
				catalogCache.delete(keys[ki]);
			}
		}

		return metas;
	}

	// ──────────────────────────────────────────────
	//  META CONVERSION
	// ──────────────────────────────────────────────

	/** Convert a Stremio meta object to a SkyStream MultimediaItem */
	function metaToItem(meta, addon, catalogType) {
		if (!meta) return null;

		var type = meta.type || catalogType || "movie";
		var skyType =
			type === "series" ||
			type === "tv" ||
			type === "anime" ||
			type === "hentai"
				? "series"
				: "movie";
		var poster = meta.poster || "";
		var background = meta.background || meta.backdrop || "";
		var description = (meta.description || "")
			.replace(/<[^>]*>/g, "")
			.trim()
			.substring(0, 500);

		return new MultimediaItem({
			title: meta.name || meta.title || "Unknown",
			url: encodeRef(
				addon.baseUrl,
				type,
				meta.id,
				0,
				0,
				poster,
				meta.name || meta.title,
			),
			posterUrl: poster,
			bannerUrl: background,
			type: skyType,
			description: description,
			year: meta.year
				? parseInt(meta.year)
				: meta.releaseInfo
					? parseInt(meta.releaseInfo)
					: undefined,
			score: meta.imdbRating
				? parseFloat(meta.imdbRating)
				: meta.score || meta.popularity || undefined,
			isAdult: true,
			genres: meta.genres || meta.tags || undefined,
		});
	}

	// ──────────────────────────────────────────────
	//  SMART CLIENT-SIDE TITLE MATCHER
	//  Splits multi-word queries into tokens for
	//  partial matching — fixes multi-word search.
	// ──────────────────────────────────────────────

	function metaMatches(meta, queryLower) {
		// Build searchable text
		var title = (
			(meta.name || meta.title || "") +
			" " +
			(meta.englishName || "")
		).toLowerCase();
		var desc = (meta.description || "").replace(/<[^>]*>/g, "").toLowerCase();
		var tags = meta.genres || meta.tags || [];

		// Split query into individual tokens
		var tokens = queryLower.split(/\s+/).filter(Boolean);

		// Each token must match at least one field
		var matchedCount = 0;
		for (var ti = 0; ti < tokens.length; ti++) {
			var token = tokens[ti];
			if (token.length === 0) continue;

			// Check title
			if (title.indexOf(token) !== -1) {
				matchedCount++;
				continue;
			}
			// Check description
			if (desc.indexOf(token) !== -1) {
				matchedCount++;
				continue;
			}
			// Check genres/tags
			var foundInTags = false;
			if (Array.isArray(tags)) {
				for (var gi = 0; gi < tags.length; gi++) {
					if (String(tags[gi]).toLowerCase().indexOf(token) !== -1) {
						foundInTags = true;
						break;
					}
				}
			}
			if (foundInTags) {
				matchedCount++;
				continue;
			}
			// Check cast
			var cast = meta.cast || [];
			if (Array.isArray(cast)) {
				for (var ci = 0; ci < cast.length; ci++) {
					if (
						cast[ci] &&
						cast[ci].name &&
						cast[ci].name.toLowerCase().indexOf(token) !== -1
					) {
						matchedCount++;
						break;
					}
				}
			}
		}

		// All tokens must match at least one field
		return matchedCount >= tokens.length;
	}

	// ──────────────────────────────────────────────
	//  DEDUPLICATION — proper title-based dedup
	// ──────────────────────────────────────────────

	function normalizeTitle(t) {
		return (t || "")
			.toLowerCase()
			.replace(/[^a-z0-9]/g, "")
			.trim();
	}

	function deduplicate(items) {
		var seen = {};
		var result = [];
		for (var i = 0; i < items.length; i++) {
			var item = items[i];
			if (!item) continue;
			var key = normalizeTitle(item.title);
			if (seen[key]) continue;
			seen[key] = true;
			result.push(item);
		}
		return result;
	}

	// ──────────────────────────────────────────────
	//  getHome — Dashboard from all addon catalogs
	// ──────────────────────────────────────────────

	async function getHome(cb, page) {
		try {
			var pageNum = parseInt(page) || 1;
			var addons = await getAddonConfigs();

			if (addons.length === 0) {
				return cb({
					success: false,
					errorCode: "NO_ADDONS",
					message: "No addons configured. Please check plugin settings.",
				});
			}

			var skip = (pageNum - 1) * CONFIG.CATALOG_FETCH_LIMIT;

			// Launch ALL catalog fetches in parallel
			var catalogPromises = [];
			var catalogMeta = [];
			for (var ai = 0; ai < addons.length; ai++) {
				var addon = addons[ai];
				for (var ci = 0; ci < addon.catalogs.length; ci++) {
					var cat = addon.catalogs[ci];
					var catUrl =
						addon.baseUrl +
						"/catalog/" +
						cat.type +
						"/" +
						cat.id +
						".json?limit=" +
						CONFIG.CATALOG_FETCH_LIMIT +
						(skip > 0 ? "&skip=" + skip : "");
					catalogPromises.push(
						safeFetch(catUrl, null, CONFIG.CATALOG_TIMEOUT_MS),
					);
					catalogMeta.push({ addon: addon, cat: cat });
				}
			}

			// Wait for all fetches to settle
			var catalogResults = await Promise.allSettled(catalogPromises);

			var homeData = {};
			var sectionOrder = [];

			for (var ri = 0; ri < catalogResults.length; ri++) {
				var cr = catalogResults[ri];
				if (cr.status !== "fulfilled" || !cr.value) continue;
				var result = cr.value;
				if (!result.ok || !result.data) continue;

				var metas = result.data.metas;
				if (!metas || metas.length === 0) continue;

				var addon = catalogMeta[ri].addon;
				var cat = catalogMeta[ri].cat;

				var items = [];
				for (var mi = 0; mi < metas.length; mi++) {
					var item = metaToItem(metas[mi], addon, cat.type);
					if (item) items.push(item);
				}
				if (items.length === 0) continue;

				var section = addon.name;
				if (cat.name && cat.name !== addon.name) {
					section = addon.name + " - " + cat.name;
				}
				if (pageNum > 1) section += " (Page " + pageNum + ")";

				homeData[section] = items;
				sectionOrder.push(section);
			}

			if (Object.keys(homeData).length === 0) {
				return cb({
					success: false,
					errorCode: "NO_DATA",
					message: "No catalog data available from any addon.",
				});
			}

			// Return in order
			var ordered = {};
			for (var si = 0; si < sectionOrder.length; si++) {
				if (homeData[sectionOrder[si]])
					ordered[sectionOrder[si]] = homeData[sectionOrder[si]];
			}

			cb({ success: true, data: ordered, page: pageNum });
		} catch (e) {
			cb({
				success: false,
				errorCode: "HOME_ERROR",
				message: e.message || String(e),
			});
		}
	}

	// ──────────────────────────────────────────────
	//  search — Across ALL addons, with multi-word
	//  token matching and proper error handling
	// ──────────────────────────────────────────────

	async function search(query, cb) {
		try {
			var q = String(query || "").trim();
			if (!q) return cb({ success: true, data: [] });

			var addons = await getAddonConfigs();
			if (addons.length === 0) return cb({ success: true, data: [] });

			var qLower = q.toLowerCase();

			// Build all search tasks across all addons for parallel execution
			var searchTasks = []; // Each task: { addon, promise, cat?, isClientFilter?, isFallback? }
			var taskMetas = []; // Parallel meta-inference results

			for (var ai = 0; ai < addons.length; ai++) {
				var addon = addons[ai];

				// Strategy 1: Native search (catalogs with search extra)
				for (var ci = 0; ci < addon.catalogs.length; ci++) {
					var cat = addon.catalogs[ci];
					var hasSearch = false;
					if (cat.extra && Array.isArray(cat.extra)) {
						for (var ei = 0; ei < cat.extra.length; ei++) {
							if (cat.extra[ei].name === "search") {
								hasSearch = true;
								break;
							}
						}
					}
					if (hasSearch) {
						var searchUrl =
							addon.baseUrl +
							"/catalog/" +
							cat.type +
							"/" +
							cat.id +
							"/search=" +
							encodeURIComponent(q) +
							".json";
						searchTasks.push({
							addon: addon,
							cat: cat,
							promise: safeFetch(searchUrl, null, CONFIG.SEARCH_TIMEOUT_MS),
							isNativeSearch: true,
						});
					}
				}

				// Strategy 2: Client-side filter (catalogs without search)
				for (var ci2 = 0; ci2 < addon.catalogs.length; ci2++) {
					var cat2 = addon.catalogs[ci2];
					var hasSearch2 = false;
					if (cat2.extra && Array.isArray(cat2.extra)) {
						for (var ei2 = 0; ei2 < cat2.extra.length; ei2++) {
							if (cat2.extra[ei2].name === "search") {
								hasSearch2 = true;
								break;
							}
						}
					}
					if (hasSearch2) continue;

					var catUrl =
						addon.baseUrl +
						"/catalog/" +
						cat2.type +
						"/" +
						cat2.id +
						".json?limit=" +
						CONFIG.CLIENT_FILTER_LIMIT;
					searchTasks.push({
						addon: addon,
						cat: cat2,
						promise: safeFetch(catUrl, null, CONFIG.SEARCH_TIMEOUT_MS),
						isClientFilter: true,
					});
				}

				// Strategy 3: Type-based fallback
				if (addon.types && addon.types.length > 0) {
					for (var ti = 0; ti < addon.types.length; ti++) {
						var t = addon.types[ti];
						var fbUrl =
							addon.baseUrl +
							"/catalog/" +
							t +
							"/top/search=" +
							encodeURIComponent(q) +
							".json";
						searchTasks.push({
							addon: addon,
							type: t,
							promise: safeFetch(fbUrl, null, CONFIG.SEARCH_TIMEOUT_MS),
							isFallback: true,
						});
					}
				}
			}

			// Execute all search tasks in parallel
			var taskResults = await Promise.allSettled(
				searchTasks.map(function (t) {
					return t.promise;
				}),
			);

			// Process results
			var allResults = [];

			for (var ri = 0; ri < taskResults.length; ri++) {
				var tr = taskResults[ri];
				if (tr.status !== "fulfilled" || !tr.value) continue;
				var result = tr.value;
				if (!result.ok || !result.data || !result.data.metas) continue;

				var task = searchTasks[ri];

				if (task.isNativeSearch) {
					// Native search results: trust the server, no client filtering needed
					for (var mi = 0; mi < result.data.metas.length; mi++) {
						var item = metaToItem(
							result.data.metas[mi],
							task.addon,
							task.cat.type,
						);
						if (item) allResults.push(item);
					}
				} else if (task.isClientFilter) {
					// Client-side filter: apply token matching
					for (var mi2 = 0; mi2 < result.data.metas.length; mi2++) {
						var meta = result.data.metas[mi2];
						if (metaMatches(meta, qLower)) {
							var item2 = metaToItem(meta, task.addon, task.cat.type);
							if (item2) allResults.push(item2);
						}
					}
				} else if (task.isFallback) {
					// Type fallback: apply token matching
					for (var mi3 = 0; mi3 < result.data.metas.length; mi3++) {
						var fbMeta = result.data.metas[mi3];
						if (metaMatches(fbMeta, qLower)) {
							var item3 = metaToItem(fbMeta, task.addon, task.type);
							if (item3) allResults.push(item3);
						}
					}
				}
			}

			// ── Deduplicate by normalized title ──
			// (This properly removes cross-addon duplicates)
			var deduped = deduplicate(allResults);

			// Limit to max results
			if (deduped.length > CONFIG.MAX_SEARCH_RESULTS) {
				deduped = deduped.slice(0, CONFIG.MAX_SEARCH_RESULTS);
			}

			cb({ success: true, data: deduped });
		} catch (e) {
			cb({
				success: false,
				errorCode: "SEARCH_ERROR",
				message: e.message || String(e),
			});
		}
	}

	// ──────────────────────────────────────────────
	//  load — Fetch full details for a specific item
	// ──────────────────────────────────────────────

	async function load(url, cb) {
		try {
			var ref = decodeRef(url);
			if (!ref) {
				return cb({
					success: false,
					errorCode: "PARSE_ERROR",
					message: "Invalid URL format",
				});
			}

			var addonUrl = ref.a;
			var type = ref.t;
			var id = ref.i;
			var fallbackPoster = ref.p || "";
			var fallbackTitle = ref.n || "";

			var metaUrl =
				addonUrl + "/meta/" + type + "/" + encodeURIComponent(id) + ".json";
			var result = await safeFetch(metaUrl, null, CONFIG.ADDON_TIMEOUT_MS);

			if (result.ok && result.data && result.data.meta) {
				var meta = result.data.meta;
				var skyType =
					type === "series" ||
					type === "tv" ||
					type === "anime" ||
					type === "hentai"
						? "series"
						: "movie";
				var episodes = [];

				// Build episodes from videos array
				if (meta.videos && Array.isArray(meta.videos)) {
					for (var vi = 0; vi < meta.videos.length; vi++) {
						var video = meta.videos[vi];
						var epUrl = encodeRef(
							addonUrl,
							type,
							video.id || id,
							video.season || 1,
							video.episode || video.number || 1,
						);
						episodes.push(
							new Episode({
								name:
									video.title ||
									video.name ||
									"Episode " + (video.episode || video.number || 1),
								url: epUrl,
								season: video.season || 1,
								episode: video.episode || video.number || 1,
								posterUrl: video.thumbnail || meta.poster || "",
								description: video.description || "",
								airDate: video.released || "",
							}),
						);
					}
				}

				// Single episode if none found
				if (episodes.length === 0) {
					episodes.push(
						new Episode({
							name: skyType === "movie" ? "Full Movie" : "Watch",
							url: url,
							season: 1,
							episode: 1,
							posterUrl: meta.poster || "",
							description: (meta.description || "")
								.replace(/<[^>]*>/g, "")
								.trim(),
						}),
					);
				}

				return cb({
					success: true,
					data: new MultimediaItem({
						title: meta.name || meta.title || meta.englishName || "Unknown",
						url: url,
						posterUrl: meta.poster || "",
						bannerUrl: meta.background || meta.backdrop || "",
						logoUrl: meta.logo || "",
						type: skyType,
						description: (meta.description || "")
							.replace(/<[^>]*>/g, "")
							.trim(),
						year: meta.year
							? parseInt(meta.year)
							: meta.releaseInfo
								? parseInt(meta.releaseInfo)
								: undefined,
						score:
							meta.score ||
							(meta.imdbRating ? parseFloat(meta.imdbRating) : undefined),
						genres: meta.genres || meta.tags || undefined,
						status: meta.status
							? meta.status.toLowerCase().indexOf("releasing") !== -1 ||
								meta.status.toLowerCase().indexOf("ongoing") !== -1
								? "ongoing"
								: "completed"
							: undefined,
						isAdult: true,
						episodes: episodes,
					}),
				});
			}

			// Fallback: minimal item
			var displayId = id
				.replace(/^([a-z]+[-:])+/, "")
				.replace(/[-_]/g, " ")
				.replace(/\b\w/g, function (c) {
					return c.toUpperCase();
				})
				.substring(0, 60);
			var fbType =
				type === "series" ||
				type === "tv" ||
				type === "anime" ||
				type === "hentai"
					? "series"
					: "movie";
			cb({
				success: true,
				data: new MultimediaItem({
					title: fallbackTitle || displayId || "Content",
					url: url,
					posterUrl: fallbackPoster,
					type: fbType,
					description: "Browse streams from source addon.",
					isAdult: true,
					episodes: [
						new Episode({
							name: "Play",
							url: url,
							season: 1,
							episode: 1,
							posterUrl: fallbackPoster,
						}),
					],
				}),
			});
		} catch (e) {
			cb({
				success: false,
				errorCode: "LOAD_ERROR",
				message: e.message || String(e),
			});
		}
	}

	// ──────────────────────────────────────────────
	//  STREAM FORMATTING HELPERS
	// ──────────────────────────────────────────────

	/**
	 * Parse quality features from stream metadata text.
	 * Returns { resolution, _sortKey } where resolution is e.g. "1080p" and
	 * _sortKey is a numeric sort priority (higher = better).
	 */
	function parseStreamFeatures(text) {
		if (!text) return { resolution: "Auto", _sortKey: 0 };
		var s = String(text).toLowerCase();
		var res = "Auto";
		var key = 0;

		if (/\b(2160|4k|uhd)\b/.test(s)) {
			res = "4K";
			key = 4;
		} else if (/\b1440\b/.test(s)) {
			res = "1440p";
			key = 3;
		} else if (/\b1080\b/.test(s) || /\bfhd\b/.test(s)) {
			res = "1080p";
			key = 2;
		} else if (/\b720\b/.test(s) || /\bhd\b/.test(s)) {
			res = "720p";
			key = 1;
		} else if (/\b480\b/.test(s) || /\bsd\b/.test(s)) {
			res = "480p";
			key = 0;
		} else if (/\b360\b/.test(s)) {
			res = "360p";
			key = 0;
		}

		return { resolution: res, _sortKey: key };
	}

	/**
	 * Build a display source string from stream metadata + addon tag.
	 * Format: [AddonName] stream.name | stream.title
	 * Follows the same pattern as the OnlyTorrents reference plugin.
	 */
	function buildDisplaySource(stream, addonTag) {
		var parts = [];

		if (stream.name) {
			var segs = safeStr(stream.name).split("\n");
			for (var ni = 0; ni < segs.length; ni++) {
				var s = segs[ni].trim();
				if (s) parts.push(s);
			}
		}

		var contentText =
			safeStr(stream.title).trim() || safeStr(stream.description).trim();
		if (contentText) {
			var segs2 = contentText.split("\n");
			for (var si = 0; si < segs2.length; si++) {
				var s2 = segs2[si].trim();
				if (s2) parts.push(s2);
			}
		}

		return parts.length > 0 ? addonTag + " " + parts.join(" | ") : addonTag;
	}

	/**
	 * Extract custom HTTP headers from the stream's behaviorHints.
	 */
	function extractHeaders(stream, baseUrl) {
		var h = { Referer: baseUrl + "/", "User-Agent": USER_AGENT };
		if (stream.behaviorHints && stream.behaviorHints.headers) {
			for (var key in stream.behaviorHints.headers) {
				h[key] = stream.behaviorHints.headers[key];
			}
		}
		return h;
	}

	/**
	 * Extract behaviorHints from stream, excluding the headers sub-object.
	 */
	function extractBehaviorHints(stream) {
		if (!stream.behaviorHints) return {};
		var bh = {};
		for (var key in stream.behaviorHints) {
			if (key === "headers") continue;
			bh[key] = stream.behaviorHints[key];
		}
		return bh;
	}

	/**
	 * Extract subtitles from stream if available.
	 */
	function extractSubtitles(stream) {
		return stream.subtitles && Array.isArray(stream.subtitles)
			? stream.subtitles
			: undefined;
	}

	// ──────────────────────────────────────────────
	//  loadStreams — Fetch playable streams
	// ──────────────────────────────────────────────

	async function loadStreams(url, cb) {
		try {
			var ref = decodeRef(url);
			if (!ref) {
				return cb({
					success: false,
					errorCode: "PARSE_ERROR",
					message: "Invalid URL format",
				});
			}

			var addonUrl = ref.a;
			var type = ref.t;
			var id = ref.i;
			var season = ref.s || 1;
			var episode = ref.e || 1;

			// Derive human-readable addon name from URL
			var addonDisplayName = addonName(addonUrl);
			var addonTag = "[" + addonDisplayName + "]";

			// Build the Stremio stream URL
			var streamUrl =
				addonUrl + "/stream/" + type + "/" + encodeURIComponent(id) + ".json";
			if (season && episode) {
				streamUrl += "?season=" + season + "&episode=" + episode;
			}

			var result = await safeFetch(streamUrl, null, CONFIG.ADDON_TIMEOUT_MS);

			if (result.ok && result.data && result.data.streams) {
				var streams = result.data.streams;
				var processed = [];

				for (var si = 0; si < streams.length; si++) {
					var s = streams[si];
					if (!s) continue;

					// Combined text for feature parsing (name + title + description)
					var flatName = safeStr(s.name)
						.replace(/\n/g, " ")
						.replace(/\s+/g, " ")
						.trim();
					var flatTitle = safeStr(s.title)
						.replace(/\n/g, " ")
						.replace(/\s+/g, " ")
						.trim();
					var flatDesc = safeStr(s.description)
						.replace(/\n/g, " ")
						.replace(/\s+/g, " ")
						.trim();
					var combined = flatName + " " + flatTitle + " " + flatDesc;
					var features = parseStreamFeatures(combined);

					// Build rich source label: [AddonName] name | title
					var displaySource = buildDisplaySource(s, addonTag);

					// Shared metadata
					var headers = extractHeaders(s, addonUrl);
					var bh = extractBehaviorHints(s);
					var subs = extractSubtitles(s);

					// Direct HTTP(S) URL stream
					if (s.url && isHttp(s.url)) {
						var finalUrl = s.url;
						var isDirectMedia = /\.(mp4|mkv|webm|avi|mov)(\?|$)/i.test(s.url);
						var isStreamingPlaylist = /\.(m3u8|mpd)(\?|$)/i.test(s.url);

						// Mark as notWebReady if it's likely a proxied/redirect URL
						if (
							!bh.notWebReady &&
							(!isDirectMedia ||
								/(extract|proxy|redirect|gateway|fetch|resolve)/i.test(s.url) ||
								isStreamingPlaylist)
						) {
							bh.notWebReady = true;
						}

						var resultObj = new StreamResult({
							url: finalUrl,
							quality: features.resolution,
							source: displaySource,
							cached: !!s.cached,
							size: s.size || null,
							headers: headers,
							behaviorHints: Object.keys(bh).length > 0 ? bh : undefined,
							subtitles: subs,
							_sortKey: features._sortKey,
						});

						// Add Origin header for streaming playlists (HLS/DASH)
						if (isStreamingPlaylist && !resultObj.headers["Origin"]) {
							try {
								resultObj.headers["Origin"] = new URL(s.url).origin;
							} catch (e) {
								// Ignore
							}
						}

						processed.push(resultObj);
					}

					// InfoHash (torrent)
					if (s.infoHash) {
						var filename =
							(s.behaviorHints && s.behaviorHints.filename) ||
							s.title ||
							s.name ||
							"";
						var magnet =
							"magnet:?xt=urn:btih:" +
							s.infoHash +
							"&dn=" +
							encodeURIComponent(filename || s.infoHash);
						if (s.sources && Array.isArray(s.sources)) {
							for (var ti = 0; ti < s.sources.length; ti++) {
								var src = s.sources[ti];
								if (src) magnet += "&tr=" + encodeURIComponent(src);
							}
						}
						// Add fallback trackers
						var fallbackTr = [
							"udp://tracker.opentrackr.org:1337/announce",
							"udp://tracker.openbittorrent.com:6969/announce",
							"udp://tracker.torrent.eu.org:451/announce",
						];
						for (var fti = 0; fti < fallbackTr.length; fti++) {
							magnet += "&tr=" + encodeURIComponent(fallbackTr[fti]);
						}

						if (Object.keys(bh).length === 0) bh.notWebReady = true;

						processed.push(
							new StreamResult({
								url: magnet,
								infoHash: s.infoHash,
								fileIndex: s.fileIdx !== undefined ? s.fileIdx : 0,
								quality: features.resolution,
								source: displaySource,
								cached: !!s.cached,
								size: s.size || null,
								headers: headers,
								behaviorHints: Object.keys(bh).length > 0 ? bh : undefined,
								subtitles: subs,
								_sortKey: features._sortKey,
							}),
						);
					}

					// External URL
					if (s.externalUrl) {
						if (Object.keys(bh).length === 0) bh.notWebReady = true;
						processed.push(
							new StreamResult({
								url: s.externalUrl,
								quality: features.resolution,
								source: displaySource + " External",
								cached: !!s.cached,
								headers: headers,
								behaviorHints: Object.keys(bh).length > 0 ? bh : undefined,
								subtitles: subs,
								_sortKey: features._sortKey,
							}),
						);
					}
				}

				return cb({ success: true, data: processed });
			}

			cb({ success: true, data: [] });
		} catch (e) {
			cb({
				success: false,
				errorCode: "STREAMS_ERROR",
				message: e.message || String(e),
			});
		}
	}

	// ──────────────────────────────────────────────
	//  EXPORTS — SkyStream expects these globals
	//  Wrapped with global timeout to prevent hanging
	//  when addon servers are unreachable.
	// ──────────────────────────────────────────────

	globalThis.getHome = withGlobalTimeout(
		getHome,
		CONFIG.GLOBAL_HOME_TIMEOUT_MS,
	);
	globalThis.search = withGlobalTimeout(
		search,
		CONFIG.GLOBAL_SEARCH_TIMEOUT_MS,
	);
	globalThis.load = withGlobalTimeout(load, CONFIG.GLOBAL_LOAD_TIMEOUT_MS);
	globalThis.loadStreams = withGlobalTimeout(
		loadStreams,
		CONFIG.GLOBAL_STREAMS_TIMEOUT_MS,
	);
})();
