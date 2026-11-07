import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { isSealed, openField, sealField, setFieldKey } from "../src/platform/secrets";

afterEach(() => setFieldKey(undefined));

describe("sealed fields", () => {
  it("seal the same value to the same text in a workspace, and open it again", () => {
    setFieldKey(randomBytes(32));
    const sealed = sealField("Bearer tok_123", "ws_a");
    expect(sealed).toMatch(/^kenc:v1:[0-9a-f]{8}:[A-Za-z0-9_-]+$/);
    expect(isSealed(sealed)).toBe(true);
    expect(sealed).not.toContain("tok_123");
    expect(sealField("Bearer tok_123", "ws_a")).toBe(sealed);
    expect(sealField("Bearer tok_124", "ws_a")).not.toBe(sealed);
    expect(sealField(sealed, "ws_a")).toBe(sealed);
    expect(openField(sealed, "ws_a")).toBe("Bearer tok_123");
    expect(openField("plain", "ws_a")).toBe("plain");
  });

  it("seal one value differently in each workspace, and open it only in its own", () => {
    setFieldKey(randomBytes(32));
    const sealed = sealField("Bearer tok_123", "ws_a");
    expect(sealField("Bearer tok_123", "ws_b")).not.toBe(sealed);
    expect(() => openField(sealed, "ws_b")).toThrow();
  });

  it("are kept as they are without a key, and name the key they need", () => {
    expect(sealField("Bearer tok_123", "ws_a")).toBe("Bearer tok_123");
    setFieldKey(randomBytes(32));
    const sealed = sealField("Bearer tok_123", "ws_a");
    setFieldKey(undefined);
    expect(() => openField(sealed, "ws_a")).toThrow("KAIROS_ENCRYPTION_KEY is not set");
    setFieldKey(randomBytes(32));
    expect(() => openField(sealed, "ws_a")).toThrow(
      `The value was encrypted with another KAIROS_ENCRYPTION_KEY (key ${sealed.split(":")[2]})`,
    );
  });
});
