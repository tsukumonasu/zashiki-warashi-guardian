// Repository scan and documentation checks (task 25.3; R19.3, R25.3, R25.4, R25.8).
//
// The scan covers every file git tracks plus every file git does not ignore, so a new file is
// checked before its first commit. A failure names the path, the line and the rule. It never
// prints the matched text, because the match may be the secret itself.
//
// ALLOW LIST (documented, R25.4):
//   - files named `*.example` or `*.example.*` (placeholder files);
//   - e-mail addresses and hosts in the reserved `example.invalid`, `example.com`, `example.org`
//     and `example.net` domains, and the local part `you@` / `user@` on those domains;
//   - ARNs whose account id is `123456789012` or `000000000000` (AWS documentation placeholders);
//   - documentation placeholder account ids `123456789012` and `000000000000`;
//   - `docs/fixtures/` golden messages, which hold placeholder ids only and are still scanned by
//     every rule except the allow-listed values above;
//   - voice-session tokens (`<uuid>.<43 Base64URL characters>`) whose secret is one repeated
//     character or whose id is the all-zero placeholder (the `docs/fixtures/` golden messages);
//   - AppSync hosts that start with `xxxx`, `example`, `placeholder` or `your`;
//   - audio recordings (`*.wav`, `*.mp3` and similar) only inside `device/warashi_agent/voice/`,
//     which git ignores, so in practice never in a listed file;
//   - lock files and `.kiro/` spec text are scanned for secrets, but lock files skip the token rule
//     because integrity hashes look like tokens.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "..", "..");

function listFiles(): string[] {
  const out = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: REPO_ROOT, maxBuffer: 64 * 1024 * 1024 },
  ).toString("utf8");
  return [...new Set(out.split("\0").filter((f) => f.length > 0))].sort();
}

const PLACEHOLDER_ACCOUNTS = new Set(["123456789012", "000000000000"]);
const PLACEHOLDER_DOMAINS = ["example.invalid", "example.com", "example.org", "example.net"];

interface Rule {
  readonly id: string;
  readonly pattern: RegExp;
  /** Returns true when the match is allow-listed. */
  readonly allow?: (match: RegExpExecArray) => boolean;
  readonly skipFile?: (file: string) => boolean;
}

/** Documentation placeholders and ids made of one repeated digit (for example in test stacks). */
const isPlaceholderAccount = (id: string): boolean =>
  PLACEHOLDER_ACCOUNTS.has(id) || /^(\d)\1{11}$/.test(id);

const isLockFile = (f: string): boolean => /(^|\/)package-lock\.json$/.test(f);

