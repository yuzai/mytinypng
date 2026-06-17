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
      const onMessage = (e: MessageEvent<CompressResponse>) => {
        if (e.data.id !== id) return;
        worker.removeEventListener("message", onMessage);
        this.release(worker);
        resolve(e.data);
      };
      worker.addEventListener("message", onMessage);
      worker.postMessage(req, [buffer]);
    });
  }

  dispose(): void {
    for (const w of this.all) w.terminate();
  }
}
