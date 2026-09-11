import { Context, DateTime, Effect, Layer } from "effect";

// A device polls on a timer with nothing new to say, and each of those polls
// would otherwise cost a D1 row write: the largest recurring write here.
// A minute collapses a wake-up burst while keeping the lag on last_seen_at far
// inside the 20 minute window the online count reads.
const windowMillis = 60_000;

// Dropped whole at the cap rather than evicted one by one: forgetting an entry
// costs a write, not a mistake.
const memoCapacity = 20_000;

export interface CheckKey {
  // Cache entries are keyed by URL; one under the origin already serving the
  // request is certainly ours.
  readonly origin: string;
  readonly clientId: string;
  // Everything a write would record. Any difference is worth writing.
  readonly fingerprint: string;
}

export interface CheckDebounceShape {
  // Runs `write` unless this exact check was already written for this client
  // inside the window.
  readonly once: <E, R>(key: CheckKey, write: Effect.Effect<void, E, R>) => Effect.Effect<void, E, R>;
}

export class CheckDebounce extends Context.Service<CheckDebounce, CheckDebounceShape>()("expo-ota/CheckDebounce") {
  // Every check is written: correct, merely chattier.
  static readonly always = Layer.succeed(CheckDebounce, { once: (_key, write) => write });

  /**
   * Two tiers, neither needing a binding or any setup. The isolate's map
   * answers first and works everywhere, including a workers.dev URL, where the
   * cache is a no-op because that zone is shared. The Workers cache answers
   * second, covering what one isolate cannot: it is per colo and ephemeral,
   * which suits a debounce, where a lost entry costs one extra write.
   *
   * Not KV: it is built for rare writes, caps one key at a write per second,
   * and allows 1,000 writes a day free against D1's 100,000.
   *
   * The marker is stored only after the write succeeds, so a failed write is
   * never suppressed by its own marker; a cache that errors or is absent
   * degrades to writing every check.
   */
  static readonly edge = (cache: Cache) => {
    const memo = new Map<string, { readonly fingerprint: string; readonly until: number }>();
    return Layer.succeed(CheckDebounce, {
      once: Effect.fn("CheckDebounce.once")(function* <E, R>(key: CheckKey, write: Effect.Effect<void, E, R>) {
        const now = DateTime.toEpochMillis(yield* DateTime.now);
        const remembered = memo.get(key.clientId);
        if (remembered !== undefined && remembered.until > now && remembered.fingerprint === key.fingerprint) return;
        const request = new Request(`${key.origin}/__check/${encodeURIComponent(key.clientId)}`);
        const cached = yield* Effect.tryPromise(async () => {
          const hit = await cache.match(request);
          return hit === undefined ? null : await hit.text();
        }).pipe(Effect.orElseSucceed(() => null));
        if (cached !== key.fingerprint) {
          yield* write;
          yield* Effect.tryPromise(() =>
            cache.put(
              request,
              new Response(key.fingerprint, { headers: { "cache-control": `max-age=${windowMillis / 1000}` } }),
            ),
          ).pipe(Effect.orElseSucceed(() => undefined));
        }
        if (memo.size >= memoCapacity) memo.clear();
        memo.set(key.clientId, { fingerprint: key.fingerprint, until: now + windowMillis });
      }),
    });
  };

  // The same contract over a plain map, for tests with no Workers runtime.
  static readonly memory = (seen = new Map<string, string>()) =>
    Layer.succeed(CheckDebounce, {
      once: <E, R>(key: CheckKey, write: Effect.Effect<void, E, R>) =>
        seen.get(key.clientId) === key.fingerprint
          ? Effect.void
          : Effect.tap(write, () => Effect.sync(() => void seen.set(key.clientId, key.fingerprint))),
    });
}
