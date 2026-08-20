import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * The whole schema as it stands: `user`, `refresh_token`, `verification_token`.
 *
 * Generated with `npm run migration:generate` by diffing the entity classes
 * against an empty database, so it is the same DDL `synchronize` produces - not
 * a hand transcription of it. `tests/db/migrations.spec.ts` re-checks that
 * equivalence on every run by asking TypeORM's schema builder what it would
 * still change after this migration has run; the answer has to be nothing.
 *
 * The generated identifiers (`PK_cace4a...`, `FK_8e913e...`) are TypeORM's
 * hashes of the table and column names. They look arbitrary and are: what
 * matters is that they are deterministic, so `down` can name exactly what `up`
 * created and a later generated migration refers to the same objects.
 *
 * `down` drops the foreign keys before the tables it points at, which is the
 * reverse order of `up`. That ordering is the reason the revert works on a
 * populated database rather than failing on a dependency.
 */

export class InitialSchema1787212846340 implements MigrationInterface {
  name = "InitialSchema1787212846340";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "user" ("id" SERIAL NOT NULL, "firstName" character varying NOT NULL, "lastName" character varying NOT NULL, "email" character varying NOT NULL, "password" character varying NOT NULL, "role" character varying NOT NULL DEFAULT 'customer', "emailVerified" boolean NOT NULL DEFAULT false, "failedLoginAttempts" integer NOT NULL DEFAULT '0', "lockedUntil" TIMESTAMP WITH TIME ZONE, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "UQ_e12875dfb3b1d92d7d7c5377e22" UNIQUE ("email"), CONSTRAINT "PK_cace4a159ff9f2512dd42373760" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "refresh_token" ("id" SERIAL NOT NULL, "userId" integer NOT NULL, "familyId" uuid NOT NULL, "expiresAt" TIMESTAMP WITH TIME ZONE NOT NULL, "revokedAt" TIMESTAMP WITH TIME ZONE, "replacedByTokenId" integer, "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_b575dd3c21fb0831013c909e7fe" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_8e913e288156c133999341156a" ON "refresh_token" ("userId") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_b803086815f2d539fe7a0349d1" ON "refresh_token" ("familyId") `,
    );
    await queryRunner.query(
      `CREATE TABLE "verification_token" ("id" SERIAL NOT NULL, "userId" integer NOT NULL, "type" character varying(32) NOT NULL, "tokenHash" character varying(64) NOT NULL, "expiresAt" TIMESTAMP WITH TIME ZONE NOT NULL, "usedAt" TIMESTAMP WITH TIME ZONE, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_74bc3066ea24f13f37d52a12c79" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_0748c047a951e34c0b686bfadb" ON "verification_token" ("userId") `,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_2eaf4316eb36db7fa25d898ae7" ON "verification_token" ("tokenHash") `,
    );
    await queryRunner.query(
      `ALTER TABLE "refresh_token" ADD CONSTRAINT "FK_8e913e288156c133999341156ad" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "verification_token" ADD CONSTRAINT "FK_0748c047a951e34c0b686bfadb2" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "verification_token" DROP CONSTRAINT "FK_0748c047a951e34c0b686bfadb2"`,
    );
    await queryRunner.query(
      `ALTER TABLE "refresh_token" DROP CONSTRAINT "FK_8e913e288156c133999341156ad"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_2eaf4316eb36db7fa25d898ae7"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_0748c047a951e34c0b686bfadb"`,
    );
    await queryRunner.query(`DROP TABLE "verification_token"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_b803086815f2d539fe7a0349d1"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_8e913e288156c133999341156a"`,
    );
    await queryRunner.query(`DROP TABLE "refresh_token"`);
    await queryRunner.query(`DROP TABLE "user"`);
  }
}
