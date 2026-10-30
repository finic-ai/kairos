import { Component, type ReactNode } from "react";

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <b>{title}</b>
      {children}
    </div>
  );
}

export class PageBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="card">
        <Empty title="This page could not be shown">
          <p>{this.state.error.message}</p>
          <button className="btn" onClick={() => window.location.reload()}>
            Reload
          </button>
        </Empty>
      </div>
    );
  }
}

export const Loading = () => <div className="empty muted">Loading…</div>;
export const Failure = ({ message }: { message: string }) => <div className="banner">{message}</div>;
