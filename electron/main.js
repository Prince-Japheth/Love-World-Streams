/* eslint-disable @typescript-eslint/no-require-imports */
const { app, BrowserWindow, WebContentsView, ipcMain, shell, dialog, Menu, session } = require('electron');
const path = require('path');
const { setupTouchBar } = require('./touchbar');
const { DownloadManager } = require('./download-manager');
const { buildStripScript } = require('./strip-youtube');
const { ElectronBlocker } = require('@cliqz/adblocker-electron');
const fetch = require('cross-fetch');

const isDev = !app.isPackaged;

async function setupAdblocker(session) {
    try {
        const blocker = await ElectronBlocker.fromPrebuiltAdsAndTracking(fetch);
        blocker.enableBlockingInSession(session);
        console.log('Adblocker enabled for session');
    } catch (err) {
        console.error('Failed to initialize adblocker:', err);
    }
}

let mainWindow = null;
let splashWindow = null;
let downloadsPopup = null;
let settingsWindow = null;
let downloadManager = null;
let touchbar = null;

const TOOLBAR_HEIGHT = 64; // Spotify-proportioned toolbar
const SIDEBAR_EXPANDED = 260; // wide enough for the brand (logo + name) without truncation
const SIDEBAR_COLLAPSED = 64; // icons-only rail (collapsed)
const DOWNLOAD_POPUP_WIDTH = 420;
const DOWNLOAD_POPUP_HEIGHT = 560;

// The channel is embedded like Bluubox embeds its site — you browse it in-app.
// Override with LW_START_URL for local testing. /featured is the home page.
const startUrl = process.env.LW_START_URL || 'https://www.youtube.com/@WatchPastorChris/featured';

// Section views: one WebContentsView per channel section, preloaded at startup
// so switching tabs is instant. Only the active section is attached to the
// window; the rest stay detached (loaded, ready to swap in).
const SECTIONS = ['home', 'videos', 'streams', 'podcasts', 'playlists'];
const SECTION_PATHS = { home: '/featured', videos: '/videos', streams: '/streams', podcasts: '/podcasts', playlists: '/playlists' };
let sectionViews = {};
let activeSection = 'home';
let sidebarCollapsed = false;
let authWindow = null;
// The view actually playing a video. Tracked across ALL section views (not just
// the active one) so the Touch Bar controls keep working when the user switches
// sections while audio keeps playing in a detached view.
let streamingWc = null;
// True while a video is in YouTube's own (HTML) fullscreen — the app chrome
// steps aside so the player really fills the window.
let webFullscreen = false;

function sidebarWidth() {
    return sidebarCollapsed ? SIDEBAR_COLLAPSED : SIDEBAR_EXPANDED;
}

function channelBase() {
    try {
        const u = new URL(startUrl);
        const handle = u.pathname.split('/').filter(Boolean)[0] || '@WatchPastorChris';
        return u.origin + '/' + handle;
    } catch {
        return startUrl;
    }
}
const CHANNEL_BASE = channelBase();
// The canonical home URL (the channel's /featured page).
const HOME_URL = CHANNEL_BASE + (SECTION_PATHS.home || '');

function activeWebContents() {
    const view = sectionViews[activeSection];
    return view && !view.webContents.isDestroyed() ? view.webContents : null;
}

function pathnameFromUrl(url) {
    try { return new URL(url).pathname || '/'; } catch { return '/'; }
}

function isStreamingPathname(pathname) {
    return /^\/(watch|live|shorts)(\/|$)/.test(pathname) && pathname !== '/';
}

/** Find the section view (any of them) that is showing a watch/live page. */
function refreshStreaming() {
    streamingWc = null;
    for (const name of SECTIONS) {
        const v = sectionViews[name];
        if (!v || v.webContents.isDestroyed()) continue;
        if (isStreamingPathname(pathnameFromUrl(v.webContents.getURL()))) {
            streamingWc = v.webContents;
            break;
        }
    }
    return streamingWc;
}

