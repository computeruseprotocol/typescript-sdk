# Contributing to the CUP TypeScript SDK

Thanks for your interest in the Computer Use Protocol! CUP is in early development (v0.1.0) and contributions are welcome.

> For changes to the protocol schema, compact format spec, or role mappings, please contribute to [computeruseprotocol](https://github.com/computeruseprotocol/computeruseprotocol).

## Getting started

1. Fork the repository and clone your fork
2. Install dependencies:

```bash
npm install
```

3. Run the test suite to verify your setup:

```bash
npm test
```

## Making changes

1. Create a branch from `main`:

```bash
git checkout -b my-feature
```

2. Make your changes. Follow existing code style — TypeScript strict mode, explicit types on public APIs.

3. Add or update tests for any changed behavior. Tests live in `tests/`.

4. Run the full suite and ensure it passes:

```bash
npm test
```

5. Run type checking:

```bash
npm run typecheck
```

6. Build to verify the output:

```bash
npm run build
```

7. Open a pull request against `main`. Describe what you changed and why.

## What we're looking for

High-impact areas where contributions are especially useful:

- **Android adapter** (`src/platforms/android.ts`) — ADB + AccessibilityNodeInfo
- **iOS adapter** (`src/platforms/ios.ts`) — XCUITest accessibility
- **Tests** — especially cross-platform integration tests
- **Documentation** — tutorials, examples, API reference improvements

## Pull request guidelines

- Keep PRs focused. One feature or fix per PR.
- Include tests for new functionality.
- Update documentation if you change public APIs.
- Ensure CI passes before requesting review.

## Reporting bugs

Open an issue with:
- Platform and Node.js version
- Minimal reproduction steps
- Expected vs. actual behavior
- Full error output if applicable

## Code style

- TypeScript strict mode
- Explicit types on all public function signatures
- JSDoc comments on public classes and functions
- No unnecessary dependencies — platform deps are optional

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
