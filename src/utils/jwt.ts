import jwt from "jsonwebtoken";
import { env } from "../config/env.js";

export type AccessTokenPayload = {
  sub: string;
  role: string;
  typ: "access";
};

export function signAccessToken(sub: string, role: string): string {
  return jwt.sign({ sub, role, typ: "access" } satisfies AccessTokenPayload, env.JWT_SECRET, {
    expiresIn: `${env.JWT_ACCESS_EXPIRES_MIN}m`,
    algorithm: "HS256",
  });
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  const decoded = jwt.verify(token, env.JWT_SECRET) as AccessTokenPayload;
  if (decoded.typ !== "access") throw new Error("Invalid token type");
  return decoded;
}
