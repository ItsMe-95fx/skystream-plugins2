(function () {
	"use strict";

	// ================================================================
	//  MoviesWood — SkyStream Gen 2 Plugin
	//  Fetches movies & series from movieswood.cloud
	//  Anti-bot via Googlebot UA rotation, multi-page categories
	// ================================================================

	// ---- Configuration ----
	var CONFIG = {
		MAX_PAGES_2026: 4,
		MAX_PAGES_2025: 4,
		MAX_PAGES_ALL: 4,
		MAX_PAGES_DUB: 4,
		MAX_PAGES_WEB: 4,
		TIMEOUT_MS: 20000,
		RETRY_LIMIT: 2,
		CONCURRENT: 3,
		USE_MAGIC_PROXY: true,
		DEBUG: false,
	};

	// ---- Bot User-Agents to bypass Cloudflare JS challenge ----
	// The site lets search engine bots through while challenging regular browsers
	var USER_AGENTS = [
		"Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
		"Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
		"Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Googlebot/2.1; +http://www.google.com/bot.html) Chrome/131.0.0.0 Safari/537.36",
		"Mozilla/5.0 (compatible; Bingbot/2.0; +http://www.bing.com/bingbot.htm)",
		"Mozilla/5.0 (compatible; DuckDuckBot-Https/1.1; https://duckduckgo.com/duckduckbot.html)",
		"Mozilla/5.0 (compatible; YandexBot/3.0; +http://yandex.com/bots)",
		"facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
		"Twitterbot/1.0",
	];

	var _uaIndex = 0;

	function getUA() {
		var ua = USER_AGENTS[_uaIndex % USER_AGENTS.length];
		_uaIndex = (_uaIndex + 1) % USER_AGENTS.length;
		return ua;
	}

	// ---- Logging ----
	function log() {
		if (!CONFIG.DEBUG) return;
		var a = ["[MoviesWood]"];
		for (var i = 0; i < arguments.length; i++) a.push(arguments[i]);
		console.log.apply(console, a);
	}
	function warn() {
		var a = ["[MoviesWood]"];
		for (var i = 0; i < arguments.length; i++) a.push(arguments[i]);
		console.warn.apply(console, a);
	}
	function err() {
		var a = ["[MoviesWood]"];
		for (var i = 0; i < arguments.length; i++) a.push(arguments[i]);
		console.error.apply(console, a);
	}

	// ---- Helpers ----
	function getBase() {
		return typeof manifest !== "undefined" && manifest && manifest.baseUrl
			? manifest.baseUrl.replace(/\/+$/, "")
			: "https://movieswood.cloud";
	}

	function absUrl(base, rel) {
		if (!rel) return "";
		if (rel.indexOf("http://") === 0 || rel.indexOf("https://") === 0)
			return rel;
		var b = (base || getBase()).replace(/\/+$/, "");
		// If relative starts with ?, it's a query param for current path
		if (rel.indexOf("?") === 0) return b + "/telly/" + rel;
		if (rel.indexOf("/") === 0) return b + rel;
		return b + "/telly/" + rel;
	}

	function decode(str) {
		if (!str) return "";
		return String(str)
			.replace(/&#(\d+);/g, function (_, d) {
				return String.fromCharCode(Number(d));
			})
			.replace(/&#x([0-9a-fA-F]+);/g, function (_, h) {
				return String.fromCharCode(parseInt(h, 16));
			})
			.replace(/&amp;/gi, "&")
			.replace(/&quot;/gi, '"')
			.replace(/&lt;/gi, "<")
			.replace(/&gt;/gi, ">")
			.replace(/&nbsp;/gi, " ")
			.replace(/&#039;/g, "'");
	}

	function quality(text) {
		if (!text) return "Auto";
		var t = text.toLowerCase();
		if (t.indexOf("2160") !== -1 || t.indexOf("4k") !== -1) return "4K";
		if (t.indexOf("1080") !== -1) return "1080p";
		if (t.indexOf("720") !== -1) return "720p";
		if (t.indexOf("480") !== -1) return "480p";
		var m = t.match(/(\d{3,4})\s*p/i);
		if (m) return m[1] + "p";
		if (
			t.indexOf("hdrip") !== -1 ||
			t.indexOf("webrip") !== -1 ||
			t.indexOf("web-dl") !== -1
		)
			return "HD";
		if (t.indexOf("bluray") !== -1 || t.indexOf("brrip") !== -1)
			return "BluRay";
		return "Auto";
	}

	// ---- HTTP with retry and bot UA ----
	function sleep(ms) {
		return new Promise(function (r) {
			setTimeout(r, ms);
		});
	}

	async function fetchURL(url, opts) {
		opts = opts || {};
		var retries =
			opts.retries !== undefined ? opts.retries : CONFIG.RETRY_LIMIT;
		var timeout = opts.timeout || CONFIG.TIMEOUT_MS;

		for (var a = 0; a <= retries; a++) {
			try {
				var headers = {
					"User-Agent": getUA(),
					Accept:
						"text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
					"Accept-Language": "en-US,en;q=0.5",
					Referer: opts.referer || getBase() + "/",
					DNT: "1",
				};

				log(
					"GET " + (a > 0 ? "(retry " + a + ") " : "") + url.substring(0, 100),
				);

				var res = await Promise.race([
					http_get(url, headers),
					new Promise(function (_, rej) {
						setTimeout(function () {
							rej(new Error("Timeout"));
						}, timeout);
					}),
				]);

				var code = res.status || res.statusCode || 0;
				var body = res.body || "";

				// 503 + Cloudflare challenge → retry with different UA
				if (code === 503 && body.indexOf("cf-browser") !== -1) {
					warn("CF challenge on " + url.substring(0, 60));
					if (a < retries) {
						await sleep(2000 + Math.random() * 1000);
						continue;
					}
					return { body: "", status: code };
				}

				// 429 rate limit
				if (code === 429) {
					if (a < retries) {
						await sleep(4000);
						continue;
					}
					return { body: "", status: code };
				}

				if (code >= 200 && code < 400) {
					return { body: body, status: code };
				}

				if (a < retries) {
					await sleep(1500 + Math.random() * 1000);
					continue;
				}
				return { body: body, status: code };
			} catch (e) {
				log("Fetch error: " + e.message);
				if (a < retries) {
					await sleep(1500 + Math.random() * 1000);
					continue;
				}
				return { body: "", status: 0, error: e.message };
			}
		}
		return { body: "", status: 0 };
	}

	// ================================================================
	//  PARSERS
	// ================================================================

	// ---- Parse listing page (telly/web section) ----
	// Structure:
	//   <a href="?d=loanidXXX" class="card">
	//     <div class="card-img"><img src="TMDB_URL" alt="Title"></div>
	//     <div class="card-body">
	//       <div class="card-name">Title</div>
	//       <div class="card-meta"><span>YEAR</span><span>RATING</span></div>
	//     </div>
	//   </a>
	function parseGridCards(html, base) {
		var items = [];
		var seen = {};
		if (!html || html.length < 200) return items;

		// Split by card anchor tags
		var parts = html.split(/<a\s+href=/gi);
		for (var i = 1; i < parts.length; i++) {
			var block = parts[i];
			// Extract href
			var hrefMatch = block.match(/^"([^"]+)"/);
			if (!hrefMatch) continue;
			var href = hrefMatch[1].trim();

			// Must be a movie link (contains ?d=loanid)
			if (href.indexOf("?d=loanid") === -1 && href.indexOf("/dub/p?id=") === -1)
				continue;

			var fullUrl = absUrl(base, href);
			if (seen[fullUrl]) continue;
			seen[fullUrl] = true;

			// Extract poster
			var poster = "";
			var pm = block.match(/<img[^>]+src="([^"]+)"/i);
			if (pm) poster = pm[1];

			// Extract title (card-name or movie-title)
			var title = "";
			var tm = block.match(/<div class="card-name">([\s\S]*?)<\/div>/i);
			if (!tm) tm = block.match(/<h3 class="movie-title">([\s\S]*?)<\/h3>/i);
			if (tm) title = decode(tm[1].trim());

			if (!title || title.length < 2) continue;

			// Extract year
			var year = null;
			var ym = block.match(/<span class="movie-year">(\d{4})<\/span>/i);
			if (!ym) {
				var metaParts = block.match(
					/<div class="card-meta">[\s\S]*?<span>(\d{4})/i,
				);
				if (metaParts) ym = metaParts;
			}
			if (ym) year = parseInt(ym[1]);

			// Extract rating
			var rating = null;
			var rm = block.match(
				/<span class="rating-badge">[^\d]*([\d.]+)<\/span>/i,
			);
			if (!rm) {
				var metaParts2 = block.match(/<span>(\d{4})<\/span><span>([\d.]+)/);
				if (metaParts2) rm = [null, null, metaParts2[2]];
			}
			if (rm) rating = parseFloat(rm[rm.length - 1]);

			// Determine type
			var type = "movie";
			if (
				href.indexOf("/web/") !== -1 ||
				block.match(/web.?series|season|episode/i)
			) {
				type = "series";
			}

			items.push(
				new MultimediaItem({
					title: title,
					url: fullUrl,
					posterUrl: poster || "",
					type: type,
					year: year || 0,
					score: rating || 0,
				}),
			);
		}

		return items;
	}

	// ---- Parse movie detail page ----
	function parseDetail(html, base) {
		var result = {
			title: "",
			posterUrl: "",
			year: null,
			score: null,
			description: "",
			files: [], // [{ name, size, url }]
		};
		if (!html || html.length < 200) return result;

		// Title — try multiple patterns
		var m = html.match(/<h1 class="movie-title">([\s\S]*?)<\/h1>/i);
		if (!m) m = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
		if (!m) m = html.match(/<title>([\s\S]*?)<\/title>/i);
		if (m) {
			result.title = decode(m[1].replace(/- MoviesWood/i, "").trim());
			result.title = result.title.replace(/<[^>]+>/g, "").trim();
		}

		// Poster
		m = html.match(/<div class="movie-poster">[\s\S]*?<img[^>]+src="([^"]+)"/i);
		if (m) result.posterUrl = m[1];

		// Year — try multiple patterns
		m = html.match(/<span class="meta-tag">[^<]*(\d{4})[^<]*<\/span>/i);
		if (!m) m = html.match(/Release[^:]*:\s*(\d{4})/i);
		if (!m) m = html.match(/<span>(19\d{2}|20\d{2})<\/span>/);
		if (m) result.year = parseInt(m[1]);

		// Score — try multiple patterns
		m = html.match(/<span class="meta-tag">⭐\s*([\d.]+)/i);
		if (!m) m = html.match(/⭐\s*([\d.]+)/);
		if (!m) m = html.match(/IMDB[^:]*:\s*([\d.]+)/i);
		if (!m) m = html.match(/rating[^:]*:\s*([\d.]+)/i);
		if (m) {
			var rv = parseFloat(m[1]);
			if (!isNaN(rv) && rv <= 10) result.score = rv;
		}

		// Description — try multiple patterns
		m = html.match(/<div class="movie-overview">([\s\S]*?)<\/div>/i);
		if (!m) m = html.match(/<meta\s+name="description"\s+content="([^"]+)"/i);
		if (!m)
			m = html.match(
				/<div[^>]*(?:summary|synopsis|plot|story)[^>]*>([\s\S]*?)<\/div>/i,
			);
		if (!m) {
			// Try to get description from any large text block near the poster
			var descSection = html.match(/movie-overview[\s\S]{0,200}?<\/div>/i);
			if (descSection) {
				m = descSection[0].match(/>([\s\S]*?)<\/div>/);
			}
		}
		if (m) {
			var desc = decode(m[1].trim());
			// Clean up common junk
			desc = desc
				.replace(/<[^>]+>/g, "")
				.replace(/\s+/g, " ")
				.trim();
			if (desc.length > 20) result.description = desc;
		}

		// Download files — match all dl-btn links on the page
		var dlMatches = html.match(
			/<a\s+href="([^"]*rating\.php[^"]*)"\s+class="dl-btn">⬇️ Download<\/a>/gi,
		);
		if (dlMatches) {
			for (var fi = 0; fi < dlMatches.length; fi++) {
				var urlM3 = dlMatches[fi].match(/href="([^"]+)"/i);
				if (!urlM3) continue;
				var fileUrl = absUrl(base, urlM3[1].trim());

				// Find corresponding name/size from nearby DOM
				// The page has <div class="file-item"> blocks in order
				var idx = html.indexOf(dlMatches[fi]);
				var before = html.substring(Math.max(0, idx - 400), idx);

				var nameM3 = before.match(/<div class="file-name">([\s\S]*?)<\/div>/i);
				var sizeM3 = before.match(/<div class="file-size">([\s\S]*?)<\/div>/i);

				var name = nameM3 ? decode(nameM3[1].trim()) : "File " + (fi + 1);
				var size = sizeM3 ? sizeM3[1].trim() : "";

				result.files.push({
					name: name,
					size: size,
					url: fileUrl,
				});
			}
		}

		return result;
	}

	// ---- Resolve rating.php page to get actual CDN URL ----
	// Uses fetchFast to keep within app time limits
	async function resolveRatingUrl(ratingUrl) {
		try {
			var res = await fetchFast(ratingUrl, getBase() + "/telly/");
			if (!res || !res.body || res.body.length < 200) return null;

			// The CDN URL is in data-href attribute of download button
			var m = res.body.match(/data-href="([^"]+)"/i);
			if (m) return m[1].trim();

			// Fallback: direct video URL in page
			var vm = res.body.match(
				/https?:\/\/[^"'\s<>]+\.(?:mp4|mkv|m3u8|webm)[^"'\s<>]*/i,
			);
			if (vm) return vm[0].trim().replace(/["'\]>].*$/, "");

			// Fallback: redirect
			var loc = res.body.match(
				/window\.location\s*(?:\.href)?\s*=\s*["']([^"']+)["']/i,
			);
			if (loc) return loc[1];

			return null;
		} catch (e) {
			return null;
		}
	}

	// ---- Magic proxy ----
	function magicProxy(url) {
		if (!CONFIG.USE_MAGIC_PROXY) return url;
		if (!url) return url;
		if (
			url.indexOf(".mp4") === -1 &&
			url.indexOf(".m3u8") === -1 &&
			url.indexOf(".mkv") === -1 &&
			url.indexOf(".webm") === -1 &&
			url.indexOf("cdn") === -1 &&
			url.indexOf("stream") === -1
		)
			return url;
		return "MAGIC_PROXY_v1" + btoa(url);
	}

	// ================================================================
	//  PAGE FETCHER (paginated)
	// ================================================================

	async function fetchPages(baseUrl, pathTemplate, maxPages) {
		var allItems = [];
		var seen = {};
		var count = Math.min(maxPages || 1, 10);
		var urls = [];

		// Build URLs for pages 1..count
		for (var p = 1; p <= count; p++) {
			var sep = pathTemplate.indexOf("?") !== -1 ? "&" : "?";
			urls.push({ url: pathTemplate + sep + "page=" + p, page: p });
		}
		// Also try without page param for page 1
		urls.unshift({ url: pathTemplate, page: 1 });

		var fetchOne = async function (u) {
			var res = await fetchURL(u.url, { referer: baseUrl + "/" });
			if (!res.body || res.body.length < 200) return [];
			return parseGridCards(res.body, baseUrl);
		};

		for (var s = 0; s < urls.length; s += CONFIG.CONCURRENT) {
			var batch = urls.slice(s, s + CONFIG.CONCURRENT);
			var results = await Promise.all(batch.map(fetchOne));
			for (var ri = 0; ri < results.length; ri++) {
				var items = results[ri] || [];
				for (var ii = 0; ii < items.length; ii++) {
					var item = items[ii];
					if (!seen[item.url]) {
						seen[item.url] = true;
						allItems.push(item);
					}
				}
			}
		}

		return allItems;
	}

	// ================================================================
	//  API FUNCTIONS
	// ================================================================

	// ---- getHome ----
	async function getHome(cb) {
		try {
			var base = getBase();
			log("getHome starting...");

			var cats = [
				{
					name: "2026 Movies",
					path: base + "/telly/?list=years&value=2026",
					pages: CONFIG.MAX_PAGES_2026,
				},
				{
					name: "2025 Movies",
					path: base + "/telly/?list=years&value=2025",
					pages: CONFIG.MAX_PAGES_2025,
				},
				{
					name: "All Movies",
					path: base + "/telly/?list=all",
					pages: CONFIG.MAX_PAGES_ALL,
				},
				{
					name: "Dubbed Movies",
					path: base + "/dub/",
					pages: CONFIG.MAX_PAGES_DUB,
				},
				{
					name: "Webseries",
					path: base + "/web/",
					pages: CONFIG.MAX_PAGES_WEB,
				},
			];

			var tasks = cats.map(function (c) {
				return fetchPages(base, c.path, c.pages)
					.then(function (items) {
						return { name: c.name, items: items };
					})
					.catch(function (e) {
						err("Category '" + c.name + "' failed:", e.message);
						return { name: c.name, items: [] };
					});
			});

			var results = await Promise.all(tasks);
			var data = {};
			var total = 0;

			for (var i = 0; i < results.length; i++) {
				if (results[i].items.length > 0) {
					data[results[i].name] = results[i].items;
					total += results[i].items.length;
				}
			}

			log(
				"getHome: " +
					total +
					" items across " +
					Object.keys(data).length +
					" categories",
			);

			if (total === 0) {
				cb({
					success: false,
					errorCode: "HOME_ERROR",
					message:
						"Could not load any content from movieswood.cloud. The site may be under maintenance.",
				});
			} else {
				cb({ success: true, data: data });
			}
		} catch (e) {
			err("getHome error:", e.message);
			cb({ success: false, errorCode: "HOME_ERROR", message: e.message });
		}
	}

	// ---- search ----
	async function search(query, cb) {
		try {
			var base = getBase();
			var q = encodeURIComponent(query);
			var results = [];
			var seen = {};

			log("Search: " + query);

			// Try telly search
			var res = await fetchURL(base + "/telly/?q=" + q, {
				referer: base + "/telly/",
			});
			if (res.body && res.body.length > 200) {
				var items = parseGridCards(res.body, base);
				for (var i = 0; i < items.length; i++) {
					if (!seen[items[i].url]) {
						seen[items[i].url] = true;
						results.push(items[i]);
					}
				}
			}

			// Try dub search
			var res2 = await fetchURL(base + "/dub/search?q=" + q, {
				referer: base + "/dub/",
			});
			if (res2.body && res2.body.length > 200) {
				var items2 = parseGridCards(res2.body, base);
				for (var j = 0; j < items2.length; j++) {
					if (!seen[items2[j].url]) {
						seen[items2[j].url] = true;
						results.push(items2[j]);
					}
				}
			}

			// Filter by query match
			var ql = query.toLowerCase();
			var filtered = results.filter(function (it) {
				return it.title.toLowerCase().indexOf(ql) !== -1;
			});

			cb({
				success: true,
				data: filtered.length > 0 ? filtered : results.slice(0, 50),
			});
		} catch (e) {
			err("search error:", e.message);
			cb({ success: true, data: [] });
		}
	}

	// ---- Fast fetch for load (8s timeout, 1 retry) ----
	async function fetchFast(url, referer) {
		var uas = [
			getUA(),
			"Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
			"Mozilla/5.0 (compatible; Bingbot/2.0; +http://www.bing.com/bingbot.htm)",
		];
		for (var attempt = 0; attempt < 2; attempt++) {
			try {
				var headers = {
					"User-Agent": uas[attempt % uas.length],
					Accept:
						"text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
					"Accept-Language": "en-US,en;q=0.5",
					Referer: referer || getBase() + "/",
					DNT: "1",
				};
				var res = await Promise.race([
					http_get(url, headers),
					new Promise(function (_, rej) {
						setTimeout(function () {
							rej(new Error("Timeout"));
						}, 8000);
					}),
				]);
				if (!res) continue;
				var body = res.body || "";
				var code = res.status || res.statusCode || 0;
				if (code >= 200 && code < 400 && body.length >= 200) {
					return { body: body, status: code };
				}
				if (code === 503 && body.indexOf("cf-browser") !== -1) {
					await sleep(1000 + Math.random() * 500);
					continue;
				}
				if (attempt === 0) await sleep(1500 + Math.random() * 500);
			} catch (e) {
				if (attempt === 0) await sleep(1000 + Math.random() * 500);
			}
		}
		return null;
	}

	// ---- load ----
	async function load(url, cb) {
		try {
			var base = getBase();
			log("Load: " + url.substring(0, 100));

			var res = await fetchFast(url, base + "/telly/");
			if (!res) {
				cb({
					success: false,
					errorCode: "LOAD_ERROR",
					message: "Failed to load page",
				});
				return;
			}

			var detail = parseDetail(res.body, base);
			var title = detail.title || "Unknown Title";

			// Determine type based on URL
			var contentType = "movie";
			if (
				url.indexOf("/web/") !== -1 ||
				title.match(/season|web.?series|episode/i)
			) {
				contentType = "series";
			}

			var item = new MultimediaItem({
				title: title,
				url: url,
				posterUrl: detail.posterUrl || "",
				type: contentType,
				year: detail.year || 0,
				description: detail.description || "",
				score: detail.score || 0,
			});

			// Build episodes
			var episodes = [];

			if (detail.files.length > 0) {
				var fileData = detail.files.map(function (f) {
					return {
						name: f.name,
						size: f.size,
						url: f.url,
						quality: quality(f.name + " " + f.url),
					};
				});
				episodes.push(
					new Episode({
						name: "Play Movie",
						url: JSON.stringify(fileData),
						season: 1,
						episode: 1,
					}),
				);
			} else {
				episodes.push(
					new Episode({
						name: "Play Movie",
						url: url,
						season: 1,
						episode: 1,
					}),
				);
			}

			item.episodes = episodes;
			log("Loaded: " + title + " (" + detail.files.length + " files)");
			cb({ success: true, data: item });
		} catch (e) {
			err("load error:", e.message);
			cb({ success: false, errorCode: "LOAD_ERROR", message: e.message });
		}
	}

	// ---- loadStreams ----
	async function loadStreams(dataStr, cb) {
		try {
			var base = getBase();
			log("loadStreams called");

			var files = [];

			// Parse input
			try {
				var parsed = JSON.parse(dataStr);
				if (Array.isArray(parsed)) {
					files = parsed;
				} else {
					files = [parsed];
				}
			} catch (e) {
				if (typeof dataStr === "string" && dataStr.length > 5) {
					files = [{ url: dataStr, name: "Stream", quality: "Auto" }];
				}
			}

			if (files.length === 0) {
				cb({ success: true, data: [] });
				return;
			}

			// Resolve each file URL to a stream
			var tasks = files.map(function (f) {
				return (async function () {
					var fileUrl = f.url || "";
					var fileQuality =
						f.quality || quality(f.name + " " + fileUrl) || "Auto";

					if (!fileUrl || fileUrl.length < 5) return null;

					// If it's a rating.php URL, resolve it
					if (fileUrl.indexOf("rating.php") !== -1) {
						var cdnUrl = await resolveRatingUrl(fileUrl);
						if (cdnUrl) {
							var q = quality(cdnUrl) || fileQuality;
							return new StreamResult({
								url: magicProxy(cdnUrl),
								quality: q,
								source: "MoviesWood [" + q + "]",
								headers: {
									"User-Agent": getUA(),
									Referer: base + "/telly/",
									Accept: "*/*",
								},
							});
						}
						// Fallback: use the rating URL itself with magic proxy
						return new StreamResult({
							url: magicProxy(fileUrl),
							quality: fileQuality,
							source: "MoviesWood [" + fileQuality + "]",
							headers: {
								"User-Agent": getUA(),
								Referer: base + "/telly/",
								Accept: "*/*",
							},
						});
					}

					// Direct video URL
					if (
						fileUrl.indexOf(".mp4") !== -1 ||
						fileUrl.indexOf(".mkv") !== -1 ||
						fileUrl.indexOf(".m3u8") !== -1 ||
						fileUrl.indexOf("http") === 0
					) {
						var q2 = quality(fileUrl) || fileQuality;
						return new StreamResult({
							url: magicProxy(fileUrl),
							quality: q2,
							source: "MoviesWood [" + q2 + "]",
							headers: {
								"User-Agent": getUA(),
								Referer: base + "/telly/",
								Accept: "*/*",
							},
						});
					}

					return null;
				})();
			});

			var streams = await Promise.all(tasks);
			var valid = [];
			var seen = {};
			for (var i = 0; i < streams.length; i++) {
				var s = streams[i];
				if (s && s.url && !seen[s.url]) {
					seen[s.url] = true;
					valid.push(s);
				}
			}

			log("Resolved " + valid.length + " streams");
			cb({ success: true, data: valid });
		} catch (e) {
			err("loadStreams error:", e.message);
			cb({ success: true, data: [] });
		}
	}

	// ---- Export ----
	globalThis.getHome = getHome;
	globalThis.search = search;
	globalThis.load = load;
	globalThis.loadStreams = loadStreams;

	log("MoviesWood plugin loaded");
})();
