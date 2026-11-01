import { useState } from "react";
import { workspaces } from "../../api/index";
import claudeLogo from "../../assets/agents/claude.svg";
import codexLogo from "../../assets/agents/codex.svg";
import cursorLogo from "../../assets/agents/cursor.svg";
import vscodeLogo from "../../assets/agents/vscode.png";
import { Code } from "../../components/get-started/Code";
import { CopyButton } from "../../components/get-started/CopyButton";
import { KeyModal } from "../../components/settings/KeyModal";
import { Banner, type Message } from "../../components/ui/Banner";
import { Copy } from "../../components/ui/Copy";
import { Group, Row } from "../../components/ui/Group";
import { Empty, Loading } from "../../components/ui/states";
import { Switch } from "../../components/ui/Switch";
import { Tab, TabStrip } from "../../components/ui/TabStrip";
import { useApi } from "../../hooks/useApi";
import type { McpGroup, McpSettings } from "../../types/interfaces";
import type { SettingsPageProps } from "./types";

const GROUPS: { id: McpGroup; title: string; note: string }[] = [
  { id: "read", title: "Read", note: "View data. Changes nothing." },
  { id: "write", title: "Write", note: "Send events, labels and case notes." },
  { id: "decide", title: "Decide", note: "Make and resolve decisions, resolve cases, run workflows." },
  {
    id: "build",
    title: "Build",
    note: "Save entity types, actions and workflows, publish, and run and apply experiments.",
  },
];

const CLIENTS = ["Claude Code", "Cursor", "Codex", "VS Code", "Other"] as const;
type Client = (typeof CLIENTS)[number];

const LOGOS: Partial<Record<Client, string>> = {
  Cursor: cursorLogo,
  "Claude Code": claudeLogo,
  Codex: codexLogo,
  "VS Code": vscodeLogo,
};

const PLACEHOLDER = "<YOUR_API_KEY>";

interface Block {
  title: string;
  text: string;
  /** What an agent must do with `text`, said in the prompt. */
  step: string;
}

/** The configuration file first; a command, when the client has one, under it. */
const setup = (client: Client, url: string, key: string): Block[] => {
  const headers = { Authorization: `Bearer ${key}` };
  const keep = "Keep any servers that are already in the file.";
  switch (client) {
    case "Cursor":
      return [
        {
          title: ".cursor/mcp.json",
          text: JSON.stringify({ mcpServers: { kairos: { url, headers } } }, null, 2),
          step: `Add this server to .cursor/mcp.json in this project. ${keep}`,
        },
      ];
    case "Claude Code":
      return [
        {
          title: ".mcp.json",
          text: JSON.stringify({ mcpServers: { kairos: { type: "http", url, headers } } }, null, 2),
          step: `Add this server to .mcp.json in the root of this project. ${keep}`,
        },
        {
          title: "Or in a terminal",
          text: `claude mcp add --transport http kairos ${url} --header "Authorization: Bearer ${key}"`,
          step: "Or run this command.",
        },
      ];
    case "Codex":
      return [
        {
          title: "JSON",
          text: JSON.stringify({ mcpServers: { kairos: { type: "http", url, headers } } }, null, 2),
          step: `Add this server to ~/.codex/config.toml as [mcp_servers.kairos], with url and http_headers. ${keep}`,
        },
        {
          // `codex mcp add` takes a bearer token only from an environment variable.
          title: "Or in a terminal",
          text: `export KAIROS_API_KEY="${key}"\ncodex mcp add kairos --url ${url} --bearer-token-env-var KAIROS_API_KEY`,
          step: "Or run these commands, and add the export line to the shell profile, so that KAIROS_API_KEY is set when Codex starts.",
        },
      ];
    case "VS Code":
      return [
        {
          title: ".vscode/mcp.json",
          text: JSON.stringify({ servers: { kairos: { type: "http", url, headers } } }, null, 2),
          step: `Add this server to .vscode/mcp.json in this project. ${keep}`,
        },
      ];
    case "Other":
      return [
        {
          title: "Streamable HTTP",
          text: `URL: ${url}\nHeader: Authorization: Bearer ${key}`,
          step: "Configure a Streamable HTTP MCP server named kairos with this URL and header.",
        },
      ];
  }
};

const promptFor = (client: Client, url: string, key: string, environment: string) => {
  return [
    `Connect ${client === "Other" ? "this agent" : client} to the Kairos MCP server.`,
    "",
    `Kairos is a fraud decision engine. Its MCP server is at ${url} and uses Streamable HTTP. Each request needs the header "Authorization: Bearer <key>". The key works in the "${environment}" environment.`,
    "",
    ...setup(client, url, key).flatMap(({ step, text }) => [step, "", text, ""]),
    ...(key === PLACEHOLDER ? [`Ask me for the secret API key, and put it in place of ${PLACEHOLDER}.`, ""] : []),
    "Then check that the server connects and lists its tools, and call list_actions. Do not commit the key to a repository, and do not show it in your answer.",
  ].join("\n");
};

