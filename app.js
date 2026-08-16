const crypto = require('crypto');
const http = require('http');
const readline = require('readline');
const { execFile } = require('child_process');

// Cookie sp_dc akun Anda (bisa diisi langsung atau via Environment Variable SP_DC)
const SP_DC = process.env.SP_DC || "AQCyKsyTaZ27InFOezEW5ekV01jqsoBdg-mwjGypbY65R6ehPFVeLzHvGZLuDRRHROZZIajHgWEUSt9Jx6SpsKSdju56iDzckINFuJKfSJolQmq2Wl-4sMsO4Ux6BkfFdQeIM3fXmJ3fqIJg1QTLRrAzVg1BXCu4QQUOxJ-QUUW0dSBPMJdS-06Jn8toqWrjTkFn67zz2IGFmHmV-g";
const PORT = parseInt(process.env.PORT || '8888', 10);

// ANSI Colors
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[90m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";

let globalServer = null;
const audioCache = {};

function printJson(data) {
    console.log(JSON.stringify(data, null, 2));
}

// =========================================================================
// SPOTIFY PURE REVERSE-ENGINEERED CORE ENGINE (NODE.JS ZERO-DEPENDENCY)
// =========================================================================
class SpotifyPureAPI {
    constructor(spDc) {
        this.spDc = spDc;
        this.accessToken = null;
        this.clientToken = null;
        this.tokenExpiry = 0;
        this.totpSecret = ',7/*F("rLJ2oxaKL^f+E1xvP@N';
        this.totpVersion = "61";
    }

    async _fetchLatestTotpFromWeb() {
        try {
            const res = await fetch("https://open.spotify.com/", {
                headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" }
            });
            if (res.ok) {
                const html = await res.text();
                const jsMatch = html.match(/src="([^"]*\/cdn\/build\/web-player\/web-player\.[a-f0-9]+\.js)"/);
                if (jsMatch) {
                    let jsUrl = jsMatch[1];
                    if (!jsUrl.startsWith("http")) jsUrl = "https://open.spotifycdn.com" + jsUrl;
                    const jsRes = await fetch(jsUrl);
                    if (jsRes.ok) {
                        const jsText = await jsRes.text();
                        const match = jsText.match(/let\s+[a-zA-Z0-9_$]+\s*=\s*(\[\s*\{secret:.*?\}\s*\])\.map/);
                        if (match) {
                            const rawArray = match[1];
                            const itemMatches = [...rawArray.matchAll(/secret:\s*(['"])(.*?)(?<!\\)\1\s*,\s*version:\s*(\d+)/g)];
                            if (itemMatches.length > 0) {
                                itemMatches.sort((a, b) => parseInt(b[3]) - parseInt(a[3]));
                                this.totpSecret = itemMatches[0][2];
                                this.totpVersion = itemMatches[0][3];
                                return true;
                            }
                        }
                    }
                }
            }
        } catch (e) {}
        return false;
    }

    _generateTotp(timestampMs = null) {
        if (!timestampMs) timestampMs = Date.now();
        const r = [];
        for (let i = 0; i < this.totpSecret.length; i++) {
            r.push(String(this.totpSecret.charCodeAt(i) ^ ((i % 33) + 9)));
        }
        const rawKey = Buffer.from(r.join(''), 'utf-8');
        const counter = Math.floor(timestampMs / 1000 / 30);
        const counterBuf = Buffer.alloc(8);
        counterBuf.writeBigUInt64BE(BigInt(counter));

        const hmac = crypto.createHmac('sha1', rawKey).update(counterBuf).digest();
        const offset = hmac[hmac.length - 1] & 0x0f;
        const truncated = hmac.readUInt32BE(offset) & 0x7fffffff;
        return String(truncated % 1000000).padStart(6, '0');
    }

    async getClientToken() {
        const payload = {
            client_data: {
                client_version: "1.2.98.59.g81a1284c-development",
                client_id: "d8a5ed958d274c2e8ee717e6a4b0971d",
                js_sdk_data: {
                    device_brand: "Google",
                    device_model: "desktop",
                    os: "Windows",
                    os_version: "NT 10.0"
                }
            }
        };
        const res = await fetch("https://clienttoken.spotify.com/v1/clienttoken", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
                "Accept": "application/json"
            },
            body: JSON.stringify(payload)
        });
        if (!res.ok) throw new Error(`Failed to get client-token: ${res.status}`);
        const data = await res.json();
        return data?.granted_token?.token;
    }

    async getAccessToken() {
        for (let attempt = 0; attempt < 2; attempt++) {
            const totp = this._generateTotp();
            const url = `https://open.spotify.com/api/token?reason=init&productType=web-player&totp=${totp}&totpServer=${totp}&totpVer=${this.totpVersion}`;
            const res = await fetch(url, {
                headers: {
                    "Cookie": `sp_dc=${this.spDc}`,
                    "Referer": "https://open.spotify.com/",
                    "Origin": "https://open.spotify.com",
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
                    "Accept": "application/json"
                }
            });
            if (res.ok) {
                const data = await res.json();
                this.accessToken = data.accessToken;
                this.tokenExpiry = (data.accessTokenExpirationTimestampMs || 0) / 1000;
                return this.accessToken;
            }
            if (res.status === 400 && attempt === 0) {
                const updated = await this._fetchLatestTotpFromWeb();
                if (updated) continue;
            }
            const txt = await res.text();
            throw new Error(`Failed to get access-token (${res.status}): ${txt}`);
        }
    }

    async ensureTokens() {
        if (!this.clientToken) {
            this.clientToken = await this.getClientToken();
        }
        if (!this.accessToken || Date.now() / 1000 > this.tokenExpiry - 60) {
            await this.getAccessToken();
        }
    }

    async queryPathfinder(operationName, sha256Hash, variables) {
        await this.ensureTokens();
        const url = "https://api-partner.spotify.com/pathfinder/v2/query";
        const payload = {
            variables,
            operationName,
            extensions: {
                persistedQuery: {
                    version: 1,
                    sha256Hash
                }
            }
        };
        const res = await fetch(url, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${this.accessToken}`,
                "client-token": this.clientToken,
                "Content-Type": "application/json;charset=UTF-8",
                "Origin": "https://open.spotify.com",
                "Referer": "https://open.spotify.com/",
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
            },
            body: JSON.stringify(payload)
        });
        if (!res.ok) {
            const txt = await res.text();
            throw new Error(`Pathfinder '${operationName}' failed (${res.status}): ${txt}`);
        }
        return await res.json();
    }

    _extractId(inputStr, expectedType = null) {
        if (!inputStr) throw new Error("ID atau URL Spotify tidak boleh kosong.");
        inputStr = inputStr.trim();
        
        const urlMatch = inputStr.match(/spotify\.com\/(track|artist|album|playlist)\/([a-zA-Z0-9]+)/);
        if (urlMatch) {
            const [, actualType, entityId] = urlMatch;
            if (expectedType && actualType !== expectedType) {
                throw new Error(`Input yang Anda masukkan adalah URL ${actualType}, sedangkan endpoint ini memerlukan ${expectedType}.`);
            }
            return entityId;
        }

        const uriMatch = inputStr.match(/spotify:(track|artist|album|playlist):([a-zA-Z0-9]+)/);
        if (uriMatch) {
            const [, actualType, entityId] = uriMatch;
            if (expectedType && actualType !== expectedType) {
                throw new Error(`Input yang Anda masukkan adalah URI ${actualType}, sedangkan endpoint ini memerlukan ${expectedType}.`);
            }
            return entityId;
        }

        const cleanId = inputStr.split('?')[0].split('/').pop().split(':').pop().trim();
        if (!/^[a-zA-Z0-9]+$/.test(cleanId)) {
            throw new Error(`Format ID/URL Spotify tidak valid: '${inputStr}'`);
        }
        return cleanId;
    }

    async searchTracks(query, limit = 10, offset = 0) {
        const variables = {
            searchTerm: query,
            offset,
            limit,
            numberOfTopResults: limit,
            includeAudiobooks: true,
            includeAuthors: false,
            includePreReleases: true,
            includeAlbumPreReleases: false,
            includeEpisodeContentRatingsV2: true
        };
        const data = await this.queryPathfinder("searchTracks", "59ee4a659c32e9ad894a71308207594a65ba67bb6b632b183abe97303a51fa55", variables);
        const items = data?.data?.searchV2?.tracksV2?.items || [];
        
        const results = [];
        for (const it of items) {
            const t = it?.item?.data;
            if (!t) continue;
            const uri = t.uri || "";
            const tid = uri.split(':').pop();

            const artistsRaw = t.artists?.items || [];
            const artistsNames = artistsRaw.map(a => a.profile?.name).filter(Boolean);
            const firstArtistId = artistsRaw[0]?.uri?.split(':').pop() || "";

            const albumData = t.albumOfTrack || {};
            const albumId = albumData.uri ? albumData.uri.split(':').pop() : "";
            const covers = albumData.coverArt?.sources || [];
            const durMs = t.duration?.totalMilliseconds || 0;
            const isExplicit = t.contentRating?.label === "EXPLICIT";

            results.push({
                id: tid,
                title: t.name || "",
                artists: artistsNames.join(", "),
                artist_id: firstArtistId,
                album: albumData.name || "",
                album_id: albumId,
                duration: `${Math.floor(durMs / 60000)}:${String(Math.floor((durMs % 60000) / 1000)).padStart(2, '0')}`,
                is_explicit: isExplicit,
                cover_url: covers.length > 0 ? covers[covers.length - 1].url : "",
                spotify_url: `https://open.spotify.com/track/${tid}`
            });
        }
        return results;
    }

    async searchArtists(query, limit = 10, offset = 0) {
        const variables = { searchTerm: query, offset, limit };
        const data = await this.queryPathfinder("searchArtists", "270905851ba5c7faca81cfe053c2dbd8ceb4f156a0e0ef4b385af75ab69ffd13", variables);
        const items = data?.data?.searchV2?.artists?.items || [];
        
        const results = [];
        for (const it of items) {
            const a = it?.data;
            if (!a) continue;
            const aid = a.uri ? a.uri.split(':').pop() : "";
            const avatars = a.visuals?.avatarImage?.sources || [];
            const avatarUrl = avatars.length > 0 ? avatars[avatars.length - 1].url : "";

            results.push({
                id: aid,
                name: a.profile?.name || "",
                verified: a.profile?.verified || false,
                avatar_url: avatarUrl,
                spotify_url: `https://open.spotify.com/artist/${aid}`
            });
        }
        return results;
    }

    async searchAlbums(query, limit = 10, offset = 0) {
        const variables = { searchTerm: query, offset, limit };
        const data = await this.queryPathfinder("searchAlbums", "64ae1fe6df380b038c0a65a2606d3361bc270de6870b2fdc99cf0848b1efa6d3", variables);
        const items = data?.data?.searchV2?.albumsV2?.items || [];
        
        const results = [];
        for (const it of items) {
            const alb = it?.data;
            if (!alb) continue;
            const alid = alb.uri ? alb.uri.split(':').pop() : "";
            const artists = (alb.artists?.items || []).map(ar => ar.name).filter(Boolean);
            const covers = alb.coverArt?.sources || [];
            const coverUrl = covers.length > 0 ? covers[covers.length - 1].url : "";

            results.push({
                id: alid,
                title: alb.name || "",
                artists: artists.join(", "),
                release_year: alb.date?.year || null,
                cover_url: coverUrl,
                spotify_url: `https://open.spotify.com/album/${alid}`
            });
        }
        return results;
    }

    async getTrackDetails(trackIdOrUrl) {
        const trackId = this._extractId(trackIdOrUrl, "track");
        const variables = { uri: `spotify:track:${trackId}` };
        const data = await this.queryPathfinder("getTrack", "1a2f0cce77c90a4a5b1730beecc4da7e34290d684324c16663bf09a268ebce48", variables);
        const t = data?.data?.trackUnion;
        if (!t || t.__typename === "NotFound") {
            throw new Error(`Lagu dengan ID '${trackId}' tidak ditemukan di Spotify.`);
        }

        const durMs = t.duration?.totalMilliseconds || 0;
        const albumData = t.albumOfTrack || {};
        const albumId = albumData.uri ? albumData.uri.split(':').pop() : "";
        const covers = albumData.coverArt?.sources || [];

        const firstArt = t.firstArtist?.items || [];
        const otherArt = t.otherArtists?.items || [];
        const allArtists = [...firstArt, ...otherArt];
        const artistsNames = allArtists.map(a => a.profile?.name).filter(Boolean);
        const artistId = allArtists[0]?.uri?.split(':').pop() || "";

        const playcountRaw = t.playcount;
        const playcountInt = playcountRaw ? parseInt(playcountRaw, 10) : null;
        const isExplicit = t.contentRating?.label === "EXPLICIT";
        const releaseDate = albumData.date?.isoString || "";
        const canvasUrl = await this.getCanvasUrl(trackId);

        return {
            id: trackId,
            title: t.name,
            artists: artistsNames.join(", "),
            artist_id: artistId,
            album: albumData.name,
            album_id: albumId,
            release_date: releaseDate ? releaseDate.slice(0, 10) : "",
            duration: `${Math.floor(durMs / 60000)}:${String(Math.floor((durMs % 60000) / 1000)).padStart(2, '0')}`,
            playcount: playcountInt,
            playcount_formatted: playcountInt ? playcountInt.toLocaleString() : "0",
            is_explicit: isExplicit,
            cover_url: covers.length > 0 ? covers[covers.length - 1].url : "",
            canvas_url: canvasUrl,
            spotify_url: `https://open.spotify.com/track/${trackId}`
        };
    }

    async getCanvasUrl(trackIdOrUrl) {
        try {
            const trackId = this._extractId(trackIdOrUrl, "track");
            await this.ensureTokens();
            const trackUri = `spotify:track:${trackId}`;
            
            const uriBuf = Buffer.from(trackUri, 'utf-8');
            const trackMsg = Buffer.concat([Buffer.from([0x0a, uriBuf.length]), uriBuf]);
            const reqMsg = Buffer.concat([Buffer.from([0x0a, trackMsg.length]), trackMsg]);

            const res = await fetch("https://spclient.wg.spotify.com/canvaz-cache/v0/canvases", {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${this.accessToken}`,
                    "client-token": this.clientToken,
                    "App-Platform": "Android",
                    "Content-Type": "application/x-protobuf"
                },
                body: reqMsg
            });

            if (res.ok) {
                const buf = Buffer.from(await res.arrayBuffer());
                if (buf.length > 10) {
                    const text = buf.toString('utf-8');
                    const match = text.match(/https:\/\/canvaz\.scdn\.co\/[^\s\x00-\x1f\x7f-\xff]+\.cnvs\.mp4/);
                    if (match) return match[0];
                }
            }
        } catch (e) {}
        return null;
    }

    async getLyrics(trackIdOrUrl) {
        const trackId = this._extractId(trackIdOrUrl, "track");
        await this.ensureTokens();

        const url = `https://spclient.wg.spotify.com/color-lyrics/v2/track/${trackId}?format=json&market=from_token`;
        const res = await fetch(url, {
            headers: {
                "Authorization": `Bearer ${this.accessToken}`,
                "client-token": this.clientToken,
                "App-Platform": "WebPlayer",
                "Accept": "application/json",
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
            }
        });

        if (res.status === 404) {
            return { track_id: trackId, has_lyrics: false, message: "Lirik tidak tersedia untuk lagu ini." };
        }
        if (!res.ok) throw new Error(`Gagal mengambil lirik (${res.status})`);

        const raw = await res.json();
        const data = raw.lyrics || {};
        const syncType = data.syncType || "UNSYNCED";
        const isTimeSynced = ["LINE_SYNCED", "SYLLABLE_SYNCED"].includes(syncType);
        const linesRaw = data.lines || [];

        const lines = [];
        const lrcLines = [];
        const plainLines = [];

        for (const line of linesRaw) {
            const words = (line.words || "").trim();
            plainLines.push(words);

            if (isTimeSynced) {
                const startMs = parseInt(line.startTimeMs || "0", 10);
                const totalSec = startMs / 1000;
                const m = Math.floor(totalSec / 60);
                const s = (totalSec % 60).toFixed(2);
                lrcLines.push(`[${String(m).padStart(2, '0')}:${String(s).padStart(5, '0')}] ${words}`);
                lines.push({
                    startTimeMs: startMs,
                    time_formatted: `${Math.floor(startMs / 60000)}:${String(Math.floor((startMs % 60000) / 1000)).padStart(2, '0')}`,
                    words
                });
            } else {
                lines.push({ time_formatted: null, words });
            }
        }

        return {
            track_id: trackId,
            has_lyrics: true,
            is_time_synced: isTimeSynced,
            syncType,
            language: data.language,
            lrc_format: isTimeSynced ? lrcLines.join('\n') : null,
            plain_text: plainLines.join('\n'),
            lines
        };
    }

    async getArtistOverview(artistIdOrUrl) {
        const artistId = this._extractId(artistIdOrUrl, "artist");
        const variables = { uri: `spotify:artist:${artistId}`, locale: "" };
        const data = await this.queryPathfinder("queryArtistOverview", "ae0e2958a4ab645b35ca19ac04d0495ae12d9c5d7b7286217674801a9aab281a", variables);
        const artistUnion = data?.data?.artistUnion;
        if (!artistUnion || artistUnion.__typename === "NotFound") {
            throw new Error(`Artis dengan ID '${artistId}' tidak ditemukan di Spotify.`);
        }

        const profile = artistUnion.profile || {};
        const stats = artistUnion.stats || {};
        const visuals = artistUnion.visuals || {};

        const avatars = visuals.avatarImage?.sources || [];
        const avatarUrl = avatars.length > 0 ? avatars[avatars.length - 1].url : "";
        const headersImg = visuals.headerImage?.sources || [];
        const headerUrl = headersImg.length > 0 ? headersImg[headersImg.length - 1].url : "";

        const ml = stats.monthlyListeners || null;
        const topTracksRaw = artistUnion.discography?.topTracks?.items || [];
        const topTracks = [];
        for (const item of topTracksRaw) {
            const t = item.track;
            if (t) {
                const tid = t.uri ? t.uri.split(':').pop() : "";
                const dur = t.duration?.totalMilliseconds || 0;
                const pc = t.playcount ? parseInt(t.playcount, 10) : null;
                topTracks.push({
                    id: tid,
                    title: t.name,
                    duration: `${Math.floor(dur / 60000)}:${String(Math.floor((dur % 60000) / 1000)).padStart(2, '0')}`,
                    streams: pc ? pc.toLocaleString() : "0",
                    spotify_url: `https://open.spotify.com/track/${tid}`,
                    stream_url: `http://localhost:${PORT}/stream/${tid}`
                });
            }
        }

        return {
            id: artistId,
            name: profile.name,
            verified: profile.verified || false,
            monthly_listeners: ml,
            monthly_listeners_formatted: ml ? ml.toLocaleString() : "0",
            world_rank: stats.worldRank || null,
            top_cities: (stats.topCities?.items || []).map(c => ({
                city: c.city,
                country: c.country,
                listeners: c.numberOfListeners,
                listeners_formatted: c.numberOfListeners ? c.numberOfListeners.toLocaleString() : "0"
            })),
            avatar_url: avatarUrl,
            header_url: headerUrl,
            top_tracks: topTracks,
            spotify_url: `https://open.spotify.com/artist/${artistId}`
        };
    }

    async getAlbum(albumIdOrUrl) {
        const albumId = this._extractId(albumIdOrUrl, "album");
        const variables = { uri: `spotify:album:${albumId}`, locale: "", offset: 0, limit: 100 };
        const data = await this.queryPathfinder("getAlbum", "b9bfabef66ed756e5e13f68a942deb60bd4125ec1f1be8cc42769dc0259b4b10", variables);
        const alb = data?.data?.albumUnion;
        if (!alb || alb.__typename === "NotFound") {
            throw new Error(`Album dengan ID '${albumId}' tidak ditemukan di Spotify.`);
        }

        const artistsRaw = alb.artists?.items || [];
        const artistsNames = artistsRaw.map(a => a.profile?.name).filter(Boolean);
        const artistId = artistsRaw[0]?.uri?.split(':').pop() || "";

        const covers = alb.coverArt?.sources || [];
        const coverUrl = covers.length > 0 ? covers[covers.length - 1].url : "";
        const relDate = alb.date?.isoString || "";

        const tracksRaw = alb.tracksV2?.items || [];
        const tracks = [];
        for (const it of tracksRaw) {
            const tr = it.track;
            if (tr) {
                const tid = tr.uri ? tr.uri.split(':').pop() : "";
                const dur = tr.duration?.totalMilliseconds || 0;
                const trArtists = (tr.artists?.items || []).map(a => a.profile?.name).filter(Boolean);
                tracks.push({
                    track_number: tr.trackNumber,
                    id: tid,
                    title: tr.name,
                    artists: trArtists.join(", "),
                    duration: `${Math.floor(dur / 60000)}:${String(Math.floor((dur % 60000) / 1000)).padStart(2, '0')}`,
                    is_explicit: tr.contentRating?.label === "EXPLICIT",
                    spotify_url: `https://open.spotify.com/track/${tid}`,
                    stream_url: `http://localhost:${PORT}/stream/${tid}`
                });
            }
        }

        return {
            id: albumId,
            title: alb.name,
            artists: artistsNames.join(", "),
            artist_id: artistId,
            release_date: relDate ? relDate.slice(0, 10) : "",
            total_tracks: alb.tracksV2?.totalCount || tracks.length,
            cover_url: coverUrl,
            tracks,
            spotify_url: `https://open.spotify.com/album/${albumId}`
        };
    }

    async getPlaylist(playlistIdOrUrl) {
        const playlistId = this._extractId(playlistIdOrUrl, "playlist");
        const variables = {
            uri: `spotify:playlist:${playlistId}`,
            offset: 0,
            limit: 25,
            enableWatchFeedEntrypoint: false,
            includeEpisodeContentRatingsV2: false
        };
        const data = await this.queryPathfinder("fetchPlaylist", "86dde7b9d9356e2369414647cf6950cfed96e778e129cfdfc99aea6c1613b3b0", variables);
        const pl = data?.data?.playlistV2;
        if (!pl || pl.__typename === "NotFound" || pl.__typename === "GenericError") {
            throw new Error(`Playlist dengan ID '${playlistId}' tidak ditemukan di Spotify.`);
        }

        const itemsRaw = pl.content?.items || [];
        const tracks = [];
        for (const it of itemsRaw) {
            const tr = it.itemV2?.data;
            if (tr) {
                const tid = tr.uri ? tr.uri.split(':').pop() : "";
                const dur = tr.duration?.totalMilliseconds || 0;
                const trArtists = (tr.artists?.items || []).map(a => a.profile?.name).filter(Boolean);
                tracks.push({
                    id: tid,
                    title: tr.name,
                    artists: trArtists.join(", "),
                    duration: `${Math.floor(dur / 60000)}:${String(Math.floor((dur % 60000) / 1000)).padStart(2, '0')}`,
                    spotify_url: `https://open.spotify.com/track/${tid}`,
                    stream_url: `http://localhost:${PORT}/stream/${tid}`
                });
            }
        }

        return {
            id: playlistId,
            name: pl.name,
            description: pl.description || "",
            total_tracks: pl.content?.totalCount || tracks.length,
            tracks,
            spotify_url: `https://open.spotify.com/playlist/${playlistId}`
        };
    }

    async getHomeFeed(sectionLimit = 30, itemsLimit = 20) {
        const variables = {
            homeEndUserIntegration: "INTEGRATION_WEB_PLAYER",
            facet: "",
            sectionItemsLimit: itemsLimit,
            timeZone: "Asia/Jakarta",
            sp_t: "",
            includeEpisodeContentRatingsV2: false
        };
        const data = await this.queryPathfinder("home", "76243c78b0e20ecdbe41b794dec8cbe73f75e585b0a7201b8d2e84578412847a", variables);
        const sectionsRaw = data?.data?.home?.sectionContainer?.sections?.items || [];
        
        const homeFeed = [];
        for (const sec of sectionsRaw) {
            const secData = sec?.data || {};
            const titleObj = secData?.title || {};
            const secTitle = titleObj.transformedLabel || titleObj.translatedBaseText;
            if (!secTitle) continue;

            const titleLower = secTitle.toLowerCase();
            if (titleLower.includes("episode") || titleLower.includes("show") || titleLower.includes("podcast") || titleLower.includes("audiobook")) {
                continue;
            }

            const itemsRaw = sec?.sectionItems?.items || [];
            const cards = [];
            for (const it of itemsRaw) {
                const c = it?.content?.data;
                if (!c) continue;
                const uri = c.uri || "";
                if (!uri) continue;
                const entityType = uri.includes(':') ? uri.split(':')[1] : "item";
                if (entityType === "episode" || entityType === "show") continue;

                const eid = uri.split(':').pop();
                const name = c.name || c.title?.text || c.profile?.name;
                if (!name) continue;
                const desc = c.description || "";

                const images = c.images?.items || c.coverArt?.sources || c.visuals?.avatarImage?.sources || [];
                let coverUrl = "";
                if (images.length > 0 && images[0]?.sources) {
                    coverUrl = images[0].sources[images[0].sources.length - 1]?.url || "";
                } else if (images.length > 0 && images[0]?.url) {
                    coverUrl = images[images.length - 1]?.url || "";
                }

                const cardItem = {
                    id: eid,
                    type: entityType,
                    title: name,
                    description: desc,
                    cover_url: coverUrl,
                    spotify_url: `https://open.spotify.com/${entityType}/${eid}`,
                    stream_url: `http://localhost:${PORT}/stream/${eid}`
                };
                cards.push(cardItem);
            }

            if (cards.length > 0) {
                homeFeed.push({
                    section: secTitle,
                    total_items: cards.length,
                    items: cards
                });
            }
            if (homeFeed.length >= sectionLimit) break;
        }
        return homeFeed;
    }
}

const spotifyClient = new SpotifyPureAPI(SP_DC);


// =========================================================================
// AUDIO STREAM RESOLVER VIA YT-DLP
// =========================================================================
function getDirectFullAudioUrl(query) {
    return new Promise((resolve) => {
        if (audioCache[query]) return resolve(audioCache[query]);

        const args = [
            `ytsearch1:${query} audio`,
            '--format', 'bestaudio[ext=m4a]/bestaudio/best',
            '--get-url',
            '--no-playlist',
            '--quiet',
            '--no-warnings',
            '--extractor-args', 'youtube:player_client=ios,android'
        ];

        execFile('yt-dlp', args, (error, stdout) => {
            if (!error && stdout) {
                const url = stdout.trim().split('\n')[0];
                if (url) {
                    audioCache[query] = url;
                    return resolve(url);
                }
            }
            resolve("");
        });
    });
}

async function resolvePlayableTrack(id) {
    try {
        const t = await spotifyClient.getTrackDetails(id);
        if (t && t.title) {
            return {
                current: t,
                queue: [{ id: t.id, title: t.title, artists: t.artists }]
            };
        }
    } catch (e) {}

    try {
        const alb = await spotifyClient.getAlbum(id);
        if (alb && alb.tracks && alb.tracks.length > 0) {
            return {
                current: alb.tracks[0],
                queue: alb.tracks.map(tr => ({
                    id: tr.id,
                    title: tr.title,
                    artists: tr.artists || alb.artists
                }))
            };
        }
    } catch (e) {}

    try {
        const pl = await spotifyClient.getPlaylist(id);
        if (pl && pl.tracks && pl.tracks.length > 0) {
            return {
                current: pl.tracks[0],
                queue: pl.tracks.map(tr => ({
                    id: tr.id,
                    title: tr.title,
                    artists: tr.artists
                }))
            };
        }
    } catch (e) {}

    try {
        const art = await spotifyClient.getArtistOverview(id);
        if (art && art.top_tracks && art.top_tracks.length > 0) {
            return {
                current: art.top_tracks[0],
                queue: art.top_tracks.map(tr => ({
                    id: tr.id,
                    title: tr.title,
                    artists: art.name
                }))
            };
        }
    } catch (e) {}

    return null;
}


// =========================================================================
// HTTP AUDIO STREAMING SERVER
// =========================================================================
function startStreamingServer(port = PORT) {
    if (globalServer) return globalServer;

    globalServer = http.createServer(async (req, res) => {
        const parsedUrl = new URL(req.url, `http://localhost:${port}`);
        const pathname = parsedUrl.pathname;

        // 1. Endpoint: /stream/:id (HTML5 Audio Progress Bar Only)
        if (pathname.startsWith('/stream/')) {
            const rawId = pathname.split('/').pop();
            if (!rawId) {
                res.writeHead(400, { 'Content-Type': 'text/plain' });
                return res.end('Track ID missing');
            }

            try {
                const resolved = await resolvePlayableTrack(rawId);
                if (!resolved || !resolved.current) {
                    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                    return res.end(`<!DOCTYPE html><html><body style="background:#000;color:#666;font-family:sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;"><p>Stream not available for this item</p></body></html>`);
                }

                const firstTrack = resolved.current;
                const queue = resolved.queue || [firstTrack];
                const title = firstTrack.title || "Track";
                const artists = firstTrack.artists || "";
                const pageTitle = artists ? `${title} — ${artists}` : title;

                const html = `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Cache-Control" content="no-cache, no-store, must-revalidate">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${pageTitle}</title>
  <style>
    html, body {
      margin: 0; padding: 0; width: 100%; height: 100%;
      background-color: #000000; display: flex;
      justify-content: center; align-items: center; overflow: hidden;
    }
    audio { width: 320px; height: 40px; outline: none; }
  </style>
</head>
<body>
  <audio id="player" controls autoplay src="/audio/${firstTrack.id}"></audio>
  <script>
    const queue = ${JSON.stringify(queue)};
    let currentIndex = 0;
    const player = document.getElementById('player');
    player.addEventListener('ended', () => {
      currentIndex++;
      if (currentIndex < queue.length) {
        const next = queue[currentIndex];
        document.title = next.artists ? (next.title + ' — ' + next.artists) : next.title;
        player.src = '/audio/' + next.id;
        player.play();
      }
    });
  </script>
</body>
</html>`;
                res.writeHead(200, {
                    'Content-Type': 'text/html; charset=utf-8',
                    'Cache-Control': 'no-cache, no-store, must-revalidate'
                });
                res.end(html);
            } catch (err) {
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                res.end(`Error: ${err.message}`);
            }
            return;
        }

        // 2. Endpoint: /audio/:id (Proxy Audio Chunks with Full HTTP 206 Range Seeking Support)
        if (pathname.startsWith('/audio/')) {
            const rawId = pathname.split('/').pop();
            try {
                const resolved = await resolvePlayableTrack(rawId);
                if (!resolved || !resolved.current) {
                    res.writeHead(404, { 'Content-Type': 'text/plain' });
                    return res.end('Audio stream not found');
                }

                const trackInfo = resolved.current;
                const audioUrl = await getDirectFullAudioUrl(`${trackInfo.artists} - ${trackInfo.title}`);
                if (!audioUrl) {
                    res.writeHead(404, { 'Content-Type': 'text/plain' });
                    return res.end('Audio stream not found');
                }

                const forwardHeaders = {
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
                };
                if (req.headers.range) {
                    forwardHeaders["Range"] = req.headers.range;
                }

                const audioRes = await fetch(audioUrl, {
                    headers: forwardHeaders
                });

                const responseHeaders = {
                    'Content-Type': audioRes.headers.get('content-type') || 'audio/mp4',
                    'Accept-Ranges': 'bytes',
                    'Cache-Control': 'no-cache'
                };
                if (audioRes.headers.has('content-range')) {
                    responseHeaders['Content-Range'] = audioRes.headers.get('content-range');
                }
                if (audioRes.headers.has('content-length')) {
                    responseHeaders['Content-Length'] = audioRes.headers.get('content-length');
                }

                res.writeHead(audioRes.status, responseHeaders);

                const reader = audioRes.body.getReader();
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    res.write(value);
                }
                res.end();
            } catch (err) {
                if (!res.headersSent) res.writeHead(500);
                res.end();
            }
            return;
        }

        // CORS Headers helper
        const sendJson = (statusCode, data) => {
            res.writeHead(statusCode, {
                'Content-Type': 'application/json; charset=utf-8',
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type, Range'
            });
            res.end(JSON.stringify(data, null, 2));
        };

        if (req.method === 'OPTIONS') {
            res.writeHead(204, {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type, Range'
            });
            return res.end();
        }

        // =====================================================================
        // REST API ENDPOINTS
        // =====================================================================
        // GET /api/search?q=query&limit=5
        if (pathname === '/api/search' || pathname === '/api/search/track') {
            const q = parsedUrl.searchParams.get('q') || '';
            const limit = parseInt(parsedUrl.searchParams.get('limit') || '5', 10);
            if (!q) return sendJson(400, { status: 'error', message: "Parameter 'q' (query) diperlukan." });
            try {
                const data = await spotifyClient.searchTracks(q, limit);
                data.forEach(item => { item.stream_url = `http://localhost:${port}/stream/${item.id}`; });
                return sendJson(200, { status: 'success', total: data.length, data });
            } catch (err) {
                return sendJson(500, { status: 'error', message: err.message });
            }
        }

        // GET /api/search/artist?q=query&limit=5
        if (pathname === '/api/search/artist') {
            const q = parsedUrl.searchParams.get('q') || '';
            const limit = parseInt(parsedUrl.searchParams.get('limit') || '5', 10);
            if (!q) return sendJson(400, { status: 'error', message: "Parameter 'q' (query) diperlukan." });
            try {
                const data = await spotifyClient.searchArtists(q, limit);
                return sendJson(200, { status: 'success', total: data.length, data });
            } catch (err) {
                return sendJson(500, { status: 'error', message: err.message });
            }
        }

        // GET /api/search/album?q=query&limit=5
        if (pathname === '/api/search/album') {
            const q = parsedUrl.searchParams.get('q') || '';
            const limit = parseInt(parsedUrl.searchParams.get('limit') || '5', 10);
            if (!q) return sendJson(400, { status: 'error', message: "Parameter 'q' (query) diperlukan." });
            try {
                const data = await spotifyClient.searchAlbums(q, limit);
                return sendJson(200, { status: 'success', total: data.length, data });
            } catch (err) {
                return sendJson(500, { status: 'error', message: err.message });
            }
        }

        // GET /api/track/:id
        if (pathname.startsWith('/api/track/')) {
            const trackId = pathname.split('/').pop();
            try {
                const data = await spotifyClient.getTrackDetails(trackId);
                data.stream_url = `http://localhost:${port}/stream/${data.id}`;
                return sendJson(200, { status: 'success', data });
            } catch (err) {
                return sendJson(500, { status: 'error', message: err.message });
            }
        }

        // GET /api/lyrics/:id
        if (pathname.startsWith('/api/lyrics/')) {
            const trackId = pathname.split('/').pop();
            try {
                const data = await spotifyClient.getLyrics(trackId);
                return sendJson(200, { status: 'success', data });
            } catch (err) {
                return sendJson(500, { status: 'error', message: err.message });
            }
        }

        // GET /api/canvas/:id
        if (pathname.startsWith('/api/canvas/')) {
            const trackId = pathname.split('/').pop();
            try {
                const canvas_url = await spotifyClient.getCanvasUrl(trackId);
                return sendJson(200, { status: 'success', track_id: trackId, canvas_url });
            } catch (err) {
                return sendJson(500, { status: 'error', message: err.message });
            }
        }

        // GET /api/artist/:id
        if (pathname.startsWith('/api/artist/')) {
            const artistId = pathname.split('/').pop();
            try {
                const data = await spotifyClient.getArtistOverview(artistId);
                return sendJson(200, { status: 'success', data });
            } catch (err) {
                return sendJson(500, { status: 'error', message: err.message });
            }
        }

        // GET /api/album/:id
        if (pathname.startsWith('/api/album/')) {
            const albumId = pathname.split('/').pop();
            try {
                const data = await spotifyClient.getAlbum(albumId);
                return sendJson(200, { status: 'success', data });
            } catch (err) {
                return sendJson(500, { status: 'error', message: err.message });
            }
        }

        // GET /api/playlist/:id
        if (pathname.startsWith('/api/playlist/')) {
            const playlistId = pathname.split('/').pop();
            try {
                const data = await spotifyClient.getPlaylist(playlistId);
                return sendJson(200, { status: 'success', data });
            } catch (err) {
                return sendJson(500, { status: 'error', message: err.message });
            }
        }

        // GET /api/home
        if (pathname === '/api/home' || pathname === '/api/feed') {
            try {
                const data = await spotifyClient.getHomeFeed();
                return sendJson(200, { status: 'success', total_sections: data.length, data });
            } catch (err) {
                return sendJson(500, { status: 'error', message: err.message });
            }
        }

        // Root / -> REST API Documentation
        return sendJson(200, {
            name: "Spotify Pure HTTP REST API & Streaming Server",
            status: "online",
            endpoints: {
                search: `http://localhost:${port}/api/search?q=Shape of My Heart&limit=5`,
                search_artist: `http://localhost:${port}/api/search/artist?q=Backstreet Boys`,
                search_album: `http://localhost:${port}/api/search/album?q=Midnights`,
                track: `http://localhost:${port}/api/track/:track_id`,
                lyrics: `http://localhost:${port}/api/lyrics/:track_id`,
                canvas: `http://localhost:${port}/api/canvas/:track_id`,
                artist: `http://localhost:${port}/api/artist/:artist_id`,
                album: `http://localhost:${port}/api/album/:album_id`,
                playlist: `http://localhost:${port}/api/playlist/:playlist_id`,
                home: `http://localhost:${port}/api/home`,
                stream_player: `http://localhost:${port}/stream/:id`,
                audio_stream: `http://localhost:${port}/audio/:id`
            }
        });
    });

    globalServer.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
            // Port already in use, reuse existing running server instance
        }
    });

    try {
        globalServer.listen(port, () => {});
    } catch (e) {}

    return globalServer;
}

