export type RecordStatus =
  | "ready"
  | "blocked"
  | "skipped"
  | "sending"
  | "sent"
  | "failed"
  | "unknown"
  | "stopped";
export interface Certificate {
  id: string;
  filename: string;
  relativePath: string;
  size: number;
  mime: string;
  hash: string;
  status: "valid" | "invalid" | "duplicate";
  error?: string;
  path?: string;
}
export interface Recipient {
  id: string;
  name: string;
  email: string;
  reference: string;
  certificateId: string;
  certificate: string;
  certificateHash: string;
  certificate_id: string;
  match: string;
  approved: boolean;
  status: RecordStatus;
  errors: string[];
  warnings: string[];
  timestamp?: string;
  gmailMessageId?: string;
  error?: string;
  attempts: number;
}
export interface Template {
  subject: string;
  body: string;
  senderName: string;
  event: string;
  date: string;
  retryAttempts: number;
  emailDelay: number;
}
export interface Mapping {
  name: string;
  email: string;
  certificate: string;
  certificate_id?: string;
}
export interface Batch {
  batchId: string;
  status: "draft" | "sending" | "paused" | "stopping" | "stopped" | "complete";
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  records: Recipient[];
  certificates: Certificate[];
  headers: string[];
  rows: Record<string, string>[];
  mapping?: Mapping;
  template: Template;
  directory: string;
  revision: number;
  testedRevision?: number;
  test?: { to: string; gmailMessageId: string; timestamp: string };
  currentRecipient?: string;
  expiresAt: number;
  filesAvailable: boolean;
  busy: boolean;
  work?: Promise<void>;
}
export const defaultTemplate: Template = {
  subject: "🎉 Congratulations {{name}} — Certificate of Participation",
  body: "Congratulations {{name}}!\n\nYou have successfully completed the workshop conducted by\n\n{{event}}\n\nYour dedication and participation are truly appreciated.\n\nPlease find your certificate attached with this email.",
  senderName: "Advanced Tech Club",
  event: "Advanced Tech Club x CDU",
  date: "",
  retryAttempts: 3,
  emailDelay: 1500,
};
export function publicBatch(b: Batch) {
  const counts = (status: string) =>
    b.records.filter((r) => r.status === status).length;
  return {
    batchId: b.batchId,
    status: b.status,
    createdAt: b.createdAt,
    startedAt: b.startedAt,
    completedAt: b.completedAt,
    records: b.records,
    certificates: b.certificates.map(({ path, ...c }) => c),
    headers: b.headers,
    mapping: b.mapping,
    template: b.template,
    revision: b.revision,
    testedRevision: b.testedRevision,
    test: b.test,
    currentRecipient: b.currentRecipient,
    filesAvailable: b.filesAvailable,
    expiresAt: b.expiresAt,
    total: b.records.length,
    processed: b.records.filter((r) =>
      ["sent", "failed", "unknown", "skipped", "stopped"].includes(r.status),
    ).length,
    sent: counts("sent"),
    failed: counts("failed"),
    skipped: counts("skipped"),
    unknown: counts("unknown"),
    ready: counts("ready"),
    blocked: counts("blocked"),
  };
}
