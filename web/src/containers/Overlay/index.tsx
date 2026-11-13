import { Data } from "../../../../common/data";
import { RouteData } from "../../../../common/route-processing/types";
import { FragmentStep } from "../../components/FragmentStep";
import { GemReward } from "../../components/ItemReward";
import { AreaEvent, bridge, OverlayState } from "../../overlay/bridge";
import {
  findZoneLayout,
  loadActLayouts,
  ZoneLayout,
} from "../../overlay/zoneLayouts";
import { gemProgressSelectorFamily } from "../../state/gem-progress";
import { routeSelector } from "../../state/route";
import { routeProgressSelectorFamily } from "../../state/route-progress";
import styles from "./styles.module.css";
import classNames from "classnames";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  FiChevronLeft,
  FiChevronRight,
  FiEyeOff,
  FiLock,
  FiMap,
  FiMaximize2,
  FiSettings,
  FiUnlock,
} from "react-icons/fi";
import {
  RecoilState,
  useRecoilCallback,
  useRecoilValue,
  waitForAll,
} from "recoil";

// ---------------------------------------------------------------------------
// Overlay-local preferences (same origin as the full guide → shared storage)

interface OverlayPrefs {
  opacity: number; // background opacity 0.2 – 1
  upcoming: number; // how many upcoming steps to show
  showLayout: boolean;
  autoAdvance: boolean;
  fontScale: number;
}

const PREFS_KEY = "overlay-prefs";
const DEFAULT_PREFS: OverlayPrefs = {
  opacity: 0.75,
  upcoming: 3,
  showLayout: true,
  autoAdvance: true,
  fontScale: 1,
};

function loadPrefs(): OverlayPrefs {
  try {
    return { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem(PREFS_KEY) || "{}") };
  } catch {
    return DEFAULT_PREFS;
  }
}

function usePrefs() {
  const [prefs, setPrefs] = useState(loadPrefs);
  const update = useCallback((patch: Partial<OverlayPrefs>) => {
    setPrefs((p) => {
      const next = { ...p, ...patch };
      try {
        localStorage.setItem(PREFS_KEY, JSON.stringify(next));
      } catch {}
      return next;
    });
  }, []);
  return [prefs, update] as const;
}

// ---------------------------------------------------------------------------
// Route flattening

interface FlatStep {
  key: string;
  sectionName: string;
  step: RouteData.Step;
  state: RecoilState<boolean>;
}

function flattenRoute(route: RouteData.Route): FlatStep[] {
  const flat: FlatStep[] = [];
  route.forEach((section, sectionIndex) =>
    section.steps.forEach((step, stepIndex) => {
      if (step.type === "fragment_step")
        flat.push({
          key: `${sectionIndex},${stepIndex}`,
          sectionName: section.name,
          step,
          // Same key format as containers/Routes, so progress is shared.
          state: routeProgressSelectorFamily([sectionIndex, stepIndex].toString()),
        });
      else
        flat.push({
          key: `gem-${step.requiredGem.id}`,
          sectionName: section.name,
          step,
          state: gemProgressSelectorFamily(step.requiredGem.id),
        });
    })
  );
  return flat;
}

/** Areas a step takes you into (enter / waypoint / logout). */
function travelTargets(step: RouteData.Step): string[] {
  if (step.type !== "fragment_step") return [];
  const out: string[] = [];
  for (const part of step.parts) {
    if (typeof part === "string") continue;
    if (part.type === "enter" || part.type === "logout") out.push(part.areaId);
    if (part.type === "waypoint_use") out.push(part.dstAreaId);
  }
  return out;
}

const TRAVEL_ONLY = new Set([
  "enter",
  "logout",
  "waypoint_use",
  "waypoint",
  "portal_use",
  "dir",
]);

/** True when the step is nothing but "go to X" — safe to tick on arrival. */
function isPureTravel(step: RouteData.Step) {
  if (step.type !== "fragment_step") return false;
  return step.parts.every(
    (p) => typeof p === "string" || TRAVEL_ONLY.has(p.type)
  );
}

const AUTO_ADVANCE_WINDOW = 15;

// ---------------------------------------------------------------------------

