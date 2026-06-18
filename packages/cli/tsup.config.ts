import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

export default defineConfig({
  entry: { index: "src/index.ts", cli: "src/cli.ts" },
  format: ["esm", "cjs"],
  dts: { entry: "src/index.ts" },
  clean: true,
  sourcemap: true,
  target: "node18",
  shims: true,
  define: { __VERSION__: JSON.stringify(pkg.version) },
  external: ["sharp", "@jsquash/oxipng", "mytinypng-core"],
});
