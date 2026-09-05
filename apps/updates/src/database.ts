import * as Cloudflare from "alchemy/Cloudflare";

// Relative to the repo root, where every Alchemy command runs. This file is
// bundled into the Worker, so it cannot resolve paths from import.meta.
export const Database = Cloudflare.D1.Database("Database", {
  migrations: "./apps/updates/migrations",
});
