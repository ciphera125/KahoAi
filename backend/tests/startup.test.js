import { afterEach, describe, expect, it, vi } from "vitest";
import net from "node:net";
import { freshDb } from "./helpers.js";
import { checkDatabaseRole, checkSecretsKey, portTaken } from "../src/services/startup.js";
import { systemQuery } from "../src/db/pool.js";
import { encryptJson } from "../src/utils/crypto.js";

afterEach(() => vi.restoreAllMocks());

describe("start-up checks turn silent failures into a refusal to start", () => {
  it("notices when something already answers on a port", async () => {
    const server = net.createServer();
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const port = server.address().port;
    expect(await portTaken(port)).toBe(true);
    await new Promise((r) => server.close(r));
    expect(await portTaken(port)).toBe(false);
  });

  it("confirms the app runs as the restricted role, not the owner", async () => {
    await expect(checkDatabaseRole()).resolves.toBeUndefined();
  });

  it("accepts the right SECRETS_KEY and refuses a changed one", async () => {
    await freshDb();
    await systemQuery("DELETE FROM meta WHERE key = 'secrets_canary'");
    await expect(checkSecretsKey()).resolves.toBeUndefined(); // first run writes the canary
    await expect(checkSecretsKey()).resolves.toBeUndefined(); // same key, fine
    // A canary written under a different key cannot be read back.
    await systemQuery("UPDATE meta SET value = $1 WHERE key = 'secrets_canary'",
      ["v1.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA.AAAA"]);
    await expect(checkSecretsKey()).rejects.toThrow(/SECRETS_KEY/);
    // Restore a valid canary so later tests are unaffected.
    await systemQuery("UPDATE meta SET value = $1 WHERE key = 'secrets_canary'", [encryptJson("kaho")]);
  });
});
