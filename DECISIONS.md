# Design decisions

Short records of the choices in this service and the reasoning behind them.
Where a decision has a real cost, the cost is written down too.

---

## 1. PostgreSQL rather than MongoDB

**Decision.** Relational storage, with foreign keys from `refresh_token` and
`verification_token` to `user`.

**Why.** The data here is relational and the invariants are the point: a refresh
token belongs to exactly one user, a token family is a set of rows that must be
revoked together, and an email address must be unique. A unique index enforces
that last one under concurrency; an application-level check does not — see
decision 7. `ON DELETE CASCADE` means deleting a user cannot leave live tokens
behind pointing at nothing.

**Cost.** A schema to keep in step with the code, which is what makes decision 8
(migrations) unfinished business rather than a nicety.

---

## 2. TypeORM rather than raw `pg` or Prisma

**Decision.** TypeORM 0.3 with decorator entities.

**Why.** The entity classes double as the schema definition and as the types the
services use, so a column rename is a compile error rather than a runtime
surprise. `synchronize` gives a zero-setup local and test loop: the integration
tests drop the schema and rebuild it from the same classes the application runs
against, so no fixture SQL can drift away from the code.

**Cost.** TypeORM's query builder is weaker than Prisma's generated client, and
`synchronize` is unsafe in production, which is why it is switched off there
(`src/config/data-source.ts`) — and why the service currently has no supported
way to create a production schema.

---

## 3. Two token types, two algorithms

**Decision.** Short-lived RS256 access tokens (`certs/private.pem`), long-lived
HS256 refresh tokens (`REFRESH_TOKEN_SECRET`).

**Why.** An access token is presented to other services, so verification must be
possible without the ability to mint tokens: RS256 lets any service verify with
the public key while only this one holds the private key. A refresh token is only
ever presented back to this service, so a symmetric secret is enough and avoids a
second asymmetric operation on every refresh. Both verifications pin
`algorithms`, which is what blocks the classic algorithm-confusion attack where a
token is re-signed HS256 using the RSA public key as the HMAC secret.

**Cost.** Two secrets to manage instead of one, and the private key has to exist
on disk before the service can sign anything.

---

## 4. Rotating refresh tokens instead of one long-lived token

**Decision.** Every `POST /auth/refresh` burns the presented token and issues its
successor.

**Why.** A stateless long-lived JWT cannot be withdrawn: until it expires, anyone
holding it is the user. Rotation shrinks the window a stolen token is useful for
to a single request, and because every token corresponds to a database row, this
service can revoke one — logout and password reset both depend on that.

**Cost.** A database read and two writes per refresh, and a client that loses the
new token is logged out. That is the deliberate trade: unavailability is
recoverable, an unrevocable stolen token is not.

---

## 5. Reuse detection revokes the entire family

**Decision.** Presenting an already-rotated refresh token revokes every live
token sharing its `familyId`, not just the replayed one.

**Why.** Rotation alone does not detect theft, it only shortens the window. If an
attacker copies a refresh token and uses it, the legitimate client's next refresh
presents a token the server has already burned — so a replay is _evidence_ that
two parties hold the same credential. The server cannot tell which one is the
thief, and guessing wrong leaves the attacker logged in. Revoking the family
forces both back through the password, which the attacker does not have. This is
the OAuth 2.0 Security Best Current Practice recommendation for public clients.

**Cost.** A user who legitimately replays a token — a retried request, two tabs
racing a refresh — gets logged out. Families are per login, so only that one
device is affected; other sessions survive, which
`tests/users/refresh.spec.ts` asserts explicitly.

---

## 6. Two independent brute-force defences

**Decision.** A per-IP rate limit on the `/auth` endpoints plus a per-account
lockout after `MAX_FAILED_LOGIN_ATTEMPTS` failures.

**Why.** They fail in opposite directions. An IP limit does nothing against a
botnet spreading one attempt per address across thousands of hosts. An account
lockout does nothing against credential stuffing that tries one password against
a million different accounts. Each covers the other's blind spot.

**Cost.** The lockout is a denial-of-service primitive: anyone who knows an email
address can lock that account for `ACCOUNT_LOCK_MINUTES`. The lock is
time-boxed rather than permanent for exactly that reason.

---

## 7. The unique index is the authority on duplicate emails

**Decision.** `UserService.create` still checks for an existing address first,
but also translates PostgreSQL error `23505` into a 400.

**Why.** The check-then-insert is a time-of-check/time-of-use race: two
simultaneous registrations for the same address both see "not taken" and both
insert. The database is the only component that can settle that. Before this,
the loser of the race got a 500 — a client error reported as a server fault,
which is both wrong and noisy in alerting.

