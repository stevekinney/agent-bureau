/**
 * The black-box lifecycle contract matrix (AB-268). Registers the shared
 * scenario list from `runner.ts` against every adapter this slice ships —
 * direct `ActiveRun`, the thin `AgentRun` wrapper, a session-owned run, and
 * a Bureau-owned in-memory run — through public APIs only. See each
 * adapter's own module doc for what it supports and why.
 */
import { createAgentRunAdapter } from './adapters/agent-run';
import { createBureauMemoryAdapter } from './adapters/bureau-memory';
import { createDirectRunAdapter } from './adapters/direct-run';
import { createSessionRunAdapter } from './adapters/session-run';
import { runLifecycleContractSuite } from './runner';

runLifecycleContractSuite(createDirectRunAdapter());
runLifecycleContractSuite(createAgentRunAdapter());
runLifecycleContractSuite(createSessionRunAdapter());
runLifecycleContractSuite(createBureauMemoryAdapter());
