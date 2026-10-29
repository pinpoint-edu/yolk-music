const WORKER_BASE = process.env.CF_WORKER_URL || 'https://yolk-yt-proxy.yolkmusic.workers.dev';

async function extractCobaltMedia(urlOrId) {
  let str = String(urlOrId || '').trim();
  if (str.includes('ytm-gen-')) str = str.replace('ytm-gen-', '');
  if (str.includes('ytm-')) str = str.replace('ytm-', '');

  let videoId = null;
  if (/^[a-zA-Z0-9_-]{11}$/.test(str)) {
    videoId = str;
  } else {
    const match = str.match(/(?:v=|\/embed\/|\/v\/|youtu\.be\/|\/shorts\/|^)([a-zA-Z0-9_-]{11})/);
    if (match) videoId = match[1];
  }

  if (videoId) {
    try {
      const res = await fetch(`${WORKER_BASE}?id=${videoId}&mode=url`, {
        headers: { 'Accept': 'application/json' }
      });

      if (res.ok) {
        const data = await res.json();
        if (data?.status === 'success' && data?.url) {
          return {
            status: 'success',
            service: 'youtube',
            id: videoId,
            url: data.url,
            userAgent: data.userAgent,
            mimeType: data.mimeType || 'audio/mp4',
            title: data.title || '',
            artist: data.artist || '',
            artwork: data.artwork || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
            source: `cloudflare-worker-${data.client || 'unknown'}`
          };
        }
      }
    } catch (e) {
      console.error('Worker fetch error:', e.message);
    }
  }

  return { status: 'error', error: 'Media URL or ID could not be resolved' };
}

export default extractCobaltMedia;
