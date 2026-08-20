# M2 E1 Real Evaluation

> Small-sample baseline using real PostgreSQL, Qdrant and Bailian providers.

## Run Metadata

- Generated: 2026-08-20T04:48:18.550Z
- Git revision: `25b5106`
- Model: `qwen3.7-max`
- Embedding: `text-embedding-v4` (256 dimensions)
- Datasets: `retrieval.v1`, `risk-cases.v1`, `tenant-attacks.v1`

## Quality Summary

| Metric | Result | Target | Status |
| --- | ---: | ---: | --- |
| Retrieval Recall@5 | 100.00% | >= 85% | PASS |
| Citation Accuracy | 100.00% | >= 90% | PASS |
| Evidence Validity | 100.00% | 100% | PASS |
| Task Success Rate | 100.00% | baseline | PASS |
| Tenant Leakage | 0 | 0 | PASS |
| Duplicate Side Effects | 0 | 0 | PASS |

Overall: **PASS**

## Latency And Cost

- Agent P50: 5775.27 ms
- Agent P95: 6954.17 ms
- Model input tokens: 8041
- Model output tokens: 1307
- Embedding tokens: 497
- Estimated cost: CNY 0.143793

## Risk Agent Cases

| Case | Status | Iterations | Duration | Result | Issues |
| --- | --- | ---: | ---: | --- | --- |
| risk-high-one-pass | waiting_approval | 1 | 6954.17 ms | PASS | - |
| risk-normal-one-pass | completed | 1 | 3069.17 ms | PASS | - |
| risk-supplemental-loop | waiting_approval | 2 | 5774.35 ms | PASS | - |
| risk-bounded-tool-failure | waiting_input | 3 | 5775.27 ms | PASS | - |
| risk-approved-writeback | completed | 1 | 6131.97 ms | PASS | - |

## Limitations

- This E1 baseline uses a small 8/5/3 dataset and must not be presented as the final 30/20/10 benchmark.
- Cost is estimated from configured unit rates; the Bailian billing console remains the billing source of truth.
- Recovery fault injection and three-run variance are deferred to E2.
