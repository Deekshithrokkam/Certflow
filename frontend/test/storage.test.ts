import { describe, it, expect, beforeEach } from "vitest";
import {
  parseHistory,
  mergeHistory,
  duplicateHistory,
  reportCSV,
  saveHistory,
  loadHistory,
} from "../src/storage";
const record = {
  id: "one",
  name: "John Doe",
  email: "john@gmail.com",
  certificate: "John_Doe.pdf",
  status: "sent",
  timestamp: "2026-09-16T00:00:00.000Z",
  gmailMessageId: "gmail-123",
};
const data = () =>
  JSON.stringify({
    version: 1,
    batches: [
      {
        batchId: "1e78b367-30ac-41d6-825a-0123456789ab",
        createdAt: "2026-09-16T00:00:00.000Z",
        status: "complete",
        records: [record],
        certificateCount: 1,
      },
    ],
  });
beforeEach(() => {
  const map = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    value: {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => map.set(k, v),
      removeItem: (k: string) => map.delete(k),
    },
    configurable: true,
  });
});
describe("browser-local history", () => {
  it("imports, stores and exports valid history without credentials", () => {
    const h = parseHistory(data());
    saveHistory(h);
    expect(loadHistory()).toEqual(h);
    expect(h[0].records[0].gmailMessageId).toBe("gmail-123");
  });
  it("rejects wrong versions and malformed records", () => {
    expect(() => parseHistory("{}")).toThrow();
    expect(() =>
      parseHistory(data().replace('"sent"', '"invented"')),
    ).toThrow();
  });
  it("does not overwrite a sent record with an older imported failure", () => {
    const h = parseHistory(data());
    const older = parseHistory(data());
    older[0].records[0].status = "failed";
    expect(mergeHistory(h, older)[0].records[0].status).toBe("sent");
  });
  it("uses sent and uncertain history for duplicate warnings", () => {
    const h = parseHistory(data());
    h[0].records.push({ ...h[0].records[0], id: "two", status: "unknown" });
    expect(duplicateHistory(h)).toHaveLength(2);
  });
  it("includes message IDs and prevents CSV formula execution", () => {
    const h = parseHistory(data());
    h[0].records[0].name = '=HYPERLINK("evil")';
    const csv = reportCSV(h[0].records);
    expect(csv).toContain("'=HYPERLINK");
    expect(csv).toContain("gmail-123");
  });
  it("surfaces quota errors instead of silently losing history", () => {
    localStorage.setItem = () => {
      throw Error("Quota exceeded");
    };
    expect(() => saveHistory(parseHistory(data()))).toThrow("Quota");
  });
});
