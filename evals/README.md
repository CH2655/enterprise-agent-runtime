# M2 Evaluation

The evaluation module is separate from unit and integration tests:

- tests prove deterministic contracts and failure handling;
- evaluations measure retrieval, citation, workflow and isolation quality on versioned datasets.

Run the zero-cost E0 baseline:

```bash
pnpm eval:m2
```

The command writes machine-readable JSON and a reviewable Markdown report to `evals/reports/`.
E0 deliberately uses `ScriptedModelProvider`, deterministic embeddings and in-memory infrastructure.
Its scores validate the harness only and must not be used as resume claims.

## Dataset Rules

- Keep stable case IDs and increment the dataset version when expected behavior changes.
- Label retrieval ground truth by document key and section; the runner resolves generated Chunk IDs.
- Label business facts and required evidence categories, not exact model wording.
- Never add production customer data, credentials or unredacted documents.

## Next Modes

- E1 uses real PostgreSQL, Qdrant and Bailian providers plus token/cost telemetry:

```bash
pnpm db:up
pnpm eval:m2:real
```

The real runner creates a temporary PostgreSQL database and Qdrant collection, then removes both
in a `finally` block. It never reuses development Run or knowledge data. Unit prices are explicit
environment inputs so a report records the cost assumptions used at execution time.

- E2 repeats real-model runs, injects recovery failures and compares regressions across revisions.

```bash
pnpm eval:m2:e2
```

E2 always uses the versioned 30/20/10 `v2` datasets. It runs three times by default, records
mean/min/max/standard deviation, aggregates token cost, and compares compatible metrics with the
previous `latest.e2.json`. Set `EVAL_E2_RUNS=1` only for a paid smoke run; a one-run report is not a
variance baseline.
