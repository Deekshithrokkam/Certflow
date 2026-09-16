import { rm } from "node:fs/promises";
import type { Batch, Recipient } from "./types.js";
import { SendError } from "./errors.js";
export const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
export async function cleanFiles(batch: Batch) {
  await rm(batch.directory, { recursive: true, force: true });
  for (const c of batch.certificates) delete c.path;
  batch.filesAvailable = false;
}
export function stopBatch(batch: Batch) {
  batch.status = "stopping";
}
export async function runBatch(
  batch: Batch,
  send: (r: Recipient) => Promise<string>,
  emit: () => void,
  wait = sleep,
) {
  batch.status = "sending";
  batch.startedAt ??= new Date().toISOString();
  emit();
  try {
    for (const record of batch.records) {
      if (record.status !== "ready") continue;
      while ((batch.status as string) === "paused") {
        await wait(250);
      }
      if ((batch.status as string) === "stopping") break;
      batch.currentRecipient = record.id;
      record.status = "sending";
      emit();
      for (
        let attempt = 0;
        attempt <= batch.template.retryAttempts;
        attempt++
      ) {
        if ((batch.status as string) === "stopping") {
          record.status = "stopped";
          break;
        }
        while ((batch.status as string) === "paused") await wait(250);
        if ((batch.status as string) === "stopping") {
          record.status = "stopped";
          break;
        }
        record.attempts++;
        try {
          record.gmailMessageId = await send(record);
          record.status = "sent";
          record.timestamp = new Date().toISOString();
          delete record.error;
          break;
        } catch (error) {
          const e =
            error instanceof SendError
              ? error
              : new SendError(
                  "The attachment or message could not be prepared.",
                  "permanent",
                );
          record.error = e.message;
          if (
            e.kind === "temporary" &&
            attempt < batch.template.retryAttempts
          ) {
            emit();
            await wait(
              Math.max(e.retryAfter, Math.min(60000, 1000 * 2 ** attempt)),
            );
            continue;
          }
          record.status = e.kind === "unknown" ? "unknown" : "failed";
          record.timestamp = new Date().toISOString();
          if (e.kind === "auth") batch.status = "paused";
          break;
        }
      }
      emit();
      await wait(batch.template.emailDelay);
    }
    if ((batch.status as string) === "stopping") {
      for (const r of batch.records)
        if (["ready", "sending"].includes(r.status)) r.status = "stopped";
      batch.status = "stopped";
    } else batch.status = "complete";
  } catch {
    for (const r of batch.records)
      if (r.status === "sending") {
        r.status = "unknown";
        r.error = "Sending was interrupted. Verify Gmail Sent before retrying.";
      }
    batch.status = "stopped";
    for (const r of batch.records)
      if (r.status === "ready") r.status = "stopped";
  } finally {
    delete batch.currentRecipient;
    batch.completedAt = new Date().toISOString();
    await cleanFiles(batch);
    emit();
  }
}
