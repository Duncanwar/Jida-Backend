import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * FR-AUTH-2 — the ID token verifier is the security boundary for Google
 * sign-in. These tests pin the checks that must never be relaxed: signature
 * verification, issuer, and Google's own email_verified claim.
 */

const verifyIdToken = vi.fn();

vi.mock("google-auth-library", () => ({
  OAuth2Client: class {
    verifyIdToken = verifyIdToken;
  },
}));

const { verifyGoogleIdToken, GoogleAuthError } = await import("../../src/services/googleAuth.js");

function ticket(payload: Record<string, unknown> | undefined) {
  return { getPayload: () => payload };
}

const validPayload = {
  iss: "https://accounts.google.com",
  sub: "google-sub-123",
  email: "Grace@Example.com",
  email_verified: true,
  given_name: "Grace",
  family_name: "Hopper",
  picture: "https://example.com/a.png",
};

beforeEach(() => verifyIdToken.mockReset());

describe("verifyGoogleIdToken", () => {
  it("returns the identity for a valid token", async () => {
    verifyIdToken.mockResolvedValue(ticket(validPayload));

    const identity = await verifyGoogleIdToken("token");

    expect(identity.googleId).toBe("google-sub-123");
    expect(identity.firstName).toBe("Grace");
    expect(identity.emailVerified).toBe(true);
  });

  it("normalises the email to lower case so accounts cannot be duplicated by case", async () => {
    verifyIdToken.mockResolvedValue(ticket(validPayload));
    const identity = await verifyGoogleIdToken("token");
    expect(identity.email).toBe("grace@example.com");
  });

  it("passes the configured client ID as the expected audience", async () => {
    verifyIdToken.mockResolvedValue(ticket(validPayload));
    await verifyGoogleIdToken("token");
    expect(verifyIdToken).toHaveBeenCalledWith(
      expect.objectContaining({ audience: process.env.GOOGLE_CLIENT_ID }),
    );
  });

  it("rejects a token whose signature does not verify", async () => {
    // ...Once, not a persistent implementation: Vitest's teardown re-invokes
    // the spy, and a permanently throwing mock would surface that second call
    // as a spurious test failure.
    verifyIdToken.mockImplementationOnce(() => {
      throw new Error("Invalid token signature");
    });
    await expect(verifyGoogleIdToken("forged")).rejects.toBeInstanceOf(GoogleAuthError);
  });

  it("rejects a token from an unexpected issuer", async () => {
    verifyIdToken.mockResolvedValue(ticket({ ...validPayload, iss: "https://evil.example.com" }));
    await expect(verifyGoogleIdToken("token")).rejects.toThrow(/issuer/i);
  });

  // Requirement 1: a user must have a *valid* email. An unverified Google
  // address has not been proven to belong to the person signing in.
  it("rejects a Google account whose email is not verified with Google", async () => {
    verifyIdToken.mockResolvedValue(ticket({ ...validPayload, email_verified: false }));
    await expect(verifyGoogleIdToken("token")).rejects.toThrow(/not verified/i);
  });

  it("rejects a token with no email claim", async () => {
    const { email, ...withoutEmail } = validPayload;
    void email;
    verifyIdToken.mockResolvedValue(ticket(withoutEmail));
    await expect(verifyGoogleIdToken("token")).rejects.toThrow(/email/i);
  });

  it("rejects an empty payload", async () => {
    verifyIdToken.mockResolvedValue(ticket(undefined));
    await expect(verifyGoogleIdToken("token")).rejects.toBeInstanceOf(GoogleAuthError);
  });
});
