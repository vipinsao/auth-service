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
   */
  async rotate(current: RefreshToken, user: User): Promise<RefreshToken> {
    const replacement = await this.refreshTokenRepository.save({
      user,
      userId: user.id,
      familyId: current.familyId,
      expiresAt: this.expiryDate(),
    });
    await this.refreshTokenRepository.update(current.id, {
      revokedAt: new Date(),
      replacedByTokenId: replacement.id,
    });
    return replacement;
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
