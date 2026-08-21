/* eslint-disable @typescript-eslint/no-require-imports */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lwToolbar', {
    contentAction: (action) => ipcRenderer.invoke('toolbar:content-action', action),
    goto: (url) => ipcRenderer.invoke('toolbar:navigate', url),
    gotoSection: (section) => ipcRenderer.invoke('toolbar:goto-section', section),
    setSidebarCollapsed: (collapsed) => ipcRenderer.invoke('sidebar:set-collapsed', !!collapsed),
    toggleDownloads: (bounds) => ipcRenderer.invoke('toolbar:toggle-downloads', bounds),
    openSettings: () => ipcRenderer.invoke('toolbar:open-settings'),
    onContentState: (callback) => {
        const listener = (_event, state) => callback(state);
        ipcRenderer.on('toolbar:content-state', listener);
        return () => ipcRenderer.removeListener('toolbar:content-state', listener);
    },
    onFocusSearch: (callback) => {
        const listener = () => callback();
        ipcRenderer.on('toolbar:focus-search', listener);
        return () => ipcRenderer.removeListener('toolbar:focus-search', listener);
    },
    onWebFullscreen: (callback) => {
        const listener = (_event, active) => callback(active);
        ipcRenderer.on('toolbar:web-fullscreen', listener);
        return () => ipcRenderer.removeListener('toolbar:web-fullscreen', listener);
    },
    onDownloadCount: (callback) => {
        const listener = (_event, count) => callback(count);
        ipcRenderer.on('toolbar:dl-count', listener);
        return () => ipcRenderer.removeListener('toolbar:dl-count', listener);
    },
});
