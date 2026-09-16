import type { Certificate, Recipient } from "./types.js";
const stem = (s: string) => s.replace(/\.[^.]+$/, "");
export const normalize = (s: string) =>
  stem(s)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
export function matchRecipients(
  records: Recipient[],
  certificates: Certificate[],
): Recipient[] {
  const files = certificates.filter((c) => c.status === "valid");
  const result = records.map((original) => {
    const r = {
      ...original,
      errors: [...original.errors],
      warnings: [...original.warnings],
    };
    const strategies: [string, (f: Certificate) => boolean][] = [
      [
        "Exact filename",
        (f) =>
          !!r.reference &&
          (f.filename === r.reference || f.relativePath === r.reference),
      ],
      [
        "Case-insensitive filename",
        (f) =>
          !!r.reference &&
          f.filename.toLowerCase() === r.reference.toLowerCase(),
      ],
      [
        "Normalized filename",
        (f) =>
          !!r.reference && normalize(f.filename) === normalize(r.reference),
      ],
      [
        "Certificate ID",
        (f) =>
          !!r.certificate_id &&
          normalize(f.filename) === normalize(r.certificate_id),
      ],
      [
        "Participant name",
        (f) => !!r.name && normalize(f.filename) === normalize(r.name),
      ],
      [
        "Email username",
        (f) =>
          !!r.email &&
          normalize(f.filename) === normalize(r.email.split("@")[0]),
      ],
    ];
    for (const [label, test] of strategies) {
      const found = files.filter(test);
      if (found.length > 1) {
        r.errors.push(
          `Ambiguous ${label.toLowerCase()} match. Correct the CSV or ZIP.`,
        );
        r.match = "Ambiguous";
        break;
      }
      if (found.length === 1) {
        const c = found[0];
        Object.assign(r, {
          certificateId: c.id,
          certificate: c.filename,
          certificateHash: c.hash,
          match: label,
          approved: label === "Exact filename",
        });
        if (!r.approved)
          r.warnings.push(
            "Suggested match: inspect the attachment and explicitly approve it.",
          );
        break;
      }
    }
    if (!r.certificateId)
      r.errors.push(`Certificate not found for ${r.name || r.email}.`);
    r.status = r.errors.length || !r.approved ? "blocked" : "ready";
    return r;
  });
  const used = new Map<string, number>();
  for (const r of result)
    if (r.certificateId)
      used.set(r.certificateId, (used.get(r.certificateId) ?? 0) + 1);
  for (const r of result)
    if ((used.get(r.certificateId) ?? 0) > 1) {
      r.errors.push(
        "The same certificate matched multiple recipients. Correct the source data.",
      );
      r.status = "blocked";
    }
  return result;
}
