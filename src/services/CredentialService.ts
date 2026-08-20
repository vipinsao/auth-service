import bcrypt from "bcrypt";
import { randomBytes } from "crypto";

/** bcrypt work factor. 10 is ~60ms on this hardware, measured. */
const SALT_ROUNDS = 10;

/**
 * A hash of a random string nobody will ever submit, used to spend the same
 * time on a login for an address that does not exist as on one that does.
 *
 * It is built at startup rather than hard-coded so that the plaintext behind it
 * does not exist anywhere - not in this file, not in the repository history.
 * Building it costs one bcrypt hash at import, about 60ms, once.
 */
const ABSENT_USER_HASH = bcrypt.hashSync(
  randomBytes(32).toString("hex"),
  SALT_ROUNDS,
);

export class CredentialService {
  async hashPassword(plaintext: string): Promise<string> {
    return bcrypt.hash(plaintext, SALT_ROUNDS);
  }

  /**
   * Runs a real bcrypt comparison and always returns false.
   *
   * `login` returns early for an unknown email address, and returning early is
   * measurable: the known-address path spends a bcrypt compare (~60ms here) and
   * the unknown one spent nothing at all. That gap is orders of magnitude
   * larger than network jitter, so it answered "does this address have an
   * account?" for anyone willing to time the response - which is precisely what
   * the deliberately identical error body was there to prevent.
   *
   * The comparison is against a hash with the same cost factor as a real one,
   * because it is the cost factor that determines the time.
   */
  async compareAgainstAbsentUser(plaintext: string): Promise<boolean> {
    return bcrypt.compare(plaintext, ABSENT_USER_HASH);
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
