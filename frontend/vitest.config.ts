import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

// Scene fixtures live in the backend test directory and are imported by the
// frontend tests, so both sides validate the same JSON. `fs.allow` lets Vite
// read outside the frontend root for that.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    server: { deps: { inline: [/@react-three/] } },
  },
  server: {
    fs: { allow: [path.resolve(__dirname), path.resolve(__dirname, "..", "backend")] },
  },
});
