import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { RawListingSchema, type RawListing } from "../lib/normalize";
import type {
  CoinAfriqueExtraction,
  CoinAfriqueExtractionInput,
} from "../sources/coinafrique-parser";

const MAX_BYTES = 2_000_000;
const MAX_DIAGNOSTIC_BYTES = 16_000;
const DEFAULT_TIMEOUT_MS = 3_000;
const KILL_GRACE_MS = 1_000;

export type ScraplingMode = "standard" | "adaptive-train" | "adaptive";

export interface ScraplingMetrics {
  durationMs: number;
  rssBytes: number;
  networkAttempts: number;
  wallMs: number;
}

export interface ScraplingExtraction extends CoinAfriqueExtraction {
  metrics: ScraplingMetrics;
}

export interface ScraplingBridgeOptions {
  mode?: ScraplingMode;
  storagePath?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  pythonPath?: string;
  scriptPath?: string;
}

export type ScraplingPilotErrorCode =
  | "missing-runtime"
  | "input-too-large"
  | "output-too-large"
  | "timeout"
  | "aborted"
  | "process"
  | "protocol";

export class ScraplingPilotError extends Error {
  constructor(
    readonly code: ScraplingPilotErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const ResponseSchema = z
  .object({
    version: z.literal(1),
    listings: z.array(RawListingSchema),
    errors: z.array(z.string().max(500)),
    metrics: z
      .object({
        durationMs: z.number().nonnegative(),
        rssBytes: z.number().int().nonnegative(),
        networkAttempts: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();

const defaultPython = fileURLToPath(
  new URL("../../.venv-scrapling/bin/python", import.meta.url),
);
const defaultScript = fileURLToPath(new URL("./parse_coinafrique.py", import.meta.url));

interface LockWaiter {
  resolve: (release: () => void) => void;
  reject: (error: unknown) => void;
  active: boolean;
}

let isBridgeBusy = false;
const bridgeQueue: LockWaiter[] = [];

function releaseBridgeLock(): void {
  while (bridgeQueue.length > 0) {
    const next = bridgeQueue.shift()!;
    if (next.active) {
      next.active = false;
      next.resolve(releaseBridgeLock);
      return;
    }
  }
  isBridgeBusy = false;
}

function acquireBridgeLock(signal?: AbortSignal, timeoutMs?: number): Promise<() => void> {
  if (signal?.aborted) {
    return Promise.reject(
      new ScraplingPilotError("aborted", "Scrapling pilot aborted before start"),
    );
  }

  if (typeof timeoutMs === "number" && timeoutMs <= 0) {
    return Promise.reject(
      new ScraplingPilotError("timeout", "Scrapling pilot exceeded its deadline"),
    );
  }

  if (!isBridgeBusy && bridgeQueue.length === 0) {
    isBridgeBusy = true;
    return Promise.resolve(releaseBridgeLock);
  }

  return new Promise<() => void>((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined;

    const waiter: LockWaiter = {
      active: true,
      resolve: (release) => {
        cleanup();
        resolve(release);
      },
      reject: (err) => {
        cleanup();
        reject(err);
      },
    };

    const cleanup = () => {
      waiter.active = false;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      const index = bridgeQueue.indexOf(waiter);
      if (index !== -1) bridgeQueue.splice(index, 1);
    };

    const onAbort = () => {
      cleanup();
      reject(new ScraplingPilotError("aborted", "Scrapling pilot aborted"));
    };

    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
    }

    if (typeof timeoutMs === "number" && Number.isFinite(timeoutMs)) {
      timer = setTimeout(() => {
        cleanup();
        reject(new ScraplingPilotError("timeout", "Scrapling pilot exceeded its deadline"));
      }, timeoutMs);
      timer.unref?.();
    }

    bridgeQueue.push(waiter);
  });
}

function diagnosticText(chunks: Buffer[], total: number): string {
  return Buffer.concat(chunks, Math.min(total, MAX_DIAGNOSTIC_BYTES))
    .subarray(0, MAX_DIAGNOSTIC_BYTES)
    .toString("utf8")
    .trim();
}

export async function extractCoinAfriqueScrapling(
  input: CoinAfriqueExtractionInput,
  options: ScraplingBridgeOptions = {},
): Promise<ScraplingExtraction> {
  const started = performance.now();
  const totalTimeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  if (options.signal?.aborted) {
    throw new ScraplingPilotError("aborted", "Scrapling pilot aborted before start");
  }

  const mode = options.mode ?? "standard";
  if (mode !== "standard" && !options.storagePath) {
    throw new ScraplingPilotError("protocol", "adaptive mode requires storagePath");
  }

  const payload = Buffer.from(
    JSON.stringify({
      version: 1,
      html: input.html,
      baseUrl: input.baseUrl,
      mode,
      ...(options.storagePath ? { storagePath: options.storagePath } : {}),
    }),
    "utf8",
  );
  if (payload.byteLength > MAX_BYTES) {
    throw new ScraplingPilotError("input-too-large", "Scrapling input exceeds 2 MB");
  }

  const pythonPath = options.pythonPath ?? defaultPython;
  const scriptPath = options.scriptPath ?? defaultScript;
  if (!existsSync(pythonPath) || !existsSync(scriptPath)) {
    throw new ScraplingPilotError(
      "missing-runtime",
      "Scrapling pilot runtime is not installed",
    );
  }

  const release = await acquireBridgeLock(options.signal, totalTimeoutMs);
  try {
    if (options.signal?.aborted) {
      throw new ScraplingPilotError("aborted", "Scrapling pilot aborted");
    }

    const elapsedMs = performance.now() - started;
    const remainingTimeoutMs = totalTimeoutMs - elapsedMs;
    if (remainingTimeoutMs <= 0) {
      throw new ScraplingPilotError("timeout", "Scrapling pilot exceeded its deadline");
    }

    const child = spawn(pythonPath, [scriptPath], {
      cwd: options.storagePath ? dirname(options.storagePath) : tmpdir(),
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
        NODE_ENV: "production",
        PYTHONHASHSEED: "0",
        PYTHONIOENCODING: "utf-8",
        PYTHONNOUSERSITE: "1",
        PYTHONDONTWRITEBYTECODE: "1",
      },
    });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let failure: ScraplingPilotError | null = null;
    let killTimer: NodeJS.Timeout | undefined;

    const terminate = () => {
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
      killTimer.unref?.();
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes <= MAX_BYTES) stdout.push(chunk);
      if (stdoutBytes > MAX_BYTES && !failure) {
        failure = new ScraplingPilotError("output-too-large", "Scrapling output exceeds 2 MB");
        terminate();
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const remaining = MAX_DIAGNOSTIC_BYTES - stderrBytes;
      if (remaining > 0) stderr.push(chunk.subarray(0, remaining));
      stderrBytes += chunk.byteLength;
    });

    const timeout = setTimeout(() => {
      if (!failure) {
        failure = new ScraplingPilotError("timeout", "Scrapling pilot exceeded its deadline");
        terminate();
      }
    }, remainingTimeoutMs);
    timeout.unref?.();

    const onAbort = () => {
      if (!failure) {
        failure = new ScraplingPilotError("aborted", "Scrapling pilot aborted");
        terminate();
      }
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => resolve({ code, signal }));
      },
    );
    child.stdin.on("error", () => {});
    child.stdin.end(payload);

    let result: { code: number | null; signal: NodeJS.Signals | null };
    try {
      result = await exit;
    } catch (error) {
      throw new ScraplingPilotError(
        "process",
        `Scrapling process failed to start: ${(error as Error).message}`,
      );
    } finally {
      clearTimeout(timeout);
      clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", onAbort);
    }

    if (failure) throw failure;
    if (result.code !== 0) {
      const diagnostic = diagnosticText(stderr, stderrBytes);
      throw new ScraplingPilotError(
        "process",
        `Scrapling process exited with ${result.code ?? result.signal}${
          diagnostic ? `: ${diagnostic}` : ""
        }`,
      );
    }

    let raw: unknown;
    try {
      raw = JSON.parse(Buffer.concat(stdout, stdoutBytes).toString("utf8"));
    } catch {
      throw new ScraplingPilotError("protocol", "Scrapling returned invalid JSON");
    }
    const parsed = ResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new ScraplingPilotError("protocol", "Scrapling returned an invalid response");
    }

    return {
      listings: parsed.data.listings as RawListing[],
      errors: parsed.data.errors,
      metrics: {
        ...parsed.data.metrics,
        wallMs: performance.now() - started,
      },
    };
  } finally {
    release();
  }
}
