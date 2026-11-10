import path from "node:path";
import JSON5 from "json5";
import { VERSION } from "../version.js";
import { formatConfigIssueLines } from "./issue-format.js";
import type { ConfigFileSnapshot } from "./types.js";
import { shouldWarnOnTouchedVersion } from "./version.js";

type ConfigIssuePathSegment = string | number;

type Cursor = { pos: number };

function skipTrivia(raw: string, cursor: Cursor): void {
  while (cursor.pos < raw.length) {
    const char = raw[cursor.pos];
    if (/\s/u.test(char ?? "")) {
      cursor.pos++;
      continue;
    }
    if (char === "/" && raw[cursor.pos + 1] === "/") {
      cursor.pos += 2;
      while (cursor.pos < raw.length && !/[\n\r\u2028\u2029]/u.test(raw[cursor.pos] ?? "")) {
        cursor.pos++;
      }
      continue;
    }
    if (char === "/" && raw[cursor.pos + 1] === "*") {
      const close = raw.indexOf("*/", cursor.pos + 2);
      cursor.pos = close === -1 ? raw.length : close + 2;
      continue;
    }
    return;
  }
}

function scanQuoted(raw: string, cursor: Cursor): void {
  const quote = raw[cursor.pos++];
  while (cursor.pos < raw.length) {
    const char = raw[cursor.pos++];
    if (char === "\\") {
      cursor.pos++;
    } else if (char === quote) {
      return;
    }
  }
}

function consume(raw: string, cursor: Cursor, expected: string): boolean {
  skipTrivia(raw, cursor);
  if (raw[cursor.pos] !== expected) {
    return false;
  }
  cursor.pos++;
  return true;
}

