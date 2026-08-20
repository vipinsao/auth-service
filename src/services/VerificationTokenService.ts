import { createHash, randomBytes } from "crypto";
import { IsNull, Repository } from "typeorm";
import {
  VerificationToken,
  type VerificationTokenTypeValue,
} from "../entity/VerificationToken.js";
import { User } from "../entity/User.js";
import { Config } from "../config/index.js";

const hash = (raw: string) => createHash("sha256").update(raw).digest("hex");

export class VerificationTokenService {
  constructor(private repository: Repository<VerificationToken>) {}

  /**
   * Returns the raw token - the only time it exists outside the email. The
   * database keeps its SHA-256 hash. Issuing a new token invalidates any
   * outstanding one of the same type, so a reset link cannot be kept alive by
   * requesting more of them.
   */
  async issue(user: User, type: VerificationTokenTypeValue): Promise<string> {
    await this.repository.update(
      { userId: user.id, type, usedAt: IsNull() },
      { usedAt: new Date() },
    );

    const raw = randomBytes(32).toString("hex");
    await this.repository.save({
      user,
      userId: user.id,
      type,
      tokenHash: hash(raw),
      expiresAt: new Date(
        Date.now() + Config.VERIFICATION_TOKEN_TTL_MINUTES * 60 * 1000,
      ),
    });
    return raw;
  }

  /**
   * Validates and burns a token in one step. The update is conditional on
   * `usedAt IS NULL`, so two concurrent requests carrying the same token cannot
   * both succeed - the database decides the winner, not a read-then-write race
   * in application code.
   */
  async consume(
    raw: string,
    type: VerificationTokenTypeValue,
  ): Promise<VerificationToken | null> {
    const record = await this.repository.findOne({
      where: { tokenHash: hash(raw), type },
    });

    if (!record || record.usedAt !== null) return null;
    if (record.expiresAt.getTime() <= Date.now()) return null;

    const result = await this.repository.update(
      { id: record.id, usedAt: IsNull() },
      { usedAt: new Date() },
    );
    return result.affected === 1 ? record : null;
  }
}
