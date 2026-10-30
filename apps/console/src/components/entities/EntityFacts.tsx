import { api } from "../../api/index";
import { useApi } from "../../hooks/useApi";
import { factText, usualText, windowText } from "../../lib/facts";
import type { EntityRef, FactValue } from "../../types/interfaces";
import { Card } from "../ui/Card";

export function EntityFacts({ entity, title = "Facts" }: { entity: EntityRef; title?: string }) {
  const { data } = useApi(["entity-facts", entity.type, entity.id], () => api.entityFacts(entity), {
    refetchInterval: 30_000,
  });
  return <FactsCard facts={data?.facts ?? []} title={title} />;
}

export function FactsCard({ facts, title }: { facts: FactValue[]; title: string }) {
  if (!facts.length) return null;
  return (
    <Card title={title} className="facts-card">
      <dl className="fact-grid">
        {facts.map((f) => {
          const usual = usualText(f);
          const high = f.times_usual === null ? Boolean(f.value) : (f.times_usual ?? 0) >= 3;
          return (
            <div key={f.name} title={f.window === "all" ? "All time" : `In the last ${windowText(f.window)}`}>
              <dt>{f.label}</dt>
              <dd>{factText(f)}</dd>
              {usual && <span className={`chip ${high ? "warn" : ""}`}>{usual}</span>}
            </div>
          );
        })}
      </dl>
    </Card>
  );
}
