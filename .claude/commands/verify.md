# Verify

Run the project validation pipeline and report structured results.

## Arguments

$ARGUMENTS — Mode: `quick` or `full` (default: `full`). Optionally `--filter=<package>` to scope to a single package.

## Procedure

Parse the mode and optional filter from $ARGUMENTS.

If a `--filter` is provided, append `--filter=<package>` to each turbo command.

### Quick Mode

Run these steps in order. Stop on the first failure.

1. `turbo run build` — compile all packages
2. `turbo run check-types` — TypeScript type checking

### Full Mode

Run these steps in order. Stop if `build` fails (downstream tasks depend on it). Continue through other failures to report all issues.

1. `turbo run build`
2. `turbo run check-types`
3. `turbo run lint`
4. `turbo run test`

## Output

After running all steps, print a summary:

```
Verification Report (<mode>):
  build:       PASS | FAIL
  check-types: PASS | FAIL
  lint:        PASS | FAIL  (full only)
  test:        PASS | FAIL  (full only)
  Overall:     PASS | FAIL
```

If any step failed, include the first error output below the summary. Keep it concise — the user can re-run individually for full output.

## Reset Edit Counter

After running verify, reset the edit counter by running: `echo 0 > /tmp/agent-bureau-edit-count`
