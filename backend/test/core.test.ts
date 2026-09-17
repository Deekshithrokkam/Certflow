import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID, createHash } from "node:crypto";
import JSZip from "jszip";
import { PDFDocument } from "pdf-lib";
import { simpleParser } from "mailparser";
import { parseCSV, recipientsFromRows, validEmail } from "../src/csv.js";
import { pairRecipients } from "../src/pairing.js";
import { safeZipPath, inspectZip } from "../src/zip.js";
import { renderEmail, buildMIME } from "../src/email.js";
import { defaultTemplate, type Batch, type Certificate } from "../src/types.js";
import { runBatch } from "../src/engine.js";
import { SendError } from "../src/errors.js";
import { gmailSend } from "../src/gmail.js";
const dirs: string[] = [];
async function temp() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "certflow-test-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});
const csv =
  "name,email,certificate\nJohn Doe,john@gmail.com,John_Doe.pdf\nRahul Kumar,rahul@gmail.com,Rahul_Kumar.pdf\nPriya Sharma,priya@gmail.com,Priya_Sharma.pdf";
const rows = () => {
  const p = parseCSV(csv);
  return recipientsFromRows(p.rows, p.mapping);
};
const certs = (): Certificate[] =>
  ["John_Doe.pdf", "Rahul_Kumar.pdf", "Priya_Sharma.pdf"].map((filename) => ({
    id: randomUUID(),
    filename,
    relativePath: filename,
    size: 30,
    mime: "application/pdf",
    hash: "abc",
    status: "valid",
  }));
