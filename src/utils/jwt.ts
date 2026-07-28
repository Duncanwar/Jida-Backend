import jwt from "jsonwebtoken";
import { env } from "../config/env.js";

export type AccessTokenPayload = {
  sub: string;
  role: string;
  typ: "access";
  /**
   * FR-AUTH-1 — email-verified flag, carried in the token so protected routes
   * can enforce the gate without a database round trip on every request.
   * Optional for backward compatibility with tokens issued before this claim
   * existed; absent is treated as verified (see requireVerifiedEmail).
   */
  ev?: boolean;
};

export function signAccessToken(sub: string, role: string, emailVerified = true): string {
  return jwt.sign(
    { sub, role, typ: "access", ev: emailVerified } satisfies AccessTokenPayload,
    env.JWT_SECRET,
    {
      expiresIn: `${env.JWT_ACCESS_EXPIRES_MIN}m`,
      algorithm: "HS256",
    },
  );
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  const decoded = jwt.verify(token, env.JWT_SECRET) as AccessTokenPayload;
  if (decoded.typ !== "access") throw new Error("Invalid token type");
  return decoded;
}
