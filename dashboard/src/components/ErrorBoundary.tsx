import { Component, type ErrorInfo, type ReactNode } from "react";
import { COPY } from "../content/copy";

interface Props {
  children: ReactNode;
}
interface State {
  failed: boolean;
}

/**
 * Replaces its children with a recovery message when one of them throws (Requirement 19.5).
 * The app shell keeps the header, Mute_Control and Privacy_Indicator outside this boundary.
 * It never logs: error details could carry data the privacy rules keep out of the console.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(_error: Error, _info: ErrorInfo): void {
    // Intentionally empty.
  }

  render(): ReactNode {
    if (this.state.failed) {
      return (
        <div className="error-boundary" role="alert">
          <p>{COPY.shell.errorBoundary}</p>
          <button type="button" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
