import { useEffect, useState } from 'react';
import { api, ApiError } from './api-client.js';
import { Button, Input, Tabs, Toast } from './design-system.js';
import { PluginSlot } from './plugin-slot.js';
import type {
  BootstrapResponse,
  JsonSchema,
  PluginInventory,
  SettingsSection,
  SettingsSnapshot,
} from './workbench-types.js';

const sections: Array<{ value: SettingsSection; label: string }> = [
  { value: 'general', label: 'General' },
  { value: 'models', label: 'Models' },
  { value: 'permissions', label: 'Permissions' },
  { value: 'skills', label: 'Skills' },
  { value: 'mcp', label: 'MCP' },
  { value: 'runtime', label: 'Runtime' },
  { value: 'plugins', label: 'Plugins' },
];

const SchemaField = ({
  name,
  schema,
  value,
  onChange,
}: {
  name: string;
  schema: JsonSchema;
  value: unknown;
  onChange(value: unknown): void;
}) => {
  const label = schema.title ?? name.replaceAll(/[-_]/g, ' ');
  if (schema.enum)
    return (
      <label className="schema-field">
        <span>{label}</span>
        <small>{schema.description}</small>
        <select
          value={String(value ?? schema.default ?? '')}
          onChange={(event) => onChange(event.target.value)}
        >
          {schema.enum.map((option) => (
            <option key={String(option)} value={String(option)}>
              {String(option)}
            </option>
          ))}
        </select>
      </label>
    );
  if (schema.type === 'boolean')
    return (
      <label className="schema-field schema-toggle">
        <span>
          {label}
          <small>{schema.description}</small>
        </span>
        <input
          type="checkbox"
          checked={Boolean(value ?? schema.default)}
          onChange={(event) => onChange(event.target.checked)}
        />
      </label>
    );
  if (schema.type === 'object' || schema.type === 'array')
    return (
      <label className="schema-field">
        <span>{label}</span>
        <small>{schema.description}</small>
        <textarea
          key={JSON.stringify(value)}
          defaultValue={JSON.stringify(value ?? (schema.type === 'array' ? [] : {}), null, 2)}
          onBlur={(event) => {
            try {
              event.currentTarget.setCustomValidity('');
              onChange(JSON.parse(event.currentTarget.value));
            } catch {
              event.currentTarget.setCustomValidity('Enter valid JSON');
              event.currentTarget.reportValidity();
            }
          }}
        />
      </label>
    );
  return (
    <Input
      label={label}
      hint={schema.description}
      type={schema.secret ? 'password' : schema.type === 'number' ? 'number' : 'text'}
      value={String(value ?? schema.default ?? '')}
      onChange={(event) =>
        onChange(schema.type === 'number' ? Number(event.target.value) : event.target.value)
      }
    />
  );
};

const SchemaForm = ({
  schema,
  values,
  onChange,
}: {
  schema?: JsonSchema;
  values: Record<string, unknown>;
  onChange(value: Record<string, unknown>): void;
}) => {
  if (!schema?.properties)
    return <div className="settings-empty">This section has no configurable fields.</div>;
  return (
    <div className="schema-form">
      {Object.entries(schema.properties).map(([name, field]) => (
        <SchemaField
          key={name}
          name={name}
          schema={field}
          value={values[name]}
          onChange={(value) => onChange({ ...values, [name]: value })}
        />
      ))}
    </div>
  );
};

const inferredSchema = (values: Record<string, unknown>): JsonSchema => ({
  type: 'object',
  properties: Object.fromEntries(
    Object.entries(values).map(([name, value]) => [
      name,
      {
        title: name.replaceAll(/[-_]/g, ' '),
        type: Array.isArray(value) ? 'array' : value === null ? 'string' : typeof value,
      },
    ])
  ),
});

