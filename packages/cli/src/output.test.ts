import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { createOutput, Progress } from "./output.ts";

describe("terminal output", () => {
  it("keeps CI output append-only and diagnostics opt-in", () => {
    const writes: Array<string> = [];
    const output = createOutput({
      write: (text) => writes.push(text),
      interactive: false,
      color: false,
      verbose: false,
    });
    output.report({ type: "start", message: "Uploading assets" }, 0);
    output.report({ type: "progress", message: "Uploaded 1/2 assets" }, 100);
    output.report({ type: "detail", message: "internal detail" }, 200);
    output.report({ type: "success", message: "Uploaded 2 assets" }, 1500);
    expect(writes.join("")).toContain("Uploaded 1/2 assets");
    expect(writes.join("")).toContain("(1.5s)");
    expect(writes.join("")).not.toMatch(/[\r\x1b]/);
    expect(writes.join("")).not.toContain("internal detail");
    output.close();
  });

  it("stops drawing on failure and removes untrusted terminal controls", () => {
    const writes: Array<string> = [];
    const output = createOutput({
      write: (text) => writes.push(text),
      interactive: true,
      color: false,
      verbose: false,
      columns: 32,
    });
    output.report({ type: "start", message: "Exporting project" }, 0);
    output.draw(200);
    expect(writes.length).toBeGreaterThan(1);
    output.fail("bad input\x1b[2J\nnext line");
    const count = writes.length;
    output.draw(1000);
    expect(writes).toHaveLength(count);
    expect(writes.at(-1)).not.toContain("\x1b");
    expect(writes.at(-1)).toContain("Exporting project failed");
  });

  it("settles optional patch warnings without a success checkmark", () => {
    const writes: Array<string> = [];
    const output = createOutput({
      write: (text) => writes.push(text),
      interactive: true,
      color: false,
      verbose: false,
    });
    output.report({ type: "start", message: "Preparing patches" }, 0);
    output.report({ type: "warning", message: "Patches unavailable. Update remains published." }, 100);
    const count = writes.length;
    output.draw(1000);
    expect(writes).toHaveLength(count);
    expect(writes.at(-1)).toContain("Warning:");
    expect(writes.at(-1)).not.toContain("✓");
  });

  it("closes the animation fiber when its layer scope ends", async () => {
    const writes: Array<string> = [];
    await Effect.runPromise(
      Effect.gen(function* () {
        const progress = yield* Progress;
        yield* progress.report({ type: "start", message: "Working" });
        yield* Effect.sleep("150 millis");
      }).pipe(
        Effect.provide(
          Progress.layer({ write: (text) => writes.push(text), interactive: true, color: false, verbose: false }),
        ),
      ),
    );
    expect(writes.length).toBeGreaterThan(1);
    const count = writes.length;
    await Effect.runPromise(Effect.sleep("150 millis"));
    expect(writes).toHaveLength(count);
  });
});
