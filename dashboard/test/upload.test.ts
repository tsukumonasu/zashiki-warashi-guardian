import { describe, expect, it } from "vitest";
import { buildUploadForm, uploadToS3 } from "../src/lib/upload";

const signedFields = { key: "faces-staging/abc", policy: "p", "x-amz-signature": "s" };

function entryNames(form: FormData): string[] {
  return [...form.keys()];
}

describe("buildUploadForm", () => {
  it("adds the file's Content-Type before the file, which stays last", () => {
    const file = new File(["x"], "me.jpg", { type: "image/jpeg" });
    const form = buildUploadForm(signedFields, file);
    expect(form.get("Content-Type")).toBe("image/jpeg");
    const names = entryNames(form);
    expect(names.at(-1)).toBe("file");
    expect(names.indexOf("Content-Type")).toBeLessThan(names.indexOf("file"));
  });

  it("keeps every signed field first, in order", () => {
    const form = buildUploadForm(signedFields, new File(["x"], "me.png", { type: "image/png" }));
    expect(entryNames(form).slice(0, 3)).toEqual(["key", "policy", "x-amz-signature"]);
  });

  it("does not add a second Content-Type when the ticket carries one", () => {
    const fields = { ...signedFields, "content-type": "image/png" };
    const form = buildUploadForm(fields, new File(["x"], "me.png", { type: "image/jpeg" }));
    expect(form.getAll("content-type")).toEqual(["image/png"]);
    expect(form.has("Content-Type")).toBe(false);
  });

  it("adds no Content-Type when the file has no type", () => {
    const form = buildUploadForm(signedFields, new Blob(["x"]));
    expect(form.has("Content-Type")).toBe(false);
  });
});

describe("uploadToS3", () => {
  it("posts the form with the Content-Type field", async () => {
    let sent: FormData | null = null;
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      sent = init?.body as FormData;
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    const file = new File(["x"], "me.jpg", { type: "image/jpeg" });
    const result = await uploadToS3({ url: "https://example.invalid/", fields: signedFields }, file, fetchImpl);
    expect(result).toEqual({ ok: true });
    expect((sent as FormData | null)?.get("Content-Type")).toBe("image/jpeg");
  });
});
