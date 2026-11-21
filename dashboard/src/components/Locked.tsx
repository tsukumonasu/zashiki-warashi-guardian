import { useId } from "react";

export interface LockedProps {
  /** The label of the control that is locked, for example "Look left". */
  label: string;
  /** Why it is locked. Linked to the control with aria-describedby. */
  explanation: string;
}

/**
 * A control that looks like a button but does nothing (Requirements 14.9, 16.1).
 *
 * It uses `aria-disabled` instead of `disabled` so keyboard and screen-reader users can still
 * focus it and hear the explanation. It takes no action prop and its only handler calls
 * `preventDefault`, so no code path from here reaches the API.
 */
export function Locked({ label, explanation }: LockedProps) {
  const explanationId = useId();
  return (
    <span className="locked">
      <button
        type="button"
        className="locked-control"
        aria-disabled="true"
        aria-describedby={explanationId}
        onClick={(event) => event.preventDefault()}
      >
        {label}
      </button>
      <span id={explanationId} className="locked-explanation">
        {explanation}
      </span>
    </span>
  );
}
