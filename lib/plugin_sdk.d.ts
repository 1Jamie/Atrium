/** @atrium/sdk — plugin registration primitives (CommonJS runtime: lib/plugin_sdk.js). */

export type DockAnchor =
  | 'top-left'
  | 'top-right'
  | 'bottom-left'
  | 'bottom-right';

export type AtriumControllerAction =
  | { action: 'Nav'; dir: 'up' | 'down' | 'left' | 'right' }
  | { action: 'Confirm' }
  | { action: 'Back' }
  | { action: 'TabPrev' }
  | { action: 'TabNext' }
  | { action: 'OskToggle' }
  | { action: 'ToggleOverlay' }
  | { action: string; [key: string]: unknown };

export interface Disposable {
  dispose(): void;
}

export interface AtriumPlugin {
  id: string;
  name: string;
  version: string;
  setup?(ctx: AtriumContext): void | Promise<void> | (() => void | Promise<void>);
  activate?(ctx: AtriumContext): void | Promise<void>;
  deactivate?(ctx: AtriumContext): void | Promise<void>;
}

export interface AtriumContext {
  readonly id: string;
  readonly dir: string;
  readonly manifest: Record<string, unknown>;
  readonly shell: AtriumShellApi;
  log(...args: unknown[]): void;

  registerHud(spec: {
    id: string;
    entry: string;
    anchor?: DockAnchor;
    defaultVisible?: boolean;
    width?: number;
    height?: number;
  }): Promise<Disposable>;

  registerTab(spec: {
    id: string;
    label: string;
    icon?: string;
    order?: number;
    entry: string;
    input?: {
      mode?: 'spatial' | 'cursor' | 'raw';
      handlesBack?: boolean;
      handlesTriggers?: boolean;
    };
    onFocusChange?: (focused: boolean) => void;
    defaultRect?: { x: number; y: number; width: number; height: number };
    layoutRect?: (win: unknown) => { x: number; y: number; width: number; height: number };
  }): Promise<Disposable>;

  registerPane(spec: {
    id: string;
    appId?: string;
    spawn?: { cmd?: string; command?: string; args?: string[]; env?: Record<string, string> };
    ensure?: () => Promise<unknown>;
    lazy?: boolean;
    layout?: {
      clientSizing?: 'dock' | 'reference' | 'decoupled';
      anchor?: string;
      resize?: Array<'left' | 'right' | 'top' | 'bottom'>;
    };
    dockEntry?: { label: string; icon?: string; order?: number };
    input?: Record<string, unknown>;
    onFocusChange?: (focused: boolean) => void;
    dbus?: Record<string, unknown>;
  }): Promise<Disposable>;

  onAction(
    handler: (action: AtriumControllerAction) => boolean | void
  ): Disposable;

  disposeAll(): void;
}

export interface AtriumShellApi {
  mode: 'game' | 'overlay' | 'edit';
  setMode(mode: 'game' | 'overlay' | 'edit'): void;
  addDockSlot(slot: DockSlot): void;
  removeDockSlot(key: string): void;
  selectDockSlot(key: string): Promise<void>;
  cycleDock(delta: number): Promise<void>;
  focusActiveSlot(): Promise<void>;
  dispatchAction(action: AtriumControllerAction): boolean;
  addActionHandler(pluginId: string, handler: (action: AtriumControllerAction) => boolean | void): Disposable;
}

export interface DockSlot {
  key: string;
  pluginId: string;
  localId: string;
  kind: 'tab' | 'pane';
  label: string;
  icon?: string | null;
  order?: number;
  input?: Record<string, unknown>;
  onFocusChange?: ((focused: boolean) => void) | null;
  ensure?: () => Promise<unknown>;
}

export function installPluginSdk(ctx: AtriumContext): AtriumContext;
