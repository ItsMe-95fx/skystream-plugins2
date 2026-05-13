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

    // ---- Fetch movies.json with retry ----
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
                console.error("fetchMovies attempt " + (attempt + 1) + " failed: " + e.message);
                if (attempt < 2) {
                    await new Promise(function(r) { setTimeout(r, 1000); });
                }
            }
        }

        console.error("fetchMovies failed after 3 attempts: " + (lastErr ? lastErr.message : "unknown"));
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

    // ---- Build streams from movie data ----
    function buildStreams(movie) {
        var streams = [];
        var checked = {};

        function addStream(url, quality) {
            if (!url || typeof url !== "string") return;
            url = url.trim();
            if (!url) return;
            if (checked[url]) return;
            checked[url] = true;

            var q = quality || extractQuality(url) || "Auto";

            streams.push(new StreamResult({
                url: url,
                quality: q,
                source: "TeluguScreen [" + q + "]",
                headers: {
                    "User-Agent": USER_AGENT,
                    "Referer": getBaseUrl() + "/",
                    "Accept": "*/*"
                }
            }));
        }

        // 1. Check qualities object (Q360p, Q480p, Q720p - these are the main ones)
        var quals = movie.qualities || {};
        if (quals.Q360p) addStream(quals.Q360p, "360p");
        if (quals.Q480p) addStream(quals.Q480p, "480p");
        if (quals.Q720p) addStream(quals.Q720p, "720p");

        // 2. Check moviePath fields
        if (movie.moviePath) addStream(movie.moviePath);
        if (movie.moviePath360p) addStream(movie.moviePath360p, "360p");
        if (movie.moviePath480p) addStream(movie.moviePath480p, "480p");
        if (movie.moviePath720p) addStream(movie.moviePath720p, "720p");

        // 3. Check src fields
        if (movie.src) addStream(movie.src);
        if (movie.src1) addStream(movie.src1);
        if (movie.src2) addStream(movie.src2);

        // 4. Check quality1, quality2 fields (these might be quality labels with URLs)
        if (movie.quality1 && typeof movie.quality1 === "string" && movie.quality1.indexOf("http") === 0) {
            addStream(movie.quality1);
        }
        if (movie.quality2 && typeof movie.quality2 === "string" && movie.quality2.indexOf("http") === 0) {
            addStream(movie.quality2);
        }

        return streams;
    }

    // ---- Get Home (with pagination) ----
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

            var data = {};

            // Trending - most recent 20 movies
            data["Trending"] = recent.slice(0, 20);

            // By quality (limited to 40 per section)
            var qualityOrder = { "BluRay": 0, "WEB-DL": 1, "HDRip": 2, "DVDRip": 3, "WEBRip": 4, "HDTV": 5, "All": 99 };
            var sortedQualities = Object.keys(qualities).sort(function(a, b) {
                return (qualityOrder[a] || 99) - (qualityOrder[b] || 99);
            });

            sortedQualities.forEach(function(q) {
                data["Quality: " + q] = qualities[q].slice(0, 40);
            });

            // By year (limited to 40 per section)
            var sortedYears = Object.keys(years).sort(function(a, b) {
                var ex = function(s) { var n = parseInt(s); return isNaN(n) ? 0 : n; };
                return ex(b) - ex(a);
            });

            sortedYears.forEach(function(y) {
                data["Year: " + y] = years[y].slice(0, 40);
            });

            // By genre (limited to 40 per section)
            var sortedGenres = Object.keys(genres).sort();
            sortedGenres.forEach(function(g) {
                data[g] = genres[g].slice(0, 40);
            });

            cb({ success: true, data: data });
        } catch (e) {
            console.error("getHome error: " + e.message);
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

            // Limit search results
            if (results.length > 100) {
                results = results.slice(0, 100);
            }

            cb({ success: true, data: results });
        } catch (e) {
            console.error("search error: " + e.message);
            cb({ success: true, data: [] });
        }
    }

    // ---- Load (movie detail) ----
    async function load(url, cb) {
        try {
            var idMatch = url.match(/id=([^&]+)/);
            var movieId = idMatch ? idMatch[1] : null;

            if (!movieId) {
                cb({ success: false, errorCode: "NO_ID", message: "Could not extract movie ID from URL" });
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
                cb({ success: false, errorCode: "NOT_FOUND", message: "Movie not found" });
                return;
            }

            var streams = buildStreams(movie);

            var genres = [];
            if (movie.genre) {
                genres = movie.genre.split(",").map(function(g) { return g.trim(); }).filter(function(g) { return g; });
            }

            // Build cast array
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

            if (streams.length > 0) {
                var episodeUrls = streams.map(function(s) {
                    return { url: s.url, quality: s.quality };
                });
                item.episodes = [new Episode({
                    name: "Play Movie",
                    url: JSON.stringify(episodeUrls),
                    season: 1,
                    episode: 1
                })];
            }

            cb({ success: true, data: item });
        } catch (e) {
            console.error("load error: " + e.message);
            cb({ success: false, errorCode: "LOAD_ERROR", message: e.message });
        }
    }

    // ---- Load Streams ----
    async function loadStreams(dataStr, cb) {
        try {
            var streams = [];

            // Try to parse as JSON (list of URLs with qualities)
            try {
                var parsed = JSON.parse(dataStr);
                if (Array.isArray(parsed) && parsed.length > 0) {
                    parsed.forEach(function(s) {
                        if (s && s.url) {
                            streams.push(new StreamResult({
                                url: s.url,
                                quality: s.quality || "Auto",
                                source: "TeluguScreen [" + (s.quality || "Auto") + "]",
                                headers: {
                                    "User-Agent": USER_AGENT,
                                    "Referer": getBaseUrl() + "/",
                                    "Accept": "*/*"
                                }
                            }));
                        }
                    });
                }
            } catch (e) {
                // Not JSON - try to extract movie ID from URL and rebuild streams
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
                        streams = buildStreams(movie);
                    }
                }
            }

            if (streams.length === 0) {
                cb({ success: true, data: [] });
            } else {
                cb({ success: true, data: streams });
            }
        } catch (e) {
            console.error("loadStreams error: " + e.message);
            cb({ success: true, data: [] });
        }
    }

    globalThis.getHome = getHome;
    globalThis.search = search;
    globalThis.load = load;
    globalThis.loadStreams = loadStreams;
})();