/**
 * YouTube sometimes redirects to a consent page before showing content.
 * Auto-click "Accept all" once so the embedded channel loads without a wall.
 */
function armConsentAutoAccept(wc) {
    if (!wc || wc.isDestroyed()) return;

    wc.on('did-start-navigation', (details) => {
        if (!details?.isMainFrame) return;
        if (!String(details.url || '').startsWith('https://consent.youtube.com')) return;
        const tryAccept = (n = 0) => {
            if (n > 10 || wc.isDestroyed()) return;
            wc.executeJavaScript(`(() => {
                const b = [...document.querySelectorAll('button')]
                    .find(x => (x.innerText || '').trim() === 'Accept all');
                if (!b) return false;
                b.click();
                return true;
            })()`).then((ok) => {
                if (!ok) setTimeout(() => tryAccept(n + 1), 1000);
            }).catch(() => {});
        };
        tryAccept();
    });
}

function focusContent() {
    const wc = activeWebContents();
    if (!wc) return;
    if (downloadsPopup && !downloadsPopup.isDestroyed() && downloadsPopup.isVisible()) return;
    wc.focus();
}

function setViewBounds() {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const { width, height } = mainWindow.getContentBounds();
    const view = sectionViews[activeSection];
    if (view) {
        // Web fullscreen: the player covers the ENTIRE window (toolbar and
        // sidebar are the window's own webContents, so the view on top hides
        // them). Otherwise the content sits below the toolbar, right of the
        // sidebar.
        const sw = webFullscreen ? 0 : sidebarWidth();
        const ty = webFullscreen ? 0 : TOOLBAR_HEIGHT;
        view.setBounds({
            x: sw,
            y: ty,
            width: Math.max(0, width - sw),
            height: Math.max(0, height - ty),
        });
        view.webContents.invalidate();
    }
}

/** A video entered/left YouTube's own fullscreen — chrome steps aside. */
function setWebFullscreen(active) {
    webFullscreen = !!active;
    if (!mainWindow || mainWindow.isDestroyed()) return;
    // Traffic lights only make sense outside the player.
    if (process.platform === 'darwin') {
        try { mainWindow.setWindowButtonVisibility(!webFullscreen); } catch (e) { /* hiddenInset quirk */ }
    }
    mainWindow.webContents.send('toolbar:web-fullscreen', webFullscreen);
    setViewBounds();
}

/** The currently-open YouTube video (watch/live/shorts) in the active view, if any. */
function currentVideo() {
    const url = activeWebContents()?.getURL() || '';
    const m = url.match(/[?&]v=([\w-]{11})/) || url.match(/\/(?:shorts|live)\\([\w-]{11})/);
    return m ? { id: m[1] } : null;
}

// Violently strip YouTube's chrome (masthead, page header, mini-guide, extra
// tabs) and drop our brand into the top-left, Bluubox-style. Re-injected on
// every page load and SPA navigation; the in-page script is self-healing.
let stripScript = null;
function injectChromeStrip(wc) {
    if (!wc || wc.isDestroyed()) return;
    if (!stripScript) stripScript = buildStripScript();
    wc.executeJavaScript(stripScript).catch(() => {});
}

function sendContentState() {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const wc = activeWebContents();
    if (!wc) return;
    const history = wc.navigationHistory;
    const url = wc.getURL() || '';
    const pathname = pathnameFromUrl(url);
    const isStreaming = !!refreshStreaming();
    const loading = wc.isLoading();

    console.log('[LoveWorld] state:', pathname, '| streaming:', isStreaming);

    touchbar?.setLoading(loading);
    touchbar?.setStreaming(isStreaming);

    mainWindow.webContents.send('toolbar:content-state', {
        canGoBack: history.canGoBack(),
        canGoForward: history.canGoForward(),
        loading,
        title: String(wc.getTitle() || '').replace(/\s*-\s*YouTube$/i, ''),
        url,
        isStreaming,
        channelUrl: CHANNEL_BASE,
    });
}

