import { defineConfig } from "vite";

export default defineConfig({
  esbuild: { jsx: "automatic", jsxImportSource: "preact" },
  build: { outDir: "dist", emptyOutDir: true },
});
