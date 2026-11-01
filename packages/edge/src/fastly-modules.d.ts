declare module "fastly:secret-store" {
  export class SecretStore {
    constructor(name: string);
    get(key: string): Promise<{ plaintext(): string } | null>;
  }
}

declare module "fastly:cache" {
  export class SimpleCache {
    static getOrSet(
      key: string,
      set: () => Promise<{ value: string; ttl: number }>,
    ): Promise<{ text(): Promise<string> }>;
  }
}

declare module "fastly:html-rewriter" {
  export class HTMLRewritingStream extends TransformStream<Uint8Array, Uint8Array> {
    onElement(selector: string, handler: (element: { append(content: string): void }) => void): this;
  }
}
