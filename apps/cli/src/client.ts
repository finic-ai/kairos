import { gzipSync } from "node:zlib";
import { CliError } from "./args";
import type { Connection } from "./config";

export class ApiError extends CliError {
  constructor(
    readonly status: number,
    readonly type: string,
    message: string,
  ) {
    super(message);
  }
}

export type Query = Record<string, string | number | boolean | string[] | undefined>;

export interface RequestOptions {
  body?: unknown;
  query?: Query;
  /** Send no key and no session, as for signing in. */
  anonymous?: boolean;
  gzip?: boolean;
}

const SESSION_COOKIE = "kairos_session";

export class Client {
  constructor(
    readonly conn: Connection,
    private readonly doFetch: typeof fetch = fetch,
  ) {}

  get hasSession(): boolean {
    return !this.conn.apiKey && !!this.conn.session;
  }

  async request<T = any>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    return (await this.send<T>(method, path, options)).data;
  }

  /** The answer with its headers, for the session cookie that signing in sets. */
  async send<T = any>(method: string, path: string, options: RequestOptions = {}) {
    const url = new URL(this.conn.url + path);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value === undefined || value === "") continue;
      for (const one of Array.isArray(value) ? value : [value]) url.searchParams.append(key, String(one));
    }
    const headers: Record<string, string> = { Accept: "application/json" };
    if (options.body !== undefined) headers["Content-Type"] = "application/json";
    if (options.gzip) headers["Content-Encoding"] = "gzip";
    if (!options.anonymous) Object.assign(headers, this.credentials());
    const json = options.body === undefined ? undefined : JSON.stringify(options.body);

    let response: Response;
    try {
      response = await this.doFetch(url, {
        method,
        headers,
        body: json === undefined ? undefined : options.gzip ? new Uint8Array(gzipSync(json)) : json,
        signal: AbortSignal.timeout(60_000),
      });
    } catch (cause) {
      if ((cause as Error).name === "TimeoutError") throw new CliError(`${url.origin} did not answer in 60 seconds`);
      throw new CliError(`Cannot reach a Kairos server at ${this.conn.url}. Start one with "kairos server".`);
    }

    const text = await response.text();
    let data: any = undefined;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    if (!response.ok) {
      const type: string = data?.error?.type ?? "http_error";
      let message: string = data?.error?.message ?? `${response.status} ${response.statusText}`;
      if (response.status === 401 && !path.startsWith("/auth/login")) message += `. Run "kairos login".`;
      if (type === "public_key_scope") message += ` Sign in with a secret key (ksk_…) or an email address.`;
      throw new ApiError(response.status, type, message);
    }
    return { data: data as T, response };
  }

  private credentials(): Record<string, string> {
    const { apiKey, session, workspace, environment } = this.conn;
    if (apiKey) return { Authorization: `Bearer ${apiKey}` };
    if (!session) return {};
    return {
      Cookie: `${SESSION_COOKIE}=${session}`,
      ...(workspace ? { "X-Kairos-Workspace": workspace } : {}),
      ...(environment ? { "X-Kairos-Environment": environment } : {}),
    };
  }

  /** `/app/workspaces/<id>`: needs a session, because an API key cannot manage a workspace. */
  workspacePath(): string {
    if (!this.hasSession)
      throw new CliError(
        `This command needs you to sign in with your email address: "kairos login --email you@example.com". An API key can only use the data API.`,
      );
    if (!this.conn.workspace) throw new CliError(`Choose a workspace first: "kairos use --workspace <name>".`);
    return `/app/workspaces/${encodeURIComponent(this.conn.workspace)}`;
  }
}

export function sessionFrom(response: Response): string | undefined {
  for (const cookie of response.headers.getSetCookie()) {
    const match = new RegExp(`^${SESSION_COOKIE}=([^;]*)`).exec(cookie);
    if (match?.[1]) return decodeURIComponent(match[1]);
  }
  return undefined;
}
