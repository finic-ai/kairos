import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SessionTrace, spanLength } from "../src/components/sessions/SessionTrace";
import type { DecisionSummary, StoredEvent } from "../src/types/interfaces";

const at = (ms: number) => new Date(Date.UTC(2026, 10, 3, 12) + ms).toISOString();
const span = (id: string, type: string, start: number, end: number, parent?: string, extra = {}): StoredEvent => ({
  id: `e_${id}`,
  type,
  ts: at(start),
  entities: { agent: "a1" },
  properties: {},
  trace: {
    trace_id: "t1",
    span_id: id,
    ...(parent ? { parent_span_id: parent } : {}),
    name: type,
    end: at(end),
    ...extra,
  },
});
const decision: DecisionSummary = {
  id: "dec_1",
  ts: at(7_000),
  action: "agent_tool_call@1",
  subject: { type: "agent", id: "a1" },
  event_id: "e_tool2",
  decision: {
    decision: "block",
    probability: 0.97,
    risk_score: 97,
    reasons: ["tool_never_used"],
    typology: "privilege_escalation",
    rules: [],
    action: "agent_tool_call@1",
  },
};

describe("the trace of a session", () => {
  it("draws the spans under their parent, in the order they started, with the decision on its span", () => {
    const events = [
      span("tool2", "shell_exec", 6_000, 6_500, "root"),
      span("root", "invoke_agent", 0, 10_000),
      span("tool1", "read_ticket", 2_000, 2_800, "root", { status: "error" }),
      { id: "e_plain", type: "login", ts: at(0), entities: { agent: "a1" }, properties: {} },
    ];
    const html = renderToStaticMarkup(<SessionTrace events={events} decisions={[decision]} names={{}} />);
    const order = [...html.matchAll(/class="spans-label">([^<]+)</g)].map((m) => m[1]);
    expect(order).toEqual(["invoke_agent", "read_ticket", "shell_exec"]);
    expect(html).toContain("3 spans · 10.0 s");
    expect(html).toContain('class="spans-row  error"');
    expect(html).toMatch(/spans-mark t-block[^>]*>97</);
    expect(html).toContain("1 not approved");
    expect(html).toContain("1 event of this session came with no span");
  });

  it("shows nothing for a session with no spans, and survives a span that is its own parent", () => {
    const plain = [{ id: "e1", type: "login", ts: at(0), entities: { user: "u" }, properties: {} }];
    expect(renderToStaticMarkup(<SessionTrace events={plain} decisions={[]} names={{}} />)).toBe("");
    const loop = [span("x", "a", 0, 1_000, "y"), span("y", "b", 0, 1_000, "x")];
    const html = renderToStaticMarkup(<SessionTrace events={loop} decisions={[]} names={{}} />);
    expect([...html.matchAll(/class="spans-label">([^<]+)</g)].map((m) => m[1])).toEqual(["a", "b"]);
  });

  it("writes a span's length in the unit that reads best", () => {
    expect([spanLength(420), spanLength(1_500), spanLength(12_300), spanLength(95_000)]).toEqual([
      "420 ms",
      "1.50 s",
      "12.3 s",
      "1 min 35 s",
    ]);
  });
});
