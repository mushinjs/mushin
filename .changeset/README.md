# Changesets

Every pull request that changes what users get adds a changeset: run `pnpm changeset`, pick the bump, and write one line for the changelog.

All `@mushin/*` packages share one version (the `fixed` group in `config.json`), because the version of `@mushin/core` is the Mushin.js version that plugins check against.

When a pull request with a changeset merges into `main`, the release workflow:

- publishes a snapshot of every package to the `next` tag on npm, such as `0.2.0-next.20261111120000`, so `npm i @mushin/cli@next` gets it right away;
- opens or updates the "Version Packages" pull request. Merging that one publishes the release to the `latest` tag.