function readObjectKey(raw: string, cursor: Cursor): string | null {
  skipTrivia(raw, cursor);
  const start = cursor.pos;
  const char = raw[cursor.pos];
  if (char === '"' || char === "'") {
    scanQuoted(raw, cursor);
  } else {
    while (
      cursor.pos < raw.length &&
      !/[\s:]/u.test(raw[cursor.pos] ?? "") &&
      !(raw[cursor.pos] === "/" && /[/*]/u.test(raw[cursor.pos + 1] ?? ""))
    ) {
      cursor.pos++;
    }
  }
  if (cursor.pos === start) {
    return null;
  }
  const token = raw.slice(start, cursor.pos);
  try {
    if (char === '"' || char === "'") {
      const parsed = JSON5.parse(token);
      return typeof parsed === "string" ? parsed : null;
    }
    const parsed = JSON5.parse(`{${token}:null}`) as Record<string, unknown>;
    return Object.keys(parsed)[0] ?? null;
  } catch {
    return null;
  }
}

function skipValue(raw: string, cursor: Cursor): void {
  skipTrivia(raw, cursor);
  const char = raw[cursor.pos];
  if (char === '"' || char === "'") {
    scanQuoted(raw, cursor);
    return;
  }
  if (char === "{" || char === "[") {
    const close = char === "{" ? "}" : "]";
    cursor.pos++;
    while (cursor.pos < raw.length) {
      skipTrivia(raw, cursor);
      if (raw[cursor.pos] === close) {
        cursor.pos++;
        return;
      }
      if (char === "{" && (readObjectKey(raw, cursor) === null || !consume(raw, cursor, ":"))) {
        return;
      }
      skipValue(raw, cursor);
      skipTrivia(raw, cursor);
      if (raw[cursor.pos] === ",") {
        cursor.pos++;
      }
    }
    return;
  }
  while (
    cursor.pos < raw.length &&
    !/[,}\]\s]/u.test(raw[cursor.pos] ?? "") &&
    !(raw[cursor.pos] === "/" && /[/*]/u.test(raw[cursor.pos + 1] ?? ""))
  ) {
    cursor.pos++;
  }
}

function locateValueOffset(
  raw: string,
  cursor: Cursor,
  segments: readonly ConfigIssuePathSegment[],
  depth: number,
): number | undefined {
  const segment = segments[depth];
  const isLeaf = depth === segments.length - 1;
  if (typeof segment === "number") {
    if (!consume(raw, cursor, "[")) {
      return undefined;
    }
    for (let index = 0; cursor.pos < raw.length; index++) {
      skipTrivia(raw, cursor);
      if (raw[cursor.pos] === "]") {
        return undefined;
      }
      if (index === segment) {
        return isLeaf ? cursor.pos : locateValueOffset(raw, cursor, segments, depth + 1);
      }
      skipValue(raw, cursor);
      if (!consume(raw, cursor, ",")) {
        return undefined;
      }
    }
    return undefined;
  }

  if (!consume(raw, cursor, "{")) {
    return undefined;
  }
  let lastMatch: number | undefined;
  while (cursor.pos < raw.length) {
    skipTrivia(raw, cursor);
    if (raw[cursor.pos] === "}") {
      return lastMatch;
    }
    const key = readObjectKey(raw, cursor);
    if (key === null || !consume(raw, cursor, ":")) {
      return undefined;
    }
    skipTrivia(raw, cursor);
    const valueStart = cursor.pos;
    if (key === segment) {
      lastMatch = isLeaf
        ? valueStart
        : locateValueOffset(raw, { pos: valueStart }, segments, depth + 1);
    }
    cursor.pos = valueStart;
    skipValue(raw, cursor);
    skipTrivia(raw, cursor);
    if (raw[cursor.pos] === ",") {
      cursor.pos++;
      continue;
    }
    return lastMatch;
  }
  return lastMatch;
}

function lineAtOffset(raw: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index++) {
    const char = raw[index];
    if (char === "\r") {
      line++;
      if (raw[index + 1] === "\n") {
        index++;
      }
    } else if (char === "\n" || char === "\u2028" || char === "\u2029") {
      line++;
    }
  }
  return line;
}

function resolveConfigIssueLineInRaw(
  raw: string,
  segments: readonly ConfigIssuePathSegment[],
): number | undefined {
  if (segments.length === 0 || raw.trim().length === 0) {
    return undefined;
  }
  const offset = locateValueOffset(raw, { pos: 0 }, segments, 0);
  return offset === undefined ? undefined : lineAtOffset(raw, offset);
}

/**
 * Render invalid config issues with source locations and version-skew advice.
 * Messages name the setting path and the reason; configured values are never
 * echoed, so secrets cannot leak through validation output.
 */
export function renderConfigValidationIssueLines(
  snapshot: Pick<ConfigFileSnapshot, "issues" | "raw" | "parsed" | "sourceConfig" | "path">,
  marker = "-",
): string[] {
  const raw = typeof snapshot.raw === "string" ? snapshot.raw : null;
  const sourceFile =
    typeof snapshot.path === "string" && snapshot.path.trim()
      ? path.basename(snapshot.path)
      : "openclaw.json";
  const issues = snapshot.issues.map((issue) => {
    const segments = issue.pathSegments;
    if (!segments || segments.length === 0) {
      return issue;
    }
    const line = raw === null ? undefined : resolveConfigIssueLineInRaw(raw, segments);
    return {
      ...issue,
      // Validation path metadata is non-enumerable; preserve it through this display copy.
      pathSegments: segments,
      ...(line === undefined ? {} : { line, sourceFile }),
    };
  });
  const lines = formatConfigIssueLines(issues, marker, { normalizeRoot: true });
  const touchedVersion = snapshot.sourceConfig.meta?.lastTouchedVersion;
  return shouldWarnOnTouchedVersion(VERSION, touchedVersion)
    ? [
        ...lines,
        `Config was last written by OpenClaw ${touchedVersion}, but you are running ${VERSION} — upgrade or re-run setup.`,
      ]
    : lines;
}
