# mytinypng

TinyPNG-quality batch image compression — as a CLI and a library. Re-encodes JPEG with mozjpeg, PNG with libimagequant + oxipng, and WebP/AVIF with libvips. Validated head-to-head against the real TinyPNG API (equal perceptual quality, equal-or-smaller files).

## CLI

```bash
npx mytinypng <files | globs | dirs...> [options]
```

```bash
npx mytinypng image.png                 # -> image.min.png (never overwrites by default)
npx mytinypng "src/**/*.{png,jpg}" -w    # overwrite matches in place
npx mytinypng photos/ -r -o dist/        # mirror photos/ into dist/, compressed
npx mytinypng hero.png --to webp         # convert format
npx mytinypng banner.png --smart         # per-image adaptive quality (SSIM target)
npx mytinypng assets/ -r -w --cache      # idempotent — skip already-compressed files
```

### Options

| Option | Description |
| ------ | ----------- |
| `-o, --output <dir>` | Write into `<dir>`, mirroring the input's relative path |
| `-w, --overwrite` | Overwrite the originals in place |
| `--suffix <s>` | Suffix for the default (non-overwrite) mode — default `.min` |
| `-q, --quality <1-100>` | Fixed quality (default: tuned per format) |
| `--smart` / `--ssim <0-1>` | Smallest output keeping perceptual SSIM ≥ target (default 0.99) |
| `--lossless` | No quality loss |
| `--skip-oxipng` | Skip the lossless PNG post-pass (faster) |
| `--cache` / `--cache-file <p>` | Skip files already compressed by us (content-hash manifest) |
| `--force` | Re-process even if cached |
| `-f, --to <fmt>` | Convert to `jpeg` \| `png` \| `webp` \| `avif` |
| `-r, --recursive` | Recurse into directories |
| `--concurrency <n>` | Parallel files (default: CPU cores) |
| `--dry-run` / `--json` / `--quiet` | Preview / machine-readable / summary-only |

By default it writes a `*.min.ext` copy and **never touches the original**. Use `-w` to overwrite. It never produces a larger file — if compression can't beat the input, the original is kept.

> **Idempotency:** with `--overwrite`, repeated runs would re-compress already-compressed files and slowly degrade them. `--cache` prevents this by recording the sha256 of every output and skipping matches on the next run.

## Library

```ts
import { compress } from "mytinypng"; // re-exports @mytinypng/core

const { data, compressedSize, ratio, skipped } = await compress(buffer, {
  format: "keep",      // "jpeg" | "png" | "webp" | "avif"
  quality: 80,         // omit for per-format defaults
  targetSsim: 0.99,    // optional smart mode
});
```

## License

MIT
