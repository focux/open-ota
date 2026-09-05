import * as Cloudflare from "alchemy/Cloudflare";

// Private. Bundles and assets are served through the Worker, never directly.
export const Assets = Cloudflare.R2.Bucket("Assets");
