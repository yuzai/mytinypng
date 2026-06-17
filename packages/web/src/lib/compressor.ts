import CompressWorker from "../compress.worker?worker";
import type { CompressRequest, CompressResponse, CompressSettings } from "../types";

let idSeq = 1;

function guessType(name: string): string {
  const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  if (ext === "avif") return "image/avif";
  if (ext === "gif") return "image/gif";
  return "image/jpeg";
}

/** A small worker pool that compresses files off the main thread. */
export class Compressor {
  private idle: Worker[] = [];
  private all: Worker[] = [];
  private waiters: Array<(w: Worker) => void> = [];

  constructor(size = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 1))) {
    for (let i = 0; i < size; i++) {
      const w = new CompressWorker();
      this.all.push(w);
      this.idle.push(w);
    }
  }

  private acquire(): Promise<Worker> {
    const free = this.idle.pop();
    if (free) return Promise.resolve(free);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private release(w: Worker): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter(w);
    else this.idle.push(w);
  }

  async compress(file: File, settings: CompressSettings): Promise<CompressResponse> {
    const worker = await this.acquire();
    const buffer = await file.arrayBuffer();
    const id = idSeq++;
    const req: CompressRequest = {
      id,
      name: file.name,
      type: file.type || guessType(file.name),
      buffer,
      settings,
    };

    return new Promise<CompressResponse>((resolve) => {
      const cleanup = () => {
        worker.removeEventListener("message", onMessage);
        worker.removeEventListener("error", onError);
        worker.removeEventListener("messageerror", onError);
      };
      // Resolve (never reject) so a single bad file can't crash the whole batch.
      const fail = (message: string) => {
        cleanup();
        this.release(worker);
        resolve({
          id,
          ok: false,
          name: file.name,
          outType: req.type,
          originalSize: buffer.byteLength,
          compressedSize: 0,
          skipped: false,
          error: message,
        });
      };
      const onMessage = (e: MessageEvent<CompressResponse>) => {
        if (e.data.id !== id) return;
        cleanup();
        this.release(worker);
        resolve(e.data);
      };
      // A worker that crashes/aborts (OOM, wasm abort) without replying would
      // otherwise leave this promise pending forever and leak the worker.
      const onError = (e: ErrorEvent | MessageEvent) =>
        fail((e as ErrorEvent)?.message ?? "worker crashed");

      worker.addEventListener("message", onMessage);
      worker.addEventListener("error", onError);
      worker.addEventListener("messageerror", onError);
      try {
        worker.postMessage(req, [buffer]);
      } catch (err) {
        fail((err as Error)?.message ?? "failed to dispatch to worker");
      }
    });
  }

  dispose(): void {
    for (const w of this.all) w.terminate();
  }
}
