import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import jwt, { type JwtPayload, type SignOptions } from "jsonwebtoken";
import createHttpError from "http-errors";
import { IsNull, Repository } from "typeorm";
import { Config } from "../config/index.js";
import { User } from "../entity/User.js";
import { RefreshToken } from "../entity/RefreshToken.js";

const ISSUER = "auth-service";

let privateKey: Buffer | undefined;
let publicKey: Buffer | undefined;

const readKey = (configuredPath: string): Buffer => {
  const resolved = path.resolve(process.cwd(), configuredPath);
  try {
    return fs.readFileSync(resolved);
  } catch {
    throw createHttpError(500, `Unable to read key file at ${resolved}`);
  }
};

const getPrivateKey = () => (privateKey ??= readKey(Config.PRIVATE_KEY_PATH));
const getPublicKey = () => (publicKey ??= readKey(Config.PUBLIC_KEY_PATH));

/**
 * Access tokens are RS256: only this service holds the private key, but any
 * downstream service can verify one with the public key alone. Refresh tokens
 * are HS256 because nothing outside this service ever needs to verify them.
 */
export class TokenService {
  constructor(private refreshTokenRepository: Repository<RefreshToken>) {}

  generateAccessToken(payload: JwtPayload): string {
    return jwt.sign(payload, getPrivateKey(), {
      algorithm: "RS256",
      expiresIn: Config.ACCESS_TOKEN_EXPIRY as SignOptions["expiresIn"],
      issuer: ISSUER,
    });
  }

  verifyAccessToken(token: string): JwtPayload {
    // Pinning `algorithms` is what stops the classic "alg: none" / algorithm
    // confusion attack, where a token is re-signed HS256 using the public key.
    return jwt.verify(token, getPublicKey(), {
      algorithms: ["RS256"],
      issuer: ISSUER,
    }) as JwtPayload;
  }

  generateRefreshToken(payload: JwtPayload & { id: string }): string {
    return jwt.sign(payload, Config.REFRESH_TOKEN_SECRET, {
      algorithm: "HS256",
      expiresIn: `${Config.REFRESH_TOKEN_EXPIRY_DAYS}d`,
      issuer: ISSUER,
      jwtid: payload.id,
    });
  }

  verifyRefreshToken(token: string): JwtPayload {
    return jwt.verify(token, Config.REFRESH_TOKEN_SECRET, {
      algorithms: ["HS256"],
      issuer: ISSUER,
    }) as JwtPayload;
  }

  private expiryDate(): Date {
    return new Date(
      Date.now() + Config.REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000,
    );
  }

  /** First token of a new family - one family per login/registration. */
  async startFamily(user: User): Promise<RefreshToken> {
    return this.refreshTokenRepository.save({
      user,
      userId: user.id,
      familyId: randomUUID(),
      expiresAt: this.expiryDate(),
    });
  }

  /**
   * Issue the successor of `current` inside the same family and mark `current`
   * spent. A later presentation of `current` therefore lands on a revoked row,
   * which is the signal used to detect replay.
   *
   * Returns null when the row had already been spent by someone else, which the
   * caller must treat exactly as it treats a replay.
   *
   * The whole thing runs in one transaction that starts by taking a write lock
   * on the row being spent. Two things forced that, and a conditional UPDATE
   * alone was not enough for either:
   *
   * - The caller's check that the row was live is a read, and two concurrent
   *   refreshes both pass it. Without the database picking a winner, both
   *   rotate: the family ends up with two live successors and the replay that
   *   should have burned it is never detected.
   * - The loser then revokes the family, and it must not do so while the
   *   winner's successor is still uncommitted - it would revoke the rows that
   *   exist at that instant and the new one would quietly survive, leaving a
   *   live token behind a detected replay. Holding the lock until commit means
   *   the loser only proceeds once the successor is visible to it.
   *
   * `SELECT ... FOR UPDATE` is what makes the second caller wait rather than
   * race. `VerificationTokenService.consume` gets away with a plain conditional
   * UPDATE because burning a token creates nothing that a concurrent caller
   * also has to see.
   */
  async rotate(
    current: RefreshToken,
    user: User,
  ): Promise<RefreshToken | null> {
    return this.refreshTokenRepository.manager.transaction(async (manager) => {
      const row = await manager.findOne(RefreshToken, {
        where: { id: current.id },
        lock: { mode: "pessimistic_write" },
      });

      // Re-read under the lock: by the time the lock is granted, a concurrent
      // refresh may already have spent this row and committed.
      if (!row || row.revokedAt !== null) return null;

      const replacement = await manager.save(RefreshToken, {
        user,
        userId: user.id,
        familyId: current.familyId,
        expiresAt: this.expiryDate(),
      });

      await manager.update(RefreshToken, current.id, {
        revokedAt: new Date(),
        replacedByTokenId: replacement.id,
      });

      return replacement;
    });
  }

  async revokeFamily(familyId: string): Promise<void> {
    await this.refreshTokenRepository.update(
      { familyId, revokedAt: IsNull() },
      { revokedAt: new Date() },
    );
  }

  /** Used after a password reset: every existing session must die. */
  async revokeAllForUser(userId: number): Promise<void> {
    await this.refreshTokenRepository.update(
      { userId, revokedAt: IsNull() },
      { revokedAt: new Date() },
    );
  }

  async findById(id: number): Promise<RefreshToken | null> {
    return this.refreshTokenRepository.findOne({ where: { id } });
  }
}
