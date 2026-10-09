import type { CreateExpressContextOptions } from "@trpc/server/adapters/express";
import type { User } from "../../drizzle/schema";
import * as db from "../db";
import { parse as parseCookie } from "cookie";
import { PASSWORD_SESSION_COOKIE, verifyPasswordSession } from "../auth/password";
import { sdk } from "./sdk";

export type TrpcContext = {
  req: CreateExpressContextOptions["req"];
  res: CreateExpressContextOptions["res"];
  user: User | null;
};

export async function createContext(
  opts: CreateExpressContextOptions
): Promise<TrpcContext> {
  let user: User | null = null;

  try {
    const cookies = parseCookie(opts.req.headers.cookie ?? "");
    const userId = verifyPasswordSession(cookies[PASSWORD_SESSION_COOKIE]);
    if (userId) user = (await db.getUserById(userId)) ?? null;
  } catch {
    user = null;
  }

  if (user) return { req: opts.req, res: opts.res, user };

  try {
    user = await sdk.authenticateRequest(opts.req);
  } catch (error) {
    // Authentication is optional for public procedures.
    user = null;
  }

  return {
    req: opts.req,
    res: opts.res,
    user,
  };
}
