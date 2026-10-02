import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  resolve: { conditions: ["development", "browser"] },
  // The extension tests live outside this package, above Vite's default
  // filesystem root.
  server: { fs: { allow: [".."] } },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    // The browser extension ships as plain ES modules with no build step of
    // its own, so its pure logic is tested by this project rather than a
    // second runner.
    include: ["src/**/*.{test,spec}.{ts,tsx}", "../browser-extension/**/*.{test,spec}.ts"],
    server: { deps: { inline: [/@react-three/] } },
  },
});
