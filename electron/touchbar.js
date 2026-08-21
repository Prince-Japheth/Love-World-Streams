/* eslint-disable @typescript-eslint/no-require-imports */
const path = require('path');
const fs = require('fs');
// Item classes are static properties on TouchBar (Electron >= 40 docs pattern);
// they are no longer top-level exports, so destructuring them from
// `require('electron')` yields undefined and `new TouchBarButton(...)` throws.
const { TouchBar, nativeImage } = require('electron');
const { TouchBarButton, TouchBarSpacer, TouchBarLabel, TouchBarScrubber } = TouchBar || {};

/**
 * macOS Touch Bar for LoveWorld Streams.
 *  - App-icon squircle button (gold LW mark, click = home).
 *  - Back / forward: Apple's native NSTouchBarGoBack/GoForwardTemplate icons.
 *  - Reload: the ↻ refresh glyph at 20pt. Downloads: native download icon.
 *  - All buttons are flat (no background) for a native look.
 *  - Loading state: the ↻ button becomes an animated spinner, and the center
 *    of the bar rotates soothing messages while pages load.
 *  - Launch tooltip: a blinking gold hint with an arrow pointing at the logo
 *    that tells users the logo is also the home button, then fades away.
 * The Dock + Touch Bar far-left icon comes from the app bundle (icon.icns) — the
 * standard macOS rendering. We never override it with app.dock.setIcon.
 * Safe to require on any platform — TouchBar is only defined on macOS builds.
 */
function systemIcon(name) {
    try {
        const img = nativeImage.createFromNamedImage(name, { hslShift: [0, 0, 0] });
        if (!img || img.isEmpty()) return null;
        // Template images render with the system's adaptive tint (white on the
        // dark bar, black in light mode) instead of raw black pixels.
        img.setTemplateImage(true);
        return img;
    } catch (e) {
        return null;
    }
}

/** Load a 1x+2x PNG asset from assets/icons and flag it as a template image. */
function loadIcon(baseName) {
    try {
        const img = nativeImage.createEmpty();
        img.addRepresentation({
            scaleFactor: 1,
            buffer: fs.readFileSync(path.join(__dirname, 'assets', 'icons', `${baseName}.png`)),
        });
        img.addRepresentation({
            scaleFactor: 2,
            buffer: fs.readFileSync(path.join(__dirname, 'assets', 'icons', `${baseName}@2x.png`)),
        });
        if (img.isEmpty()) return null;
        img.setTemplateImage(true);
        return img;
    } catch (e) {
        return null;
    }
}

const SPINNER_FRAMES = 8;
function loadSpinnerFrames() {
    const frames = [];
    for (let i = 0; i < SPINNER_FRAMES; i++) {
        try {
            const img = nativeImage.createEmpty();
            img.addRepresentation({
                scaleFactor: 1,
                buffer: fs.readFileSync(path.join(__dirname, 'assets', 'spinner', `spinner-${i}.png`)),
            });
            img.addRepresentation({
                scaleFactor: 2,
                buffer: fs.readFileSync(path.join(__dirname, 'assets', 'spinner', `spinner-${i}@2x.png`)),
            });
            if (img.isEmpty()) continue;
            img.setTemplateImage(true);
            frames.push(img);
        } catch (e) {
            /* skip unreadable frame */
        }
    }
    return frames;
}

// Soothing rotating copy for the center while anything is loading.
const LOADING_MESSAGES = [
    'Be still, and know that I am God…',
    'The Word is on the way…',
    'Jesus — the Way, the Truth and the Life…',
    'Faith is rising…',
    'His grace is sufficient…',
    'Seek ye first the Kingdom of God…',
    'The Light of the world is coming…',
    'Trust in the Lord with all your heart…',
    'Every good and perfect gift is from above…',
    'The Living Word is loading…',
];

// Volume scrubber levels (0–10). TouchBarSlider hits an AppKit constraint bug
// on Electron 40 (renders nothing), so volume uses a native scrubber instead.
const VOLUME_LEVELS = 10;

