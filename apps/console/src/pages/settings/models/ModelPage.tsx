import { useState, type FormEvent } from "react";
import { useSearchParams } from "react-router";
import { models } from "../../../api/index";
import { Card } from "../../../components/ui/Card";
import { KV } from "../../../components/ui/KV";
import { Modal } from "../../../components/ui/Modal";
import { Failure, Loading } from "../../../components/ui/states";
import { useApi, useWorkflows } from "../../../hooks/useApi";
import { useWorkspace } from "../../../hooks/useWorkspace";
import { stamp } from "../../../lib/format";
import { KIND_LABEL, metric, signed, TRAIN_SNIPPET, workflowsUsing } from "../../../lib/models";
import { href } from "../../../lib/route";
import type {
  BuiltinModel,
  Environment,
  ModelPromotion,
  ModelScore,
  ModelVersionDefinition,
  ModelVersionInfo,
  UploadedModel,
} from "../../../types/interfaces";
export function ModelPage({ slug }: { slug: string }) {
  const { data: model, error } = useApi(["model", slug], () => models.get(slug));
  if (error) return <Failure message={error.message} />;
  if (!model) return <Loading />;
  return model.runtime === "builtin" ? <BuiltinPage model={model} /> : <UploadedPage model={model} />;
}

function BuiltinPage({ model }: { model: BuiltinModel }) {
  return (
    <>
      <a className="crumb" href={href("settings", "models")}>
        ← Models
      </a>
      <header className="page-head">
        <div>
          <h1>{model.name}</h1>
          <div className="row wrap" style={{ marginTop: 8 }}>
            <span className="chip">{model.slug}</span>
            <span className="chip accent">Built in</span>
          </div>
          <p className="lede">
            Finic's decision model. It reads a case, with its history, links and labels, and answers questions in plain
            language with a probability for each answer. It needs no labels of yours.
          </p>
        </div>
      </header>
      <Card title="Where it is used">
        <p className="note" style={{ margin: 0 }}>
          Each action asks it, and so do the <b>Get the model's decision</b> and <b>Ask a question</b> steps of a
          workflow. Its answers can be the features of a scoring model, in a <b>Score with a model</b> step after them.
        </p>
      </Card>
    </>
  );
}