async function batch(): Promise<Batch> {
  return {
    batchId: randomUUID(),
    status: "draft",
    createdAt: new Date().toISOString(),
    certificates: certs(),
    records: [],
    headers: [],
    rows: [],
    template: { ...defaultTemplate, emailDelay: 0 },
    directory: await temp(),
    revision: 0,
    expiresAt: Date.now() + 1000,
    filesAvailable: true,
    busy: false,
  };
}
async function pdf() {
  const d = await PDFDocument.create();
  d.addPage().drawText("Certificate");
  return Buffer.from(await d.save());
}
describe("CSV and validation", () => {
  it("detects aliases, BOM, and quoted CSV without changing values", () => {
    const p = parseCSV(
      '\uFEFFfull_name,recipient_email,certificate_file\r\n"Doe, John",john@gmail.com,John_Doe.pdf',
    );
    expect(p.mapping.name).toBe("full_name");
    expect(p.rows[0].full_name).toBe("Doe, John");
  });
  it("rejects malformed CSV, duplicate headers, and empty input", () => {
    for (const s of [
      "name,name\nx,y",
      "name,email\nx,y,z",
      "name,email",
    ])
      expect(() => parseCSV(s)).toThrow();
  });
  it("accepts more than 1,000 CSV recipients without a configured cap", () => {
    expect(parseCSV("name,email\n" + Array(1001).fill("a,b").join("\n")).rows).toHaveLength(1001);
  });
  it("requires unambiguous alias mapping", () =>
    expect(parseCSV("name,full_name,email\na,b,x@y.com").mapping.name).toBe(
      "",
    ));
  it("accepts one email only and rejects injection and whitespace", () => {
    expect(validEmail("a.b+tag@example.com")).toBe(true);
    for (const value of [
      "john@@gmail.com",
      "a@b.com,c@d.com",
      " a@b.com",
      "a@b.com\r\nBcc:x@y.com",
    ])
      expect(validEmail(value)).toBe(false);
  });
  it("flags duplicate emails and missing fields", () => {
    const p = parseCSV(
      "name,email,certificate\n,john@@gmail.com,same.pdf\nJohn,john@@gmail.com,same.pdf",
    );
    const r = recipientsFromRows(p.rows, p.mapping);
    expect(r[0].errors).toHaveLength(3);
  });
  it("preserves spaces and warns rather than silently changing data", () => {
    const p = parseCSV("name,email,certificate\n John ,john@gmail.com,");
    const [r] = recipientsFromRows(p.rows, p.mapping);
    expect(r.name).toBe(" John ");
    expect(r.warnings).toHaveLength(1);
  });
});
describe("ordered pairing", () => {
  it("pairs name/email rows by archive order regardless of filenames", () => {
    const parsed = parseCSV("names,gmails\nFirst,first@example.com\nSecond,second@example.com\nThird,third@example.com");
    const files = certs().reverse();
    const paired = pairRecipients(recipientsFromRows(parsed.rows, parsed.mapping), files);
    expect(paired.map((r) => r.certificateId)).toEqual(files.map((f) => f.id));
    expect(paired.map((r) => r.name)).toEqual(["First", "Second", "Third"]);
    expect(paired.every((r) => r.status === "ready" && r.approved)).toBe(true);
  });
  it("rejects extra or missing certificates instead of truncating", () => {
    expect(() => pairRecipients(rows(), [])).toThrow("Counts differ");
    expect(() => pairRecipients(rows(), certs().slice(1))).toThrow("Counts differ");
    expect(() => pairRecipients(rows(), [...certs(), certs()[0]])).toThrow("Counts differ");
  });
  it("rejects invalid files without shifting later assignments", () => {
    const files = certs();
    files[1].status = "invalid";
    expect(() => pairRecipients(rows(), files)).toThrow("Certificate 2");
  });
  it("keeps invalid recipient rows in position", () => {
    const recipients = rows(), files = certs();
    recipients[0].errors.push("Invalid email");
    const paired = pairRecipients(recipients, files);
    expect(paired[0].status).toBe("blocked");
    expect(paired[1].certificateId).toBe(files[1].id);
    expect(paired[2].certificateId).toBe(files[2].id);
  });
});
describe("ZIP security and files", () => {
  it.each([
    "../a.pdf",
    "/a.pdf",
    "C:/a.pdf",
    "a/../../b",
    "a\\b.pdf",
    "a\u0000.pdf",
  ])("rejects path %s", (p) => expect(safeZipPath(p)).toBe(false));
  it("preserves archive order, allows repeated basenames, and flags corrupt content", async () => {
    const zip = new JSZip();
    const data = await pdf();
    zip.file("a/John.pdf", data);
    zip.file("b/john.pdf", data);
    zip.file("other/valid.pdf", data);
    zip.file(".DS_Store", "ignore");
    zip.file("__MACOSX/metadata", "ignore");
    zip.file("broken.pdf", "%PDF fake");
    zip.file("script.js", "alert(1)");
    const dir = await temp(),
      archive = path.join(dir, "input.zip");
    await writeFile(archive, await zip.generateAsync({ type: "nodebuffer" }));
    const files = await inspectZip(archive, dir);
    expect(files).toHaveLength(5);
    expect(files.filter((f) => f.status === "valid")).toHaveLength(3);
    expect(files.map((f) => f.relativePath)).toEqual(["a/John.pdf", "b/john.pdf", "other/valid.pdf", "broken.pdf", "script.js"]);
    expect(files.filter((f) => f.status === "invalid")).toHaveLength(2);
    expect(files.find((f) => f.filename === "valid.pdf")?.mime).toBe(
      "application/pdf",
    );
  });
  it("rejects malformed archives", async () => {
    const dir = await temp(),
      archive = path.join(dir, "bad.zip");
    await writeFile(archive, "not a zip");
    await expect(inspectZip(archive, dir)).rejects.toThrow();
  });
  it("rejects a real traversal entry", async () => {
    const dir = await temp(),
      archive = path.join(dir, "traversal.zip"),
      z = new JSZip();
    z.file("../outside.pdf", await pdf());
    await writeFile(archive, await z.generateAsync({ type: "nodebuffer" }));
    await expect(inspectZip(archive, dir)).rejects.toThrow();
  });
  it("rejects symlinks", async () => {
    const dir = await temp(),
      archive = path.join(dir, "link.zip"),
      z = new JSZip();
    z.file("link.pdf", "/etc/passwd", { unixPermissions: 0o120777 });
    await writeFile(
      archive,
      await z.generateAsync({ type: "nodebuffer", platform: "UNIX" }),
    );
    await expect(inspectZip(archive, dir)).rejects.toThrow("Symbolic");
  });
  it("rejects zip bombs before extraction", async () => {
    const dir = await temp(),
      archive = path.join(dir, "bomb.zip"),
      z = new JSZip();
    z.file("bomb.pdf", Buffer.alloc(1024 * 1024));
    await writeFile(
      archive,
      await z.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }),
    );
    await expect(inspectZip(archive, dir)).rejects.toThrow("safety limits");
  });
});
describe("HTML and MIME", () => {
  it("escapes all recipient HTML and rejects unknown or missing variables", () => {
    const r = pairRecipients(rows(), certs())[0];
    r.name = "<img src=x onerror=alert(1)>";
    expect(renderEmail(defaultTemplate, r).html).toContain("&lt;img");
    expect(renderEmail(defaultTemplate, r).html).not.toContain("<img");
    expect(() =>
      renderEmail({ ...defaultTemplate, body: "{{unknown}}" }, r),
    ).toThrow();
    expect(() =>
      renderEmail({ ...defaultTemplate, body: "{{date}}" }, r),
    ).toThrow();
  });
  it("builds a single-recipient MIME message with a real attachment", async () => {
    const r = pairRecipients(rows(), certs())[0],
      content = await pdf(),
      dir = await temp();
    const file = path.join(dir, "certificate");
    await writeFile(file, content);
    r.certificateHash = createHash("sha256").update(content).digest("hex");
    const c = {
      ...certs()[0],
      path: file,
      filename: r.certificate,
      hash: r.certificateHash,
    };
    const raw = await buildMIME(
      "sender@gmail.com",
      r.email,
      defaultTemplate,
      r,
      c,
    );
    const message = await simpleParser(Buffer.from(raw, "base64url"));
    expect(message.to).toMatchObject({
      value: [{ address: "john@gmail.com" }],
    });
    expect(message.cc).toBeUndefined();
    expect(message.bcc).toBeUndefined();
    expect(message.attachments).toHaveLength(1);
    expect(message.attachments[0].content.equals(content)).toBe(true);
    expect(message.subject).toContain("John Doe");
    expect(message.html).toContain("CONGRATULATIONS!");
    await writeFile(file, "changed");
    await expect(
      buildMIME("sender@gmail.com", r.email, defaultTemplate, r, c),
    ).rejects.toThrow("integrity");
  });
});
describe("batch state and delivery safety", () => {
  it("sends sequentially, records IDs, and deletes attachments on completion", async () => {
    const b = await batch();
    b.records = pairRecipients(rows(), b.certificates);
    let inFlight = 0,
      max = 0;
    await runBatch(
      b,
      async (r) => {
        inFlight++;
        max = Math.max(max, inFlight);
        await Promise.resolve();
        inFlight--;
        return `gmail-${r.id}`;
      },
      () => {},
      async () => {},
    );
    expect(max).toBe(1);
    expect(
      b.records.every((r) => r.status === "sent" && r.gmailMessageId),
    ).toBe(true);
    expect(b.status).toBe("complete");
    expect(b.filesAvailable).toBe(false);
  });
  it("retries temporary errors with bounded exponential backoff", async () => {
    const b = await batch();
    b.records = pairRecipients(rows(), b.certificates).slice(0, 1);
    let calls = 0;
    const waits: number[] = [];
    await runBatch(
      b,
      async () => {
        if (++calls < 3) throw new SendError("rate limit", "temporary");
        return "gmail";
      },
      () => {},
      async (n) => {
        waits.push(n);
      },
    );
    expect(calls).toBe(3);
    expect(waits.slice(0, 2)).toEqual([1000, 2000]);
  });
  it("does not retry permanent or uncertain deliveries", async () => {
    for (const kind of ["permanent", "unknown"] as const) {
      const b = await batch();
      b.records = pairRecipients(rows(), b.certificates).slice(0, 1);
      let count = 0;
      await runBatch(
        b,
        async () => {
          count++;
          throw new SendError("failure", kind);
        },
        () => {},
        async () => {},
      );
      expect(count).toBe(1);
      expect(b.records[0].status).toBe(
        kind === "unknown" ? "unknown" : "failed",
      );
    }
  });
  it("pauses between messages and resumes without duplication", async () => {
    const b = await batch();
    b.records = pairRecipients(rows(), b.certificates);
    let count = 0,
      paused = false;
    await runBatch(
      b,
      async () => {
        count++;
        return "id" + count;
      },
      () => {
        if (count === 1 && b.records[0].status === "sent" && !paused) {
          b.status = "paused";
          paused = true;
        }
      },
      async (n) => {
        if (n === 250) {
          expect(count).toBe(1);
          b.status = "sending";
        }
      },
    );
    expect(count).toBe(3);
  });
  it("stops after the in-flight message and marks remaining recipients stopped", async () => {
    const b = await batch();
    b.records = pairRecipients(rows(), b.certificates);
    let count = 0;
    await runBatch(
      b,
      async () => {
        count++;
        b.status = "stopping";
        return "id";
      },
      () => {},
      async () => {},
    );
    expect(count).toBe(1);
    expect(b.records.map((r) => r.status)).toEqual([
      "sent",
      "stopped",
      "stopped",
    ]);
    expect(b.filesAvailable).toBe(false);
  });
});
