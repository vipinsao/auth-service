import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  CreateDateColumn,
  Index,
} from "typeorm";
import { User } from "./User.js";

export const VerificationTokenType = {
  EMAIL_VERIFICATION: "email_verification",
  PASSWORD_RESET: "password_reset",
} as const;

export type VerificationTokenTypeValue =
  (typeof VerificationTokenType)[keyof typeof VerificationTokenType];

/**
 * Single-use, expiring tokens emailed to the user (email verification and
 * password reset). Only the SHA-256 hash is stored: a dump of this table cannot
 * be replayed against the API, the same reason passwords are stored hashed.
 */
@Entity()
export class VerificationToken {
  @PrimaryGeneratedColumn()
  id: number;

  @Index()
  @Column()
  userId: number;

  @Column({ type: "varchar", length: 32 })
  type: VerificationTokenTypeValue;

  @Index({ unique: true })
  @Column({ type: "varchar", length: 64 })
  tokenHash: string;

  @Column({ type: "timestamptz" })
  expiresAt: Date;

  @Column({ type: "timestamptz", nullable: true })
  usedAt: Date | null;

  @ManyToOne(() => User, { onDelete: "CASCADE" })
  user: User;

  @CreateDateColumn({ type: "timestamptz" })
  createdAt: Date;
}
