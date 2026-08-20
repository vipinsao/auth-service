import bcrypt from "bcrypt";

/** bcrypt work factor. 10 is ~100ms on commodity hardware in 2026. */
const SALT_ROUNDS = 10;

export class CredentialService {
  async hashPassword(plaintext: string): Promise<string> {
    return bcrypt.hash(plaintext, SALT_ROUNDS);
  }

  /**
   * Returns a Promise - every caller must await it. Calling this without
   * `await` yields a truthy Promise object, which is how the login handler used
   * to accept any password at all.
   */
  async comparePassword(
    plaintext: string,
    hashedPassword: string,
  ): Promise<boolean> {
    return bcrypt.compare(plaintext, hashedPassword);
  }
}
