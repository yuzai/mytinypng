---
name: compress-images
description: Compress and optimize images in a folder to TinyPNG-level quality with no visible loss. Use when the user wants to compress, optimize, shrink, minify, or reduce the size of images, PNGs, JPEGs, screenshots, icons, or web assets in a directory. Safely skips images it has already compressed, so repeated runs never degrade quality.
---

# Compress images

Batch-compress images to **TinyPNG-quality** using the `mytinypng` CLI (sharp + mozjpeg for JPEG, libimagequant + oxipng for PNG). Output quality has been validated head-to-head against the real TinyPNG API (equal perceptual quality, equal-or-smaller files). Runs are **idempotent**: a content-hash cache records every output, so the same image is never compressed twice (lossy re-compression silently degrades quality each pass — this prevents that).

## When to use

- "compress / optimize / shrink the images in `<dir>`"
- "reduce the size of these PNGs/JPEGs/screenshots/assets"
- shrinking assets before committing, building, or shipping

## How to run

1. **Confirm the target directory** (default: the current directory) and whether overwriting in place is OK. If overwriting, recommend a clean git working tree first so the changes are reviewable.

2. **Compress in place (idempotent):**
   ```bash
   npx mytinypng@latest <dir> -r -w --cache
   ```
   - `-r` recurse into subdirectories
   - `-w` overwrite the originals in place (minimal downstream changes)
   - `--cache` writes `.mytinypng-cache.json` in the working dir; on later runs, files whose hash matches a previous output are skipped (printed as `already compressed`)

   If `mytinypng` is installed in the project, call it directly (`mytinypng ...` or `pnpm exec mytinypng ...`). When developing inside this monorepo before publish, use `node packages/cli/dist/cli.js ...` (after `pnpm --filter mytinypng build`).

3. **Report** the printed summary (files compressed, cached, total `before → after  −NN%`).

## Non-destructive alternatives

- Omit `-w` → writes `name.min.ext` next to each original (originals untouched).
- `-o <outdir>` → mirror the input tree into a separate folder, compressed.

## Useful options

- `--smart` — per-image adaptive quality: smallest size that keeps perceptual SSIM ≥ 0.99 (closest to TinyPNG's behavior)
- `-q <1-100>` — fixed quality (default is tuned per format)
- `--to webp|avif|jpeg|png` — also convert format
- `--lossless` — no quality loss at all
- `--dry-run` — preview the savings without writing anything
- `--force` — re-process even files in the cache

## Guarantees

- **Never grows a file:** if compression can't beat the original, the original is kept unchanged.
- **Color-safe:** strips bulky EXIF/XMP metadata but preserves the ICC color profile and bakes in EXIF orientation.
- **Idempotent:** keep `.mytinypng-cache.json` alongside the images; it's what makes re-runs safe.
