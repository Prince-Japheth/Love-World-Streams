/* eslint-disable @typescript-eslint/no-require-imports */
const { app } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { getSettings } = require('./config');

const STATUS = {
    QUEUED: 'queued',      // waiting for the livestream to end
    WAITING: 'waiting',    // confirmed still live, re-checking on poll
    DOWNLOADING: 'downloading',
    DONE: 'done',
    ERROR: 'error',
};

/**
 * Queue livestreams for download. Downloads start automatically once the
 * stream ends (live_status is no longer "live"/"upcoming"). Regular videos
 * download immediately. Requires the yt-dlp binary (see bin/README.md).
 */
class DownloadManager extends EventEmitter {
    constructor({ getWindow } = {}) {
        super();
        this.getWindow = getWindow;
        this.items = new Map();
        this.pollTimer = null;
        this.downloadsDir = '';
    }

    queuePath() {
        return path.join(app.getPath('userData'), 'loveworld-queue.json');
    }

    start() {
        this.downloadsDir = getSettings().downloadDir || path.join(app.getPath('downloads'), 'LoveWorld Streams');
        console.log('DOWNLOADS DIR IS:', this.downloadsDir);
        if (!fs.existsSync(this.downloadsDir)) fs.mkdirSync(this.downloadsDir, { recursive: true });
        this.loadQueue();
        this.emitState();
        this.schedulePoll(5000); // check for newly-queued items shortly after launch
    }

    loadQueue() {
        try {
            const raw = JSON.parse(fs.readFileSync(this.queuePath(), 'utf8'));
            for (const item of raw) {
                if (item && item.id && !this.items.has(item.id)) {
                    // Anything that wasn't mid-download resumes from 'queued'.
                    if (item.status === STATUS.DOWNLOADING) item.status = STATUS.QUEUED;
                    this.items.set(item.id, item);
                }
            }
        } catch {
            /* first run — no queue yet */
        }
    }

    persist() {
        try {
            fs.writeFileSync(this.queuePath(), JSON.stringify([...this.items.values()], null, 2));
        } catch (e) {
            console.error('Failed to persist queue:', e);
        }
    }

    publicState() {
        return {
            ytdlpAvailable: this.ytdlpAvailable !== false,
            downloadsDir: this.downloadsDir,
            items: [...this.items.values()].map((it) => {
                const copy = { ...it };
                delete copy.proc; // cannot serialize ChildProcess over IPC
                return copy;
            }),
        };
    }

    emitState() {
        this.emit('state-changed', this.publicState());
    }

    queue(id, title) {
        if (this.items.has(id)) {
            const existing = this.items.get(id);
            if (existing.status === STATUS.QUEUED || existing.status === STATUS.WAITING || existing.status === STATUS.DOWNLOADING) {
                return this.publicState();
            }
        }
        
        const item = {
            id,
            title,
            url: `https://www.youtube.com/watch?v=${id}`,
            status: STATUS.DOWNLOADING,
            progress: 0,
            speed: '',
            error: '',
            queuedAt: Date.now(),
        };
        this.items.set(id, item);
        this.persist();
        this.emitState();
        this.startDownload(item);
        return this.publicState();
    }

    remove(id) {
        this.items.delete(id);
        this.persist();
        this.emitState();
    }

    cancel(id) {
        const item = this.items.get(id);
        if (item && item.proc) item.proc.kill('SIGTERM');
        this.items.delete(id);
        this.persist();
        this.emitState();
    }

    retry(id) {
        const item = this.items.get(id);
        if (!item) return;
        item.status = STATUS.QUEUED;
        item.error = '';
        this.persist();
        this.emitState();
        this.schedulePoll(1000);
    }

