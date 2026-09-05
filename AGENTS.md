# open-ota engineering conventions

Read `docs/plan.md` first. It is the design; this file is how to write the code.

`docs/plan.md` and the `.refs/` checkouts are local working material and are not in the
repository, so these instructions assume a working copy that has them.

- Effect 4 idioms only. `.refs/effect-smol/migration/*.md` is the migration authority; `.refs/effect-smol/ai-docs` has runnable examples.
- Before wrapping a library or designing a capability, search `.refs/effect-smol`, `.refs/alchemy`, `.refs/executor`, and `.refs/distilled` for an established pattern and copy it.
- Capabilities are `Context.Service` classes with a `static layer`; tests swap in `Layer.succeed`/`Layer.sync` doubles.
- Expected failures stay in the typed error channel as `Schema.TaggedError`. Defects are for programmer bugs only.
- `Effect.fn("module.operation")` on every service method and handler. Time is `DateTime.now` inline, never `new Date()`.
- Promise interop only at the R2, WebCrypto, and D1-binding boundary, inside the module that owns it, with `Effect.tryPromise`.
- HTTP is `effect/unstable/http` (`HttpRouter.use`, `HttpServerRequest`, `HttpServerResponse`). Transports stay thin; behavior lives in services.
- SQL goes through `SqlClient` from `alchemy/SQL/D1`. Rows are decoded with Schema before use. D1 has no transactions; design writes so partial state is invisible.
- Alchemy is the sole infrastructure authority: `alchemy.run.ts` is the composition root, one file per resource, no wrangler config, `Config.redacted` resolved at Worker init.
- Dashboard: TanStack Start, shadcn components from the configured registry before any custom primitive, pathless `_dashboard` layout, TanStack Query for reads and writes, `ManagedRuntime.runPromise` bridge in `src/lib/api.ts` only. No `useEffect` for derived state, events, or fetching.
- Do not over-abstract. Inline one-liners. Extract only real duplicated behavior. Match the comment density of the surrounding file.
- No em dashes in code, docs, commits, or PR text.
