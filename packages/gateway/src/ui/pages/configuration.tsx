import type { ConfigurationResponse } from '../../types';

export function ConfigurationPage({ config }: { config: ConfigurationResponse }) {
  return (
    <main className="page-configuration">
      <h1>Configuration</h1>
      <section>
        <h2>Provider</h2>
        {config.provider ? (
          <dl>
            <dt>Provider</dt>
            <dd>{config.provider.provider}</dd>
            <dt>Model</dt>
            <dd>{config.provider.model}</dd>
          </dl>
        ) : (
          <p>No provider configured.</p>
        )}
      </section>
      <section>
        <h2>Settings</h2>
        <dl>
          <dt>Maximum Steps</dt>
          <dd>{config.maximumSteps}</dd>
          <dt>System Prompt</dt>
          <dd>{config.systemPrompt ?? 'None'}</dd>
        </dl>
      </section>
      {config.tools.length > 0 && (
        <section>
          <h2>Tools ({config.tools.length})</h2>
          <ul>
            {config.tools.map((tool) => (
              <li key={tool.name}>
                <strong>{tool.name}</strong>: {tool.description}
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
