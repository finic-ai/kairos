import type { Executor } from "../platform/database";
import { DatabaseService } from "../platform/orm";

export class ModelArtifactsService extends DatabaseService<"modelArtifacts"> {
  constructor(db: Executor, scope: { workspaceId: string; environmentId: string }) {
    super(db, "modelArtifacts", scope);
  }

  async findFile(sha256: string): Promise<Buffer | null> {
    const r = await this.findFirst({ where: { sha256 }, columns: { file: true } });
    return r ? r.file : null;
  }

  async findSamples(sha256: string): Promise<Buffer | null> {
    const r = await this.findFirst({ where: { sha256 }, columns: { samples: true } });
    return r ? r.samples : null;
  }

  async store(
    values: {
      sha256: string;
      format: "xgboost-json" | "logistic-json";
      file: Buffer;
      size: number;
      samples: Buffer;
      sampleCount: number;
    },
    now: Date,
  ): Promise<boolean> {
    return this.createIfMissing({ ...values, storedSize: values.file.length }, now, ["sha256"]);
  }
}
