import express, {
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { createServer } from "node:http";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import { rateLimit } from "express-rate-limit";
import multer from "multer";
import { mkdtemp, mkdir, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { Server } from "socket.io";
import { z } from "zod";
import type { OAuth2Client } from "google-auth-library";
import { AppError, SendError } from "./errors.js";
import { defaultTemplate, publicBatch, type Batch } from "./types.js";
import { parseCSV, recipientsFromRows, validEmail } from "./csv.js";
import { matchRecipients } from "./matching.js";
import { inspectZip } from "./zip.js";
import { uploadLimits } from "./limits.js";
import { buildMIME, renderEmail } from "./email.js";
import { makeOAuth, gmailSend } from "./gmail.js";
import { runBatch, cleanFiles, stopBatch } from "./engine.js";
interface Session {
  id: string;
  csrf: string;
  expires: number;
  email?: string;
  oauth?: OAuth2Client;
  state?: string;
  verifier?: string;
  stateExpires?: number;
  batch?: Batch;
  busy?: boolean;
  testKeys: Map<
    string,
    { status: "pending" | "sent" | "failed" | "unknown"; messageId?: string }
  >;
}
declare global {
  namespace Express {
    interface Request {
      cf: Session;
    }
  }
}
const mappingSchema = z
  .object({
    name: z.string().min(1),
    email: z.string().min(1),
    certificate: z.string(),
    certificate_id: z.string().optional(),
  })
  .strict();
export const templateSchema = z
  .object({
    subject: z
      .string()
      .min(1)
      .max(250)
      .refine((s) => !/[\r\n]/.test(s)),
    body: z.string().min(1).max(20000),
    senderName: z
      .string()
      .min(1)
      .max(100)
      .refine((s) => !/[\r\n]/.test(s)),
    event: z.string().max(300),
    date: z.string().max(100),
    retryAttempts: z.number().int().min(0).max(5),
    emailDelay: z.number().int().min(1000).max(60000),
  })
  .strict();
const active = (b?: Batch) =>
  b && ["sending", "paused", "stopping"].includes(b.status);
export async function createApplication(
  options: {
    sendRaw?: typeof gmailSend;
    frontend?: string;
    secret?: string;
  } = {},
) {
  const frontend =
    options.frontend ?? process.env.FRONTEND_URL ?? "http://localhost:5173";
  const production = process.env.NODE_ENV === "production";
  const secret = options.secret ?? process.env.SESSION_SECRET;
  if (!secret || secret.length < 32)
    throw Error("SESSION_SECRET must contain at least 32 characters.");
  if (
    production &&
    (!frontend.startsWith("https://") ||
      !process.env.GOOGLE_REDIRECT_URI?.startsWith("https://"))
  )
    throw Error(
      "HTTPS frontend and OAuth redirect URLs are required in production.",
    );
  const root = await mkdtemp(path.join(os.tmpdir(), "certflow-"));
  const sessions = new Map<string, Session>();
  const app = express(),
    http = createServer(app);
  app.set("trust proxy", 1);
  app.disable("x-powered-by");
  app.use(helmet());
  app.use(cors({ origin: frontend, credentials: true }));
  // Duplicate-history requests may contain a large, locally saved batch.
  app.use(express.json({ limit: "25mb" }));
  app.use(cookieParser(secret));
  app.use(
    "/api",
    rateLimit({
      windowMs: 60000,
      limit: 180,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      message: { error: "Too many requests. Please wait a minute." },
    }),
  );
  const cookieOptions = {
    httpOnly: true,
    secure: production,
    sameSite: (process.env.COOKIE_SAME_SITE === "none" ? "none" : "lax") as
      | "none"
      | "lax",
    signed: true,
    path: "/",
    maxAge: 8 * 60 * 60 * 1000,
  };
  const cookieName = production ? "__Host-certflow" : "certflow";
  const getSession = (req: Request) => {
    const id = req.signedCookies?.[cookieName];
    const s = typeof id === "string" ? sessions.get(id) : undefined;
    return s && s.expires > Date.now() ? s : undefined;
  };
  const newSession = (res: Response) => {
    if (sessions.size >= 200)
      throw new AppError(
        503,
        "Server capacity reached. Please try again later.",
      );
    const s: Session = {
      id: randomBytes(32).toString("hex"),
      csrf: randomBytes(32).toString("hex"),
      expires: Date.now() + 8 * 60 * 60 * 1000,
      testKeys: new Map(),
    };
    sessions.set(s.id, s);
    res.cookie(cookieName, s.id, cookieOptions);
    return s;
  };
  app.use("/api", (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  app.get("/api/health", (_req, res) =>
    res.json({ ok: true, service: "CertFlow", storage: "temporary-memory" }),
  );
  app.get("/api/auth/me", (req, res) => {
    const s = getSession(req) ?? newSession(res);
    res.json({
      email: s.email ?? null,
      csrf: s.csrf,
      configured: !!(
        process.env.GOOGLE_CLIENT_ID &&
        process.env.GOOGLE_CLIENT_SECRET &&
        process.env.GOOGLE_REDIRECT_URI
      ),
    });
  });
  app.get("/api/auth/google", async (req, res) => {
    if (
      !process.env.GOOGLE_CLIENT_ID ||
      !process.env.GOOGLE_CLIENT_SECRET ||
      !process.env.GOOGLE_REDIRECT_URI
    )
      throw new AppError(
        503,
        "Gmail sign-in is not configured. Set the backend Google OAuth environment variables.",
      );
    const s = getSession(req) ?? newSession(res);
    if (active(s.batch) || s.busy)
      throw new AppError(
        409,
        "Stop the current batch before reconnecting Gmail.",
      );
    const client = makeOAuth(),
      codes = await client.generateCodeVerifierAsync();
    s.state = randomBytes(32).toString("hex");
    s.verifier = codes.codeVerifier;
    s.stateExpires = Date.now() + 600000;
    res.redirect(
      client.generateAuthUrl({
        scope: [
          "openid",
          "email",
          "https://www.googleapis.com/auth/gmail.send",
        ],
        access_type: "offline",
        prompt: "consent",
        state: s.state,
        code_challenge: codes.codeChallenge,
        code_challenge_method: "S256" as never,
      }),
    );
  });
  app.get("/api/auth/google/callback", async (req, res) => {
    const s = getSession(req);
    const state = typeof req.query.state === "string" ? req.query.state : "";
    if (
      !s ||
      !s.state ||
      state !== s.state ||
      !s.stateExpires ||
      s.stateExpires < Date.now()
    )
      return res.redirect(`${frontend}/?auth=failed`);
    const verifier = s.verifier;
    delete s.state;
    delete s.verifier;
    delete s.stateExpires;
    try {
      if (typeof req.query.code !== "string") throw Error();
      const oauth = makeOAuth();
      const { tokens } = await oauth.getToken({
        code: req.query.code,
        codeVerifier: verifier,
      });
      if (
        !tokens.id_token ||
        !tokens.scope
          ?.split(" ")
          .includes("https://www.googleapis.com/auth/gmail.send")
      )
        throw Error();
      const ticket = await oauth.verifyIdToken({
        idToken: tokens.id_token,
        audience: process.env.GOOGLE_CLIENT_ID,
      });
      const profile = ticket.getPayload();
      if (!profile?.email || !profile.email_verified) throw Error();
      oauth.setCredentials(tokens);
      if (s.batch) await cleanFiles(s.batch);
      sessions.delete(s.id);
      const next = newSession(res);
      next.email = profile.email;
      next.oauth = oauth;
      res.redirect(`${frontend}/app`);
    } catch {
      res.redirect(`${frontend}/?auth=failed`);
    }
  });
  app.use("/api", (req, res, next) => {
    const s = getSession(req);
    if (!s?.email || !s.oauth)
      return res
        .status(401)
        .json({
          error: "Your Gmail connection needs attention. Please reconnect.",
        });
    req.cf = s;
    if (
      !["GET", "HEAD"].includes(req.method) &&
      (req.get("origin") !== new URL(frontend).origin ||
        req.get("x-csrf-token") !== s.csrf)
    )
      return res
        .status(403)
        .json({
          error:
            "Request could not be verified. Reload the page and try again.",
        });
    next();
  });
  const io = new Server(http, {
    cors: { origin: frontend, credentials: true },
    maxHttpBufferSize: 1024,
    allowRequest: (req, callback) =>
      callback(null, req.headers.origin === new URL(frontend).origin),
  });
  io.use((socket, next) => {
    const fake = { headers: socket.request.headers } as Request;
    cookieParser(secret)(fake, {} as Response, () => {
      const s = getSession(fake);
      if (!s?.email || socket.handshake.auth.csrf !== s.csrf)
        return next(Error("Unauthorized"));
      socket.data.sid = s.id;
      next();
    });
  });
  io.on("connection", (socket) => {
    socket.join(socket.data.sid);
    const b = sessions.get(socket.data.sid)?.batch;
    if (b) socket.emit("batch", publicBatch(b));
  });
  const emit = (s: Session) => {
    if (s.batch) io.to(s.id).emit("batch", publicBatch(s.batch));
  };
  const batch = (req: Request) => {
    const b = req.cf.batch;
    if (!b) throw new AppError(404, "Create a batch first.");
    if (b.expiresAt < Date.now())
      throw new AppError(
        410,
        "This batch expired. Start a new batch and upload your files again.",
      );
    return b;
  };
  const mutable = (req: Request) => {
    const b = batch(req);
    if (b.status !== "draft" || b.busy || req.cf.busy)
      throw new AppError(
        409,
        "This batch is locked. Start a new batch to make changes.",
      );
    return b;
  };
  const change = (b: Batch) => {
    b.revision++;
    delete b.testedRevision;
    delete b.test;
    b.expiresAt = Date.now() + 2 * 60 * 60 * 1000;
  };
  const sendRaw = options.sendRaw ?? gmailSend;
  const sendRecord = (
    s: Session,
    b: Batch,
    r: Batch["records"][number],
    to = r.email,
  ) => {
    const c = b.certificates.find(
      (c) => c.id === r.certificateId && c.status === "valid",
    );
    if (!c) throw new AppError(409, "Matched certificate is not available.");
    return buildMIME(s.email!, to, b.template, r, c).then((raw) =>
      sendRaw(s.oauth!, raw),
    );
  };
  app.post("/api/auth/logout", async (req, res) => {
    if (active(req.cf.batch) || req.cf.busy)
      throw new AppError(409, "Stop the active batch before disconnecting.");
    if (req.cf.batch) await cleanFiles(req.cf.batch);
    await req.cf.oauth?.revokeCredentials().catch(() => undefined);
    sessions.delete(req.cf.id);
    io.in(req.cf.id).disconnectSockets(true);
    res.clearCookie(cookieName, { ...cookieOptions, maxAge: undefined });
    res.json({ ok: true });
  });
  app.post("/api/batch/new", async (req, res) => {
    if (active(req.cf.batch) || req.cf.busy)
      throw new AppError(409, "Finish or stop the active batch first.");
    req.cf.busy = true;
    try {
      if (req.cf.batch) await cleanFiles(req.cf.batch);
      const directory = await mkdtemp(path.join(root, "batch-"));
      req.cf.batch = {
        batchId: randomUUID(),
        status: "draft",
        createdAt: new Date().toISOString(),
        records: [],
        certificates: [],
        headers: [],
        rows: [],
        template: { ...defaultTemplate },
        directory,
        revision: 0,
        expiresAt: Date.now() + 2 * 60 * 60 * 1000,
        filesAvailable: false,
        busy: false,
      };
      res.json(publicBatch(req.cf.batch));
    } finally {
      req.cf.busy = false;
    }
  });
  const makeUpload = (fileSize: number) => multer({
    dest: root,
    limits: { ...(fileSize > 0 ? { fileSize } : {}), files: 1, fields: 0 },
  }).single("file");
  const uploads = {
    zip: makeUpload(uploadLimits.zipBytes),
    csv: makeUpload(uploadLimits.csvBytes),
  };
  const uploadGate = (req: Request, _res: Response, next: NextFunction) => {
    const b = mutable(req);
    if (b.records.some((r) => ['sent', 'unknown'].includes(r.status)))
      throw new AppError(409, 'This batch already has deliveries. Create a new batch to replace files.');
    b.busy = true;
    req.cf.busy = true;
    next();
  };
  function uploaded(handler: (req: Request) => Promise<unknown>) {
    return (req: Request, res: Response, next: NextFunction) => {
      const kind = req.path.endsWith("upload-zip") ? "zip" : "csv";
      uploads[kind](req, res, (err) => {
        void (async () => {
          let result: unknown;
          try {
            if (err)
              throw new AppError(
                err.code === "LIMIT_FILE_SIZE" ? 413 : 400,
                err.code === "LIMIT_FILE_SIZE"
                  ? `${kind.toUpperCase()} exceeds the configured ${uploadLimits[kind === "zip" ? "zipBytes" : "csvBytes"] / (1024 * 1024)} MB upload limit.`
                  : "Upload failed. Send one file without additional form fields.",
              );
            if (!req.file) throw new AppError(400, "Choose a file to upload.");
            result = await handler(req);
          } finally {
            if (req.file) await rm(req.file.path, { force: true });
            if (req.cf.batch) req.cf.batch.busy = false;
            req.cf.busy = false;
          }
          res.json(result);
        })().catch(next);
      });
    };
  }
  app.post(
    "/api/batch/upload-zip",
    uploadGate,
    uploaded(async (req) => {
      const b = batch(req);
      if (!req.file!.originalname.toLowerCase().endsWith(".zip"))
        throw new AppError(400, "Upload a ZIP archive.");
      const directory = await mkdtemp(path.join(root, "files-"));
      try {
        const files = await inspectZip(req.file!.path, directory);
        await rm(b.directory, { recursive: true, force: true });
        b.directory = directory;
        b.certificates = files;
        b.filesAvailable = true;
        b.records = [];
        change(b);
        return publicBatch(b);
      } catch (e) {
        await rm(directory, { recursive: true, force: true });
        throw e;
      }
    }),
  );
  app.post(
    "/api/batch/upload-csv",
    uploadGate,
    uploaded(async (req) => {
      const b = batch(req);
      if (!req.file!.originalname.toLowerCase().endsWith(".csv"))
        throw new AppError(400, "Upload a CSV file.");
      const bytes = await readFile(req.file!.path);
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw new AppError(400, "CSV must use UTF-8 encoding.");
      }
      const parsed = parseCSV(text);
      Object.assign(b, parsed);
      b.records = [];
      change(b);
      return publicBatch(b);
    }),
  );
  app.post("/api/batch/analyze", (req, res) =>
    res.json(publicBatch(batch(req))),
  );
  app.post("/api/batch/match", (req, res) => {
    const b = mutable(req);
    if (b.records.some((r) => ['sent', 'unknown'].includes(r.status)))
      throw new AppError(409, 'Delivered or uncertain records cannot be rematched. Create a new batch.');
    const data = z
      .object({
        mapping: mappingSchema,
        history: z
          .array(
            z.object({
              email: z.string(),
              certificate: z.string(),
              certificateHash: z.string().optional(),
            }),
          )
          .default([]),
      })
      .strict()
      .parse(req.body);
    for (const key of Object.values(data.mapping))
      if (key && !b.headers.includes(key))
        throw new AppError(400, "Mapped column was not found in the CSV.");
    if (!b.rows.length || !b.filesAvailable)
      throw new AppError(409, "Upload both the CSV and ZIP first.");
    b.mapping = data.mapping;
    b.records = matchRecipients(
      recipientsFromRows(b.rows, data.mapping),
      b.certificates,
    );
    for (const r of b.records)
      if (
        data.history.some(
          (h) =>
            h.email.toLowerCase() === r.email.toLowerCase() &&
            (h.certificate.toLowerCase() === r.certificate.toLowerCase() ||
              (!!h.certificateHash && h.certificateHash === r.certificateHash)),
        )
      ) {
        r.warnings.push(
          "POSSIBLE DUPLICATE: your local history contains this recipient and certificate. Choose Skip or Send Again.",
        );
        r.status = "blocked";
      }
    change(b);
    res.json(publicBatch(b));
  });
  app.post("/api/batch/record", (req, res) => {
    const b = mutable(req);
    const data = z
      .object({
        id: z.string(),
        action: z.enum(["approve", "skip", "send-again"]),
      })
      .strict()
      .parse(req.body);
    const r = b.records.find((r) => r.id === data.id);
    if (!r) throw new AppError(404, "Recipient not found.");
    if (['sent', 'unknown', 'sending', 'failed', 'stopped'].includes(r.status))
      throw new AppError(409, 'Delivery records are immutable. Create a reviewed retry batch instead.');
    if (data.action === "skip") r.status = "skipped";
    else {
      if (r.errors.length)
        throw new AppError(
          409,
          "Correct the CSV or ZIP and match again to fix validation errors.",
        );
      if (data.action === "approve") r.approved = true;
      if (data.action === "send-again")
        r.warnings = r.warnings.filter(
          (w) => !w.startsWith("POSSIBLE DUPLICATE"),
        );
      r.status =
        r.approved &&
        !r.warnings.some((w) => w.startsWith("POSSIBLE DUPLICATE"))
          ? "ready"
          : "blocked";
    }
    change(b);
    res.json(publicBatch(b));
  });
  app.post("/api/email/template", (req, res) => {
    const b = mutable(req);
    b.template = templateSchema.parse(req.body);
    change(b);
    res.json(publicBatch(b));
  });
  app.post("/api/email/preview", (req, res) => {
    const b = batch(req);
    const { id } = z.object({ id: z.string() }).strict().parse(req.body);
    const r = b.records.find((r) => r.id === id);
    if (!r) throw new AppError(404, "Recipient not found.");
    res.json({
      ...renderEmail(b.template, r),
      from: req.cf.email,
      to: r.email,
      certificate: r.certificate,
    });
  });
  app.get("/api/batch/attachment/:id", (req, res) => {
    const b = batch(req);
    const c = b.certificates.find(
      (c) => c.id === req.params.id && c.status === "valid",
    );
    if (!c?.path || !b.filesAvailable)
      throw new AppError(404, "Attachment expired or is unavailable.");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.download(c.path, c.filename);
  });
  app.post("/api/email/test", async (req, res) => {
    const b = mutable(req);
    const data = z
      .object({
        id: z.string(),
        to: z.string().refine(validEmail),
        requestId: z.string().uuid(),
        confirmed: z.literal(true),
      })
      .strict()
      .parse(req.body);
    if (req.cf.testKeys.has(data.requestId))
      throw new AppError(
        409,
        "This test request was already submitted. Check Gmail before trying again.",
      );
    if (req.cf.testKeys.size >= 100)
      throw new AppError(429, "Test email limit reached for this session.");
    const r = b.records.find((r) => r.id === data.id && r.status === "ready");
    if (!r) throw new AppError(400, "Select a ready recipient for the test.");
    b.busy = true;
    req.cf.busy = true;
    req.cf.testKeys.set(data.requestId, { status: "pending" });
    try {
      const messageId = await sendRecord(req.cf, b, r, data.to);
      req.cf.testKeys.set(data.requestId, { status: "sent", messageId });
      b.testedRevision = b.revision;
      b.test = {
        to: data.to,
        gmailMessageId: messageId,
        timestamp: new Date().toISOString(),
      };
      if (data.to.toLowerCase() === r.email.toLowerCase()) {
        r.status = "sent";
        r.gmailMessageId = messageId;
        r.timestamp = b.test.timestamp;
        r.warnings.push(
          "Delivered as the test email; excluded from bulk sending.",
        );
      }
      emit(req.cf);
      res.json(publicBatch(b));
    } catch (e) {
      req.cf.testKeys.set(data.requestId, {
        status:
          e instanceof SendError && e.kind === "unknown" ? "unknown" : "failed",
      });
      if (
        e instanceof SendError &&
        e.kind === "unknown" &&
        data.to.toLowerCase() === r.email.toLowerCase()
      ) {
        r.status = "unknown";
        r.error = e.message;
        r.timestamp = new Date().toISOString();
        emit(req.cf);
      }
      throw e;
    } finally {
      b.busy = false;
      req.cf.busy = false;
    }
  });
  app.post("/api/batch/send", async (req, res) => {
    const b = mutable(req);
    const { batchId, revision } = z
      .object({
        batchId: z.string(),
        revision: z.number().int(),
        confirmed: z.literal(true),
      })
      .strict()
      .parse(req.body);
    if (batchId !== b.batchId || revision !== b.revision)
      throw new AppError(409, "Batch changed. Review the current batch again.");
    if (b.testedRevision !== b.revision)
      throw new AppError(
        409,
        "Send a successful test email for the current batch before sending.",
      );
    if (
      !b.filesAvailable ||
      !b.records.some((r) => r.status === "ready") ||
      b.records.some((r) => ["blocked", "unknown"].includes(r.status))
    )
      throw new AppError(
        409,
        "Resolve or explicitly skip every blocked recipient before sending.",
      );
    for (const r of b.records.filter((r) => r.status === "ready"))
      renderEmail(b.template, r);
    b.status = "sending";
    b.expiresAt = Date.now() + 8 * 60 * 60 * 1000;
    b.work = runBatch(
      b,
      (r) => sendRecord(req.cf, b, r),
      () => emit(req.cf),
    );
    res.json(publicBatch(b));
  });
  app.post("/api/batch/pause", (req, res) => {
    const b = batch(req);
    if (b.status !== "sending")
      throw new AppError(409, "Batch is not sending.");
    b.status = "paused";
    emit(req.cf);
    res.json(publicBatch(b));
  });
  app.post("/api/batch/resume", (req, res) => {
    const b = batch(req);
    if (b.status !== "paused") throw new AppError(409, "Batch is not paused.");
    b.status = "sending";
    emit(req.cf);
    res.json(publicBatch(b));
  });
  app.post("/api/batch/stop", async (req, res) => {
    const b = batch(req);
    z.object({ confirmed: z.literal(true) })
      .strict()
      .parse(req.body);
    if (!active(b)) throw new AppError(409, "Batch is not active.");
    stopBatch(b);
    emit(req.cf);
    res.json(publicBatch(b));
  });
  app.post("/api/batch/retry", async (req, res) => {
    const b = batch(req);
    if (active(b)) throw new AppError(409, "Wait for this batch to finish.");
    throw new AppError(
      409,
      "Temporary attachments have been deleted. Use Retry Failed to create a new batch, upload the original ZIP, review, test, and confirm again.",
    );
  });
  app.get("/api/batch/status", (req, res) =>
    res.json(req.cf.batch ? publicBatch(batch(req)) : null),
  );
  app.use("/api", (_req, res) =>
    res.status(404).json({ error: "API endpoint not found." }),
  );
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof z.ZodError)
      return res
        .status(400)
        .json({
          error:
            "Invalid request. Check the required fields and allowed values.",
        });
    if (err instanceof AppError)
      return res
        .status(err.status)
        .json({ error: err.message, code: err.code });
    if (err instanceof SendError)
      return res
        .status(err.kind === "auth" ? 401 : 502)
        .json({ error: err.message, code: err.kind });
    res
      .status(500)
      .json({ error: "The request could not be completed. Please try again." });
  });
  const timer = setInterval(() => {
    void (async () => {
      for (const [id, s] of sessions) {
        if (s.batch && s.batch.expiresAt < Date.now()) {
          if (active(s.batch)) {
            stopBatch(s.batch);
            continue;
          }
          if (!s.busy) await cleanFiles(s.batch);
        }
        if (s.expires < Date.now() && !active(s.batch) && !s.busy) {
          if (s.batch) await cleanFiles(s.batch);
          sessions.delete(id);
          io.in(id).disconnectSockets(true);
        }
      }
    })().catch(() => undefined);
  }, 60000);
  timer.unref();
  const close = async () => {
    clearInterval(timer);
    for (const s of sessions.values()) if (active(s.batch)) stopBatch(s.batch!);
    await Promise.all([...sessions.values()].map((s) => s.batch?.work));
    io.close();
    await rm(root, { recursive: true, force: true });
  };
  return { app, http, io, close, sessions };
}
