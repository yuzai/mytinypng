import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { cpus } from "node:os";
import {
  basename,
  dirname,
  extname,
  join,
  relative,
  resolve,
} from "node:path";
import { parseArgs } from "node:util";
import {
  type CompressOptions,
  type ImageFormat,
  compress,
  extensionForFormat,
} from "mytinypng-core";
import { glob } from "tinyglobby";

declare const __VERSION__: string;
const VERSION = typeof __VERSION__ === "string" ? __VERSION__ : "0.0.0-dev";

const SUPPORTED_INPUT = /\.(png|jpe?g|webp|avif|gif|tiff?)$/i;
const OUTPUT_FORMATS = new Set<ImageFormat>(["jpeg", "png", "webp", "avif"]);

export interface RunResult {
  /** Process exit code. */
  code: number;
}

const HELP = `mytinypng — TinyPNG-quality batch image compression

Usage:
  mytinypng <files | globs | dirs...> [options]

Output (default: writes alongside originals with a ".min" suffix — never overwrites):
  -o, --output <dir>     Write into <dir>, mirroring the input's relative path
  -w, --overwrite        Overwrite the original files in place
      --suffix <s>       Suffix for the default mode (default: ".min")

Quality:
  -q, --quality <1-100>  Fixed quality (default: tuned per format)
      --smart            Smart mode: smallest output keeping perceptual SSIM >= target
      --ssim <0-1>       SSIM target for --smart (default: 0.99)
      --lossless         Lossless mode (no quality loss)
      --skip-oxipng      Skip the lossless PNG post-pass (faster, slightly larger)

Idempotency (avoid re-compressing — important with --overwrite, lossy re-compression degrades):
      --cache            Skip files we've already compressed (content-hash manifest)
      --cache-file <p>   Manifest path (default: ./.mytinypng-cache.json; implies --cache)
      --force            Re-process even if a file is in the cache

Format & traversal:
  -f, --to <fmt>         Convert output to jpeg | png | webp | avif
  -r, --recursive        Recurse into directories
      --concurrency <n>  Parallel files (default: CPU cores)

Reporting:
      --dry-run          Compress and report, but write nothing
      --json             Emit machine-readable JSON results
      --quiet            Only print the summary
  -h, --help             Show this help
  -v, --version          Show version

Examples:
  mytinypng image.png                 # -> image.min.png
  mytinypng "src/**/*.{png,jpg}" -w   # overwrite all matches in place
  mytinypng photos/ -r -o dist/       # mirror photos/ into dist/, compressed
  mytinypng hero.png --to webp        # -> hero.webp
  mytinypng banner.png --smart --ssim 0.98
`;

interface ParsedOptions {
  inputs: string[];
  output?: string;
  overwrite: boolean;
  suffix: string;
  quality?: number;
  smart: boolean;
  ssim: number;
  lossless: boolean;
  skipOxipng: boolean;
  cache: boolean;
  cacheFile?: string;
  force: boolean;
  to?: ImageFormat;
  recursive: boolean;
  concurrency: number;
  dryRun: boolean;
  json: boolean;
  quiet: boolean;
}

function parse(argv: string[]): ParsedOptions {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      output: { type: "string", short: "o" },
      overwrite: { type: "boolean", short: "w", default: false },
      suffix: { type: "string", default: ".min" },
      quality: { type: "string", short: "q" },
      smart: { type: "boolean", default: false },
      ssim: { type: "string" },
      lossless: { type: "boolean", default: false },
      "skip-oxipng": { type: "boolean", default: false },
      cache: { type: "boolean", default: false },
      "cache-file": { type: "string" },
      force: { type: "boolean", default: false },
      to: { type: "string", short: "f" },
      recursive: { type: "boolean", short: "r", default: false },
      concurrency: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      quiet: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", short: "v", default: false },
    },
  });

  if (values.help) {
    process.stdout.write(HELP);
    process.exit(0);
  }
  if (values.version) {
    process.stdout.write(`${VERSION}\n`);
    process.exit(0);
  }

  const quality = values.quality != null ? Number(values.quality) : undefined;
  if (quality != null && (!Number.isFinite(quality) || quality < 1 || quality > 100)) {
    throw new Error(`--quality must be 1..100, got "${values.quality}"`);
  }
  const ssim = values.ssim != null ? Number(values.ssim) : 0.99;
  if (!Number.isFinite(ssim) || ssim <= 0 || ssim > 1) {
    throw new Error(`--ssim must be in (0, 1], got "${values.ssim}"`);
  }
  let to: ImageFormat | undefined;
  if (values.to != null) {
    const f = values.to.toLowerCase() === "jpg" ? "jpeg" : values.to.toLowerCase();
    if (!OUTPUT_FORMATS.has(f as ImageFormat)) {
      throw new Error(`--to must be one of jpeg|png|webp|avif, got "${values.to}"`);
    }
    to = f as ImageFormat;
  }
  const concurrency = values.concurrency != null ? Number(values.concurrency) : cpus().length;
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(`--concurrency must be a positive integer, got "${values.concurrency}"`);
  }
  if (values.overwrite && values.output) {
    throw new Error("Use either --overwrite or --output, not both.");
  }
  if (values.smart && values.lossless) {
    throw new Error("--smart (perceptual quality search) cannot be combined with --lossless.");
  }

  return {
    inputs: positionals,
    output: values.output,
    overwrite: values.overwrite ?? false,
    suffix: values.suffix ?? ".min",
    quality,
    smart: values.smart ?? false,
    ssim,
    lossless: values.lossless ?? false,
    skipOxipng: values["skip-oxipng"] ?? false,
    cache: (values.cache ?? false) || values["cache-file"] != null,
    cacheFile: values["cache-file"],
    force: values.force ?? false,
    to,
    recursive: values.recursive ?? false,
    concurrency,
    dryRun: values["dry-run"] ?? false,
    json: values.json ?? false,
    quiet: values.quiet ?? false,
  };
}

