import type { Meta } from "express-validator";

/**
 * A small deny-list of passwords that are long enough to pass a length check
 * and are still among the first things any credential-stuffing list tries.
 *
 * This is deliberately not a 100k-entry wordlist. A real deployment should
 * check Have I Been Pwned's k-anonymity range API - it is free and does not
 * disclose the password - and that belongs behind a network call this service
 * does not currently make. What this list does is stop the passwords that a
 * minimum length of 8 does nothing about, `password` and `12345678` among them,
 * which is the gap between "we have a policy" and "the policy stops anything".
 */
const COMMON_PASSWORDS = new Set([
  "password",
  "password1",
  "password123",
  "passw0rd",
  "12345678",
  "123456789",
  "1234567890",
  "qwertyui",
  "qwerty123",
  "iloveyou",
  "princess",
  "sunshine",
  "football",
  "baseball",
  "welcome1",
  "welcome123",
  "admin123",
  "letmein1",
  "trustno1",
  "superman",
  "michael1",
  "changeme",
  "starwars",
  "whatever",
  "computer",
  "abc12345",
]);

/**
 * Rejects a password that is the local part of the address it protects.
 * `alice@example.com` / `alice1234` is the shape this catches: it survives a
 * length check and is the first thing an attacker who knows the address tries.
 */
const containsEmailLocalPart = (password: string, email: unknown): boolean => {
  if (typeof email !== "string") return false;
  const localPart = email.split("@")[0]?.toLowerCase().trim();
  // Below four characters this would reject far too much for no real gain.
  if (!localPart || localPart.length < 4) return false;
  return password.toLowerCase().includes(localPart);
};

/**
 * The shared password rules, used by registration and by password reset. Reset
 * has no email in its body, so only the deny-list applies there - which is the
 * reason this is one schema fragment rather than two divergent copies.
 */
export const passwordSchema = {
  trim: true,
  errorMessage: "Password is required",
  notEmpty: true,
  isLength: {
    options: { min: 8, max: 128 },
    errorMessage: "Password must be between 8 and 128 characters long",
  },
  custom: {
    options: (value: unknown, { req }: Meta) => {
      if (typeof value !== "string") return true;
      const password = value.trim();

      if (COMMON_PASSWORDS.has(password.toLowerCase())) {
        throw new Error("Password is too common, choose another");
      }

      const email = (req.body as { email?: unknown } | undefined)?.email;
      if (containsEmailLocalPart(password, email)) {
        throw new Error("Password must not contain your email address");
      }

      return true;
    },
  },
};
