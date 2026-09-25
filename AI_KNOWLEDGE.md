<!-- docs: sync from coderbuzz/codex@b300389 -->

# Velox Framework: AI Expert Knowledge Reference

**Package**: `@coderbuzz/velox`\
**Purpose**: This document is a comprehensive reference for AI agents generating
application code with the Velox framework. Treat every rule here as authoritative.

---

## 1. Architecture Mental Model

```
AppServer  ─ extends ─► App  ─ extends ─► Router
                         │
                         ├─ middleware[]        (apply / define patterns)
                         ├─ wsRoutes[]          (WebSocket registrations)
                         ├─ _onError?           (app-level error handler)
                         └─ _notFoundEntries[]  (prefix-scoped 404 handlers)
```

- **`Router`**: radix tree + static route map. Compiles routes at server start.
- **`App`**: adds middleware pipeline, `define()`, `apply()`, `use()`, error
  handling.
- **`AppServer`**: adds `run()` / `stop()`, auto-detects runtime.
- **`cloudflare(app)`**: the Cloudflare Workers entry. A Worker cannot listen, so
  instead of `run()` it returns `{ fetch }` for `export default`. See §13b.

---

## 2. Core API

### 2.1 Creating an App

```ts
import { App, AppServer } from "@coderbuzz/velox";

// Entry point (has run/stop)
const app = new AppServer({ port: 3000, hostname: "0.0.0.0" });

// Sub-app (router only, no server lifecycle)
const sub = new App();
```

### 2.2 Route Registration Signatures

Every HTTP method accepts three overloaded forms:

```ts
// Form 1: static value (string or object → auto-serialized)
app.get("/health", "OK");
app.get("/version", { version: "1.0.0" });

// Form 2: handler only
app.get("/users", (ctx) => Response.json([...]));

// Form 3: schema + handler
app.get("/users/:id", { params: { id: coerce(number()) } }, (ctx) => {
  return Response.json({ id: ctx.params.id }); // typed as number
});

// Form 4: schema + static value (rare, but valid)
app.get("/info", { headers: { "x-api-key": string({ min: 10 }) } }, { data: 1 });
```

Supported methods: `get`, `post`, `put`, `patch`, `delete`, `head`, `options`.

### 2.3 Method handling (VLX-30)

- **Implicit `HEAD`.** Every `GET` path without an explicit `HEAD` route also
  answers `HEAD`: same handler, same middleware, same status and headers, no body.
  `Content-Length` reports the GET body's length. Added at compile time only —
  `getRoutes()`/`printRoutes()` list what you registered. An explicit
  `app.head(path, …)` always wins.
- **`405 Method Not Allowed`.** When the path matches some route but not with the
  request's method, the answer is `405` with `Allow: GET, HEAD, POST, …` (the
  implicit HEAD included), body `Method Not Allowed`. It runs the middleware of the
  route pattern that matched, so CORS, logger and guards apply (a guard may answer
  first, e.g. 401). Only a path no route matches is `404` (and reaches `notFound`).
- **Strict trailing slash.** `/items/` is not `/items` — the default in Hono and
  Fastify too. Register both if you need both.
- **Static-value routes run middleware.** `app.get(path, value)` keeps its
  zero-allocation fast path only when no middleware matches the route; under a
  guard / `cors()` / `csrf()` / `secureHeaders()` it goes through the executor
  like a handler (VLX-15).

---

## 3. Schema Validation

The schema object is the second argument before the handler. It has these keys:

| Key       | Validates                           | Async access                             |
| --------- | ----------------------------------- | ---------------------------------------- |
| `params`  | `Record<string, Validator>`         | `ctx.params.xxx` (sync)                  |
| `query`   | `Record<string, Validator>`         | `ctx.query.xxx` (sync)                   |
| `headers` | `Record<string, Validator>`         | `ctx.headers.xxx` (sync, lowercase keys) |
| `cookies` | `Record<string, Validator>`         | `ctx.cookies.xxx` (sync)                 |
| `json`    | `Validator` (usually `object(...)`) | `await ctx.json`                         |
| `text`    | `Validator`                         | `await ctx.text`                         |
| `form`    | `Record<string, Validator>`         | `await ctx.form`                         |
| `state`   | `StateMiddleware`                   | `ctx.state.xxx` (after middleware runs)  |
| `onError` | `ErrorHandler`                      | invoked if handler/middleware throws     |
| `response`| `ResponseSchema`                    | validated after finish callbacks         |

### 3.1 Validators from `@coderbuzz/veta`

`@coderbuzz/veta` is not a dependency of velox (`dependencies: {}`; veta is only a devDependency). Install it separately, or use any `(val, ctx?) => T` function.

```ts
import {
  array,
  boolean,
  coerce,
  date,
  number,
  object,
  optional,
  string,
} from "@coderbuzz/veta";

// string options: min, max, pattern, email, url, uuid, etc.
string({ min: 2, max: 100 });

// number options: min, max, integer
number({ min: 0, max: 100 });

// coerce: converts string inputs (query/params/headers) to the target type
coerce(number()); // "42" → 42
coerce(boolean()); // "true" → true
coerce(date()); // "2024-01-01" → Date

// optional: allows undefined, omits the field from required type
optional(string());

// object: validates a JSON body shape
object({ name: string({ min: 2 }), age: number({ min: 18 }) });
```

### 3.2 Type Inference Rules

- `params/query/headers/cookies` without schema → `Record<string, string>`
- `params` with schema → typed by validator return types, with optional fields
  for validators wrapped in `optional()`
- `json/text` with schema → typed by validator return type
- `form` with schema → typed plain object (NOT `FormData`)
- `params` without schema but route has dynamic segments → typed from path
  string (e.g., `/users/:id` → `{ id: string }`, `/files/*` → `{ "*": string }`,
  `/optional/:id?` → `{ id?: string }`)

### 3.3 Response Schema

Validates the handler's return value before sending to the client:

```ts
response?: {
  body?: Validator;          // validasi raw value (object/string/null)
  status?: number;           // default status (for raw values) or expected status (for Response)
  headers?: Record<string, Validator>;  // validasi header Response
}
```

**Behavior by return type:**

| Return Type | Body | Status | Headers |
|---|---|---|---|
| `object` / `string` / `null` / `undefined` | Validator applied to raw value | If `response.status` set → passed as `defaultStatus` to `toResponse()` | Skipped: raw values don't have headers yet |
| `instanceof Response` | Body validation skipped | `response.status` compared against actual `Response.status`: throws on mismatch | Each key in `response.headers` validated with its Validator |

**Execution order in executor:**

```
handler(ctx) → raw value
  └─ applyResponseValidation(value, schema?.response)
       ├─ body validation (raw only, skip Response)
       └─ toResponse(value, status?) → Response
  └─ _executeFinishCallbacks(Response) ← onFinish callbacks (cookies appended, etc.)
  └─ validateResponse(Response, schema.response)  ← status + headers validation
  └─ return Response → runtime adapter → HTTP write
```

**Sync vs async execution.** Velox compiles two executors per route and picks
one when the route is registered, using `fn.constructor.name === 'AsyncFunction'`
on the handler and on each `state` middleware. That check is an optimisation, not
a correctness rule: a function that returns a Promise **without** being declared
`async` (for example `app.get('/j/:id', (ctx) => service.find(ctx.params.id))`) is an
ordinary `Function`, and so is an `async` function a build has downlevelled.

Those land on the sync executor, which now tests the returned value instead of
trusting the guess: anything with a callable `.then` hands the rest of the
request to an async continuation. This holds for state middleware too, and a
chain that has gone async awaits the remaining middleware in order rather than
reverting to sync.

The cost is one `typeof value.then` test per request on the sync path. What it
buys: before, such a handler was treated as synchronous, so the Promise **object**
was serialised: `{}`, with status 200, because a Promise has no own enumerable
properties. For a read that is an empty screen; for a write it is worse, since
the 200 was sent before the work finished, and if the work then failed the
rejection had no handler at all, enough to take the process down.

**Key design decisions:**

- Body validation happens on raw value, NOT after serialization to Response. Zero parsing overhead.
- Status/headers validation happens AFTER `onFinish` callbacks, so cookies appended via `setCookie` are included in the validated headers.
- Routes without `response` schema: **zero overhead**, `applyResponseValidation` just calls `toResponse()` (same cost as before).
- Throwing a `Response` from middleware/handler **bypasses** response validation entirely: `Response` instanceof check in executor's catch block returns early.
- Response validation errors (body mismatch, status mismatch, header mismatch) are thrown as `Error` with descriptive messages: `"Response body validation failed: ..."`, `"Response status mismatch: expected 201, got 200"`, `"Response header \"x-id\" validation failed: ..."`.

**Type surface (VLX-09, VLX-13).** velox does not depend on veta at runtime: a
validator is any function of the right shape, from any library or written by
hand. That neutrality has a cost the types now state explicitly:

```ts
type Validator<Out = any> = (val: any, ctx?: any) => Out;
type ErrorHandler<S extends Schema = any, P extends string = string, TState = {}> =
  (error: unknown, ctx: Context<S, P, TState>) => Response | Promise<Response>;
type StateMiddleware = { [key: string]: (ctx: Context<any, any>) => unknown };
```

- `Validator<Out>` lets a schema state what it produces. Bare `Validator` is
  still `Validator<any>`, so nothing existing changes. There is no real type
  gate: an identity function satisfies it, and no type can fix that without a
  runtime dependency.
- `ErrorHandler` is generic, so a route-level `onError` can be written against
  that route's schema and see typed `ctx.params` / `ctx.query` / `ctx.state`.
- `StateMiddleware` returns `unknown` rather than `any`. As a constraint it
  accepts every middleware just the same, but a caller holding one through this
  type must narrow before reading a property. `InferState` still recovers each
  middleware's real return type. What it cannot fix is a middleware whose own
  return type is `any`: then `ctx.state.auth.tenantId` is unchecked, a typo is
  `undefined`, and that `undefined` in a `WHERE tenant_id = ?` returns nothing,
  or everything. Type the middleware's return value.

`InferObject` and `ContainsUndefined` are duplicated from veta rather than
imported. `tests/veta-contract.test.ts` asserts the two engines infer identical
optionality for the same shape; if either copy drifts, that test stops
compiling. Without it, the same schema could make a field required on one side
and optional on the other, letting `undefined` reach code that was told the
value is always present.

**TypeScript type:**

```ts
import type { ResponseSchema } from "@coderbuzz/velox";

export interface ResponseSchema {
  body?: Validator;
  status?: number;
  headers?: Record<string, Validator>;
}
```

### 3.4 Type Inference from Response Body

When `response.body` is present in the schema, the handler's return type is inferred from the validator's `ReturnType` via `InferResponse<T>`:

