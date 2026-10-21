export {};

declare global {
  /** Metadata supplied as render()'s third argument by the host. */
  type RenderMetadata = {
    // Web mode only: the commit the agent under test is on, to flag results from older agent code.
    agentCommit?: string;
    // Web mode only: every commit with the same agent code as agentCommit (EVAL_AGENT_PATHS unchanged since).
    sameAgentCommits?: string[];
    mode: 'dark' | 'light';
    /** Empty when the workspace is unresolved. */
    workspaceId: string;
    host: string;
  };

  interface Window {
    /** Injected by the host page. See AGENTS.md for usage. */
    langsmith: {
      call: (
        operation: string,
        args?: { params?: Record<string, string | string[]>; body?: unknown }
      ) => Promise<unknown>;
      setData: (patch: Record<string, unknown>) => void;
      openUrl: (url: string, options?: { newTab?: boolean }) => void;
      feedback: {
        create: (args: Record<string, unknown>) => Promise<unknown>;
      };
    };
  }
}
