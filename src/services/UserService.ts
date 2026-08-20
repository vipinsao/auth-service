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

  /** Called on every failed login; locks the account once the cap is reached. */
  async registerFailedLogin(user: User): Promise<void> {
    const attempts = user.failedLoginAttempts + 1;
    const locked = attempts >= Config.MAX_FAILED_LOGIN_ATTEMPTS;
    await this.userRepository.update(user.id, {
      failedLoginAttempts: locked ? 0 : attempts,
      lockedUntil: locked
        ? new Date(Date.now() + Config.ACCOUNT_LOCK_MINUTES * 60 * 1000)
        : user.lockedUntil,
    });
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
