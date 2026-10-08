# Legacy nine-tool tests

These files exercise the replaced nine-tool `parallel_*` interface (registration, lazy activation,
per-tool request contracts, guidance, Monitor/Group/FindAll wiring). The extension now registers
exactly `web_search`, `interactive_search` and `deep_search`, so these tests cannot run against it.

They are kept intact (only relative import paths adjusted) as a reference of previously verified
behavior and are deliberately outside the default `tests/*.test.ts` glob. Where a behavior carries
over (readable evidence, receipts, artifacts), the default suite covers it through the new tools or
the unchanged `results.ts`/`evidence.ts` unit tests. They also depend on `tests/helpers/test-host.ts`
as it was before the three-tool change (`execute("task", ...)` addressed `parallel_task`); to revive
one, restore that helper behavior.