function cleanupServer() {
    if (globalServer) {
        try {
            globalServer.close();
        } catch (e) {}
    }
}

process.on('SIGINT', () => { cleanupServer(); process.exit(0); });
process.on('SIGTERM', () => { cleanupServer(); process.exit(0); });
process.on('exit', () => { cleanupServer(); });


// =========================================================================
// INTERACTIVE CLI
// =========================================================================
function renderMenu() {
    console.log("1. search");
    console.log("2. search-artist");
    console.log("3. search-album");
    console.log("4. lyrics");
    console.log("5. track");
    console.log("6. artist");
    console.log("7. album");
    console.log("8. home");
    console.log("q. exit\n");
}

function startInteractiveCli() {
    startStreamingServer(PORT);
    renderMenu();

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    const ask = (promptText) => new Promise(resolve => rl.question(promptText, resolve));

    async function loop() {
        while (true) {
            const choice = (await ask(`${CYAN}> ${RESET}`)).trim().toLowerCase();
            if (!choice) continue;
            if (['q', 'exit', 'quit', ':q'].includes(choice)) {
                cleanupServer();
                rl.close();
                process.exit(0);
            }

            try {
                if (choice === '1' || choice === 'search') {
                    const q = (await ask(`${DIM}query > ${RESET}`)).trim();
                    if (q) {
                        const res = await spotifyClient.searchTracks(q, 5);
                        res.forEach(item => { item.stream_url = `http://localhost:${PORT}/stream/${item.id}`; });
                        printJson(res);
                    }
                } else if (choice === '2' || choice === 'search-artist') {
                    const q = (await ask(`${DIM}artist > ${RESET}`)).trim();
                    if (q) printJson(await spotifyClient.searchArtists(q, 5));
                } else if (choice === '3' || choice === 'search-album') {
                    const q = (await ask(`${DIM}album > ${RESET}`)).trim();
                    if (q) printJson(await spotifyClient.searchAlbums(q, 5));
                } else if (choice === '4' || choice === 'lyrics') {
                    const q = (await ask(`${DIM}track id/url > ${RESET}`)).trim();
                    if (q) printJson(await spotifyClient.getLyrics(q));
                } else if (choice === '5' || choice === 'track') {
                    const q = (await ask(`${DIM}track id/url > ${RESET}`)).trim();
                    if (q) {
                        const res = await spotifyClient.getTrackDetails(q);
                        res.stream_url = `http://localhost:${PORT}/stream/${res.id}`;
                        printJson(res);
                    }
                } else if (choice === '6' || choice === 'artist') {
                    const q = (await ask(`${DIM}artist id/url > ${RESET}`)).trim();
                    if (q) printJson(await spotifyClient.getArtistOverview(q));
                } else if (choice === '7' || choice === 'album') {
                    const q = (await ask(`${DIM}album id/url > ${RESET}`)).trim();
                    if (q) printJson(await spotifyClient.getAlbum(q));
                } else if (choice === '8' || choice === 'home') {
                    printJson(await spotifyClient.getHomeFeed());
                } else if (choice === 'help' || choice === '?') {
                    renderMenu();
                } else {
                    console.log(`${YELLOW}unknown command '${choice}'. Type 1-8 or 'q'.${RESET}`);
                }
            } catch (err) {
                printJson({ status: "error", message: err.message });
            }
        }
    }

    loop();
}

