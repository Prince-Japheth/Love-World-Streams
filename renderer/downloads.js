(function () {
    const api = window.loveworld;
    const listEl = document.getElementById('list');
    const statusEl = document.getElementById('status');

    document.getElementById('popup-close').addEventListener('click', () => api.windowAction('close'));
    document.getElementById('open-folder-btn').addEventListener('click', () => api.downloads.openFolder());

    const detectedEl = document.getElementById('detected');
    let currentVideoInfo = null;
    let currentState = null;

    async function renderDetected() {
        if (!currentVideoInfo) currentVideoInfo = await api.downloads.currentVideo();
        if (!currentVideoInfo) {
            detectedEl.innerHTML = '<div style="color:#71717a; font-size:13px; text-align:center; padding: 12px 0;">No video detected on this page.</div>';
            return;
        }

        const existingItem = currentState?.items?.find((it) => it.id === currentVideoInfo.id);
        const isActive = existingItem && ['downloading', 'queued', 'waiting'].includes(existingItem.status);
        const btnText = isActive ? 'Currently Downloading' : 'Download Now';

        detectedEl.innerHTML = `
            <div style="background: rgba(255,255,255,0.05); padding: 12px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.1);">
                <div style="font-size: 13px; font-weight: 600; margin-bottom: 4px;">Detected: ${escapeHtml(currentVideoInfo.title)}</div>
                <div style="font-size: 11px; color: #a1a1aa; margin-bottom: 12px;">YouTube Video</div>
                <button class="btn primary" id="do-download" style="width: 100%;" ${isActive ? 'disabled' : ''}>
                    ${btnText}
                </button>
            </div>
        `;

        if (!isActive) {
            document.getElementById('do-download').addEventListener('click', async () => {
                const btn = document.getElementById('do-download');
                btn.textContent = 'Currently Downloading';
                btn.disabled = true;

                // Optimistic UI update
                if (currentState && currentVideoInfo) {
                    const optimisticItem = {
                        id: currentVideoInfo.id,
                        title: currentVideoInfo.title,
                        status: 'downloading',
                        progress: 0,
                        speed: '',
                        error: '',
                        queuedAt: new Date().toISOString(),
                    };
                    currentState.items = currentState.items || [];
                    currentState.items.unshift(optimisticItem); // Add to beginning of list
                    render(currentState);
                }
                
                const res = await api.downloads.queueCurrent();
                if (res && res.error) {
                    statusEl.textContent = res.error;
                    btn.textContent = 'Error';
                } else {
                    statusEl.innerHTML = '<span style="color:#d4af37">Starting download...</span>';
                }
            });
        }
    }

    const BADGE = {
        queued: ['badge gold', 'Queued'],
        waiting: ['badge blue', 'Waiting for stream to end'],
        downloading: ['badge gold', 'Downloading'],
        done: ['badge green', 'Done'],
        error: ['badge red', 'Error'],
    };

    function render(state) {
        if (!state) return; // first load still pending
        const items = state.items || [];
        if (!items.length) {
            listEl.innerHTML = '<p class="empty">Nothing queued yet.<br>Open a video or stream, then press “Queue current video”.</p>';
            return;
        }

        // Remove the empty message if it's there
        if (listEl.querySelector('.empty')) listEl.innerHTML = '';

        // Keep track of which IDs are currently in the DOM
        const currentIds = new Set(items.map(it => it.id));
        Array.from(listEl.children).forEach(child => {
            if (!child.dataset.itemId || !currentIds.has(child.dataset.itemId)) {
                child.remove();
            }
        });

        items.forEach((it) => {
            const [cls, label] = BADGE[it.status] || ['badge blue', it.status];
            const pct = it.status === 'done' ? 100 : Math.round(it.progress || 0);
            const meta =
                it.status === 'downloading' ? `${pct}% ${it.speed || ''}`
                : it.status === 'error' ? (it.error || 'Something went wrong.')
                : it.status === 'waiting' ? (it.error || 'Polling stream status…')
                : `Queued ${new Date(it.queuedAt).toLocaleString()}`;

            const actions = it.status === 'done' || it.status === 'error'
                ? `<button class="btn ghost" data-act="remove" data-id="${it.id}">Remove</button>`
                : `<button class="btn ghost" data-act="cancel" data-id="${it.id}">Cancel</button>`;

            let child = listEl.querySelector(`[data-item-id="${it.id}"]`);
            if (!child) {
                child = document.createElement('div');
                child.className = 'dl-item';
                child.dataset.itemId = it.id;
                child.innerHTML = `
                    <div class="info">
                        <div class="t"></div>
                        <div class="meta"></div>
                        <div class="bar"><i></i></div>
                    </div>
                    <span class="badge-container"></span>
                    <div class="actions"></div>
                `;
                listEl.appendChild(child);
            }

            // Surgically update elements to preserve event targets
            child.querySelector('.t').textContent = it.title || '';
            child.querySelector('.meta').textContent = meta || '';
            
            const bar = child.querySelector('.bar');
            if (it.status === 'downloading' || it.status === 'done') {
                bar.style.display = 'block';
                bar.querySelector('i').style.width = `${pct}%`;
            } else {
                bar.style.display = 'none';
            }

            const badgeSpan = child.querySelector('.badge-container');
            if (badgeSpan.className !== `badge-container ${cls}`) {
                badgeSpan.className = `badge-container ${cls}`;
                badgeSpan.textContent = label;
            }

            const actionsDiv = child.querySelector('.actions');
            if (actionsDiv.dataset.renderedHtml !== actions) {
                const retryHtml = it.status === 'error' ? `<button class="btn ghost" data-act="retry" data-id="${it.id}">Retry</button>` : '';
                actionsDiv.innerHTML = retryHtml + actions;
                actionsDiv.dataset.renderedHtml = actions; // avoid rewriting unless actions change
            }
        });
    }

    listEl.addEventListener('click', async (e) => {
        const btn = e.target.closest('button[data-act]');
        if (!btn) return;
        const act = btn.dataset.act;
        const id = btn.dataset.id;
        if (act === 'remove') await api.downloads.remove(id);
        else if (act === 'cancel') await api.downloads.cancel(id);
        else if (act === 'retry') await api.downloads.retry(id);
    });

    function escapeHtml(s) {
        return String(s ?? '')
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    // Skeleton rows while the queue state loads — no text, just shimmer.
    function showSkeleton() {
        listEl.innerHTML = Array.from({ length: 3 }, () => `
            <div class="dl-item skeleton-item">
                <div class="info">
                    <div class="skeleton-line w80"></div>
                    <div class="skeleton-line w40"></div>
                </div>
            </div>`).join('');
    }

    let first = true;
    api.downloads.onState((state) => {
        currentState = state;
        render(state);
        renderDetected();
        if (first) {
            first = false;
            if (!state.ytdlpAvailable) {
                statusEl.innerHTML = '⚠️ yt-dlp was not found. See bin/README.md — <code>brew install yt-dlp</code> (or drop the binary in the bin folder) for downloads to start.';
            }
        }
    });

    showSkeleton();
    api.downloads.state().then((state) => {
        currentState = state;
        render(state);
        renderDetected();
        if (state && !state.ytdlpAvailable) {
            statusEl.innerHTML = '⚠️ yt-dlp was not found. See bin/README.md — <code>brew install yt-dlp</code> (or drop the binary in the bin folder) for downloads to start.';
        }
    });

    api.downloads.onPopupOpened(() => {
        currentVideoInfo = null;
        renderDetected();
    });
})();
