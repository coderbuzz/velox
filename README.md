<!-- docs: sync from coderbuzz/codex@8a99d5c -->

# Velox &mdash; `@coderbuzz/velox`

> **#1 fastest TypeScript HTTP framework — faster than Elysia, Hono, and Express across every benchmark.** Runtime-agnostic with full type safety.
> AI agents: see [AI_KNOWLEDGE.md](https://github.com/coderbuzz/velox/blob/main/AI_KNOWLEDGE.md) for expert context.

Velox is the fastest TypeScript HTTP framework on Bun, topping the charts at **269K req/s** for simple GET and **119K req/s** for validation POST — outperforming Elysia, Hono, and Express on every benchmark. Runtime-agnostic (Node.js, Deno, Bun) with full type inference, schema validation via `@coderbuzz/veta`, built-in WebSocket with pub/sub, and 16+ production middleware — all in one framework.

---

## Why Velox over Elysia, Hono, or Express?

| Pain Point | Elysia | Hono | Express | **Velox** |
|---|---|---|---|---|
| Performance (simple GET) | ~262K req/sec | ~170K req/sec | ~100K req/sec | **~269K req/sec** on Bun (winner) |
| Schema validation | TypeBox (heavy, complex) | Zod (no coercion) | Manual | **Veta** — <5 KB gzip, coercion built-in |
| Type inference through middleware | Good | Partial | None | **Full** — `define()` scopes typed state |
| WebSocket | Bun-only | Partial | Via socket.io | **Built-in** with pub/sub, binary protocol, client SDK |
| Runtime support | Bun, Node, Deno | Bun, Node, Deno, Workers | Node only | Bun, Node (**+uWebSockets.js**), Deno |
| Built-in middleware | Limited | Via third-party | Via third-party | **16+** — JWT, CORS, sessions, CSRF, rate limiting, secure headers, etc. |
| File utilities | Limited | None | Via middleware | **Built-in** — sendFile, receiveFiles, listDirectory, MIME detection |
| Encrypted cookies | Not built-in | Not built-in | Not built-in | **Built-in** AES-GCM encryption utilities |
| Binary WebSocket protocol | No | No | No | **Wire Protocol** (`@coderbuzz/velox-ws-wire`) — 80-93% bandwidth reduction over JSON |

---

## Benchmarks

Full benchmark results at **[github.com/coderbuzz/benchmarks](https://github.com/coderbuzz/benchmarks)**.

Velox on Bun (Apple M-series, oha `-c 100 -z 10s`):

| Scenario | Requests/sec |
|---|---|
| Simple GET (inline JSON) | **~269K req/s** |
| Validation POST (veta schema) | **~119K req/s** |

Comparative numbers (simple GET, Bun):
- **@coderbuzz/velox**: **269,388 req/s** (winner)
- **Elysia**: 262,685 req/s (1.026x factor)
- **Hono**: 170,044 req/s (1.58x factor)
- **Express**: 100,762 req/s (2.67x factor)

Validation POST (veta schema):
- **@coderbuzz/velox**: **119,058 req/s** (winner)
- **Elysia**: 94,776 req/s (1.26x factor)
- **Hono**: 74,657 req/s (1.60x factor)
- **Express**: 48,652 req/s (2.45x factor)

> Run benchmarks yourself: `git clone https://github.com/coderbuzz/benchmarks && cd benchmarks && bash packages/velox/static-value/run.sh`

---

## Key Features

- **Runtime Agnostic** — Bun, Deno, Node.js (with optional uWebSockets.js for max perf)
- **TypeScript Native** — Full type inference through routes, middleware, and schemas
- **Schema Validation** — Validate params, query, headers, cookies, body with `@coderbuzz/veta` inline schemas
- **Built-in Middleware** — JWT, JWK/JWKS, CORS, sessions, compression, rate limiting, secure headers, CSRF, ETag, IP restriction, and more
- **WebSocket** — Real-time connections with pub/sub, ping/pong, binary protocol, typed upgrade data
- **Performance-Driven** — Minimal overhead, engineered for high throughput
- **Modular & Extensible** — Sub-apps, scoped middleware via `define()`, global middleware via `apply()`
- **Ecosystem** — `@coderbuzz/velox-ws-wire*` for binary WebSocket protocol with 80-93% bandwidth reduction, fault-tolerant client, and server-side handler

---

## Installation

```sh
# Bun
bun add @coderbuzz/velox

# npm
npm install @coderbuzz/velox

# Deno
import { AppServer } from "npm:@coderbuzz/velox";
```

> **Node.js**: The package ships as ESM. Your project must have
> `"type": "module"` in `package.json`, or use the `.mjs` extension. Node.js 18+
> required. For TypeScript, use [tsx](https://tsx.is) or `tsc`.

---

## Quick Start

```ts
import { AppServer } from "@coderbuzz/velox";

const app = new AppServer({ port: 3000 });

app.get("/", "Hello, Velox!");

const { hostname, port } = await app.run();
console.log(`Listening on ${hostname}:${port}`);
```

That's it. A full HTTP server in 6 lines. Now let's build something real.

---

## App vs AppServer

| Class | Purpose |
|---|---|
| `App` | Pure router — no server lifecycle. Used for sub-apps and modular composition. |
| `AppServer` | `App` + `run()` / `stop()`. The entry point for a server process. |

```ts
import { App, AppServer } from "@coderbuzz/velox";

const app = new AppServer({ port: 3000, hostname: "0.0.0.0" });

const api = new App();
api.get("/users", handler);
app.use("/api/v1", api);

await app.run();
```

---

## Routing

### Static Routes

```ts
app.get("/", "Hello Velox!"); // string → text/plain
app.get("/health", "OK");
app.get("/version", { version: "1.0.0" }); // object → JSON-serialized
```

### Dynamic Params

```ts
app.get("/users/:id", (ctx) => new Response(`User ${ctx.params.id}`));

app.get(
  "/posts/:postId/comments/:commentId",
  (ctx) =>
    new Response(`Post ${ctx.params.postId}, Comment ${ctx.params.commentId}`),
);
```

### Optional Params & Wildcards

```ts
app.get(
  "/optional/:id?",
  (ctx) => new Response(`ID: ${ctx.params.id ?? "none"}`),
);

app.get("/files/*", (ctx) => new Response(`File: ${ctx.params["*"]}`));
```

### HTTP Methods

```ts
app.get("/items", handler);
app.post("/items", handler);
app.put("/items/:id", handler);
app.patch("/items/:id", handler);
app.delete("/items/:id", handler);
app.head("/items", handler);
app.options("/items", handler);
```

### Route Introspection

```ts
const routes = app.getRoutes(); // RouteInfo[] — { method, path }[]
app.printRoutes();
// ┌──────────┬────────────────────┐
// │  Method  │ Path               │
// ├──────────┼────────────────────┤
// │  GET     │ /                  │
// │  POST    │ /users             │
// │  WS      │ /chat              │
// └──────────┴────────────────────┘
```

---

## Schema Validation

Validate request data inline via the schema object. Uses
[`@coderbuzz/veta`](https://www.npmjs.com/package/@coderbuzz/veta) — faster and
lighter than TypeBox with built-in coercion.

```ts
import {
  boolean,
  coerce,
  date,
  number,
  object,
  optional,
  string,
} from "@coderbuzz/veta";
```

### Params

```ts
app.get("/products/:id", {
  params: { id: coerce(number()) },
}, (ctx) => Response.json({ productId: ctx.params.id }));
// ctx.params.id is typed as number
```

### Query

```ts
app.get("/search", {
  query: {
    q: string({ min: 1 }),
    page: coerce(number({ min: 1, max: 100 })),
    limit: optional(coerce(number({ min: 10, max: 100 }))),
  },
}, (ctx) => Response.json({ search: ctx.query.q, page: ctx.query.page }));
```

### Headers

```ts
app.get("/api/resource", {
  headers: { "x-api-key": string({ min: 10 }) },
}, (ctx) => Response.json({ key: ctx.headers["x-api-key"] }));
```

### Cookies

```ts
app.get(
  "/api/profile",
  {
    cookies: {
      sessionId: string({ min: 5 }),
      premium: optional(coerce(boolean())),
    },
  },
  (ctx) =>
    Response.json({ session: ctx.cookies.sessionId, isPremium: ctx.cookies.premium }),
);
```

### JSON Body

```ts
app.post("/api/users", {
  json: object({
    name: string({ min: 2 }),
    age: number({ min: 18 }),
    active: boolean(),
    email: optional(string()),
  }),
}, async (ctx) => {
  const body = await ctx.json;
  return Response.json({ name: body.name, age: body.age });
});
```

### Text Body

```ts
app.post("/api/echo", {
  text: string({ min: 5 }),
}, async (ctx) => new Response(await ctx.text));
```

### Form Body

```ts
app.post("/api/submit", {
  form: { field: string({ min: 3 }) },
}, async (ctx) => {
  const data = await ctx.form;
  return new Response(data.field);
});
```

### Date Validation

```ts
app.post("/api/register", {
  json: object({
    born: coerce(
      date({ min: new Date("1900-01-01"), max: new Date("2025-12-31") }),
    ),
  }),
}, async (ctx) => {
  const { born } = await ctx.json;
  return Response.json({ born: born.toISOString() });
});
```

---

## Middleware & State

Middleware runs before the handler and returns typed state accessible via `ctx.state`.

### Per-Route State

```ts
app.get("/protected", {
  state: {
    auth: (ctx) => {
      const token = ctx.headers["authorization"];
      if (token !== "Bearer valid-token") {
        throw new Response("Unauthorized", { status: 401 });
      }
      return { userId: "user123", role: "admin" };
    },
  },
}, (ctx) => Response.json({ user: ctx.state.auth.userId }));
```

### `define()` — Scoped Middleware with Full Type Inference

Apply middleware to a group of routes. Routes inside the callback automatically
inherit the state type:

```ts
app.define(
  {
    userId: (ctx) => ctx.headers["x-user-id"] || "guest",
    isAdmin: (ctx) => ctx.headers["x-role"] === "admin",
  },
  (app) => {
    app.get("/me", (ctx) =>
      Response.json({ userId: ctx.state.userId, isAdmin: ctx.state.isAdmin })
    );
    app.get("/dashboard", (ctx) => {
      if (!ctx.state.isAdmin) throw new Response("Forbidden", { status: 403 });
      return Response.json({ admin: true });
    });
  },
);
```

`define()` can be nested for layered composition:

```ts
app.define({ requestId: () => crypto.randomUUID() }, (app) => {
  app.define({ timestamp: () => Date.now() }, (app) => {
    app.get("/meta", (ctx) =>
      Response.json({ id: ctx.state.requestId, ts: ctx.state.timestamp }));
  });
});
```

### `apply()` — Global Middleware

```ts
// Side-effect middleware (logging, metrics) — no state produced
app.apply("/*", (ctx) => { console.log(ctx.method, ctx.url); });

// State-producing middleware
app.apply("/*", { auth: (ctx) => verifyAuth(ctx) });

// Scoped to a prefix
app.apply("/api/*", { apiVersion: () => "v1" });
```

### `use()` — Mount Sub-Apps

```ts
const api = new App();
api.get("/users", handler);
api.get("/posts", handler);

app.use("/api/v1", api);
app.use(api); // without prefix — routes merged at root
```

---

## Built-in Middleware (16+)

### Authentication

| Middleware | Description | Example usage |
|---|---|---|
| `jwt()` | JWT verification with HS256/HS384/HS512, claims validation | `state: { auth: jwt({ secret, issuer, audience }) }` |
| `jwk()` | JWK/JWKS (RSA, ECDSA) — Auth0, Cognito, custom | `state: { auth: jwk({ jwksUrl, issuer }) }` |
| `basicAuth()` | HTTP Basic auth with static or custom verification | `state: { auth: basicAuth({ username, password }) }` |
| `bearerAuth()` | Bearer token auth with single/multiple/verified tokens | `state: { auth: bearerAuth({ token: [...] }) }` |
| `session()` | Cookie-based session with custom validation | `state: { session: session({ cookieName, validate }) }` |

### Security

| Middleware | Description |
|---|---|
| `cors()` | CORS with dynamic origin resolver, custom headers, credentials |
| `csrf()` | CSRF protection for form endpoints (skips JSON API) |
| `secureHeaders()` | Helmet-inspired security headers (15+ headers) |
| `ipRestriction()` | Allow/deny list by IP address |

### Performance & Observability

| Middleware | Description |
|---|---|
| `compress()` | Content-encoding negotiation (gzip, deflate, br) |
| `cache()` | Cache-Control headers (CDN-friendly) |
| `etag()` | ETag generation and If-None-Match handling |
| `timing()` | Server-Timing header |
| `timeout()` | Request timeout with AbortSignal |

### Request Handling

| Middleware | Description |
|---|---|
| `bodyLimit()` | Limit request body size |
| `requestId()` | X-Request-Id header generation |
| `logger()` | Request logging with customizable format |

### CORS

```ts
import { cors } from "@coderbuzz/velox";

const apiCors = cors({ origin: "https://example.com", credentials: true });
apiCors.get("/data", () => Response.json({ data: 1 }));
app.use("/api", apiCors);

// Dynamic origin
const dynamicCors = cors({
  origin: (requestOrigin, ctx) => {
    const allowed = ["https://app.example.com", "https://admin.example.com"];
    return allowed.includes(requestOrigin) ? requestOrigin : allowed[0];
  },
});
```

### JWT

```ts
import { decodeJwt, jwt, signJwt, verifyJwt } from "@coderbuzz/velox";

// Sign
app.get("/token", async () => {
  const token = await signJwt(
    { sub: "user123", iss: "my-app", aud: "my-api", exp: Math.floor(Date.now() / 1000) + 3600 },
    "secret",
    "HS256",
  );
  return Response.json({ token });
});

// Protect
app.get("/secure", {
  state: { auth: jwt({ secret: "secret", issuer: "my-app", audience: "my-api" }) },
}, (ctx) => Response.json({ payload: ctx.state.auth }));
```

### Session

```ts
import { session } from "@coderbuzz/velox";

const userSession = session({
  cookieName: "_sid",
  validate: (cookieValue) => {
    const user = db.getUser(cookieValue);
    if (!user?.active) throw new Response("Unauthorized", { status: 401 });
    return user;
  },
});

app.get("/dashboard", {
  state: { session: userSession },
}, (ctx) => Response.json({ user: ctx.state.session }));
```

### Secure Headers

```ts
import { secureHeaders } from "@coderbuzz/velox";

// Helmet-inspired defaults
app.define({ sec: secureHeaders() }, (app) => {
  app.get("/", () => new Response("secure"));
});

// Custom
app.get("/page", {
  state: {
    sec: secureHeaders({
      xFrameOptions: "DENY",
      contentSecurityPolicy: "default-src 'self'",
    }),
  },
}, () => new Response("secure"));
```

### Logger

```ts
import { logger } from "@coderbuzz/velox";

app.use(logger());

// Custom format
app.use(logger({
  format: ({ method, url, status, duration }) =>
    `[${new Date().toISOString()}] ${method} ${url} → ${status} (${duration}ms)`,
}));
```

### Combining Middleware

```ts
import { cache, requestId, secureHeaders, timing } from "@coderbuzz/velox";

app.get("/combined", {
  state: {
    reqId: requestId(),
    perf: timing(),
    sec: secureHeaders(),
    caching: cache({ maxAge: 3600, public: true }),
  },
}, (ctx) => Response.json({ id: ctx.state.reqId }));
```

---

## WebSocket

### Basic Echo

```ts
app.ws("/echo", {
  message(peer, message) { peer.send(message); },
});
```

### With Pub/Sub

```ts
app.ws("/chat", {
  open(peer) {
    peer.subscribe("chat");
    peer.publish("chat", "someone joined");
  },
  message(peer, message) {
    peer.publish("chat", message); // broadcast to all except sender
    peer.send(`you: ${message}`); // echo to sender
  },
  close(peer) {
    peer.unsubscribe("chat");
    peer.publish("chat", "someone left");
  },
});
```

### Typed Upgrade Data

```ts
app.ws<{ userId: string }>("/auth", {
  upgrade(req) {
    const url = new URL(req.url);
    const userId = url.searchParams.get("userId");
    if (!userId) return new Response("Unauthorized", { status: 401 });
    return { userId }; // becomes peer.data
  },
  open(peer) { peer.send(`Hello ${peer.data.userId}`); },
  message(peer, message) { peer.send(`${peer.data.userId}: ${message}`); },
});
```

### WsTopicHub (Cross-Topic Broadcast)

```ts
import { WsTopicHub } from "@coderbuzz/velox";

const hub = new WsTopicHub();

app.ws("/notifications", {
  open(peer) { hub.subscribe(peer, "alerts"); },
  close(peer) { hub.unsubscribeAll(peer); },
});

// Broadcast from any route
app.post("/broadcast", async (ctx) => {
  const { message } = await ctx.json;
  hub.publish("alerts", message);
  return Response.json({ sent: true });
});
```

### WsOptions

| Option | Type | Default | Description |
|---|---|---|---|
| `maxPayloadLength` | `number` | `16_777_216` | Max message size in bytes (16 MB) |
| `backpressureLimit` | `number` | `16_777_216` | Max send buffer size (16 MB) |
| `pingInterval` | `number` | `30` | Seconds between server ping frames |
| `pongTimeout` | `number` | `10` | Seconds to wait for pong before closing |
| `perMessageDeflate` | `boolean` | `false` | Enable per-message compression |
| `idleTimeout` | `number` | `120` | Seconds before idle connections are closed |

---

## Velox Ecosystem

Velox is the HTTP framework core. Binary WebSocket protocol utilities live in separate packages to keep velox lean:

| Package | Description | Requires Velox? |
|---|---|---|
| `@coderbuzz/velox-ws-wire` | Binary Wire Protocol codec — 80-93% bandwidth reduction over JSON | No |
| `@coderbuzz/velox-ws-wire-client` | Fault-tolerant WebSocket client with auto-reconnect, heartbeat, pub/sub, request-response | No |
| `@coderbuzz/velox-ws-wire-server` | Server-side Wire Protocol handler — mount via `app.use("/ws", wireProtocol({...}))` | Yes |

```ts
// Server — mount binary protocol handler
import { wireProtocol } from "@coderbuzz/velox-ws-wire-server";

app.use("/ws", wireProtocol({
  message(peer, msg) { peer.send(`echo: ${msg}`); },
}));

// Client — standalone, not from velox
import { WireClient } from "@coderbuzz/velox-ws-wire-client";

const client = new WireClient("wss://api.example.com/ws", {
  heartbeatInterval: 30_000,
});
await client.connect();
client.send("hello");
await client.close();
```

---

## Error Handling

```ts
// App-level error handler
app.onError((error, ctx) => {
  console.error(ctx.method, ctx.url, error);
  return Response.json(
    { message: error instanceof Error ? error.message : "Internal Server Error" },
    { status: 500 },
  );
});

// Custom 404
app.notFound((ctx) => {
  return Response.json({ error: "Not Found", path: ctx.url }, { status: 404 });
});

// Route-level onError — takes priority
app.get("/validate", {
  onError: (error, ctx) => Response.json({ custom: true, message: String(error) }, { status: 422 }),
}, () => { throw new Error("validation failed"); });

// Throw a Response to short-circuit
app.get("/secret", () => { throw new Response("Forbidden", { status: 403 }); });
```

---

## Streaming Response

```ts
app.get("/stream", () => {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("chunk 1"));
      controller.enqueue(new TextEncoder().encode("chunk 2"));
      controller.close();
    },
  });
  return new Response(stream);
});
```

---

## File Utilities

### Serve a File

```ts
import { sendFile } from "@coderbuzz/velox";

app.get("/download/:name", (ctx) =>
  sendFile(ctx, `./uploads/${ctx.params.name}`, {
    download: true,
    cacheControl: "public, max-age=3600",
    reqHeaders: ctx.headers, // enables ETag/Range/If-Modified-Since
  }),
);
```

`sendFile` supports ETag, Range requests (→ 206 Partial Content), and
Last-Modified. On Bun, uses `Bun.file()` for zero-copy sendfile.

### Receive Uploads

```ts
import { receiveFiles, saveFile } from "@coderbuzz/velox";

app.post("/upload", async (ctx) => {
  const files = await receiveFiles(ctx, {
    maxFileSize: 5_000_000,
    maxFiles: 10,
    allowedTypes: ["image/png", "image/jpeg"],
  });
  for (const file of files) {
    await saveFile(file, "./uploads");
  }
  return Response.json({ count: files.length });
});
```

### List Directory

```ts
import { listDirectory } from "@coderbuzz/velox";

app.get("/files", async (ctx) =>
  listDirectory(ctx, "./uploads", { recursive: true, stats: true })
);
```

---

## Utilities

### Encryption (AES-GCM)

```ts
import { generateSecretKey, encryptString, decryptString } from "@coderbuzz/velox";

const key = generateSecretKey(); // base64 256-bit key
const encrypted = await encryptString("hello world", key);
const original = await decryptString(encrypted, key);
```

### Compression

```ts
import { compressString, decompressString } from "@coderbuzz/velox";

const compressed = await compressString("large text payload...");
const original = await decompressString(compressed);
```

### Memoization

```ts
import { memoize } from "@coderbuzz/velox";

const fetchUser = memoize(
  async (id: string) => db.users.findById(id),
  { ttl: 30_000, maxSize: 500 },
);
```

### Runtime Detection

```ts
import { isBun, isDeno, isNode } from "@coderbuzz/velox";
if (isBun) console.log("Running on Bun");
```

---

## Context API Reference

| Property | Type | Description |
|---|---|---|
| `ctx.url` | `string` | Full request URL |
| `ctx.method` | `string` | HTTP method |
| `ctx.params` | `Record<string, string>` (or typed) | Route params |
| `ctx.query` | `Record<string, string>` (or typed) | Query string |
| `ctx.headers` | `Record<string, string>` (or typed) | Request headers (lowercase) |
| `ctx.cookies` | `Record<string, string>` (or typed) | Request cookies |
| `ctx.json` | `Promise<any>` (or typed) | Parsed JSON body |
| `ctx.text` | `Promise<string>` (or typed) | Raw text body |
| `ctx.form` | `Promise<FormData>` (or typed) | Form data body |
| `ctx.body` | `any` | Raw body stream |
| `ctx.state` | typed | Middleware state |
| `ctx.remoteInfo` | `{ address: string; port: number }` | Client IP and port |
| `ctx.setCookie(name, value, opts?)` | `void` | Set a response cookie |
| `ctx.onFinish(cb)` | `void` | Post-response callback |

---

## Node.js Performance Tip

Install uWebSockets.js for maximum throughput on Node.js:

```sh
npm install uWebSockets.js
UWS=1 node --import tsx/esm server.ts
```

---

## License

MIT © 2026 Indra Gunawan