```ts
// Internal type utility (exported from @coderbuzz/velox):
export type InferResponse<T> = T extends ResponseSchema
  ? T['body'] extends Validator
    ? ReturnType<T['body']>
    : any
  : any;
```

**Effect on handler types:**

| `Handler` (compiler.ts) | `TypedHandler` (app.ts) |
|---|---|
| `(ctx) => InferResponse<S['response']> \| Promise<...>` | `(ctx) => InferResponse<S['response']> \| Promise<...>` |

**Example:**

```ts
app.post("/users", {
  response: { body: object({ id: number(), name: string() }) },
}, (ctx) => {
  // return type inferred as { id: number; name: string }
  return { id: 1, name: "John" };     // ✅ OK
  return { id: "1", name: "John" };    // ❌ Type 'string' not assignable to 'number'
  return { name: "John" };             // ❌ Property 'id' is missing
  return "hello";                      // ❌ Type 'string' not assignable to '{ id: number; name: string }'
});
```

**Routes without `response.body`:** return type stays `any` (backward compatible):

```ts
app.get("/health", (ctx) => "OK"); // return type is still any
app.get("/version", { response: { status: 200 } }, (ctx) => {
  return { version: "1.0" }; // no body validator → return type is any
});
```

**Important caveat:** TypeScript structural typing allows extra properties in return positions. The following will NOT error at compile time:

```ts
app.post("/users", {
  response: { body: object({ id: number(), name: string() }) },
}, (ctx) => {
  return { id: 1, name: "John", extra: true }; // ✅ compiles, but `extra` is not in schema
});
```

For strict excess property checking, use a type-level `Exact<T>` wrapper if needed (not provided by default). At runtime, the veta validator will strip/ignore unknown fields depending on the validator configuration.

---



## 4. Context Object (`ctx`)

All fields are lazily evaluated on first access:

```ts
ctx.url          // string: full URL — scheme://host/path?query — on EVERY runtime
ctx.path         // string: path only, no query (percent-encoding as sent)
ctx.method       // string: "GET", "POST", etc.
ctx.params       // parsed + validated route params
ctx.query        // parsed + validated query string
ctx.headers      // parsed + validated headers (all keys lowercase)
ctx.cookies      // parsed + validated cookies
ctx.json         // Promise<T>: parsed + validated JSON body
ctx.text         // Promise<T>: raw text body
ctx.form         // Promise<T>: FormData on every runtime; plain object of validated fields if `form` schema
ctx.body         // raw body stream (runtime-specific)
ctx.state        // accumulated middleware state
ctx.remoteInfo   // { address: string; port: number }
ctx.setCookie(name, value, opts?)  // set response cookie
ctx.onFinish(cb) // register callback called after response is sent
```

**`ctx.url` is absolute everywhere (VLX-23).** Bun, Deno and Workers pass the
Web `Request.url` through. Node and uWS rebuild it: `https` when the socket is TLS
(Node), otherwise `http`; the host from the `Host` header (`localhost` if absent);
then the request target. An absolute-form target (a request sent to a forward
proxy) is used as-is. Until this change Node and uWS gave the bare path
(`/journals/7?x=1`), so `new URL(ctx.url)` threw there — and `csrf()` without an
`origin` option, which does exactly that, rejected **every** same-origin request
on Node and uWS while passing on Bun (VLX-19). Code that logged or compared
`ctx.url` on Node now sees the full URL; use `ctx.path` for the path.

**Cookie options for `setCookie`**: `path`, `domain`, `maxAge`, `expires`,
`httpOnly`, `secure`, `sameSite: 'Strict' | 'Lax' | 'None'`.

