import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

/** A fixed token from `CONCENTRATE_TOKEN` (so a container keeps the same URL across restarts), else a random one. */
export function createToken(env: NodeJS.ProcessEnv = process.env): string {
  const fixed = env.CONCENTRATE_TOKEN;
  if (fixed !== undefined && fixed !== "") {
    if (!/^[A-Za-z0-9_-]{16,}$/.test(fixed)) throw new Error("CONCENTRATE_TOKEN must be at least 16 characters of A-Z a-z 0-9 _ -");
    return fixed;
  }
  return randomBytes(24).toString("hex");
}

/** DNS rebinding guard: only the loopback host names are served. */
export function isAllowedHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  const host = hostHeader.startsWith("[") ? hostHeader.slice(0, hostHeader.indexOf("]") + 1) : hostHeader.split(":")[0];
  return host === "127.0.0.1" || host === "localhost" || host === "[::1]";
}

export function tokenFromRequest(request: IncomingMessage, url: URL): string | undefined {
  const header = request.headers["x-concentrate-token"];
  if (typeof header === "string") return header;
  return url.searchParams.get("token") ?? undefined;
}

export function tokenMatches(expected: string, given: string | undefined): boolean {
  if (!given) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}
