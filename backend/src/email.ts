import MailComposer from "nodemailer/lib/mail-composer/index.js";
import { readFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import type { Certificate, Recipient, Template } from "./types.js";
import { AppError } from "./errors.js";
export const escapeHTML = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
export function renderEmail(template: Template, record: Recipient) {
  const vars: Record<string, string> = {
    name: record.name,
    email: record.email,
    certificate: record.certificate,
    event: template.event,
    date: template.date,
    certificate_id: record.certificate_id,
  };
  const substitute = (s: string) =>
    s.replace(/{{\s*(\w+)\s*}}/g, (_, key: string) => {
      if (!(key in vars))
        throw new AppError(400, `Unknown template variable: ${key}`);
      if (!vars[key])
        throw new AppError(400, `Missing value for template variable: ${key}`);
      return vars[key];
    });
  const subject = substitute(template.subject);
  if (/[\r\n]/.test(subject) || subject.length > 300)
    throw new AppError(
      400,
      "Subject must be one line and no more than 300 characters.",
    );
  const text = substitute(template.body);
  const paragraphs = text
    .split(/\n\s*\n/)
    .map(
      (p) =>
        `<p style="margin:0 0 18px;line-height:1.7;color:#374151">${escapeHTML(p).replace(/\n/g, "<br>")}</p>`,
    )
    .join("");
  const html = `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;padding:0;background:#f3f5f7;font-family:Arial,Helvetica,sans-serif"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f5f7"><tr><td align="center" style="padding:32px 12px"><table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:#ffffff;border:1px solid #e3e8e6;border-radius:16px"><tr><td style="padding:36px 24px 24px;text-align:center;border-bottom:1px solid #edf0ee"><p style="font-size:42px;margin:0 0 16px">🎉</p><h1 style="font-size:25px;line-height:1.3;color:#173e35;margin:0">CONGRATULATIONS!</h1></td></tr><tr><td style="padding:28px 24px;font-size:16px">${paragraphs}<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="padding:18px;background:#f3f5f7;border:1px solid #e5e7eb;border-radius:8px;color:#374151;font-size:14px">📎 Attachment:<br><strong>${escapeHTML(record.certificate)}</strong></td></tr><tr><td style="padding:24px 0"><p style="margin:0;padding:20px;background:#e9f5ef;border-radius:8px;color:#173e35;line-height:1.6">🚀 Keep learning, keep building, and keep pushing your limits.</p></td></tr></table><p style="margin:0 0 18px;line-height:1.7;color:#374151">We look forward to seeing you in our upcoming events.</p><p style="margin:0 0 18px;line-height:1.7;color:#374151">Regards,<br>${escapeHTML(template.senderName)}</p></td></tr><tr><td style="padding:20px 24px;background:#f8faf9;text-align:center;font-size:13px;color:#5d7067;border-radius:0 0 16px 16px">See you in the upcoming workshops 🚀</td></tr></table></td></tr></table></body></html>`;
  return {
    subject,
    text: `${text}\n\nAttachment: ${record.certificate}\n\n🚀 Keep learning, keep building, and keep pushing your limits.\n\nWe look forward to seeing you in our upcoming events.\n\nRegards,\n${template.senderName}\n\nSee you in the upcoming workshops 🚀`,
    html,
  };
}
export async function buildMIME(
  from: string,
  to: string,
  template: Template,
  record: Recipient,
  certificate: Certificate,
) {
  if (!certificate.path)
    throw new AppError(
      409,
      "Attachments expired. Create a new batch with a ZIP and CSV containing the same recipients in the same order.",
    );
  const content = await readFile(certificate.path);
  if (
    createHash("sha256").update(content).digest("hex") !==
    record.certificateHash
  )
    throw new AppError(
      409,
      "Certificate integrity check failed. Sending is blocked.",
    );
  const { subject, text, html } = renderEmail(template, record);
  const message = new MailComposer({
    from: { name: template.senderName, address: from },
    to: [{ address: to, name: to === record.email ? record.name : "" }],
    subject,
    text,
    html,
    messageId: `<${randomUUID()}@certflow.local>`,
    attachments: [
      {
        filename: certificate.filename,
        content,
        contentType: certificate.mime,
        contentDisposition: "attachment",
      },
    ],
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  return (await message.compile().build()).toString("base64url");
}
