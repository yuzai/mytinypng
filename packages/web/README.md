# @mytinypng/web

A privacy-first image compressor that runs **entirely in the browser** — TinyPNG-quality, nothing uploaded. React + Vite, compiles to a pure static site.

Compression happens in a Web Worker via WebAssembly codecs: `@jsquash/jpeg` (mozjpeg) and `@jsquash/webp` (libwebp) — the same encoders as the Node engine — and for PNG, `image-q` palette quantization → `@jsquash/png` → `@jsquash/oxipng`. Output keeps the original filename so it drops back in place; batches download as a ZIP.

> Because images are decoded through a canvas, the browser app is **not color-managed**: embedded ICC profiles are not preserved. For wide-gamut sources (Display-P3 / AdobeRGB), use the `mytinypng` CLI, which keeps the ICC profile.

```bash
pnpm install
pnpm --filter @mytinypng/web dev       # http://localhost:5173
pnpm --filter @mytinypng/web build     # static output -> packages/web/dist
pnpm --filter @mytinypng/web preview    # serve the built site
```

The `dist/` output is fully static — deploy it to Cloudflare Pages, GitHub Pages, Netlify, or any static host.