const RULES: readonly Rule[] = [
  {
    id: "certificate-or-private-key",
    pattern: new RegExp("-----BEGIN [A-Z ]*(CERTIFICATE|PRIVATE KEY)[A-Z ]*-----"),
    // Test stubs for the provisioning script carry the body text STUB on the same line.
    allow: (m) => m.input.includes("STUB"),
  },
  {
    id: "aws-access-key-id",
    pattern: /\b(AKIA|ASIA)[A-Z0-9]{16}\b/,
  },
  {
    id: "token",
    pattern:
      /\b(gh[pousr]_[A-Za-z0-9]{30,}|xox[abprs]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,})/,
    skipFile: isLockFile,
  },
  {
    // A voice-session token (docs/schema.md "Voice session channels"). It is the only credential
    // of a session, so a real one must never be committed.
    id: "voice-session-token",
    pattern: /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})\b/,
    allow: (m) => /^0{8}-0{4}-4000-8000-0{12}$/.test(m[1] ?? "") || /^(.)\1{42}$/.test(m[2] ?? ""),
    skipFile: isLockFile,
  },
  {
    id: "arn-with-account-id",
    pattern: /arn:aws[a-z-]*:[a-z0-9-]+:[a-z0-9-]*:(\d{12}):/,
    allow: (m) => isPlaceholderAccount(m[1] ?? ""),
  },
  {
    id: "account-id",
    pattern: /\b(?:account(?:[ _-]?id)?|accountId)\b["']?\s*[:=]?\s*["']?(\d{12})\b/i,
    allow: (m) => isPlaceholderAccount(m[1] ?? ""),
  },
  {
    id: "endpoint-host",
    pattern:
      /\b[a-z0-9-]+(?:-ats)?\.(?:iot|execute-api|lambda-url)\.[a-z0-9-]+\.amazonaws\.com\b|\b[a-z0-9]{10,}\.cloudfront\.net\b|\b[a-z0-9]{10,}\.(?:appsync-api|appsync-realtime-api)\.[a-z0-9-]+\.amazonaws\.com\b|\b[a-z0-9-]+\.auth\.[a-z0-9-]+\.amazoncognito\.com\b/i,
    // Placeholder hosts and the made-up region `test-region` used by script stubs.
    allow: (m) => /^(?:xxxx|example|placeholder|your)|\.test-region\./i.test(m[0]),
  },
  {
    id: "email-address",
    pattern: /\b[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)\b/,
    allow: (m) => {
      const domain = (m[1] ?? "").toLowerCase();
      return (
        domain.endsWith(".example") ||
        PLACEHOLDER_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`))
      );
    },
    skipFile: isLockFile,
  },
  {
    id: "phone-number",
    pattern: /(?<![\w.-])(?:\+\d{1,3}[ -]?)?\(?\d{2,4}\)?[ -]\d{2,4}[ -]\d{4}(?![\w.-])/,
    skipFile: isLockFile,
  },
  {
    // Personal names are not detectable by pattern. This rule catches the places where the
    // contract says a name would appear: a literal `displayName` or `memberName` value that is
    // not a placeholder.
    id: "personal-name",
    pattern: /\b(?:displayName|memberName|fullName)["']?\s*[:=]\s*["']([^"'\s][^"']*)["']/,
    allow: (m) => /^(?:member|family|test|sample|placeholder|example|alice|bob|name|x+|a+|warashi|\$\{)/i.test(m[1] ?? ""),
    skipFile: (f) => /(^|\/)(test|tests)\//.test(f) || /\.test\.(ts|tsx)$/.test(f) || /test_.*\.py$/.test(f),
  },
];

const IMAGE_EXT = /\.(jpe?g|png|gif|webp|bmp|heic|tiff?)$/i;
const AUDIO_EXT = /\.(wav|mp3|pcm|ogg|opus|m4a|flac|aac)$/i;
/** The generated voice lines. Git ignores it; the exception only keeps the rule honest. */
const VOICE_FOLDER = /^device\/warashi_agent\/voice\//;
const SAMPLE_OR_FACE_PATH = /(^|\/)(samples?|faces?|selfies?)\//i;

function isExampleFile(file: string): boolean {
  return /\.example(\.[A-Za-z0-9]+)?$/.test(path.basename(file));
}

function readText(file: string): string | null {
  let buf: Buffer;
  try {
    buf = readFileSync(path.join(REPO_ROOT, file));
  } catch {
    return null; // deleted but still in the index
  }
  if (buf.subarray(0, 8000).includes(0)) return null; // binary
  return buf.toString("utf8");
}

export interface Finding {
  readonly file: string;
  readonly line: number;
  readonly rule: string;
}

/** Scan text with the rules. Exported shape is used by the self-test below. */
export function scanText(file: string, text: string): Finding[] {
  const findings: Finding[] = [];
  if (isExampleFile(file)) return findings;
  const lines = text.split(/\r?\n/);
  lines.forEach((content, index) => {
    if (content.length > 20000) return; // minified data; not source text
    for (const rule of RULES) {
      if (rule.skipFile?.(file)) continue;
      const re = new RegExp(rule.pattern.source, rule.pattern.flags.replace("g", "") + "g");
      for (let m = re.exec(content); m !== null; m = re.exec(content)) {
        if (rule.allow?.(m)) continue;
        findings.push({ file, line: index + 1, rule: rule.id });
      }
    }
  });
  return findings;
}

function scanPaths(files: readonly string[]): Finding[] {
  const images = files
    .filter((f) => IMAGE_EXT.test(f) && SAMPLE_OR_FACE_PATH.test(f) && !isExampleFile(f))
    .map((f) => ({ file: f, line: 0, rule: "image-under-sample-or-face-path" }));
  const audio = files
    .filter((f) => AUDIO_EXT.test(f) && !VOICE_FOLDER.test(f) && !isExampleFile(f))
    .map((f) => ({ file: f, line: 0, rule: "audio-recording" }));
  return [...images, ...audio];
}

const describeFinding = (f: Finding): string => `${f.file}:${f.line} violates rule "${f.rule}"`;

describe("repository scan (R25.3, R25.4)", () => {
  const files = listFiles();

  it("lists files and excludes ignored ones", () => {
    expect(files.length).toBeGreaterThan(20);
    expect(files).toContain("README.md");
    expect(files.some((f) => f.startsWith("cloud/node_modules/"))).toBe(false);
    expect(files.some((f) => f.endsWith("cdk.context.json"))).toBe(false);
  });

  it("finds no secret, account id, endpoint host, e-mail address, phone number or name", () => {
    const findings: Finding[] = [];
    for (const file of files) {
      const text = readText(file);
      if (text === null) continue;
      findings.push(...scanText(file, text));
    }
    expect(findings.map(describeFinding)).toEqual([]);
  });

  it("finds no image file under a sample or face path", () => {
    expect(scanPaths(files).map(describeFinding)).toEqual([]);
  });
});

describe("repository scan rules detect violations and honor the allow list", () => {
  // Values are assembled at run time so this file does not contain a match itself.
  const digits = ["4321", "9876", "5432"].join("");
  const arnBase = ["arn", "aws", "sns", "ap-northeast-1"].join(":");

  it("flags a private key header, naming the file and line but not the text", () => {
    const text = `ok\n${"-".repeat(5)}BEGIN PRIVATE KEY${"-".repeat(5)}\n`;
    const found = scanText("x.txt", text);
    expect(found).toEqual([{ file: "x.txt", line: 2, rule: "certificate-or-private-key" }]);
    expect(JSON.stringify(found)).not.toContain("BEGIN");
  });

  it("flags an ARN with a real-looking account id and allows the placeholder", () => {
    expect(scanText("a.md", `${arnBase}:${digits}:topic`).map((f) => f.rule)).toEqual([
      "arn-with-account-id",
    ]);
    expect(scanText("a.md", `${arnBase}:123456789012:topic`)).toEqual([]);
  });

  it("flags a stated account id", () => {
    expect(scanText("a.md", `account id: ${digits}`).map((f) => f.rule)).toEqual(["account-id"]);
  });

  it("flags an e-mail address and allows example domains", () => {
    expect(scanText("a.md", `mail ${"owner"}@${"mail"}.${"test-domain"}.jp`).map((f) => f.rule)).toEqual([
      "email-address",
    ]);
    expect(scanText("a.md", "you@example.invalid and a@sub.example.com")).toEqual([]);
  });

  it("flags an endpoint host", () => {
    const host = `abcd1234efgh-ats.iot.ap-northeast-1.${"amazonaws"}.com`;
    expect(scanText("a.md", `host ${host}`).map((f) => f.rule)).toEqual(["endpoint-host"]);
  });

  it("flags a phone number", () => {
    expect(scanText("a.md", `call ${["090", "1234", "5678"].join("-")}`).map((f) => f.rule)).toEqual(["phone-number"]);
  });

  it("flags a real-looking voice-session token and allows the placeholder", () => {
    const id = ["0b8f6c1e", "3a52", "4d0f", "9d53", "2f1f3c1f7a10"].join("-");
    const secret = "Zq8".repeat(14) + "Z";
    expect(scanText("a.md", `${id}.${secret}`).map((f) => f.rule)).toEqual(["voice-session-token"]);
    const placeholder = `${"0".repeat(8)}-0000-4000-8000-${"0".repeat(12)}.${"A".repeat(43)}`;
    expect(scanText("a.json", placeholder)).toEqual([]);
  });

  it("flags an AppSync host and allows a placeholder host", () => {
    const host = `abcdefghij1234.appsync-api.ap-northeast-1.${"amazonaws"}.com`;
    expect(scanText("a.md", host).map((f) => f.rule)).toEqual(["endpoint-host"]);
    expect(scanText("a.md", host.replace("abcdefghij1234", "xxxxxxxxxxxx"))).toEqual([]);
  });

  it("flags an audio recording outside the git-ignored voice folder", () => {
    expect(
      scanPaths(["docs/demo/hello.wav", "device/warashi_agent/voice/a.wav", "docs/a.md"]).map((f) => f.file),
    ).toEqual(["docs/demo/hello.wav"]);
  });

  it("skips *.example files", () => {
    expect(scanText("config.example.toml", `mail ${"a"}@${"b"}.jp`)).toEqual([]);
  });

  it("flags an image under a sample or face path only", () => {
    expect(scanPaths(["dashboard/public/samples/a.jpg", "docs/wiring/photo.jpg"]).map((f) => f.file)).toEqual([
      "dashboard/public/samples/a.jpg",
    ]);
  });
});

describe("README and .gitignore statements (R5.17, R9.12, R19.7, R25.8, R19.3)", () => {
  const readme = readFileSync(path.join(REPO_ROOT, "README.md"), "utf8").replace(/\s+/g, " ");
  const gitignore = readFileSync(path.join(REPO_ROOT, ".gitignore"), "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim());

  it("R5.17: the largest face decides the verdict", () => {
    expect(readme).toMatch(/largest face in the image is judged/i);
    expect(readme).toMatch(/second person/i);
  });

  it("R9.12: confirm the e-mail subscription within 48 hours", () => {
    expect(readme).toMatch(/confirm the e-mail subscription within 48 hours/i);
  });

  it("R19.7: teardown with npx cdk destroy --all", () => {
    expect(readme).toContain("npx cdk destroy --all");
  });

  it("R25.8: art piece, not an alarm product; a photograph may be greeted as family", () => {
    expect(readme).toMatch(/art piece and not an alarm product/i);
    expect(readme).toMatch(/photograph of a family member .*may be greeted as family/i);
  });

  it("R9.11: the voice section states the no-guardrails, photograph, Tokyo, no-storage and owner-step facts", () => {
    expect(readme).toMatch(/Nova Sonic has no guardrails/i);
    expect(readme).toMatch(/only proof that a family member is present/i);
    expect(readme).toMatch(/photograph of a family member .*passes/i);
    expect(readme).toMatch(/Amazon Bedrock in the Tokyo Region/i);
    expect(readme).toMatch(/Nothing is stored: no audio, no transcript/i);
    expect(readme).toContain("scripts/check_sonic_japanese.py");
    expect(readme).toContain("scripts/check_appsync_ordering.py");
    expect(readme).toContain(".kiro/specs/voice-conversation/tasks.md");
  });

  it("R19.3: cdk.context.json is ignored and the example file exists", () => {
    expect(gitignore).toContain("cdk.context.json");
    const files = listFiles();
    expect(files).toContain("cloud/cdk.context.example.json");
  });
});
