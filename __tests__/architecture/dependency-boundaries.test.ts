import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

describe("架构依赖边界", () => {
  it("跨端Agent SDK不应依赖UI框架和具体状态库", () => {
    expect(importsUnder("packages/rn-agent-sdk")).not.toContainAnyOf([
      "react",
      "react-native",
      "zustand",
      "@tanstack/react-query",
      "apps/web",
    ]);
  });

  it("稳定事件协议不应反向依赖应用和业务Agent", () => {
    expect(importsUnder("packages/agent-protocol")).not.toContainAnyOf([
      "apps/",
      "agents/",
      "react",
      "react-native",
    ]);
  });

  it("MCP适配层应通过Tool Registry执行工具", () => {
    const imports = importsInFile("mcp-servers/paas-tools/src/index.ts");
    expect(imports).toContain("@ear/tool-registry");
    expect(imports).not.toContainAnyOf(["@ear/paas-metadata", "apps/api"]);
  });
});

function importsUnder(relativeDirectory: string): string[] {
  return sourceFiles(join(root, relativeDirectory)).flatMap(importsFromSourceFile);
}

function importsInFile(relativeFile: string): string[] {
  return importsFromSourceFile(join(root, relativeFile));
}

function importsFromSourceFile(file: string): string[] {
  const source = readFileSync(file, "utf8");
  return [...source.matchAll(/(?:from\s+|import\s*\()["']([^"']+)["']/g)]
    .map((match) => match[1])
    .filter((specifier): specifier is string => Boolean(specifier));
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && /\.(ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

expect.extend({
  toContainAnyOf(received: string[], forbidden: string[]) {
    const matches = received.filter((specifier) => forbidden.some((item) => specifier === item || specifier.startsWith(item)));
    return {
      pass: matches.length > 0,
      message: () => matches.length > 0
        ? `发现受限制依赖: ${matches.join(", ")}`
        : `未发现任一依赖: ${forbidden.join(", ")}`,
    };
  },
});

declare module "vitest" {
  interface Assertion<T> {
    toContainAnyOf(expected: string[]): T;
  }
}