const PluginSettings = ({
  inventory,
  contributions,
  onMutate,
  onRefresh,
}: {
  inventory: PluginInventory;
  contributions: PluginInventory['contributions'];
  onMutate(id: string, action: 'enable' | 'disable' | 'remove'): void;
  onRefresh(): void;
}) => {
  const [source, setSource] = useState('');
  const [selected, setSelected] = useState<string>();
  const [config, setConfig] = useState<import('./workbench-types.js').PluginConfigResponse>();
  const [configValues, setConfigValues] = useState<Record<string, unknown>>({});
  const [secretValues, setSecretValues] = useState<Record<string, string>>({});
  const [report, setReport] = useState('');
  const openConfig = async (id: string) => {
    setSelected(id);
    try {
      const next = await api.pluginConfig(id);
      setConfig(next);
      setConfigValues(next.config.values);
    } catch (error) {
      setConfig(undefined);
      setReport(error instanceof Error ? error.message : 'No configuration schema.');
    }
  };
  return (
    <div className="plugin-settings">
      <p>
        Trusted local and npm plugins share Moss tokens and controlled slots. Advanced plugin
        configuration is generated from JSON Schema when available.
      </p>
      <div className="plugin-install">
        <Input
          label="Local path, exact npm package, official source, or compatible DSH package"
          value={source}
          placeholder="./plugin, package-name@1.2.3, or official:deepseek-harness"
          onChange={(event) => setSource(event.target.value)}
        />
        <Button
          disabled={!source.trim()}
          onClick={() =>
            void api.addPlugin(source.trim()).then(({ generation }) => {
              setSource('');
              setReport(`Plugin loaded · generation ${generation} · client reloaded`);
              onRefresh();
            })
          }
        >
          Add plugin
        </Button>
        <Button
          variant="ghost"
          onClick={() =>
            void api
              .doctorPlugins()
              .then(({ results, generation }) =>
                setReport(
                  `Doctor · generation ${generation}\n${results.map((result) => `${result.pluginId ?? result.id ?? 'plugin'}: ${result.message ?? result.status ?? (result.ok ? 'ok' : 'failed')}`).join('\n')}`
                )
              )
          }
        >
          Run doctor
        </Button>
      </div>
      {report && <Toast>{report}</Toast>}
      {inventory.installed.length === 0 && (
        <div className="settings-empty">No plugins installed.</div>
      )}
      {inventory.installed.map((plugin) => (
        <article className="plugin-card" key={plugin.id}>
          <div>
            <strong>{plugin.id}</strong>
            <small>
              {plugin.version} · {plugin.enabled ? 'enabled' : 'disabled'}
            </small>
          </div>
          <div className="plugin-actions">
            <Button
              size="small"
              onClick={() => onMutate(plugin.id, plugin.enabled ? 'disable' : 'enable')}
            >
              {plugin.enabled ? 'Disable' : 'Enable'}
            </Button>
            <Button variant="danger" size="small" onClick={() => onMutate(plugin.id, 'remove')}>
              Remove
            </Button>
            <Button variant="ghost" size="small" onClick={() => void openConfig(plugin.id)}>
              Configure
            </Button>
          </div>
        </article>
      ))}
      {selected && config && (
        <section className="plugin-config">
          <h4>{selected} configuration</h4>
          <SchemaForm
            schema={{
              ...config.schema,
              properties: Object.fromEntries(
                Object.entries(config.schema.properties ?? {}).filter(
                  ([, field]) => !field.writeOnly
                )
              ),
            }}
            values={configValues}
            onChange={setConfigValues}
          />
          <Button
            onClick={() =>
              void api.savePluginConfig(selected, configValues).then((next) => {
                setConfig(next);
                setReport(`Configuration saved · generation ${next.generation}`);
              })
            }
          >
            Save plugin config
          </Button>
          {Object.entries(config.schema.properties ?? {})
            .filter(([, field]) => field.writeOnly)
            .map(([name, field]) => (
              <div className="secret-control" key={name}>
                <div>
                  <strong>{field.title ?? name}</strong>
                  <small>
                    {config.config.secrets[name]?.configured
                      ? 'Configured — write-only'
                      : 'Not configured'}
                  </small>
                </div>
                <Input
                  label={field.title ?? name}
                  labelHidden
                  type="password"
                  value={secretValues[name] ?? ''}
                  onChange={(event) =>
                    setSecretValues({ ...secretValues, [name]: event.target.value })
                  }
                />
                <Button
                  disabled={!secretValues[name]}
                  onClick={() =>
                    void api
                      .putPluginSecret(selected, name, secretValues[name] ?? '')
                      .then((next) => {
                        setConfig(next);
                        setSecretValues({ ...secretValues, [name]: '' });
                      })
                  }
                >
                  Write
                </Button>
                <Button
                  variant="danger"
                  onClick={() => void api.deletePluginSecret(selected, name).then(setConfig)}
                >
                  Delete
                </Button>
              </div>
            ))}
        </section>
      )}
      <PluginSlot
        slot="settings.plugin"
        contributions={contributions}
        owner={{ kind: 'settings', id: 'plugins' }}
      />
    </div>
  );
};

