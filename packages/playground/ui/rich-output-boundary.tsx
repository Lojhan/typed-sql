import { Component, type ReactNode } from "react";
import { Button, Notice } from "./components";

/** A malformed artifact or renderer failure must not unmount the workspace. */
export class RichOutputBoundary extends Component<{ children: ReactNode; fallback?: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    if (!this.state.failed) return this.props.children;
    return (
      <>
        <Notice tone="error">
          This rich output could not be rendered.{" "}
          <Button onClick={() => this.setState({ failed: false })}>Retry rendering</Button>
        </Notice>
        {this.props.fallback}
      </>
    );
  }
}
