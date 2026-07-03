/// <reference types="vite/client" />

/** Injected by Vite's `define` from package.json version. */
declare const __APP_VERSION__: string

declare module '*?worker&url' {
  const url: string
  export default url
}