export const SettingsCenter = ({
  initialSection,
  bootstrap,
  inventory,
  onSection,
  onPluginMutate,
  onPluginsChanged,
  onModelChanged,
}: {
  initialSection: SettingsSection;
  bootstrap: BootstrapResponse | null;
  inventory: PluginInventory;
  onSection(value: SettingsSection): void;
  onPluginMutate(id: string, action: 'enable' | 'disable' | 'remove'): void;
  onPluginsChanged(): void;
  onModelChanged(model: string): void;
}) => {
  const [section, setSection] = useState(initialSection);
  const [snapshot, setSnapshot] = useState<SettingsSnapshot>({});
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [baseline, setBaseline] = useState('{}');
  const [notice, setNotice] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [models, setModels] = useState<string[]>([]);
  const dirty = JSON.stringify(values) !== baseline;
  useEffect(() => {
    let alive = true;
    void api
      .settings(section)
      .then((next) => {
        if (!alive) return;
        const nextValues = next.values ?? {};
        setSnapshot(next);
        setValues(nextValues);
        setBaseline(JSON.stringify(nextValues));
        setNotice('');
      })
      .catch((error: unknown) => {
        if (alive)
          setNotice(
            error instanceof ApiError && error.status === 404
              ? 'This settings service is not available in the current runtime.'
              : 'Settings could not be loaded.'
          );
      });
    if (section === 'models')
      void api
        .models()
        .then((catalog) =>
          setModels(
            catalog.models ??
              catalog.choices?.map((choice) => choice.model ?? choice.id ?? '').filter(Boolean) ??
              []
          )
        )
        .catch(() => {});
    return () => {
      alive = false;
    };
  }, [section]);
  const changeSection = (value: SettingsSection) => {
    if (dirty && !window.confirm('Discard unsaved settings?')) return;
    setSection(value);
    onSection(value);
  };
  const save = async () => {
    const validation = await api.validateSettings(section, values);
    if (!validation.valid) {
      setNotice(
        validation.errors
          ? Object.entries(validation.errors)
              .map(([field, message]) => `${field}: ${message}`)
              .join('\n')
          : 'Validation failed.'
      );
      return;
    }
    await api.saveSettings(section, values);
    setBaseline(JSON.stringify(values));
    setNotice('Saved.');
  };
  return (
    <section className="settings-view">
      <Tabs
        value={section}
        options={sections}
        onChange={changeSection}
        ariaLabel="Settings sections"
        orientation="vertical"
      />
      <div
        className="settings-section"
        id={`moss-panel-${section}`}
        role="tabpanel"
        aria-labelledby={`moss-tab-${section}`}
      >
        <PluginSlot
          slot="settings.section"
          contributions={inventory.contributions}
          owner={{ kind: 'settings', id: section, data: snapshot }}
        />
        <p className="overline">SETTINGS</p>
        <h3>{sections.find(({ value }) => value === section)?.label}</h3>
        {notice && <Toast>{notice}</Toast>}
        {section === 'plugins' && (
          <PluginSettings
            inventory={inventory}
            contributions={inventory.contributions}
            onMutate={onPluginMutate}
            onRefresh={onPluginsChanged}
          />
        )}
        <>
          {section === 'runtime' && (
            <div className="inventory-grid">
              <article>
                <strong>{bootstrap?.tools.length ?? 0}</strong>
                <span>Tools</span>
              </article>
              <article>
                <strong>{bootstrap?.plugins.length ?? 0}</strong>
                <span>Plugins</span>
              </article>
              <article>
                <strong>{bootstrap?.taskRuns.length ?? 0}</strong>
                <span>Runs</span>
              </article>
            </div>
          )}
          {section === 'models' && (
            <label className="schema-field">
              <span>Active model</span>
              <select
                value={String(values.model ?? bootstrap?.model ?? '')}
                onChange={(event) => {
                  setValues({ ...values, model: event.target.value });
                  void api
                    .selectModel(event.target.value)
                    .then(() => onModelChanged(event.target.value));
                }}
              >
                {models.map((model) => (
                  <option key={model}>{model}</option>
                ))}
              </select>
            </label>
          )}
          <SchemaForm
            schema={snapshot.schema ?? inferredSchema(values)}
            values={values}
            onChange={setValues}
          />
          {section === 'models' && (
            <div className="secret-control">
              <div>
                <strong>Provider API key</strong>
                <small>
                  {(snapshot.credentials?.apiKey?.configured ?? snapshot.configured?.apiKey)
                    ? 'Configured — value is write-only.'
                    : 'Not configured.'}
                </small>
              </div>
              <Input
                label="New API key"
                labelHidden
                type="password"
                value={apiKey}
                placeholder="Write-only API key"
                onChange={(event) => setApiKey(event.target.value)}
              />
              <Button
                disabled={!apiKey}
                onClick={() =>
                  void api.setApiKey(apiKey).then(() => {
                    setApiKey('');
                    setNotice('Credential updated.');
                  })
                }
              >
                Update
              </Button>
              <Button
                variant="danger"
                onClick={() => void api.deleteApiKey().then(() => setNotice('Credential deleted.'))}
              >
                Delete
              </Button>
            </div>
          )}
          <footer className="settings-actions">
            <span>{dirty ? 'Unsaved changes' : 'Up to date'}</span>
            <Button
              disabled={!dirty}
              onClick={() =>
                void save().catch((error: unknown) =>
                  setNotice(error instanceof Error ? error.message : 'Save failed.')
                )
              }
            >
              Save changes
            </Button>
          </footer>
        </>
      </div>
    </section>
  );
};
