import mongoose from "mongoose";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { initializeModels } from "./data.ts";

export async function connectDatabase() {
  const production = process.env.NODE_ENV === "production";
  if (
    production &&
    (!process.env.MONGODB_URI ||
      !process.env.JWT_SECRET ||
      !process.env.APP_ORIGIN)
  )
    throw new Error(
      "Production requires MONGODB_URI, JWT_SECRET, and APP_ORIGIN.",
    );
  let localDb: { stop: () => Promise<any> } | undefined;
  let uri = process.env.MONGODB_URI;
  if (!uri) {
    const dataPath = resolve(".local/database");
    await mkdir(dataPath, { recursive: true });
    process.env.MONGOMS_DOWNLOAD_DIR = resolve(".local/mongodb-binaries");
    const { MongoMemoryReplSet } = await import("mongodb-memory-server");
    console.log(
      "Starting local MongoDB (first run downloads the official MongoDB binary)…",
    );
    // A persistent replica set must keep its advertised member port across restarts.
    const instance = await MongoMemoryReplSet.create({
      instanceOpts: [{ dbPath: dataPath, port: 27028 }],
      replSet: { name: "orbit-local", count: 1, storageEngine: "wiredTiger" },
    });
    localDb = instance;
    uri = instance.getUri("orbit");
  }
  await mongoose.connect(uri);
  await initializeModels();
  let secret = process.env.JWT_SECRET;
  if (!secret) {
    const path = resolve(".local/session-secret");
    try {
      secret = await readFile(path, "utf8");
    } catch {
      secret = randomBytes(48).toString("hex");
      await mkdir(resolve(".local"), { recursive: true });
      await writeFile(path, secret, { mode: 0o600 });
    }
  }
  return {
    secret,
    close: async () => {
      await mongoose.disconnect();
      await localDb?.stop();
    },
  };
}