/** Wire strip injection, consent handling and toolbar state to one content view. */
function wireContentView(wc) {
    wc.on('dom-ready', () => injectChromeStrip(wc));
    wc.on('did-finish-load', () => {
        console.log('[LoveWorld] content loaded:', wc.getURL());
        injectChromeStrip(wc);
    });
    wc.on('did-fail-load', (_e, code, desc, url) => {
        console.warn('[LoveWorld] content load failed:', code, desc, url);
        injectChromeStrip(wc);
    });
    wc.on('did-start-loading', sendContentState);
    wc.on('did-stop-loading', sendContentState);
    wc.on('did-navigate', () => { sendContentState(); injectChromeStrip(wc); });
    // TEMP DEBUG: watch what navigations happen on content views.
    wc.on('did-navigate-in-page', (_e, url) => console.log('[NAV-SPA]', url));
    wc.on('did-navigate', (_e, url) => console.log('[NAV-FULL]', url));
    // In-page (SPA) navigations only refresh toolbar state. The strip's CSS
    // layer is declarative and applies to re-rendered nodes automatically, so
    // re-injecting the script here just added churn on every pushState.
    wc.on('did-navigate-in-page', sendContentState);
    wc.on('page-title-updated', sendContentState);
    // YouTube's own (HTML) fullscreen: let the player take over the whole
    // window, then restore the chrome on exit.
    wc.on('enter-html-full-screen', () => setWebFullscreen(true));
    wc.on('leave-html-full-screen', () => setWebFullscreen(false));
    wc.setWindowOpenHandler(({ url }) => {
        if (url.startsWith('http')) shell.openExternal(url);
        return { action: 'deny' };
    });
    armConsentAutoAccept(wc);

    // Right-click menu with a working element inspector. DevTools open detached
    // (in-view devtools get covered by the WebContentsView).
    wc.on('context-menu', (_e, params) => {
        const canGoBack = wc.navigationHistory.canGoBack();
        const canGoForward = wc.navigationHistory.canGoForward();
        const template = [
            {
                label: 'Back',
                enabled: canGoBack,
                click: () => wc.navigationHistory.goBack(),
            },
            {
                label: 'Forward',
                enabled: canGoForward,
                click: () => wc.navigationHistory.goForward(),
            },
            { label: 'Reload', click: () => (wc.isLoading() ? wc.stop() : wc.reload()) },
            { type: 'separator' },
            { role: 'copy', enabled: !!params.selectionText },
            { role: 'selectAll' },
            ...(params.isEditable ? [
                { type: 'separator' },
                { role: 'cut' },
                { role: 'paste' },
            ] : []),
            { type: 'separator' },
            {
                label: 'Inspect Element',
                click: () => {
                    wc.openDevTools({ mode: 'detach' });
                    wc.inspectElement(params.x, params.y);
                },
            },
        ];
        Menu.buildFromTemplate(template).popup({
            window: BrowserWindow.fromWebContents(wc) || mainWindow || undefined,
        });
    });
}

function createSectionView(name) {
    const view = new WebContentsView({
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            preload: path.join(__dirname, 'content-preload.js'),
        },
    });
    view.setBackgroundColor('#0a0f1f');
    wireContentView(view.webContents);
    view.webContents.loadURL(CHANNEL_BASE + (SECTION_PATHS[name] || ''));
    return view;
}

/** Swap the visible section view. The target is preloaded, so this is instant. */
function activateSection(name) {
    if (!SECTIONS.includes(name)) name = 'home';
    if (name === activeSection) { focusContent(); return; }
    if (!mainWindow || mainWindow.isDestroyed()) return;

    let next = sectionViews[name];
    if (!next || next.webContents.isDestroyed()) {
        next = createSectionView(name);
        sectionViews[name] = next;
    }
    const prev = sectionViews[activeSection];
    if (prev && !prev.webContents.isDestroyed()) mainWindow.contentView.removeChildView(prev);

    mainWindow.contentView.addChildView(next);
    activeSection = name;
    setViewBounds();
    sendContentState();
    focusContent();
}

