/**
 * FR-AUTH-2 — Google sign-in via Google Identity Services.
 *
 * The browser obtains an ID token (a signed JWT) from Google and posts it here.
 * We verify the signature against Google's rotating public keys and check the
 * audience, issuer and expiry before trusting a single claim. Never decode an
 * ID token without verifying it — an unverified token is attacker-controlled
 * input and would let anyone sign in as anyone.
 */
import { OAuth2Client, type TokenPayload } from "google-auth-library";
import { env } from "../config/env.js";

let client: OAuth2Client | null = null;

function getClient(): OAuth2Client {
  if (!env.GOOGLE_CLIENT_ID) {
    throw new Error("GOOGLE_CLIENT_ID is not configured");
  }
  // The library caches and refreshes Google's JWKS internally.
  client ??= new OAuth2Client(env.GOOGLE_CLIENT_ID);
  return client;
}

export class GoogleAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoogleAuthError";
  }
}

export interface GoogleIdentity {
  googleId: string;
  email: string;
  emailVerified: boolean;
  firstName?: string;
  lastName?: string;
  avatarUrl?: string;
}

const ACCEPTED_ISSUERS = new Set(["accounts.google.com", "https://accounts.google.com"]);

/**
 * Verifies a Google ID token and extracts the identity it asserts.
 * Throws {@link GoogleAuthError} for anything untrustworthy.
 */
export async function verifyGoogleIdToken(idToken: string): Promise<GoogleIdentity> {
  let payload: TokenPayload | undefined;

  try {
    const ticket = await getClient().verifyIdToken({
      idToken,
      audience: env.GOOGLE_CLIENT_ID!,
    });
    payload = ticket.getPayload();
  } catch (err) {
    // Covers bad signature, wrong audience and expired tokens.
    throw new GoogleAuthError(
      `Google token verification failed: ${err instanceof Error ? err.message : "unknown error"}`,
    );
  }

  if (!payload) throw new GoogleAuthError("Google token contained no payload");
  if (!ACCEPTED_ISSUERS.has(payload.iss)) {
    throw new GoogleAuthError("Google token has an unexpected issuer");
  }
  if (!payload.sub) throw new GoogleAuthError("Google token is missing a subject claim");
  if (!payload.email) throw new GoogleAuthError("Google account did not expose an email address");

  // Requirement 1: a user must have a valid email. Google's own verification
  // stands in for ours, so an unverified Google address is rejected outright
  // rather than silently trusted.
  if (!payload.email_verified) {
    throw new GoogleAuthError(
      "This Google account's email address is not verified with Google. Verify it with Google, then try again.",
    );
  }

  return {
    googleId: payload.sub,
    email: payload.email.toLowerCase(),
    emailVerified: true,
    firstName: payload.given_name,
    lastName: payload.family_name,
    avatarUrl: payload.picture,
  };
}
