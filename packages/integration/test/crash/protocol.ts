import { z } from 'zod';

/**
 * The closed marker vocabulary the crash fixture (`fixture.ts`) reports as it
 * progresses through one linear, deterministic run (AB-270). The parent
 * harness (`harness.ts`) kills the fixture with `SIGKILL` the instant it
 * observes the marker named by `CrashScenarioOptions.killAtMarker` — every
 * marker before that one is acknowledged with a `{ type: 'proceed' }`
 * command first, so the fixture only ever advances when the parent tells it
 * to. No marker here is ever inferred from timing; each is reported by the
 * fixture itself, synchronously with the state transition it names.
 *
 * AB-271 adds three markers used only by the harder scenarios
 * (`scenarios.ts`): `children-registered` (nested-children, fired once BOTH
 * children are durably registered), `schedule-registered` (the
 * running-schedule-fire scenario, fired once `bureau.createSchedule` commits
 * and the fire's own effect step is dispatched), and `catalog-run-started`
 * (the AB-29 recovery-failure scenario, fired once the `bureau.run()`
 * catalog dispatch is durably checkpointed). None of the original AB-270
 * markers changed meaning.
 */
export const CRASH_MARKERS = [
  'ready',
  'run-started',
  'child-registered',
  'children-registered',
  'effect-attempted',
  'checkpoint-committed',
  'schedule-registered',
  'catalog-run-started',
  'signal-parked',
  'cancellation-recorded',
  'cleanup-completed',
] as const;

export type CrashMarker = (typeof CRASH_MARKERS)[number];

/**
 * The fixed bearer token the optional gateway (AB-275, `fixture.ts`'s
 * `--gateway` flag) is started with. Lives here — a pure data module with
 * no top-level side effects — rather than in `fixture.ts` itself, so
 * `packages/gateway/src/conformance/restart.test.ts` can import it without
 * also importing (and thereby executing) `fixture.ts`'s own `main()`,
 * which runs unconditionally at that module's top level.
 */
export const CRASH_FIXTURE_GATEWAY_AUTH_TOKEN = 'crash-fixture-gateway-test-token';

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

export type JsonValue =
  string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };

const crashMarkerSchema = z.enum(CRASH_MARKERS);

/** One line of structured JSON the fixture writes to its own stdout. */
export const crashFixtureMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('marker'),
    marker: crashMarkerSchema,
    detail: z.record(z.string(), jsonValueSchema).optional(),
  }),
  z.object({
    type: z.literal('observation'),
    label: z.string(),
    value: jsonValueSchema,
  }),
  z.object({
    type: z.literal('fatal'),
    message: z.string(),
    stack: z.string().optional(),
  }),
]);

export type CrashFixtureMessage = z.infer<typeof crashFixtureMessageSchema>;

/** One line of structured JSON the parent harness writes to the fixture's stdin. */
export const crashParentCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('proceed') }),
  z.object({ type: z.literal('cancel') }),
]);

export type CrashParentCommand = z.infer<typeof crashParentCommandSchema>;

/** Encodes one message/command as a single line-delimited JSON line (no trailing newline). */
export function encodeCrashLine(value: CrashFixtureMessage | CrashParentCommand): string {
  return JSON.stringify(value);
}

/**
 * Decodes one line previously produced by {@link encodeCrashLine} back into a
 * {@link CrashFixtureMessage}. Throws (never returns `undefined`) on
 * malformed input — a structured IPC boundary fails loudly on a decode
 * error rather than silently dropping the line.
 */
export function decodeCrashFixtureMessage(line: string): CrashFixtureMessage {
  return crashFixtureMessageSchema.parse(JSON.parse(line));
}

/** Decodes one line previously produced by {@link encodeCrashLine} back into a {@link CrashParentCommand}. */
export function decodeCrashParentCommand(line: string): CrashParentCommand {
  return crashParentCommandSchema.parse(JSON.parse(line));
}
