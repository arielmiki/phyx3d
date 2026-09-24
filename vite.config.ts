import { defineConfig } from "vite";

export default defineConfig({
  root: "web",
  publicDir: "public",
  build: { outDir: "../dist/web", emptyOutDir: true, chunkSizeWarningLimit: 4000 },
  server: { port: 5173, proxy: { "/api": "http://127.0.0.1:5217" } },
  worker: { format: "es" },
});
