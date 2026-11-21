import { useCallback, useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { COPY } from "../content/copy";
import { Locked } from "../components/Locked";
import { capabilities, type Role } from "../lib/roles";
import type { ApiClient, FaceMember } from "../lib/api";
import { uploadToS3, type UploadResult, type UploadTicket } from "../lib/upload";
import { canRegister, validateFaceFile } from "../simulation/faces";

/** Consent notice texts bundled per version: `content/consent/<version>.md`. */
const NOTICES: Record<string, string> = Object.fromEntries(
  Object.entries(import.meta.glob("../content/consent/*.md", { query: "?raw", import: "default", eager: true })).map(
    ([path, text]) => [path.replace(/^.*\/([^/]+)\.md$/, "$1"), String(text)],
  ),
);

export interface FamilyPageProps {
  api: ApiClient;
  role: Role;
  /** Injected for tests; defaults to the S3 upload helper. */
  upload?: (ticket: UploadTicket, file: Blob) => Promise<UploadResult>;
  /** False while the browser is offline: register, delete and upload are disabled. Default true. */
  online?: boolean;
}

type Message = { kind: "error" | "info"; text: string } | null;

function NoticeText({ text }: { text: string }) {
  return (
    <div className="consent-notice">
      {text
        .split(/\n\s*\n/)
        .map((block) => block.trim())
        .filter((block) => block !== "")
        .map((block) =>
          block.startsWith("# ") ? <h3 key={block}>{block.slice(2)}</h3> : <p key={block}>{block}</p>,
        )}
    </div>
  );
}

/**
 * Face registration for the family (Requirement 15).
 * Reviewers and visitors get Locked controls and this page sends them no `/faces` request.
 */
export function FamilyPage({ api, role, upload = uploadToS3, online = true }: FamilyPageProps) {
  const allowed = capabilities(role).faces;
  const [members, setMembers] = useState<FaceMember[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [noticeVersion, setNoticeVersion] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [consent, setConsent] = useState(false);
  const [memberId, setMemberId] = useState<string>("");
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [message, setMessage] = useState<Message>(null);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState<FaceMember | null>(null);
  const previewRef = useRef<string | null>(null);

  const discardFile = useCallback(() => {
    if (previewRef.current !== null) URL.revokeObjectURL(previewRef.current);
    previewRef.current = null;
    setPreviewUrl(null);
    setFile(null);
  }, []);

  useEffect(
    () => () => {
      if (previewRef.current !== null) URL.revokeObjectURL(previewRef.current);
    },
    [],
  );

  const loadMe = useCallback(async () => {
    const me = await api.me();
    if (me.ok) setNoticeVersion(me.value.consentNoticeVersion);
  }, [api]);

  const loadFaces = useCallback(async () => {
    const res = await api.faces();
    if (res.ok) {
      setMembers(res.value.members);
      setLoadFailed(false);
    } else {
      setLoadFailed(true);
    }
  }, [api]);

  useEffect(() => {
    if (!allowed) return;
    void loadMe();
    void loadFaces();
  }, [allowed, loadMe, loadFaces]);

  if (!allowed) {
    const why = role === "visitor" ? COPY.locked.visitor : COPY.family.lockedFaces;
    return (
      <section className="family-page" aria-label={COPY.family.heading}>
        <h2>{COPY.family.heading}</h2>
        <Locked label={COPY.family.register} explanation={why} />
        <Locked label={COPY.family.delete} explanation={why} />
      </section>
    );
  }

  const noticeText = noticeVersion === null ? undefined : NOTICES[noticeVersion];
  const noticeMissing = noticeVersion !== null && noticeText === undefined;
  const ready = online && noticeText !== undefined && !busy && file !== null && canRegister(consent, name);

  function onFile(event: ChangeEvent<HTMLInputElement>): void {
    const chosen = event.target.files?.[0] ?? null;
    discardFile();
    setMessage(null);
    if (chosen === null) return;
    const check = validateFaceFile({ type: chosen.type, size: chosen.size });
    if (!check.ok) {
      setMessage({ kind: "error", text: check.reason });
      event.target.value = "";
      return;
    }
    const url = URL.createObjectURL(chosen);
    previewRef.current = url;
    setPreviewUrl(url);
    setFile(chosen);
  }

  function resetForm(): void {
    discardFile();
    setName("");
    setConsent(false);
    setMemberId("");
  }

  async function onSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!ready || file === null || noticeVersion === null) return;
    setBusy(true);
    setMessage(null);
    try {
      const ticket = await api.faceUpload();
      if (!ticket.ok) {
        setMessage({ kind: "error", text: COPY.family.registerFailed });
        return;
      }
      const sent = await upload({ url: ticket.value.url, fields: ticket.value.fields }, file);
      if (!sent.ok) {
        setMessage({ kind: "error", text: COPY.family.registerFailed });
        return;
      }
      const done = await api.faceRegister({
        stagingKey: ticket.value.stagingKey,
        displayName: name,
        memberId: memberId === "" ? null : memberId,
        consent: { noticeVersion, accepted: true },
      });
      if (done.ok) {
        resetForm();
        setMessage({ kind: "info", text: COPY.family.registered });
        await loadFaces();
      } else if (done.error.code === "face_count_invalid") {
        setMessage({ kind: "error", text: COPY.family.oneFace });
      } else if (done.error.code === "consent_required") {
        setConsent(false);
        await loadMe();
        setMessage({ kind: "error", text: COPY.family.consentAgain });
      } else {
        setMessage({ kind: "error", text: COPY.family.registerFailed });
      }
    } finally {
      // The operation is over: the photo and its preview are never kept (Requirement 15.10).
      discardFile();
      setBusy(false);
    }
  }

  async function confirmDelete(): Promise<void> {
    if (deleting === null) return;
    const target = deleting;
    setBusy(true);
    const res = await api.faceDelete(target.memberId);
    setBusy(false);
    setDeleting(null);
    discardFile();
    if (res.ok) {
      setMembers((current) => (current ?? []).filter((m) => m.memberId !== target.memberId));
      if (memberId === target.memberId) setMemberId("");
      setMessage(null);
    } else {
      setMessage({ kind: "error", text: COPY.family.deleteFailed });
    }
  }

  return (
    <section className="family-page" aria-label={COPY.family.heading}>
      <h2>{COPY.family.heading}</h2>

      {loadFailed ? (
        <p role="alert">{COPY.family.loadFailed}</p>
      ) : members !== null && members.length === 0 ? (
        <p>{COPY.family.noMembers}</p>
      ) : (
        <ul className="face-list">
          {(members ?? []).map((m) => (
            <li key={m.memberId}>
              <span className="face-name">{m.displayName}</span>{" "}
              <span className="face-meta">
                {m.faceCount} {m.faceCount === 1 ? "photo" : "photos"}, added {m.createdAt}
              </span>{" "}
              <button type="button" disabled={busy || !online} onClick={() => setDeleting(m)}>
                {COPY.family.delete}
                <span className="visually-hidden"> {m.displayName}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={(e) => void onSubmit(e)}>
        {noticeText !== undefined && <NoticeText text={noticeText} />}
        {noticeMissing && <p role="alert">{COPY.family.noticeOutOfDate}</p>}

        <label>
          {COPY.family.nameLabel}
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />
        </label>

        <label>
          {COPY.family.addToLabel}
          <select value={memberId} onChange={(e) => setMemberId(e.target.value)}>
            <option value="">{COPY.family.newMember}</option>
            {(members ?? []).map((m) => (
              <option key={m.memberId} value={m.memberId}>
                {m.displayName}
              </option>
            ))}
          </select>
        </label>

        <label>
          {COPY.family.photoLabel}
          <input type="file" accept="image/jpeg,image/png" disabled={!online} onChange={onFile} />
        </label>
        {previewUrl !== null && <img src={previewUrl} alt={COPY.family.previewAlt} className="face-preview" />}

        <label>
          <input
            type="checkbox"
            checked={consent}
            disabled={noticeText === undefined}
            onChange={(e) => setConsent(e.target.checked)}
          />
          {COPY.family.consentLabel}
        </label>

        <button type="submit" disabled={!ready}>
          {COPY.family.register}
        </button>
        {!online && <p className="offline-note">{COPY.shell.offlineFaces}</p>}
      </form>

      {message !== null && <p role={message.kind === "error" ? "alert" : "status"}>{message.text}</p>}

      <p className="privacy-note">{COPY.family.storedNote}</p>

      {deleting !== null && (
        <div role="alertdialog" aria-modal="true" aria-labelledby="delete-title" aria-describedby="delete-body">
          <h3 id="delete-title">{COPY.family.deleteTitle(deleting.displayName)}</h3>
          <p id="delete-body">{COPY.family.deleteBody}</p>
          <button type="button" disabled={busy || !online} onClick={() => void confirmDelete()}>
            {COPY.family.confirmDelete}
          </button>
          <button type="button" autoFocus onClick={() => setDeleting(null)}>
            {COPY.family.cancel}
          </button>
        </div>
      )}
    </section>
  );
}
