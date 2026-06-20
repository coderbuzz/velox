<!-- docs: sync from coderbuzz/codex@cd4a13b -->

# Velox Framework — AI Expert Knowledge Reference

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

### 3.1 Validators from `@coderbuzz/veta`

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

// optional: allows undefined — omits the field from required type
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

---

## 4. Context Object (`ctx`)

All fields are lazily evaluated on first access:

```ts
ctx.url          // string — full URL
ctx.method       // string — "GET", "POST", etc.
ctx.params       // parsed + validated route params
ctx.query        // parsed + validated query string
ctx.headers      // parsed + validated headers (all keys lowercase)
ctx.cookies      // parsed + validated cookies
ctx.json         // Promise<T> — parsed + validated JSON body
ctx.text         // Promise<T> — raw text body
ctx.form         // Promise<T> — parsed form data (as plain object if validated)
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

Middleware in Ken are just functions inside the `state` key of a schema. They
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

#### `apply()` — Global or prefix-scoped

```ts
// Applies to ALL routes (pattern "/*")
app.apply("/*", { auth: (ctx) => verifyAuth(ctx) });

// Side-effect only (no state produced)
app.apply("/*", (ctx) => console.log(ctx.method, ctx.url));

// Scoped to prefix
app.apply("/api/*", { rateLimit: checkRateLimit });
```

#### `define()` — Lexically scoped with type inference

```ts
app.define(
  {
    userId: (ctx) => ctx.headers["x-user-id"] ?? "guest",
    isAdmin: (ctx) => ctx.headers["x-role"] === "admin",
  },
  (app) => {
    // TypeScript knows ctx.state.userId: string, ctx.state.isAdmin: boolean
    app.get("/me", (ctx) => Response.json({ userId: ctx.state.userId }));

    // Nested define — accumulates state
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
  // void return — not in ctx.state
};
```

---

## 6. Error Handling

### 6.1 Priority Chain

1. Route-level `onError` (highest priority)
2. App/sub-app-level `onError` (set with `app.onError(...)`)
3. Framework default (returns plain text error message, 500)

### 6.2 Throwing a Response

Throwing a `Response` **bypasses** `onError` entirely — it is sent directly:

```ts
throw new Response("Forbidden", { status: 403 });
```

If you want `onError` to receive it, wrap in `Error` or catch it yourself.

### 6.3 Route-Level onError

```ts
app.get("/path", {
  onError: (error, ctx) => {
    if (error instanceof Response) return error; // pass through thrown Responses
    return Response.json({ message: String(error) }, { status: 500 });
  },
}, handler);
```

### 6.4 App-Level onError

```ts
app.onError((error, ctx) => {
  return Response.json(
    { message: error instanceof Error ? error.message : "Server Error" },
    { status: 500 },
  );
});
```

When using `app.use()`, the sub-app's `onError` is inherited by its routes.

### 6.5 notFound

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

// WRONG — cors() and logger() return App, not a middleware function
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
| `etag(options?)`          | fn          | `string \| null` (If-None-Match value)              |
| `timeout(options)`        | fn          | `{ signal: AbortSignal }` or `Response`             |
| `secureHeaders(options?)` | fn          | `void` (sets headers via onFinish)                  |
| `cache(options?)`         | fn          | `void` (sets Cache-Control via onFinish)            |
| `bodyLimit(options)`      | fn          | `void` or `Response`                                |
| `timing(options?)`        | fn          | `void` (sets Server-Timing via onFinish)            |
| `ipRestriction(options)`  | fn          | `void` or `Response`                                |
| `csrf(options?)`          | fn          | `void` or `Response`                                |

### 8.3 JWT / JWK Options

```ts
jwt({
  secret: string,           // HMAC secret
  algorithm?: 'HS256' | 'HS384' | 'HS512',  // default: 'HS256'
  issuer?: string,          // validates iss claim
  audience?: string,        // validates aud claim
  headerName?: string,      // default: 'authorization'
  prefix?: string,          // default: 'Bearer'
  clockTolerance?: number,  // seconds, default: 0
})

jwk({
  jwksUrl?: string,         // JWKS endpoint URL
  keys?: JWK[],             // pre-loaded keys (alternative to jwksUrl)
  issuer?: string,
  audience?: string,
  headerName?: string,      // default: 'authorization'
  prefix?: string,          // default: 'Bearer'
  clockTolerance?: number,  // seconds
  cacheTtl?: number,        // ms, default: 600_000 (10 min)
})
```

### 8.4 CORS Options

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

### 8.5 Session Options

```ts
session({
  cookieName: string,
  validate: (cookieValue: string, ctx: Context) => T | Response | Promise<T | Response>,
  onUnauthorized?: (ctx: Context) => Response,  // default: 401 Unauthorized
})
```

Returns `T` on success, `Response` to short-circuit. Null/undefined triggers
`onUnauthorized`. Auto-detects sync vs async at initialization — zero overhead.

### 8.6 basicAuth Options

```ts
basicAuth({
  username?: string,        // required if no verifyUser
  password?: string,        // required if no verifyUser
  realm?: string,           // default: 'Secure Area'
  verifyUser?: (username: string, password: string, ctx: Context) => boolean | Promise<boolean>,
})
// returns { username: string } in ctx.state
```

### 8.7 bearerAuth Options

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

### 8.8 CSRF Rules

CSRF middleware **only** activates on:

- Unsafe methods: POST, PUT, PATCH, DELETE
- Form-like content types: `application/x-www-form-urlencoded`,
  `multipart/form-data`, `text/plain`

**JSON APIs are automatically exempt.** `Content-Type: application/json`
requests skip CSRF validation entirely.

---

## 9. WebSocket

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
  ping?(peer: WsPeer<DataType>, data: WsMessageData): void;
  pong?(peer: WsPeer<DataType>, data: WsMessageData): void;
  error?(peer: WsPeer<DataType>, error: Error): void;
}
```

### 9.3 WsPeer Methods

```ts
peer.send(data, compress?)     // send message
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

### 9.4 Native Pub/Sub vs WsTopicHub

Use **native pub/sub** (`peer.subscribe` / `peer.publish`) for:

- Simple broadcast within the same WebSocket route
- Bun/uWS native performance

Use **`WsTopicHub`** for:

- Cross-route publish (HTTP → WebSocket, background job → WebSocket)
- Dead peer detection (`hub.markAlive(peer)`)
- Explicit unsubscribe-all on close (`hub.unsubscribeAll(peer)`)

```ts
import { WsTopicHub } from "@coderbuzz/velox";

const hub = new WsTopicHub();
// hub.subscribe(peer, topic)
// hub.unsubscribe(peer, topic)
// hub.unsubscribeAll(peer)
// hub.publish(topic, data)
// hub.markAlive(peer)
```

### 9.5 WsOptions Defaults

```
pingInterval:       30 (seconds)
pongTimeout:        10 (seconds)
idleTimeout:        120 (seconds)
maxPayloadLength:   16_777_216 (16 MB)
backpressureLimit:  16_777_216 (16 MB)
perMessageDeflate:  false
```

---

## 10. Velox Ecosystem — Binary WebSocket Protocol

The binary Wire Protocol (formerly KBWP) was extracted from velox into separate packages to keep the core lean:

| Package | What it provides | Velox dependency? |
|---|---|---|
| `@coderbuzz/velox-ws-wire` | `encode()`, `decode()`, `encodedSize()` — pure binary framing codec | No |
| `@coderbuzz/velox-ws-wire-client` | `WireClient` — fault-tolerant WebSocket client with binary protocol | No |
| `@coderbuzz/velox-ws-wire-server` | `wireProtocol()` — server-side handler, mount via `app.use()` | Yes |

**Warning:** `WSClient`, `wsClientProtocol`, `WsClientState`, `WsDefinition`, `WsClientOptions` were removed from velox in v0.5.0. Import from the new packages instead:

```ts
// old — no longer in @coderbuzz/velox
import { WSClient, wsClientProtocol } from "@coderbuzz/velox"; // ❌

// new
import { WireClient } from "@coderbuzz/velox-ws-wire-client";
import { wireProtocol } from "@coderbuzz/velox-ws-wire-server";
```

---

## 11. File Utilities

### 11.1 sendFile

```ts
sendFile(ctx, filePath, options?): Response | Promise<Response>
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
listDirectory(ctx, dirPath, options?): Response | Promise<Response>
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
const files: UploadedFile[] = await receiveFiles(ctx, options?);
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
await saveFile(file: UploadedFile, directory: string): Promise<void>
```

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

const key = generateSecretKey(); // sync — returns base64 string
const enc = await encryptString("data", key); // AES-256-GCM, base64 output
const dec = await decryptString(enc, key);
```

LRU key caching (64 entries) avoids repeated key derivation.

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
  },
);

