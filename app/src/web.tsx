// Standalone entry: the same App, served by the eval server. window.langsmith is a shim with the custom-app
// bridge's shape that forwards each call to the server's LangSmith proxy, so App.tsx doesn't know which mode it's in.
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import { App } from './App';
import { HostTheme } from './lib/HostTheme';
import { ErrorBoundary } from './lib/ErrorBoundary';
import { enableWebRunner } from './runs';

type Config = { host: string; workspaceId: string; agentCommit?: string; sameAgentCommits?: string[] };

async function call(operation: string, args?: { params?: Record<string, string | string[]>; body?: unknown }) {
  const [method, path] = operation.split(' ');
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(args?.params ?? {})) {
    for (const item of Array.isArray(value) ? value : [value]) query.append(key, item);
  }
  const response = await fetch(`/api/langsmith${path}${query.size ? `?${query}` : ''}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: args?.body === undefined ? undefined : JSON.stringify(args.body),
  });
  const text = await response.text();
  let payload: unknown = text;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    // not JSON; keep the text
  }
  if (!response.ok) {
    const detail = typeof payload === 'object' && payload && 'detail' in payload ? String((payload as { detail: unknown }).detail) : text;
    throw { status: response.status, message: `${response.status}: ${detail.slice(0, 300)}` };
  }
  return payload;
}

function installShim(config: Config) {
  window.langsmith = {
    call,
    setData: () => undefined,
    openUrl: (url, options) => {
      const absolute = /^https?:/.test(url) ? url : `${config.host}${url}`;
      if (options?.newTab === false) window.location.href = absolute;
      else window.open(absolute, '_blank', 'noopener');
    },
    feedback: { create: (body) => call('POST /api/v1/feedback', { body }) },
  };
}

function useColorMode() {
  const query = window.matchMedia('(prefers-color-scheme: dark)');
  const [mode, setMode] = useState<'light' | 'dark'>(query.matches ? 'dark' : 'light');
  useEffect(() => {
    const onChange = (event: MediaQueryListEvent) => setMode(event.matches ? 'dark' : 'light');
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, [query]);
  return mode;
}

// The agent's commit, re-read every 30s: a server restarted on new code runs on a new commit, and a page still
// holding the old one would call those fresh results out of date.
function useAgentCommits(initial: Config) {
  const [commits, setCommits] = useState({ agentCommit: initial.agentCommit, sameAgentCommits: initial.sameAgentCommits });
  useEffect(() => {
    const timer = window.setInterval(() => {
      fetch('/api/config').then((response) => response.json() as Promise<Config>)
        .then((next) => setCommits((current) => current.agentCommit === next.agentCommit ? current
          : { agentCommit: next.agentCommit, sameAgentCommits: next.sameAgentCommits }))
        .catch(() => {});
    }, 30000);
    return () => window.clearInterval(timer);
  }, []);
  return commits;
}

function Root({ config }: { config: Config }) {
  const mode = useColorMode();
  const { agentCommit, sameAgentCommits } = useAgentCommits(config);
  useEffect(() => {
    document.documentElement.classList.toggle('dark', mode === 'dark');
  }, [mode]);
  return (
    <HostTheme mode={mode}>
      <ErrorBoundary>
        <App data={{}} metadata={{ mode, workspaceId: config.workspaceId, host: config.host, agentCommit, sameAgentCommits }} />
      </ErrorBoundary>
    </HostTheme>
  );
}

enableWebRunner();
fetch('/api/config')
  .then((response) => response.json() as Promise<Config>)
  .catch(() => ({ host: 'https://smith.langchain.com', workspaceId: '' }))
  .then((config) => {
    installShim(config);
    createRoot(document.getElementById('root')!).render(<Root config={config} />);
  });