export default function OverlayContainer() {
  const route = useRecoilValue(routeSelector);
  const flat = useMemo(() => flattenRoute(route), [route]);
  const done = useRecoilValue(waitForAll(flat.map((f) => f.state)));
  const [prefs, setPrefs] = usePrefs();
  const [showSettings, setShowSettings] = useState(false);
  const [bridgeState, setBridgeState] = useState<OverlayState | null>(null);
  const [liveArea, setLiveArea] = useState<AreaEvent | null>(null);

  const current = done.findIndex((d) => !d);
  const finished = current === -1;

  const setDone = useRecoilCallback(
    ({ set }) =>
      (from: number, to: number, value: boolean) => {
        for (let i = from; i <= to; i++) set(flat[i].state, value);
      },
    [flat]
  );

  // Refs so the IPC listeners (registered once) always see fresh values.
  const live = useRef({ current, done, flat, prefs });
  live.current = { current, done, flat, prefs };

  // Last auto-advance, so "back" can undo the whole jump in one press.
  const lastAuto = useRef<{ from: number; to: number } | null>(null);

  const next = useCallback(() => {
    lastAuto.current = null;
    const { current } = live.current;
    if (current >= 0) setDone(current, current, true);
  }, [setDone]);

  const back = useCallback(() => {
    const { current, flat } = live.current;
    const auto = lastAuto.current;
    lastAuto.current = null;
    const end = current === -1 ? flat.length : current;
    if (auto && auto.to === end - 1) return setDone(auto.from, auto.to, false);
    if (end - 1 >= 0) setDone(end - 1, end - 1, false);
  }, [setDone]);

  const onArea = useCallback(
    (event: AreaEvent) => {
      setLiveArea(event);
      const { current, flat, prefs } = live.current;
      if (event.initial || !prefs.autoAdvance || current < 0) return;

      // Town visits happen all the time off-route (selling, portals), so a
      // town only counts if it's the very next place the route sends you.
      // Other zones may match further ahead (you skipped an optional step).
      const isTown = Data.Areas[event.areaId]?.is_town_area ?? false;

      const end = Math.min(flat.length, current + AUTO_ADVANCE_WINDOW);
      for (let j = current; j < end; j++) {
        const targets = travelTargets(flat[j].step);
        if (targets.length === 0) continue;
        if (!targets.includes(event.areaId)) {
          if (isTown) return;
          continue;
        }
        // Tick everything you've moved past. The arrival step itself is ticked
        // only if it's pure travel ("➞ The Coast"), not "➞ Arena, kill boss".
        const last = isPureTravel(flat[j].step) ? j : j - 1;
        if (last >= current) {
          setDone(current, last, true);
          lastAuto.current = { from: current, to: last };
        }
        return;
      }
    },
    [setDone]
  );

  // Electron wiring
  useEffect(() => {
    if (!bridge) return;
    bridge.getState().then((s) => {
      setBridgeState(s);
      if (s.lastArea) setLiveArea(s.lastArea);
    });
    const offs = [
      bridge.onState(setBridgeState),
      bridge.onArea(onArea),
      bridge.onHotkey((action) => {
        if (action === "next") next();
        if (action === "back") back();
        if (action === "toggleLayout")
          setPrefs({ showLayout: !live.current.prefs.showLayout });
      }),
    ];
    return () => offs.forEach((off) => off());
  }, [next, back, onArea, setPrefs]);

  // Progress changed in the full guide window → reload to pick it up.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key && e.key !== PREFS_KEY) window.location.reload();
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  // Transparent page background for the overlay window only.
  useEffect(() => {
    document.documentElement.classList.add("overlay-mode");
    return () => document.documentElement.classList.remove("overlay-mode");
  }, []);

  // Which zone's layout to show: live zone from Client.txt, otherwise the
  // last place the route sent you before the current step.
  const zoneAreaId = useMemo(() => {
    if (liveArea) return liveArea.areaId;
    const upto = finished ? flat.length : current;
    for (let i = upto - 1; i >= 0; i--) {
      const t = travelTargets(flat[i].step);
      if (t.length) return t[t.length - 1];
    }
    return null;
  }, [liveArea, current, finished, flat]);

  const zoneArea = zoneAreaId ? Data.Areas[zoneAreaId] : undefined;
  const layout = useZoneLayout(zoneArea);

  const sectionName = finished ? "Route complete" : flat[current].sectionName;
  const sectionSteps = flat.filter((f) => f.sectionName === sectionName);
  const sectionDone = sectionSteps.filter((f) => done[flat.indexOf(f)]).length;

  const visible = finished
    ? []
    : flat.slice(current, current + 1 + prefs.upcoming);

  const locked = bridgeState?.clickThrough ?? false;

  return (
    <div
      className={classNames(styles.overlay, { [styles.locked]: locked })}
      style={
        {
          "--overlay-alpha": prefs.opacity,
          fontSize: `${prefs.fontScale}em`,
        } as React.CSSProperties
      }
    >
      <DragHeader>
        <div className={styles.title}>
          <span className={styles.section}>{sectionName}</span>
          {!finished && (
            <span className={styles.count}>
              {sectionDone}/{sectionSteps.length}
            </span>
          )}
        </div>
        <div className={styles.toolbar} data-nodrag>
          <IconButton title="Previous step" onClick={back}>
            <FiChevronLeft />
          </IconButton>
          <IconButton title="Complete step" onClick={next}>
            <FiChevronRight />
          </IconButton>
          <IconButton
            title="Toggle zone layout"
            active={prefs.showLayout}
            onClick={() => setPrefs({ showLayout: !prefs.showLayout })}
          >
            <FiMap />
          </IconButton>
          <IconButton title="Settings" active={showSettings} onClick={() => setShowSettings(!showSettings)}>
            <FiSettings />
          </IconButton>
          {bridge && (
            <>
              <IconButton
                title="Lock (click-through). Unlock with the hotkey."
                onClick={() => bridge!.setClickThrough(true)}
              >
                <FiUnlock />
              </IconButton>
              <IconButton title="Open full guide" onClick={() => bridge!.openGuide()}>
                <FiMaximize2 />
              </IconButton>
              <IconButton title="Hide overlay" onClick={() => bridge!.hide()}>
                <FiEyeOff />
              </IconButton>
            </>
          )}
        </div>
        {locked && (
          <span className={styles.lockBadge} title="Click-through on">
            <FiLock />
          </span>
        )}
      </DragHeader>

      {showSettings && (
        <Settings
          prefs={prefs}
          setPrefs={setPrefs}
          bridgeState={bridgeState}
          liveArea={liveArea}
        />
      )}

      <ol className={styles.steps}>
        {finished && <li className={styles.current}>All steps complete. GG.</li>}
        {visible.map((f, i) => (
          <li
            key={f.key}
            className={classNames(i === 0 ? styles.current : styles.upcoming)}
            onClick={i === 0 ? next : undefined}
          >
            {f.step.type === "fragment_step" ? (
              <FragmentStep step={f.step} />
            ) : (
              <GemReward
                requiredGem={f.step.requiredGem}
                count={f.step.count}
                rewardType={f.step.rewardType}
              />
            )}
          </li>
        ))}
      </ol>

      {prefs.showLayout && zoneArea && (
        <div className={styles.layout}>
          <div className={styles.layoutTitle}>
            {zoneArea.name}
            {liveArea && <span className={styles.liveDot} title="Live from Client.txt" />}
          </div>
          {zoneArea.is_town_area ? null : layout ? (
            <>
              {layout.images.length > 0 && (
                <div className={styles.layoutImages}>
                  {layout.images.map((src, i) => (
                    <img key={i} src={src} alt="" />
                  ))}
                </div>
              )}
              {layout.notes.map((n, i) => (
                <p key={i} className={styles.layoutNote}>
                  {n}
                </p>
              ))}
            </>
          ) : (
            <p className={styles.layoutNote}>No layout notes for this zone.</p>
          )}
        </div>
      )}

      {bridge && <ResizeGrip />}
    </div>
  );
}

