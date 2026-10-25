// yolk-app.js - Modern minimalist music player with YouTube Music, playlist management, and synced lyrics

const API_BASE = '/api/music-api';

// State Management
let favorites = JSON.parse(localStorage.getItem('yolk_favorites') || '[]');
let playlists = JSON.parse(localStorage.getItem('yolk_playlists') || '[]');
let currentAudio = new Audio();
let isPlaying = false;
let currentTrack = null;
let currentQueue = [];
let currentQueueIndex = -1;
let currentPlaylistContextId = null; // null if from search, 'favorites', or playlist ID

let searchOffset = 0;
let isLoadingMore = false;
let currentSearchQuery = '';
let parsedLyrics = [];
let currentLyricsTrackId = null;
let trackToAddPending = null;
let playlistToEditPending = null;

// Inject custom styles
const dynamicStyle = document.createElement('style');
dynamicStyle.innerHTML = `
    .bubbly-hover {
        transition: transform 0.25s cubic-bezier(0.175, 0.885, 0.32, 1.275) !important;
    }
    .bubbly-hover:hover {
        transform: scale(1.03) !important;
    }
    .bubbly-hover:active {
        transform: scale(0.97) !important;
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
        return `${API_BASE}?endpoint=stream&id=${encodeURIComponent(rawYtId)}`;
    }
    if (item.downloadUrl && Array.isArray(item.downloadUrl) && item.downloadUrl.length > 0) {
        const b = item.downloadUrl.find(d => d.quality === '320kbps') || item.downloadUrl[0];
        const link = b.link || b.url;
        if (link) return link;
    }
    return '';
}

// YouTube search fallback
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

// Synced lyrics highlight & smooth scroll
function updateLyricsSync(currentTime) {
    const container = document.getElementById('lyrics-container');
    if (!container || !parsedLyrics || parsedLyrics.length === 0) return;

    let adjustedTime = currentTime + 0.3;
    let activeIndex = -1;

    for (let i = 0; i < parsedLyrics.length; i++) {
        const item = parsedLyrics[i];
        if (item.type === 'line' && item.time !== null && adjustedTime >= item.time && adjustedTime < (item.endTime || Infinity)) {
            activeIndex = i;
            break;
        }
    }

    const lineElements = container.querySelectorAll('.lyric-line');
    let activeLineEl = null;

    lineElements.forEach((el) => {
        const idx = parseInt(el.dataset.index);
        if (idx === activeIndex) {
            activeLineEl = el;
            el.classList.add('active');
        } else {
            el.classList.remove('active');
        }
    });

    if (activeLineEl && container._lastActiveIndex !== activeIndex) {
        container._lastActiveIndex = activeIndex;
        const targetScrollTop = activeLineEl.offsetTop - (container.clientHeight / 2) + (activeLineEl.offsetHeight / 2);
        container.scrollTo({
            top: Math.max(0, targetScrollTop),
            behavior: 'smooth'
        });
    }
}

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

// Storage Helpers
function savePlaylists() {
    localStorage.setItem('yolk_playlists', JSON.stringify(playlists));
}

function saveFavorites() {
    localStorage.setItem('yolk_favorites', JSON.stringify(favorites));
}

function isFavorite(id) {
    return favorites.some(f => f.id === id);
}

function showToast(msg) {
    const toast = document.createElement('div');
    toast.textContent = msg;
    toast.style.cssText = 'position:fixed;bottom:90px;left:50%;transform:translateX(-50%);background:#18181b;color:#f4f4f5;padding:8px 18px;border-radius:999px;font-size:12px;z-index:9999;pointer-events:none;opacity:1;transition:opacity 0.5s ease;box-shadow:0 10px 25px rgba(0,0,0,0.2)';
    document.body.appendChild(toast);
    setTimeout(() => {
        toast.style.opacity = '0';
        setTimeout(() => toast.remove(), 500);
    }, 2800);
}

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

    const bpPlayPauseBtn = document.getElementById('bottom-player-play-pause');
    const bpPrevBtn = document.getElementById('bottom-player-prev');
    const bpNextBtn = document.getElementById('bottom-player-next');
    const bpFavBtn = document.getElementById('bottom-player-fav-btn');
    const bpAddBtn = document.getElementById('bottom-player-add-btn');
    const bpProgressBar = document.getElementById('bottom-player-progress-bar');
    const bpProgressFill = document.getElementById('bottom-player-progress-fill');
    const bpCurrentTime = document.getElementById('bottom-player-current-time');
    const bpDuration = document.getElementById('bottom-player-duration');

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

    // Search Logic (Exact Matching & YouTube Music Only)
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
                }, 350);
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
            searchResults.innerHTML = '<div class="text-[11px] font-semibold text-zinc-400 uppercase tracking-widest text-left w-full mb-1 pl-5">Searching YouTube Music…</div>';
        }
        
        try {
            const res = await fetch(`${API_BASE}?endpoint=search&q=${encodeURIComponent(query)}&limit=25&offset=${searchOffset}`);
            const data = await res.json();
            
            if (clear) {
                searchResults.innerHTML = '<div class="text-[11px] font-semibold text-zinc-400 uppercase tracking-widest text-left w-full mb-1 pl-5">Top Results</div>';
            }
            
            if (data && Array.isArray(data.tracks) && data.tracks.length > 0) {
                const searchList = data.tracks;
                searchList.forEach((track, idx) => {
                    const el = createTrackElement(track, () => {
                        currentQueue = searchList;
                        currentQueueIndex = idx;
                        currentPlaylistContextId = null;
                        playTrack(track);
                    });
                    searchResults.appendChild(el);
                });
            } else if (clear) {
                searchResults.innerHTML = '<div class="text-xs text-zinc-400 pl-5">No YouTube Music tracks found.</div>';
            }
        } catch (e) {
            console.error('Search error:', e);
            if (clear) searchResults.innerHTML = '<div class="text-xs text-red-400 pl-5">Failed to load results.</div>';
        } finally {
            isLoadingMore = false;
        }
    }

    // Creates track list item with Play, Add to Playlist, and Favorite buttons
    function createTrackElement(track, onPlayClick, onRemoveClick = null) {
        const div = document.createElement('div');
        div.className = 'group flex items-center justify-between p-2 sm:p-2.5 rounded-xl bg-white/90 backdrop-blur-sm border border-zinc-200/70 hover:border-zinc-300 hover:shadow-sm transition-all cursor-pointer bubbly-hover mb-1.5';
        
        const artwork = getProxyUrl(track.artwork_url || track.image, '50x50');
        const title = track.title || track.name || 'Unknown Title';
        const artist = track.artist_name || track.artist || 'Unknown Artist';
        const durStr = track.duration ? formatTime(track.duration > 1000 ? track.duration / 1000 : track.duration) : '';

        div.innerHTML = `
            <div class="flex items-center gap-3 min-w-0 flex-1 mr-2">
                <div class="w-10 h-10 bg-zinc-100 rounded-lg overflow-hidden flex-shrink-0 relative border border-zinc-200/50 flex items-center justify-center">
                    ${artwork ? `<img src="${artwork}" alt="${escapeHtml(title)}" class="w-full h-full object-cover" referrerpolicy="no-referrer" onerror="this.style.display='none'">` : ''}
                    <div class="absolute inset-0 bg-black/20 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity backdrop-blur-[1px]">
                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="white" stroke="white" stroke-width="1" class="ml-0.5"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
                    </div>
                </div>
                <div class="flex flex-col text-left min-w-0">
                    <span class="font-semibold text-zinc-900 text-xs sm:text-sm truncate">${escapeHtml(title)}</span>
                    <span class="text-[11px] text-zinc-500 truncate">${escapeHtml(artist)}</span>
                </div>
            </div>
            <div class="flex items-center gap-1 shrink-0">
                ${durStr ? `<span class="text-[11px] text-zinc-400 font-medium mr-1.5 hidden sm:inline">${durStr}</span>` : ''}
                <button class="add-to-pl-btn text-zinc-400 hover:text-zinc-800 transition-colors p-1.5 rounded-full hover:bg-zinc-100" title="Add to Playlist">
                    <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"></path></svg>
                </button>
                <button class="favorite-btn text-zinc-400 hover:text-yolk-yellow transition-colors p-1.5 rounded-full hover:bg-zinc-100" title="Favorite">
                    <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="${isFavorite(track.id) ? '#FDE047' : 'none'}" stroke="${isFavorite(track.id) ? '#FDE047' : 'currentColor'}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg>
                </button>
                ${onRemoveClick ? `
                <button class="remove-btn text-zinc-400 hover:text-red-500 transition-colors p-1.5 rounded-full hover:bg-red-50" title="Remove from playlist">
                    <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                </button>
                ` : ''}
            </div>
        `;

        div.addEventListener('click', (e) => {
            if (!e.target.closest('button')) {
                if (onPlayClick) onPlayClick();
            }
        });

        const favBtn = div.querySelector('.favorite-btn');
        favBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleFavorite(track, favBtn.querySelector('svg'));
        });

        const addPlBtn = div.querySelector('.add-to-pl-btn');
        addPlBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            openAddToPlaylistModal(track);
        });

        if (onRemoveClick) {
            const removeBtn = div.querySelector('.remove-btn');
            removeBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                onRemoveClick();
            });
        }

        return div;
    }

    // Playback Execution
    async function playTrack(track) {
        if (!track) return;
        currentTrack = track;
        showSpinner(true);
        currentAudio._recovering = false;

        // Immediately update titles, covers, and fav status
        updateNowPlayingUI(track);
        updateBottomPlayerUI(track);
        updateNowPlayingFavButton();

        // System Media Session Integration
        if ('mediaSession' in navigator) {
            navigator.mediaSession.metadata = new MediaMetadata({
                title: track.title || track.name || 'Unknown Title',
                artist: track.artist_name || track.artist || 'Unknown Artist',
                artwork: [{ src: getProxyUrl(track.artwork_url || track.image), sizes: '512x512', type: 'image/jpeg' }]
            });
            try {
                navigator.mediaSession.setActionHandler('play', () => {
                    if (currentAudio.paused) togglePlayPause();
                });
                navigator.mediaSession.setActionHandler('pause', () => {
                    if (!currentAudio.paused) togglePlayPause();
                });
                navigator.mediaSession.setActionHandler('nexttrack', () => playNext());
                navigator.mediaSession.setActionHandler('previoustrack', () => playPrev());
            } catch (err) {}
        }

        // Fetch lyrics
        fetchLyrics(track);

        let streamUrl = getDownloadUrl(track);

        if (!streamUrl) {
            const videoId = await getYoutubeId(track);
            if (videoId) {
                streamUrl = `${API_BASE}?endpoint=stream&id=${encodeURIComponent(videoId)}`;
            }
        }

        if (!streamUrl) {
            showSpinner(false);
            showToast('Unable to resolve stream for this track.');
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
                if (err.name === 'AbortError') {
                    // Playback was intentionally interrupted by pause
                    showSpinner(false);
                    return;
                }
                console.warn('Audio play error, attempting fallback…', err.message);
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
                            }).catch((fbErr) => {
                                if (fbErr && fbErr.name === 'AbortError') return;
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

    // Audio Event Handlers
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
        if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
        if (document.body.getAttribute('data-page') !== 'now-playing') {
            bottomPlayer.classList.remove('hidden-force');
        }
    });
    currentAudio.addEventListener('pause', () => {
        isPlaying = false;
        updatePlayPauseButtons();
        if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
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
        showToast('Playback error: Stream unavailable.');
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

    // Playback Navigation (Next, Prev, Play/Pause)
    function togglePlayPause() {
        if (!currentTrack) {
            if (currentQueue.length > 0) {
                currentQueueIndex = 0;
                playTrack(currentQueue[0]);
            }
            return;
        }

        if (!currentAudio.src) {
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

    function playNext() {
        if (!currentQueue || currentQueue.length === 0) return;
        currentQueueIndex = (currentQueueIndex + 1) % currentQueue.length;
        playTrack(currentQueue[currentQueueIndex]);
    }

    function playPrev() {
        if (!currentQueue || currentQueue.length === 0) return;
        if (currentAudio.currentTime > 3) {
            currentAudio.currentTime = 0;
            return;
        }
        currentQueueIndex = (currentQueueIndex - 1 + currentQueue.length) % currentQueue.length;
        playTrack(currentQueue[currentQueueIndex]);
    }

    if (npPlayPauseBtn) {
        npPlayPauseBtn.onclick = (e) => {
            if (e && e.currentTarget && typeof e.currentTarget.blur === 'function') e.currentTarget.blur();
            togglePlayPause();
        };
    }
    if (bpPlayPauseBtn) {
        bpPlayPauseBtn.onclick = (e) => {
            if (e && e.currentTarget && typeof e.currentTarget.blur === 'function') e.currentTarget.blur();
            togglePlayPause();
        };
    }
    if (npNextBtn) {
        npNextBtn.onclick = (e) => {
            if (e && e.currentTarget && typeof e.currentTarget.blur === 'function') e.currentTarget.blur();
            playNext();
        };
    }
    if (bpNextBtn) {
        bpNextBtn.onclick = (e) => {
            if (e && e.currentTarget && typeof e.currentTarget.blur === 'function') e.currentTarget.blur();
            playNext();
        };
    }
    if (npPrevBtn) {
        npPrevBtn.onclick = (e) => {
            if (e && e.currentTarget && typeof e.currentTarget.blur === 'function') e.currentTarget.blur();
            playPrev();
        };
    }
    if (bpPrevBtn) {
        bpPrevBtn.onclick = (e) => {
            if (e && e.currentTarget && typeof e.currentTarget.blur === 'function') e.currentTarget.blur();
            playPrev();
        };
    }

    // Keyboard Shortcuts (Spacebar to toggle Play/Pause)
    document.addEventListener('keydown', (e) => {
        if (e.code === 'Space' || e.key === ' ' || e.keyCode === 32) {
            const active = document.activeElement;
            const isInput = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable);
            if (!isInput) {
                e.preventDefault();
                if (e.repeat) return;
                if (active && typeof active.blur === 'function') {
                    active.blur();
                }
                togglePlayPause();
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
    }

    function updateNowPlayingFavButton() {
        if (!npFavBtn || !currentTrack) return;
        const fav = isFavorite(currentTrack.id);
        const svg = npFavBtn.querySelector('svg');
        if (svg) {
            svg.setAttribute('fill', fav ? '#FDE047' : 'none');
            svg.setAttribute('stroke', fav ? '#FDE047' : 'currentColor');
        }
    }

    function updateBottomPlayerFavButton() {
        if (!bpFavBtn || !currentTrack) return;
        const fav = isFavorite(currentTrack.id);
        const svg = bpFavBtn.querySelector('svg');
        if (svg) {
            svg.setAttribute('fill', fav ? '#FDE047' : 'none');
            svg.setAttribute('stroke', fav ? '#FDE047' : 'currentColor');
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

        const coverUrl = getProxyUrl(track.artwork_url || track.image);
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
                    <div class="lyric-line dots-line flex items-center justify-center cursor-pointer my-2" data-index="${idx}" onclick="seekToLyrics(${item.time})">
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

        if (currentAudio.currentTime > 0) {
            updateLyricsSync(currentAudio.currentTime);
        }
    }

    function renderNoLyricsFound(trackUid) {
        const container = document.getElementById('lyrics-container');
        if (!container || currentLyricsTrackId !== trackUid) return;
        parsedLyrics = [];

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
                svgElement.setAttribute('fill', '#FDE047');
                svgElement.setAttribute('stroke', '#FDE047');
            }
            showToast('Saved to Favorites');
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

    function renderLibrary() {
        if (!libraryGrid) return;
        libraryGrid.innerHTML = '';

        // 1. Favorites Card
        const favCard = document.createElement('div');
        favCard.className = 'group cursor-pointer bubbly-hover text-left';
        favCard.innerHTML = `
            <div class="w-full aspect-square bg-gradient-to-br from-yolk-yellow to-yellow-200 rounded-2xl border border-zinc-200/60 mb-2 relative overflow-hidden flex items-center justify-center shadow-sm group-hover:shadow-md transition-all">
                <svg xmlns="http://www.w3.org/2000/svg" width="30" height="30" viewBox="0 0 24 24" fill="white" stroke="white" stroke-width="1.5"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg>
            </div>
            <h3 class="font-semibold text-xs sm:text-sm text-zinc-900 truncate">Favorites</h3>
            <p class="text-[11px] text-zinc-500 mt-0.5">${favorites.length} ${favorites.length === 1 ? 'song' : 'songs'}</p>
        `;
        favCard.addEventListener('click', () => {
            openPlaylistDetail('favorites');
        });
        libraryGrid.appendChild(favCard);

        // 2. Custom Playlists Cards
        playlists.forEach((pl) => {
            const plCard = document.createElement('div');
            plCard.className = 'group cursor-pointer bubbly-hover text-left';
            const firstArt = pl.tracks && pl.tracks[0] ? getProxyUrl(pl.tracks[0].artwork_url || pl.tracks[0].image, '150x150') : '';

            plCard.innerHTML = `
                <div class="w-full aspect-square bg-zinc-100 rounded-2xl border border-zinc-200/60 mb-2 relative overflow-hidden flex items-center justify-center shadow-sm group-hover:shadow-md transition-all">
                    ${firstArt ? `<img src="${firstArt}" class="w-full h-full object-cover" referrerpolicy="no-referrer">` : `
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
    function openPlaylistDetail(playlistId) {
        currentPlaylistContextId = playlistId;

        const detailArtImg = document.getElementById('playlist-detail-img');
        const detailArtIcon = document.getElementById('playlist-detail-icon');
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

            detailArtImg.classList.add('hidden');
            detailArtIcon.classList.remove('hidden');
            detailArtIcon.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="white" stroke="white" stroke-width="1.5"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg>`;
            editBtn.classList.add('hidden');
            deleteBtn.classList.add('hidden');
        } else {
            const pl = playlists.find(p => p.id === playlistId);
            if (!pl) return;
            playlistName = pl.name;
            playlistDesc = pl.description || 'Custom Playlist';
            trackList = pl.tracks || [];

            const firstArt = trackList[0] ? getProxyUrl(trackList[0].artwork_url || trackList[0].image, '150x150') : '';
            if (firstArt) {
                detailArtImg.src = firstArt;
                detailArtImg.classList.remove('hidden');
                detailArtIcon.classList.add('hidden');
            } else {
                detailArtImg.classList.add('hidden');
                detailArtIcon.classList.remove('hidden');
                detailArtIcon.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg>`;
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

        detailName.textContent = playlistName;
        detailDesc.textContent = playlistDesc;
        detailMeta.textContent = `${trackList.length} ${trackList.length === 1 ? 'song' : 'songs'}`;

        playAllBtn.onclick = () => {
            if (trackList.length > 0) {
                currentQueue = [...trackList];
                currentQueueIndex = 0;
                playTrack(currentQueue[0]);
            } else {
                showToast('Playlist is empty. Add some tracks first!');
            }
        };

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
                        currentQueue = [...trackList];
                        currentQueueIndex = idx;
                        playTrack(track);
                    },
                    () => {
                        if (isFav) {
                            toggleFavorite(track, null);
                        } else {
                            removeTrackFromPlaylist(playlistId, getTrackUid(track));
                        }
                    }
                );
                trackListContainer.appendChild(el);
            });
        }

        libraryOverview.classList.add('hidden');
        playlistDetailView.classList.remove('hidden');
    }

    function closePlaylistDetail() {
        currentPlaylistContextId = null;
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

    // Modal: Create & Edit Playlist
    function openCreatePlaylistModal() {
        playlistToEditPending = null;
        playlistModalTitle.textContent = 'New Playlist';
        playlistNameInput.value = '';
        playlistDescInput.value = '';
        playlistModal.classList.add('active');
        setTimeout(() => playlistNameInput.focus(), 50);
    }

    function openEditPlaylistModal(pl) {
        playlistToEditPending = pl;
        playlistModalTitle.textContent = 'Edit Playlist';
        playlistNameInput.value = pl.name || '';
        playlistDescInput.value = pl.description || '';
        playlistModal.classList.add('active');
        setTimeout(() => playlistNameInput.focus(), 50);
    }

    function closePlaylistModal() {
        playlistModal.classList.remove('active');
        playlistToEditPending = null;
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
                playlistToEditPending.name = name;
                playlistToEditPending.description = desc;
                savePlaylists();
                showToast('Playlist updated');
                closePlaylistModal();
                openPlaylistDetail(playlistToEditPending.id);
            } else {
                const newPlaylist = {
                    id: 'pl_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
                    name: name,
                    description: desc,
                    createdAt: new Date().toISOString(),
                    tracks: []
                };
                playlists.push(newPlaylist);
                savePlaylists();
                showToast(`Created playlist "${name}"`);
                closePlaylistModal();
                renderLibrary();
                openPlaylistDetail(newPlaylist.id);
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
                        <div class="w-8 h-8 rounded-lg bg-zinc-100 flex items-center justify-center shrink-0 text-zinc-500">
                            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg>
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
        if (!playlistDetailView.classList.contains('hidden') && currentPlaylistContextId === playlistId) {
            openPlaylistDetail(playlistId);
        } else {
            renderLibrary();
        }
    }

    // Close modals on clicking backdrop
    [playlistModal, addToPlaylistModal].forEach(modal => {
        if (!modal) return;
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                modal.classList.remove('active');
            }
        });
    });

    // Initial render of library
    renderLibrary();
});
