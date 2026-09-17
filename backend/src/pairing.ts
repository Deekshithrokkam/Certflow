import type { Certificate, Recipient } from "./types.js";
import { AppError } from "./errors.js";

// Preserve archive-entry and CSV-row order. Never sort, search by name,
// or discard invalid entries, since doing so could shift all later pairs.
export function pairRecipients(
  records: Recipient[],
  certificates: Certificate[],
): Recipient[] {
  if (!records.length || records.length !== certificates.length)
    throw new AppError(400,
      `Counts differ: ${certificates.length} certificates and ${records.length} CSV rows. Upload exactly one certificate per row in the same order.`);
  const invalid = certificates.findIndex((c) => c.status !== "valid");
  if (invalid !== -1)
    throw new AppError(400,
      `Certificate ${invalid + 1} (${certificates[invalid].relativePath}) is invalid. Replace it in the same ZIP position before continuing.`);
  return records.map((r, index) => {
    const c = certificates[index];
    return {
      ...r,
      errors: [...r.errors],
      warnings: [...r.warnings],
      certificateId: c.id,
      certificate: c.relativePath,
      certificateHash: c.hash,
      match: `ZIP position ${index + 1}`,
      approved: true,
      status: r.errors.length ? "blocked" as const : "ready" as const,
    };
  });
}
