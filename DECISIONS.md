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

**Cost.** A schema to keep in step with the code, which is what decision 8
(migrations) exists to manage.

---

## 2. TypeORM rather than raw `pg` or Prisma

**Decision.** TypeORM 0.3 with decorator entities.

**Why.** The entity classes double as the schema definition and as the types the
services use, so a column rename is a compile error rather than a runtime
surprise. `synchronize` gives a zero-setup local and test loop: the integration
tests drop the schema and rebuild it from the same classes the application runs
against, so no fixture SQL can drift away from the code.

**Cost.** TypeORM's query builder is weaker than Prisma's generated client, and
`synchronize` is unsafe anywhere that holds data, so it is limited to
`NODE_ENV=test` (`src/config/data-source.ts`). Every other environment is built
by the migrations in `src/migrations/` — see decision 8.

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

**Cost, and what was done about it.** The lockout is a denial-of-service
primitive. Anyone who knows an address can spend five requests and take that
account offline. That is not a hypothetical: it is the cheapest attack in this
service, it needs no credentials, and the victim cannot distinguish it from
having forgotten their own password.

Three changes narrow it, none of which needs infrastructure:

1. **The lock is progressive, not flat.** It starts at
   `ACCOUNT_LOCK_INITIAL_MINUTES` (1) and doubles per further failure up to
   `ACCOUNT_LOCK_MINUTES` (15). The case that actually happens - a real user
   mistyping, or a drive-by that fires five requests and leaves - now costs a
   minute instead of a quarter of an hour, a fifteen-fold reduction. A
   determined attacker still climbs to the cap, which is the point: the
   defence against sustained guessing is unchanged.
2. **The lock is no longer visible to someone who does not know the password.**
   It used to be checked before the password, so five failures against a
   guessed address returned 400 if nobody owned it and 423 if somebody did -
   a six-request account-existence oracle. The check now happens after the
   password has been proved correct, so a wrong guess gets the same generic 400
   whatever the account's state.
3. **The counter is incremented in the database, not in application code.** It
   was `user.failedLoginAttempts + 1` computed from a row read earlier in the
   request, so two simultaneous failures both read 3 and both wrote 4. An
   attacker sending guesses in parallel never tripped the cap at all - the
   lockout was, in the case that mattered, not working.

**Residual risk, stated plainly.** An attacker willing to keep sending traffic
can still hold an account at the 15-minute cap indefinitely. Closing that needs
the ability to tell the legitimate user apart from the attacker, and every way
of doing so costs something this service does not currently have: per-source
counters that only lock the guessing source (defeated by a botnet, which is what
the lockout exists for), a device cookie issued on successful login (does not
help a user on a new device), or a second factor (the real answer, and a much
larger feature). The honest position is that the lockout trades a
hard-to-exploit credential attack for an easy-to-exploit availability attack,
that the trade is the conventional one, and that the sharp edge has been filed
down rather than removed.

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

## 8. Migrations build every schema except the test one

**Decision.** `synchronize` is now `Config.IS_TEST` — on only under
`NODE_ENV=test`. Everything else, including a developer's own database, is built
by the migrations in `src/migrations/`.

**Why.** `synchronize` drops columns to make the database match the entities, so
it is right for a suite that rebuilds the schema per case and wrong for anything
holding data. The previous setting, `!IS_PRODUCTION`, left production with no
supported way to create its schema at all — the service could not be deployed.

Turning it off in development as well is the part worth arguing for. If
developers keep `synchronize`, their database is built by one mechanism and
production by another, and a missing migration is invisible until deploy. With
it off, a forgotten migration is a missing column on the developer's own laptop,
which is where it costs nothing to find.

**Migrations are listed explicitly** in `src/migrations/index.ts` rather than
matched by a glob. TypeORM imports every migration during
`DataSource.initialize()`, and a glob resolves to a different path in the
TypeScript sources, in the compiled `build/` output and inside ts-jest's module
registry. A static import list is the same in all three.

