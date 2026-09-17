import { z } from "zod";
import type { Batch, Template, Recipient } from "./types";
import { defaults } from "./types";
const recordSchema = z.object({
  id: z.string().max(100),
  name: z.string().max(10000),
  email: z.string().max(10000),
  reference: z.string().max(10000).default(""),
  certificate: z.string().max(300),
  certificateId: z.string().max(100).default(""),
  certificateHash: z.string().max(64).default(""),
  certificate_id: z.string().max(10000).default(""),
  match: z.string().max(100).default(""),
  approved: z.boolean().default(false),
  status: z.enum([
    "ready",
    "blocked",
    "skipped",
    "sending",
    "sent",
    "failed",
    "unknown",
    "stopped",
  ]),
  errors: z.array(z.string().max(10000)).max(30).default([]),
  warnings: z.array(z.string().max(10000)).max(30).default([]),
  attempts: z.number().int().min(0).max(10000).default(0),
  timestamp: z.string().max(100).optional(),
  gmailMessageId: z.string().max(200).optional(),
  error: z.string().max(10000).optional(),
});
const entrySchema = z.object({
  batchId: z.string().uuid(),
  createdAt: z.string().datetime(),
  status: z.enum([
    "draft",
    "sending",
    "paused",
    "stopping",
    "stopped",
    "complete",
  ]),
  records: z.array(recordSchema),
  certificateCount: z.number().int().min(0),
});
const historySchema = z.object({
  version: z.literal(1),
  batches: z.array(entrySchema).max(100),
});
export type HistoryEntry = z.infer<typeof entrySchema>;
export const HISTORY_KEY = "certflow.history.v1";
export function parseHistory(text: string): HistoryEntry[] {
  if (text.length > 20 * 1024 * 1024)
    throw Error("History file exceeds 20 MB.");
  const result = historySchema.safeParse(JSON.parse(text));
  if (!result.success)
    throw Error(
      "Invalid CertFlow history. Import a version 1 CertFlow JSON export.",
    );
  return result.data.batches;
}
export function loadHistory(): HistoryEntry[] {
  const value = localStorage.getItem(HISTORY_KEY);
  return value ? parseHistory(value) : [];
}
export function saveHistory(entries: HistoryEntry[]) {
  const json = JSON.stringify({ version: 1, batches: entries });
  parseHistory(json);
  localStorage.setItem(HISTORY_KEY, json);
}
export function snapshot(b: Batch): HistoryEntry {
  return {
    batchId: b.batchId,
    createdAt: b.createdAt,
    status: b.status,
    records: b.records,
    certificateCount: b.certificates.filter((c) => c.status === "valid").length,
  };
}
export function mergeHistory(
  current: HistoryEntry[],
  incoming: HistoryEntry[],
) {
  const all = new Map(current.map((b) => [b.batchId, b]));
  for (const b of incoming) {
    const existing = all.get(b.batchId);
    if (!existing) {
      all.set(b.batchId, b);
      continue;
    }
    const records = new Map(existing.records.map((r) => [r.id, r]));
    for (const r of b.records) {
      const old = records.get(r.id);
      if (
        !old ||
        (old.status !== "sent" &&
          (r.status === "sent" || (r.timestamp ?? "") > (old.timestamp ?? "")))
      )
        records.set(r.id, r);
    }
    all.set(b.batchId, { ...existing, records: [...records.values()] });
  }
  return [...all.values()].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  );
}
export const duplicateHistory = (entries: HistoryEntry[]) =>
  entries.flatMap((b) =>
    b.records
      .filter((r) => ["sent", "unknown", "sending"].includes(r.status))
      .map((r) => ({
        email: r.email,
        certificate: r.certificate,
        certificateHash: r.certificateHash,
      })),
  );
const csvCell = (s: unknown) => {
  let str = String(s ?? "");
  if (/^[\s]*[=+@-]/.test(str)) str = "'" + str;
  return '"' + str.replace(/"/g, '""') + '"';
};
export function reportCSV(records: Recipient[]) {
  const cols = [
    "name",
    "email",
    "certificate",
    "status",
    "timestamp",
    "gmail_message_id",
    "error",
  ];
  return (
    "\uFEFF" +
    [
      cols.join(","),
      ...records.map((r) =>
        [
          r.name,
          r.email,
          r.certificate,
          r.status,
          r.timestamp,
          r.gmailMessageId,
          r.error ?? r.errors.join("; "),
        ]
          .map(csvCell)
          .join(","),
      ),
    ].join("\r\n")
  );
}
export function retryCSV(records: Recipient[]) {
  return (
    "\uFEFFname,email\r\n" +
    records
      .map((r) =>
        [r.name, r.email]
          .map(csvCell)
          .join(","),
      )
      .join("\r\n")
  );
}
export function download(
  name: string,
  data: string,
  type = "application/json",
) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export interface Settings extends Template {
  theme: "light" | "dark" | "system";
}
export function loadSettings(): Settings {
  try {
    const raw = JSON.parse(localStorage.getItem("certflow.settings") ?? "{}");
    return {
      subject: typeof raw.subject === "string" ? raw.subject : defaults.subject,
      body: typeof raw.body === "string" ? raw.body : defaults.body,
      senderName:
        typeof raw.senderName === "string"
          ? raw.senderName
          : defaults.senderName,
      event: typeof raw.event === "string" ? raw.event : defaults.event,
      date: typeof raw.date === "string" ? raw.date : "",
      retryAttempts:
        Number.isInteger(raw.retryAttempts) &&
        raw.retryAttempts >= 0 &&
        raw.retryAttempts <= 5
          ? raw.retryAttempts
          : 3,
      emailDelay:
        Number.isInteger(raw.emailDelay) &&
        raw.emailDelay >= 1000 &&
        raw.emailDelay <= 60000
          ? raw.emailDelay
          : 1500,
      theme: ["light", "dark", "system"].includes(raw.theme)
        ? raw.theme
        : "system",
    };
  } catch {
    return { ...defaults, theme: "system" };
  }
}