function createWindow() {
    sectionViews = {};
    activeSection = 'home';

    mainWindow = new BrowserWindow({
        width: 1280,
        height: 840,
        minWidth: 900,
        minHeight: 600,
        title: 'LoveWorld Streams',
        backgroundColor: '#0a0f1f',
        show: false,
        // macOS-native traffic lights + full-size content (Apple-style hidden title bar).
        titleBarStyle: 'hiddenInset',
        webPreferences: {
            preload: path.join(__dirname, 'toolbar-preload.js'),
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
        },
    });

    // Vertically center the traffic lights with the 64px toolbar.
    if (process.platform === 'darwin') {
        try { mainWindow.setWindowButtonPosition({ x: 14, y: 26 }); } catch (e) { /* default */ }
    }

    mainWindow.loadFile(path.join(__dirname, 'toolbar.html'));

    // Splash FIRST (so revealMain can always find it) — and never alwaysOnTop:
    // a floating splash over the user's other windows is terrible. It also skips
    // the Dock and closes the moment the home content is ready.
    splashWindow = new BrowserWindow({
        width: 480, height: 320, transparent: true, frame: false,
        resizable: false, alwaysOnTop: false, skipTaskbar: true,
        webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
    });
    splashWindow.loadFile(path.join(__dirname, 'splash.html'));
    splashWindow.on('closed', () => { splashWindow = null; });

    // Home section: attached immediately, below the toolbar.
    sectionViews.home = createSectionView('home');
    mainWindow.contentView.addChildView(sectionViews.home);
    setViewBounds();
    mainWindow.on('resize', setViewBounds);

    // Reveal the window the moment the home content signals ready — or after
    // 10s no matter what, so the app can never be stuck behind the splash.
    const revealMain = () => {
        if (splashWindow) { splashWindow.close(); splashWindow = null; }
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show();
    };
    const homeWc = sectionViews.home.webContents;
    homeWc.once('did-finish-load', revealMain);
    homeWc.once('did-fail-load', revealMain);
    setTimeout(revealMain, 10000);

    // If the main window dies while the splash is up, take the splash with it.
    mainWindow.on('closed', () => {
        webFullscreen = false;
        if (splashWindow && !splashWindow.isDestroyed()) splashWindow.destroy();
        splashWindow = null;
    });

    // Preload the other channel sections so tab clicks are instant.
    ['videos', 'streams', 'podcasts', 'playlists'].forEach((name, i) => {
        setTimeout(() => {
            if (!mainWindow || mainWindow.isDestroyed()) return;
            if (sectionViews[name]) return;
            console.log('[LoveWorld] preloading section:', name);
            sectionViews[name] = createSectionView(name);
        }, 1200 + i * 1400);
    });

    mainWindow.on('closed', () => {
        if (downloadsPopup && !downloadsPopup.isDestroyed()) downloadsPopup.destroy();
        downloadsPopup = null;
        if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.destroy();
        settingsWindow = null;
        if (authWindow && !authWindow.isDestroyed()) authWindow.destroy();
        authWindow = null;
        SECTIONS.forEach((n) => {
            const v = sectionViews[n];
            if (v && !v.webContents.isDestroyed()) { try { v.webContents.close(); } catch (e) { /* ignore */ } }
        });
        sectionViews = {};
        downloadManager = null;
        mainWindow = null;
    });
}

