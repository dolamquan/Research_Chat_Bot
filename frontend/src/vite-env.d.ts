/// <reference types="vite/client" />

// Vite's client types cover `?raw` / `?url` imports and `import.meta.env`.
// The two declarations below cover what they do not.

// Side-effect stylesheet imports (`import "./notes.css"`), which Vite handles
// but TypeScript has no module for.
declare module "*.css";

// The Figma asset namespace resolved by `figmaAssetResolver` in vite.config.js.
declare module "figma:asset/*" {
  const source: string;
  export default source;
}