function UploadedPage({ model }: { model: UploadedModel & { versions: ModelVersionInfo[] } }) {
  const [params, setParams] = useSearchParams();
  const asked = Number(params.get("version"));
  const version = Number.isInteger(asked) && asked >= 1 && asked <= model.version ? asked : model.version;
  const { data: old } = useApi(["model-version", model.slug, version], () => models.version(model.slug, version), {
    enabled: version !== model.version,
  });
  const { data: workflowList } = useWorkflows();
  const { workspace, environment } = useWorkspace();
  const [problem, setProblem] = useState<string | null>(null);
  const [promoting, setPromoting] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const others = workspace.environments.filter((e) => e.id !== environment.id);
  const definition: ModelVersionDefinition | undefined = version === model.version ? model.definition : old?.definition;
  const using = workflowsUsing(workflowList?.workflows ?? [], model.slug);
  const archived = model.status === "archived";

  const act = async (work: () => Promise<unknown>) => {
    setProblem(null);
    try {
      await work();
    } catch (e) {
      setProblem((e as Error).message);
    }
  };
  const archive = () => {
    if (window.confirm(`Archive "${model.name}"? A workflow saved after this cannot use it. It cannot be undone.`))
      void act(() => models.archive(model.slug));
  };

  if (!definition) return <Loading />;
  const test = definition.metrics?.test as { rows?: number; positives?: number; roc_auc?: number; pr_auc?: number };
  const comparison = definition.metrics?.comparison as
    { without: string[]; roc_auc_without: number; gain: number; gain_95: [number, number] } | undefined;
  return (
    <>
      <a className="crumb" href={href("settings", "models")}>
        ← Models
      </a>
      <header className="page-head">
        <div>
          <h1>{model.name}</h1>
          <div className="row wrap" style={{ marginTop: 8 }}>
            <span className="chip">{model.slug}</span>
            <span className="chip accent">Version {version}</span>
            {version !== model.version && <span className="chip warn">Not the latest</span>}
            {archived && <span className="chip warn">Archived {model.archived_at && stamp(model.archived_at)}</span>}
          </div>
          {definition.description && <p className="lede">{definition.description}</p>}
        </div>
        <div className="row">
          <button className="btn" onClick={() => void act(() => models.download(model.slug, version))}>
            Download
          </button>
          {!archived && others.length > 0 && (
            <button className="btn" onClick={() => setPromoting(true)}>
              Promote
            </button>
          )}
          <button className="btn" onClick={() => setRenaming(true)}>
            Rename
          </button>
          {!archived && (
            <button className="btn danger" onClick={archive}>
              Archive
            </button>
          )}
        </div>
      </header>
      {problem && <Failure message={problem} />}
      {promoting && (
        <PromoteModal slug={model.slug} version={version} environments={others} onClose={() => setPromoting(false)} />
      )}
      {renaming && <RenameModal slug={model.slug} name={model.name} onClose={() => setRenaming(false)} />}

      <div className="summary-row">
        <div className="card">
          <span>Kind</span>
          <b>{KIND_LABEL[model.kind]}</b>
          <small>XGBoost, scored in the Kairos server.</small>
        </div>
        <div className="card">
          <span>Features</span>
          <b>{definition.features.length}</b>
          <small>
            {definition.trees} trees, at most {definition.depth} deep.
          </small>
        </div>
        <div className="card">
          <span>Test ROC-AUC</span>
          <b>{metric(test?.roc_auc)}</b>
          <small>
            {test?.rows
              ? `On ${test.rows.toLocaleString()} rows newer than the training rows.`
              : "Not given at upload."}
          </small>
        </div>
        <div className="card">
          <span>Same scores as XGBoost</span>
          <b>{definition.parity.samples.toLocaleString()} samples</b>
          <small>
            {definition.parity.max_difference === 0
              ? "Kairos gave each sample exactly XGBoost's score."
              : `Largest difference ${definition.parity.max_difference.toExponential(1)}.`}
          </small>
        </div>
      </div>

      <div className="split">
        <div className="stack">
          <Card title={`Features · ${definition.features.length}`} className="flush-table">
            <FeatureTable definition={definition} />
          </Card>
          {!archived && <TryIt slug={model.slug} version={version} definition={definition} />}
        </div>
        <aside className="stack">
          <Card title="How good it is">
            {test ? (
              <KV
                data={{
                  "Test rows": test.rows,
                  Positives: test.positives,
                  "ROC-AUC": metric(test.roc_auc),
                  "PR-AUC": metric(test.pr_auc),
                }}
              />
            ) : (
              <p className="note" style={{ margin: 0 }}>
                The upload gave no metrics.
              </p>
            )}
            {comparison && (
              <p className="note" style={{ margin: "12px 0 0" }}>
                Without {comparison.without.join(", ")}, the ROC-AUC is {metric(comparison.roc_auc_without)}: a gain of{" "}
                <b>{signed(comparison.gain)}</b>, 95% interval {signed(comparison.gain_95[0])} to{" "}
                {signed(comparison.gain_95[1])}.
                {comparison.gain_95[0] > 0 ? " The interval is above zero." : " The interval includes zero."}
              </p>
            )}
          </Card>
          {definition.promoted_from && (
            <Card title="Promoted from">
              <KV
                data={{
                  Environment:
                    workspace.environments.find((e) => e.id === definition.promoted_from!.environment)?.name ??
                    definition.promoted_from.environment,
                  Version: `${model.slug}@${definition.promoted_from.version}`,
                  "File SHA-256": definition.promoted_from.sha256,
                }}
              />
            </Card>
          )}
          {definition.training && (
            <Card title="Training">
              <KV data={definition.training} skip={["params", "export"]} />
            </Card>
          )}
          <Card title={`Used by · ${using.length}`}>
            {using.length === 0 ? (
              <p className="note" style={{ margin: 0 }}>
                No published workflow scores with it.
              </p>
            ) : (
              <div className="stack" style={{ gap: 6 }}>
                {using.map((w) => (
                  <a key={w.name} href={href("workflows", w.name)}>
                    {w.displayName ?? w.name}
                  </a>
                ))}
                <small className="note">Kairos does not archive a model while a published workflow uses it.</small>
              </div>
            )}
          </Card>
          <Card title={`Versions · ${model.versions.length}`}>
            <div className="stack" style={{ gap: 6 }}>
              {model.versions.map((v) => (
                <button
                  key={v.version}
                  type="button"
                  className={v.version === version ? "btn" : "btn ghost"}
                  style={{ justifyContent: "space-between" }}
                  onClick={() => setParams(v.version === model.version ? {} : { version: String(v.version) })}
                >
                  <span className="mono">
                    {model.slug}@{v.version}
                  </span>
                  <small className="muted">{stamp(v.created)}</small>
                </button>
              ))}
            </div>
            <p className="note" style={{ margin: "10px 0 0" }}>
              A version never changes. To add one, train and upload again:
            </p>
            <pre>{TRAIN_SNIPPET}</pre>
          </Card>
        </aside>
      </div>
    </>
  );
}

