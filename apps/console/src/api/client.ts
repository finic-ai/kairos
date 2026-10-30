import { queryClient } from "../lib/queryClient";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export const SIGNED_OUT = "kairos:signed-out";

let workspace: string | null = null;
let environment: string | null = null;
export const setEnvironment = (id: string | null) => void (environment = id);
export const currentEnvironment = () => environment;
export const setWorkspace = (id: string | null) => void (workspace = id);
export const currentWorkspace = () => workspace;
export const apiHeaders = (): Record<string, string> => ({
  ...(workspace ? { "X-Kairos-Workspace": workspace } : {}),
  ...(environment ? { "X-Kairos-Environment": environment } : {}),
});

export async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  { changes = method !== "GET" }: { changes?: boolean } = {},
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers: {
        ...(path.startsWith("/v1/") || path.startsWith("/app/") ? apiHeaders() : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, "The Kairos API is not reachable. Is the server running?");
  }
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 401 && !path.startsWith("/auth/")) window.dispatchEvent(new Event(SIGNED_OUT));
    throw new ApiError(
      response.status,
      data?.error?.message ??
        (response.status >= 500
          ? "The Kairos API is not reachable. Is the server running?"
          : `Request failed (${response.status})`),
    );
  }
  // A change can show on any page: what is cached is asked for again when it is next shown.
  if (changes) void queryClient.invalidateQueries();
  return data as T;
}

export async function requestBlob(path: string): Promise<Blob> {
  const response = await fetch(path, { headers: apiHeaders() });
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw new ApiError(response.status, data?.error?.message ?? `Request failed (${response.status})`);
  }
  return response.blob();
}

export const workspacePath = (id: string) => `/app/workspaces/${encodeURIComponent(id)}`;
