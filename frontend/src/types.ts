export type {
  Certificate,
  Recipient,
  Template,
  Mapping,
} from "../../backend/src/types";
import type {
  Certificate,
  Recipient,
  Template,
  Mapping,
} from "../../backend/src/types";
export interface Batch {
  batchId: string;
  status: "draft" | "sending" | "paused" | "stopping" | "stopped" | "complete";
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  records: Recipient[];
  certificates: Certificate[];
  headers: string[];
  mapping?: Mapping;
  template: Template;
  revision: number;
  testedRevision?: number;
  test?: { to: string; gmailMessageId: string; timestamp: string };
  currentRecipient?: string;
  filesAvailable: boolean;
  expiresAt: number;
  total: number;
  processed: number;
  sent: number;
  failed: number;
  skipped: number;
  unknown: number;
  ready: number;
  blocked: number;
}
export const defaults: Template = {
  subject: "🎉 Congratulations {{name}} — Certificate of Participation",
  body: "Congratulations {{name}}!\n\nYou have successfully completed the workshop conducted by\n\n{{event}}\n\nYour dedication and participation are truly appreciated.\n\nPlease find your certificate attached with this email.",
  senderName: "Advanced Tech Club",
  event: "Advanced Tech Club x CDU",
  date: "",
  retryAttempts: 3,
  emailDelay: 1500,
};
