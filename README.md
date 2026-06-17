# mytinypng

**TinyPNG-quality image compression** — as a Node engine, a CLI/library, an AI skill, and a browser app. Quality has been validated head-to-head against the real TinyPNG API: **equal perceptual quality, total size −0.6%** across a mixed test set.

```
┌─ @mytinypng/core ─ the engine (sharp + mozjpeg + libimagequant + oxipng)
│
├─ mytinypng ─────── CLI + library (batch compress; --cache; --smart)
├─ compress-images ─ AI skill (Claude Code) that drives the CLI on a folder
└─ @mytinypng/web ── React + Vite static site, 100% client-side WASM
```

## Why it matches TinyPNG

TinyPNG's results come from two well-known techniques; this uses the same ones:

| Format | Technique | Library (Node & browser) |
| ------ | --------- | ------------------------ |
| **JPEG** | mozjpeg re-encode (trellis quant, optimized Huffman, progressive) | sharp (mozjpeg) / `@jsquash/jpeg` |
| **PNG** | lossy palette quantization + lossless filter/DEFLATE optimization | sharp (libimagequant) + oxipng / `image-q` + `@jsquash/oxipng` |
| **WebP** | libwebp | sharp / `@jsquash/webp` |

Plus TinyPNG's safety behaviors: **never output a larger file**, strip bulky EXIF/XMP metadata but **keep the ICC color profile** and bake in EXIF orientation.

### Validated, not assumed

The repo includes a real head-to-head harness (`packages/core/bench/compare-tinypng.ts`). It runs the same images through the **real TinyPNG API** and our engine, measures byte size and a perceptual SSIM (light blur before SSIM, so dither grain doesn't fool the metric), and writes a side-by-side gallery. On a 9-image set (photos, screenshots, UI graphics, transparent PNGs): quality tied per-image, total bytes −0.6%.

## The four deliverables

### 1. `@mytinypng/core` — the engine

```ts
import { compress } from "@mytinypng/core";

const result = await compress(inputBufferOrPath, {
  format: "keep",        // or "jpeg" | "png" | "webp" | "avif"
  quality: 80,           // omit for tuned per-format defaults
  targetSsim: 0.99,      // optional "smart" mode: smallest size at this quality
  // mode: "lossless", maxWidth, maxHeight, stripMetadata, pngOptimize, ...
});
// result.data (Buffer), .compressedSize, .ratio, .skipped, ...
```

### 2. `mytinypng` — CLI + library

```bash
npx mytinypng image.png                 # -> image.min.png (non-destructive)
npx mytinypng "src/**/*.{png,jpg}" -w    # overwrite all matches in place
npx mytinypng photos/ -r -o dist/        # mirror photos/ into dist/, compressed
npx mytinypng hero.png --to webp         # convert
npx mytinypng banner.png --smart         # per-image adaptive quality
npx mytinypng assets/ -r -w --cache      # idempotent: skip already-compressed
```

`--cache` writes `.mytinypng-cache.json` (sha256 of every output); on later runs, matching files are skipped so repeated runs never re-compress (and never degrade). Also usable as a library: `import { compress } from "mytinypng"`.

### 3. `compress-images` — AI skill

[`.claude/skills/compress-images/SKILL.md`](.claude/skills/compress-images/SKILL.md). Ask Claude Code to "compress/optimize the images in this folder" and it runs the CLI in place with `--cache`, reporting savings — and won't re-compress already-done files.

### 4. `@mytinypng/web` — browser app

A pure static site. Drag in images → they're compressed **entirely in your browser** (WebAssembly in a worker; nothing is uploaded) → download (keeps the original filename so it drops back in place; ZIP for batches).

```bash
pnpm --filter @mytinypng/web dev       # local dev
pnpm --filter @mytinypng/web build     # static output in packages/web/dist (deploy anywhere)
```

## Development

```bash
pnpm install
pnpm -r build          # build all packages
pnpm -r test           # run all tests
pnpm --filter @mytinypng/core bench    # quality sweep on fixtures
pnpm --filter @mytinypng/core compare  # head-to-head vs real TinyPNG (needs TINIFY_KEY)
```

The head-to-head needs a free TinyPNG API key (https://tinypng.com/developers, 500/mo) in a gitignored root `.env`:

```
TINIFY_KEY=your_key_here
```

Results are cached by content hash in `bench/.tinycache/`, so re-runs cost no quota.

## License

MIT
