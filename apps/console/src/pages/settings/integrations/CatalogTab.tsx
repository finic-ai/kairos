import { useState } from "react";
import { Empty } from "../../../components/ui/states";
import { Tab, TabStrip } from "../../../components/ui/TabStrip";
import { href } from "../../../lib/route";
import { INTEGRATIONS, KINDS, type Integration, type Kind } from "./catalog";

export function Logo({ integration, size = 34 }: { integration: Integration; size?: number }) {
  return (
    <span className="integration-mark" style={{ width: size, height: size }} aria-hidden>
      <img className={integration.mono ? "mono" : ""} src={integration.logo} alt="" />
    </span>
  );
}

export function CatalogTab() {
  const [kind, setKind] = useState<Kind | "all">("all");
  const [query, setQuery] = useState("");
  const words = query.trim().toLowerCase();
  const shown = INTEGRATIONS.filter(
    (i) => (kind === "all" || i.kind === kind) && (!words || `${i.name} ${i.note}`.toLowerCase().includes(words)),
  );

  return (
    <>
      <div className="row wrap" style={{ marginBottom: 18 }}>
        <input
          className="input search grow"
          placeholder="Filter by name…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Filter integrations"
        />
        <TabStrip label="Kinds of integration" className="tight">
          <Tab on={kind === "all"} onSelect={() => setKind("all")}>
            All
          </Tab>
          {KINDS.map((k) => (
            <Tab key={k.id} on={kind === k.id} onSelect={() => setKind(k.id)}>
              {k.title}
            </Tab>
          ))}
        </TabStrip>
      </div>

      {shown.length === 0 && (
        <div className="card">
          <Empty title="No integrations match">Try another name, or choose All.</Empty>
        </div>
      )}
      {KINDS.map((k) => {
        const items = shown.filter((i) => i.kind === k.id);
        if (items.length === 0) return null;
        return (
          <section className="set" key={k.id}>
            <div className="set-head">
              <h2>{k.title}</h2>
            </div>
            <div className="integrations">
              {items.map((i) => (
                <a key={i.slug} className="card integration" href={href("settings", "integrations", i.slug)}>
                  <div className="integration-top">
                    <Logo integration={i} />
                    {!i.docs && <span className="chip">Coming soon</span>}
                  </div>
                  <b>{i.name}</b>
                  <span>{i.note}</span>
                </a>
              ))}
            </div>
          </section>
        );
      })}
    </>
  );
}
