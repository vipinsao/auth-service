import { Repository } from "typeorm";
import { User } from "../entity/User.js";
import { UserData } from "../types/index.js";
import createHttpError from "http-errors";
import { Roles } from "../constants/index.js";
import { CredentialService } from "./CredentialService.js";
import { Config } from "../config/index.js";

/** Postgres `unique_violation`. */
const UNIQUE_VIOLATION = "23505";

export class UserService {
  constructor(
    private userRepository: Repository<User>,
    private credentialService: CredentialService = new CredentialService(),
  ) {}

  async create({ firstName, lastName, email, password }: UserData) {
    const existing = await this.userRepository.findOne({ where: { email } });
    if (existing) {
      throw createHttpError(400, "Email is already exists!");
    }

    const hashedPassword = await this.credentialService.hashPassword(password);

    try {
      return await this.userRepository.save({
        firstName,
        lastName,
        email,
        password: hashedPassword,
        role: Roles.CUSTOMER,
      });
    } catch (err) {
      // The findOne above is a courtesy check, not a guarantee: two concurrent
      // registrations for the same address both pass it and one of them hits
      // the unique index. That is a client error (400), not a server fault.
      if ((err as { code?: string }).code === UNIQUE_VIOLATION) {
        throw createHttpError(400, "Email is already exists!");
      }
      throw createHttpError(500, "Failed to store the data in the database");
    }
  }

  async findByEmail(email: string) {
    return this.userRepository.findOne({ where: { email } });
  }

  async findById(id: number) {
    return this.userRepository.findOne({ where: { id } });
  }

  async findAll() {
    return this.userRepository.find({
      select: ["id", "firstName", "lastName", "email", "role", "createdAt"],
      order: { id: "ASC" },
    });
  }

  /**
   * Called on every failed login. Counts the failure and, once the cap is
   * reached, locks the account for a period that doubles with each further
   * failure up to `ACCOUNT_LOCK_MINUTES`.
   *
   * One statement, no read-then-write. The old version computed
   * `user.failedLoginAttempts + 1` in JavaScript from a row read earlier in the
   * request, so two failures arriving together both read 3 and both wrote 4:
   * the counter advanced by one instead of two, and an attacker who simply sent
   * guesses in parallel could stay under the cap indefinitely. The increment
   * now happens inside the UPDATE, where the row lock serialises it - the same
   * conditional-update shape as `VerificationTokenService.consume`.
   *
   * The backoff is the other half. A flat 15 minutes made this a denial of
   * service: anyone who knew an address could lock it out for a quarter of an
   * hour with five requests. Doubling from one minute means the first lock -
   * the one a real user hits after mistyping a password, and the one a drive-by
   * attacker causes - costs a minute, while a persistent attacker still climbs
   * to the same cap. It does not remove the DoS, and DECISIONS.md decision 6
   * says so plainly; it reduces the common case by fifteen times.
   *
   * `failedLoginAttempts` is no longer reset to zero on locking. It has to keep
   * climbing for the backoff to have anything to count, and a successful login
   * is what clears it.
   *
   * That is also why the exponent has to be clamped, and `LEAST` around the
   * whole product is not enough: `power(2, n)` is evaluated first, in double
   * precision, and only then bounded. With the counter climbing forever the
   * exponent climbed with it, and at 1029 failed logins - measured by bisection,
   * 1028 works - the multiplication overflowed with `22003 value out of range`.
   * Every later wrong password on that account then answered 500 where every
   * other account answered 400, permanently: a durable per-account difference in
   * the response, which is the enumeration oracle 8b17adb closed being let back
   * in through a side door. Clamping at 20 puts the ceiling at 2^20 initial
   * minutes, roughly two years, so `ACCOUNT_LOCK_MINUTES` is what actually bounds
   * the wait and the clamp is never what a real account notices.
   */
  async registerFailedLogin(user: User): Promise<void> {
    await this.userRepository.query(
      `UPDATE "user"
          SET "failedLoginAttempts" = "failedLoginAttempts" + 1,
              "lockedUntil" = CASE
                WHEN "failedLoginAttempts" + 1 >= $2
                  THEN now() + (
                    LEAST(
                      $3::numeric * power(
                        2,
                        LEAST("failedLoginAttempts" + 1 - $2, 20)
                      )::numeric,
                      $4::numeric
                    )::text || ' minutes'
                  )::interval
                ELSE "lockedUntil"
              END
        WHERE "id" = $1`,
      [
        user.id,
        Config.MAX_FAILED_LOGIN_ATTEMPTS,
        Config.ACCOUNT_LOCK_INITIAL_MINUTES,
        Config.ACCOUNT_LOCK_MINUTES,
      ],
    );
  }

  async clearFailedLogins(user: User): Promise<void> {
    if (user.failedLoginAttempts === 0 && user.lockedUntil === null) return;
    await this.userRepository.update(user.id, {
      failedLoginAttempts: 0,
      lockedUntil: null,
    });
  }

  async setPassword(userId: number, plaintext: string): Promise<void> {
    const hashedPassword = await this.credentialService.hashPassword(plaintext);
    await this.userRepository.update(userId, {
      password: hashedPassword,
      failedLoginAttempts: 0,
      lockedUntil: null,
    });
  }

  async markEmailVerified(userId: number): Promise<void> {
    await this.userRepository.update(userId, { emailVerified: true });
  }
}