// ---- Downloads popup (the download queue, Bluubox-style) ----
function toggleDownloadsPopup(buttonBounds) {
    if (downloadsPopup && !downloadsPopup.isDestroyed()) {
        if (downloadsPopup.isVisible()) { downloadsPopup.hide(); return; }
        downloadsPopup.show();
        downloadsPopup.focus();
        downloadsPopup.webContents.send('dl:popup-opened');
        return;
    }
    downloadsPopup = new BrowserWindow({
        width: DOWNLOAD_POPUP_WIDTH,
        height: DOWNLOAD_POPUP_HEIGHT,
        show: false,
        frame: false,
        transparent: true,
        backgroundColor: '#00000000',
        resizable: false,
        skipTaskbar: true,
        parent: mainWindow,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
        },
    });
    downloadsPopup.loadFile(path.join(__dirname, '..', 'renderer', 'downloads.html'));
    downloadsPopup.on('closed', () => { downloadsPopup = null; });

    const position = () => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        const winBounds = mainWindow.getBounds();
        const x = winBounds.x + winBounds.width - DOWNLOAD_POPUP_WIDTH - 12;
        downloadsPopup.setPosition(Math.round(x), Math.round(winBounds.y + TOOLBAR_HEIGHT + 8));
    };
    downloadsPopup.once('ready-to-show', () => {
        position();
        downloadsPopup.show();
        downloadsPopup.webContents.send('dl:popup-opened');
    });
    downloadsPopup.on('blur', () => {
        if (downloadsPopup && !downloadsPopup.isDestroyed()) downloadsPopup.hide();
    });
}

// ---- Settings window ----
function openSettingsWindow() {
    if (settingsWindow && !settingsWindow.isDestroyed()) { settingsWindow.focus(); return; }
    settingsWindow = new BrowserWindow({
        width: 680, height: 560, title: 'Settings — LoveWorld Streams',
        parent: mainWindow, backgroundColor: '#0a0f1f',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            nodeIntegration: false, contextIsolation: true, sandbox: true,
        },
    });
    settingsWindow.loadFile(path.join(__dirname, '..', 'renderer', 'settings.html'));
    settingsWindow.on('closed', () => { settingsWindow = null; });
}

// ---- YouTube sign-in (auth handoff for like/subscribe/comment) ----
// Uses the SAME session as the content views, so cookies set here log the
// embedded pages in too. When the flow lands back on youtube.com (or the
// window closes), the active view reloads to pick up the signed-in state.
function openAuthWindow() {
    if (authWindow && !authWindow.isDestroyed()) { authWindow.focus(); return; }
    authWindow = new BrowserWindow({
        width: 940,
        height: 680,
        title: 'Sign in to YouTube — LoveWorld Streams',
        parent: mainWindow,
        backgroundColor: '#0a0f1f',
        autoHideMenuBar: true,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
        },
    });
    const finishAuth = () => {
        if (authWindow && !authWindow.isDestroyed()) authWindow.close();
        authWindow = null;
        const wc = activeWebContents();
        if (wc && !wc.isDestroyed()) {
            wc.reload();
            focusContent();
        }
    };
    authWindow.webContents.on('did-navigate', (_e, url) => {
        if (String(url).startsWith('https://www.youtube.com/')) finishAuth();
    });
    authWindow.on('closed', () => { authWindow = null; });
    authWindow.loadURL('https://accounts.google.com/ServiceLogin?service=youtube&continue=https%3A%2F%2Fwww.youtube.com%2F');
}

