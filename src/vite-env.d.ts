/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_WS_URL?: string
  /** Dev only: Kalshi watcher host (default localhost). */
  readonly VITE_WATCH_HOST?: string
  /** Dev only: Kalshi watcher WS port (default 3001). */
  readonly VITE_WATCH_PORT?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
