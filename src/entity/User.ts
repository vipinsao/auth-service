import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from "typeorm";
import { Roles } from "../constants/index.js";

@Entity()
export class User {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  firstName: string;

  @Column()
  lastName: string;

  @Column({ unique: true })
  email: string;

  /** bcrypt hash - the plaintext password is never stored or logged. */
  @Column()
  password: string;

  @Column({ default: Roles.CUSTOMER })
  role: string;

  @Column({ default: false })
  emailVerified: boolean;

  /** Reset to 0 on every successful login. Drives the account lockout. */
  @Column({ type: "int", default: 0 })
  failedLoginAttempts: number;

  @Column({ type: "timestamptz", nullable: true })
  lockedUntil: Date | null;

  @CreateDateColumn({ type: "timestamptz" })
  createdAt: Date;

  @UpdateDateColumn({ type: "timestamptz" })
  updatedAt: Date;
}
