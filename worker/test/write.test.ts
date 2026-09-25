import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { upsertIfChanged } from "../src/write";

describe("upsertIfChanged", () => {
  it("rejects a column placed in two groups", () => {
    expect(() =>
      upsertIfChanged(env.DB, "t", {
        key: { id: "a" },
        insertOnly: { id: "b" },
        content: { v: 1 },
      }),
    ).toThrow(/two groups/);
  });

  it("rejects a row with nothing to compare", () => {
    expect(() => upsertIfChanged(env.DB, "t", { key: { id: "a" }, content: {} })).toThrow(
      /no content/,
    );
  });

  it("rejects a name that is not a plain identifier", () => {
    const content = { "v = 1; DROP TABLE t; --": 1 };
    expect(() => upsertIfChanged(env.DB, "t", { key: { id: "a" }, content })).toThrow(
      /identifiers/,
    );
  });
});
