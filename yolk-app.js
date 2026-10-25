// yolk-app.js - Modern minimalist music player integrated with pinpoint-edu streaming & synced lyrics

const API_BASE = '/api/music-api';
let favorites = JSON.parse(localStorage.getItem('yolk_favorites') || '[]');
let pins = JSON.parse(localStorage.getItem('yolk_pins') || '[]');
let currentAudio = new Audio();
let isPlaying = false;
let currentTrack = null;
let playlist = [];
let currentIndex = -1;
let searchOffset = 0;
let isLoadingMore = false;
let currentSearchQuery = '';
let parsedLyrics = [];
let currentLyricsTrackId = null;

// Inject dynamic styles
const style = document.createElement('style');
style.innerHTML = `
    .bubbly-hover {
        transition: transform 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275) !important;
    }
    .bubbly-hover:hover {
        transform: scale(1.03) !important;
    }
    
    #loading-spinner-container {
        position: fixed;
        bottom: 24px;
        left: 50%;
        transform: translateX(-50%);
        z-index: 50;
        opacity: 0;
        pointer-events: none;
        transition: opacity 0.4s ease;
    }
    #loading-spinner-container.active {
        opacity: 1;
    }
    .parabola-spin {
        width: 38px;
        height: 38px;
        border: 3px solid rgba(0, 0, 0, 0.08);
        border-top-color: #FDE047;
        border-right-color: #FDE047;
        border-radius: 50%;
        animation: spin-parabola 1.2s cubic-bezier(0.16, 1, 0.3, 1) infinite;
    }
    
    @keyframes spin-parabola {
        0% { transform: rotate(0deg); }
        100% { transform: rotate(360deg); }
    }
    
    .hidden-force {
        opacity: 0 !important;
        pointer-events: none !important;
        transform: translate(-50%, 150%) !important;
    }
`;
document.head.appendChild(style);

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

function getTrackUid(track) {
    if (!track) return '';
    return track.youtube_id || track.videoId || track.id || `${track.title || track.name}_${track.artist_name || track.artist}`;
}

// Image URL optimization & proxying from pinpoint-edu
function getProxyUrl(url, size = null) {
    if (!url || typeof url !== 'string') return url;
    if (url.startsWith('data:')) return url;

    if (url.includes('saavncdn.com')) {
        if (size) {
            url = url.replace(/_([0-9]+x[0-9]+|150|500)\.jpg/i, `_${size}.jpg`);
        } else {
            url = url.replace(/_([0-9]+x[0-9]+|150|500)\.jpg/i, `_500x500.jpg`);
        }
    }

    if (url.includes('googleusercontent.com') || url.includes('ggpht.com')) {
        const targetSize = (size === '50x50') ? 's50' : 'w1000-h1000-l90-rj';
        if (url.includes('=')) {
            url = url.split('=')[0] + '=' + targetSize;
        } else {
            url += '=' + targetSize;
        }
    }

    if (url.includes('i.ytimg.com')) {
        url = url.replace(/\/(default|mqdefault|hqdefault|sddefault|maxresdefault)\.jpg/gi, '/0.jpg');
    }

    if (url.startsWith('//')) url = 'https:' + url;
    return url;
}

// Download URL resolution based on pinpoint-edu logic
function getDownloadUrl(item) {
    if (!item) return '';
    if (item.source === 'MusicAPI' && item.downloadUrl?.[0]?.link) {
        let link = item.downloadUrl[0].link;
        if (link.startsWith('/api/gateway')) link = link.replace('/api/gateway', '/api/proxy');
        return link;
    }
    const rawYtId = item.youtube_id || item.videoId || (item.id && typeof item.id === 'string' && item.id.startsWith('ytm-') && !item.id.startsWith('ytm-gen-') ? item.id.replace('ytm-', '') : null);
    if (rawYtId && rawYtId.length === 11) {
        return `${API_BASE}?endpoint=stream&id=${encodeURIComponent(rawYtId)}`;
    }
    let url = '';
    if (item.downloadUrl && Array.isArray(item.downloadUrl) && item.downloadUrl.length > 0) {
        const b = item.downloadUrl.find(d => d.quality === '96kbps') || 
                  item.downloadUrl.find(d => d.quality === '160kbps') || 
                  item.downloadUrl.find(d => d.quality === '320kbps') || 
                  item.downloadUrl[item.downloadUrl.length - 1];
        url = b.link || b.url;
    }

    if (!url && item.media_url) url = item.media_url;
    if (url) {
        if (url.startsWith('/api/')) return url;
        return `/api/proxy?url=${encodeURIComponent(url)}`;
    }
    return '';
}

