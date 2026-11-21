/**
 * Pure helpers for the family face registration form (Requirements 15.4, 15.6).
 * No DOM, no Date: the page passes plain values in, so the rules are property-testable.
 */

/** Largest face photo the cloud accepts (`POST /faces/upload`, docs/schema.md). */
export const MAX_FACE_FILE_BYTES = 5_000_000;

export const MIN_DISPLAY_NAME_LENGTH = 1;
export const MAX_DISPLAY_NAME_LENGTH = 40;

const ALLOWED_TYPES: readonly string[] = ["image/jpeg", "image/png"];

export type FaceFileCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/** Accepts exactly JPEG and PNG of at most 5,000,000 bytes; otherwise returns a reason to show. */
export function validateFaceFile(file: {
  type: string;
  size: number;
}): FaceFileCheck {
  if (!ALLOWED_TYPES.includes(file.type)) {
    return { ok: false, reason: "The photo must be a JPEG or PNG image." };
  }
  if (!(file.size <= MAX_FACE_FILE_BYTES)) {
    return { ok: false, reason: "The photo must be 5 MB or smaller." };
  }
  return { ok: true };
}

/**
 * True only when consent is exactly `true` and the name has 1 to 40 Unicode
 * code points (not UTF-16 units, so emoji and rare kanji count as one).
 */
export function canRegister(consent: boolean, displayName: string): boolean {
  if (consent !== true) return false;
  const length = Array.from(displayName).length;
  return length >= MIN_DISPLAY_NAME_LENGTH && length <= MAX_DISPLAY_NAME_LENGTH;
}
