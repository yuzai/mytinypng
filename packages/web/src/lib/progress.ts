// Estimated compression progress for a single image.
//
// The WASM codecs (mozjpeg, oxipng, libwebp, image-q) don't expose intra-encode
// progress, so the bar is a deliberate *estimate* paced by elapsed-vs-expected
// time — enough to make a slow large image feel responsive. The elapsed seconds
// shown next to it are exact; only the percentage is a guess.

// Rough per-format cost in ms per input byte. PNG is slowest per byte because it
// also pays for palette quantization (image-q) + oxipng on top of the encode.
const MS_PER_BYTE = { png: 1 / 700, jpeg: 1 / 2500, webp: 1 / 1800 } as const;
type Fmt = keyof typeof MS_PER_BYTE;

const MIN_MS = 400;
const MAX_MS = 60_000;

function fmt(type: string): Fmt {
  if (type.includes("png")) return "png";
  if (type.includes("webp")) return "webp";
  return "jpeg";
}

/** Expected wall-clock to compress a file of `bytes`, used only to pace the bar.
 * Clamped so both tiny and huge files behave reasonably. */
export function estimateMs(bytes: number, type: string): number {
  const est = 250 + bytes * MS_PER_BYTE[fmt(type)];
  return Math.min(MAX_MS, Math.max(MIN_MS, est));
}

/**
 * Estimated percent complete (0–95) from elapsed and expected time. Eases toward
 * ~95% on an exponential curve and never reaches 100 — the caller snaps to 100
 * only when the job actually finishes, so a bad estimate keeps inching forward
 * rather than stalling at a fake 100%.
 */
export function progressPct(elapsedMs: number, estMs: number): number {
  if (elapsedMs <= 0) return 0;
  const p = 1 - Math.exp(-elapsedMs / (estMs * 0.4));
  return Math.min(95, Math.round(p * 100));
}
