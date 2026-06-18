import JSZip from "jszip";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Compressor } from "./lib/compressor";
import { humanSize, savedPct } from "./lib/format";
import { estimateMs, progressPct } from "./lib/progress";
import type { CompressSettings, OutFormat } from "./types";

interface Item {
  id: number;
  file: File;
  outputName: string;
  status: "working" | "done" | "error";
  originalSize: number;
  compressedSize: number;
  outBlob?: Blob;
  url?: string;
  skipped: boolean;
  error?: string;
  /** ms timestamp when this job started compressing — paces the progress bar. */
  startedAt: number;
}

const FORMATS: { value: OutFormat; label: string }[] = [
  { value: "keep", label: "Keep" },
  { value: "png", label: "PNG" },
  { value: "jpeg", label: "JPEG" },
  { value: "webp", label: "WebP" },
];

const IMAGE_RE = /\.(png|jpe?g|webp|avif|gif)$/i;
const REPO_URL = "https://github.com/yuzai/mytinypng";
let uid = 1;

/** GitHub mark — official octicon path. */
function GitHubMark() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z"
      />
    </svg>
  );
}

export function App() {
  const compressor = useRef<Compressor | null>(null);
  if (!compressor.current) compressor.current = new Compressor();

  const [items, setItems] = useState<Item[]>([]);
  const itemsRef = useRef<Item[]>([]);
  itemsRef.current = items;
  const [format, setFormat] = useState<OutFormat>("keep");
  const [customQuality, setCustomQuality] = useState(false);
  const [quality, setQuality] = useState(80);
  const [dragging, setDragging] = useState(false);
  const [zipping, setZipping] = useState(false);
  const [now, setNow] = useState(0);

  const settings = useMemo<CompressSettings>(
    () => ({ format, quality: customQuality ? quality : undefined }),
    [format, quality, customQuality],
  );
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  // Own the worker pool's lifecycle here. React StrictMode (dev) mounts twice:
  // it runs this cleanup — which terminates the workers — then re-runs the
  // effect. Without re-creating the pool (and nulling the ref so the next
  // compress sees it's gone), `compressor.current` would keep pointing at a
  // disposed pool, so every job would post to a dead worker and hang forever.
  useEffect(() => {
    if (!compressor.current) compressor.current = new Compressor();
    return () => {
      compressor.current?.dispose();
      compressor.current = null;
    };
  }, []);

  const update = useCallback((id: number, patch: Partial<Item>) => {
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, ...patch } : it)));
  }, []);

  const runOne = useCallback(
    async (id: number, file: File) => {
      try {
        const res = await compressor.current!.compress(file, settingsRef.current);
        if (!res.ok || !res.buffer) {
          update(id, { status: "error", error: res.error ?? "failed" });
          return;
        }
        const blob = new Blob([res.buffer], { type: res.outType });
        update(id, {
          status: "done",
          outputName: res.name,
          compressedSize: res.compressedSize,
          outBlob: blob,
          url: URL.createObjectURL(blob),
          skipped: res.skipped,
        });
      } catch (e) {
        update(id, { status: "error", error: (e as Error).message });
      }
    },
    [update],
  );

  const addFiles = useCallback(
    (files: File[]) => {
      const images = files.filter((f) => f.type.startsWith("image/") || IMAGE_RE.test(f.name));
      const startedAt = Date.now();
      const fresh: Item[] = images.map((file) => ({
        id: uid++,
        file,
        outputName: file.name,
        status: "working",
        originalSize: file.size,
        compressedSize: 0,
        skipped: false,
        startedAt,
      }));
      setItems((prev) => [...prev, ...fresh]);
      for (const it of fresh) void runOne(it.id, it.file);
    },
    [runOne],
  );

  const recompressAll = useCallback(() => {
    // Side effects (revoke URLs, launch work) must stay OUT of the state updater
    // — under StrictMode an impure updater runs twice and double-compresses.
    const current = itemsRef.current;
    const startedAt = Date.now();
    for (const it of current) if (it.url) URL.revokeObjectURL(it.url);
    setItems((prev) =>
      prev.map((it) => ({ ...it, status: "working", url: undefined, outBlob: undefined, startedAt })),
    );
    for (const it of current) void runOne(it.id, it.file);
  }, [runOne]);

  const clearAll = useCallback(() => {
    setItems((prev) => {
      for (const it of prev) if (it.url) URL.revokeObjectURL(it.url);
      return [];
    });
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      addFiles(Array.from(e.dataTransfer.files));
    },
    [addFiles],
  );

  const downloadZip = useCallback(async () => {
    const done = items.filter((it) => it.status === "done" && it.outBlob);
    if (done.length === 0) return;
    setZipping(true);
    try {
      const zip = new JSZip();
      const seen = new Map<string, number>();
      for (const it of done) {
        let name = it.outputName;
        const n = seen.get(name) ?? 0; // de-dupe identical names
        if (n > 0) {
          const dot = name.lastIndexOf(".");
          name = dot > 0 ? `${name.slice(0, dot)}-${n}${name.slice(dot)}` : `${name}-${n}`;
        }
        seen.set(it.outputName, n + 1);
        zip.file(name, it.outBlob as Blob);
      }
      const blob = await zip.generateAsync({ type: "blob" });
      triggerDownload(URL.createObjectURL(blob), "mytinypng.zip");
    } finally {
      setZipping(false);
    }
  }, [items]);

  const totals = useMemo(() => {
    const done = items.filter((it) => it.status === "done");
    const orig = done.reduce((s, it) => s + it.originalSize, 0);
    const comp = done.reduce((s, it) => s + it.compressedSize, 0);
    return { count: done.length, orig, comp, saved: savedPct(orig, comp) };
  }, [items]);

  const working = items.some((it) => it.status === "working");

  // Tick a shared clock while anything is compressing so the progress bars
  // animate. One interval for the whole list — rows derive their own elapsed
  // time from it, so we never mutate `items` per frame.
  useEffect(() => {
    if (!working) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 120);
    return () => window.clearInterval(id);
  }, [working]);

  return (
    <div className="app">
      <header className="hero">
        <div className="hero-row">
          <h1>
            my<span>tiny</span>png
          </h1>
          <a
            className="gh"
            href={REPO_URL}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Star mytinypng on GitHub — opens in a new tab"
          >
            <GitHubMark />
            <span>Star on GitHub</span>
          </a>
        </div>
        <p>
          TinyPNG-quality compression that runs <strong>entirely in your browser</strong>. Your
          images never leave your device.
        </p>
      </header>

      <section className="controls">
        <div className="seg" role="group" aria-label="Output format">
          {FORMATS.map((f) => (
            <button
              key={f.value}
              className={format === f.value ? "active" : ""}
              onClick={() => setFormat(f.value)}
            >
              {f.label}
            </button>
          ))}
        </div>
        <label className="quality">
          <input
            type="checkbox"
            checked={customQuality}
            onChange={(e) => setCustomQuality(e.target.checked)}
          />
          Quality
          <input
            type="range"
            min={40}
            max={95}
            value={quality}
            disabled={!customQuality}
            onChange={(e) => setQuality(Number(e.target.value))}
          />
          <span>{customQuality ? quality : "auto"}</span>
        </label>
        {items.length > 0 && (
          <div className="actions">
            <button onClick={recompressAll} disabled={working}>
              Re-compress
            </button>
            <button onClick={clearAll}>Clear</button>
          </div>
        )}
      </section>

      <label
        className={`dropzone${dragging ? " over" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        <input
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => {
            addFiles(Array.from(e.target.files ?? []));
            e.target.value = "";
          }}
        />
        <span className="big">Drop images here</span>
        <span className="small">or click to choose — PNG, JPEG, WebP, GIF, AVIF</span>
      </label>

      {items.length > 0 && (
        <section className="summary">
          <div>
            <strong>{totals.count}</strong> done
            {working ? " · compressing…" : ""}
          </div>
          <div>
            {humanSize(totals.orig)} → {humanSize(totals.comp)}{" "}
            <span className="save">−{totals.saved}%</span>
          </div>
          <button className="primary" onClick={downloadZip} disabled={zipping || totals.count === 0}>
            {zipping ? "Zipping…" : `Download all (.zip)`}
          </button>
        </section>
      )}

      <ul className="list">
        {items.map((it) => {
          const elapsed = it.status === "working" ? Math.max(0, now - it.startedAt) : 0;
          const pct =
            it.status === "working"
              ? progressPct(elapsed, estimateMs(it.originalSize, it.file.type))
              : 0;
          return (
            <li key={it.id} className={`row ${it.status}`}>
              <div className="thumb">{it.url ? <img src={it.url} alt="" /> : <div className="spin" />}</div>
              <div className="meta">
                <div className="name">{it.outputName}</div>
                <div className="sizes">
                  {it.status === "done" ? (
                    <>
                      {humanSize(it.originalSize)} → {humanSize(it.compressedSize)}{" "}
                      {it.skipped ? (
                        <span className="kept">already optimal</span>
                      ) : (
                        <span className="save">−{savedPct(it.originalSize, it.compressedSize)}%</span>
                      )}
                    </>
                  ) : it.status === "error" ? (
                    <span className="err">{it.error}</span>
                  ) : (
                    <span className="muted">
                      compressing… {elapsed > 400 ? `${(elapsed / 1000).toFixed(1)}s` : humanSize(it.originalSize)} ·{" "}
                      {pct}%
                    </span>
                  )}
                </div>
                {it.status === "working" && (
                  <div className="bar" aria-hidden="true">
                    <i style={{ width: `${pct}%` }} />
                  </div>
                )}
              </div>
              {it.status === "done" && it.url && (
                <a className="dl" href={it.url} download={it.outputName}>
                  Download
                </a>
              )}
            </li>
          );
        })}
      </ul>

      <footer className="foot">
        <p>Powered by mozjpeg · libwebp · oxipng · image-q (WebAssembly). 100% client-side.</p>
        <p className="foot-links">
          <a href={REPO_URL} target="_blank" rel="noopener noreferrer">
            <GitHubMark />
            Source on GitHub
          </a>
          <span aria-hidden="true">·</span>
          <a href={`${REPO_URL}/blob/main/LICENSE`} target="_blank" rel="noopener noreferrer">
            Open source, MIT
          </a>
          <span aria-hidden="true">·</span>
          <a href={`${REPO_URL}/issues`} target="_blank" rel="noopener noreferrer">
            Report an issue
          </a>
        </p>
      </footer>
    </div>
  );
}

function triggerDownload(url: string, filename: string) {
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
