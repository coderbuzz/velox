<!-- docs: sync from coderbuzz/codex@b37bd48 -->

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
ctx.url          // string: full URL
ctx.method       // string: "GET", "POST", etc.
ctx.params       // parsed + validated route params
ctx.query        // parsed + validated query string
ctx.headers      // parsed + validated headers (all keys lowercase)
ctx.cookies      // parsed + validated cookies
ctx.json         // Promise<T>: parsed + validated JSON body
ctx.text         // Promise<T>: raw text body
ctx.form         // Promise<T>: parsed form data (as plain object if validated)
ctx.body         // raw body stream (runtime-specific)
ctx.state        // accumulated middleware state
ctx.remoteInfo   // { address: string; port: number }
ctx.setCookie(name, value, opts?)  // set response cookie
ctx.onFinish(cb) // register callback called after response is sent
```

**Cookie options for `setCookie`**: `path`, `domain`, `maxAge`, `expires`,
`httpOnly`, `secure`, `sameSite: 'Strict' | 'Lax' | 'None'`.

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
`HttpError(400, 'Malformed JSON body')`, in all three runtime contexts. The same
applies to an unparseable form body.

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
new HttpError(status: number, message?: string, details?: Record<string, unknown>)
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
| `timeout(options)`        | fn          | `{ signal: AbortSignal }` or `Response`             |
| `secureHeaders(options?)` | fn          | `void` (sets 13 headers via onFinish)               |
| `cache(options?)`         | fn          | `void` (sets Cache-Control via onFinish)            |
| `bodyLimit(options)`      | fn          | `void` or `Response`                                |
| `timing(options?)`        | fn          | `void` (sets Server-Timing via onFinish)            |
| `ipRestriction(options)`  | fn          | `void` or `Response`                                |
| `csrf(options?)`          | fn          | `void` or `Response`                                |

### 8.3 Body Limit Options

```ts
bodyLimit({
  maxSize: number,          // maximum body size in bytes
  onError?: (ctx) => Response,  // custom 413/411 response
})
```

**Behavior:**
- Only applies to POST, PUT, PATCH, DELETE: safe methods (GET/HEAD/OPTIONS) pass through.
- If `Content-Length` exceeds `maxSize` → 413 Payload Too Large (or `onError` response).
- If `Content-Length` is missing → 411 Length Required (or `onError` response).
- Does not read the body stream: relies on Content-Length header for efficiency.

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

```ts
basicAuth({
  username?: string,        // required if no verifyUser
  password?: string,        // required if no verifyUser
  realm?: string,           // default: 'Secure Area'
  verifyUser?: (username: string, password: string, ctx: Context) => boolean | Promise<boolean>,
})
// returns { username: string } in ctx.state
```

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
  threshold?: number,                 // declared (JSDoc default 1024) but never read
})
```
- Only negotiates: returns `{ encoding }` in state and sets `Vary`. It does not compress the body; the runtime or a proxy does.
- The middleware's `CompressOptions` type is not importable from `@coderbuzz/velox`: the root export of that name is the `compressString` options type (12.2).
- `Accept-Encoding: *` (wildcard) returns the first preferred encoding.
- Adds `Vary: Accept-Encoding` to responses via `onFinish`.

```ts
timeout({
  duration: number,          // milliseconds, must be > 0
  onTimeout?: (ctx) => Response,  // NOTE: accepted but never called
})
```
- `duration <= 0` throws `Error` at middleware creation time.
- The AbortSignal is available at `ctx.state.<key>.signal` (e.g. `ctx.state.timeoutSig.signal` for `state: { timeoutSig: timeout(...) }`).
- It does not end or replace the response: only code that listens to the signal is cancelled.
- Pass the signal to `fetch(url, { signal })` for network request cancellation.

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

`source` is `'topic dispatch'` (pub/sub fan-out) or `'message handler'` (the
Node adapter's inbound frame path).

Previously both sites were empty `catch` blocks. A handler that threw on one
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

`TopicCallback<T>` is `(peer, msg) => void`. A throwing handler in `dispatch()` is reported through `onWsHandlerError` with source `'topic dispatch'`.

### 9.5 WsOptions Defaults

```
pingInterval:       30 (seconds)
pongTimeout:        10 (seconds)
idleTimeout:        120 (seconds)
maxPayloadLength:   16_777_216 (16 MB)
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
}
```

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
import { isBun, isDeno, isNode } from "@coderbuzz/velox";
```

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
| Runtimes                  | Node.js, Bun, Deno                   |
| Node.js high-perf adapter | `uWebSockets.js` (optional, `UWS=1`) |
| Module format             | ESM only                             |
| TypeScript                | Bundled types, no `@types` needed    |
