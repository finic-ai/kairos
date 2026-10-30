import type { ActionDefinition, Decider, EntityDefinition } from "@kairos/core";
import type { SecretBox } from "./platform/secrets";
import type { CognitoConfig } from "./platform/auth/cognito";
import type { TenancyRepository, EnvironmentsRepository, Repositories } from "./repositories";
import type { Executor } from "./platform/database";
import type { AutomaticRunner } from "./modules/decisions/libs";
import type { Jobs } from "./platform/jobs/worker";
import type { WebhookPreset, WebhookWorker } from "./modules/webhooks/libs";
import type { ViewTemplate } from "./modules/cases/types";

export interface AppOptions {
  repos: Repositories;
  decider: Decider;
  accounts: TenancyRepository;
  environments: EnvironmentsRepository;
  signup?: boolean;
  supabase?: { url: string; anonKey: string; providers?: string[] };
  cognito?: CognitoConfig;
  /** Read the caller's address from X-Forwarded-For. Only behind a proxy that sets it. */
  trustProxy?: boolean;
  fetch?: typeof fetch;
  templates?: ActionDefinition[];
  entityTemplates?: EntityDefinition[];
  viewTemplates?: ViewTemplate[];
  presets?: WebhookPreset[];
  now?: () => Date;
  webhooks?: Webhooks;
  automatic?: AutomaticRunner;
  jobs?: Jobs;
}

export interface Webhooks {
  db: Executor;
  secretBox?: SecretBox;
  worker?: WebhookWorker;
  allowPrivate: boolean;
  cronSecret?: string;
  warning?: string;
  payloadDays?: number;
}