interface InputFile {
  /** Absolute path to the image. */
  file: string;
  /** Absolute base the file is relative to (its dir arg, or a glob's prefix). */
  base: string;
}

/** The static path prefix of a glob, before the first wildcard segment. */
function globBase(pattern: string): string {
  const stable: string[] = [];
  for (const seg of pattern.split("/")) {
    if (/[*?{}[\]]/.test(seg)) break;
    stable.push(seg);
  }
  return resolve(stable.join("/") || ".");
}

/** Expand files/dirs/globs into a de-duplicated list, tracking each file's base. */
async function resolveInputs(inputs: string[], recursive: boolean): Promise<InputFile[]> {
  const out: InputFile[] = [];
  const seen = new Set<string>();
  const add = (file: string, base: string) => {
    if (SUPPORTED_INPUT.test(file) && !seen.has(file)) {
      seen.add(file);
      out.push({ file, base });
    }
  };

  for (const input of inputs) {
    const isGlob = /[*?{}[\]]/.test(input);
    let pattern: string;
    let base: string;

    if (isGlob) {
      pattern = input;
      base = globBase(input);
    } else {
      try {
        const s = await stat(input);
        if (!s.isDirectory()) {
          add(resolve(input), dirname(resolve(input)));
          continue;
        }
        pattern = join(input, recursive ? "**/*" : "*");
        base = resolve(input);
      } catch {
        continue; // non-existent
      }
    }

    const matched = await glob(pattern, { absolute: true, onlyFiles: true, dot: false });
    for (const f of matched) add(f, base);
  }

  return out.sort((a, b) => a.file.localeCompare(b.file));
}

function outputPathFor(file: string, base: string, opts: ParsedOptions): string {
  const origExt = extname(file);
  const ext = opts.to ? extensionForFormat(opts.to) : origExt;
  const stem = basename(file, origExt);

  if (opts.overwrite) return join(dirname(file), stem + ext);

  if (opts.output) {
    const rel = relative(base, file);
    const safeRel = rel.startsWith("..") ? basename(file) : rel; // outside base → flatten
    return join(resolve(opts.output), dirname(safeRel), stem + ext);
  }

  // Default: alongside the original, always with the suffix so we never clobber
  // an unrelated existing file (e.g. `a.png --to jpeg` must not overwrite a.jpg).
  return join(dirname(file), stem + opts.suffix + ext);
}

interface FileResult {
  input: string;
  output: string;
  originalSize: number;
  compressedSize: number;
  ratio: number;
  skipped: boolean;
  /** True when skipped because it was already compressed by us (cache hit). */
  cached?: boolean;
  error?: string;
}

interface CacheCtx {
  enabled: boolean;
  path: string;
  /** sha256 of every output we've produced — a file matching one is "ours". */
  hashes: Set<string>;
  dirty: boolean;
}

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

const pathExists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );

/** Append -1, -2, … before the extension until the path is unused. */
function disambiguate(path: string, used: Set<string>): string {
  if (!used.has(path)) return path;
  const ext = extname(path);
  const stem = path.slice(0, path.length - ext.length);
  let n = 1;
  let candidate: string;
  do {
    candidate = `${stem}-${n++}${ext}`;
  } while (used.has(candidate));
  return candidate;
}

async function processFile(
  entry: InputFile,
  output: string,
  opts: ParsedOptions,
  cache: CacheCtx,
): Promise<FileResult> {
  const { file } = entry;
  const buf = await readFile(file);

  // Already one of our outputs → skip, so repeated runs never re-compress
  // (lossy re-compression would quietly degrade quality each pass).
  if (cache.enabled && !opts.force && cache.hashes.has(sha256(buf))) {
    return {
      input: file,
      output: file,
      originalSize: buf.length,
      compressedSize: buf.length,
      ratio: 0,
      skipped: true,
      cached: true,
    };
  }

  const options: CompressOptions = {
    format: opts.to ?? "keep",
    quality: opts.quality,
    mode: opts.lossless ? "lossless" : "lossy",
    targetSsim: opts.smart ? opts.ssim : undefined,
    pngOptimize: !opts.skipOxipng,
  };
  const result = await compress(buf, options);

  if (!opts.dryRun) {
    // Skip rewriting an unchanged file onto itself in overwrite mode.
    if (!(result.skipped && output === file)) {
      await mkdir(dirname(output), { recursive: true });
      await writeFile(output, result.data);
    }
  }

  if (cache.enabled) {
    cache.hashes.add(sha256(result.data));
    cache.dirty = true;
  }

  return {
    input: file,
    output,
    originalSize: result.originalSize,
    compressedSize: result.compressedSize,
    ratio: result.ratio,
    skipped: result.skipped,
  };
}

