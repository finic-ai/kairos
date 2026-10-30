import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

type App = { request: (input: string | URL | Request, init?: RequestInit) => Response | Promise<Response> };

/** An MCP client connected to the app in this process, as the agent with `key`. */
export async function mcpClient(app: App, key: string): Promise<Client> {
  const client = new Client({ name: "test-agent", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("http://kairos.test/mcp"), {
      requestInit: { headers: { Authorization: `Bearer ${key}` } },
      fetch: (url, init) => Promise.resolve(app.request(String(url), init)),
    }),
  );
  return client;
}

/** The JSON of a tool's text result. */
export const resultOf = (result: Awaited<ReturnType<Client["callTool"]>>) =>
  JSON.parse((result.content as { type: string; text: string }[])[0]!.text);
