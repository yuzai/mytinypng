import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { compress } from "../src/compress.js";
import { ssim } from "../src/ssim.js";

const W = 256;
const H = 256;

/** A truecolor, continuous-tone PNG that benefits from quantization. */
async function makePng(): Promise<Buffer> {
  const buf = Buffer.alloc(W * H * 3);
  let i = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      buf[i++] = (x + y) % 256;
      buf[i++] = (x * 2) % 256;
      buf[i++] = (y * 2) % 256;
    }
  }
  return sharp(buf, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
}

/** Perceptual luma: light blur so dither grain doesn't fool SSIM (see engine). */
async function lumaOf(buf: Buffer): Promise<Buffer> {
  const { data } = await sharp(buf)
    .resize(W, H, { fit: "fill" })
    .greyscale()
    .blur(1.0)
    .raw()
    .toBuffer({ resolveWithObject: true });
  return data;
}

describe("compress", () => {
  it("shrinks a truecolor PNG while staying visually lossless", async () => {
    const png = await makePng();
    const ref = await lumaOf(png);
    const r = await compress(png);

    expect(r.format).toBe("png");
    expect(r.compressedSize).toBeLessThan(png.length);
    expect(r.skipped).toBe(false);
    expect(ssim(ref, await lumaOf(r.data), W, H)).toBeGreaterThan(0.95);
  });

  it("re-encodes JPEG smaller with mozjpeg", async () => {
    const png = await makePng();
    const jpg = await sharp(png).jpeg({ quality: 95 }).toBuffer();
    const r = await compress(jpg);
    expect(r.format).toBe("jpeg");
    expect(r.compressedSize).toBeLessThan(jpg.length);
  });

  it("converts format when requested", async () => {
    const png = await makePng();
    const r = await compress(png, { format: "webp" });
    expect(r.format).toBe("webp");
    const meta = await sharp(r.data).metadata();
    expect(meta.format).toBe("webp");
  });

  it("never returns a larger file (skips when compression does not help)", async () => {
    // A tiny already-optimal image: re-encoding should not grow it.
    const small = await sharp({
      create: { width: 2, height: 2, channels: 3, background: { r: 10, g: 20, b: 30 } },
    })
      .png()
      .toBuffer();
    const r = await compress(small);
    expect(r.compressedSize).toBeLessThanOrEqual(small.length);
  });

  it("converts an undetected input format (gif) without emitting the original bytes", async () => {
    // detectFormat() returns null for gif; converting it must never let the
    // never-larger fallback return the raw, undecoded gif under a webp name.
    const gif = await sharp({
      create: { width: 8, height: 8, channels: 3, background: { r: 10, g: 200, b: 60 } },
    })
      .gif()
      .toBuffer();
    const r = await compress(gif, { format: "webp" });
    expect(r.format).toBe("webp");
    expect(r.skipped).toBe(false);
    expect((await sharp(r.data).metadata()).format).toBe("webp");
  });

  it("smart mode meets the SSIM target", async () => {
    const png = await makePng();
    const ref = await lumaOf(png);
    const r = await compress(png, { targetSsim: 0.97 });
    expect(ssim(ref, await lumaOf(r.data), W, H)).toBeGreaterThanOrEqual(0.96);
  });
});
