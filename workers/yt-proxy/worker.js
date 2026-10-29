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
  const fetchTasks = [];

  // 1. InnerTube TVHTML5 (Very fast, unencrypted direct stream)
  fetchTasks.push((async () => {
    const res = await fetch('https://www.youtube.com/youtubei/v1/player', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (SmartTV; Linux) AppleWebKit/537.36'
      },
      body: JSON.stringify({
        videoId: videoId,
        context: { client: { clientName: 'TVHTML5', clientVersion: '7.20250101.00.00' } },
        playbackContext: { contentPlaybackContext: { html5Preference: 'HTML5_PREFER_FORMAT_22' } }
      })
    });
    if (!res.ok) throw new Error('TVHTML5 failed');
    const data = await res.json();
    const formats = data.streamingData?.adaptiveFormats || data.streamingData?.formats || [];
    const audioFormats = formats.filter(f => f.url && (f.mimeType?.includes('audio') || f.audioQuality));
    if (!audioFormats.length) throw new Error('No TVHTML5 audio');
    audioFormats.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
    return {
      url: audioFormats[0].url,
      mimeType: audioFormats[0].mimeType || 'audio/mp4',
      userAgent: 'Mozilla/5.0 (SmartTV; Linux) AppleWebKit/537.36',
      client: 'TVHTML5',
      title: data.videoDetails?.title || '',
      artist: data.videoDetails?.author || '',
      artwork: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`
    };
  })());

  // 2. Invidious Instances in parallel
  const invidiousInstances = [
    'https://inv.nadeko.net',
    'https://invidious.schenkel.eti.br',
    'https://echostreamz.com',
    'https://inv.tux.pizza'
  ];
  for (const inst of invidiousInstances) {
    fetchTasks.push((async () => {
      const res = await fetch(`${inst}/api/v1/videos/${videoId}?fields=adaptiveFormats,title,author`, {
        headers: { 'Accept': 'application/json' }
      });
      if (!res.ok) throw new Error('Invidious failed');
      const data = await res.json();
      const audioFormats = (data.adaptiveFormats || []).filter(f => f.type?.includes('audio') && f.url);
      if (!audioFormats.length) throw new Error('No audio');
      audioFormats.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
      return {
        url: audioFormats[0].url,
        mimeType: audioFormats[0].type || 'audio/mp4',
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        client: 'Invidious',
        title: data.title || '',
        artist: data.author || '',
        artwork: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`
      };
    })());
  }

  // 3. Piped API Instances in parallel
  const pipedInstances = [
    'https://pipedapi.kavin.rocks',
    'https://api.piped.privacydev.net'
  ];
  for (const p of pipedInstances) {
    fetchTasks.push((async () => {
      const res = await fetch(`${p}/streams/${videoId}`, { headers: { 'Accept': 'application/json' } });
      if (!res.ok) throw new Error('Piped failed');
      const data = await res.json();
      const audioStreams = (data.audioStreams || []).filter(s => s.url);
      if (!audioStreams.length) throw new Error('No audio');
      audioStreams.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
      return {
        url: audioStreams[0].url,
        mimeType: audioStreams[0].mimeType || 'audio/mp4',
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        client: 'Piped',
        title: data.title || '',
        artist: data.uploader || '',
        artwork: data.thumbnailUrl || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`
      };
    })());
  }

  try {
    return await Promise.any(fetchTasks);
  } catch (_) {
    return null;
  }
}
