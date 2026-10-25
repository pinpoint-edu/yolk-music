import extractCobaltMedia from './cobalt-engine.js';

const MUSIC_API_BASE = 'https://bhindi1.ddns.net/music/api';

let youtubeInstance = null;
let isInitializing = false;

async function getYoutube() {
  if (youtubeInstance) return youtubeInstance;
  if (isInitializing) {
      while (isInitializing) await new Promise(r => setTimeout(r, 100));
      if (youtubeInstance) return youtubeInstance;
  }

  isInitializing = true;
  try {
      const { Innertube, Platform } = await import('youtubei.js');
      if (Platform && Platform.shim) {
          Platform.shim.eval = (data, env) => {
              const code = typeof data === 'string' ? data : data.output;
              const fn = new Function(...Object.keys(env), code);
              return fn(...Object.values(env));
          };
      }
      youtubeInstance = await Innertube.create({
          cache: null,
          generate_session_locally: true,
          retrieve_player: true
      });
      isInitializing = false;
      return youtubeInstance;
  } catch (e) {
      isInitializing = false;
      console.error(e);
      throw new Error(`Innertube failed: ${e.message}`);
  }
}

function optimizeThumbnailUrl(url) {
  if (!url) return url;
  if (url.includes('googleusercontent.com') || url.includes('ggpht.com')) {
      return url.split('=')[0] + '=w544-h544-l90-rj';
  }
  if (url.includes('i.ytimg.com') && url.includes('/vi/')) {
      const videoId = url.split('/vi/')[1].split('/')[0];
      return `https://i.ytimg.com/vi/${videoId}/0.jpg`;
  }
  return url;
}

const YTM_KEY = "AIzaSyC9XL3ZjWddXya6X74dJoCTL-WEYFDNX30";

async function fetchYTM(endpoint, body = {}) {
  try {
    const payload = {
      context: {
        client: {
          clientName: "WEB_REMIX",
          clientVersion: "1.20240729.01.00",
          hl: "en",
          gl: "US"
        }
      },
      ...body
    };
    const res = await fetch(`https://music.youtube.com/youtubei/v1/${endpoint}?alt=json&key=${YTM_KEY}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:88.0) Gecko/20100101 Firefox/88.0",
        "Origin": "https://music.youtube.com",
        "Referer": "https://music.youtube.com/"
      },
      body: JSON.stringify(payload)
    });
    if (res.ok) {
      return await res.json();
    }
  } catch (e) {
    console.error("YTM API Error:", e);
  }
  return null;
}

async function searchYTM(query) {
  const data = await fetchYTM("search", { 
    query,
    params: "EgWKAQIIAWoMEA4QChADEAQQCRAF"
  });
  if (!data) return [];
  const tabs = data.contents?.tabbedSearchResultsRenderer?.tabs || [];
  const sectionList = tabs[0]?.tabRenderer?.content?.sectionListRenderer?.contents || [];
  const results = [];
  for (const s of sectionList) {
    const shelf = s.musicShelfRenderer || s.itemSectionRenderer;
    if (shelf) {
      for (const item of (shelf.contents || [])) {
        const r = item.musicResponsiveListItemRenderer;
        if (r) {
          const col0 = r.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer?.title?.runs || r.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs || [];
          const col1 = r.flexColumns?.[1]?.musicResponsiveListItemFlexColumnRenderer?.title?.runs || r.flexColumns?.[1]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs || [];
          const title = col0.map(x => x.text).join("");
          const subRuns = col1.map(x => x.text);
          const videoId = r.playlistItemData?.videoId || r.overlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer?.playNavigationEndpoint?.watchEndpoint?.videoId || r.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer?.title?.runs?.[0]?.navigationEndpoint?.watchEndpoint?.videoId;
          const thumb = r.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails?.[0]?.url;
          
          if (title && videoId && !results.some(res => res.youtube_id === videoId)) {
            const rawSubtitle = subRuns.join("");
            const parts = rawSubtitle.split(" • ").map(p => p.trim());
            const artistName = parts[0] || "Unknown Artist";
            const albumName = parts.length > 2 ? parts[1] : null;
            const durationStr = parts[parts.length - 1];
            let duration = 0;
            if (durationStr && durationStr.includes(':')) {
              const dparts = durationStr.split(':').map(Number);
              if (dparts.length === 2) duration = (dparts[0] * 60 + dparts[1]) * 1000;
              else if (dparts.length === 3) duration = (dparts[0] * 3600 + dparts[1] * 60 + dparts[2]) * 1000;
            }

            results.push({
              id: `ytm-${videoId}`,
              youtube_id: videoId,
              videoId: videoId,
              title: title,
              artist_name: artistName,
              album_name: albumName,
              artwork_url: optimizeThumbnailUrl(thumb || `https://i.ytimg.com/vi/${videoId}/0.jpg`),
              duration: duration,
              downloadUrl: [{ quality: '320kbps', link: `/api/music-api?endpoint=stream&id=${encodeURIComponent(videoId)}` }],
              source: "YTMusic"
            });
          }
        }
      }
    }
  }
  return results;
}

function extractArtistName(item, defaultFallback = 'Unknown Artist') {
  if (!item) return defaultFallback;
  if (item.artists && Array.isArray(item.artists) && item.artists.length > 0) {
    const names = item.artists.map(a => a.name || a.text || (typeof a === 'string' ? a : a.toString())).filter(Boolean);
    if (names.length > 0) {
      const joined = names.join(', ');
      if (joined !== 'YT Music Artist' && joined !== '[object Object]') return joined;
    }
  }
  if (item.author) {
    const authorName = item.author.name || item.author.text || (typeof item.author === 'string' ? item.author : item.author.toString());
    if (authorName && authorName !== 'YT Music Artist' && authorName !== '[object Object]') return authorName;
  }
  if (item.artists_name && typeof item.artists_name === 'string') {
    return item.artists_name;
  }
  if (item.subtitle) {
    if (Array.isArray(item.subtitle.runs)) {
      const runs = item.subtitle.runs
        .map(r => r.text || '')
        .filter(t => t && t.trim() !== '•' && !t.match(/^\d+:\d+$/) && !t.toLowerCase().includes('song') && !t.toLowerCase().includes('video') && !t.toLowerCase().includes('views') && !t.toLowerCase().includes('plays') && !t.toLowerCase().includes('subscribers'));
      if (runs.length > 0 && runs[0].trim() && runs[0].trim() !== 'YT Music Artist') return runs[0].trim();
    } else if (typeof item.subtitle === 'string') {
      const parts = item.subtitle.split('•').map(p => p.trim()).filter(Boolean);
      if (parts.length > 0 && parts[0] !== 'YT Music Artist') return parts[0];
    }
  }
  if (item.subtitles && Array.isArray(item.subtitles)) {
    const sub = item.subtitles.map(s => s.name || s.text || s.toString()).filter(Boolean);
    if (sub.length > 0 && sub[0] !== 'YT Music Artist') return sub[0];
  }
  if (item.short_byline_text) {
    const byline = item.short_byline_text.toString();
    if (byline && byline !== '[object Object]' && byline !== 'YT Music Artist') return byline;
  }
  return defaultFallback;
}