// YouTube search fallback from pinpoint-edu
const pendingSearches = new Map();
async function getYoutubeId(track) {
    if (!track) return null;
    if (track.youtube_id || track.videoId) return track.youtube_id || track.videoId;
    if (track.id && typeof track.id === 'string' && track.id.startsWith('ytm-') && !track.id.startsWith('ytm-gen-')) {
        const rawId = track.id.replace('ytm-', '');
        track.youtube_id = rawId;
        track.videoId = rawId;
        return rawId;
    }

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
            console.error('Yolk: YouTube search fallback failed', e);
        } finally {
            pendingSearches.delete(uid);
        }
        return null;
    })();

    pendingSearches.set(uid, promise);
    return promise;
}

// Robust LRC Lyrics Parser from pinpoint-edu
function parseLyrics(lyricsText, duration) {
    if (!lyricsText || typeof lyricsText !== 'string') return [];
    const lines = lyricsText.split('\n');
    const parsed = [];
    const timeRegex = /\[(\d+):(\d+)(?:\.(\d+))?\]/;
    const wordTimeRegex = /<(\d+):(\d+)(?:\.(\d+))?>/g;
    
    let hasTimestamps = false;
    for (let line of lines) {
        line = line.trim();
        if (!line) continue;
        const match = timeRegex.exec(line);
        if (match) {
            hasTimestamps = true;
            const minutes = parseInt(match[1]);
            const seconds = parseInt(match[2]);
            const ms = match[3] ? parseFloat('0.' + match[3]) : 0;
            const time = minutes * 60 + seconds + ms;
            
            let text = line.replace(timeRegex, '').trim();
            const words = [];
            let lastIdx = 0;
            let wordMatch;
            while ((wordMatch = wordTimeRegex.exec(text)) !== null) {
                const wordText = text.substring(lastIdx, wordMatch.index).trim();
                if (wordText) {
                    const wMin = parseInt(wordMatch[1]);
                    const wSec = parseInt(wordMatch[2]);
                    const wMs = wordMatch[3] ? parseFloat('0.' + wordMatch[3]) : 0;
                    words.push({ text: wordText, time: wMin * 60 + wSec + wMs });
                }
                lastIdx = wordTimeRegex.lastIndex;
            }
            const remainingText = text.substring(lastIdx).trim();
            if (remainingText) words.push({ text: remainingText, time: time + 5 }); 

            const cleanText = text.replace(wordTimeRegex, ' ').replace(/\s+/g, ' ').trim();
            parsed.push({ time, text: cleanText, words: words.length > 0 ? words : null, type: 'line' });
        } else {
            parsed.push({ time: null, text: line, words: null, type: 'line' });
        }
    }

    let validTimestampsCount = 0;
    parsed.forEach(p => {
        if (p.time !== null && !isNaN(p.time) && p.time >= 0) validTimestampsCount++;
    });

    let isChronological = true;
    let lastValidTime = -1;
    for (const p of parsed) {
        if (p.time !== null && !isNaN(p.time)) {
            if (p.time < lastValidTime) {
                isChronological = false;
                break;
            }
            lastValidTime = p.time;
        }
    }

    const isValidTimed = hasTimestamps && isChronological && (validTimestampsCount >= Math.max(1, parsed.length * 0.4));

    if (!isValidTimed) {
        return parsed.map(p => ({
            time: null,
            endTime: null,
            text: p.text,
            words: null,
            type: 'line'
        }));
    }

    const finalParsed = [];
    if (parsed.length > 0 && parsed[0].time !== null && parsed[0].time >= 3.0) {
        finalParsed.push({ 
            time: 0, 
            endTime: parsed[0].time,
            type: 'dots', 
            text: '...' 
        });
    }

    for (let i = 0; i < parsed.length; i++) {
        const current = parsed[i];
        const next = parsed[i+1];
        
        if (next && next.time !== null) {
            current.endTime = next.time;
        } else if (duration) {
            current.endTime = duration;
        } else if (current.time !== null) {
            current.endTime = current.time + 5;
        }

        finalParsed.push(current);

        if (current.time !== null && next && next.time !== null) {
            const rawGap = next.time - current.time;
            const approxLineDuration = current.words ? Math.max(2.5, current.words.length * 0.4) : 3.0;
            const interludeStart = current.time + approxLineDuration;
            const interludeDuration = next.time - interludeStart;

            if (rawGap >= 6.0 && interludeDuration >= 2.0) {
                finalParsed.push({ 
                    time: interludeStart, 
                    endTime: next.time,
                    type: 'dots', 
                    text: '...' 
                });
            }
        }
    }
    return finalParsed;
}

