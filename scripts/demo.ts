import { spawn, type ChildProcess } from "node:child_process";
import { createServer, connect } from "node:net";
import { seedDemoData } from "./demo-data.js";

const options = parseOptions(process.argv.slice(2));
const apiBaseUrl = `http://127.0.0.1:${options.apiPort}`;
const webBaseUrl = `http://127.0.0.1:${options.webPort}`;
const children: ChildProcess[] = [];

try {
  await assertPortFree(options.apiPort, "API");
  await assertPortFree(options.webPort, "Web");
  if (options.full) await prepareFullInfrastructure();

  const api = start(process.execPath, [
    "--env-file-if-exists=.env",
    "--import",
    "tsx",
    "apps/api/src/main.ts",
  ], runtimeEnvironment());
  children.push(api);
  await waitForHttp(`${apiBaseUrl}/api/health`, "Runtime API");

  const seed = await seedDemoData(`${apiBaseUrl}/api`);
  const web = start("pnpm", [
    "--filter",
    "@ear/web",
    "exec",
    "vite",
    "--host",
    "127.0.0.1",
    "--port",
    String(options.webPort),
    "--strictPort",
  ], {
    VITE_API_PROXY_TARGET: apiBaseUrl,
  });
  children.push(web);
  await waitForHttp(webBaseUrl, "Web workbench");

  console.log("\nEnterprise Agent Runtime demo is ready");
  console.log(`  mode: ${options.full ? "PostgreSQL + Qdrant" : "offline in-memory"}`);
  console.log(`  workbench: ${webBaseUrl}`);
  console.log(`  lifecycle lab: ${webBaseUrl}/lifecycle-lab`);
  console.log(`  seed: ${seed.created.length} created, ${seed.skipped.length} reused, ${seed.approved.length} approved`);
  console.log("  model cost: CNY 0 (deterministic providers)\n");
  console.log("Press Ctrl+C to stop API and Web processes.");
  await waitForShutdown();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  for (const child of children.reverse()) child.kill("SIGTERM");
}

interface DemoOptions {
  full: boolean;
  apiPort: number;
  webPort: number;
}

function parseOptions(args: string[]): DemoOptions {
  const value = (name: string, fallback: number) => {
    const item = args.find((argument) => argument.startsWith(`${name}=`));
    const parsed = Number(item?.slice(name.length + 1) ?? fallback);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
      throw new Error(`Invalid ${name}: ${item ?? parsed}`);
    }
    return parsed;
  };
  return {
    full: args.includes("--full"),
    apiPort: value("--api-port", 3001),
    webPort: value("--web-port", 5173),
  };
}

async function prepareFullInfrastructure(): Promise<void> {
  console.log("Preparing PostgreSQL and Qdrant...");
  await run("docker", ["compose", "up", "-d", "postgres", "qdrant"]);
  await waitForPort(5434, "PostgreSQL");
  await waitForHttp("http://127.0.0.1:6333/readyz", "Qdrant");
  await run("pnpm", ["db:migrate"], {
    DATABASE_URL: "postgresql://ear:ear_dev@127.0.0.1:5434/ear",
  });
}

function runtimeEnvironment(): Record<string, string> {
  return {
    AUTH_MODE: "demo",
    PORT: String(options.apiPort),
    OPENAI_API_KEY: "",
    SEED_DEMO_DATA: "true",
    EMBEDDING_DIMENSIONS: "256",
    DATABASE_URL: options.full ? "postgresql://ear:ear_dev@127.0.0.1:5434/ear" : "",
    QDRANT_URL: options.full ? "http://127.0.0.1:6333" : "",
    QDRANT_COLLECTION: "ear_demo_256",
  };
}

function start(command: string, args: string[], overrides: Record<string, string>): ChildProcess {
  return spawn(command, args, {
    cwd: process.cwd(),
    env: { ...process.env, ...overrides },
    stdio: "inherit",
  });
}

function run(command: string, args: string[], overrides: Record<string, string> = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = start(command, args, overrides);
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with code ${code}`)));
  });
}

async function assertPortFree(port: number, label: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const server = createServer();
    server.once("error", () => reject(new Error(`${label} port ${port} is already in use. Pass --${label.toLowerCase()}-port=<port>.`)));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve()));
  });
}

async function waitForPort(port: number, label: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const connected = await new Promise<boolean>((resolve) => {
      const socket = connect({ host: "127.0.0.1", port });
      socket.once("connect", () => { socket.destroy(); resolve(true); });
      socket.once("error", () => resolve(false));
    });
    if (connected) return;
    await sleep(300);
  }
  throw new Error(`${label} did not become ready within ${timeoutMs}ms`);
}

async function waitForHttp(url: string, label: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Service is still starting.
    }
    await sleep(300);
  }
  throw new Error(`${label} did not become ready within ${timeoutMs}ms`);
}

function waitForShutdown(): Promise<void> {
  return new Promise((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