function extractVideoId(item) {
  if (!item) return null;
  const directId = item.id || item.videoId || item.video_id || item.youtube_id;
  if (directId && typeof directId === 'string' && !directId.startsWith('MPRE') && !directId.startsWith('UC') && !directId.startsWith('VL') && !directId.startsWith('RD') && !directId.startsWith('PL')) {
    return directId;
  }
  if (item.endpoint?.payload?.videoId) return item.endpoint.payload.videoId;
  if (item.navigation_endpoint?.watchEndpoint?.videoId) return item.navigation_endpoint.watchEndpoint.videoId;
  if (item.overlay?.content?.endpoint?.payload?.videoId) return item.overlay.content.endpoint.payload.videoId;
  if (item.on_tap?.payload?.videoId) return item.on_tap.payload.videoId;
  return null;
}

async function fetchWithTimeout(url, options = {}, timeout = 5000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(id);
    return response;
  } catch (e) {
    clearTimeout(id);
    throw e;
  }
}

function hasValidCover(track) {
  if (!track) return false;
  const url = track.artwork_url || track.image || track.thumbnail || track.cover;
  if (!url || typeof url !== 'string') return false;
  const trimmed = url.trim();
  return Boolean(trimmed && trimmed !== 'null' && trimmed !== 'undefined' && !trimmed.includes('placeholder'));
}

function hasValidArtist(track) {
  if (!track) return false;
  const artist = (track.artist_name || track.artist || track.author || '').trim();
  if (!artist) return false;
  const lower = artist.toLowerCase();
  return lower !== 'unknown artist' && lower !== 'unknown' && lower !== 'yt music artist' && lower !== '[object object]';
}

function getTrackQualityScore(track) {
  const cover = hasValidCover(track);
  const artist = hasValidArtist(track);
  if (cover && artist) return 0;
  if (cover || artist) return 1;
  return 2;
}

