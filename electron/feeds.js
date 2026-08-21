/* eslint-disable @typescript-eslint/no-require-imports */
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');
/**
 * Fetch a channel's recent uploads/livestreams via YouTube's keyless RSS feeds:
 *   https://www.youtube.com/feeds/videos.xml?channel_id=...
 * Returns a normalized list of { id, title, published, url }.
 */
const FEED_RE = /<entry>([\s\S]*?)<\/entry>/g;
const TAG_RE = (tag) => new RegExp(`<${tag}(?:[^>]*)>([\\s\\S]*?)</${tag}>`);

function decodeXmlEntities(s) {
    return String(s || '')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

/**
 * Extract the 11-char video id from one <entry> block. YouTube's feed uses a
 * self-closing <link .../> (no </link>), so prefer <yt:videoId>, then the
 * link's href, then <id>yt:video:...</id>.
 */
function extractVideoId(entry) {
    let m = /<yt:videoId[^>]*>([\w-]{11})<\/yt:videoId>/.exec(entry);
    if (m) return m[1];
    m = /<link[^>]*href="[^"]*[?&]v=([\w-]{11})"/.exec(entry);
    if (m) return m[1];
    m = /<id[^>]*>yt:video:([\w-]{11})<\/id>/.exec(entry);
    return m ? m[1] : null;
}

async function fetchChannelFeed(channelId) {
    const res = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`, {
        headers: { 'User-Agent': 'LoveWorldStreams/0.1' },
    });
    if (!res.ok) throw new Error(`YouTube feed returned ${res.status}`);

    const xml = await res.text();
    const entries = [];
    let m;
    while ((m = FEED_RE.exec(xml))) {
        const entry = m[1];
        const title = decodeXmlEntities((TAG_RE('title').exec(entry) || [])[1] || '');
        const published = (TAG_RE('published').exec(entry) || [])[1] || '';
        const id = extractVideoId(entry);
        if (!id) continue;
        entries.push({ id, title, published, url: `https://www.youtube.com/watch?v=${id}` });
    }
    return { entries };
}

/** Locate the yt-dlp binary: settings path → bundled bin/yt-dlp → PATH. */
function resolveYtDlp() {
    const { getSettings } = require('./config');
    const s = getSettings();
    if (s.ytdlpPath) return s.ytdlpPath;
    const packaged = typeof app === 'object' && app !== null && !!app.isPackaged;
    const bundled = packaged
        ? path.join(process.resourcesPath, 'bin', 'yt-dlp')
        : path.join(__dirname, '..', 'bin', 'yt-dlp');
    if (fs.existsSync(bundled)) return bundled;
    return 'yt-dlp';
}

function runYtDlp(args, timeoutMs = 45000) {
    return new Promise((resolve, reject) => {
        const child = execFile(resolveYtDlp(), args, { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
            clearTimeout(timer);
            if (err) {
                const msg = String(stderr || err.message).trim().split('\n')[0] || err.message;
                reject(new Error(msg));
                return;
            }
            resolve(stdout);
        });
        const timer = setTimeout(() => {
            child.kill('SIGKILL');
            reject(new Error('timed out'));
        }, timeoutMs);
    });
}

/**
 * Fetch a channel section (streams / podcasts / playlists) via the bundled
 * yt-dlp in flat-playlist mode. Videos uses the fast keyless RSS instead.
 */
async function fetchChannelSection(channelId, section) {
    if (section === 'videos') return fetchChannelFeed(channelId);

    const tabUrl = `https://www.youtube.com/channel/${encodeURIComponent(channelId)}/${section}`;
    const json = await runYtDlp(['--flat-playlist', '--playlist-end', '24', '-J', '--no-warnings', tabUrl]);
    const data = JSON.parse(json);
    const isPlaylists = section === 'playlists';

    const entries = (data.entries || [])
        .filter((e) => e && e.id)
        .map((e) => ({
            id: e.id,
            title: e.title || '(untitled)',
            published: e.upload_date || e.published || '',
            url: e.url || (isPlaylists
                ? `https://www.youtube.com/playlist?list=${e.id}`
                : `https://www.youtube.com/watch?v=${e.id}`),
            isPlaylist: isPlaylists,
        }));
    return { entries };
}

module.exports = { fetchChannelFeed, fetchChannelSection };
