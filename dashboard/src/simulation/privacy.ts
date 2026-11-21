// Privacy of family labels in the simulation (Requirement 9). Pure: no React, no storage.
// Labels come from `GET /faces` (family role only) and are held in memory by the caller.

import catalog from "./data/voice-catalog.json";
import type { SchemaMessage, VerdictLabel } from "./types";

export interface LineText {
  ja: string;
  en: string;
}

const MAX_RESPONSE_TEXT = 200;

const CATALOG_TEXT: ReadonlyMap<string, LineText> = new Map(
  (catalog as { id: string; ja: string; en: string }[]).map((l) => [l.id, { ja: l.ja, en: l.en }]),
);

/** True when `text` contains any non-empty label, compared case-insensitively. */
export function containsLabel(text: string, labels: readonly string[]): boolean {
  const haystack = text.toLowerCase();
  return labels.some((label) => label !== "" && haystack.includes(label.toLowerCase()));
}

/**
 * Text to show for a spoken line. Only a `family` verdict may use the response text (it may
 * carry a nickname, Requirement 9.3); every other verdict gets the cached catalog text.
 * `labels` is accepted for the call-site contract; the family text is kept as is, and callers
 * must not copy it into the Timeline or any event.
 */
export function safeLineText(
  verdict: VerdictLabel,
  catalogLine: LineText,
  responseText: LineText | null | undefined,
  _labels: readonly string[],
): LineText {
  if (verdict !== "family" || !responseText) return catalogLine;
  const { ja, en } = responseText;
  const ok = (s: unknown): s is string =>
    typeof s === "string" && s.length > 0 && s.length <= MAX_RESPONSE_TEXT;
  return ok(ja) && ok(en) ? { ja, en } : catalogLine;
}

/** Remove every label occurrence (case-insensitive) until none is left. */
function stripLabels(text: string, labels: readonly string[]): string {
  let out = text;
  const active = labels.filter((l) => l !== "");
  while (containsLabel(out, active)) {
    for (const label of active) {
      const lower = label.toLowerCase();
      let i = out.toLowerCase().indexOf(lower);
      while (i >= 0) {
        out = out.slice(0, i) + out.slice(i + label.length);
        i = out.toLowerCase().indexOf(lower);
      }
    }
  }
  return out;
}

function scrubValue(value: unknown, labels: readonly string[]): unknown {
  if (typeof value === "string") return containsLabel(value, labels) ? stripLabels(value, labels) : value;
  if (Array.isArray(value)) return value.map((v) => scrubValue(v, labels));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, scrubValue(v, labels)]),
    );
  }
  return value;
}

/**
 * Returns messages with no label in any string. A `speak` whose text holds a label shows the
 * cached line text instead (Requirement 9.4); any other string loses the label.
 */
export function scrubMessages(
  messages: readonly SchemaMessage[],
  labels: readonly string[],
): SchemaMessage[] {
  return messages.map((m) => {
    if (m.type === "speak" && (containsLabel(m.data.ja, labels) || containsLabel(m.data.en, labels))) {
      const cached = m.data.lineId ? CATALOG_TEXT.get(m.data.lineId) : undefined;
      const text = cached ?? { ja: "", en: "" };
      return scrubValue({ ...m, data: { ...m.data, ...text } }, labels) as SchemaMessage;
    }
    return scrubValue(m, labels) as SchemaMessage;
  });
}
