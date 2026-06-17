import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

/**
 * Lossless PNG post-optimization via oxipng (the same WASM codec the web build
 * uses, so quality is identical across Node and browser). It re-derives optimal
 * PNG filters + DEFLATE without touching pixels, squeezing a few extra percent
 * out of sharp's palette output — this is what closes the size gap to TinyPNG.
 *
 * @jsquash/oxipng is browser-first and tries to `fetch()` its wasm; in Node we
 * must compile the wasm from disk and hand it to `init()` once.
 */

export interface OxipngOptions {
  /** Optimization level 1..6 (higher = smaller + slower). Default 3. */
  level?: number;
  /** Optimize the color of fully-transparent pixels for better compression. */
  optimiseAlpha?: boolean;
}

let modPromise: Promise<typeof import("@jsquash/oxipng/optimise.js")> | null = null;

async function getModule() {
  const mod = await import("@jsquash/oxipng/optimise.js");
  const require = createRequire(import.meta.url);
  const wasmPath = require.resolve(
    "@jsquash/oxipng/codec/pkg/squoosh_oxipng_bg.wasm",
  );
  await mod.init(await WebAssembly.compile(await readFile(wasmPath)));
  return mod;
}

/** Losslessly shrink a PNG buffer. Returns the input unchanged on failure. */
export async function oxipng(
  png: Buffer,
  options: OxipngOptions = {},
): Promise<Buffer> {
  modPromise ??= getModule();
  const mod = await modPromise;
  // Hand oxipng a tight ArrayBuffer view (Node Buffers sit in a shared pool).
  const ab = png.buffer.slice(
    png.byteOffset,
    png.byteOffset + png.byteLength,
  ) as ArrayBuffer;
  const out = await mod.default(ab, {
    level: options.level ?? 3,
    interlace: false,
    optimiseAlpha: options.optimiseAlpha ?? true,
  });
  return Buffer.from(out);
}
