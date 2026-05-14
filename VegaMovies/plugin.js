(function() {
    'use strict';

    var BASE_URL = manifest && manifest.baseUrl ? manifest.baseUrl : 'https://vegamovies.market';
    var CINEMETA_URL = 'https://v3-cinemeta.strem.io/meta';
    var DYNAMIC_URLS = 'https://raw.githubusercontent.com/SaurabhKaperwan/Utils/refs/heads/main/urls.json';

    var HEADERS = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5'
    };

    // ========================================================================
    // HELPERS
    // ========================================================================

    async function fetchUrl(url, ch) {
        try {
            var merged = Object.assign({}, HEADERS, ch || {});
            var res = await http_get(url, merged);
            return res ? (res.body || res.text || '') : '';
        } catch (e) { return ''; }
    }

    async function fetchJson(url, ch) {
        try {
            var merged = Object.assign({}, HEADERS, ch || {});
            var res = await http_get(url, merged);
            var t = res ? (res.body || res.text || '') : '';
            return t ? JSON.parse(t) : null;
        } catch (e) { return null; }
    }

    function fixUrl(url) {
        if (!url) return '';
        if (url.indexOf('://') >= 0) return url;
        if (url.indexOf('//') === 0) return 'https:' + url;
        if (url.indexOf('/') === 0) return BASE_URL + url;
        return BASE_URL + '/' + url;
    }

    function stripHtml(t) { return t ? t.replace(/<[^>]*>/g, '') : ''; }

    function extractTagText(html, tag) {
        if (!html) return '';
        var m = html.match(new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)</' + tag + '>', 'i'));
        return m ? m[1].replace(/<[^>]*>/g, '').trim() : '';
    }

    function getBaseUrl(url) {
        var m = url.match(/^(https?:\/\/[^\/]+)/);
        return m ? m[1] : url;
    }

    function getQualityNum(str) {
        if (!str) return 0;
        var m = str.match(/(\d{3,4})[pP]/);
        if (m) return parseInt(m[1]);
        var lower = str.toLowerCase();
        if (lower.indexOf('8k') >= 0) return 4320;
        if (lower.indexOf('4k') >= 0) return 2160;
        if (lower.indexOf('2k') >= 0) return 1440;
        return 0;
    }

    function isBadUrl(url, pu) {
        if (!url || url === '#' || url === '/' || url === '') return true;
        var b = pu || BASE_URL;
        if (url === b || url === b + '/') return true;
        return false;
    }

    function findElements(html, tag, filter) {
        if (!html) return [];
        var results = [];
        var re = new RegExp('<' + tag + '([^>]*)>([\\s\\S]*?)</' + tag + '>', 'gi');
        var m;
        while ((m = re.exec(html)) !== null) {
            var text = stripHtml(m[2] || '');
            if (filter && text.toLowerCase().indexOf(filter.toLowerCase()) < 0) continue;
            results.push({ html: m[0], inner: m[1] || '', text: text, index: m.index });
        }
        return results;
    }

    function nextSiblingAt(html, pos) {
        if (!html || pos < 0 || pos >= html.length) return null;
        var rest = html.substring(pos);
        var tm = rest.match(/<(\w+)(?:\s[^>]*)?>/);
        if (!tm) return null;
        var t = tm[1];
        var f = rest.match(new RegExp('<' + t + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + t + '>', 'i'));
        if (!f) return null;
        return { tag: t, text: stripHtml(f[1] || ''), html: f[0] };
    }

    function withTimeout(fn, ms) {
        return new Promise(function(resolve, reject) {
            var timer = setTimeout(function() { reject(new Error('Timeout')); }, ms);
            fn().then(function(r) { clearTimeout(timer); resolve(r); }).catch(function(e) { clearTimeout(timer); reject(e); });
        });
    }

    function findAllLinks(html) {
        if (!html) return [];
        var links = [];
        var re = /<a[^>]*href="([^"]+)"[^>]*>/gi;
        var m;
        while ((m = re.exec(html)) !== null) links.push(m[1]);
        return links;
    }

    function findBestVcLink(html) {
        if (!html) return null;
        var p1 = html.match(/<a[^>]*href="([^"]*(?:vcloud|hubcloud)[^"]*)"[^>]*>/i);
        if (p1) return p1[1];
        var p2 = html.match(/<a[^>]*href="([^"]*nexdrive[^"]*)"[^>]*>/i);
        if (p2) return p2[1];
        var p3 = html.match(/<a[^>]*href="([^"]*(?:fastdl|filebee|gdtot|dgdrive)[^"]*)"[^>]*>/i);
        if (p3) return p3[1];
        return null;
    }

    function findFirstLinkContaining(html, keywords) {
        if (!html) return null;
        var re = /<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
        var m;
        while ((m = re.exec(html)) !== null) {
            var text = stripHtml(m[2]).toLowerCase();
            var href = m[1].toLowerCase();
            for (var ki = 0; ki < keywords.length; ki++) {
                if (text.indexOf(keywords[ki]) >= 0 || href.indexOf(keywords[ki]) >= 0) return m[1];
            }
        }
        return null;
    }

    function extractVcLinks(html) {
        if (!html) return [];
        var seen = {};
        var links = [];
        // Find ALL vcloud/hubcloud links regardless of parent element
        var re = /<a[^>]*href="([^"]+(?:vcloud|hubcloud)[^"]*)"[^>]*>/gi;
        var m;
        while ((m = re.exec(html)) !== null) {
            var url = m[1];
            if (!seen[url]) { seen[url] = true; links.push(url); }
        }
        return links;
    }

    // ========================================================================
    // GITHUB URLS CACHE
    // ========================================================================

    var _cachedUrls = null;
    var _cachedP = null;

    async function getUrls() {
        if (_cachedUrls) return _cachedUrls;
        if (_cachedP) return _cachedP;
        _cachedP = (async function() {
            try { var j = await fetchJson(DYNAMIC_URLS); _cachedUrls = j || {}; return _cachedUrls; }
            catch (e) { _cachedUrls = {}; return _cachedUrls; }
        })();
        return _cachedP;
    }

    async function getLatestVc(source) {
        try { var j = await getUrls(); if (j && j[source]) return j[source]; return source === 'hubcloud' ? 'https://hubcloud.foo' : 'https://vcloud.zip'; }
        catch (e) { return source === 'hubcloud' ? 'https://hubcloud.foo' : 'https://vcloud.zip'; }
    }

    async function getWorkingUrl() {
        try { var j = await getUrls(); return j && j.vegamovies ? j.vegamovies : BASE_URL; }
        catch (e) { return BASE_URL; }
    }

    // ========================================================================
    // V-CLOUD EXTRACTOR
    // Reference: Extractors.kt - VCloud class
    // ========================================================================

    async function extractVcStream(url, cb) {
        try {
            var isHub = url.toLowerCase().indexOf('hubcloud') >= 0;
            var latestBase = await getLatestVc(isHub ? 'hubcloud' : 'vcloud');
            var curBase = getBaseUrl(url);
            var newUrl = url;
            if (curBase !== latestBase) { newUrl = url.replace(curBase, latestBase); curBase = latestBase; }

            var html = await fetchUrl(newUrl);
            if (!html) return 0;

            // Extract token URL from script: var url = '...'
            var tokenUrl = '';
            var scripts = html.match(/<script[^>]*>([\s\S]*?)<\/script>/gi);
            if (scripts) {
                for (var si = 0; si < scripts.length; si++) {
                    var uM = scripts[si].match(/var\s+url\s*=\s*['"]([^'"]+)['"]/);
                    if (uM) { tokenUrl = uM[1]; break; }
                    // Also try: src = '...'
                    var uM2 = scripts[si].match(/src\s*=\s*['"]([^'"]+)['"]/);
                    if (uM2 && uM2[1].indexOf('token') >= 0) { tokenUrl = uM2[1]; break; }
                }
            }
            // Fallback: /video/ format
            if (!tokenUrl && newUrl.indexOf('/video/') >= 0) {
                var vdM = html.match(/<div[^>]*class="[^"]*\bvd\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
                if (vdM) {
                    var cM = vdM[1].match(/<center[^>]*>([\s\S]*?)<\/center>/i);
                    if (cM) { var aM2 = cM[1].match(/<a[^>]*href="([^"]*)"[^>]*>/i); if (aM2) tokenUrl = aM2[1]; }
                }
            }
            if (!tokenUrl) return 0;
            if (tokenUrl.indexOf('://') < 0) tokenUrl = curBase + tokenUrl;

            var docHtml = await fetchUrl(tokenUrl);
            if (!docHtml) return 0;

            // Extract quality / size info
            var cardM = docHtml.match(/<div[^>]*class="[^"]*card-header[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
            var headerText = cardM ? stripHtml(cardM[1]) : 'Unknown';
            var sizeM = docHtml.match(/<i[^>]*id="size"[^>]*>([\s\S]*?)<\/i>/i);
            var sizeText = sizeM ? stripHtml(sizeM[1]) : '';
            var quality = getQualityNum(headerText);
            var labelBase = headerText + (sizeText ? ' [' + sizeText + ']' : '');

            // Scan all <a> tags for download server links.
            // Use a broad regex that works regardless of attribute order (class before href, etc.)
            // Kotlin reference: document.select("h2 a.btn")
            var links = [];
            var aRe = /<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
            var aM;
            while ((aM = aRe.exec(docHtml)) !== null) {
                var href = aM[1].trim();
                var text = stripHtml(aM[2]).trim();
                if (!href || href === '#' || href === 'admin') continue;
                var hLow = href.toLowerCase();
                var tLow = text.toLowerCase();
                // Skip known non-download links
                if (hLow.indexOf('google') >= 0 || hLow.indexOf('telegram') >= 0 || hLow.indexOf('cdnjs') >= 0 || hLow.indexOf('fontawesome') >= 0 || hLow.indexOf('unpkg') >= 0) continue;
                // Accept any link that has download-related text or looks like a file host
                if (tLow.indexOf('fsl') >= 0 || tLow.indexOf('pixel') >= 0 || tLow.indexOf('mega') >= 0 ||
                    tLow.indexOf('download') >= 0 || tLow.indexOf('server') >= 0 || tLow.indexOf('10g') >= 0 ||
                    tLow.indexOf('buzz') >= 0 || tLow.indexOf('fast') >= 0 || tLow.indexOf('direct') >= 0 ||
                    hLow.indexOf('diskcdn') >= 0 || hLow.indexOf('hubcloud') >= 0 || hLow.indexOf('gofile') >= 0 ||
                    hLow.indexOf('workers.dev') >= 0 || hLow.indexOf('pixeldra') >= 0) {
                    links.push({ href: href, text: text });
                }
            }

            var tasks = links.map(async function(link) {
                var h = link.href, t = link.text;
                if (t.indexOf('FSL Server') >= 0 || t.indexOf('FSL ') >= 0) { if (cb) cb(h, quality, 'FSL Server', labelBase); return 1; }
                if (t.indexOf('FSLv2') >= 0) { if (cb) cb(h, quality, 'FSLv2 Server', labelBase); return 1; }
                if (t.indexOf('Mega Server') >= 0) { if (cb) cb(h, quality, 'Mega Server', labelBase); return 1; }
                if (t.indexOf('Download File') >= 0) { if (cb) cb(h, quality, '', labelBase); return 1; }
                if (t.indexOf('BuzzServer') >= 0 || t.indexOf('Buzz Server') >= 0) {
                    try {
                        var bUrl = h.charAt(h.length-1) === '/' ? h : h + '/download';
                        var bRes = await http_get(bUrl, Object.assign({}, HEADERS, { 'Referer': tokenUrl }));
                        var bText = bRes ? (bRes.body || bRes.text || '') : '';
                        var hxM = bText.match(/hx-redirect\s*=\s*"([^"]+)"/i);
                        if (hxM) { var dl = hxM[1]; var base = getBaseUrl(h); var fUrl = base + (dl.indexOf('/') === 0 ? dl : '/' + dl); if (cb) cb(fUrl, quality, 'BuzzServer', labelBase); return 1; }
                    } catch(e) { /* skip */ }
                    return 0;
                }
                if (h.indexOf('pixeldra') >= 0 || t.indexOf('PixelServer') >= 0 || t.indexOf('Pixeldrain') >= 0) {
                    var pxlM = docHtml.match(/var\s+pxl\s*=\s*["']([^"']+)["']/);
                    var pxl = pxlM ? pxlM[1] : null;
                    if (pxl) {
                        var baseLink = getBaseUrl(pxl);
                        var fURL = '';
                        if (pxl.toLowerCase().indexOf('download') >= 0) { fURL = pxl; }
                        else { var seg = pxl.split('/').pop(); fURL = baseLink + '/api/file/' + seg + '?download'; }
                        if (cb) cb(fURL, quality, 'Pixeldrain', labelBase); return 1;
                    }
                    return 0;
                }
                if (t.indexOf('10Gbps') >= 0 || t.indexOf('10 gbps') >= 0 || t.indexOf('10gbps') >= 0 || t.indexOf('10Gbps Server') >= 0 || h.indexOf('hubcloud.cx') >= 0) {
                    var fLink = h;
                    var linkParts = h.split('link=');
                    if (linkParts.length > 1) { var afterLink = linkParts[1]; var ampIdx = afterLink.indexOf('&'); fLink = ampIdx >= 0 ? afterLink.substring(0, ampIdx) : afterLink; fLink = decodeURIComponent(fLink); }
                    if (cb) cb(fLink, quality, 'Download', labelBase); return 1;
                }
                // Generic catch
                if (t.toLowerCase().indexOf('download') >= 0 || h.indexOf('hubcloud') >= 0 || h.indexOf('pixeldra') >= 0 || h.indexOf('diskcdn') >= 0 || h.indexOf('gofile') >= 0 || h.indexOf('workers.dev') >= 0) {
                    if (cb) cb(h, quality, 'Server', labelBase); return 1;
                }
                // Last resort: any link that looks like a file host
                if (h.indexOf('http') >= 0 && t.length > 0 && t.toLowerCase().indexOf('server') >= 0) {
                    if (cb) cb(h, quality, 'Server', labelBase); return 1;
                }
                return 0;
            });

            var results = await Promise.all(tasks);
            return results.reduce(function(a, v) { return a + v; }, 0);
        } catch (e) { return 0; }
    }

    async function extractSingleVc(vcUrl, referer) {
        var streams = [];
        var lower = vcUrl.toLowerCase();

        // Try V-Cloud / HubCloud extraction
        if (lower.indexOf('vcloud') >= 0 || lower.indexOf('hubcloud') >= 0 || lower.indexOf('nexdrive') >= 0) {
            await extractVcStream(vcUrl, function(su, q, sn, lb) {
                streams.push({ url: su, source: sn ? sn + ' ' + lb : lb, headers: { 'Referer': referer } });
            });
        }

        // FastDL fallback: always try if V-Cloud returned nothing OR URL is fastdl
        if ((streams.length === 0 || lower.indexOf('fastdl') >= 0) && (lower.indexOf('fastdl') >= 0 || lower.indexOf('vcloud') >= 0 || lower.indexOf('hubcloud') >= 0 || lower.indexOf('nexdrive') >= 0)) {
            try {
                var fHtml = await fetchUrl(vcUrl);
                if (fHtml) {
                    var rM = fHtml.match(/var\s+reurl\s*=\s*"([^"]+)"/);
                    if (rM) streams.push({ url: rM[1], source: 'FastDL', headers: { 'Referer': getBaseUrl(vcUrl) } });
                    var dlM = fHtml.match(/https?:\/\/[^"']*dl\.php[^"']*/);
                    if (dlM && streams.length === 0) { var dR = await fetchUrl(dlM[0]); if (dR && dR.length > 100) streams.push({ url: dlM[0], source: 'FastDL', headers: { 'Referer': getBaseUrl(vcUrl) } }); }
                    // Also try any direct video URL in the page
                    if (streams.length === 0) {
                        var vidM = fHtml.match(/https?:\/\/[^"'\s]+\.(?:mp4|mkv|avi|webm)[^"'\s]*/i);
                        if (vidM) streams.push({ url: vidM[0], source: 'Direct', headers: { 'Referer': getBaseUrl(vcUrl) } });
                    }
                }
            } catch(e) { /* skip */ }
        }
        return streams;
    }

    // ========================================================================
    // getHome
    // ========================================================================

    async function getHome(cb) {
        try {
            var wu = await getWorkingUrl();
            var cats = [
                { n: 'Home', u: wu + '/page/%d/' },
                { n: 'Netflix', u: wu + '/category/web-series/netflix/page/%d/' },
                { n: 'Disney Plus Hotstar', u: wu + '/category/web-series/disney-plus-hotstar/page/%d/' },
                { n: 'Amazon Prime', u: wu + '/category/web-series/amazon-prime-video/page/%d/' },
                { n: 'MX Original', u: wu + '/category/web-series/mx-original/page/%d/' },
                { n: 'Anime Series', u: wu + '/category/anime-series/page/%d/' },
                { n: 'Korean Series', u: wu + '/category/korean-series/page/%d/' }
            ];
            var result = {};
            for (var ci = 0; ci < cats.length; ci++) {
                var html = await fetchUrl(cats[ci].u.replace('%d', '1'));
                if (!html) continue;
                var re = /<a\s+href="([^"]+)"[^>]*>\s*<div class="poster-card">[\s\S]*?<img[^>]+src="([^"]+)"[^>]+alt="([^"]*)"[\s\S]*?<\/a>/gi;
                var pm, items = [];
                while ((pm = re.exec(html)) !== null) {
                    var title = pm[3].replace(/Download\s*/gi, '').trim();
                    if (!title || title.indexOf('${') >= 0) continue;
                    if (isBadUrl(pm[1])) continue;
                    items.push({ title: title, url: fixUrl(pm[1]), posterUrl: pm[2].indexOf('://') >= 0 ? pm[2] : fixUrl(pm[2]), type: 'movie', description: '' });
                }
                if (items.length > 0) result[cats[ci].n] = items;
            }
            if (Object.keys(result).length === 0) result['Latest Movies'] = [];
            cb({ success: true, data: result });
        } catch (e) { cb({ success: true, data: { 'Latest Movies': [] } }); }
    }

    // ========================================================================
    // search
    // ========================================================================

    async function search(query, cb) {
        try {
            var wu = await getWorkingUrl();
            var rt = await fetchUrl(wu + '/search.php?q=' + encodeURIComponent(query) + '&page=1');
            if (!rt) { cb({ success: true, data: [] }); return; }
            var results = [];
            try {
                var json = JSON.parse(rt);
                if (json && json.hits && Array.isArray(json.hits)) {
                    results = json.hits.map(function(h) { var d = h.document || {}; return { title: (d.post_title || '').replace(/Download\s*/gi, '').trim(), url: d.permalink ? (d.permalink.indexOf('://') >= 0 ? d.permalink : fixUrl(d.permalink)) : '', posterUrl: d.post_thumbnail || '', type: 'movie', description: '' }; }).filter(function(i) { return i.title && i.url && !isBadUrl(i.url); });
                }
            } catch (e) {
                var linksRe = /<a\s+[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
                var lm;
                while ((lm = linksRe.exec(rt)) !== null) {
                    if (!lm[1] || lm[1] === '#') continue;
                    var imgM2 = lm[2].match(/<img[^>]+src="([^"]+)"[^>]+alt="([^"]*)"[^>]*>/i);
                    if (imgM2) {
                        var t2 = imgM2[2].replace(/Download\s*/gi, '').trim();
                        if (t2) results.push({ title: t2, url: fixUrl(lm[1]), posterUrl: imgM2[1].indexOf('://') >= 0 ? imgM2[1] : fixUrl(imgM2[1]), type: 'movie', description: '' });
                    }
                }
            }
            var seen = {};
            results = results.filter(function(i) { if (seen[i.url]) return false; seen[i.url] = true; return true; });
            cb({ success: true, data: results });
        } catch (e) { cb({ success: true, data: [] }); }
    }

    // ========================================================================
    // load - Media Details
    // Reference: VegaMoviesProvider.kt - load()
    // ========================================================================

    async function load(url, cb) {
        try {
            var pageUrl = fixUrl(url);
            var html = await fetchUrl(pageUrl);
            if (!html || html.indexOf('Attention Required') >= 0 || html.indexOf('Cloudflare') >= 0) {
                cb({ success: false, errorCode: 'LOAD_ERROR', message: 'Blocked' });
                return;
            }

            // Title
            var title = extractTagText(html, 'title');
            title = title.replace(/Download\s*/gi, '').trim() || 'Unknown';

            // Poster
            var poster = '';
            var pRe = /<p[^>]*>([\s\S]*?)<\/p>/gi;
            var pM;
            while ((pM = pRe.exec(html)) !== null) {
                var imgM = pM[1].match(/<img[^>]+src="([^"]+)"[^>]*>/i);
                if (imgM && imgM[1]) { poster = imgM[1]; break; }
            }

            // IMDb
            var imdbM = html.match(/<a[^>]*href="[^"]*imdb\.com\/title\/(tt\d+)[^"]*"[^>]*>/i);
            var imdbId = imdbM ? imdbM[1] : '';

            // Type detection
            var isSeries = false;
            var h3Tags = findElements(html, 'h3');
            for (var hi = 0; hi < h3Tags.length; hi++) {
                var ht = h3Tags[hi].text.toLowerCase();
                if (ht.indexOf('series-synopsis') >= 0 || ht.indexOf('series info') >= 0 || ht.indexOf('series synopsis') >= 0) { isSeries = true; break; }
            }

            // Description
            var description = '';
            for (var hi = 0; hi < h3Tags.length; hi++) {
                var spanM = h3Tags[hi].html.match(/<span[^>]*>([\s\S]*?)<\/span>/i);
                if (spanM && /synopsis\/plot/i.test(spanM[1])) {
                    var hPos = html.indexOf(h3Tags[hi].html);
                    if (hPos >= 0) { var ne = nextSiblingAt(html, hPos + h3Tags[hi].html.length); if (ne) description = ne.text; }
                    break;
                }
            }

            // Cinemeta enrichment
            var genres = [], imdbRating = '', year = '';
            if (imdbId) {
                try {
                    var cRes = await fetchJson(CINEMETA_URL + '/' + (isSeries ? 'series' : 'movie') + '/' + imdbId + '.json');
                    if (cRes && cRes.meta) {
                        description = cRes.meta.description || description;
                        title = cRes.meta.name || title;
                        genres = cRes.meta.genre || [];
                        imdbRating = cRes.meta.imdbRating || '';
                        year = cRes.meta.year || '';
                        if (cRes.meta.poster) poster = cRes.meta.poster;
                    }
                } catch (e) {}
            }

            // === EPISODES ===
            // PLAIN OBJECTS (not new Episode()) to avoid Dart serialization issues.
            // URL is always a plain HTTP URL matching Kotlin loadLinks() architecture:
            //   - Movies: single episode with page URL, loadStreams handles all quality extraction
            //   - Series: episodes with nexdrive URL (intermediate page with V-Cloud links)
            var episodes = [];

            if (isSeries) {
                var hTags = h3Tags.concat(findElements(html, 'h5')).filter(function(el) {
                    return /4k|\d{3,4}p/i.test(el.text) && el.text.toLowerCase().indexOf('zip') < 0;
                });
                var epMap = {};

                for (var ti = 0; ti < hTags.length; ti++) {
                    var tag = hTags[ti];
                    var sM = tag.text.match(/(?:Season\s+|S)(\d+)/i);
                    var realSeason = sM ? parseInt(sM[1]) : 0;
                    var tPos = html.indexOf(tag.html);
                    var ns = null;
                    if (tPos >= 0) ns = nextSiblingAt(html, tPos + tag.html.length);

                    var searchHtml = (ns && ns.html) || tag.html;

                    var found = findFirstLinkContaining(searchHtml, ['v-cloud', 'episode', 'download', 'g-direct']);
                    if (!found) found = findFirstLinkContaining(searchHtml, ['nexdrive']);

                    if (found) {
                        var interHtml = await fetchUrl(fixUrl(found));
                        if (interHtml) {
                            var vcLinks = extractVcLinks(interHtml);
                            for (var vci = 0; vci < vcLinks.length; vci++) {
                                var mKey = realSeason + '_' + (vci + 1);
                                if (epMap[mKey]) {
                                    if (epMap[mKey].indexOf(vcLinks[vci]) < 0) epMap[mKey].push(vcLinks[vci]);
                                } else {
                                    epMap[mKey] = [vcLinks[vci]];
                                }
                            }
                        }
                    }
                }

                var keys = Object.keys(epMap).sort();
                for (var ki = 0; ki < keys.length; ki++) {
                    var parts = keys[ki].split('_');
                    var sn = parseInt(parts[0]) || 1;
                    var en = parseInt(parts[1]) || (ki + 1);
                    var srcs = epMap[keys[ki]];
                    episodes.push({
                        name: 'S' + sn + ' E' + en,
                        url: JSON.stringify(srcs),
                        season: sn,
                        episode: en,
                        posterUrl: poster || '',
                        description: description || ''
                    });
                }
                episodes.sort(function(a, b) { if (a.season !== b.season) return a.season - b.season; return a.episode - b.episode; });

            } else {
                // Movie: single episode with page URL
                // loadStreams fetches the page, finds all quality nexdrive buttons,
                // extracts V-Cloud URLs, and returns all streams across all qualities
                episodes.push({
                    name: 'Play',
                    url: pageUrl || '',
                    season: 1,
                    episode: 1,
                    posterUrl: poster || '',
                    description: description || ''
                });
            }

            // Response: new MultimediaItem wrapper, PLAIN OBJECT episodes
            var scoreVal = imdbRating ? parseFloat(imdbRating) / 10 : undefined;
            var yearVal = year ? (parseInt(year) || undefined) : undefined;
            cb({ success: true, data: new MultimediaItem({
                title: title || 'Unknown',
                url: pageUrl || '',
                posterUrl: poster || '',
                type: isSeries ? 'series' : 'movie',
                description: description || '',
                year: yearVal,
                score: scoreVal,
                genres: genres.length > 0 ? genres : undefined,
                episodes: episodes
            }) });
        } catch (e) {
            cb({ success: false, errorCode: 'PARSE_ERROR', message: String(e) });
        }
    }

    // ========================================================================
    // loadStreams
    // Reference: VegaMoviesProvider.kt - loadLinks()
    // ========================================================================

    async function loadStreams(url, cb) {
        try {
            // JSON array of V-Cloud URLs (series episode with multiple quality sources)
            if (typeof url === 'string' && url.indexOf('[') === 0) {
                try {
                    var srcs = JSON.parse(url);
                    if (Array.isArray(srcs) && srcs.length > 0) {
                        var allStreams = [];
                        for (var si = 0; si < srcs.length; si++) {
                            try {
                                var st = await withTimeout(function() { return extractSingleVc(srcs[si], url); }, 60000);
                                for (var sj = 0; sj < st.length; sj++) {
                                    var dup = false;
                                    for (var sk = 0; sk < allStreams.length; sk++) {
                                        if (allStreams[sk].url === st[sj].url) { dup = true; break; }
                                    }
                                    if (!dup) allStreams.push(st[sj]);
                                }
                            } catch(e) {}
                        }
                        cb({ success: true, data: allStreams });
                        return;
                    }
                } catch(e) {}
            }

            var lower = url.toLowerCase();

            // Direct V-Cloud/HubCloud URL (series episodes with single quality)
            if (lower.indexOf('vcloud') >= 0 || lower.indexOf('hubcloud') >= 0) {
                var st = await withTimeout(function() { return extractSingleVc(url, url); }, 60000);
                cb({ success: true, data: st });
                return;
            }

            // Nexdrive proxy page
            if (lower.indexOf('nexdrive') >= 0) {
                var nHtml = await withTimeout(function() { return fetchUrl(url); }, 30000);
                if (nHtml) {
                    // Try to find V-Cloud link first
                    var vcL = findBestVcLink(nHtml);
                    if (vcL) {
                        var st2 = await withTimeout(function() { return extractSingleVc(fixUrl(vcL), url); }, 60000);
                        cb({ success: true, data: st2 });
                        return;
                    }
                    // Fallback: try FastDL link on the nexdrive page directly
                    var fastM = nHtml.match(/<a[^>]*href="([^"]*fastdl[^"]*)"[^>]*>/i);
                    if (fastM) {
                        var st3 = await withTimeout(function() { return extractSingleVc(fixUrl(fastM[1]), url); }, 60000);
                        cb({ success: true, data: st3 });
                        return;
                    }
                }
                cb({ success: true, data: [] });
                return;
            }

            // Movie page URL: find all quality buttons
            var html = await withTimeout(function() { return fetchUrl(url); }, 30000);
            if (!html || html.indexOf('Cloudflare') >= 0) { cb({ success: true, data: [] }); return; }

            var btns = [];
            var bs = getBaseUrl(url);

            // Pattern 1: a:has(button.dwd-button) — matching Kotlin
            var dwdRe = /<a[^>]*href="([^"]+)"[^>]*>(?:(?!<\/a>)[\s\S])*?<button[^>]*class="[^"]*dwd-button[^"]*"[^>]*>/gi;
            var bm;
            while ((bm = dwdRe.exec(html)) !== null) {
                var bUrl = fixUrl(bm[1]);
                if (bUrl && bUrl !== '#' && bUrl !== '/' && bUrl !== url && bUrl !== bs + '/' && bUrl !== bs) btns.push(bUrl);
            }

            // Pattern 2: a > button with any download class
            if (btns.length === 0) {
                var btnRe2 = /<a[^>]*href="([^"]+)"[^>]*>(?:(?!<\/a>)[\s\S])*?<button[^>]*class="[^"]*(?:dwd|btn|download|dl)[^"]*"[^>]*>/gi;
                while ((bm = btnRe2.exec(html)) !== null) {
                    var b2Url = fixUrl(bm[1]);
                    if (b2Url && b2Url !== '#' && b2Url !== '/' && b2Url.indexOf(bs) !== 0 && b2Url !== bs + '/' && b2Url !== bs) btns.push(b2Url);
                }
            }

            // Pattern 3: nexdrive links near h3/h5 quality tags
            if (btns.length === 0) {
                var altRe = /<h[3456][^>]*>([\s\S]*?)<\/h[3456]>[\s\S]*?<a[^>]*href="([^"]*nexdrive[^"]*)"[^>]*>/gi;
                var altM;
                while ((altM = altRe.exec(html)) !== null) { btns.push(fixUrl(altM[2])); }
            }

            // Pattern 4: any nexdrive link on the page
            if (btns.length === 0) {
                var allLinks = findAllLinks(html);
                for (var li = 0; li < allLinks.length; li++) {
                    if (allLinks[li].indexOf('nexdrive') >= 0) btns.push(fixUrl(allLinks[li]));
                }
            }

            if (btns.length === 0) { cb({ success: true, data: [] }); return; }

            // Process each quality SEQUENTIALLY
            var allStreams = [];
            for (var bi = 0; bi < btns.length; bi++) {
                try {
                    var dlH = await withTimeout(function() { return fetchUrl(btns[bi]); }, 30000);
                    if (!dlH) continue;
                    var best = findBestVcLink(dlH);
                    if (best) {
                        var qSt = await withTimeout(function() { return extractSingleVc(fixUrl(best), btns[bi]); }, 60000);
                        for (var si = 0; si < qSt.length; si++) allStreams.push(qSt[si]);
                    } else {
                        // No V-Cloud link found: try any link on the nexdrive page
                        var nxLinks = findAllLinks(dlH);
                        var nxFound = null;
                        for (var nli = 0; nli < nxLinks.length; nli++) {
                            var nl = nxLinks[nli].toLowerCase();
                            if (nl.indexOf('vcloud') >= 0 || nl.indexOf('hubcloud') >= 0 || nl.indexOf('fastdl') >= 0 || nl.indexOf('nexdrive') >= 0) {
                                nxFound = nxLinks[nli]; break;
                            }
                        }
                        if (nxFound) {
                            var fSt = await withTimeout(function() { return extractSingleVc(fixUrl(nxFound), btns[bi]); }, 60000);
                            for (var si = 0; si < fSt.length; si++) allStreams.push(fSt[si]);
                        }
                    }
                } catch (e) { /* skip failed quality */ }
            }

            cb({ success: true, data: allStreams });
        } catch (e) { cb({ success: true, data: [] }); }
    }

    
    globalThis.getHome = getHome;
    globalThis.search = search;
    globalThis.load = load;
    globalThis.loadStreams = loadStreams;

})();
