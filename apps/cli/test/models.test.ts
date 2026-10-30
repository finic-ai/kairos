import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "../src/client";
import type { Connection } from "../src/config";
import type { Context } from "../src/context";
import { models } from "../src/commands/models";

type Answer = { status?: number; body: unknown };
let calls: { method: string; path: string; query: string; headers: Record<string, string>; body: unknown }[];
let printed: string[];

function context(conn: Partial<Connection>, answers: Record<string, Answer>): Context {
  const doFetch = (async (url: URL, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    const raw = init.body as string | Uint8Array | undefined;
    const text = raw === undefined ? undefined : headers["Content-Encoding"] ? gunzipSync(raw).toString() : String(raw);
    const key = `${init.method} ${url.pathname}`;
    calls.push({
      method: init.method!,
      path: url.pathname,
      query: url.search,
      headers,
      body: text && JSON.parse(text),
    });
    const answer = answers[key];
    if (!answer) return new Response(JSON.stringify({ error: { type: "not_found", message: key } }), { status: 404 });
    return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200 });
  }) as unknown as typeof fetch;
  const client = new Client({ url: "http://kairos.test", ...conn }, doFetch);
  return { json: false, profile: "test", stored: () => ({}), client: () => client };
}
const session = { session: "tok", workspace: "ws_1", environment: "env_sandbox" };
const loanDefault = {
  body: { slug: "loan-default", name: "Loan default", kind: "scoring", runtime: "in_process", version: 3 },
};

beforeEach(() => {
  calls = [];
  printed = [];
  vi.spyOn(console, "log").mockImplementation((line: string) => void printed.push(String(line)));
});
afterEach(() => vi.restoreAllMocks());

describe("kairos models list", () => {
  it("sends the search and the page, and says when there are more", async () => {
    const ctx = context({ apiKey: "ksk_1" }, { "GET /v1/models": { body: { models: [loanDefault.body], total: 12 } } });
    await models(["list", "--q", "loan", "--limit", "1", "--offset", "3"], ctx);
    expect(calls[0]!.query).toBe("?q=loan&limit=1&offset=3");
    expect(printed.join("\n")).toContain("1 of 12. Use --limit and --offset for more.");
  });
});

describe("kairos models upload", () => {
  const folder = mkdtempSync(join(tmpdir(), "kairos-models-"));
  const write = (name: string, value: unknown) => {
    writeFileSync(join(folder, name), JSON.stringify(value));
    return join(folder, name);
  };
  const uploaded = { body: { version: 4, created: true, load_ms: 3 }, status: 201 };

  it("sends the upload.json of the train command with gzip, and the name given", async () => {
    const upload = write("upload.json", { name: "Old", format: "xgboost-json", model: { learner: {} }, samples: [1] });
    const ctx = context({ apiKey: "ksk_1" }, { "POST /v1/models/loan-default/versions": uploaded });
    await models(["upload", "loan-default", "--upload", upload, "--name", "Loan default"], ctx);
    expect(calls[0]!.headers["Content-Encoding"]).toBe("gzip");
    expect(calls[0]!.body).toEqual({
      name: "Loan default",
      format: "xgboost-json",
      model: { learner: {} },
      samples: [1],
    });
    expect(printed.join("\n")).toContain("loan-default@4");
  });

  it("sends a model file and its samples", async () => {
    const file = write("model.json", { learner: {} });
    const samples = write("samples.json", [{ features: {}, score: 0.5 }]);
    const ctx = context({ apiKey: "ksk_1" }, { "POST /v1/models/loan-default/versions": uploaded });
    await models(["upload", "loan-default", "--file", file, "--samples", samples], ctx);
    expect(calls[0]!.body).toEqual({
      format: "xgboost-json",
      model: { learner: {} },
      samples: [{ features: {}, score: 0.5 }],
    });
  });

  it("needs one of the two forms", async () => {
    const ctx = context({ apiKey: "ksk_1" }, {});
    await expect(models(["upload", "loan-default", "--file", "model.json"], ctx)).rejects.toThrow("--samples");
    await expect(models(["upload", "loan-default", "--upload", "a.json", "--file", "b.json"], ctx)).rejects.toThrow(
      "not both",
    );
    expect(calls).toEqual([]);
  });
});

describe("kairos models score", () => {
  it("scores with the latest version when none is given, with typed values", async () => {
    const ctx = context(
      { apiKey: "ksk_1" },
      {
        "GET /v1/models/loan-default": loanDefault,
        "POST /v1/models/loan-default/versions/3/score": {
          body: {
            score: 0.25,
            risk_score: 25,
            model: "loan-default@3",
            features: {},
            missing: ["amount"],
            invalid: [],
          },
        },
      },
    );
    await models(["score", "loan-default", "-f", "hardship=0.8", "-f", "purpose=car"], ctx);
    expect(calls[1]!.body).toEqual({ features: { hardship: 0.8, purpose: "car" } });
    expect(printed.join("\n")).toContain("0.2500");
  });

  it("refuses a version that is not a version", async () => {
    const ctx = context({ apiKey: "ksk_1" }, {});
    for (const ref of ["loan-default@", "loan-default@0", "loan-default@1@2"])
      await expect(models(["score", ref, "-f", "a=1"], ctx)).rejects.toThrow("is not a model");
    expect(calls).toEqual([]);
  });

  it("does not ask for the latest version when one is given", async () => {
    const answer = {
      body: { score: 0.5, risk_score: 50, model: "loan-default@1", features: {}, missing: [], invalid: [] },
    };
    const ctx = context({ apiKey: "ksk_1" }, { "POST /v1/models/loan-default/versions/1/score": answer });
    await models(["score", "loan-default@1", "-f", "hardship=0.1"], ctx);
    expect(calls.map((c) => c.path)).toEqual(["/v1/models/loan-default/versions/1/score"]);
  });
});

describe("kairos models promote", () => {
  const me = {
    body: {
      user: { id: "usr_1", email: "a@example.com" },
      workspaces: [
        {
          id: "ws_1",
          name: "Acme",
          role: "owner",
          environments: [
            { id: "env_prod", name: "Production", kind: "production" },
            { id: "env_sandbox", name: "Development", kind: "sandbox" },
          ],
        },
      ],
    },
  };

  it("finds the environment by its name, and promotes the version", async () => {
    const ctx = context(session, {
      "GET /auth/me": me,
      "POST /v1/models/loan-default/versions/2/promote": {
        status: 201,
        body: { created: true, version: 1, environment: "env_prod", reference: "loan-default@1" },
      },
    });
    await models(["promote", "loan-default@2", "--to", "production"], ctx);
    expect(calls[1]!.body).toEqual({ to: "env_prod" });
    expect(calls[1]!.headers["X-Kairos-Environment"]).toBe("env_sandbox");
    expect(printed.join("\n")).toContain("loan-default@1");
  });

  it("needs a session, and an environment of the workspace", async () => {
    await expect(
      models(["promote", "loan-default@2", "--to", "prod"], context({ apiKey: "ksk_1" }, {})),
    ).rejects.toThrow("kairos login --email");
    await expect(
      models(["promote", "loan-default@2", "--to", "staging"], context(session, { "GET /auth/me": me })),
    ).rejects.toThrow('No environment "staging". There is: Production, Development');
  });
});
