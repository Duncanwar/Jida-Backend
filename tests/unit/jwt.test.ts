import jsonwebtoken from "jsonwebtoken";
import { describe, expect, it } from "vitest";
import { signAccessToken, verifyAccessToken } from "../../src/utils/jwt.js";

describe("jwt", () => {
  it("signs and verifies an access token", () => {
    const token = signAccessToken("user-1", "AUTHOR");
    const payload = verifyAccessToken(token);
    expect(payload.sub).toBe("user-1");
    expect(payload.role).toBe("AUTHOR");
    expect(payload.typ).toBe("access");
  });

  it("rejects a token signed with a different secret", () => {
    const forged = jsonwebtoken.sign({ sub: "u", role: "ADMIN", typ: "access" }, "wrong-secret");
    expect(() => verifyAccessToken(forged)).toThrow();
  });

  it("rejects a token with the wrong typ", () => {
    const bad = jsonwebtoken.sign(
      { sub: "u", role: "AUTHOR", typ: "refresh" },
      process.env.JWT_SECRET as string,
    );
    expect(() => verifyAccessToken(bad)).toThrow("Invalid token type");
  });

  it("rejects an expired token", () => {
    const expired = jsonwebtoken.sign(
      { sub: "u", role: "AUTHOR", typ: "access" },
      process.env.JWT_SECRET as string,
      { expiresIn: "-1s" },
    );
    expect(() => verifyAccessToken(expired)).toThrow();
  });
});
