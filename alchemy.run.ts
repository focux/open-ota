import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import { assertProtectedStage, Origins } from "./apps/updates/src/config.ts";
import { Dashboard } from "./apps/updates/src/dashboard.ts";
import Updates from "./apps/updates/src/worker.ts";

export default Alchemy.Stack(
  "OpenOta",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const { stage, accessInclude } = yield* Origins;
    yield* assertProtectedStage(stage, accessInclude);
    const updates = yield* Updates;
    const dashboard = yield* Dashboard;
    return {
      updatesUrl: updates.url.as<string>(),
      dashboardUrl: dashboard.url.as<string>(),
    };
  }),
);
