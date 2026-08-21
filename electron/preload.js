/* eslint-disable @typescript-eslint/no-require-imports */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('loveworld', {
    openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),
    windowAction: (action) => ipcRenderer.invoke('window:action', action),
    downloads: {
        state: () => ipcRenderer.invoke('dl:state'),
        currentVideo: () => ipcRenderer.invoke('dl:current-video'),
        queueCurrent: () => ipcRenderer.invoke('dl:queue-current'),
        remove: (id) => ipcRenderer.invoke('dl:remove', id),
        cancel: (id) => ipcRenderer.invoke('dl:cancel', id),
        retry: (id) => ipcRenderer.invoke('dl:retry', id),
        openFolder: () => ipcRenderer.invoke('dl:open-folder'),
        onState: (cb) => {
            const listener = (_e, state) => cb(state);
            ipcRenderer.on('dl:state', listener);
            return () => ipcRenderer.removeListener('dl:state', listener);
        },
        onPopupOpened: (cb) => {
            const listener = () => cb();
            ipcRenderer.on('dl:popup-opened', listener);
            return () => ipcRenderer.removeListener('dl:popup-opened', listener);
        },
    },
    settings: {
        get: () => ipcRenderer.invoke('settings:get'),
        set: (patch) => ipcRenderer.invoke('settings:set', patch),
        pickDownloadDir: () => ipcRenderer.invoke('settings:pick-dir'),
    },
});
