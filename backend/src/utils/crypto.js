// Hashing, tokens, and encryption of stored secrets.
import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt, scryptSync,
  timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { config } from "../config/env.js";

// The same parameters as the Python Studio (auth_store.py), so imported
// accounts keep their passwords. ~50ms, run off the event loop.
const SCRYPT = { N: 2 ** 14, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const scryptAsync = promisify(scrypt);

export const scryptHash = (password, salt) => scryptSync(password, salt, 32, SCRYPT).toString("hex");
export const scryptHashAsync = async (password, salt) =>
  (await scryptAsync(String(password), salt, 32, SCRYPT)).toString("hex");

export const sha256 = (text) => createHash("sha256").update(String(text), "utf8").digest("hex");
export const token = (bytes = 32) => randomBytes(bytes).toString("base64url");
export const hexId = (bytes = 6) => randomBytes(bytes).toString("hex");

/** Constant-time equality for two strings of any length. */
export function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

// Provider credentials are encrypted with AES-256-GCM under SECRETS_KEY, so a
// copy of the database (a backup, a dump) holds no usable tokens.
const KEY = Buffer.from(config.SECRETS_KEY, "hex");

export function encryptJson(value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", KEY, iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), body.toString("base64")].join(".");
}

export function decryptJson(sealed) {
  if (!sealed) return {};
  const [version, iv, tag, body] = String(sealed).split(".");
  if (version !== "v1") throw new Error("unknown secret format");
  const decipher = createDecipheriv("aes-256-gcm", KEY, Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(body, "base64")), decipher.final()]).toString("utf8"));
}
