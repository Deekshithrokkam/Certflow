// Zero (the default) means no application-level aggregate upload cap.
// Hosting capacity, per-certificate validation and Gmail limits still apply.
function optionalLimit(name: string, multiplier = 1): number {
  const raw = process.env[name]?.trim();
  const value = raw ? Number(raw) : 0;
  const scaled = value * multiplier;
  if (!Number.isSafeInteger(scaled) || scaled < 0)
    throw new Error(`${name} must be a nonnegative number with a safe integer byte/count value.`);
  return scaled;
}
const MB = 1024 * 1024;
export const uploadLimits = {
  zipBytes: optionalLimit("MAX_ZIP_MB", MB),
  csvBytes: optionalLimit("MAX_CSV_MB", MB),
  expandedBytes: optionalLimit("MAX_EXPANDED_MB", MB),
  entries: optionalLimit("MAX_ZIP_ENTRIES"),
  certificates: optionalLimit("MAX_CERTIFICATES"),
  recipients: optionalLimit("MAX_RECIPIENTS"),
};
