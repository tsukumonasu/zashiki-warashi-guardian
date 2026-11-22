import { useEffect, useId, useRef, useState } from "react";
import { COPY } from "../content/copy";

export interface InfoTipProps {
  /** The explanation. Plain text, in the current language. */
  text: string;
}

/**
 * A small "i" button that explains the thing next to it. It opens on hover and keyboard focus
 * (mouse), and toggles on click or tap (touch). Escape and a click elsewhere close it.
 */
export function InfoTip({ text }: InfoTipProps) {
  const [pinned, setPinned] = useState(false);
  const [hover, setHover] = useState(false);
  const id = useId();
  const rootRef = useRef<HTMLSpanElement>(null);
  const open = pinned || hover;

  useEffect(() => {
    if (!pinned) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setPinned(false);
    };
    const onDown = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setPinned(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [pinned]);

  return (
    <span
      className="info"
      ref={rootRef}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <button
        type="button"
        className="info__button"
        aria-label={COPY.shell.infoLabel}
        aria-expanded={open}
        aria-describedby={open ? id : undefined}
        onClick={() => setPinned((v) => !v)}
        onFocus={() => setHover(true)}
        onBlur={() => setHover(false)}
      >
        i
      </button>
      {open && (
        <span role="tooltip" id={id} className="info__tip">
          {text}
        </span>
      )}
    </span>
  );
}
