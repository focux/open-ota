# Landing site

The project's marketing site for [openota.dev](https://openota.dev). It is a
static page: `index.html` plus the stylesheets and `site.js` in
`public/assets/`, built by Vite.

It deploys on its own, from `alchemy.run.ts` in this directory:

```sh
pnpm --filter landing site:plan      # preview the change
pnpm --filter landing site:deploy    # deploy to openota.dev
```

That stack is separate from the one at the repository root on purpose. People
self-hosting Open OTA deploy the root `alchemy.run.ts`, which provisions the
updates Worker and the dashboard; they never deploy this site. The two share no
resources and no state. Set `SITE_DOMAIN` to override the hostname; a
`dev_<user>` stage keeps its `workers.dev` URL and never touches the zone.