// ---------------------------------------------------------------------------

function useZoneLayout(area: { act: number; name: string; is_town_area: boolean } | undefined) {
  const [layout, setLayout] = useState<ZoneLayout | undefined>();
  useEffect(() => {
    let cancelled = false;
    setLayout(undefined);
    if (!area || area.is_town_area) return;
    loadActLayouts(area.act).then((layouts) => {
      if (!cancelled) setLayout(findZoneLayout(layouts, area.name));
    });
    return () => {
      cancelled = true;
    };
  }, [area?.act, area?.name]);
  return layout;
}

function IconButton({
  title,
  active,
  onClick,
  children,
}: {
  title: string;
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      title={title}
      aria-label={title}
      className={classNames(styles.iconButton, { [styles.active]: active })}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
      {children}
    </button>
  );
}

/**
 * Manual drag instead of `-webkit-app-region: drag`: the overlay window is
 * non-focusable on Windows (so clicking it never steals focus from the game),
 * and pointer-driven moves are reliable in that mode.
 */
function DragHeader({ children }: { children: React.ReactNode }) {
  const onPointerDown = async (e: React.PointerEvent<HTMLDivElement>) => {
    if (!bridge || (e.target as HTMLElement).closest("[data-nodrag]")) return;
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const start = await bridge.getBounds();
    const sx = e.screenX;
    const sy = e.screenY;
    const move = (ev: PointerEvent) =>
      bridge!.setBounds({
        x: Math.round(start.x + ev.screenX - sx),
        y: Math.round(start.y + ev.screenY - sy),
      });
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };
  return (
    <div className={styles.header} onPointerDown={onPointerDown}>
      {children}
    </div>
  );
}

