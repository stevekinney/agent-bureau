export function ToolCallCard({
  name,
  arguments: args,
  result,
}: {
  name: string;
  arguments: unknown;
  result?: unknown;
}) {
  return (
    <div className="tool-call-card">
      <h4>{name}</h4>
      <pre>{JSON.stringify(args, null, 2)}</pre>
      {result !== undefined && (
        <div className="tool-call-result">
          <strong>Result:</strong>
          <pre>{JSON.stringify(result, null, 2)}</pre>
        </div>
      )}
    </div>
  );
}