function RenameModal({ slug, name, onClose }: { slug: string; name: string; onClose: () => void }) {
  const [value, setValue] = useState(name);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setProblem(null);
    try {
      await models.rename(slug, value.trim());
      onClose();
    } catch (e) {
      setProblem((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <Modal title={`Rename ${slug}`} onClose={() => !busy && onClose()}>
      <form className="modal-body" onSubmit={save}>
        {problem && <div className="banner">{problem}</div>}
        <label className="field">
          <span>Name</span>
          <input
            className="input"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            required
            maxLength={80}
            autoFocus
            disabled={busy}
          />
          <small>The name that people see. The slug, {slug}, does not change.</small>
        </label>
        <div className="modal-foot">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || !value.trim() || value.trim() === name}>
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function PromoteModal({
  slug,
  version,
  environments,
  onClose,
}: {
  slug: string;
  version: number;
  environments: Environment[];
  onClose: () => void;
}) {
  const { onChooseEnvironment } = useWorkspace();
  const [to, setTo] = useState(environments.find((e) => e.kind === "production")?.id ?? environments[0]!.id);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState<ModelPromotion | null>(null);
  const target = environments.find((e) => e.id === to)!;
  const promote = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setProblem(null);
    try {
      setDone(await models.promote(slug, version, to));
    } catch (e) {
      setProblem((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={`Promote ${slug}@${version}`} onClose={() => !busy && onClose()}>
      {done ? (
        <div className="modal-body">
          <p style={{ marginTop: 0 }}>
            {done.created ? "It is now " : "It was already "}
            <b className="mono">{done.reference}</b> in {target.name}. A workflow there uses it when a step names that
            reference.
          </p>
          <div className="modal-foot">
            <button type="button" className="btn" onClick={onClose}>
              Close
            </button>
            <button type="button" className="btn primary" onClick={() => onChooseEnvironment(target.id)}>
              Switch to {target.name}
            </button>
          </div>
        </div>
      ) : (
        <form className="modal-body" onSubmit={promote}>
          {problem && <div className="banner">{problem}</div>}
          <p className="note" style={{ marginTop: 0 }}>
            The same file becomes the next version of {slug} in the other environment. Kairos checks its samples there
            again, and the new version records where it came from. Nothing else in that environment changes.
          </p>
          <label className="field">
            <span>To</span>
            <select className="input" value={to} onChange={(e) => setTo(e.target.value)} disabled={busy}>
              {environments.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </select>
          </label>
          <div className="modal-foot">
            <button type="button" className="btn" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button className="btn primary" disabled={busy}>
              {busy ? "Promoting…" : `Promote to ${target.name}`}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}

function FeatureTable({ definition }: { definition: ModelVersionDefinition }) {
  const suggested = definition.suggested_features ?? {};
  return (
    <table>
      <thead>
        <tr>
          <th>Feature</th>
          <th>Type</th>
          <th>Suggested value</th>
        </tr>
      </thead>
      <tbody>
        {definition.features.map((f) => (
          <tr key={f.name}>
            <td className="mono">{f.name}</td>
            <td className="muted">{f.type}</td>
            <td className="mono muted wrap">{suggested[f.name] ?? "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function TryIt({ slug, version, definition }: { slug: string; version: number; definition: ModelVersionDefinition }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [result, setResult] = useState<ModelScore | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const score = async () => {
    setProblem(null);
    try {
      const features = Object.fromEntries(
        Object.entries(values)
          .filter(([, v]) => v.trim() !== "")
          .map(([k, v]) => [k, v.trim()]),
      );
      setResult(await models.score(slug, version, features));
    } catch (e) {
      setProblem((e as Error).message);
    }
  };
  return (
    <Card title="Score a row">
      <p className="note" style={{ marginTop: 0 }}>
        Give a value for each feature. An empty one is missing, and the model takes its default branch for it.
      </p>
      <div className="pair-fields">
        {definition.features.map((f) => (
          <label key={f.name} className="field">
            <span className="mono">{f.name}</span>
            <input
              className="input mono"
              inputMode="decimal"
              value={values[f.name] ?? ""}
              onChange={(e) => setValues({ ...values, [f.name]: e.target.value })}
            />
          </label>
        ))}
      </div>
      <div className="row" style={{ marginTop: 12 }}>
        <button className="btn primary" onClick={() => void score()}>
          Score
        </button>
        {result && (
          <span>
            <b className="mono">{result.score.toFixed(4)}</b>{" "}
            <span className="muted">
              risk score {result.risk_score}
              {result.missing.length > 0 && ` · missing: ${result.missing.join(", ")}`}
              {result.invalid.length > 0 && ` · not numbers: ${result.invalid.join(", ")}`}
            </span>
          </span>
        )}
      </div>
      {problem && <small className="wh-failed">{problem}</small>}
    </Card>
  );
}
