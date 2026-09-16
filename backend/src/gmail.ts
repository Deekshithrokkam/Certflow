import { OAuth2Client } from "google-auth-library";
import { SendError } from "./errors.js";
export const makeOAuth = () =>
  new OAuth2Client(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI,
  );
export async function gmailSend(
  client: OAuth2Client,
  raw: string,
): Promise<string> {
  let token: string | null | undefined;
  try {
    token = (await client.getAccessToken()).token;
  } catch {
    throw new SendError(
      "Your Gmail connection needs attention. Please reconnect.",
      "auth",
    );
  }
  if (!token)
    throw new SendError(
      "Your Gmail connection needs attention. Please reconnect.",
      "auth",
    );
  let response: Response;
  try {
    response = await fetch(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ raw }),
        signal: AbortSignal.timeout(45000),
      },
    );
  } catch {
    throw new SendError(
      "Delivery is uncertain after a network interruption. Check Gmail Sent before sending again.",
      "unknown",
    );
  }
  const body = (await response.json().catch(() => null)) as {
    id?: string;
    error?: { errors?: { reason?: string }[] };
  } | null;
  if (response.ok && body?.id) return body.id;
  const reasons = body?.error?.errors?.map((e) => e.reason) ?? [];
  if (
    response.status === 429 ||
    (response.status === 403 &&
      reasons.some((r) =>
        ["rateLimitExceeded", "userRateLimitExceeded"].includes(r ?? ""),
      ))
  )
    throw new SendError(
      "Gmail temporarily limited sending. CertFlow will retry when appropriate.",
      "temporary",
      Math.min(
        60000,
        Math.max(0, Number(response.headers.get("retry-after") ?? 0) * 1000),
      ),
    );
  if (response.status === 401)
    throw new SendError(
      "Your Gmail connection needs attention. Please reconnect.",
      "auth",
    );
  if (response.status >= 500 || response.ok)
    throw new SendError(
      "Gmail did not confirm delivery. Check Gmail Sent before sending again.",
      "unknown",
    );
  throw new SendError(
    "Gmail rejected this message. Check permissions, recipient, account limits, and attachment.",
    "permanent",
  );
}
