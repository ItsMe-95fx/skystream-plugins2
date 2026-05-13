(function() {

    var EXCL = ['79601436077', '13297974909'];

    function getBaseUrl() {
        return manifest.baseUrl || 'https://teluguscreen.com';
    }

    async function fetchMovies() {
        var url = getBaseUrl() + '/movies.json';
        var res = await http_get(url, {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        });
        if (!res || !res.body) return [];
        var data = JSON.parse(res.body);
        return data.filter(function(m) { return EXCL.indexOf(String(m.id)) === -1; });
    }

    function movieToItem(m) {
        return new MultimediaItem({
            title: m.title,
            url: getBaseUrl() + '/player.html?id=' + m.id,
            posterUrl: m.imagePath || '',
            type: 'movie',
            year: parseInt(m.year) || 0,
            description: m.plot || '',
            score: m.rating ? parseFloat(m.rating) : 0
        });
    }

    function toYearRange(year) {
        var y = parseInt(year) || 0;
        if (y >= 2021) return '2021+';
        if (y >= 2016) return '2016-20';
        if (y >= 2011) return '2011-15';
        if (y >= 2006) return '2006-10';
        if (y >= 2001) return '2001-05';
        if (y >= 1991) return '1991-00';
        return 'Classic';
    }

    function buildStreams(movie) {
        var streams = [];
        var quals = movie.qualities || {};
        var keys = ['Q360p', 'Q480p', 'Q720p'];

        keys.forEach(function(key) {
            var streamUrl = quals[key];
            var label = key.replace('Q', '');

            if (streamUrl && typeof streamUrl === 'string' && streamUrl.indexOf('.mp4') !== -1) {
                streams.push(new StreamResult({
                    url: streamUrl,
                    quality: label,
                    source: label
                }));
            }
        });

        return streams;
    }

    async function getHome(cb) {
        try {
            var movies = await fetchMovies();
            if (!movies || movies.length === 0) {
                return cb({ success: false, errorCode: 'NO_MOVIES', message: 'No movies found' });
            }

            var trending = [];
            var recent = [];
            var genres = {};
            var years = {};
            var qualities = {};

            movies.forEach(function(m) {
                var item = movieToItem(m);
                var yr = toYearRange(m.year);
                var quality = m.quality || 'All';

                recent.push(item);

                if (!years[yr]) years[yr] = [];
                years[yr].push(item);

                if (!qualities[quality]) qualities[quality] = [];
                qualities[quality].push(item);

                if (m.genre) {
                    m.genre.split(',').forEach(function(g) {
                        g = g.trim();
                        if (!g) return;
                        if (!genres[g]) genres[g] = [];
                        genres[g].push(item);
                    });
                }
            });

            trending = recent.slice(0, 15);

            var data = {};
            data['Trending'] = trending;

            var sortedQualities = Object.keys(qualities).sort(function(a, b) {
                var order = { 'BluRay': 0, 'WEB-DL': 1, 'HDRip': 2, 'DVDRip': 3, 'All': 4 };
                return (order[a] || 99) - (order[b] || 99);
            });

            sortedQualities.forEach(function(q) {
                data['Quality: ' + q] = qualities[q].slice(0, 30);
            });

            var sortedYears = Object.keys(years).sort(function(a, b) {
                var extract = function(s) { var n = parseInt(s); return isNaN(n) ? 0 : n; };
                return extract(b) - extract(a);
            });

            sortedYears.forEach(function(y) {
                data['Year: ' + y] = years[y].slice(0, 30);
            });

            var sortedGenres = Object.keys(genres).sort();
            sortedGenres.forEach(function(g) {
                data['Genre: ' + g] = genres[g].slice(0, 30);
            });

            cb({ success: true, data: data });
        } catch (e) {
            cb({ success: false, errorCode: 'GET_HOME_ERROR', message: e.message });
        }
    }

    async function search(query, cb) {
        try {
            var movies = await fetchMovies();
            var q = query.toLowerCase();
            var results = movies.filter(function(m) {
                return (m.title || '').toLowerCase().indexOf(q) !== -1 ||
                       (m.year || '').indexOf(q) !== -1 ||
                       (m.quality || '').toLowerCase().indexOf(q) !== -1 ||
                       (m.genre || '').toLowerCase().indexOf(q) !== -1 ||
                       (m.actors || '').toLowerCase().indexOf(q) !== -1 ||
                       (m.director || '').toLowerCase().indexOf(q) !== -1;
            }).map(function(m) { return movieToItem(m); });
            cb({ success: true, data: results });
        } catch (e) {
            cb({ success: false, errorCode: 'SEARCH_ERROR', message: e.message });
        }
    }

    async function load(url, cb) {
        try {
            var idMatch = url.match(/id=([^&]+)/);
            var movieId = idMatch ? idMatch[1] : null;
            if (!movieId) {
                return cb({ success: false, errorCode: 'NO_ID', message: 'Could not extract movie ID from URL' });
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
                return cb({ success: false, errorCode: 'NOT_FOUND', message: 'Movie not found' });
            }

            var streams = buildStreams(movie);

            var item = new MultimediaItem({
                title: movie.title,
                url: url,
                posterUrl: movie.imagePath || '',
                type: 'movie',
                year: parseInt(movie.year) || 0,
                description: movie.plot || '',
                score: movie.rating ? parseFloat(movie.rating) : 0,
                contentRating: '',
                genres: movie.genre ? movie.genre.split(',').map(function(g) { return g.trim(); }) : [],
                cast: movie.actors ? movie.actors.split(',').map(function(a) {
                    return { name: a.trim(), role: '' };
                }) : [],
                episodes: []
            });

            if (streams.length > 0) {
                var episodeUrls = streams.map(function(s) {
                    return { url: s.url, quality: s.quality };
                });
                item.episodes = [new Episode({
                    name: 'Play Movie',
                    url: JSON.stringify(episodeUrls),
                    season: 1,
                    episode: 1
                })];
            }

            cb({ success: true, data: item });
        } catch (e) {
            cb({ success: false, errorCode: 'LOAD_ERROR', message: e.message });
        }
    }

    async function loadStreams(url, cb) {
        try {
            var streams = [];
            try {
                var parsed = JSON.parse(url);
                if (Array.isArray(parsed) && parsed.length > 0) {
                    parsed.forEach(function(s) {
                        streams.push(new StreamResult({
                            url: s.url,
                            quality: s.quality || '',
                            source: s.source || ''
                        }));
                    });
                }
            } catch (e) {
                var idMatch = url.match(/id=([^&]+)/);
                var movieId = idMatch ? idMatch[1] : null;
                if (!movieId) {
                    return cb({ success: false, errorCode: 'NO_ID', message: 'Could not extract movie ID' });
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
                    return cb({ success: false, errorCode: 'NOT_FOUND', message: 'Movie not found' });
                }

                streams = buildStreams(movie);
            }

            if (streams.length === 0) {
                return cb({ success: false, errorCode: 'NO_STREAMS', message: 'No streams found' });
            }

            cb({ success: true, data: streams });
        } catch (e) {
            cb({ success: false, errorCode: 'LOAD_STREAMS_ERROR', message: e.message });
        }
    }

    globalThis.getHome = getHome;
    globalThis.search = search;
    globalThis.load = load;
    globalThis.loadStreams = loadStreams;
})();
