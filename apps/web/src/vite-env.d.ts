/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

interface ImportMetaEnv {
  readonly VITE_APP_VERSION: string
  readonly VITE_APP_REPO_URL: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
