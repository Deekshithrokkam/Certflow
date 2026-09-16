import { it, expect, vi, afterEach } from "vitest";
import { gmailSend } from "../src/gmail.js";
import type { OAuth2Client } from "google-auth-library";
const client = {
  getAccessToken: async () => ({ token: "test-only-token" }),
} as OAuth2Client;
afterEach(() => vi.unstubAllGlobals());
it("uses the Gmail API with base64url MIME and returns the message ID", async () => {
  const fetch = vi.fn(
    async () =>
      new Response(JSON.stringify({ id: "gmail-id" }), { status: 200 }),
  );
  vi.stubGlobal("fetch", fetch);
  expect(await gmailSend(client, "encoded-mime")).toBe("gmail-id");
  expect(fetch.mock.calls[0][0]).toContain("/users/me/messages/send");
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({
    raw: "encoded-mime",
  });
});
it("classifies authentication failures", async () => {
  vi.stubGlobal("fetch", async () => new Response("{}", { status: 401 }));
  await expect(gmailSend(client, "raw")).rejects.toMatchObject({
    kind: "auth",
  });
});
it("marks network interruptions and server errors as uncertain", async () => {
  vi.stubGlobal("fetch", async () => {
    throw Error("network");
  });
  await expect(gmailSend(client, "raw")).rejects.toMatchObject({
    kind: "unknown",
  });
  vi.stubGlobal("fetch", async () => new Response("{}", { status: 503 }));
  await expect(gmailSend(client, "raw")).rejects.toMatchObject({
    kind: "unknown",
  });
});
it("retries only explicit temporary rejection, honoring Retry-After", async () => {
  vi.stubGlobal(
    "fetch",
    async () =>
      new Response("{}", { status: 429, headers: { "retry-after": "3" } }),
  );
  await expect(gmailSend(client, "raw")).rejects.toMatchObject({
    kind: "temporary",
    retryAfter: 3000,
  });
});
it("does not retry permanent Gmail permission errors", async () => {
  vi.stubGlobal("fetch", async () => new Response("{}", { status: 403 }));
  await expect(gmailSend(client, "raw")).rejects.toMatchObject({
    kind: "permanent",
  });
});
