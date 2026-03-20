#!/usr/bin/env bun

import { COMMAND_TIMEOUT } from "../packages/shared/src/constants.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

declare const process: {
  argv: string[];
  exit(code?: number): never;
  on(event: string, listener: (...args: unknown[]) => void): void;
};

const DEFAULT_PINIX_URL = "ws://127.0.0.1:9000/ws/capability";
const DEFAULT_CAPABILITY_NAME = "browser";
const RECONNECT_DELAY_MS = 5000;
const DEFAULT_CDP_PORT = 19825;
const CDP_PORT_FILE = join(homedir(), ".bb-browser", "browser", "cdp-port");
const WAIT_POLL_INTERVAL = 200;

const CAPABILITIES = [
  "navigate",
  "click",
  "type",
  "evaluate",
  "screenshot",
  "getCookies",
  "waitForSelector",
] as const;

type CapabilityCommand = (typeof CAPABILITIES)[number];
type InputObject = Record<string, unknown>;

interface Options {
  pinixUrl: string;
  name: string;
}

interface PinixRegisterMessage {
  type: "register";
  name: string;
  capabilities: readonly CapabilityCommand[];
}

interface PinixInvokeMessage {
  id: string;
  command: string;
  input?: InputObject;
}

interface PinixResultMessage {
  id: string;
  output?: unknown;
  error?: { message: string; code: string };
}

// ─── CDP Client ───────────────────────────────────────────────

interface CdpTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

let cdpSocket: WebSocket | null = null;
let cdpNextId = 1;
let cdpSessionId: string | null = null;
let cdpTargetId: string | null = null;
const cdpPending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

function discoverCdpPort(): number {
  try {
    const content = readFileSync(CDP_PORT_FILE, "utf-8").trim();
    const port = parseInt(content, 10);
    return isNaN(port) ? DEFAULT_CDP_PORT : port;
  } catch {
    return DEFAULT_CDP_PORT;
  }
}

async function ensureCdp(): Promise<void> {
  if (cdpSocket && cdpSocket.readyState === WebSocket.OPEN && cdpSessionId) {
    return;
  }

  const port = discoverCdpPort();

  // Get browser WebSocket URL
  const versionRes = await fetch(`http://127.0.0.1:${port}/json/version`);
  if (!versionRes.ok) throw new Error(`Chrome not reachable at port ${port}`);
  const version = (await versionRes.json()) as { webSocketDebuggerUrl?: string };
  const wsUrl = version.webSocketDebuggerUrl;
  if (!wsUrl) throw new Error("Chrome CDP missing webSocketDebuggerUrl");

  // Connect browser WebSocket
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.onopen = () => {
      cdpSocket = ws;
      console.log(`[bb-browserd] CDP connected to ${wsUrl}`);
      resolve();
    };
    ws.onerror = () => reject(new Error(`CDP WebSocket connection failed`));
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data as ArrayBuffer));
        if (typeof msg.id === "number") {
          const pending = cdpPending.get(msg.id);
          if (pending) {
            cdpPending.delete(msg.id);
            if (msg.error) pending.reject(new Error(msg.error.message || "CDP error"));
            else pending.resolve(msg.result);
          }
        }
      } catch {}
    };
    ws.onclose = () => {
      cdpSocket = null;
      cdpSessionId = null;
      cdpTargetId = null;
      console.error("[bb-browserd] CDP disconnected");
    };
  });

  // Find a page target
  const targetsRes = await fetch(`http://127.0.0.1:${port}/json/list`);
  const targets = (await targetsRes.json()) as CdpTarget[];
  const page = targets.find((t) => t.type === "page");
  if (!page) throw new Error("No page target found in Chrome");

  // Attach to target
  const attachResult = await cdpBrowserCommand<{ sessionId: string }>("Target.attachToTarget", {
    targetId: page.id,
    flatten: true,
  });
  cdpSessionId = attachResult.sessionId;
  cdpTargetId = page.id;
  console.log(`[bb-browserd] Attached to target: ${page.title} (${page.url})`);
}

function cdpBrowserCommand<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  if (!cdpSocket || cdpSocket.readyState !== WebSocket.OPEN) {
    return Promise.reject(new Error("CDP not connected"));
  }
  const id = cdpNextId++;
  return new Promise<T>((resolve, reject) => {
    cdpPending.set(id, { resolve, reject });
    cdpSocket!.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (cdpPending.has(id)) {
        cdpPending.delete(id);
        reject(new Error(`CDP command ${method} timed out`));
      }
    }, COMMAND_TIMEOUT);
  });
}

function cdpSessionCommand<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  if (!cdpSocket || cdpSocket.readyState !== WebSocket.OPEN || !cdpSessionId) {
    return Promise.reject(new Error("CDP session not available"));
  }
  const id = cdpNextId++;
  return new Promise<T>((resolve, reject) => {
    cdpPending.set(id, { resolve, reject });
    cdpSocket!.send(JSON.stringify({ id, method, params, sessionId: cdpSessionId }));
    setTimeout(() => {
      if (cdpPending.has(id)) {
        cdpPending.delete(id);
        reject(new Error(`CDP command ${method} timed out`));
      }
    }, COMMAND_TIMEOUT);
  });
}