// Synced lyrics highlight & smooth scroll
function updateLyricsSync(currentTime) {
    const container = document.getElementById('lyrics-container');
    if (!container || !parsedLyrics || parsedLyrics.length === 0) return;

    let adjustedTime = currentTime + 0.35;
    let activeIndex = -1;
    for (let i = 0; i < parsedLyrics.length; i++) {
        if (parsedLyrics[i].time !== null && adjustedTime >= parsedLyrics[i].time && adjustedTime < (parsedLyrics[i].endTime || Infinity)) {
            activeIndex = i;
            break;
        }
    }

    const lines = container.querySelectorAll('.lyric-line');
    let activeLineEl = null;
    lines.forEach((line, index) => {
        if (index === activeIndex) {
            activeLineEl = line;
            line.classList.add('active');
            const dots = line.querySelector('.lyric-dots');
            if (dots) {
                const dotEls = dots.querySelectorAll('.lyric-dot');
                const currentLine = parsedLyrics[index];
                const startTime = currentLine.time;
                const endTime = currentLine.endTime || (startTime + 3);
                const lineDuration = Math.max(0.1, endTime - startTime);
                const dotProgress = Math.min(1, Math.max(0, (adjustedTime - startTime) / lineDuration));
                dotEls.forEach((dot, dIdx) => {
                    if (dotProgress >= (dIdx + 1) * 0.3) {
                        dot.classList.add('highlight');
                    } else {
                        dot.classList.remove('highlight');
                    }
                });
            }
        } else {
            line.classList.remove('active');
            const dots = line.querySelector('.lyric-dots');
            if (dots) {
                dots.querySelectorAll('.lyric-dot').forEach(d => d.classList.remove('highlight'));
            }
        }
    });

    if (activeLineEl && container._lastActiveIndex !== activeIndex) {
        container._lastActiveIndex = activeIndex;
        const pageNowPlaying = document.getElementById('page-now-playing');
        if (pageNowPlaying && document.body.getAttribute('data-page') === 'now-playing') {
            const targetScrollTop = activeLineEl.offsetTop - (pageNowPlaying.clientHeight / 2) + (activeLineEl.offsetHeight / 2);
            pageNowPlaying.scrollTo({
                top: Math.max(0, targetScrollTop),
                behavior: 'smooth'
            });
        }
    }
}

// Seek directly to a lyric timestamp
window.seekToLyrics = function(time) {
    if (typeof time === 'number' && !isNaN(time) && currentAudio) {
        currentAudio.currentTime = Math.max(0, time);
        if (!isPlaying) {
            currentAudio.play().then(() => {
                isPlaying = true;
                updatePlayPauseButtons();
            }).catch(() => {});
        }
        updateLyricsSync(time);
    }
};

