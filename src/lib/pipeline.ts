import { extractJson } from "./extract-json";
import {
  mockStream,
  type MockBehavior,
  type MockState,
  type TransientError,
} from "./anthropic-mock";

export interface GenerateInput {
  /** Drives the mock streaming client (see anthropic-mock.ts). */
  behavior: MockBehavior;
  /** Hands the finished draft to the next pipeline stage. May reject. */
  advanceToNextStage: () => Promise<void>;
  /** Returns true once the draft passes review. Scripted by callers/tests. */
  reviewPasses: (attempt: number) => boolean;
}

export interface GenerateResult {
  status: "ok" | "error";
  attempts: number;
}

const MAX_REVISIONS = 3;

/** How many times we re-pull the stream before giving up on the draft. */
const MAX_STREAM_ATTEMPTS = 5;

/**
 * A stream hiccup we can recover from by retrying: either a transient rate
 * limit / server error from the model, or a dropped stream that left us with
 * un-parseable (truncated) JSON. Anything else is a real error and rethrows.
 */
function isRetryable(err: unknown): boolean {
  const status = (err as TransientError | undefined)?.status;
  if (status === 429 || status === 500 || status === 503) {
    return true;
  }
  // extractJson throws when the fenced block is missing/truncated.
  return err instanceof Error && /fenced JSON block/i.test(err.message);
}

/**
 * Pull a draft from the model and extract its JSON, retrying through transient
 * failures and truncated streams. Reuses `state` so the mock's call counter
 * advances across retries. Throws if every attempt fails.
 */
async function streamDraft(
  behavior: MockBehavior,
  state: MockState,
): Promise<unknown> {
  let lastErr: unknown;
  for (let i = 0; i < MAX_STREAM_ATTEMPTS; i += 1) {
    try {
      const text = await mockStream(behavior, state);
      return extractJson(text);
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err)) {
        throw err;
      }
    }
  }
  throw lastErr;
}

/**
 * Runs one content-generation pass: stream a draft, extract it, revise until it
 * passes review, then hand off to the next stage.
 *
 * This is a faithful (stripped-down) reproduction of the real pipeline — and it
 * ships with three real bugs from that pipeline. Your job is to fix them so the
 * test suite passes. See the README for the symptoms. (Do not edit the tests.)
 */
export async function generate(input: GenerateInput): Promise<GenerateResult> {
  const state: MockState = { calls: 0 };

  // Bug 2 & 3a: the model call can fail transiently (rate limits) or return a
  // truncated stream. Retry through those hiccups; only a persistent failure
  // takes the run down (as an error, not a crash).
  let attempt = 0;
  try {
    await streamDraft(input.behavior, state);
  } catch {
    return { status: "error", attempts: attempt };
  }

  // Bug 3b: revise until the draft passes review, but bounded by
  // MAX_REVISIONS. If it never passes, that's a failure — not a silent "ok".
  while (!input.reviewPasses(attempt)) {
    if (attempt >= MAX_REVISIONS) {
      return { status: "error", attempts: attempt };
    }
    attempt += 1;
  }

  // Bug 1: a failed hand-off to the next stage must surface as an error,
  // not vanish. Await it and report the failure.
  try {
    await input.advanceToNextStage();
  } catch {
    return { status: "error", attempts: attempt };
  }

  return { status: "ok", attempts: attempt };
}

export { MAX_REVISIONS };
