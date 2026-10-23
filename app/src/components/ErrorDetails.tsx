// A run's raw error and traceback, folded under "Details" beside the one-line friendlyError. Shared by Results, the
// drill-down and the run comparison.
export function ErrorDetails({ error, traceback = '' }: { error: string; traceback?: string }) {
  if (!error && !traceback) return null;
  return (
    <details className="text-xs text-tertiary">
      <summary className="cursor-pointer">Details</summary>
      <pre className="mt-space-1 max-h-60 overflow-auto whitespace-pre-wrap font-mono">{[error, traceback].filter(Boolean).join('\n\n')}</pre>
    </details>
  );
}