// ---- Minimal, standard macOS menu ----
function buildMenu() {
    const isMac = process.platform === 'darwin';
    const template = [
        ...(isMac ? [{
            label: app.name,
            submenu: [
                { role: 'about' },
                { type: 'separator' },
                { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
                { type: 'separator' },
                { role: 'quit' },
            ],
        }] : []),
        {
            label: 'Edit',
            submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' },
                { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }],
        },
        {
            label: 'View',
            submenu: [
                { label: 'Back', accelerator: 'Cmd+[', click: () => contentAction('back') },
                { label: 'Forward', accelerator: 'Cmd+]', click: () => contentAction('forward') },
                { label: 'Reload', accelerator: 'Cmd+R', click: () => contentAction('reload') },
                { label: 'Home', accelerator: 'Cmd+Shift+H', click: () => contentAction('home') },
                { type: 'separator' },
                { role: 'togglefullscreen' },
                { type: 'separator' },
                // Detached devtools: the content is a WebContentsView, so the
                // in-view devtools get covered by it. A separate window always
                // stays above the content.
                {
                    label: 'Toggle Developer Tools',
                    accelerator: process.platform === 'darwin' ? 'Alt+Cmd+I' : 'Ctrl+Shift+I',
                    click: () => {
                        const wc = activeWebContents();
                        if (!wc || wc.isDestroyed()) return;
                        if (wc.isDevToolsOpened()) wc.closeDevTools();
                        else wc.openDevTools({ mode: 'detach' });
                    },
                },
            ],
        },
        {
            label: 'Window',
            submenu: [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }],
        },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/** Home always lands on the channel's /featured page, wherever the view drifted. */
function goHome() {
    activateSection('home');
    const home = sectionViews.home;
    if (!home || home.webContents.isDestroyed()) {
        sectionViews.home = createSectionView('home');
        activateSection('home');
        return;
    }
    const url = home.webContents.getURL() || '';
    // If the home view wandered off /featured (search results, a video, …),
    // reload it to the canonical home URL. Skip the reload when already there.
    if (!url.startsWith(HOME_URL)) {
        home.webContents.loadURL(HOME_URL);
    }
    focusContent();
}

function contentAction(action) {
    const wc = activeWebContents();
    if (!wc) return;
    if (action === 'back' && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
    if (action === 'forward' && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
    if (action === 'reload') (wc.isLoading() ? wc.stop() : wc.reload());
    if (action === 'home') { goHome(); return; }
    focusContent();
}

// ---- IPC ----
function requireToolbarSender(event) {
    if (!mainWindow || event.sender !== mainWindow.webContents) {
        throw new Error('Rejected IPC request from an untrusted renderer.');
    }
}

ipcMain.handle('toolbar:content-action', (event, action) => {
    requireToolbarSender(event);
    contentAction(String(action));
});
ipcMain.handle('toolbar:toggle-downloads', (event, bounds) => {
    requireToolbarSender(event);
    const values = [bounds?.x, bounds?.y, bounds?.width, bounds?.height];
    if (!values.every(Number.isFinite)) throw new Error('Invalid toolbar button bounds.');
    toggleDownloadsPopup(bounds);
});
ipcMain.handle('toolbar:open-settings', (event) => {
    requireToolbarSender(event);
    openSettingsWindow();
});

// Sidebar collapse → content view resizes to match.
ipcMain.handle('sidebar:set-collapsed', (event, collapsed) => {
    requireToolbarSender(event);
    sidebarCollapsed = !!collapsed;
    setViewBounds();
});

// Logged-out like/subscribe/comment clicked in the embedded page → sign in.
ipcMain.on('auth:request', async (event) => {
    const fromContent = Object.values(sectionViews).some(
        (v) => v && v.webContents === event.sender
    );
    if (!fromContent) return;

    // Verify auth natively since the page-level DOM/cookie checks can be flaky
    // or race against the injected strip script.
    try {
        const cookies = await session.defaultSession.cookies.get({ url: 'https://www.youtube.com' });
        const hasLogin = cookies.some((c) => ['SAPISID', 'SSID', 'LOGIN_INFO'].includes(c.name));
        if (hasLogin) {
            console.log('[LoveWorld] auth:request ignored (already logged in natively)');
            return;
        }
    } catch (e) {
        console.warn('[LoveWorld] failed to read session cookies:', e);
    }

    openAuthWindow();
});

// Channel section tabs → switch to the preloaded section view.
ipcMain.handle('toolbar:goto-section', (event, name) => {
    requireToolbarSender(event);
    if (typeof name !== 'string' || !SECTIONS.includes(name)) {
        throw new Error('Invalid section.');
    }
    activateSection(name);
});

// Channel search: navigate the active view, YouTube only.
ipcMain.handle('toolbar:navigate', (event, rawUrl) => {
    requireToolbarSender(event);
    const wc = activeWebContents();
    if (!wc || wc.isDestroyed()) return;
    if (typeof rawUrl !== 'string') throw new Error('Invalid navigation URL.');
    let u;
    try { u = new URL(rawUrl); } catch { throw new Error('Invalid navigation URL.'); }
    if (!/^https?:$/.test(u.protocol) || u.hostname !== 'www.youtube.com') {
        throw new Error('Navigation outside YouTube is not allowed.');
    }
    wc.loadURL(u.href);
    focusContent();
});

// Close/minimize whatever window sent it (frameless downloads popup).
ipcMain.handle('window:action', (event, action) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return;
    if (action === 'close') win.close();
    else if (action === 'minimize') win.minimize();
});

ipcMain.handle('dl:state', () => downloadManager?.publicState());
ipcMain.handle('dl:current-video', () => {
    const v = currentVideo();
    if (!v) return null;
    const wc = activeWebContents();
    const title = String(wc?.getTitle() || 'YouTube video').replace(/\s*-\s*YouTube$/i, '').trim();
    return { id: v.id, title: title || 'YouTube video' };
});
ipcMain.handle('dl:queue-current', () => {
    const v = currentVideo();
    if (!v) return { error: 'No YouTube video is open.' };
    const wc = activeWebContents();
    const title = String(wc?.getTitle() || 'YouTube video').replace(/\s*-\s*YouTube$/i, '').trim();
    return downloadManager.queue(v.id, title || 'YouTube video');
});
ipcMain.handle('dl:remove', (_e, id) => downloadManager.remove(String(id)));
ipcMain.handle('dl:cancel', (_e, id) => downloadManager.cancel(String(id)));
ipcMain.handle('dl:retry', (_e, id) => downloadManager.retry(String(id)));
ipcMain.handle('dl:open-folder', () => {
    const { shell } = require('electron');
    shell.openPath(downloadManager.downloadsDir);
});

ipcMain.handle('settings:get', () => require('./config').getSettings());
ipcMain.handle('settings:set', (_e, patch) => require('./config').setSettings(patch));
ipcMain.handle('settings:pick-dir', async () => {
    const opts = { title: 'Choose a download folder', properties: ['openDirectory', 'createDirectory'] };
    const r = mainWindow && !mainWindow.isDestroyed()
        ? await dialog.showOpenDialog(mainWindow, opts)
        : await dialog.showOpenDialog(opts);
    return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('shell:open-external', (_e, url) => {
    if (typeof url === 'string' && url.startsWith('http')) shell.openExternal(url);
});

app.whenReady().then(() => {
    // Apply the network-level adblocker to block ads completely like Brave
    setupAdblocker(session.defaultSession);
    
    buildMenu();
    downloadManager = new DownloadManager({ getWindow: () => mainWindow });
    downloadManager.on('state-changed', (state) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('toolbar:dl-count', (state.items || []).length);
        }
        if (downloadsPopup && !downloadsPopup.isDestroyed()) {
            downloadsPopup.webContents.send('dl:state-changed', state);
        }
    });
    downloadManager.start();

    createWindow();
    touchbar = setupTouchBar({
        getWindow: () => mainWindow,
        getSplashWindow: () => splashWindow,
        getContent: () => streamingWc || activeWebContents(),
        startUrl,
        navigate: (page) => {
            if (page === 'downloads.html') toggleDownloadsPopup(null);
            else contentAction('home');
        },
        goBack: () => contentAction('back'),
        goForward: () => contentAction('forward'),
        reload: () => contentAction('reload'),
        focusSearch: () => {
            if (!mainWindow || mainWindow.isDestroyed()) return;
            mainWindow.show();
            mainWindow.webContents.focus();
            mainWindow.webContents.send('toolbar:focus-search');
        },
    });
    touchbar.setLoading(activeWebContents()?.isLoading() || false);

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
            touchbar?.attach(mainWindow);
        }
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
