import { describe, it, expect } from "@jest/globals";
import type { Repository } from "typeorm";
import { UserService } from "../../src/services/UserService.js";
import { User } from "../../src/entity/User.js";

/**
 * Plain fakes, no database. This is only possible because UserService takes its
 * repository through the constructor.
 */
const repositoryStub = (overrides: Partial<Repository<User>>) =>
  overrides as unknown as Repository<User>;

const userData = {
  firstName: "Vipin",
  lastName: "Sao",
  email: "vipinsao3@gmail.com",
  password: "secret123",
};

describe("UserService.create", () => {
  it("rejects an address that already exists", async () => {
    const service = new UserService(
      repositoryStub({
        findOne: async () => ({ id: 1 }) as User,
      }),
    );

    await expect(service.create(userData)).rejects.toMatchObject({
      status: 400,
    });
  });

  /**
   * Two concurrent registrations for the same address both pass the findOne
   * check and one of them hits the unique index. Before this was handled, that
   * loser got a 500; it is a client error.
   */
  it("maps a unique-violation race to 400, not 500", async () => {
    const service = new UserService(
      repositoryStub({
        findOne: async () => null,
        save: async () => {
          throw Object.assign(new Error("duplicate key value"), {
            code: "23505",
          });
        },
      }),
    );

    await expect(service.create(userData)).rejects.toMatchObject({
      status: 400,
    });
  });

  it("still reports an unrelated database failure as 500", async () => {
    const service = new UserService(
      repositoryStub({
        findOne: async () => null,
        save: async () => {
          throw Object.assign(new Error("connection terminated"), {
            code: "57P01",
          });
        },
      }),
    );

    await expect(service.create(userData)).rejects.toMatchObject({
      status: 500,
    });
  });

  it("never stores the plaintext password", async () => {
    let saved: Partial<User> | undefined;
    const service = new UserService(
      repositoryStub({
        findOne: async () => null,
        save: (async (entity: Partial<User>) => {
          saved = entity;
          return { ...entity, id: 1 } as User;
        }) as unknown as Repository<User>["save"],
      }),
    );

    await service.create(userData);
    expect(saved?.password).not.toBe(userData.password);
    expect(saved?.password).toMatch(/^\$2[aby]\$\d+\$/);
    expect(saved?.role).toBe("customer");
  });
});