function sortTracksByQuality(trackList) {
  if (!Array.isArray(trackList)) return [];
  return [...trackList].sort((a, b) => getTrackQualityScore(a) - getTrackQualityScore(b));
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
  );

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { pathname } = new URL(req.url, `http://${req.headers.host}`);
  const pathParts = pathname.split('/').filter(Boolean);
  const endpointFromPath = pathParts[pathParts.length - 1];
  let { q, query, offset, limit, id, endpoint: endpointFromQuery } = req.query;
  let endpoint = (endpointFromQuery || endpointFromPath);
  if (endpoint && (endpoint.startsWith('stream/') || endpoint.startsWith('stream'))) {
    if (endpoint.includes('/')) {
      const parts = endpoint.split('/');
      id = id || parts[1];
      endpoint = parts[0];
    }
  }

  try {
    if (endpoint === 'proxy-image') {
      const imageUrl = req.query.url;
      if (!imageUrl) return res.status(400).json({ error: 'Missing url' });
      try {
        const imageRes = await fetch(imageUrl);
        if (!imageRes.ok) throw new Error(`Failed to fetch: ${imageRes.statusText}`);
        const contentType = imageRes.headers.get('content-type') || 'image/jpeg';
        res.setHeader('Content-Type', contentType);
        res.setHeader('Cache-Control', 'public, max-age=86400');
        const arrayBuffer = await imageRes.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        return res.status(200).send(buffer);
      } catch (e) {
        return res.status(500).json({ error: 'Proxy failed', message: e.message });
      }
    }

    if (endpoint === 'suggestions') {
      const searchQuery = q || query;
      if (!searchQuery) return res.status(400).json({ error: 'Missing query' });
      
      try {
        const yt = await getYoutube();
        const suggestions = await yt.music.getSearchSuggestions(searchQuery);
        
        return res.status(200).json({ 
            suggestions: (suggestions || []).map(s => ({
                name: s.toString(),
                type: 'Search'
            }))
        });
      } catch (e) {
        return res.status(200).json({ suggestions: [] });
      }
    }

    if (endpoint === 'search') {
      const searchQuery = q || query;
      if (!searchQuery) return res.status(400).json({ error: 'Missing query' });
      
      const [musicApiRes, ytmDirectResults, ytSearchData, argonRes, audiusRes] = await Promise.all([
        fetchWithTimeout(`${MUSIC_API_BASE}/prepare/${encodeURIComponent(searchQuery)}`)
            .then(r => r.ok ? r.json() : null)
            .then(async data => {
                if (data && data.ID) {
                    const songData = await fetchWithTimeout(`${MUSIC_API_BASE}/fetch/${data.ID}`).then(r => r.ok ? r.json() : null);
                    return songData;
                }
                return null;
            })
            .catch(() => null),
        searchYTM(searchQuery).catch(() => []),
        getYoutube().then(async (yt) => {
            try {
                const searchPromise = yt.music.search(searchQuery);
                const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 6000));
                
                const [musicRes] = await Promise.allSettled([
                    Promise.race([searchPromise, timeoutPromise])
                ]);
                
                return {
                    music: musicRes.status === 'fulfilled' ? musicRes.value : null,
                    general: null
                };
            } catch (e) {
                return null;
            }
        }).catch(() => null),
        fetchWithTimeout(`https://argon.global.ssl.fastly.net/api/search?query=${encodeURIComponent(searchQuery)}&offset=${offset || 0}&limit=${limit || 25}`)
            .then(r => r.ok ? r.json() : { collection: [] })
            .catch(() => ({ collection: [] })),
        fetchWithTimeout(`https://discoveryprovider.audius.co/v1/tracks/search?query=${encodeURIComponent(searchQuery)}&app_name=PinpointAudio`, {}, 4000)
            .then(r => r.ok ? r.json() : null)
            .catch(() => null)
      ]);

      let tracks = [];
      if (Array.isArray(ytmDirectResults) && ytmDirectResults.length > 0) {
          tracks.push(...ytmDirectResults);
      }
      let ytSongs = [];
      let ytAlbums = [];
      let ytArtists = [];
      let ytPlaylists = [];

      const ytMusicRes = ytSearchData?.music;
      const ytGeneralRes = ytSearchData?.general;

      if (ytMusicRes && ytMusicRes.contents) {
          const shelves = ytMusicRes.contents || [];
          shelves.forEach(shelf => {
              const shelfTitle = shelf.title?.toString().toLowerCase() || shelf.header?.title?.toString().toLowerCase() || '';
              const items = shelf.contents || [];
              
              if (shelf.type === 'MusicCardShelf') {
                  const subtitle = shelf.subtitle?.toString().toLowerCase() || '';
                  const title = shelf.title?.toString() || '';
                  const rawId = extractVideoId(shelf);
                  if (subtitle.includes('song') || rawId) {
                      ytSongs.push({
                          id: rawId,
                          title: title,
                          artist_name: extractArtistName(shelf, shelf.header?.title?.toString()),
                          artwork_url: shelf.thumbnail?.contents?.[0]?.url,
                          duration: 0,
                          youtube_id: rawId,
                          source: 'YTMusic'
                      });
                  } else if (subtitle.includes('artist')) {
                      ytArtists.push({
                          id: shelf.id ? `ytm-${shelf.id}` : (shelf.endpoint?.payload?.browseId ? `ytm-${shelf.endpoint.payload.browseId}` : null),
                          name: title,
                          artwork_url: shelf.thumbnail?.contents?.[0]?.url
                      });
                  }
              }

              items.forEach(item => {
                  const itemType = item.item_type?.toLowerCase() || '';
                  let targetGroup = null;
                  if (itemType.includes('song') || shelfTitle.includes('song')) targetGroup = ytSongs;
                  else if (itemType.includes('album') || shelfTitle.includes('album')) targetGroup = ytAlbums;
                  else if (itemType.includes('artist') || shelfTitle.includes('artist')) targetGroup = ytArtists;
                  else if (itemType.includes('playlist') || shelfTitle.includes('playlist')) targetGroup = ytPlaylists;
                  else if (item.duration || extractVideoId(item)) targetGroup = ytSongs;
                  else if (item.song_count) targetGroup = ytPlaylists;
                  
                  if (targetGroup) {
                      targetGroup.push(item);
                  }
              });
          });
      }

      if (ytSongs.length > 0) {
          const ytTracks = ytSongs.map(item => {
              if (!item) return null;
              const title = item.title?.toString() || item.name?.toString() || item.title?.text || 'Unknown Title';
              const artist = extractArtistName(item);
              const artistId = item.artists?.[0]?.id || item.author?.id;
              const thumbnail = optimizeThumbnailUrl(item.thumbnails?.[0]?.url || item.thumbnail?.url || item.thumbnail?.contents?.[0]?.url || item.artwork_url);
              const duration = (item.duration?.seconds || 0) * 1000;
              const rawId = extractVideoId(item);
              const trackId = rawId ? `ytm-${rawId}` : `ytm-gen-${Math.random().toString(36).substr(2, 9)}`;

              if (artist === 'YT Music Artist') return null;

              return {
                  id: trackId,
                  title: title,
                  artist_name: artist,
                  artist_id: artistId ? `ytm-${artistId}` : null,
                  artwork_url: thumbnail,
                  duration: duration,
                  downloadUrl: rawId ? [{ quality: '320kbps', link: `/api/music-api?endpoint=stream&id=${encodeURIComponent(rawId)}` }] : [],
                  youtube_id: rawId,
                  source: 'YTMusic'
              };
          }).filter(Boolean);
          tracks.push(...ytTracks);
      }

      if (ytGeneralRes && (ytGeneralRes.results || ytGeneralRes.videos)) {
          const generalItems = ytGeneralRes.results || ytGeneralRes.videos || [];
          generalItems.forEach(item => {
              const rawId = item.id;
              if (!rawId || tracks.some(t => t.youtube_id === rawId)) return;
              
              let title = item.title?.toString() || 'Unknown Title';
              let artist = item.author?.name || 'Unknown Artist';
              
              if (title.includes(' - ')) {
                  const parts = title.split(' - ');
                  if (parts.length === 2) {
                      artist = parts[0].trim();
                      title = parts[1].replace(/\[.*?\]|\(.*?\)/g, '').trim();
                  }
              }

              tracks.push({
                  id: `ytm-${rawId}`,
                  title: title,
                  artist_name: artist,
                  artwork_url: optimizeThumbnailUrl(item.thumbnails?.[0]?.url || `https://i.ytimg.com/vi/${rawId}/hqdefault.jpg`),
                  duration: (item.duration?.seconds || 0) * 1000,
                  downloadUrl: [{ quality: '320kbps', link: `/api/music-api?endpoint=stream&id=${encodeURIComponent(rawId)}` }],
                  youtube_id: rawId,
                  source: 'YTMusic'
              });
          });
      }

      if (argonRes.collection && Array.isArray(argonRes.collection)) {
          const ARGON_BASE = 'https://argon.global.ssl.fastly.net';
          const argonTracks = argonRes.collection.map(item => {
              let artwork = item.song?.img?.big || item.song?.img?.small || (Array.isArray(item.image) ? item.image[item.image.length-1].link : item.image);
              if (artwork && artwork.startsWith('/api/')) artwork = ARGON_BASE + artwork;
              const songUrl = item.song?.url || item.url || '';
              const encodedId = Buffer.from(songUrl).toString('base64url');
              const durationSecs = (item.song?.duration?.hours || 0) * 3600 + (item.song?.duration?.minutes || 0) * 60 + (item.song?.duration?.seconds || 0);

              const artist = item.author?.name || 'Argon Artist';
              if (artist === 'YT Music Artist') return null;

              return {
                  id: `argon-${encodedId}`,
                  title: item.song?.name || item.name,
                  artist_name: artist,
                  artist_id: item.author?.id ? `argon-${item.author.id}` : null,
                  artwork_url: optimizeThumbnailUrl(artwork),
                  duration: durationSecs * 1000,
                  url: songUrl,
                  source: 'Argon'
              };
          }).filter(Boolean);
          tracks.push(...argonTracks);
      }

      if (audiusRes && audiusRes.data && Array.isArray(audiusRes.data)) {
          const audiusTracks = audiusRes.data.map(item => {
              if (!item || !item.id) return null;
              const title = item.title || 'Unknown Title';
              const artist = item.user?.name || 'Unknown Artist';
              const artwork = item.artwork?.['480x480'] || item.artwork?.['150x150'] || '';
              const duration = (item.duration || 0) * 1000;
              const streamUrl = `https://discoveryprovider.audius.co/v1/tracks/${item.id}/stream?app_name=PinpointAudio`;
              return {
                  id: `audius-${item.id}`,
                  title: title,
                  artist_name: artist,
                  artwork_url: artwork,
                  duration: duration,
                  downloadUrl: [{ quality: '320kbps', link: `/api/gateway?url=${encodeURIComponent(streamUrl)}` }],
                  source: 'Audius'
              };
          }).filter(Boolean);
          tracks.push(...audiusTracks);
      }

      const albums = ytAlbums.map(item => {
          const artist = item.author?.name || item.artists?.[0]?.name?.toString() || 'Unknown Artist';
          if (artist === 'YT Music Artist') return null;
          return {
              id: item.id ? `ytm-${item.id}` : null,
              name: item.title?.toString() || item.name?.toString(),
              artist_name: artist,
              artwork_url: optimizeThumbnailUrl(item.thumbnails?.[0]?.url || item.thumbnail?.url)
          };
      }).filter(a => a && a.id);

      const artists = ytArtists.map(item => ({
          id: item.id ? `ytm-${item.id}` : null,
          name: item.name?.toString() || item.title?.toString(),
          artwork_url: optimizeThumbnailUrl(item.thumbnails?.[0]?.url || item.thumbnail?.url || item.artwork_url)
      })).filter(a => a.id);

      const playlists = ytPlaylists.map(item => ({
          id: item.id ? `ytm-${item.id}` : null,
          name: item.title?.toString() || item.name?.toString(),
          artwork_url: optimizeThumbnailUrl(item.thumbnails?.[0]?.url || item.thumbnail?.url),
          song_count: item.song_count || 0
      })).filter(p => p.id);

      return res.status(200).json({
        tracks: sortTracksByQuality(tracks),
        albums,
        artists,
        playlists
      });
    }

    if (endpoint === 'artist-search' || endpoint === 'album-search') {
        return res.status(404).json({ error: 'Search category disabled' });
    }

    if (endpoint === 'album' || pathname.includes('/album/')) {
        const albumId = id || pathParts[pathParts.length - 1];
        try {
            const yt = await getYoutube();
            const album = await yt.music.getAlbum(albumId.replace('ytm-', ''));
            const tracks = (album.contents || []).map(item => {
                const title = item.title?.toString() || 'Unknown Title';
                const artist = item.artists?.[0]?.name?.toString() || album.header?.artist?.name?.toString() || 'Unknown Artist';
                const artistId = item.artists?.[0]?.id;
                const thumbnail = optimizeThumbnailUrl(item.thumbnails?.[0]?.url || album.header?.thumbnails?.[0]?.url);
                const duration = (item.duration?.seconds || 0) * 1000;
                const rawId = item.id || item.video_id;

                const downloadLink = rawId ? `/api/music-api?endpoint=stream&id=${encodeURIComponent(rawId)}&q=${encodeURIComponent(title + ' ' + artist)}` : null;

                return {
                    id: rawId ? `ytm-${rawId}` : `ytm-gen-${Math.random().toString(36).substr(2, 9)}`,
                    title: title,
                    artist_name: artist,
                    artist_id: artistId ? `ytm-${artistId}` : null,
                    artwork_url: thumbnail,
                    duration: duration,
                    downloadUrl: downloadLink ? [{ quality: '320kbps', link: downloadLink }] : [],
                    youtube_id: rawId,
                    source: 'YTMusic'
                };
            }).filter(Boolean);

            return res.status(200).json({
                id: `ytm-${albumId}`,
                name: album.header?.title?.toString() || 'Unknown Album',
                description: album.header?.description?.toString() || '',
                artwork_url: optimizeThumbnailUrl(album.header?.thumbnails?.[0]?.url || ''),
                song_count: tracks.length,
                tracks: tracks
            });
        } catch (e) {
            return res.status(500).json({ error: 'Failed to load album details', message: e.message });
        }
    }

    if (endpoint === 'artist' || pathname.includes('/artist/')) {
        const rawArtistId = id || req.query.query || req.query.name || q || pathParts[pathParts.length - 1] || '';
        const cleanArtistId = (rawArtistId || '').replace('ytm-', '');
        let artistName = req.query.name || '';
        let artistDescription = '';
        let artistArtwork = '';
        const allTracks = [];

        try {
            const yt = await getYoutube();
            
            if (cleanArtistId.startsWith('UC') || cleanArtistId.startsWith('FEmusic')) {
                try {
                    const artistData = await yt.music.getArtist(cleanArtistId);
                    if (artistData) {
                        artistName = artistData.name?.toString() || artistName;
                        artistDescription = artistData.description?.toString() || '';
                        artistArtwork = optimizeThumbnailUrl(artistData.thumbnails?.[0]?.url || '');
                        
                        const ytTracks = (artistData.songs?.contents || []).map(item => {
                            const rawId = extractVideoId(item);
                            const title = item.title?.toString() || item.name?.toString() || 'Unknown Title';
                            const author = extractArtistName(item, artistName);
                            if (author === 'YT Music Artist') return null;

                            return {
                                id: rawId ? `ytm-${rawId}` : `ytm-gen-${Math.random().toString(36).substr(2, 9)}`,
                                title: title,
                                artist_name: author,
                                artwork_url: optimizeThumbnailUrl(item.thumbnails?.[0]?.url || artistArtwork),
                                duration: (item.duration?.seconds || 0) * 1000,
                                downloadUrl: rawId ? [{ quality: '320kbps', link: `/api/music-api?endpoint=stream&id=${encodeURIComponent(rawId)}` }] : [],
                                youtube_id: rawId,
                                source: 'YTMusic'
                            };
                        }).filter(Boolean);
                        allTracks.push(...ytTracks);
                    }
                } catch (e) {}
            }

            if (!artistName) {
                artistName = decodeURIComponent(cleanArtistId);
            }

            const [ytSearchRes, argonRes, audiusRes] = await Promise.all([
                yt.music.search(artistName).catch(() => null),
                fetchWithTimeout(`https://argon.global.ssl.fastly.net/api/search?query=${encodeURIComponent(artistName)}&offset=0&limit=30`)
                    .then(r => r.ok ? r.json() : { collection: [] })
                    .catch(() => ({ collection: [] })),
                fetchWithTimeout(`https://discoveryprovider.audius.co/v1/tracks/search?query=${encodeURIComponent(artistName)}&app_name=PinpointAudio`, {}, 4000)
                    .then(r => r.ok ? r.json() : null)
                    .catch(() => null)
            ]);

            if (ytSearchRes && ytSearchRes.contents) {
                ytSearchRes.contents.forEach(shelf => {
                    const items = shelf.contents || [];
                    items.forEach(item => {
                        const rawId = extractVideoId(item);
                        const title = item.title?.toString() || item.name?.toString();
                        if (rawId && title) {
                            const author = extractArtistName(item, artistName);
                            if (author !== 'YT Music Artist') {
                                allTracks.push({
                                    id: `ytm-${rawId}`,
                                    title: title,
                                    artist_name: author,
                                    artwork_url: optimizeThumbnailUrl(item.thumbnails?.[0]?.url || item.thumbnail?.url || artistArtwork),
                                    duration: (item.duration?.seconds || 0) * 1000,
                                    downloadUrl: [{ quality: '320kbps', link: `/api/music-api?endpoint=stream&id=${encodeURIComponent(rawId)}` }],
                                    youtube_id: rawId,
                                    source: 'YTMusic'
                                });
                            }
                        }
                    });
                });
            }

            if (argonRes.collection && Array.isArray(argonRes.collection)) {
                const ARGON_BASE = 'https://argon.global.ssl.fastly.net';
                argonRes.collection.forEach(item => {
                    let artwork = item.song?.img?.big || item.song?.img?.small || (Array.isArray(item.image) ? item.image[item.image.length-1].link : item.image);
                    if (artwork && artwork.startsWith('/api/')) artwork = ARGON_BASE + artwork;
                    const songUrl = item.song?.url || item.url || '';
                    const encodedId = Buffer.from(songUrl).toString('base64url');
                    const durationSecs = (item.song?.duration?.hours || 0) * 3600 + (item.song?.duration?.minutes || 0) * 60 + (item.song?.duration?.seconds || 0);
                    const author = item.author?.name || artistName;

                    if (author !== 'YT Music Artist') {
                        allTracks.push({
                            id: `argon-${encodedId}`,
                            title: item.song?.name || item.name || 'Unknown Track',
                            artist_name: author,
                            artwork_url: optimizeThumbnailUrl(artwork || artistArtwork),
                            duration: durationSecs * 1000,
                            url: songUrl,
                            downloadUrl: [{ quality: '320kbps', link: `https://argon.global.ssl.fastly.net/api/download?track_url=${encodeURIComponent(songUrl)}` }],
                            source: 'Argon'
                        });
                    }
                });
            }

            if (audiusRes && audiusRes.data && Array.isArray(audiusRes.data)) {
                audiusRes.data.forEach(item => {
                    if (!item || !item.id) return;
                    const streamUrl = `https://discoveryprovider.audius.co/v1/tracks/${item.id}/stream?app_name=PinpointAudio`;
                    allTracks.push({
                        id: `audius-${item.id}`,
                        title: item.title || 'Unknown Track',
                        artist_name: item.user?.name || artistName,
                        artwork_url: item.artwork?.['480x480'] || item.artwork?.['150x150'] || artistArtwork,
                        duration: (item.duration || 0) * 1000,
                        downloadUrl: [{ quality: '320kbps', link: `/api/gateway?url=${encodeURIComponent(streamUrl)}` }],
                        source: 'Audius'
                    });
                });
            }

            const seen = new Set();
            const deduplicated = allTracks.filter(t => {
                const key = `${(t.title || '').toLowerCase().trim()}|${(t.artist_name || '').toLowerCase().trim()}`;
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            });

            if (!artistArtwork && deduplicated.length > 0) {
                artistArtwork = deduplicated[0].artwork_url;
            }

            return res.status(200).json({
                id: `ytm-${cleanArtistId}`,
                name: artistName,
                description: artistDescription,
                artwork_url: artistArtwork,
                tracks: deduplicated
            });
        } catch (e) {
            return res.status(500).json({ error: 'Failed to load artist details', message: e.message });
        }
    }

    if (endpoint === 'playlist' || pathname.includes('/playlist/')) {
        const playlistId = id || pathParts[pathParts.length - 1];
        try {
            const yt = await getYoutube();
            const playlist = await yt.music.getPlaylist(playlistId.replace('ytm-', ''));
            const tracks = (playlist.contents || []).map(item => {
                const title = item.title?.toString() || 'Unknown Title';
                const artist = item.artists?.[0]?.name?.toString() || 'Unknown Artist';
                const artistId = item.artists?.[0]?.id;
                const thumbnail = optimizeThumbnailUrl(item.thumbnails?.[0]?.url);
                const duration = (item.duration?.seconds || 0) * 1000;
                const rawId = item.id || item.video_id;

                if (artist === 'YT Music Artist') return null;

                const downloadLink = rawId ? `/api/music-api?endpoint=stream&id=${encodeURIComponent(rawId)}&q=${encodeURIComponent(title + ' ' + artist)}` : null;

                return {
                    id: rawId ? `ytm-${rawId}` : `ytm-gen-${Math.random().toString(36).substr(2, 9)}`,
                    title: title,
                    artist_name: artist,
                    artist_id: artistId ? `ytm-${artistId}` : null,
                    artwork_url: thumbnail,
                    duration: duration,
                    downloadUrl: downloadLink ? [{ quality: '320kbps', link: downloadLink }] : [],
                    youtube_id: rawId,
                    source: 'YTMusic'
                };
            }).filter(Boolean);

            return res.status(200).json({
                id: `ytm-${playlistId}`,
                name: playlist.header?.title?.toString() || 'Unknown Playlist',
                description: playlist.header?.description?.toString() || '',
                artwork_url: optimizeThumbnailUrl(playlist.header?.thumbnails?.[0]?.url || (tracks.length > 0 ? tracks[0].artwork_url : '')),
                song_count: tracks.length,
                tracks: tracks
            });
        } catch (e) {
            return res.status(500).json({ error: 'Failed to load playlist details', message: e.message });
        }
    }

    if (endpoint === 'lyrics' || pathname.includes('/lyrics/')) {
        const songId = id || pathParts[pathParts.length - 1];
        const { title, artist, duration } = req.query;
        
        if (songId.startsWith('mapi-')) {
            const mapiId = songId.replace('mapi-', '');
            const songData = await fetch(`${MUSIC_API_BASE}/fetch/${mapiId}`).then(r => r.ok ? r.json() : null);
            if (songData && songData.LYRICS) {
                return res.status(200).json({ lyrics: songData.LYRICS, source: 'MusicAPI' });
            }
        }

        if (title && artist) {
            try {
                let lrclibUrl = `https://lrclib.net/api/get?artist_name=${encodeURIComponent(artist)}&track_name=${encodeURIComponent(title)}`;
                if (duration && parseInt(duration) > 0) {
                    lrclibUrl += `&duration=${Math.round(parseInt(duration))}`;
                }
                const lrclibRes = await fetch(lrclibUrl);
                if (lrclibRes.ok) {
                    const lrclibData = await lrclibRes.json();
                    const lyrics = lrclibData.syncedLyrics || lrclibData.plainLyrics;
                    if (lyrics) {
                        return res.status(200).json({ lyrics, source: 'LrcLib' });
                    }
                }

                const lrclibSearchRes = await fetch(`https://lrclib.net/api/search?q=${encodeURIComponent(title + ' ' + artist)}`);
                if (lrclibSearchRes.ok) {
                    const searchResults = await lrclibSearchRes.json();
                    if (searchResults && searchResults.length > 0) {
                        const lyrics = searchResults[0].syncedLyrics || searchResults[0].plainLyrics;
                        if (lyrics) {
                            return res.status(200).json({ lyrics, source: 'LrcLib-Search' });
                        }
                    }
                }
            } catch (e) {
                console.error(e);
            }
        }

        if (songId && !songId.includes('f-') && !songId.startsWith('mapi-') && !songId.startsWith('argon-')) {
            try {
                const yt = await getYoutube();
                const lyrics = await yt.music.getLyrics(songId.replace('ytm-', ''));
                
                if (lyrics) {
                    if (lyrics.content && Array.isArray(lyrics.content.lines)) {
                        const lrcLines = lyrics.content.lines.map(line => {
                            const start = line.start_time_ms || 0;
                            const min = Math.floor(start / 60000);
                            const sec = ((start % 60000) / 1000).toFixed(2);
                            return `[${min.toString().padStart(2, '0')}:${sec.padStart(5, '0')}]${line.text}`;
                        });
                        return res.status(200).json({ lyrics: lrcLines.join('\n'), source: 'YTMusic-Timed' });
                    }

                    if (lyrics.description) {
                        return res.status(200).json({ lyrics: lyrics.description.toString(), source: 'YTMusic' });
                    }
                }
            } catch (e) {
                console.error(e);
            }
        }

        return res.status(200).json({ lyrics: null, error: 'Lyrics not found' });
    }

    if (endpoint === 'youtube-search') {
        const searchQuery = q || query;
        if (!searchQuery) return res.status(400).json({ error: 'Missing query' });
        
        try {
            const ytmResults = await searchYTM(searchQuery);
            if (ytmResults && ytmResults.length > 0) {
                return res.status(200).json({
                    videoId: ytmResults[0].videoId,
                    results: ytmResults
                });
            }
        } catch (e) {}

        try {
            const yt = await getYoutube();
            const searchResults = await yt.search(searchQuery, { type: 'video' });
            
            const results = (searchResults.results || searchResults.videos || []).map(item => ({
                videoId: item.id,
                id: item.id,
                title: item.title?.toString(),
                author: item.author?.name,
                thumbnails: item.thumbnails
            }));

            const firstVideoId = results.length > 0 ? results[0].videoId : null;

            if (firstVideoId) {
                return res.status(200).json({ 
                    videoId: firstVideoId,
                    results: results 
                });
            }
        } catch (e) {}

        try {
            const htmlRes = await fetch(`https://www.youtube.com/results?search_query=${encodeURIComponent(searchQuery)}`, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                    'Accept-Language': 'en-US,en;q=0.9'
                }
            });
            if (htmlRes.ok) {
                const html = await htmlRes.text();
                const matches = [...html.matchAll(/"videoId":"([a-zA-Z0-9_-]{11})"/g)];
                const videoIds = [...new Set(matches.map(m => m[1]))];
                if (videoIds.length > 0) {
                    return res.status(200).json({
                        videoId: videoIds[0],
                        results: videoIds.map(id => ({ videoId: id, id }))
                    });
                }
            }
        } catch (e) {}

        return res.status(200).json({ 
            videoId: null,
            results: [] 
        });
    }

    if (endpoint === 'popular' || endpoint === 'trending') {
        const fallbackPopular = [
            {
                id: "ytm-U-l4ya3Ejko",
                title: "FE!N",
                artist_name: "Travis Scott",
                artwork_url: "https://i.ytimg.com/vi/U-l4ya3Ejko/hqdefault.jpg",
                duration: 191000,
                downloadUrl: [{ quality: "320kbps", link: "/api/music-api?endpoint=stream&id=U-l4ya3Ejko" }],
                youtube_id: "U-l4ya3Ejko",
                source: "YTMusic"
            },
            {
                id: "ytm-NPqbm4qZg84",
                title: "Not Like Us",
                artist_name: "Kendrick Lamar",
                artwork_url: "https://i.ytimg.com/vi/NPqbm4qZg84/hqdefault.jpg",
                duration: 274000,
                downloadUrl: [{ quality: "320kbps", link: "/api/music-api?endpoint=stream&id=NPqbm4qZg84" }],
                youtube_id: "NPqbm4qZg84",
                source: "YTMusic"
            },
            {
                id: "ytm-vM0e_i336t8",
                title: "Timeless",
                artist_name: "The Weeknd & Playboi Carti",
                artwork_url: "https://i.ytimg.com/vi/vM0e_i336t8/hqdefault.jpg",
                duration: 256000,
                downloadUrl: [{ quality: "320kbps", link: "/api/music-api?endpoint=stream&id=vM0e_i336t8" }],
                youtube_id: "vM0e_i336t8",
                source: "YTMusic"
            },
            {
                id: "ytm-Dst9gZkq1a8",
                title: "goosebumps",
                artist_name: "Travis Scott",
                artwork_url: "https://i.ytimg.com/vi/Dst9gZkq1a8/hqdefault.jpg",
                duration: 243000,
                downloadUrl: [{ quality: "320kbps", link: "/api/music-api?endpoint=stream&id=Dst9gZkq1a8" }],
                youtube_id: "Dst9gZkq1a8",
                source: "YTMusic"
            },
            {
                id: "ytm-4NRXx6U8ABQ",
                title: "Blinding Lights",
                artist_name: "The Weeknd",
                artwork_url: "https://i.ytimg.com/vi/4NRXx6U8ABQ/hqdefault.jpg",
                duration: 200000,
                downloadUrl: [{ quality: "320kbps", link: "/api/music-api?endpoint=stream&id=4NRXx6U8ABQ" }],
                youtube_id: "4NRXx6U8ABQ",
                source: "YTMusic"
            },
            {
                id: "ytm-lY2yjAuuMGo",
                title: "God's Plan",
                artist_name: "Drake",
                artwork_url: "https://i.ytimg.com/vi/lY2yjAuuMGo/hqdefault.jpg",
                duration: 198000,
                downloadUrl: [{ quality: "320kbps", link: "/api/music-api?endpoint=stream&id=lY2yjAuuMGo" }],
                youtube_id: "lY2yjAuuMGo",
                source: "YTMusic"
            },
            {
                id: "ytm-gNi_6U5Pm_o",
                title: "Snooze",
                artist_name: "SZA",
                artwork_url: "https://i.ytimg.com/vi/gNi_6U5Pm_o/hqdefault.jpg",
                duration: 201000,
                downloadUrl: [{ quality: "320kbps", link: "/api/music-api?endpoint=stream&id=gNi_6U5Pm_o" }],
                youtube_id: "gNi_6U5Pm_o",
                source: "YTMusic"
            },
            {
                id: "ytm-wXhTHyIgQ_U",
                title: "Circles",
                artist_name: "Post Malone",
                artwork_url: "https://i.ytimg.com/vi/wXhTHyIgQ_U/hqdefault.jpg",
                duration: 215000,
                downloadUrl: [{ quality: "320kbps", link: "/api/music-api?endpoint=stream&id=wXhTHyIgQ_U" }],
                youtube_id: "wXhTHyIgQ_U",
                source: "YTMusic"
            },
            {
                id: "ytm-d5gf9dXbPi0",
                title: "BIRDS OF A FEATHER",
                artist_name: "Billie Eilish",
                artwork_url: "https://i.ytimg.com/vi/d5gf9dXbPi0/hqdefault.jpg",
                duration: 194000,
                downloadUrl: [{ quality: "320kbps", link: "/api/music-api?endpoint=stream&id=d5gf9dXbPi0" }],
                youtube_id: "d5gf9dXbPi0",
                source: "YTMusic"
            },
            {
                id: "ytm-eVli-tstM5E",
                title: "Espresso",
                artist_name: "Sabrina Carpenter",
                artwork_url: "https://i.ytimg.com/vi/eVli-tstM5E/hqdefault.jpg",
                duration: 175000,
                downloadUrl: [{ quality: "320kbps", link: "/api/music-api?endpoint=stream&id=eVli-tstM5E" }],
                youtube_id: "eVli-tstM5E",
                source: "YTMusic"
            },
            {
                id: "ytm-_6NSXa_bmdQ",
                title: "MILLION DOLLAR BABY",
                artist_name: "Tommy Richman",
                artwork_url: "https://i.ytimg.com/vi/_6NSXa_bmdQ/hqdefault.jpg",
                duration: 155000,
                downloadUrl: [{ quality: "320kbps", link: "/api/music-api?endpoint=stream&id=_6NSXa_bmdQ" }],
                youtube_id: "_6NSXa_bmdQ",
                source: "YTMusic"
            },
            {
                id: "ytm-N9bKBsCOSiU",
                title: "Like That",
                artist_name: "Future, Metro Boomin, Kendrick Lamar",
                artwork_url: "https://i.ytimg.com/vi/N9bKBsCOSiU/hqdefault.jpg",
                duration: 267000,
                downloadUrl: [{ quality: "320kbps", link: "/api/music-api?endpoint=stream&id=N9bKBsCOSiU" }],
                youtube_id: "N9bKBsCOSiU",
                source: "YTMusic"
            },
            {
                id: "ytm-ic8j13piAhQ",
                title: "Cruel Summer",
                artist_name: "Taylor Swift",
                artwork_url: "https://i.ytimg.com/vi/ic8j13piAhQ/hqdefault.jpg",
                duration: 178000,
                downloadUrl: [{ quality: "320kbps", link: "/api/music-api?endpoint=stream&id=ic8j13piAhQ" }],
                youtube_id: "ic8j13piAhQ",
                source: "YTMusic"
            },
            {
                id: "ytm-fJ9rUzIMcZQ",
                title: "Bohemian Rhapsody",
                artist_name: "Queen",
                artwork_url: "https://i.ytimg.com/vi/fJ9rUzIMcZQ/hqdefault.jpg",
                duration: 354000,
                downloadUrl: [{ quality: "320kbps", link: "/api/music-api?endpoint=stream&id=fJ9rUzIMcZQ" }],
                youtube_id: "fJ9rUzIMcZQ",
                source: "YTMusic"
            }
        ];

        try {
            const yt = await getYoutube();
            const searchPromise = yt.music.search('top hits popular music');
            const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 5000));

            const [musicRes] = await Promise.allSettled([
                Promise.race([searchPromise, timeoutPromise])
            ]);

            const dynamicTracks = [];
            const ytMusicRes = musicRes.status === 'fulfilled' ? musicRes.value : null;
            const ytGeneralRes = null;

            if (ytMusicRes && ytMusicRes.contents) {
                const shelves = ytMusicRes.contents || [];
                shelves.forEach(shelf => {
                    const items = shelf.contents || [];
                    items.forEach(item => {
                        const rawId = extractVideoId(item);
                        const title = item.title?.toString() || item.name?.toString() || item.title?.text;
                        const artist = extractArtistName(item);
                        if (rawId && title && artist && artist !== 'YT Music Artist') {
                            dynamicTracks.push({
                                id: `ytm-${rawId}`,
                                title: title,
                                artist_name: artist,
                                artwork_url: optimizeThumbnailUrl(item.thumbnails?.[0]?.url || item.thumbnail?.url || item.artwork_url),
                                duration: (item.duration?.seconds || 0) * 1000,
                                downloadUrl: [{ quality: "320kbps", link: `/api/music-api?endpoint=stream&id=${encodeURIComponent(rawId)}` }],
                                youtube_id: rawId,
                                source: "YTMusic"
                            });
                        }
                    });
                });
            }

            if (ytGeneralRes && (ytGeneralRes.results || ytGeneralRes.videos)) {
                const generalItems = ytGeneralRes.results || ytGeneralRes.videos || [];
                generalItems.forEach(item => {
                    const rawId = item.id;
                    if (!rawId || dynamicTracks.some(t => t.youtube_id === rawId)) return;
                    let title = item.title?.toString() || '';
                    let artist = item.author?.name || 'Unknown Artist';
                    if (title.includes(' - ')) {
                        const parts = title.split(' - ');
                        if (parts.length === 2) {
                            artist = parts[0].trim();
                            title = parts[1].replace(/\[.*?\]|\(.*?\)/g, '').trim();
                        }
                    }
                    if (title && artist) {
                        dynamicTracks.push({
                            id: `ytm-${rawId}`,
                            title: title,
                            artist_name: artist,
                            artwork_url: optimizeThumbnailUrl(item.thumbnails?.[0]?.url || `https://i.ytimg.com/vi/${rawId}/hqdefault.jpg`),
                            duration: (item.duration?.seconds || 0) * 1000,
                            downloadUrl: [{ quality: "320kbps", link: `/api/music-api?endpoint=stream&id=${encodeURIComponent(rawId)}` }],
                            youtube_id: rawId,
                            source: "YTMusic"
                        });
                    }
                });
            }

            const sorted = sortTracksByQuality(dynamicTracks).filter(t => hasValidCover(t) && hasValidArtist(t));
            const seen = new Set();
            const unique = sorted.filter(t => {
                const k = `${t.title.toLowerCase().trim()}|${t.artist_name.toLowerCase().trim()}`;
                if (seen.has(k)) return false;
                seen.add(k);
                return true;
            });

            if (unique.length >= 14) {
                return res.status(200).json({ tracks: unique.slice(0, 14) });
            }
            if (unique.length > 0) {
                const combined = [...unique];
                fallbackPopular.forEach(fb => {
                    if (combined.length < 14 && !combined.some(c => c.title.toLowerCase() === fb.title.toLowerCase())) {
                        combined.push(fb);
                    }
                });
                return res.status(200).json({ tracks: combined.slice(0, 14) });
            }
        } catch (e) {}

        return res.status(200).json({ tracks: fallbackPopular });
    }

    if (endpoint === 'cobalt') {
        const targetUrl = req.query.url || req.query.id || (req.body && (req.body.url || req.body.id));
        if (!targetUrl) return res.status(400).json({ error: 'Missing url or id parameter' });
        
        const mediaResult = await extractCobaltMedia(targetUrl);
        if (mediaResult && mediaResult.status === 'success') {
            return res.status(200).json(mediaResult);
        }
        return res.status(404).json({ error: 'Media URL or ID could not be resolved via Cobalt' });
    }

    if (endpoint === 'stream') {
        const targetId = id || req.query.id || req.query.url;
        if (!targetId) return res.status(400).json({ error: 'Missing stream id or url' });

        const videoIdMatch = String(targetId).match(/(?:v=|\/embed\/|\/v\/|youtu\.be\/|\/shorts\/|^)([a-zA-Z0-9_-]{11})/);
        const videoId = /^[a-zA-Z0-9_-]{11}$/.test(targetId) ? targetId : (videoIdMatch?.[1] ?? null);
        if (!videoId) return res.status(400).json({ error: 'Could not parse video ID' });

        const INVIDIOUS_INSTANCES = [
            'https://echostreamz.com',
            'https://invidious.schenkel.eti.br',
            'https://yt.omada.cafe'
        ];

        for (const instance of INVIDIOUS_INSTANCES) {
            try {
                const invRes = await fetch(
                    `${instance}/api/v1/videos/${videoId}?fields=adaptiveFormats,lengthSeconds`,
                    { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(7000) }
                );
                if (!invRes.ok) continue;

                const data = await invRes.json();
                const audioFormats = (data.adaptiveFormats || [])
                    .filter(f => f.type && f.type.startsWith('audio'));

                if (!audioFormats.length) continue;

                audioFormats.sort((a, b) => parseInt(b.bitrate || 0) - parseInt(a.bitrate || 0));
                const best = audioFormats[0];

                const rawUrl = new URL(best.url);
                const proxied = new URL(`${instance}/videoplayback`);
                rawUrl.searchParams.forEach((v, k) => proxied.searchParams.set(k, v));
                proxied.searchParams.set('host', rawUrl.hostname);

                const upstreamHeaders = {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                    'Accept': '*/*',
                    'Accept-Encoding': 'identity'
                };
                if (req.headers.range) {
                    upstreamHeaders['Range'] = req.headers.range;
                }

                const streamRes = await fetch(proxied.toString(), {
                    method: req.method || 'GET',
                    headers: upstreamHeaders,
                    signal: AbortSignal.timeout(12000)
                });

                if (!streamRes.ok && streamRes.status !== 206) {
                    continue;
                }

                const contentType = streamRes.headers.get('content-type') || 'audio/webm';
                res.setHeader('Content-Type', contentType);
                res.setHeader('Accept-Ranges', 'bytes');
                res.setHeader('Cache-Control', 'public, max-age=604800, immutable');

                const contentRange = streamRes.headers.get('content-range');
                if (contentRange) res.setHeader('Content-Range', contentRange);
                const contentLength = streamRes.headers.get('content-length');
                if (contentLength) res.setHeader('Content-Length', contentLength);

                res.status(streamRes.status);
                if (streamRes.body) {
                    const { pipeline } = await import('stream/promises');
                    const { Readable } = await import('stream');
                    const stream = Readable.fromWeb(streamRes.body);
                    try {
                        await pipeline(stream, res);
                    } catch (pipeErr) {
                        if (pipeErr.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
                            console.warn('Stream closed:', pipeErr.message);
                        }
                    }
                    return;
                }
                return res.end();
            } catch (_) {
                continue;
            }
        }

        const pipedApis = [
            `https://pipedapi.drgns.space/streams/${videoId}`,
            `https://pipedapi.kavin.rocks/streams/${videoId}`
        ];
        for (const apiUrl of pipedApis) {
            try {
                const apiRes = await fetch(apiUrl, {
                    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
                    signal: AbortSignal.timeout(5000)
                });
                if (apiRes.ok) {
                    const data = await apiRes.json();
                    const audioUrl = (data.audioStreams && data.audioStreams[0]?.url) ||
                                     (data.adaptiveFormats && data.adaptiveFormats.find(f => f.type?.includes('audio'))?.url);
                    if (audioUrl) {
                        const upstreamHeaders = {
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                            'Accept': '*/*',
                            'Accept-Encoding': 'identity'
                        };
                        if (req.headers.range) upstreamHeaders['Range'] = req.headers.range;

                        const audioRes = await fetch(audioUrl, {
                            method: req.method || 'GET',
                            headers: upstreamHeaders,
                            signal: AbortSignal.timeout(10000)
                        });

                        if (audioRes.ok || audioRes.status === 206) {
                            res.setHeader('Content-Type', audioRes.headers.get('content-type') || 'audio/mp4');
                            res.setHeader('Accept-Ranges', 'bytes');
                            res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
                            if (audioRes.headers.get('content-range')) res.setHeader('Content-Range', audioRes.headers.get('content-range'));
                            if (audioRes.headers.get('content-length')) res.setHeader('Content-Length', audioRes.headers.get('content-length'));

                            res.status(audioRes.status);
                            if (audioRes.body) {
                                const { pipeline } = await import('stream/promises');
                                const { Readable } = await import('stream');
                                const stream = Readable.fromWeb(audioRes.body);
                                try {
                                    await pipeline(stream, res);
                                } catch (pipeErr) {
                                    if (pipeErr.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
                                        console.warn('Stream closed:', pipeErr.message);
                                    }
                                }
                                return;
                            }
                            return res.end();
                        }
                    }
                }
            } catch (_) {}
        }

        return res.status(404).json({ error: 'Audio stream could not be resolved by any instance' });
    }

    return res.status(404).json({ error: 'Endpoint not found' });

  } catch (error) {
    return res.status(500).json({ 
        error: 'Critical API Failure', 
        message: error.message
    });
  }
}
