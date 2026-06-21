import { test, expect } from "bun:test";
import { isBun, isNode, isDeno, defaultErrorHandler, App, AppServer } from "@coderbuzz/velox";

test("runtime detection", () => {
  expect(typeof isBun).toBe("boolean");
  expect(typeof isNode).toBe("boolean");
  expect(typeof isDeno).toBe("boolean");
});

test("defaultErrorHandler returns Response", () => {
  const res = defaultErrorHandler(new Error("test"));
  expect(res instanceof Response).toBe(true);
  expect(res.status).toBe(500);
});