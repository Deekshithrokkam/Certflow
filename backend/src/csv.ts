import { parse } from "csv-parse/sync";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { Mapping, Recipient } from "./types.js";
import { AppError } from "./errors.js";
const aliases = {
  name: ["name", "full_name", "participant", "participant_name"],
  email: ["email", "email_address", "recipient_email", "gmail"],
  certificate: ["certificate", "certificate_file", "filename", "file"],
  certificate_id: ["certificate_id", "id"],
};
export const validEmail = (value: string) =>
  value.length <= 254 &&
  z.email().safeParse(value).success &&
  !/[\r\n]/.test(value);
export function parseCSV(text: string) {
  let values: string[][];
  try {
    values = parse(text, {
      bom: true,
      skip_empty_lines: true,
      relax_column_count: false,
      max_record_size: 10000,
    });
  } catch {
    throw new AppError(
      400,
      "CSV could not be read. Check quoting and column counts.",
    );
  }
  if (values.length < 2 || values.length > 1001)
    throw new AppError(
      400,
      "CSV must contain a header and between 1 and 1,000 recipients.",
    );
  const headers = values[0];
  if (
    headers.length > 40 ||
    headers.some((h) => !h || h.length > 100) ||
    new Set(headers).size !== headers.length
  )
    throw new AppError(
      400,
      "CSV headers must be unique, nonempty, and at most 100 characters. Maximum 40 columns.",
    );
  const mapping: Mapping = {
    name: "",
    email: "",
    certificate: "",
    certificate_id: "",
  };
  for (const key of Object.keys(aliases) as (keyof typeof aliases)[]) {
    const matches = headers.filter((h) =>
      aliases[key].includes(h.toLowerCase()),
    );
    if (matches.length === 1) mapping[key] = matches[0];
  }
  const rows = values
    .slice(1)
    .map((v) => Object.fromEntries(headers.map((h, i) => [h, v[i] ?? ""])));
  return { headers, rows, mapping };
}
export function recipientsFromRows(
  rows: Record<string, string>[],
  mapping: Mapping,
): Recipient[] {
  const recipients = rows.map((row) => ({
    id: randomUUID(),
    name: row[mapping.name] ?? "",
    email: row[mapping.email] ?? "",
    reference: row[mapping.certificate] ?? "",
    certificate_id: mapping.certificate_id
      ? (row[mapping.certificate_id] ?? "")
      : "",
    certificateId: "",
    certificate: "",
    certificateHash: "",
    match: "Missing",
    approved: false,
    status: "blocked" as const,
    errors: [] as string[],
    warnings: [] as string[],
    attempts: 0,
  }));
  const counts = (key: "email" | "reference") =>
    recipients.reduce((map, r) => {
      const s = r[key].toLowerCase();
      if (s) map.set(s, (map.get(s) ?? 0) + 1);
      return map;
    }, new Map<string, number>());
  const emails = counts("email"),
    refs = counts("reference");
  for (const r of recipients) {
    if (!r.name.trim()) r.errors.push("Missing recipient name.");
    if (r.name !== r.name.trim())
      r.warnings.push(
        "Name contains leading or trailing spaces; values are preserved.",
      );
    if (!validEmail(r.email))
      r.errors.push(`Invalid recipient email: ${r.email}`);
    if ((emails.get(r.email.toLowerCase()) ?? 0) > 1)
      r.errors.push("Duplicate email address in CSV.");
    if (!r.reference)
      r.warnings.push(
        "Missing certificate reference; any suggested match requires approval.",
      );
    if ((refs.get(r.reference.toLowerCase()) ?? 0) > 1)
      r.errors.push("Duplicate certificate reference in CSV.");
  }
  return recipients;
}
