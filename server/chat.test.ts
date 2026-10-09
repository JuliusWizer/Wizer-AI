import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeLLMMock, notifyOwnerMock } = vi.hoisted(() => ({
  invokeLLMMock: vi.fn(),
  notifyOwnerMock: vi.fn(),
}));

vi.mock("./_core/llm", () => ({
  invokeLLM: invokeLLMMock,
}));

vi.mock("./_core/notification", () => ({
  notifyOwner: notifyOwnerMock,
}));

import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";

function createContext(): TrpcContext {
  return {
    user: undefined,
    req: {} as TrpcContext["req"],
    res: {} as TrpcContext["res"],
  };
}

describe("chat.send", () => {
  beforeEach(() => {
    invokeLLMMock.mockReset();
    notifyOwnerMock.mockReset();
    invokeLLMMock.mockResolvedValue({
      choices: [{ message: { content: "Python is a programming language." } }],
    });
    notifyOwnerMock.mockResolvedValue(true);
  });

  it("returns the model response and forwards the current conversation", async () => {
    const caller = appRouter.createCaller(createContext());
    const result = await caller.chat.send({
      message: "Who created it?",
      language: "sw",
      history: [
        { role: "user", content: "What is Python?" },
        { role: "assistant", content: "Python is a programming language." },
      ],
    });

    expect(result).toEqual({ response: "Python is a programming language." });
    expect(invokeLLMMock).toHaveBeenCalledOnce();
    expect(invokeLLMMock.mock.calls[0][0].messages).toEqual([
      expect.objectContaining({ role: "system", content: expect.stringContaining("Swahili") }),
      { role: "user", content: "What is Python?" },
      { role: "assistant", content: "Python is a programming language." },
      { role: "user", content: "Who created it?" },
    ]);
  });

  it("rejects empty messages before calling the model", async () => {
    const caller = appRouter.createCaller(createContext());

    await expect(caller.chat.send({ message: "   ", history: [] })).rejects.toThrow();
    expect(invokeLLMMock).not.toHaveBeenCalled();
  });

  it("notifies the project owner when the model fails", async () => {
    invokeLLMMock.mockRejectedValueOnce(new Error("provider unavailable"));
    const caller = appRouter.createCaller(createContext());

    await expect(caller.chat.send({ message: "Please answer this", history: [] })).rejects.toThrow("provider unavailable");
    expect(notifyOwnerMock).toHaveBeenCalledWith(expect.objectContaining({
      title: "Wizer AI conversation failed",
      content: expect.stringContaining("provider unavailable"),
    }));
  });
});