async function pool<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i]);
    }
  });
  await Promise.all(runners);
  return results;
}

const kb = (n: number) => `${(n / 1024).toFixed(1)}kB`;
const pct = (r: number) => `${(r * 100).toFixed(0)}%`;

/** Programmatic entry point for the CLI. Returns an exit code; does not exit. */
export async function run(argv: string[]): Promise<RunResult> {
  let opts: ParsedOptions;
  try {
    opts = parse(argv);
  } catch (e) {
    process.stderr.write(`error: ${(e as Error).message}\n`);
    return { code: 2 };
  }

  if (opts.inputs.length === 0) {
    process.stderr.write("error: no input files. See --help.\n");
    return { code: 2 };
  }

  const files = await resolveInputs(opts.inputs, opts.recursive);
  if (files.length === 0) {
    process.stderr.write("error: no matching image files found.\n");
    return { code: 1 };
  }

  const cache: CacheCtx = {
    enabled: opts.cache,
    path: resolve(opts.cacheFile ?? ".mytinypng-cache.json"),
    hashes: new Set(),
    dirty: false,
  };
  if (cache.enabled) {
    try {
      const m = JSON.parse(await readFile(cache.path, "utf8")) as { hashes?: string[] };
      for (const h of m.hashes ?? []) cache.hashes.add(h);
    } catch {
      /* no manifest yet */
    }
  }

  // Plan output paths up front: resolve intra-run collisions (two inputs that
  // map to the same output) and refuse to silently clobber an unrelated file
  // when an in-place format conversion retargets to a different existing path.
  const usedOutputs = new Set<string>();
  const plan: Array<{ entry: InputFile; output: string; skipReason?: string }> = [];
  for (const entry of files) {
    let output = outputPathFor(entry.file, entry.base, opts);
    if (output !== entry.file) output = disambiguate(output, usedOutputs);
    usedOutputs.add(output);

    let skipReason: string | undefined;
    if (
      opts.overwrite &&
      !opts.force &&
      !opts.dryRun &&
      output !== entry.file &&
      (await pathExists(output))
    ) {
      skipReason = `would overwrite existing ${relative(process.cwd(), output)} (use --force)`;
    }
    plan.push({ entry, output, skipReason });
  }

  const results = await pool(plan, opts.concurrency, async ({ entry, output, skipReason }) => {
    if (skipReason) {
      return {
        input: entry.file,
        output,
        originalSize: 0,
        compressedSize: 0,
        ratio: 0,
        skipped: false,
        error: skipReason,
      } satisfies FileResult;
    }
    try {
      return await processFile(entry, output, opts, cache);
    } catch (e) {
      return {
        input: entry.file,
        output: entry.file,
        originalSize: 0,
        compressedSize: 0,
        ratio: 0,
        skipped: false,
        error: (e as Error).message,
      } satisfies FileResult;
    }
  });

  if (cache.enabled && cache.dirty && !opts.dryRun) {
    await writeFile(cache.path, `${JSON.stringify({ version: 1, hashes: [...cache.hashes] })}\n`);
  }

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
  } else if (!opts.quiet) {
    for (const r of results) {
      if (r.error) {
        process.stdout.write(`✗ ${relative(process.cwd(), r.input)}  ${r.error}\n`);
      } else if (r.cached) {
        process.stdout.write(
          `⋯ ${relative(process.cwd(), r.input)}  already compressed (skipped)\n`,
        );
      } else if (r.skipped) {
        process.stdout.write(
          `· ${relative(process.cwd(), r.input)}  ${kb(r.originalSize)} (kept original)\n`,
        );
      } else {
        process.stdout.write(
          `✓ ${relative(process.cwd(), r.output)}  ${kb(r.originalSize)} → ${kb(r.compressedSize)}  −${pct(r.ratio)}\n`,
        );
      }
    }
  }

  const ok = results.filter((r) => !r.error);
  const failed = results.length - ok.length;
  const cachedCount = ok.filter((r) => r.cached).length;
  const processed = ok.filter((r) => !r.cached);
  const totalOrig = processed.reduce((s, r) => s + r.originalSize, 0);
  const totalNew = processed.reduce((s, r) => s + r.compressedSize, 0);
  const overall = totalOrig > 0 ? 1 - totalNew / totalOrig : 0;

  if (!opts.json) {
    process.stdout.write(
      `\n${processed.length} compressed` +
        `${cachedCount ? `, ${cachedCount} cached` : ""}` +
        `${failed ? `, ${failed} failed` : ""}` +
        `${opts.dryRun ? " [dry-run]" : ""}: ${kb(totalOrig)} → ${kb(totalNew)}  −${pct(overall)} overall\n`,
    );
  }

  return { code: failed > 0 ? 1 : 0 };
}
