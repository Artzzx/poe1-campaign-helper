// Electron shell that turns the campaign helper into an in-game overlay.
//
//  - Overlay window: frameless, transparent, always-on-top, and (on Windows)
//    non-focusable, so clicking it never steals focus from the game.
//  - Global hotkeys: complete / undo step, toggle layout, click-through, hide.
//  - Client.txt watcher: auto-advances the route when you load a zone.
//  - "Full guide" window: the original app, for build import and browsing.
//
// PoE must run in "Windowed Fullscreen" (or Windowed). Exclusive fullscreen
// renders over every other window, so no overlay can show on top of it.

const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  dialog,
  globalShortcut,
  ipcMain,
  nativeImage,
  net,
  protocol,
  screen,
  shell,
} = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { ClientLogWatcher, findClientLog } = require("./client-log.cjs");

const IS_DEV = process.argv.includes("--dev");
const DEV_URL = "http://localhost:5173/poe1-campaign-helper/";
const BASE_PATH = "/poe1-campaign-helper/"; // vite `base`
const APP_URL = `app://bundle${BASE_PATH}`;

// Built web app: packaged → resources/web, unpackaged → ../web/dist-overlay
const WEB_ROOT = app.isPackaged
  ? path.join(process.resourcesPath, "web")
  : path.join(__dirname, "..", "web", "dist-overlay");

// ---------------------------------------------------------------------------
// Settings (userData/overlay-settings.json — editable from the tray menu)

const DEFAULT_SETTINGS = {
  hotkeys: {
    next: "Alt+X",
    back: "Alt+Z",
    toggleLayout: "Alt+C",
    toggleClickThrough: "Alt+L",
    toggleVisible: "Alt+V",
  },
  clientLogPath: null,
  clickThrough: false,
  bounds: null,
};

const settingsPath = () => path.join(app.getPath("userData"), "overlay-settings.json");
let settings = structuredClone(DEFAULT_SETTINGS);

function loadSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsPath(), "utf8"));
    settings = {
      ...DEFAULT_SETTINGS,
      ...raw,
      hotkeys: { ...DEFAULT_SETTINGS.hotkeys, ...(raw.hotkeys || {}) },
    };
  } catch {
    settings = structuredClone(DEFAULT_SETTINGS);
  }
}

let saveTimer = null;
function saveSettings() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
      fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
    } catch (err) {
      console.error("Failed to save settings", err);
    }
  }, 300);
}

// ---------------------------------------------------------------------------
// Serve the built web app from a custom scheme so the origin is stable
// (localStorage = your progress survives restarts) and fetch() works.