// ─── Command Implementations ─────────────────────────────────

async function cmdNavigate(input: InputObject): Promise<unknown> {
  const url = getRequiredString(input, "url");
  await ensureCdp();
  await cdpSessionCommand("Page.navigate", { url });
  // Wait a bit for load
  await new Promise((r) => setTimeout(r, 1000));
  const result = await cdpSessionCommand<{ result: { value: unknown } }>("Runtime.evaluate", {
    expression: "JSON.stringify({url: location.href, title: document.title})",
    returnByValue: true,
  });
  return JSON.parse(result.result.value as string);
}

async function cmdClick(input: InputObject): Promise<unknown> {
  const selector = getRequiredString(input, "selector", "ref");
  await ensureCdp();
  await cdpSessionCommand("Runtime.evaluate", {
    expression: `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error("Element not found: ${selector}"); el.click(); })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  return {};
}

async function cmdType(input: InputObject): Promise<unknown> {
  const selector = getRequiredString(input, "selector", "ref");
  const text = getRequiredStringAllowEmpty(input, "text");
  await ensureCdp();
  await cdpSessionCommand("Runtime.evaluate", {
    expression: `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error("Element not found: ${selector}"); el.focus(); el.value += ${JSON.stringify(text)}; el.dispatchEvent(new Event("input", {bubbles:true})); })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  return {};
}

async function cmdEvaluate(input: InputObject): Promise<unknown> {
  const js = getRequiredString(input, "js", "script");
  await ensureCdp();
  const result = await cdpSessionCommand<{
    result: { value?: unknown };
    exceptionDetails?: { text?: string; exception?: { description?: string } };
  }>("Runtime.evaluate", {
    expression: js,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.exception?.description ||
      result.exceptionDetails.text ||
      "Runtime.evaluate failed"
    );
  }
  return { result: result.result.value ?? null };
}

async function cmdScreenshot(_input: InputObject): Promise<unknown> {
  await ensureCdp();
  const result = await cdpSessionCommand<{ data: string }>("Page.captureScreenshot", {
    format: "png",
  });
  return { base64: result.data };
}

async function cmdGetCookies(_input: InputObject): Promise<unknown> {
  await ensureCdp();
  const result = await cdpSessionCommand<{ cookies: Array<{ name: string; value: string; domain: string; path: string }> }>(
    "Network.getCookies",
    {}
  );
  return {
    cookies: result.cookies.map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
    })),
  };
}

async function cmdWaitForSelector(input: InputObject): Promise<unknown> {
  const selector = getRequiredString(input, "selector", "ref");
  const timeout = typeof input.timeout === "number" ? input.timeout : 10000;
  await ensureCdp();

  const start = Date.now();
  while (Date.now() - start < timeout) {
    const result = await cdpSessionCommand<{ result: { value: unknown } }>("Runtime.evaluate", {
      expression: `document.querySelector(${JSON.stringify(selector)}) !== null`,
      returnByValue: true,
    });
    if (result.result.value === true) return {};
    await new Promise((r) => setTimeout(r, WAIT_POLL_INTERVAL));
  }
  throw new Error(`Timeout waiting for selector: ${selector}`);
}

const COMMAND_HANDLERS: Record<CapabilityCommand, (input: InputObject) => Promise<unknown>> = {
  navigate: cmdNavigate,
  click: cmdClick,
  type: cmdType,
  evaluate: cmdEvaluate,
  screenshot: cmdScreenshot,
  getCookies: cmdGetCookies,
  waitForSelector: cmdWaitForSelector,
};

async function executeCommand(command: CapabilityCommand, input: InputObject): Promise<unknown> {
  return COMMAND_HANDLERS[command](input);
}

// ─── Helpers ──────────────────────────────────────────────────

function printUsage(): void {
  console.log(`Usage: bun run bin/bb-browserd.ts [--pinix <url>] [--name <name>]

Options:
  --pinix <url>  Pinix capability WebSocket URL (default: ${DEFAULT_PINIX_URL})
  --name <name>  Capability name to register (default: ${DEFAULT_CAPABILITY_NAME})
  --help         Show this message`);
}

function parseArgs(argv: string[]): Options {
  let pinixUrl = DEFAULT_PINIX_URL;
  let name = DEFAULT_CAPABILITY_NAME;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--pinix") {
      pinixUrl = getFlagValue(argv, index, "--pinix");
      index += 1;
    } else if (arg === "--name") {
      name = getFlagValue(argv, index, "--name");
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return { pinixUrl, name };
}

function getFlagValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
  return value;
}

function isCapabilityCommand(command: string): command is CapabilityCommand {
  return (CAPABILITIES as readonly string[]).includes(command);
}

function asInputObject(value: unknown): InputObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as InputObject;
}

