/* eslint-disable @typescript-eslint/no-require-imports */
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Christ Embassy / LoveWorld Nation channels.
 * Edit this list to curate which channels appear in the app.
 * Channel IDs are found on the channel's YouTube page (handle -> About -> Share).
 */
const CHANNELS = [
    {
        // Official Christ Embassy / LoveWorld Nations channel (Pastor Chris messages).
        id: 'UC3FqMTURvvZyCKb_4hod9Vg',
        name: 'Christ Embassy',
    },
];

function settingsPath() {
    return path.join(app.getPath('userData'), 'loveworld-settings.json');
}

const DEFAULTS = {
    // Path to the yt-dlp binary. Leave empty to auto-detect: bundled ./bin/yt-dlp,
    // then "yt-dlp" on PATH (e.g. installed via `brew install yt-dlp`).
    ytdlpPath: '',
    // Poll interval (ms) for livestream status while waiting for a stream to end.
    pollIntervalMs: 5 * 60 * 1000,
    // Download destination. Empty = <userData>/downloads
    downloadDir: '',
};

let settings = null;
function getSettings() {
    if (settings) return settings;
    try {
        settings = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) };
    } catch {
        settings = { ...DEFAULTS };
    }
    return settings;
}

function setSettings(patch) {
    settings = { ...getSettings(), ...patch };
    try {
        fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
        fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
    } catch (e) {
        console.error('Failed to persist settings:', e);
    }
    return settings;
}

module.exports = { CHANNELS, getSettings, setSettings };
