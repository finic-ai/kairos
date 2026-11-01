import { href } from "../../../lib/route";
import type { SettingsPageProps } from "../types";
import { CatalogTab } from "./CatalogTab";
import { INTEGRATIONS } from "./catalog";
import { ClientSettingsTab } from "./ClientSettingsTab";
import { IntegrationDetail } from "./IntegrationDetail";

const TABS = [
  { id: "catalog", title: "Catalog" },
  { id: "client-settings", title: "Client settings" },
] as const;

/** `id` is a tab, or the slug of an integration. */
export function IntegrationsPage({
  workspace,
  environment,
  onChooseEnvironment,
  id,
}: SettingsPageProps & { id?: string }) {
  const integration = INTEGRATIONS.find((i) => i.slug === id);
  if (integration)
    return <IntegrationDetail integration={integration} workspace={workspace} environment={environment} />;

  const on = TABS.find((t) => t.id === id)?.id ?? "catalog";
  return (
    <>
      <h1>Integrations</h1>
      <p className="muted" style={{ margin: "4px 0 0" }}>
        Libraries and integrations that send your data to Kairos.
      </p>
      <nav className="tabs">
        {TABS.map((t) => (
          <a key={t.id} href={href("settings", "integrations", t.id)} className={on === t.id ? "on" : ""}>
            {t.title}
          </a>
        ))}
      </nav>
      {on === "catalog" ? (
        <CatalogTab />
      ) : (
        <ClientSettingsTab workspace={workspace} environment={environment} onChooseEnvironment={onChooseEnvironment} />
      )}
    </>
  );
}
