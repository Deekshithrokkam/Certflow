import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import JSZip from "jszip";
import { PDFDocument } from "pdf-lib";
import { randomUUID } from "node:crypto";
import { createApplication } from "../src/server.js";
import { makeOAuth } from "../src/gmail.js";
let server: Awaited<ReturnType<typeof createApplication>>,
  agent: ReturnType<typeof request.agent>,
  csrf: string,
  calls = 0;
const origin = "http://localhost:5173";
const post = (path: string, body: unknown) =>
  agent
    .post("/api" + path)
    .set("Origin", origin)
    .set("X-CSRF-Token", csrf)
    .send(body);
const scenario =
  "name,email,certificate\nJohn Doe,john@gmail.com,John_Doe.pdf\nRahul Kumar,rahul@gmail.com,Rahul_Kumar.pdf\nPriya Sharma,priya@gmail.com,Priya_Sharma.pdf";
beforeAll(async () => {
  server = await createApplication({
    secret: "test-secret-at-least-thirty-two-characters",
    frontend: origin,
    sendRaw: async () => `gmail-${++calls}`,
  });
  agent = request.agent(server.app);
  const me = await agent.get("/api/auth/me");
  csrf = me.body.csrf;
  const s = [...server.sessions.values()][0];
  s.email = "sender@gmail.com";
  s.oauth = makeOAuth();
});
afterAll(async () => server.close());
async function prepare() {
  expect((await post("/batch/new", {})).status).toBe(200);
  const zip = new JSZip();
  for (const name of ["John_Doe", "Rahul_Kumar", "Priya_Sharma"]) {
    const pdf = await PDFDocument.create();
    pdf.addPage().drawText(name);
    zip.file(`${name}.pdf`, await pdf.save());
  }
  let response = await agent
    .post("/api/batch/upload-zip")
    .set("Origin", origin)
    .set("X-CSRF-Token", csrf)
    .attach(
      "file",
      await zip.generateAsync({ type: "nodebuffer" }),
      "certificates.zip",
    );
  expect(response.status).toBe(200);
  response = await agent
    .post("/api/batch/upload-csv")
    .set("Origin", origin)
    .set("X-CSRF-Token", csrf)
    .attach("file", Buffer.from(scenario), "recipients.csv");
  expect(response.status).toBe(200);
  const matched = await post("/batch/match", {
    mapping: { name: "name", email: "email", certificate: "certificate" },
    history: [],
  });
  expect(matched.status).toBe(200);
  expect(matched.body.ready).toBe(3);
  return matched.body;
}
describe("authenticated API and send gates", () => {
  it("exposes health but rejects unauthenticated processing", async () => {
    expect((await request(server.app).get("/api/health")).status).toBe(200);
    expect((await request(server.app).post("/api/batch/new")).status).toBe(401);
  });
  it("enforces origin and CSRF", async () => {
    expect((await agent.post("/api/batch/new").send({})).status).toBe(403);
    expect(
      (
        await agent
          .post("/api/batch/new")
          .set("Origin", "https://evil.example")
          .set("X-CSRF-Token", csrf)
          .send({})
      ).status,
    ).toBe(403);
  });
  it("runs upload → match → preview → one test → confirmed bulk without duplicates", async () => {
    const b = await prepare();
    expect(b.certificates.every((c: { path?: string }) => !c.path)).toBe(true);
    expect(
      (
        await post("/batch/send", {
          batchId: b.batchId,
          revision: b.revision,
          confirmed: true,
        })
      ).status,
    ).toBe(409);
    const preview = await post("/email/preview", { id: b.records[0].id });
    expect(preview.body.to).toBe("john@gmail.com");
    expect(preview.body.html).toContain("John Doe");
    const body = {
      id: b.records[0].id,
      to: "sender@gmail.com",
      requestId: randomUUID(),
      confirmed: true,
    };
    const tested = await post("/email/test", body);
    expect(tested.status).toBe(200);
    expect(calls).toBe(1);
    expect((await post("/email/test", body)).status).toBe(409);
    expect(calls).toBe(1);
    expect(
      (
        await post("/batch/send", {
          batchId: b.batchId,
          revision: b.revision,
          confirmed: false,
        })
      ).status,
    ).toBe(400);
    const sent = await post("/batch/send", {
      batchId: b.batchId,
      revision: b.revision,
      confirmed: true,
    });
    expect(sent.status).toBe(200);
    expect(
      (
        await post("/batch/send", {
          batchId: b.batchId,
          revision: b.revision,
          confirmed: true,
        })
      ).status,
    ).toBe(409);
    await [...server.sessions.values()][0].batch?.work;
    const status = await agent.get("/api/batch/status");
    expect(status.body.sent).toBe(3);
    expect(status.body.filesAvailable).toBe(false);
    expect(calls).toBe(4);
    expect(
      (await agent.get(`/api/batch/attachment/${b.records[0].certificateId}`))
        .status,
    ).toBe(404);
  }, 15000);
  it("invalidates the test after template edits and validates payloads", async () => {
    const b = await prepare();
    expect(
      (await post("/email/template", { ...b.template, emailDelay: 0 })).status,
    ).toBe(400);
    const test = await post("/email/test", {
      id: b.records[0].id,
      to: "sender@gmail.com",
      requestId: randomUUID(),
      confirmed: true,
    });
    expect(test.status).toBe(200);
    const edited = await post("/email/template", {
      ...b.template,
      event: "Changed event",
    });
    expect(edited.body.testedRevision).toBeUndefined();
    expect(
      (
        await post("/batch/send", {
          batchId: b.batchId,
          revision: edited.body.revision,
          confirmed: true,
        })
      ).status,
    ).toBe(409);
  });
  it("protects duplicate local history until explicitly resolved", async () => {
    await prepare();
    const match = await post("/batch/match", {
      mapping: { name: "name", email: "email", certificate: "certificate" },
      history: [{ email: "john@gmail.com", certificate: "John_Doe.pdf" }],
    });
    expect(match.body.records[0].status).toBe("blocked");
    const resolved = await post("/batch/record", {
      id: match.body.records[0].id,
      action: "skip",
    });
    expect(resolved.body.records[0].status).toBe("skipped");
  });
  it("records a test to the real recipient as sent, excluding it from bulk", async () => {
    const b = await prepare();
    const test = await post("/email/test", {
      id: b.records[0].id,
      to: "john@gmail.com",
      requestId: randomUUID(),
      confirmed: true,
    });
    expect(test.body.sent).toBe(1);
    expect(test.body.ready).toBe(2);
    expect(
      (
        await post("/email/test", {
          id: b.records[0].id,
          to: "john@gmail.com",
          requestId: randomUUID(),
          confirmed: true,
        })
      ).status,
    ).toBe(400);
  });
});
