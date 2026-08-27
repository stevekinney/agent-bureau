---
'armorer': minor
---

Add stable, revisioned execution handles and lifecycle snapshots for queued, active, waiting, streaming, abort-requested, cleanup-pending, terminal, and unknown-effect work. Compose caller, deadline, and owner cancellation, remove cancelled calls from concurrency queues, expose scoped abort and admission closure, and make tool and toolbox shutdown awaitable with explicit cleanup reports.
