// Minimal, explicit API surface for the renderer (contextIsolation on,
// nodeIntegration off). Typed on the web side in src/overlay/bridge.ts.
const { contextBridge, ipcRenderer } = require("electron");

function subscribe(channel, cb) {
  const listener = (_event, payload) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld("overlay", {
  isElectron: true,
  getState: () => ipcRenderer.invoke("overlay:get-state"),
  getBounds: () => ipcRenderer.invoke("overlay:get-bounds"),
  setBounds: (bounds) => ipcRenderer.send("overlay:set-bounds", bounds),
  setClickThrough: (value) => ipcRenderer.send("overlay:set-click-through", !!value),
  openGuide: () => ipcRenderer.send("overlay:open-guide"),
  hide: () => ipcRenderer.send("overlay:hide"),
  chooseClientLog: () => ipcRenderer.send("overlay:choose-client-log"),
  onHotkey: (cb) => subscribe("overlay:hotkey", cb),
  onArea: (cb) => subscribe("overlay:area", cb),
  onState: (cb) => subscribe("overlay:state", cb),
});
