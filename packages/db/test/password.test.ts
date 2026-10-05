import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "../src/password.js";

describe("password hashing", () => {
  it("verifies the original password and rejects others", async () => {
    const stored = await hashPassword("correct horse");
    expect(stored).toMatch(/^scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}$/);
    await expect(verifyPassword("correct horse", stored)).resolves.toBe(true);
    await expect(verifyPassword("wrong", stored)).resolves.toBe(false);
  });

  it("rejects malformed hashes", async () => {
    await expect(verifyPassword("x", "md5$abc")).resolves.toBe(false);
  });
});
