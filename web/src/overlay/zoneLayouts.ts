// Turns the act markdown files (web/public/docs/actN.md) into a per-zone
// lookup so the overlay can show only the layout images for the zone you
// are in, instead of the whole act.
//
// The markdown is a sequence of 3-column tables:
//   | Zone A | Zone B | Zone C |
//   | ----- | ----- | ----- |
//   | ![][image2]![][image3] | text | ![][image5] |
//   | Note: ... | Note: ... | Note: ... |
// followed by `[imageN]: <data:image/png;base64,...>` definitions.

export interface ZoneLayout {
  name: string;
  images: string[];
  notes: string[];
}

export function normalizeZoneName(name: string) {
  return name
    .toLowerCase()
    .replace(/[’'`]/g, "")
    .replace(/\s+and the end of part \d+/, "") // "Cathedral Rooftop (3) and the End of Part 1"
    .replace(/\(\d+\)/g, "") // "The Ossuary (1)" — step numbering in the docs
    .replace(/\blevel\s+(\d)/g, "$1") // "Crypt Level 1" (game) == "Crypt 1" (docs)
    .replace(/^the\s+/, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Exact match first, then "The Crypt" -> "crypt 1" style fallbacks. */
export function findZoneLayout(
  layouts: Map<string, ZoneLayout>,
  areaName: string
): ZoneLayout | undefined {
  const key = normalizeZoneName(areaName);
  const exact = layouts.get(key);
  if (exact) return exact;
  for (const [k, v] of layouts) if (k.startsWith(key + " ")) return v;
  return undefined;
}

function splitRow(line: string) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

const isTableLine = (line: string) => line.trim().startsWith("|");
const isSeparator = (line: string) => /^\|?\s*:?-{3,}/.test(line.trim());

export function parseZoneLayouts(markdown: string): Map<string, ZoneLayout> {
  const imageDefs = new Map<string, string>();
  for (const m of markdown.matchAll(/\[image(\d+)\]:\s*<(data:image\/[^>]+)>/g))
    imageDefs.set(m[1], m[2]);

  const result = new Map<string, ZoneLayout>();
  const lines = markdown.split("\n");

  for (let i = 0; i < lines.length - 1; i++) {
    if (!isTableLine(lines[i]) || !isSeparator(lines[i + 1])) continue;

    const headers = splitRow(lines[i]);
    const zones: ZoneLayout[] = headers.map((name) => ({
      name,
      images: [],
      notes: [],
    }));

    // Some tables put a single zone's name in col 0 but its images in col 1;
    // when only one header is filled, pool every column into that zone.
    const named = zones.filter((z) => z.name.length > 0);
    const pool = named.length === 1 ? named[0] : null;

    let j = i + 2;
    for (; j < lines.length && isTableLine(lines[j]); j++) {
      splitRow(lines[j]).forEach((cell, col) => {
        const zone = pool ?? zones[col];
        if (!zone) return;
        for (const m of cell.matchAll(/!\[\]\[image(\d+)\]/g)) {
          const src = imageDefs.get(m[1]);
          if (src) zone.images.push(src);
        }
        const text = cell
          .replace(/!\[\]\[image\d+\]/g, "")
          .replace(/^note:\s*/i, "")
          .trim();
        if (text) zone.notes.push(text);
      });
    }

    for (const zone of named) result.set(normalizeZoneName(zone.name), zone);
    i = j - 1;
  }

  return result;
}

const cache = new Map<number, Promise<Map<string, ZoneLayout>>>();

export function loadActLayouts(act: number) {
  let entry = cache.get(act);
  if (!entry) {
    entry = fetch(`${import.meta.env.BASE_URL}docs/act${act}.md`)
      .then((r) => (r.ok ? r.text() : ""))
      .then(parseZoneLayouts)
      .catch(() => new Map<string, ZoneLayout>());
    cache.set(act, entry);
  }
  return entry;
}
