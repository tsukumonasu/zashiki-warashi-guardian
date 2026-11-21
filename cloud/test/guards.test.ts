// Proves the test guards of task 2.2 (R26.2, R26.3, R26.5).
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { describe, expect, it } from "vitest";
import { describeIntegration, integrationEnabled, selectDescribe } from "./integration.js";
import { isLoopbackHost, takeViolations } from "./network-guard.js";

describe("network guard (R26.3)", () => {
  it("fails net.connect with the host name", () => {
    expect(() => net.connect({ host: "broker.example.invalid", port: 8883 })).toThrow(
      /broker\.example\.invalid:8883/,
    );
    takeViolations();
  });

  it("fails tls.connect with the host name", () => {
    expect(() => tls.connect({ host: "iot.example.invalid", port: 8883 })).toThrow(
      /iot\.example\.invalid/,
    );
    takeViolations();
  });

  it("fails https.request and http.get with the host name", () => {
    expect(() => https.request("https://rekognition.example.invalid/x")).toThrow(
      /rekognition\.example\.invalid/,
    );
    expect(() => http.get({ hostname: "plain.example.invalid" })).toThrow(/plain\.example\.invalid/);
    takeViolations();
  });

  it("records the attempt so a swallowed error still fails the test", () => {
    try {
      net.connect({ host: "swallowed.example.invalid", port: 1 });
    } catch {
      // Code under test could do this; the afterEach hook would catch it.
    }
    expect(takeViolations()).toEqual(["swallowed.example.invalid:1"]);
  });

  it("allows loopback connections", async () => {
    const server = net.createServer((s) => s.end("ok"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as net.AddressInfo;
    const data = await new Promise<string>((resolve, reject) => {
      const c = net.connect({ host: "127.0.0.1", port });
      let buf = "";
      c.on("data", (d) => (buf += d.toString()));
      c.on("end", () => resolve(buf));
      c.on("error", reject);
    });
    server.close();
    expect(data).toBe("ok");
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("example.com")).toBe(false);
  });
});

describe("integration switch (R26.5)", () => {
  it("is off without WARASHI_AWS_INTEGRATION=1", () => {
    expect(integrationEnabled({})).toBe(false);
    expect(integrationEnabled({ WARASHI_AWS_INTEGRATION: "0" })).toBe(false);
    expect(selectDescribe({})).not.toBe(describe);
  });

  it("is on with WARASHI_AWS_INTEGRATION=1", () => {
    expect(integrationEnabled({ WARASHI_AWS_INTEGRATION: "1" })).toBe(true);
    expect(selectDescribe({ WARASHI_AWS_INTEGRATION: "1" })).toBe(describe);
  });
});

// Reported as skipped by `make test`; this is the only kind of skip the suite allows.
describeIntegration("integration helper smoke (needs WARASHI_AWS_INTEGRATION=1)", () => {
  it("runs only when opted in", () => {
    expect(integrationEnabled()).toBe(true);
  });
});
