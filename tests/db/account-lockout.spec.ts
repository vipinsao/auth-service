import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
} from "@jest/globals";
import { DataSource } from "typeorm";
import { AppDataSource } from "../../src/config/data-source.js";
import { Config } from "../../src/config/index.js";
import { User } from "../../src/entity/User.js";
import { UserService } from "../../src/services/UserService.js";

/**
 * The lock backoff is `initial * 2^(attempts - cap)`, bounded by
 * `ACCOUNT_LOCK_MINUTES`. The bound is applied with `LEAST` around the product,
 * which reads as if it bounded everything - but `power(2, n)` is computed first,
 * in double precision, and the counter feeding `n` is never reset while the
 * failures continue.
 *
 * By bisection against this statement, 1028 failed logins work and 1029 raise
 * `22003 value out of range: overflow`. From then on every wrong password on
 * that one account answers 500 while every other account answers 400 - a
 * permanent, per-account difference in the response, which is exactly the
 * enumeration oracle the 400-for-everything work removed.
 *
 * The counter is set directly rather than by sending a thousand logins: what is
 * under test is the arithmetic in the UPDATE, and a thousand bcrypt comparisons
 * would take minutes to assert the same thing.
 */
describe("Failed-login backoff arithmetic", () => {
  let connection: DataSource;
  let service: UserService;

  beforeAll(async () => {
    connection = await AppDataSource.initialize();
    service = new UserService(connection.getRepository(User));
  });

  beforeEach(async () => {
    await connection.dropDatabase();
    await connection.synchronize();
  });

  afterAll(async () => {
    await connection.destroy();
  });

  /**
   * Run the `nth` failed login against a fresh account - the counter is set to
   * `n - 1` and one real `registerFailedLogin` is executed on top of it, so the
   * statement under test sees exactly the values it would see in production on
   * that attempt.
   */
  const nthFailedLogin = async (n: number) => {
    const repository = connection.getRepository(User);
    const user = await repository.save({
      firstName: "Vipin",
      lastName: "Sao",
      email: `locked-${n}@example.com`,
      password: "not-a-real-hash",
      role: "customer",
      failedLoginAttempts: n - 1,
    });

    await service.registerFailedLogin(user);
    return repository.findOneOrFail({ where: { id: user.id } });
  };

  // 1028 is the last failed login that worked before the clamp and 1029 the
  // first that did not, so the pair is the boundary itself: without the clamp
  // the first case passes and the second raises 22003. Both are asserted so a
  // change that moves the boundary rather than removing it still fails here.
  it.each([1028, 1029])(
    "records failed login number %i without overflowing the exponent",
    async (n) => {
      const user = await nthFailedLogin(n);

      expect(user.failedLoginAttempts).toBe(n);

      // The lock is still the configured maximum, so clamping the exponent has
      // not shortened the punishment - `ACCOUNT_LOCK_MINUTES` was already what
      // bounded it long before this many failures.
      const minutes = (user.lockedUntil!.getTime() - Date.now()) / (60 * 1000);
      expect(minutes).toBeGreaterThan(Config.ACCOUNT_LOCK_MINUTES - 1);
      expect(minutes).toBeLessThanOrEqual(Config.ACCOUNT_LOCK_MINUTES);
    },
    30_000,
  );

  /** The ordinary case the backoff was designed for still doubles. */
  it("doubles the lock over the first few failures past the cap", async () => {
    const cap = Config.MAX_FAILED_LOGIN_ATTEMPTS;
    const first = await nthFailedLogin(cap);
    const second = await nthFailedLogin(cap + 1);

    const lockMinutes = (user: User) =>
      (user.lockedUntil!.getTime() - Date.now()) / (60 * 1000);

    expect(lockMinutes(first)).toBeLessThanOrEqual(
      Config.ACCOUNT_LOCK_INITIAL_MINUTES,
    );
    expect(lockMinutes(second)).toBeGreaterThan(
      Config.ACCOUNT_LOCK_INITIAL_MINUTES,
    );
  });
});
