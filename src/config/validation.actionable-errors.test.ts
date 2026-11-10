// Verifies invalid config errors name the setting path and reason without echoing values.
import JSON5 from "json5";
import { describe, expect, it } from "vitest";
import { renderConfigValidationIssueLines } from "./issue-location.js";
import type { ConfigFileSnapshot, ConfigValidationIssue } from "./types.js";
import { validateConfigObjectWithPlugins } from "./validation.js";

function validate(raw: unknown) {
  return validateConfigObjectWithPlugins(raw, { pluginValidation: "skip" });
}

function renderedText(raw: unknown, issues: readonly ConfigValidationIssue[]): string {
  const snapshot = {
    issues,
    raw: JSON5.stringify(raw),
    parsed: raw,
    sourceConfig: raw as ConfigFileSnapshot["sourceConfig"],
    path: "/tmp/openclaw.json",
  };
  return renderConfigValidationIssueLines(snapshot).join("\n");
}

describe("config validation actionable errors", () => {
  it("names the path and reason for an invalid nested entry", () => {
    const raw = { gateway: { port: "not-a-port" } };
    const result = validate(raw);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.issues).toContainEqual(
      expect.objectContaining({ path: "gateway.port", message: expect.stringMatching(/number/) }),
    );
    const text = renderedText(raw, result.issues);
    expect(text).toContain("gateway.port");
    expect(text).not.toContain("not-a-port");
  });

  it("reports every invalid entry without echoing values", () => {
    const raw = { gateway: { port: "not-a-port", bind: "bogus-mode" } };
    const result = validate(raw);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    const paths = result.issues.map((issue) => issue.path);
    expect(paths).toContain("gateway.port");
    expect(paths).toContain("gateway.bind");
    const text = renderedText(raw, result.issues);
    expect(text).toContain("gateway.port");
    expect(text).toContain("gateway.bind");
    expect(text).not.toContain("not-a-port");
    expect(text).not.toContain("bogus-mode");
  });

  it("never echoes secret-bearing values", () => {
    const secretRef = "sk-live-secret-ref-value";
    const raw = {
      agents: {
        ownership: "explicit",
        entries: { main: {}, runner: { modelPolicy: { allow: [secretRef] } } },
      },
    };
    const result = validate(raw);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        path: "agents.entries.runner.modelPolicy.allow.0",
        message: expect.stringContaining("invalid model policy ref"),
      }),
    );
    const text = renderedText(raw, result.issues);
    expect(text).toContain("agents.entries.runner.modelPolicy.allow.0");
    expect(text).not.toContain(secretRef);
    expect(
      result.issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n"),
    ).not.toContain(secretRef);
  });

  it("redacts sensitive paths that fail type checks", () => {
    const raw = { gateway: { auth: { token: 12345 } } };
    const result = validate(raw);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.issues).toContainEqual(expect.objectContaining({ path: "gateway.auth.token" }));
    expect(renderedText(raw, result.issues)).not.toContain("12345");
  });

  it("still accepts a valid configuration", () => {
    expect(validate({ gateway: { port: 19001 } }).ok).toBe(true);
  });
});
