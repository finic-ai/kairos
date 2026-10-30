import type { XgboostModel } from "@kairos/core";

const BYTES_PER_NODE = 17;
const MAX_BYTES = 256 * 1024 * 1024;

/** By the hash of the file. A file never changes, so nothing expires: only the size limit removes a model. */
export class ModelCache {
  private readonly models = new Map<string, XgboostModel>();
  private readonly loading = new Map<string, Promise<XgboostModel>>();
  private bytes = 0;

  constructor(private readonly maxBytes = MAX_BYTES) {}

  async get(sha256: string, load: () => Promise<XgboostModel>): Promise<XgboostModel> {
    const found = this.models.get(sha256);
    if (found) {
      // A Map keeps the order of insertion: the last one is the one used most recently.
      this.models.delete(sha256);
      this.models.set(sha256, found);
      return found;
    }
    const pending = this.loading.get(sha256);
    if (pending) return pending;
    const loaded = load().finally(() => this.loading.delete(sha256));
    this.loading.set(sha256, loaded);
    const model = await loaded;
    this.add(sha256, model);
    return model;
  }

  get size() {
    return this.models.size;
  }

  private add(sha256: string, model: XgboostModel) {
    if (this.models.has(sha256)) return;
    this.models.set(sha256, model);
    this.bytes += model.nodes * BYTES_PER_NODE;
    for (const [key, old] of this.models) {
      if (this.bytes <= this.maxBytes || key === sha256) break;
      this.models.delete(key);
      this.bytes -= old.nodes * BYTES_PER_NODE;
    }
  }
}

export const modelCache = new ModelCache();
