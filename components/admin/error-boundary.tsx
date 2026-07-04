"use client";

import { Component, type ReactNode } from "react";

/** Wraps a subtree so a single malformed/throwing event can't crash the whole dashboard. */
export class ErrorBoundary extends Component<
  { children: ReactNode; fallback?: ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  render() {
    if (this.state.hasError) {
      return (
        this.props.fallback ?? (
          <div className="rounded border border-rose-300 bg-rose-50 px-2 py-1 text-xs text-rose-600 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-300">
            (could not render this event)
          </div>
        )
      );
    }
    return this.props.children;
  }
}
