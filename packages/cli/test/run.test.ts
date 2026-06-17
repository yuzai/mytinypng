import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run } from "../src/run.js";

let dir: string;

/** A truecolor gradient PNG that compresses well (so it won't be "skipped"). */
async function writePng(path: string, w = 300, h = 300): Promise<void> {
  const buf = Buffer.alloc(w * h * 3);
  let i = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      buf[i++] = (x * 255) / w;
      buf[i++] = (y * 255) / h;
      buf[i++] = ((x + y) * 255) / (w + h);
    }
  }
  await sharp(buf, { raw: { width: w, height: h, channels: 3 } }).png().toFile(path);
}

const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );

describe("cli run()", () => {
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "mytinypng-test-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("default: writes a .min copy and leaves the original untouched", async () => {
    const src = join(dir, "a.png");
    await writePng(src);
    const before = (await stat(src)).size;

    const { code } = await run([src, "--quiet"]);
    expect(code).toBe(0);

    const out = join(dir, "a.min.png");
    expect(await exists(out)).toBe(true);
    expect((await stat(out)).size).toBeLessThan(before);
    expect((await stat(src)).size).toBe(before); // original unchanged
  });

  it("--overwrite replaces the original in place", async () => {
    const src = join(dir, "b.png");
    await writePng(src);
    const before = (await stat(src)).size;

    const { code } = await run([src, "-w", "--quiet"]);
    expect(code).toBe(0);
    expect((await stat(src)).size).toBeLessThan(before);
    expect(await exists(join(dir, "b.min.png"))).toBe(false);
  });

  it("--to converts format to a suffixed file (non-destructive default)", async () => {
    const src = join(dir, "c.png");
    await writePng(src);

    const { code } = await run([src, "--to", "webp", "--quiet"]);
    expect(code).toBe(0);

    const out = join(dir, "c.min.webp"); // suffixed so it can't clobber an existing c.webp
    expect(await exists(out)).toBe(true);
    const meta = await sharp(await readFile(out)).metadata();
    expect(meta.format).toBe("webp");
  });

  it("--dry-run writes nothing", async () => {
    const src = join(dir, "d.png");
    await writePng(src);
    const { code } = await run([src, "--dry-run", "--quiet"]);
    expect(code).toBe(0);
    expect(await exists(join(dir, "d.min.png"))).toBe(false);
  });

  it("processes a directory recursively and mirrors into --output", async () => {
    await writePng(join(dir, "one.png"));
    const sub = join(dir, "sub");
    await mkdir(sub, { recursive: true });
    await writePng(join(sub, "two.png"));

    const outDir = join(dir, "out");
    const { code } = await run([dir, "-r", "-o", outDir, "--quiet"]);
    expect(code).toBe(0);
    expect(await exists(join(outDir, "one.png"))).toBe(true);
    expect(await exists(join(outDir, "sub", "two.png"))).toBe(true);
  });

  it("returns exit code 1 when there are no matching files", async () => {
    const { code } = await run([join(dir, "nope-*.png"), "--quiet"]);
    expect(code).toBe(1);
  });

  it("default mode never clobbers an unrelated existing file on format conversion", async () => {
    const src = join(dir, "a.png");
    await writePng(src);
    const existing = join(dir, "a.jpg");
    await writeFile(existing, "PRE-EXISTING"); // unrelated file at the convert target

    const { code } = await run([src, "--to", "jpeg", "--quiet"]);
    expect(code).toBe(0);
    expect(await readFile(existing, "utf8")).toBe("PRE-EXISTING"); // untouched
    expect(await exists(join(dir, "a.min.jpg"))).toBe(true); // suffixed instead
  });

  it("--overwrite + --to refuses to clobber a different existing file (without --force)", async () => {
    const src = join(dir, "b.png");
    await writePng(src);
    const existing = join(dir, "b.jpg");
    await writeFile(existing, "PRE-EXISTING");

    const { code } = await run([src, "--to", "jpeg", "-w", "--quiet"]);
    expect(code).toBe(1); // reported as a failure, not silently destroyed
    expect(await readFile(existing, "utf8")).toBe("PRE-EXISTING");

    const forced = await run([src, "--to", "jpeg", "-w", "--force", "--quiet"]);
    expect(forced.code).toBe(0);
    expect(await readFile(existing, "utf8")).not.toBe("PRE-EXISTING"); // now overwritten
  });

  it("disambiguates two inputs that map to the same output path", async () => {
    const x = join(dir, "x");
    const y = join(dir, "y");
    await mkdir(x, { recursive: true });
    await mkdir(y, { recursive: true });
    await writePng(join(x, "same.png"));
    await writePng(join(y, "same.png"));
    const out = join(dir, "out");

    const { code } = await run([join(x, "same.png"), join(y, "same.png"), "-o", out, "--quiet"]);
    expect(code).toBe(0);
    expect(await exists(join(out, "same.png"))).toBe(true);
    expect(await exists(join(out, "same-1.png"))).toBe(true); // second one disambiguated
  });

  it("rejects --smart combined with --lossless", async () => {
    const src = join(dir, "s.png");
    await writePng(src);
    const { code } = await run([src, "--smart", "--lossless", "--quiet"]);
    expect(code).toBe(2); // parse error, not silently ignored
  });

  it("--cache skips a file we already compressed (no re-compress on rerun)", async () => {
    const src = join(dir, "e.png");
    await writePng(src);
    const cacheFile = join(dir, "cache.json");

    await run([src, "-w", "--cache-file", cacheFile, "--quiet"]);
    const sizeAfterFirst = (await stat(src)).size;

    // Second run: src is now our own output → must be recognized and skipped.
    const writes: string[] = [];
    const spy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((s: string | Uint8Array) => {
        writes.push(String(s));
        return true;
      });
    const { code } = await run([src, "-w", "--cache-file", cacheFile, "--json"]);
    spy.mockRestore();

    expect(code).toBe(0);
    const json = JSON.parse(writes.join(""));
    expect(json[0].cached).toBe(true);
    expect((await stat(src)).size).toBe(sizeAfterFirst); // untouched, not re-compressed
  });
});