    // ---- yt-dlp discovery ----
    findYtDlp() {
        const settings = getSettings();
        if (settings.ytdlpPath) return settings.ytdlpPath;

        const candidates = [];
        if (app.isPackaged) {
            candidates.push(path.join(process.resourcesPath, 'bin', 'yt-dlp'));
        } else {
            candidates.push(path.join(__dirname, '..', 'bin', 'yt-dlp'));
        }
        candidates.push('yt-dlp'); // PATH (e.g. brew install yt-dlp)

        for (const c of candidates) {
            if (c === 'yt-dlp') return c; // resolve via PATH at spawn time
            try {
                if (fs.existsSync(c)) return c;
            } catch {
                /* keep looking */
            }
        }
        return 'yt-dlp';
    }

    runYtDlp(args) {
        const bin = this.findYtDlp();
        return new Promise((resolve) => {
            let out = '';
            let err = '';
            const proc = spawn(bin, args, { env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
            proc.stdout.on('data', (d) => { out += d; });
            proc.stderr.on('data', (d) => { err += d; });
            proc.on('error', (e) => resolve({ error: e, out, err }));
            proc.on('close', (code) => resolve({ code, out, err }));
        });
    }

    // ---- livestream status ----
    async checkLiveStatus(item) {
        // We no longer delay livestreams. yt-dlp supports downloading them in real-time.
        item.status = STATUS.QUEUED;
        item.error = '';
        return 'download';
    }

    startDownload(item) {
        item.status = STATUS.DOWNLOADING;
        item.progress = 0;
        item.speed = '';
        item.error = '';
        this.persist();
        this.emitState();

        const bin = this.findYtDlp();
        const args = [
            '-f', 'bv*+ba/b',
            '--merge-output-format', 'mp4',
            '--newline',
            '--no-playlist',
            '-o', path.join(this.downloadsDir, '%(title)s [%(id)s].%(ext)s'),
            item.url,
        ];

        const proc = spawn(bin, args, { env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
        item.proc = proc;

        let lastErr = '';
        proc.stdout.on('data', (d) => {
            const line = String(d);
            const pct = line.match(/([\d.]+)%/);
            if (pct) item.progress = Math.min(99.9, parseFloat(pct[1]));
            const speed = line.match(/at\s+([\d.]+\s*(?:KiB|MiB|GiB)\/s)/);
            if (speed) item.speed = speed[1];
            this.emitState();
        });
        proc.stderr.on('data', (d) => { lastErr += String(d); });

        proc.on('error', (e) => {
            item.status = STATUS.ERROR;
            item.error = `Failed to launch yt-dlp: ${e.message}`;
            this.ytdlpAvailable = false;
            this.persist();
            this.emitState();
        });

        proc.on('close', (code) => {
            item.proc = null;
            if (code === 0) {
                item.status = STATUS.DONE;
                item.progress = 100;
                item.speed = '';
            } else if (item.status !== STATUS.DONE) {
                item.status = STATUS.ERROR;
                item.error = `yt-dlp exited with code ${code}: ${lastErr.slice(0, 300)}`;
            }
            this.persist();
            this.emitState();
        });
    }

    // ---- poll loop ----
    schedulePoll(delay = getSettings().pollIntervalMs) {
        if (this.pollTimer) clearTimeout(this.pollTimer);
        this.pollTimer = setTimeout(() => this.poll(), Math.max(1000, delay));
    }

    async poll() {
        this.pollTimer = null;
        const needCheck = [...this.items.values()].filter(
            (it) => it.status === STATUS.QUEUED || it.status === STATUS.WAITING,
        );

        for (const item of needCheck) {
            if (this.items.get(item.id)?.status !== item.status) continue;
            const action = await this.checkLiveStatus(item);
            if (action === 'download' && this.items.get(item.id)?.status === STATUS.QUEUED) {
                this.startDownload(item);
                continue;
            }
            this.emitState();
        }

        // Re-poll for anything still queued/waiting.
        const stillPending = [...this.items.values()].some(
            (it) => it.status === STATUS.QUEUED || it.status === STATUS.WAITING,
        );
        if (stillPending) this.schedulePoll(getSettings().pollIntervalMs);
    }
}

module.exports = { DownloadManager, STATUS };
