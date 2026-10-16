import { Component, type ErrorInfo, type ReactNode } from 'react';

type Props = { children?: ReactNode };
type State = { caught: boolean; detail: string; children?: ReactNode };

// A thrown value is whatever the app threw, not necessarily an Error. Only V8
// puts the message in the stack, so Safari and Firefox need it prepended.
const describe = (error: unknown) => {
  if (!(error instanceof Error)) return String(error);
  if (!error.stack) return error.message;
  return error.stack.includes(error.message)
    ? error.stack
    : `${error.message}\n${error.stack}`;
};

// A throw during render otherwise unmounts the tree and leaves the host a blank
// frame. Matches the panel the sandbox paints for boot and renderer failures.
export class ErrorBoundary extends Component<Props, State> {
  state: State = { caught: false, detail: '' };

  // The host re-renders with fresh children whenever its data or theme changes.
  // Treat that as a request to try again instead of staying on an old failure.
  static getDerivedStateFromProps(props: Props, state: State): State | null {
    if (props.children === state.children) return null;
    return { caught: false, detail: '', children: props.children };
  }

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { caught: true, detail: describe(error) };
  }

  // console.error reaches .langsmith/browser-logs.txt, so the editing agent sees it.
  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error(error, info.componentStack);
  }

  render() {
    if (!this.state.caught) return this.props.children;

    return (
      <div
        role="alert"
        style={{
          background: '#fef2f2',
          border: '1px solid #fda29b',
          borderRadius: 8,
          padding: 12,
          margin: 16,
          color: '#b91c1c',
          fontSize: 13,
        }}
      >
        <strong>This app failed to render</strong>
        <pre
          style={{
            margin: '8px 0 0',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            font: 'inherit',
          }}
        >
          {this.state.detail}
        </pre>
      </div>
    );
  }
}
