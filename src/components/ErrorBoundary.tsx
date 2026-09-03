import { Component, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";

/**
 * A render crash inside one pane must not blank the window. The boundary
 * draws the error where the pane was, with the stack for a bug report.
 */
export class ErrorBoundary extends Component<{ children: ReactNode; label?: string; fallback?: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string }) {
    console.error(`[${this.props.label ?? "pane"}] render failed`, error, info.componentStack);
    void invoke("frontend_log", { level: "error", message: `render failed in ${this.props.label}: ${error.message} ${String(error.stack ?? "").split("\n").slice(0, 3).join(" | ")}` }).catch(() => {});
  }

  render() {
    if (this.state.error) {
      if (this.props.fallback !== undefined) return this.props.fallback;
      return (
        <div className="m-4 select-text rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
          <div className="font-medium">Something went wrong in {this.props.label ?? "this pane"}.</div>
          <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap font-mono text-xs">
            {String(this.state.error?.stack ?? this.state.error)}
          </pre>
          <button
            type="button"
            className="mt-3 rounded-md bg-destructive/20 px-2 py-1 text-xs"
            onClick={() => this.setState({ error: null })}
          >
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