**Migrations are generated, not hand-written.** `npm run migration:generate`
diffs the entity classes against a database and emits the DDL, so the migration
is the same SQL `synchronize` would have produced instead of a transcription of
it that can be subtly wrong.

**What stops the two drifting.** `tests/db/migrations.spec.ts` runs the
migrations on an empty database and then asks TypeORM's schema builder what
`synchronize` would still change. The answer has to be nothing. Adding a column
to an entity without writing a migration fails that test with the exact
`ALTER TABLE` in the message — verified by doing it.

`migrationsTransactionMode: "each"` wraps each migration in its own transaction,
so a migration that fails half way rolls back rather than leaving a schema that
matches neither the before state nor the after.

**Cost.** A developer now has to run `npm run migration:run` after pulling a
schema change, and generating a migration needs a database to diff against.
Both are the price of the schema in production being something that was
reviewed rather than inferred at boot.

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

---

## 13. The rate-limit store is pluggable, and there is a free shared one

**Decision.** `RATE_LIMIT_STORE` selects the counter store: `memory` (the
default, `express-rate-limit`'s own in-process store) or `postgres`
(`PostgresRateLimitStore`, counters in the database every replica already
shares).

**Why.** An in-process counter is per instance, so N replicas give an attacker N
times the budget and a limit of 20 is really a limit of 20N. That is not a
theoretical objection: a rolling deploy runs two instances at once, so even a
"single instance" service is periodically two.

The usual fix is Redis, which means another service to run, monitor and pay for.
This service already has a database that every replica connects to, and a rate
limit counter is a row. The shared store therefore costs one table and one
statement per request instead of a new piece of infrastructure.

**How it stays correct with several replicas.** The whole increment is one
statement:

```sql
INSERT INTO rate_limit_hit ("key", hits, "expiresAt") VALUES ($1, 1, now() + ...)
ON CONFLICT ("key") DO UPDATE SET
  hits = CASE WHEN rate_limit_hit."expiresAt" <= now() THEN 1 ELSE rate_limit_hit.hits + 1 END,
  ...
RETURNING hits, "expiresAt"
```

Read, decide and write happen inside one statement, under the row lock
`ON CONFLICT` takes, so two replicas incrementing the same key serialise. A
read-then-write would let both see 19 and both write 20.

**The trap that cost a bug here.** `express-rate-limit` does _not_ prepend
`store.prefix` to the keys it passes in — it only reads that field for its own
double-count check. Applying it is the store's job. Until it did, `authLimiter`
and `refreshLimiter` wrote to the same row and silently shared one budget, which
a live two-replica run showed as a single `rate_limit_hit` row keyed
`127.0.0.1`. `tests/db/rate-limit-store.spec.ts` now asserts the stored keys are
`auth:1.2.3.4` and `refresh:1.2.3.4`, and fails if the scoping is removed.

**Why memory is still the default.** It needs nothing and it is correct for one
instance, which is what someone cloning this repo has. Making `postgres` the
default would put a database write on the path of every auth request for a setup
that does not need one. The README says plainly that more than one replica means
changing it.

**Cost.** One extra round trip per rate-limited request, and rate limiting now
depends on the database being up. Expired rows are swept at most once per window
by whichever request notices, so there is no scheduler; a failed sweep is logged
and ignored, because leaving stale rows behind is housekeeping and failing the
user's request would be an outage.

---

## 14. `trust proxy` is off unless someone says otherwise, and rate-limit keys are hashed

**Decision.** `app.set("trust proxy", ...)` comes from `TRUST_PROXY` and
defaults to `false`. The Postgres rate-limit store hashes the client key before
storing it.

**Why.** `req.ip` is what both limiters count against. With `trust proxy` on,
`req.ip` is taken from `X-Forwarded-For`, a header the caller sends. Nothing in
the shipped Compose stack strips or sets that header, so it was hard-coded to
trust a value any client could choose — meaning a caller could pick their own
rate-limit bucket, use a fresh one per request, and never be throttled at all.
The limiter was decorative against anyone who read the source.

Express also does not check the value is an address. That turned a broken
limiter into an outage: the key went into a `varchar(160)` primary key, so an
`X-Forwarded-For` of a couple of hundred characters made Postgres raise `22001`,
`increment()` reject, and express-rate-limit hand the rejection to `next(err)` —
an unauthenticated 500 on every credential endpoint, from one header. Each
distinct forged value also left a durable row in the auth database, which the
in-memory store had bounded by RAM and cleared on restart.

Defaulting to `false` is the fix; hashing the key is the reason the column can
never be the failure mode again whatever feeds it. **Hashing rather than
truncating**, because two long values that truncate to the same string would let
an attacker land in a chosen victim's bucket deliberately — the hash is there
for a fixed width and collision resistance, not secrecy, since the input is a
public IP address.

**The precondition, which the first version of this decision left implicit and
the config comment then got wrong.** A hop count says nothing about the network:
Express simply counts back from the right-hand end of `X-Forwarded-For`. So
`TRUST_PROXY=1` is only safe where this service's port cannot be reached except
through a proxy that overwrites the header. Setting it on a directly reachable
port — the Compose stack in this repository publishes 5501 with nothing in front
of it — restores the original bug in full. Measured, 60 logins each with a
unique forged header: unset gives `{400: 20, 429: 40}`, `TRUST_PROXY` set gives
`{400: 60}` and 62 rows in `rate_limit_hit`, each holding a window.

`TRUST_PROXY=true` is refused outright and warned about rather than honoured. It
is the worst possible value — trusting every hop means the leftmost entry, which
is entirely the caller's — and it is the one a reader reaches for when the
variable looks like a boolean. express-rate-limit's own validator does not flag
it when it arrives this way. The sibling `Smart-Ingredient-Analyzer` refuses it
for the same reason.

**Cost.** A deployment genuinely behind a load balancer must now set
`TRUST_PROXY=1`, and if it forgets, every client behind that balancer shares one
bucket and gets throttled together. That failure is loud and hits the operator
immediately, which is the right direction: the alternative failed silently and
only hit the users being protected. The stored key also no longer shows which
address a row belongs to — `SELECT encode(sha256('1.2.3.4'), 'hex')` recovers it
when debugging.

---

## 15. Hardening is keyed off "is this local", never "is this production"

**Decision.** `Config.IS_LOCAL` is an allow-list of local environment names
(`dev`, `development`, `test`). Every protection is written as `!IS_LOCAL`.
There is no `IS_PRODUCTION`.

**Why.** There was one, and it was an allow-list of production spellings:
`NODE_ENV === "prod" || NODE_ENV === "production"`. Two things depended on it —
the `secure` flag on the session cookies, and whether a 5xx response returns its
real message. Under `NODE_ENV=staging`, or `Production`, or a value with a
trailing space, both answered "not production": session cookies went out over
plain HTTP, and raw driver errors with table and column names went back to
unauthenticated callers.

Both are failures nobody notices, because the service keeps working. Inverting
the allow-list inverts the failure: an unrecognised environment is treated as
deployed and gets the strict behaviour, so the worst case is a developer whose
cookie will not set over `http://` — visible in seconds, and fixed by naming the
environment properly.

`REFRESH_TOKEN_SECRET` uses the same direction. Outside local environments the
process refuses to start if the secret is shorter than 32 characters or is one
of the example values in this repository. That is a refusal rather than a
warning because the `jti` in a refresh token is the row's sequential integer id:
anyone holding the secret can mint a token for `jti = 1, 2, 3…` and land on real
sessions belonging to other people. A guessable secret is full account takeover,
not a hardening detail.

**Cost.** A deployment that uses an unusual `NODE_ENV` gets the strict path
whether it wanted it or not, and the boot-time secret check is one more way for
a deploy to fail. Both are deliberate: a deploy that fails is cheaper than a
deploy that silently ships an insecure cookie.

**Not done.** The sequential `jti` is still sequential. Making it a UUID would
add real defence in depth — a leaked secret would then also require guessing
which token ids exist — and it needs a column, a migration and a change to how
rotation links rows. It is the next thing to do here, and it is written down
rather than quietly left.

---

## 16. The database is part of the repository

**Decision.** `embedded-postgres` is a committed development dependency, and
`npm run db:local` starts a real PostgreSQL out of `.postgres/`.

**Why.** The test suite is an integration suite: 81 of its assertions talk to a
database, and without one the correct response to `git clone` is an error. That
put "install PostgreSQL, or install Docker" between a reader and any evidence
that this code works — the single largest obstacle to anyone evaluating it.

`embedded-postgres` ships an actual PostgreSQL binary for the host platform. No
Docker, no system package, no service, nothing to pay for. The suite and both
migration directions were run against it to confirm it is a real database and
not a stub.

It runs in the foreground deliberately. A backgrounded database leaves a PID
file, a stale lock and a "why is this port taken" puzzle for the next session;
`Ctrl-C` here is the entire lifecycle.

**Cost.** About 60MB of platform binary in `node_modules`, and the package has
never published a non-beta — `latest` is `18.4.0-beta.17`, which is why it is
pinned exactly rather than caret-ranged. It is a development dependency: CI uses
the `postgres` service in the workflow and Compose uses its own container, so
neither the build nor the deployed image goes near it.

## 17. An empty environment variable means unset, not empty

**Decision.** Every optional string in `src/config/index.ts` is read through a
`str()` helper that treats `""` the same as `undefined`, and the rate-limit
flag does the same. `tests/unit/env-example.spec.ts` loads the committed
`.env.example` and asserts the defaults survive it.

**Why.** `.env.example` documents each optional variable by listing it with an
empty value — that is how a reader learns the name and the default without
reading the source. dotenv sets those to `""`, and `??` only falls back on
`null` and `undefined`. So following the README exactly produced
`ACCESS_TOKEN_EXPIRY=""`, which jsonwebtoken rejects: every login 500'd. The
same shape left `RATE_LIMIT_DISABLED=""` reading as "not disabled", which
switched the limiter on during the test run.

Both are the same mistake in two files, which is the argument for a helper
rather than two `||`s. The version of this file that documents its own
variables is the version most likely to break this way, so the test reads the
committed `.env.example` rather than a fixture: a variable added to the example
without a default is caught the next time the suite runs.

**Cost.** One indirection on every optional read, and a config test that fails
if `.env.example` and the defaults drift apart — which is the point.

## 18. Three spans, three metrics, and two of them shaped by the timing oracle

**Decision.** OpenTelemetry, hand-written rather than auto-instrumented,
exporting to the console by default. Spans around bcrypt, the refresh
transaction and the outbound mail send, and nowhere else. Three metrics.

**Why so little.** `requestContext` already writes one structured line per
request with method, path, status and duration. That answers "how long". Adding
tracing is only worth its weight where it answers "how long doing what", and on
an auth service there are three such places. bcrypt at cost 10 is ~60ms by
design and dominates a login by an order of magnitude — it is the number anyone
should look at before proposing a lower cost factor, and it should be visible
rather than inferred. `rotate` and `revokeLive` run transactions that take a
pessimistic row lock (decisions 5 and 6), so a slow refresh can mean "the
database is slow" or "this caller waited on a concurrent rotation", and those
have opposite remedies; `token.rotate.contended` separates them. `MailService.send`
is an outbound network call that both of its callers wrap in a `try/catch` which
deliberately swallows the failure, because registration must not fail when the
mail server is down — the span is then the only surviving evidence that a
verification email was never sent.

A span around one indexed `SELECT` was considered and rejected. It would appear
in every trace, and it would never be the answer.

**Why not `@opentelemetry/auto-instrumentations-node`.** The build is ESM
(`"type": "module"`, `module: esnext`), and auto-instrumentation works by
patching CommonJS `require`. Under ESM it needs
`--experimental-loader @opentelemetry/instrumentation/hook.mjs` threaded through
`npm start`, `nodemon.json`, the Dockerfile and Jest — four places to forget,
and the failure mode of forgetting is silence. What it would have bought is
spans around `pg` and `http`, neither of which answers any of the three
questions above. The cost of choosing manual is stated rather than hidden: a
`fetch` added elsewhere later will be invisible until somebody wraps it.

**Two decisions the timing oracle made for us.** `CredentialService.compareAgainstAbsentUser`
gets the _same_ span name and the _same_ attributes as the real comparison. That
method exists (decision 6) so a login for an address with no account spends the
same time as one for an address that has one; naming its span differently — or
adding a `user_found` attribute anywhere on the login path — would put the answer
the oracle used to give straight into the telemetry, and telemetry is exported
off the box. For the same reason `mail.send` carries the transport and not the
recipient: "who registered" is not a question a trace backend needs to be able to
answer.

**Three metrics.** `http.server.request.duration` by route and outcome;
`auth.rate_limit.rejections` by limiter, because a refusal is the fastest
response this service produces and is therefore invisible in a duration
histogram; and `auth.token.reuse_detected`, split into `replay` and
`concurrent`. The service cannot tell those apart and answers both by burning
the family (decision 5) — but an operator can act on the difference: a rising
`concurrent` count is a client racing its own refresh, and a rising `replay`
count is an attack. It is the one number here that deserves an alert.

**The route attribute is a closed set, and getting there took two attempts.**
A metric attribute taken from an unauthenticated caller is a memory leak: one
scan of this service would mint a time series per probed URL, and they are never
reclaimed. So the attribute comes from `req.route.path`, which the router
declares. The first version composed it as `${req.baseUrl}${req.route.path}` —
correct while the handler runs, and wrong by the time `res.on("finish")` fires,
because Express has restored `req.baseUrl` to `""` and the error path writes its
response from the app-level handler after that restore. A successful login was
labelled `/auth/login` and a failed one `/login`: the same endpoint under two
names, splitting exactly when a chart most needs them together. The prefix is
now recovered from `req.originalUrl` and only used when it ends with a path this
service declared, with case and trailing slashes normalised.

**A defect worth recording, because it was written during this change.**
Instruments resolve on first use, not at import. `trace.getTracer()` returns a
proxy that picks up a provider registered later, which is why a module-scope
tracer works; `metrics.getMeter()` does not — called before
`setGlobalMeterProvider` it returns a `NoopMeter`, and every instrument built
from it is permanently and silently a no-op. Traces appeared, metrics did not,
and nothing reported an error. It was caught by running the service and grepping
the exporter's output for the metric names, not by reading the code.

**Cost.** `npm run bench:telemetry`, 2000 `GET /health` per configuration — that
route because it does no bcrypt and touches no database, so the overhead is
resolvable rather than lost inside a 60ms hash:

| configuration               | p50     | p95     | mean    |
| --------------------------- | ------- | ------- | ------- |
| off                         | 0.684ms | 1.241ms | 0.772ms |
| console (default)           | 0.783ms | 1.533ms | 0.958ms |
| console, 1s metric interval | 0.831ms | 1.357ms | 0.945ms |

+0.099ms at p50 on the cheapest route here, and roughly 0.16% of a login. The
span processor is `Batch` rather than `Simple` for that reason: a
`SimpleSpanProcessor` serialises and writes on the request thread as each span
ends, putting the exporter inside the path it exists to observe.
