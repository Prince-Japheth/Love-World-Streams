/* eslint-disable */
// Violent YouTube chrome stripping for the embedded channel, Bluubox-style.
//
// STRATEGY (reworked after a freeze report): the previous MutationObserver +
// element.remove() approach fought YouTube — YouTube re-adds elements it thinks
// are missing, which retriggered the observer, which removed them again, in an
// endless remove/re-add loop that starved the renderer (the page became
// un-interactive). Now:
//   1. A <style> display:none !important layer is the PRIMARY weapon. CSS is
//      declarative: it applies to re-added nodes instantly and can never
//      trigger a mutation loop.
//   2. element.remove() runs only in a few finite passes (belt and braces).
//   3. No MutationObserver at all — YouTube re-renders are handled by the CSS
//      layer, and the strip is re-injected on real page loads/navigations.
//   4. The page background is forced to the app color (#0a0f1f).
function buildStripScript() {
    return `(() => {
  const STYLE_ID = 'lw-strip-css';
  const APP_BG = '#0a0f1f';

  // Everything inside the masthead that gets removed. ytd-masthead itself is
  // only hidden (never removed) so YouTube's layout/JS doesn't choke.
  const MASTHEAD_SELECTORS = [
    'ytd-masthead #container',
    'ytd-masthead #background',
    'ytd-masthead ytd-topbar-logo-renderer',
    'ytd-masthead yt-icon-button#guide-button',
    'ytd-masthead yt-icon-button#back-button',
    'ytd-masthead div#skip-navigation',
    'ytd-masthead div#center',
    'ytd-masthead div#end',
    'ytd-masthead ytd-topbar-menu-button-renderer',
    'ytd-masthead ytd-notification-topbar-button-renderer',
    'ytd-masthead ytd-button-renderer',
    'ytd-masthead #masthead-skeleton-icons',
  ];

  const CSS_TEXT = [
    // The whole top bar, the sidebar, AND the channel page header (banner,
    // avatar/name/description, in-page tab bar) are gone — the channel tabs
    // now live natively in the app sidebar.
    'ytd-masthead, tp-yt-app-header, ytd-tabbed-page-header, tp-yt-app-toolbar { display: none !important; height: 0 !important; min-height: 0 !important; border: 0 !important; box-shadow: none !important; }',
    MASTHEAD_SELECTORS.join(', ') + ' { display: none !important; }',
    '#guide, ytd-mini-guide-renderer, ytd-guide-renderer { display: none !important; }',
    '#page-manager { margin-left: 0 !important; padding-top: 0 !important; margin-top: 0 !important; }',
    // Shorts: the tab is gone AND the Shorts shelf on the channel home is
    // brutally removed (it doesn't belong on a sermon channel).
    'ytd-reel-shelf-renderer, ytm-shorts-lockup-view-model { display: none !important; }',
    // The fullscreen "More videos" wall (ytp-fullscreen-grid) is gone too —
    // when a service ends the player just stops, no unrelated suggestions.
    '.ytp-fullscreen-grid { display: none !important; }',
    // Brave-style ad blocking: hide every ad surface YouTube renders (the
    // skip button stays clickable — auto-click + manual click both work; the
    // ad itself is muted and fast-forwarded by handleAds()).
    '#ad-container, .video-ads, .ytp-ad-player-overlay, .ytp-ad-text-overlay, .ytp-ad-image-overlay, .ytp-ad-overlay-container, .ytp-ad-simple-ad-badge, .ytp-ad-subtitles, .ytp-ad-progress-list, ytd-ad-slot-renderer, ytd-display-ad-renderer, ytd-in-feed-ad-layout-renderer, ytd-banner-promo-renderer, ytd-action-companion-ad-renderer, ytd-promoted-sparkles-web-renderer, ytd-statement-banner-renderer, ytd-player-legacy-desktop-watch-ads-renderer, ytd-mealbar-promo-renderer { display: none !important; }',
    // Match the page background to the app (window/toolbar color).
    'html, body, ytd-app, #page-manager { background: ' + APP_BG + ' !important; }',
    // Safety net: if YouTube ever re-renders its tab bar, only the section
    // tabs the user asked for survive.
    'yt-tab-shape[tab-title="Shorts"], yt-tab-shape[tab-title="Posts"], yt-tab-shape:not([tab-title]), ytd-expandable-tab-renderer { display: none !important; }',
    // Hide the entire secondary column in the watch page (removes related videos, comments, and side panels)
    '#secondary { display: none !important; }',
    // Fix horizontal scrolling caused by hiding the secondary column
    'body, ytd-app, ytd-watch-flexy { overflow-x: hidden !important; }',
    '#primary, #primary-inner { max-width: 100% !important; min-width: 0 !important; }',
    // Remove extra YouTube action buttons (Download, Thanks, Save, Report, Clip, etc.) under the video
    '#flexible-item-buttons, ytd-menu-popup-renderer ytd-menu-service-item-renderer { display: none !important; }',
  ].join('\\n');

  function injectCss() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS_TEXT;
    (document.head || document.documentElement).appendChild(style);
  }

  // YouTube sets an !important background on <html> that out-ranks our style
  // tag; an inline !important beats everything, so apply it directly too.
  function forceAppBackground() {
    const root = document.documentElement;
    try {
      root.style.setProperty('background', APP_BG, 'important');
      root.style.setProperty('background-color', APP_BG, 'important');
      if (document.body) document.body.style.setProperty('background', APP_BG, 'important');
    } catch (_) {}
  }

  function removeAll(selectors) {
    selectors.forEach((sel) => {
      try { document.querySelectorAll(sel).forEach((el) => el.remove()); } catch (_) {}
    });
  }

  // Whitelist the channel tabs to exactly the page links the user gave us.
  function cleanTabs() {
    document.querySelectorAll('yt-tab-shape').forEach((tab) => {
      const title = String((tab.getAttribute('tab-title') || '').trim());
      const ALLOWED_TABS = new Set(['Home', 'Videos', 'Live', 'Podcasts', 'Playlists']);
      if (!title || !ALLOWED_TABS.has(title)) {
        try { tab.remove(); } catch (_) {}
      }
    });
    removeAll(['ytd-expandable-tab-renderer']);
  }

  // Ad containers to physically yank (the CSS above handles re-renders).
  const AD_SELECTORS = [
    '#ad-container',
    '.video-ads',
    'ytd-ad-slot-renderer',
    'ytd-display-ad-renderer',
    'ytd-in-feed-ad-layout-renderer',
    'ytd-banner-promo-renderer',
    'ytd-action-companion-ad-renderer',
    'ytd-promoted-sparkles-web-renderer',
    'ytd-statement-banner-renderer',
    'ytd-player-legacy-desktop-watch-ads-renderer',
  ];
  const AD_SKIP_SELECTOR = '.ytp-ad-skip-button, .ytp-skip-ad-button, .ytp-ad-skip-button-modern';

  function clean() {
    try {
      injectCss();
      forceAppBackground();
      removeAll(AD_SELECTORS);
      // cleanTabs() and physical DOM removal of the masthead/guide/shorts
      // were breaking YouTube's SPA hydration, causing random redirects to /watch.
      // We now rely entirely on the CSS rules in STYLE_ID to hide these elements.
    } catch (_) {}
  }

  // Brave-style in-video ad handling: the instant an ad starts playing,
  // mute it and push playback to 16x so it burns through in seconds, and
  // click Skip the moment it appears. Restores volume/rate when the ad ends.
  let adState = null; // { muted, volume } captured before an ad muted the video
  function handleAds() {
    try {
      removeAll(AD_SELECTORS);
      document.querySelectorAll(AD_SKIP_SELECTOR).forEach((b) => {
        try { if (!b.disabled) b.click(); } catch (_) {}
      });
      const v = document.querySelector('video.html5-main-video') || document.querySelector('video');
      const adShowing = !!document.querySelector('.ad-showing');
      if (adShowing && v) {
        if (!adState) adState = { muted: v.muted, volume: v.volume };
        v.muted = true;
        v.volume = 0;
        if (v.playbackRate < 16) v.playbackRate = 16;
      } else if (!adShowing && v && adState) {
        v.muted = adState.muted;
        v.volume = adState.volume;
        if (v.playbackRate === 16) v.playbackRate = 1;
        adState = null;
      }
    } catch (_) {}
  }

  // While logged out, YouTube opens a "Sign in" dialog when the user tries to
  // like/dislike/subscribe/comment. Instead, hand off to the app's auth window
  // (same browser session), so once they sign in the page is logged in too.
  // Registered once per document; harmless for logged-in users (native flow).
  const AUTH_SELECTOR = [
    'ytd-subscribe-button-renderer',
    'like-button-view-model',
    'dislike-button-view-model',
    'ytd-comment-simplebox-renderer',
    'ytd-comment-box-renderer',
    'ytd-comment-dialog-renderer',
    'ytd-topbar-menu-button-renderer',
  ].join(', ');
  // Logged-in detection. The masthead (which hosted the avatar and
  // ytd-topbar-menu-button-renderer) is stripped from the page, so a DOM
  // presence check can never see it — it used to always report "logged out",
  // which re-triggered the auth window after every real sign-in. Use YouTube's
  // session cookies instead: LOGIN_INFO is only present after a real sign-in
  // and is readable from JS (SID/HSID/SSID are HttpOnly, so they never appear
  // in document.cookie; they're listed anyway as extra signals).
  function isSignedIn() {
    try {
      if (window.ytcfg && window.ytcfg.data_ && window.ytcfg.data_.LOGGED_IN) return true;
      return /(^|;\s*)(LOGIN_INFO|SAPISID|APISID|SID|HSID|SSID)=/.test(document.cookie || '');
    } catch (_) {
      return false;
    }
  }

  function armAuthHandoff() {
    if (document.__lwAuthArmed) return;
    document.__lwAuthArmed = true;
    document.addEventListener('click', (e) => {
      try {
        const path = e.composedPath ? e.composedPath() : [];
        const hit = path.find((el) => el && el.matches && el.matches(AUTH_SELECTOR));
        if (!hit) return;
        // Logged-in users get YouTube's normal in-page flow.
        if (isSignedIn()) return;
        e.preventDefault();
        e.stopPropagation();
        if (window.lwBridge && window.lwBridge.requireAuth) window.lwBridge.requireAuth();
      } catch (_) {}
    }, true);
  }

  function boot() {
    injectCss();
    clean();
    armAuthHandoff();

    // YouTube's SPA navigation doesn't reload the page, so if a video is playing
    // it might continue in the invisible miniplayer. We must pause it explicitly.
    document.addEventListener('yt-navigate-start', () => {
      document.querySelectorAll('video').forEach(v => {
        if (!v.paused) v.pause();
      });
    });

    // Finite timed passes only — no MutationObserver, so no remove/re-add fight.
    [0, 800, 2000, 5000, 12000].forEach((t) => setTimeout(() => { clean(); handleAds(); }, t));
    // Lightweight interval keeps ads handled when they start mid-playback.
    setInterval(handleAds, 2000);
  }

  // Idempotent: re-injections (page loads / full navigations) re-run clean().
  if (window.__lwStripInstalled) { clean(); return; }
  window.__lwStripInstalled = true;
  window.__lwStripNow = clean;
  boot();
})()`;
}

module.exports = { buildStripScript };
