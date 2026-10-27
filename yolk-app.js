// yolk-app.js - Modern minimalist music player with YouTube Music, playlist management, and synced lyrics

const API_BASE = '/api/music-api';

// State Management
let favorites = JSON.parse(localStorage.getItem('yolk_favorites') || '[]');
let playlists = JSON.parse(localStorage.getItem('yolk_playlists') || '[]');
let currentAudio = new Audio();
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

// Synced lyrics highlight & smooth scroll with Pinpoint-Edu 3-dots animation
function updateLyricsSync(currentTime, force = false) {
    // Only process lyrics when on Now Playing page or forced on navigation
    if (!force && document.body.getAttribute('data-page') !== 'now-playing') return;

    const container = document.getElementById('lyrics-container');
    if (!container || !parsedLyrics || parsedLyrics.length === 0) return;

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

    if (activeLineEl) {
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

    const npLyricsToggleBtn = document.getElementById('np-lyrics-toggle-btn');
    const nowPlayingContainer = document.getElementById('now-playing-container');
    let isLyricsAvailable = false;
    let isLyricsUserEnabled = true;

    function updateLyricsVisibilityUI() {
        if (!nowPlayingContainer || !npLyricsToggleBtn) return;

        if (!isLyricsAvailable) {
            nowPlayingContainer.classList.add('no-lyrics');
            nowPlayingContainer.classList.remove('lyrics-hidden');
            npLyricsToggleBtn.disabled = true;
            npLyricsToggleBtn.className = 'flex items-center justify-center w-10 h-10 rounded-full bg-white/40 text-black/20 border border-black/10 shadow-none cursor-not-allowed opacity-40 pointer-events-none transition-all';
            npLyricsToggleBtn.title = 'No lyrics available for this song';
        } else {
            nowPlayingContainer.classList.remove('no-lyrics');
            npLyricsToggleBtn.disabled = false;
            npLyricsToggleBtn.title = 'Toggle Lyrics';

            if (isLyricsUserEnabled) {
                nowPlayingContainer.classList.remove('lyrics-hidden');
                npLyricsToggleBtn.className = 'flex items-center justify-center w-10 h-10 rounded-full bg-black text-white border border-black shadow-lg transition-all hover:scale-105 active:scale-95 cursor-pointer';
            } else {
                nowPlayingContainer.classList.add('lyrics-hidden');
                npLyricsToggleBtn.className = 'flex items-center justify-center w-10 h-10 rounded-full bg-white text-black border border-black/20 shadow-md transition-all hover:scale-105 active:scale-95 cursor-pointer';
            }
        }
    }

    if (npLyricsToggleBtn) {
        npLyricsToggleBtn.onclick = () => {
            if (!isLyricsAvailable) return;
            isLyricsUserEnabled = !isLyricsUserEnabled;
            updateLyricsVisibilityUI();
            if (isLyricsUserEnabled && typeof window.syncLyricsOnNavigate === 'function') {
                window.syncLyricsOnNavigate();
            }
        };
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
        bottomPlayerInfo.addEventListener('click', (e) => {
            if (e.target.closest('#bottom-player-artist')) {
                e.stopPropagation();
                if (currentTrack) {
                    const a = currentTrack.artist_name || currentTrack.artist;
                    if (a && typeof window.loadArtistView === 'function') {
                        window.loadArtistView(a);
                    }
                }
                return;
            }
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

    // Search Logic (Top tracks list removed to prevent animation bugs and reduce lag)
    let searchTimeout;

    if (searchInput) {
        searchInput.addEventListener('focus', () => {
            if (searchInput.value.trim().length > 0) {
                document.body.classList.add('is-searching');
            }
        });

        searchInput.addEventListener('input', (e) => {
            const val = e.target.value.trim();
            if (val.length > 0) {
                document.body.classList.add('is-searching');
                clearTimeout(searchTimeout);
                searchTimeout = setTimeout(() => {
                    currentSearchQuery = val;
                    searchOffset = 0;
                    performSearch(val, true);
                }, 250);
            } else {
                currentSearchQuery = '';
                document.body.classList.remove('is-searching');
                if (searchResults) searchResults.innerHTML = '';
            }
        });

        // Click outside search block when input is empty collapses search state back to center
        document.addEventListener('click', (e) => {
            if (searchInput && !searchInput.value.trim() && !e.target.closest('#search-block')) {
                document.body.classList.remove('is-searching');
            }
        });
    }

    // Infinite Scroll on Search Page
    const pageSearch = document.getElementById('page-search');
    if (pageSearch) {
        pageSearch.addEventListener('scroll', (e) => {
            const el = e.target;
            if (el.scrollHeight - el.scrollTop <= el.clientHeight + 250) {
                if (!isLoadingMore && currentSearchQuery) {
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
                        currentPlayingPlaylistContextId = null;
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
                    <span class="artist-name-link text-[11px] text-zinc-500 hover:text-zinc-950 hover:underline cursor-pointer truncate transition-colors inline-block w-fit" title="View artist">${escapeHtml(artist)}</span>
                </div>
            </div>
            <div class="flex items-center gap-1 shrink-0">
                ${durStr ? `<span class="text-[11px] text-zinc-400 font-medium mr-1.5 hidden sm:inline">${durStr}</span>` : ''}
                <button class="add-to-pl-btn text-zinc-400 hover:text-zinc-800 transition-colors p-1.5 rounded-full hover:bg-zinc-100" title="Add to Playlist">
                    <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"></path></svg>
                </button>
                <button class="favorite-btn text-zinc-900 hover:scale-110 transition-transform p-1.5 rounded-full hover:bg-zinc-100" title="Favorite">
                    <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="${isFavorite(track.id) ? '#18181b' : 'none'}" stroke="#18181b" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg>
                </button>
                ${onRemoveClick ? `
                <button class="remove-btn text-zinc-400 hover:text-red-500 transition-colors p-1.5 rounded-full hover:bg-red-50" title="Remove from playlist">
                    <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                </button>
                ` : ''}
            </div>
        `;

        div.addEventListener('click', (e) => {
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
            showToast('Unable to stream this track.');
            return;
        }
        activeSource = 'youtube';
        try {
            currentAudio.pause();
            currentAudio.src = '';
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
            playsinline: 1
        };
        if (window.location.origin && window.location.origin !== 'null' && !window.location.origin.startsWith('file')) {
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
                            e.target.setVolume(100);
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
                        showToast('Unable to play track');
                    }
                }
            });
        } catch (err) {
            console.warn('YT.Player init error:', err);
            showSpinner(false);
        }
    }

    function loadDirectAudioPlayer(streamUrl) {
        activeSource = 'audio';
        if (ytPlayer && typeof ytPlayer.stopVideo === 'function') {
            try { ytPlayer.stopVideo(); } catch (_) {}
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
            }).catch(() => {
                showSpinner(false);
            });
        }
    }

    // Playback Execution
    async function playTrack(track) {
        if (!track) return;
        currentTrack = track;
        showSpinner(true);
        stopYouTubeProgress();
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
                navigator.mediaSession.setActionHandler('play', () => togglePlayPause());
                navigator.mediaSession.setActionHandler('pause', () => togglePlayPause());
                navigator.mediaSession.setActionHandler('nexttrack', () => playNext());
                navigator.mediaSession.setActionHandler('previoustrack', () => playPrev());
            } catch (err) {}
        }

        // Fetch lyrics
        fetchLyrics(track);

        const videoId = await getYoutubeId(track);
        if (videoId) {
            loadYouTubePlayer(videoId);
            return;
        }

        let streamUrl = getDownloadUrl(track);
        if (streamUrl && !streamUrl.includes('endpoint=stream')) {
            loadDirectAudioPlayer(streamUrl);
            return;
        }

        showSpinner(false);
        showToast('Unable to resolve stream for this track.');
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
        if (currentTrack && activeSource === 'audio' && !currentAudio._recovering) {
            currentAudio._recovering = true;
            const videoId = await getYoutubeId(currentTrack);
            if (videoId) {
                loadYouTubePlayer(videoId);
                return;
            }
        }
        showToast('Playback error: Stream unavailable.');
    });

    // Time & Progress Update
    currentAudio.addEventListener('timeupdate', () => {
        if (activeSource !== 'audio') return;
        const cur = currentAudio.currentTime || 0;
        const dur = currentAudio.duration || (currentTrack?.duration ? currentTrack.duration / 1000 : 0);
        updateProgressUI(cur, dur);
        updateLyricsSync(cur);
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
            svg.setAttribute('fill', fav ? '#18181b' : 'none');
            svg.setAttribute('stroke', '#18181b');
        }
    }

    function updateBottomPlayerFavButton() {
        if (!bpFavBtn || !currentTrack) return;
        const fav = isFavorite(currentTrack.id);
        const svg = bpFavBtn.querySelector('svg');
        if (svg) {
            svg.setAttribute('fill', fav ? '#18181b' : 'none');
            svg.setAttribute('stroke', '#18181b');
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

    function updateTopNavTint() {
        const topNav = document.getElementById('top-nav-bar');
        if (!topNav) return;
        const page = document.body.getAttribute('data-page');
        if (page === 'now-playing' && currentCoverColor) {
            const { r, g, b } = currentCoverColor;
            topNav.style.backgroundColor = `rgba(${r}, ${g}, ${b}, 0.18)`;
            topNav.style.borderColor = `rgba(${r}, ${g}, ${b}, 0.35)`;
            topNav.style.boxShadow = `0 8px 25px rgba(${r}, ${g}, ${b}, 0.12)`;
        } else {
            topNav.style.backgroundColor = '';
            topNav.style.borderColor = '';
            topNav.style.boxShadow = '';
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
        [npAddBtn, bpAddBtn].forEach(btn => {
            if (!btn) return;
            const svg = btn.querySelector('svg');
            if (svg) {
                svg.setAttribute('fill', inLib ? '#18181b' : 'none');
                svg.setAttribute('stroke', '#18181b');
            }
            btn.classList.toggle('text-zinc-900', inLib);
            btn.classList.toggle('text-zinc-400', !inLib);
            btn.title = inLib ? 'In Library / Playlists (Click to manage)' : 'Add to Playlist';
        });
    }
    window.updateLibraryButtons = updateLibraryButtons;

    function updateNowPlayingBgArt() {
        const bgArt = document.getElementById('now-playing-bg-art');
        if (!bgArt) return;

        let coverSrc = null;
        if (currentPlayingPlaylistContextId && currentPlayingPlaylistContextId !== 'favorites') {
            const pl = playlists.find(p => p.id === currentPlayingPlaylistContextId);
            if (pl && pl.cover) {
                coverSrc = pl.cover;
            }
        }
        if (!coverSrc && currentTrack) {
            coverSrc = getProxyUrl(currentTrack.artwork_url || currentTrack.image);
        }

        if (coverSrc) {
            bgArt.onload = () => {
                bgArt.classList.remove('opacity-0');
                bgArt.classList.add('opacity-80');
            };
            bgArt.src = coverSrc;
            if (bgArt.complete && bgArt.naturalWidth > 0) {
                bgArt.classList.remove('opacity-0');
                bgArt.classList.add('opacity-80');
            }
        } else {
            bgArt.classList.add('opacity-0');
            bgArt.classList.remove('opacity-80');
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

        updateNowPlayingBgArt();
        updateLibraryButtons();

        const coverUrl = getProxyUrl(track.artwork_url || track.image);
        if (coverUrl) {
            extractDominantColor(coverUrl, (rgb) => {
                if (rgb) {
                    applyNowPlayingTint(rgb.r, rgb.g, rgb.b);
                } else {
                    applyNowPlayingTint(220, 220, 230);
                }
            });
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
        const favIndex = favorites.findIndex(f => f.id === track.id);
        if (favIndex > -1) {
            favorites.splice(favIndex, 1);
            if (svgElement) {
                svgElement.setAttribute('fill', 'none');
                svgElement.setAttribute('stroke', '#18181b');
            }
            showToast('Removed from Favorites');
        } else {
            favorites.push(track);
            if (svgElement) {
                svgElement.setAttribute('fill', '#18181b');
                svgElement.setAttribute('stroke', '#18181b');
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

    function applyPlaylistTint(r, g, b) {
        const tintEl = document.getElementById('playlist-bg-tint');
        if (!tintEl) return;
        tintEl.style.background = `linear-gradient(180deg, rgba(${r}, ${g}, ${b}, 0.38) 0%, rgba(${r}, ${g}, ${b}, 0.22) 22%, rgba(${r}, ${g}, ${b}, 0.08) 45%, rgba(252, 251, 248, 0.95) 65%, #FCFBF8 85%)`;
        tintEl.style.opacity = '1';
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
            <div class="w-full aspect-square bg-[#F4F4F5] rounded-2xl border border-zinc-200/80 mb-2 relative overflow-hidden flex items-center justify-center shadow-sm group-hover:shadow-md transition-all">
                <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="#18181b" stroke="#18181b" stroke-width="1.5"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg>
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
    function openPlaylistDetail(playlistId) {
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

            applyPlaylistTint(225, 225, 230);

            if (detailArt) {
                detailArt.className = 'w-44 h-44 sm:w-52 sm:h-52 md:w-60 md:h-60 rounded-2xl bg-[#F4F4F5] flex items-center justify-center overflow-hidden shrink-0 shadow-[0_16px_36px_rgba(0,0,0,0.08)] border border-zinc-200/80 relative';
                detailArt.title = 'Favorites';
                detailArt.style.cursor = 'default';
            }
            if (detailUploadOverlay) detailUploadOverlay.classList.add('hidden');

            detailArtImg.classList.add('hidden');
            detailArtIcon.classList.remove('hidden');
            detailArtIcon.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 24 24" fill="#18181b" stroke="#18181b" stroke-width="1.5"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg>`;
            editBtn.classList.add('hidden');
            deleteBtn.classList.add('hidden');
        } else {
            const pl = playlists.find(p => p.id === playlistId);
            if (!pl) return;
            playlistName = pl.name;
            playlistDesc = pl.description || 'Custom Playlist';
            trackList = pl.tracks || [];

            if (detailArt) {
                detailArt.className = 'w-44 h-44 sm:w-52 sm:h-52 md:w-60 md:h-60 rounded-2xl bg-zinc-100 flex items-center justify-center overflow-hidden shrink-0 shadow-[0_16px_36px_rgba(0,0,0,0.12)] border border-white/60 relative group/art cursor-pointer';
                detailArt.title = 'Click to upload album cover';
                detailArt.style.cursor = 'pointer';
            }
            if (detailUploadOverlay) detailUploadOverlay.classList.remove('hidden');

            const coverSrc = pl.cover || (trackList[0] ? getProxyUrl(trackList[0].artwork_url || trackList[0].image, '300x300') : '');
            if (coverSrc) {
                detailArtImg.src = coverSrc;
                detailArtImg.classList.remove('hidden');
                detailArtIcon.classList.add('hidden');
                extractDominantColor(coverSrc, (rgb) => {
                    if (rgb) applyPlaylistTint(rgb.r, rgb.g, rgb.b);
                    else applyPlaylistTint(253, 224, 71);
                });
            } else {
                detailArtImg.classList.add('hidden');
                detailArtIcon.classList.remove('hidden');
                detailArtIcon.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg>`;
                applyPlaylistTint(220, 220, 228);
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

        const tracksCountEl = document.getElementById('playlist-tracks-count');
        if (tracksCountEl) tracksCountEl.textContent = `${trackList.length} ${trackList.length === 1 ? 'track' : 'tracks'}`;

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
                        currentPlayingPlaylistContextId = playlistId;
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

        // Scroll playlist view to top smoothly
        const scrollContainer = document.getElementById('page-library-scroll');
        if (scrollContainer) scrollContainer.scrollTop = 0;
    }

    // Cover upload from Playlist Detail Hero Art
    const playlistDetailArt = document.getElementById('playlist-detail-art');
    const playlistDetailCoverInput = document.getElementById('playlist-detail-cover-input');
    if (playlistDetailArt && playlistDetailCoverInput) {
        playlistDetailArt.addEventListener('click', () => {
            if (currentPlaylistContextId && currentPlaylistContextId !== 'favorites') {
                playlistDetailCoverInput.click();
            }
        });

        playlistDetailCoverInput.addEventListener('change', (e) => {
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
        const tintEl = document.getElementById('playlist-bg-tint');
        if (tintEl) tintEl.style.opacity = '0';
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

            drawCropCanvas();
            if (cropModal) cropModal.classList.remove('hidden');
        };
        cropImg.src = imageSrc;
    }

    if (cropCanvas) {
        cropCanvas.addEventListener('mousedown', (e) => {
            isCropperDragging = true;
            cropStartX = e.clientX;
            cropStartY = e.clientY;
        });
        window.addEventListener('mousemove', (e) => {
            if (!isCropperDragging) return;
            const dx = e.clientX - cropStartX;
            const dy = e.clientY - cropStartY;
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
            }
        }, { passive: true });
        window.addEventListener('touchmove', (e) => {
            if (!isCropperDragging || e.touches.length !== 1) return;
            const dx = e.touches[0].clientX - cropStartX;
            const dy = e.touches[0].clientY - cropStartY;
            cropStartX = e.touches[0].clientX;
            cropStartY = e.touches[0].clientY;
            cropPanX += dx;
            cropPanY += dy;
            drawCropCanvas();
        }, { passive: true });
        window.addEventListener('touchend', () => {
            isCropperDragging = false;
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
            cropModal.classList.add('hidden');
        };
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
            cropModal.classList.add('hidden');
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
        modalCoverPreview.addEventListener('click', () => playlistModalCoverInput.click());
    }
    if (modalCoverUploadBtn && playlistModalCoverInput) {
        modalCoverUploadBtn.addEventListener('click', () => playlistModalCoverInput.click());
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
        playlistModalTitle.textContent = 'Edit Playlist';
        playlistNameInput.value = pl.name || '';
        playlistDescInput.value = pl.description || '';
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

    async function loadArtistView(artistName) {
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

        if (heroName) heroName.textContent = artistName;
        if (heroDesc) heroDesc.textContent = '';
        if (trackCountEl) trackCountEl.textContent = 'Loading tracks across services...';
        if (headerCountEl) headerCountEl.textContent = '';
        if (heroImg) { heroImg.src = ''; heroImg.classList.add('hidden'); }
        if (heroPlaceholder) heroPlaceholder.classList.remove('hidden');
        if (trackListEl) trackListEl.innerHTML = '';
        if (loaderEl) loaderEl.classList.remove('hidden');
        if (tintEl) tintEl.style.opacity = '0';

        const scrollContainer = document.getElementById('page-artist-scroll');
        if (scrollContainer) scrollContainer.scrollTop = 0;

        try {
            let tracks = [];
            let artwork = null;
            let description = '';

            // 1. Fetch from artist endpoint
            try {
                const res = await fetch(`/api/music-api?endpoint=artist&name=${encodeURIComponent(artistName)}`);
                if (res.ok) {
                    const data = await res.json();
                    if (data) {
                        if (data.artwork_url) artwork = data.artwork_url;
                        if (data.description) description = data.description;
                        if (Array.isArray(data.tracks) && data.tracks.length > 0) {
                            tracks = data.tracks.filter(t => isExactArtistMatch(t, artistName));
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

            if (!artwork && tracks.length > 0) {
                artwork = tracks[0].artwork_url || tracks[0].image;
            }

            currentArtistTracks = tracks;

            if (loaderEl) loaderEl.classList.add('hidden');
            if (heroDesc) heroDesc.textContent = description;
            const countStr = `${tracks.length} ${tracks.length === 1 ? 'track' : 'tracks'} found`;
            if (trackCountEl) trackCountEl.textContent = countStr;
            if (headerCountEl) headerCountEl.textContent = countStr;

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
                        tintEl.style.background = `linear-gradient(180deg, rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.38) 0%, rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.22) 22%, rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.08) 45%, rgba(252, 251, 248, 0.95) 65%, #FCFBF8 85%)`;
                        tintEl.style.opacity = '1';
                    }
                });
            } else {
                if (tintEl) {
                    tintEl.style.background = `linear-gradient(180deg, rgba(200, 200, 210, 0.3) 0%, rgba(252, 251, 248, 0.95) 65%, #FCFBF8 85%)`;
                    tintEl.style.opacity = '1';
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

    // Close modals on clicking backdrop
    [playlistModal, addToPlaylistModal].forEach(modal => {
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

    // Initial render of library and controls
    renderLibrary();
    updateLibraryButtons();
});
