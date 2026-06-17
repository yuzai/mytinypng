import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Pure static build (relative base so it works on any host / subpath).
// The jSquash codecs ship their own .wasm and load it via `import.meta.url`;
// excluding them from dep pre-bundling lets Vite emit those wasm assets as-is.
export default defineConfig({
  base: "./",
  plugins: [react()],
  worker: { format: "es" },
  optimizeDeps: {
    exclude: [
      "@jsquash/jpeg",
      "@jsquash/png",
      "@jsquash/webp",
      "@jsquash/oxipng",
    ],
  },
  build: {
    target: "es2022",
  },
});
