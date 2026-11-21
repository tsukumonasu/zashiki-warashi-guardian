import { afterEach, describe, expect, it, vi } from "vitest";
import { registerServiceWorker } from "../src/lib/sw-register";

function installFakeServiceWorker(register: () => Promise<unknown>) {
  const postMessage = vi.fn();
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: { register, ready: Promise.resolve({ active: { postMessage } }) },
  });
  return postMessage;
}

afterEach(() => {
  Reflect.deleteProperty(navigator, "serviceWorker");
  vi.unstubAllGlobals();
});

describe("registerServiceWorker", () => {
  it("does nothing on a plain http host", () => {
    const register = vi.fn(async () => ({}));
    installFakeServiceWorker(register);
    vi.stubGlobal("location", { protocol: "http:", hostname: "example.test" });
    registerServiceWorker();
    expect(register).not.toHaveBeenCalled();
  });

  it("registers on localhost and posts the loaded URLs", async () => {
    const register = vi.fn(async () => ({}));
    const postMessage = installFakeServiceWorker(register);
    vi.stubGlobal("location", { protocol: "http:", hostname: "localhost" });
    Object.defineProperty(document, "readyState", { configurable: true, value: "complete" });
    registerServiceWorker();
    await vi.waitFor(() => expect(postMessage).toHaveBeenCalled());
    expect(register).toHaveBeenCalledWith("/sw.js");
    expect(postMessage.mock.calls[0]?.[0]).toMatchObject({ type: "cache-urls" });
  });

  it("ignores a registration failure", async () => {
    installFakeServiceWorker(async () => {
      throw new Error("blocked");
    });
    vi.stubGlobal("location", { protocol: "https:", hostname: "example.test" });
    Object.defineProperty(document, "readyState", { configurable: true, value: "complete" });
    expect(() => registerServiceWorker()).not.toThrow();
    await Promise.resolve();
  });
});
