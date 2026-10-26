import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { ApiError } from "./data.ts";
export interface ObjectStore {
  put(key: string, bytes: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  remove(key: string): Promise<void>;
}
function safeKey(key: string) {
  if (!/^[a-f\d]{24}\/[a-f\d-]{36}$/.test(key))
    throw new Error("Invalid storage key");
  return key;
}
export class LocalStore implements ObjectStore {
  constructor(private root = resolve(".local/uploads")) {}
  private path(key: string) {
    return resolve(this.root, safeKey(key));
  }
  async put(key: string, bytes: Buffer) {
    const path = this.path(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
  }
  async get(key: string) {
    return readFile(this.path(key));
  }
  async remove(key: string) {
    try {
      await unlink(this.path(key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
export class S3Store implements ObjectStore {
  constructor(
    private bucket: string,
    private client: S3Client,
  ) {}
  async put(key: string, bytes: Buffer) {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: safeKey(key),
        Body: bytes,
        ContentType: "application/octet-stream",
      }),
    );
  }
  async get(key: string) {
    const object = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: safeKey(key) }),
    );
    if (!object.Body) throw new Error("File missing");
    return Buffer.from(await object.Body.transformToByteArray());
  }
  async remove(key: string) {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: safeKey(key) }),
    );
  }
}
export function configuredStore(production = false): ObjectStore {
  if (process.env.S3_BUCKET)
    return new S3Store(
      process.env.S3_BUCKET,
      new S3Client({
        region: process.env.AWS_REGION ?? "us-east-1",
        ...(process.env.S3_ENDPOINT
          ? { endpoint: process.env.S3_ENDPOINT }
          : {}),
      }),
    );
  if (production && !process.env.UPLOAD_DIRECTORY)
    throw new Error(
      "Production requires S3_BUCKET or a persistent UPLOAD_DIRECTORY.",
    );
  return new LocalStore(
    process.env.UPLOAD_DIRECTORY
      ? resolve(process.env.UPLOAD_DIRECTORY)
      : undefined,
  );
}
export const maxFileSize = 10 * 1024 * 1024;
export function validateFile(original: string, bytes: Buffer) {
  const filename = original
    .split(/[\\/]/)
    .pop()!
    .replace(/[\x00-\x1f\x7f]/g, "")
    .trim()
    .slice(0, 180);
  if (!filename || !bytes.length || bytes.length > maxFileSize)
    throw new ApiError(400, "Choose a nonempty file up to 10 MB.");
  const ext = filename.split(".").pop()?.toLowerCase();
  const head = bytes.subarray(0, 16);
  const matches =
    ext === "pdf"
      ? head.toString().startsWith("%PDF-")
      : ext === "png"
        ? head
            .subarray(0, 8)
            .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        : ["jpg", "jpeg"].includes(ext!)
          ? head[0] === 255 && head[1] === 216 && head[2] === 255
          : ext === "webp"
            ? head.toString("ascii", 0, 4) === "RIFF" &&
              head.toString("ascii", 8, 12) === "WEBP"
            : ["zip", "docx", "xlsx", "pptx"].includes(ext!)
              ? head[0] === 80 && head[1] === 75
              : ["txt", "md", "csv"].includes(ext!)
                ? !bytes.includes(0)
                : false;
  if (!matches)
    throw new ApiError(
      400,
      "Use PDF, PNG, JPEG, WebP, text, Markdown, CSV, ZIP, or Office files with matching content.",
    );
  return filename;
}
