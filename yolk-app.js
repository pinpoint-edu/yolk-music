// yolk-app.js - Modern minimalist music player with YouTube Music, playlist management, and synced lyrics

const API_BASE = '/api/music-api';

// State Management
let favorites = JSON.parse(localStorage.getItem('yolk_favorites') || '[]');
let playlists = JSON.parse(localStorage.getItem('yolk_playlists') || '[]').map(pl => {
    if (pl && (pl.description === '[object Object]' || pl.description === 'undefined')) {
        pl.description = '';
    }
    return pl;
});
let currentAudio = document.getElementById('yolk-audio-player') || new Audio();
currentAudio.preload = 'auto';
let preloadedNextAudio = new Audio();
preloadedNextAudio.preload = 'auto';
let preloadedNextTrackUid = null;
let activeSource = 'audio'; // 'audio' or 'youtube'
let ytPlayer = null;
let ytProgressInterval = null;
let isPlaying = false;
let currentTrack = null;
let currentQueue = [];
let currentQueueIndex = -1;
let currentPlaylistContextId = null; // null if from search, 'favorites', or playlist ID
let currentPlayingPlaylistContextId = null;

let searchOffset = 0;
let isLoadingMore = false;
let currentSearchQuery = '';
let parsedLyrics = [];
let currentLyricsTrackId = null;
let trackToAddPending = null;
let playlistToEditPending = null;
const artistPfpMap = new Map();

// Inject custom styles
const dynamicStyle = document.createElement('style');
dynamicStyle.innerHTML = `
    .bubbly-hover {
        transition: transform 0.2s cubic-bezier(0.175, 0.885, 0.32, 1.275) !important;
    }
    .bubbly-hover:hover {
        transform: scale(1.02) !important;
    }
    .bubbly-hover:active {
        transform: scale(0.97) !important;
    }
    
    .scroll-row-hover {
        transition: background-color 0.18s ease, border-color 0.18s ease, transform 0.18s cubic-bezier(0.16, 1, 0.3, 1), box-shadow 0.18s ease !important;
    }
    .scroll-row-hover:hover {
        transform: translateY(-1.5px) !important;
        box-shadow: 0 4px 14px rgba(0, 0, 0, 0.06) !important;
        border-color: rgba(0, 0, 0, 0.18) !important;
    }
    .scroll-row-hover:active {
        transform: scale(0.99) !important;
    }

    .song-row-card {
        background-color: #ffffff !important;
        border: 1px solid rgba(228, 228, 231, 0.9) !important;
        border-radius: 16px !important;
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.04), 0 1px 2px rgba(0, 0, 0, 0.02) !important;
        transition: transform 0.2s cubic-bezier(0.16, 1, 0.3, 1), box-shadow 0.2s ease, border-color 0.2s ease, background-color 0.2s ease !important;
    }
    .song-row-card:hover {
        background-color: #ffffff !important;
        border-color: rgba(200, 200, 205, 1) !important;
        transform: translateY(-2px) !important;
        box-shadow: 0 6px 20px rgba(0, 0, 0, 0.08) !important;
    }
    .song-row-card:active {
        transform: translateY(0) !important;
        box-shadow: 0 2px 6px rgba(0, 0, 0, 0.04) !important;
    }
    body.dark-mode .song-row-card {
        background-color: #16161a !important;
        border-color: rgba(63, 63, 70, 0.55) !important;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35) !important;
    }
    body.dark-mode .song-row-card:hover {
        background-color: #1c1c22 !important;
        border-color: rgba(82, 82, 91, 0.85) !important;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5) !important;
    }

    .hidden-force {
        opacity: 0 !important;
        pointer-events: none !important;
        transform: translate(-50%, 150%) !important;
    }
`;
document.head.appendChild(dynamicStyle);

function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function formatTime(seconds) {
    if (isNaN(seconds) || seconds < 0) return '0:00';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
}

// ==========================================
// iOS 18+ Safari Taptic Engine & Web Haptics
// ==========================================
let hapticsEnabled = localStorage.getItem('yolk_haptics') !== 'false';
let _lastHapticTs = 0;
let _hapticAudioCtx = null;

function playTactileAudioPulse(style = 'light') {
    try {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtx) return;
        if (!_hapticAudioCtx) {
            _hapticAudioCtx = new AudioCtx();
        }
        if (_hapticAudioCtx.state === 'suspended') {
            _hapticAudioCtx.resume().catch(() => {});
        }
        const now = _hapticAudioCtx.currentTime;

        // Low-frequency chassis-coupled tactile transient (58Hz–68Hz sub-bass micro-thump)
        const osc = _hapticAudioCtx.createOscillator();
        const gain = _hapticAudioCtx.createGain();
        osc.type = 'sine';

        const dur = style === 'heavy' ? 0.018 : (style === 'medium' ? 0.014 : 0.010);
        const peakGain = style === 'heavy' ? 0.24 : (style === 'medium' ? 0.17 : 0.11);
        const startFreq = style === 'heavy' ? 68 : (style === 'medium' ? 62 : 58);

        osc.frequency.setValueAtTime(startFreq, now);
        osc.frequency.exponentialRampToValueAtTime(36, now + dur);

        gain.gain.setValueAtTime(0.001, now);
        gain.gain.linearRampToValueAtTime(peakGain, now + 0.002);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + dur);

        osc.connect(gain);
        gain.connect(_hapticAudioCtx.destination);
        osc.start(now);
        osc.stop(now + dur + 0.002);
    } catch (_) {}
}

function triggerHaptic(style = 'light') {
    if (!hapticsEnabled) return;
    const now = performance.now();
    if (now - _lastHapticTs < 35) return;
    _lastHapticTs = now;

    try {
        // 1. iOS 18+ Safari Native Taptic Engine via in-viewport <input type="checkbox" switch> label click
        const iosSwitchLabel = document.getElementById('yolk-ios-haptic-label');
        if (iosSwitchLabel) {
            iosSwitchLabel.click();
        }
        // 2. Web Vibration API (Android / supported browsers)
        if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
            if (style === 'heavy') {
                navigator.vibrate([14, 28, 18]);
            } else if (style === 'medium') {
                navigator.vibrate(16);
            } else {
                navigator.vibrate(8);
            }
        }
        // 3. Tactile Web Audio sub-bass micro-pulse fallback for iOS standalone PWA & iOS < 18
        playTactileAudioPulse(style);
    } catch (_) {}
}
window.triggerHaptic = triggerHaptic;

// Fire haptic synchronously on pointerdown (inside WebKit's strict user-gesture activation window)
document.addEventListener('pointerdown', (e) => {
    if (!hapticsEnabled) return;
    const target = e.target;
    if (!target || typeof target.closest !== 'function') return;
    if (target.id === 'yolk-ios-haptic-input' || target.id === 'yolk-ios-haptic-label' || target.closest('#yolk-ios-haptic-label')) {
        return;
    }
    const interactive = target.closest('button, a[href^="#"], .song-row-card, .lyric-line, .bubbly-hover, .sleek-hover, [role="switch"], input[type="range"]');
    if (interactive) {
        triggerHaptic('light');
    }
}, { passive: true });

function getTrackUid(track) {
    if (!track) return '';
    return track.youtube_id || track.videoId || track.id || `${track.title || track.name}_${track.artist_name || track.artist}`;
}

// Artwork URL optimization & resolution
function getProxyUrl(url, size = null) {
    if (!url || typeof url !== 'string') return '';
    if (url.startsWith('data:')) return url;

    let resUrl = url;
    if (resUrl.includes('googleusercontent.com') || resUrl.includes('ggpht.com')) {
        const targetSize = (size === '50x50') ? 's80' : 'w1000-h1000-l90-rj';
        if (resUrl.includes('=')) {
            resUrl = resUrl.split('=')[0] + '=' + targetSize;
        } else {
            resUrl += '=' + targetSize;
        }
    }

    if (resUrl.includes('i.ytimg.com')) {
        resUrl = resUrl.replace(/\/(default|mqdefault|sddefault)\.jpg/gi, '/hqdefault.jpg');
    }

    if (resUrl.startsWith('//')) resUrl = 'https:' + resUrl;
    return resUrl;
}

// Download URL resolution based on YouTube video ID
function getDownloadUrl(item) {
    if (!item) return '';
    const rawYtId = item.youtube_id || item.videoId || (item.id && typeof item.id === 'string' && item.id.startsWith('ytm-') && !item.id.startsWith('ytm-gen-') ? item.id.replace('ytm-', '') : null);
    if (rawYtId && rawYtId.length === 11) {
        return `${API_BASE}?endpoint=stream&id=${encodeURIComponent(rawYtId)}&v=2`;
    }
    if (item.downloadUrl && Array.isArray(item.downloadUrl) && item.downloadUrl.length > 0) {
        const b = item.downloadUrl.find(d => d.quality === '320kbps') || item.downloadUrl[0];
        const link = b.link || b.url;
        if (link) return link;
    }
    return '';
}

// Synchronous fast-path extraction of YouTube video ID
function getYoutubeIdSync(track) {
    if (!track) return null;
    if (track.youtube_id || track.videoId || track.video_id) {
        return track.youtube_id || track.videoId || track.video_id;
    }
    if (track.id && typeof track.id === 'string') {
        if (track.id.startsWith('ytm-') && !track.id.startsWith('ytm-gen-')) {
            const rawId = track.id.replace('ytm-', '');
            track.youtube_id = rawId;
            track.videoId = rawId;
            return rawId;
        }
        if (/^[a-zA-Z0-9_-]{11}$/.test(track.id)) {
            track.youtube_id = track.id;
            track.videoId = track.id;
            return track.id;
        }
    }
    if (track.downloadUrl && Array.isArray(track.downloadUrl)) {
        for (const d of track.downloadUrl) {
            const link = d?.link || d?.url || '';
            const match = link.match(/[?&]id=([a-zA-Z0-9_-]{11})/);
            if (match) {
                track.youtube_id = match[1];
                track.videoId = match[1];
                return match[1];
            }
        }
    }
    if (track.url && typeof track.url === 'string') {
        const match = track.url.match(/(?:v=|\/embed\/|\/v\/|youtu\.be\/|\/shorts\/|^)([a-zA-Z0-9_-]{11})/);
        if (match) {
            track.youtube_id = match[1];
            track.videoId = match[1];
            return match[1];
        }
    }
    return null;
}

// YouTube search fallback
const pendingSearches = new Map();
async function getYoutubeId(track) {
    if (!track) return null;
    const syncId = getYoutubeIdSync(track);
    if (syncId) return syncId;

    const uid = getTrackUid(track);
    if (pendingSearches.has(uid)) return pendingSearches.get(uid);

    const promise = (async () => {
        try {
            const trackName = track.title || track.name || '';
            const artistName = track.artist_name || track.artist || '';
            const query = `${trackName} ${artistName}`.trim();
            const res = await fetch(`${API_BASE}?endpoint=youtube-search&q=${encodeURIComponent(query)}`);
            if (res.ok) {
                const data = await res.json();
                if (data && data.videoId) {
                    track.youtube_id = data.videoId;
                    track.videoId = data.videoId;
                    return data.videoId;
                }
            }
        } catch (e) {
            console.error('YouTube search fallback error:', e);
        } finally {
            pendingSearches.delete(uid);
        }
        return null;
    })();

    pendingSearches.set(uid, promise);
    return promise;
}

// Robust LRC Lyrics Parser with metadata filtering and section label support
function parseLyrics(lyricsText, duration) {
    if (!lyricsText || typeof lyricsText !== 'string') return [];
    const lines = lyricsText.split('\n');
    const parsed = [];
    const timeRegex = /\[(\d+):(\d+)(?:\.(\d+))?\]/;
    const metaRegex = /^\[(ar|al|ti|au|by|length|offset|re|ve|id):.*\]$/i;
    const sectionHeaderRegex = /^\[?(intro|verse\s*\d*|chorus\s*\d*|bridge\s*\d*|outro|hook\s*\d*|pre-chorus\s*\d*|solo|interlude)\]?:?$/i;

    let hasTimestamps = false;
    for (let rawLine of lines) {
        const line = rawLine.trim();
        if (!line) {
            parsed.push({ type: 'spacer' });
            continue;
        }

        // Filter out metadata lines
        if (metaRegex.test(line)) continue;

        const match = timeRegex.exec(line);
        if (match) {
            hasTimestamps = true;
            const minutes = parseInt(match[1]);
            const seconds = parseInt(match[2]);
            const ms = match[3] ? parseFloat('0.' + match[3]) : 0;
            const time = minutes * 60 + seconds + ms;
            const cleanText = line.replace(timeRegex, '').trim();

            if (!cleanText) continue;

            if (sectionHeaderRegex.test(cleanText)) {
                parsed.push({ type: 'section', text: cleanText.replace(/[\[\]]/g, '') });
                continue;
            }

            parsed.push({ time, text: cleanText, type: 'line' });
        } else {
            if (sectionHeaderRegex.test(line)) {
                parsed.push({ type: 'section', text: line.replace(/[\[\]]/g, '') });
            } else {
                parsed.push({ time: null, text: line, type: 'line' });
            }
        }
    }

    if (!hasTimestamps) {
        return parsed;
    }

    const finalParsed = [];
    const timedLines = parsed.filter(p => p.type === 'line' && p.time !== null);

    if (timedLines.length > 0 && timedLines[0].time >= 3.0) {
        finalParsed.push({
            time: 0,
            endTime: timedLines[0].time,
            type: 'dots',
            text: '...'
        });
    }

    for (let i = 0; i < parsed.length; i++) {
        const item = parsed[i];
        if (item.type !== 'line') {
            finalParsed.push(item);
            continue;
        }

        // Calculate end time
        let nextTimed = null;
        for (let j = i + 1; j < parsed.length; j++) {
            if (parsed[j].type === 'line' && parsed[j].time !== null) {
                nextTimed = parsed[j];
                break;
            }
        }

        if (nextTimed && nextTimed.time !== null) {
            item.endTime = nextTimed.time;
        } else if (duration) {
            item.endTime = duration;
        } else if (item.time !== null) {
            item.endTime = item.time + 4.5;
        }

        finalParsed.push(item);

        if (item.time !== null && nextTimed && nextTimed.time !== null) {
            const rawGap = nextTimed.time - item.time;
            if (rawGap >= 6.5) {
                finalParsed.push({
                    time: item.time + 3.0,
                    endTime: nextTimed.time,
                    type: 'dots',
                    text: '...'
                });
            }
        }
    }

    return finalParsed;
}

// Synced lyrics highlight & smooth scroll with Pinpoint-Edu 3-dots animation
function updateLyricsSync(currentTime, force = false) {
    // Only process lyrics when on Now Playing page or forced on navigation
    if (!force && document.body.getAttribute('data-page') !== 'now-playing') return;

    const container = document.getElementById('lyrics-container');
    if (!container || !parsedLyrics || parsedLyrics.length === 0) return;

    if (!container._scrollListenersAttached) {
        container._scrollListenersAttached = true;
        const markManualScroll = () => {
            container._userScrollUntil = Date.now() + 3500;
        };
        container.addEventListener('wheel', markManualScroll, { passive: true });
        container.addEventListener('touchmove', markManualScroll, { passive: true });
    }

    let adjustedTime = currentTime + 0.3;
    let activeIndex = -1;

    for (let i = 0; i < parsedLyrics.length; i++) {
        const item = parsedLyrics[i];
        if ((item.type === 'line' || item.type === 'dots') && item.time !== null && adjustedTime >= item.time && adjustedTime < (item.endTime || Infinity)) {
            activeIndex = i;
            break;
        }
    }

    // Fast-path: If active index hasn't changed, skip DOM work
    if (!force && container._lastActiveIndex === activeIndex) {
        return;
    }

    container._lastActiveIndex = activeIndex;

    const lineElements = container.querySelectorAll('.lyric-line');
    let activeLineEl = null;

    lineElements.forEach((el) => {
        const idx = parseInt(el.dataset.index);
        if (idx === activeIndex) {
            activeLineEl = el;
            el.classList.add('active');
            el.classList.remove('next-up');
        } else {
            el.classList.remove('active');
            if (idx === activeIndex + 1) {
                el.classList.add('next-up');
            } else {
                el.classList.remove('next-up');
            }
        }
    });

    if (activeLineEl && (force || !container._userScrollUntil || Date.now() > container._userScrollUntil)) {
        const targetScrollTop = activeLineEl.offsetTop - (container.clientHeight / 2) + (activeLineEl.offsetHeight / 2);
        container.scrollTo({
            top: Math.max(0, targetScrollTop),
            behavior: force ? 'auto' : 'smooth'
        });
    }
}

window.syncLyricsOnNavigate = function() {
    let curTime = 0;
    if (activeSource === 'youtube' && ytPlayer && typeof ytPlayer.getCurrentTime === 'function') {
        curTime = ytPlayer.getCurrentTime() || 0;
    } else if (currentAudio) {
        curTime = currentAudio.currentTime || 0;
    }
    updateLyricsSync(curTime, true);
};

window.seekToLyrics = function(time) {
    if (typeof time === 'number' && !isNaN(time)) {
        triggerHaptic('selection');
        const targetTime = Math.max(0, time);
        if (activeSource === 'youtube' && ytPlayer && typeof ytPlayer.seekTo === 'function') {
            ytPlayer.seekTo(targetTime, true);
            if (!isPlaying && typeof ytPlayer.playVideo === 'function') {
                ytPlayer.playVideo();
            }
        } else if (currentAudio) {
            currentAudio.currentTime = targetTime;
            if (!isPlaying) {
                currentAudio.play().then(() => {
                    isPlaying = true;
                    updatePlayPauseButtons();
                }).catch(() => {});
            }
        }
        updateLyricsSync(targetTime);
    }
};

// Storage Helpers
function savePlaylists() {
    localStorage.setItem('yolk_playlists', JSON.stringify(playlists));
    if (typeof updateLibraryButtons === 'function') {
        updateLibraryButtons();
    }
}

function saveFavorites() {
    localStorage.setItem('yolk_favorites', JSON.stringify(favorites));
}

function isFavorite(id) {
    return favorites.some(f => f.id === id);
}

let activeToastTimeout = null;
let activeToastEl = null;

function showToast(msg) {
    if (!msg) return;
    if (activeToastEl) {
        clearTimeout(activeToastTimeout);
        activeToastEl.remove();
        activeToastEl = null;
    }

    const toast = document.createElement('div');
    toast.className = 'yolk-toast';
    
    // Determine icon based on message content
    let iconSvg = '';
    const lower = msg.toLowerCase();
    if (lower.includes('imported') || lower.includes('saved') || lower.includes('added') || lower.includes('success')) {
        iconSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="shrink-0"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
    } else if (lower.includes('error') || lower.includes('fail') || lower.includes('unable') || lower.includes('restricted')) {
        iconSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#f87171" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="shrink-0"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>`;
    } else {
        iconSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#a1a1aa" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>`;
    }

    const isDark = document.body.classList.contains('dark-mode');
    toast.innerHTML = `
        ${iconSvg}
        <span class="text-xs font-bold tracking-tight select-none" style="color: ${isDark ? '#f4f4f5' : '#18181b'};">${escapeHtml(msg)}</span>
    `;

    toast.style.cssText = `
        position: fixed;
        top: 24px;
        left: 50%;
        transform: translate(-50%, -24px) scale(0.92);
        opacity: 0;
        background: ${isDark ? 'rgba(24, 24, 29, 0.92)' : 'rgba(255, 255, 255, 0.90)'};
        backdrop-filter: blur(20px);
        -webkit-backdrop-filter: blur(20px);
        color: ${isDark ? '#f4f4f5' : '#18181b'};
        padding: 9px 18px;
        border-radius: 9999px;
        border: 1px solid ${isDark ? 'rgba(63, 63, 70, 0.85)' : 'rgba(228, 228, 231, 0.85)'};
        box-shadow: ${isDark ? '0 14px 34px -4px rgba(0, 0, 0, 0.55)' : '0 14px 34px -4px rgba(0, 0, 0, 0.12), 0 4px 12px rgba(0, 0, 0, 0.04)'};
        z-index: 9999;
        pointer-events: none;
        display: flex;
        align-items: center;
        gap: 8px;
        max-width: calc(100vw - 32px);
        transition: transform 0.4s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.3s ease;
    `;

    document.body.appendChild(toast);
    activeToastEl = toast;

    // Trigger enter animation
    requestAnimationFrame(() => {
        toast.style.transform = 'translate(-50%, 0) scale(1)';
        toast.style.opacity = '1';
    });

    activeToastTimeout = setTimeout(() => {
        toast.style.transform = 'translate(-50%, -16px) scale(0.96)';
        toast.style.opacity = '0';
        setTimeout(() => {
            if (toast.parentNode) toast.remove();
            if (activeToastEl === toast) activeToastEl = null;
        }, 400);
    }, 2800);
}

// Browser audio codec capability negotiation (MP4 vs WebM)
function getSupportedAudioFormat() {
    const dummy = document.createElement('audio');
    const canMp4 = !!(dummy.canPlayType && dummy.canPlayType('audio/mp4; codecs="mp4a.40.2"').replace(/no/, ''));
    const canWebm = !!(dummy.canPlayType && dummy.canPlayType('audio/webm; codecs="opus"').replace(/no/, ''));

    // If browser has WebM but lacks MP4 AAC (e.g. Opera / Chromium on older Windows / Linux without proprietary codecs)
    if (!canMp4 && canWebm) return 'webm';
    // If browser supports MP4 (iOS Safari, modern Chrome, modern Edge)
    if (canMp4) return 'mp4';
    return canWebm ? 'webm' : 'auto';
}

// ==========================================
// Download Progress Manager (White Frosted Theme)
// ==========================================
let downloadProgressEl = null;
let downloadProgressDismissTimeout = null;

function updateDownloadProgressUI({ title, percent, receivedBytes, totalBytes, statusText, isDone, isError, errorMessage }) {
    const isNowPlaying = document.body.dataset.page === 'now-playing' || window.location.hash === '#now-playing';
    const bottomPos = isNowPlaying ? '20px' : '90px';
    const isDark = document.body.classList.contains('dark-mode');
    const textCol = isDark ? '#f4f4f5' : '#18181b';

    if (!downloadProgressEl) {
        downloadProgressEl = document.createElement('div');
        downloadProgressEl.id = 'yolk-download-progress';
        downloadProgressEl.style.cssText = `
            position: fixed;
            bottom: ${bottomPos};
            right: 20px;
            left: auto;
            z-index: 9999;
            background: ${isDark ? 'rgba(24, 24, 29, 0.94)' : 'rgba(255, 255, 255, 0.92)'};
            backdrop-filter: blur(20px);
            -webkit-backdrop-filter: blur(20px);
            border: 1px solid ${isDark ? 'rgba(63, 63, 70, 0.85)' : 'rgba(228, 228, 231, 0.9)'};
            border-radius: 9999px;
            padding: 8px 14px;
            box-shadow: ${isDark ? '0 12px 30px rgba(0, 0, 0, 0.5)' : '0 12px 30px rgba(0, 0, 0, 0.12), 0 2px 8px rgba(0, 0, 0, 0.04)'};
            max-width: calc(100vw - 32px);
            color: ${textCol};
            display: inline-flex;
            align-items: center;
            gap: 8px;
            font-size: 12px;
            font-weight: 600;
            transition: all 0.35s cubic-bezier(0.16, 1, 0.3, 1);
            transform: translateY(16px) scale(0.95);
            opacity: 0;
            pointer-events: auto;
        `;
        document.body.appendChild(downloadProgressEl);
        requestAnimationFrame(() => {
            if (downloadProgressEl) {
                downloadProgressEl.style.transform = 'translateY(0) scale(1)';
                downloadProgressEl.style.opacity = '1';
            }
        });
    } else {
        downloadProgressEl.style.bottom = bottomPos;
        downloadProgressEl.style.right = '20px';
        downloadProgressEl.style.left = 'auto';
        downloadProgressEl.style.background = isDark ? 'rgba(24, 24, 29, 0.94)' : 'rgba(255, 255, 255, 0.92)';
        downloadProgressEl.style.borderColor = isDark ? 'rgba(63, 63, 70, 0.85)' : 'rgba(228, 228, 231, 0.9)';
        downloadProgressEl.style.color = textCol;
    }

    if (downloadProgressDismissTimeout) {
        clearTimeout(downloadProgressDismissTimeout);
        downloadProgressDismissTimeout = null;
    }

    if (isError) {
        downloadProgressEl.innerHTML = `
            <svg style="width: 15px; height: 15px; color: #ef4444; flex-shrink: 0;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line>
            </svg>
            <span style="max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #dc2626; font-weight: 700;">${escapeHtml(errorMessage || 'Download failed')}</span>
        `;
        downloadProgressDismissTimeout = setTimeout(() => {
            dismissDownloadProgressUI();
        }, 3000);
        return;
    }

    if (isDone) {
        downloadProgressEl.innerHTML = `
            <svg style="width: 15px; height: 15px; color: #10b981; flex-shrink: 0;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline>
            </svg>
            <span style="max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: ${textCol};">${escapeHtml(title)}</span>
            <span style="font-size: 11px; font-weight: 700; color: #10b981; flex-shrink: 0;">✓ Saved</span>
        `;
        downloadProgressDismissTimeout = setTimeout(() => {
            dismissDownloadProgressUI();
        }, 2200);
        return;
    }

    const pct = typeof percent === 'number' ? Math.max(0, Math.min(100, Math.round(percent))) : null;
    const pctLabel = pct !== null ? `${pct}%` : '…';
    const barWidth = pct !== null ? `${pct}%` : '50%';

    downloadProgressEl.innerHTML = `
        <svg style="width: 14px; height: 14px; color: #38bdf8; flex-shrink: 0;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
            <polyline points="7 10 12 15 17 10"></polyline>
            <line x1="12" y1="15" x2="12" y2="3"></line>
        </svg>
        <span style="max-width: 130px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: ${textCol};">${escapeHtml(title)}</span>
        <div style="width: 36px; background: ${isDark ? 'rgba(255, 255, 255, 0.14)' : 'rgba(0, 0, 0, 0.08)'}; border-radius: 9999px; height: 4px; overflow: hidden; flex-shrink: 0;">
            <div style="background: linear-gradient(90deg, #0284c7, #38bdf8); height: 100%; border-radius: 9999px; width: ${barWidth}; transition: width 0.15s ease;"></div>
        </div>
        <span style="font-family: monospace; font-size: 11px; font-weight: 700; color: #38bdf8; flex-shrink: 0;">${pctLabel}</span>
    `;
}

function dismissDownloadProgressUI() {
    if (!downloadProgressEl) return;
    downloadProgressEl.style.transform = 'translateY(16px) scale(0.95)';
    downloadProgressEl.style.opacity = '0';
    setTimeout(() => {
        if (downloadProgressEl) {
            downloadProgressEl.remove();
            downloadProgressEl = null;
        }
    }, 300);
}

// ==========================================
// IndexedDB Offline Storage Manager
// Enables 100% offline playback on iOS & browsers as an installable PWA
// ==========================================
const YolkOfflineDB = {
    DB_NAME: 'yolk_offline_storage',
    DB_VERSION: 1,
    STORE_NAME: 'tracks',
    _db: null,

    async getDB() {
        if (this._db) return this._db;
        return new Promise((resolve, reject) => {
            if (!('indexedDB' in window)) {
                return reject(new Error('IndexedDB not supported in this browser.'));
            }
            const request = indexedDB.open(this.DB_NAME, this.DB_VERSION);
            request.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains(this.STORE_NAME)) {
                    db.createObjectStore(this.STORE_NAME, { keyPath: 'uid' });
                }
            };
            request.onsuccess = (e) => {
                this._db = e.target.result;
                resolve(this._db);
            };
            request.onerror = (e) => {
                reject(e.target.error);
            };
        });
    },

    async saveTrack(track, audioBlob, artworkBlob, lyrics = null) {
        const db = await this.getDB();
        const uid = getTrackUid(track);
        return new Promise((resolve, reject) => {
            const tx = db.transaction(this.STORE_NAME, 'readwrite');
            const store = tx.objectStore(this.STORE_NAME);
            const record = {
                uid: uid,
                id: track.id || uid,
                youtube_id: track.youtube_id || (track.id?.startsWith('ytm-') ? track.id.replace('ytm-', '') : null),
                title: track.title || track.name || 'Unknown Title',
                artist_name: track.artist_name || track.artist || 'Unknown Artist',
                artwork_url: track.artwork_url || track.image || '',
                duration: track.duration || 0,
                audioBlob: audioBlob,
                artworkBlob: artworkBlob || null,
                lyrics: lyrics || null,
                downloadedAt: Date.now(),
                size: audioBlob ? audioBlob.size : 0
            };
            const req = store.put(record);
            req.onsuccess = () => resolve(record);
            req.onerror = (e) => reject(e.target.error);
        });
    },

    async getTrack(uid) {
        if (!uid) return null;
        try {
            const db = await this.getDB();
            return new Promise((resolve) => {
                const tx = db.transaction(this.STORE_NAME, 'readonly');
                const store = tx.objectStore(this.STORE_NAME);
                const req = store.get(uid);
                req.onsuccess = () => resolve(req.result || null);
                req.onerror = () => resolve(null);
            });
        } catch (_) {
            return null;
        }
    },

    async getAllTracks() {
        try {
            const db = await this.getDB();
            return new Promise((resolve) => {
                const tx = db.transaction(this.STORE_NAME, 'readonly');
                const store = tx.objectStore(this.STORE_NAME);
                const req = store.getAll();
                req.onsuccess = () => resolve(req.result || []);
                req.onerror = () => resolve([]);
            });
        } catch (_) {
            return [];
        }
    },

    async deleteTrack(uid) {
        if (!uid) return;
        const db = await this.getDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(this.STORE_NAME, 'readwrite');
            const store = tx.objectStore(this.STORE_NAME);
            const req = store.delete(uid);
            req.onsuccess = () => resolve();
            req.onerror = (e) => reject(e.target.error);
        });
    },

    async isDownloaded(uid) {
        const item = await this.getTrack(uid);
        return !!(item && item.audioBlob);
    },

    async downloadTrack(track, options = {}) {
        if (!track) return;
        const uid = getTrackUid(track);
        if (await this.isDownloaded(uid)) {
            return;
        }

        const rawTitle = track.title || track.name || 'Track';
        const title = options.queueSuffix ? `${rawTitle} (${options.queueSuffix})` : rawTitle;
        updateDownloadProgressUI({
            title,
            percent: 0,
            receivedBytes: 0,
            totalBytes: 0,
            statusText: 'Connecting to stream…'
        });

        try {
            let videoId = getYoutubeIdSync(track);
            if (!videoId) {
                videoId = await getYoutubeId(track);
            }
            if (!videoId) {
                throw new Error('Could not resolve stream URL for track');
            }

            const prefFormat = getSupportedAudioFormat();
            const downloadUrl = `/api/music-api?endpoint=download&id=${encodeURIComponent(videoId)}&format=${prefFormat}&v=2`;

            // Fetch binary audio blob directly from server stream proxy
            const audioRes = await fetch(downloadUrl);
            if (!audioRes.ok) throw new Error(`Audio download failed: HTTP ${audioRes.status}`);

            const contentLength = +audioRes.headers.get('content-length') || 0;
            const contentType = audioRes.headers.get('content-type') || (prefFormat === 'webm' ? 'audio/webm' : 'audio/mp4');

            let receivedLength = 0;
            const chunks = [];

            if (audioRes.body && typeof audioRes.body.getReader === 'function') {
                const reader = audioRes.body.getReader();
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    chunks.push(value);
                    receivedLength += value.length;
                    const percent = contentLength > 0 ? (receivedLength / contentLength) * 100 : null;
                    updateDownloadProgressUI({
                        title,
                        percent,
                        receivedBytes: receivedLength,
                        totalBytes: contentLength,
                        statusText: 'Downloading stream…'
                    });
                }
            } else {
                const arrayBuf = await audioRes.arrayBuffer();
                chunks.push(new Uint8Array(arrayBuf));
                receivedLength = arrayBuf.byteLength;
            }

            const audioBlob = new Blob(chunks, { type: contentType });

            updateDownloadProgressUI({
                title,
                percent: 94,
                receivedBytes: receivedLength,
                totalBytes: contentLength,
                statusText: 'Caching artwork & lyrics…'
            });

            // Fetch artwork blob
            let artworkBlob = null;
            const artUrl = getProxyUrl(track.artwork_url || track.image);
            if (artUrl) {
                try {
                    const artRes = await fetch(artUrl);
                    if (artRes.ok) artworkBlob = await artRes.blob();
                } catch (_) {}
            }

            // Fetch lyrics so offline tracks have full synced/plain lyrics in Now Playing
            let lyricsText = null;
            try {
                const trackName = track.title || track.name || '';
                const artistName = track.artist_name || track.artist || '';
                const durSec = track.duration ? (track.duration > 1000 ? track.duration / 1000 : track.duration) : 0;
                const lyrUrl = `/api/music-api?endpoint=lyrics&id=${encodeURIComponent(videoId)}&title=${encodeURIComponent(trackName)}&artist=${encodeURIComponent(artistName)}&duration=${Math.round(durSec)}`;
                const lyrRes = await fetch(lyrUrl);
                if (lyrRes.ok) {
                    const lyrData = await lyrRes.json();
                    if (lyrData && lyrData.lyrics && lyrData.lyrics.trim()) {
                        lyricsText = lyrData.lyrics;
                    }
                }
            } catch (_) {}

            await this.saveTrack(track, audioBlob, artworkBlob, lyricsText);
            updateDownloadProgressUI({
                title,
                percent: 100,
                receivedBytes: receivedLength,
                totalBytes: contentLength,
                isDone: true
            });

            if (typeof window.refreshAllDownloadButtonsUI === 'function') {
                window.refreshAllDownloadButtonsUI();
            }
        } catch (err) {
            console.error('Download offline track error:', err);
            updateDownloadProgressUI({
                title,
                isError: true,
                errorMessage: err.message || 'Stream unavailable'
            });
        }
    }
};
window.YolkOfflineDB = YolkOfflineDB;

// Discreet sequential background download queue (no per-song toast popups)
const _yolkDownloadQueue = [];
let _isProcessingDownloadQueue = false;

async function processDownloadQueue() {
    if (_isProcessingDownloadQueue) return;
    _isProcessingDownloadQueue = true;
    try {
        while (_yolkDownloadQueue.length > 0) {
            const item = _yolkDownloadQueue.shift();
            if (!item || !item.track) continue;
            const uid = getTrackUid(item.track);
            if (!(await YolkOfflineDB.isDownloaded(uid))) {
                const remaining = _yolkDownloadQueue.length;
                const queueSuffix = remaining > 0 ? `+${remaining}` : '';
                await YolkOfflineDB.downloadTrack(item.track, { queueSuffix });
            }
        }
    } finally {
        _isProcessingDownloadQueue = false;
        if (typeof window.refreshAllDownloadButtonsUI === 'function') {
            window.refreshAllDownloadButtonsUI();
        }
    }
}

function enqueueLibraryDownload(tracksOrSingle) {
    if (!tracksOrSingle) return;
    const list = Array.isArray(tracksOrSingle) ? tracksOrSingle : [tracksOrSingle];
    const existingUids = new Set(_yolkDownloadQueue.map(q => getTrackUid(q.track)));
    for (const track of list) {
        if (!track) continue;
        const uid = getTrackUid(track);
        if (!uid || existingUids.has(uid)) continue;
        existingUids.add(uid);
        _yolkDownloadQueue.push({ track });
    }
    processDownloadQueue();
}
window.enqueueLibraryDownload = enqueueLibraryDownload;

function wireTrackDownloadBtn(dlBtn, track) {
    if (!dlBtn || !track) return;
    const uid = getTrackUid(track);
    const title = track.title || track.name || 'Track';
    dlBtn.dataset.trackUid = uid;
    const renderDownloadState = (isDownloaded) => {
        if (isDownloaded) {
            dlBtn.classList.add('text-emerald-600', 'bg-emerald-50');
            dlBtn.classList.remove('text-zinc-400');
            dlBtn.title = 'Downloaded offline (click to undownload)';
            dlBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>`;
        } else {
            dlBtn.classList.remove('text-emerald-600', 'bg-emerald-50');
            dlBtn.classList.add('text-zinc-400');
            dlBtn.title = 'Download offline';
            dlBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>`;
        }
    };
    dlBtn._renderDownloadState = renderDownloadState;

    YolkOfflineDB.isDownloaded(uid).then(renderDownloadState);

    dlBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const already = await YolkOfflineDB.isDownloaded(uid);
        if (already) {
            await YolkOfflineDB.deleteTrack(uid);
            renderDownloadState(false);
            if (typeof window.refreshAllDownloadButtonsUI === 'function') {
                window.refreshAllDownloadButtonsUI();
            }
        } else {
            await YolkOfflineDB.downloadTrack(track);
            const nowDownloaded = await YolkOfflineDB.isDownloaded(uid);
            renderDownloadState(nowDownloaded);
        }
    });
}

window.refreshAllDownloadButtonsUI = function () {
    document.querySelectorAll('.download-track-btn').forEach(btn => {
        const uid = btn.dataset.trackUid;
        if (uid && typeof btn._renderDownloadState === 'function') {
            YolkOfflineDB.isDownloaded(uid).then(btn._renderDownloadState);
        }
    });
    if (typeof window._updatePlaylistDownloadAllBtn === 'function') {
        window._updatePlaylistDownloadAllBtn();
    }
    if (typeof window._updateAlbumDownloadAllBtn === 'function') {
        window._updateAlbumDownloadAllBtn();
    }
    if (typeof window.refreshStorageManagerUI === 'function') {
        window.refreshStorageManagerUI();
    }
};

document.addEventListener('DOMContentLoaded', () => {
    // DOM Elements
    const bottomPlayer = document.getElementById('bottom-player');
    const bottomPlayerInfo = document.getElementById('bottom-player-info');
    const searchInput = document.getElementById('searchInput');
    const searchResults = document.getElementById('searchResults');
    const libraryOverview = document.getElementById('library-overview');
    const libraryGrid = document.getElementById('library-grid');
    const playlistDetailView = document.getElementById('playlist-detail-view');
    const playlistBackBtn = document.getElementById('playlist-back-btn');
    const createPlaylistBtn = document.getElementById('create-playlist-btn');

    // Controls
    const npPlayPauseBtn = document.getElementById('now-playing-play-pause');
    const npPrevBtn = document.getElementById('now-playing-prev');
    const npNextBtn = document.getElementById('now-playing-next');
    const npAddBtn = document.getElementById('now-playing-add-btn');
    const npFavBtn = document.getElementById('now-playing-fav-btn');
    const npProgressBar = document.getElementById('now-playing-progress-bar');
    const npProgressFill = document.getElementById('now-playing-progress-fill');
    const npCurrentTime = document.getElementById('now-playing-current-time');
    const npDuration = document.getElementById('now-playing-duration');

    const npLyricsBtn = document.getElementById('np-lyrics-btn');
    const npLyricsFloatingBar = document.getElementById('np-lyrics-floating-bar');
    const lyricsBarLyricsToggle = document.getElementById('lyrics-bar-lyrics-toggle');
    const lyricsBarPlayPause = document.getElementById('lyrics-bar-play-pause');
    const lyricsBarPlayIcon = document.getElementById('lyrics-bar-play-icon');
    const lyricsBarPrev = document.getElementById('lyrics-bar-prev');
    const lyricsBarNext = document.getElementById('lyrics-bar-next');
    const lyricsBarFavBtn = document.getElementById('lyrics-bar-fav-btn');
    const lyricsBarMoreBtn = document.getElementById('lyrics-bar-more-btn');
    const lyricsBarMorePopover = document.getElementById('lyrics-bar-more-popover');
    const lyricsMoreAddBtn = document.getElementById('lyrics-more-add-btn');
    const lyricsMoreQueueBtn = document.getElementById('lyrics-more-queue-btn');
    const lyricsMoreDownloadBtn = document.getElementById('lyrics-more-download-btn');
    const lyricsMoreVolumeSlider = document.getElementById('lyrics-more-volume-slider');
    const lyricsBarTitle = document.getElementById('lyrics-bar-title');
    const lyricsBarArtist = document.getElementById('lyrics-bar-artist');
    const lyricsBarThumb = document.getElementById('lyrics-bar-thumb');
    const lyricsBarInfo = document.getElementById('lyrics-bar-info');

    const npMobileMoreBtn = document.getElementById('np-mobile-more-btn');
    const npMobileMorePopover = document.getElementById('np-mobile-more-popover');
    const npMobileMoreArtistBtn = document.getElementById('np-mobile-more-artist-btn');
    const npMobileMoreAddBtn = document.getElementById('np-mobile-more-add-btn');
    const npMobileMoreQueueBtn = document.getElementById('np-mobile-more-queue-btn');
    const npMobileMoreDownloadBtn = document.getElementById('np-mobile-more-download-btn');
    const npMobileMoreVolumeSlider = document.getElementById('np-mobile-more-volume-slider');

    const bpMobileMoreBtn = document.getElementById('bp-mobile-more-btn');
    const bpMobileMorePopover = document.getElementById('bp-mobile-more-popover');
    const bpMoreArtistBtn = document.getElementById('bp-more-artist-btn');
    const bpMoreFavBtn = document.getElementById('bp-more-fav-btn');
    const bpMoreAddBtn = document.getElementById('bp-more-add-btn');
    const bpMoreQueueBtn = document.getElementById('bp-more-queue-btn');
    const bpMoreDownloadBtn = document.getElementById('bp-more-download-btn');
    const bpMoreVolumeSlider = document.getElementById('bp-more-volume-slider');

    const lyricsMoreArtistBtn = document.getElementById('lyrics-more-artist-btn');

    const nowPlayingContainer = document.getElementById('now-playing-container');
    let isLyricsAvailable = false;
    let isLyricsUserEnabled = false;

    function updateLyricsVisibilityUI() {
        if (!nowPlayingContainer) return;
        const page = document.body.getAttribute('data-page');

        if (!isLyricsAvailable) {
            nowPlayingContainer.classList.add('no-lyrics');
            nowPlayingContainer.classList.remove('lyrics-active', 'lyrics-hidden');
            if (npLyricsFloatingBar) npLyricsFloatingBar.classList.add('hidden');
            if (npLyricsBtn) {
                npLyricsBtn.disabled = true;
                npLyricsBtn.className = 'flex items-center justify-center w-9 h-9 rounded-full bg-white/20 border border-black/5 opacity-30 cursor-not-allowed pointer-events-none text-zinc-400 shrink-0';
                npLyricsBtn.title = 'No lyrics available for this song';
            }
        } else {
            nowPlayingContainer.classList.remove('no-lyrics');
            if (npLyricsBtn) {
                npLyricsBtn.disabled = false;
                npLyricsBtn.title = 'Toggle Lyrics';
            }

            if (isLyricsUserEnabled) {
                nowPlayingContainer.classList.add('lyrics-active');
                nowPlayingContainer.classList.remove('lyrics-hidden');
                if (page === 'now-playing' && npLyricsFloatingBar) {
                    if (window.innerWidth < 768) {
                        npLyricsFloatingBar.classList.remove('hidden');
                    } else {
                        npLyricsFloatingBar.classList.add('hidden');
                    }
                }
                if (npLyricsBtn) {
                    npLyricsBtn.className = 'flex items-center justify-center w-9 h-9 rounded-full bg-black text-white shadow-md hover:scale-105 active:scale-95 transition-all cursor-pointer shrink-0';
                }
            } else {
                nowPlayingContainer.classList.remove('lyrics-active');
                nowPlayingContainer.classList.add('lyrics-hidden');
                if (npLyricsFloatingBar) npLyricsFloatingBar.classList.add('hidden');
                if (npLyricsBtn) {
                    npLyricsBtn.className = 'lyrics-glossy-btn flex items-center justify-center w-9 h-9 rounded-full bg-white/50 backdrop-blur-md border border-white/80 shadow-xs hover:bg-white/80 hover:scale-105 active:scale-95 transition-all text-black cursor-pointer shrink-0';
                }
            }
        }
    }
    window.updateLyricsVisibilityUI = updateLyricsVisibilityUI;
    window.addEventListener('resize', () => {
        if (document.body.getAttribute('data-page') === 'now-playing') {
            updateLyricsVisibilityUI();
        }
    });

    const toggleLyricsMode = () => {
        if (!isLyricsAvailable) return;
        triggerHaptic('light');
        isLyricsUserEnabled = !isLyricsUserEnabled;
        updateLyricsVisibilityUI();
        if (isLyricsUserEnabled && typeof window.syncLyricsOnNavigate === 'function') {
            window.syncLyricsOnNavigate();
        }
    };
    if (npLyricsBtn) npLyricsBtn.onclick = toggleLyricsMode;
    if (lyricsBarLyricsToggle) lyricsBarLyricsToggle.onclick = toggleLyricsMode;
    if (lyricsBarInfo) lyricsBarInfo.onclick = toggleLyricsMode;

    if (lyricsBarPlayPause) {
        lyricsBarPlayPause.onclick = (e) => {
            if (e && e.currentTarget) e.currentTarget.blur();
            togglePlayPause();
        };
    }
    if (lyricsBarPrev) {
        lyricsBarPrev.onclick = (e) => {
            if (e && e.currentTarget) e.currentTarget.blur();
            playPrev();
        };
    }
    if (lyricsBarNext) {
        lyricsBarNext.onclick = (e) => {
            if (e && e.currentTarget) e.currentTarget.blur();
            playNext();
        };
    }
    if (lyricsBarFavBtn) {
        lyricsBarFavBtn.onclick = (e) => {
            if (e && e.currentTarget) e.currentTarget.blur();
            if (currentTrack) {
                toggleFavorite(currentTrack, lyricsBarFavBtn.querySelector('svg'));
                updateNowPlayingFavButton();
            }
        };
    }
    if (lyricsBarMoreBtn) {
        lyricsBarMoreBtn.onclick = (e) => {
            e.stopPropagation();
            if (lyricsBarMorePopover) {
                lyricsBarMorePopover.classList.toggle('hidden');
            }
        };
    }
    if (npMobileMoreBtn) {
        npMobileMoreBtn.onclick = (e) => {
            e.stopPropagation();
            if (npMobileMorePopover) {
                npMobileMorePopover.classList.toggle('hidden');
            }
        };
    }
    if (bpMobileMoreBtn) {
        bpMobileMoreBtn.onclick = (e) => {
            e.stopPropagation();
            if (bpMobileMorePopover) {
                bpMobileMorePopover.classList.toggle('hidden');
            }
        };
    }
    document.addEventListener('click', (e) => {
        if (lyricsBarMorePopover && !lyricsBarMorePopover.contains(e.target) && e.target !== lyricsBarMoreBtn) {
            lyricsBarMorePopover.classList.add('hidden');
        }
        if (npMobileMorePopover && !npMobileMorePopover.contains(e.target) && e.target !== npMobileMoreBtn) {
            npMobileMorePopover.classList.add('hidden');
        }
        if (bpMobileMorePopover && !bpMobileMorePopover.contains(e.target) && e.target !== bpMobileMoreBtn) {
            bpMobileMorePopover.classList.add('hidden');
        }
    });
    if (lyricsMoreAddBtn) {
        lyricsMoreAddBtn.onclick = () => {
            if (lyricsBarMorePopover) lyricsBarMorePopover.classList.add('hidden');
            if (currentTrack) openAddToPlaylistModal(currentTrack);
        };
    }
    if (lyricsMoreQueueBtn) {
        lyricsMoreQueueBtn.onclick = () => {
            if (lyricsBarMorePopover) lyricsBarMorePopover.classList.add('hidden');
            if (typeof openQueueModal === 'function') openQueueModal();
        };
    }
    function navigateToTrackArtist() {
        if (!currentTrack) return;
        const artist = currentTrack.artist_name || currentTrack.artist;
        if (artist && typeof window.loadArtistView === 'function') {
            window.loadArtistView(artist);
        }
    }

    function navigateToTrackAlbum() {
        if (!currentTrack) return;
        if (currentTrack.album_id && typeof window.loadAlbumView === 'function') {
            window.loadAlbumView(currentTrack.album_id);
            return;
        }
        const albumName = currentTrack.album_name || currentTrack.album;
        if (albumName) {
            window.location.hash = '#search';
            const searchInput = document.getElementById('searchInput');
            if (searchInput) {
                searchInput.value = albumName;
                if (typeof handleSearch === 'function') handleSearch(albumName);
                setTimeout(() => {
                    const albumsTab = document.querySelector('.search-tab-pill[data-tab="albums"]');
                    if (albumsTab) albumsTab.click();
                }, 350);
            }
        }
    }

    if (lyricsMoreArtistBtn) {
        lyricsMoreArtistBtn.onclick = () => {
            if (lyricsBarMorePopover) lyricsBarMorePopover.classList.add('hidden');
            navigateToTrackArtist();
        };
    }
    if (lyricsMoreDownloadBtn) {
        lyricsMoreDownloadBtn.onclick = () => {
            if (lyricsBarMorePopover) lyricsBarMorePopover.classList.add('hidden');
            if (currentTrack) YolkOfflineDB.downloadTrack(currentTrack);
        };
    }
    if (npMobileMoreArtistBtn) {
        npMobileMoreArtistBtn.onclick = () => {
            if (npMobileMorePopover) npMobileMorePopover.classList.add('hidden');
            navigateToTrackArtist();
        };
    }
    if (npMobileMoreAddBtn) {
        npMobileMoreAddBtn.onclick = () => {
            if (npMobileMorePopover) npMobileMorePopover.classList.add('hidden');
            if (currentTrack) openAddToPlaylistModal(currentTrack);
        };
    }
    if (npMobileMoreQueueBtn) {
        npMobileMoreQueueBtn.onclick = () => {
            if (npMobileMorePopover) npMobileMorePopover.classList.add('hidden');
            if (typeof openQueueModal === 'function') openQueueModal();
        };
    }
    if (npMobileMoreDownloadBtn) {
        npMobileMoreDownloadBtn.onclick = () => {
            if (npMobileMorePopover) npMobileMorePopover.classList.add('hidden');
            if (currentTrack) YolkOfflineDB.downloadTrack(currentTrack);
        };
    }
    if (bpMoreArtistBtn) {
        bpMoreArtistBtn.onclick = () => {
            if (bpMobileMorePopover) bpMobileMorePopover.classList.add('hidden');
            navigateToTrackArtist();
        };
    }
    if (bpMoreFavBtn) {
        bpMoreFavBtn.onclick = () => {
            if (bpMobileMorePopover) bpMobileMorePopover.classList.add('hidden');
            if (currentTrack) {
                toggleFavorite(currentTrack, null);
                updateNowPlayingFavButton();
                updateBottomPlayerFavButton();
            }
        };
    }
    if (bpMoreAddBtn) {
        bpMoreAddBtn.onclick = () => {
            if (bpMobileMorePopover) bpMobileMorePopover.classList.add('hidden');
            if (currentTrack) openAddToPlaylistModal(currentTrack);
        };
    }
    if (bpMoreQueueBtn) {
        bpMoreQueueBtn.onclick = () => {
            if (bpMobileMorePopover) bpMobileMorePopover.classList.add('hidden');
            if (typeof openQueueModal === 'function') openQueueModal();
        };
    }
    if (bpMoreDownloadBtn) {
        bpMoreDownloadBtn.onclick = () => {
            if (bpMobileMorePopover) bpMobileMorePopover.classList.add('hidden');
            if (currentTrack) YolkOfflineDB.downloadTrack(currentTrack);
        };
    }
    const npDownloadBtn = document.getElementById('now-playing-download-btn');
    if (npDownloadBtn) {
        npDownloadBtn.onclick = () => {
            if (currentTrack) YolkOfflineDB.downloadTrack(currentTrack);
        };
    }
    const bpDownloadBtn = document.getElementById('bottom-player-download-btn');
    if (bpDownloadBtn) {
        bpDownloadBtn.onclick = () => {
            if (currentTrack) YolkOfflineDB.downloadTrack(currentTrack);
        };
    }
    if (npMobileMoreVolumeSlider) {
        npMobileMoreVolumeSlider.addEventListener('input', (e) => {
            setMasterVolume(parseFloat(e.target.value) / 100);
        });
    }
    if (bpMoreVolumeSlider) {
        bpMoreVolumeSlider.addEventListener('input', (e) => {
            setMasterVolume(parseFloat(e.target.value) / 100);
        });
    }
    if (lyricsMoreVolumeSlider) {
        lyricsMoreVolumeSlider.addEventListener('input', (e) => {
            setMasterVolume(parseFloat(e.target.value) / 100);
        });
    }
    updateLyricsVisibilityUI();

    const bpPlayPauseBtn = document.getElementById('bottom-player-play-pause');
    const bpPrevBtn = document.getElementById('bottom-player-prev');
    const bpNextBtn = document.getElementById('bottom-player-next');
    const bpFavBtn = document.getElementById('bottom-player-fav-btn');
    const bpAddBtn = document.getElementById('bottom-player-add-btn');
    const bpProgressBar = document.getElementById('bottom-player-progress-bar');
    const bpProgressFill = document.getElementById('bottom-player-progress-fill');
    const bpCurrentTime = document.getElementById('bottom-player-current-time');
    const bpDuration = document.getElementById('bottom-player-duration');

    // Master Volume Control (Bottom Bar & Fullscreen Now Playing)
    let currentVolume = parseFloat(localStorage.getItem('yolk_volume') ?? '1.0');
    if (isNaN(currentVolume) || currentVolume < 0 || currentVolume > 1) currentVolume = 1.0;
    let savedMuteVolume = currentVolume > 0 ? currentVolume : 1.0;

    const bpVolumeBtn = document.getElementById('bp-volume-btn');
    const bpVolumeSlider = document.getElementById('bp-volume-slider');
    const bpVolumeIcon = document.getElementById('bp-volume-icon');

    const npVolumeBtn = document.getElementById('np-volume-btn');
    const npVolumeSlider = document.getElementById('np-volume-slider');
    const npVolumeIcon = document.getElementById('np-volume-icon');

    function getVolumeIconSvg(vol, stroke = 'currentColor', strokeWidth = '2') {
        if (vol <= 0) {
            return `<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><line x1="23" y1="9" x2="17" y2="15"></line><line x1="17" y1="9" x2="23" y2="15"></line>`;
        }
        if (vol <= 0.5) {
            return `<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path>`;
        }
        return `<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path><path d="M19.07 4.93a10 10 0 0 1 0 14.14"></path>`;
    }

    function setMasterVolume(vol, persist = true) {
        currentVolume = Math.max(0, Math.min(1, vol));
        if (persist) {
            localStorage.setItem('yolk_volume', currentVolume.toString());
        }

        currentAudio.volume = currentVolume;

        if (ytPlayer && typeof ytPlayer.setVolume === 'function') {
            try {
                ytPlayer.setVolume(Math.round(currentVolume * 100));
                if (currentVolume <= 0 && typeof ytPlayer.mute === 'function') {
                    ytPlayer.mute();
                } else if (currentVolume > 0 && typeof ytPlayer.unMute === 'function') {
                    ytPlayer.unMute();
                }
            } catch (_) {}
        }

        const percentVal = Math.round(currentVolume * 100);
        if (bpVolumeSlider) bpVolumeSlider.value = percentVal;
        if (npVolumeSlider) npVolumeSlider.value = percentVal;
        if (lyricsMoreVolumeSlider) lyricsMoreVolumeSlider.value = percentVal;
        if (npMobileMoreVolumeSlider) npMobileMoreVolumeSlider.value = percentVal;
        if (bpMoreVolumeSlider) bpMoreVolumeSlider.value = percentVal;

        if (bpVolumeIcon) {
            bpVolumeIcon.innerHTML = getVolumeIconSvg(currentVolume, 'currentColor', '2');
        }
        if (npVolumeIcon) {
            npVolumeIcon.innerHTML = getVolumeIconSvg(currentVolume, 'currentColor', '2.2');
        }
    }

    function toggleMute() {
        if (currentVolume > 0) {
            savedMuteVolume = currentVolume;
            setMasterVolume(0);
        } else {
            setMasterVolume(savedMuteVolume > 0 ? savedMuteVolume : 1.0);
        }
    }

    if (bpVolumeSlider) {
        bpVolumeSlider.addEventListener('input', (e) => {
            const val = parseFloat(e.target.value) / 100;
            setMasterVolume(val);
        });
    }

    if (npVolumeSlider) {
        npVolumeSlider.addEventListener('input', (e) => {
            const val = parseFloat(e.target.value) / 100;
            setMasterVolume(val);
        });
    }

    if (lyricsMoreVolumeSlider) {
        lyricsMoreVolumeSlider.addEventListener('input', (e) => {
            const val = parseFloat(e.target.value) / 100;
            setMasterVolume(val);
        });
    }

    if (bpVolumeBtn) {
        bpVolumeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleMute();
        });
    }

    if (npVolumeBtn) {
        npVolumeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleMute();
        });
    }

    setMasterVolume(currentVolume, false);

    // Modals
    const playlistModal = document.getElementById('playlist-modal');
    const playlistModalTitle = document.getElementById('playlist-modal-title');
    const playlistNameInput = document.getElementById('playlist-name-input');
    const playlistDescInput = document.getElementById('playlist-desc-input');
    const playlistModalCancel = document.getElementById('playlist-modal-cancel');
    const playlistModalSave = document.getElementById('playlist-modal-save');

    const addToPlaylistModal = document.getElementById('add-to-playlist-modal');
    const addToPlaylistClose = document.getElementById('add-to-playlist-close');
    const addToPlaylistTrackName = document.getElementById('add-to-playlist-track-name');
    const addToPlaylistOptions = document.getElementById('add-to-playlist-options');
    const addToPlaylistNewBtn = document.getElementById('add-to-playlist-new-btn');

    // Loading spinner (morphs bottom bar into circle with parabola animation)
    function showSpinner(show) {
        if (!bottomPlayer) return;
        if (show) {
            if (document.body.getAttribute('data-page') !== 'now-playing') {
                bottomPlayer.classList.remove('hidden-force');
            }
            bottomPlayer.classList.add('is-loading');
        } else {
            bottomPlayer.classList.remove('is-loading');
        }
    }

    // Bottom Player Routing
    if (bottomPlayerInfo) {
        bottomPlayerInfo.addEventListener('click', () => {
            window.location.hash = '#now-playing';
        });
    }

    const npArtistEl = document.getElementById('now-playing-artist');
    if (npArtistEl) {
        npArtistEl.addEventListener('click', (e) => {
            e.stopPropagation();
            if (currentTrack) {
                const a = currentTrack.artist_name || currentTrack.artist;
                if (a && typeof window.loadArtistView === 'function') {
                    window.loadArtistView(a);
                }
            }
        });
    }

    // Search Logic & Category Tabs
    let searchTimeout;
    const searchTabsContainer = document.getElementById('search-tabs-container');
    let currentSearchTab = 'all';
    let currentSearchData = { tracks: [], albums: [], artists: [], playlists: [] };

    function updateSearchTabsUI() {
        if (!searchTabsContainer) return;
        const tabBtns = searchTabsContainer.querySelectorAll('.search-tab-pill');
        tabBtns.forEach(btn => {
            const tab = btn.getAttribute('data-tab');
            if (tab === currentSearchTab) {
                btn.className = 'search-tab-pill px-4 py-1.5 rounded-full text-xs font-semibold bg-zinc-900 text-white shadow-sm transition-all cursor-pointer';
            } else {
                btn.className = 'search-tab-pill px-4 py-1.5 rounded-full text-xs font-semibold bg-white/90 text-zinc-600 hover:text-zinc-950 border border-zinc-200/80 hover:bg-zinc-100 transition-all cursor-pointer';
            }
        });
    }

    if (searchTabsContainer) {
        searchTabsContainer.querySelectorAll('.search-tab-pill').forEach(btn => {
            btn.addEventListener('click', () => {
                const tab = btn.getAttribute('data-tab');
                if (tab === currentSearchTab) {
                    const searchPage = document.getElementById('page-search');
                    if (searchPage) searchPage.scrollTo({ top: 0, behavior: 'smooth' });
                    window.scrollTo({ top: 0, behavior: 'smooth' });
                    return;
                }
                currentSearchTab = tab;
                updateSearchTabsUI();
                renderSearchResults();
                const searchPage = document.getElementById('page-search');
                if (searchPage) searchPage.scrollTo({ top: 0, behavior: 'smooth' });
                window.scrollTo({ top: 0, behavior: 'smooth' });
            });
        });
    }

    // ==========================================
    // Recent Searches Management
    // ==========================================
    const recentSearchesContainer = document.getElementById('recent-searches-container');
    const recentSearchesList = document.getElementById('recent-searches-list');
    const clearRecentBtn = document.getElementById('clear-recent-searches-btn');

    function getRecentSearches() {
        try {
            const raw = localStorage.getItem('yolk_recent_searches');
            const parsed = raw ? JSON.parse(raw) : [];
            return Array.isArray(parsed) ? parsed.slice(0, 3) : [];
        } catch (_) {
            return [];
        }
    }

    function saveRecentSearch(q) {
        const term = String(q || '').trim();
        if (!term || term.length < 2) return;
        let list = getRecentSearches().filter(item => item.toLowerCase() !== term.toLowerCase());
        list.unshift(term);
        if (list.length > 3) list = list.slice(0, 3);
        try {
            localStorage.setItem('yolk_recent_searches', JSON.stringify(list));
        } catch (_) {}
        renderRecentSearches();
    }

    function removeRecentSearch(term) {
        let list = getRecentSearches().filter(item => item.toLowerCase() !== term.toLowerCase());
        try {
            localStorage.setItem('yolk_recent_searches', JSON.stringify(list));
        } catch (_) {}
        renderRecentSearches();
    }

    function clearAllRecentSearches() {
        try {
            localStorage.removeItem('yolk_recent_searches');
        } catch (_) {}
        renderRecentSearches();
    }

    function renderRecentSearches() {
        if (!recentSearchesList || !recentSearchesContainer) return;
        const list = getRecentSearches();
        if (list.length === 0) {
            recentSearchesContainer.classList.add('hidden');
            recentSearchesContainer.classList.remove('flex');
            recentSearchesList.innerHTML = '';
            return;
        }

        recentSearchesList.innerHTML = '';
        list.forEach(term => {
            const pill = document.createElement('div');
            pill.className = 'group/pill flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-white/80 hover:bg-white text-zinc-700 text-xs font-semibold border border-zinc-200/80 shadow-xs transition-all cursor-pointer select-none';
            
            const textSpan = document.createElement('span');
            textSpan.className = 'truncate max-w-[160px] sm:max-w-[220px]';
            textSpan.textContent = term;
            textSpan.addEventListener('click', () => {
                if (searchInput) {
                    searchInput.value = term;
                    currentSearchQuery = term;
                    searchOffset = 0;
                    document.body.classList.add('is-searching');
                    hideRecentSearches();
                    if (searchTabsContainer) {
                        searchTabsContainer.classList.remove('hidden');
                        searchTabsContainer.classList.add('flex');
                    }
                    performSearch(term, true);
                    saveRecentSearch(term);
                }
            });

            const delBtn = document.createElement('button');
            delBtn.type = 'button';
            delBtn.title = 'Remove search';
            delBtn.className = 'w-4 h-4 rounded-full flex items-center justify-center text-zinc-400 hover:text-zinc-700 hover:bg-zinc-100 transition-colors cursor-pointer shrink-0 ml-0.5';
            delBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`;
            delBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                removeRecentSearch(term);
            });

            pill.appendChild(textSpan);
            pill.appendChild(delBtn);
            recentSearchesList.appendChild(pill);
        });
    }

    function showRecentSearches() {
        const list = getRecentSearches();
        if (list.length > 0 && (!searchInput || !searchInput.value.trim())) {
            renderRecentSearches();
            if (recentSearchesContainer) {
                recentSearchesContainer.classList.remove('hidden');
                recentSearchesContainer.classList.add('flex');
            }
        }
    }

    function hideRecentSearches() {
        if (recentSearchesContainer) {
            recentSearchesContainer.classList.add('hidden');
            recentSearchesContainer.classList.remove('flex');
        }
    }

    if (clearRecentBtn) {
        clearRecentBtn.addEventListener('click', clearAllRecentSearches);
    }

    // ==========================================
    // Logo Click -> Return to Home
    // ==========================================
    function returnToHomeScreen() {
        if (searchInput) {
            searchInput.value = '';
        }
        currentSearchQuery = '';
        document.body.classList.remove('is-searching');
        if (searchTabsContainer) {
            searchTabsContainer.classList.add('hidden');
            searchTabsContainer.classList.remove('flex');
        }
        if (searchResults) {
            searchResults.innerHTML = '';
        }
        hideRecentSearches();
        window.location.hash = '#search';
        const pageSearch = document.getElementById('page-search');
        if (pageSearch) pageSearch.scrollTo({ top: 0, behavior: 'smooth' });
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    const smallLogo = document.getElementById('smallLogo');
    if (smallLogo) {
        smallLogo.addEventListener('click', returnToHomeScreen);
    }
    const largeLogo = document.getElementById('large-logo-wrapper');
    if (largeLogo) {
        largeLogo.addEventListener('click', returnToHomeScreen);
    }

    let clearCollapseTimeout = null;

    if (searchInput) {
        searchInput.addEventListener('focus', () => {
            clearTimeout(clearCollapseTimeout);
            if (searchInput.value.trim().length > 0) {
                document.body.classList.add('is-searching');
                hideRecentSearches();
                if (searchTabsContainer) {
                    searchTabsContainer.classList.remove('hidden');
                    searchTabsContainer.classList.add('flex');
                }
            } else {
                showRecentSearches();
            }
        });

        searchInput.addEventListener('input', (e) => {
            clearTimeout(clearCollapseTimeout);
            const val = e.target.value.trim();
            if (val.length > 0) {
                document.body.classList.add('is-searching');
                hideRecentSearches();
                if (searchTabsContainer) {
                    searchTabsContainer.classList.remove('hidden');
                    searchTabsContainer.classList.add('flex');
                }
                clearTimeout(searchTimeout);
                // 450ms typing delay before firing search requests
                searchTimeout = setTimeout(() => {
                    currentSearchQuery = val;
                    searchOffset = 0;
                    performSearch(val, true);
                }, 450);
            } else {
                clearTimeout(searchTimeout);
                currentSearchQuery = '';
                showRecentSearches();
                // 1.2s delay before collapsing back to center hero mode, allowing user to type something else
                clearCollapseTimeout = setTimeout(() => {
                    if (searchInput && !searchInput.value.trim()) {
                        document.body.classList.remove('is-searching');
                        const ps = document.getElementById('page-search');
                        if (ps) ps.scrollTop = 0;
                        window.scrollTo(0, 0);
                        if (searchTabsContainer) {
                            searchTabsContainer.classList.add('hidden');
                            searchTabsContainer.classList.remove('flex');
                        }
                        if (searchResults) searchResults.innerHTML = '';
                        showRecentSearches();
                    }
                }, 1200);
            }
        });

        // Click outside search block collapses search state back to center immediately
        document.addEventListener('click', (e) => {
            if (
                searchInput &&
                !searchInput.value.trim() &&
                !currentSearchQuery &&
                !e.target.closest('#search-block') &&
                !e.target.closest('#main-header') &&
                !e.target.closest('#bottom-player') &&
                !e.target.closest('.modal-overlay')
            ) {
                clearTimeout(clearCollapseTimeout);
                document.body.classList.remove('is-searching');
                const ps = document.getElementById('page-search');
                if (ps) ps.scrollTop = 0;
                window.scrollTo(0, 0);
                hideRecentSearches();
                if (searchTabsContainer) {
                    searchTabsContainer.classList.add('hidden');
                    searchTabsContainer.classList.remove('flex');
                }
            }
        });
    }

    // Infinite Scroll on Search Page
    const pageSearch = document.getElementById('page-search');
    if (pageSearch) {
        pageSearch.addEventListener('scroll', (e) => {
            const el = e.target;
            if (el.scrollHeight - el.scrollTop <= el.clientHeight + 250) {
                if (!isLoadingMore && currentSearchQuery && currentSearchTab === 'songs') {
                    searchOffset += 25;
                    performSearch(currentSearchQuery, false);
                }
            }
        });
    }

    async function performSearch(query, clear) {
        isLoadingMore = true;
        if (clear) {
            searchResults.innerHTML = '<div class="text-[11px] font-semibold text-zinc-400 uppercase tracking-widest text-left w-full mb-1 pl-5">Searching YouTube Music…</div>';
            if (query && query.trim().length >= 2) {
                saveRecentSearch(query.trim());
            }
        }
        
        try {
            const res = await fetch(`${API_BASE}?endpoint=search&q=${encodeURIComponent(query)}&limit=25&offset=${searchOffset}`);
            const data = await res.json();
            
            if (clear) {
                currentSearchData = {
                    tracks: Array.isArray(data.tracks) ? data.tracks : [],
                    albums: Array.isArray(data.albums) ? data.albums : [],
                    artists: Array.isArray(data.artists) ? data.artists : [],
                    playlists: Array.isArray(data.playlists) ? data.playlists : []
                };
                if (Array.isArray(data.artists)) {
                    data.artists.forEach(a => {
                        if (a && a.name && a.artwork_url) {
                            artistPfpMap.set(a.name.toLowerCase().trim(), a.artwork_url);
                        }
                    });
                }
            } else if (data && Array.isArray(data.tracks) && data.tracks.length > 0) {
                // Append more tracks if in infinite scroll
                const existingVids = new Set(currentSearchData.tracks.map(t => t.youtube_id || t.id));
                const newTracks = data.tracks.filter(t => !existingVids.has(t.youtube_id || t.id));
                currentSearchData.tracks.push(...newTracks);
            }
            
            renderSearchResults();
        } catch (e) {
            console.error('Search error:', e);
            if (clear) searchResults.innerHTML = '<div class="text-xs text-red-400 pl-5 py-4">Failed to load results.</div>';
        } finally {
            isLoadingMore = false;
        }
    }

    function renderSearchResults() {
        if (!searchResults) return;
        searchResults.innerHTML = '';

        const { tracks, albums, artists, playlists } = currentSearchData;
        const hasAnyResults = (tracks && tracks.length > 0) || (albums && albums.length > 0) || (artists && artists.length > 0) || (playlists && playlists.length > 0);

        if (!hasAnyResults) {
            searchResults.innerHTML = '<div class="text-xs text-zinc-400 pl-5 py-4">No results found on YouTube Music.</div>';
            return;
        }

        if (currentSearchTab === 'all') {
            renderSearchAllTab(tracks, albums, artists, playlists);
        } else if (currentSearchTab === 'songs') {
            renderSearchSongsTab(tracks);
        } else if (currentSearchTab === 'albums') {
            renderSearchAlbumsTab(albums);
        } else if (currentSearchTab === 'artists') {
            renderSearchArtistsTab(artists);
        } else if (currentSearchTab === 'playlists') {
            renderSearchPlaylistsTab(playlists);
        }
    }

    function createSearchAlbumRow(album) {
        const div = document.createElement('div');
        div.className = 'group flex items-center justify-between p-2.5 rounded-2xl song-row-card mb-2 w-full max-w-full box-border cursor-pointer select-none';
        const artwork = getProxyUrl(album.artwork_url, '80x80');
        div.innerHTML = `
            <div class="flex items-center gap-3 min-w-0 flex-1 mr-2 overflow-hidden">
                <div class="w-10 h-10 bg-zinc-100 rounded-xl overflow-hidden shrink-0 relative border border-zinc-200/60 shadow-xs flex items-center justify-center">
                    ${artwork ? `<img src="${artwork}" alt="${escapeHtml(album.name)}" class="w-full h-full object-cover">` : `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" class="text-zinc-400"><circle cx="12" cy="12" r="10"></circle><circle cx="12" cy="12" r="3"></circle></svg>`}
                </div>
                <div class="flex flex-col text-left min-w-0 flex-1 overflow-hidden">
                    <span class="font-bold text-zinc-900 text-xs sm:text-sm truncate block max-w-full" title="${escapeHtml(album.name)}">${escapeHtml(album.name)}</span>
                    <span class="text-[11px] text-zinc-500 font-medium truncate block max-w-full mt-0.5" title="${escapeHtml(album.artist_name || 'Album')}">${escapeHtml(album.artist_name || 'Album')}</span>
                </div>
            </div>
            <span class="text-[9px] uppercase font-bold text-zinc-600 bg-zinc-100 px-2.5 py-1 rounded-full shrink-0 border border-zinc-200/50">Album</span>
        `;
        div.addEventListener('click', () => {
            if (typeof window.loadAlbumView === 'function') {
                window.loadAlbumView(album.id);
            }
        });
        return div;
    }

    function createSearchPlaylistRow(playlist) {
        const div = document.createElement('div');
        div.className = 'group flex items-center justify-between p-2.5 rounded-2xl song-row-card mb-2 w-full max-w-full box-border cursor-pointer select-none';
        const artwork = getProxyUrl(playlist.artwork_url, '80x80');
        div.innerHTML = `
            <div class="flex items-center gap-3 min-w-0 flex-1 mr-2 overflow-hidden">
                <div class="w-10 h-10 bg-zinc-100 rounded-xl overflow-hidden shrink-0 relative border border-zinc-200/60 shadow-xs flex items-center justify-center">
                    ${artwork ? `<img src="${artwork}" alt="${escapeHtml(playlist.name)}" class="w-full h-full object-cover">` : `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" class="text-zinc-400"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg>`}
                </div>
                <div class="flex flex-col text-left min-w-0 flex-1 overflow-hidden">
                    <span class="font-bold text-zinc-900 text-xs sm:text-sm truncate block max-w-full" title="${escapeHtml(playlist.name)}">${escapeHtml(playlist.name)}</span>
                    <span class="text-[11px] text-zinc-500 font-medium truncate block max-w-full mt-0.5">${playlist.song_count ? `${playlist.song_count} songs` : 'Playlist'}</span>
                </div>
            </div>
            <button class="pl-play-btn w-8 h-8 rounded-full bg-zinc-900 text-white flex items-center justify-center shrink-0 hover:scale-105 active:scale-95 transition-all shadow-xs" title="Play Playlist">
                <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="white" stroke="white" stroke-width="1" class="ml-0.5"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
            </button>
        `;
        div.addEventListener('click', async (e) => {
            showSpinner(true);
            try {
                const res = await fetch(`${API_BASE}?endpoint=playlist&id=${encodeURIComponent((playlist.id || '').replace('ytm-', ''))}`);
                const data = await res.json();
                if (data && Array.isArray(data.tracks) && data.tracks.length > 0) {
                    currentQueue = data.tracks;
                    currentQueueIndex = 0;
                    currentPlayingPlaylistContextId = null;
                    playTrack(data.tracks[0]);
                } else {
                    showToast('Unable to load playlist tracks');
                }
            } catch (_) {
                showToast('Failed to load playlist');
            } finally {
                showSpinner(false);
            }
        });
        return div;
    }

    function createSearchArtistRow(artist) {
        const div = document.createElement('div');
        div.className = 'group flex items-center justify-between p-2.5 rounded-2xl song-row-card mb-2 w-full max-w-full box-border cursor-pointer select-none';
        const artwork = getProxyUrl(artist.artwork_url, '80x80');
        div.innerHTML = `
            <div class="flex items-center gap-3 min-w-0 flex-1 mr-2 overflow-hidden">
                <div class="w-10 h-10 bg-zinc-100 rounded-full overflow-hidden shrink-0 relative border border-zinc-200/60 flex items-center justify-center shadow-xs">
                    ${artwork ? `<img src="${artwork}" alt="${escapeHtml(artist.name)}" class="w-full h-full object-cover">` : `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" class="text-zinc-400"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>`}
                </div>
                <div class="flex flex-col text-left min-w-0 flex-1 overflow-hidden">
                    <span class="font-bold text-zinc-900 text-xs sm:text-sm truncate block max-w-full" title="${escapeHtml(artist.name)}">${escapeHtml(artist.name)}</span>
                    <span class="text-[9px] uppercase font-bold text-blue-600 mt-0.5">Artist</span>
                </div>
            </div>
            <button class="px-3 py-1 rounded-full bg-zinc-100 hover:bg-zinc-200 text-zinc-800 text-[11px] font-semibold transition-colors shrink-0 border border-zinc-200/50">View</button>
        `;
        div.addEventListener('click', () => {
            if (typeof window.loadArtistView === 'function') {
                window.loadArtistView(artist.name, artist.artwork_url);
            }
        });
        return div;
    }

    function renderSearchAllTab(tracks, albums, artists, playlists) {
        // 1. Check for Best Match / Top Result Card (Artist or Album or Top Track)
        const q = (currentSearchQuery || '').toLowerCase().trim();
        let topArtistMatch = artists.find(a => (a.name || '').toLowerCase().trim() === q) 
            || (artists.length > 0 && (artists[0].name || '').toLowerCase().trim().startsWith(q) ? artists[0] : null)
            || (artists.length > 0 && tracks.some(t => (t.artist_name || '').toLowerCase().trim() === (artists[0].name || '').toLowerCase().trim()) ? artists[0] : null);
        let topAlbumMatch = albums.find(a => (a.name || '').toLowerCase().trim() === q);

        if (topArtistMatch) {
            const bestCard = document.createElement('div');
            bestCard.className = 'group p-4 rounded-2xl bg-white/95 backdrop-blur-md border border-zinc-200/80 hover:border-zinc-300 hover:shadow-md transition-all cursor-pointer scroll-row-hover flex items-center justify-between mb-4';
            const art = getProxyUrl(topArtistMatch.artwork_url, '200x200');
            bestCard.innerHTML = `
                <div class="flex items-center gap-4 min-w-0">
                    <div class="w-14 h-14 sm:w-16 sm:h-16 rounded-full overflow-hidden bg-zinc-100 shrink-0 border border-zinc-200/60 shadow-sm flex items-center justify-center">
                        ${art ? `<img src="${art}" class="w-full h-full object-cover">` : `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" class="text-zinc-400"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>`}
                    </div>
                    <div class="flex flex-col text-left min-w-0">
                        <span class="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-blue-600 bg-blue-50 px-2 py-0.5 rounded-full border border-blue-200/60 w-fit mb-1">Artist</span>
                        <h3 class="text-sm sm:text-base font-bold text-zinc-900 truncate leading-snug">${escapeHtml(topArtistMatch.name)}</h3>
                        <p class="text-[11px] text-zinc-500 font-medium">Top Verified Artist</p>
                    </div>
                </div>
                <button class="px-4 py-1.5 rounded-full bg-zinc-900 text-white text-xs font-semibold hover:bg-zinc-800 transition-all shrink-0">View Artist</button>
            `;
            bestCard.addEventListener('click', () => {
                if (typeof window.loadArtistView === 'function') {
                    window.loadArtistView(topArtistMatch.name, topArtistMatch.artwork_url);
                }
            });
            searchResults.appendChild(bestCard);
        } else if (topAlbumMatch) {
            const bestAlbumCard = document.createElement('div');
            bestAlbumCard.className = 'group p-4 rounded-2xl bg-white/95 backdrop-blur-md border border-zinc-200/80 hover:border-zinc-300 hover:shadow-md transition-all cursor-pointer scroll-row-hover flex items-center justify-between mb-4';
            const art = getProxyUrl(topAlbumMatch.artwork_url, '200x200');
            bestAlbumCard.innerHTML = `
                <div class="flex items-center gap-4 min-w-0">
                    <div class="w-14 h-14 sm:w-16 sm:h-16 rounded-2xl overflow-hidden bg-zinc-100 shrink-0 border border-zinc-200/60 shadow-sm flex items-center justify-center">
                        ${art ? `<img src="${art}" class="w-full h-full object-cover">` : `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" class="text-zinc-400"><circle cx="12" cy="12" r="10"></circle><circle cx="12" cy="12" r="3"></circle></svg>`}
                    </div>
                    <div class="flex flex-col text-left min-w-0">
                        <span class="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-zinc-700 bg-zinc-100 px-2 py-0.5 rounded-full border border-zinc-200/60 w-fit mb-1">Album</span>
                        <h3 class="text-sm sm:text-base font-bold text-zinc-900 truncate leading-snug">${escapeHtml(topAlbumMatch.name)}</h3>
                        <p class="text-[11px] text-zinc-500 font-medium">${escapeHtml(topAlbumMatch.artist_name || 'Album')}</p>
                    </div>
                </div>
                <button class="px-4 py-1.5 rounded-full bg-zinc-900 text-white text-xs font-semibold hover:bg-zinc-800 transition-all shrink-0">Open Album</button>
            `;
            bestAlbumCard.addEventListener('click', () => {
                if (typeof window.loadAlbumView === 'function') {
                    window.loadAlbumView(topAlbumMatch.id);
                }
            });
            searchResults.appendChild(bestAlbumCard);
        }

        // Asymmetric Bento Grid:
        // Left Column (58% width, lg:col-span-7): Full-height immersive Songs pane with independent scroll
        // Right Column (42% width, lg:col-span-5): 2-Column Bento subgrid stacking Albums (top, sm:col-span-2) and Playlists & Artists (bottom, sm:col-span-1 each)
        // Because secondary categories have natural max-heights, dead space disappears completely while keeping the full-width dashboard feel!
        const bentoGrid = document.createElement('div');
        bentoGrid.className = 'grid grid-cols-1 lg:grid-cols-12 gap-5 w-full mt-2 items-start';

        // 1. Songs Column (Left: 58% width, lg:col-span-7)
        const songsCol = document.createElement('div');
        songsCol.className = 'lg:col-span-7 bg-white/85 backdrop-blur-xl rounded-3xl border border-zinc-200/80 p-3.5 sm:p-4 shadow-sm flex flex-col min-w-0 h-[calc(100vh-210px)] max-h-[780px] min-h-[480px] overflow-hidden';
        songsCol.innerHTML = `
            <div class="flex items-center justify-between text-[11px] font-bold text-zinc-500 uppercase tracking-wider pb-2.5 mb-2.5 border-b border-zinc-100 shrink-0">
                <span class="flex items-center gap-1.5 text-zinc-900 font-extrabold">
                    <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg>
                    Songs (${tracks ? tracks.length : 0})
                </span>
                <button class="songs-all-btn text-zinc-500 hover:text-zinc-950 normal-case font-semibold text-xs transition-colors hover:underline cursor-pointer">Show all</button>
            </div>
            <div class="songs-scroll flex-1 overflow-y-auto overflow-x-hidden pr-2 sleek-scrollbar flex flex-col gap-1.5 px-1 py-1"></div>
        `;
        const songsScroll = songsCol.querySelector('.songs-scroll');
        if (tracks && tracks.length > 0) {
            tracks.forEach((track, idx) => {
                const el = createTrackElement(track, () => {
                    currentQueue = tracks;
                    currentQueueIndex = idx;
                    currentPlaylistContextId = null;
                    currentPlayingPlaylistContextId = null;
                    playTrack(track);
                });
                songsScroll.appendChild(el);
            });
        } else {
            songsScroll.innerHTML = '<div class="py-8 text-center text-xs text-zinc-400 font-medium">No songs found</div>';
        }
        songsCol.querySelector('.songs-all-btn').onclick = () => {
            currentSearchTab = 'songs';
            updateSearchTabsUI();
            renderSearchResults();
        };
        bentoGrid.appendChild(songsCol);

        // 2. Right Sub-Grid (42% width, lg:col-span-5): 2-Column Bento Subgrid for Albums, Playlists & Artists
        const rightBento = document.createElement('div');
        rightBento.className = 'lg:col-span-5 grid grid-cols-1 sm:grid-cols-2 gap-4 w-full items-start';

        const hasAlbums = albums && albums.length > 0;
        const hasPlaylists = playlists && playlists.length > 0;
        const hasArtists = artists && artists.length > 0;

        // A. Albums Bento Card (Top of right side, spans full width of right stack for wide breathing room)
        const albumsCol = document.createElement('div');
        albumsCol.className = 'sm:col-span-2 bg-white/85 backdrop-blur-xl rounded-3xl border border-zinc-200/80 p-3.5 sm:p-4 shadow-sm flex flex-col min-w-0 max-h-[270px] overflow-hidden';
        albumsCol.innerHTML = `
            <div class="flex items-center justify-between text-[11px] font-bold text-zinc-500 uppercase tracking-wider pb-2.5 mb-2.5 border-b border-zinc-100 shrink-0">
                <span class="flex items-center gap-1.5 text-zinc-900 font-extrabold">
                    <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"></circle><circle cx="12" cy="12" r="3"></circle></svg>
                    Albums (${albums ? albums.length : 0})
                </span>
                <button class="albums-all-btn text-zinc-500 hover:text-zinc-950 normal-case font-semibold text-xs transition-colors hover:underline cursor-pointer">Show all</button>
            </div>
            <div class="albums-scroll overflow-y-auto overflow-x-hidden pr-2 sleek-scrollbar flex flex-col gap-1.5 px-1 py-1"></div>
        `;
        const albumsScroll = albumsCol.querySelector('.albums-scroll');
        if (hasAlbums) {
            albums.forEach(album => {
                albumsScroll.appendChild(createSearchAlbumRow(album));
            });
        } else {
            albumsScroll.innerHTML = '<div class="py-5 text-center text-xs text-zinc-400 font-medium">No albums found</div>';
        }
        albumsCol.querySelector('.albums-all-btn').onclick = () => {
            currentSearchTab = 'albums';
            updateSearchTabsUI();
            renderSearchResults();
        };
        rightBento.appendChild(albumsCol);

        // B. Playlists Bento Card
        const playlistsCol = document.createElement('div');
        const playlistsSpanClass = (!hasArtists && hasPlaylists) ? 'sm:col-span-2' : 'sm:col-span-1';
        playlistsCol.className = `${playlistsSpanClass} bg-white/85 backdrop-blur-xl rounded-3xl border border-zinc-200/80 p-3.5 sm:p-4 shadow-sm flex flex-col min-w-0 max-h-[270px] overflow-hidden`;
        playlistsCol.innerHTML = `
            <div class="flex items-center justify-between text-[11px] font-bold text-zinc-500 uppercase tracking-wider pb-2.5 mb-2.5 border-b border-zinc-100 shrink-0">
                <span class="flex items-center gap-1.5 text-zinc-900 font-extrabold truncate">
                    <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" class="shrink-0"><path d="M21 15V6M18.5 18a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM12 12H3M16 6H3M12 18H3"></path></svg>
                    Playlists (${playlists ? playlists.length : 0})
                </span>
                <button class="playlists-all-btn text-zinc-500 hover:text-zinc-950 normal-case font-semibold text-xs transition-colors hover:underline cursor-pointer shrink-0">All</button>
            </div>
            <div class="playlists-scroll overflow-y-auto overflow-x-hidden pr-2 sleek-scrollbar flex flex-col gap-1.5 px-1 py-1"></div>
        `;
        const playlistsScroll = playlistsCol.querySelector('.playlists-scroll');
        if (hasPlaylists) {
            playlists.forEach(pl => {
                playlistsScroll.appendChild(createSearchPlaylistRow(pl));
            });
        } else {
            playlistsScroll.innerHTML = '<div class="py-5 text-center text-xs text-zinc-400 font-medium">No playlists found</div>';
        }
        playlistsCol.querySelector('.playlists-all-btn').onclick = () => {
            currentSearchTab = 'playlists';
            updateSearchTabsUI();
            renderSearchResults();
        };
        rightBento.appendChild(playlistsCol);

        // C. Artists Bento Card
        const artistsCol = document.createElement('div');
        const artistsSpanClass = (!hasPlaylists && hasArtists) ? 'sm:col-span-2' : 'sm:col-span-1';
        artistsCol.className = `${artistsSpanClass} bg-white/85 backdrop-blur-xl rounded-3xl border border-zinc-200/80 p-3.5 sm:p-4 shadow-sm flex flex-col min-w-0 max-h-[270px] overflow-hidden`;
        artistsCol.innerHTML = `
            <div class="flex items-center justify-between text-[11px] font-bold text-zinc-500 uppercase tracking-wider pb-2.5 mb-2.5 border-b border-zinc-100 shrink-0">
                <span class="flex items-center gap-1.5 text-zinc-900 font-extrabold truncate">
                    <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" class="shrink-0"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>
                    Artists (${artists ? artists.length : 0})
                </span>
                <button class="artists-all-btn text-zinc-500 hover:text-zinc-950 normal-case font-semibold text-xs transition-colors hover:underline cursor-pointer shrink-0">All</button>
            </div>
            <div class="artists-scroll overflow-y-auto overflow-x-hidden pr-2 sleek-scrollbar flex flex-col gap-1.5 px-1 py-1"></div>
        `;
        const artistsScroll = artistsCol.querySelector('.artists-scroll');
        if (hasArtists) {
            artists.forEach(artist => {
                artistsScroll.appendChild(createSearchArtistRow(artist));
            });
        } else {
            artistsScroll.innerHTML = '<div class="py-5 text-center text-xs text-zinc-400 font-medium">No artists found</div>';
        }
        artistsCol.querySelector('.artists-all-btn').onclick = () => {
            currentSearchTab = 'artists';
            updateSearchTabsUI();
            renderSearchResults();
        };
        rightBento.appendChild(artistsCol);

        bentoGrid.appendChild(rightBento);
        searchResults.appendChild(bentoGrid);
    }

    function renderSearchSongsTab(tracks) {
        if (!tracks || tracks.length === 0) {
            searchResults.innerHTML = '<div class="text-xs text-zinc-400 pl-5 py-4">No songs found.</div>';
            return;
        }
        const hdr = document.createElement('div');
        hdr.className = 'text-[11px] font-semibold text-zinc-400 uppercase tracking-widest text-left w-full mb-2 pl-2';
        hdr.textContent = `Songs (${tracks.length})`;
        searchResults.appendChild(hdr);

        tracks.forEach((track, idx) => {
            const el = createTrackElement(track, () => {
                currentQueue = tracks;
                currentQueueIndex = idx;
                currentPlaylistContextId = null;
                currentPlayingPlaylistContextId = null;
                playTrack(track);
            });
            searchResults.appendChild(el);
        });
    }

    function renderSearchAlbumsTab(albums) {
        if (!albums || albums.length === 0) {
            searchResults.innerHTML = '<div class="text-xs text-zinc-400 pl-5 py-4">No albums found.</div>';
            return;
        }
        const hdr = document.createElement('div');
        hdr.className = 'text-[11px] font-semibold text-zinc-400 uppercase tracking-widest text-left w-full mb-3 pl-2';
        hdr.textContent = `Albums (${albums.length})`;
        searchResults.appendChild(hdr);

        const grid = document.createElement('div');
        grid.className = 'grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3.5';
        albums.forEach(album => grid.appendChild(createAlbumCard(album)));
        searchResults.appendChild(grid);
    }

    function renderSearchArtistsTab(artists) {
        if (!artists || artists.length === 0) {
            searchResults.innerHTML = '<div class="text-xs text-zinc-400 pl-5 py-4">No artists found.</div>';
            return;
        }
        const hdr = document.createElement('div');
        hdr.className = 'text-[11px] font-semibold text-zinc-400 uppercase tracking-widest text-left w-full mb-3 pl-2';
        hdr.textContent = `Artists (${artists.length})`;
        searchResults.appendChild(hdr);

        const grid = document.createElement('div');
        grid.className = 'grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3.5';
        artists.forEach(artist => grid.appendChild(createArtistCard(artist)));
        searchResults.appendChild(grid);
    }

    function renderSearchPlaylistsTab(playlists) {
        if (!playlists || playlists.length === 0) {
            searchResults.innerHTML = '<div class="text-xs text-zinc-400 pl-5 py-4">No playlists found.</div>';
            return;
        }
        const hdr = document.createElement('div');
        hdr.className = 'text-[11px] font-semibold text-zinc-400 uppercase tracking-widest text-left w-full mb-3 pl-2';
        hdr.textContent = `Playlists (${playlists.length})`;
        searchResults.appendChild(hdr);

        const grid = document.createElement('div');
        grid.className = 'grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3.5';
        playlists.forEach(pl => grid.appendChild(createPlaylistCard(pl)));
        searchResults.appendChild(grid);
    }

    function createAlbumCard(album) {
        const card = document.createElement('div');
        card.className = 'group p-3 rounded-2xl bg-white/90 backdrop-blur-sm border border-zinc-200/70 hover:border-zinc-300 hover:shadow-md transition-all cursor-pointer bubbly-hover flex flex-col';
        const artwork = getProxyUrl(album.artwork_url, '300x300');
        card.innerHTML = `
            <div class="w-full aspect-square bg-zinc-100 rounded-xl overflow-hidden relative border border-zinc-200/50 mb-2.5 flex items-center justify-center shadow-sm">
                ${artwork ? `<img src="${artwork}" alt="${escapeHtml(album.name)}" class="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300" referrerpolicy="no-referrer">` : `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" class="text-zinc-400"><circle cx="12" cy="12" r="10"></circle><circle cx="12" cy="12" r="3"></circle></svg>`}
                <div class="absolute inset-0 bg-black/20 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                    <div class="w-10 h-10 rounded-full bg-zinc-900 text-white flex items-center justify-center shadow-lg">
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="white" stroke="white" stroke-width="1" class="ml-0.5"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
                    </div>
                </div>
            </div>
            <span class="font-bold text-zinc-900 text-xs sm:text-sm truncate w-full text-left">${escapeHtml(album.name)}</span>
            <span class="text-[11px] text-zinc-500 truncate w-full text-left mt-0.5">${escapeHtml(album.artist_name || 'Album')}</span>
        `;
        card.addEventListener('click', () => {
            if (typeof window.loadAlbumView === 'function') {
                window.loadAlbumView(album.id);
            }
        });
        return card;
    }

    function createArtistCard(artist) {
        const card = document.createElement('div');
        card.className = 'group p-3 rounded-2xl bg-white/90 backdrop-blur-sm border border-zinc-200/70 hover:border-zinc-300 hover:shadow-md transition-all cursor-pointer bubbly-hover flex flex-col items-center text-center';
        const artwork = getProxyUrl(artist.artwork_url, '300x300');
        card.innerHTML = `
            <div class="w-20 h-20 sm:w-24 sm:h-24 bg-zinc-100 rounded-full overflow-hidden relative border border-zinc-200/50 mb-2.5 flex items-center justify-center shadow-sm">
                ${artwork ? `<img src="${artwork}" alt="${escapeHtml(artist.name)}" class="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300" referrerpolicy="no-referrer">` : `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" class="text-zinc-400"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>`}
            </div>
            <span class="font-bold text-zinc-900 text-xs sm:text-sm truncate w-full">${escapeHtml(artist.name)}</span>
            <span class="text-[10px] uppercase font-bold text-blue-600 bg-blue-50 px-2 py-0.5 rounded-full mt-1 border border-blue-200/50">Artist</span>
        `;
        if (artist.artwork_url) {
            artistPfpMap.set(artist.name.toLowerCase().trim(), artist.artwork_url);
        }
        card.addEventListener('click', () => {
            if (typeof window.loadArtistView === 'function') {
                window.loadArtistView(artist.name, artist.artwork_url);
            }
        });
        return card;
    }

    function createPlaylistCard(playlist) {
        const card = document.createElement('div');
        card.className = 'group p-3 rounded-2xl bg-white/90 backdrop-blur-sm border border-zinc-200/70 hover:border-zinc-300 hover:shadow-md transition-all cursor-pointer bubbly-hover flex flex-col';
        const artwork = getProxyUrl(playlist.artwork_url, '300x300');
        card.innerHTML = `
            <div class="w-full aspect-square bg-zinc-100 rounded-xl overflow-hidden relative border border-zinc-200/50 mb-2.5 flex items-center justify-center shadow-sm">
                ${artwork ? `<img src="${artwork}" alt="${escapeHtml(playlist.name)}" class="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300" referrerpolicy="no-referrer">` : `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" class="text-zinc-400"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg>`}
                <div class="absolute inset-0 bg-black/20 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                    <div class="w-10 h-10 rounded-full bg-zinc-900 text-white flex items-center justify-center shadow-lg">
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="white" stroke="white" stroke-width="1" class="ml-0.5"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
                    </div>
                </div>
            </div>
            <span class="font-bold text-zinc-900 text-xs sm:text-sm truncate w-full text-left">${escapeHtml(playlist.name)}</span>
            <span class="text-[11px] text-zinc-500 truncate w-full text-left mt-0.5">${playlist.song_count ? `${playlist.song_count} songs` : 'Playlist'}</span>
        `;
        card.addEventListener('click', async () => {
            showSpinner(true);
            try {
                const res = await fetch(`${API_BASE}?endpoint=playlist&id=${encodeURIComponent((playlist.id || '').replace('ytm-', ''))}`);
                const data = await res.json();
                if (data && Array.isArray(data.tracks) && data.tracks.length > 0) {
                    currentQueue = data.tracks;
                    currentQueueIndex = 0;
                    currentPlayingPlaylistContextId = null;
                    playTrack(data.tracks[0]);
                } else {
                    showToast('Unable to load playlist tracks');
                }
            } catch (_) {
                showToast('Failed to load playlist');
            } finally {
                showSpinner(false);
            }
        });
        return card;
    }

    // Pointer/Touch Reordering Helper for Playlists & Up Next Queue
    function enableListReordering(containerEl, onReorder) {
        if (!containerEl || typeof onReorder !== 'function') return;
        let dragRow = null;
        let startIdx = -1;
        let currentIdx = -1;
        let activePointerId = null;

        const getRows = () => Array.from(containerEl.querySelectorAll(':scope > [data-reorder-item="true"]'));

        containerEl.addEventListener('pointerdown', (e) => {
            const handle = e.target.closest('.reorder-grip-handle');
            if (!handle) return;
            const row = handle.closest('[data-reorder-item="true"]');
            if (!row || !containerEl.contains(row)) return;

            e.preventDefault();
            e.stopPropagation();

            const rows = getRows();
            startIdx = rows.indexOf(row);
            if (startIdx < 0) return;

            currentIdx = startIdx;
            dragRow = row;
            activePointerId = e.pointerId;
            dragRow.classList.add('dragging-reorder-row');
            triggerHaptic('medium');

            try {
                handle.setPointerCapture(e.pointerId);
            } catch (_) {}

            const onPointerMove = (moveEv) => {
                if (!dragRow || moveEv.pointerId !== activePointerId) return;
                moveEv.preventDefault();
                const allRows = getRows();
                const y = moveEv.clientY;

                for (let i = 0; i < allRows.length; i++) {
                    const sibling = allRows[i];
                    if (sibling === dragRow) continue;
                    const rect = sibling.getBoundingClientRect();
                    const midY = rect.top + rect.height / 2;
                    if (y >= rect.top && y <= rect.bottom) {
                        if (i < currentIdx && y < midY) {
                            containerEl.insertBefore(dragRow, sibling);
                            currentIdx = getRows().indexOf(dragRow);
                            triggerHaptic('selection');
                        } else if (i > currentIdx && y > midY) {
                            containerEl.insertBefore(dragRow, sibling.nextSibling);
                            currentIdx = getRows().indexOf(dragRow);
                            triggerHaptic('selection');
                        }
                        break;
                    }
                }
            };

            const finishDrag = (endEv) => {
                if (!dragRow || (endEv && endEv.pointerId !== undefined && endEv.pointerId !== activePointerId)) return;
                window.removeEventListener('pointermove', onPointerMove);
                window.removeEventListener('pointerup', finishDrag);
                window.removeEventListener('pointercancel', finishDrag);
                try {
                    handle.releasePointerCapture(activePointerId);
                } catch (_) {}

                const finalRows = getRows();
                const finalIdx = finalRows.indexOf(dragRow);
                dragRow.classList.remove('dragging-reorder-row');
                const from = startIdx;
                const to = finalIdx;
                dragRow = null;
                startIdx = -1;
                currentIdx = -1;
                activePointerId = null;

                if (from >= 0 && to >= 0 && from !== to) {
                    triggerHaptic('medium');
                    onReorder(from, to);
                }
            };

            window.addEventListener('pointermove', onPointerMove, { passive: false });
            window.addEventListener('pointerup', finishDrag);
            window.addEventListener('pointercancel', finishDrag);
        });
    }

    // Touch Swipe Gestures on Song Rows: Swipe Right -> Add to Queue, Swipe Left -> Favorite
    function attachSongRowSwipeGestures(rowEl, track, getFavSvg) {
        if (!rowEl || !track) return;
        let touchStartX = 0;
        let touchStartY = 0;
        let currentDx = 0;
        let isSwipingRow = false;
        let swipeLockedOut = false;
        let thresholdCrossed = false;
        let badgeEl = null;

        rowEl.addEventListener('touchstart', (e) => {
            if (e.touches.length !== 1) return;
            if (e.target.closest('.reorder-grip-handle') || e.target.closest('button')) {
                swipeLockedOut = true;
                return;
            }
            swipeLockedOut = false;
            isSwipingRow = false;
            thresholdCrossed = false;
            currentDx = 0;
            touchStartX = e.touches[0].clientX;
            touchStartY = e.touches[0].clientY;
        }, { passive: true });

        rowEl.addEventListener('touchmove', (e) => {
            if (swipeLockedOut || e.touches.length !== 1) return;
            const dx = e.touches[0].clientX - touchStartX;
            const dy = e.touches[0].clientY - touchStartY;

            if (!isSwipingRow) {
                if (Math.abs(dy) > 14 && Math.abs(dy) >= Math.abs(dx)) {
                    swipeLockedOut = true;
                    return;
                }
                if (Math.abs(dx) > 18 && Math.abs(dx) > Math.abs(dy) * 1.65) {
                    isSwipingRow = true;
                    rowEl.style.transition = 'none';
                    rowEl.style.position = 'relative';
                    if (!badgeEl) {
                        badgeEl = document.createElement('div');
                        badgeEl.className = 'pointer-events-none absolute top-1/2 -translate-y-1/2 px-2.5 py-1 rounded-full text-[10px] font-extrabold uppercase tracking-wider shadow-sm z-20 transition-opacity duration-150';
                        rowEl.appendChild(badgeEl);
                    }
                } else {
                    return;
                }
            }

            currentDx = Math.max(-84, Math.min(84, dx * 0.68));
            rowEl.style.transform = `translateX(${currentDx}px)`;

            if (badgeEl) {
                if (currentDx > 12) {
                    badgeEl.textContent = '＋ Queue';
                    badgeEl.style.left = '10px';
                    badgeEl.style.right = 'auto';
                    badgeEl.style.backgroundColor = '#FDE047';
                    badgeEl.style.color = '#18181b';
                    badgeEl.style.opacity = String(Math.min(1, (currentDx - 12) / 42));
                } else if (currentDx < -12) {
                    const favNow = isFavorite(track.id);
                    badgeEl.textContent = favNow ? '♡ Unfavorite' : '♥ Favorite';
                    badgeEl.style.right = '10px';
                    badgeEl.style.left = 'auto';
                    badgeEl.style.backgroundColor = '#18181b';
                    badgeEl.style.color = '#ffffff';
                    badgeEl.style.opacity = String(Math.min(1, (Math.abs(currentDx) - 12) / 42));
                } else {
                    badgeEl.style.opacity = '0';
                }
            }

            const overThreshold = Math.abs(currentDx) >= 54;
            if (overThreshold && !thresholdCrossed) {
                thresholdCrossed = true;
                triggerHaptic('selection');
            } else if (!overThreshold && thresholdCrossed) {
                thresholdCrossed = false;
            }
        }, { passive: true });

        const finishRowSwipe = () => {
            if (!isSwipingRow) return;
            const finalDx = currentDx;
            isSwipingRow = false;
            currentDx = 0;
            rowEl.style.transition = 'transform 0.28s cubic-bezier(0.16, 1, 0.3, 1)';
            rowEl.style.transform = '';
            if (badgeEl) {
                badgeEl.style.opacity = '0';
                setTimeout(() => {
                    if (badgeEl && badgeEl.parentNode) badgeEl.parentNode.removeChild(badgeEl);
                    badgeEl = null;
                }, 220);
            }

            if (finalDx >= 54) {
                rowEl._suppressNextClick = true;
                setTimeout(() => { rowEl._suppressNextClick = false; }, 320);
                triggerHaptic('medium');
                addToQueue(track);
            } else if (finalDx <= -54) {
                rowEl._suppressNextClick = true;
                setTimeout(() => { rowEl._suppressNextClick = false; }, 320);
                const svg = typeof getFavSvg === 'function' ? getFavSvg() : null;
                toggleFavorite(track, svg);
            }
        };

        rowEl.addEventListener('touchend', finishRowSwipe, { passive: true });
        rowEl.addEventListener('touchcancel', finishRowSwipe, { passive: true });
    }

    // Creates track list item with Play, Add to Playlist, and Favorite buttons (compact desktop 16:9 ratio fit)
    function createTrackElement(track, onPlayClick, onRemoveClick = null, options = {}) {
        const div = document.createElement('div');
        div.className = 'group flex items-center justify-between p-2 sm:p-2.5 rounded-xl song-row-card mb-1.5 w-full max-w-full box-border cursor-pointer select-none';
        if (options && options.reorderable) {
            div.setAttribute('data-reorder-item', 'true');
        }
        
        const artwork = getProxyUrl(track.artwork_url || track.image, '50x50');
        const title = track.title || track.name || 'Unknown Title';
        const artist = track.artist_name || track.artist || 'Unknown Artist';
        const durStr = track.duration ? formatTime(track.duration > 1000 ? track.duration / 1000 : track.duration) : '';

        div.innerHTML = `
            <div class="flex items-center gap-2.5 min-w-0 flex-1 mr-2 overflow-hidden">
                ${options && options.reorderable ? `
                <button type="button" class="reorder-grip-handle text-zinc-400 hover:text-zinc-800 p-1 -ml-1 rounded-lg cursor-grab active:cursor-grabbing shrink-0 flex items-center justify-center" title="Drag to reorder">
                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="5" r="1"></circle><circle cx="9" cy="12" r="1"></circle><circle cx="9" cy="19" r="1"></circle><circle cx="15" cy="5" r="1"></circle><circle cx="15" cy="12" r="1"></circle><circle cx="15" cy="19" r="1"></circle></svg>
                </button>
                ` : ''}
                <div class="w-9 h-9 sm:w-10 sm:h-10 bg-zinc-100 rounded-lg overflow-hidden shrink-0 relative border border-zinc-200/60 shadow-2xs flex items-center justify-center">
                    ${artwork ? `<img src="${artwork}" alt="${escapeHtml(title)}" class="w-full h-full object-cover" referrerpolicy="no-referrer" onerror="this.style.display='none'; if (this.nextElementSibling) this.nextElementSibling.classList.remove('hidden');">` : ''}
                    <div class="artwork-fallback ${artwork ? 'hidden' : ''} text-zinc-400 flex items-center justify-center">
                        <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg>
                    </div>
                    <div class="absolute inset-0 bg-black/25 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity backdrop-blur-[1px]">
                        <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="white" stroke="white" stroke-width="1" class="ml-0.5"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
                    </div>
                </div>
                <div class="flex flex-col text-left min-w-0 flex-1 overflow-hidden">
                    <span class="font-bold text-zinc-900 text-xs sm:text-[13px] truncate block max-w-full" title="${escapeHtml(title)}">${escapeHtml(title)}</span>
                    <span class="artist-name-link text-[11px] text-zinc-500 hover:text-zinc-950 font-medium hover:underline cursor-pointer truncate block max-w-full transition-colors inline-block w-fit" title="View artist">${escapeHtml(artist)}</span>
                </div>
            </div>
            <div class="flex items-center gap-1 shrink-0">
                ${durStr ? `<span class="text-[11px] text-zinc-400 font-semibold mr-1.5 hidden sm:inline">${durStr}</span>` : ''}
                <button class="download-track-btn text-zinc-400 hover:text-zinc-900 transition-colors p-1.5 rounded-full hover:bg-zinc-100 cursor-pointer" title="Download offline">
                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
                </button>
                <button class="add-to-queue-btn text-zinc-400 hover:text-zinc-900 transition-colors p-1.5 rounded-full hover:bg-zinc-100 cursor-pointer" title="Add to Queue">
                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"></line><line x1="8" y1="12" x2="21" y2="12"></line><line x1="8" y1="18" x2="16" y2="18"></line><line x1="3" y1="6" x2="3.01" y2="6"></line><line x1="3" y1="12" x2="3.01" y2="12"></line><line x1="3" y1="18" x2="3.01" y2="18"></line></svg>
                </button>
                <button class="add-to-pl-btn text-zinc-400 hover:text-zinc-900 transition-colors p-1.5 rounded-full hover:bg-zinc-100 cursor-pointer" title="Add to Playlist">
                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"></path></svg>
                </button>
                <button class="favorite-btn text-zinc-900 hover:scale-110 transition-transform p-1.5 rounded-full hover:bg-zinc-100 cursor-pointer" title="Favorite">
                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="${isFavorite(track.id) ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg>
                </button>
                ${onRemoveClick ? `
                <button class="remove-btn text-zinc-400 hover:text-red-500 transition-colors p-1.5 rounded-full hover:bg-red-50 cursor-pointer" title="Remove from playlist">
                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                </button>
                ` : ''}
            </div>
        `;

        div.addEventListener('click', (e) => {
            if (div._suppressNextClick) return;
            if (e.target.closest('.artist-name-link')) {
                e.stopPropagation();
                if (typeof window.loadArtistView === 'function') {
                    window.loadArtistView(artist);
                }
                return;
            }
            if (!e.target.closest('button')) {
                if (onPlayClick) onPlayClick();
            }
        });

        const favBtn = div.querySelector('.favorite-btn');
        favBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleFavorite(track, favBtn.querySelector('svg'));
        });

        attachSongRowSwipeGestures(div, track, () => favBtn ? favBtn.querySelector('svg') : null);

        const addPlBtn = div.querySelector('.add-to-pl-btn');
        addPlBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            openAddToPlaylistModal(track);
        });

        const dlBtn = div.querySelector('.download-track-btn');
        if (dlBtn) {
            wireTrackDownloadBtn(dlBtn, track);
        }

        const addQueueBtn = div.querySelector('.add-to-queue-btn');
        if (addQueueBtn) {
            addQueueBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                addToQueue(track);
            });
        }

        if (onRemoveClick) {
            const removeBtn = div.querySelector('.remove-btn');
            removeBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                onRemoveClick();
            });
        }

        return div;
    }

    // Progress UI Update Helper
    function updateProgressUI(cur, dur) {
        const percent = (dur > 0) ? Math.min(100, Math.max(0, (cur / dur) * 100)) : 0;
        if (npProgressFill) npProgressFill.style.width = `${percent}%`;
        if (bpProgressFill) bpProgressFill.style.width = `${percent}%`;

        if (npCurrentTime) npCurrentTime.textContent = formatTime(cur);
        if (bpCurrentTime) bpCurrentTime.textContent = formatTime(cur);

        if (npDuration && dur > 0) npDuration.textContent = formatTime(dur);
        if (bpDuration && dur > 0) bpDuration.textContent = formatTime(dur);
    }

    // YouTube Player Engine (Fallback from pinpoint-edu)
    function stopYouTubeProgress() {
        if (ytProgressInterval) {
            clearInterval(ytProgressInterval);
            ytProgressInterval = null;
        }
    }

    function startYouTubeProgress() {
        stopYouTubeProgress();
        ytProgressInterval = setInterval(() => {
            if (activeSource === 'youtube' && ytPlayer && typeof ytPlayer.getCurrentTime === 'function') {
                const cur = ytPlayer.getCurrentTime() || 0;
                let dur = (typeof ytPlayer.getDuration === 'function') ? ytPlayer.getDuration() : 0;
                if (!dur || dur <= 0) {
                    if (currentTrack && currentTrack.duration) {
                        dur = currentTrack.duration > 1000 ? currentTrack.duration / 1000 : currentTrack.duration;
                    }
                }
                updateProgressUI(cur, dur);
                updateLyricsSync(cur);
            }
        }, 250);
    }

    let pendingVideoId = null;

    function initYouTubeAPI() {
        if (window.YT && window.YT.Player) return;
        if (!document.querySelector('script[src*="iframe_api"]')) {
            const tag = document.createElement('script');
            tag.src = "https://www.youtube.com/iframe_api";
            document.head.appendChild(tag);
        }
    }
    initYouTubeAPI();

    window.onYouTubeIframeAPIReady = () => {
        if (pendingVideoId) {
            const vid = pendingVideoId;
            pendingVideoId = null;
            loadYouTubePlayer(vid);
        }
    };

    function loadYouTubePlayer(videoId) {
        if (!videoId) {
            showSpinner(false);
            return;
        }
        activeSource = 'youtube';
        try {
            currentAudio.pause();
            currentAudio.removeAttribute('src');
            currentAudio.load();
        } catch (_) {}

        if (!window.YT || !window.YT.Player) {
            pendingVideoId = videoId;
            initYouTubeAPI();
            return;
        }

        if (ytPlayer && typeof ytPlayer.loadVideoById === 'function') {
            try {
                ytPlayer.loadVideoById(videoId);
                ytPlayer.playVideo();
                showSpinner(false);
                return;
            } catch (err) {
                console.warn('loadVideoById failed, recreating player:', err);
                ytPlayer = null;
            }
        }

        const playerVars = {
            autoplay: 1,
            controls: 0,
            disablekb: 1,
            fs: 0,
            rel: 0,
            modestbranding: 1,
            playsinline: 1,
            enablejsapi: 1
        };
        if (window.location.protocol.startsWith('http') && window.location.hostname !== 'localhost') {
            playerVars.origin = window.location.origin;
        }

        try {
            ytPlayer = new YT.Player('youtubePlayer', {
                height: '200',
                width: '200',
                videoId: videoId,
                playerVars: playerVars,
                events: {
                    onReady: (e) => {
                        try {
                            e.target.setVolume(Math.round(currentVolume * 100));
                            e.target.playVideo();
                        } catch (_) {}
                        showSpinner(false);
                    },
                    onStateChange: (event) => {
                        if (event.data === YT.PlayerState.PLAYING) {
                            isPlaying = true;
                            showSpinner(false);
                            updatePlayPauseButtons();
                            startYouTubeProgress();
                            if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
                            if (document.body.getAttribute('data-page') !== 'now-playing') {
                                bottomPlayer.classList.remove('hidden-force');
                            }
                        } else if (event.data === YT.PlayerState.PAUSED) {
                            isPlaying = false;
                            updatePlayPauseButtons();
                            stopYouTubeProgress();
                            if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
                        } else if (event.data === YT.PlayerState.ENDED) {
                            stopYouTubeProgress();
                            playNext();
                        } else if (event.data === YT.PlayerState.BUFFERING) {
                            showSpinner(true);
                        }
                    },
                    onError: (err) => {
                        console.warn('YouTube playback error:', err);
                        showSpinner(false);
                        const errCode = err?.data;
                        if (errCode === 150 || errCode === 101) {
                            showToast('Track embed restricted. Playing next track…');
                            playNext();
                        }
                    }
                }
            });
        } catch (err) {
            console.warn('YT.Player init error:', err);
            showSpinner(false);
        }
    }

    let crossfadeSeconds = Math.max(0, Math.min(12, parseInt(localStorage.getItem('yolk_crossfade_sec') || '0', 10) || 0));
    let _crossfadeFadeInTimer = null;

    function clearCrossfadeTimers() {
        if (_crossfadeFadeInTimer) {
            clearInterval(_crossfadeFadeInTimer);
            _crossfadeFadeInTimer = null;
        }
        try {
            if (preloadedNextAudio && !preloadedNextAudio.paused) {
                preloadedNextAudio.pause();
                preloadedNextAudio.currentTime = 0;
            }
        } catch (_) {}
    }

    function loadDirectAudioPlayer(streamUrl) {
        activeSource = 'audio';
        const shouldCrossfadeIn = Boolean(crossfadeSeconds > 0 && currentAudio._didCrossfadeOut);
        currentAudio._didCrossfadeOut = false;
        clearCrossfadeTimers();

        if (ytPlayer && typeof ytPlayer.stopVideo === 'function') {
            try { ytPlayer.stopVideo(); } catch (_) {}
        }
        currentAudio.pause();
        currentAudio.removeAttribute('src');
        currentAudio.load();
        currentAudio._recovering = false;
        currentAudio.src = streamUrl;
        currentAudio.volume = shouldCrossfadeIn ? Math.max(0.05, currentVolume * 0.16) : currentVolume;
        currentAudio.load();
        const playPromise = currentAudio.play();
        if (playPromise !== undefined) {
            playPromise.then(() => {
                currentAudio._recovering = false;
                showSpinner(false);
                isPlaying = true;
                updatePlayPauseButtons();
                updateNowPlayingNavVisibility(true);
                if (shouldCrossfadeIn && crossfadeSeconds > 0) {
                    const rampMs = Math.min(crossfadeSeconds * 650, 3500);
                    const steps = 24;
                    const stepTime = Math.max(30, Math.round(rampMs / steps));
                    let step = 0;
                    _crossfadeFadeInTimer = setInterval(() => {
                        step++;
                        if (step >= steps || currentAudio.paused) {
                            currentAudio.volume = currentVolume;
                            clearInterval(_crossfadeFadeInTimer);
                            _crossfadeFadeInTimer = null;
                            return;
                        }
                        const ratio = step / steps;
                        currentAudio.volume = Math.min(1, Math.max(0, currentVolume * (0.16 + 0.84 * ratio)));
                    }, stepTime);
                } else {
                    currentAudio.volume = currentVolume;
                }
                if ('mediaSession' in navigator) {
                    navigator.mediaSession.playbackState = 'playing';
                    updateMediaSessionPosition();
                }
                if (document.body.getAttribute('data-page') !== 'now-playing') {
                    bottomPlayer.classList.remove('hidden-force');
                }
            }).catch(e => {
                currentAudio.volume = currentVolume;
                showSpinner(false);
                if (e.name !== 'AbortError') {
                    console.warn('Audio playback notice:', e.message);
                    // If error is NotSupportedError (unsupported codec on this device/browser), trigger immediate format recovery
                    if (e.name === 'NotSupportedError' && !currentAudio._recovering) {
                        currentAudio.dispatchEvent(new Event('error'));
                    }
                }
            });
        }
    }

    function updateNowPlayingNavVisibility(isVisible) {
        const npNav = document.getElementById('nav-now-playing');
        const bpNpNav = document.getElementById('bp-nav-now-playing');
        const shouldShow = Boolean(isVisible && currentTrack);
        [npNav, bpNpNav].forEach(el => {
            if (!el) return;
            if (shouldShow) {
                el.classList.remove('nav-hidden');
                el.classList.add('nav-visible');
            } else {
                el.classList.add('nav-hidden');
                el.classList.remove('nav-visible');
            }
        });
    }
    window.updateNowPlayingNavVisibility = updateNowPlayingNavVisibility;

    // Infinite Autoplay Up-Next Fetcher
    let isFetchingUpNext = false;
    async function fetchUpNextTracks(track) {
        if (!track || isFetchingUpNext) return;
        const rawId = track.youtube_id || (track.id && typeof track.id === 'string' ? track.id.replace('ytm-', '') : null);
        if (!rawId) return;

        isFetchingUpNext = true;
        try {
            const res = await fetch(`${API_BASE}?endpoint=up-next&id=${encodeURIComponent(rawId)}`);
            if (res.ok) {
                const data = await res.json();
                if (data && Array.isArray(data.tracks) && data.tracks.length > 0) {
                    const existingVids = new Set(currentQueue.map(t => t.youtube_id || t.id));
                    const newTracks = data.tracks.filter(t => !existingVids.has(t.youtube_id || t.id));
                    if (newTracks.length > 0) {
                        currentQueue.push(...newTracks);
                    }
                }
            }
        } catch (e) {
            console.warn('Error fetching up-next autoplay tracks:', e);
        } finally {
            isFetchingUpNext = false;
        }
    }

    function updateMediaSessionMetadata(track) {
        if (!('mediaSession' in navigator) || !track) return;
        const rawArtwork = getProxyUrl(track.artwork_url || track.image);
        let safeArtworkUrl = '';
        if (rawArtwork) {
            try {
                safeArtworkUrl = new URL(rawArtwork, window.location.href).href;
            } catch (_) {
                safeArtworkUrl = rawArtwork;
            }
        }

        try {
            navigator.mediaSession.metadata = new MediaMetadata({
                title: track.title || track.name || 'Unknown Title',
                artist: track.artist_name || track.artist || 'Unknown Artist',
                album: track.album_name || track.album || 'Yolk Music',
                artwork: safeArtworkUrl ? [
                    { src: safeArtworkUrl, sizes: '96x96' },
                    { src: safeArtworkUrl, sizes: '128x128' },
                    { src: safeArtworkUrl, sizes: '192x192' },
                    { src: safeArtworkUrl, sizes: '256x256' },
                    { src: safeArtworkUrl, sizes: '512x512' }
                ] : []
            });
        } catch (e) {
            console.warn('MediaMetadata warning:', e);
        }

        try {
            navigator.mediaSession.setActionHandler('play', () => togglePlayPause());
            navigator.mediaSession.setActionHandler('pause', () => togglePlayPause());
            navigator.mediaSession.setActionHandler('nexttrack', () => playNext());
            navigator.mediaSession.setActionHandler('previoustrack', () => playPrev());
            navigator.mediaSession.setActionHandler('seekto', (details) => {
                if (details.fastSeek && 'fastSeek' in currentAudio) {
                    currentAudio.fastSeek(details.seekTime);
                    return;
                }
                if (details.seekTime !== undefined && !isNaN(details.seekTime)) {
                    currentAudio.currentTime = details.seekTime;
                    updateMediaSessionPosition();
                }
            });
        } catch (err) {}
    }

    async function extractMp4MvhdDuration(blob) {
        try {
            if (!blob || typeof blob.slice !== 'function') return null;
            const buf = await blob.slice(0, 512).arrayBuffer();
            const view = new DataView(buf);
            const bytes = new Uint8Array(buf);
            for (let i = 0; i + 32 < bytes.length; i++) {
                // Look for 'mvhd' box signature (0x6d, 0x76, 0x68, 0x64)
                if (bytes[i] === 0x6d && bytes[i + 1] === 0x76 && bytes[i + 2] === 0x68 && bytes[i + 3] === 0x64) {
                    const version = bytes[i + 4];
                    if (version === 0 && i + 24 <= bytes.length) {
                        const timescale = view.getUint32(i + 16, false);
                        const duration = view.getUint32(i + 20, false);
                        if (timescale > 0 && duration > 0) {
                            return duration / timescale;
                        }
                    }
                    break;
                }
            }
        } catch (_) {}
        return null;
    }

    function getEffectiveAudioDuration() {
        const metaDur = currentTrack?.duration
            ? (currentTrack.duration > 1000 ? currentTrack.duration / 1000 : currentTrack.duration)
            : 0;
        const mvhdDur = (currentAudio && currentAudio._mvhdDuration > 0) ? currentAudio._mvhdDuration : 0;
        const rawDur = (currentAudio && isFinite(currentAudio.duration) && currentAudio.duration > 0)
            ? currentAudio.duration
            : 0;

        const refDur = mvhdDur || metaDur;
        if (rawDur > 0 && refDur > 10) {
            // Guard against 2x HE-AAC (mp4a.40.5) container duration doubling (adds 100% blank audio time at end)
            if (rawDur > refDur * 1.45 && Math.abs((rawDur / 2) - refDur) <= 18) {
                return mvhdDur || (rawDur / 2);
            }
            if (rawDur > refDur + 20) {
                return refDur;
            }
        }
        return rawDur || refDur || 0;
    }

    function updateMediaSessionPosition() {
        if ('mediaSession' in navigator && 'setPositionState' in navigator.mediaSession) {
            const effDur = getEffectiveAudioDuration();
            if (currentAudio && effDur > 0) {
                try {
                    const curPos = Math.max(0, Math.min(currentAudio.currentTime || 0, effDur));
                    navigator.mediaSession.setPositionState({
                        duration: effDur,
                        playbackRate: currentAudio.playbackRate || 1.0,
                        position: curPos
                    });
                } catch (e) {}
            }
        }
    }

    async function preloadNextQueueTrack() {
        if (!currentQueue || currentQueue.length === 0) return;
        const nextIdx = currentQueueIndex + 1;
        if (nextIdx < 0 || nextIdx >= currentQueue.length) return;
        const nextTrack = currentQueue[nextIdx];
        if (!nextTrack) return;
        const uid = getTrackUid(nextTrack);
        if (preloadedNextTrackUid === uid) return;

        try {
            const isOffline = await YolkOfflineDB.getTrack(uid);
            if (isOffline) {
                preloadedNextTrackUid = uid;
                return;
            }

            let videoId = getYoutubeIdSync(nextTrack);
            if (!videoId) {
                videoId = await getYoutubeId(nextTrack);
            }
            if (videoId) {
                const prefFormat = getSupportedAudioFormat();
                const streamUrl = `/api/music-api?endpoint=stream&id=${encodeURIComponent(videoId)}&format=${prefFormat}&v=2`;
                preloadedNextAudio.removeAttribute('src');
                preloadedNextAudio.src = streamUrl;
                preloadedNextAudio.load();
                preloadedNextTrackUid = uid;
            }
        } catch (_) {}
    }

    // Playback Execution
    async function playTrack(track) {
        if (!track) return;
        currentTrack = track;
        showSpinner(true);
        stopYouTubeProgress();
        currentAudio._recovering = false;
        currentAudio._mvhdDuration = 0;

        // Immediately update titles, covers, and fav status
        updateNowPlayingUI(track);
        updateBottomPlayerUI(track);
        updateNowPlayingFavButton();
        updateNowPlayingNavVisibility(true);
        if (typeof updateQueueModalUI === 'function') updateQueueModalUI();

        // Autoplay Preload: keep queue filled with continuous recommendations
        if (currentQueue.length <= 2 || currentQueueIndex >= currentQueue.length - 2) {
            fetchUpNextTracks(track);
        }

        // System Media Session Integration
        updateMediaSessionMetadata(track);

        // Fetch lyrics
        fetchLyrics(track);

        // 1. Check Offline Database FIRST (instantaneous playback, 0 network lag, works fully offline)
        const uid = getTrackUid(track);
        try {
            const offlineItem = await YolkOfflineDB.getTrack(uid);
            if (offlineItem && offlineItem.audioBlob) {
                if (offlineItem.artworkBlob) {
                    const localCoverUrl = URL.createObjectURL(offlineItem.artworkBlob);
                    track._offlineArtUrl = localCoverUrl;
                    const npImgEl = document.getElementById('now-playing-img');
                    const bpImgEl = document.getElementById('bottom-player-img');
                    const bgArtEl = document.getElementById('now-playing-bg-art');
                    const bpPlEl = document.getElementById('bottom-player-placeholder');
                    if (npImgEl) {
                        npImgEl.src = localCoverUrl;
                        npImgEl.classList.remove('hidden');
                    }
                    if (bpImgEl) {
                        bpImgEl.src = localCoverUrl;
                        bpImgEl.classList.remove('hidden');
                    }
                    if (bpPlEl) bpPlEl.classList.add('hidden');
                    if (bgArtEl) {
                        bgArtEl.src = localCoverUrl;
                        bgArtEl.style.opacity = '1';
                    }
                    extractArtworkPalette(localCoverUrl, (colors) => {
                        applyAppleMusicNowPlayingBg(colors);
                    });
                }
                if (offlineItem.lyrics) {
                    currentLyricsTrackId = uid;
                    renderLyricsToUI(offlineItem.lyrics, uid);
                }
                const mvhdDur = await extractMp4MvhdDuration(offlineItem.audioBlob);
                if (mvhdDur && mvhdDur > 0) {
                    currentAudio._mvhdDuration = mvhdDur;
                }
                const objectUrl = URL.createObjectURL(offlineItem.audioBlob);
                loadDirectAudioPlayer(objectUrl);
                preloadNextQueueTrack();
                return;
            }
        } catch (_) {}

        if (typeof navigator !== 'undefined' && navigator.onLine === false) {
            showSpinner(false);
            showToast('⚠️ Offline: This track is not downloaded.');
            return;
        }

        // 2. Synchronous fast-path: if video ID is already known on track, start playback immediately
        const syncVideoId = getYoutubeIdSync(track);
        if (syncVideoId) {
            const prefFormat = getSupportedAudioFormat();
            currentAudio._activeFormat = prefFormat;
            currentAudio._activeVideoId = syncVideoId;
            currentAudio._recovering = false;
            const streamUrl = `/api/music-api?endpoint=stream&id=${encodeURIComponent(syncVideoId)}&format=${prefFormat}&v=2`;
            loadDirectAudioPlayer(streamUrl);
            preloadNextQueueTrack();
            return;
        }

        // 3. Asynchronous fallback resolution
        const videoId = await getYoutubeId(track);
        if (videoId) {
            const prefFormat = getSupportedAudioFormat();
            currentAudio._activeFormat = prefFormat;
            currentAudio._activeVideoId = videoId;
            currentAudio._recovering = false;
            const streamUrl = `/api/music-api?endpoint=stream&id=${encodeURIComponent(videoId)}&format=${prefFormat}&v=2`;
            loadDirectAudioPlayer(streamUrl);
            preloadNextQueueTrack();
            return;
        }

        let streamUrl = getDownloadUrl(track);
        if (streamUrl) {
            loadDirectAudioPlayer(streamUrl);
            preloadNextQueueTrack();
            return;
        }

        showSpinner(false);
        showToast('Unable to resolve stream for this track.');
    }

    // Audio Event Handlers
    currentAudio.addEventListener('canplay', () => {
        showSpinner(false);
        updateMediaSessionPosition();
        if (document.body.getAttribute('data-page') !== 'now-playing') {
            bottomPlayer.classList.remove('hidden-force');
        }
    });

    currentAudio.addEventListener('loadedmetadata', () => {
        updateMediaSessionPosition();
    });

    currentAudio.addEventListener('seeked', () => {
        updateMediaSessionPosition();
    });

    currentAudio.addEventListener('waiting', () => showSpinner(true));
    currentAudio.addEventListener('playing', () => {
        showSpinner(false);
        isPlaying = true;
        updatePlayPauseButtons();
        updateMediaSessionPosition();
        if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
        if (document.body.getAttribute('data-page') !== 'now-playing') {
            bottomPlayer.classList.remove('hidden-force');
        }
    });
    currentAudio.addEventListener('pause', () => {
        isPlaying = false;
        updatePlayPauseButtons();
        updateMediaSessionPosition();
        if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
    });

    currentAudio.addEventListener('ended', () => {
        if (activeSource === 'audio') {
            playNext();
        }
    });

    currentAudio.addEventListener('error', async () => {
        // Do nothing if audio is not active or if src is empty/null/cleared
        if (activeSource !== 'audio' || !currentAudio.src || currentAudio.src === window.location.href) {
            currentAudio._recovering = false;
            return;
        }
        showSpinner(false);
        if (currentTrack && !currentAudio._recovering) {
            currentAudio._recovering = true;
            try {
                const videoId = await getYoutubeId(currentTrack);
                if (videoId) {
                    // Swap to alternative codec (MP4 <-> WebM) to seamlessly recover on machines lacking proprietary codecs (like older Windows/Opera)
                    const currentFmt = currentAudio._activeFormat || (currentAudio.src.includes('format=webm') ? 'webm' : 'mp4');
                    const altFmt = currentFmt === 'mp4' ? 'webm' : 'mp4';
                    currentAudio._activeFormat = altFmt;
                    const retryUrl = `/api/music-api?endpoint=stream&id=${encodeURIComponent(videoId)}&format=${altFmt}&_t=${Date.now()}`;
                    currentAudio.pause();
                    currentAudio.removeAttribute('src');
                    currentAudio.load();
                    currentAudio.src = retryUrl;
                    currentAudio.load();
                    try {
                        await currentAudio.play();
                        currentAudio._recovering = false;
                        return;
                    } catch (playErr) {
                        // Try alternative video ID if available
                        try {
                            const searchQ = `${currentTrack.title || ''} ${currentTrack.artist_name || ''}`.trim();
                            if (searchQ) {
                                const searchRes = await fetch(`/api/music-api?endpoint=search&q=${encodeURIComponent(searchQ)}&limit=5`);
                                if (searchRes.ok) {
                                    const searchData = await searchRes.json();
                                    const items = Array.isArray(searchData) ? searchData : (searchData.tracks || []);
                                    const altItem = items.find(i => {
                                        const vid = i.youtube_id || i.videoId;
                                        return vid && vid !== videoId;
                                    });
                                    if (altItem) {
                                        const altId = altItem.youtube_id || altItem.videoId;
                                        currentTrack.youtube_id = altId;
                                        currentAudio._activeVideoId = altId;
                                        const altStreamUrl = `/api/music-api?endpoint=stream&id=${encodeURIComponent(altId)}&format=${altFmt}&_t=${Date.now()}`;
                                        currentAudio.pause();
                                        currentAudio.removeAttribute('src');
                                        currentAudio.load();
                                        currentAudio.src = altStreamUrl;
                                        currentAudio.load();
                                        await currentAudio.play();
                                        currentAudio._recovering = false;
                                        return;
                                    }
                                }
                            }
                        } catch (_) {}
                    }
                }
            } catch (_) {}
            finally {
                currentAudio._recovering = false;
            }
        }
        currentAudio._recovering = false;
        showToast('Playback error: Stream unavailable.');
    });

    // Seamless Network Online / Offline Lifecycle Handling
    window.addEventListener('online', () => {
        showToast('✓ Back online');
        currentAudio._recovering = false;
        // If track was paused or failed during offline disconnect, resume seamlessly
        if (currentTrack && (!currentAudio.src || currentAudio.error || (!isPlaying && currentAudio.paused && currentAudio.currentTime === 0))) {
            playTrack(currentTrack);
        }
    });

    window.addEventListener('offline', () => {
        showToast('Offline mode: Playing downloaded songs');
    });

    // iPhone / Mobile Lock Screen Redirect -> Automatically open Now Playing section
    let wasAppBackgrounded = false;
    window._yolkFilePickerOpen = false;

    function handleReturnFromLockScreen() {
        if (!wasAppBackgrounded) return;
        wasAppBackgrounded = false;
        if (window._yolkFilePickerOpen) {
            setTimeout(() => { window._yolkFilePickerOpen = false; }, 1200);
            return;
        }
        const isMobileDevice = window.innerWidth < 640 || /iPhone|iPod|Android/i.test(navigator.userAgent || '');
        if (isMobileDevice && currentTrack) {
            if (window.location.hash !== '#now-playing') {
                window.location.hash = '#now-playing';
            }
        }
    }

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
            wasAppBackgrounded = true;
        } else if (document.visibilityState === 'visible') {
            handleReturnFromLockScreen();
        }
    });

    window.addEventListener('pagehide', () => {
        wasAppBackgrounded = true;
    });

    window.addEventListener('pageshow', () => {
        if (document.visibilityState === 'visible') {
            handleReturnFromLockScreen();
        }
    });

    window.addEventListener('focus', () => {
        if (document.visibilityState === 'visible') {
            handleReturnFromLockScreen();
        }
    });

    // Time & Progress Update
    let lastMediaSessionPosUpdate = 0;
    currentAudio.addEventListener('timeupdate', () => {
        if (activeSource !== 'audio') return;
        const cur = currentAudio.currentTime || 0;
        const dur = getEffectiveAudioDuration();
        if (dur > 0 && cur >= dur - 0.15 && currentAudio.duration > dur + 2) {
            // Reached true end of song: skip any trailing blank container padding immediately
            playNext();
            return;
        }

        // Crossfade Envelope: smoothly fade outgoing song & overlap preloaded next song during final crossfadeSeconds
        if (crossfadeSeconds > 0 && dur > Math.max(18, crossfadeSeconds * 2) && isPlaying) {
            const remaining = dur - cur;
            if (remaining > 0.18 && remaining <= crossfadeSeconds) {
                currentAudio._didCrossfadeOut = true;
                const fadeRatio = Math.max(0.06, Math.min(1, remaining / crossfadeSeconds));
                if (!_crossfadeFadeInTimer) {
                    currentAudio.volume = Math.max(0, Math.min(1, currentVolume * fadeRatio));
                }
                if (preloadedNextAudio && preloadedNextAudio.src && preloadedNextTrackUid) {
                    try {
                        preloadedNextAudio.volume = Math.max(0, Math.min(1, currentVolume * (1 - fadeRatio) * 0.85));
                        if (preloadedNextAudio.paused) {
                            preloadedNextAudio.play().catch(() => {});
                        }
                    } catch (_) {}
                }
            } else if (remaining > crossfadeSeconds && !_crossfadeFadeInTimer && currentAudio.volume !== currentVolume) {
                currentAudio.volume = currentVolume;
            }
        }

        updateProgressUI(cur, dur);
        updateLyricsSync(cur);

        const now = Date.now();
        if (now - lastMediaSessionPosUpdate > 1000) {
            lastMediaSessionPosUpdate = now;
            updateMediaSessionPosition();
        }
    });

    // Progress Bar Scrubbing
    function setupScrubbing(barEl) {
        if (!barEl) return;
        barEl.addEventListener('click', (e) => {
            const rect = barEl.getBoundingClientRect();
            const clickPos = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));

            if (activeSource === 'youtube' && ytPlayer && typeof ytPlayer.getDuration === 'function') {
                let dur = ytPlayer.getDuration() || (currentTrack?.duration ? currentTrack.duration / 1000 : 0);
                if (dur > 0) {
                    const seekTo = clickPos * dur;
                    ytPlayer.seekTo(seekTo, true);
                    updateProgressUI(seekTo, dur);
                    updateLyricsSync(seekTo);
                    if (!isPlaying && typeof ytPlayer.playVideo === 'function') {
                        ytPlayer.playVideo();
                    }
                }
                return;
            }

            const dur = getEffectiveAudioDuration();
            if (dur > 0) {
                currentAudio.currentTime = clickPos * dur;
                updateMediaSessionPosition();
                if (!isPlaying) {
                    currentAudio.play().then(() => {
                        isPlaying = true;
                        updatePlayPauseButtons();
                    }).catch(() => {});
                }
            }
        });
    }
    setupScrubbing(npProgressBar);
    setupScrubbing(bpProgressBar);

    // Playback Navigation (Next, Prev, Play/Pause)
    function togglePlayPause() {
        if (!currentTrack) {
            if (currentQueue.length > 0) {
                currentQueueIndex = 0;
                playTrack(currentQueue[0]);
            }
            return;
        }

        if (activeSource === 'youtube' && ytPlayer) {
            if (isPlaying) {
                if (typeof ytPlayer.pauseVideo === 'function') ytPlayer.pauseVideo();
                isPlaying = false;
                updatePlayPauseButtons();
                stopYouTubeProgress();
            } else {
                if (typeof ytPlayer.playVideo === 'function') ytPlayer.playVideo();
                isPlaying = true;
                updatePlayPauseButtons();
                startYouTubeProgress();
            }
            return;
        }

        if (!currentAudio.src || currentAudio.error) {
            playTrack(currentTrack);
            return;
        }

        if (currentAudio.paused) {
            const playPromise = currentAudio.play();
            if (playPromise !== undefined) {
                playPromise.then(() => {
                    isPlaying = true;
                    updatePlayPauseButtons();
                }).catch(e => {
                    if (e.name !== 'AbortError') {
                        console.error('Play error:', e);
                    }
                });
            }
        } else {
            currentAudio.pause();
            isPlaying = false;
            updatePlayPauseButtons();
        }
    }

    async function playNext() {
        if (!currentQueue || currentQueue.length === 0) return;
        if (currentQueueIndex >= currentQueue.length - 1) {
            // Reached the end of active queue: seamlessly fetch up-next tracks and continue
            if (currentTrack) {
                await fetchUpNextTracks(currentTrack);
            }
            if (currentQueueIndex < currentQueue.length - 1) {
                currentQueueIndex++;
                playTrack(currentQueue[currentQueueIndex]);
                return;
            }
            currentQueueIndex = 0;
            playTrack(currentQueue[currentQueueIndex]);
            return;
        }
        currentQueueIndex++;
        playTrack(currentQueue[currentQueueIndex]);

        // Preload next batch when getting close to end
        if (currentQueueIndex >= currentQueue.length - 2 && currentTrack) {
            fetchUpNextTracks(currentTrack);
        }
    }

    function playPrev() {
        if (!currentQueue || currentQueue.length === 0) return;
        const cur = (activeSource === 'youtube' && ytPlayer && typeof ytPlayer.getCurrentTime === 'function')
            ? ytPlayer.getCurrentTime()
            : (currentAudio.currentTime || 0);

        if (cur > 3) {
            if (activeSource === 'youtube' && ytPlayer && typeof ytPlayer.seekTo === 'function') {
                ytPlayer.seekTo(0, true);
            } else {
                currentAudio.currentTime = 0;
            }
            return;
        }
        currentQueueIndex = (currentQueueIndex - 1 + currentQueue.length) % currentQueue.length;
        playTrack(currentQueue[currentQueueIndex]);
    }

    if (npPlayPauseBtn) {
        npPlayPauseBtn.onclick = (e) => {
            if (e && e.currentTarget && typeof e.currentTarget.blur === 'function') e.currentTarget.blur();
            triggerHaptic('medium');
            togglePlayPause();
        };
    }
    if (bpPlayPauseBtn) {
        bpPlayPauseBtn.onclick = (e) => {
            if (e && e.currentTarget && typeof e.currentTarget.blur === 'function') e.currentTarget.blur();
            triggerHaptic('medium');
            togglePlayPause();
        };
    }
    if (npNextBtn) {
        npNextBtn.onclick = (e) => {
            if (e && e.currentTarget && typeof e.currentTarget.blur === 'function') e.currentTarget.blur();
            triggerHaptic('light');
            playNext();
        };
    }
    if (bpNextBtn) {
        bpNextBtn.onclick = (e) => {
            if (e && e.currentTarget && typeof e.currentTarget.blur === 'function') e.currentTarget.blur();
            triggerHaptic('light');
            playNext();
        };
    }
    if (npPrevBtn) {
        npPrevBtn.onclick = (e) => {
            if (e && e.currentTarget && typeof e.currentTarget.blur === 'function') e.currentTarget.blur();
            triggerHaptic('light');
            playPrev();
        };
    }
    if (bpPrevBtn) {
        bpPrevBtn.onclick = (e) => {
            if (e && e.currentTarget && typeof e.currentTarget.blur === 'function') e.currentTarget.blur();
            triggerHaptic('light');
            playPrev();
        };
    }

    // Playback Timing Helpers for Keyboard Navigation & Seeking
    function getPlaybackDuration() {
        if (activeSource === 'youtube' && ytPlayer && typeof ytPlayer.getDuration === 'function') {
            return ytPlayer.getDuration() || (currentTrack?.duration ? currentTrack.duration / 1000 : 0);
        }
        return getEffectiveAudioDuration();
    }

    function getPlaybackCurrentTime() {
        if (activeSource === 'youtube' && ytPlayer && typeof ytPlayer.getCurrentTime === 'function') {
            return ytPlayer.getCurrentTime() || 0;
        }
        return currentAudio.currentTime || 0;
    }

    function seekToSeconds(targetSec) {
        const dur = getPlaybackDuration();
        const clamped = Math.max(0, Math.min(dur || Infinity, targetSec));
        if (activeSource === 'youtube' && ytPlayer && typeof ytPlayer.seekTo === 'function') {
            ytPlayer.seekTo(clamped, true);
        } else if (currentAudio) {
            currentAudio.currentTime = clamped;
        }
        updateProgressUI(clamped, dur);
        updateLyricsSync(clamped);
    }

    // Keyboard Shortcuts: Spacebar (Play/Pause), M (Mute), Arrows (Skip ±5s / Next / Prev), 1-9 (Seek % of song)
    document.addEventListener('keydown', (e) => {
        const active = document.activeElement;
        const isInput = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable);
        if (isInput) return;

        // Spacebar: Toggle Play/Pause
        if (e.code === 'Space' || e.key === ' ' || e.keyCode === 32) {
            e.preventDefault();
            if (e.repeat) return;
            if (active && typeof active.blur === 'function') active.blur();
            togglePlayPause();
            return;
        }

        // M: Toggle Mute / Unmute
        if (e.key === 'm' || e.key === 'M' || e.code === 'KeyM') {
            e.preventDefault();
            toggleMute();
            return;
        }

        // Arrow Keys: Skip forward / backward
        if (e.key === 'ArrowRight' || e.code === 'ArrowRight') {
            e.preventDefault();
            if (e.shiftKey) {
                playNext();
            } else {
                seekToSeconds(getPlaybackCurrentTime() + 5);
            }
            return;
        }

        if (e.key === 'ArrowLeft' || e.code === 'ArrowLeft') {
            e.preventDefault();
            if (e.shiftKey) {
                playPrev();
            } else {
                seekToSeconds(getPlaybackCurrentTime() - 5);
            }
            return;
        }

        // Numbers 1-9 (and 0): Seek through track
        // 1 = very start (0%), 2 = 10%, 3 = 20% ... 9 = 80%, 0 = 90%
        if (!e.ctrlKey && !e.metaKey && !e.altKey) {
            const digitMatch = e.code.match(/^(?:Digit|Numpad)([0-9])$/);
            const numStr = digitMatch ? digitMatch[1] : (e.key >= '0' && e.key <= '9' ? e.key : null);
            if (numStr !== null) {
                const num = parseInt(numStr, 10);
                const dur = getPlaybackDuration();
                if (dur > 0) {
                    e.preventDefault();
                    let fraction = 0;
                    if (num === 1) {
                        fraction = 0; // Very start
                    } else if (num >= 2 && num <= 9) {
                        fraction = (num - 1) * 0.1; // 2 -> 10%, 3 -> 20% ... 9 -> 80%
                    } else if (num === 0) {
                        fraction = 0.9; // 90%
                    }
                    seekToSeconds(fraction * dur);
                }
            }
        }
    });

    document.addEventListener('keyup', (e) => {
        if (e.code === 'Space' || e.key === ' ' || e.keyCode === 32) {
            const active = document.activeElement;
            const isInput = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable);
            if (!isInput) {
                e.preventDefault();
            }
        }
    });

    function updatePlayPauseButtons() {
        const playIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1" class="ml-0.5"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>`;
        const pauseIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg>`;
        
        const bpPlayIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1" class="ml-0.5"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>`;
        const bpPauseIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg>`;

        if (npPlayPauseBtn) npPlayPauseBtn.innerHTML = isPlaying ? pauseIcon : playIcon;
        if (bpPlayPauseBtn) bpPlayPauseBtn.innerHTML = isPlaying ? bpPauseIcon : bpPlayIcon;
        if (lyricsBarPlayPause) lyricsBarPlayPause.innerHTML = isPlaying ? bpPauseIcon : bpPlayIcon;
    }

    function updateNowPlayingFavButton() {
        if (!npFavBtn || !currentTrack) return;
        const fav = isFavorite(currentTrack.id);
        const strokeCol = document.body.classList.contains('dark-mode') ? '#f4f4f5' : '#18181b';
        const svg = npFavBtn.querySelector('svg');
        if (svg) {
            svg.setAttribute('fill', fav ? strokeCol : 'none');
            svg.setAttribute('stroke', strokeCol);
        }
        if (lyricsBarFavBtn) {
            const lsvg = lyricsBarFavBtn.querySelector('svg');
            if (lsvg) {
                lsvg.setAttribute('fill', fav ? strokeCol : 'none');
                lsvg.setAttribute('stroke', strokeCol);
            }
        }
    }

    function updateBottomPlayerFavButton() {
        if (!currentTrack) return;
        const fav = isFavorite(currentTrack.id);
        const strokeCol = document.body.classList.contains('dark-mode') ? '#f4f4f5' : '#18181b';
        if (bpFavBtn) {
            const svg = bpFavBtn.querySelector('svg');
            if (svg) {
                svg.setAttribute('fill', fav ? strokeCol : 'none');
                svg.setAttribute('stroke', strokeCol);
            }
        }
        if (bpMoreFavBtn) {
            const msvg = bpMoreFavBtn.querySelector('svg');
            if (msvg) {
                msvg.setAttribute('fill', fav ? strokeCol : 'none');
                msvg.setAttribute('stroke', strokeCol);
            }
        }
    }

    if (npFavBtn) {
        npFavBtn.onclick = () => {
            if (currentTrack) {
                toggleFavorite(currentTrack, npFavBtn.querySelector('svg'));
            }
        };
    }

    if (npAddBtn) {
        npAddBtn.onclick = () => {
            if (currentTrack) {
                openAddToPlaylistModal(currentTrack);
            }
        };
    }

    if (bpFavBtn) {
        bpFavBtn.onclick = (e) => {
            e.stopPropagation();
            if (currentTrack) {
                toggleFavorite(currentTrack, bpFavBtn.querySelector('svg'));
            }
        };
    }

    if (bpAddBtn) {
        bpAddBtn.onclick = (e) => {
            e.stopPropagation();
            if (currentTrack) {
                openAddToPlaylistModal(currentTrack);
            }
        };
    }

    let currentCoverColor = null;
    let currentActivePageTint = null;
    let currentPlaylistTintRgb = null;

    function updateSafariThemeTint(r, g, b, alpha = 0.38) {
        const metaTheme = document.getElementById('meta-theme-color') || document.querySelector('meta[name="theme-color"]');
        const shimEl = document.getElementById('safari-top-color-shim');
        const topFadeBar = document.getElementById('top-white-fade-bar');
        const page = document.body.getAttribute('data-page');
        const isDark = document.body.classList.contains('dark-mode');
        const defaultBg = isDark ? '#0c0c0e' : '#FCFBF8';
        if (r === null || r === undefined || page !== 'now-playing') {
            if (r === null || r === undefined) currentActivePageTint = null;
            if (metaTheme) metaTheme.setAttribute('content', defaultBg);
            if (shimEl) shimEl.style.backgroundColor = defaultBg;
            if (topFadeBar) {
                topFadeBar.style.background = '';
                topFadeBar.style.opacity = '';
            }
            document.documentElement.style.setProperty('background-color', defaultBg, 'important');
            document.body.style.setProperty('background-color', defaultBg, 'important');
            return;
        }

        currentActivePageTint = { r, g, b, alpha };
        let clR, clG, clB;
        if (alpha >= 0.95) {
            // Match true color directly for Safari top row status bar blend
            clR = Math.max(0, Math.min(255, Math.round(r)));
            clG = Math.max(0, Math.min(255, Math.round(g)));
            clB = Math.max(0, Math.min(255, Math.round(b)));
        } else {
            const baseR = isDark ? 12 : 252;
            const baseG = isDark ? 12 : 251;
            const baseB = isDark ? 14 : 248;
            clR = Math.max(0, Math.min(255, Math.round(r * alpha + baseR * (1 - alpha))));
            clG = Math.max(0, Math.min(255, Math.round(g * alpha + baseG * (1 - alpha))));
            clB = Math.max(0, Math.min(255, Math.round(b * alpha + baseB * (1 - alpha))));
        }
        const hex = `#${clR.toString(16).padStart(2, '0')}${clG.toString(16).padStart(2, '0')}${clB.toString(16).padStart(2, '0')}`;

        if (metaTheme) metaTheme.setAttribute('content', hex);
        if (shimEl) shimEl.style.backgroundColor = hex;
        if (topFadeBar) {
            topFadeBar.style.opacity = '1';
            topFadeBar.style.background = `linear-gradient(180deg, ${hex} 0%, ${hex} 48%, rgba(${clR}, ${clG}, ${clB}, 0.72) 76%, rgba(${clR}, ${clG}, ${clB}, 0) 100%)`;
        }
        document.documentElement.style.setProperty('background-color', hex, 'important');
        document.body.style.setProperty('background-color', hex, 'important');
    }
    window.updateSafariThemeTint = updateSafariThemeTint;

    function updateTopNavTint() {
        const topNav = document.getElementById('top-nav-bar');
        const page = document.body.getAttribute('data-page');
        const isDark = document.body.classList.contains('dark-mode');
        const navSearch = document.getElementById('nav-search');
        const navLibrary = document.getElementById('nav-library');
        const navSettings = document.getElementById('nav-settings');
        const navNowPlaying = document.getElementById('nav-now-playing');
        const allTopNavBtns = [navSearch, navLibrary, navSettings, navNowPlaying];

        if (page === 'now-playing' && currentCoverColor) {
            const { r, g, b } = currentCoverColor;
            if (topNav) {
                topNav.style.backgroundColor = isDark ? `rgba(${r}, ${g}, ${b}, 0.28)` : `rgba(${r}, ${g}, ${b}, 0.22)`;
                topNav.style.borderColor = `rgba(${r}, ${g}, ${b}, 0.42)`;
                topNav.style.boxShadow = `0 8px 25px rgba(${r}, ${g}, ${b}, 0.16)`;
            }
            updateSafariThemeTint(r, g, b, 1.0);

            // Adaptive contrast for top nav icon buttons on dynamic background
            const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
            const inactiveColor = (isDark || lum < 0.48) ? '#f4f4f5' : '#18181b';
            const activeTextCol = isDark ? '#18181b' : '#ffffff';
            allTopNavBtns.forEach(btn => {
                if (!btn) return;
                if (btn.classList.contains('yolk-active')) {
                    btn.style.color = activeTextCol;
                } else {
                    btn.style.color = inactiveColor;
                }
            });
        } else {
            const activeTextCol = isDark ? '#18181b' : '#ffffff';
            allTopNavBtns.forEach(btn => {
                if (!btn) return;
                btn.style.color = btn.classList.contains('yolk-active') ? activeTextCol : '';
            });
            if (topNav) {
                topNav.style.backgroundColor = '';
                topNav.style.borderColor = '';
                topNav.style.boxShadow = '';
            }
            updateSafariThemeTint(null);
        }
    }
    window.updateTopNavTint = updateTopNavTint;

    function applyNowPlayingTint(r, g, b) {
        currentCoverColor = { r, g, b };
        const tintEl = document.getElementById('now-playing-bg-tint');
        if (tintEl) {
            tintEl.style.background = `radial-gradient(ellipse at 70% 30%, rgba(${r}, ${g}, ${b}, 0.32) 0%, rgba(${r}, ${g}, ${b}, 0.14) 45%, rgba(252, 251, 248, 0) 75%), linear-gradient(180deg, rgba(${r}, ${g}, ${b}, 0.24) 0%, rgba(${r}, ${g}, ${b}, 0.08) 35%, rgba(252, 251, 248, 0.95) 70%, #FCFBF8 100%)`;
            if (document.body.getAttribute('data-page') === 'now-playing') {
                tintEl.style.opacity = '1';
            }
        }
        updateTopNavTint();
    }

    function isTrackInLibrary(track) {
        if (!track) return false;
        const uid = getTrackUid(track);
        return playlists.some(pl => Array.isArray(pl.tracks) && pl.tracks.some(t => getTrackUid(t) === uid));
    }

    function updateLibraryButtons() {
        const inLib = isTrackInLibrary(currentTrack);
        const strokeCol = document.body.classList.contains('dark-mode') ? '#f4f4f5' : '#18181b';
        [npAddBtn, bpAddBtn].forEach(btn => {
            if (!btn) return;
            const svg = btn.querySelector('svg');
            if (svg) {
                svg.setAttribute('fill', inLib ? strokeCol : 'none');
                svg.setAttribute('stroke', strokeCol);
            }
            btn.classList.toggle('text-zinc-900', inLib);
            btn.classList.toggle('text-zinc-400', !inLib);
            btn.title = inLib ? 'In Library / Playlists (Click to manage)' : 'Add to Playlist';
        });
    }
    window.updateLibraryButtons = updateLibraryButtons;

    function updateNowPlayingBgArt() {
        const bgArt = document.getElementById('now-playing-bg-art');
        const meshEl = document.getElementById('now-playing-mesh');
        if (!bgArt) return;

        let coverSrc = null;
        if (currentTrack) {
            coverSrc = currentTrack._offlineArtUrl || getProxyUrl(currentTrack.artwork_url || currentTrack.image);
        }

        if (coverSrc) {
            bgArt.onerror = () => {
                bgArt.removeAttribute('src');
                bgArt.classList.add('opacity-0');
                bgArt.classList.remove('opacity-75');
            };
            bgArt.onload = () => {
                bgArt.classList.remove('opacity-0');
                bgArt.classList.add('opacity-75');
            };
            bgArt.src = coverSrc;
            if (bgArt.complete && bgArt.naturalWidth > 0) {
                bgArt.classList.remove('opacity-0');
                bgArt.classList.add('opacity-75');
            }
            extractArtworkPalette(coverSrc, (colors) => {
                applyAppleMusicNowPlayingBg(colors);
            });
        } else {
            bgArt.removeAttribute('src');
            bgArt.classList.add('opacity-0');
            bgArt.classList.remove('opacity-75');
            applyAppleMusicNowPlayingBg(null);
        }
    }
    window.updateNowPlayingBgArt = updateNowPlayingBgArt;

    // Now Playing UI update (Cover Art & Track Details)
    function updateNowPlayingUI(track) {
        const titleEl = document.getElementById('now-playing-title');
        const artistEl = document.getElementById('now-playing-artist');
        const imgEl = document.getElementById('now-playing-img');
        const vinylEl = document.getElementById('now-playing-vinyl');

        const trackTitle = track.title || track.name || 'Unknown Title';
        const trackArtist = track.artist_name || track.artist || 'Unknown Artist';

        if (titleEl) titleEl.textContent = trackTitle;
        if (artistEl) artistEl.textContent = trackArtist;
        if (lyricsBarTitle) lyricsBarTitle.textContent = trackTitle;
        if (lyricsBarArtist) lyricsBarArtist.textContent = trackArtist;

        updateNowPlayingBgArt();
        updateLibraryButtons();

        const coverUrl = getProxyUrl(track.artwork_url || track.image);
        if (lyricsBarThumb) {
            lyricsBarThumb.src = coverUrl || '';
        }
        if (coverUrl && imgEl) {
            imgEl.onload = () => {
                imgEl.classList.remove('hidden');
                if (vinylEl) vinylEl.classList.add('hidden');
            };
            imgEl.onerror = () => {
                if (!imgEl.src.includes('/api/proxy') && !imgEl.src.includes('/api/gateway')) {
                    imgEl.src = `/api/proxy?url=${encodeURIComponent(coverUrl)}`;
                } else {
                    imgEl.classList.add('hidden');
                    if (vinylEl) vinylEl.classList.remove('hidden');
                }
            };
            imgEl.src = coverUrl;
            if (imgEl.complete && imgEl.naturalWidth > 0) {
                imgEl.classList.remove('hidden');
                if (vinylEl) vinylEl.classList.add('hidden');
            }
        } else if (imgEl) {
            imgEl.classList.add('hidden');
            if (vinylEl) vinylEl.classList.remove('hidden');
        }
    }

    // Bottom Player UI update
    function updateBottomPlayerUI(track) {
        const titleEl = document.getElementById('bottom-player-title');
        const artistEl = document.getElementById('bottom-player-artist');
        const imgEl = document.getElementById('bottom-player-img');
        const placeholderEl = document.getElementById('bottom-player-placeholder');

        const trackTitle = track.title || track.name || 'Unknown Title';
        const trackArtist = track.artist_name || track.artist || 'Unknown Artist';

        if (titleEl) titleEl.textContent = trackTitle;
        if (artistEl) artistEl.textContent = trackArtist;

        updateLibraryButtons();

        const coverUrl = getProxyUrl(track.artwork_url || track.image, '50x50');
        if (coverUrl && imgEl) {
            imgEl.onload = () => {
                imgEl.classList.remove('hidden');
                if (placeholderEl) placeholderEl.classList.add('hidden');
            };
            imgEl.onerror = () => {
                imgEl.classList.add('hidden');
                if (placeholderEl) placeholderEl.classList.remove('hidden');
            };
            imgEl.src = coverUrl;
            if (imgEl.complete && imgEl.naturalWidth > 0) {
                imgEl.classList.remove('hidden');
                if (placeholderEl) placeholderEl.classList.add('hidden');
            }
        } else if (imgEl) {
            imgEl.classList.add('hidden');
            if (placeholderEl) placeholderEl.classList.remove('hidden');
        }

        updateBottomPlayerFavButton();
    }

    // Synced Lyrics Fetching & Clean Formatting
    async function fetchLyrics(track) {
        const container = document.getElementById('lyrics-container');
        if (!container) return;

        const badge = document.getElementById('lyrics-badge');
        if (badge) {
            badge.textContent = 'Loading…';
            badge.style.display = 'inline-block';
        }

        const uid = getTrackUid(track);
        currentLyricsTrackId = uid;
        container._lastActiveIndex = -1;
        parsedLyrics = [];

        container.innerHTML = `
            <div class="h-full flex flex-col items-center justify-center gap-3 text-zinc-400 select-none py-16">
                <div class="w-6 h-6 border-2 border-zinc-200 border-t-zinc-700 rounded-full animate-spin"></div>
                <span class="text-xs font-medium tracking-wide">Loading synced lyrics…</span>
            </div>
        `;

        const lyricsId = track.youtube_id || track.videoId || (track.id ? String(track.id).replace('ytm-', '') : '');
        const trackName = track.title || track.name || '';
        const artistName = track.artist_name || track.artist || '';
        const durSec = track.duration ? (track.duration > 1000 ? track.duration / 1000 : track.duration) : 0;

        try {
            const url = `${API_BASE}?endpoint=lyrics&id=${encodeURIComponent(lyricsId)}&title=${encodeURIComponent(trackName)}&artist=${encodeURIComponent(artistName)}&duration=${Math.round(durSec)}`;
            const res = await fetch(url);
            if (currentLyricsTrackId !== uid) return;

            if (res.ok) {
                const data = await res.json();
                if (data && data.lyrics && data.lyrics.trim()) {
                    renderLyricsToUI(data.lyrics, uid);
                    return;
                }
            }
            renderNoLyricsFound(uid);
        } catch (e) {
            if (currentLyricsTrackId === uid) {
                renderNoLyricsFound(uid);
            }
        }
    }

    function renderLyricsToUI(lyricsText, trackUid) {
        const container = document.getElementById('lyrics-container');
        if (!container || currentLyricsTrackId !== trackUid) return;

        const duration = currentAudio.duration || (currentTrack?.duration ? currentTrack.duration / 1000 : 0);
        parsedLyrics = parseLyrics(lyricsText, duration);

        if (!parsedLyrics || parsedLyrics.length === 0) {
            renderNoLyricsFound(trackUid);
            return;
        }

        const badge = document.getElementById('lyrics-badge');
        if (badge) {
            const hasTimestamps = parsedLyrics.some(p => p.time !== null && p.time !== undefined);
            badge.textContent = hasTimestamps ? 'Synced' : 'Plain';
            badge.style.display = 'inline-block';
        }

        const html = parsedLyrics.map((item, idx) => {
            if (item.type === 'spacer') {
                return `<div class="lyric-spacer"></div>`;
            }

            if (item.type === 'section') {
                return `<div class="lyric-section-label">${escapeHtml(item.text)}</div>`;
            }

            if (item.type === 'dots') {
                return `
                    <div class="lyric-line dots-line cursor-pointer my-3" data-index="${idx}" onclick="seekToLyrics(${item.time})">
                        <div class="lyric-dots">
                            <div class="lyric-dot"></div>
                            <div class="lyric-dot"></div>
                            <div class="lyric-dot"></div>
                        </div>
                    </div>
                `;
            }

            const isTimed = (item.time !== null && item.time !== undefined);
            const untimedClass = isTimed ? '' : 'untimed';
            const clickAttr = isTimed ? `onclick="seekToLyrics(${item.time})"` : '';
            return `<div class="lyric-line ${untimedClass}" data-index="${idx}" ${clickAttr}>${escapeHtml(item.text)}</div>`;
        }).join('');

        container.innerHTML = html;
        container._lastActiveIndex = -1;
        isLyricsAvailable = true;
        updateLyricsVisibilityUI();

        if (currentAudio.currentTime > 0) {
            updateLyricsSync(currentAudio.currentTime);
        }
    }

    function renderNoLyricsFound(trackUid) {
        const container = document.getElementById('lyrics-container');
        if (!container || currentLyricsTrackId !== trackUid) return;
        parsedLyrics = [];
        isLyricsAvailable = false;
        updateLyricsVisibilityUI();

        const badge = document.getElementById('lyrics-badge');
        if (badge) {
            badge.style.display = 'none';
        }

        container.innerHTML = `
            <div class="h-full flex flex-col items-center justify-center gap-2 text-zinc-400 select-none py-16 text-center">
                <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="opacity-40 mb-1"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg>
                <span class="text-sm font-semibold text-zinc-600">No lyrics available</span>
                <span class="text-xs text-zinc-400">Enjoy the song!</span>
            </div>
        `;
    }

    // Favorites Logic
    function toggleFavorite(track, svgElement) {
        triggerHaptic('medium');
        const favIndex = favorites.findIndex(f => f.id === track.id);
        if (favIndex > -1) {
            favorites.splice(favIndex, 1);
            if (svgElement) {
                svgElement.setAttribute('fill', 'none');
                svgElement.setAttribute('stroke', 'currentColor');
            }
            showToast('Removed from Favorites');
        } else {
            favorites.push(track);
            if (svgElement) {
                svgElement.setAttribute('fill', 'currentColor');
                svgElement.setAttribute('stroke', 'currentColor');
            }
            showToast('Saved to Favorites');
            // Automatically download when added to Library
            enqueueLibraryDownload(track);
        }
        saveFavorites();
        updateNowPlayingFavButton();
        updateBottomPlayerFavButton();
        if (!playlistDetailView.classList.contains('hidden') && currentPlaylistContextId === 'favorites') {
            openPlaylistDetail('favorites');
        } else {
            renderLibrary();
        }
    }

    // ============================================
    // PLAYLIST MANAGEMENT & PLAYLIST UI
    // ============================================

    // Dynamic Cover Tint Extraction & Application
    function extractDominantColor(imgUrl, callback) {
        if (!imgUrl) {
            callback(null);
            return;
        }
        const img = new Image();
        if (!imgUrl.startsWith('data:')) {
            img.crossOrigin = 'Anonymous';
        }
        img.src = imgUrl.startsWith('data:') ? imgUrl : getProxyUrl(imgUrl, '100x100');
        img.onload = () => {
            try {
                const canvas = document.createElement('canvas');
                const ctx = canvas.getContext('2d');
                canvas.width = 40;
                canvas.height = 40;
                ctx.drawImage(img, 0, 0, 40, 40);
                const data = ctx.getImageData(0, 0, 40, 40).data;
                let r = 0, g = 0, b = 0, count = 0;
                let bestScore = -1, vibR = 253, vibG = 224, vibB = 71;

                for (let i = 0; i < data.length; i += 4) {
                    const pr = data[i], pg = data[i+1], pb = data[i+2], pa = data[i+3];
                    if (pa < 128) continue;
                    r += pr; g += pg; b += pb; count++;

                    const max = Math.max(pr, pg, pb);
                    const min = Math.min(pr, pg, pb);
                    const delta = max - min;
                    const lum = (max + min) / 510;
                    if (lum > 0.15 && lum < 0.85) {
                        const score = delta * (1 - Math.abs(lum - 0.5));
                        if (score > bestScore) {
                            bestScore = score;
                            vibR = pr; vibG = pg; vibB = pb;
                        }
                    }
                }

                if (bestScore > 18) {
                    callback({ r: vibR, g: vibG, b: vibB });
                } else if (count > 0) {
                    callback({ r: Math.round(r / count), g: Math.round(g / count), b: Math.round(b / count) });
                } else {
                    callback(null);
                }
            } catch (_) {
                callback(null);
            }
        };
        img.onerror = () => callback(null);
    }

    function clearPlaylistTint() {
        currentPlaylistTintRgb = null;
        const tintEl = document.getElementById('playlist-bg-tint');
        if (tintEl) {
            tintEl.style.opacity = '0';
            tintEl.style.background = '';
        }
        const detailView = document.getElementById('playlist-detail-view');
        if (detailView) {
            detailView.classList.remove('has-playlist-tint');
            detailView.style.removeProperty('--pl-icon-color');
            detailView.style.removeProperty('--pl-play-bg');
            detailView.style.removeProperty('--pl-play-icon');
            detailView.style.removeProperty('--pl-border-color');
            detailView.style.removeProperty('--pl-surface-bg');
            detailView.style.removeProperty('--pl-badge-bg');
        }
    }

    function applyPlaylistThemeUI(r, g, b) {
        const detailView = document.getElementById('playlist-detail-view');
        if (!detailView) return;
        const { h, s, l } = rgbToHsl(r, g, b);
        const effS = Math.max(0.28, Math.min(0.92, s));
        const isDark = document.body.classList.contains('dark-mode');

        // Shift icon/button colors lighter or darker by a margin depending on the tint's brightness
        let iconRgb, playBgRgb, playIconRgb, borderRgb, surfaceRgb, badgeRgb;
        if (isDark) {
            // In Dark Mode, make tinted playlist icons luminous and surfaces richly dark-tinted
            iconRgb = hslToRgb(h, Math.min(0.92, effS + 0.1), l > 0.55 ? Math.min(0.84, l + 0.16) : Math.max(0.68, l + 0.34));
            playBgRgb = hslToRgb(h, Math.min(0.90, effS + 0.08), Math.max(0.56, Math.min(0.74, l + 0.22)));
            playIconRgb = hslToRgb(h, Math.min(0.65, effS), 0.10);
            borderRgb = hslToRgb(h, Math.min(0.65, effS), 0.34);
            surfaceRgb = hslToRgb(h, Math.min(0.45, effS), 0.13);
            badgeRgb = hslToRgb(h, Math.min(0.55, effS), 0.20);
        } else if (l > 0.52) {
            // Bright tint -> make icons darker by a clear margin
            iconRgb = hslToRgb(h, effS, Math.max(0.20, l - 0.34));
            playBgRgb = hslToRgb(h, effS, Math.max(0.24, l - 0.30));
            playIconRgb = hslToRgb(h, Math.min(0.85, effS), Math.min(0.96, l + 0.32));
            borderRgb = hslToRgb(h, Math.min(0.65, effS), 0.76);
            surfaceRgb = hslToRgb(h, Math.min(0.45, effS), 0.96);
            badgeRgb = hslToRgb(h, Math.min(0.60, effS), 0.90);
        } else {
            // Darker tint -> keep action icons rich in that hue and make primary play icon lighter by a margin
            iconRgb = hslToRgb(h, effS, Math.min(0.42, Math.max(0.24, l + 0.08)));
            playBgRgb = hslToRgb(h, effS, Math.max(0.22, Math.min(0.38, l)));
            playIconRgb = hslToRgb(h, Math.min(0.90, effS + 0.1), Math.min(0.94, l + 0.42));
            borderRgb = hslToRgb(h, Math.min(0.65, effS), 0.76);
            surfaceRgb = hslToRgb(h, Math.min(0.45, effS), 0.96);
            badgeRgb = hslToRgb(h, Math.min(0.60, effS), 0.90);
        }

        detailView.classList.add('has-playlist-tint');
        detailView.style.setProperty('--pl-icon-color', `rgb(${iconRgb.r}, ${iconRgb.g}, ${iconRgb.b})`);
        detailView.style.setProperty('--pl-play-bg', `rgb(${playBgRgb.r}, ${playBgRgb.g}, ${playBgRgb.b})`);
        detailView.style.setProperty('--pl-play-icon', `rgb(${playIconRgb.r}, ${playIconRgb.g}, ${playIconRgb.b})`);
        detailView.style.setProperty('--pl-border-color', `rgba(${borderRgb.r}, ${borderRgb.g}, ${borderRgb.b}, ${isDark ? '0.55' : '0.65'})`);
        detailView.style.setProperty('--pl-surface-bg', `rgba(${surfaceRgb.r}, ${surfaceRgb.g}, ${surfaceRgb.b}, ${isDark ? '0.88' : '0.86'})`);
        detailView.style.setProperty('--pl-badge-bg', `rgba(${badgeRgb.r}, ${badgeRgb.g}, ${badgeRgb.b}, ${isDark ? '0.82' : '0.78'})`);
    }

    function applyPlaylistTint(r, g, b) {
        if (!currentPlaylistContextId || currentPlaylistContextId === 'favorites' || currentPlaylistContextId === 'downloaded') {
            clearPlaylistTint();
            return;
        }
        currentPlaylistTintRgb = { r, g, b };
        const tintEl = document.getElementById('playlist-bg-tint');
        if (!tintEl) return;
        tintEl.style.background = `
            radial-gradient(ellipse at 20% 15%, rgba(${r}, ${g}, ${b}, 0.38) 0%, transparent 65%),
            radial-gradient(ellipse at 82% 55%, rgba(${r}, ${g}, ${b}, 0.26) 0%, transparent 65%),
            linear-gradient(180deg, rgba(${r}, ${g}, ${b}, 0.34) 0%, rgba(${r}, ${g}, ${b}, 0.20) 48%, rgba(${r}, ${g}, ${b}, 0.12) 100%)
        `;
        tintEl.style.maskImage = 'none';
        tintEl.style.webkitMaskImage = 'none';
        tintEl.style.opacity = '1';
        applyPlaylistThemeUI(r, g, b);
    }

    function hslToRgb(h, s, l) {
        s = Math.max(0, Math.min(1, s));
        l = Math.max(0, Math.min(1, l));
        const c = (1 - Math.abs(2 * l - 1)) * s;
        const x = c * (1 - Math.abs((h / 60) % 2 - 1));
        const m = l - c / 2;
        let r = 0, g = 0, b = 0;

        if (0 <= h && h < 60) { r = c; g = x; b = 0; }
        else if (60 <= h && h < 120) { r = x; g = c; b = 0; }
        else if (120 <= h && h < 180) { r = 0; g = c; b = x; }
        else if (180 <= h && h < 240) { r = 0; g = x; b = c; }
        else if (240 <= h && h < 300) { r = x; g = 0; b = c; }
        else if (300 <= h && h <= 360) { r = c; g = 0; b = x; }

        return {
            r: Math.round((r + m) * 255),
            g: Math.round((g + m) * 255),
            b: Math.round((b + m) * 255)
        };
    }

    function rgbToHex(r, g, b) {
        const toHex = n => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0').toUpperCase();
        return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
    }

    // ============================================
    // CUSTOM COLOR CHOOSER WHEEL (Canvas-based)
    // ============================================
    let isWheelDragging = false;
    let wheelHue = 48; // default yolk yellow hue
    let wheelSat = 0.85;
    let wheelLightness = 0.65;
    let currentWheelTint = { r: 253, g: 224, b: 71, hex: '#FDE047' };
    let wheelApplyCallback = null;
    let pendingModalTint = null;

    const tintWheelModal = document.getElementById('tint-wheel-modal');
    const tintWheelCanvas = document.getElementById('tint-color-wheel-canvas');
    const tintWheelHandle = document.getElementById('tint-wheel-handle');
    const tintBrightnessSlider = document.getElementById('tint-brightness-slider');
    const tintBrightnessVal = document.getElementById('tint-brightness-val');
    const tintPreviewSwatch = document.getElementById('tint-preview-swatch');
    const tintHexText = document.getElementById('tint-hex-text');
    const tintRgbText = document.getElementById('tint-rgb-text');
    const tintAutoBtn = document.getElementById('tint-auto-btn');
    const tintWheelCloseBtn = document.getElementById('tint-wheel-close-btn');
    const tintWheelCancel = document.getElementById('tint-wheel-cancel');
    const tintWheelApply = document.getElementById('tint-wheel-apply');
    const modalOpenTintWheelBtn = document.getElementById('modal-open-tint-wheel-btn');
    const modalTintDot = document.getElementById('modal-tint-dot');
    const modalTintStatus = document.getElementById('modal-tint-status');

    function drawColorWheel(canvas) {
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        const width = canvas.width;
        const height = canvas.height;
        const cx = width / 2;
        const cy = height / 2;
        const radius = cx - 3;

        ctx.clearRect(0, 0, width, height);

        for (let angle = 0; angle < 360; angle += 1) {
            const startAngle = (angle - 1.2) * Math.PI / 180;
            const endAngle = (angle + 1.2) * Math.PI / 180;

            ctx.beginPath();
            ctx.moveTo(cx, cy);
            ctx.arc(cx, cy, radius, startAngle, endAngle);
            ctx.closePath();

            const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
            grad.addColorStop(0, '#FFFFFF');
            grad.addColorStop(1, `hsl(${angle}, 100%, 50%)`);

            ctx.fillStyle = grad;
            ctx.fill();
        }
    }

    function refreshWheelColor() {
        const rgb = hslToRgb(wheelHue, wheelSat, wheelLightness);
        const hex = rgbToHex(rgb.r, rgb.g, rgb.b);
        currentWheelTint = { r: rgb.r, g: rgb.g, b: rgb.b, hex: hex };

        if (tintWheelHandle) tintWheelHandle.style.backgroundColor = hex;
        if (tintPreviewSwatch) tintPreviewSwatch.style.backgroundColor = hex;
        if (tintHexText) tintHexText.textContent = hex;
        if (tintRgbText) tintRgbText.textContent = `RGB(${rgb.r}, ${rgb.g}, ${rgb.b})`;
        if (tintBrightnessSlider) {
            tintBrightnessSlider.style.background = `linear-gradient(to right, #000000, hsl(${wheelHue}, ${Math.round(wheelSat * 100)}%, 50%), #ffffff)`;
        }
        if (tintBrightnessVal) {
            tintBrightnessVal.textContent = `${Math.round(wheelLightness * 100)}%`;
        }

        // Live preview on playlist background if viewing playlist
        if (playlistDetailView && !playlistDetailView.classList.contains('hidden')) {
            applyPlaylistTint(rgb.r, rgb.g, rgb.b);
        }
    }

    function updateWheelFromPointer(e, canvas, handle) {
        if (!canvas) return;
        const rect = canvas.getBoundingClientRect();
        const clientX = e.clientX ?? (e.touches && e.touches[0] ? e.touches[0].clientX : 0);
        const clientY = e.clientY ?? (e.touches && e.touches[0] ? e.touches[0].clientY : 0);
        const x = clientX - rect.left;
        const y = clientY - rect.top;

        const cx = canvas.width / 2;
        const cy = canvas.height / 2;
        const radius = cx - 3;

        const dx = x - cx;
        const dy = y - cy;
        const dist = Math.min(radius, Math.hypot(dx, dy));
        const angle = (Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360;

        wheelHue = angle;
        wheelSat = dist / radius;

        const handleX = cx + Math.cos(angle * Math.PI / 180) * dist;
        const handleY = cy + Math.sin(angle * Math.PI / 180) * dist;
        if (handle) {
            handle.style.left = `${handleX}px`;
            handle.style.top = `${handleY}px`;
        }

        refreshWheelColor();
    }

    let previousBgStyle = null;
    let previousBgOpacity = null;

    function openTintWheelModal(playlist, onApply) {
        wheelApplyCallback = onApply;
        const tintEl = document.getElementById('playlist-bg-tint');
        if (tintEl) {
            previousBgStyle = tintEl.style.background;
            previousBgOpacity = tintEl.style.opacity;
        }

        if (tintWheelCanvas) drawColorWheel(tintWheelCanvas);

        let initialColor = playlist && playlist.custom_tint ? playlist.custom_tint : { r: 253, g: 224, b: 71, hex: '#FDE047' };

        const cx = tintWheelCanvas ? tintWheelCanvas.width / 2 : 105;
        const cy = tintWheelCanvas ? tintWheelCanvas.height / 2 : 105;
        const radius = cx - 3;

        const r = initialColor.r / 255, g = initialColor.g / 255, b = initialColor.b / 255;
        const max = Math.max(r, g, b), min = Math.min(r, g, b);
        let h = 48, s = 0.85, l = (max + min) / 2;
        if (max !== min) {
            const d = max - min;
            s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
            switch (max) {
                case r: h = (g - b) / d + (g < b ? 6 : 0); break;
                case g: h = (b - r) / d + 2; break;
                case b: h = (r - g) / d + 4; break;
            }
            h *= 60;
        }

        wheelHue = h;
        wheelSat = Math.max(0.1, s);
        wheelLightness = Math.max(0.2, Math.min(0.85, l));

        if (tintBrightnessSlider) tintBrightnessSlider.value = Math.round(wheelLightness * 100);

        const dist = wheelSat * radius;
        const handleX = cx + Math.cos(wheelHue * Math.PI / 180) * dist;
        const handleY = cy + Math.sin(wheelHue * Math.PI / 180) * dist;
        if (tintWheelHandle) {
            tintWheelHandle.style.left = `${handleX}px`;
            tintWheelHandle.style.top = `${handleY}px`;
        }

        refreshWheelColor();
        if (tintWheelModal) {
            tintWheelModal.classList.remove('hidden');
            tintWheelModal.classList.add('active');
        }
    }

    function closeTintWheelModal(applied = false) {
        if (tintWheelModal) {
            tintWheelModal.classList.remove('active');
            tintWheelModal.classList.add('hidden');
        }
        isWheelDragging = false;
        if (!applied) {
            const tintEl = document.getElementById('playlist-bg-tint');
            if (tintEl && previousBgStyle !== null) {
                tintEl.style.background = previousBgStyle;
                tintEl.style.opacity = previousBgOpacity;
            }
        }
        previousBgStyle = null;
        previousBgOpacity = null;
        wheelApplyCallback = null;
    }

    if (tintWheelModal) {
        tintWheelModal.addEventListener('click', (e) => {
            if (e.target === tintWheelModal) {
                closeTintWheelModal(false);
            }
        });
    }

    const tintWheelBox = document.getElementById('tint-wheel-box');
    if (tintWheelBox && tintWheelCanvas) {
        const onStart = (e) => {
            isWheelDragging = true;
            updateWheelFromPointer(e, tintWheelCanvas, tintWheelHandle);
        };
        const onMove = (e) => {
            if (!isWheelDragging) return;
            e.preventDefault();
            updateWheelFromPointer(e, tintWheelCanvas, tintWheelHandle);
        };
        const onEnd = () => {
            isWheelDragging = false;
        };

        tintWheelBox.addEventListener('pointerdown', onStart);
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onEnd);
        window.addEventListener('pointercancel', onEnd);
    }

    if (tintBrightnessSlider) {
        tintBrightnessSlider.addEventListener('input', (e) => {
            wheelLightness = parseFloat(e.target.value) / 100;
            refreshWheelColor();
        });
    }

    if (tintWheelCloseBtn) tintWheelCloseBtn.onclick = () => closeTintWheelModal(false);
    if (tintWheelCancel) tintWheelCancel.onclick = () => closeTintWheelModal(false);

    if (tintAutoBtn) {
        tintAutoBtn.onclick = () => {
            if (wheelApplyCallback) {
                wheelApplyCallback(null);
            }
            closeTintWheelModal(true);
            showToast('Reset to automatic artwork tint');
        };
    }

    if (tintWheelApply) {
        tintWheelApply.onclick = () => {
            if (wheelApplyCallback) {
                wheelApplyCallback(currentWheelTint);
            }
            closeTintWheelModal(true);
            showToast('Playlist tint updated');
        };
    }

    if (modalOpenTintWheelBtn) {
        modalOpenTintWheelBtn.onclick = () => {
            openTintWheelModal({ custom_tint: pendingModalTint }, (newTint) => {
                pendingModalTint = newTint;
                if (modalTintDot) modalTintDot.style.backgroundColor = newTint ? newTint.hex : '#FDE047';
                if (modalTintStatus) modalTintStatus.textContent = newTint ? `Custom (${newTint.hex})` : 'Automatic (from artwork)';
            });
        };
    }

    function rgbToHsl(r, g, b) {
        r /= 255; g /= 255; b /= 255;
        const max = Math.max(r, g, b), min = Math.min(r, g, b);
        let h = 0, s = 0, l = (max + min) / 2;

        if (max !== min) {
            const d = max - min;
            s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
            switch (max) {
                case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
                case g: h = ((b - r) / d + 2) / 6; break;
                case b: h = ((r - g) / d + 4) / 6; break;
            }
        }
        return { h: h * 360, s, l };
    }

    function hslToRgb(h, s, l) {
        h = ((h % 360) + 360) % 360;
        const c = (1 - Math.abs(2 * l - 1)) * s;
        const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
        const m = l - c / 2;
        let r = 0, g = 0, b = 0;
        if (h < 60) { r = c; g = x; b = 0; }
        else if (h < 120) { r = x; g = c; b = 0; }
        else if (h < 180) { r = 0; g = c; b = x; }
        else if (h < 240) { r = 0; g = x; b = c; }
        else if (h < 300) { r = x; g = 0; b = c; }
        else { r = c; g = 0; b = x; }
        return {
            r: Math.round((r + m) * 255),
            g: Math.round((g + m) * 255),
            b: Math.round((b + m) * 255)
        };
    }

    function colorDistance(c1, c2) {
        const rmean = (c1.r + c2.r) / 2;
        const dr = c1.r - c2.r;
        const dg = c1.g - c2.g;
        const db = c1.b - c2.b;
        return Math.sqrt((((512 + rmean) * dr * dr) >> 8) + 4 * dg * dg + (((767 - rmean) * db * db) >> 8));
    }

    function ensureVibrantColor(c) {
        if (!c) return { r: 245, g: 245, b: 245 };
        let { h, s, l } = rgbToHsl(c.r, c.g, c.b);

        // Boost saturation so colors are punchy, rich, and vibrant (never dull or washed out!)
        if (s > 0.10) {
            s = Math.min(1, s * 1.35 + 0.08);
        }

        // Lift dark colors so they are slightly lighter for dark colors like black (ensures black icons/text remain legible)
        if (l < 0.38) {
            l = 0.44;
            if (s < 0.15) {
                s = 0.16;
                h = 42; // subtle warm yolk tone instead of pitch black void
            }
        } else if (l > 0.78 && s > 0.25) {
            // Keep bright colors richly saturated instead of blown out
            l = 0.68;
        }

        return hslToRgb(h, s, l);
    }

    function extractArtworkPalette(imgUrl, callback) {
        if (!imgUrl) {
            callback(null);
            return;
        }
        const img = new Image();
        const isLocal = imgUrl.startsWith('data:') || imgUrl.startsWith('blob:');
        if (!isLocal) {
            img.crossOrigin = 'Anonymous';
        }
        let retriedWithProxy = false;
        const baseSrc = isLocal ? imgUrl : getProxyUrl(imgUrl, '120x120');
        // Append cors=1 for external URLs so iOS Safari never reuses a non-CORS cached <img> response from song lists
        const targetSrc = isLocal ? baseSrc : (baseSrc + (baseSrc.includes('?') ? '&' : '?') + 'cors=1');
        img.src = targetSrc;
        img.onload = () => {
            try {
                const canvas = document.createElement('canvas');
                const ctx = canvas.getContext('2d', { willReadFrequently: true });
                canvas.width = 48;
                canvas.height = 48;
                ctx.drawImage(img, 0, 0, 48, 48);
                const data = ctx.getImageData(0, 0, 48, 48).data;

                // Extract average color of the top row of pixels (y = 0) for seamless Safari status bar tinting
                let topRowR = 0, topRowG = 0, topRowB = 0, topRowCount = 0;
                for (let x = 0; x < 48; x++) {
                    const idx = x * 4;
                    if (data[idx + 3] >= 120) {
                        topRowR += data[idx];
                        topRowG += data[idx + 1];
                        topRowB += data[idx + 2];
                        topRowCount++;
                    }
                }
                const topRowColor = topRowCount > 0 ? {
                    r: Math.round(topRowR / topRowCount),
                    g: Math.round(topRowG / topRowCount),
                    b: Math.round(topRowB / topRowCount)
                } : null;

                // Bin colors by quantizing (round to 16) to merge nearby pixels & compute accurate representation
                const colorMap = new Map();
                for (let i = 0; i < data.length; i += 4) {
                    const pr = data[i], pg = data[i+1], pb = data[i+2], pa = data[i+3];
                    if (pa < 120) continue;

                    const qr = Math.round(pr / 16) * 16;
                    const qg = Math.round(pg / 16) * 16;
                    const qb = Math.round(pb / 16) * 16;
                    const key = `${qr},${qg},${qb}`;

                    if (!colorMap.has(key)) {
                        const { h, s, l } = rgbToHsl(pr, pg, pb);
                        colorMap.set(key, { r: pr, g: pg, b: pb, h, s, l, count: 1 });
                    } else {
                        colorMap.get(key).count++;
                    }
                }

                const candidates = Array.from(colorMap.values());
                if (candidates.length === 0) {
                    callback(null);
                    return;
                }

                // Score candidate colors: strongly favor saturated & vivid tones
                candidates.forEach(c => {
                    c.score = (c.s * 3.2) + (1 - Math.abs(c.l - 0.5)) * 1.5 + Math.log(c.count + 1) * 0.4;
                });

                // Sort by vibrance score
                candidates.sort((a, b) => b.score - a.score);

                // 1st color: The most vibrant dominant color in the artwork (e.g. vibrant pinkish red!)
                const picked = [candidates[0]];

                // Use Farthest Point Sampling (Max-Min Distance) to pick the 4 MOST DIFFERENT colors in the artwork!
                while (picked.length < 4 && picked.length < candidates.length) {
                    let bestCandidate = null;
                    let bestDiversityScore = -1;

                    for (const cand of candidates) {
                        if (picked.includes(cand)) continue;

                        let minDist = Infinity;
                        for (const p of picked) {
                            const d = colorDistance(cand, p);
                            if (d < minDist) minDist = d;
                        }

                        const diversityScore = minDist * (1 + cand.s * 1.2) * (1 - Math.abs(cand.l - 0.5) * 0.5);
                        if (diversityScore > bestDiversityScore) {
                            bestDiversityScore = diversityScore;
                            bestCandidate = cand;
                        }
                    }

                    if (bestCandidate && bestDiversityScore > 35) {
                        picked.push(bestCandidate);
                    } else {
                        break;
                    }
                }

                // If monochromatic or duotone, rotate hues in HSL space for rich complementary accents
                while (picked.length < 4) {
                    const base = picked[picked.length - 1];
                    const rot = (picked.length % 2 === 1) ? 55 : -45;
                    const newH = (base.h + rot + 360) % 360;
                    const genRgb = hslToRgb(newH, Math.max(0.65, base.s), Math.max(0.44, Math.min(0.64, base.l)));
                    picked.push({
                        r: genRgb.r,
                        g: genRgb.g,
                        b: genRgb.b,
                        h: newH,
                        s: Math.max(0.65, base.s),
                        l: Math.max(0.44, Math.min(0.64, base.l))
                    });
                }

                // Apply ensureVibrantColor: keeps saturation high, prevents washed-out salmon
                const vibrantColors = picked.map(c => ensureVibrantColor(c));
                vibrantColors.topRowColor = topRowColor;
                callback(vibrantColors);
            } catch (_) {
                if (!isLocal && !retriedWithProxy && !img.src.includes('/api/proxy')) {
                    retriedWithProxy = true;
                    img.src = `/api/proxy?url=${encodeURIComponent(targetSrc)}`;
                    return;
                }
                callback(null);
            }
        };
        img.onerror = () => {
            if (!isLocal && !retriedWithProxy && !img.src.includes('/api/proxy')) {
                retriedWithProxy = true;
                img.src = `/api/proxy?url=${encodeURIComponent(targetSrc)}`;
                return;
            }
            callback(null);
        };
    }

    function applyAppleMusicNowPlayingBg(colors) {
        const meshEl = document.getElementById('now-playing-mesh');
        const fadeEl = document.getElementById('now-playing-top-safari-fade');
        const bgWrapper = document.getElementById('now-playing-bg-wrapper');
        if (!meshEl) return;

        const isDark = document.body.classList.contains('dark-mode');
        const defaultBg = isDark ? '#0c0c0e' : '#FCFBF8';

        if (!colors || colors.length === 0) {
            if (currentTrack) {
                colors = [
                    { r: 245, g: 158, b: 11 },
                    { r: 234, g: 88, b: 12 },
                    { r: 217, g: 119, b: 6 },
                    { r: 251, g: 191, b: 36 }
                ];
            } else {
                meshEl.style.opacity = '0';
                meshEl.style.background = '';
                if (fadeEl) fadeEl.style.opacity = '0';
                if (bgWrapper) bgWrapper.style.backgroundColor = defaultBg;
                return;
            }
        }

        const [c1, c2, c3, c4] = colors;
        meshEl.style.background = `
            radial-gradient(circle at 18% 20%, rgba(${c1.r}, ${c1.g}, ${c1.b}, ${isDark ? '0.42' : '0.52'}) 0%, transparent 60%),
            radial-gradient(circle at 82% 16%, rgba(${c2.r}, ${c2.g}, ${c2.b}, ${isDark ? '0.38' : '0.48'}) 0%, transparent 56%),
            radial-gradient(circle at 78% 82%, rgba(${c3.r}, ${c3.g}, ${c3.b}, ${isDark ? '0.34' : '0.42'}) 0%, transparent 58%),
            radial-gradient(circle at 20% 82%, rgba(${c4.r}, ${c4.g}, ${c4.b}, ${isDark ? '0.32' : '0.40'}) 0%, transparent 56%),
            radial-gradient(circle at 50% 50%, rgba(${c1.r}, ${c1.g}, ${c1.b}, ${isDark ? '0.20' : '0.26'}) 0%, transparent 64%)
        `;
        meshEl.style.opacity = '1';

        // Use vibrant dominant artwork palette (c1/c2) for the Now Playing top tint so letterboxed thumbnails never wash out to grey/black
        const topR = Math.round(c1.r * 0.72 + c2.r * 0.28);
        const topG = Math.round(c1.g * 0.72 + c2.g * 0.28);
        const topB = Math.round(c1.b * 0.72 + c2.b * 0.28);

        let blendR, blendG, blendB;
        if (isDark) {
            blendR = Math.round(topR * 0.55 + 12 * 0.45);
            blendG = Math.round(topG * 0.55 + 12 * 0.45);
            blendB = Math.round(topB * 0.55 + 14 * 0.45);
        } else {
            blendR = Math.round(topR * 0.72 + 252 * 0.28);
            blendG = Math.round(topG * 0.72 + 251 * 0.28);
            blendB = Math.round(topB * 0.72 + 248 * 0.28);
        }

        if (bgWrapper) {
            bgWrapper.style.backgroundColor = `rgb(${blendR}, ${blendG}, ${blendB})`;
        }

        if (fadeEl) {
            fadeEl.style.background = `linear-gradient(180deg, rgb(${blendR}, ${blendG}, ${blendB}) 0%, rgba(${blendR}, ${blendG}, ${blendB}, 0.78) 42%, transparent 100%)`;
            fadeEl.style.opacity = '1';
        }

        currentCoverColor = { r: blendR, g: blendG, b: blendB };
        if (typeof updateTopNavTint === 'function') {
            updateTopNavTint();
        }
    }

    function applyPlaylistMultiTint(colors) {
        if (!currentPlaylistContextId || currentPlaylistContextId === 'favorites' || currentPlaylistContextId === 'downloaded') {
            clearPlaylistTint();
            return;
        }
        const tintEl = document.getElementById('playlist-bg-tint');
        if (!tintEl) return;
        if (!colors || colors.length === 0) {
            clearPlaylistTint();
            return;
        }
        const [c1, c2, c3, c4] = colors;
        currentPlaylistTintRgb = c1;
        tintEl.style.background = `
            linear-gradient(180deg, rgba(${c1.r}, ${c1.g}, ${c1.b}, 0.36) 0%, rgba(${c1.r}, ${c1.g}, ${c1.b}, 0.18) 45%, rgba(${c2.r}, ${c2.g}, ${c2.b}, 0.12) 100%),
            radial-gradient(ellipse at 18% 12%, rgba(${c1.r}, ${c1.g}, ${c1.b}, 0.44) 0%, transparent 64%),
            radial-gradient(ellipse at 82% 16%, rgba(${c2.r}, ${c2.g}, ${c2.b}, 0.38) 0%, transparent 60%),
            radial-gradient(ellipse at 32% 52%, rgba(${c3.r}, ${c3.g}, ${c3.b}, 0.30) 0%, transparent 64%),
            radial-gradient(ellipse at 78% 76%, rgba(${c4.r}, ${c4.g}, ${c4.b}, 0.26) 0%, transparent 64%)
        `;
        tintEl.style.maskImage = 'none';
        tintEl.style.webkitMaskImage = 'none';
        tintEl.style.opacity = '1';
        applyPlaylistThemeUI(c1.r, c1.g, c1.b);
    }

    function hexToRgbObj(hex) {
        if (!hex || typeof hex !== 'string') return null;
        const clean = hex.replace('#', '').trim();
        if (clean.length === 3) {
            return {
                r: parseInt(clean[0] + clean[0], 16),
                g: parseInt(clean[1] + clean[1], 16),
                b: parseInt(clean[2] + clean[2], 16)
            };
        }
        if (clean.length === 6) {
            return {
                r: parseInt(clean.substring(0, 2), 16),
                g: parseInt(clean.substring(2, 4), 16),
                b: parseInt(clean.substring(4, 6), 16)
            };
        }
        return null;
    }

    function formatTotalDurationText(trackList) {
        if (!Array.isArray(trackList) || trackList.length === 0) {
            return '0 songs • 0 min';
        }
        let totalSec = 0;
        for (const t of trackList) {
            if (!t) continue;
            const rawDur = Number(t.duration) || 0;
            if (rawDur > 0) {
                totalSec += rawDur > 1000 ? (rawDur / 1000) : rawDur;
            } else {
                totalSec += 195; // fallback ~3:15 estimate when metadata duration is 0
            }
        }
        totalSec = Math.round(totalSec);
        const hrs = Math.floor(totalSec / 3600);
        const mins = Math.floor((totalSec % 3600) / 60);
        const secs = totalSec % 60;
        const songCountStr = `${trackList.length} ${trackList.length === 1 ? 'song' : 'songs'}`;
        if (hrs > 0) {
            return `${songCountStr} • ${hrs} hr ${mins} min`;
        }
        if (mins > 0) {
            return `${songCountStr} • ${mins} min ${secs} sec`;
        }
        return `${songCountStr} • ${secs} sec`;
    }

    // Client-side image compression for playlist covers (persisted in localStorage as base64)
    function compressImage(file, maxSize, callback) {
        if (!file) return callback(null);
        const reader = new FileReader();
        reader.onload = (e) => {
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement('canvas');
                let width = img.width;
                let height = img.height;
                if (width > height) {
                    if (width > maxSize) {
                        height = Math.round((height * maxSize) / width);
                        width = maxSize;
                    }
                } else {
                    if (height > maxSize) {
                        width = Math.round((width * maxSize) / height);
                        height = maxSize;
                    }
                }
                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, width, height);
                const dataUrl = canvas.toDataURL('image/jpeg', 0.82);
                callback(dataUrl);
            };
            img.onerror = () => callback(null);
            img.src = e.target.result;
        };
        reader.onerror = () => callback(null);
        reader.readAsDataURL(file);
    }

    function renderLibrary() {
        if (!libraryGrid) return;
        libraryGrid.innerHTML = '';

        // 1. Favorites Card (black heart on light greyish white background)
        const favCard = document.createElement('div');
        favCard.className = 'group cursor-pointer bubbly-hover text-left';
        favCard.innerHTML = `
            <div class="w-full aspect-square bg-[#F4F4F5] rounded-2xl border border-zinc-200/80 mb-2 relative overflow-hidden flex items-center justify-center shadow-sm group-hover:shadow-md transition-all text-zinc-900">
                <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.5"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg>
            </div>
            <h3 class="font-semibold text-xs sm:text-sm text-zinc-900 truncate">Favorites</h3>
            <p class="text-[11px] text-zinc-500 mt-0.5">${favorites.length} ${favorites.length === 1 ? 'song' : 'songs'}</p>
        `;
        favCard.addEventListener('click', () => {
            openPlaylistDetail('favorites');
        });
        libraryGrid.appendChild(favCard);

        // 2. Custom Playlists Cards (All library tracks automatically download offline)
        playlists.forEach((pl) => {
            const plCard = document.createElement('div');
            plCard.className = 'group cursor-pointer bubbly-hover text-left';
            const coverSrc = pl.cover || (pl.tracks && pl.tracks[0] ? getProxyUrl(pl.tracks[0].artwork_url || pl.tracks[0].image, '150x150') : '');

            plCard.innerHTML = `
                <div class="w-full aspect-square bg-zinc-100 rounded-2xl border border-zinc-200/60 mb-2 relative overflow-hidden flex items-center justify-center shadow-sm group-hover:shadow-md transition-all">
                    ${coverSrc ? `<img src="${coverSrc}" class="w-full h-full object-cover" referrerpolicy="no-referrer">` : `
                        <div class="text-zinc-400">
                            <svg xmlns="http://www.w3.org/2000/svg" width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg>
                        </div>
                    `}
                </div>
                <h3 class="font-semibold text-xs sm:text-sm text-zinc-900 truncate">${escapeHtml(pl.name)}</h3>
                <p class="text-[11px] text-zinc-500 mt-0.5">${pl.tracks ? pl.tracks.length : 0} ${pl.tracks && pl.tracks.length === 1 ? 'song' : 'songs'}</p>
            `;
            plCard.addEventListener('click', () => {
                openPlaylistDetail(pl.id);
            });
            libraryGrid.appendChild(plCard);
        });
    }

    // Open Playlist Detail View (does NOT automatically play!)
    async function openPlaylistDetail(playlistId) {
        currentPlaylistContextId = playlistId;

        const detailArt = document.getElementById('playlist-detail-art');
        const detailArtImg = document.getElementById('playlist-detail-img');
        const detailArtIcon = document.getElementById('playlist-detail-icon');
        const detailUploadOverlay = document.getElementById('playlist-detail-upload-overlay');
        const detailName = document.getElementById('playlist-detail-name');
        const detailDesc = document.getElementById('playlist-detail-desc');
        const detailMeta = document.getElementById('playlist-detail-meta');
        const playAllBtn = document.getElementById('playlist-play-all-btn');
        const editBtn = document.getElementById('playlist-edit-btn');
        const deleteBtn = document.getElementById('playlist-delete-btn');
        const trackListContainer = document.getElementById('playlist-track-list');

        let playlistName = '';
        let playlistDesc = '';
        let trackList = [];
        let isFav = false;

        if (playlistId === 'favorites') {
            isFav = true;
            playlistName = 'Favorites';
            playlistDesc = 'Your liked songs collection';
            trackList = favorites;

            // Remove all tints altogether for Favorites & system playlists
            clearPlaylistTint();

            if (detailArt) {
                detailArt.className = 'w-32 h-32 sm:w-48 sm:h-48 md:w-52 md:h-52 rounded-2xl bg-[#F4F4F5] flex items-center justify-center overflow-hidden shrink-0 shadow-[0_16px_36px_rgba(0,0,0,0.08)] border border-zinc-200/80 relative';
                detailArt.title = 'Favorites';
                detailArt.style.cursor = 'default';
            }
            if (detailUploadOverlay) detailUploadOverlay.classList.add('hidden');

            detailArtImg.classList.add('hidden');
            detailArtIcon.classList.remove('hidden');
            detailArtIcon.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.5" class="text-zinc-900"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg>`;
            editBtn.classList.add('hidden');
            deleteBtn.classList.add('hidden');
        } else {
            const pl = playlists.find(p => p.id === playlistId);
            if (!pl) return;
            playlistName = pl.name;
            playlistDesc = (pl.description && pl.description !== '[object Object]' && pl.description !== 'undefined') ? pl.description : '';
            trackList = pl.tracks || [];

            if (detailArt) {
                detailArt.className = 'w-32 h-32 sm:w-48 sm:h-48 md:w-52 md:h-52 rounded-2xl bg-zinc-100 flex items-center justify-center overflow-hidden shrink-0 shadow-[0_16px_36px_rgba(0,0,0,0.12)] border border-white/60 relative group/art cursor-pointer';
                detailArt.title = 'Click to upload album cover';
                detailArt.style.cursor = 'pointer';
            }
            if (detailUploadOverlay) detailUploadOverlay.classList.remove('hidden');

            const coverSrc = pl.cover || (trackList[0] ? getProxyUrl(trackList[0].artwork_url || trackList[0].image, '300x300') : '');
            if (coverSrc) {
                detailArtImg.src = coverSrc;
                detailArtImg.classList.remove('hidden');
                detailArtIcon.classList.add('hidden');
            } else {
                detailArtImg.classList.add('hidden');
                detailArtIcon.classList.remove('hidden');
                detailArtIcon.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg>`;
            }

            if (pl.custom_tint && pl.custom_tint.r !== undefined) {
                applyPlaylistTint(pl.custom_tint.r, pl.custom_tint.g, pl.custom_tint.b);
            } else if (coverSrc && coverSrc.startsWith('data:image/svg+xml')) {
                const decodedSvg = decodeURIComponent(coverSrc);
                const hexMatch = decodedSvg.match(/fill="(#[0-9a-fA-F]{3,6})"/);
                const svgRgb = hexMatch ? hexToRgbObj(hexMatch[1]) : null;
                if (svgRgb && !(svgRgb.r > 245 && svgRgb.g > 245 && svgRgb.b > 245)) {
                    applyPlaylistTint(svgRgb.r, svgRgb.g, svgRgb.b);
                } else {
                    applyPlaylistTint(250, 204, 21);
                }
            } else if (coverSrc) {
                extractArtworkPalette(coverSrc, (colors) => {
                    const freshPl = playlists.find(p => p.id === playlistId);
                    if (freshPl && freshPl.custom_tint) return;
                    if (colors) {
                        applyPlaylistMultiTint(colors);
                    } else {
                        applyPlaylistTint(253, 224, 71);
                    }
                });
            } else {
                applyPlaylistTint(250, 204, 21);
            }

            editBtn.classList.remove('hidden');
            deleteBtn.classList.remove('hidden');

            editBtn.onclick = () => {
                openEditPlaylistModal(pl);
            };

            deleteBtn.onclick = () => {
                if (confirm(`Are you sure you want to delete the playlist "${pl.name}"?`)) {
                    playlists = playlists.filter(p => p.id !== playlistId);
                    savePlaylists();
                    showToast('Playlist deleted');
                    closePlaylistDetail();
                }
            };
        }

        const totalSummaryText = formatTotalDurationText(trackList);
        detailName.textContent = playlistName;
        detailDesc.textContent = playlistDesc;
        if (detailDesc) {
            detailDesc.classList.toggle('hidden', !playlistDesc);
        }
        detailMeta.textContent = totalSummaryText;

        const tracksCountEl = document.getElementById('playlist-tracks-count');
        if (tracksCountEl) tracksCountEl.textContent = `${trackList.length} ${trackList.length === 1 ? 'track' : 'tracks'}`;

        const footerSummaryEl = document.getElementById('playlist-footer-summary');
        if (footerSummaryEl) footerSummaryEl.textContent = totalSummaryText;

        const tracksCard = document.getElementById('playlist-tracks-card');
        if (tracksCard) {
            if (trackList.length === 0) {
                tracksCard.classList.add('min-h-[260px]');
            } else {
                tracksCard.classList.remove('min-h-[260px]', 'min-h-[460px]');
            }
        }

        playAllBtn.onclick = () => {
            if (trackList.length > 0) {
                currentQueue = [...trackList];
                currentQueueIndex = 0;
                currentPlayingPlaylistContextId = playlistId;
                playTrack(currentQueue[0]);
            } else {
                showToast('Playlist is empty. Add some tracks first!');
            }
        };

        const downloadAllBtn = document.getElementById('playlist-download-all-btn');
        if (downloadAllBtn) {
            if (trackList.length === 0) {
                downloadAllBtn.classList.add('hidden');
                window._updatePlaylistDownloadAllBtn = null;
            } else {
                downloadAllBtn.classList.remove('hidden');
                const updateDownloadAllStatus = async () => {
                    const checks = await Promise.all(trackList.map(t => YolkOfflineDB.isDownloaded(getTrackUid(t))));
                    const allDownloaded = checks.length > 0 && checks.every(Boolean);
                    if (allDownloaded) {
                        downloadAllBtn.title = 'Undownload All Playlist Songs';
                        downloadAllBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#059669" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>`;
                    } else {
                        downloadAllBtn.title = 'Download Entire Playlist';
                        downloadAllBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>`;
                    }
                    return allDownloaded;
                };
                window._updatePlaylistDownloadAllBtn = updateDownloadAllStatus;
                updateDownloadAllStatus();

                downloadAllBtn.onclick = async () => {
                    const isAll = await updateDownloadAllStatus();
                    if (isAll) {
                        if (confirm(`Remove all downloaded songs in "${playlistName}" from offline storage?`)) {
                            for (const t of trackList) {
                                await YolkOfflineDB.deleteTrack(getTrackUid(t));
                            }
                            if (typeof window.refreshAllDownloadButtonsUI === 'function') {
                                window.refreshAllDownloadButtonsUI();
                            }
                        }
                    } else {
                        enqueueLibraryDownload(trackList);
                    }
                };
            }
        }

        trackListContainer.innerHTML = '';
        if (trackList.length === 0) {
            trackListContainer.innerHTML = `
                <div class="py-16 text-center text-zinc-400">
                    <p class="text-sm font-medium">This playlist is empty.</p>
                    <p class="text-xs text-zinc-500 mt-1">Search for songs and click the playlist button to add them here.</p>
                </div>
            `;
        } else {
            trackList.forEach((track, idx) => {
                const el = createTrackElement(
                    track,
                    () => {
                        const freshList = isFav ? favorites : (playlists.find(p => p.id === playlistId)?.tracks || trackList);
                        const freshIdx = freshList.findIndex(t => getTrackUid(t) === getTrackUid(track));
                        currentQueue = [...freshList];
                        currentQueueIndex = freshIdx >= 0 ? freshIdx : idx;
                        currentPlayingPlaylistContextId = playlistId;
                        playTrack(track);
                    },
                    () => {
                        if (isFav) {
                            toggleFavorite(track, null);
                        } else if (playlistId === 'downloaded') {
                            YolkOfflineDB.deleteTrack(getTrackUid(track)).then(() => {
                                showToast('Removed from offline downloads');
                                openPlaylistDetail('downloaded');
                            });
                        } else {
                            removeTrackFromPlaylist(playlistId, getTrackUid(track));
                        }
                    },
                    { reorderable: true }
                );
                trackListContainer.appendChild(el);
            });

            enableListReordering(trackListContainer, (fromIdx, toIdx) => {
                const listRef = isFav ? favorites : (playlists.find(p => p.id === playlistId)?.tracks || null);
                if (!Array.isArray(listRef) || fromIdx < 0 || toIdx < 0 || fromIdx >= listRef.length || toIdx >= listRef.length) return;
                const [moved] = listRef.splice(fromIdx, 1);
                listRef.splice(toIdx, 0, moved);
                if (isFav) {
                    saveFavorites();
                } else {
                    savePlaylists();
                }
                if (currentPlayingPlaylistContextId === playlistId && currentTrack) {
                    currentQueue = [...listRef];
                    const newCurIdx = currentQueue.findIndex(t => getTrackUid(t) === getTrackUid(currentTrack));
                    if (newCurIdx >= 0) currentQueueIndex = newCurIdx;
                }
                showToast('Playlist order updated');
            });
        }

        libraryOverview.classList.add('hidden');
        playlistDetailView.classList.remove('hidden');

        // Scroll playlist view to top smoothly
        const scrollContainer = document.getElementById('page-library-scroll');
        if (scrollContainer) scrollContainer.scrollTop = 0;
    }
    window.openPlaylistDetail = openPlaylistDetail;

    // Cover upload from Playlist Detail Hero Art
    const playlistDetailArt = document.getElementById('playlist-detail-art');
    const playlistDetailCoverInput = document.getElementById('playlist-detail-cover-input');
    if (playlistDetailArt && playlistDetailCoverInput) {
        playlistDetailArt.addEventListener('click', () => {
            if (currentPlaylistContextId && currentPlaylistContextId !== 'favorites') {
                window._yolkFilePickerOpen = true;
                playlistDetailCoverInput.click();
            }
        });

        playlistDetailCoverInput.addEventListener('change', (e) => {
            window._yolkFilePickerOpen = false;
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = (re) => {
                openCropper(re.target.result, (croppedBase64) => {
                    const pl = playlists.find(p => p.id === currentPlaylistContextId);
                    if (pl) {
                        pl.cover = croppedBase64;
                        savePlaylists();
                        showToast('Playlist cover updated');
                        openPlaylistDetail(pl.id);
                        renderLibrary();
                    }
                });
            };
            reader.readAsDataURL(file);
            playlistDetailCoverInput.value = '';
        });
    }

    function closePlaylistDetail() {
        currentPlaylistContextId = null;
        window._updatePlaylistDownloadAllBtn = null;
        clearPlaylistTint();
        playlistDetailView.classList.add('hidden');
        libraryOverview.classList.remove('hidden');
        renderLibrary();
    }

    if (playlistBackBtn) {
        playlistBackBtn.onclick = closePlaylistDetail;
    }

    function removeTrackFromPlaylist(playlistId, trackUid) {
        const pl = playlists.find(p => p.id === playlistId);
        if (pl && pl.tracks) {
            pl.tracks = pl.tracks.filter(t => getTrackUid(t) !== trackUid);
            savePlaylists();
            showToast('Removed from playlist');
            openPlaylistDetail(playlistId);
        }
    }

    // ============================================
    // 1:1 SQUARE IMAGE CROPPER MODAL
    // ============================================
    let cropImg = new Image();
    let cropZoom = 1;
    let cropMinZoom = 1;
    let cropPanX = 0;
    let cropPanY = 0;
    let isCropperDragging = false;
    let cropStartX = 0;
    let cropStartY = 0;
    let cropOnDoneCallback = null;

    const cropModal = document.getElementById('crop-modal');
    const cropCanvas = document.getElementById('crop-canvas');
    const cropZoomSlider = document.getElementById('crop-zoom-slider');
    const cropCancelBtn = document.getElementById('crop-cancel-btn');
    const cropApplyBtn = document.getElementById('crop-apply-btn');

    function drawCropCanvas() {
        if (!cropCanvas || !cropImg.complete || cropImg.naturalWidth === 0) return;
        const ctx = cropCanvas.getContext('2d');
        const cW = cropCanvas.width;
        const cH = cropCanvas.height;
        ctx.clearRect(0, 0, cW, cH);

        const currentW = cropImg.naturalWidth * cropZoom;
        const currentH = cropImg.naturalHeight * cropZoom;

        // Bounded pan coordinates
        if (cropPanX > 0) cropPanX = 0;
        if (cropPanY > 0) cropPanY = 0;
        if (cropPanX < cW - currentW) cropPanX = cW - currentW;
        if (cropPanY < cH - currentH) cropPanY = cH - currentH;

        ctx.drawImage(cropImg, cropPanX, cropPanY, currentW, currentH);
    }

    function closeCropperModal() {
        if (cropModal) {
            cropModal.classList.remove('active');
            cropModal.classList.add('hidden');
        }
        isCropperDragging = false;
    }

    function openCropper(imageSrc, onDone) {
        cropOnDoneCallback = onDone;
        cropImg = new Image();
        cropImg.onload = () => {
            const cW = cropCanvas ? cropCanvas.width : 240;
            const cH = cropCanvas ? cropCanvas.height : 240;
            const scaleX = cW / cropImg.naturalWidth;
            const scaleY = cH / cropImg.naturalHeight;
            cropMinZoom = Math.max(scaleX, scaleY);
            cropZoom = cropMinZoom;

            cropPanX = (cW - cropImg.naturalWidth * cropZoom) / 2;
            cropPanY = (cH - cropImg.naturalHeight * cropZoom) / 2;

            if (cropZoomSlider) {
                cropZoomSlider.min = cropMinZoom;
                cropZoomSlider.max = cropMinZoom * 3.5;
                cropZoomSlider.step = (cropMinZoom * 2.5) / 100;
                cropZoomSlider.value = cropZoom;
            }

            if (cropModal) {
                cropModal.classList.remove('hidden');
                cropModal.classList.add('active');
            }
            requestAnimationFrame(() => drawCropCanvas());
        };
        cropImg.src = imageSrc;
    }

    let pinchStartDist = 0;
    let pinchStartZoom = 1;

    if (cropCanvas) {
        cropCanvas.addEventListener('mousedown', (e) => {
            isCropperDragging = true;
            cropStartX = e.clientX;
            cropStartY = e.clientY;
        });
        window.addEventListener('mousemove', (e) => {
            if (!isCropperDragging) return;
            const rect = cropCanvas.getBoundingClientRect();
            const scaleFactor = rect.width > 0 ? (cropCanvas.width / rect.width) : 1;
            const dx = (e.clientX - cropStartX) * scaleFactor;
            const dy = (e.clientY - cropStartY) * scaleFactor;
            cropStartX = e.clientX;
            cropStartY = e.clientY;
            cropPanX += dx;
            cropPanY += dy;
            drawCropCanvas();
        });
        window.addEventListener('mouseup', () => {
            isCropperDragging = false;
        });

        cropCanvas.addEventListener('touchstart', (e) => {
            if (e.touches.length === 1) {
                isCropperDragging = true;
                cropStartX = e.touches[0].clientX;
                cropStartY = e.touches[0].clientY;
            } else if (e.touches.length === 2) {
                isCropperDragging = false;
                pinchStartDist = Math.hypot(
                    e.touches[0].clientX - e.touches[1].clientX,
                    e.touches[0].clientY - e.touches[1].clientY
                );
                pinchStartZoom = cropZoom;
            }
        }, { passive: false });
        cropCanvas.addEventListener('touchmove', (e) => {
            if (e.touches.length === 1 && isCropperDragging) {
                e.preventDefault();
                const rect = cropCanvas.getBoundingClientRect();
                const scaleFactor = rect.width > 0 ? (cropCanvas.width / rect.width) : 1;
                const dx = (e.touches[0].clientX - cropStartX) * scaleFactor;
                const dy = (e.touches[0].clientY - cropStartY) * scaleFactor;
                cropStartX = e.touches[0].clientX;
                cropStartY = e.touches[0].clientY;
                cropPanX += dx;
                cropPanY += dy;
                drawCropCanvas();
            } else if (e.touches.length === 2 && pinchStartDist > 0) {
                e.preventDefault();
                const dist = Math.hypot(
                    e.touches[0].clientX - e.touches[1].clientX,
                    e.touches[0].clientY - e.touches[1].clientY
                );
                const prevZoom = cropZoom;
                cropZoom = Math.min(Math.max(pinchStartZoom * (dist / pinchStartDist), cropMinZoom), cropMinZoom * 3.5);
                if (cropZoomSlider) cropZoomSlider.value = cropZoom;
                const centerX = cropCanvas.width / 2;
                const centerY = cropCanvas.height / 2;
                cropPanX = centerX - ((centerX - cropPanX) * (cropZoom / prevZoom));
                cropPanY = centerY - ((centerY - cropPanY) * (cropZoom / prevZoom));
                drawCropCanvas();
            }
        }, { passive: false });
        window.addEventListener('touchend', () => {
            isCropperDragging = false;
            pinchStartDist = 0;
        });

        cropCanvas.addEventListener('wheel', (e) => {
            e.preventDefault();
            const factor = e.deltaY < 0 ? 1.06 : 0.94;
            const newZoom = Math.min(Math.max(cropZoom * factor, cropMinZoom), cropMinZoom * 3.5);
            const prevZoom = cropZoom;
            cropZoom = newZoom;
            if (cropZoomSlider) cropZoomSlider.value = cropZoom;

            const rect = cropCanvas.getBoundingClientRect();
            const mouseX = (e.clientX - rect.left) * (cropCanvas.width / rect.width);
            const mouseY = (e.clientY - rect.top) * (cropCanvas.height / rect.height);
            cropPanX = mouseX - ((mouseX - cropPanX) * (cropZoom / prevZoom));
            cropPanY = mouseY - ((mouseY - cropPanY) * (cropZoom / prevZoom));
            drawCropCanvas();
        }, { passive: false });
    }

    if (cropZoomSlider) {
        cropZoomSlider.addEventListener('input', (e) => {
            const prevZoom = cropZoom;
            cropZoom = parseFloat(e.target.value);
            const centerX = cropCanvas.width / 2;
            const centerY = cropCanvas.height / 2;
            cropPanX = centerX - ((centerX - cropPanX) * (cropZoom / prevZoom));
            cropPanY = centerY - ((centerY - cropPanY) * (cropZoom / prevZoom));
            drawCropCanvas();
        });
    }

    if (cropCancelBtn && cropModal) {
        cropCancelBtn.onclick = () => {
            closeCropperModal();
        };
    }

    if (cropModal) {
        cropModal.addEventListener('click', (e) => {
            if (e.target === cropModal) closeCropperModal();
        });
    }

    if (cropApplyBtn && cropModal) {
        cropApplyBtn.onclick = () => {
            const outCanvas = document.createElement('canvas');
            outCanvas.width = 400;
            outCanvas.height = 400;
            const outCtx = outCanvas.getContext('2d');
            const ratio = 400 / (cropCanvas ? cropCanvas.width : 240);

            outCtx.drawImage(
                cropImg,
                cropPanX * ratio,
                cropPanY * ratio,
                cropImg.naturalWidth * cropZoom * ratio,
                cropImg.naturalHeight * cropZoom * ratio
            );

            const croppedBase64 = outCanvas.toDataURL('image/jpeg', 0.88);
            closeCropperModal();
            if (typeof cropOnDoneCallback === 'function') {
                cropOnDoneCallback(croppedBase64);
            }
        };
    }

    // ============================================
    // 16-COLOR PALETTE & 40 EVENT/OBJECT ICONS
    // ============================================
    const PALETTE_16_COLORS = [
        { name: 'Onyx', hex: '#18181B' },
        { name: 'White', hex: '#FFFFFF' },
        { name: 'Red', hex: '#EF4444' },
        { name: 'Orange', hex: '#F97316' },
        { name: 'Amber', hex: '#F59E0B' },
        { name: 'Emerald', hex: '#10B981' },
        { name: 'Teal', hex: '#14B8A6' },
        { name: 'Cyan', hex: '#06B6D4' },
        { name: 'Blue', hex: '#3B82F6' },
        { name: 'Indigo', hex: '#6366F1' },
        { name: 'Violet', hex: '#8B5CF6' },
        { name: 'Purple', hex: '#A855F7' },
        { name: 'Pink', hex: '#EC4899' },
        { name: 'Rose', hex: '#F43F5E' },
        { name: 'Lime', hex: '#84CC16' },
        { name: 'Slate', hex: '#475569' }
    ];

    const PLAYLIST_40_ICONS = [
        { id: 'car', name: 'Road Trip / Travel', svg: '<path d="M19 17h2c.6 0 1-.4 1-1v-3c0-.9-.7-1.7-1.5-1.9C18.7 10.6 16 10 16 10s-1.3-1.4-2.2-2.3c-.5-.4-1.1-.7-1.8-.7H5c-.6 0-1.1.4-1.4.9l-1.4 2.9A3.7 3.7 0 0 0 2 12v4c0 .6.4 1 1 1h2"/><circle cx="7" cy="17" r="2"/><circle cx="17" cy="17" r="2"/>' },
        { id: 'snowflake', name: 'Winter / Snow', svg: '<path d="M2 12h20M12 2v20M20 16l-4-4 4-4M4 8l4 4-4 4M16 4l-4 4-4-4M8 20l4-4 4 4"/>' },
        { id: 'sun', name: 'Summer Vibes', svg: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>' },
        { id: 'moon', name: 'Night Drive / Lofi', svg: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>' },
        { id: 'cloud-rain', name: 'Rainy Day', svg: '<path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242M16 14v6M8 14v6M12 16v6"/>' },
        { id: 'dumbbell', name: 'Gym / Workout', svg: '<path d="m6.5 6.5 11 11M21 21l-1-1M3 3l1 1M18 22l4-4M2 6l4-4M3 10l7-7M14 21l7-7"/>' },
        { id: 'flame', name: 'Hype / Lit', svg: '<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>' },
        { id: 'coffee', name: 'Focus / Coffee', svg: '<path d="M17 8h1a4 4 0 1 1 0 8h-1M3 8h14v9a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4Z M6 2v2M10 2v2M14 2v2"/>' },
        { id: 'headphones', name: 'Beats / Audio', svg: '<path d="M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a9 9 0 0 1 18 0v7a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3"/>' },
        { id: 'zap', name: 'High Energy', svg: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>' },
        { id: 'plane', name: 'Vacation / Travel', svg: '<path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z"/>' },
        { id: 'palmtree', name: 'Beach / Tropical', svg: '<path d="M13 8c0-2.76-2.46-5-5.5-5S2 5.24 2 8h11zm0 0c0-2.76 2.46-5 5.5-5S24 5.24 24 8H13zm-1 0v14"/>' },
        { id: 'waves', name: 'Surf / Chill Waves', svg: '<path d="M2 6c.6.5 1.2 1 2.5 1C7 7 7 5 9.5 5c2.6 0 2.4 2 5 2 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1M2 12c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 2.6 0 2.4 2 5 2 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1M2 18c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 2.6 0 2.4 2 5 2 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1"/>' },
        { id: 'gamepad', name: 'Gaming / Stream', svg: '<line x1="6" y1="12" x2="10" y2="12"/><line x1="8" y1="10" x2="8" y2="14"/><line x1="15" y1="13" x2="15.01" y2="13"/><line x1="18" y1="11" x2="18.01" y2="11"/><rect width="20" height="12" x="2" y="6" rx="6"/>' },
        { id: 'book', name: 'Reading / Study', svg: '<path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1-2.5-2.5Z"/><path d="M6 2v20"/>' },
        { id: 'cocktail', name: 'Party / Drinks', svg: '<path d="M8 22h8M12 15v7M19 3H5l7 8 7-8Z"/>' },
        { id: 'pizza', name: 'Hangout / Food', svg: '<path d="m19 17-5.5-5.5a2.12 2.12 0 0 0-3 3L16 20l5-3z"/><path d="m5 19 5.5-5.5a2.12 2.12 0 0 0-3-3L2 16l3 3z"/><path d="m15 4 4 4M9 10l-4 4"/>' },
        { id: 'music', name: 'Rock / Indie', svg: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>' },
        { id: 'mic', name: 'Singing / Karaoke', svg: '<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v4M8 23h8"/>' },
        { id: 'radio', name: 'Retro / Lo-Fi', svg: '<path d="M4.9 19.1C1 15.2 1 8.8 4.9 4.9M7.8 16.2c-2.3-2.3-2.3-6.1 0-8.5M12 12h.01M16.2 7.8c2.3 2.3 2.3 6.1 0 8.5M19.1 4.9C23 8.8 23 15.1 19.1 19"/>' },
        { id: 'disc', name: 'Vinyl / Classics', svg: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3"/>' },
        { id: 'heart', name: 'Romance / Love', svg: '<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/>' },
        { id: 'heart-crack', name: 'Heartbreak / Sad', svg: '<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7ZM12 5l-2 5 4 4-3 5"/>' },
        { id: 'star', name: 'Top Hits', svg: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>' },
        { id: 'flower', name: 'Spring / Fresh', svg: '<path d="M12 7.5a4.5 4.5 0 1 1 4.5 4.5M12 7.5A4.5 4.5 0 1 0 7.5 12M12 7.5V9m4.5 3a4.5 4.5 0 1 1-4.5 4.5M16.5 12H15m-4.5 4.5a4.5 4.5 0 1 1-4.5-4.5M12 16.5V15m-4.5-3H9"/>' },
        { id: 'leaf', name: 'Autumn / Cozy', svg: '<path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10Z"/><path d="M2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12"/>' },
        { id: 'tent', name: 'Camp / Outdoors', svg: '<path d="m19 20-7-14-7 14M12 6v14M2 20h20"/>' },
        { id: 'bike', name: 'Cruising / Bike', svg: '<circle cx="5.5" cy="17.5" r="3.5"/><circle cx="18.5" cy="17.5" r="3.5"/><path d="M15 6a1 1 0 1 0 0-2 1 1 0 0 0 0 2zm-3 11.5L9 11l3-5 3.5 3h3.5"/>' },
        { id: 'sneaker', name: 'Running / Pace', svg: '<path d="M4 16v-2.38C4 11.5 6.01 9.6 8.38 9.6H11l4-5h4v6l-2 3v4.5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2.12Z"/>' },
        { id: 'sparkles', name: 'Magic / Sparkles', svg: '<path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3Z"/>' },
        { id: 'rocket', name: 'Launch / Future', svg: '<path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09zM12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/>' },
        { id: 'building', name: 'City / Metro', svg: '<rect width="16" height="20" x="4" y="2" rx="2" ry="2"/><path d="M9 22v-4h6v4M8 6h.01M16 6h.01M12 6h.01M12 10h.01M12 14h.01M16 10h.01M16 14h.01M8 10h.01M8 14h.01"/>' },
        { id: 'ghost', name: 'Spooky / Halloween', svg: '<path d="M9 10h.01M15 10h.01M12 2a8 8 0 0 0-8 8v12l3-3 2.5 2.5L12 19l2.5 2.5L17 19l3 3V10a8 8 0 0 0-8-8z"/>' },
        { id: 'gift', name: 'Holiday / Gift', svg: '<rect x="3" y="8" width="18" height="4" rx="1"/><path d="M12 8v13M19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7M7.5 8a2.5 2.5 0 0 1 0-5A4.8 8 0 0 1 12 8a4.8 8 0 0 1 4.5-5 2.5 2.5 0 0 1 0 5"/>' },
        { id: 'trophy', name: 'Win / Champion', svg: '<path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6M18 9h1.5a2.5 2.5 0 0 0 0-5H18M4 22h16M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22M18 2H6v7a6 6 0 0 0 12 0V2Z"/>' },
        { id: 'compass', name: 'Discovery / Zen', svg: '<circle cx="12" cy="12" r="10"/><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"/>' },
        { id: 'sunset', name: 'Sunset / Golden Hour', svg: '<path d="M12 10V2M4.93 10.93 3.52 9.51M19.07 10.93l1.41-1.42M22 18H2M16 18a4 4 0 0 0-8 0"/>' },
        { id: 'sparkle', name: 'Acoustic / Glow', svg: '<path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/>' },
        { id: 'film', name: 'Movie / Cinema', svg: '<rect width="20" height="20" x="2" y="2" rx="2.18" ry="2.18"/><line x1="7" y1="2" x2="7" y2="22"/><line x1="17" y1="2" x2="17" y2="22"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="2" y1="7" x2="7" y2="7"/><line x1="2" y1="17" x2="7" y2="17"/><line x1="17" y1="17" x2="22" y2="17"/><line x1="17" y1="7" x2="22" y2="7"/>' },
        { id: 'smile', name: 'Good Vibes / Happy', svg: '<circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2M9 9h.01M15 9h.01"/>' }
    ];

    let selectedCoverColor = PALETTE_16_COLORS[0].hex;
    let selectedCoverIcon = PLAYLIST_40_ICONS[0];

    function generateColorIconCover(bgColor, iconSvgInner) {
        const isWhite = bgColor.toLowerCase() === '#ffffff' || bgColor.toLowerCase() === '#fff';
        const iconStroke = isWhite ? '#18181b' : '#ffffff';
        const innerBorder = isWhite ? `<rect width="394" height="394" x="3" y="3" rx="38" fill="none" stroke="#d4d4d8" stroke-width="6"/>` : '';
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400" viewBox="0 0 400 400"><rect width="400" height="400" rx="40" fill="${bgColor}"/>${innerBorder}<g transform="translate(100, 100) scale(8.33)" stroke="${iconStroke}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none">${iconSvgInner}</g></svg>`;
        return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
    }

    function renderColorPalette() {
        const paletteEl = document.getElementById('playlist-color-palette');
        if (!paletteEl) return;
        paletteEl.innerHTML = '';
        PALETTE_16_COLORS.forEach(c => {
            const btn = document.createElement('button');
            btn.type = 'button';
            const isSelected = selectedCoverColor.toLowerCase() === c.hex.toLowerCase();
            const isWhite = c.hex.toLowerCase() === '#ffffff';
            const whiteBorder = isWhite ? 'border border-zinc-300 shadow-2xs' : '';
            btn.className = `w-7 h-7 rounded-full cursor-pointer transition-transform hover:scale-110 relative flex items-center justify-center shrink-0 ${whiteBorder} ${isSelected ? 'ring-2 ring-zinc-900 ring-offset-2' : ''}`;
            btn.style.backgroundColor = c.hex;
            btn.title = c.name;
            if (isSelected) {
                const checkColor = isWhite ? '#18181b' : 'white';
                btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="${checkColor}" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
            }
            btn.onclick = () => {
                selectedCoverColor = c.hex;
                renderColorPalette();
                pendingModalCover = generateColorIconCover(selectedCoverColor, selectedCoverIcon.svg);
                updateModalCoverUI();
            };
            paletteEl.appendChild(btn);
        });
    }

    function renderIconGrid() {
        const iconGridEl = document.getElementById('playlist-icon-grid');
        if (!iconGridEl) return;
        iconGridEl.innerHTML = '';
        PLAYLIST_40_ICONS.forEach(iconObj => {
            const btn = document.createElement('button');
            btn.type = 'button';
            const isSelected = selectedCoverIcon.id === iconObj.id;
            btn.className = `w-8 h-8 rounded-lg flex items-center justify-center transition-all cursor-pointer ${isSelected ? 'bg-zinc-900 text-white shadow-xs' : 'text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900'}`;
            btn.title = iconObj.name;
            btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${iconObj.svg}</svg>`;
            btn.onclick = () => {
                selectedCoverIcon = iconObj;
                renderIconGrid();
                pendingModalCover = generateColorIconCover(selectedCoverColor, selectedCoverIcon.svg);
                updateModalCoverUI();
            };
            iconGridEl.appendChild(btn);
        });
    }

    // Modal: Create & Edit Playlist with Cover Upload & Custom Art
    let pendingModalCover = null;
    let lastUploadedRawImage = null;
    const modalCoverPreview = document.getElementById('modal-cover-preview');
    const modalCoverImg = document.getElementById('modal-cover-img');
    const modalCoverPlaceholder = document.getElementById('modal-cover-placeholder');
    const modalCoverUploadBtn = document.getElementById('modal-cover-upload-btn');
    const modalCoverRecropBtn = document.getElementById('modal-cover-recrop-btn');
    const modalCoverRemoveBtn = document.getElementById('modal-cover-remove-btn');
    const playlistModalCoverInput = document.getElementById('playlist-modal-cover-input');

    function updateModalCoverUI() {
        if (pendingModalCover) {
            if (modalCoverImg) {
                modalCoverImg.src = pendingModalCover;
                modalCoverImg.classList.remove('hidden');
            }
            if (modalCoverPlaceholder) modalCoverPlaceholder.classList.add('hidden');
            if (modalCoverRemoveBtn) modalCoverRemoveBtn.classList.remove('hidden');
            if (modalCoverRecropBtn) {
                const isPhoto = lastUploadedRawImage || (pendingModalCover && !pendingModalCover.startsWith('data:image/svg+xml'));
                modalCoverRecropBtn.classList.toggle('hidden', !isPhoto);
            }
        } else {
            if (modalCoverImg) {
                modalCoverImg.src = '';
                modalCoverImg.classList.add('hidden');
            }
            if (modalCoverPlaceholder) modalCoverPlaceholder.classList.remove('hidden');
            if (modalCoverRemoveBtn) modalCoverRemoveBtn.classList.add('hidden');
            if (modalCoverRecropBtn) modalCoverRecropBtn.classList.add('hidden');
        }
    }

    if (modalCoverPreview && playlistModalCoverInput) {
        modalCoverPreview.addEventListener('click', () => {
            window._yolkFilePickerOpen = true;
            playlistModalCoverInput.click();
        });
    }
    if (modalCoverUploadBtn && playlistModalCoverInput) {
        modalCoverUploadBtn.addEventListener('click', () => {
            window._yolkFilePickerOpen = true;
            playlistModalCoverInput.click();
        });
    }
    if (modalCoverRecropBtn) {
        modalCoverRecropBtn.addEventListener('click', () => {
            const raw = lastUploadedRawImage || (pendingModalCover && !pendingModalCover.startsWith('data:image/svg+xml') ? pendingModalCover : null);
            if (raw) {
                openCropper(raw, (croppedBase64) => {
                    pendingModalCover = croppedBase64;
                    updateModalCoverUI();
                });
            }
        });
    }
    if (modalCoverRemoveBtn) {
        modalCoverRemoveBtn.addEventListener('click', () => {
            pendingModalCover = null;
            lastUploadedRawImage = null;
            updateModalCoverUI();
        });
    }
    if (playlistModalCoverInput) {
        playlistModalCoverInput.addEventListener('change', (e) => {
            window._yolkFilePickerOpen = false;
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = (re) => {
                lastUploadedRawImage = re.target.result;
                openCropper(lastUploadedRawImage, (croppedBase64) => {
                    pendingModalCover = croppedBase64;
                    updateModalCoverUI();
                });
            };
            reader.readAsDataURL(file);
            playlistModalCoverInput.value = '';
        });
    }

    function openCreatePlaylistModal() {
        playlistToEditPending = null;
        pendingModalTint = null;
        if (modalTintDot) modalTintDot.style.backgroundColor = '#FDE047';
        if (modalTintStatus) modalTintStatus.textContent = 'Automatic (from artwork)';
        playlistModalTitle.textContent = 'New Playlist';
        playlistNameInput.value = '';
        playlistDescInput.value = '';
        lastUploadedRawImage = null;
        selectedCoverColor = PALETTE_16_COLORS[Math.floor(Math.random() * PALETTE_16_COLORS.length)].hex;
        selectedCoverIcon = PLAYLIST_40_ICONS[Math.floor(Math.random() * PLAYLIST_40_ICONS.length)];
        pendingModalCover = generateColorIconCover(selectedCoverColor, selectedCoverIcon.svg);
        renderColorPalette();
        renderIconGrid();
        updateModalCoverUI();
        playlistModal.classList.add('active');
        setTimeout(() => playlistNameInput.focus(), 50);
    }

    function openEditPlaylistModal(pl) {
        playlistToEditPending = pl;
        pendingModalTint = pl.custom_tint || null;
        if (modalTintDot) modalTintDot.style.backgroundColor = pendingModalTint ? pendingModalTint.hex : '#FDE047';
        if (modalTintStatus) modalTintStatus.textContent = pendingModalTint ? `Custom (${pendingModalTint.hex})` : 'Automatic (from artwork)';
        playlistModalTitle.textContent = 'Edit Playlist';
        playlistNameInput.value = pl.name || '';
        playlistDescInput.value = (pl.description && pl.description !== '[object Object]' && pl.description !== 'undefined') ? pl.description : '';
        pendingModalCover = pl.cover || null;
        lastUploadedRawImage = (pendingModalCover && !pendingModalCover.startsWith('data:image/svg+xml')) ? pendingModalCover : null;
        renderColorPalette();
        renderIconGrid();
        updateModalCoverUI();
        playlistModal.classList.add('active');
        setTimeout(() => playlistNameInput.focus(), 50);
    }

    function closePlaylistModal() {
        playlistModal.classList.remove('active');
        playlistToEditPending = null;
        pendingModalCover = null;
        lastUploadedRawImage = null;
        pendingModalTint = null;
    }

    if (createPlaylistBtn) {
        createPlaylistBtn.onclick = openCreatePlaylistModal;
    }

    if (playlistModalCancel) {
        playlistModalCancel.onclick = closePlaylistModal;
    }

    if (playlistModalSave) {
        playlistModalSave.onclick = () => {
            const name = playlistNameInput.value.trim();
            const desc = playlistDescInput.value.trim();
            if (!name) {
                showToast('Please enter a playlist name.');
                return;
            }

            if (playlistToEditPending) {
                const targetId = playlistToEditPending.id;
                playlistToEditPending.name = name;
                playlistToEditPending.description = desc;
                playlistToEditPending.cover = pendingModalCover;
                playlistToEditPending.custom_tint = pendingModalTint;
                savePlaylists();
                showToast('Playlist updated');
                renderLibrary();
                openPlaylistDetail(targetId);
                if (currentPlayingPlaylistContextId === targetId) {
                    updateNowPlayingBgArt();
                }
                closePlaylistModal();
            } else {
                const newPlaylist = {
                    id: 'pl_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
                    name: name,
                    description: desc,
                    cover: pendingModalCover,
                    custom_tint: pendingModalTint,
                    createdAt: new Date().toISOString(),
                    tracks: []
                };
                playlists.push(newPlaylist);
                savePlaylists();
                showToast(`Created playlist "${name}"`);
                renderLibrary();
                openPlaylistDetail(newPlaylist.id);
                closePlaylistModal();
            }
        };
    }

    // Modal: Add Track to Playlist
    function openAddToPlaylistModal(track) {
        trackToAddPending = track;
        addToPlaylistTrackName.textContent = `${track.title || track.name} - ${track.artist_name || track.artist}`;
        addToPlaylistOptions.innerHTML = '';

        if (playlists.length === 0) {
            addToPlaylistOptions.innerHTML = `<div class="py-4 text-center text-xs text-zinc-400">No custom playlists yet. Create one below!</div>`;
        } else {
            playlists.forEach(pl => {
                const btn = document.createElement('button');
                btn.className = 'w-full flex items-center justify-between p-3 rounded-2xl border border-zinc-100 hover:border-zinc-300 hover:bg-zinc-50 transition-all text-left';
                btn.innerHTML = `
                    <div class="flex items-center gap-3 min-w-0">
                        <div class="w-8 h-8 rounded-lg bg-zinc-100 flex items-center justify-center shrink-0 text-zinc-500 overflow-hidden">
                            ${pl.cover ? `<img src="${pl.cover}" class="w-full h-full object-cover">` : `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg>`}
                        </div>
                        <span class="text-sm font-semibold text-zinc-800 truncate">${escapeHtml(pl.name)}</span>
                    </div>
                    <span class="text-xs text-zinc-400 font-medium shrink-0">${pl.tracks ? pl.tracks.length : 0}</span>
                `;
                btn.onclick = () => {
                    addTrackToPlaylist(pl.id, trackToAddPending);
                    closeAddToPlaylistModal();
                };
                addToPlaylistOptions.appendChild(btn);
            });
        }

        addToPlaylistModal.classList.add('active');
    }

    function closeAddToPlaylistModal() {
        addToPlaylistModal.classList.remove('active');
        trackToAddPending = null;
    }

    if (addToPlaylistClose) {
        addToPlaylistClose.onclick = closeAddToPlaylistModal;
    }

    if (addToPlaylistNewBtn) {
        addToPlaylistNewBtn.onclick = () => {
            closeAddToPlaylistModal();
            openCreatePlaylistModal();
        };
    }

    function addTrackToPlaylist(playlistId, track) {
        const pl = playlists.find(p => p.id === playlistId);
        if (!pl) return;
        if (!pl.tracks) pl.tracks = [];

        const trackUid = getTrackUid(track);
        if (pl.tracks.some(t => getTrackUid(t) === trackUid)) {
            showToast(`Already in "${pl.name}"`);
            return;
        }

        pl.tracks.push(track);
        savePlaylists();
        showToast(`Added to "${pl.name}"`);
        // Automatically download when added to Library
        enqueueLibraryDownload(track);
        if (!playlistDetailView.classList.contains('hidden') && currentPlaylistContextId === playlistId) {
            openPlaylistDetail(playlistId);
        } else {
            renderLibrary();
        }
    }

    // ============================================
    // ARTIST PAGES (Matching pinpoint-edu experience)
    // ============================================
    let previousNavPage = 'search';
    let currentArtistTracks = [];
    let currentArtistName = '';

    function isExactArtistMatch(track, targetArtist) {
        if (!track || !targetArtist) return false;
        const target = targetArtist.trim().toLowerCase();
        const rawArtist = (track.artist_name || track.artist || track.subtitle || '').trim().toLowerCase();
        if (!rawArtist) return false;
        if (rawArtist === target) return true;

        const splitArtists = rawArtist
            .split(/[,&]|(?:\sfeat\.?\s)|(?:\sft\.?\s)|(?:\swith\s)|(?:\sx\s)/i)
            .map(a => a.trim().toLowerCase())
            .filter(Boolean);

        return splitArtists.includes(target);
    }

    async function loadArtistView(artistName, preferredPfp = null) {
        if (!artistName || artistName === 'Select a song to start' || artistName === 'Unknown Artist') return;

        const currentHash = window.location.hash.replace('#', '') || 'search';
        if (currentHash !== 'artist') {
            previousNavPage = currentHash;
        }

        currentArtistName = artistName;
        window.location.hash = '#artist';

        const heroName = document.getElementById('artist-hero-name');
        const heroDesc = document.getElementById('artist-hero-desc');
        const trackCountEl = document.getElementById('artist-hero-track-count');
        const headerCountEl = document.getElementById('artist-tracks-header-count');
        const heroImg = document.getElementById('artist-hero-img');
        const heroPlaceholder = document.getElementById('artist-hero-placeholder');
        const trackListEl = document.getElementById('artist-track-list');
        const loaderEl = document.getElementById('artist-loader');
        const tintEl = document.getElementById('artist-bg-tint');
        const albumsSectionEl = document.getElementById('artist-albums-section');
        const albumsGridEl = document.getElementById('artist-albums-grid');
        const albumsCountEl = document.getElementById('artist-albums-count');

        if (heroName) heroName.textContent = artistName;
        if (heroDesc) heroDesc.textContent = '';
        if (trackCountEl) trackCountEl.textContent = '';
        if (headerCountEl) headerCountEl.textContent = '';
        if (heroImg) { heroImg.src = ''; heroImg.classList.add('hidden'); }
        if (heroPlaceholder) heroPlaceholder.classList.remove('hidden');
        if (trackListEl) trackListEl.innerHTML = '';
        if (albumsGridEl) albumsGridEl.innerHTML = '';
        if (albumsSectionEl) albumsSectionEl.classList.add('hidden');
        if (loaderEl) loaderEl.classList.remove('hidden');
        if (tintEl) tintEl.style.opacity = '0';

        const scrollContainer = document.getElementById('page-artist-scroll');
        if (scrollContainer) scrollContainer.scrollTop = 0;

        const cachedPfp = artistPfpMap.get(artistName.toLowerCase().trim());
        let hasGenuinePfp = !!(preferredPfp || cachedPfp);
        let artwork = preferredPfp || cachedPfp || null;
        if (preferredPfp) {
            artistPfpMap.set(artistName.toLowerCase().trim(), preferredPfp);
        }
        if (artwork) {
            const proxiedArt = getProxyUrl(artwork, '400x400');
            if (heroImg) {
                heroImg.src = proxiedArt;
                heroImg.classList.remove('hidden');
            }
            if (heroPlaceholder) heroPlaceholder.classList.add('hidden');
            extractDominantColor(proxiedArt, (rgb) => {
                if (rgb && tintEl) {
                    tintEl.style.background = `linear-gradient(180deg, rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.38) 0%, rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.22) 30%, rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.08) 60%, transparent 100%)`;
                    tintEl.style.maskImage = 'linear-gradient(to bottom, black 0%, black 50%, transparent 100%)';
                    tintEl.style.webkitMaskImage = 'linear-gradient(to bottom, black 0%, black 50%, transparent 100%)';
                    tintEl.style.opacity = '1';
                    updateSafariThemeTint(rgb.r, rgb.g, rgb.b, 0.38);
                }
            });
        }

        try {
            let tracks = [];
            let albums = [];
            let description = '';

            // 1. Fetch from artist endpoint
            try {
                const res = await fetch(`/api/music-api?endpoint=artist&name=${encodeURIComponent(artistName)}`);
                if (res.ok) {
                    const data = await res.json();
                    if (data) {
                        if (data.artwork_url) {
                            artwork = data.artwork_url;
                            artistPfpMap.set(artistName.toLowerCase().trim(), artwork);
                            hasGenuinePfp = true;
                        } else if (!hasGenuinePfp && data.fallback_artwork_url) {
                            artwork = data.fallback_artwork_url;
                        }
                        if (data.description) description = data.description;
                        if (Array.isArray(data.tracks) && data.tracks.length > 0) {
                            tracks = data.tracks.filter(t => isExactArtistMatch(t, artistName));
                        }
                        if (Array.isArray(data.albums) && data.albums.length > 0) {
                            albums = data.albums;
                        }
                    }
                }
            } catch (_) {}

            // 2. Fallback to search if no tracks found
            if (tracks.length === 0) {
                try {
                    const res = await fetch(`/api/music-api?endpoint=search&q=${encodeURIComponent(artistName)}&limit=50`);
                    if (res.ok) {
                        const data = await res.json();
                        const rawTracks = (data.tracks || []).filter(t => (t.artist_name || t.artist || '').trim() !== 'YT Music Artist');
                        tracks = rawTracks.filter(t => isExactArtistMatch(t, artistName));
                    }
                } catch (_) {}
            }

            // Deduplicate tracks
            const seen = new Set();
            tracks = tracks.filter(t => {
                const uid = getTrackUid(t);
                const key = `${(t.title || t.name || '').toLowerCase()}|${(t.artist_name || t.artist || '').toLowerCase()}`;
                if (seen.has(uid) || seen.has(key)) return false;
                seen.add(uid);
                seen.add(key);
                return true;
            });

            // Fallback to top song artwork ONLY if artist profile picture is not available AT ALL
            if (!hasGenuinePfp && !artwork && tracks.length > 0) {
                artwork = tracks[0].artwork_url || tracks[0].image;
            }

            currentArtistTracks = tracks;

            if (loaderEl) loaderEl.classList.add('hidden');
            if (heroDesc) heroDesc.textContent = description;
            if (trackCountEl) trackCountEl.textContent = '';
            if (headerCountEl) headerCountEl.textContent = '';

            // Artwork & Background Tint
            if (artwork) {
                const proxiedArt = getProxyUrl(artwork, '400x400');
                if (heroImg) {
                    heroImg.src = proxiedArt;
                    heroImg.classList.remove('hidden');
                }
                if (heroPlaceholder) heroPlaceholder.classList.add('hidden');
                extractDominantColor(proxiedArt, (rgb) => {
                    if (rgb && tintEl) {
                        tintEl.style.background = `linear-gradient(180deg, rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.38) 0%, rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.22) 30%, rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.08) 60%, transparent 100%)`;
                        tintEl.style.maskImage = 'linear-gradient(to bottom, black 0%, black 50%, transparent 100%)';
                        tintEl.style.webkitMaskImage = 'linear-gradient(to bottom, black 0%, black 50%, transparent 100%)';
                        tintEl.style.opacity = '1';
                        updateSafariThemeTint(rgb.r, rgb.g, rgb.b, 0.38);
                    }
                });
            } else {
                if (tintEl) {
                    tintEl.style.background = `linear-gradient(180deg, rgba(200, 200, 210, 0.3) 0%, transparent 100%)`;
                    tintEl.style.maskImage = 'linear-gradient(to bottom, black 0%, black 50%, transparent 100%)';
                    tintEl.style.webkitMaskImage = 'linear-gradient(to bottom, black 0%, black 50%, transparent 100%)';
                    tintEl.style.opacity = '1';
                }
            }

            // Render Albums & Releases
            if (albumsSectionEl && albumsGridEl) {
                albumsGridEl.innerHTML = '';
                if (albums.length > 0) {
                    albumsSectionEl.classList.remove('hidden');
                    if (albumsCountEl) {
                        albumsCountEl.textContent = `${albums.length} ${albums.length === 1 ? 'release' : 'releases'}`;
                    }
                    albums.forEach((album) => {
                        const card = document.createElement('div');
                        card.className = 'group cursor-pointer bubbly-hover text-left flex flex-col p-2 rounded-2xl hover:bg-zinc-50/80 transition-all';
                        const artSrc = album.artwork_url ? getProxyUrl(album.artwork_url, '300x300') : '';
                        const albumTitle = album.name || album.title || 'Unknown Album';
                        const yearBadge = [album.year, album.album_type || album.type].filter(Boolean).join(' • ') || 'Album';
                        card.innerHTML = `
                            <div class="w-full aspect-square bg-zinc-100 rounded-2xl border border-zinc-200/70 mb-2 relative overflow-hidden flex items-center justify-center shadow-sm group-hover:shadow-md transition-all">
                                ${artSrc ? `<img src="${artSrc}" class="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500" referrerpolicy="no-referrer">` : `
                                    <div class="text-zinc-400">
                                        <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><circle cx="12" cy="12" r="3"></circle></svg>
                                    </div>
                                `}
                            </div>
                            <h3 class="font-bold text-xs sm:text-sm text-zinc-900 truncate leading-tight">${escapeHtml(albumTitle)}</h3>
                            <p class="text-[11px] font-medium text-zinc-500 mt-0.5 truncate">${escapeHtml(yearBadge)}</p>
                        `;
                        card.addEventListener('click', () => {
                            if (typeof loadAlbumView === 'function' && album.id) {
                                loadAlbumView(album.id);
                            }
                        });
                        albumsGridEl.appendChild(card);
                    });
                } else {
                    albumsSectionEl.classList.add('hidden');
                }
            }

            // Render Tracks
            if (trackListEl) {
                trackListEl.innerHTML = '';
                if (tracks.length === 0) {
                    trackListEl.innerHTML = '<div class="py-12 text-center text-xs text-zinc-400">No tracks found for this artist.</div>';
                } else {
                    tracks.forEach((track, idx) => {
                        const el = createTrackElement(track, () => {
                            currentQueue = [...tracks];
                            currentQueueIndex = idx;
                            currentPlayingPlaylistContextId = null;
                            playTrack(track);
                        });
                        trackListEl.appendChild(el);
                    });
                }
            }
        } catch (err) {
            console.error('Artist view error:', err);
            if (loaderEl) loaderEl.classList.add('hidden');
            if (trackListEl) trackListEl.innerHTML = '<div class="py-12 text-center text-xs text-red-400">Failed to load artist tracks.</div>';
        }
    }
    window.loadArtistView = loadArtistView;

    const artistBackBtn = document.getElementById('artist-back-btn');
    if (artistBackBtn) {
        artistBackBtn.onclick = () => {
            window.location.hash = '#' + (previousNavPage || 'search');
        };
    }

    const artistPlayAllBtn = document.getElementById('artist-play-all-btn');
    if (artistPlayAllBtn) {
        artistPlayAllBtn.onclick = () => {
            if (currentArtistTracks.length > 0) {
                currentQueue = [...currentArtistTracks];
                currentQueueIndex = 0;
                currentPlayingPlaylistContextId = null;
                playTrack(currentQueue[0]);
            } else {
                showToast('No tracks available to play');
            }
        };
    }

    // ==== ALBUM VIEW ====
    let currentAlbumTracks = [];
    let currentAlbumData = null;

    function createAlbumTrackElement(track, trackNum, onPlayClick) {
        const div = document.createElement('div');
        div.className = 'group flex items-center justify-between p-2.5 sm:p-3 rounded-2xl song-row-card mb-2 w-full max-w-full box-border cursor-pointer select-none';
        const title = track.title || track.name || 'Unknown Title';
        const artist = track.artist_name || track.artist || 'Unknown Artist';
        const durStr = track.duration ? formatTime(track.duration > 1000 ? track.duration / 1000 : track.duration) : '';

        div.innerHTML = `
            <div class="flex items-center gap-3.5 min-w-0 flex-1 mr-2 overflow-hidden">
                <span class="w-6 text-center text-xs font-bold text-zinc-400 group-hover:text-zinc-900 group-hover:hidden transition-colors shrink-0">${trackNum}</span>
                <div class="w-6 hidden group-hover:flex items-center justify-center text-zinc-900 shrink-0">
                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
                </div>
                <div class="flex flex-col text-left min-w-0 flex-1 overflow-hidden">
                    <span class="font-bold text-zinc-900 text-xs sm:text-sm truncate block max-w-full" title="${escapeHtml(title)}">${escapeHtml(title)}</span>
                    <span class="artist-name-link text-[11px] text-zinc-500 hover:text-zinc-950 font-medium hover:underline cursor-pointer truncate block max-w-full transition-colors inline-block w-fit mt-0.5" title="View artist">${escapeHtml(artist)}</span>
                </div>
            </div>
            <div class="flex items-center gap-1 shrink-0">
                ${durStr ? `<span class="text-[11px] text-zinc-400 font-semibold mr-1.5 hidden sm:inline">${durStr}</span>` : ''}
                <button class="download-track-btn text-zinc-400 hover:text-zinc-900 transition-colors p-2 rounded-full hover:bg-zinc-100 cursor-pointer" title="Download offline">
                    <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
                </button>
                <button class="add-to-queue-btn text-zinc-400 hover:text-zinc-900 transition-colors p-2 rounded-full hover:bg-zinc-100 cursor-pointer" title="Add to Queue">
                    <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"></line><line x1="8" y1="12" x2="21" y2="12"></line><line x1="8" y1="18" x2="16" y2="18"></line><line x1="3" y1="6" x2="3.01" y2="6"></line><line x1="3" y1="12" x2="3.01" y2="12"></line><line x1="3" y1="18" x2="3.01" y2="18"></line></svg>
                </button>
                <button class="add-to-pl-btn text-zinc-400 hover:text-zinc-900 transition-colors p-2 rounded-full hover:bg-zinc-100 cursor-pointer" title="Add to Playlist">
                    <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"></path></svg>
                </button>
                <button class="favorite-btn text-zinc-900 hover:scale-110 transition-transform p-2 rounded-full hover:bg-zinc-100 cursor-pointer" title="Favorite">
                    <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="${isFavorite(track.id) ? '#18181b' : 'none'}" stroke="#18181b" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg>
                </button>
            </div>
        `;

        div.addEventListener('click', (e) => {
            if (div._suppressNextClick) return;
            if (e.target.closest('.artist-name-link')) {
                e.stopPropagation();
                if (typeof window.loadArtistView === 'function') {
                    window.loadArtistView(artist);
                }
                return;
            }
            if (!e.target.closest('button')) {
                if (onPlayClick) onPlayClick();
            }
        });

        const favBtn = div.querySelector('.favorite-btn');
        favBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleFavorite(track, favBtn.querySelector('svg'));
        });

        attachSongRowSwipeGestures(div, track, () => favBtn ? favBtn.querySelector('svg') : null);

        const addPlBtn = div.querySelector('.add-to-pl-btn');
        addPlBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            openAddToPlaylistModal(track);
        });

        const dlBtn = div.querySelector('.download-track-btn');
        if (dlBtn) {
            wireTrackDownloadBtn(dlBtn, track);
        }

        const addQueueBtn = div.querySelector('.add-to-queue-btn');
        if (addQueueBtn) {
            addQueueBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                addToQueue(track);
            });
        }

        return div;
    }

    async function loadAlbumView(albumId) {
        if (!albumId) return;
        const resolvedId = typeof albumId === 'object' ? (albumId.id || '') : String(albumId);
        if (!resolvedId) return;

        const currentHash = window.location.hash.replace('#', '') || 'search';
        if (currentHash !== 'album') {
            previousNavPage = currentHash;
        }

        window.location.hash = '#album';

        const cleanId = resolvedId.replace('ytm-', '');
        const heroName = document.getElementById('album-hero-name');
        const heroArtist = document.getElementById('album-hero-artist');
        const heroMeta = document.getElementById('album-hero-meta');
        const trackCountEl = document.getElementById('album-hero-track-count');
        const headerCountEl = document.getElementById('album-tracks-header-count');
        const heroImg = document.getElementById('album-hero-img');
        const heroPlaceholder = document.getElementById('album-hero-placeholder');
        const trackListEl = document.getElementById('album-track-list');
        const loaderEl = document.getElementById('album-loader');
        const tintEl = document.getElementById('album-bg-tint');

        if (heroName) heroName.textContent = 'Loading Album...';
        if (heroArtist) heroArtist.textContent = '';
        if (heroMeta) heroMeta.textContent = '';
        if (trackCountEl) trackCountEl.textContent = 'Fetching tracks...';
        if (headerCountEl) headerCountEl.textContent = '';
        if (heroImg) { heroImg.src = ''; heroImg.classList.add('hidden'); }
        if (heroPlaceholder) heroPlaceholder.classList.remove('hidden');
        if (trackListEl) trackListEl.innerHTML = '';
        if (loaderEl) loaderEl.classList.remove('hidden');
        if (tintEl) tintEl.style.opacity = '0';

        const scrollContainer = document.getElementById('page-album-scroll');
        if (scrollContainer) scrollContainer.scrollTop = 0;

        try {
            const res = await fetch(`${API_BASE}?endpoint=album&id=${encodeURIComponent(cleanId)}`);
            const data = await res.json();

            if (loaderEl) loaderEl.classList.add('hidden');

            if (!res.ok || !data) {
                if (trackListEl) trackListEl.innerHTML = '<div class="py-12 text-center text-xs text-red-400">Failed to load album details.</div>';
                return;
            }

            currentAlbumData = data;
            const tracks = Array.isArray(data.tracks) ? data.tracks : [];
            currentAlbumTracks = tracks;

            if (heroName) heroName.textContent = data.name || 'Unknown Album';
            if (heroArtist) {
                heroArtist.textContent = data.artist_name || 'Unknown Artist';
                heroArtist.onclick = (e) => {
                    e.stopPropagation();
                    if (data.artist_name && typeof window.loadArtistView === 'function') {
                        window.loadArtistView(data.artist_name);
                    }
                };
            }
            if (heroMeta) heroMeta.textContent = data.release_date || data.meta || '';
            const countStr = `${tracks.length} ${tracks.length === 1 ? 'track' : 'tracks'}`;
            if (trackCountEl) trackCountEl.textContent = data.meta ? `${countStr} • ${data.meta}` : countStr;
            if (headerCountEl) headerCountEl.textContent = countStr;

            // Artwork & Tint
            const artwork = data.artwork_url || (tracks[0]?.artwork_url);
            if (artwork) {
                const proxiedArt = getProxyUrl(artwork, '500x500');
                if (heroImg) {
                    heroImg.src = proxiedArt;
                    heroImg.classList.remove('hidden');
                }
                if (heroPlaceholder) heroPlaceholder.classList.add('hidden');
                extractDominantColor(proxiedArt, (rgb) => {
                    if (rgb && tintEl) {
                        tintEl.style.background = `linear-gradient(180deg, rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.38) 0%, rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.22) 30%, rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.08) 60%, transparent 100%)`;
                        tintEl.style.maskImage = 'linear-gradient(to bottom, black 0%, black 50%, transparent 100%)';
                        tintEl.style.webkitMaskImage = 'linear-gradient(to bottom, black 0%, black 50%, transparent 100%)';
                        tintEl.style.opacity = '1';
                        updateSafariThemeTint(rgb.r, rgb.g, rgb.b, 0.38);
                    }
                });
            } else {
                if (tintEl) {
                    tintEl.style.background = `linear-gradient(180deg, rgba(200, 200, 210, 0.3) 0%, transparent 100%)`;
                    tintEl.style.maskImage = 'linear-gradient(to bottom, black 0%, black 50%, transparent 100%)';
                    tintEl.style.webkitMaskImage = 'linear-gradient(to bottom, black 0%, black 50%, transparent 100%)';
                    tintEl.style.opacity = '1';
                }
            }

            // Render tracks
            if (trackListEl) {
                trackListEl.innerHTML = '';
                if (tracks.length === 0) {
                    trackListEl.innerHTML = '<div class="py-12 text-center text-xs text-zinc-400">No tracks found in this album.</div>';
                } else {
                    tracks.forEach((track, idx) => {
                        const el = createAlbumTrackElement(track, idx + 1, () => {
                            currentQueue = [...tracks];
                            currentQueueIndex = idx;
                            currentPlayingPlaylistContextId = null;
                            playTrack(track);
                        });
                        trackListEl.appendChild(el);
                    });
                }
            }

            // Wire Album Download All button
            const albumDownloadAllBtn = document.getElementById('album-download-all-btn');
            if (albumDownloadAllBtn) {
                if (tracks.length === 0) {
                    albumDownloadAllBtn.classList.add('hidden');
                    window._updateAlbumDownloadAllBtn = null;
                } else {
                    albumDownloadAllBtn.classList.remove('hidden');
                    const updateAlbumDownloadStatus = async () => {
                        const checks = await Promise.all(tracks.map(t => YolkOfflineDB.isDownloaded(getTrackUid(t))));
                        const allDownloaded = checks.length > 0 && checks.every(Boolean);
                        if (allDownloaded) {
                            albumDownloadAllBtn.title = 'Undownload Album';
                            albumDownloadAllBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#059669" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>`;
                        } else {
                            albumDownloadAllBtn.title = 'Download Album';
                            albumDownloadAllBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>`;
                        }
                        return allDownloaded;
                    };
                    window._updateAlbumDownloadAllBtn = updateAlbumDownloadStatus;
                    updateAlbumDownloadStatus();

                    albumDownloadAllBtn.onclick = async () => {
                        const isAll = await updateAlbumDownloadStatus();
                        const albumTitle = data.name || 'Album';
                        if (isAll) {
                            if (confirm(`Remove all downloaded songs from "${albumTitle}"?`)) {
                                for (const t of tracks) {
                                    await YolkOfflineDB.deleteTrack(getTrackUid(t));
                                }
                                if (typeof window.refreshAllDownloadButtonsUI === 'function') {
                                    window.refreshAllDownloadButtonsUI();
                                }
                            }
                        } else {
                            // Also save album as a playlist in Library if not already present
                            const existingAlbumPl = playlists.find(p => p.name && p.name.toLowerCase() === albumTitle.toLowerCase());
                            if (!existingAlbumPl) {
                                playlists.push({
                                    id: 'pl_alb_' + Date.now().toString(36),
                                    name: albumTitle,
                                    description: data.artist_name ? `Album by ${data.artist_name}` : 'Album',
                                    cover: artwork || '',
                                    createdAt: new Date().toISOString(),
                                    tracks: [...tracks]
                                });
                                savePlaylists();
                                renderLibrary();
                            }
                            enqueueLibraryDownload(tracks);
                        }
                    };
                }
            }
        } catch (err) {
            console.error('Album view error:', err);
            if (loaderEl) loaderEl.classList.add('hidden');
            if (trackListEl) trackListEl.innerHTML = '<div class="py-12 text-center text-xs text-red-400">Failed to load album tracks.</div>';
        }
    }
    window.loadAlbumView = loadAlbumView;

    const albumBackBtn = document.getElementById('album-back-btn');
    if (albumBackBtn) {
        albumBackBtn.onclick = () => {
            window.location.hash = '#' + (previousNavPage || 'search');
        };
    }

    const albumPlayAllBtn = document.getElementById('album-play-all-btn');
    if (albumPlayAllBtn) {
        albumPlayAllBtn.onclick = () => {
            if (currentAlbumTracks.length > 0) {
                currentQueue = [...currentAlbumTracks];
                currentQueueIndex = 0;
                currentPlayingPlaylistContextId = null;
                playTrack(currentQueue[0]);
            } else {
                showToast('No tracks in this album');
            }
        };
    }

    // ==== YOUTUBE PLAYLIST IMPORTER (SONGS ONLY) ====
    const importYtPlaylistBtn = document.getElementById('import-yt-playlist-btn');
    const ytImportModal = document.getElementById('yt-import-modal');
    const ytImportCloseBtn = document.getElementById('yt-import-close-btn');
    const ytImportCancelBtn = document.getElementById('yt-import-cancel-btn');
    const ytImportSubmitBtn = document.getElementById('yt-import-submit-btn');
    const ytImportInput = document.getElementById('yt-import-input');
    const ytImportStatus = document.getElementById('yt-import-status');
    const ytImportStatusText = document.getElementById('yt-import-status-text');

    function openYtImportModal() {
        if (!ytImportModal) return;
        ytImportModal.classList.add('active');
        if (ytImportInput) {
            ytImportInput.value = '';
            setTimeout(() => ytImportInput.focus(), 60);
        }
    }

    function closeYtImportModal() {
        if (!ytImportModal) return;
        ytImportModal.classList.remove('active');
        if (ytImportInput) ytImportInput.value = '';
        if (ytImportStatus) {
            ytImportStatus.classList.add('hidden');
            ytImportStatus.classList.remove('flex');
        }
        if (ytImportSubmitBtn) ytImportSubmitBtn.disabled = false;
    }

    if (importYtPlaylistBtn) {
        importYtPlaylistBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            openYtImportModal();
        });
    }

    if (ytImportCloseBtn) ytImportCloseBtn.onclick = closeYtImportModal;
    if (ytImportCancelBtn) ytImportCancelBtn.onclick = closeYtImportModal;

    if (ytImportInput && ytImportSubmitBtn) {
        ytImportInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                ytImportSubmitBtn.click();
            }
        });
    }

    if (ytImportSubmitBtn && ytImportInput) {
        ytImportSubmitBtn.addEventListener('click', async () => {
            const rawVal = ytImportInput.value.trim();
            if (!rawVal) {
                showToast('Please enter a YouTube playlist link or ID.');
                return;
            }

            // Extract playlist ID
            let playlistId = rawVal;
            const match = rawVal.match(/[?&]list=([a-zA-Z0-9_-]+)/);
            if (match) {
                playlistId = match[1];
            } else if (rawVal.includes('/playlist/')) {
                const parts = rawVal.split('/playlist/');
                playlistId = parts[parts.length - 1].split('?')[0];
            }
            playlistId = playlistId.replace(/^VL/, '');

            if (ytImportStatus) {
                ytImportStatus.classList.remove('hidden');
                ytImportStatus.classList.add('flex');
            }
            if (ytImportStatusText) ytImportStatusText.textContent = 'Extracting songs from YouTube…';
            ytImportSubmitBtn.disabled = true;

            try {
                const res = await fetch(`${API_BASE}?endpoint=playlist&id=${encodeURIComponent(playlistId)}`);
                const data = await res.json();

                if (!res.ok || !data || !Array.isArray(data.tracks) || data.tracks.length === 0) {
                    showToast(data?.error || 'No valid music tracks found in this playlist.');
                    return;
                }

                // Filter to "songs only"
                const songsOnly = data.tracks.filter(t => {
                    const title = (t.title || t.name || '').toLowerCase();
                    const dur = t.duration || 0;
                    return t.youtube_id && dur > 0 && !title.includes('podcast') && !title.includes('full album');
                });

                if (songsOnly.length === 0) {
                    showToast('No music tracks could be extracted from this playlist.');
                    return;
                }

                let cleanDesc = '';
                if (typeof data.description === 'string') {
                    const d = data.description.trim();
                    if (d && d !== '[object Object]' && d !== 'undefined' && d !== 'null') {
                        cleanDesc = d;
                    }
                }

                const newPl = {
                    id: 'pl_' + Date.now(),
                    name: data.name || 'Imported YT Playlist',
                    description: cleanDesc,
                    cover: data.artwork_url || (songsOnly[0]?.artwork_url || ''),
                    color: '#18181b',
                    icon: 'music',
                    tracks: songsOnly
                };

                playlists.push(newPl);
                savePlaylists();
                renderLibrary();
                closeYtImportModal();
                showToast(`Imported "${newPl.name}" (${songsOnly.length} songs)!`);
                openPlaylistDetail(newPl.id);
                // Automatically download imported library playlist discreetly in background
                enqueueLibraryDownload(songsOnly);
            } catch (err) {
                console.error('YT import error:', err);
                showToast('Failed to import playlist.');
            } finally {
                if (ytImportStatus) {
                    ytImportStatus.classList.add('hidden');
                    ytImportStatus.classList.remove('flex');
                }
                ytImportSubmitBtn.disabled = false;
            }
        });
    }

    // ==== QUEUE MANAGEMENT SYSTEM ====
    const queueModal = document.getElementById('queue-modal');
    const queueCloseBtn = document.getElementById('queue-close-btn');
    const queueClearBtn = document.getElementById('queue-clear-btn');
    const bpQueueBtn = document.getElementById('bp-queue-btn');
    const npQueueBtn = document.getElementById('np-queue-btn');

    function addToQueue(track, playImmediately = false) {
        if (!track) return;
        const trackTitle = track.title || track.name || 'Song';
        if (!currentTrack && (!currentQueue || currentQueue.length === 0)) {
            currentQueue = [track];
            currentQueueIndex = 0;
            currentPlaylistContextId = null;
            currentPlayingPlaylistContextId = null;
            playTrack(track);
            showToast(`Now playing: ${trackTitle}`);
            return;
        }

        if (playImmediately) {
            currentQueue.splice(currentQueueIndex + 1, 0, track);
            showToast(`Playing next: ${trackTitle}`);
        } else {
            currentQueue.push(track);
            showToast(`Added to queue: ${trackTitle}`);
        }
        updateQueueModalUI();
    }

    function removeFromQueue(index) {
        if (!currentQueue || index < 0 || index >= currentQueue.length) return;
        if (index === currentQueueIndex) {
            playNext();
            currentQueue.splice(index, 1);
            if (currentQueueIndex > 0) currentQueueIndex--;
        } else {
            currentQueue.splice(index, 1);
            if (index < currentQueueIndex) {
                currentQueueIndex--;
            }
        }
        updateQueueModalUI();
    }

    function clearUpcomingQueue() {
        if (!currentQueue || currentQueue.length === 0) return;
        if (currentTrack && currentQueueIndex >= 0 && currentQueueIndex < currentQueue.length) {
            currentQueue = [currentQueue[currentQueueIndex]];
            currentQueueIndex = 0;
        } else {
            currentQueue = [];
            currentQueueIndex = -1;
        }
        updateQueueModalUI();
        showToast('Upcoming queue cleared');
    }

    function openQueueModal() {
        if (!queueModal) return;
        updateQueueModalUI();
        queueModal.classList.add('active');
    }

    function closeQueueModal() {
        if (!queueModal) return;
        queueModal.classList.remove('active');
    }

    function updateQueueModalUI() {
        if (!queueModal) return;

        const countBadge = document.getElementById('queue-count-badge');
        const nowPlayingItem = document.getElementById('queue-now-playing-item');
        const upNextList = document.getElementById('queue-up-next-list');
        const upNextCount = document.getElementById('queue-up-next-count');

        const upcomingTracks = (currentQueue && currentQueueIndex >= 0)
            ? currentQueue.slice(currentQueueIndex + 1)
            : [];

        if (countBadge) {
            const total = currentQueue ? currentQueue.length : 0;
            countBadge.textContent = `${total} ${total === 1 ? 'song' : 'songs'} in queue`;
        }

        if (upNextCount) {
            upNextCount.textContent = `${upcomingTracks.length} upcoming`;
        }

        // Render Current Track
        if (nowPlayingItem) {
            if (currentTrack) {
                const artwork = getProxyUrl(currentTrack.artwork_url || currentTrack.image, '60x60');
                const title = currentTrack.title || currentTrack.name || 'Unknown Title';
                const artist = currentTrack.artist_name || currentTrack.artist || 'Unknown Artist';
                nowPlayingItem.innerHTML = `
                    <div class="flex items-center gap-3 min-w-0 flex-1 mr-2">
                        <div class="w-10 h-10 bg-zinc-100 rounded-xl overflow-hidden shrink-0 relative border border-zinc-200/50 flex items-center justify-center">
                            ${artwork ? `<img src="${artwork}" class="w-full h-full object-cover">` : ''}
                            <div class="absolute inset-0 bg-black/25 flex items-center justify-center">
                                <span class="flex gap-0.5 items-end h-3">
                                    <span class="w-0.5 h-3 bg-white rounded-full animate-pulse"></span>
                                    <span class="w-0.5 h-2 bg-white rounded-full animate-pulse" style="animation-delay: 150ms"></span>
                                    <span class="w-0.5 h-2.5 bg-white rounded-full animate-pulse" style="animation-delay: 300ms"></span>
                                </span>
                            </div>
                        </div>
                        <div class="flex flex-col text-left min-w-0">
                            <span class="font-bold text-zinc-900 text-xs sm:text-sm truncate">${escapeHtml(title)}</span>
                            <span class="text-[11px] text-zinc-500 truncate">${escapeHtml(artist)}</span>
                        </div>
                    </div>
                    <span class="text-[9px] uppercase font-bold text-green-700 bg-green-100 px-2 py-0.5 rounded-full shrink-0">Playing</span>
                `;
            } else {
                nowPlayingItem.innerHTML = `
                    <span class="text-xs text-zinc-400 py-1 font-medium">No track currently playing</span>
                `;
            }
        }

        // Render Upcoming Tracks
        if (upNextList) {
            upNextList.innerHTML = '';
            if (upcomingTracks.length === 0) {
                upNextList.innerHTML = `
                    <div class="py-8 text-center text-xs text-zinc-400 font-medium">
                        No upcoming tracks in queue.<br>Click the queue icon on any song to add it!
                    </div>
                `;
            } else {
                upcomingTracks.forEach((track, offset) => {
                    const actualIdx = currentQueueIndex + 1 + offset;
                    const row = document.createElement('div');
                    row.className = 'group flex items-center justify-between p-2 rounded-xl bg-zinc-50/70 hover:bg-zinc-100/90 border border-zinc-200/60 hover:border-zinc-300 transition-all cursor-pointer scroll-row-hover mb-1 w-full max-w-full box-border overflow-hidden select-none';
                    row.setAttribute('data-reorder-item', 'true');
                    const artwork = getProxyUrl(track.artwork_url || track.image, '60x60');
                    const title = track.title || track.name || 'Unknown Title';
                    const artist = track.artist_name || track.artist || 'Unknown Artist';
                    const durStr = track.duration ? formatTime(track.duration > 1000 ? track.duration / 1000 : track.duration) : '';

                    row.innerHTML = `
                        <div class="flex items-center gap-2 min-w-0 flex-1 mr-2 overflow-hidden">
                            <button type="button" class="reorder-grip-handle text-zinc-400 hover:text-zinc-800 p-1 rounded-lg cursor-grab active:cursor-grabbing shrink-0 flex items-center justify-center" title="Drag to reorder queue">
                                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="5" r="1"></circle><circle cx="9" cy="12" r="1"></circle><circle cx="9" cy="19" r="1"></circle><circle cx="15" cy="5" r="1"></circle><circle cx="15" cy="12" r="1"></circle><circle cx="15" cy="19" r="1"></circle></svg>
                            </button>
                            <span class="w-4 text-center text-[11px] font-bold text-zinc-400 group-hover:text-zinc-900 shrink-0">${offset + 1}</span>
                            <div class="w-9 h-9 bg-zinc-100 rounded-lg overflow-hidden shrink-0 border border-zinc-200/50 flex items-center justify-center">
                                ${artwork ? `<img src="${artwork}" class="w-full h-full object-cover">` : ''}
                            </div>
                            <div class="flex flex-col text-left min-w-0 flex-1 overflow-hidden">
                                <span class="font-bold text-zinc-900 text-xs truncate block max-w-full" title="${escapeHtml(title)}">${escapeHtml(title)}</span>
                                <span class="text-[11px] text-zinc-500 truncate block max-w-full" title="${escapeHtml(artist)}">${escapeHtml(artist)}</span>
                            </div>
                        </div>
                        <div class="flex items-center gap-1.5 shrink-0">
                            ${durStr ? `<span class="text-[11px] text-zinc-400 font-medium hidden sm:inline mr-1">${durStr}</span>` : ''}
                            <button class="remove-queue-item-btn text-zinc-400 hover:text-red-500 transition-colors p-1.5 rounded-full hover:bg-red-50 cursor-pointer" title="Remove from queue">
                                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                            </button>
                        </div>
                    `;

                    row.addEventListener('click', (e) => {
                        if (e.target.closest('.reorder-grip-handle')) return;
                        if (e.target.closest('.remove-queue-item-btn')) {
                            e.stopPropagation();
                            removeFromQueue(actualIdx);
                            return;
                        }
                        currentQueueIndex = actualIdx;
                        playTrack(track);
                        updateQueueModalUI();
                    });

                    upNextList.appendChild(row);
                });

                if (!upNextList._reorderBound) {
                    upNextList._reorderBound = true;
                    enableListReordering(upNextList, (fromOffset, toOffset) => {
                        const baseIdx = currentQueueIndex + 1;
                        const fromActual = baseIdx + fromOffset;
                        const toActual = baseIdx + toOffset;
                        if (fromActual >= baseIdx && toActual >= baseIdx && fromActual < currentQueue.length && toActual < currentQueue.length) {
                            const [movedTrack] = currentQueue.splice(fromActual, 1);
                            currentQueue.splice(toActual, 0, movedTrack);
                            preloadedNextTrackUid = null;
                            preloadNextQueueTrack();
                            updateQueueModalUI();
                            showToast('Queue order updated');
                        }
                    });
                }
            }
        }
    }

    if (bpQueueBtn) bpQueueBtn.addEventListener('click', () => openQueueModal());
    if (npQueueBtn) npQueueBtn.addEventListener('click', () => openQueueModal());
    if (queueCloseBtn) queueCloseBtn.addEventListener('click', () => closeQueueModal());
    if (queueClearBtn) queueClearBtn.addEventListener('click', () => clearUpcomingQueue());

    // Close modals on clicking backdrop
    [playlistModal, addToPlaylistModal, ytImportModal, queueModal].forEach(modal => {
        if (!modal) return;
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                modal.classList.remove('active');
            }
        });
    });
    if (cropModal) {
        cropModal.addEventListener('click', (e) => {
            if (e.target === cropModal) {
                cropModal.classList.add('hidden');
            }
        });
    }

    // ==== SETTINGS PAGE: DARK MODE (BETA) VS LIGHT MODE ====
    const themeToggleBtn = document.getElementById('theme-mode-toggle-btn');
    const themeToggleKnob = document.getElementById('theme-mode-toggle-knob');
    const themeLightBtn = document.getElementById('theme-mode-light-btn');
    const themeDarkBtn = document.getElementById('theme-mode-dark-btn');
    const themeLightDot = document.getElementById('theme-light-active-dot');
    const themeDarkDot = document.getElementById('theme-dark-active-dot');

    function applyThemeMode(mode, notify = false) {
        const isDark = (mode === 'dark');
        document.documentElement.classList.toggle('dark-mode', isDark);
        document.body.classList.toggle('dark-mode', isDark);
        localStorage.setItem('yolk_theme_mode', isDark ? 'dark' : 'light');

        if (themeToggleBtn) {
            themeToggleBtn.setAttribute('aria-checked', isDark ? 'true' : 'false');
            themeToggleBtn.style.backgroundColor = isDark ? '#FDE047' : '';
            themeToggleBtn.style.borderColor = isDark ? '#FACC15' : '';
        }
        if (themeToggleKnob) {
            themeToggleKnob.style.transform = isDark ? 'translateX(24px)' : 'translateX(0px)';
            themeToggleKnob.style.backgroundColor = isDark ? '#18181b' : '#ffffff';
        }
        if (themeLightDot) themeLightDot.classList.toggle('hidden', isDark);
        if (themeDarkDot) themeDarkDot.classList.toggle('hidden', !isDark);

        if (themeLightBtn) {
            themeLightBtn.style.borderColor = !isDark ? '#18181b' : 'rgba(63, 63, 70, 0.7)';
        }
        if (themeDarkBtn) {
            themeDarkBtn.style.borderColor = isDark ? '#FDE047' : 'rgba(228, 228, 231, 0.8)';
        }

        updateNowPlayingFavButton();
        updateBottomPlayerFavButton();
        updateLibraryButtons();
        updateNowPlayingBgArt();
        updateTopNavTint();

        if (currentPlaylistTintRgb && currentPlaylistContextId && currentPlaylistContextId !== 'favorites') {
            applyPlaylistThemeUI(currentPlaylistTintRgb.r, currentPlaylistTintRgb.g, currentPlaylistTintRgb.b);
        }

        if (notify) {
            showToast(isDark ? 'Dark Mode (Beta) enabled' : 'Light Mode enabled');
        }
    }
    window.applyThemeMode = applyThemeMode;

    if (themeToggleBtn) {
        themeToggleBtn.addEventListener('click', () => {
            triggerHaptic('medium');
            const isCurrentlyDark = document.body.classList.contains('dark-mode');
            applyThemeMode(isCurrentlyDark ? 'light' : 'dark', true);
        });
    }
    if (themeLightBtn) {
        themeLightBtn.addEventListener('click', () => {
            triggerHaptic('light');
            if (document.body.classList.contains('dark-mode')) {
                applyThemeMode('light', true);
            }
        });
    }
    if (themeDarkBtn) {
        themeDarkBtn.addEventListener('click', () => {
            triggerHaptic('light');
            if (!document.body.classList.contains('dark-mode')) {
                applyThemeMode('dark', true);
            }
        });
    }

    // ==== SETTINGS PAGE: HAPTIC FEEDBACK TOGGLE ====
    const hapticToggleBtn = document.getElementById('haptic-toggle-btn');
    const hapticToggleKnob = document.getElementById('haptic-toggle-knob');

    function updateHapticToggleUI(enabled, notify = false) {
        hapticsEnabled = !!enabled;
        localStorage.setItem('yolk_haptics', hapticsEnabled ? 'true' : 'false');
        if (hapticToggleBtn) {
            hapticToggleBtn.setAttribute('aria-checked', hapticsEnabled ? 'true' : 'false');
            hapticToggleBtn.style.backgroundColor = hapticsEnabled ? '#FDE047' : 'rgba(212, 212, 216, 0.8)';
            hapticToggleBtn.style.borderColor = hapticsEnabled ? '#FACC15' : 'rgba(161, 161, 170, 0.7)';
        }
        if (hapticToggleKnob) {
            hapticToggleKnob.style.transform = hapticsEnabled ? 'translateX(24px)' : 'translateX(0px)';
            hapticToggleKnob.style.backgroundColor = hapticsEnabled ? '#18181b' : '#ffffff';
        }
        if (notify) {
            if (hapticsEnabled) triggerHaptic('medium');
            showToast(hapticsEnabled ? 'Haptic Feedback enabled' : 'Haptic Feedback disabled');
        }
    }

    if (hapticToggleBtn) {
        hapticToggleBtn.addEventListener('click', () => {
            updateHapticToggleUI(!hapticsEnabled, true);
        });
    }
    updateHapticToggleUI(hapticsEnabled, false);

    // ==== SETTINGS PAGE: REAL-TIME 5-BAND WEB AUDIO EQUALIZER (EQ) ====
    const EQ_PRESETS = {
        flat: { name: 'Flat', gains: [0, 0, 0, 0, 0] },
        bass: { name: 'Bass Boost', gains: [7.5, 5.5, 0, 1, 2] },
        vocal: { name: 'Vocal Booster', gains: [-2, -1, 4.5, 5, 2] },
        'late-night': { name: 'Late Night', gains: [5, 3, -1.5, 2.5, 4] },
        electronic: { name: 'Electronic', gains: [6.5, 4, -2, 3, 6] },
        acoustic: { name: 'Acoustic', gains: [3.5, 2, 1, 3, 4] }
    };
    const EQ_FREQS = [
        { freq: 60, type: 'lowshelf', q: 0.7 },
        { freq: 230, type: 'peaking', q: 1.0 },
        { freq: 910, type: 'peaking', q: 1.0 },
        { freq: 3600, type: 'peaking', q: 1.0 },
        { freq: 14000, type: 'highshelf', q: 0.7 }
    ];

    let eqEnabled = localStorage.getItem('yolk_eq_enabled') !== 'false';
    let eqCurrentPreset = localStorage.getItem('yolk_eq_preset') || 'flat';
    let eqBands = [0, 0, 0, 0, 0];
    try {
        const savedBands = JSON.parse(localStorage.getItem('yolk_eq_bands') || 'null');
        if (Array.isArray(savedBands) && savedBands.length === 5) {
            eqBands = savedBands.map(v => Math.max(-12, Math.min(12, Number(v) || 0)));
        } else if (EQ_PRESETS[eqCurrentPreset]) {
            eqBands = [...EQ_PRESETS[eqCurrentPreset].gains];
        }
    } catch (_) {}

    let yolkAudioCtx = null;
    let yolkMediaSourceNode = null;
    let yolkEqPreGain = null;
    let yolkEqFilters = [];
    let yolkAnalyserNode = null;
    let visualizerEnabled = localStorage.getItem('yolk_visualizer_enabled') !== 'false';
    let visualizerStyle = localStorage.getItem('yolk_visualizer_style') || 'bars';

    function ensureWebAudioEqualizer(forceInit = false) {
        const hasNonZero = eqEnabled && eqBands.some(g => Math.abs(g) > 0.05);
        if (!yolkAudioCtx && !hasNonZero && !forceInit && !visualizerEnabled) {
            // Keep native HTMLAudioElement direct pipeline untouched when EQ and visualizer are off
            return;
        }
        try {
            const AudioCtx = window.AudioContext || window.webkitAudioContext;
            if (!AudioCtx) return;
            if (!yolkAudioCtx) {
                yolkAudioCtx = new AudioCtx();
                yolkMediaSourceNode = yolkAudioCtx.createMediaElementSource(currentAudio);
                yolkEqPreGain = yolkAudioCtx.createGain();
                yolkEqFilters = EQ_FREQS.map(cfg => {
                    const filter = yolkAudioCtx.createBiquadFilter();
                    filter.type = cfg.type;
                    filter.frequency.value = cfg.freq;
                    filter.Q.value = cfg.q;
                    filter.gain.value = 0;
                    return filter;
                });
                yolkAnalyserNode = yolkAudioCtx.createAnalyser();
                yolkAnalyserNode.fftSize = 128;
                yolkAnalyserNode.smoothingTimeConstant = 0.82;

                // Connect chain: source -> preGain -> filter0..4 -> analyser -> destination
                yolkMediaSourceNode.connect(yolkEqPreGain);
                let prevNode = yolkEqPreGain;
                yolkEqFilters.forEach(f => {
                    prevNode.connect(f);
                    prevNode = f;
                });
                prevNode.connect(yolkAnalyserNode);
                yolkAnalyserNode.connect(yolkAudioCtx.destination);
            }
            if (yolkAudioCtx.state === 'suspended') {
                yolkAudioCtx.resume().catch(() => {});
            }

            // Apply band gains & automatic headroom compensation to prevent clipping
            const maxPositiveGain = eqEnabled ? Math.max(0, ...eqBands) : 0;
            const headroomDb = maxPositiveGain > 2 ? -(maxPositiveGain * 0.42) : 0;
            const linearPreGain = Math.pow(10, headroomDb / 20);
            if (yolkEqPreGain) {
                yolkEqPreGain.gain.setTargetAtTime(linearPreGain, yolkAudioCtx.currentTime, 0.03);
            }
            yolkEqFilters.forEach((filter, idx) => {
                const targetGain = eqEnabled ? (eqBands[idx] || 0) : 0;
                filter.gain.setTargetAtTime(targetGain, yolkAudioCtx.currentTime, 0.03);
            });
        } catch (err) {
            console.warn('Web Audio EQ init notice:', err);
        }
    }

    currentAudio.addEventListener('play', () => {
        if (yolkAudioCtx && yolkAudioCtx.state === 'suspended') {
            yolkAudioCtx.resume().catch(() => {});
        } else if ((eqEnabled && eqBands.some(g => Math.abs(g) > 0.05)) || visualizerEnabled) {
            ensureWebAudioEqualizer();
        }
    });

    const eqEnableToggleBtn = document.getElementById('eq-enable-toggle-btn');
    const eqEnableToggleKnob = document.getElementById('eq-enable-toggle-knob');
    const eqResetBtn = document.getElementById('eq-reset-btn');
    const eqPresetBadge = document.getElementById('eq-active-preset-badge');
    const eqPresetPills = document.querySelectorAll('.eq-preset-pill');
    const eqBandSliders = document.querySelectorAll('.eq-band-slider');

    function updateEqUI() {
        localStorage.setItem('yolk_eq_enabled', eqEnabled ? 'true' : 'false');
        localStorage.setItem('yolk_eq_preset', eqCurrentPreset);
        localStorage.setItem('yolk_eq_bands', JSON.stringify(eqBands));

        if (eqEnableToggleBtn) {
            eqEnableToggleBtn.setAttribute('aria-checked', eqEnabled ? 'true' : 'false');
            eqEnableToggleBtn.style.backgroundColor = eqEnabled ? '#FDE047' : 'rgba(212, 212, 216, 0.8)';
            eqEnableToggleBtn.style.borderColor = eqEnabled ? '#FACC15' : 'rgba(161, 161, 170, 0.7)';
        }
        if (eqEnableToggleKnob) {
            eqEnableToggleKnob.style.transform = eqEnabled ? 'translateX(24px)' : 'translateX(0px)';
            eqEnableToggleKnob.style.backgroundColor = eqEnabled ? '#18181b' : '#ffffff';
        }
        if (eqPresetBadge) {
            const label = !eqEnabled ? 'Off' : (EQ_PRESETS[eqCurrentPreset]?.name || 'Custom');
            eqPresetBadge.textContent = label;
        }
        const bandsWrapper = document.getElementById('eq-bands-wrapper');
        if (bandsWrapper) {
            bandsWrapper.style.opacity = eqEnabled ? '1' : '0.45';
            bandsWrapper.style.pointerEvents = eqEnabled ? 'auto' : 'none';
        }

        eqPresetPills.forEach(pill => {
            const key = pill.getAttribute('data-eq-preset');
            const isActive = eqEnabled && key === eqCurrentPreset;
            pill.classList.toggle('bg-zinc-900', isActive);
            pill.classList.toggle('text-white', isActive);
            pill.classList.toggle('border-zinc-900', isActive);
            pill.classList.toggle('font-bold', isActive);
            pill.classList.toggle('bg-zinc-100', !isActive);
            pill.classList.toggle('text-zinc-700', !isActive);
            pill.classList.toggle('font-semibold', !isActive);
        });

        eqBandSliders.forEach(slider => {
            const idx = parseInt(slider.getAttribute('data-eq-band'), 10);
            const val = eqBands[idx] || 0;
            slider.value = val;
            const valEl = document.getElementById(`eq-band-val-${idx}`);
            if (valEl) {
                const sign = val > 0 ? '+' : '';
                valEl.textContent = `${sign}${val % 1 === 0 ? val : val.toFixed(1)} dB`;
            }
        });

        ensureWebAudioEqualizer();
    }

    if (eqEnableToggleBtn) {
        eqEnableToggleBtn.addEventListener('click', () => {
            triggerHaptic('medium');
            eqEnabled = !eqEnabled;
            updateEqUI();
            showToast(eqEnabled ? 'Equalizer enabled' : 'Equalizer bypassed');
        });
    }

    if (eqResetBtn) {
        eqResetBtn.addEventListener('click', () => {
            triggerHaptic('light');
            eqEnabled = true;
            eqCurrentPreset = 'flat';
            eqBands = [0, 0, 0, 0, 0];
            updateEqUI();
            showToast('Equalizer reset to Flat');
        });
    }

    eqPresetPills.forEach(pill => {
        pill.addEventListener('click', () => {
            const presetKey = pill.getAttribute('data-eq-preset');
            if (!EQ_PRESETS[presetKey]) return;
            triggerHaptic('selection');
            eqEnabled = true;
            eqCurrentPreset = presetKey;
            eqBands = [...EQ_PRESETS[presetKey].gains];
            updateEqUI();
            showToast(`EQ Preset: ${EQ_PRESETS[presetKey].name}`);
        });
    });

    eqBandSliders.forEach(slider => {
        slider.addEventListener('input', (e) => {
            const idx = parseInt(slider.getAttribute('data-eq-band'), 10);
            const newVal = parseFloat(e.target.value) || 0;
            if (Math.abs(newVal) < 0.25 && Math.abs(eqBands[idx]) >= 0.25) {
                triggerHaptic('light');
            }
            eqBands[idx] = newVal;
            eqEnabled = true;
            eqCurrentPreset = 'custom';
            updateEqUI();
        });
    });

    updateEqUI();

    // ==== SETTINGS PAGE: OFFLINE STORAGE & CACHE MANAGER ====
    async function refreshStorageManagerUI() {
        const countBadge = document.getElementById('storage-count-badge');
        const usedLabel = document.getElementById('storage-used-label');
        const quotaLabel = document.getElementById('storage-quota-label');
        const barAudio = document.getElementById('storage-bar-audio');
        const barArt = document.getElementById('storage-bar-art');
        const audioMbEl = document.getElementById('storage-audio-mb');
        const artMbEl = document.getElementById('storage-art-mb');
        const orphanStatusEl = document.getElementById('storage-orphan-status');

        if (!usedLabel) return;

        try {
            const allRecords = await YolkOfflineDB.getAllTracks();
            let audioBytes = 0;
            let extraBytes = 0;

            const libraryUidSet = new Set();
            favorites.forEach(t => { if (t) libraryUidSet.add(getTrackUid(t)); });
            playlists.forEach(pl => {
                if (Array.isArray(pl.tracks)) {
                    pl.tracks.forEach(t => { if (t) libraryUidSet.add(getTrackUid(t)); });
                }
            });

            let orphanCount = 0;
            for (const rec of allRecords) {
                const aSize = rec.audioBlob ? rec.audioBlob.size : (rec.size || 0);
                const iSize = (rec.artworkBlob ? rec.artworkBlob.size : 0) + (rec.lyrics ? rec.lyrics.length * 2 : 0);
                audioBytes += aSize;
                extraBytes += iSize;
                if (rec.uid && !libraryUidSet.has(rec.uid)) {
                    orphanCount++;
                }
            }

            const totalBytes = audioBytes + extraBytes;
            const totalMb = (totalBytes / (1024 * 1024)).toFixed(1);
            const audioMb = (audioBytes / (1024 * 1024)).toFixed(1);
            const artMb = (extraBytes / (1024 * 1024)).toFixed(2);

            if (countBadge) countBadge.textContent = `${allRecords.length} ${allRecords.length === 1 ? 'Song' : 'Songs'}`;
            if (usedLabel) usedLabel.textContent = `${totalMb} MB`;
            if (audioMbEl) audioMbEl.textContent = `${audioMb} MB`;
            if (artMbEl) artMbEl.textContent = `${artMb} MB`;

            if (orphanStatusEl) {
                if (orphanCount > 0) {
                    orphanStatusEl.textContent = `${orphanCount} cached ${orphanCount === 1 ? 'song' : 'songs'} not in Library`;
                } else {
                    orphanStatusEl.textContent = `All cached songs in Library (${libraryUidSet.size} total in Library)`;
                }
            }

            let quotaBytes = 0;
            if (navigator.storage && typeof navigator.storage.estimate === 'function') {
                try {
                    const est = await navigator.storage.estimate();
                    quotaBytes = est.quota || 0;
                } catch (_) {}
            }

            if (quotaLabel) {
                if (quotaBytes > 0) {
                    const quotaGb = (quotaBytes / (1024 * 1024 * 1024)).toFixed(1);
                    quotaLabel.textContent = `of ~${quotaGb} GB available browser storage`;
                } else {
                    quotaLabel.textContent = `${allRecords.length} offline tracks stored in IndexedDB`;
                }
            }

            if (barAudio && barArt) {
                if (totalBytes <= 0) {
                    barAudio.style.width = '0%';
                    barArt.style.width = '0%';
                } else {
                    const audioRatio = Math.max(8, Math.round((audioBytes / totalBytes) * 100));
                    const artRatio = Math.max(2, 100 - audioRatio);
                    barAudio.style.width = `${audioRatio}%`;
                    barArt.style.width = `${artRatio}%`;
                }
            }
        } catch (err) {
            console.warn('Storage manager error:', err);
        }
    }
    window.refreshStorageManagerUI = refreshStorageManagerUI;

    const storageSyncBtn = document.getElementById('storage-sync-library-btn');
    const storageCleanOrphansBtn = document.getElementById('storage-clean-orphans-btn');
    const storageClearAllBtn = document.getElementById('storage-clear-all-btn');

    if (storageSyncBtn) {
        storageSyncBtn.addEventListener('click', async () => {
            triggerHaptic('medium');
            const allLibTracks = [...favorites];
            playlists.forEach(pl => {
                if (Array.isArray(pl.tracks)) allLibTracks.push(...pl.tracks);
            });
            if (allLibTracks.length === 0) {
                showToast('Your Library is empty');
                return;
            }
            let missing = 0;
            for (const t of allLibTracks) {
                if (!(await YolkOfflineDB.isDownloaded(getTrackUid(t)))) missing++;
            }
            if (missing === 0) {
                showToast('All Library songs are already downloaded offline!');
            } else {
                enqueueLibraryDownload(allLibTracks);
                showToast(`Syncing ${missing} missing Library ${missing === 1 ? 'song' : 'songs'}…`);
            }
            refreshStorageManagerUI();
        });
    }

    if (storageCleanOrphansBtn) {
        storageCleanOrphansBtn.addEventListener('click', async () => {
            triggerHaptic('light');
            const libraryUidSet = new Set();
            favorites.forEach(t => { if (t) libraryUidSet.add(getTrackUid(t)); });
            playlists.forEach(pl => {
                if (Array.isArray(pl.tracks)) {
                    pl.tracks.forEach(t => { if (t) libraryUidSet.add(getTrackUid(t)); });
                }
            });
            const allRecords = await YolkOfflineDB.getAllTracks();
            let removed = 0;
            for (const rec of allRecords) {
                if (rec.uid && !libraryUidSet.has(rec.uid)) {
                    await YolkOfflineDB.deleteTrack(rec.uid);
                    removed++;
                }
            }
            await refreshStorageManagerUI();
            if (typeof window.refreshAllDownloadButtonsUI === 'function') window.refreshAllDownloadButtonsUI();
            showToast(removed > 0 ? `Cleared ${removed} orphaned offline ${removed === 1 ? 'track' : 'tracks'}` : 'No orphaned cache found');
        });
    }

    if (storageClearAllBtn) {
        storageClearAllBtn.addEventListener('click', async () => {
            triggerHaptic('heavy');
            const allRecords = await YolkOfflineDB.getAllTracks();
            if (allRecords.length === 0) {
                showToast('No offline downloads to delete');
                return;
            }
            if (!confirm(`Delete all ${allRecords.length} downloaded offline songs from this device? (Your playlists & favorites will remain intact.)`)) {
                return;
            }
            _yolkDownloadQueue.length = 0;
            for (const rec of allRecords) {
                await YolkOfflineDB.deleteTrack(rec.uid);
            }
            await refreshStorageManagerUI();
            if (typeof window.refreshAllDownloadButtonsUI === 'function') window.refreshAllDownloadButtonsUI();
            showToast('Cleared all offline downloads');
        });
    }

    refreshStorageManagerUI();

    // ==== SHARE SONG, SHARE LYRICS & SHARE ALBUM CARD GENERATOR + NATIVE iOS SHARE SHEET ====
    const shareCardModal = document.getElementById('share-card-modal');
    const shareModalCloseBtn = document.getElementById('share-modal-close-btn');
    const shareModalTitle = document.getElementById('share-modal-title');
    const shareModalSubtitle = document.getElementById('share-modal-subtitle');
    const shareModeTabs = document.getElementById('share-mode-tabs');
    const shareTabSong = document.getElementById('share-tab-song');
    const shareTabLyrics = document.getElementById('share-tab-lyrics');
    const shareLyricsPickerSection = document.getElementById('share-lyrics-picker-section');
    const shareLyricsPickerList = document.getElementById('share-lyrics-picker-list');
    const shareLyricsSelectedCount = document.getElementById('share-lyrics-selected-count');
    const shareCardCanvas = document.getElementById('share-card-canvas');
    const shareNativeBtn = document.getElementById('share-native-btn');
    const shareDownloadImgBtn = document.getElementById('share-download-img-btn');
    const shareCopyLinkBtn = document.getElementById('share-copy-link-btn');

    let currentShareState = {
        mode: 'song', // 'song', 'lyrics', or 'album'
        title: '',
        artist: '',
        subtitle: '',
        artworkUrl: '',
        shareUrl: '',
        lyricLines: [],
        selectedLyricIndices: [],
        palette: null,
        loadedCoverImg: null
    };

    function getShareDeepLinkUrl() {
        const base = window.location.origin + window.location.pathname;
        if (currentShareState.mode === 'album' && currentAlbumData && currentAlbumData.id) {
            const cleanId = String(currentAlbumData.id).replace('ytm-', '');
            return `${base}#album=${encodeURIComponent(cleanId)}`;
        }
        if (currentTrack) {
            const vid = getYoutubeIdSync(currentTrack) || currentTrack.id || '';
            const title = currentTrack.title || currentTrack.name || '';
            const artist = currentTrack.artist_name || currentTrack.artist || '';
            return `${base}#song=${encodeURIComponent(vid)}&t=${encodeURIComponent(title)}&a=${encodeURIComponent(artist)}`;
        }
        return window.location.origin;
    }

    function drawRoundedRectPath(ctx, x, y, w, h, r) {
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.lineTo(x + w - r, y);
        ctx.quadraticCurveTo(x + w, y, x + w, y + r);
        ctx.lineTo(x + w, y + h - r);
        ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
        ctx.lineTo(x + r, y + h);
        ctx.quadraticCurveTo(x, y + h, x, y + h - r);
        ctx.lineTo(x, y + r);
        ctx.quadraticCurveTo(x, y, x + r, y);
        ctx.closePath();
    }

    function wrapCanvasText(ctx, text, maxWidth, maxLines = 3) {
        const words = String(text || '').split(/\s+/);
        const lines = [];
        let cur = '';
        for (const w of words) {
            const test = cur ? `${cur} ${w}` : w;
            if (ctx.measureText(test).width > maxWidth && cur) {
                lines.push(cur);
                cur = w;
                if (lines.length >= maxLines) break;
            } else {
                cur = test;
            }
        }
        if (cur && lines.length < maxLines) {
            lines.push(cur);
        }
        return lines;
    }

    function renderShareCardCanvas() {
        if (!shareCardCanvas) return;
        const ctx = shareCardCanvas.getContext('2d');
        const W = shareCardCanvas.width; // 1080
        const H = shareCardCanvas.height; // 1350

        ctx.clearRect(0, 0, W, H);

        const pal = currentShareState.palette;
        const c1 = pal && pal[0] ? pal[0] : { r: 24, g: 24, b: 29 };
        const c2 = pal && pal[1] ? pal[1] : { r: 45, g: 45, b: 55 };
        const c3 = pal && pal[2] ? pal[2] : { r: 18, g: 18, b: 22 };

        // 1. Rich Multi-Stop Mesh Gradient Background
        const bgGrad = ctx.createLinearGradient(0, 0, W, H);
        bgGrad.addColorStop(0, `rgb(${Math.round(c1.r * 0.72)}, ${Math.round(c1.g * 0.72)}, ${Math.round(c1.b * 0.72)})`);
        bgGrad.addColorStop(0.52, `rgb(${Math.round(c2.r * 0.55)}, ${Math.round(c2.g * 0.55)}, ${Math.round(c2.b * 0.55)})`);
        bgGrad.addColorStop(1, `rgb(${Math.round(c3.r * 0.35)}, ${Math.round(c3.g * 0.35)}, ${Math.round(c3.b * 0.35)})`);
        ctx.fillStyle = bgGrad;
        ctx.fillRect(0, 0, W, H);

        // Ambient radial glow
        const radGrad = ctx.createRadialGradient(W * 0.25, H * 0.2, 40, W * 0.25, H * 0.2, W * 0.85);
        radGrad.addColorStop(0, `rgba(${c1.r}, ${c1.g}, ${c1.b}, 0.55)`);
        radGrad.addColorStop(1, 'rgba(0, 0, 0, 0)');
        ctx.fillStyle = radGrad;
        ctx.fillRect(0, 0, W, H);

        // 2. Frosted Inner Glass Container
        const cardX = 76, cardY = 76, cardW = W - 152, cardH = H - 152;
        ctx.save();
        drawRoundedRectPath(ctx, cardX, cardY, cardW, cardH, 64);
        ctx.fillStyle = 'rgba(18, 18, 22, 0.44)';
        ctx.fill();
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.22)';
        ctx.stroke();
        ctx.restore();

        const img = currentShareState.loadedCoverImg;

        if (currentShareState.mode === 'lyrics') {
            // LYRICS CARD LAYOUT: Top Header (Cover + Song/Artist) + Bold Featured Lyric Lines
            const thumbX = cardX + 72, thumbY = cardY + 76, thumbSize = 148;
            ctx.save();
            drawRoundedRectPath(ctx, thumbX, thumbY, thumbSize, thumbSize, 32);
            ctx.clip();
            if (img && img.complete && img.naturalWidth > 0) {
                ctx.drawImage(img, thumbX, thumbY, thumbSize, thumbSize);
            } else {
                ctx.fillStyle = 'rgba(255,255,255,0.12)';
                ctx.fillRect(thumbX, thumbY, thumbSize, thumbSize);
            }
            ctx.restore();

            // Header Text
            ctx.fillStyle = '#FFFFFF';
            ctx.font = '800 42px Inter, -apple-system, BlinkMacSystemFont, sans-serif';
            const titleLines = wrapCanvasText(ctx, currentShareState.title, cardW - 320, 1);
            ctx.fillText(titleLines[0] || '', thumbX + thumbSize + 36, thumbY + 68);

            ctx.fillStyle = 'rgba(255, 255, 255, 0.72)';
            ctx.font = '600 32px Inter, -apple-system, BlinkMacSystemFont, sans-serif';
            const artistLines = wrapCanvasText(ctx, currentShareState.artist, cardW - 320, 1);
            ctx.fillText(artistLines[0] || '', thumbX + thumbSize + 36, thumbY + 116);

            // Divider
            ctx.fillStyle = 'rgba(255, 255, 255, 0.14)';
            ctx.fillRect(cardX + 72, thumbY + thumbSize + 48, cardW - 144, 2);

            // Selected Lyric Lines
            const selectedTexts = currentShareState.selectedLyricIndices
                .map(i => currentShareState.lyricLines[i])
                .filter(Boolean);
            const linesToRender = selectedTexts.length > 0 ? selectedTexts : ['♪ Instrumental / Enjoy the music'];

            let curY = thumbY + thumbSize + 135;
            const maxLyricWidth = cardW - 144;
            const fontSize = linesToRender.length >= 4 ? 50 : (linesToRender.length === 3 ? 56 : 64);
            const lineHeight = Math.round(fontSize * 1.32);

            ctx.font = `800 ${fontSize}px Inter, -apple-system, BlinkMacSystemFont, sans-serif`;
            ctx.fillStyle = '#FFFFFF';

            for (const lyricLine of linesToRender) {
                const wrapped = wrapCanvasText(ctx, lyricLine, maxLyricWidth, 2);
                for (const wLine of wrapped) {
                    if (curY < cardY + cardH - 160) {
                        ctx.fillText(wLine, cardX + 72, curY);
                        curY += lineHeight;
                    }
                }
                curY += Math.round(fontSize * 0.42);
            }
        } else {
            // SONG OR ALBUM CARD LAYOUT: Large Centered Artwork + Bold Title & Artist + Badge
            const artSize = 620;
            const artX = Math.round((W - artSize) / 2);
            const artY = cardY + 86;

            ctx.save();
            ctx.shadowColor = 'rgba(0, 0, 0, 0.45)';
            ctx.shadowBlur = 48;
            ctx.shadowOffsetY = 24;
            drawRoundedRectPath(ctx, artX, artY, artSize, artSize, 48);
            ctx.fillStyle = 'rgba(255, 255, 255, 0.08)';
            ctx.fill();
            ctx.restore();

            ctx.save();
            drawRoundedRectPath(ctx, artX, artY, artSize, artSize, 48);
            ctx.clip();
            if (img && img.complete && img.naturalWidth > 0) {
                ctx.drawImage(img, artX, artY, artSize, artSize);
            } else {
                ctx.fillStyle = 'rgba(255, 255, 255, 0.12)';
                ctx.fillRect(artX, artY, artSize, artSize);
            }
            ctx.restore();

            // Badge Pill (SONG or ALBUM)
            const badgeText = currentShareState.mode === 'album'
                ? (currentShareState.subtitle || 'ALBUM').toUpperCase()
                : 'NOW PLAYING ON YOLK!';
            ctx.font = '800 22px Inter, -apple-system, BlinkMacSystemFont, sans-serif';
            ctx.fillStyle = '#FACC15';
            ctx.fillText(badgeText, artX, artY + artSize + 72);

            // Title
            ctx.font = '800 56px Inter, -apple-system, BlinkMacSystemFont, sans-serif';
            ctx.fillStyle = '#FFFFFF';
            const wrappedTitle = wrapCanvasText(ctx, currentShareState.title, artSize, 2);
            let textY = artY + artSize + 140;
            wrappedTitle.forEach(line => {
                ctx.fillText(line, artX, textY);
                textY += 66;
            });

            // Artist
            ctx.font = '600 38px Inter, -apple-system, BlinkMacSystemFont, sans-serif';
            ctx.fillStyle = 'rgba(255, 255, 255, 0.75)';
            const wrappedArtist = wrapCanvasText(ctx, currentShareState.artist, artSize, 1);
            ctx.fillText(wrappedArtist[0] || '', artX, textY + 10);
        }

        // 3. Bottom Yolk! Branding Footer inside Card
        const footerY = cardY + cardH - 64;
        ctx.save();
        ctx.beginPath();
        ctx.arc(cardX + 90, footerY - 12, 16, 0, Math.PI * 2);
        ctx.fillStyle = '#FACC15';
        ctx.fill();
        ctx.lineWidth = 3.5;
        ctx.strokeStyle = '#09090b';
        ctx.stroke();

        ctx.font = '800 32px Inter, -apple-system, BlinkMacSystemFont, sans-serif';
        ctx.fillStyle = '#FFFFFF';
        ctx.fillText('Yolk!', cardX + 120, footerY);

        ctx.font = '600 24px Inter, -apple-system, BlinkMacSystemFont, sans-serif';
        ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
        ctx.textAlign = 'right';
        ctx.fillText(currentShareState.mode === 'lyrics' ? 'Synced Lyrics' : (currentShareState.mode === 'album' ? 'Full Album' : 'Music'), cardX + cardW - 72, footerY - 2);
        ctx.restore();
    }

    function populateShareLyricsPicker() {
        if (!shareLyricsPickerList) return;
        shareLyricsPickerList.innerHTML = '';

        const lines = currentShareState.lyricLines;
        if (!lines || lines.length === 0) {
            shareLyricsPickerList.innerHTML = `<div class="py-4 text-center text-xs text-zinc-400 font-medium">No lyrics available for this track.</div>`;
            if (shareLyricsSelectedCount) shareLyricsSelectedCount.textContent = '0/4 selected';
            return;
        }

        if (shareLyricsSelectedCount) {
            shareLyricsSelectedCount.textContent = `${currentShareState.selectedLyricIndices.length}/4 selected`;
        }

        lines.forEach((lineText, idx) => {
            const isSelected = currentShareState.selectedLyricIndices.includes(idx);
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = `w-full text-left px-3 py-2 rounded-xl text-xs font-bold transition-all cursor-pointer flex items-center justify-between gap-2 ${
                isSelected
                    ? 'bg-[#FDE047] text-zinc-900 border border-[#FACC15] shadow-2xs'
                    : 'bg-white/80 text-zinc-700 hover:bg-zinc-100 border border-zinc-200/60'
            }`;
            btn.innerHTML = `
                <span class="truncate">${escapeHtml(lineText)}</span>
                <span class="text-[10px] font-extrabold shrink-0">${isSelected ? '✓' : '+'}</span>
            `;
            btn.addEventListener('click', () => {
                triggerHaptic('selection');
                const pos = currentShareState.selectedLyricIndices.indexOf(idx);
                if (pos > -1) {
                    currentShareState.selectedLyricIndices.splice(pos, 1);
                } else {
                    if (currentShareState.selectedLyricIndices.length >= 4) {
                        currentShareState.selectedLyricIndices.shift();
                    }
                    currentShareState.selectedLyricIndices.push(idx);
                    currentShareState.selectedLyricIndices.sort((a, b) => a - b);
                }
                populateShareLyricsPicker();
                renderShareCardCanvas();
            });
            shareLyricsPickerList.appendChild(btn);
        });
    }

    function setShareModalTab(mode) {
        currentShareState.mode = mode;
        if (shareTabSong && shareTabLyrics) {
            const isSong = mode === 'song';
            shareTabSong.className = isSong
                ? 'py-1.5 px-3 rounded-xl text-xs font-bold bg-zinc-900 text-white shadow-xs transition-all cursor-pointer'
                : 'py-1.5 px-3 rounded-xl text-xs font-bold text-zinc-600 hover:text-zinc-900 transition-all cursor-pointer';
            shareTabLyrics.className = !isSong
                ? 'py-1.5 px-3 rounded-xl text-xs font-bold bg-zinc-900 text-white shadow-xs transition-all cursor-pointer'
                : 'py-1.5 px-3 rounded-xl text-xs font-bold text-zinc-600 hover:text-zinc-900 transition-all cursor-pointer';
        }
        if (shareLyricsPickerSection) {
            shareLyricsPickerSection.classList.toggle('hidden', mode !== 'lyrics');
            shareLyricsPickerSection.classList.toggle('flex', mode === 'lyrics');
        }
        renderShareCardCanvas();
    }

    function openShareModal(initialMode = 'song') {
        if (!shareCardModal) return;
        triggerHaptic('medium');

        if (initialMode === 'album') {
            if (!currentAlbumData) {
                showToast('No album loaded to share');
                return;
            }
            const tracks = Array.isArray(currentAlbumData.tracks) ? currentAlbumData.tracks : [];
            const artwork = currentAlbumData.artwork_url || (tracks[0]?.artwork_url) || '';
            currentShareState = {
                mode: 'album',
                title: currentAlbumData.name || 'Unknown Album',
                artist: currentAlbumData.artist_name || 'Unknown Artist',
                subtitle: `Album • ${tracks.length} ${tracks.length === 1 ? 'Track' : 'Tracks'}`,
                artworkUrl: getProxyUrl(artwork, '500x500'),
                shareUrl: '',
                lyricLines: [],
                selectedLyricIndices: [],
                palette: null,
                loadedCoverImg: null
            };
            currentShareState.shareUrl = getShareDeepLinkUrl();
            if (shareModalTitle) shareModalTitle.textContent = 'Share Album';
            if (shareModalSubtitle) shareModalSubtitle.textContent = `${currentShareState.title} • ${currentShareState.artist}`;
            if (shareModeTabs) shareModeTabs.classList.add('hidden');
            if (shareLyricsPickerSection) {
                shareLyricsPickerSection.classList.add('hidden');
                shareLyricsPickerSection.classList.remove('flex');
            }
        } else {
            if (!currentTrack) {
                showToast('Play a song first to share');
                return;
            }
            const cleanLines = (parsedLyrics || [])
                .filter(p => p.type === 'line' && p.text && p.text.trim())
                .map(p => p.text.trim());

            // Pre-select active lyric line + next line
            let defaultSelected = [0];
            const container = document.getElementById('lyrics-container');
            if (container && typeof container._lastActiveIndex === 'number' && container._lastActiveIndex >= 0) {
                const activeItem = parsedLyrics[container._lastActiveIndex];
                if (activeItem && activeItem.text) {
                    const foundIdx = cleanLines.indexOf(activeItem.text.trim());
                    if (foundIdx > -1) {
                        defaultSelected = cleanLines[foundIdx + 1] ? [foundIdx, foundIdx + 1] : [foundIdx];
                    }
                }
            } else if (cleanLines.length >= 2) {
                defaultSelected = [0, 1];
            }

            const artUrl = currentTrack._offlineArtUrl || getProxyUrl(currentTrack.artwork_url || currentTrack.image, '500x500');
            currentShareState = {
                mode: (initialMode === 'lyrics' && cleanLines.length > 0) ? 'lyrics' : 'song',
                title: currentTrack.title || currentTrack.name || 'Unknown Title',
                artist: currentTrack.artist_name || currentTrack.artist || 'Unknown Artist',
                subtitle: 'Song',
                artworkUrl: artUrl,
                shareUrl: '',
                lyricLines: cleanLines,
                selectedLyricIndices: cleanLines.length > 0 ? defaultSelected : [],
                palette: null,
                loadedCoverImg: null
            };
            currentShareState.shareUrl = getShareDeepLinkUrl();
            if (shareModalTitle) shareModalTitle.textContent = 'Share Song & Lyrics';
            if (shareModalSubtitle) shareModalSubtitle.textContent = `${currentShareState.title} • ${currentShareState.artist}`;
            if (shareModeTabs) shareModeTabs.classList.remove('hidden');

            populateShareLyricsPicker();
            setShareModalTab(currentShareState.mode);
        }

        renderShareCardCanvas();

        // Load artwork & palette for canvas card
        if (currentShareState.artworkUrl) {
            extractArtworkPalette(currentShareState.artworkUrl, (colors) => {
                currentShareState.palette = colors;
                renderShareCardCanvas();
            });
            const coverImg = new Image();
            const isLocal = currentShareState.artworkUrl.startsWith('data:') || currentShareState.artworkUrl.startsWith('blob:');
            if (!isLocal) coverImg.crossOrigin = 'Anonymous';
            let retried = false;
            coverImg.onload = () => {
                currentShareState.loadedCoverImg = coverImg;
                renderShareCardCanvas();
            };
            coverImg.onerror = () => {
                if (!isLocal && !retried) {
                    retried = true;
                    coverImg.src = `/api/proxy?url=${encodeURIComponent(currentShareState.artworkUrl)}`;
                }
            };
            const corsArtUrl = isLocal
                ? currentShareState.artworkUrl
                : (currentShareState.artworkUrl + (currentShareState.artworkUrl.includes('?') ? '&' : '?') + 'cors=1');
            coverImg.src = corsArtUrl;
        }

        shareCardModal.classList.add('active');
    }
    window.openShareModal = openShareModal;

    function closeShareModal() {
        if (shareCardModal) shareCardModal.classList.remove('active');
    }

    if (shareModalCloseBtn) shareModalCloseBtn.addEventListener('click', closeShareModal);
    if (shareCardModal) {
        shareCardModal.addEventListener('click', (e) => {
            if (e.target === shareCardModal) closeShareModal();
        });
    }
    if (shareTabSong) {
        shareTabSong.addEventListener('click', () => {
            triggerHaptic('selection');
            setShareModalTab('song');
        });
    }
    if (shareTabLyrics) {
        shareTabLyrics.addEventListener('click', () => {
            triggerHaptic('selection');
            setShareModalTab('lyrics');
        });
    }

    // Wire Share buttons across Now Playing, Lyrics, Bottom Player, and Album Page
    const npShareBtn = document.getElementById('np-share-btn');
    const npShareLyricsBtn = document.getElementById('np-share-lyrics-btn');
    const npMobileMoreShareBtn = document.getElementById('np-mobile-more-share-btn');
    const lyricsMoreShareLyricsBtn = document.getElementById('lyrics-more-share-lyrics-btn');
    const bpMoreShareBtn = document.getElementById('bp-more-share-btn');
    const albumShareBtn = document.getElementById('album-share-btn');

    if (npShareBtn) npShareBtn.addEventListener('click', () => openShareModal(isLyricsUserEnabled ? 'lyrics' : 'song'));
    if (npShareLyricsBtn) npShareLyricsBtn.addEventListener('click', () => openShareModal('lyrics'));
    if (npMobileMoreShareBtn) {
        npMobileMoreShareBtn.addEventListener('click', () => {
            if (npMobileMorePopover) npMobileMorePopover.classList.add('hidden');
            openShareModal(isLyricsUserEnabled ? 'lyrics' : 'song');
        });
    }
    if (lyricsMoreShareLyricsBtn) {
        lyricsMoreShareLyricsBtn.addEventListener('click', () => {
            if (lyricsBarMorePopover) lyricsBarMorePopover.classList.add('hidden');
            openShareModal('lyrics');
        });
    }
    if (bpMoreShareBtn) {
        bpMoreShareBtn.addEventListener('click', () => {
            if (bpMobileMorePopover) bpMobileMorePopover.classList.add('hidden');
            openShareModal('song');
        });
    }
    if (albumShareBtn) {
        albumShareBtn.addEventListener('click', () => openShareModal('album'));
    }

    // Native iOS Share Sheet / Image Download / Copy Link Actions
    if (shareNativeBtn) {
        shareNativeBtn.addEventListener('click', async () => {
            triggerHaptic('medium');
            if (!shareCardCanvas) return;

            const shareTitle = `${currentShareState.title} — ${currentShareState.artist}`;
            let shareText = `Listen to "${currentShareState.title}" by ${currentShareState.artist} on Yolk!`;
            if (currentShareState.mode === 'lyrics' && currentShareState.selectedLyricIndices.length > 0) {
                const quote = currentShareState.selectedLyricIndices.map(i => currentShareState.lyricLines[i]).filter(Boolean).join('\n');
                shareText = `"${quote}"\n— ${currentShareState.title} by ${currentShareState.artist}`;
            } else if (currentShareState.mode === 'album') {
                shareText = `Check out the album "${currentShareState.title}" by ${currentShareState.artist} on Yolk!`;
            }

            try {
                const blob = await new Promise(resolve => shareCardCanvas.toBlob(resolve, 'image/png'));
                if (blob && navigator.share) {
                    const file = new File([blob], `yolk-${currentShareState.mode}-card.png`, { type: 'image/png' });
                    if (navigator.canShare && navigator.canShare({ files: [file] })) {
                        await navigator.share({
                            files: [file],
                            title: shareTitle,
                            text: shareText,
                            url: currentShareState.shareUrl
                        });
                        return;
                    }
                    await navigator.share({
                        title: shareTitle,
                        text: shareText,
                        url: currentShareState.shareUrl
                    });
                    return;
                }
            } catch (err) {
                if (err && err.name === 'AbortError') return;
            }

            // Fallback: copy link & trigger image download
            if (shareDownloadImgBtn) shareDownloadImgBtn.click();
        });
    }

    if (shareDownloadImgBtn) {
        shareDownloadImgBtn.addEventListener('click', () => {
            triggerHaptic('light');
            if (!shareCardCanvas) return;
            const link = document.createElement('a');
            const safeName = (currentShareState.title || 'yolk-card').toLowerCase().replace(/[^a-z0-9]+/g, '-');
            link.download = `${safeName}-${currentShareState.mode}.png`;
            link.href = shareCardCanvas.toDataURL('image/png');
            link.click();
            showToast('Saved Share Card image!');
        });
    }

    if (shareCopyLinkBtn) {
        shareCopyLinkBtn.addEventListener('click', async () => {
            triggerHaptic('light');
            const url = currentShareState.shareUrl || window.location.href;
            try {
                await navigator.clipboard.writeText(url);
                showToast('Share link copied to clipboard!');
            } catch (_) {
                showToast(url);
            }
        });
    }

    // =========================================================================
    // 1. CROSSFADE SETTINGS UI
    // =========================================================================
    const crossfadeSlider = document.getElementById('crossfade-slider');
    const crossfadeBadge = document.getElementById('crossfade-badge');
    const crossfadeValLabel = document.getElementById('crossfade-val-label');
    const crossfadePresetPills = document.querySelectorAll('.crossfade-preset-pill');

    function updateCrossfadeUI(sec, notify = false) {
        crossfadeSeconds = Math.max(0, Math.min(12, parseInt(sec, 10) || 0));
        localStorage.setItem('yolk_crossfade_sec', String(crossfadeSeconds));

        const label = crossfadeSeconds === 0 ? 'Off' : `${crossfadeSeconds}s`;
        if (crossfadeBadge) crossfadeBadge.textContent = label;
        if (crossfadeValLabel) crossfadeValLabel.textContent = label;
        if (crossfadeSlider) crossfadeSlider.value = String(crossfadeSeconds);

        crossfadePresetPills.forEach(pill => {
            const pSec = parseInt(pill.getAttribute('data-crossfade-sec') || '0', 10);
            const isActive = pSec === crossfadeSeconds;
            pill.classList.toggle('bg-zinc-900', isActive);
            pill.classList.toggle('text-white', isActive);
            pill.classList.toggle('border-zinc-900', isActive);
            pill.classList.toggle('font-bold', isActive);
            pill.classList.toggle('bg-zinc-100', !isActive);
            pill.classList.toggle('text-zinc-700', !isActive);
            pill.classList.toggle('font-semibold', !isActive);
        });

        if (crossfadeSeconds === 0) {
            clearCrossfadeTimers();
            currentAudio.volume = currentVolume;
        }
        if (notify) {
            showToast(crossfadeSeconds === 0 ? 'Crossfade turned off' : `Crossfade set to ${crossfadeSeconds}s`);
        }
    }

    if (crossfadeSlider) {
        crossfadeSlider.addEventListener('input', (e) => {
            updateCrossfadeUI(e.target.value, false);
        });
        crossfadeSlider.addEventListener('change', (e) => {
            triggerHaptic('selection');
            updateCrossfadeUI(e.target.value, true);
        });
    }
    crossfadePresetPills.forEach(pill => {
        pill.addEventListener('click', () => {
            triggerHaptic('selection');
            const val = parseInt(pill.getAttribute('data-crossfade-sec') || '0', 10);
            updateCrossfadeUI(val, true);
        });
    });
    updateCrossfadeUI(crossfadeSeconds, false);

    // =========================================================================
    // 2. REAL-TIME 60FPS AUDIO VISUALIZER (SPECTRUM BARS / FLUID WAVE / PULSE GLOW)
    // =========================================================================
    const npVisualizerCanvas = document.getElementById('np-visualizer-canvas');
    const npVisualizerWrapper = document.getElementById('np-visualizer-wrapper');
    const visualizerToggleBtn = document.getElementById('visualizer-toggle-btn');
    const visualizerToggleKnob = document.getElementById('visualizer-toggle-knob');
    const visualizerStylePills = document.querySelectorAll('.visualizer-style-pill');
    const npArtBox = document.getElementById('now-playing-art');

    const _vizFreqBins = new Uint8Array(64);
    const _vizSmoothBins = new Float32Array(28);

    function updateVisualizerSettingsUI(notify = false) {
        localStorage.setItem('yolk_visualizer_enabled', visualizerEnabled ? 'true' : 'false');
        localStorage.setItem('yolk_visualizer_style', visualizerStyle);

        if (visualizerToggleBtn) {
            visualizerToggleBtn.setAttribute('aria-checked', visualizerEnabled ? 'true' : 'false');
            visualizerToggleBtn.style.backgroundColor = visualizerEnabled ? '#FDE047' : 'rgba(212, 212, 216, 0.8)';
            visualizerToggleBtn.style.borderColor = visualizerEnabled ? '#FACC15' : 'rgba(161, 161, 170, 0.7)';
        }
        if (visualizerToggleKnob) {
            visualizerToggleKnob.style.transform = visualizerEnabled ? 'translateX(24px)' : 'translateX(0px)';
            visualizerToggleKnob.style.backgroundColor = visualizerEnabled ? '#18181b' : '#ffffff';
        }
        if (npVisualizerWrapper) {
            const hideCanvas = !visualizerEnabled || visualizerStyle === 'glow';
            npVisualizerWrapper.style.opacity = hideCanvas ? '0' : '1';
            npVisualizerWrapper.style.height = hideCanvas ? '0px' : '36px';
            npVisualizerWrapper.style.marginTop = hideCanvas ? '0px' : '10px';
        }
        if (!visualizerEnabled && npArtBox) {
            npArtBox.style.boxShadow = '';
        }

        visualizerStylePills.forEach(pill => {
            const st = pill.getAttribute('data-viz-style');
            const isActive = visualizerEnabled && st === visualizerStyle;
            pill.classList.toggle('bg-zinc-900', isActive);
            pill.classList.toggle('text-white', isActive);
            pill.classList.toggle('border-zinc-900', isActive);
            pill.classList.toggle('font-bold', isActive);
            pill.classList.toggle('bg-zinc-100', !isActive);
            pill.classList.toggle('text-zinc-700', !isActive);
            pill.classList.toggle('font-semibold', !isActive);
        });

        if (visualizerEnabled && isPlaying) {
            ensureWebAudioEqualizer(true);
        }
        if (notify) {
            showToast(visualizerEnabled ? `Visualizer: ${visualizerStyle.toUpperCase()}` : 'Audio Visualizer disabled');
        }
    }

    if (visualizerToggleBtn) {
        visualizerToggleBtn.addEventListener('click', () => {
            triggerHaptic('medium');
            visualizerEnabled = !visualizerEnabled;
            updateVisualizerSettingsUI(true);
        });
    }
    visualizerStylePills.forEach(pill => {
        pill.addEventListener('click', () => {
            triggerHaptic('selection');
            visualizerStyle = pill.getAttribute('data-viz-style') || 'bars';
            visualizerEnabled = true;
            updateVisualizerSettingsUI(true);
        });
    });
    updateVisualizerSettingsUI(false);

    function computeLiveVisualizerBins(nowSec) {
        let hasRealSignal = false;
        if (yolkAnalyserNode && isPlaying) {
            try {
                yolkAnalyserNode.getByteFrequencyData(_vizFreqBins);
                for (let i = 0; i < 28; i++) {
                    if (_vizFreqBins[i] > 4) {
                        hasRealSignal = true;
                        break;
                    }
                }
            } catch (_) {}
        }

        const numBars = 28;
        let bassEnergy = 0;
        for (let i = 0; i < numBars; i++) {
            let target = 0.08;
            if (isPlaying) {
                if (hasRealSignal) {
                    const binIdx = Math.min(_vizFreqBins.length - 1, Math.floor(i * 1.35) + 1);
                    target = Math.max(0.08, Math.min(1, _vizFreqBins[binIdx] / 245));
                } else {
                    // Musical harmonic fallback when Web Audio source is bypassed/unavailable
                    const centerDist = Math.abs(i - (numBars - 1) / 2) / (numBars / 2);
                    const env = Math.max(0.18, 1 - centerDist * 0.72);
                    const wave1 = Math.sin(nowSec * 7.8 + i * 0.55) * 0.5 + 0.5;
                    const wave2 = Math.cos(nowSec * 12.4 - i * 0.85) * 0.5 + 0.5;
                    const kick = Math.pow(Math.sin(nowSec * 4.2) * 0.5 + 0.5, 3);
                    target = Math.max(0.10, Math.min(0.96, (wave1 * 0.45 + wave2 * 0.35 + kick * 0.35) * env));
                }
            }
            _vizSmoothBins[i] = _vizSmoothBins[i] * 0.72 + target * 0.28;
            if (i < 6) bassEnergy += _vizSmoothBins[i];
        }
        return bassEnergy / 6;
    }

    function drawVisualizerBarsOnContext(ctx, W, H, style, strokeHex) {
        ctx.clearRect(0, 0, W, H);
        const numBars = 28;
        if (style === 'wave') {
            ctx.save();
            ctx.beginPath();
            const midY = H / 2;
            for (let i = 0; i < numBars; i++) {
                const x = (i / (numBars - 1)) * W;
                const amp = (_vizSmoothBins[i] - 0.08) * (H * 0.46);
                const sign = (i % 2 === 0) ? 1 : -1;
                const y = midY + sign * amp;
                if (i === 0) {
                    ctx.moveTo(x, y);
                } else {
                    const prevX = ((i - 1) / (numBars - 1)) * W;
                    const prevAmp = (_vizSmoothBins[i - 1] - 0.08) * (H * 0.46);
                    const prevSign = ((i - 1) % 2 === 0) ? 1 : -1;
                    const prevY = midY + prevSign * prevAmp;
                    const cpX = (prevX + x) / 2;
                    ctx.quadraticCurveTo(prevX, prevY, cpX, (prevY + y) / 2);
                }
            }
            ctx.strokeStyle = strokeHex;
            ctx.lineWidth = 2.6;
            ctx.lineCap = 'round';
            ctx.stroke();
            ctx.restore();
            return;
        }

        // Default: Symmetric Rounded Spectrum Bars
        const gap = 4;
        const barW = Math.max(3, (W - gap * (numBars - 1)) / numBars);
        ctx.save();
        ctx.fillStyle = strokeHex;
        for (let i = 0; i < numBars; i++) {
            const val = _vizSmoothBins[i];
            const barH = Math.max(4, Math.min(H - 2, val * (H - 2)));
            const x = i * (barW + gap);
            const y = (H - barH) / 2;
            ctx.globalAlpha = 0.38 + Math.min(0.62, val * 0.72);
            drawRoundedRectPath(ctx, x, y, barW, barH, barW / 2);
            ctx.fill();
        }
        ctx.restore();
    }

    // =========================================================================
    // 3. NOW PLAYING COVER ART SWIPE GESTURES (LEFT = NEXT, RIGHT = PREV, DOWN = MINIMIZE)
    // =========================================================================
    if (npArtBox) {
        let artStartX = 0;
        let artStartY = 0;
        let artDx = 0;
        let artDy = 0;
        let artSwiping = false;

        npArtBox.addEventListener('touchstart', (e) => {
            if (e.touches.length !== 1) return;
            artStartX = e.touches[0].clientX;
            artStartY = e.touches[0].clientY;
            artDx = 0;
            artDy = 0;
            artSwiping = true;
            npArtBox.style.transition = 'none';
        }, { passive: true });

        npArtBox.addEventListener('touchmove', (e) => {
            if (!artSwiping || e.touches.length !== 1) return;
            artDx = e.touches[0].clientX - artStartX;
            artDy = e.touches[0].clientY - artStartY;
            const clampX = Math.max(-90, Math.min(90, artDx * 0.55));
            const clampY = Math.max(-25, Math.min(95, artDy * 0.5));
            const rot = clampX * 0.06;
            npArtBox.style.transform = `translate3d(${clampX}px, ${clampY}px, 0) rotate(${rot}deg)`;
        }, { passive: true });

        const finishArtSwipe = () => {
            if (!artSwiping) return;
            artSwiping = false;
            const finalDx = artDx;
            const finalDy = artDy;
            npArtBox.style.transition = 'transform 0.38s cubic-bezier(0.16, 1, 0.3, 1)';
            npArtBox.style.transform = '';

            if (Math.abs(finalDx) >= 52 && Math.abs(finalDx) > Math.abs(finalDy) * 1.15) {
                triggerHaptic('medium');
                if (finalDx < 0) {
                    playNext();
                } else {
                    playPrev();
                }
            } else if (finalDy >= 64 && Math.abs(finalDy) > Math.abs(finalDx) * 1.25) {
                triggerHaptic('light');
                window.location.hash = '#' + (previousNavPage || 'search');
            }
        };

        npArtBox.addEventListener('touchend', finishArtSwipe, { passive: true });
        npArtBox.addEventListener('touchcancel', finishArtSwipe, { passive: true });
    }

    // =========================================================================
    // 4. FLOATING PICTURE-IN-PICTURE (PiP) MINI-PLAYER (DESKTOP + SAFARI/iOS FALLBACK)
    // =========================================================================
    let pipWindowRef = null;
    let pipVideoEl = null;
    let pipStreamCanvas = null;
    let pipCoverImage = null;
    let pipCoverImageSrc = '';

    function getActiveLyricTextForPiP() {
        const container = document.getElementById('lyrics-container');
        if (container && typeof container._lastActiveIndex === 'number' && container._lastActiveIndex >= 0) {
            const item = parsedLyrics[container._lastActiveIndex];
            if (item && item.text) return item.text;
        }
        return '';
    }

    function ensurePipCoverLoaded() {
        const src = currentTrack
            ? (currentTrack._offlineArtUrl || getProxyUrl(currentTrack.artwork_url || currentTrack.image, '300x300'))
            : '';
        if (!src || src === pipCoverImageSrc) return;
        pipCoverImageSrc = src;
        const img = new Image();
        const isLocal = src.startsWith('data:') || src.startsWith('blob:');
        if (!isLocal) img.crossOrigin = 'Anonymous';
        img.onload = () => {
            pipCoverImage = img;
        };
        img.src = isLocal ? src : (src + (src.includes('?') ? '&' : '?') + 'cors=1');
    }

    function updateDocumentPipDOM() {
        if (!pipWindowRef || pipWindowRef.closed) return;
        const doc = pipWindowRef.document;
        const titleEl = doc.getElementById('pip-title');
        const artistEl = doc.getElementById('pip-artist');
        const lyricEl = doc.getElementById('pip-lyric');
        const imgEl = doc.getElementById('pip-cover');
        const progFill = doc.getElementById('pip-prog-fill');
        const curEl = doc.getElementById('pip-cur');
        const durEl = doc.getElementById('pip-dur');
        const playBtn = doc.getElementById('pip-play');
        const favBtn = doc.getElementById('pip-fav');
        const bodyEl = doc.body;

        const tTitle = currentTrack ? (currentTrack.title || currentTrack.name || 'Unknown Title') : 'Not Playing';
        const tArtist = currentTrack ? (currentTrack.artist_name || currentTrack.artist || 'Unknown Artist') : 'Select a song';
        const coverSrc = currentTrack ? (currentTrack._offlineArtUrl || getProxyUrl(currentTrack.artwork_url || currentTrack.image, '300x300')) : '';
        const cur = getPlaybackCurrentTime();
        const dur = getPlaybackDuration();
        const pct = dur > 0 ? Math.max(0, Math.min(100, (cur / dur) * 100)) : 0;

        if (titleEl && titleEl.textContent !== tTitle) titleEl.textContent = tTitle;
        if (artistEl && artistEl.textContent !== tArtist) artistEl.textContent = tArtist;
        if (imgEl && coverSrc && imgEl.getAttribute('data-src') !== coverSrc) {
            imgEl.setAttribute('data-src', coverSrc);
            imgEl.src = coverSrc;
        }
        const activeLyric = getActiveLyricTextForPiP();
        if (lyricEl) {
            lyricEl.textContent = activeLyric || (isPlaying ? '♪ Instrumental / Playing…' : 'Paused');
        }
        if (progFill) progFill.style.width = `${pct}%`;
        if (curEl) curEl.textContent = formatTime(cur);
        if (durEl) durEl.textContent = formatTime(dur);
        if (playBtn) {
            playBtn.innerHTML = isPlaying
                ? `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>`
                : `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" style="margin-left:2px"><polygon points="5 3 19 12 5 21 5 3"/></svg>`;
        }
        if (favBtn && currentTrack) {
            const fav = isFavorite(currentTrack.id);
            favBtn.style.color = fav ? '#FACC15' : '#ffffff';
        }
        if (bodyEl && currentCoverColor) {
            const { r, g, b } = currentCoverColor;
            bodyEl.style.background = `linear-gradient(160deg, rgb(${Math.round(r * 0.55)}, ${Math.round(g * 0.55)}, ${Math.round(b * 0.55)}) 0%, #111115 100%)`;
        }

        const pipVizCanvas = doc.getElementById('pip-viz-canvas');
        if (pipVizCanvas) {
            const vCtx = pipVizCanvas.getContext('2d');
            drawVisualizerBarsOnContext(vCtx, pipVizCanvas.width, pipVizCanvas.height, visualizerStyle === 'wave' ? 'wave' : 'bars', '#FDE047');
        }
    }

    function renderFallbackVideoPipCanvas() {
        if (!pipStreamCanvas) return;
        ensurePipCoverLoaded();
        const ctx = pipStreamCanvas.getContext('2d');
        const W = pipStreamCanvas.width;
        const H = pipStreamCanvas.height;

        const c = currentCoverColor || { r: 36, g: 36, b: 44 };
        const grad = ctx.createLinearGradient(0, 0, W, H);
        grad.addColorStop(0, `rgb(${Math.round(c.r * 0.65)}, ${Math.round(c.g * 0.65)}, ${Math.round(c.b * 0.65)})`);
        grad.addColorStop(1, '#0e0e12');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, W, H);

        // Cover Art
        const artSize = 230;
        const artX = (W - artSize) / 2;
        const artY = 38;
        ctx.save();
        drawRoundedRectPath(ctx, artX, artY, artSize, artSize, 28);
        ctx.clip();
        if (pipCoverImage && pipCoverImage.complete && pipCoverImage.naturalWidth > 0) {
            ctx.drawImage(pipCoverImage, artX, artY, artSize, artSize);
        } else {
            ctx.fillStyle = 'rgba(255,255,255,0.12)';
            ctx.fillRect(artX, artY, artSize, artSize);
        }
        ctx.restore();

        // Title & Artist
        const tTitle = currentTrack ? (currentTrack.title || currentTrack.name || 'Not Playing') : 'Not Playing';
        const tArtist = currentTrack ? (currentTrack.artist_name || currentTrack.artist || 'Yolk!') : 'Yolk!';
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'center';
        ctx.font = '800 28px -apple-system, BlinkMacSystemFont, Inter, sans-serif';
        ctx.fillText(tTitle.slice(0, 32), W / 2, 312);

        ctx.fillStyle = 'rgba(255,255,255,0.72)';
        ctx.font = '600 20px -apple-system, BlinkMacSystemFont, Inter, sans-serif';
        ctx.fillText(tArtist.slice(0, 38), W / 2, 342);

        // Synced Lyric Line
        const lyric = getActiveLyricTextForPiP();
        if (lyric) {
            ctx.fillStyle = '#FDE047';
            ctx.font = '700 22px -apple-system, BlinkMacSystemFont, Inter, sans-serif';
            ctx.fillText(lyric.slice(0, 40), W / 2, 386);
        }

        // Visualizer Bars inside PiP
        const numBars = 24;
        const barW = 8;
        const gap = 5;
        const totalW = numBars * barW + (numBars - 1) * gap;
        const startX = (W - totalW) / 2;
        const baseMidY = 432;
        ctx.fillStyle = 'rgba(253, 224, 71, 0.88)';
        for (let i = 0; i < numBars; i++) {
            const v = _vizSmoothBins[i] || 0.1;
            const bH = Math.max(5, v * 36);
            drawRoundedRectPath(ctx, startX + i * (barW + gap), baseMidY - bH / 2, barW, bH, 4);
            ctx.fill();
        }

        // Progress Bar
        const cur = getPlaybackCurrentTime();
        const dur = getPlaybackDuration();
        const pct = dur > 0 ? Math.max(0, Math.min(1, cur / dur)) : 0;
        const barX = 56, barY = 478, barLen = W - 112;
        ctx.fillStyle = 'rgba(255,255,255,0.22)';
        drawRoundedRectPath(ctx, barX, barY, barLen, 8, 4);
        ctx.fill();
        if (pct > 0) {
            ctx.fillStyle = '#ffffff';
            drawRoundedRectPath(ctx, barX, barY, Math.max(8, barLen * pct), 8, 4);
            ctx.fill();
        }
    }

    async function togglePictureInPicture() {
        triggerHaptic('medium');
        if (!currentTrack) {
            showToast('Play a song first to open the Mini-Player');
            return;
        }

        // 1. Desktop Document Picture-in-Picture API (Chrome / Edge / Opera)
        if ('documentPictureInPicture' in window) {
            try {
                if (pipWindowRef && !pipWindowRef.closed) {
                    pipWindowRef.close();
                    pipWindowRef = null;
                    return;
                }
                const pipWin = await window.documentPictureInPicture.requestWindow({
                    width: 340,
                    height: 430
                });
                pipWindowRef = pipWin;
                const doc = pipWin.document;
                doc.head.innerHTML = `
                    <style>
                        * { box-sizing: border-box; margin: 0; padding: 0; user-select: none; -webkit-user-select: none; font-family: -apple-system, BlinkMacSystemFont, 'Geist', sans-serif; }
                        body {
                            width: 100vw; height: 100vh; overflow: hidden;
                            background: linear-gradient(160deg, #27272a 0%, #09090b 100%);
                            color: #ffffff; display: flex; flex-direction: column;
                            align-items: center; justify-content: space-between;
                            padding: 16px 18px;
                        }
                        .cover-wrap {
                            width: 148px; height: 148px; border-radius: 22px; overflow: hidden;
                            box-shadow: 0 14px 34px rgba(0,0,0,0.45); border: 1px solid rgba(255,255,255,0.22);
                            background: rgba(255,255,255,0.08); flex-shrink: 0;
                        }
                        .cover-wrap img { width: 100%; height: 100%; object-fit: cover; display: block; }
                        .meta { width: 100%; text-align: center; margin-top: 8px; }
                        #pip-title { font-size: 16px; font-weight: 800; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
                        #pip-artist { font-size: 12px; font-weight: 600; color: rgba(255,255,255,0.72); margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
                        #pip-lyric {
                            font-size: 12px; font-weight: 700; color: #FDE047; margin-top: 6px;
                            min-height: 18px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
                        }
                        .prog-wrap { width: 100%; margin-top: 6px; }
                        #pip-prog-bar {
                            width: 100%; height: 6px; background: rgba(255,255,255,0.2);
                            border-radius: 999px; overflow: hidden; cursor: pointer; position: relative;
                        }
                        #pip-prog-fill { height: 100%; width: 0%; background: #ffffff; border-radius: 999px; }
                        .times { display: flex; justify-content: space-between; font-size: 10px; font-weight: 700; color: rgba(255,255,255,0.65); margin-top: 4px; }
                        .controls { display: flex; align-items: center; justify-content: center; gap: 16px; margin-top: 6px; width: 100%; }
                        button {
                            background: none; border: none; color: #ffffff; cursor: pointer;
                            display: flex; align-items: center; justify-content: center;
                            transition: transform 0.15s ease, opacity 0.15s ease;
                        }
                        button:hover { transform: scale(1.1); }
                        button:active { transform: scale(0.94); }
                        #pip-play {
                            width: 46px; height: 46px; border-radius: 999px;
                            background: #ffffff; color: #09090b;
                            box-shadow: 0 8px 20px rgba(0,0,0,0.35);
                        }
                    </style>
                `;
                doc.body.innerHTML = `
                    <div class="cover-wrap"><img id="pip-cover" src="" alt="Cover"></div>
                    <canvas id="pip-viz-canvas" width="220" height="24" style="width:220px;height:24px;margin-top:6px;"></canvas>
                    <div class="meta">
                        <div id="pip-title">Not Playing</div>
                        <div id="pip-artist">Yolk!</div>
                        <div id="pip-lyric"></div>
                    </div>
                    <div class="prog-wrap">
                        <div id="pip-prog-bar"><div id="pip-prog-fill"></div></div>
                        <div class="times"><span id="pip-cur">0:00</span><span id="pip-dur">0:00</span></div>
                    </div>
                    <div class="controls">
                        <button id="pip-fav" title="Favorite"><svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg></button>
                        <button id="pip-prev" title="Previous"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3"><polygon points="19 20 9 12 19 4 19 20"/><line x1="5" y1="19" x2="5" y2="5"/></svg></button>
                        <button id="pip-play" title="Play/Pause"></button>
                        <button id="pip-next" title="Next"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3"><polygon points="5 4 15 12 5 20 5 4"/><line x1="19" y1="5" x2="19" y2="19"/></svg></button>
                    </div>
                `;
                doc.getElementById('pip-play').onclick = () => togglePlayPause();
                doc.getElementById('pip-prev').onclick = () => playPrev();
                doc.getElementById('pip-next').onclick = () => playNext();
                doc.getElementById('pip-fav').onclick = () => {
                    if (currentTrack) toggleFavorite(currentTrack, null);
                    updateDocumentPipDOM();
                };
                doc.getElementById('pip-prog-bar').onclick = (e) => {
                    const rect = e.currentTarget.getBoundingClientRect();
                    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
                    const dur = getPlaybackDuration();
                    if (dur > 0) seekToSeconds(ratio * dur);
                };
                updateDocumentPipDOM();
                return;
            } catch (err) {
                console.warn('documentPictureInPicture fallback notice:', err);
            }
        }

        // 2. Safari macOS / iOS / Mobile Canvas-Stream <video> Picture-in-Picture Fallback
        try {
            if (document.pictureInPictureElement) {
                await document.exitPictureInPicture();
                return;
            }
            if (!pipStreamCanvas) {
                pipStreamCanvas = document.createElement('canvas');
                pipStreamCanvas.width = 520;
                pipStreamCanvas.height = 520;
            }
            renderFallbackVideoPipCanvas();
            if (!pipVideoEl) {
                pipVideoEl = document.createElement('video');
                pipVideoEl.muted = true;
                pipVideoEl.playsInline = true;
                pipVideoEl.setAttribute('playsinline', '');
                pipVideoEl.setAttribute('webkit-playsinline', '');
                pipVideoEl.style.cssText = 'position:fixed;bottom:0;right:0;width:1px;height:1px;opacity:0.001;pointer-events:none;z-index:-1;';
                document.body.appendChild(pipVideoEl);
                if (typeof pipStreamCanvas.captureStream === 'function') {
                    pipVideoEl.srcObject = pipStreamCanvas.captureStream(30);
                }
            }
            await pipVideoEl.play().catch(() => {});
            if (typeof pipVideoEl.requestPictureInPicture === 'function') {
                await pipVideoEl.requestPictureInPicture();
            } else if (typeof pipVideoEl.webkitSetPresentationMode === 'function') {
                pipVideoEl.webkitSetPresentationMode(
                    pipVideoEl.webkitPresentationMode === 'picture-in-picture' ? 'inline' : 'picture-in-picture'
                );
            } else {
                showToast('Picture-in-Picture is not supported on this browser');
            }
        } catch (err) {
            console.warn('Video PiP notice:', err);
            showToast('Unable to open Picture-in-Picture on this device');
        }
    }
    window.togglePictureInPicture = togglePictureInPicture;

    const npPipBtn = document.getElementById('np-pip-btn');
    const bpPipBtn = document.getElementById('bp-pip-btn');
    const npMobileMorePipBtn = document.getElementById('np-mobile-more-pip-btn');
    const bpMorePipBtn = document.getElementById('bp-more-pip-btn');

    if (npPipBtn) npPipBtn.addEventListener('click', togglePictureInPicture);
    if (bpPipBtn) bpPipBtn.addEventListener('click', togglePictureInPicture);
    if (npMobileMorePipBtn) {
        npMobileMorePipBtn.addEventListener('click', () => {
            if (npMobileMorePopover) npMobileMorePopover.classList.add('hidden');
            togglePictureInPicture();
        });
    }
    if (bpMorePipBtn) {
        bpMorePipBtn.addEventListener('click', () => {
            if (bpMobileMorePopover) bpMobileMorePopover.classList.add('hidden');
            togglePictureInPicture();
        });
    }

    // Master 60fps Animation Loop for Now Playing Visualizer + Active PiP Window
    function runVisualizerAndPipFrame(ts) {
        const nowSec = (ts || performance.now()) / 1000;
        const onNowPlaying = document.body.getAttribute('data-page') === 'now-playing';
        const hasDocPip = Boolean(pipWindowRef && !pipWindowRef.closed);
        const hasVideoPip = Boolean(
            document.pictureInPictureElement === pipVideoEl ||
            (pipVideoEl && pipVideoEl.webkitPresentationMode === 'picture-in-picture')
        );

        if ((visualizerEnabled && onNowPlaying) || hasDocPip || hasVideoPip) {
            const bassEnergy = computeLiveVisualizerBins(nowSec);

            if (visualizerEnabled && onNowPlaying) {
                if (npVisualizerCanvas && visualizerStyle !== 'glow') {
                    const ctx = npVisualizerCanvas.getContext('2d');
                    const isDark = document.body.classList.contains('dark-mode');
                    const strokeColor = isDark ? '#f4f4f5' : '#18181b';
                    drawVisualizerBarsOnContext(ctx, npVisualizerCanvas.width, npVisualizerCanvas.height, visualizerStyle, strokeColor);
                }
                if (npArtBox) {
                    if (isPlaying) {
                        const c = currentCoverColor || { r: 250, g: 204, b: 21 };
                        const glowAlpha = (0.18 + bassEnergy * 0.42).toFixed(2);
                        const spread = Math.round(28 + bassEnergy * 38);
                        npArtBox.style.boxShadow = `0 20px ${spread}px rgba(${c.r}, ${c.g}, ${c.b}, ${glowAlpha})`;
                    } else {
                        npArtBox.style.boxShadow = '';
                    }
                }
            }

            if (hasDocPip) {
                updateDocumentPipDOM();
            }
            if (hasVideoPip) {
                renderFallbackVideoPipCanvas();
            }
        }
        requestAnimationFrame(runVisualizerAndPipFrame);
    }
    requestAnimationFrame(runVisualizerAndPipFrame);
    window.handleYolkDeepLink = async function (rawHash) {
        if (!rawHash) return;
        if (rawHash.startsWith('album=')) {
            const albumId = decodeURIComponent(rawHash.replace('album=', '').split('&')[0]);
            if (albumId) {
                loadAlbumView(albumId);
            }
            return;
        }
        if (rawHash.startsWith('song=')) {
            const params = new URLSearchParams(rawHash);
            const songId = params.get('song') || '';
            const title = params.get('t') || 'Shared Song';
            const artist = params.get('a') || 'Artist';
            window.location.hash = '#now-playing';
            if (songId) {
                const trackObj = {
                    id: `ytm-${songId}`,
                    youtube_id: songId,
                    videoId: songId,
                    title,
                    artist_name: artist,
                    artwork_url: `https://i.ytimg.com/vi/${songId}/hqdefault.jpg`
                };
                currentQueue = [trackObj];
                currentQueueIndex = 0;
                playTrack(trackObj);
            }
        }
    };

    // Check if opened directly via a shared #song= or #album= deep link
    const initialRawHash = window.location.hash.replace('#', '');
    if (initialRawHash.startsWith('song=') || initialRawHash.startsWith('album=')) {
        setTimeout(() => window.handleYolkDeepLink(initialRawHash), 150);
    }

    // Initialize saved theme mode on startup
    applyThemeMode(localStorage.getItem('yolk_theme_mode') === 'dark' ? 'dark' : 'light', false);

    // Initial render of library and controls
    renderLibrary();
    updateLibraryButtons();
    updateNowPlayingNavVisibility(!!currentTrack);

    // Automatically ensure all tracks in Library (Favorites + Playlists) are downloaded offline
    setTimeout(() => {
        const allLibTracks = [...favorites];
        playlists.forEach(pl => {
            if (Array.isArray(pl.tracks)) {
                allLibTracks.push(...pl.tracks);
            }
        });
        if (allLibTracks.length > 0) {
            enqueueLibraryDownload(allLibTracks);
        }
    }, 1800);
});
