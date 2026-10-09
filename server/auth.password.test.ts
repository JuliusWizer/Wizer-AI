import { describe, expect, it } from "vitest";
import { createPasswordSession, hashPassword, verifyPassword, verifyPasswordSession } from "./auth/password";

describe("password authentication helpers", () => {
  it("hashes passwords and verifies only the original password", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(hash).toMatch(/^scrypt:/);
    await expect(verifyPassword("correct horse battery staple", hash)).resolves.toBe(true);
    await expect(verifyPassword("wrong password", hash)).resolves.toBe(false);
  });

  it("signs sessions and rejects tampered tokens", () => {
    const token = createPasswordSession(42);
    expect(verifyPasswordSession(token)).toBe(42);
    expect(verifyPasswordSession(`${token}tampered`)).toBeNull();
  });
});
