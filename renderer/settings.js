(function () {
    const api = window.loveworld;

    const pathEl = document.getElementById('ytdlp-path');
    const dirEl = document.getElementById('dl-dir');
    const pollEl = document.getElementById('poll-ms');
    const statusEl = document.getElementById('status');

    async function load() {
        const s = await api.settings.get();
        pathEl.value = s.ytdlpPath || '';
        dirEl.value = s.downloadDir || '';
        pollEl.value = s.pollIntervalMs || 300000;

        const dl = await api.downloads.state();
        statusEl.textContent = dl.ytdlpAvailable
            ? `yt-dlp: available · saving to: ${dl.downloadsDir}`
            : `yt-dlp: NOT FOUND — install with "brew install yt-dlp" (or drop it in the bin folder). Saving to: ${dl.downloadsDir}`;
    }

    document.getElementById('save').addEventListener('click', async () => {
        await api.settings.set({
            ytdlpPath: pathEl.value.trim(),
            downloadDir: dirEl.value.trim(),
            pollIntervalMs: Math.max(15000, parseInt(pollEl.value, 10) || 300000),
        });
        statusEl.textContent = 'Saved. Restart the app for changes to take full effect.';
    });

    document.getElementById('browse-dir').addEventListener('click', async () => {
        const picked = await api.settings.pickDownloadDir();
        if (picked) dirEl.value = picked;
    });

    document.getElementById('open-dir').addEventListener('click', async () => {
        const dl = await api.downloads.state();
        if (dl.downloadsDir) api.openExternal('file://' + encodeURI(dl.downloadsDir));
    });

    load();
})();
