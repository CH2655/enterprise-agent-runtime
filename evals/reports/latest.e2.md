# M2 E2 Aggregate Evaluation

> Three-run baseline using real PostgreSQL, Qdrant and Bailian providers.

## Run Metadata

- Generated: 2026-08-20T05:33:56.320Z
- Git revision: `9e8d1ee`
- Runs: 3
- Model: `qwen3.7-max`
- Embedding: `text-embedding-v4` (256 dimensions)
- Datasets: `retrieval.v2`, `risk-cases.v2`, `tenant-attacks.v2`
- Sample sizes per run: 30/20/10

## Quality Distribution

| Metric | Mean | Min | Max | Std Dev | Target |
| --- | ---: | ---: | ---: | ---: | ---: |
| Retrieval Recall@5 | 100.00% | 100.00% | 100.00% | 0.00% | >= 85% |
| Citation Accuracy | 100.00% | 100.00% | 100.00% | 0.00% | >= 90% |
| Evidence Validity | 100.00% | 100.00% | 100.00% | 0.00% | 100% |
| Task Success Rate | 100.00% | 100.00% | 100.00% | 0.00% | recorded |
| Recovery Pass Rate | 100.00% | 100.00% | 100.00% | 0.00% | 100% |
| Candidate Rejection Rate | 0.00% | 0.00% | 0.00% | 0.00% | <= 10% |

- Tenant leakage across all runs: 0
- Duplicate side effects across all runs: 0
- P50 latency mean/min/max: 5008.95/4849.92/5194.94 ms
- P95 latency mean/min/max: 7107.61/6583.01/7463.3 ms
- Total provider calls: 327
- Total tokens: 121306
- Estimated total cost: CNY 1.750917

## Per-Run Result

| Run | Recall@5 | Citation | Task Success | Recovery | P95 | Result |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| e2-run-1-of-3 | 100.00% | 100.00% | 100.00% | 100.00% | 6583.01 ms | PASS |
| e2-run-2-of-3 | 100.00% | 100.00% | 100.00% | 100.00% | 7463.3 ms | PASS |
| e2-run-3-of-3 | 100.00% | 100.00% | 100.00% | 100.00% | 7276.52 ms | PASS |

## Regression

- Comparable baseline: yes
- Baseline Git revision: `2ebcac2`
- Regression gate: PASS
- Retrieval Recall@5 delta: 0.00%
- Citation Accuracy delta: +21.62%
- Task Success Rate delta: +25.00%
- Recovery Pass Rate delta: 0.00%
- P95 latency delta: -4.12%

Overall: **PASS**

## Limitations

- The 30/20/10 dataset meets the minimum acceptance size but remains synthetic and domain-scoped.
- Three-run variance measures provider nondeterminism at one point in time; it is not a long-term availability claim.
- Cost is estimated from configured rates and must be reconciled with the Bailian billing console.
