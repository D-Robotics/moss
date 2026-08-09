# Formatting baseline and blame handling

The first repository-wide Prettier run is a mechanical migration. It changes layout and canonical
line endings across existing source, tests, scripts, metadata, and documentation without intending
to change runtime behavior.

## Landing the baseline

The baseline must be reviewed and landed separately from lint fixes, runtime changes, API report
updates, and policy changes:

1. Apply the formatting configuration and run `npm run format`.
2. Confirm `npm run format:check` and `git diff --check` pass.
3. Review the formatting diff independently and commit it with a message such as
   `style: establish Prettier baseline`.
4. Run the existing build, typecheck, and complete package tests before merging.
5. Add that formatting-only commit hash to `.git-blame-ignore-revs` in a follow-up metadata commit.

Do not add the hash of a mixed tooling or behavioral commit. If the hosting platform cannot ignore
revisions automatically, configure local Git with:

```sh
git config blame.ignoreRevsFile .git-blame-ignore-revs
```

Future changes must not be folded into the initial baseline. Contributors run `npm run format` only
on their current branch and include resulting formatting with the code they intentionally changed.
