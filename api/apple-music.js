// Apple Music Public Playlist Scraper & YouTube Music Matcher
// Incorporates scraping logic from depau/applemusic-ytmusic-playlist-converter

export function isAppleMusicPlaylistUrl(url) {
  if (!url || typeof url !== 'string') return false;
  const str = url.trim();
  return (
    (str.includes('music.apple.com') && str.includes('/playlist/')) ||
    /^pl\.[a-zA-Z0-9_-]+$/.test(str)
  );
}

export function extractAppleMusicPlaylistId(url) {
  if (!url || typeof url !== 'string') return null;
  const str = url.trim();
  const plMatch = str.match(/pl\.[a-zA-Z0-9_-]+/);
  if (plMatch) return plMatch[0];
  return null;
}

export async function scrapeAppleMusicPlaylist(urlOrId) {
  let targetUrl = urlOrId.trim();
  if (targetUrl.startsWith('pl.')) {
    targetUrl = `https://music.apple.com/us/playlist/${encodeURIComponent(targetUrl)}`;
  } else if (!targetUrl.startsWith('http')) {
    targetUrl = `https://${targetUrl}`;
  }

  const res = await fetch(targetUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': 'https://music.apple.com/'
    }
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch Apple Music playlist (HTTP ${res.status})`);
  }

  const html = await res.text();
  const scriptMatch = html.match(/<script[^>]*id="serialized-server-data"[^>]*>([\s\S]*?)<\/script>/);
  if (!scriptMatch) {
    throw new Error('Could not find Apple Music playlist serialized data in page');
  }

  let parsed;
  try {
    parsed = JSON.parse(scriptMatch[1]);
  } catch (err) {
    throw new Error(`Failed to parse Apple Music JSON data: ${err.message}`);
  }

  const root = Array.isArray(parsed) ? parsed[0] : parsed;
  const d0 = root.data?.[0] || root.data;
  const sections = d0?.data?.sections || [];

  let name = 'Apple Music Playlist';
  let description = '';
  let artworkUrl = '';
  const rawSongs = [];

  for (const sec of sections) {
    for (const item of (sec.items || [])) {
      if (item.id && (item.id.includes('playlist-detail-header') || item.contentDescriptor?.kind === 'playlist')) {
        if (item.title) name = item.title;
        if (item.modalPresentationDescriptor?.paragraphText) {
          description = item.modalPresentationDescriptor.paragraphText.replace(/<[^>]+>/g, '').trim();
        }
        const rawArt = item.artwork?.dictionary?.url || item.tallArtwork?.dictionary?.url || '';
        if (rawArt) {
          artworkUrl = rawArt.replace('{w}x{h}bb.{f}', '600x600bb.jpg');
        }
      }

      if (item.artistName && item.title) {
        const art = item.artwork?.dictionary?.url ? item.artwork.dictionary.url.replace('{w}x{h}bb.{f}', '300x300bb.jpg') : '';
        const dur = item.duration || 0;
        rawSongs.push({
          title: item.title,
          artist: item.artistName,
          album: item.tertiaryLinks?.[0]?.title || '',
          duration: dur,
          artwork_url: art,
          apple_id: item.contentDescriptor?.identifiers?.storeAdamID || null
        });
      }
    }
  }

  if (rawSongs.length === 0) {
    // Secondary fallback: check subtitleLinks
    for (const sec of sections) {
      for (const item of (sec.items || [])) {
        const title = item.title;
        const artist = item.subtitleLinks?.[0]?.title || item.artistName;
        if (title && artist && !rawSongs.some(s => s.title === title && s.artist === artist)) {
          const art = item.artwork?.dictionary?.url ? item.artwork.dictionary.url.replace('{w}x{h}bb.{f}', '300x300bb.jpg') : '';
          rawSongs.push({
            title,
            artist,
            album: item.tertiaryLinks?.[0]?.title || '',
            duration: item.duration || 0,
            artwork_url: art,
            apple_id: item.contentDescriptor?.identifiers?.storeAdamID || null
          });
        }
      }
    }
  }

  return {
    name,
    description,
    artwork_url: artworkUrl || (rawSongs[0]?.artwork_url || ''),
    rawSongs
  };
}

export async function convertAppleMusicToYTM(applePlaylist, searchYTM) {
  const { name, description, artwork_url, rawSongs } = applePlaylist;
  if (!rawSongs || rawSongs.length === 0) {
    return {
      name,
      description,
      artwork_url,
      tracks: []
    };
  }

  // Concurrency-limited matching against YouTube Music (analogous to json2ytmusic.py)
  const concurrency = 6;
  const matchedTracks = new Array(rawSongs.length);

  async function matchSong(index) {
    const song = rawSongs[index];
    const cleanTitle = song.title.replace(/\(feat\..*?\)/i, '').trim();
    const query = `${cleanTitle} ${song.artist}`.trim();

    try {
      if (typeof searchYTM === 'function') {
        const results = await searchYTM(query);
        if (results && results.length > 0) {
          const best = results[0];
          const vid = best.youtube_id || best.videoId;
          matchedTracks[index] = {
            id: best.id || `ytm-${vid}`,
            title: song.title,
            artist_name: song.artist,
            album_name: song.album || best.album_name,
            artwork_url: song.artwork_url || best.artwork_url,
            duration: song.duration || best.duration,
            youtube_id: vid,
            downloadUrl: best.downloadUrl || [{ quality: '320kbps', link: `/api/music-api?endpoint=stream&id=${encodeURIComponent(vid)}` }],
            source: 'AppleMusic'
          };
          return;
        }
      }
    } catch (_) {}

    // Fallback: If not matched in batch, retain Apple Music metadata for on-the-fly resolution via getYoutubeId
    const tempId = `am-${song.apple_id || Math.random().toString(36).substr(2, 9)}`;
    matchedTracks[index] = {
      id: tempId,
      title: song.title,
      artist_name: song.artist,
      album_name: song.album,
      artwork_url: song.artwork_url,
      duration: song.duration,
      youtube_id: null,
      downloadUrl: [],
      source: 'AppleMusic'
    };
  }

  for (let i = 0; i < rawSongs.length; i += concurrency) {
    const chunk = [];
    for (let j = i; j < Math.min(i + concurrency, rawSongs.length); j++) {
      chunk.push(matchSong(j));
    }
    await Promise.all(chunk);
  }

  return {
    name,
    description,
    artwork_url: artwork_url || (matchedTracks[0]?.artwork_url || ''),
    tracks: matchedTracks.filter(Boolean)
  };
}
