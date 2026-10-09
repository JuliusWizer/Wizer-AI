import { describe, expect, it } from "vitest";
import { decodeProfileImage } from "./auth/avatar";

describe("profile avatar validation", () => {
  it("accepts a small supported image data URL", () => {
    const result = decodeProfileImage("data:image/png;base64,aGVsbG8=");
    expect(result.contentType).toBe("image/png");
    expect(result.extension).toBe("png");
    expect(result.buffer.toString()).toBe("hello");
  });

  it("rejects unsupported data URLs", () => {
    expect(() => decodeProfileImage("data:image/svg+xml;base64,PHN2Zy8+"))
      .toThrow("PNG, JPG, or WebP");
  });
});