**`setCookie` validates and encodes (VLX-26).**
- `name` must be an RFC 6265 token (letters, digits, ``!#$%&'*+-.^_`|~``), else
  `TypeError`.
- `value` is written byte for byte when it is made only of cookie-octets and has
  no `%` — tokens, JWTs, base64 (`+ / =` are cookie-octets), `encryptString`
  output. Anything else (`;`, `,`, spaces, quotes, `\`, non-ASCII, `%`) is
  `encodeURIComponent`-ed. It used to be written verbatim, so
  `setCookie('lang', 'en; Domain=evil.example; Max-Age=99999999')` set an
  attacker-chosen `Domain` and lifetime on the cookie.
- `ctx.cookies` decodes `%XX` in values (an undecodable value is kept as sent), so
  whatever `setCookie` wrote reads back exactly.
- `path`/`domain` containing `;` or a control character, a non-finite `maxAge`,
  or an invalid `expires` Date throw `TypeError`. `maxAge` is truncated to an
  integer.

**`ctx.remoteInfo` is the socket peer unless you trust a proxy (VLX-18).**
`X-Forwarded-For`, `X-Real-IP`, `CF-Connecting-IP` and `True-Client-IP` are
request headers any client can set. They used to be believed unconditionally, so
`ipRestriction({ allowList: [officeIp] })` let in anyone sending
`X-Forwarded-For: <officeIp>`. Now they are read only when the socket peer is a
proxy you declared:

```ts
import { trustProxy } from "@coderbuzz/velox";
trustProxy(false);                        // default: never read proxy headers
trustProxy(["10.0.0.0/8", "127.0.0.1"]); // only from these peers (IPs / CIDR, v4 or v6)
trustProxy((peer) => peer.startsWith("10.")); // predicate
trustProxy(true);                         // every peer — only if the app is unreachable except via the proxy
```

From a trusted peer: `CF-Connecting-IP`, then `X-Real-IP`, win if present;
otherwise `X-Forwarded-For` is walked **from the right**, skipping hops that are
themselves trusted, and the first untrusted hop is the client (the left end is
whatever the client wrote); `True-Client-IP` last. `port` is 0 when the address
came from a header. Process-wide, like `enableRequestContext()`. Invalid list
entries throw at the `trustProxy()` call. Behind a load balancer, without
`trustProxy`, every client appears to be the load balancer.

---

## 5. Middleware & State System

### 5.1 How Middleware Works

Middleware in Velox are just functions inside the `state` key of a schema. They
run before the handler in insertion order. If a middleware returns a `Response`,
the chain stops and that response is sent.

```ts
state: {
  // Returns a value → available in ctx.state.auth
  auth: (ctx) => {
    const token = ctx.headers.authorization;
    if (!token) throw new Response("Unauthorized", { status: 401 });
    return { userId: "u1", role: "admin" };
  },
  // Returns void → NOT in ctx.state (type-erased)
  logger: (ctx) => {
    ctx.onFinish((resp) => console.log(resp?.status));
  },
}
```

### 5.2 Middleware Composition Patterns

#### Per-Route (inline)

```ts
app.get("/path", { state: { auth: myAuthMiddleware } }, handler);
```

#### `apply()`: Global or prefix-scoped

```ts
// Applies to ALL routes (pattern "/*")
app.apply("/*", { auth: (ctx) => verifyAuth(ctx) });

// Side-effect only (no state produced)
app.apply("/*", (ctx) => console.log(ctx.method, ctx.url));

// Scoped to prefix
app.apply("/api/*", { rateLimit: checkRateLimit });
```

#### `define()`: Lexically scoped with type inference

```ts
app.define(
  {
    userId: (ctx) => ctx.headers["x-user-id"] ?? "guest",
    isAdmin: (ctx) => ctx.headers["x-role"] === "admin",
  },
  (app) => {
    // TypeScript knows ctx.state.userId: string, ctx.state.isAdmin: boolean
    app.get("/me", (ctx) => Response.json({ userId: ctx.state.userId }));

    // Nested define: accumulates state
    app.define({ extra: () => "data" }, (app) => {
      app.get("/extra", (ctx) =>
        Response.json({
          userId: ctx.state.userId,
          extra: ctx.state.extra,
        }));
    });
  },
);
```

#### Per-Route overrides `define()` / `apply()` state

Route-level state is merged last, so it can override middleware:

```ts
app.apply("/*", { auth: globalAuth });

app.get("/special", {
  state: { auth: specialAuth }, // overrides globalAuth for this route
}, handler);
```

### 5.3 `onFinish` Pattern

`onFinish` callbacks run after the response is sent. Use for logging, cleanup,
header injection:

```ts
const logger = (ctx) => {
  const start = Date.now();
  ctx.onFinish((resp) => {
    // resp is the Response object (or undefined if handler threw)
    console.log(
      `${ctx.method} ${ctx.url} ${resp?.status} ${Date.now() - start}ms`,
    );
  });
  // void return: not in ctx.state
};
```

---

## 5b. Declared body schemas run

A route that declares `json`, `form` or `text` has that schema **awaited before
the handler**, so declaring it is a contract rather than a suggestion.

```ts
app.post('/jurnal', { json: JournalSchema }, async (ctx) => {
  return postJournal(await ctx.json);   // already validated before this line
});
```

The body getters stay lazy and memoised (reading `ctx.json` twice parses once),
but the executor reads it once itself before calling the handler. Any route with
a body schema therefore uses the async executor, whatever its handler looks like.

**Why:** validation only ran if the handler touched the getter. A handler that
read the body another way, forwarded `ctx.req` elsewhere, or used only part of
the payload was served an unvalidated request and answered 200, and nothing
anywhere reported that the declared schema had gone unused. The inferred type of
`ctx.json` made it look guaranteed.

**Cost** falls only on routes that declare a body schema: the routes that
wanted the check.

**Malformed bodies are 400.** A body that is not valid JSON used to become
`null`: the handler read `null.amount`, the `TypeError` became a 500, and the
actual cause (malformed JSON) appeared nowhere. It is now
`HttpError(400, 'Malformed JSON body')`, in all three runtime contexts, **on
routes with and without a `json` schema**. (Until VLX-20 the schema'd branch
still let the parse error escape unwrapped, so exactly the routes that validate
answered 500.) Only the *parse* is wrapped: an error thrown by your validator
propagates as-is, for your `onError` to map. An unparseable form body is
`HttpError(400, 'Malformed form body')`, with or without a `form` schema. Deno's
`formData()` is lenient — garbage multipart parses as an empty form — so there the
request reaches your validator instead.

**Query decoding (`ctx.query`).** Keys and values are decoded as
`application/x-www-form-urlencoded`, the same as `URLSearchParams`: `+` is a space
(`?q=john+smith` → `"john smith"`; `%2B` is a literal plus), and a malformed escape
(`%E0%A4%A`, `%ZZ`) never throws — valid escapes decode, an invalid `%` stays
literal, non-UTF-8 bytes become U+FFFD. It used to keep `+` literal and let
`decodeURIComponent`'s `URIError` escape as a 500 (VLX-25). A repeated key keeps
the last value.

**Form bodies (`await ctx.form`) are the same on every runtime.** Without a schema
the result is a real `FormData` — `get`, `getAll`, `has`, `entries` — for both
`multipart/form-data` and `application/x-www-form-urlencoded`. The Node and uWS
adapters used to hand-parse url-encoded bodies with `pair.split('=')`, which cut
values at a second `=` (`token=abc==` → `"abc"`), kept only the last of repeated
keys, threw on malformed escapes, and returned a `Map` (Node) or a plain object
(uWS) (VLX-24). With a `form` schema, each validator receives
`formData.get(key)` — the first value, or `null` when absent.

---

## 6. Error Handling

### 6.1 Priority Chain

1. Route-level `onError` (highest priority)
2. App/sub-app-level `onError` (set with `app.onError(...)`)
3. Framework default: see 6.2, and 6.3 for `HttpError`

### 6.2 The default handler never echoes the error

With no `onError`, an unhandled throw produces exactly:

```json
{ "status": 500, "message": "Internal Server Error", "errorId": "mfk3a1-7" }
```

`content-type: application/json`, status 500. **The thrown error's own message
is not in it**, whatever it was. The error object is passed to `console.error`
server-side with the same `errorId` (`[velox] unhandled error <id>: <error>`),
so a user quoting the id from their screen leads straight to the stack trace.

`errorId` is `<base36 ms timestamp>-<base36 counter>`: unique within a process,
not globally, and not a secret.

This applies to every runtime path: the Node and uWS servers use the same
response for an error escaping the executor, instead of writing the message to
the socket as plain text.

Why it matters more than it looks: the most common 500 in a database-backed app
is a driver error, and those carry the constraint name, the column names and the
conflicting values (`Key (tenant_id, ref)=(42, INV-001) already exists`). Echoing
that hands one tenant's data, and the schema, to whoever sent the request,
including an unauthenticated one, if the route is public.

Consequences to plan for:
- A failing request schema is still a 500, not a 400, and the client cannot tell
  which field was wrong. Mapping validation failures to 4xx is a separate change
  (velox does not depend on veta, so it cannot recognise a `VetaError`); until
  then, an `onError` handler in the application is where that mapping goes.
- Anything the client should see must be explicit: an `onError` handler, or a
  thrown `Response`. Both are passed through untouched.

### 6.3 HttpError: a status you chose

```ts
new HttpError(status: number, message?: string, details?: Record<string, unknown>, headers?: Record<string, string>)
// headers: extra response headers — Retry-After, WWW-Authenticate, Allow, …
httpError.toResponse(): Response
```

Thrown anywhere a handler or middleware runs, and answered as written:

```json
{ "status": 404, "message": "Journal not found" }
```

`content-type: application/json`, status = `status`, and every key of `details`
merged into the body alongside `status` and `message`.

`message` defaults to the status' standard reason phrase for the statuses an
application throws by hand (400, 401, 403, 404, 409, 422, 429, 500, 503, …); an
unlisted status falls back to `HTTP <status>`, which is a hint to pass one.

**Why its message is sent when a plain `Error`'s is not:** you constructed it,
so it is an answer. An arbitrary error is a driver or library error whose
message carries constraint names, column names and conflicting values.

A 5xx `HttpError` is sent as written **and** logged (`[velox] unhandled error
<id>`), because at that point something is wrong on this side.

**Validation → 400.** Velox has no runtime dependency on a validation library,
so it cannot recognise a `VetaError` by itself: see 2H in the audit. The
mapping is one line in the application, which is where it can be reviewed:

```ts
const parsed = safeParse(schema, await ctx.json);
if (!parsed.ok) throw new HttpError(400, 'Validation failed', { issues: parsed.issues });
```

`safeParse` (veta) returns every failure with a `path`, so the response carries
a field-level list a form can render, rather than one message at a time.

**An `onError` handler replaces the default handler entirely**, including its
`HttpError` branch. If you install one, handle `HttpError` in it:
`if (err instanceof HttpError) return err.toResponse();`

**`onError` must return (or resolve to) a `Response` (VLX-34).** Anything else —
most often `undefined` from a branch that forgot to `return` — is answered with
the default 500 (`{ status, message, errorId }`, see 6.2), and both
`[velox] onError handler returned undefined instead of a Response; answering 500.`
and the original error are logged. It used to be sent on as a `204 No Content`:
a failed request reported as success, with the error never logged. An `onError`
that throws or rejects is also answered by the default handler.

### 6.4 Throwing a Response

Throwing a `Response` **bypasses** `onError` entirely: it is sent directly.

```ts
throw new Response("Forbidden", { status: 403 });
```

If you want `onError` to receive it, wrap in `Error` or catch it yourself.

### 6.5 Route-Level onError

```ts
app.get("/path", {
  onError: (error, ctx) => {
    if (error instanceof Response) return error; // pass through thrown Responses
    console.error(error);
    return Response.json({ message: "Internal Server Error" }, { status: 500 });
  },
}, handler);
```

### 6.6 App-Level onError

```ts
app.onError((error, ctx) => {
  // An onError handler replaces the default one, so it has to keep doing what
  // the default did: including answering HttpError and NOT echoing anything
  // else's message.
  if (error instanceof HttpError) return error.toResponse();
  console.error(ctx.method, ctx.url, error);
  if (error instanceof MyValidationError) {
    return Response.json({ status: 400, issues: error.issues }, { status: 400 });
  }
  return Response.json({ message: "Internal Server Error" }, { status: 500 });
});
```

When using `app.use()`, the sub-app's `onError` is inherited by its routes.

### 6.7 notFound

```ts
// Global fallback
app.notFound((ctx) =>
  Response.json({ error: "Not Found", path: ctx.url }, { status: 404 })
);

// Sub-app scoped (only matches /api/* paths)
const apiApp = new App();
apiApp.notFound((ctx) =>
  Response.json({ error: "API resource not found" }, { status: 404 })
);
app.use("/api", apiApp);

// define()-scoped (inherits middleware state)
app.define({ user: () => getCurrentUser() }, (app) => {
  app.notFound((ctx) =>
    Response.json({ error: "Not Found", user: ctx.state.user }, { status: 404 })
  );
});
```

### 6.8 Error Type Preservation

Validation errors from body getters (`json`, `text`, `form`) propagate **as-is** to `onError`: no type wrapping.

```ts
import { VetaError } from "@coderbuzz/veta";

app.onError((err) => {
  // VetaError dari json/text/form validation:
  if (err instanceof VetaError) {
    return Response.json(
      { message: err.message, path: err.path },
      { status: 400 },
    );
  }

  // Error dari handler: log detailnya, jangan kirim ke klien
  console.error(err);
  return Response.json({ message: "Internal Server Error" }, { status: 500 });
});
```

This is consistent with `params`, `query`, `cookies`, and `headers`: validation errors from ALL schema keys preserve their original error type (e.g., `VetaError`). No try-catch wrapping in body getters.

**Before v0.3.24**: body getters caught VetaError and re-threw as generic `Error("JSON Body validation failed: ...")`, destroying `instanceof` checks and `err.path`.

---

## 7. Sub-App Mounting

```ts
const api = new App();
api.get("/items", listItems); // mounted at /api/v1/items
api.post("/items", createItem); // mounted at /api/v1/items
api.get("/items/:id", getItem); // mounted at /api/v1/items/:id
api.onError(apiErrorHandler); // applies to all api/* routes
api.notFound(apiNotFoundHandler); // applies to /api/v1/* not-found

app.use("/api/v1", api);

// Without prefix
app.use(api); // routes merged at root level
```

---

## 8. Built-in Middleware Reference

### 8.1 Middleware that returns an `App` (mount with `app.use()`)

These must be mounted, not used in `state`:

| Function           | What it does                                     |
| ------------------ | ------------------------------------------------ |
| `cors(options?)`   | Adds CORS headers, handles OPTIONS preflight     |
| `logger(options?)` | Logs requests with method, URL, status, duration |

```ts
// CORRECT
const corsApp = cors({ origin: "https://example.com" });
corsApp.get("/data", handler);
app.use("/api", corsApp);

app.use(logger());

// WRONG: cors() and logger() return App, not a middleware function
app.apply("/*", cors()); // ❌
```

### 8.2 Middleware used in `state` key

These return functions that produce typed state values:

| Function                  | Returns     | ctx.state type                                      |
| ------------------------- | ----------- | --------------------------------------------------- |
| `jwt(options)`            | async fn    | `JWTPayload` or `Response`                          |
| `jwk(options)`            | async fn    | `JWTPayload` or `Response`                          |
| `session(options)`        | fn/async fn | `T` (generic) or `Response`                         |
| `basicAuth(options)`      | fn/async fn | `{ username: string }` or `Response`                |
| `bearerAuth(options)`     | fn/async fn | `{ token: string }` or `Response`                   |
| `requestId(options?)`     | fn          | `string`                                            |
| `compress(options?)`      | fn          | `{ encoding: 'br' \| 'gzip' \| 'deflate' \| null }` |
| `etag()`                  | fn          | `string \| null` (If-None-Match value, no ETag generated) |
| `timeout(options)`        | fn          | `{ signal: AbortSignal }` (the deadline answers `onTimeout`/504) |
| `secureHeaders(options?)` | fn          | `void` (sets 13 headers via onFinish)               |
| `cache(options?)`         | fn          | `void` (sets Cache-Control via onFinish, status < 400 only, never overwrites the handler's) |
| `bodyLimit(options)`      | fn          | `void` or `Response`                                |
| `timing(options?)`        | fn          | `void` (sets Server-Timing via onFinish)            |
| `ipRestriction(options)`  | fn          | `void` or `Response`                                |
| `csrf(options?)`          | fn          | `void` or `Response`                                |

### 8.3 Body Limit Options

```ts
bodyLimit({
  maxSize: number,          // maximum body size in bytes (>= 0)
  onError?: (ctx) => Response,  // response for a declared Content-Length over maxSize
})
```

**Behavior:**
- Only applies to POST, PUT, PATCH, DELETE: safe methods (GET/HEAD/OPTIONS) pass through.
- Sets the per-request limit (`ctx._setBodyLimit(maxSize)`), which the body
  readers enforce while streaming, whatever the headers say. Precedence:
  `bodyLimit()` > `schema.bodyLimit` > `setDefaultBodyLimit()` (10 MiB).
- Declared `Content-Length` over `maxSize` → `onError(ctx)` or `413 Payload Too Large`.
  Up to 1 MiB over, the body is drained first (the middleware awaits it), so the
  413 arrives after the upload ends and the connection stays usable; further over,
  the 413 is immediate with `Connection: close`.
- No `Content-Length` (chunked): no longer 411. The body is counted as it is read;
  once past `maxSize` → `HttpError(413)` (not `onError`).

### 8.3b Request body limits (all routes)

Every body reader (`ctx.json`, `ctx.text`, `ctx.form`, eager schema validation)
enforces a byte limit on every runtime:

| Source | Scope |
|---|---|
| `setDefaultBodyLimit(bytes)` | process-wide default; **10 MiB** unless set; `Infinity` = none |
| `schema.bodyLimit` | one route: `app.post(path, { bodyLimit: 50 * 1024 * 1024 }, h)` |
| `bodyLimit({ maxSize })` middleware | one request; wins over both |

Over the limit → `HttpError(413, 'Payload Too Large', { limit })`, i.e.
`{"status":413,"message":"Payload Too Large","limit":<bytes>}`.

Mechanics (VLX-22):
- A declared `Content-Length` far over the limit (> limit + 1 MiB) is refused
  before a byte is read, with `Connection: close`.
- Otherwise bytes are counted while reading; past the limit nothing more is kept,
  the rest is read and discarded, and the 413 is thrown when the upload ends —
  up to 1 MiB of overflow; beyond that, at once with `Connection: close`. Sending
  the 413 while the client is still uploading broke keep-alive in testing: kept
  open, the unsent rest was parsed as the next request (a bare 400, or a hang);
  closed, clients saw a reset instead of the 413.
- With a `Content-Length` within the limit the runtime's native reader is used
  (the HTTP framing guarantees the body is not longer); chunked bodies are
  streamed and counted.
- Memory: a refused 200 MB upload raised Node's RSS by ~11 MB (the old code
  buffered it whole: ~660 MB).
- Node and uWS read the body once and share it between `json`/`text`/`form`;
  uWS copies each `onData` chunk (uWS reuses the buffer) and hooks the runtime's
  single `onAborted` instead of replacing it.

### 8.4 JWT / JWK Options

```ts
jwt({
  secret: string,           // HMAC secret (required, must not be empty)
  algorithm?: 'HS256' | 'HS384' | 'HS512',  // default: 'HS256'
  issuer?: string,          // validates iss claim
  audience?: string,        // validates aud claim
  headerName?: string,      // default: 'authorization'
  prefix?: string,          // default: 'Bearer'
  clockTolerance?: number,  // seconds, default: 0
  requireExp?: boolean,     // default: true, reject a token with no exp claim
})

jwk({
  jwksUrl?: string,         // JWKS endpoint URL
  keys?: JWK[],             // pre-loaded keys (alternative to jwksUrl)
  issuer?: string,
  audience?: string,
  headerName?: string,      // default: 'authorization'
  prefix?: string,          // default: 'Bearer'
  clockTolerance?: number,  // seconds
  requireExp?: boolean,     // default: true, reject a token with no exp claim
  cacheTtl?: number,        // ms, default: 600_000 (10 min)
})
```

`jwk()` imports each JWK into a `CryptoKey` once and reuses it (VLX-P1): a
`WeakMap` keyed by the JWK object, one entry per algorithm. The object is stable
for the life of `keys`, or of a fetched JWKS until its `cacheTtl` refresh, after
which the old keys are collected. A key that fails to import is not cached.
Measured RS256 verify: ~115 → ~97 µs per request.

`jwt()` does the same for its HMAC secret: each `jwt()` instance imports its
verify key once per hash and keeps it in its own closure (which already holds the
secret, so nothing new stays alive; a failed import is not cached). Measured
HS256 through the middleware on Bun 1.4.2: ~42 → ~40 µs (−6%). A bare
`verifyJwt(token, secret)` call still imports per call: it has no instance to
cache in, and a process-wide cache keyed by the secret would keep secrets in a
Map for the life of the process.

```ts
signJwt(
  payload: JWTPayload,
  secret: string,
  options?: JWTAlgorithm | { algorithm?: JWTAlgorithm; expiresIn?: number },
): Promise<string>

verifyJwt(
  token: string,
  secret: string,
  options?: {
    algorithm?: JWTAlgorithm;   // default: 'HS256'
    issuer?: string;
    audience?: string;
    clockTolerance?: number;    // default: 0
    requireExp?: boolean;       // default: true
  },
): Promise<JWTPayload>

// No signature check whatsoever. Debugging only.
unsafeDecodeJwtWithoutVerification(token: string): { header: any; payload: JWTPayload }
```

**JWT notes:**
- HS256 is default. HS384 and HS512 also supported.
- Empty secret throws `Error('JWT secret must not be empty')`.
- `clockTolerance` allows small clock skew for `exp` and `nbf` validation. The
  signs are the way round you would want: `exp + tolerance`, `nbf - tolerance`.
- **Expiry is mandatory in both directions.** `signJwt()` throws unless the
  payload has `exp` or you pass `expiresIn` (seconds, positive and finite;
  `exp` on the payload wins). `verifyJwt()`, `jwt()` and `jwk()` reject a token
  with no `exp` claim. `requireExp: false` opts out. A JWT is stateless: a
  leaked token cannot be revoked except by rotating the secret, which signs
  every other session out with it, so a token that never expires is a credential
  you cannot take back.
- `signJwt()` does not mutate the payload you pass; `exp` is added to a copy.
- The third argument of `signJwt()` still accepts a bare algorithm string.
- Error messages returned to client are generic (`'JWT verification failed'`);
  the reason is written to `console.warn` with the `[velox]` prefix. A missing
  `exp` and a bad signature are the same 401 to the caller, and only the log
  tells them apart.
- `unsafeDecodeJwtWithoutVerification()` (formerly `decodeJwt`) verifies nothing.
  Its result is attacker-controlled: anyone can craft a token with any payload.
  Never read `sub`, tenant or role from it. The old name is gone rather than
  deprecated, because it read like the safe thing to call.

**JWK notes:**
- JWKS fetch has a 5-second timeout (AbortSignal).
- Cache is keyed by URL, different JWKS endpoints don't corrupt each other.
- Unknown `kid` in JWT header is rejected immediately (no algorithm fallback).

### 8.5 CORS Options

```ts
cors({
  origin?: string | string[] | ((origin: string, ctx: Context) => string),
  // default: '*'
  allowMethods?: string[],  // default: ['GET','HEAD','PUT','POST','DELETE','PATCH']
  allowHeaders?: string[],
  exposeHeaders?: string[],
  maxAge?: number,          // seconds for preflight cache
  credentials?: boolean,    // default: false
})
```

**`credentials: true` with a wildcard origin throws at construction.** That
covers `cors({ credentials: true })` (origin defaults to `'*'`),
`cors({ origin: '*', credentials: true })` and any array containing `'*'`. The
error names the fix: list the origins. It is thrown from `cors()` itself, so it
surfaces at startup, not on the first cross-origin request.

Why it is not merely a spec technicality: browsers refuse
`Access-Control-Allow-Origin: *` on credentialed requests, and the way around
that refusal is to echo the caller's own `Origin` back. That turns "allow
everyone, with cookies" into a configuration the browser accepts, so any page a
signed-in user opens can `fetch(..., { credentials: 'include' })` your API and
read the response. It also removes the only thing protecting JSON endpoints from
CSRF, since `csrf()` treats a successful preflight as the check.

A resolver function may still be used with `credentials: true`: it is explicit
code, not a default. If such a resolver returns `'*'`, no `Access-Control-Allow-Origin`
header is sent at all.

**Usage patterns:**

```ts
// Mount at root (simplest): handles all routes
const c = cors();
c.get("/data", handler);
app.use(c);

// Mount at prefix
app.use("/api", c);

// Array origin: non-matching origins denied (no ACAO header)
cors({ origin: ["https://a.com", "https://b.com"] });

// Function origin: return empty string to deny
cors({ origin: (o) => o.startsWith("https://trusted") ? o : "" });
```

**Behavior notes:**
- `origin: "*"` or `["*"]` with `credentials: true` throws (see above). Without
  `credentials`, `'*'` is sent as `'*'`.
- Responses always include `Vary: Origin` header for proper CDN caching.
- Empty array `origin: []` denies all origins (no ACAO header set).
- `allowHeaders: []` sets no ACAH header (does NOT mirror request headers).

### 8.6 Session Options

```ts
session({
  cookieName: string,
  validate: (cookieValue: string, ctx: Context) => T | Response | Promise<T | Response>,
  onUnauthorized?: (ctx: Context) => Response,  // default: 401 Unauthorized
})
```

Returns `T` on success, `Response` to short-circuit. Null/undefined triggers
`onUnauthorized`. Runs as async always: no constructor.name detection,
works correctly under bundlers (esbuild, tsup, webpack).

### 8.7 basicAuth Options

**Security note:** Credentials are compared using constant-time comparison (`timingSafeEqual`) to prevent timing attacks.

**An empty configuration throws (VLX-27).** Without `verifyUser`, a missing or
empty `username` or `password` throws at construction. It used to compare against
`''`, so `basicAuth({ username: process.env.ADMIN_USER, password: process.env.ADMIN_PASS })`
with the env vars unset admitted `Authorization: Basic Og==` (empty user and
password).

```ts
basicAuth({
  username?: string,        // required (non-empty) if no verifyUser
  password?: string,        // required (non-empty) if no verifyUser
  realm?: string,           // default: 'Secure Area'
  verifyUser?: (username: string, password: string, ctx: Context) => boolean | Promise<boolean>,
})
// returns { username: string } in ctx.state
```

### 8.7b ipRestriction Options

```ts
ipRestriction({
  allowList?: string[],   // IPs or CIDR ranges ('10.0.0.0/8', 'fd00::/8'); if set, only these pass
  denyList?: string[],    // IPs or CIDR ranges; checked after allowList
  onError?: (ctx: Context) => Response,  // default: 403 'Forbidden'
})
// returns void (pass) or a Response (blocked)
```

- Matches `ctx.remoteInfo.address` — the **socket peer**, unless `trustProxy()`
  declared that peer a proxy (see §4). A client-sent `X-Forwarded-For` does not
  change it.
- IPv4 and IPv6; an IPv4-mapped peer (`::ffff:10.0.0.1`) matches its IPv4 entry,
  and an IPv4 address never matches an IPv6 range or the reverse.
- An invalid entry (`'localhost'`, `'10.0.0.0/33'`) throws at construction instead
  of silently never matching. An address that does not parse matches nothing, so
  an allow-list refuses it.

### 8.8 bearerAuth Options

```ts
bearerAuth({
  token?: string | string[],          // single or multiple valid tokens
  verifyToken?: (token: string, ctx: Context) => boolean | Promise<boolean>,
  realm?: string,                     // default: ''
  prefix?: string,                    // default: 'Bearer'
  headerName?: string,                // default: 'authorization'
})
// returns { token: string } in ctx.state
```

### 8.9 Compress / Timeout

```ts
compress({
  preferred?: CompressionEncoding[],  // default: ['br', 'gzip', 'deflate']
  threshold?: number,                 // @deprecated, no effect (nothing is compressed)
})
```
- **Only negotiates.** Returns `{ encoding }` in state and sets `Vary`. It does
  not compress the body. Bun and Node do not compress responses on their own
  (Deno's `Deno.serve` does), so with no reverse proxy the body goes out
  uncompressed unless the handler compresses it (e.g. `CompressionStream`) and sets
  `Content-Encoding` itself.
- Negotiation follows RFC 9110 (VLX-32):
  - `q=0` means *not acceptable*: `br;q=0, gzip` → `gzip`. (Before, `q` was ignored
    and a substring search picked `br`.)
  - The highest `q` wins; a tie goes to `preferred` order: `gzip;q=0.5, br;q=0.8` →
    `br`; `gzip, br` → `br` (default order), or `gzip` with `preferred: ['gzip', …]`.
  - `*` covers codings not listed, with its own `q`: `br;q=0, *` → `gzip`;
    `*;q=0` → `null`.
  - Tokens match whole and case-insensitively: `x-gzip` is not `gzip`; `GZIP` is.
  - A malformed `q` counts as 1; values are clamped to 0..1.
  - `null` when nothing in `preferred` is acceptable (or no header).
- The middleware's `CompressOptions` type is not importable from `@coderbuzz/velox`: the root export of that name is the `compressString` options type (12.2).
- Adds `Vary: Accept-Encoding` to responses via `onFinish`.

```ts
timeout({
  duration: number,               // milliseconds, must be > 0 (NaN is rejected too)
  onTimeout?: (ctx) => Response,  // default: new Response('Gateway Timeout', { status: 504 })
})
```
- `duration` not `> 0` throws `Error` at middleware creation time.
- **The deadline answers the request (VLX-33).** When `duration` ms pass before
  the handler's promise settles, the request is answered with `onTimeout(ctx)`,
  default `504 Gateway Timeout`, and the `AbortSignal` in state is aborted at the
  same moment. If `onTimeout` throws, the 504 is sent.
- Mechanism: the middleware registers a deadline promise on the context
  (`ctx._setDeadline`, internal); the executor races the handler's promise
  against it (`Promise.race`). Without `timeout()` this costs one property read
  per request.
- Only an **async** handler can be cut off: a synchronous handler that blocks the
  event loop finishes before the timer can fire.
- The handler is not stopped. Code that ignores the signal keeps running in the
  background; its late result is discarded and a late rejection is swallowed (no
  unhandled rejection). Pass the signal on — `fetch(url, { signal })`, a driver
  that accepts one — to actually stop work.
- The timer is cleared in `onFinish`, so a fast response leaves nothing behind.
- The AbortSignal is available at `ctx.state.<key>.signal` (e.g. `ctx.state.timeoutSig.signal` for `state: { timeoutSig: timeout(...) }`).
- Before: only the signal was aborted; a handler that did not pass it on ran to
  completion and its response was sent, and `onTimeout` was never called.

### 8.10 CSRF Rules

Applies to unsafe methods only: POST, PUT, PATCH, DELETE. GET, HEAD and OPTIONS
always pass.

Decision order on an unsafe request:

1. **`Origin` present** → must be allowed, or 403. **Content type is not
   consulted.**
2. **No `Origin`, `Referer` present** → its origin must be allowed, or 403.
3. **Neither header** → 403 when the content type is form-producible
   (`application/x-www-form-urlencoded`, `multipart/form-data`, `text/plain`, or
   absent); allowed otherwise.

**JSON is no longer exempt.** It used to be, on the premise that a browser
cannot send a cross-origin `application/json` POST without a CORS preflight.
True, but only while CORS is configured correctly. Combined with a permissive CORS setup
the preflight always succeeded, `csrf()` skipped every JSON request, and the API
had no CSRF protection at all, from two lines that both looked like good
practice. Reading one header costs nothing; the hidden coupling cost a great
deal.

Step 3 is what keeps non-browser clients working: curl, a mobile app or a
service call sends no `Origin`, and is not what CSRF protects against. A browser
does send `Origin` on unsafe cross-origin requests, so the attack shape lands in
step 1.

**"Allowed" without an `origin` option means same-origin:** the request's
`Origin` must equal `new URL(ctx.url).origin`. This works on every runtime since
`ctx.url` became absolute everywhere (VLX-19/VLX-23; on Node and uWS it used to
throw, which rejected every same-origin request). **Behind a TLS-terminating
proxy** the server builds `http://host` while the browser sends
`Origin: https://host`, so the default rejects — pass the public origin
explicitly: `csrf({ origin: 'https://app.example.com' })`.

---

## 9. WebSocket

### 9.0 Handler errors are reported

```ts
onWsHandlerError((error: unknown, source: string) => void | null): void
```

A throwing user handler is isolated from the other handlers on the same socket
(one failure must not take the rest down), but it is no longer swallowed. The
default reporter writes `[velox] WebSocket handler error in <source>:` to
`console.error`; pass your own to route them to a logger or a counter, or `null`
to silence them, which is then a decision rather than an accident.

`source` is `'<name> handler'` for the handler that failed — `'open handler'`,
`'message handler'`, `'close handler'`, `'ping handler'`, `'pong handler'`,
`'error handler'`, `'drain handler'`, `'upgrade handler'` — or `'topic dispatch'`
for a `WsTopicHub` callback. This holds on **every** runtime adapter (Bun, Node,
uWS, Deno).

**Async handlers are covered.** A handler may be `async`; a rejection is reported
exactly like a synchronous throw. Before this, only synchronous throws were caught:
an `async message()` that rejected produced an **unhandled rejection, which ends
the process on Bun and Node** — one malformed message took the whole server down,
every other connection and every HTTP request with it (VLX-17). Handlers are
called as methods of the handler object, so `this` inside a handler still works.

**An upgrade handler that throws** answers the upgrade with 500 *and* is reported
(`'upgrade handler'`); it used to be answered 500 silently.

**`close` fires exactly once per connection** on every adapter. The Node adapter
used to call it twice on a server-initiated close (once from `peer.close()`, again
when the client's close frame arrived), so presence counters and lock releases
in a close handler ran twice.

**uWS binary messages are copied** before the handler runs: uWS reuses the
ArrayBuffer after the callback returns, so an async handler reading it after an
`await` used to see a detached buffer.

Previously most sites were empty `catch` blocks, and the first fix (audit #1,
VLX-10) only reached the Node `message` path and `WsTopicHub.dispatch`; Bun, uWS
and Deno kept swallowing (VLX-21). A handler that threw on one
malformed payload stopped delivering for that message with no log, no hook and
no counter, and the symptom that reached you was "sometimes the notification
doesn't arrive," close to undiagnosable.

A reporter that itself throws is caught, so it cannot escalate into the socket
teardown path.

### 9.1 Basic Registration

```ts
app.ws<DataType>(path, handler, options?);
```

### 9.2 WsHandler Interface

```ts
{
  upgrade?(req: Request): DataType | Response | Promise<DataType | Response>;
  // reject upgrade with Response, or return per-connection data

  open?(peer: WsPeer<DataType>): void | Promise<void>;
  message(peer: WsPeer<DataType>, message: WsMessageData): void | Promise<void>;
  close?(peer: WsPeer<DataType>, code: number, reason: string): void | Promise<void>;
  drain?(peer: WsPeer<DataType>): void;
  ping?(peer: WsPeer<DataType>, data: WsMessageData): void;
  pong?(peer: WsPeer<DataType>, data: WsMessageData): void;
  error?(peer: WsPeer<DataType>, error: Error): void;
}
```

### 9.3 WsPeer Methods

```ts
peer.send(data, compress?)     // send message
peer.getBufferedAmount()       // bytes buffered by the runtime
peer.close(code?, reason?)     // close connection
peer.subscribe(topic)          // subscribe to topic
peer.unsubscribe(topic)        // unsubscribe from topic
peer.publish(topic, data)      // publish to topic (excludes self)
peer.isSubscribed(topic)       // check subscription
peer.ping(data?)               // send ping frame
peer.pong(data?)               // send pong frame
peer.data                      // per-connection data (from upgrade handler)
peer.remoteAddress             // client IP
peer.readyState                // 0=CONNECTING, 1=OPEN, 2=CLOSING, 3=CLOSED
```

`peer.send()` returns a positive byte count on success, `-1` when the runtime queued the write under backpressure, and `0` when it was dropped/failed. Avoid blindly retrying `-1` because the payload is already queued. Keep only newer application state if coalescing is safe, then use `drain` to continue. The uWebSockets.js adapter normalizes its native `BACKPRESSURE/SUCCESS/DROPPED` enum to these values.

Portable drain behavior:

- Bun and uWebSockets.js forward their native drain callback.
- Node uses the Boolean result of `socket.write()` and forwards the socket `drain` event; `getBufferedAmount()` reports `writableLength`.
- Deno exposes `WebSocket.bufferedAmount` and polls until it reaches zero before invoking `drain`.

### 9.4 Native Pub/Sub vs WsTopicHub

Use **native pub/sub** (`peer.subscribe` / `peer.publish`) for:

- Simple broadcast within the same WebSocket route
- Bun/uWS native performance

Use **`WsTopicHub`** for:

- Cross-route publish (HTTP → WebSocket, background job → WebSocket)
- Dead peer detection (`hub.markAlive(peer)`)
- Explicit remove-from-all-topics on close (`hub.leave(peer)`)

```ts
import { WsTopicHub } from "@coderbuzz/velox";

const hub = new WsTopicHub<T>();
hub.subscribe(peer, topic, (peer, msg) => {}) // handler required; same topic replaces it
hub.unsubscribe(peer, topic)
hub.leave(peer)                               // all topics + liveness state; call from close()
hub.dispatch(peer, msg)                       // call from message(): runs the peer's topic handlers
hub.publish(topic, data, compress?)           // send to ALL subscribers, including the sender
hub.markAlive(peer)                           // call from pong()
hub.isPeerAlive(peer, timeoutMs)
hub.pruneDeadPeers(timeoutMs)                 // close(1001, 'ping timeout') + leave
hub.startDeadPeerCheck(checkIntervalMs, timeoutMs) / hub.stopDeadPeerCheck()
hub.subscriberCount(topic); hub.isSubscribed(peer, topic); hub.topicNames()
```

`TopicCallback<T>` is `(peer, msg) => void | Promise<void>`. A throwing handler in `dispatch()` — or an async one that rejects — is reported through `onWsHandlerError` with source `'topic dispatch'`.

### 9.5 WsOptions Defaults

```
pingInterval:       30 (seconds)
pongTimeout:        10 (seconds)
idleTimeout:        120 (seconds)
maxPayloadLength:   16_777_216 (16 MB) — bounds the assembled MESSAGE, fragments included
backpressureLimit:  16_777_216 (16 MB)
closeOnBackpressureLimit: false
perMessageDeflate:  false
```

On Bun, options across multiple WebSocket routes use the strictest explicit payload/backpressure limit. A route can therefore lower the 16 MiB default. Set `closeOnBackpressureLimit: true` only when disconnecting overloaded peers is the intended policy; otherwise handle `send() === -1`, `getBufferedAmount()`, and `drain` in application code.

---

## 10. Velox Ecosystem: Binary WebSocket Protocol

The binary Wire Protocol (formerly KBWP) was extracted from velox into separate packages to keep the core lean:

| Package | What it provides | Velox dependency? |
|---|---|---|
| `@coderbuzz/velox-ws-wire` | `encodePing()` ... `encodeAuthFail()`, `decode()`, `isWireBinaryFrame()`, `MsgType`: pure binary framing codec | No |
| `@coderbuzz/velox-ws-wire-client` | `WireClient`: fault-tolerant WebSocket client with binary protocol | No |
| `@coderbuzz/velox-ws-wire-server` | `wireProtocol()`: server-side handler, mount via `app.use()` | Yes |

**Warning:** `WSClient`, `wsClientProtocol`, `WsClientState`, `WsDefinition`, `WsClientOptions` were removed from velox in v0.3.7. Import from the new packages instead:

```ts
// old: no longer in @coderbuzz/velox
import { WSClient, wsClientProtocol } from "@coderbuzz/velox"; // ❌

// new
import { WireClient } from "@coderbuzz/velox-ws-wire-client";
import { wireProtocol } from "@coderbuzz/velox-ws-wire-server";
```

---

## 11. File Utilities

### 11.1 sendFile

```ts
sendFile(filePath: string, options?: SendFileOptions): Promise<Response>
// 404 Response (no throw) when the file does not exist
```

Options:

```ts
{
  contentType?: string,           // overrides auto-detection
  download?: boolean | string,    // true = original name, string = custom name
  cacheControl?: string,          // Cache-Control header value
  headers?: Record<string, string>,
  status?: number,                // default: 200
  reqHeaders?: Headers | Record<string, string>,
  // pass ctx.headers to enable: ETag/If-None-Match (→304),
  //   Last-Modified/If-Modified-Since (→304), Range (→206)
  root?: string,                  // base dir the path must stay inside
}
```

**Path containment (`root`) — required for untrusted input.** Without `root`,
`sendFile` opens exactly the path given: `sendFile("./public/" + ctx.params.name)`
serves `../../etc/passwd` for `name = "../../etc/passwd"` (arbitrary file read).
When `root` is set, the served path is computed as `path.resolve(root, filePath)`
and the request is answered **404 before the file is opened** if the result is not
`root` itself or a descendant of it (the `+ path.sep` check also blocks a sibling
dir whose name is a prefix of `root`, e.g. `/srv/pub` vs `/srv/public`). A NUL
byte (`\u0000`) in `filePath` is refused on every call, with or without `root`.
`filePath` may be the raw request sub-path (`sendFile(ctx.params.name, { root })`)
or an already-joined absolute path (`sendFile(join(root, name), { root })`); both
are checked against `root`. There is no matching containment for a path with no
`root`, which is why `root` is mandatory whenever the path is user-controlled.

### 11.2 listDirectory

```ts
listDirectory(dirPath: string, options?: ListDirectoryOptions): Promise<FileEntry[]>
// return it from a handler to get a JSON array
```

Options:

```ts
{
  recursive?: boolean,         // default: false
  maxDepth?: number,           // default: 10
  stats?: boolean,             // include size/modifiedAt, default: true
  filter?: (entry: FileEntry) => boolean,
}
```

FileEntry: `{ name, path, isDirectory, size, modifiedAt }`.

### 11.3 receiveFiles

```ts
const files: UploadedFile[] = await receiveFiles(await ctx.form, options?);
// receiveFiles(formData: FormData, options?: ReceiveFileOptions): Promise<UploadedFile[]>
// Throws Error when a file exceeds maxFileSize or has a type outside allowedTypes;
// files past maxFiles are silently ignored. String fields are skipped.
```

Options:

```ts
{
  maxFileSize?: number,         // max bytes per file
  maxFiles?: number,
  allowedTypes?: string[],      // MIME types, e.g. ['image/png']
  fields?: string[],            // only extract these form field names
}
```

UploadedFile: `{ fieldName, fileName, type, size, data: ArrayBuffer }`.

### 11.4 saveFile

```ts
saveFile(filePath: string, data: Blob | ArrayBuffer | Uint8Array | string): Promise<void>
await saveFile(`./uploads/${crypto.randomUUID()}`, file.data); // creates parent dirs on ENOENT
```

`file.fileName` is client-supplied: never build a path from it without sanitising.

### 11.5 getMimeType

```ts
getMimeType(filePath: string): string
// 'photo.jpg' → 'image/jpeg'
// '.css'      → 'text/css; charset=utf-8'
// unknown     → 'application/octet-stream'
```

---

## 12. Utilities

### 12.1 Encryption

```ts
import {
  decryptString,
  encryptString,
  generateSecretKey,
} from "@coderbuzz/velox";

const key = generateSecretKey(); // sync, returns base64 string
const enc = await encryptString("data", key); // AES-256-GCM, base64 output
const dec = await decryptString(enc, key);
```

```ts
generateSecretKey(): string                  // base64, 32 random bytes
generateSalt(): string                       // base64, 16 random bytes
deriveKeyFromPassphrase(
  passphrase: string,
  salt: string,                              // base64, from generateSalt()
  options?: { iterations?: number },         // default 600_000
): Promise<string>                           // base64 32-byte key
decryptString(encrypted, key, options?: { legacyKeyDerivation?: boolean })
```

**The key must be a base64 32-byte key.** Anything else throws, with a message
naming both ways to get one. Previously the parameter was called `password` and
was hashed once with SHA-256, so `SESSION_SECRET="erp-rahasia-2026"` became the
key. SHA-256 is fast and GPU-friendly: that is minutes of offline guessing from
a single captured cookie, and whoever guesses it can mint a valid session for
any user in any tenant.

`deriveKeyFromPassphrase` is PBKDF2-HMAC-SHA256, 600,000 iterations by default
(OWASP's floor). It is deliberately slow: derive once at startup, never per
request. The salt is not a secret but must be stable: the same passphrase and
salt must produce the same key, or yesterday's data does not decrypt. The
iteration count is part of the recipe too; changing it changes the key.

`legacyKeyDerivation` reproduces the old single-SHA-256 derivation so existing
ciphertext can be read and re-encrypted. There is no equivalent on
`encryptString`: the weak form cannot be written any more.

**Malformed base64 is an error (VLX-35).** The internal decoders behind
`decryptString`, the secret and salt of `encryptString`/`deriveKeyFromPassphrase`,
`decompressString`, and JWT parsing (`jwt()`, `jwk()`, `verifyJwt`,
`unsafeDecodeJwtWithoutVerification`) reject a
character outside the alphabet (standard `A–Z a–z 0–9 + /` with `=` padding;
base64url `- _`, unpadded), padding anywhere but the end, and a length that no
encoding produces (4n+1). Before, any such character silently decoded as `0`
bits, so a mangled ciphertext or token reached the crypto layer as different
bytes instead of failing at decode. `decryptString` already threw on a bad
ciphertext, so callers see the same kind of failure, only earlier; in `jwt()`
and `jwk()` a token whose segments are not base64url is a 401, and
`unsafeDecodeJwtWithoutVerification` throws.

LRU key caching (64 entries) avoids repeated key import. The cache is keyed by a
digest of the secret, not the secret: this Map lives for the life of the process,
and a plaintext session secret in it would appear verbatim in every heap and core
dump.

**What was already right, and is unchanged:** AES-GCM with a fresh random 12-byte
IV per operation, IV prepended to the ciphertext, and GCM's authentication, so
no padding oracle and no IV reuse. The cryptography was sound; the key derivation
was not.

### 12.2 Compression

```ts
import { compressString, decompressString } from "@coderbuzz/velox";

const c = await compressString(input, { encoding: "gzip", level: 9 });
const d = await decompressString(c, { encoding: "gzip" });
```

Encodings: `'gzip'` (default), `'deflate'`, `'deflate-raw'`. gzip/deflate
levels: 0–9. Output is base64url-encoded (safe for cookies and URLs).

**`decompressString(s, { maxOutputSize })` caps the output (VLX-29):** default
10 MiB (`10 * 1024 * 1024`), `Infinity` to disable. Over it, decompression stops
and a `RangeError` is thrown. Compressed input is usually attacker-controlled (a
cookie, a body) and deflate expands ~1000× — measured 766× for a 6.5 KB input
that became 5 MB.

### 12.3 Memoize

```ts
import { memoize } from "@coderbuzz/velox";

// Auto-detects sync vs async
const fn = memoize(
  async (id: string) => fetchUser(id),
  {
    maxSize: 256, // default: 256 entries
    ttl: 30_000, // ms (0 = no expiry)
    key: (id) => id, // custom key resolver (default: first arg)
    async: true, // force the async strategy (see below)
  },
);

fn.cache; // Map, direct access
fn.clear(); // clear all entries
// Async version also has: fn.inflight (in-flight deduplication Map)
```

**Strategy detection.** The strategy is chosen once, when `memoize()` is called,
from `fn.constructor.name === 'AsyncFunction'`. That does not recognise
`(id) => db.find(id)` (an ordinary function returning a Promise), nor an
`async` function a build has downlevelled. Such a function gets the sync
strategy, and the cache holds the Promise rather than its value.

Pass `{ async: true }` for those. Without it the failure is no longer permanent:
the sync strategy notices a cached Promise and evicts the entry if it rejects,
so a transient error is retried instead of being replayed to every later caller
for the lifetime of the process. What it cannot give you is in-flight
deduplication: the wrapper's shape (whether it has `.inflight`) is fixed when
it is created, before any call has happened.

### 12.4 Ambient Request Context

```ts
enableRequestContext(): void      // call once at startup, before serving
disableRequestContext(): void     // mainly for tests
isRequestContextEnabled(): boolean
getRequestContext<S, P, TState>(): Context<S, P, TState>            // throws if none
tryGetRequestContext<S, P, TState>(): Context<S, P, TState> | undefined
```

**Off by default.** With it off the cost is one boolean test per request;
`AsyncLocalStorage` is not free and velox is built for throughput.

**What it is for.** Code far from the handler (a repository, an audit hook, the
`SET LOCAL` that drives row-level security) can read the current request
without every caller in between remembering to pass it. A `tenantId` threaded by
hand is a `string` among strings: when a new endpoint forgets it, nothing fails
to compile and nothing fails at runtime, the query just runs against the wrong
tenant.

**`getRequestContext()` throws instead of returning `undefined`.** Code reading
a tenant id from it is deciding which rows someone may see; `undefined` must
stop it, not be carried forward. The two messages differ so the cause is
obvious: "the ambient request context is off" (you never called
`enableRequestContext()`) versus "no request in scope" (it is on, but this call
is outside a request or escaped its async scope).

**Mechanics.** Each request runs inside `AsyncLocalStorage.run()` with a mutable
holder; the context factory fills the holder as soon as the `Context` exists.
The scope has to be entered before the Context is built, which is why it is a
holder and not the Context itself: `enterWith()` would avoid the holder and
leak into whatever else shares the current tick, which on a server is other
requests.

**Covered:** route handlers, `state` middleware, `notFound` handlers, async
handlers across `await`, and Promise-returning handlers not declared `async`
(they resume inside the same scope). `getRequestContext() === ctx` inside a
handler.

**Not covered**, and no mechanism can cover it: anything that escaped the
request's async scope: a callback pushed into a module-level array and invoked
later, `setInterval`, a queue worker. Pass the value explicitly there.

**Bridging to veta.** `safeParse(schema, body, getRequestContext())` hands the
request context to validators that need it; `withContext()` on the veta side
makes a missing one a `VetaError` rather than a `TypeError`.

### 12.5 URL

```ts
import { getPathname } from "@coderbuzz/velox";
getPathname("https://example.com/api?q=1"); // '/api'
```

---

## 13. Runtime Detection & Server Startup

```ts
import { isBun, isDeno, isNode, isWorkers } from "@coderbuzz/velox";
```

All four are `const boolean`, evaluated once when the module loads:

| Flag | True when | Notes |
|---|---|---|
| `isDeno` | `Deno.version` exists | |
| `isBun` | `Bun.version` exists | |
| `isWorkers` | `navigator.userAgent === 'Cloudflare-Workers'` | |
| `isNode` | `process.versions.node` exists **and** not Bun **and** not Workers | Workers with `nodejs_compat` report `process.versions.node` (e.g. `22.19.0`). Before `isWorkers` existed, `isNode` was `true` there |

`server()` / `AppServer.run()` pick an adapter in the order Deno → Bun →
Workers (throws, see §13b) → Node.

```ts
// Start server
const { hostname, port } = await app.run();

// Graceful shutdown
await app.stop();

// Signal handlers (Node.js / Deno)
process.on("SIGTERM", async () => {
  await app.stop();
  process.exit(0);
});
process.on("SIGINT", async () => {
  await app.stop();
  process.exit(0);
});
```

**Runtime selection for Node.js:**

- `UWS=1` → uses `uWebSockets.js` (must be installed)
- Default → uses `node:http`

Velox imports `uWebSockets.js` through a variable (`import(UWS_MODULE)`), not a
string literal, so bundlers do not follow it. With a literal, esbuild (and so
wrangler) tried to bundle the addon's `.node` binaries whenever
`uWebSockets.js` was installed. The build failed with `No loader is configured
for ".node" files`, which broke a Worker in any repo that also runs velox on
Node.

---

## 13b. Cloudflare Workers

### 13b.1 Minimal Worker

```ts
// src/index.ts
import { App, cloudflare, getEnv, getExecutionContext } from "@coderbuzz/velox";

interface Env {
  KV: KVNamespace;        // types from @cloudflare/workers-types
  API_KEY: string;
}

const app = new App();       // App, not AppServer (AppServer also works; its run() throws)

app.get("/", "Hello from the edge");
app.get("/kv/:key", (ctx) => getEnv<Env>(ctx).KV.get(ctx.params.key));   // null → 204
app.post("/events", async (ctx) => {
  getExecutionContext(ctx).waitUntil(logSomewhere(await ctx.json));
  return { queued: true };
});

export default cloudflare(app);
```

```jsonc
// wrangler.jsonc
{
  "name": "my-api",
  "main": "src/index.ts",
  "compatibility_date": "2025-09-15",
  "compatibility_flags": ["nodejs_compat"]
}
```

### 13b.2 Signatures

```ts
function cloudflare(router: Router): WorkerHandler;

interface WorkerHandler {
  fetch(request: Request, env: unknown, ctx: WorkerExecutionContext): Response | Promise<Response>;
}

interface WorkerExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

function getEnv<Env = Record<string, unknown>>(ctx: Context): Env;       // throws off Workers
function getExecutionContext(ctx: Context): WorkerExecutionContext;     // throws off Workers

const isWorkers: boolean;
class WorkerContext extends WebContext { readonly env: unknown; readonly executionCtx: WorkerExecutionContext }
```

- `WorkerExecutionContext` is velox's own minimal interface, so velox has no
  dependency on `@cloudflare/workers-types`. The real `ExecutionContext`
  satisfies it.
- `cloudflare(app) satisfies ExportedHandler<Env>` type-checks against
  `@cloudflare/workers-types`, including with `skipLibCheck: false`.
- `fetch` does not use `this`, so spreading works:
  `export default { ...cloudflare(app), scheduled(controller, env, ctx) { ... } } satisfies ExportedHandler<Env>`.
- `getEnv`'s type parameter is unchecked: velox cannot know which bindings the
  Worker was deployed with. Declare `Env` to match `wrangler.jsonc`.
- `getEnv` / `getExecutionContext` check `ctx instanceof WorkerContext`. On
  Bun/Node/Deno they throw `getEnv(): this request is not being served by the
  Cloudflare Workers adapter ... export default cloudflare(app)`. For code that
  runs on several runtimes, branch on `isWorkers` first.
- Handlers still receive the ordinary `Context`, typed the same as on every
  runtime. `env` was deliberately not added to `Context`, where it would exist
  (and mean nothing) on Bun, Node and Deno.
- `env` and the execution context reach state middleware, `onError`,
  `notFound` handlers and `define()` scopes, anywhere a `ctx` exists.

### 13b.3 Compatibility requirements (measured on workerd)

| Setup | Works? |
|---|---|
| wrangler + `nodejs_compat` + date ≥ `2024-09-23` | Yes |
| wrangler + `nodejs_compat` + date `2024-09-22` or earlier | No: `Could not resolve "async_hooks"` / `"fs/promises"` at bundle time |
| wrangler without `nodejs_compat` | No: `Could not resolve "async_hooks"` / `"fs"` at bundle time |
| own bundler, raw workerd, `nodejs_compat`, date ≥ `2025-09-15` | Yes |
| own bundler, raw workerd, `nodejs_compat`, date `2025-09-01` | No: `No such module "node:fs"` (or add flag `enable_nodejs_fs_module`) |

Why: velox's entry point statically imports `node:async_hooks` (ambient request
context), `node:fs`, `node:fs/promises` and `node:path` (file utilities). Wrangler
polyfills `node:fs` through unenv on older dates. Workerd provides it natively
only from `2025-09-15`.

### 13b.4 Internal behavior

- **Lazy compile.** Nothing is compiled inside `cloudflare()`. The first
  `fetch` compiles every route, and later requests reuse that compiled table.
  Two reasons: workerd rejects `new Response('body')` at module scope
  (`Disallowed operation called within global scope`), and compiling late
  means routes registered after `cloudflare(app)` but before the first request
  are still served. Routes added after the first request are **not** served.
- **Static routes build a fresh Response per request.** Bun/Deno/Node cache one
  Response for `app.get(path, value)` and `clone()` it. On workerd, a body
  created while handling one request cannot be read by another (`Cannot perform
  I/O on behalf of a different request`), so the second request got a 500. The
  Workers adapter calls `toResponse(value)` per request instead. It serializes
  JSON each time, which costs little and is required.
- **Remote info.** `ctx.remoteInfo.address` comes from `cf-connecting-ip`, which
  the Workers adapter treats as the peer address: a Worker is reached only
  through Cloudflare's edge, which sets that header itself. No `trustProxy()` is
  needed. Absent the header it is `''`; the port is always `0`.
- **WebSocket routes.** `app.ws(path)` is not served. A request to that exact
  path with `upgrade: websocket` gets `501 WebSocket routes are not supported
  on Cloudflare Workers`. Non-upgrade requests to the same path route normally.
  At first compile, one `console.warn` names how many ws routes are
  unserved. On Workers, WebSockets belong in a Durable Object.
- **Ambient request context** (`enableRequestContext()`) works: `nodejs_compat`
  provides `AsyncLocalStorage`, and it survives `await` and `setTimeout` per
  request (tested on workerd with concurrent requests).
- **`AppServer.run()` / `server()`** throw on Workers with: ``A Cloudflare Worker
  does not listen on a port, so server() and AppServer.run() cannot start one.
  Export the app instead: `export default cloudflare(app)`.``
- **Not-found.** Same executor as other runtimes (custom `notFound`,
  prefix-scoped sub-app handlers, global middleware), with `env`/`ctx`
  forwarded. Without any of them, a plain `404 Not Found` is returned.

### 13b.5 Gotchas

- Do not create a `Response` with a body at module scope and return it from a
  handler. Workers refuse the module scope one outright. A Response cached from
  one request and returned (or `clone()`d) in another fails with the
  cross-request I/O error. Build responses inside the handler.
- `sendFile`, `listDirectory`, `saveFile`: they import fine, but a Worker has no project filesystem. Serve static assets
  with Workers Static Assets, and store uploads in R2.
- `setInterval`-based features (WS heartbeat, `WsTopicHub` dead-peer sweep) do
  not apply, because ws routes are not served.
- `memoize()` caches in module memory, per isolate.
  Isolates are recycled and not shared across locations, so a cache is not
  shared state.

---

## 14. Route Introspection

```ts
const routes: Array<{ method: string; path: string }> = app.getRoutes();
app.printRoutes(); // colored table to console including WS routes
```

---

## 15. Common Patterns & Best Practices

### 15.1 Auth Guard with Type Propagation

```ts
// Define once, use everywhere
const authMiddleware = {
  auth: (ctx: Context) => {
    const token = ctx.headers.authorization;
    if (!token) throw new Response("Unauthorized", { status: 401 });
    return verifyToken(token); // returns { userId: string; role: string }
  },
};

// Use in define() for full type inference across a group
app.define(authMiddleware, (app) => {
  app.get("/profile", (ctx) => Response.json({ id: ctx.state.auth.userId }));
  app.delete("/account", (ctx) => {
    if (ctx.state.auth.role !== "admin") {
      throw new Response("Forbidden", { status: 403 });
    }
    return Response.json({ deleted: true });
  });
});
```

### 15.2 Composing Middleware

```ts
// Combine multiple built-ins
app.define(
  {
    reqId: requestId(),
    perf: timing(),
    auth: jwt({ secret: process.env.JWT_SECRET! }),
  },
  (app) => {
    app.get("/api/data", (ctx) =>
      Response.json({
        requestId: ctx.state.reqId,
        userId: ctx.state.auth.sub,
      }));
  },
);
```

### 15.3 Versioned API with Sub-Apps

```ts
const v1 = new App();
v1.get("/users", listUsersV1);
v1.onError(v1ErrorHandler);

const v2 = new App();
v2.get("/users", listUsersV2);
v2.onError(v2ErrorHandler);

app.use("/api/v1", v1);
app.use("/api/v2", v2);
```

### 15.4 CORS + Auth Pattern

```ts
const protectedApi = cors({
  origin: process.env.ALLOWED_ORIGIN!,
  credentials: true,
});

protectedApi.define(
  { auth: jwt({ secret: process.env.JWT_SECRET! }) },
  (app) => {
    app.get("/me", (ctx) => Response.json({ user: ctx.state.auth }));
  },
);

// Mount at prefix
app.use("/api", protectedApi);

// Or mount at root (no prefix needed)
app.use(protectedApi);
```

### 15.5 File Upload with Validation

```ts
app.post("/upload", {
  state: { limit: bodyLimit({ maxSize: 10_000_000 }) }, // 10 MB guard
}, async (ctx) => {
  const files = await receiveFiles(await ctx.form, {
    maxFileSize: 5_000_000,
    allowedTypes: ["image/png", "image/jpeg", "image/webp"],
    maxFiles: 5,
  });
  for (const file of files) {
    await saveFile(`./uploads/${crypto.randomUUID()}`, file.data);
  }
  return Response.json({ uploaded: files.map((f) => f.fileName) });
});
```

### 15.6 Encrypted Session Cookie

```ts
const sessionKey = generateSecretKey(); // store in env var in production

const authSession = session({
  cookieName: "_session",
  validate: async (cookieValue, ctx) => {
    try {
      const data = await decryptString(cookieValue, sessionKey);
      return JSON.parse(data) as { userId: string };
    } catch {
      throw new Response("Unauthorized", { status: 401 });
    }
  },
});

// Set session on login
app.post("/login", async (ctx) => {
  const { username, password } = await ctx.json;
  const user = await db.verifyCredentials(username, password);
  const sessionData = await encryptString(
    JSON.stringify({ userId: user.id }),
    sessionKey,
  );
  ctx.setCookie("_session", sessionData, {
    httpOnly: true,
    secure: true,
    sameSite: "Strict",
  });
  return Response.json({ ok: true });
});

// Use session
app.define({ session: authSession }, (app) => {
  app.get(
    "/profile",
    (ctx) => Response.json({ userId: ctx.state.session.userId }),
  );
});
```

### 15.7 WebSocket Chat Room

```ts
app.ws<{ username: string }>("/chat", {
  upgrade(req) {
    const url = new URL(req.url);
    const username = url.searchParams.get("name");
    if (!username) return new Response("Name required", { status: 400 });
    return { username };
  },
  open(peer) {
    peer.subscribe("room");
    peer.publish(
      "room",
      JSON.stringify({ type: "join", user: peer.data.username }),
    );
  },
  message(peer, msg) {
    peer.publish(
      "room",
      JSON.stringify({
        type: "message",
        user: peer.data.username,
        text: String(msg),
      }),
    );
  },
  close(peer) {
    peer.publish(
      "room",
      JSON.stringify({ type: "leave", user: peer.data.username }),
    );
  },
});
```

### 15.8 Server-Sent Events / Streaming

```ts
app.get("/events", () => {
  let id = 0;
  const stream = new ReadableStream({
    start(controller) {
      const timer = setInterval(() => {
        controller.enqueue(
          new TextEncoder().encode(
            `data: ${JSON.stringify({ id: id++, ts: Date.now() })}\n\n`,
          ),
        );
      }, 1000);
      // cleanup after 30s
      setTimeout(() => {
        clearInterval(timer);
        controller.close();
      }, 30_000);
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
});
```

---

## 16. Common Mistakes to Avoid

| Mistake                                                          | Fix                                                                                                     |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `app.use(cors(...))` without defining routes inside the cors App | Define routes inside: `const c = cors(); c.get(...); app.use(c)`                                        |
| `app.use(logger())` expects routes inside logger App             | Mount as global: `app.use(logger())` is correct, logger applies via `apply("/*")` internally           |
| `ctx.params.id` in query validation                              | Params come from URL path segments, not query string                                                    |
| Forgetting `await` on `ctx.json`, `ctx.text`, `ctx.form`         | These are always `Promise`; always `await` them                                                         |
| Using `generateSecretKey()` with `await`                         | It is **sync**: no `await` needed                                                                      |
| Setting cookies after `return new Response(...)`                 | Use `ctx.setCookie()` before returning; it hooks via `onFinish`                                         |
| Accessing `ctx.state.auth` before auth middleware runs           | State is populated in order; sequential middleware can read earlier state via `(ctx.state as any).auth` |
| Passing schema validators to `cors()`                            | CORS doesn't accept schema. Use `cors()` → mount with `use()`                                           |
| Using `app.apply()` with `cors()` return value                   | Wrong: `cors()` returns an App, not a middleware function                                              |
| Calling `app.run()` in a Cloudflare Worker                       | Export instead: `export default cloudflare(app)` (§13b)                                                 |
| Reading bindings via `process.env` or a global in a Worker       | Use `getEnv<Env>(ctx)`; bindings arrive per request                                                     |
| Deploying a Worker without `nodejs_compat`                       | Add `"compatibility_flags": ["nodejs_compat"]` (§13b.3)                                                 |
| Checking `isNode` to detect a server with `process`              | On Workers `isNode` is false but `process` exists; check `isWorkers` too                                |

---

## 17. TypeScript Import Reference

```ts
// Core
import { App, AppServer, HttpError, defaultErrorHandler } from "@coderbuzz/velox";
import type {
  AppServerInit,
  Context,
  ErrorHandler,
  Flatten,
  InferObject,
  InferResponse,
  InferState,
  InferValidator,
  MiddlewareHandler,
  ParamsFromPath,
  RemoteInfo,
  ResponseSchema,
  RouteInfo,
  Schema,
  Server,
  ServerOptions,
  StateMiddleware,
  TypedHandler,
  Validator,
} from "@coderbuzz/velox";

// Ambient request context
import {
  disableRequestContext,
  enableRequestContext,
  getRequestContext,
  isRequestContextEnabled,
  tryGetRequestContext,
} from "@coderbuzz/velox";

// Middleware
import {
  basicAuth,
  bearerAuth,
  bodyLimit,
  cache,
  compress,
  cors,
  csrf,
  unsafeDecodeJwtWithoutVerification,
  etag,
  ipRestriction,
  jwk,
  jwt,
  logger,
  requestId,
  secureHeaders,
  session,
  signJwt,
  timeout,
  timing,
  verifyJwt,
} from "@coderbuzz/velox";

// WebSocket (Wire Protocol lives in separate packages)
import { WsReadyState, WsTopicHub, onWsHandlerError } from "@coderbuzz/velox";
import type {
  TopicCallback,
  WsHandler,
  WsHandlerErrorHandler,
  WsMessageData,
  WsOptions,
  WsPeer,
  WsReadyStateValue,
} from "@coderbuzz/velox";

// Wire Protocol: separate packages (not in velox)
// import { encodeRequest, decode } from "@coderbuzz/velox-ws-wire";
// import { WireClient } from "@coderbuzz/velox-ws-wire-client";
// import { wireProtocol } from "@coderbuzz/velox-ws-wire-server";

// Utilities
import {
  compressString,
  decompressString,
  decryptString,
  deriveKeyFromPassphrase,
  encryptString,
  generateSalt,
  generateSecretKey,
  getMimeType,
  getPathname,
  isBun,
  isDeno,
  isNode,
  isWorkers,
  listDirectory,
  memoize,
  receiveFiles,
  saveFile,
  sendFile,
} from "@coderbuzz/velox";
import type {
  CompressOptions,      // compressString options (not the compress() middleware's)
  DecompressOptions,
  FileEntry,
  ListDirectoryOptions,
  MemoizeOptions,
  ReceiveFileOptions,
  SendFileOptions,
  UploadedFile,
} from "@coderbuzz/velox";
// Middleware option types: BasicAuthOptions, BearerAuthOptions, BodyLimitOptions,
// CacheOptions, CompressionEncoding, CorsOptions, CsrfOptions, IpRestrictionOptions,
// JWKOptions, JWK, JWKS, JWTOptions, SignJwtOptions, JWTPayload, JWTAlgorithm,
// LoggerOptions, RequestIdOptions, SecureHeadersOptions, SessionOptions,
// TimeoutOptions, TimingOptions

// Cloudflare Workers
import { cloudflare, getEnv, getExecutionContext } from "@coderbuzz/velox";
import type { WorkerHandler, WorkerExecutionContext } from "@coderbuzz/velox";

// Validation schemas (separate package, not a velox dependency)
import {
  array,
  boolean,
  coerce,
  date,
  number,
  object,
  optional,
  string,
} from "@coderbuzz/veta";
```

---

## 18. Response Helpers

Velox uses the standard Web API `Response` class throughout:

```ts
// Text
new Response("Hello");
new Response("Error", { status: 500 });

// JSON
Response.json({ key: "value" });
Response.json({ error: "Bad Request" }, { status: 400 });

// Stream
new Response(readableStream);
new Response(readableStream, {
  headers: { "Content-Type": "text/event-stream" },
});

// Redirect
new Response(null, { status: 302, headers: { Location: "/new-path" } });

// No content
new Response(null, { status: 204 });
new Response(null, { status: 304 }); // Not Modified
```

---

## 19. Deployment Checklist

```ts
// Production AppServer setup
const app = new AppServer({
  port: Number(process.env.PORT ?? 3000),
  hostname: "0.0.0.0",
});

// Global error handler
app.onError((error, ctx) => {
  console.error(ctx.method, ctx.url, error);
  return Response.json({ error: "Internal Server Error" }, { status: 500 });
});

// Global 404
app.notFound((ctx) => Response.json({ error: "Not Found" }, { status: 404 }));

// Global logger
app.use(logger());

// Security headers for all routes
app.apply("/*", { _sec: secureHeaders() });

// Graceful shutdown
const { hostname, port } = await app.run();
console.log(`Listening on ${hostname}:${port}`);

process.on("SIGTERM", async () => {
  await app.stop();
  process.exit(0);
});
process.on("SIGINT", async () => {
  await app.stop();
  process.exit(0);
});
```

---

## 20. Package Info

| Field                     | Value                                |
| ------------------------- | ------------------------------------ |
| Package                   | `@coderbuzz/velox`                     |
| Runtime dependencies      | None (`dependencies: {}`)            |
| Validation library        | Any `(val, ctx?) => T` function; examples use `@coderbuzz/veta` (install separately) |
| License                   | MIT                                  |
| Runtimes                  | Node.js, Bun, Deno, Cloudflare Workers (`nodejs_compat`) |
| Node.js high-perf adapter | `uWebSockets.js` (optional, `UWS=1`) |
| Module format             | ESM only                             |
| TypeScript                | Bundled types, no `@types` needed    |