protocol.registerSchemesAsPrivileged([
  {
    scheme: "app",
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
]);

function registerAppProtocol() {
  protocol.handle("app", (request) => {
    const { pathname } = new URL(request.url);
    let rel = decodeURIComponent(pathname);
    if (rel.startsWith(BASE_PATH)) rel = rel.slice(BASE_PATH.length);
    if (rel === "" || rel.endsWith("/")) rel += "index.html";

    const filePath = path.normalize(path.join(WEB_ROOT, rel));
    if (!filePath.startsWith(WEB_ROOT + path.sep)) {
      return new Response("Forbidden", { status: 403 });
    }
    return net.fetch(pathToFileURL(filePath).toString());
  });
}

const pageUrl = (hash) => `${IS_DEV ? DEV_URL : APP_URL}#${hash}`;

// ---------------------------------------------------------------------------
// Windows

let overlay = null;
let guide = null;
let tray = null;
let lastArea = null;
let hotkeyErrors = [];
const logWatcher = new ClientLogWatcher();

function defaultBounds() {
  const { workArea } = screen.getPrimaryDisplay();
  const width = 380;
  const height = 520;
  return { width, height, x: workArea.x + workArea.width - width - 24, y: workArea.y + 120 };
}

function boundsAreVisible(b) {
  return screen.getAllDisplays().some(({ workArea: w }) =>
    b.x < w.x + w.width && b.x + b.width > w.x && b.y < w.y + w.height && b.y + b.height > w.y
  );
}

function createOverlay() {
  const bounds =
    settings.bounds && boundsAreVisible(settings.bounds) ? settings.bounds : defaultBounds();

  overlay = new BrowserWindow({
    ...bounds,
    minWidth: 260,
    minHeight: 120,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    resizable: false, // resized via the grip in the UI (transparent windows can't be edge-resized on Windows)
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    // Windows: clicks reach the overlay without activating it → the game keeps focus.
    focusable: process.platform !== "win32",
    show: false,
    title: "PoE Campaign Overlay",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });

  // "screen-saver" is the level that stays above borderless-fullscreen games.
  overlay.setAlwaysOnTop(true, "screen-saver");
  overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  applyClickThrough();
  overlay.loadURL(pageUrl("/overlay"));
  overlay.once("ready-to-show", () => overlay.showInactive());

  const persistBounds = () => {
    if (!overlay || overlay.isDestroyed()) return;
    settings.bounds = overlay.getBounds();
    saveSettings();
  };
  overlay.on("moved", persistBounds);
  overlay.on("resized", persistBounds);
  overlay.on("closed", () => (overlay = null));

  // Links (e.g. YouTube in the guide) open in the real browser.
  overlay.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
}

function openGuide() {
  if (guide && !guide.isDestroyed()) {
    guide.show();
    guide.focus();
    return;
  }
  guide = new BrowserWindow({
    width: 1280,
    height: 900,
    title: "PoE Campaign Helper",
    autoHideMenuBar: true,
    backgroundColor: "#161616",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  guide.loadURL(pageUrl("/"));
  guide.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  // Build import / route changes made in the guide → refresh the overlay.
  guide.on("closed", () => {
    guide = null;
    if (overlay && !overlay.isDestroyed()) overlay.webContents.reload();
  });
}

function toggleOverlayVisible() {
  if (!overlay) return createOverlay();
  if (overlay.isVisible()) overlay.hide();
  else overlay.showInactive();
  updateTray();
}

function applyClickThrough() {
  if (!overlay) return;
  overlay.setIgnoreMouseEvents(settings.clickThrough);
  broadcastState();
  updateTray();
}

function setClickThrough(value) {
  settings.clickThrough = value;
  saveSettings();
  applyClickThrough();
}

// ---------------------------------------------------------------------------
// State / IPC

function getState() {
  return {
    clickThrough: settings.clickThrough,
    hotkeys: settings.hotkeys,
    hotkeyErrors,
    clientLogPath: settings.clientLogPath,
    lastArea,
  };
}

function send(channel, payload) {
  if (overlay && !overlay.isDestroyed()) overlay.webContents.send(channel, payload);
}

function broadcastState() {
  send("overlay:state", getState());
}

ipcMain.handle("overlay:get-state", () => getState());
ipcMain.handle("overlay:get-bounds", () => overlay?.getBounds());
ipcMain.on("overlay:set-bounds", (_e, b) => {
  if (!overlay) return;
  const current = overlay.getBounds();
  overlay.setBounds({ ...current, ...b });
});
ipcMain.on("overlay:set-click-through", (_e, v) => setClickThrough(v));
ipcMain.on("overlay:open-guide", () => openGuide());
ipcMain.on("overlay:hide", () => {
  overlay?.hide();
  updateTray();
});
ipcMain.on("overlay:choose-client-log", () => chooseClientLog());

// ---------------------------------------------------------------------------
// Hotkeys

function registerHotkeys() {
  globalShortcut.unregisterAll();
  hotkeyErrors = [];

  const actions = {
    next: () => send("overlay:hotkey", "next"),
    back: () => send("overlay:hotkey", "back"),
    toggleLayout: () => send("overlay:hotkey", "toggleLayout"),
    toggleClickThrough: () => setClickThrough(!settings.clickThrough),
    toggleVisible: () => toggleOverlayVisible(),
  };

  for (const [action, accelerator] of Object.entries(settings.hotkeys)) {
    if (!accelerator || !actions[action]) continue;
    let ok = false;
    try {
      ok = globalShortcut.register(accelerator, actions[action]);
    } catch {
      ok = false;
    }
    if (!ok) hotkeyErrors.push(`${accelerator} (${action}) is invalid or used by another app`);
  }
  broadcastState();
}

// ---------------------------------------------------------------------------
// Client.txt

logWatcher.on("area", (event) => {
  lastArea = event;
  send("overlay:area", event);
});

function startLogWatcher() {
  if (!settings.clientLogPath || !fs.existsSync(settings.clientLogPath)) {
    settings.clientLogPath = findClientLog();
    saveSettings();
  }
  if (settings.clientLogPath) logWatcher.start(settings.clientLogPath);
  else logWatcher.stop();
  broadcastState();
  updateTray();
}

async function chooseClientLog() {
  const result = await dialog.showOpenDialog({
    title: "Locate Path of Exile's Client.txt (in the game's logs folder)",
    properties: ["openFile"],
    filters: [{ name: "Client log", extensions: ["txt"] }],
    defaultPath: settings.clientLogPath || undefined,
  });
  if (result.canceled || !result.filePaths[0]) return;
  settings.clientLogPath = result.filePaths[0];
  saveSettings();
  lastArea = null;
  startLogWatcher();
}

// ---------------------------------------------------------------------------
// Tray (the overlay has no taskbar entry)

function trayIcon() {
  const candidates = [
    path.join(WEB_ROOT, "favicon-32x32.png"),
    path.join(__dirname, "..", "web", "public", "favicon-32x32.png"),
  ];
  const file = candidates.find((p) => fs.existsSync(p));
  return file ? nativeImage.createFromPath(file) : nativeImage.createEmpty();
}

function updateTray() {
  if (!tray) return;
  const hk = settings.hotkeys;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: overlay?.isVisible() ? `Hide overlay\t${hk.toggleVisible}` : `Show overlay\t${hk.toggleVisible}`,
        click: toggleOverlayVisible,
      },
      {
        label: `Click-through (lock)\t${hk.toggleClickThrough}`,
        type: "checkbox",
        checked: settings.clickThrough,
        click: (item) => setClickThrough(item.checked),
      },
      { label: "Open full guide (build import)", click: openGuide },
      { type: "separator" },
      {
        label: settings.clientLogPath ? "Client.txt: found" : "Client.txt: not found",
        enabled: false,
      },
      { label: "Choose Client.txt…", click: chooseClientLog },
      { type: "separator" },
      {
        label: "Reset overlay position",
        click: () => {
          settings.bounds = null;
          saveSettings();
          overlay?.setBounds(defaultBounds());
          overlay?.showInactive();
        },
      },
      {
        label: "Settings file (hotkeys)…",
        click: () => {
          saveSettings();
          setTimeout(() => shell.openPath(settingsPath()), 400);
        },
      },
      {
        label: "Reload settings",
        click: () => {
          loadSettings();
          registerHotkeys();
          applyClickThrough();
          startLogWatcher();
        },
      },
      { type: "separator" },
      { label: "Quit", click: () => app.quit() },
    ])
  );
}

function createTray() {
  tray = new Tray(trayIcon());
  tray.setToolTip("PoE Campaign Overlay");
  tray.on("click", toggleOverlayVisible);
  updateTray();
}

// ---------------------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => overlay?.showInactive());

  app.whenReady().then(() => {
    loadSettings();
    saveSettings(); // writes defaults on first run so the file is there to edit
    if (!IS_DEV) registerAppProtocol();
    createOverlay();
    createTray();
    registerHotkeys();
    startLogWatcher();
  });

  app.on("will-quit", () => {
    globalShortcut.unregisterAll();
    logWatcher.stop();
  });

  // Having a listener disables Electron's default quit-on-last-window-closed:
  // closing the guide window must not quit; the tray "Quit" does.
  app.on("window-all-closed", () => {});
}