function getRequiredString(input: InputObject, ...keys: string[]): string {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  throw new Error(`Missing or invalid "${keys[0]}"`);
}

function getRequiredStringAllowEmpty(input: InputObject, ...keys: string[]): string {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string") return value;
  }
  throw new Error(`Missing or invalid "${keys[0]}"`);
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function isPinixInvokeMessage(value: unknown): value is PinixInvokeMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const c = value as Record<string, unknown>;
  return typeof c.id === "string" && typeof c.command === "string";
}

function isPingMessage(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return (value as Record<string, unknown>).type === "ping";
}

async function readTextMessage(data: unknown): Promise<string | null> {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  if (data instanceof Blob) return data.text();
  return null;
}

// ─── Pinix Bridge ─────────────────────────────────────────────

class PinixBridge {
  private socket: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(private readonly options: Options) {}

  start(): void { this.connect(); }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.socket && this.socket.readyState !== WebSocket.CLOSING && this.socket.readyState !== WebSocket.CLOSED) {
      this.socket.close();
    }
  }

  private connect(): void {
    if (this.stopped) return;
    if (this.socket && (this.socket.readyState === WebSocket.CONNECTING || this.socket.readyState === WebSocket.OPEN)) return;

    console.log(`[bb-browserd] Connecting to ${this.options.pinixUrl}`);
    let socket: WebSocket;
    try {
      socket = new WebSocket(this.options.pinixUrl);
    } catch (error) {
      console.error(`[bb-browserd] Failed to create WebSocket: ${formatError(error)}`);
      this.scheduleReconnect();
      return;
    }

    this.socket = socket;

    socket.onopen = () => {
      if (this.socket !== socket) return;
      console.log(`[bb-browserd] Connected to pinixd at ${this.options.pinixUrl}`);
      this.clearReconnectTimer();
      this.register(socket);
    };

    socket.onmessage = (event) => {
      if (this.socket !== socket) return;
      void this.handleMessage(socket, event.data);
    };

    socket.onerror = () => {
      if (this.socket !== socket) return;
      console.error("[bb-browserd] WebSocket error");
    };

    socket.onclose = (event) => {
      if (this.socket === socket) this.socket = null;
      console.error(`[bb-browserd] Disconnected from pinixd: ${event.code}`);
      if (!this.stopped) this.scheduleReconnect();
    };
  }

  private register(socket: WebSocket): void {
    const message: PinixRegisterMessage = { type: "register", name: this.options.name, capabilities: CAPABILITIES };
    if (this.send(socket, message)) {
      console.log(`[bb-browserd] Registered capability "${this.options.name}" with commands: ${CAPABILITIES.join(", ")}`);
    }
  }

  private async handleMessage(socket: WebSocket, rawData: unknown): Promise<void> {
    const text = await readTextMessage(rawData);
    if (text === null) return;

    let message: unknown;
    try { message = JSON.parse(text); } catch { return; }

    if (isPingMessage(message)) { this.send(socket, { type: "pong" }); return; }
    if (!isPinixInvokeMessage(message)) return;

    await this.handleInvocation(socket, message);
  }

  private async handleInvocation(socket: WebSocket, message: PinixInvokeMessage): Promise<void> {
    if (!isCapabilityCommand(message.command)) {
      this.sendError(socket, message.id, `Unknown capability command: ${message.command}`);
      return;
    }

    try {
      const output = await executeCommand(message.command, asInputObject(message.input));
      this.send(socket, { id: message.id, output } satisfies PinixResultMessage);
    } catch (error) {
      this.sendError(socket, message.id, formatError(error));
    }
  }

  private sendError(socket: WebSocket, id: string, error: string): void {
    this.send(socket, { id, error: { message: error, code: "ERROR" } } satisfies PinixResultMessage);
  }

  private send(socket: WebSocket, payload: PinixRegisterMessage | PinixResultMessage | { type: "pong" }): boolean {
    if (socket.readyState !== WebSocket.OPEN) return false;
    try { socket.send(JSON.stringify(payload)); return true; } catch { return false; }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.stopped) return;
    console.log(`[bb-browserd] Reconnecting in ${RECONNECT_DELAY_MS}ms`);
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.connect(); }, RECONNECT_DELAY_MS);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
  }
}

// ─── Main ─────────────────────────────────────────────────────

function installProcessHandlers(bridge: PinixBridge): void {
  process.on("SIGINT", () => { bridge.stop(); process.exit(0); });
  process.on("SIGTERM", () => { bridge.stop(); process.exit(0); });
  process.on("unhandledRejection", (reason) => { console.error(`[bb-browserd] Unhandled rejection: ${formatError(reason)}`); });
  process.on("uncaughtException", (error) => { console.error(`[bb-browserd] Uncaught exception: ${formatError(error)}`); });
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const bridge = new PinixBridge(options);
  installProcessHandlers(bridge);
  bridge.start();
}

try { main(); } catch (error) { console.error(`[bb-browserd] ${formatError(error)}`); process.exit(1); }