// =========================================================================
// MAIN DISPATCHER
// =========================================================================
async function main() {
    const args = process.argv.slice(2);
    if (args.length === 0) {
        startInteractiveCli();
        return;
    }

    const cmd = args[0];
    const target = args[1] || "";

    try {
        if (cmd === 'serve') {
            const port = parseInt(args[1] || `${PORT}`, 10);
            startStreamingServer(port);
            console.log(`\n${BOLD}spotify-server${RESET} ${DIM}http://localhost:{port}${RESET}\n`);
        } else if (cmd === 'search') {
            const data = await spotifyClient.searchTracks(target, 5);
            data.forEach(item => { item.stream_url = `http://localhost:${PORT}/stream/${item.id}`; });
            printJson(data);
        } else if (cmd === 'search-artist') {
            printJson(await spotifyClient.searchArtists(target, 5));
        } else if (cmd === 'search-album') {
            printJson(await spotifyClient.searchAlbums(target, 5));
        } else if (cmd === 'lyrics') {
            printJson(await spotifyClient.getLyrics(target));
        } else if (cmd === 'track') {
            const data = await spotifyClient.getTrackDetails(target);
            data.stream_url = `http://localhost:${PORT}/stream/${data.id}`;
            printJson(data);
        } else if (cmd === 'artist') {
            printJson(await spotifyClient.getArtistOverview(target));
        } else if (cmd === 'album') {
            printJson(await spotifyClient.getAlbum(target));
        } else if (cmd === 'home') {
            printJson(await spotifyClient.getHomeFeed());
        } else {
            console.log(`${YELLOW}Unknown command: '${cmd}'. Use: search, search-artist, search-album, lyrics, track, artist, album, home, serve${RESET}`);
        }
    } catch (err) {
        printJson({ status: "error", message: err.message });
    }
}

if (require.main === module) {
    main();
}

module.exports = { SpotifyPureAPI, spotifyClient, startStreamingServer };
