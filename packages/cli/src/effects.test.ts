import { NodeServices } from "@effect/platform-node";
import { Deferred, Effect, Fiber, Layer } from "effect";
import { expect, it } from "vitest";
import { Processes } from "./expo.ts";
import { Progress } from "./output.ts";

const quiet = Layer.succeed(Progress, { report: () => Effect.void, fail: () => Effect.void, close: Effect.void });

it("keeps a nonzero process exit in the typed error channel with stderr", async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const processes = yield* Processes;
      return yield* Effect.result(
        processes.run(process.execPath, ["-e", "console.error('export diagnostic');process.exit(7)"], process.cwd()),
      );
    }).pipe(Effect.provide(Processes.layer), Effect.provide(quiet), Effect.provide(NodeServices.layer)),
  );
  expect(result).toMatchObject({
    _tag: "Failure",
    failure: { _tag: "ProcessFailure", missing: false, message: expect.stringContaining("export diagnostic") },
  });
});

it("identifies a missing executable as a typed process failure", async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const processes = yield* Processes;
      return yield* Effect.result(processes.run("/nonexistent/open-ota-test-bsdiff", [], process.cwd()));
    }).pipe(Effect.provide(Processes.layer), Effect.provide(quiet), Effect.provide(NodeServices.layer)),
  );
  expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "ProcessFailure", missing: true } });
});

it("terminates a running subprocess when its fiber is interrupted", async () => {
  const pid = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const started = yield* Deferred.make<number>();
        const output = Layer.succeed(Progress, {
          report: (event) =>
            event.type === "detail" && /^\d+\s*$/.test(event.message)
              ? Deferred.succeed(started, Number(event.message)).pipe(Effect.asVoid)
              : Effect.void,
          fail: () => Effect.void,
          close: Effect.void,
        });
        const fiber = yield* Effect.forkScoped(
          Effect.gen(function* () {
            const processes = yield* Processes;
            yield* processes.run(
              process.execPath,
              ["-e", "console.log(process.pid);setInterval(()=>{},1000)"],
              process.cwd(),
            );
          }).pipe(Effect.provide(Processes.layer), Effect.provide(output)),
        );
        const pid = yield* Deferred.await(started);
        yield* Fiber.interrupt(fiber);
        return pid;
      }),
    ).pipe(Effect.provide(NodeServices.layer), Effect.timeout("5 seconds")),
  );
  expect(() => process.kill(pid, 0)).toThrow();
});
