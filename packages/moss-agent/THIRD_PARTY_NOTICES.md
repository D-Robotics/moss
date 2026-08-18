# Third-party notices

## Cordis lifecycle kernel

Moss includes a locally adapted lifecycle kernel derived from the design and
effect-ownership semantics of [Cordis](https://github.com/cordiverse/cordis).

- Copyright: 2021-present Shigma
- License: MIT
- Reviewed distribution: `deepseek-ai/deepseek-harness`
- Reviewed commit: `47f943859bef60e4160492346772ded9b24f765a`
- Vendored manifest and license:
  `src/vendor/cordis/README.md`, `src/vendor/cordis/LICENSE`

The complete license text is retained with the vendored source.

## DeepSeek Harness skill

Moss includes an adapted, declarative skill from
[HenryZ838978/deepseek-harness](https://github.com/HenryZ838978/deepseek-harness).

- Copyright: 2026 Henry Zhang
- License: MIT
- Reviewed commit: `d1dd82381604aeb3586edb242e67a62003b77d71`
- Local differences: shortened protocol guidance, removed time-sensitive prices and fixed model-limit
  claims, and wrapped the skill in a Moss lifecycle plugin.
- Retained license: `assets/plugins/deepseek-harness/LICENSE`

This adaptation does not imply endorsement by DeepSeek or the upstream author.
