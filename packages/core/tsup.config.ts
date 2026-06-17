import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  target: "node18",
  // Inject import.meta.url / __dirname so createRequire works in the CJS build.
  shims: true,
  // Native / wasm deps resolved at runtime — never bundle them.
  external: ["sharp", "@jsquash/oxipng"],
});
