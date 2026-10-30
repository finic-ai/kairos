import { describe, expect, it } from "vitest";
import {
  DEFAULT_VIEW,
  definitionsFor,
  hostApproved,
  isViewPath,
  validateHosts,
  validateQueue,
  validateView,
  type CaseView,
} from "../src/index";

const onboarding: CaseView = {
  template: "onboarding_identity",
  header: ["subject.full_name", { field: "subject.country", label: "Country", format: "country" }],
  blocks: [
    { id: "why", type: "evidence", region: "main", w: 12 },
    { id: "check", type: "text", region: "main", w: 6, text: "Check that the ID matches the selfie." },
    { id: "decisions", type: "decisions", region: "main", w: 6 },
    { id: "logins", type: "list", region: "main", of: "case.target", lists: ["logins"], rows: 5 },
    { id: "facts", type: "facts", region: "side", facts: ["applications_24h", "devices"] },
    { id: "device", type: "facts", region: "side", of: "item.device" },
    { id: "money", type: "fields", region: "side", fields: ["request.amount", "decision.risk_score", "case.due"] },
  ],
  facts: [
    {
      for: "user",
      name: "applications_24h",
      label: "Applications in 24 hours",
      source: "events",
      measure: "count",
      filters: { event_type: "application" },
      window: "24h",
    },
  ],
};

describe("case views", () => {
  it("accepts a view, and the fixed page as a view", () => {
    expect(validateView(onboarding)).toEqual([]);
    expect(validateView(DEFAULT_VIEW)).toEqual([]);
  });

  it("names the paths a field can read", () => {
    for (const path of [
      "case.priority",
      "decision.risk_score",
      "signal.new_device",
      "request.amount",
      "item.device.os",
    ])
      expect([path, isViewPath(path)]).toEqual([path, true]);
    for (const path of ["case.secret", "decision", "item.device", "subject.a.b", "context.x"])
      expect([path, isViewPath(path)]).toEqual([path, false]);
  });

  it("says what is wrong with a view", () => {
    expect(
      validateView({
        header: ["case.secret"],
        blocks: [
          { id: "a", type: "decisions", region: "top" },
          { id: "a", type: "list", region: "main", w: 2, of: "user", text: "no" },
          { id: "c", type: "fields", region: "side" },
          { id: "d", type: "text", region: "side", text: " " },
        ],
        facts: [{ name: "x", label: "X", source: "events", measure: "count" }],
      }),
    ).toEqual([
      "view.header[0] must be a path such as case.priority, decision.risk_score, signal.<code>, request.<property>, event.<property>, subject.<property> or item.<type>.<property>",
      "view.blocks[0].region must be main or side",
      'view.blocks[1].id: "a" is used twice',
      "view.blocks[1].w must be a whole number from 3 to 12",
      "view.blocks[1].text is only for text",
      "view.blocks[1].of must be case.target or item.<entity type>",
      "view.blocks[2].fields must be a list of at most 16 fields",
      "view.blocks[3].text must be text of 1 to 2,000 characters",
      "view.blocks must have the evidence block: it says why the case exists",
      "view.facts[0].for must be an entity type",
    ]);
  });

  it("checks the view's own facts as an entity type's", () => {
    expect(
      validateView({
        ...onboarding,
        facts: [{ for: "user", name: "x", label: "X", source: "labels", measure: "sum", field: "amount" }],
      }),
    ).toEqual(["view.facts for user[0].measure must be one of count, first, last for labels"]);
  });

  it("is checked with the queue, under display", () => {
    const queue = {
      name: "Onboarding",
      visibility: "workspace" as const,
      sources: { actions: ["onboard_user"] },
      intake: [],
      correlation: { by: "subject" as const },
    };
    expect(validateQueue({ ...queue, display: { icon: "person", view: onboarding } })).toEqual([]);
    expect(validateQueue({ ...queue, display: { view: { blocks: [] } } })).toEqual([
      "display.view.blocks must be a list of 1 to 24 blocks",
    ]);
  });
});

describe("which facts and lists a block shows", () => {
  const type = [
    { name: "devices", label: "Devices (type)" },
    { name: "payments", label: "Payments (type)" },
  ];
  const own = [
    { for: "user", name: "devices", label: "Devices (view)" },
    { for: "user", name: "logins", label: "Logins (view)" },
    { for: "device", name: "users", label: "Users (view)" },
  ];

  it("shows the view's own when the block names none, and the type's when the view has none", () => {
    expect(definitionsFor(own, "user", type, undefined).map((d) => d.label)).toEqual([
      "Devices (view)",
      "Logins (view)",
    ]);
    expect(definitionsFor(own, "merchant", type, undefined).map((d) => d.label)).toEqual([
      "Devices (type)",
      "Payments (type)",
    ]);
  });

  it("looks a name up in the view first, then in the type, in the block's order", () => {
    expect(definitionsFor(own, "user", type, ["payments", "devices", "nope"]).map((d) => d.label)).toEqual([
      "Payments (type)",
      "Devices (view)",
    ]);
  });
});

describe("images, documents and checklists", () => {
  const base = [{ id: "why", type: "evidence", region: "main" }];
  it("needs the address fields of images, and the points of a checklist", () => {
    expect(
      validateView({
        blocks: [
          ...base,
          {
            id: "id",
            type: "images",
            region: "side",
            fields: ["subject.id_front_url", "subject.selfie_url"],
            sensitive: true,
          },
          { id: "docs", type: "documents", region: "side", fields: ["item.application.statement_url"] },
          {
            id: "check",
            type: "checklist",
            region: "main",
            points: ["The ID matches the selfie", "The address matches"],
          },
        ],
      }),
    ).toEqual([]);
    expect(
      validateView({
        blocks: [
          ...base,
          { id: "id", type: "images", region: "side" },
          { id: "check", type: "checklist", region: "main", points: ["Same", "Same"] },
          { id: "text", type: "text", region: "main", text: "Hi", sensitive: false },
        ],
      }),
    ).toEqual([
      "view.blocks[1].fields must name 1 to 8 fields that hold an address",
      "view.blocks[2].points must be 1 to 12 different points of at most 200 characters",
      "view.blocks[3].sensitive is only for images and documents",
    ]);
  });

  it("approves a host by its name, or by a wildcard for its subdomains", () => {
    expect(validateHosts(["files.example.com", "*.blob.core.windows.net"])).toEqual([]);
    expect(validateHosts(["https://x.com", "localhost"])).toHaveLength(2);
    expect(hostApproved("Files.Example.com", ["files.example.com"])).toBe(true);
    expect(hostApproved("acme.blob.core.windows.net", ["*.blob.core.windows.net"])).toBe(true);
    expect(hostApproved("blob.core.windows.net", ["*.blob.core.windows.net"])).toBe(false);
    expect(hostApproved("evilexample.com", ["*.example.com"])).toBe(false);
  });
});
