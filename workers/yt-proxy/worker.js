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

    if (mode === 'stream') {
      return await handleStream(videoId, request, corsHeaders);
    }

    const info = await getVideoAudioCandidates(videoId);
    if (!info || !info.length) {
      return new Response(JSON.stringify({ error: 'Could not extract stream from YouTube' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    const best = info[0];
    return new Response(
      JSON.stringify({
        status: 'success',
        id: videoId,
        url: best.streamUrl,
        mimeType: best.mimeType,
        userAgent: best.userAgent,
        client: best.client,
        title: best.title,
        artist: best.artist,
        artwork: best.artwork,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
    );
  }
};

const INVIDIOUS_INSTANCES = [
  'https://echostreamz.com',
  'https://yt.chocolatemoo53.com',
  'https://invidious.schenkel.eti.br',
  'https://inv.nadeko.net',
  'https://inv.tux.pizza',
  'https://invidious.nerdvpn.de',
  'https://invidious.private.coffee'
];

async function getVideoAudioCandidates(videoId) {
  const fetchPromises = INVIDIOUS_INSTANCES.map(async (inst) => {
    try {
      const res = await fetch(`${inst}/api/v1/videos/${videoId}?fields=adaptiveFormats,title,author`, {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return null;
      const data = await res.json();
      const audioFormats = (data.adaptiveFormats || []).filter(f => f.type?.includes('audio') && f.url);
      if (!audioFormats.length) return null;
      audioFormats.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

      const rawUrl = audioFormats[0].url;
      let streamUrl = rawUrl;
      try {
        const u = new URL(rawUrl);
        if (u.hostname.includes('googlevideo.com')) {
          streamUrl = `${inst}${u.pathname}${u.search}`;
        }
      } catch (_) {}

      return {
        streamUrl,
        rawUrl,
        instance: inst,
        mimeType: audioFormats[0].type || 'audio/mp4',
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        client: 'InvidiousProxy',
        title: data.title || '',
        artist: data.author || '',
        artwork: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`
      };
    } catch (_) {
      return null;
    }
  });

  const results = await Promise.allSettled(fetchPromises);
  const candidates = results
    .filter(r => r.status === 'fulfilled' && r.value !== null)
    .map(r => r.value);

  return candidates;
}

async function handleStream(videoId, request, corsHeaders) {
  const range = request.headers.get('Range');
  const candidates = await getVideoAudioCandidates(videoId);

  if (!candidates.length) {
    return new Response(JSON.stringify({ error: 'No audio streams available' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }

  for (const candidate of candidates) {
    try {
      const upstreamHeaders = {
        'User-Agent': candidate.userAgent,
        'Accept': '*/*',
        'Accept-Encoding': 'identity',
      };
      if (range) upstreamHeaders['Range'] = range;

      const upstream = await fetch(candidate.streamUrl, {
        headers: upstreamHeaders,
        signal: AbortSignal.timeout(7000),
      });

      if (upstream.status === 200 || upstream.status === 206) {
        const responseHeaders = {
          'Content-Type': upstream.headers.get('content-type') ?? candidate.mimeType,
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'public, max-age=3600',
          ...corsHeaders,
        };
        const cr = upstream.headers.get('content-range');
        if (cr) responseHeaders['Content-Range'] = cr;
        const cl = upstream.headers.get('content-length');
        if (cl) responseHeaders['Content-Length'] = cl;

        return new Response(upstream.body, {
          status: upstream.status,
          headers: responseHeaders,
        });
      }
    } catch (_) {
      // Continue to next candidate on failure
    }
  }

  return new Response(JSON.stringify({ error: 'Stream playback failed on all instances' }), {
    status: 502,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}
