// Typed access to the API exposed by overlay/preload.cjs.
// When the app runs in a normal browser, `window.overlay` is undefined and
// the overlay view still works as a compact page (just without hotkeys,
// click-through or Client.txt auto-advance).

export type HotkeyAction = "next" | "back" | "toggleLayout";

export interface AreaEvent {
  areaId: string;
  level: number;
  /** true when read from history at startup, not a fresh zone change */
  initial: boolean;
}

export interface OverlayState {
  clickThrough: boolean;
  hotkeys: Record<string, string>;
  hotkeyErrors: string[];
  clientLogPath: string | null;
  lastArea: AreaEvent | null;
}

export interface OverlayBridge {
  isElectron: true;
  getState(): Promise<OverlayState>;
  getBounds(): Promise<{ x: number; y: number; width: number; height: number }>;
  setBounds(bounds: {
    x?: number;
    y?: number;
    width?: number;
    height?: number;
  }): void;
  setClickThrough(value: boolean): void;
  openGuide(): void;
  hide(): void;
  chooseClientLog(): void;
  onHotkey(cb: (action: HotkeyAction) => void): () => void;
  onArea(cb: (event: AreaEvent) => void): () => void;
  onState(cb: (state: OverlayState) => void): () => void;
}

declare global {
  interface Window {
    overlay?: OverlayBridge;
  }
}

export const bridge: OverlayBridge | undefined =
  typeof window !== "undefined" ? window.overlay : undefined;
