import { Component, type ErrorInfo, type ReactNode } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
  // Names the failing region in the fallback ("dashboard", "agent panel").
  label?: string;
}

interface ErrorBoundaryState {
  error: Error | null;
}

// Class component on purpose: error boundaries cannot be written as
// function components (getDerivedStateFromError/componentDidCatch have no
// hook equivalent).
export default class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(
      `ErrorBoundary caught an error in ${this.props.label ?? 'component'}:`,
      error,
      info,
    );
  }

  // Re-render the children as-is. Useful when the failure was caused by a
  // transient payload that a poll has since replaced; if the data is still
  // bad the boundary trips again and the operator can reload instead.
  handleRetry = (): void => {
    this.setState({ error: null });
  };

  handleReload = (): void => {
    window.location.reload();
  };

  render(): ReactNode {
    const { error } = this.state;
    if (error === null) return this.props.children;

    const label = this.props.label ?? 'dashboard';
    return (
      <div className="flex min-h-40 flex-1 items-center justify-center p-6" role="alert">
        <div className="ui-section w-full max-w-md space-y-3 p-4 text-center">
          <div className="text-error font-semibold">Something went wrong in the {label}</div>
          <div className="text-muted font-mono text-xs break-all">{error.message}</div>
          <div className="flex items-center justify-center gap-2">
            <button type="button" className="btn btn-sm btn-primary" onClick={this.handleRetry}>
              Try again
            </button>
            <button type="button" className="btn btn-sm btn-soft" onClick={this.handleReload}>
              Reload page
            </button>
          </div>
        </div>
      </div>
    );
  }
}
