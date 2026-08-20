import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  UpdateDateColumn,
  CreateDateColumn,
  Index,
} from "typeorm";
import { User } from "./User.js";

/**
 * One row per issued refresh token.
 *
 * Tokens issued from the same original login share a `familyId`. Rotation marks
 * the old row revoked and links it to its replacement, so presenting a revoked
 * row is proof that a token was replayed - at which point the whole family is
 * revoked. The JWT itself carries only the row id (as its `jti`); the database
 * row is the authority on whether that token is still live.
 */
@Entity()
export class RefreshToken {
  @PrimaryGeneratedColumn()
  id: number;

  @Index()
  @Column()
  userId: number;

  @Index()
  @Column({ type: "uuid" })
  familyId: string;

  @Column({ type: "timestamptz" })
  expiresAt: Date;

  /** Non-null once the token has been rotated away or explicitly revoked. */
  @Column({ type: "timestamptz", nullable: true })
  revokedAt: Date | null;

  /** The row that superseded this one during rotation. */
  @Column({ type: "int", nullable: true })
  replacedByTokenId: number | null;

  @ManyToOne(() => User, { onDelete: "CASCADE" })
  user: User;

  @UpdateDateColumn({ type: "timestamptz" })
  updatedAt: Date;

  @CreateDateColumn({ type: "timestamptz" })
  createdAt: Date;
}