export function McpPage({ workspace, environment }: SettingsPageProps) {
  const manage = workspace.role !== "member";
  const { data, error: loadError, refetch } = useApi(["mcp", workspace.id], () => workspaces.mcp(workspace.id));
  const [message, setMessage] = useState<Message>(null);
  const [client, setClient] = useState<Client>("Claude Code");
  const [creating, setCreating] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const url = `${window.location.origin}/mcp`;

  const save = (next: Pick<McpSettings, "enabled" | "groups">, text: string) =>
    workspaces.setMcp(workspace.id, next).then(
      () => (setMessage({ ok: true, text }), refetch()),
      (e: Error) => setMessage({ ok: false, text: e.message }),
    );
  const toggleGroup = (settings: McpSettings, group: McpGroup, on: boolean) => {
    const groups = on ? [...settings.groups, group] : settings.groups.filter((g) => g !== group);
    const title = GROUPS.find((g) => g.id === group)!.title;
    return save({ enabled: settings.enabled, groups }, `${title} tools turned ${on ? "on" : "off"}.`);
  };

  const key = secret ?? PLACEHOLDER;
  const shown = setup(client, url, key);

  return (
    <>
      <h1>MCP</h1>
      <Banner message={message ?? (loadError ? { ok: false, text: loadError.message } : null)} />

      <Group title="Server" note="Connect AI agents to Kairos with the Model Context Protocol.">
        <div className="card rows">
          <Row
            title="Allow agents"
            note={
              manage
                ? "This determines whether agents can connect to Kairos via the MCP server."
                : "Only admins can change this."
            }
          >
            {data ? (
              <Switch
                checked={data.enabled}
                disabled={!manage}
                title="Allow agents"
                onChange={(enabled) =>
                  save({ enabled, groups: data.groups }, enabled ? "Agents can connect." : "Agents cannot connect.")
                }
              />
            ) : (
              <Loading />
            )}
          </Row>
          <Row title="Server URL">
            <Copy value={url} />
          </Row>
        </div>
      </Group>

      <Group
        title="Connect an agent"
        note={`Connect your favorite AI agent to Kairos with the MCP server.`}
        action={
          manage && (
            <button className="btn primary" onClick={() => setCreating(true)}>
              Create Key
            </button>
          )
        }
      >
        <div className="card" style={{ padding: 18 }}>
          {!manage && !secret ? (
            <Empty title="Ask an admin for a key" />
          ) : (
            <>
              <TabStrip label="MCP clients" className="tight">
                {CLIENTS.map((c) => (
                  <Tab key={c} on={c === client} onSelect={() => setClient(c)}>
                    {LOGOS[c] && <img className={`tab-logo ${c === "Cursor" ? "mono" : ""}`} src={LOGOS[c]} alt="" />}
                    {c}
                  </Tab>
                ))}
              </TabStrip>
              {shown.map((block) => (
                <div key={block.title} style={{ marginTop: 12 }}>
                  <Code title={block.title} text={block.text} />
                </div>
              ))}
              <div style={{ display: "flex", alignItems: "center", gap: 16, marginTop: 12 }}>
                <p className="muted" style={{ margin: 0, flex: 1 }}>
                  {secret
                    ? "Copy it now. The key is shown only once."
                    : `Ensure you replace ${PLACEHOLDER} with your secret key.`}
                </p>
                <CopyButton
                  text={promptFor(client, url, key, environment.name)}
                  label="Copy prompt"
                  brand
                  icon={
                    <span className="btn-logo" aria-hidden>
                      {LOGOS[client] ? (
                        <img src={LOGOS[client]} alt="" />
                      ) : (
                        <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="#172b4d" strokeWidth="1.6">
                          <path d="M6 2v3M10 2v3M4 5h8v3a4 4 0 0 1-8 0V5ZM8 12v2" strokeLinecap="round" />
                        </svg>
                      )}
                    </span>
                  }
                />
              </div>
            </>
          )}
        </div>
      </Group>

      <Group title="Tools">
        {!data ? (
          <div className="card">
            <Loading />
          </div>
        ) : (
          GROUPS.map((group) => {
            const on = data.groups.includes(group.id);
            const tools = data.tools.filter((t) => t.group === group.id);
            return (
              <div className="card rows" key={group.id} style={{ marginBottom: 12, opacity: data.enabled ? 1 : 0.6 }}>
                <Row title={group.title} note={group.note}>
                  <Switch
                    checked={on}
                    disabled={!manage}
                    title={`${group.title} tools`}
                    onChange={(next) => toggleGroup(data, group.id, next)}
                  />
                </Row>
                <details className="set-row" style={{ display: "block" }}>
                  <summary className="muted">
                    {tools.length} tools{on ? "" : ", all off"}
                  </summary>
                  {tools.map((tool) => (
                    <Row key={tool.name} title={tool.title} note={<span className="mono">{tool.name}</span>}>
                      {tool.destructive && <span className="chip warn">Asks first</span>}
                    </Row>
                  ))}
                </details>
              </div>
            );
          })
        )}
      </Group>

      {creating && (
        <KeyModal
          workspace={workspace}
          environment={environment}
          kind="secret"
          defaultName="MCP agent"
          onClose={() => setCreating(false)}
          onCreated={(created) => setSecret(created.secret)}
        />
      )}
    </>
  );
}
