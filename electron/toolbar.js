(function () {
    const { contentAction, gotoSection, toggleDownloads, openSettings, onContentState, onDownloadCount, goto, setSidebarCollapsed, onFocusSearch, onWebFullscreen } = window.lwToolbar;

    const backBtn = document.getElementById('back');
    const fwdBtn = document.getElementById('forward');
    const reloadBtn = document.getElementById('reload');
    const badge = document.getElementById('download-badge');
    const downloadsBtn = document.getElementById('downloads');
    const settingsBtn = document.getElementById('settings');
    const sideItems = Array.from(document.querySelectorAll('.side-item[data-section]'));
    const collapseBtn = document.getElementById('sidebar-collapse');
    const brandHome = document.getElementById('brand-home');
    const homeBtn = document.getElementById('home');
    const searchInput = document.getElementById('search-input');

    let lastState = null;

    // Map the current YouTube pathname to the active sidebar section.
    function sectionForPath(pathname) {
        const seg = (pathname || '').split('/').filter(Boolean);
        switch (seg[1]) {
            case 'videos': return 'videos';
            case 'streams':
            case 'live': return 'streams';
            case 'podcasts': return 'podcasts';
            case 'playlists': return 'playlists';
            default: return 'home';
        }
    }

    function applyActive(url) {
        let pathname = '';
        try { pathname = new URL(url).pathname; } catch (_) { /* keep empty */ }
        const active = sectionForPath(pathname);
        sideItems.forEach((b) => b.classList.toggle('active', b.dataset.section === active));
        // Home lives in the toolbar now — it lights up like a sidebar item.
        if (homeBtn) homeBtn.classList.toggle('active', active === 'home');
    }

    // ---- Sidebar collapse (persisted, Spotify-style) ----
    function applyCollapsed(collapsed) {
        document.body.classList.toggle('sidebar-collapsed', collapsed);
        collapseBtn.title = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
        collapseBtn.setAttribute('aria-label', collapseBtn.title);
        if (brandHome) {
            brandHome.title = collapsed ? 'Expand sidebar' : 'LoveWorld';
            brandHome.setAttribute('aria-label', brandHome.title);
        }
    }
    function toggleCollapsed() {
        const collapsed = !document.body.classList.contains('sidebar-collapsed');
        applyCollapsed(collapsed);
        try { localStorage.setItem('lw-sidebar-collapsed', collapsed ? '1' : '0'); } catch (_) { /* ignore */ }
        setSidebarCollapsed(collapsed);
    }
    collapseBtn.addEventListener('click', toggleCollapsed);
    try {
        const saved = localStorage.getItem('lw-sidebar-collapsed');
        if (saved === '1') { applyCollapsed(true); setSidebarCollapsed(true); }
    } catch (_) { /* ignore */ }

    // Brand header (logo + name). Expanded: click → home. Collapsed: the logo
    // is the expand button (no separate chevron needed).
    if (brandHome) brandHome.addEventListener('click', () => {
        if (document.body.classList.contains('sidebar-collapsed')) { toggleCollapsed(); return; }
        contentAction('home');
    });

    document.getElementById('home') && document.getElementById('home').addEventListener('click', () => contentAction('home'));
    backBtn.addEventListener('click', () => contentAction('back'));
    fwdBtn.addEventListener('click', () => contentAction('forward'));
    reloadBtn.addEventListener('click', () => contentAction('reload'));
    downloadsBtn.addEventListener('click', (e) => {
        const r = downloadsBtn.getBoundingClientRect();
        toggleDownloads({ x: r.x, y: r.y, width: r.width, height: r.height });
    });
    settingsBtn.addEventListener('click', () => openSettings());

    // Sidebar sections → switch to the preloaded section view.
    sideItems.forEach((b) => b.addEventListener('click', () => gotoSection(b.dataset.section)));

    // Persistent search field — Enter searches the channel, Esc clears.
    searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            const q = searchInput.value.trim();
            const base = lastState && lastState.channelUrl ? lastState.channelUrl : '';
            if (q && base) goto(base + '/search?query=' + encodeURIComponent(q));
        } else if (e.key === 'Escape') {
            searchInput.value = '';
            searchInput.blur();
        }
    });

    onContentState((state) => {
        lastState = state;
        backBtn.disabled = !state.canGoBack;
        fwdBtn.disabled = !state.canGoForward;
        reloadBtn.classList.toggle('is-loading', !!state.loading);
        reloadBtn.disabled = !!state.loading;
        applyActive(state.url);
    });

    // Touch Bar search → focus the on-screen search field so the keyboard
    // types straight into it (the Touch Bar can't host a real text field).
    onFocusSearch(() => {
        searchInput.focus();
        searchInput.select();
    });

    // YouTube's own fullscreen: hide the app chrome (the content view covers
    // the window too, this keeps the DOM consistent).
    onWebFullscreen((active) => {
        document.body.classList.toggle('web-fullscreen', !!active);
    });

    onDownloadCount((count) => {
        badge.hidden = !count;
        badge.textContent = count > 99 ? '99+' : String(count);
    });
})();
