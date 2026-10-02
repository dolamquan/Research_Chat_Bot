/**
 * The last line of defence: without it a render-time throw leaves a black
 * screen with the real error only in the console.
 */
import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";

export default class AppErrorBoundary extends Component<
  { children: ReactNode },
  { error?: Error; info?: ErrorInfo }
> {
  state: { error?: Error; info?: ErrorInfo } = {};

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Zoetrope render error", error, info);
    this.setState({ error, info });
  }

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <div
        style={{
          minHeight: "100vh",
          background: "#0b0d10",
          color: "#f8fafc",
          padding: 32,
          fontFamily:
            "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
        }}
      >
        <div
          style={{
            maxWidth: 920,
            border: "1px solid #7f1d1d",
            background: "#1f1212",
            borderRadius: 12,
            padding: 24,
          }}
        >
          <h1 style={{ margin: 0, fontSize: 24 }}>Zoetrope crashed while rendering</h1>
          <p style={{ color: "#a09c92", lineHeight: 1.6 }}>
            The app is loaded, but a frontend runtime error stopped React from drawing the UI.
            This message is here so we can see the real issue instead of a black screen.
          </p>
          <pre
            style={{
              whiteSpace: "pre-wrap",
              color: "#fca5a5",
              background: "#0b0d10",
              border: "1px solid #3f1b1b",
              borderRadius: 8,
              padding: 16,
              overflow: "auto",
            }}
          >
            {this.state.error.message}
            {this.state.info?.componentStack ? `\n${this.state.info.componentStack}` : ""}
          </pre>
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{
              marginTop: 12,
              border: "1px solid #d7d3c7",
              background: "#d7d3c7",
              color: "#181916",
              borderRadius: 8,
              padding: "10px 14px",
              fontWeight: 700,
              cursor: "pointer",
            }}
          >
            Reload
          </button>
        </div>
      </div>
    );
  }
}
