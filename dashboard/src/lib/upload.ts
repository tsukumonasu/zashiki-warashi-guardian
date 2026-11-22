/**
 * Browser upload to a pre-signed S3 POST (docs/schema.md, `POST /faces/upload`).
 *
 * This is the only place besides the API client and sign-in that calls the network
 * (Requirement 19.6). It sends no Authorization header: the signature is in the form fields.
 * The pre-signed fields go first and `file` goes last, because S3 ignores fields after `file`.
 */

export interface UploadTicket {
  url: string;
  fields: Record<string, string>;
}

export type UploadResult = { readonly ok: true } | { readonly ok: false };

/**
 * Builds the multipart body: every pre-signed field, the `Content-Type` of the file, then
 * `file` as the last entry.
 *
 * The cloud's POST policy requires a `Content-Type` form field (`starts-with "image/"`), but a
 * pre-signed POST only returns the fields that are signed, so the browser must add this one
 * itself. Without it S3 answers 403 "Policy Condition failed". The value comes from the file the
 * user chose; a field that the ticket already carries is kept as it is.
 */
export function buildUploadForm(fields: Record<string, string>, file: Blob): FormData {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) form.append(name, value);
  const hasContentType = Object.keys(fields).some((name) => name.toLowerCase() === "content-type");
  if (!hasContentType && file.type !== "") form.append("Content-Type", file.type);
  form.append("file", file);
  return form;
}

/** POSTs the file to S3. Never throws and never reports the URL or the response body. */
export async function uploadToS3(
  ticket: UploadTicket,
  file: Blob,
  fetchImpl: typeof fetch = (input, init) => fetch(input, init),
): Promise<UploadResult> {
  try {
    const res = await fetchImpl(ticket.url, { method: "POST", body: buildUploadForm(ticket.fields, file) });
    return res.ok ? { ok: true } : { ok: false };
  } catch {
    return { ok: false };
  }
}