function setupTouchBar(deps) {
    // No-op on non-macOS builds (also guards the TouchBar class).
    if (process.platform !== 'darwin' || !TouchBar) return { setLoading() {}, setStreaming() {}, attach() {} };

    const { getWindow, getSplashWindow, getContent, navigate, goBack, goForward, reload, focusSearch } = deps;

    // Native macOS back/forward arrows, scaled to ~20pt.
    const arrowBack = systemIcon('NSTouchBarGoBackTemplate')?.resize({ height: 20 });
    const arrowForward = systemIcon('NSTouchBarGoForwardTemplate')?.resize({ height: 20 });
    if (arrowBack) arrowBack.setTemplateImage(true);
    if (arrowForward) arrowForward.setTemplateImage(true);

    // The ↻ refresh glyph, at 20pt.
    const reloadIcon = loadIcon('reload');
    const spinnerFrames = loadSpinnerFrames();

    // Native downloads icon.
    const downloadsIcon = systemIcon('NSTouchBarDownloadTemplate')?.resize({ height: 20 });
    if (downloadsIcon) downloadsIcon.setTemplateImage(true);

    // Media-control icons (streaming): native system play/pause/skip/volume set.
    const sizedIcon = (img, height) => {
        if (!img) return null;
        const resized = img.resize({ height });
        resized.setTemplateImage(true);
        return resized;
    };
    const playIcon = sizedIcon(systemIcon('NSTouchBarPlayTemplate'), 20);
    const pauseIcon = sizedIcon(systemIcon('NSTouchBarPauseTemplate'), 20);
    const rewindIcon = sizedIcon(systemIcon('NSTouchBarRewindTemplate'), 20);
    const fastForwardIcon = sizedIcon(systemIcon('NSTouchBarFastForwardTemplate'), 20);
    const volOffIcon = sizedIcon(systemIcon('NSTouchBarAudioOutputVolumeOffTemplate'), 20);
    const volLowIcon = sizedIcon(systemIcon('NSTouchBarAudioOutputVolumeLowTemplate'), 20);
    const volMedIcon = sizedIcon(systemIcon('NSTouchBarAudioOutputVolumeMediumTemplate'), 20);
    const volHighIcon = sizedIcon(systemIcon('NSTouchBarAudioOutputVolumeHighTemplate'), 20);

    let win = null;
    let currentLoading = false;
    let currentStreaming = false;
    let streamingPollTimer = null;
    let lastMediaState = null;
    let volumeOpen = false;
    let reloadBtn = null;
    let spinnerTimer = null;
    let spinnerFrame = 0;
    let loadingLabel = null;
    let loadingMsgTimer = null;
    let loadingMsgIndex = 0;
    let playPauseBtn = null;
    let volumeBtn = null;
    let volumeScrubber = null;

    // Flat buttons — no background, native look.
    const plainButton = (icon, label, click) => new TouchBarButton({ icon, label, click });

    // The search "field": a pill-styled button (visible fill + magnifier +
    // placeholder text) so it reads as a search bar, not a plain button. The
    // Touch Bar can't host a real text field, so tapping it focuses the app's
    // on-screen search input and the hardware keyboard types straight into it.
    const searchIcon = systemIcon('NSTouchBarSearchTemplate')?.resize({ height: 18 });
    const searchBtn = new TouchBarButton({
        icon: searchIcon,
        iconPosition: 'left',
        label: ' Search channel ',
        click: () => { if (focusSearch) focusSearch(); },
    });

    function buildTouchBar() {
        const back = arrowBack
            ? plainButton(arrowBack, '', () => { if (goBack) goBack(); })
            : plainButton(null, '←', () => { if (goBack) goBack(); });

        const forward = arrowForward
            ? plainButton(arrowForward, '', () => { if (goForward) goForward(); })
            : plainButton(null, '→', () => { if (goForward) goForward(); });

        reloadBtn = reloadIcon
            ? plainButton(reloadIcon, '', () => { if (reload) reload(); })
            : plainButton(null, '↻', () => { if (reload) reload(); });

        const downloads = downloadsIcon
            ? plainButton(downloadsIcon, '', () => { if (navigate) navigate('downloads.html'); })
            : plainButton(null, '↓', () => { if (navigate) navigate('downloads.html'); });

        // Streaming media cluster (center) + volume scrubber.
        const skipBack = rewindIcon ? plainButton(rewindIcon, '', () => skipBy(-10)) : null;
        playPauseBtn = playIcon ? plainButton(playIcon, '', togglePlay) : null;
        const skipFwd = fastForwardIcon ? plainButton(fastForwardIcon, '', () => skipBy(10)) : null;

        // Tap a level 0–10 to set the video volume.
        volumeScrubber = new TouchBarScrubber({
            items: Array.from({ length: VOLUME_LEVELS + 1 }, (_, i) => ({ label: String(i) })),
            mode: 'fixed',
            continuous: false,
            selectedStyle: 'background',
            select: (index) => setVolume(index / VOLUME_LEVELS),
        });
        volumeBtn = volHighIcon
            ? plainButton(volHighIcon, '', () => {
                volumeOpen = !volumeOpen;
                applyBar(buildTouchBar());
            })
            : null;

        const items = [new TouchBarSpacer({ size: 'small' }), back, forward];
        if (currentStreaming) {
            items.push(new TouchBarSpacer({ size: 'flexible' }));
            if (skipBack) items.push(skipBack);
            if (playPauseBtn) items.push(playPauseBtn);
            if (skipFwd) items.push(skipFwd);
            items.push(new TouchBarSpacer({ size: 'flexible' }));
            items.push(reloadBtn, downloads);
            if (volumeBtn) items.push(volumeBtn);
            if (volumeOpen && volumeScrubber) items.push(volumeScrubber);
        } else {
            if (loadingLabel) {
                // Loading: the rotating message owns the CENTER of the bar;
                // the search field stays tucked left so it's still reachable.
                if (searchBtn) items.push(searchBtn);
                items.push(
                    new TouchBarSpacer({ size: 'flexible' }),
                    loadingLabel,
                    new TouchBarSpacer({ size: 'flexible' }),
                );
            } else {
                // Idle: the search field owns the center.
                items.push(new TouchBarSpacer({ size: 'flexible' }));
                if (searchBtn) items.push(searchBtn);
                items.push(new TouchBarSpacer({ size: 'flexible' }));
            }
            items.push(reloadBtn, downloads);
        }

        return new TouchBar({ items });
    }

    // Apply the same bar to the main window and (while it's up) the splash, so
    // the rotating messages are visible even during the initial splash phase.
    function applyBar(bar) {
        if (win && !win.isDestroyed()) win.setTouchBar(bar);
        const splash = getSplashWindow && getSplashWindow();
        if (splash && !splash.isDestroyed()) splash.setTouchBar(bar);
    }

    function startLoadingMessages() {
        if (currentStreaming) return; // media controls own the center while streaming
        if (loadingLabel || !win || win.isDestroyed()) return;
        // Resume from the last message index instead of restarting the rotation.
        loadingLabel = new TouchBarLabel({ label: LOADING_MESSAGES[loadingMsgIndex], textColor: '#8e8e8e' });
        loadingMsgTimer = setInterval(() => {
            loadingMsgIndex = (loadingMsgIndex + 1) % LOADING_MESSAGES.length;
            loadingLabel.label = LOADING_MESSAGES[loadingMsgIndex];
        }, 2600);
        applyBar(buildTouchBar());
    }

    function attach(targetWin) {
        win = targetWin;
        if (!win || win.isDestroyed()) return;
        setLoading(false); // reset any running spinner/messages from a previous window
        applyBar(buildTouchBar());
    }

    // Called by main.js whenever the window's loading state changes.
    function setLoading(loading) {
        if (!reloadBtn || !win || win.isDestroyed()) return;
        currentLoading = loading;

        if (loading) {
            if (!spinnerTimer) {
                if (spinnerFrames.length === 0) {
                    reloadBtn.label = '…';
                } else {
                    reloadBtn.label = '';
                    reloadBtn.icon = spinnerFrames[0];
                    spinnerFrame = 0;
                    spinnerTimer = setInterval(() => {
                        spinnerFrame = (spinnerFrame + 1) % spinnerFrames.length;
                        reloadBtn.icon = spinnerFrames[spinnerFrame];
                    }, 90);
                }
            }
            startLoadingMessages();
        } else {
            if (spinnerTimer) { clearInterval(spinnerTimer); spinnerTimer = null; }
            reloadBtn.icon = reloadIcon;
            reloadBtn.label = '';

            if (loadingLabel) {
                loadingLabel = null;
                if (loadingMsgTimer) { clearInterval(loadingMsgTimer); loadingMsgTimer = null; }
                applyBar(buildTouchBar());
            }
        }
    }

    // ---- Streaming media controls (Spotify-style, Bluubox clone) ----
    // YouTube's main player is `.html5-main-video`; a bare `video` fallback
    // covers shorts/embeds. Each command targets the webContents actually
    // playing (getContent returns the streaming view) and logs its result so
    // failures are visible instead of silently swallowed.
    const MEDIA_VIDEO = `document.querySelector('video.html5-main-video') || document.querySelector('video')`;

    function volumeIconFor(state) {
        if (!state) return volHighIcon;
        if (state.muted || state.volume === 0) return volOffIcon;
        if (state.volume < 0.34) return volLowIcon;
        if (state.volume < 0.67) return volMedIcon;
        return volHighIcon;
    }

    function togglePlay() {
        const wc = getContent && getContent();
        if (!wc || wc.isDestroyed()) return;
        wc.executeJavaScript(`(() => {
            const v = ${MEDIA_VIDEO};
            if (!v) return 'no-video';
            if (v.paused) {
                return v.play().then(() => 'playing').catch(() => {
                    // Autoplay policy can reject a no-gesture play(); fall back
                    // to clicking YouTube's own play button.
                    const b = document.querySelector('.ytp-play-button');
                    if (b) b.click();
                    return 'playing-fallback';
                });
            }
            v.pause();
            return Promise.resolve('paused');
        })()`).then((r) => {
            console.log('[TouchBar] togglePlay:', r);
            if (playPauseBtn && lastMediaState && (r === 'playing' || r === 'paused')) {
                lastMediaState.paused = r === 'paused';
                playPauseBtn.icon = lastMediaState.paused ? playIcon : pauseIcon;
            }
        }).catch((err) => console.warn('[TouchBar] togglePlay failed:', err));
    }

    function skipBy(delta) {
        const wc = getContent && getContent();
        if (!wc || wc.isDestroyed()) return;
        wc.executeJavaScript(`(() => {
            const v = ${MEDIA_VIDEO};
            if (!v) return 'no-video';
            const limit = Number.isFinite(v.duration) ? v.duration : Infinity;
            v.currentTime = Math.max(0, Math.min(limit, v.currentTime + ${delta}));
            return 'seeked';
        })()`).then((r) => {
            console.log('[TouchBar] skipBy:', r);
        }).catch((err) => console.warn('[TouchBar] skipBy failed:', err));
    }

    function setVolume(value) {
        const v = Number(value);
        if (!Number.isFinite(v)) return;
        const wc = getContent && getContent();
        if (!wc || wc.isDestroyed()) return;
        wc.executeJavaScript(`(() => {
            const v = ${MEDIA_VIDEO};
            if (!v) return 'no-video';
            v.volume = ${v};
            if (${v} > 0) v.muted = false;
            return 'volume-set';
        })()`).then((r) => {
            console.log('[TouchBar] setVolume:', r);
        }).catch((err) => console.warn('[TouchBar] setVolume failed:', err));
    }

    function pollMediaState() {
        if (!currentStreaming) return;
        const wc = getContent && getContent();
        if (!wc || wc.isDestroyed()) {
            if (streamingPollTimer) { clearInterval(streamingPollTimer); streamingPollTimer = null; }
            return;
        }
        wc.executeJavaScript(`(() => {
            const v = ${MEDIA_VIDEO};
            if (!v) return null;
            return { paused: v.paused, volume: v.volume, muted: v.muted };
        })()`).then((state) => {
            if (!currentStreaming || !state) return;
            lastMediaState = state;
            if (playPauseBtn) playPauseBtn.icon = state.paused ? playIcon : pauseIcon;
            if (volumeBtn) volumeBtn.icon = volumeIconFor(state);
        }).catch((err) => console.warn('[TouchBar] pollMediaState failed:', err));
    }

    function setStreaming(streaming) {
        if (streaming === currentStreaming) return;
        currentStreaming = streaming;
        if (streaming) {
            if (loadingLabel) {
                loadingLabel = null;
                if (loadingMsgTimer) { clearInterval(loadingMsgTimer); loadingMsgTimer = null; }
            }
            applyBar(buildTouchBar());
            if (!streamingPollTimer) streamingPollTimer = setInterval(pollMediaState, 1000);
        } else {
            if (streamingPollTimer) { clearInterval(streamingPollTimer); streamingPollTimer = null; }
            volumeOpen = false;
            lastMediaState = null;
            applyBar(buildTouchBar());
        }
    }

    attach(getWindow());
    return { setLoading, setStreaming, attach };
}

module.exports = { setupTouchBar };