**Cost.** Error-code knowledge leaks into the service layer.
`tests/unit/UserService.spec.ts` pins the behaviour so it cannot silently regress.

---

## 8. `synchronize` now, migrations later — stated plainly

**Decision.** Ship with `synchronize: !IS_PRODUCTION` and document the gap rather
than half-writing a migration setup.

**Why.** `synchronize` drops columns to make the database match the entities. It
is right for a test suite that rebuilds the schema per case and wrong for
anything holding real data. A migration directory that has never been run
against a real database would be a bigger lie than an honest gap.

**Cost.** There is currently no supported path to create a production schema.
This is the first thing to build next.

---

## 9. Tokens are emailed in plaintext, stored as SHA-256

**Decision.** Password-reset and verification tokens are 32 random bytes; only
`sha256(token)` is stored.

**Why.** Same argument as password hashing: a leaked database dump should not be
a set of working credentials. bcrypt is not needed here because these are 256
bits of entropy rather than a human-chosen secret, so there is nothing to brute
force, and SHA-256 keeps the lookup a single indexed query.

**Cost.** A token cannot be re-displayed after issue. Requesting a new one
invalidates the outstanding one, so the recovery path is cheap.

---

## 10. Hand-written OpenAPI document

**Decision.** `src/docs/openapi.ts` is written by hand rather than generated from
decorators or JSDoc.

**Why.** Generators tie the published contract to the shape of the code, so an
internal refactor changes the public documentation. Writing it by hand keeps one
readable file that describes what clients are promised.

**Cost.** It can drift from the routes. It is reviewed alongside any route change;
a contract test would be the real fix.

---

## 11. Cookies over `Authorization` headers, but both are accepted

**Decision.** Tokens are issued as `httpOnly`, `SameSite=Strict` cookies;
`authenticate` also accepts a bearer header.

**Why.** `httpOnly` puts the tokens out of reach of page scripts, so an XSS bug
cannot read them — something `localStorage` cannot offer. `SameSite=Strict`
removes the CSRF exposure that cookie auth would otherwise add. Accepting a
bearer header keeps the service usable from mobile clients and from `curl`.

**Cost.** Two code paths into the same verification. The cookie domain is
configurable via `COOKIE_DOMAIN`; it used to be hard-coded to `localhost`, which
silently broke the cookie in every other environment.

---

## 12. Dependency advisories are fixed, not annotated

**Decision.** `npm audit` must report `found 0 vulnerabilities`. When this branch
started it reported 19 — 1 critical, 10 high, 6 moderate, 2 low.

**Why.** An advisory list that is carried forward as a README note is a decision
nobody revisits. Two of the 19 were not theoretical for an auth service:
`jws@3.2.2` (GHSA-869p-cjfg-cm3x, "Improperly Verifies HMAC Signature") sits
directly under `jsonwebtoken` and is the code that verifies the HS256 refresh
tokens, and `handlebars@4.7.8` (GHSA-3mfm-83xf-c92r and seven others, the single
critical) reaches the build through `ts-jest`.

Eighteen of the 19 were transitive and every fix existed inside the semver range
the direct dependency already declared, so `npm audit fix` resolved them by
rewriting `package-lock.json` alone — `package.json` was untouched. That is why
the direct dependencies mostly carry carets: a caret is what lets an in-range
security patch be picked up by a lockfile bump instead of a hand edit.

The nineteenth was TypeORM itself — GHSA-9ggv-8w38-r7pm (SQL injection in
`UpdateQueryBuilder`/`SoftDeleteQueryBuilder` `orderBy`) and GHSA-2rp8-mm9q-fp49
(`migration:generate` template-literal code injection), both affecting
`<=0.3.30`. The dependency was pinned at exactly `0.3.27`, so npm called the fix
"outside the stated dependency range" and refused it without `--force`. It is a
patch release, not a major one: `0.3.27` → `^0.3.31` clears both advisories with
no API change. `npm run typecheck`, `npm run build` and all 63 tests pass on
0.3.31 unmodified.

**Cost.** 52 transitive packages moved in one step, which is a large lockfile
diff to review. The mitigation is that the whole verification suite
(`lint:check`, `format:check`, `typecheck`, `build`, `test:ci`) was run after the
lockfile bump and again after the TypeORM bump, against a real PostgreSQL — the
lockfile diff is large but it is not unverified.

**Not done.** TypeORM 1.1.0 is published. No advisory requires it: 0.3.31 is the
fixed version for both TypeORM CVEs, and `0.3.31` is still the `legacy` dist-tag
rather than an abandoned line. Taking a major version of the ORM with no
security driver would be risk without a reason, so this stays on 0.3.x.