document.addEventListener('DOMContentLoaded', () => {
    // DOM Elements
    const bottomPlayer = document.getElementById('bottom-player');
    const bottomPlayerInfo = document.getElementById('bottom-player-info');
    const searchInput = document.getElementById('searchInput');
    const searchResults = document.getElementById('searchResults');
    const libraryGrid = document.querySelector('#page-library .grid');

    // Controls
    const npPlayPauseBtn = document.getElementById('now-playing-play-pause');
    const npPrevBtn = document.getElementById('now-playing-prev');
    const npNextBtn = document.getElementById('now-playing-next');
    const npProgressBar = document.getElementById('now-playing-progress-bar');
    const npProgressFill = document.getElementById('now-playing-progress-fill');
    const npCurrentTime = document.getElementById('now-playing-current-time');
    const npDuration = document.getElementById('now-playing-duration');

    const bpPlayPauseBtn = document.getElementById('bottom-player-play-pause');
    const bpPrevBtn = document.getElementById('bottom-player-prev');
    const bpNextBtn = document.getElementById('bottom-player-next');
    const bpProgressBar = document.getElementById('bottom-player-progress-bar');
    const bpProgressFill = document.getElementById('bottom-player-progress-fill');
    const bpCurrentTime = document.getElementById('bottom-player-current-time');
    const bpDuration = document.getElementById('bottom-player-duration');

    // Loading spinner
    const spinnerContainer = document.createElement('div');
    spinnerContainer.id = 'loading-spinner-container';
    const spinner = document.createElement('div');
    spinner.className = 'parabola-spin';
    spinnerContainer.appendChild(spinner);
    document.body.appendChild(spinnerContainer);

    function showSpinner(show) {
        if (show) spinnerContainer.classList.add('active');
        else spinnerContainer.classList.remove('active');
    }

    // Bottom player routing
    if (bottomPlayerInfo) {
        bottomPlayerInfo.addEventListener('click', () => {
            window.location.hash = '#now-playing';
        });
    }

    // Search Logic
    let searchTimeout;
    if (searchInput) {
        searchInput.addEventListener('input', (e) => {
            const val = e.target.value.trim();
            if (val.length > 0) {
                document.body.classList.add('is-searching');
                clearTimeout(searchTimeout);
                searchTimeout = setTimeout(() => {
                    currentSearchQuery = val;
                    searchOffset = 0;
                    performSearch(val, true);
                }, 400);
            } else {
                document.body.classList.remove('is-searching');
                searchResults.innerHTML = '<div class="text-[11px] font-semibold text-zinc-400 uppercase tracking-widest text-left w-full mb-1 pl-5">Top Results</div>';
            }
        });
    }

    // Infinite Scroll
    const pageSearch = document.getElementById('page-search');
    if (pageSearch) {
        pageSearch.addEventListener('scroll', (e) => {
            const el = e.target;
            if (el.scrollHeight - el.scrollTop <= el.clientHeight + 100) {
                if (!isLoadingMore && currentSearchQuery) {
                    searchOffset += 20;
                    performSearch(currentSearchQuery, false);
                }
            }
        });
    }

    async function performSearch(query, clear) {
        isLoadingMore = true;
        if (clear) {
            searchResults.innerHTML = '<div class="text-[11px] font-semibold text-zinc-400 uppercase tracking-widest text-left w-full mb-1 pl-5">Searching…</div>';
        }
        
        try {
            const res = await fetch(`${API_BASE}?endpoint=search&q=${encodeURIComponent(query)}&limit=20&offset=${searchOffset}`);
            const data = await res.json();
            
            if (clear) {
                searchResults.innerHTML = '<div class="text-[11px] font-semibold text-zinc-400 uppercase tracking-widest text-left w-full mb-1 pl-5">Top Results</div>';
            }
            
            if (data && Array.isArray(data.tracks) && data.tracks.length > 0) {
                if (clear) playlist = data.tracks;
                else playlist.push(...data.tracks);

                data.tracks.forEach((track, idx) => {
                    const trackIndex = (clear ? 0 : playlist.length - data.tracks.length) + idx;
                    const el = createTrackElement(track, trackIndex);
                    searchResults.appendChild(el);
                });
            } else if (clear) {
                searchResults.innerHTML = '<div class="text-xs text-zinc-400 pl-5">No tracks found.</div>';
            }
        } catch (e) {
            console.error('Search error:', e);
            if (clear) searchResults.innerHTML = '<div class="text-xs text-red-400 pl-5">Failed to load results.</div>';
        } finally {
            isLoadingMore = false;
        }
    }

    function createTrackElement(track, index) {
        const div = document.createElement('div');
        div.className = 'group flex items-center justify-between p-3 rounded-3xl bg-white/80 backdrop-blur-sm border border-zinc-100 hover:border-zinc-200 hover:shadow-md transition-all cursor-pointer bubbly-hover mb-2';
        
        const artwork = getProxyUrl(track.artwork_url || track.image, '150x150');
        const title = track.name || track.title || 'Unknown Title';
        const artist = track.artist_name || track.artist || 'Unknown Artist';

        div.innerHTML = `
            <div class="flex items-center gap-4 min-w-0 flex-1 mr-2">
                <div class="w-12 h-12 bg-zinc-100 rounded-2xl overflow-hidden flex-shrink-0 relative border border-zinc-200/50 flex items-center justify-center">
                    ${artwork ? `<img src="${artwork}" alt="${escapeHtml(title)}" class="w-full h-full object-cover" referrerpolicy="no-referrer" onerror="this.style.display='none'">` : ''}
                    <div class="absolute inset-0 bg-black/20 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity backdrop-blur-[1px]">
                        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="white" stroke="white" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" class="ml-0.5"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
                    </div>
                </div>
                <div class="flex flex-col text-left min-w-0">
                    <span class="font-medium text-zinc-900 text-sm truncate">${escapeHtml(title)}</span>
                    <span class="text-xs text-zinc-500 truncate">${escapeHtml(artist)}</span>
                </div>
            </div>
            <button class="favorite-btn text-zinc-300 hover:text-yolk-yellow transition-colors p-2 z-10 shrink-0" data-id="${track.id}">
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="${isFavorite(track.id) ? '#FDE047' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg>
            </button>
        `;
        
        div.addEventListener('click', (e) => {
            if (!e.target.closest('.favorite-btn')) {
                currentIndex = index;
                playTrack(track);
            }
        });
        
        const favBtn = div.querySelector('.favorite-btn');
        favBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleFavorite(track, favBtn.querySelector('svg'));
        });
        
        return div;
    }

    // Playback Logic
    async function playTrack(track) {
        if (!track) return;
        currentTrack = track;
        showSpinner(true);
        currentAudio._recovering = false;

        // Immediately update titles and album covers
        updateNowPlayingUI(track);
        updateBottomPlayerUI(track);

        // Fetch lyrics asynchronously
        fetchLyrics(track);

        let streamUrl = getDownloadUrl(track);

        // If no direct downloadUrl, attempt YouTube ID lookup
        if (!streamUrl) {
            const videoId = await getYoutubeId(track);
            if (videoId) {
                streamUrl = `${API_BASE}?endpoint=stream&id=${encodeURIComponent(videoId)}`;
            }
        }

        if (!streamUrl) {
            showSpinner(false);
            showToast('Unable to resolve audio stream for this track.');
            return;
        }

        currentAudio.src = streamUrl;
        currentAudio.load();

        const playPromise = currentAudio.play();
        if (playPromise !== undefined) {
            playPromise.then(() => {
                showSpinner(false);
                isPlaying = true;
                updatePlayPauseButtons();
                if (document.body.getAttribute('data-page') !== 'now-playing') {
                    bottomPlayer.classList.remove('hidden-force');
                }
            }).catch(async (err) => {
                console.warn('Audio play error, attempting fallback…', err.message);
                // Attempt YouTube resolution fallback if not already tried
                if (!currentAudio._recovering) {
                    currentAudio._recovering = true;
                    const videoId = await getYoutubeId(track);
                    if (videoId) {
                        const fallbackUrl = `${API_BASE}?endpoint=stream&id=${encodeURIComponent(videoId)}`;
                        if (currentAudio.src !== fallbackUrl) {
                            currentAudio.src = fallbackUrl;
                            currentAudio.load();
                            currentAudio.play().then(() => {
                                showSpinner(false);
                                isPlaying = true;
                                updatePlayPauseButtons();
                            }).catch(() => {
                                showSpinner(false);
                            });
                            return;
                        }
                    }
                }
                showSpinner(false);
            });
        }
    }

    // Audio Event Listeners
    currentAudio.addEventListener('canplay', () => {
        showSpinner(false);
        if (document.body.getAttribute('data-page') !== 'now-playing') {
            bottomPlayer.classList.remove('hidden-force');
        }
    });

    currentAudio.addEventListener('waiting', () => showSpinner(true));
    currentAudio.addEventListener('playing', () => {
        showSpinner(false);
        isPlaying = true;
        updatePlayPauseButtons();
        if (document.body.getAttribute('data-page') !== 'now-playing') {
            bottomPlayer.classList.remove('hidden-force');
        }
    });
    currentAudio.addEventListener('pause', () => {
        isPlaying = false;
        updatePlayPauseButtons();
    });

    currentAudio.addEventListener('ended', () => {
        playNext();
    });

    currentAudio.addEventListener('error', async () => {
        showSpinner(false);
        if (currentTrack && !currentAudio._recovering) {
            currentAudio._recovering = true;
            const videoId = await getYoutubeId(currentTrack);
            if (videoId) {
                const fallbackUrl = `${API_BASE}?endpoint=stream&id=${encodeURIComponent(videoId)}`;
                if (currentAudio.src !== fallbackUrl) {
                    currentAudio.src = fallbackUrl;
                    currentAudio.load();
                    currentAudio.play().then(() => {
                        isPlaying = true;
                        updatePlayPauseButtons();
                    }).catch(() => {});
                    return;
                }
            }
        }
        showToast('Stream temporarily unavailable.');
    });

    // Time & Progress Update
    currentAudio.addEventListener('timeupdate', () => {
        const cur = currentAudio.currentTime || 0;
        const dur = currentAudio.duration || (currentTrack?.duration ? currentTrack.duration / 1000 : 0);
        const percent = dur > 0 ? (cur / dur) * 100 : 0;

        if (npProgressFill) npProgressFill.style.width = `${percent}%`;
        if (bpProgressFill) bpProgressFill.style.width = `${percent}%`;

        if (npCurrentTime) npCurrentTime.textContent = formatTime(cur);
        if (bpCurrentTime) bpCurrentTime.textContent = formatTime(cur);

        if (npDuration && dur > 0) npDuration.textContent = formatTime(dur);
        if (bpDuration && dur > 0) bpDuration.textContent = formatTime(dur);

        updateLyricsSync(cur);
    });

    // Progress Bar Scrubbing
    function setupScrubbing(barEl) {
        if (!barEl) return;
        barEl.addEventListener('click', (e) => {
            const rect = barEl.getBoundingClientRect();
            const clickPos = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
            const dur = currentAudio.duration || (currentTrack?.duration ? currentTrack.duration / 1000 : 0);
            if (dur > 0) {
                currentAudio.currentTime = clickPos * dur;
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

    // Play/Pause, Next, Previous Controls
    function togglePlayPause() {
        if (!currentTrack) {
            if (playlist.length > 0) {
                currentIndex = 0;
                playTrack(playlist[0]);
            }
            return;
        }

        if (isPlaying) {
            currentAudio.pause();
        } else {
            currentAudio.play().catch(e => console.error('Play failed:', e));
        }
    }

    function playNext() {
        if (!playlist || playlist.length === 0) return;
        currentIndex = (currentIndex + 1) % playlist.length;
        playTrack(playlist[currentIndex]);
    }

    function playPrev() {
        if (!playlist || playlist.length === 0) return;
        if (currentAudio.currentTime > 3) {
            currentAudio.currentTime = 0;
            return;
        }
        currentIndex = (currentIndex - 1 + playlist.length) % playlist.length;
        playTrack(playlist[currentIndex]);
    }

    if (npPlayPauseBtn) npPlayPauseBtn.onclick = togglePlayPause;
    if (bpPlayPauseBtn) bpPlayPauseBtn.onclick = togglePlayPause;
    if (npNextBtn) npNextBtn.onclick = playNext;
    if (bpNextBtn) bpNextBtn.onclick = playNext;
    if (npPrevBtn) npPrevBtn.onclick = playPrev;
    if (bpPrevBtn) bpPrevBtn.onclick = playPrev;

    function updatePlayPauseButtons() {
        const playIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" class="ml-0.5"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>`;
        const pauseIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg>`;
        
        const bpPlayIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" class="ml-0.5"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>`;
        const bpPauseIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg>`;

        if (npPlayPauseBtn) npPlayPauseBtn.innerHTML = isPlaying ? pauseIcon : playIcon;
        if (bpPlayPauseBtn) bpPlayPauseBtn.innerHTML = isPlaying ? bpPauseIcon : bpPlayIcon;
    }

    // Now Playing UI update: Cover, Title, Artist
    function updateNowPlayingUI(track) {
        const titleEl = document.getElementById('now-playing-title');
        const artistEl = document.getElementById('now-playing-artist');
        const imgEl = document.getElementById('now-playing-img');
        const vinylEl = document.getElementById('now-playing-vinyl');

        const trackTitle = track.title || track.name || 'Unknown Title';
        const trackArtist = track.artist_name || track.artist || 'Unknown Artist';

        if (titleEl) titleEl.textContent = trackTitle;
        if (artistEl) artistEl.textContent = trackArtist;

        const coverUrl = getProxyUrl(track.artwork_url || track.image);
        if (coverUrl && imgEl) {
            imgEl.onload = () => {
                imgEl.classList.remove('hidden');
                if (vinylEl) vinylEl.classList.add('hidden');
            };
            imgEl.onerror = () => {
                // If direct loading fails, try proxy endpoint
                if (!imgEl.src.includes('/api/proxy')) {
                    imgEl.src = `/api/proxy?url=${encodeURIComponent(coverUrl)}`;
                } else {
                    imgEl.classList.add('hidden');
                    if (vinylEl) vinylEl.classList.remove('hidden');
                }
            };
            imgEl.src = coverUrl;
        } else if (imgEl) {
            imgEl.classList.add('hidden');
            if (vinylEl) vinylEl.classList.remove('hidden');
        }
    }

    // Bottom Player UI update: Cover, Title, Artist
    function updateBottomPlayerUI(track) {
        const titleEl = document.getElementById('bottom-player-title');
        const artistEl = document.getElementById('bottom-player-artist');
        const imgEl = document.getElementById('bottom-player-img');
        const placeholderEl = document.getElementById('bottom-player-placeholder');

        const trackTitle = track.title || track.name || 'Unknown Title';
        const trackArtist = track.artist_name || track.artist || 'Unknown Artist';

        if (titleEl) titleEl.textContent = trackTitle;
        if (artistEl) artistEl.textContent = trackArtist;

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
        } else if (imgEl) {
            imgEl.classList.add('hidden');
            if (placeholderEl) placeholderEl.classList.remove('hidden');
        }
    }

    // Lyrics Fetching and Rendering
    async function fetchLyrics(track) {
        const container = document.getElementById('lyrics-container');
        if (!container) return;

        const uid = getTrackUid(track);
        currentLyricsTrackId = uid;
        container._lastActiveIndex = -1;
        parsedLyrics = [];

        container.innerHTML = `
            <div class="py-12 flex flex-col items-center gap-3 text-zinc-400">
                <div class="w-6 h-6 border-2 border-zinc-200 border-t-zinc-600 rounded-full animate-spin"></div>
                <span class="text-xs font-medium tracking-wide">Loading lyrics…</span>
            </div>
        `;

        const lyricsId = track.youtube_id || track.videoId || (track.id ? String(track.id).replace('ytm-', '') : '');
        const trackName = track.title || track.name || '';
        const artistName = track.artist_name || track.artist || '';
        const durSec = track.duration ? (track.duration > 1000 ? track.duration / 1000 : track.duration) : 0;

        try {
            const url = `${API_BASE}?endpoint=lyrics&id=${encodeURIComponent(lyricsId)}&title=${encodeURIComponent(trackName)}&artist=${encodeURIComponent(artistName)}&duration=${Math.round(durSec)}`;
            const res = await fetch(url);
            if (currentLyricsTrackId !== uid) return; // Stale request

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

        const html = parsedLyrics.map((line) => {
            if (line.type === 'dots') {
                return `
                    <div class="lyric-line dots-line flex items-center justify-center cursor-pointer" onclick="seekToLyrics(${line.time})">
                        <div class="lyric-dots">
                            <div class="lyric-dot"></div>
                            <div class="lyric-dot"></div>
                            <div class="lyric-dot"></div>
                        </div>
                    </div>
                `;
            }

            const isTimed = (line.time !== null && line.time !== undefined);
            const untimedClass = isTimed ? '' : 'untimed';
            const clickAttr = isTimed ? `onclick="seekToLyrics(${line.time})"` : '';
            return `<div class="lyric-line ${untimedClass}" ${clickAttr}>${escapeHtml(line.text)}</div>`;
        }).join('');

        container.innerHTML = html;
        container._lastActiveIndex = -1;

        // Immediately sync to current playback position
        if (currentAudio.currentTime > 0) {
            updateLyricsSync(currentAudio.currentTime);
        }
    }

    function renderNoLyricsFound(trackUid) {
        const container = document.getElementById('lyrics-container');
        if (!container || currentLyricsTrackId !== trackUid) return;
        parsedLyrics = [];
        container.innerHTML = `
            <div class="py-12 text-center text-zinc-400">
                <span class="text-sm font-medium">No lyrics available for this track</span>
            </div>
        `;
    }

    function showToast(msg) {
        const toast = document.createElement('div');
        toast.textContent = msg;
        toast.style.cssText = 'position:fixed;bottom:90px;left:50%;transform:translateX(-50%);background:#18181b;color:#f4f4f5;padding:8px 18px;border-radius:999px;font-size:12px;z-index:9999;pointer-events:none;opacity:1;transition:opacity 0.6s ease;box-shadow:0 10px 25px rgba(0,0,0,0.2)';
        document.body.appendChild(toast);
        setTimeout(() => {
            toast.style.opacity = '0';
            setTimeout(() => toast.remove(), 600);
        }, 3200);
    }

    // Favorites Logic
    function isFavorite(id) {
        return favorites.some(f => f.id === id);
    }

    function toggleFavorite(track, svgElement) {
        if (isFavorite(track.id)) {
            favorites = favorites.filter(f => f.id !== track.id);
            if (svgElement) {
                svgElement.setAttribute('fill', 'none');
                svgElement.setAttribute('stroke', 'currentColor');
            }
        } else {
            favorites.push(track);
            if (svgElement) {
                svgElement.setAttribute('fill', '#FDE047');
                svgElement.setAttribute('stroke', '#FDE047');
            }
        }
        localStorage.setItem('yolk_favorites', JSON.stringify(favorites));
        renderLibrary();
    }

    // Library Rendering
    function renderLibrary() {
        if (!libraryGrid) return;
        libraryGrid.innerHTML = '';
        
        // Favorites block
        const favEl = document.createElement('div');
        favEl.className = 'group cursor-pointer bubbly-hover';
        favEl.innerHTML = `
            <div class="w-full aspect-square bg-gradient-to-br from-yolk-yellow to-yellow-200 rounded-3xl border border-zinc-200/60 mb-3 relative overflow-hidden flex items-center justify-center shadow-sm group-hover:shadow-md transition-all">
                <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="white" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg>
            </div>
            <h3 class="font-semibold text-sm text-zinc-900">Favorites</h3>
            <p class="text-xs text-zinc-500 mt-1">${favorites.length} tracks</p>
        `;
        favEl.addEventListener('click', () => {
            if (favorites.length > 0) {
                playlist = [...favorites];
                currentIndex = 0;
                playTrack(playlist[0]);
                window.location.hash = '#now-playing';
            } else {
                showToast('No favorites yet. Search and add some!');
            }
        });
        libraryGrid.appendChild(favEl);
        
        // Pinned Playlists
        pins.forEach((pin) => {
            const pinEl = document.createElement('div');
            pinEl.className = 'group cursor-pointer bubbly-hover';
            pinEl.innerHTML = `
                <div class="w-full aspect-square bg-zinc-100 rounded-3xl border border-zinc-200/60 mb-3 relative overflow-hidden flex items-center justify-center shadow-sm group-hover:shadow-md transition-all">
                    <div class="absolute inset-0 bg-black/5 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center backdrop-blur-[1px]">
                        <div class="w-10 h-10 bg-white/90 rounded-full flex items-center justify-center shadow-lg">
                            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" class="ml-1"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
                        </div>
                    </div>
                </div>
                <h3 class="font-semibold text-sm text-zinc-900">${escapeHtml(pin.name)}</h3>
                <p class="text-xs text-zinc-500 mt-1">Pinned Playlist</p>
            `;
            libraryGrid.appendChild(pinEl);
        });
    }
    renderLibrary();
});
