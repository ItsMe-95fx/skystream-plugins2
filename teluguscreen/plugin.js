(function() {
    "use strict";

    var USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36";
    var EXCL = ['79601436077', '13297974909'];
    var CACHE = {};

    function getBaseUrl() {
        return (manifest && manifest.baseUrl) || "https://teluguscreen.com";
    }

    function decodeHtml(str) {
        if (!str) return "";
        return String(str)
            .replace(/&#(\d+);/g, function(_, d) { return String.fromCharCode(Number(d)); })
            .replace(/&amp;/gi, "&")
            .replace(/&quot;/gi, '"')
            .replace(/&#039;/gi, "'")
            .replace(/&lt;/gi, "<")
            .replace(/&gt;/gi, ">")
            .replace(/&nbsp;/gi, " ");
    }

    function extractQuality(text) {
        if (!text) return "Auto";
        var lower = text.toLowerCase();
        if (lower.indexOf("2160") !== -1 || lower.indexOf("4k") !== -1) return "4K";
        if (lower.indexOf("1080") !== -1) return "1080p";
        if (lower.indexOf("720") !== -1) return "720p";
        if (lower.indexOf("480") !== -1) return "480p";
        if (lower.indexOf("360") !== -1) return "360p";
        return "Auto";
    }

    // ---- Fetch movies.json with retry (cached) ----
    async function fetchMovies(forceRefresh) {
        if (CACHE.movies && !forceRefresh) {
            return CACHE.movies;
        }

        var lastErr = null;
        for (var attempt = 0; attempt <= 2; attempt++) {
            try {
                var res = await http_get(getBaseUrl() + "/movies.json", {
                    "User-Agent": USER_AGENT,
                    "Accept": "application/json,text/html,*/*",
                    "Accept-Language": "en-US,en;q=0.9"
                });

                if (!res || !res.body) {
                    throw new Error("Empty response");
                }

                var data = JSON.parse(res.body);
                if (!Array.isArray(data)) {
                    throw new Error("Invalid JSON: expected array");
                }

                // Filter out excluded movies
                var filtered = data.filter(function(m) {
                    return EXCL.indexOf(String(m.id)) === -1;
                });

                CACHE.movies = filtered;
                CACHE.cacheTime = Date.now();
                return filtered;
            } catch (e) {
                lastErr = e;
                if (attempt < 2) {
                    await new Promise(function(r) { setTimeout(r, 1000); });
                }
            }
        }

        // If cache has old data, return it instead of failing
        if (CACHE.movies) {
            return CACHE.movies;
        }
        return [];
    }

    // ---- Convert movie object to MultimediaItem ----
    function movieToItem(m) {
        return new MultimediaItem({
            title: m.title,
            url: getBaseUrl() + "/player.html?id=" + m.id,
            posterUrl: m.imagePath || m.pic || "",
            type: "movie",
            year: parseInt(m.year) || 0,
            description: m.plot || "",
            score: m.rating ? parseFloat(m.rating) : 0
        });
    }

    // ---- Year range categorization ----
    function toYearRange(year) {
        var y = parseInt(year) || 0;
        if (y >= 2025) return "2025+";
        if (y >= 2023) return "2023-24";
        if (y >= 2021) return "2021-22";
        if (y >= 2016) return "2016-20";
        if (y >= 2011) return "2011-15";
        if (y >= 2006) return "2006-10";
        if (y >= 2001) return "2001-05";
        if (y >= 1991) return "1991-00";
        return "Classic";
    }

    // ---- Build all available streams from movie data ----
    function buildStreams(movie) {
        var streams = [];
        var checked = {};

        function addStream(url, quality) {
            if (!url || typeof url !== "string") return;
            url = url.trim();
            if (!url || !url.startsWith("http")) return;
            if (checked[url]) return;
            checked[url] = true;

            var q = quality || extractQuality(url) || "Auto";
            streams.push({
                url: url,
                quality: q
            });
        }

        // 1. Check qualities object (Q360p, Q480p, Q720p - the MAIN source)
        var quals = movie.qualities || {};
        if (quals.Q360p) addStream(quals.Q360p, "360p");
        if (quals.Q480p) addStream(quals.Q480p, "480p");
        if (quals.Q720p) addStream(quals.Q720p, "720p");

        // 2. Check moviePath (unique URL if qualities didn't cover it)
        if (movie.moviePath) addStream(movie.moviePath);
        if (movie.moviePath360p) addStream(movie.moviePath360p, "360p");
        if (movie.moviePath480p) addStream(movie.moviePath480p, "480p");
        if (movie.moviePath720p) addStream(movie.moviePath720p, "720p");

        // 3. Check src fields (often empty but worth checking)
        if (movie.src) addStream(movie.src);
        if (movie.src1) addStream(movie.src1);
        if (movie.src2) addStream(movie.src2);

        return streams;
    }

    // ---- Get Home (with "Latest" section first, organized by year/quality/genre) ----
    async function getHome(cb) {
        try {
            var movies = await fetchMovies();
            if (!movies || movies.length === 0) {
                return cb({
                    success: false,
                    errorCode: "NO_MOVIES",
                    message: "No movies found. Site may be offline."
                });
            }

            var recent = [];
            var genres = {};
            var years = {};
            var qualities = {};

            movies.forEach(function(m) {
                var item = movieToItem(m);
                var yr = toYearRange(m.year);
                var quality = m.quality || "All";

                recent.push(item);

                if (!years[yr]) years[yr] = [];
                years[yr].push(item);

                if (!qualities[quality]) qualities[quality] = [];
                qualities[quality].push(item);

                if (m.genre) {
                    m.genre.split(",").forEach(function(g) {
                        g = g.trim();
                        if (!g) return;
                        if (!genres[g]) genres[g] = [];
                        genres[g].push(item);
                    });
                }
            });

            // Sort movies by year descending for "Latest" section
            var sortedByYear = movies.slice().sort(function(a, b) {
                return (parseInt(b.year) || 0) - (parseInt(a.year) || 0);
            });

            var data = {};

            // 1. LATEST - most recent 30 movies (sorted by year DESC)
            var latestItems = sortedByYear.slice(0, 30).map(function(m) {
                return movieToItem(m);
            });
            data["Latest"] = latestItems;

            // 2. Trending - popular/recent 20 movies (first in the original array)
            data["Trending"] = recent.slice(0, 20);

            // 3. By quality (limit 40 per section)
            var qualityOrder = { "BluRay": 0, "WEB-DL": 1, "HDRip": 2, "DVDRip": 3,
                                 "WEBRip": 4, "HDTV": 5, "All": 99 };
            var sortedQualities = Object.keys(qualities).sort(function(a, b) {
                return (qualityOrder[a] || 99) - (qualityOrder[b] || 99);
            });

            sortedQualities.forEach(function(q) {
                data["Quality: " + q] = qualities[q].slice(0, 40);
            });

            // 4. By year (limit 40 per section)
            var sortedYears = Object.keys(years).sort(function(a, b) {
                var na = parseInt(a) || 0;
                var nb = parseInt(b) || 0;
                return nb - na;
            });

            sortedYears.forEach(function(y) {
                data["Year: " + y] = years[y].slice(0, 40);
            });

            // 5. By genre (limit 40 per section)
            var sortedGenres = Object.keys(genres).sort();
            sortedGenres.forEach(function(g) {
                data[g] = genres[g].slice(0, 40);
            });

            cb({ success: true, data: data });
        } catch (e) {
            console.error("getHome error:", e.message);
            cb({ success: false, errorCode: "HOME_ERROR", message: e.message });
        }
    }

    // ---- Search ----
    async function search(query, cb) {
        try {
            var movies = await fetchMovies();
            var q = query.toLowerCase().trim();

            if (!q) {
                cb({ success: true, data: [] });
                return;
            }

            var results = movies.filter(function(m) {
                return (m.title || "").toLowerCase().indexOf(q) !== -1 ||
                       (m.year || "").indexOf(q) !== -1 ||
                       (m.quality || "").toLowerCase().indexOf(q) !== -1 ||
                       (m.genre || "").toLowerCase().indexOf(q) !== -1 ||
                       (m.actors || "").toLowerCase().indexOf(q) !== -1 ||
                       (m.director || "").toLowerCase().indexOf(q) !== -1;
            }).map(function(m) {
                return movieToItem(m);
            });

            if (results.length > 100) {
                results = results.slice(0, 100);
            }

            cb({ success: true, data: results });
        } catch (e) {
            console.error("search error:", e.message);
            cb({ success: true, data: [] });
        }
    }

    // ---- Load (movie detail with ALL streams) ----
    async function load(url, cb) {
        try {
            var idMatch = url.match(/id=([^&]+)/);
            var movieId = idMatch ? idMatch[1] : null;

            if (!movieId) {
                cb({ success: false, errorCode: "NO_ID",
                     message: "Could not extract movie ID from URL" });
                return;
            }

            var movies = await fetchMovies();
            var movie = null;
            for (var i = 0; i < movies.length; i++) {
                if (String(movies[i].id) === String(movieId)) {
                    movie = movies[i];
                    break;
                }
            }

            if (!movie) {
                // Try refreshing cache
                movies = await fetchMovies(true);
                for (var j = 0; j < movies.length; j++) {
                    if (String(movies[j].id) === String(movieId)) {
                        movie = movies[j];
                        break;
                    }
                }
            }

            if (!movie) {
                cb({ success: false, errorCode: "NOT_FOUND",
                     message: "Movie not found" });
                return;
            }

            // Build ALL streams
            var streamList = buildStreams(movie);

            var genres = [];
            if (movie.genre) {
                genres = movie.genre.split(",").map(function(g) { return g.trim(); })
                    .filter(function(g) { return g; });
            }

            var cast = [];
            if (movie.actors) {
                cast = movie.actors.split(",").map(function(a) {
                    return { name: a.trim(), role: "" };
                }).filter(function(a) { return a.name; });
            }

            var item = new MultimediaItem({
                title: movie.title,
                url: url,
                posterUrl: movie.imagePath || movie.pic || "",
                type: "movie",
                year: parseInt(movie.year) || 0,
                description: movie.plot || "",
                score: movie.rating ? parseFloat(movie.rating) : 0,
                genres: genres,
                cast: cast,
                episodes: []
            });

            if (streamList.length > 0) {
                item.episodes = [new Episode({
                    name: "Play Movie",
                    url: JSON.stringify(streamList),
                    season: 1,
                    episode: 1
                })];
            } else {
                // Fallback: return the page URL as direct stream
                item.episodes = [new Episode({
                    name: "Play Movie",
                    url: url,
                    season: 1,
                    episode: 1
                })];
            }

            cb({ success: true, data: item });
        } catch (e) {
            console.error("load error:", e.message);
            cb({ success: false, errorCode: "LOAD_ERROR", message: e.message });
        }
    }

    // ---- Load Streams (return ALL available stream qualities) ----
    async function loadStreams(dataStr, cb) {
        try {
            var streams = [];

            // Try to parse as JSON array of {url, quality}
            try {
                var parsed = JSON.parse(dataStr);
                if (Array.isArray(parsed) && parsed.length > 0) {
                    parsed.forEach(function(s) {
                        if (s && s.url && s.url.startsWith("http")) {
                            var q = s.quality || extractQuality(s.url) || "Auto";
                            streams.push(new StreamResult({
                                url: s.url,
                                quality: q,
                                source: "TeluguScreen [" + q + "]",
                                headers: {
                                    "User-Agent": USER_AGENT,
                                    "Referer": getBaseUrl() + "/",
                                    "Accept": "*/*"
                                }
                            }));
                        }
                    });

                    if (streams.length > 0) {
                        cb({ success: true, data: streams });
                        return;
                    }
                }
            } catch (e) {
                // JSON parse failed - try other strategies
            }

            // Fallback: try to extract movie ID from the URL string
            var idMatch = dataStr.match(/id=([^&]+)/);
            var movieId = idMatch ? idMatch[1] : null;
            if (movieId) {
                var movies = await fetchMovies();
                var movie = null;
                for (var i = 0; i < movies.length; i++) {
                    if (String(movies[i].id) === String(movieId)) {
                        movie = movies[i];
                        break;
                    }
                }
                if (movie) {
                    var streamList = buildStreams(movie);
                    streamList.forEach(function(s) {
                        if (s && s.url && s.url.startsWith("http")) {
                            var q = s.quality || "Auto";
                            streams.push(new StreamResult({
                                url: s.url,
                                quality: q,
                                source: "TeluguScreen [" + q + "]",
                                headers: {
                                    "User-Agent": USER_AGENT,
                                    "Referer": getBaseUrl() + "/",
                                    "Accept": "*/*"
                                }
                            }));
                        }
                    });
                }
            }

            cb({ success: true, data: streams });
        } catch (e) {
            console.error("loadStreams error:", e.message);
            cb({ success: true, data: [] });
        }
    }

    globalThis.getHome = getHome;
    globalThis.search = search;
    globalThis.load = load;
    globalThis.loadStreams = loadStreams;
})();
