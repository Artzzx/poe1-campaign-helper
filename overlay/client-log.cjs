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
      const size = await this.currentSize();
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
      const size = await this.currentSize();
      if (size < this.position) {
        // File was truncated / recreated (game reinstall, log cleared).
        this.position = 0;
        this.partial = "";
      }
      // If we fell far behind, skip to the tail instead of replaying it all.
      if (size - this.position > MAX_CHUNK) this.position = size - MAX_CHUNK;
      // Read until EOF instead of up to `size`: the size can lag behind what
      // the game has already written (see currentSize).
      const text = await this.readFrom(this.position);
      if (text.length > 0) {
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

  // Size from an open handle (fstat). A path-based fs.stat on Windows can
  // return the size cached in the directory entry, which NTFS doesn't update
  // while PoE keeps Client.txt open and appends to it: the log then looks
  // frozen at whatever size it had when the game opened it.
  async currentSize() {
    const handle = await fs.promises.open(this.path, "r");
    try {
      return (await handle.stat()).size;
    } finally {
      await handle.close();
    }
  }

  /** Reads from `start` to the real end of the file and advances position. */
  async readFrom(start) {
    const handle = await fs.promises.open(this.path, "r");
    try {
      const chunks = [];
      let position = start;
      for (;;) {
        const buffer = Buffer.alloc(64 * 1024);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
        if (bytesRead === 0) break;
        chunks.push(buffer.subarray(0, bytesRead));
        position += bytesRead;
      }
      this.position = position;
      return Buffer.concat(chunks).toString("utf8");
    } finally {
      await handle.close();
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
