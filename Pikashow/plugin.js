(function() {
    /**
     * @type {import('@skystream/sdk').Manifest}
     */
    // manifest is injected by the runtime

    // ─── Constants ────────────────────────────────────────────────────────────────
    // Exact values from CloudStream extension PikashowProvider v3
    var BASE_URL = "https://manoda.co";
    var API_KEY = "picashow-api-secret-key";
    var HMAC_SECRET = "picashow-api-secret-2025";
    var UA_TPL = "Pikashow/2509030 (Android 13; Pixel 5; Channel/pikashow; gaid/GAID); Uuid/UUID";

    // ─── State ─────────────────────────────────────────────────────────────────
    var gaid = "";
    var uuid = "";
    var catCache = {};   // cache list API responses
    var cacheTime = 0;
    var CACHE_TTL = 120000; // 2 min

    // ─── HMAC-SHA256 ────────────────────────────────────────────────────────────
    var K = [
        0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,
        0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
        0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,
        0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
        0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,
        0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
        0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,
        0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
        0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,
        0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
        0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,
        0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
        0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,
        0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
        0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,
        0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
    ];

    function SA(x,y) { var l=(x&0xffff)+(y&0xffff), m=(x>>16)+(y>>16)+(l>>16); return (m<<16)|(l&0xffff); }
    function RL(n,c) { return (n<<c)|(n>>>(32-c)); }

    function SB(m,H) {
        var W=new Array(64),i,a,b,c,d,e,f,g,h,s0,s1,S1,ch,t1,S0,ma,t2;
        for(i=0;i<16;i++) W[i]=m[i];
        for(i=16;i<64;i++) { s0=((W[i-15]>>>7)|(W[i-15]<<25))^((W[i-15]>>>18)|(W[i-15]<<14))^(W[i-15]>>>3); s1=((W[i-2]>>>17)|(W[i-2]<<15))^((W[i-2]>>>19)|(W[i-2]<<13))^(W[i-2]>>>10); W[i]=(W[i-16]+s0+W[i-7]+s1)>>>0; }
        a=H[0];b=H[1];c=H[2];d=H[3];e=H[4];f=H[5];g=H[6];h=H[7];
        for(i=0;i<64;i++) { S1=((e>>>6)|(e<<26))^((e>>>11)|(e<<21))^((e>>>25)|(e<<7)); ch=(e&f)^((~e)&g); t1=(h+S1+ch+K[i]+W[i])>>>0; S0=((a>>>2)|(a<<30))^((a>>>13)|(a<<19))^((a>>>22)|(a<<10)); ma=(a&b)^(a&c)^(b&c); t2=(S0+ma)>>>0; h=g;g=f;f=e;e=(d+t1)>>>0;d=c;c=b;b=a;a=(t1+t2)>>>0; }
        return [(H[0]+a)>>>0,(H[1]+b)>>>0,(H[2]+c)>>>0,(H[3]+d)>>>0,(H[4]+e)>>>0,(H[5]+f)>>>0,(H[6]+g)>>>0,(H[7]+h)>>>0];
    }

    function SHAb(ms) {
        var l=ms.length,bl=l*8,pad=[],i,j,m,H=[0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
        for(i=0;i<l;i++) pad.push(ms[i]);
        pad.push(0x80);
        while(pad.length%64!==56) pad.push(0);
        for(i=7;i>=0;i--) pad.push((bl/Math.pow(2,i*8))&0xff);
        for(i=0;i<pad.length;i+=64) { m=[]; for(j=0;j<16;j++) m.push(((pad[i+j*4])<<24)|((pad[i+j*4+1])<<16)|((pad[i+j*4+2])<<8)|(pad[i+j*4+3])); H=SB(m,H); }
        var out=[];
        for(i=0;i<8;i++) out.push((H[i]>>>24)&0xff,(H[i]>>>16)&0xff,(H[i]>>>8)&0xff,H[i]&0xff);
        return out;
    }

    function S2B(s) {
        var b=[],i,c;
        for(i=0;i<s.length;i++) { c=s.charCodeAt(i); if(c<0x80) b.push(c); else if(c<0x800) b.push(0xc0|(c>>6),0x80|(c&0x3f)); else b.push(0xe0|(c>>12),0x80|((c>>6)&0x3f),0x80|(c&0x3f)); }
        return b;
    }

    function HMAC(k,m) {
        var B=64,kb=S2B(k); if(kb.length>B) kb=SHAb(kb); while(kb.length<B) kb.push(0);
        var ip=kb.map(function(b){return b^0x36;}),op=kb.map(function(b){return b^0x5c;}),mb=S2B(m);
        return SHAb(op.concat(SHAb(ip.concat(mb))));
    }

    function B2H(b) { var h="",i,x; for(i=0;i<b.length;i++) { x=b[i].toString(16); h+=x.length===2?x:"0"+x; } return h; }

    function sign() {
        var ts=Math.floor(Date.now()/1000).toString();
        return {ts:ts,sig:B2H(HMAC(HMAC_SECRET,API_KEY+":"+ts))};
    }

    function UUID() {
        var d=Date.now();
        return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g,function(c){var r=(d+Math.random()*16)%16|0;d=Math.floor(d/16);return(c==="x"?r:(r&0x3|0x8)).toString(16);});
    }

    function UA() {
        if(!gaid) gaid=UUID();
        if(!uuid) uuid=UUID();
        return UA_TPL.replace("GAID",gaid).replace("UUID",uuid);
    }

    function hdrs() {
        var s=sign();
        return {"Host":"manoda.co","User-Agent":UA(),"X-API-Key":API_KEY,"X-Signature":s.sig,"X-Timestamp":s.ts};
    }

    var _httpGet = typeof http_get === "function" ? http_get : null;

    async function GET(path) {
        var url = BASE_URL+"/"+path;
        var h = hdrs();
        var r;
        // Try both calling conventions
        if (_httpGet) {
            try { r = await _httpGet(url, h); } catch(e) {
                try { r = await _httpGet(url, {headers: h}); } catch(e2) { throw e2; }
            }
        } else {
            throw new Error("no http_get");
        }
        var b;
        if(typeof r==="string") b=r;
        else if(r&&typeof r.body==="string") b=r.body;
        else if(r&&typeof r.text==="string") b=r.text;
        else b=JSON.stringify(r);
        if(!b||b==="{}") throw new Error("empty");
        return JSON.parse(b);
    }

    function getCached(type) {
        if(Date.now()-cacheTime<CACHE_TTL && catCache[type]) return catCache[type];
        return null;
    }
    function setCache(type,data) { catCache[type]=data; cacheTime=Date.now(); }

    // ─── getHome ──────────────────────────────────────────────────────────────
    // Order: Trending → Hollywood Movies → TV Series → Bollywood Movies → Live TV
    // All content sorted newest-first (reversed arrays)
    function getHome(cb) {
        var data = {};
        var done = false;
        function respond() { if(!done){done=true;cb({success:true,data:data});} }

        setTimeout(function(){respond();},25000);

        (async function() {
            // 1. Trending (from main_page API — curated featured content)
            try {
                var j = await GET("v1/api/videos?type=main_page&channel=pikashow");
                var arr = j.records || [];
                var items = [];
                for(var i=arr.length-1; i>=0 && items.length<30; i--) {
                    var r=arr[i];
                    if(!r||!r.t) continue;
                    items.push(new MultimediaItem({
                        title:r.t, url:"pikashow:"+r.so+":hollywood",
                        posterUrl:r.c||"", type:r.f===1?"series":"movie",
                        year:r.y||undefined
                    }));
                }
                if(items.length>0) data["Trending"]=items;
            } catch(_) {}

            // 2. Hollywood Movies (newest first)
            try {
                var j = await GET("v1/api/videos?type=hollywood&channel=pikashow");
                setCache("hollywood", j);
                var arr = j.records || [];
                var items = [];
                for(var i=arr.length-1; i>=0 && items.length<40; i--) {
                    var r=arr[i]; if(!r||!r.t) continue;
                    items.push(new MultimediaItem({
                        title:r.t, url:"pikashow:"+r.so+":hollywood",
                        posterUrl:r.c||"", type:"movie", year:r.y||undefined
                    }));
                }
                if(items.length>0) data["Hollywood Movies"]=items;
            } catch(_) {}

            // 3. TV Series (newest first)
            try {
                var j = await GET("v1/api/videos?type=series&channel=pikashow");
                setCache("series", j);
                var arr = j.series || [];
                var items = [];
                for(var i=arr.length-1; i>=0 && items.length<40; i--) {
                    var s=arr[i]; if(!s||!s.t) continue;
                    items.push(new MultimediaItem({
                        title:s.t, url:"pikashow:"+s.t+":series",
                        posterUrl:s.c||"", type:"series",
                        year:s.y||undefined, score:s.i?parseFloat(s.i):undefined
                    }));
                }
                if(items.length>0) data["TV Series"]=items;
            } catch(_) {}

            // 4. Bollywood Movies (newest first)
            try {
                var j = await GET("v1/api/videos?type=bollywood&channel=pikashow");
                setCache("bollywood", j);
                var arr = j.records || [];
                var items = [];
                for(var i=arr.length-1; i>=0 && items.length<40; i--) {
                    var r=arr[i]; if(!r||!r.t) continue;
                    items.push(new MultimediaItem({
                        title:r.t, url:"pikashow:"+r.so+":bollywood",
                        posterUrl:r.c||"", type:"movie", year:r.y||undefined
                    }));
                }
                if(items.length>0) data["Bollywood Movies"]=items;
            } catch(_) {}

            // 5. Live TV channels
            try {
                var j = await GET("v1/api/videos?type=live_tv&channel=pikashow");
                var tv = j.tv || [];
                var items = [];
                for(var i=0;i<tv.length;i++) {
                    var c=tv[i]; if(!c||!c.t||!c.url) continue;
                    items.push(new MultimediaItem({
                        title:c.t,
                        url:JSON.stringify({kind:"livetv",title:c.t,streamUrl:c.url,logo:c.c||""}),
                        posterUrl:c.c||"", type:"livestream"
                    }));
                }
                if(items.length>0) data["Live TV"]=items;
            } catch(_) {}

            respond();
        })();
    }

    // ─── search ───────────────────────────────────────────────────────────────
    // Exactly matches Kotlin: search all 3 categories locally, client-side filtering
    function search(query, cb) {
        var q = String(query||"").trim().toLowerCase();
        if(!q) return cb({success:true,data:[]});

        var results = [];
        var pending = 3;
        var done = false;

        function respond() {
            if(done) return;
            done=true;
            results.sort(function(a,b){
                var at=a.title.toLowerCase(), bt=b.title.toLowerCase();
                var as=at===q?0:at.indexOf(q)===0?1:at.indexOf(q)>=0?2:3;
                var bs=bt===q?0:bt.indexOf(q)===0?1:bt.indexOf(q)>=0?2:3;
                return as-bs || a.title.localeCompare(b.title);
            });
            cb({success:true, data:results.slice(0,50)});
        }

        setTimeout(function(){respond();},20000);

        function searchType(type) {
            (async function(){
                try {
                    var j = await GET("v1/api/videos?type="+type+"&channel=pikashow");
                    setCache(type,j);
                    if(type==="series") {
                        var arr=j.series||[];
                        for(var i=0;i<arr.length;i++) {
                            var s=arr[i]; if(!s||!s.t) continue;
                            if((s.t+" "+(s.g||"")).toLowerCase().indexOf(q)>=0) {
                                results.push(new MultimediaItem({title:s.t, url:"pikashow:"+s.t+":series", posterUrl:s.c||"", type:"series", year:s.y||undefined, score:s.i?parseFloat(s.i):undefined}));
                            }
                        }
                    } else {
                        var arr=j.records||[];
                        for(var i=0;i<arr.length;i++) {
                            var r=arr[i]; if(!r||!r.t) continue;
                            if((r.t+" "+(r.g||"")).toLowerCase().indexOf(q)>=0) {
                                results.push(new MultimediaItem({title:r.t, url:"pikashow:"+r.so+":"+type, posterUrl:r.c||"", type:"movie", year:r.y||undefined}));
                            }
                        }
                    }
                } catch(_) {}
                pending--;
                if(pending<=0) respond();
            })();
        }

        searchType("series");
        searchType("hollywood");
        searchType("bollywood");
    }

    // ─── load ─────────────────────────────────────────────────────────────────
    function load(url, cb) {
        var done = false;
        function respond(d) { if(!done){done=true;cb({success:true,data:d});} }
        function fail(m) { if(!done){done=true;cb({success:false,errorCode:"LOAD_ERROR",message:m||"load failed"});} }

        setTimeout(function(){fail("timeout");},20000);

        (async function() {
            try {
                // Parse URL: pikashow:identifier:type
                var parts=String(url).split(":");
                if(parts.length<3||parts[0]!=="pikashow") return fail("bad url");

                var id=parts[1], type=parts.slice(2).join(":");

                // Try cache first
                var json = getCached(type);
                if(!json) {
                    json = await GET("v1/api/videos?type="+type+"&channel=pikashow");
                    setCache(type,json);
                }

                var title="",poster="",year=0,genre="",imdb="";

                if(type==="series") {
                    var arr=json.series||[];
                    var found=null;
                    for(var i=0;i<arr.length;i++){if(arr[i]&&arr[i].t===id){found=arr[i];break;}}
                    if(!found) return fail("series not found: "+id);

                    title=found.t||id; poster=found.c||""; year=found.y||0; genre=found.g||""; imdb=found.i||"";
                    var episodes=[];

                    // Fetch video details for episodes
                    try {
                        var vj = await GET("v1/api/video?type=series&videoId=0&title="+encodeURIComponent(title)+"&noseasons="+(found.n||1)+"&noepisodes=0");
                        if(vj&&vj.data) {
                            var dets=vj.data.detail||[];
                            for(var di=0;di<dets.length;di++) {
                                var sn=parseInt(dets[di].season,10)||(di+1);
                                var eps=dets[di].episodes||[];
                                for(var ei=0;ei<eps.length;ei++) {
                                    var en=parseInt(eps[ei].e,10)||(ei+1);
                                    episodes.push(new Episode({
                                        name:"Episode "+en,
                                        url:"pikashow_episode:"+title+":"+sn+":"+en,
                                        season:sn, episode:en, posterUrl:poster
                                    }));
                                }
                            }
                        }
                    } catch(_) {}

                    // Fallback if video API returned no episodes: use detail from list API
                    if(episodes.length===0) {
                        var dets=found.detail||[];
                        for(var di=0;di<dets.length;di++) {
                            var sn=parseInt(dets[di].season,10)||(di+1);
                            var ec=dets[di].episodes_count||1;
                            for(var ei=1;ei<=ec;ei++) {
                                episodes.push(new Episode({
                                    name:"Episode "+ei,
                                    url:"pikashow_episode:"+title+":"+sn+":"+ei,
                                    season:sn, episode:ei, posterUrl:poster
                                }));
                            }
                        }
                    }

                    if(episodes.length===0) {
                        episodes.push(new Episode({name:"Episode 1",url:"pikashow_episode:"+title+":1:1",season:1,episode:1,posterUrl:poster}));
                    }

                    return respond(new MultimediaItem({
                        title:title, url:url, posterUrl:poster, type:"series",
                        year:year||undefined, score:imdb?parseFloat(imdb):undefined,
                        description:genre, episodes:episodes
                    }));
                } else {
                    var arr=json.records||[];
                    var found=null;
                    for(var i=0;i<arr.length;i++){if(arr[i]&&String(arr[i].so)===id){found=arr[i];break;}}
                    if(!found) return fail("movie not found: "+id);

                    title=found.t||id; poster=found.c||""; year=found.y||0; genre=found.g||"";

                    return respond(new MultimediaItem({
                        title:title, url:url, posterUrl:poster, type:"movie",
                        year:year||undefined, description:genre,
                        episodes:[new Episode({name:title, url:url, season:1, episode:1, posterUrl:poster})]
                    }));
                }
            } catch(e) { fail(String(e&&e.message||e)); }
        })();
    }

    // ─── loadStreams ──────────────────────────────────────────────────────────
    function loadStreams(url, cb) {
        var done = false;
        function respond(s) { if(!done){done=true;cb({success:true,data:s||[]});} }
        setTimeout(function(){respond([]);},20000);

        (async function() {
            try {
                var parts=String(url).split(":");

                if(parts[0]==="pikashow_episode"&&parts.length>=4) {
                    var title=parts[1], season=parts[2], episode=parts[3];
                    var vj = await GET("v1/api/video?type=series&videoId=0&title="+encodeURIComponent(title)+"&noseasons="+season+"&noepisodes="+episode);
                    if(vj&&vj.data) return respond(xs(vj.data,title+" S"+season+"E"+episode));
                    return respond([]);
                }

                if(parts[0]==="pikashow"&&parts.length>=3) {
                    var id=parts[1], type=parts.slice(2).join(":");
                    if(type==="series") {
                        var vj=await GET("v1/api/video?type=series&videoId=0&title="+encodeURIComponent(id)+"&noseasons=1&noepisodes=1");
                        if(vj&&vj.data) return respond(xs(vj.data,id));
                    } else {
                        try {
                            var lj=getCached(type)||await GET("v1/api/videos?type="+type+"&channel=pikashow");
                            setCache(type,lj);
                            var recs=lj.records||[];
                            for(var fi=0;fi<recs.length;fi++) {
                                if(recs[fi]&&String(recs[fi].so)===id) {
                                    var mt=recs[fi].t||id;
                                    var vj=await GET("v1/api/video?type="+type+"&videoId="+id+"&title="+encodeURIComponent(mt)+"&noseasons=1&noepisodes=0");
                                    if(vj&&vj.data) return respond(xs(vj.data,mt));
                                    break;
                                }
                            }
                        } catch(_) {
                            try {
                                var vj=await GET("v1/api/video?type="+type+"&videoId="+id+"&title="+encodeURIComponent(id)+"&noseasons=1&noepisodes=0");
                                if(vj&&vj.data) return respond(xs(vj.data,id));
                            } catch(_) {}
                        }
                    }
                }
                respond([]);
            } catch(_) { respond([]); }
        })();
    }

    // ─── Stream Extraction (matches Kotlin addVideoLinksToCallback) ──────────
    function xs(vd,label) {
        var out=[], h={};
        if(vd.heastr) h["heastr"]=vd.heastr;
        var ua=vd.uastr||vd.uaStr||"";
        if(ua) h["User-Agent"]=ua;
        if(vd.headerStr) { try{var eh=JSON.parse(vd.headerStr);for(var k in eh){if(eh.hasOwnProperty(k))h[k]=eh[k];}}catch(_){} }
        if(vd.headers&&typeof vd.headers==="object") { for(var k in vd.headers){if(vd.headers.hasOwnProperty(k))h[k]=vd.headers[k];} }
        h["Referer"]="https://samui390dod.com/";
        h["Origin"]="https://samui390dod.com";
        var ch={}; for(var k in h){if(h.hasOwnProperty(k)&&h[k])ch[k]=h[k];}
        var chf=(Object.keys(ch).length>0)?ch:undefined;

        // Resolutions
        var res=vd.resolutions||[];
        for(var i=0;i<res.length;i++){if(res[i]&&res[i].url) out.push(new StreamResult({url:res[i].url, quality:QL(res[i].label), headers:chf, source:(label||"PS")+" "+(res[i].label||"")}));}

        // Language options
        var lo=vd.languageOptions||vd.languages||[];
        for(var li=0;li<lo.length;li++){var l=lo[li];if(!l)continue;var ln=l.language||"Default";var lr=l.resolutions||[];for(var ri=0;ri<lr.length;ri++){if(lr[ri]&&lr[ri].url) out.push(new StreamResult({url:lr[ri].url, quality:QL(lr[ri].label), headers:chf, source:(label||"PS")+" "+(lr[ri].label||"")+" ("+ln+")"}));}}

        // Direct URL fallback
        var du=vd.playUrl||vd.videoUrl||"";
        if(du&&out.length===0) { var q=0; if(vd.quality){var qs=String(vd.quality).toLowerCase();if(qs.indexOf("1080")>=0)q=1080;else if(qs.indexOf("720")>=0)q=720;else if(qs.indexOf("480")>=0)q=480;else if(qs.indexOf("360")>=0)q=360;} out.push(new StreamResult({url:du, quality:q>0?q+"p":"Auto", headers:chf, source:label||"PS"})); }
        return out;
    }

    function QL(l) { if(!l) return "Auto"; var v=String(l).toLowerCase(); if(v.indexOf("2160")>=0||v.indexOf("4k")>=0) return "4K"; if(v.indexOf("1080")>=0||v.indexOf("fullhd")>=0) return "1080p"; if(v.indexOf("720")>=0||v.indexOf("hd")>=0) return "720p"; if(v.indexOf("480")>=0) return "480p"; if(v.indexOf("360")>=0) return "360p"; return l; }

    // ─── Export ───────────────────────────────────────────────────────────────
    globalThis.getHome = getHome;
    globalThis.search = search;
    globalThis.load = load;
    globalThis.loadStreams = loadStreams;
})();
