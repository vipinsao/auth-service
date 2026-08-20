/**
 * The migration register.
 *
 * Migrations are listed explicitly rather than picked up from a glob. TypeORM
 * imports every migration during `DataSource.initialize()`, and a glob would
 * mean a runtime `import()` of a path that differs between the TypeScript
 * sources, the compiled `build/` output and the ts-jest module registry the
 * test suite runs in. A static import list resolves identically in all three.
 *
 * Order is execution order, so append - never insert. `tests/db/migrations.spec.ts`
 * fails if a file in this directory is missing from the array, which is the
 * check that makes "remember to register it" safe to rely on.
 */
import type { MixedList, MigrationInterface } from "typeorm";
import { InitialSchema1787212846340 } from "./1787212846340-InitialSchema.js";

export const migrations: MixedList<new () => MigrationInterface> = [
  InitialSchema1787212846340,
];
