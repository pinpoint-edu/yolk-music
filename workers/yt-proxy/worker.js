export default {
  async fetch(request, env) {
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Range',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);
    const videoId = url.searchParams.get('id');
    const mode = url.searchParams.get('mode') ?? 'url';

    if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
      return new Response(JSON.stringify({ error: 'Invalid or missing video ID' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    const result = await getAudioUrl(videoId);

    if (!result) {
      return new Response(JSON.stringify({ error: 'Could not extract stream from YouTube' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    if (mode === 'stream') {
      const range = request.headers.get('Range');
      const upstreamHeaders = {
        'User-Agent': result.userAgent,
        'Accept': '*/*',
        'Accept-Encoding': 'identity',
      };
      if (range) upstreamHeaders['Range'] = range;

      const upstream = await fetch(result.url, { headers: upstreamHeaders });

      const responseHeaders = {
        'Content-Type': upstream.headers.get('content-type') ?? result.mimeType,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'public, max-age=3600',
        ...corsHeaders,
      };
      const cr = upstream.headers.get('content-range');
      if (cr) responseHeaders['Content-Range'] = cr;
      const cl = upstream.headers.get('content-length');
      if (cl) responseHeaders['Content-Length'] = cl;

      return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
    }

    return new Response(
      JSON.stringify({ status: 'success', id: videoId, ...result }),
      { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
    );
  }
};

async function getAudioUrl(videoId) {
  const clients = [
    {
      name: 'ANDROID',
      ua: 'com.google.android.youtube/19.29.37 (Linux; U; Android 14; en_US)',
      context: { client: { clientName: 'ANDROID', clientVersion: '19.29.37', androidSdkVersion: 34 } }
    },
    {
      name: 'IOS',
      ua: 'com.google.ios.youtube/19.29.1 (iPhone16,2; U; CPU iOS 17_5_1 like Mac OS X; en_US)',
      context: { client: { clientName: 'IOS', clientVersion: '19.29.1', deviceMake: 'Apple', deviceModel: 'iPhone16,2', osName: 'iOS', osVersion: '17.5.1.21F90' } }
    },
    {
      name: 'WEB_REMIX',
      ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      context: { client: { clientName: 'WEB_REMIX', clientVersion: '1.20241001.01.00' } }
    },
    {
      name: 'TVHTML5',
      ua: 'Mozilla/5.0 (SmartTV; Linux) AppleWebKit/537.36',
      context: { client: { clientName: 'TVHTML5', clientVersion: '7.20250101.00.00' } }
    }
  ];

  for (const c of clients) {
    try {
      const res = await fetch('https://www.youtube.com/youtubei/v1/player', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': c.ua,
        },
        body: JSON.stringify({
          videoId: videoId,
          context: c.context,
          playbackContext: { contentPlaybackContext: { html5Preference: 'HTML5_PREFER_FORMAT_22' } }
        })
      });
      if (!res.ok) continue;
      const data = await res.json();
      const formats = data.streamingData?.adaptiveFormats || data.streamingData?.formats || [];
      const audioFormats = formats.filter(f => f.url && (f.mimeType?.includes('audio') || f.audioQuality));
      if (!audioFormats.length) continue;
      audioFormats.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
      const best = audioFormats[0];
      if (best.url) {
        return {
          url: best.url,
          mimeType: best.mimeType || 'audio/mp4',
          userAgent: c.ua,
          client: c.name,
          title: data.videoDetails?.title || '',
          artist: data.videoDetails?.author || '',
          artwork: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`
        };
      }
    } catch (_) {}
  }

  // Fallback to Invidious adaptiveFormats if YouTube InnerTube direct URL is decipher-encrypted
  const invidiousInstances = ['https://echostreamz.com', 'https://inv.tux.pizza', 'https://invidious.schenkel.eti.br'];
  for (const inst of invidiousInstances) {
    try {
      const res = await fetch(`${inst}/api/v1/videos/${videoId}?fields=adaptiveFormats`, {
        headers: { 'Accept': 'application/json' }
      });
      if (!res.ok) continue;
      const data = await res.json();
      const audioFormats = (data.adaptiveFormats || []).filter(f => f.type?.includes('audio') && f.url);
      if (!audioFormats.length) continue;
      audioFormats.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
      const best = audioFormats[0];
      if (best.url) {
        return {
          url: best.url,
          mimeType: best.type || 'audio/mp4',
          userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
          client: 'Invidious',
          title: '',
          artist: '',
          artwork: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`
        };
      }
    } catch (_) {}
  }

  return null;
}
