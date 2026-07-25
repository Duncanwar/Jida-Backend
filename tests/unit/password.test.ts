import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "../../src/utils/password.js";

describe("password hashing", () => {
  it("hashes a password and verifies it", async () => {
    const hash = await hashPassword("s3cret-password");
    expect(hash).not.toBe("s3cret-password");
    expect(hash.startsWith("$2")).toBe(true); // bcrypt prefix
    await expect(verifyPassword("s3cret-password", hash)).resolves.toBe(true);
  });

  it("rejects a wrong password", async () => {
    const hash = await hashPassword("correct-password");
    await expect(verifyPassword("wrong-password", hash)).resolves.toBe(false);
  });

  it("produces different hashes for the same input (salted)", async () => {
    const [a, b] = await Promise.all([hashPassword("same"), hashPassword("same")]);
    expect(a).not.toBe(b);
  });
}, 30_000);
