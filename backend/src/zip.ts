import yauzl from "yauzl";
import path from "node:path";
import { createWriteStream } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { Transform } from "node:stream";
import { crc32 } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { randomUUID, createHash } from "node:crypto";
import { fileTypeFromBuffer } from "file-type";
import { PDFDocument } from "pdf-lib";
import sharp from "sharp";
import type { Certificate } from "./types.js";
import { AppError } from "./errors.js";
import { uploadLimits } from "./limits.js";
export function safeZipPath(name: string) {
  return (
    !!name &&
    !name.includes("\\") &&
    !name.startsWith("/") &&
    !/^[a-z]:/i.test(name) &&
    !/[\x00-\x1f\x7f]/.test(name) &&
    !name.split("/").some((s) => s === ".." || s === ".") &&
    name.length <= 300
  );
}
export async function inspectZip(
  archive: string,
  directory: string,
): Promise<Certificate[]> {
  const files: Certificate[] = [];
  let total = 0,
    entries = 0;
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) =>
    yauzl.open(
      archive,
      { lazyEntries: true, validateEntrySizes: true, strictFileNames: true },
      (err, z) =>
        err || !z
          ? reject(new AppError(400, "Invalid or corrupted ZIP archive."))
          : resolve(z),
    ),
  );
  try {
    await new Promise<void>((resolve, reject) => {
      let done = false;
      const fail = (e: unknown) => {
        if (!done) {
          done = true;
          zip.close();
          reject(
            e instanceof AppError
              ? e
              : new AppError(
                  400,
                  "The ZIP is corrupted or contains an unsafe path.",
                ),
          );
        }
      };
      zip.on("error", fail);
      zip.on("end", () => {
        done = true;
        resolve();
      });
      zip.on("entry", (entry: yauzl.Entry) => {
        void (async () => {
          entries++;
          if (uploadLimits.entries && entries > uploadLimits.entries)
            throw new AppError(400, `ZIP exceeds the configured ${uploadLimits.entries} entry limit.`);
          if (!safeZipPath(entry.fileName))
            throw new AppError(400, "ZIP contains an unsafe file path.");
          const mode = (entry.externalFileAttributes >>> 16) & 0xf000;
          if (mode === 0xa000)
            throw new AppError(
              400,
              "Symbolic links are not allowed in ZIP archives.",
            );
          if (
            entry.fileName
              .split("/")
              .some((s) => s.startsWith(".") || s === "__MACOSX") ||
            entry.fileName.endsWith("/")
          ) {
            zip.readEntry();
            return;
          }
          total += entry.uncompressedSize;
          if (
            (uploadLimits.expandedBytes > 0 && total > uploadLimits.expandedBytes) ||
            entry.uncompressedSize > 15 * 1024 * 1024 ||
            entry.uncompressedSize / Math.max(entry.compressedSize, 1) > 200
          )
            throw new AppError(
              400,
              "ZIP exceeds safety limits: configured expanded size, 15 MB per file, or 200:1 compression.",
            );
          if (uploadLimits.certificates && files.length >= uploadLimits.certificates)
            throw new AppError(400, `ZIP exceeds the configured ${uploadLimits.certificates} certificate limit.`);
          const id = randomUUID(),
            filename = path.posix.basename(entry.fileName),
            ext = path.extname(filename).toLowerCase();
          const file: Certificate = {
            id,
            filename,
            relativePath: entry.fileName,
            size: entry.uncompressedSize,
            mime: "",
            hash: "",
            status: "invalid",
          };
          files.push(file);
          if (![".pdf", ".png", ".jpg", ".jpeg"].includes(ext)) {
            file.error = "Unsupported file type.";
            zip.readEntry();
            return;
          }
          if (entry.generalPurposeBitFlag & 1) {
            file.error = "Encrypted ZIP entries are not supported.";
            zip.readEntry();
            return;
          }
          file.path = path.join(directory, id);
          let actual = 0;
          const stream = await new Promise<NodeJS.ReadableStream>((res, rej) =>
            zip.openReadStream(entry, (e, s) => (e || !s ? rej(e) : res(s))),
          );
          const limiter = new Transform({
            transform(chunk, _enc, callback) {
              actual += chunk.length;
              callback(
                actual > 15 * 1024 * 1024
                  ? new AppError(400, "Expanded file exceeds size limit.")
                  : null,
                chunk,
              );
            },
          });
          await pipeline(
            stream,
            limiter,
            createWriteStream(file.path, { flags: "wx", mode: 0o600 }),
          );
          const buffer = await readFile(file.path);
          if (crc32(buffer) !== entry.crc32)
            throw new AppError(400, 'ZIP checksum failed. Upload an intact archive.');
          file.hash = createHash("sha256").update(buffer).digest("hex");
          try {
            const type = await fileTypeFromBuffer(buffer);
            const expected =
              ext === ".pdf"
                ? "application/pdf"
                : ext === ".png"
                  ? "image/png"
                  : "image/jpeg";
            if (type?.mime !== expected) throw Error();
            file.mime = expected;
            if (ext === ".pdf") {
              if (!buffer.subarray(-2048).includes(Buffer.from("%%EOF")))
                throw Error();
              const doc = await PDFDocument.load(buffer, {
                throwOnInvalidObject: true,
              });
              if (!doc.getPageCount()) throw Error();
            } else {
              await sharp(buffer, {
                limitInputPixels: 40000000,
                failOn: "warning",
              })
                .raw()
                .toBuffer();
            }
            file.status = "valid";
          } catch {
            file.error =
              "Corrupted, encrypted, or mismatched certificate content.";
            await rm(file.path, { force: true });
            delete file.path;
          }
          zip.readEntry();
        })().catch(fail);
      });
      zip.readEntry();
    });
    const names = new Map<string, Certificate[]>();
    for (const f of files) {
      const key = f.filename.toLowerCase();
      names.set(key, [...(names.get(key) ?? []), f]);
    }
    for (const group of names.values())
      if (group.length > 1)
        for (const f of group) {
          f.status = "duplicate";
          f.error = "Duplicate filename, including across nested folders.";
        }
    return files;
  } catch (e) {
    await Promise.all(
      files.filter((f) => f.path).map((f) => rm(f.path!, { force: true })),
    );
    throw e;
  } finally {
    zip.close();
  }
}
