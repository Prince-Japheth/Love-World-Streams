/* eslint-disable @typescript-eslint/no-require-imports */
// Minimal bridge for the embedded YouTube content views. Exposes only the
// auth hook the strip script needs when a logged-out user clicks
// Subscribe/Like/Dislike/Comment.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lwBridge', {
    requireAuth: () => ipcRenderer.send('auth:request'),
});
