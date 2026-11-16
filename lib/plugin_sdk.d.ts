/** @atrium/sdk — plugin registration primitives (CommonJS runtime: lib/plugin_sdk.js). */

export type DockAnchor =
  | 'top-left'
  | 'top-right'
  | 'bottom-left'
  | 'bottom-right';

export interface Disposable {
  dispose(): void;
}

export interface AtriumPlugin {
  id: string;
  name: string;
  version: string;
  activate?(ctx: AtriumContext): void | Promise<void>;
  deactivate?(ctx: AtriumContext): void | Promise<void>;
}

/**
 * Overlay input is pointer, keyboard, and touch.
 * `raw` is for an external client that takes its own keyboard (Ghostty).
 * Gamepad is not a plugin input. The only pad chord is Start+Select, handled
 * by the shell to open and close the overlay.
 */
export type ContributionInputMode = 'pointer' | 'raw';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PaneHandle {
  id: string;
  localId: string;
  readonly visible: boolean;
  setVisible(visible: boolean): void;
  setRect(x: number, y: number, width: number, height: number): void;
  raw?: unknown;
}

export type ContributionContent =
  | { kind: 'servo'; entry: string }
  | {
      kind: 'external';
      command?: string;
      cmd?: string;
      args?: string[];
      env?: Record<string, string>;
      dbus?: Record<string, unknown>;
      clientSizing?: 'dock' | 'reference' | { width: number; height: number };
      clientUpscale?: 'bilinear' | 'sgsr';
      lazy?: boolean;
      ensure?: () => Promise<unknown>;
      spawn?: Record<string, unknown>;
    };

export interface ContributionHandle extends Disposable {
  id: string;
  update(partial: { label?: string; icon?: string | null; sortKey?: number }): void;
  focus(): Promise<void>;
}

export interface GameOverlayHandle extends Disposable {
  id: string;
  /** Rest-size in game mode. The shell still owns the well rect while the overlay is open. */
  setRestSize(size: { width?: number; height?: number }): void;
  setShown(on: boolean): void;
}

export interface AtriumContext {
  readonly id: string;
  readonly dir: string;
  readonly manifest: Record<string, unknown>;
  readonly shell: AtriumShellApi;
  log(...args: unknown[]): void;

  /** Host-owned nav contribution. No coordinates — shell places the content slot. */
  registerContribution(spec: {
    id: string;
    label?: string;
    title?: string;
    icon?: string;
    sortKey?: number;
    content: ContributionContent;
    input?: { mode?: ContributionInputMode };
    onFocusChange?: (focused: boolean) => void;
  }): Promise<ContributionHandle>;

  /**
   * Game-mode floating surface. Plugin owns the rest rect; shell moves a linked
   * overlay into the reserved preview well when its contribution is selected.
   */
  registerGameOverlay(spec: {
    id?: string;
    entry: string;
    anchor?: DockAnchor;
    width?: number;
    height?: number;
    defaultVisible?: boolean;
    linkedContribution?: string | null;
    /** Well placement: natural (default, rest-sized preview) or stretch (fill well). */
    wellFit?: 'natural' | 'stretch';
    layoutRect?: (win: unknown) => Rect;
  }): Promise<GameOverlayHandle>;

  /**
   * Pin a quick action in the bottom-right socket. The shell shows at most three.
   */
  registerAction(spec: {
    id: string;
    label?: string;
    icon?: string | null;
    badge?: string | number | null;
    onTap?: () => void;
  }): Disposable;

  getPane(localId: string): PaneHandle | null;
  destroyPane(localId: string): void;
  createSurfacePane(
    localId: string,
    options: {
      entry: string;
      defaultRect?: Rect;
      layer?: 'hud' | 'drawer' | 'shell';
      zIndex?: number;
      visibility?: 'overlay-only' | 'game-only' | 'always';
      interactive?: 'overlay-only' | 'never' | 'always';
      reposition?: (pane: PaneHandle, win: unknown) => void;
    }
  ): Promise<PaneHandle>;
  createExternalPane(
    localId: string,
    options: {
      command: string;
      args?: string[];
      env?: Record<string, string>;
      defaultRect?: Rect;
      layer?: 'drawer' | 'hud';
      visibility?: 'overlay-only' | 'game-only';
      interactive?: 'overlay-only' | 'never';
      clientSizing?: 'dock' | 'reference' | 'fixed';
      dbus?: Record<string, unknown>;
      reposition?: (pane: PaneHandle, win: unknown) => void;
    }
  ): Promise<PaneHandle>;

  ipc: {
    send(channel: string, data?: unknown): void;
    /** Adds a listener. More than one handler per channel is allowed. */
    on(channel: string, handler: (data: unknown) => void): Disposable;
  };

  storage: {
    get(key: string, fallback?: unknown): unknown;
    set(key: string, value: unknown): void;
  };

  notify(opts?: {
    title?: string;
    body?: string;
    icon?: string | null;
    urgency?: 'low' | 'normal' | 'critical';
    timeoutMs?: number;
  }): unknown;

  telemetry: {
    onFrameStats(cb: (stats: Record<string, unknown>) => void): Disposable;
  };

  /**
   * Shell event subscription. Disposed with the plugin.
   * Not a controller bus — pad actions are not emitted here.
   */
  subscribe(event: string, handler: (payload: unknown) => void): Disposable;

  disposeAll(): void;
}

export interface AtriumShellApi {
  mode: 'game' | 'overlay' | 'edit';
  setMode(mode: 'game' | 'overlay' | 'edit'): void;
  selectDockSlot(key: string): Promise<void>;
  getDockSlot?(key: string): { key: string; label: string; localId: string } | null;
  getUpscale(): Record<string, unknown>;
  applyUpscale(
    partial: Record<string, unknown>,
    opts?: { persist?: boolean }
  ): Record<string, unknown>;
  on(event: string, handler: (payload: unknown) => void): unknown;
  off(event: string, handler: (payload: unknown) => void): unknown;
}

export function installPluginSdk(ctx: AtriumContext): AtriumContext;
