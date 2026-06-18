# mytinypng-core

The image-compression engine behind [mytinypng](https://www.npmjs.com/package/mytinypng) — TinyPNG-quality output with one API. Built on `sharp` (libvips): mozjpeg for JPEG, libimagequant for PNG, libwebp/AVIF, plus a lossless `oxipng` post-pass on PNG.

```ts
import { compress } from "mytinypng-core";

const result = await compress(inputBufferOrPath, {
  format: "keep",      // "jpeg" | "png" | "webp" | "avif" | "keep" (default)
  quality: 80,         // 1..100 — omit for tuned per-format defaults
  mode: "lossy",       // or "lossless"
  targetSsim: 0.99,    // smart mode: smallest output keeping perceptual SSIM ≥ this
  maxWidth: 2000,      // optional downscale (never enlarges)
  stripMetadata: true, // strip EXIF/XMP, keep ICC + bake EXIF orientation (default)
  pngOptimize: true,   // lossless oxipng pass on PNG (default)
});

result.data;           // Buffer (the original bytes if `skipped`)
result.format;         // output format
result.originalSize;   // bytes
result.compressedSize; // bytes
result.ratio;          // 0..1 saved
result.skipped;        // true if compression couldn't beat the original
```

Returns buffers and does no file I/O, so it's shared by the CLI, the AI skill, and a server.

### Behavior

- **Never larger:** if the re-encode can't beat the input (same format, no resize), the original is returned with `skipped: true`.
- **Color-safe:** strips bulky metadata but preserves the ICC profile and bakes EXIF orientation into pixels.
- **Smart mode:** with `targetSsim`, binary-searches quality for the smallest output that stays above a perceptual SSIM threshold (a light blur is applied before SSIM so palette dither / JPEG grain doesn't fool the metric).

Also exports `ssim`, `oxipng`, `detectFormat`, `DEFAULT_QUALITY`, and the option/result types.

## License

MIT
