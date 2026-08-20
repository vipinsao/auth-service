import type { Response } from "supertest";

/** Structural check only - it does not verify the signature. */
export const isJwt = (token: string | null): boolean => {
  if (token === null) return false;
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  try {
    parts.forEach((part) => {
      Buffer.from(part, "base64").toString("utf-8");
    });
    return true;
  } catch {
    return false;
  }
};

export const cookiesFrom = (response: Response): string[] => {
  const raw = response.headers["set-cookie"] as string[] | string | undefined;
  if (Array.isArray(raw)) return raw;
  return raw ? [raw] : [];
};

/** Reads one cookie's value out of a Set-Cookie list; null when unset or cleared. */
export const cookieValue = (cookies: string[], name: string): string | null => {
  const match = cookies.find((cookie) => cookie.startsWith(`${name}=`));
  if (!match) return null;
  const value = match.split(";")[0].slice(name.length + 1);
  return value === "" ? null : value;
};

/** Turns a Set-Cookie list into something that can be sent back as `Cookie`. */
export const asCookieHeader = (cookies: string[]): string[] =>
  cookies.map((cookie) => cookie.split(";")[0]);

export const tokenFromMailBody = (text: string): string | null =>
  /token=([a-f0-9]{64})/.exec(text)?.[1] ?? null;
