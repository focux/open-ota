import { Context, DateTime, Effect, Layer } from "effect";
import { stripVTControlCharacters } from "node:util";

export type Report = (event: {
  type: "start" | "progress" | "published" | "success" | "info" | "warning" | "detail";
  message: string;
}) => void;

export const createOutput = (options: {
  write: (text: string) => void;
  interactive: boolean;
  color: boolean;
  verbose: boolean;
  columns?: number;
}) => {
  let active: { message: string; started: number } | undefined;
  let frame = 0;
  let lastProgress: number | undefined;
  const frames = ["|", "/", "-", "\\"];
  const paint = (code: number, text: string) => (options.color ? `\x1b[${code}m${text}\x1b[0m` : text);
  const clean = (text: string) => stripVTControlCharacters(text).replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
  const clear = () => {
    if (options.interactive && active) options.write("\r\x1b[2K");
  };
  const elapsed = (now: number) => (active ? ` (${((now - active.started) / 1000).toFixed(1)}s)` : "");
  const draw = (now: number) => {
    if (!active) return;
    const text = `${frames[frame++ % frames.length]} ${clean(active.message)}${elapsed(now)}`;
    options.write(`\r\x1b[2K${text.slice(0, Math.max(1, (options.columns ?? 80) - 1))}`);
  };
  const close = () => {
    clear();
    active = undefined;
  };
  const report = ({ type, message }: Parameters<Report>[0], now: number) => {
    if (type === "detail" && !options.verbose) return;
    if (type === "start") {
      close();
      active = { message, started: now };
      lastProgress = undefined;
      if (options.interactive) {
        draw(now);
      } else {
        options.write(`> ${clean(message)}\n`);
      }
    } else if (type === "progress") {
      if (active) active.message = message;
      if (options.interactive) draw(now);
      else if (lastProgress === undefined || now - lastProgress >= 1000) {
        options.write(`  ${clean(message)}\n`);
        lastProgress = now;
      }
    } else if (type === "success" || type === "published") {
      const duration = elapsed(now);
      close();
      options.write(`${paint(32, "✓")} ${clean(message)}${duration}\n`);
    } else {
      if (type === "warning") close();
      else clear();
      const prefix = type === "warning" ? paint(33, "Warning: ") : "";
      const text = type === "detail" ? message.trimEnd().split(/\r?\n/).map(clean).join("\n") : clean(message);
      options.write(`${prefix}${text}\n`);
      if (options.interactive) draw(now);
    }
  };
  return {
    report,
    draw,
    close,
    fail: (message: string) => {
      const stage = active?.message;
      close();
      options.write(`${paint(31, "Error:")} ${stage ? `${clean(stage)} failed. ` : ""}${clean(message)}\n`);
    },
  };
};

export class Progress extends Context.Service<
  Progress,
  {
    report(event: Parameters<Report>[0]): Effect.Effect<void>;
    fail(message: string): Effect.Effect<void>;
    close: Effect.Effect<void>;
  }
>()("cli/Progress") {
  static readonly layer = (options: Parameters<typeof createOutput>[0]) =>
    Layer.effect(
      Progress,
      Effect.gen(function* () {
        const renderer = yield* Effect.acquireRelease(
          Effect.sync(() => createOutput(options)),
          (renderer) => Effect.sync(renderer.close),
        );
        if (options.interactive) {
          yield* Effect.forkScoped(
            Effect.forever(
              Effect.gen(function* () {
                yield* Effect.sleep("100 millis");
                const now = yield* DateTime.now;
                renderer.draw(DateTime.toEpochMillis(now));
              }),
            ),
          );
        }
        return Progress.of({
          report: Effect.fn("progress.report")(function* (event) {
            const now = yield* DateTime.now;
            renderer.report(event, DateTime.toEpochMillis(now));
          }),
          fail: Effect.fn("progress.fail")((message) => Effect.sync(() => renderer.fail(message))),
          close: Effect.sync(renderer.close),
        });
      }),
    );
}
