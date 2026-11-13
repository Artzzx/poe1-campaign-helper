// Tails Path of Exile's Client.txt and emits the area you load into.
//
// Every zone load writes a line like:
//   2026/11/13 12:00:00 123 abc [DEBUG Client 1234] Generating level 2 area "1_1_2" with seed 123
// The quoted value is the internal area id, the same id the route files use
// ({enter|1_1_2}), so we never have to match on zone names (which repeat
// between Act 1-5 and Act 6-10).
//
// This only READS the log file the game writes for itself — the same
// approach used by established overlays (Awakened PoE Trade, Exile-UI).

const fs = require("node:fs");
const { EventEmitter } = require("node:events");

const AREA_RE = /Generating level (\d+) area "([^"]+)"/;
const POLL_MS = 500;
const HISTORY_BYTES = 512 * 1024; // look back this far for the current zone
const MAX_CHUNK = 1024 * 1024;

class ClientLogWatcher extends EventEmitter {
  constructor() {
    super();
    this.path = null;
    this.position = 0;
    this.partial = "";
    this.timer = null;
    this.reading = false;
  }

  async start(path) {
    this.stop();
    this.path = path;
    this.partial = "";
    try {
      const { size } = await fs.promises.stat(path);
      this.position = size;
      await this.emitLastKnownArea(size);
    } catch (err) {
      this.emit("error", err);
      this.position = 0;
    }
    this.timer = setInterval(() => this.poll(), POLL_MS);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async emitLastKnownArea(size) {
    const start = Math.max(0, size - HISTORY_BYTES);
    const text = await this.readRange(start, size);
    const lines = text.split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i--) {
      const m = AREA_RE.exec(lines[i]);
      if (m) {
        this.emit("area", { areaId: m[2], level: Number(m[1]), initial: true });
        return;
      }
    }
  }

  async poll() {
    if (this.reading || !this.path) return;
    this.reading = true;
    try {
      const { size } = await fs.promises.stat(this.path);
      if (size < this.position) {
        // File was truncated / recreated (game reinstall, log cleared).
        this.position = 0;
        this.partial = "";
      }
      if (size > this.position) {
        // If we fell far behind, skip to the tail instead of replaying it all.
        if (size - this.position > MAX_CHUNK) this.position = size - MAX_CHUNK;
        const text = await this.readRange(this.position, size);
        this.position = size;
        const lines = (this.partial + text).split(/\r?\n/);
        this.partial = lines.pop() ?? "";
        for (const line of lines) {
          const m = AREA_RE.exec(line);
          if (m)
            this.emit("area", {
              areaId: m[2],
              level: Number(m[1]),
              initial: false,
            });
        }
      }
    } catch (err) {
      // Missing file etc. — keep polling quietly; the game may not be installed yet.
    } finally {
      this.reading = false;
    }
  }

  async readRange(start, end) {
    const length = end - start;
    if (length <= 0) return "";
    const handle = await fs.promises.open(this.path, "r");
    try {
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, start);
      return buffer.toString("utf8");
    } finally {
      await handle.close();
    }
  }
}

/** Common install locations, checked in order. */
function defaultClientLogCandidates() {
  if (process.platform !== "win32") return [];
  const roots = [
    "C:\\Program Files (x86)\\Grinding Gear Games\\Path of Exile",
    "C:\\Program Files\\Grinding Gear Games\\Path of Exile",
    "C:\\Program Files (x86)\\Steam\\steamapps\\common\\Path of Exile",
    "C:\\Program Files\\Steam\\steamapps\\common\\Path of Exile",
    "C:\\SteamLibrary\\steamapps\\common\\Path of Exile",
    "D:\\SteamLibrary\\steamapps\\common\\Path of Exile",
    "C:\\Program Files\\Epic Games\\pathofexile",
  ];
  return roots.map((r) => `${r}\\logs\\Client.txt`);
}

function findClientLog() {
  return defaultClientLogCandidates().find((p) => fs.existsSync(p)) ?? null;
}

module.exports = { ClientLogWatcher, findClientLog, AREA_RE };
