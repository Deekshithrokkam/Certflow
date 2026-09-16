export class AppError extends Error {
  constructor(
    public status: number,
    message: string,
    public code = "VALIDATION",
  ) {
    super(message);
  }
}
export class SendError extends Error {
  constructor(
    message: string,
    public kind: "temporary" | "auth" | "permanent" | "unknown",
    public retryAfter = 0,
  ) {
    super(message);
  }
}
