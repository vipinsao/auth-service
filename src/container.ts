import { AppDataSource } from "./config/data-source.js";
import logger from "./config/logger.js";
import { User } from "./entity/User.js";
import { RefreshToken } from "./entity/RefreshToken.js";
import { VerificationToken } from "./entity/VerificationToken.js";
import { UserService } from "./services/UserService.js";
import { TokenService } from "./services/TokenService.js";
import { CredentialService } from "./services/CredentialService.js";
import { VerificationTokenService } from "./services/VerificationTokenService.js";
import { MailService } from "./services/MailService.js";
import { AuthController } from "./controllers/AuthController.js";
import { UserController } from "./controllers/UserController.js";

/**
 * Hand-rolled composition root. Every dependency a controller needs is passed
 * to its constructor, which is what lets the services be unit tested with plain
 * fakes and no database.
 */
const credentialService = new CredentialService();

export const userService = new UserService(
  AppDataSource.getRepository(User),
  credentialService,
);

export const tokenService = new TokenService(
  AppDataSource.getRepository(RefreshToken),
);

export const verificationTokenService = new VerificationTokenService(
  AppDataSource.getRepository(VerificationToken),
);

export const mailService = new MailService();

export const authController = new AuthController(
  userService,
  logger,
  tokenService,
  credentialService,
  verificationTokenService,
  mailService,
);

export const userController = new UserController(userService);