fn.cache; // Map — direct access
fn.clear(); // clear all entries
// Async version also has: fn.inflight (in-flight deduplication Map)
```

### 12.4 URL

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

app.use("/api", protectedApi);
```

### 15.5 File Upload with Validation

```ts
app.post("/upload", {
  state: { limit: bodyLimit({ maxSize: 10_000_000 }) }, // 10 MB guard
}, async (ctx) => {
  const files = await receiveFiles(ctx, {
    maxFileSize: 5_000_000,
    allowedTypes: ["image/png", "image/jpeg", "image/webp"],
    maxFiles: 5,
  });
  for (const file of files) {
    await saveFile(file, "./uploads");
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
| `app.use(logger())` expects routes inside logger App             | Mount as global: `app.use(logger())` is correct — logger applies via `apply("/*")` internally           |
| `ctx.params.id` in query validation                              | Params come from URL path segments, not query string                                                    |
| Forgetting `await` on `ctx.json`, `ctx.text`, `ctx.form`         | These are always `Promise`; always `await` them                                                         |
| Using `generateSecretKey()` with `await`                         | It is **sync** — no `await` needed                                                                      |
| Setting cookies after `return new Response(...)`                 | Use `ctx.setCookie()` before returning; it hooks via `onFinish`                                         |
| Accessing `ctx.state.auth` before auth middleware runs           | State is populated in order; sequential middleware can read earlier state via `(ctx.state as any).auth` |
| Passing schema validators to `cors()`                            | CORS doesn't accept schema. Use `cors()` → mount with `use()`                                           |
| Using `app.apply()` with `cors()` return value                   | Wrong — `cors()` returns an App, not a middleware function                                              |

---

## 17. TypeScript Import Reference

```ts
// Core
import { App, AppServer } from "@coderbuzz/velox";
import type {
  AppServerInit,
  Context,
  ErrorHandler,
  InferState,
  MiddlewareHandler,
  RemoteInfo,
  Schema,
  StateMiddleware,
  TypedHandler,
  Validator,
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
  decodeJwt,
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
import { WsTopicHub } from "@coderbuzz/velox";
import type {
  WsHandler,
  WsMessageData,
  WsOptions,
  WsPeer,
} from "@coderbuzz/velox";

// Wire Protocol — separate packages (not in velox)
// import { encode, decode } from "@coderbuzz/velox-ws-wire";
// import { WireClient } from "@coderbuzz/velox-ws-wire-client";
// import { wireProtocol } from "@coderbuzz/velox-ws-wire-server";

// Utilities
import {
  compressString,
  decompressString,
  decryptString,
  encryptString,
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

// Validation schemas (separate package)
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

Ken uses the standard Web API `Response` class throughout:

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
| Validation library        | `@coderbuzz/veta`                     |
| License                   | MIT                                  |
| Runtimes                  | Node.js, Bun, Deno                   |
| Node.js high-perf adapter | `uWebSockets.js` (optional, `UWS=1`) |
| Module format             | ESM only                             |
| TypeScript                | Bundled types, no `@types` needed    |
