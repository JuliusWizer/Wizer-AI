import { describe, expect, it, vi } from "vitest";

const { streamLLMMock } = vi.hoisted(() => ({ streamLLMMock: vi.fn() }));

vi.mock("./_core/llm", () => ({ streamLLM: streamLLMMock }));
vi.mock("./_core/context", () => ({ createContext: vi.fn(async ({ req, res }) => ({ req, res, user: null })) }));
vi.mock("./_core/notification", () => ({ notifyOwner: vi.fn(async () => true) }));

import { registerChatStream } from "./chatStream";

function createResponse() {
  const chunks: string[] = [];
  return {
    chunks,
    status: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    flushHeaders: vi.fn(),
    on: vi.fn(),
    write: vi.fn((chunk: string) => { chunks.push(chunk); return true; }),
    end: vi.fn(),
    get writableEnded() { return false; },
  } as never;
}

describe("chat streaming endpoint", () => {
  it("emits incremental delta events and a completion event", async () => {
    streamLLMMock.mockImplementationOnce(async (_params: unknown, onText: (text: string) => void) => {
      onText("Hello ");
      onText("world.");
      return "Hello world.";
    });
    const response = createResponse();
    const req = { body: { message: "Say hello", history: [], language: "en" }, on: vi.fn() } as never;

    await registerChatStream(req, response);

    expect(response.chunks.join("")).toContain('"type":"delta","text":"Hello "');
    expect(response.chunks.join("")).toContain('"type":"delta","text":"world."');
    expect(response.chunks.join("")).toContain('"type":"done"');
    expect(response.end).toHaveBeenCalledOnce();
  });
});
