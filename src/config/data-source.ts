import "reflect-metadata";
import { DataSource } from "typeorm";
import { User } from "../entity/User.js";
import { Config } from "./index.js";
import { RefreshToken } from "../entity/RefreshToken.js";
import { VerificationToken } from "../entity/VerificationToken.js";

export const AppDataSource = new DataSource({
  type: "postgres",
  host: Config.DB_HOST,
  port: Config.DB_PORT,
  username: Config.DB_USERNAME,
  password: Config.DB_PASSWORD,
  database: Config.DB_NAME,

  // `synchronize` rewrites the schema from the entity classes on every boot. It
  // is convenient locally and is what the integration tests rely on (they drop
  // and re-create the schema), but it can drop columns, so it is disabled in
  // production. See DECISIONS.md for the migration plan.
  synchronize: !Config.IS_PRODUCTION,
  logging: false,
  entities: [User, RefreshToken, VerificationToken],
  migrations: [],
  subscribers: [],
});
