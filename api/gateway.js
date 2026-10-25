import { Readable } from "stream";

function resolveAndRewriteUrl(urlStr, targetUrl) {
  if (!urlStr || typeof urlStr !== "string") return urlStr;
  const trimmed = urlStr.trim();
  if (
    trimmed.startsWith("data:") ||
    trimmed.startsWith("javascript:") ||
    trimmed.startsWith("mailto:") ||
    trimmed.startsWith("tel:") ||
    trimmed.startsWith("blob:") ||
    trimmed.startsWith("#") ||
    trimmed.startsWith("chrome-extension:") ||
    trimmed.startsWith("moz-extension:") ||
    trimmed.startsWith("about:") ||
    trimmed.startsWith("/g/") ||
    trimmed.startsWith("/api/gateway")
  ) {
    return urlStr;
  }
  try {
    const resolved = new URL(trimmed, targetUrl).href;
    return "/g/" + encodeURIComponent(resolved);
  } catch (e) {
    return urlStr;
  }
}

function rewriteHtmlContent(html, targetUrl) {
  if (!html || typeof html !== "string") return html;

  let modified = html.replace(/<meta\s+[^>]*http-equiv=["']?(content-security-policy|x-frame-options)["']?[^>]*>/gi, "");

  modified = modified.replace(/<(img|link|iframe|form|source|script|embed|audio|video|input)\b([^>]*?)>/gi, (match, tagName, attrs) => {
    const lowerTag = tagName.toLowerCase();
    if (lowerTag === 'link' && /rel=["']?(canonical|alternate|author|help|license|search)["']?/i.test(attrs)) {
      return match;
    }
    const updatedAttrs = attrs.replace(/\b(src|href|action|poster)\s*=\s*(["'])(.*?)\2/gi, (attrMatch, attrName, quote, urlVal) => {
      if (attrName.toLowerCase() === 'action') {
        return attrMatch;
      }
      const rewritten = resolveAndRewriteUrl(urlVal, targetUrl);
      return `${attrName}=${quote}${rewritten}${quote}`;
    });
    return `<${tagName}${updatedAttrs}>`;
  });

  modified = modified.replace(/throw\s+(?:new\s+Error|Error)\s*\(\s*[`"']Invalid href[\s\S]*?not valid in the href\.?[\s\S]*?\)/g, 'console.warn("Invalid href bypassed")');

  const shimScript = `<script>(function(){try{var _s=String.fromCharCode(115,101,99,117,114,108,121);if(document.referrer&&(document.referrer.indexOf(_s+'.com')!==-1||document.referrer.indexOf('deviceconsole')!==-1||document.referrer.indexOf(_s)!==-1)){window.location.replace("https://classroom.google.com");return;}}catch(e){}try{Object.defineProperty(window,'top',{get:function(){return window;},configurable:true});Object.defineProperty(window,'parent',{get:function(){return window;},configurable:true});}catch(e){}var origPush=History.prototype.pushState;var origReplace=History.prototype.replaceState;History.prototype.pushState=function(s,t,u){try{if(u&&typeof u==='string'){try{var r=new URL(u,window.location.href);if(r.origin!==window.location.origin){u='/g/'+encodeURIComponent(r.href);}}catch(e){}}return origPush.call(this,s,t,u);}catch(err){try{return origPush.call(this,s,t,undefined);}catch(e){}}};History.prototype.replaceState=function(s,t,u){try{if(u&&typeof u==='string'){try{var r=new URL(u,window.location.href);if(r.origin!==window.location.origin){u='/g/'+encodeURIComponent(r.href);}}catch(e){}}return origReplace.call(this,s,t,u);}catch(err){try{return origReplace.call(this,s,t,undefined);}catch(e){}}};window.addEventListener('error',function(e){if(e&&e.message&&(e.message.indexOf('Invalid href')!==-1||e.message.indexOf('418')!==-1||e.message.indexOf('423')!==-1||e.message.indexOf('SecurityError')!==-1)){e.stopImmediatePropagation();e.preventDefault();}},true);})();</script>`;
  if (modified.includes("<head>")) {
    modified = modified.replace("<head>", "<head>" + shimScript);
  } else if (modified.includes("<HEAD>")) {
    modified = modified.replace("<HEAD>", "<HEAD>" + shimScript);
  } else {
    modified = shimScript + modified;
  }

  return modified;
}

async function pipeStream(response, req, res) {
  if (response.body) {
    const { pipeline } = await import("stream/promises");
    const stream = Readable.fromWeb(response.body);
    try {
      await pipeline(stream, res);
    } catch (e) {
      if (e.code !== "ERR_STREAM_PREMATURE_CLOSE") {
        console.warn("Gateway stream closed:", e.message);
      }
    }
  } else {
    res.end();
  }
}

const WebPack = {
  name: "web",
  matches(contentType) {
    return contentType.includes("text/html") || contentType.includes("application/xhtml+xml");
  },
  async handle(response, req, res, targetUrl) {
    res.setHeader("Content-Type", response.headers.get("content-type") || "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=60");
    const rawHtml = await response.text();
    const processedHtml = rewriteHtmlContent(rawHtml, targetUrl);
    res.status(response.status).send(processedHtml);
  }
};

const JsPack = {
  name: "javascript",
  matches(contentType, url) {
    return contentType.includes("javascript") || contentType.includes("ecmascript") || url.match(/\.js($|\?)/i);
  },
  async handle(response, req, res) {
    res.setHeader("Content-Type", response.headers.get("content-type") || "application/javascript; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=86400");
    let text = await response.text();
    text = text.replace(/function\s+h\(\)\{var\s+([a-zA-Z0-9_$]+)=window\.location\.href,([a-zA-Z0-9_$]+)=([a-zA-Z0-9_$]+)\(\);return\s+\1\.substring\(\2\.length\)\}/g, 'function h(){var $1=window.location.href,$2=$3(),_p=$1.substring($2.length);if(_p.startsWith("/g/http")){try{var _u=new URL(_p.slice(3));return _u.pathname+_u.search+_u.hash;}catch(e){}}return _p}');
    text = text.replace(/function\s+m\(e\)\{var\s+t=e\.split\("\?"\);return\s+t\[0\]\.replace\(\/\\\\\/g,"\/"\)\.replace\(\/\\\/\\\/+\/g,"\/"\)\+\(t\[1\]\?"\?"\+t\.slice\(1\)\.join\("\?"\):""\)\}/g, 'function m(e){return e}');
    text = text.replace(/var\s+n,d="string"==typeof t\?t:\(0,([a-zA-Z0-9_$]+)\.formatWithValidation\)\(t\),/g, 'var n,d="string"==typeof t?t:(0,$1.formatWithValidation)(t);if(typeof d==="string"&&d.startsWith("/g/http"))d=d.slice(3);var ');
    text = text.replace(/console\.error\(\s*[`'"]Invalid href[\s\S]*?not valid in the href\.?[`'"]\s*\);?/g, '');
    text = text.replace(/var\s+[a-zA-Z0-9_$]+=\(0,[a-zA-Z0-9_$]+\.normalizeRepeatedSlashes\)\([a-zA-Z0-9_$]+\);/g, '');
    text = text.replace(/d=\([a-zA-Z0-9_$]+\?[a-zA-Z0-9_$]+\[0\]:""\)\+[a-zA-Z0-9_$]+/g, '');
    text = text.replace(/throw\s+(?:new\s+Error|Error)\s*\(\s*[`'"]Invalid href[\s\S]*?not valid in the href\.?[`'"]\s*\)/g, 'console.warn("Invalid href bypassed")');
    res.status(response.status).send(text);
  }
};

const AudioPack = {
  name: "audio",
  matches(contentType, url) {
    return contentType.includes("audio") || 
           contentType.includes("video/mp4") || 
           contentType.includes("application/ogg") ||
           contentType.includes("application/octet-stream") ||
           url.match(/\.(mp3|m4a|aac|ogg|wav|flac|opus|mp4)($|\?)/i) ||
           url.includes("saavncdn.com") ||
           url.includes("sndcdn.com") ||
           url.includes("soundcloud.com") ||
           url.includes("argon") ||
           url.includes("googlevideo.com") ||
           url.includes("bhindi1.ddns.net");
  },
  async handle(response, req, res) {
    const contentType = response.headers.get("content-type") || "audio/mp4";
    res.setHeader("Content-Type", contentType);
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Cache-Control", "public, max-age=604800, immutable");

    const contentRange = response.headers.get("content-range");
    if (contentRange) res.setHeader("Content-Range", contentRange);
    const lastModified = response.headers.get("last-modified");
    if (lastModified) res.setHeader("Last-Modified", lastModified);
    const etag = response.headers.get("etag");
    if (etag) res.setHeader("ETag", etag);

    res.status(response.status);
    await pipeStream(response, req, res);
  }
};

const VideoPack = {
  name: "video",
  matches(contentType, url) {
    return contentType.includes("video") || url.match(/\.(mp4|webm|mkv|mov|avi)($|\?)/i);
  },
  async handle(response, req, res) {
    const contentType = response.headers.get("content-type") || "video/mp4";
    res.setHeader("Content-Type", contentType);
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Cache-Control", "public, max-age=604800");

    const contentRange = response.headers.get("content-range");
    if (contentRange) res.setHeader("Content-Range", contentRange);
    const lastModified = response.headers.get("last-modified");
    if (lastModified) res.setHeader("Last-Modified", lastModified);
    const etag = response.headers.get("etag");
    if (etag) res.setHeader("ETag", etag);

    res.status(response.status);
    await pipeStream(response, req, res);
  }
};

const ImagesPack = {
  name: "images",
  matches(contentType, url) {
    return contentType.startsWith("image/") || url.match(/\.(jpg|jpeg|png|gif|webp|svg|ico|bmp)($|\?)/i);
  },
  async handle(response, req, res) {
    const contentType = response.headers.get("content-type") || "image/jpeg";
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "public, max-age=2592000, immutable");

    res.status(response.status);
    await pipeStream(response, req, res);
  }
};

const DefaultPack = {
  name: "default",
  async handle(response, req, res) {
    const contentType = response.headers.get("content-type") || "application/octet-stream";
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "public, max-age=86400");

    const contentRange = response.headers.get("content-range");
    if (contentRange) res.setHeader("Content-Range", contentRange);
    const acceptRanges = response.headers.get("accept-ranges");
    if (acceptRanges) res.setHeader("Accept-Ranges", acceptRanges);

    res.status(response.status);
    await pipeStream(response, req, res);
  }
};

const PROXY_PACKS = [WebPack, JsPack, AudioPack, VideoPack, ImagesPack];

function normalizeTargetUrl(urlStr) {
  if (!urlStr || typeof urlStr !== "string") return urlStr;
  let decoded = urlStr.trim();
  try {
    decoded = decodeURIComponent(decoded);
  } catch (e) {}
  decoded = decoded.replace(/^https?:\/+/i, (m) => m.toLowerCase().startsWith("http:") ? "http://" : "https://");
  if (!decoded.startsWith("http://") && !decoded.startsWith("https://")) {
    decoded = "https://" + decoded.replace(/^\/+/, "");
  }
  return decoded;
}

export default async function handler(req, res) {
  const clientReferer = (req.headers["referer"] || "").toLowerCase();
  if (clientReferer.includes("securly.com") || clientReferer.includes("deviceconsole") || clientReferer.includes("securly")) {
    return res.redirect(307, "https://classroom.google.com");
  }

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS, HEAD");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Expose-Headers", "*");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  const { url, pack: forcedPack, ...params } = req.query;

  if (!url) {
    return res.status(400).json({ error: "Missing url parameter" });
  }

  try {
    let decodedUrl = normalizeTargetUrl(url);

    const queryParams = new URLSearchParams(params).toString();
    if (queryParams) {
      decodedUrl += (decodedUrl.includes("?") ? "&" : "?") + queryParams;
    }

    if (
      decodedUrl.startsWith("chrome-extension://") ||
      decodedUrl.startsWith("moz-extension://") ||
      decodedUrl.startsWith("about:") ||
      decodedUrl.startsWith("data:") ||
      decodedUrl.startsWith("blob:")
    ) {
      return res.status(204).end();
    }

    decodedUrl = normalizeTargetUrl(decodedUrl);

    const targetParsed = new URL(decodedUrl);

    const headers = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      "Accept": "*/*",
      "Accept-Language": "en-US,en;q=0.9",
      "Accept-Encoding": "identity",
      "Referer": targetParsed.origin + "/"
    };

    if (req.headers.range) {
      headers["Range"] = req.headers.range;
    }

    const fetchOptions = {
      method: req.method || "GET",
      headers,
      redirect: "follow"
    };

    if (req.method !== "GET" && req.method !== "HEAD" && req.body) {
      fetchOptions.body = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
    }

    const response = await fetch(decodedUrl, fetchOptions);
    const finalUrl = response.url || decodedUrl;
    const contentType = response.headers.get("content-type") || "";

    res.removeHeader("X-Frame-Options");
    res.removeHeader("Content-Security-Policy");
    res.removeHeader("Content-Security-Policy-Report-Only");
    res.removeHeader("X-Content-Type-Options");
    res.removeHeader("Strict-Transport-Security");

    let activePack = null;
    if (forcedPack) {
      activePack = PROXY_PACKS.find(p => p.name === forcedPack);
    }
    if (!activePack) {
      activePack = PROXY_PACKS.find(p => p.matches(contentType, decodedUrl)) || DefaultPack;
    }

    await activePack.handle(response, req, res, finalUrl);
  } catch (error) {
    if (!res.headersSent) {
      res.status(502).json({ error: "Failed to connect to target domain", details: error.message });
    }
  }
}
