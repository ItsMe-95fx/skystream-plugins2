(function () {
	"use strict";

	// ================================================================
	//  MoviesWood — SkyStream Gen 2 Plugin
	//  Multi-source scraper for movieswood.cloud
	//  Features: Anti-bot, header rotation, magic proxy, pagination
	// ================================================================

	// ---- Configurable Constants ----
	var CONFIG = {
		// Pagination: number of extra pages to fetch beyond page 1 for each category
		MAX_PAGES_2026: 4, // Pages 1..4 for 2026 Movies
		MAX_PAGES_2025: 4, // Pages 1..4 for 2025 Movies
		MAX_PAGES_ALL: 4, // Pages 1..4 for All Movies
		MAX_PAGES_DUB: 4, // Pages 1..4 for Dubbed Movies
		MAX_PAGES_WEB: 4, // Pages 1..4 for Webseries

		// Request tuning
		TIMEOUT_MS: 20000,
		RETRY_LIMIT: 3,
		RETRY_BASE_DELAY_MS: 1500,
		CONCURRENT_PAGES: 3, // How many page fetches in parallel

		// Whether to use magic proxy for video streams
		USE_MAGIC_PROXY: true,

		// Debug logging
		DEBUG: false,
	};

	// ---- Rotating User-Agent Pool ----
	var USER_AGENTS = [
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0",
		"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
		"Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
		"Mozilla/5.0 (Linux; Android 13; SM-S908B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
		"Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
		"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
	];

	// ---- Referer Pool ----
	var REFERERS = [
		"https://movieswood.cloud/",
		"https://movieswood.cloud/telly/",
		"https://movieswood.cloud/dub/",
		"https://movieswood.cloud/web/",
		"https://www.google.com/",
		"https://www.google.com/search?q=movies",
	];

	// ---- Accept-Language Pool ----
	var ACCEPT_LANGUAGES = [
		"en-US,en;q=0.9",
		"en-GB,en;q=0.8",
		"en-IN,en;q=0.9,hi;q=0.8",
		"en-US,en;q=0.9,es;q=0.8",
	];

	// ---- Internal State ----
	var _uaIndex = 0;
	var _refIndex = 0;
	var _langIndex = 0;

	// ================================================================
	//  Utility Helpers
	// ================================================================

	function getBaseUrl() {
		return typeof manifest !== "undefined" && manifest && manifest.baseUrl
			? manifest.baseUrl.replace(/\/+$/, "")
			: "https://movieswood.cloud";
	}

	function log() {
		if (CONFIG.DEBUG) {
			var args = Array.prototype.slice.call(arguments);
			args.unshift("[MoviesWood]");
			console.log.apply(console, args);
		}
	}

	function warn() {
		var args = Array.prototype.slice.call(arguments);
		args.unshift("[MoviesWood]");
		console.warn.apply(console, args);
	}

	function error() {
		var args = Array.prototype.slice.call(arguments);
		args.unshift("[MoviesWood]");
		console.error.apply(console, args);
	}

	// ---- URL Helpers ----
	function fixUrl(base, url) {
		if (!url) return "";
		if (url.indexOf("http://") === 0 || url.indexOf("https://") === 0)
			return url;
		var b = base || getBaseUrl();
		b = b.replace(/\/+$/, "");
		if (url.indexOf("/") === 0) return b + url;
		return b + "/" + url;
	}

	function resolveUrl(base, relative) {
		if (!relative) return "";
		if (relative.indexOf("http://") === 0 || relative.indexOf("https://") === 0)
			return relative;
		var b = base.replace(/\/+$/, "");
		if (relative.indexOf("/") === 0) return b + relative;
		// Resolve relative to path
		var basePath = b.split("/");
		basePath.pop(); // remove last segment
		return basePath.join("/") + "/" + relative;
	}

	// ---- HTML Decode ----
	function decodeHtml(str) {
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
			.replace(/&#039;/g, "'")
			.replace(/&apos;/g, "'");
	}

	// ---- Quality Extraction ----
	function extractQuality(text) {
		if (!text) return "Auto";
		var lower = text.toLowerCase();
		if (lower.indexOf("2160") !== -1 || lower.indexOf("4k") !== -1) return "4K";
		if (lower.indexOf("1080") !== -1) return "1080p";
		if (lower.indexOf("720") !== -1) return "720p";
		if (lower.indexOf("480") !== -1) return "480p";
		if (lower.indexOf("360") !== -1) return "360p";
		if (
			lower.indexOf("hdrip") !== -1 ||
			lower.indexOf("webrip") !== -1 ||
			lower.indexOf("web-dl") !== -1
		)
			return "HD";
		if (lower.indexOf("bluray") !== -1 || lower.indexOf("brrip") !== -1)
			return "BluRay";
		if (lower.indexOf("cam") !== -1) return "Cam";
		if (lower.indexOf("dvd") !== -1 || lower.indexOf("dvdrip") !== -1)
			return "DVD";
		// Try to find resolution pattern
		var m = lower.match(/(\d{3,4})\s*p/i);
		if (m) return m[1] + "p";
		return "Auto";
	}

	// ---- Text Truncation ----
	function truncate(str, maxLen) {
		if (!str) return "";
		if (str.length <= maxLen) return str;
		return str.substring(0, maxLen) + "...";
	}

	// ---- Title Cleanup ----
	function cleanTitle(title) {
		if (!title) return "";
		return decodeHtml(title)
			.replace(/Download\s+/i, "")
			.replace(/\[[^\]]*\]/g, "")
			.replace(/\([^)]*\)/g, "")
			.replace(/\s+/g, " ")
			.trim();
	}

	// ================================================================
	//  Anti-Bot: Header Rotation
	// ================================================================

	function getNextUserAgent() {
		var ua = USER_AGENTS[_uaIndex % USER_AGENTS.length];
		_uaIndex = (_uaIndex + 1) % USER_AGENTS.length;
		return ua;
	}

	function getNextReferer() {
		var ref = REFERERS[_refIndex % REFERERS.length];
		_refIndex = (_refIndex + 1) % REFERERS.length;
		return ref;
	}

	function getNextAcceptLanguage() {
		var lang = ACCEPT_LANGUAGES[_langIndex % ACCEPT_LANGUAGES.length];
		_langIndex = (_langIndex + 1) % ACCEPT_LANGUAGES.length;
		return lang;
	}

	function buildHeaders(extraReferer) {
		var headers = {
			"User-Agent": getNextUserAgent(),
			Accept:
				"text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
			"Accept-Language": getNextAcceptLanguage(),
			"Accept-Encoding": "gzip, deflate, br",
			Referer: extraReferer || getNextReferer(),
			DNT: "1",
			Connection: "keep-alive",
			"Upgrade-Insecure-Requests": "1",
			"Sec-Fetch-Dest": "document",
			"Sec-Fetch-Mode": "navigate",
			"Sec-Fetch-Site": "same-origin",
			"Sec-Fetch-User": "?1",
			"Cache-Control": "max-age=0",
		};
		return headers;
	}

	// ================================================================
	//  HTTP Layer with Retry, Backoff & Timeout
	// ================================================================

	function sleep(ms) {
		return new Promise(function (resolve) {
			setTimeout(resolve, ms);
		});
	}

	async function fetchWithRetry(url, options) {
		var opts = options || {};
		var retries =
			opts.retries !== undefined ? opts.retries : CONFIG.RETRY_LIMIT;
		var timeoutMs = opts.timeout || CONFIG.TIMEOUT_MS;
		var headers = opts.headers || buildHeaders();
		var referer = opts.referer || null;

		var lastError = null;
		var delay = CONFIG.RETRY_BASE_DELAY_MS;

		for (var attempt = 0; attempt <= retries; attempt++) {
			try {
				// Rotate headers on each retry for anti-bot
				var requestHeaders = headers;
				if (attempt > 0) {
					requestHeaders = buildHeaders(referer);
				}

				log(
					"Fetch attempt " +
						(attempt + 1) +
						"/" +
						(retries + 1) +
						": " +
						truncate(url, 120),
				);

				var result = await Promise.race([
					http_get(url, requestHeaders),
					new Promise(function (_, reject) {
						setTimeout(function () {
							reject(new Error("Request timed out after " + timeoutMs + "ms"));
						}, timeoutMs);
					}),
				]);

				if (!result) {
					throw new Error("Empty response from server");
				}

				var statusCode = result.status || result.statusCode || 0;
				var body = result.body || "";

				// Handle Cloudflare challenge (503 with JS)
				if (
					statusCode === 503 &&
					body.indexOf("cf-browser-verification") !== -1
				) {
					warn("Cloudflare challenge detected for: " + truncate(url, 80));
					if (attempt < retries) {
						var jitter = Math.floor(Math.random() * 2000);
						await sleep(delay + jitter);
						delay = Math.min(delay * 2, 10000);
						continue;
					}
					throw new Error("Cloudflare challenge could not be bypassed");
				}

				// Handle 429 Too Many Requests
				if (statusCode === 429) {
					warn("Rate limited (429) for: " + truncate(url, 80));
					if (attempt < retries) {
						var retryAfter =
							parseInt(result.headers && result.headers["Retry-After"]) ||
							delay / 1000;
						await sleep(retryAfter * 1000);
						delay = Math.min(delay * 2, 10000);
						continue;
					}
					throw new Error("Rate limited after " + (retries + 1) + " attempts");
				}

				// Handle 403 Forbidden
				if (statusCode === 403) {
					warn("Access forbidden (403) for: " + truncate(url, 80));
					if (attempt < retries) {
						await sleep(delay + Math.floor(Math.random() * 1000));
						delay = Math.min(delay * 2, 10000);
						continue;
					}
					throw new Error("Access forbidden");
				}

				// Handle 404
				if (statusCode === 404) {
					return { body: "", status: 404, error: "Not found" };
				}

				// Check for valid response
				if (statusCode >= 200 && statusCode < 400) {
					if (body && body.length > 100) {
						log(
							"Success: " + truncate(url, 80) + " (" + body.length + " bytes)",
						);
						return {
							body: body,
							status: statusCode,
							headers: result.headers || {},
						};
					}
					// Very short body might be an error page
					if (attempt < retries) {
						await sleep(delay);
						delay = Math.min(delay * 2, 10000);
						continue;
					}
					return {
						body: body,
						status: statusCode,
						headers: result.headers || {},
					};
				}

				// Unexpected status
				if (attempt < retries) {
					await sleep(delay + Math.floor(Math.random() * 1000));
					delay = Math.min(delay * 2, 10000);
					continue;
				}
				throw new Error("HTTP " + statusCode);
			} catch (e) {
				lastError = e;
				log("Attempt " + (attempt + 1) + " failed: " + e.message);
				if (attempt < retries) {
					var jitter2 = Math.floor(Math.random() * 1500);
					await sleep(delay + jitter2);
					delay = Math.min(delay * 2, 10000);
				}
			}
		}

		error(
			"All " +
				(retries + 1) +
				" fetch attempts failed for: " +
				truncate(url, 80),
		);
		return {
			body: "",
			status: 0,
			error: lastError ? lastError.message : "Unknown error",
		};
	}

	// ================================================================
	//  Magic Proxy Helper (Byte-Level Proxying)
	// ================================================================

	function makeMagicProxyUrl(targetUrl) {
		if (!CONFIG.USE_MAGIC_PROXY) return targetUrl;
		if (!targetUrl) return targetUrl;
		// Only use magic proxy for video/media URLs that need custom headers
		if (
			targetUrl.indexOf(".mp4") === -1 &&
			targetUrl.indexOf(".m3u8") === -1 &&
			targetUrl.indexOf(".mkv") === -1 &&
			targetUrl.indexOf(".ts") === -1 &&
			targetUrl.indexOf("stream") === -1 &&
			targetUrl.indexOf("cdn") === -1 &&
			targetUrl.indexOf("video") === -1
		) {
			return targetUrl;
		}
		// Use MAGIC_PROXY_v1 to pass through with custom referer
		return "MAGIC_PROXY_v1" + btoa(targetUrl);
	}

	// ================================================================
	//  HTML Parsing for MoviesWood
	// ================================================================

	/**
	 * Parse the telly directory listing page.
	 * Pattern: Movie entries in a list/table format with links and optional thumbnails.
	 */
	function parseTellyListing(html, baseUrl) {
		var items = [];
		var seen = {};
		var base = baseUrl || getBaseUrl();

		if (!html || html.length < 100) return items;

		// Pattern 1: Standard movie cards with posters
		// <div class="movie-card"> or <article> ... <a href="..."><img src="poster" alt="title">...</a> ... </div>
		var cardRegex =
			/<a\s+href="([^"]*telly\?d=[^"]*)"[^>]*>[\s\S]*?<img\s+src="([^"]+)"[^>]*alt="([^"]*)"[\s\S]*?<\/a>/gi;
		var match;
		while ((match = cardRegex.exec(html)) !== null) {
			var href = match[1].trim();
			var posterUrl = match[2].trim();
			var altText = decodeHtml(match[3].trim());

			if (!href || href.indexOf("telly?d=") === -1) continue;
			if (seen[href]) continue;
			seen[href] = true;

			var title = altText;
			if (!title || title.length < 2) continue;

			// Try to extract year from title
			var year = null;
			var ym = title.match(/\((\d{4})\)/);
			if (ym) {
				year = parseInt(ym[1]);
				title = title.replace(/\(\d{4}\)/, "").trim();
			}

			items.push(
				new MultimediaItem({
					title: title,
					url: fixUrl(base, href),
					posterUrl: fixUrl(base, posterUrl),
					type: "movie",
					year: year || 0,
					poster: fixUrl(base, posterUrl),
				}),
			);
		}

		// Pattern 2: Table rows (common in directory listings)
		// <tr>...<a href="/telly?d=XXX">Title</a>...</tr>
		if (items.length === 0) {
			var rowRegex =
				/<tr[^>]*>[\s\S]*?<a\s+href="([^"]*telly\?d=[^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/tr>/gi;
			while ((match = rowRegex.exec(html)) !== null) {
				var href2 = match[1].trim();
				var rawTitle = decodeHtml(match[2].trim());
				if (
					!rawTitle ||
					rawTitle.indexOf("Parent") !== -1 ||
					rawTitle === "." ||
					rawTitle === ".."
				)
					continue;
				if (seen[href2]) continue;
				seen[href2] = true;

				// Try to find poster in the same row
				var posterMatch = match[0].match(/<img\s+src="([^"]+)"[^>]*>/i);
				var poster = posterMatch ? posterMatch[1].trim() : "";

				var title2 = cleanTitle(rawTitle);
				if (!title2 || title2.length < 2) continue;

				var year2 = null;
				var ym2 = title2.match(/\((\d{4})\)/);
				if (ym2) {
					year2 = parseInt(ym2[1]);
					title2 = title2.replace(/\(\d{4}\)/, "").trim();
				}

				items.push(
					new MultimediaItem({
						title: title2,
						url: fixUrl(base, href2),
						posterUrl: fixUrl(base, poster),
						type: "movie",
						year: year2 || 0,
					}),
				);
			}
		}

		// Pattern 3: Simple link list (fallback)
		if (items.length === 0) {
			var linkRegex =
				/<a\s+href="([^"]*telly\?d=([^"]+))"[^>]*>([\s\S]*?)<\/a>/gi;
			while ((match = linkRegex.exec(html)) !== null) {
				var href3 = match[1].trim();
				var id = match[2].trim();
				var title3 = decodeHtml(match[3].trim());

				if (!title3 || title3.length < 2) continue;
				if (title3.indexOf("Parent") !== -1) continue;
				if (seen[href3]) continue;
				seen[href3] = true;

				var year3 = null;
				var ym3 = title3.match(/\((\d{4})\)/);
				if (ym3) {
					year3 = parseInt(ym3[1]);
					title3 = title3.replace(/\(\d{4}\)/, "").trim();
				}

				// Try to find poster in surrounding HTML
				var startIdx = Math.max(0, match.index - 500);
				var surrounding = html.substring(
					startIdx,
					match.index + match[0].length + 500,
				);
				var posterMatch3 = surrounding.match(/<img[^>]+src="([^"]+)"/i);
				var poster3 = posterMatch3 ? posterMatch3[1] : "";

				var finalTitle = cleanTitle(title3);
				if (!finalTitle || finalTitle.length < 2) continue;

				items.push(
					new MultimediaItem({
						title: finalTitle,
						url: fixUrl(base, href3),
						posterUrl: fixUrl(base, poster3),
						type: "movie",
						year: year3 || 0,
					}),
				);
			}
		}

		// Deduplicate by URL
		var deduped = [];
		var urlSet = {};
		for (var i = 0; i < items.length; i++) {
			if (!urlSet[items[i].url]) {
				urlSet[items[i].url] = true;
				deduped.push(items[i]);
			}
		}

		log("Parsed " + deduped.length + " items from telly listing");
		return deduped;
	}

	/**
	 * Parse movie detail page from /telly/?d=XXX
	 */
	function parseMovieDetail(html, baseUrl) {
		var result = {
			title: "",
			posterUrl: "",
			year: null,
			description: "",
			score: null,
			genre: "",
			language: "",
			qualities: [],
			downloadLinks: [],
			isSeries: false,
			episodes: [],
		};

		if (!html || html.length < 200) return result;

		var base = baseUrl || getBaseUrl();

		// Title from h1 or page title
		var m = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
		if (m) result.title = decodeHtml(m[1].trim());

		if (!result.title) {
			m = html.match(/<title>([\s\S]*?)<\/title>/i);
			if (m) result.title = decodeHtml(m[1].replace(/Download/i, "").trim());
		}

		// Poster image
		m = html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/i);
		if (m) result.posterUrl = m[1];
		if (!result.posterUrl) {
			m = html.match(/<img[^>]+src="([^"]+)"[^>]*class="[^"]*poster[^"]*"/i);
			if (m) result.posterUrl = m[1];
		}
		if (!result.posterUrl) {
			m = html.match(/<img[^>]+src="([^"]+)"[^>]*>/i);
			if (m) result.posterUrl = m[1];
		}

		// Description / synopsis
		m = html.match(/<meta\s+name="description"\s+content="([^"]+)"/i);
		if (m) result.description = decodeHtml(m[1]);
		if (!result.description) {
			m = html.match(
				/<div[^>]*(?:summary|overview|description|synopsis)[^>]*>[\s\S]*?<p>([\s\S]*?)<\/p>/i,
			);
			if (m) result.description = decodeHtml(m[1]);
		}

		// Year from various meta tags
		m = html.match(/<span[^>]*class="[^"]*year[^"]*"[^>]*>(\d{4})<\/span>/i);
		if (m) result.year = parseInt(m[1]);
		if (!result.year) {
			m = html.match(/Release\s*(?:Year|Date)[^:]*:\s*(\d{4})/i);
			if (m) result.year = parseInt(m[1]);
		}

		// Score / rating
		m = html.match(
			/<span[^>]*class="[^"]*(?:rating|score|imdb)[^"]*"[^>]*>([\d.]+)<\/span>/i,
		);
		if (m) result.score = parseFloat(m[1]);
		if (!result.score) {
			m = html.match(/IMDB[^:]*:\s*([\d.]+)/i);
			if (m) result.score = parseFloat(m[1]);
		}

		// Genre
		m = html.match(/<span[^>]*class="[^"]*genre[^"]*"[^>]*>([^<]+)<\/span>/i);
		if (m) result.genre = m[1].trim();

		// Language
		m = html.match(
			/<span[^>]*class="[^"]*language[^"]*"[^>]*>([^<]+)<\/span>/i,
		);
		if (m) result.language = m[1].trim();

		// Check if this is a series
		if (
			result.title.match(/(?:Season|Web.?Series|Episode)\s*\d+/i) ||
			html.match(/season-\d+/i) ||
			html.match(/episode-\d+/i)
		) {
			result.isSeries = true;
		}

		// ---- Extract Download/Stream Links ----
		// Pattern: Direct links to loanid pages
		// <a href="/loanid/...">Title</a> or /telly/?d=...
		var dlRegex =
			/<a\s+href="(\/[^"]*(?:loanid|telly\?d=)[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
		while ((m = dlRegex.exec(html)) !== null) {
			var linkHref = m[1].trim();
			var linkText = decodeHtml(m[2].replace(/<[^>]+>/g, "").trim());

			if (!linkText || linkText.indexOf("Parent") !== -1 || linkText.length < 2)
				continue;

			var quality = extractQuality(linkText + " " + linkHref);
			result.downloadLinks.push({
				url: fixUrl(base, linkHref),
				text: linkText,
				quality: quality,
			});
		}

		// Pattern: Download buttons with quality labels
		// <a href="..." class="download-btn">1080p</a>
		var btnRegex =
			/<a\s+href="([^"]+)"[^>]*class="[^"]*(?:download|btn)[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
		while ((m = btnRegex.exec(html)) !== null) {
			var btnHref = m[1].trim();
			var btnText = decodeHtml(m[2].replace(/<[^>]+>/g, "").trim());

			if (!btnText || btnHref.indexOf("#") === 0) continue;

			// Skip social links
			if (
				btnHref.indexOf("facebook") !== -1 ||
				btnHref.indexOf("twitter") !== -1
			)
				continue;

			var exists = result.downloadLinks.some(function (dl) {
				return dl.url === fixUrl(base, btnHref);
			});
			if (!exists) {
				var q = extractQuality(btnText + " " + btnHref);
				result.downloadLinks.push({
					url: fixUrl(base, btnHref),
					text: btnText,
					quality: q,
				});
			}
		}

		// Pattern: Table rows with file links
		var tblRegex =
			/<tr[^>]*>[\s\S]*?<a\s+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/tr>/gi;
		while ((m = tblRegex.exec(html)) !== null) {
			var tblHref = m[1].trim();
			var tblText = decodeHtml(m[2].replace(/<[^>]+>/g, "").trim());

			if (!tblText || tblText.indexOf("Parent") !== -1) continue;
			if (tblHref.indexOf("#") === 0) continue;

			// Check if it's a media file or a loanid page
			var isMediaLink =
				tblHref.indexOf(".mp4") !== -1 ||
				tblHref.indexOf(".mkv") !== -1 ||
				tblHref.indexOf(".m3u8") !== -1 ||
				tblHref.indexOf("loanid") !== -1 ||
				tblHref.indexOf("telly?d=") !== -1;

			if (!isMediaLink) continue;

			var exists2 = result.downloadLinks.some(function (dl) {
				return dl.url === fixUrl(base, tblHref);
			});
			if (!exists2) {
				var q2 = extractQuality(tblText + " " + tblHref);
				result.downloadLinks.push({
					url: fixUrl(base, tblHref),
					text: tblText,
					quality: q2,
				});
			}
		}

		// ---- Extract Episode Links for Series ----
		if (result.isSeries) {
			var episodeRegex =
				/<a\s+href="([^"]+)"[^>]*>[\s\S]*?(?:Episode|Ep|E)\s*(\d+)[\s\S]*?<\/a>/gi;
			var episodeMap = {};
			while ((m = episodeRegex.exec(html)) !== null) {
				var epHref = m[1].trim();
				var epNum = parseInt(m[2]);
				if (!epHref || epHref.indexOf("#") === 0) continue;
				if (!episodeMap[epNum]) episodeMap[epNum] = [];
				if (episodeMap[epNum].indexOf(epHref) === -1) {
					episodeMap[epNum].push(epHref);
				}
			}

			// Also look for episode sections with lists
			var epSectionRegex =
				/<div[^>]*class="[^"]*episode[^"]*"[^>]*>[\s\S]*?<a\s+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
			while ((m = epSectionRegex.exec(html)) !== null) {
				var secHref = m[1].trim();
				var secText = decodeHtml(m[2].replace(/<[^>]+>/g, "").trim());
				var epMatch = secText.match(/(\d+)/);
				if (epMatch) {
					var epNum2 = parseInt(epMatch[1]);
					if (!episodeMap[epNum2]) episodeMap[epNum2] = [];
					if (episodeMap[epNum2].indexOf(secHref) === -1) {
						episodeMap[epNum2].push(secHref);
					}
				}
			}

			// Build episode objects
			var epNums = Object.keys(episodeMap).sort(function (a, b) {
				return parseInt(a) - parseInt(b);
			});
			for (var ei = 0; ei < epNums.length; ei++) {
				var num = parseInt(epNums[ei]);
				var urls = episodeMap[num];
				result.episodes.push({
					name: "Episode " + num,
					season: 1,
					episode: num,
					urls: urls,
				});
			}
		}

		return result;
	}

	/**
	 * Resolve a loanid page to find the actual CDN video URL.
	 * The loanid page typically contains a redirect or direct video link.
	 */
	async function resolveLoanUrl(loanUrl) {
		try {
			var headers = buildHeaders(getBaseUrl() + "/");
			var result = await fetchWithRetry(loanUrl, {
				headers: headers,
				referer: getBaseUrl() + "/",
				timeout: 15000,
			});

			if (!result.body || result.body.length < 50) return null;

			var html = result.body;

			// Pattern 1: Direct video URL in the page
			var videoRegex =
				/https?:\/\/[^"'\s<>]+\.(?:mp4|mkv|m3u8|webm)[^"'\s<>]*/i;
			var vm = videoRegex.exec(html);
			if (vm) {
				var videoUrl = vm[0].trim();
				// Clean up trailing junk
				videoUrl = videoUrl.replace(/["'\]>].*$/, "");
				var quality = extractQuality(videoUrl);
				return {
					url: videoUrl,
					quality: quality,
					source: "Direct",
				};
			}

			// Pattern 2: JavaScript redirect
			var redirectMatch = /window\.location\.href\s*=\s*["']([^"']+)["']/i.exec(
				html,
			);
			if (redirectMatch) {
				var redirectUrl = redirectMatch[1].trim();
				if (redirectUrl.indexOf("http") !== 0) {
					redirectUrl = fixUrl(getBaseUrl(), redirectUrl);
				}
				// Recursively resolve the redirect
				return await resolveLoanUrl(redirectUrl);
			}

			// Pattern 3: var url = '...'  (common in hubcloud-style redirectors)
			var varUrlMatch = /var\s+url\s*=\s*['"]([^'"]+)['"]/i.exec(html);
			if (varUrlMatch) {
				var varUrl = varUrlMatch[1].trim();
				if (varUrl.indexOf("http") !== 0) {
					var origin = loanUrl.substring(0, loanUrl.indexOf("/", 8));
					varUrl = origin + "/" + varUrl.replace(/^\//, "");
				}
				return await resolveLoanUrl(varUrl);
			}

			// Pattern 4: Encoded link (base64 in script)
			var base64Match = html.match(
				/atob\s*\(\s*["']([A-Za-z0-9+/=]+)["']\s*\)/i,
			);
			if (base64Match) {
				try {
					var decoded = atob(base64Match[1]);
					var extractedUrl = decoded.match(/https?:\/\/[^"'\s]+/i);
					if (extractedUrl) {
						var quality2 = extractQuality(decoded);
						return {
							url: extractedUrl[0],
							quality: quality2,
							source: "Decoded",
						};
					}
				} catch (e) {
					// Invalid base64, continue
				}
			}

			// Pattern 5: Embedded video player (iframe)
			var iframeMatch = /<iframe[^>]+src="([^"]+)"[^>]*>/i.exec(html);
			if (iframeMatch) {
				var iframeUrl = iframeMatch[1].trim();
				if (iframeUrl.indexOf("http") !== 0) {
					var base2 = loanUrl.substring(0, loanUrl.indexOf("/", 8));
					iframeUrl = base2 + "/" + iframeUrl.replace(/^\//, "");
				}
				// Some iframes contain direct video
				var iframeResult = await fetchWithRetry(iframeUrl, {
					headers: buildHeaders(loanUrl),
					referer: loanUrl,
					timeout: 15000,
				});
				if (iframeResult.body) {
					var vm2 = videoRegex.exec(iframeResult.body);
					if (vm2) {
						var vUrl2 = vm2[0].replace(/["'\]>].*$/, "");
						var quality3 = extractQuality(vUrl2);
						return {
							url: vUrl2,
							quality: quality3,
							source: "Iframe",
						};
					}
				}
			}

			// Pattern 6: Just return the page URL if it looks like a video
			if (
				loanUrl.indexOf(".mp4") !== -1 ||
				loanUrl.indexOf(".mkv") !== -1 ||
				loanUrl.indexOf(".m3u8") !== -1
			) {
				return {
					url: loanUrl,
					quality: extractQuality(loanUrl),
					source: "DirectLink",
				};
			}

			return null;
		} catch (e) {
			error("resolveLoanUrl error:", e.message);
			return null;
		}
	}

	// ================================================================
	//  Page Fetcher for Paginated Categories
	// ================================================================

	/**
	 * Fetch multiple pages of a listing and merge results.
	 */
	async function fetchPaginated(baseUrl, pathTemplate, maxPages) {
		var allItems = [];
		var seen = {};
		var pagesToFetch = Math.min(maxPages, 10); // Safety cap

		// Build page URLs
		var pageUrls = [];
		for (var pg = 1; pg <= pagesToFetch; pg++) {
			var url = pathTemplate;
			if (url.indexOf("?") !== -1) {
				url += "&page=" + pg;
			} else {
				url += "?page=" + pg;
			}
			// For first page, also try without page param for compatibility
			if (pg === 1) {
				pageUrls.push({ url: pathTemplate, page: pg });
			}
			pageUrls.push({ url: url, page: pg });
		}

		// Fetch pages concurrently with a concurrency limit
		var concurrency = CONFIG.CONCURRENT_PAGES;
		var results = [];

		for (var start = 0; start < pageUrls.length; start += concurrency) {
			var batch = pageUrls.slice(start, start + concurrency);
			var batchResults = await Promise.all(
				batch.map(function (p) {
					return fetchWithRetry(p.url, {
						headers: buildHeaders(baseUrl + "/"),
						referer: baseUrl + "/",
						timeout: CONFIG.TIMEOUT_MS,
					}).then(function (res) {
						return { page: p.page, url: p.url, result: res };
					});
				}),
			);
			results = results.concat(batchResults);
		}

		// Process each page result
		for (var ri = 0; ri < results.length; ri++) {
			var r = results[ri];
			if (!r.result || !r.result.body || r.result.body.length < 100) {
				log("Page " + r.page + " returned empty response");
				continue;
			}

			var items = parseTellyListing(r.result.body, baseUrl);
			log("Page " + r.page + " yielded " + items.length + " items");

			for (var ii = 0; ii < items.length; ii++) {
				var item = items[ii];
				if (!seen[item.url]) {
					seen[item.url] = true;
					allItems.push(item);
				}
			}
		}

		log(
			"Total unique items across " +
				pageUrls.length +
				" URLs: " +
				allItems.length,
		);
		return allItems;
	}

	// ================================================================
	//  Core API Functions (SkyStream Interface)
	// ================================================================

	// ---- 1. getHome ----
	async function getHome(cb) {
		try {
			var base = getBaseUrl();

			log("Starting getHome...");

			// Define all categories with their URLs and pagination settings
			var categories = [
				{
					name: "2026 Movies",
					path: base + "/telly/?list=years&value=2026",
					maxPages: CONFIG.MAX_PAGES_2026,
				},
				{
					name: "2025 Movies",
					path: base + "/telly/?list=years&value=2025",
					maxPages: CONFIG.MAX_PAGES_2025,
				},
				{
					name: "All Movies",
					path: base + "/telly/?list=all",
					maxPages: CONFIG.MAX_PAGES_ALL,
				},
				{
					name: "Dubbed Movies",
					path: base + "/dub/",
					maxPages: CONFIG.MAX_PAGES_DUB,
				},
				{
					name: "Webseries",
					path: base + "/web/",
					maxPages: CONFIG.MAX_PAGES_WEB,
				},
			];

			var homeData = {};
			var fetchTasks = [];

			// Start fetching all categories concurrently
			for (var ci = 0; ci < categories.length; ci++) {
				var cat = categories[ci];
				fetchTasks.push(
					fetchPaginated(base, cat.path, cat.maxPages)
						.then(function (items) {
							return { name: cat.name, items: items };
						})
						.catch(function (err) {
							error("Category " + cat.name + " failed:", err.message);
							return { name: cat.name, items: [] };
						}),
				);
			}

			// Wait for all categories to load
			var catResults = await Promise.all(fetchTasks);

			for (var i = 0; i < catResults.length; i++) {
				var cr = catResults[i];
				if (cr.items && cr.items.length > 0) {
					homeData[cr.name] = cr.items;
					log("Category '" + cr.name + "': " + cr.items.length + " items");
				} else {
					log("Category '" + cr.name + "' returned no items");
				}
			}

			// Check if we got any data at all
			var totalItems = 0;
			for (var key in homeData) {
				if (homeData.hasOwnProperty(key)) {
					totalItems += homeData[key].length;
				}
			}

			if (totalItems === 0) {
				// Fallback: try to fetch the main page for any content
				log("No items from categories, trying main page fallback...");
				var fallbackResult = await fetchWithRetry(base + "/telly/?list=all", {
					headers: buildHeaders(base + "/"),
					referer: base + "/",
				});

				if (fallbackResult.body && fallbackResult.body.length > 200) {
					var fallbackItems = parseTellyListing(fallbackResult.body, base);
					if (fallbackItems.length > 0) {
						homeData["All Movies"] = fallbackItems;
					}
				}
			}

			if (Object.keys(homeData).length === 0) {
				cb({
					success: false,
					errorCode: "HOME_ERROR",
					message:
						"All sources failed to load. The site may be under maintenance or behind Cloudflare.",
				});
			} else {
				cb({ success: true, data: homeData });
			}
		} catch (e) {
			error("getHome error:", e.message);
			cb({
				success: false,
				errorCode: "HOME_ERROR",
				message: e.message,
			});
		}
	}

	// ---- 2. search ----
	async function search(query, cb) {
		try {
			var base = getBaseUrl();
			var q = encodeURIComponent(query);
			var results = [];

			log("Searching for: " + query);

			// Search via telly listing
			var searchUrl = base + "/telly/?list=search&q=" + q;
			var searchResult = await fetchWithRetry(searchUrl, {
				headers: buildHeaders(base + "/telly/"),
				referer: base + "/telly/",
				timeout: CONFIG.TIMEOUT_MS,
			});

			if (searchResult.body && searchResult.body.length > 200) {
				var items = parseTellyListing(searchResult.body, base);
				results = results.concat(items);
			}

			// Also try searching in dubbed section
			var dubSearchUrl = base + "/dub/?s=" + q;
			var dubResult = await fetchWithRetry(dubSearchUrl, {
				headers: buildHeaders(base + "/dub/"),
				referer: base + "/dub/",
				timeout: 15000,
			});

			if (dubResult.body && dubResult.body.length > 200) {
				var dubItems = parseTellyListing(dubResult.body, base);
				// Deduplicate
				var existingUrls = {};
				for (var k = 0; k < results.length; k++) {
					existingUrls[results[k].url] = true;
				}
				for (var d = 0; d < dubItems.length; d++) {
					if (!existingUrls[dubItems[d].url]) {
						results.push(dubItems[d]);
					}
				}
			}

			// Filter results that actually match the query
			var qLower = query.toLowerCase();
			var filtered = [];
			var seenUrls = {};
			for (var r = 0; r < results.length; r++) {
				var item = results[r];
				if (seenUrls[item.url]) continue;
				seenUrls[item.url] = true;
				if (item.title.toLowerCase().indexOf(qLower) !== -1) {
					filtered.push(item);
				}
			}

			// If no exact matches, return whatever we found
			if (filtered.length === 0) {
				filtered = results;
			}

			log("Search returned " + filtered.length + " results");
			cb({ success: true, data: filtered });
		} catch (e) {
			error("search error:", e.message);
			cb({ success: true, data: [] });
		}
	}

	// ---- 3. load (Movie/Series Detail) ----
	async function load(url, cb) {
		try {
			var base = getBaseUrl();
			log("Loading detail for: " + truncate(url, 100));

			// Fetch the movie detail page
			var result = await fetchWithRetry(url, {
				headers: buildHeaders(base + "/"),
				referer: base + "/telly/",
				timeout: CONFIG.TIMEOUT_MS,
			});

			if (!result.body || result.body.length < 200) {
				cb({
					success: false,
					errorCode: "LOAD_ERROR",
					message: "Failed to load movie page - empty response",
				});
				return;
			}

			var detail = parseMovieDetail(result.body, base);
			var title = detail.title || "Unknown Title";

			// Determine type
			var contentType = detail.isSeries ? "series" : "movie";

			log(
				"Title: " +
					title +
					", Type: " +
					contentType +
					", Links: " +
					detail.downloadLinks.length,
			);

			// Build multimedia item
			var multimediaItem = new MultimediaItem({
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

			if (detail.isSeries && detail.episodes.length > 0) {
				// Series with multiple episodes
				for (var ei = 0; ei < detail.episodes.length; ei++) {
					var ep = detail.episodes[ei];
					var epUrls = ep.urls || [];
					var epData = JSON.stringify(epUrls);

					episodes.push(
						new Episode({
							name: ep.name || "Episode " + ep.episode,
							url: epData,
							season: ep.season || 1,
							episode: ep.episode || ei + 1,
						}),
					);
				}
			} else {
				// Movie or series without episode parsing - use download links
				if (detail.downloadLinks.length > 0) {
					// Store download links as JSON for loadStreams to process
					var linkData = detail.downloadLinks.map(function (dl) {
						return {
							url: dl.url,
							text: dl.text,
							quality: dl.quality,
						};
					});

					episodes.push(
						new Episode({
							name: "Play Movie",
							url: JSON.stringify(linkData),
							season: 1,
							episode: 1,
						}),
					);
				} else {
					// No links found - store the page URL as fallback
					episodes.push(
						new Episode({
							name: "Play Movie",
							url: url,
							season: 1,
							episode: 1,
						}),
					);
				}
			}

			multimediaItem.episodes = episodes;

			log(
				"Load complete: " + title + " with " + episodes.length + " episode(s)",
			);
			cb({ success: true, data: multimediaItem });
		} catch (e) {
			error("load error:", e.message);
			cb({
				success: false,
				errorCode: "LOAD_ERROR",
				message: e.message,
			});
		}
	}

	// ---- 4. loadStreams ----
	async function loadStreams(dataStr, cb) {
		try {
			var base = getBaseUrl();
			log("loadStreams called with: " + truncate(dataStr, 150));

			var links = [];

			// Parse the data string (JSON array of links or a single URL)
			try {
				var parsed = JSON.parse(dataStr);
				if (Array.isArray(parsed)) {
					links = parsed;
				} else {
					links = [parsed];
				}
			} catch (e) {
				// Not JSON - treat as a single URL
				if (dataStr && dataStr.length > 5) {
					links = [{ url: dataStr, text: "Stream", quality: "Auto" }];
				}
			}

			if (links.length === 0) {
				log("No links to resolve");
				cb({ success: true, data: [] });
				return;
			}

			log("Processing " + links.length + " link(s)");

			// Resolve each link to a stream
			var streamTasks = [];
			for (var li = 0; li < links.length; li++) {
				var link = links[li];
				var linkUrl = link.url || link;
				var linkText = link.text || "Stream";
				var linkQuality = link.quality || "Auto";

				streamTasks.push(
					(function (url, text, quality) {
						return resolveLinkToStream(url, text, quality, base);
					})(linkUrl, linkText, linkQuality),
				);
			}

			var streamResults = await Promise.all(streamTasks);

			// Flatten results and deduplicate
			var allStreams = [];
			var seenUrls = {};
			for (var si = 0; si < streamResults.length; si++) {
				var streams = streamResults[si];
				if (!streams) continue;
				if (!Array.isArray(streams)) streams = [streams];
				for (var sj = 0; sj < streams.length; sj++) {
					var stream = streams[sj];
					if (stream && stream.url && !seenUrls[stream.url]) {
						seenUrls[stream.url] = true;
						allStreams.push(stream);
					}
				}
			}

			log("Resolved " + allStreams.length + " stream(s)");

			if (allStreams.length === 0) {
				// Fallback: if we have links but couldn't resolve, try direct streaming
				log("No streams resolved, using direct links as fallback");
				for (var fi = 0; fi < links.length; fi++) {
					var fallbackLink = links[fi];
					var fbUrl = fallbackLink.url || fallbackLink;
					if (typeof fbUrl === "string" && fbUrl.indexOf("http") === 0) {
						var qual = fallbackLink.quality || extractQuality(fbUrl) || "Auto";
						var magicUrl = makeMagicProxyUrl(fbUrl);
						allStreams.push(
							new StreamResult({
								url: magicUrl,
								quality: qual,
								source: "MoviesWood [" + qual + "]",
								headers: {
									"User-Agent": getNextUserAgent(),
									Referer: base + "/",
									Accept: "*/*",
								},
							}),
						);
					}
				}
			}

			cb({ success: true, data: allStreams });
		} catch (e) {
			error("loadStreams error:", e.message);
			cb({ success: true, data: [] });
		}
	}

	/**
	 * Resolve a single link to stream(s).
	 * Handles: direct video URLs, loanid pages, redirect chains.
	 */
	async function resolveLinkToStream(url, text, quality, base) {
		try {
			if (!url || url.indexOf("http") !== 0) return null;

			var streams = [];

			// Case 1: Direct video URL
			if (
				url.indexOf(".mp4") !== -1 ||
				url.indexOf(".mkv") !== -1 ||
				url.indexOf(".webm") !== -1 ||
				url.indexOf(".m3u8") !== -1
			) {
				var q = quality || extractQuality(url + " " + text);
				var magicUrl = makeMagicProxyUrl(url);
				streams.push(
					new StreamResult({
						url: magicUrl,
						quality: q,
						source: "MoviesWood [" + q + "]",
						headers: {
							"User-Agent": getNextUserAgent(),
							Referer: base + "/",
							Accept: "*/*",
						},
					}),
				);
				return streams;
			}

			// Case 2: LoanID page - needs resolution
			if (url.indexOf("loanid") !== -1 || url.indexOf("telly?d=") !== -1) {
				var resolved = await resolveLoanUrl(url);
				if (resolved && resolved.url) {
					var q2 =
						quality || resolved.quality || extractQuality(url + " " + text);
					var magicUrl2 = makeMagicProxyUrl(resolved.url);
					streams.push(
						new StreamResult({
							url: magicUrl2,
							quality: q2,
							source: "MoviesWood [" + q2 + "]",
							headers: {
								"User-Agent": getNextUserAgent(),
								Referer: base + "/",
								Accept: "*/*",
							},
						}),
					);
				} else {
					// Fallback: try to use the loan URL directly with magic proxy
					var magicUrl3 = makeMagicProxyUrl(url);
					var q3 = quality || "Auto";
					streams.push(
						new StreamResult({
							url: magicUrl3,
							quality: q3,
							source: "MoviesWood [" + q3 + "]",
							headers: {
								"User-Agent": getNextUserAgent(),
								Referer: base + "/",
								Accept: "*/*",
							},
						}),
					);
				}
				return streams;
			}

			// Case 3: Unknown link type - try as direct
			var q4 = quality || extractQuality(url + " " + text) || "Auto";
			var magicUrl4 = makeMagicProxyUrl(url);
			streams.push(
				new StreamResult({
					url: magicUrl4,
					quality: q4,
					source: "MoviesWood [" + q4 + "]",
					headers: {
						"User-Agent": getNextUserAgent(),
						Referer: base + "/",
						Accept: "*/*",
					},
				}),
			);

			return streams;
		} catch (e) {
			error(
				"resolveLinkToStream error for " + truncate(url, 80) + ":",
				e.message,
			);
			return null;
		}
	}

	// ---- Export to SkyStream ----
	globalThis.getHome = getHome;
	globalThis.search = search;
	globalThis.load = load;
	globalThis.loadStreams = loadStreams;

	log("MoviesWood plugin loaded successfully");
})();
