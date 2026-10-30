import type { Webhooks } from "../../context";
import type { SessionsService } from "../../services/session.service";
import { inboundRoutes, presetRoutes, webhookRoutes } from "./route";
import type { Tenancy } from "../tenancy/service";
import type { Environments } from "../environments/service";
import { createWebhookAdmin } from "./service";
import type { WebhookPreset, InboundRepositories } from "./libs";

export interface WebhooksDeps {
  sessions: SessionsService;
  tenancy: Tenancy;
  environments: Environments;
  webhooks?: Webhooks;
  repos: InboundRepositories;
  now: () => Date;
  presets: WebhookPreset[];
  onQueued?: () => void;
}

export function webhooksModule({
  sessions,
  tenancy,
  environments,
  webhooks,
  repos,
  now,
  presets,
  onQueued,
}: WebhooksDeps) {
  const admin = createWebhookAdmin({ webhooks, tenancy, environments, repos, now, onQueued });
  return {
    adminRoutes: webhookRoutes({ sessions, admin, now }),
    inboundRoutes: inboundRoutes({ webhooks, repos, now, onQueued }),
    presetRoutes: presetRoutes(presets),
  };
}
