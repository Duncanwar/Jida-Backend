import { describe, expect, it } from "vitest";
import { hashToken, randomToken } from "../../src/utils/cryptoToken.js";

describe("cryptoToken", () => {
  it("generates a 64-char hex token", () => {
    const token = randomToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it("generates unique tokens", () => {
    expect(randomToken()).not.toBe(randomToken());
  });

  it("hashes deterministically with sha256", () => {
    const token = "fixed-token";
    expect(hashToken(token)).toBe(hashToken(token));
    expect(hashToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(token)).not.toBe(hashToken("other-token"));
  });
});