/** Transparent windows can't be resized from their edges on Windows. */
function ResizeGrip() {
  const onPointerDown = async (e: React.PointerEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const start = await bridge!.getBounds();
    const sx = e.screenX;
    const sy = e.screenY;
    const move = (ev: PointerEvent) =>
      bridge!.setBounds({
        width: Math.max(260, Math.round(start.width + ev.screenX - sx)),
        height: Math.max(120, Math.round(start.height + ev.screenY - sy)),
      });
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };
  return <div className={styles.grip} onPointerDown={onPointerDown} title="Resize" />;
}

function Settings({
  prefs,
  setPrefs,
  bridgeState,
  liveArea,
}: {
  prefs: OverlayPrefs;
  setPrefs: (p: Partial<OverlayPrefs>) => void;
  bridgeState: OverlayState | null;
  liveArea: AreaEvent | null;
}) {
  return (
    <div className={styles.settings} data-nodrag>
      <label>
        Background
        <input
          type="range"
          min={0.2}
          max={1}
          step={0.05}
          value={prefs.opacity}
          onChange={(e) => setPrefs({ opacity: Number(e.target.value) })}
        />
      </label>
      <label>
        Text size
        <input
          type="range"
          min={0.8}
          max={1.6}
          step={0.05}
          value={prefs.fontScale}
          onChange={(e) => setPrefs({ fontScale: Number(e.target.value) })}
        />
      </label>
      <label>
        Upcoming steps
        <input
          type="range"
          min={0}
          max={8}
          step={1}
          value={prefs.upcoming}
          onChange={(e) => setPrefs({ upcoming: Number(e.target.value) })}
        />
        <span>{prefs.upcoming}</span>
      </label>
      {bridge && (
        <>
          <label>
            <input
              type="checkbox"
              checked={prefs.autoAdvance}
              onChange={(e) => setPrefs({ autoAdvance: e.target.checked })}
            />
            Auto-advance on zone change
          </label>
          <div className={styles.settingsRow}>
            <span className={styles.muted}>
              Client.txt:{" "}
              {bridgeState?.clientLogPath ? (
                liveArea ? "connected" : "watching…"
              ) : (
                "not found"
              )}
            </span>
            <button className={styles.textButton} onClick={() => bridge!.chooseClientLog()}>
              Choose…
            </button>
          </div>
          {bridgeState && (
            <div className={styles.hotkeys}>
              {Object.entries(bridgeState.hotkeys).map(([action, key]) => (
                <div key={action}>
                  <kbd>{key}</kbd> {HOTKEY_LABELS[action] ?? action}
                </div>
              ))}
              {bridgeState.hotkeyErrors.map((err) => (
                <div key={err} className={styles.error}>
                  {err}
                </div>
              ))}
              <div className={styles.muted}>Edit hotkeys from the tray icon → Settings file.</div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

const HOTKEY_LABELS: Record<string, string> = {
  next: "complete step",
  back: "previous step",
  toggleLayout: "toggle layout",
  toggleClickThrough: "lock / unlock",
  toggleVisible: "show / hide",
};
