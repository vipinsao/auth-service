import "reflect-metadata";
import { DataSource } from "typeorm";
import { User } from "../entity/User.js";
import { Config } from "./index.js";
import { RefreshToken } from "../entity/RefreshToken.js";
import { VerificationToken } from "../entity/VerificationToken.js";
import { RateLimitHit } from "../entity/RateLimitHit.js";
import { migrations } from "../migrations/index.js";

export const AppDataSource = new DataSource({
  type: "postgres",
  host: Config.DB_HOST,
  port: Config.DB_PORT,
  username: Config.DB_USERNAME,
  password: Config.DB_PASSWORD,
  database: Config.DB_NAME,
  ssl: Config.DB_SSL ? { rejectUnauthorized: true } : false,

  // `synchronize` rewrites the schema from the entity classes on every boot and
  // will drop a column to do it. It is enabled only under NODE_ENV=test, where
  // the suite deliberately drops and rebuilds the schema between cases. Every
  // other environment - including a developer's own database - is built by the
  // migrations below, so a migration that has drifted from the entities shows
  // up locally instead of at deploy time. See DECISIONS.md decision 8.
  synchronize: Config.IS_TEST,
  logging: false,
  entities: [User, RefreshToken, VerificationToken, RateLimitHit],
  migrations,
  // Applying a migration outside a transaction leaves a failure half-applied.
  migrationsTransactionMode: "each",
  subscribers: [],
});
