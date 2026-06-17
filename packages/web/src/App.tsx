import JSZip from "jszip";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Compressor } from "./lib/compressor";
import { humanSize, savedPct } from "./lib/format";
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
}

const FORMATS: { value: OutFormat; label: string }[] = [
  { value: "keep", label: "Keep" },
  { value: "png", label: "PNG" },
  { value: "jpeg", label: "JPEG" },
  { value: "webp", label: "WebP" },
];

const IMAGE_RE = /\.(png|jpe?g|webp|avif|gif)$/i;
let uid = 1;

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

  const settings = useMemo<CompressSettings>(
    () => ({ format, quality: customQuality ? quality : undefined }),
    [format, quality, customQuality],
  );
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  useEffect(() => () => compressor.current?.dispose(), []);

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
      const fresh: Item[] = images.map((file) => ({
        id: uid++,
        file,
        outputName: file.name,
        status: "working",
        originalSize: file.size,
        compressedSize: 0,
        skipped: false,
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
    for (const it of current) if (it.url) URL.revokeObjectURL(it.url);
    setItems((prev) =>
      prev.map((it) => ({ ...it, status: "working", url: undefined, outBlob: undefined })),
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

  return (
    <div className="app">
      <header className="hero">
        <h1>
          my<span>tiny</span>png
        </h1>
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
        {items.map((it) => (
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
                  <span className="muted">compressing… {humanSize(it.originalSize)}</span>
                )}
              </div>
            </div>
            {it.status === "done" && it.url && (
              <a className="dl" href={it.url} download={it.outputName}>
                Download
              </a>
            )}
          </li>
        ))}
      </ul>

      <footer className="foot">
        Powered by mozjpeg · libwebp · oxipng · image-q (WebAssembly). 100% client-side.
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
