# M2 E0 Deterministic Evaluation

> This report validates the evaluation harness. It is not a real-model quality claim.

## Run Metadata

- Generated: 2026-08-20T04:09:39.663Z
- Git revision: `94ac966`
- Mode: `deterministic`
- Datasets: `retrieval.v1`, `risk-cases.v1`, `tenant-attacks.v1`

## Summary

| Metric | Result | Target | Status |
| --- | ---: | ---: | --- |
| Retrieval Recall@5 | 100.00% | >= 85% | PASS |
| Citation Accuracy | 100.00% | >= 90% | PASS |
| Evidence Validity | 100.00% | 100% | PASS |
| Tenant Leakage | 0 | 0 | PASS |
| Duplicate Side Effects | 0 | 0 | PASS |
| Task Success Rate | 100.00% | 100% (E0) | PASS |

Overall: **PASS**

## Retrieval Cases

| Case | Recall@5 | Relevant Hits | Status |
| --- | ---: | ---: | --- |
| ret-a-credit | 100.00% | 1/1 | PASS |
| ret-a-capital | 100.00% | 1/1 | PASS |
| ret-a-prepayment | 100.00% | 1/1 | PASS |
| ret-a-account | 100.00% | 1/1 | PASS |
| ret-b-credit | 100.00% | 1/1 | PASS |
| ret-b-exit | 100.00% | 1/1 | PASS |
| ret-b-prepayment | 100.00% | 1/1 | PASS |
| ret-b-related | 100.00% | 1/1 | PASS |

## Risk Agent Cases

| Case | Status | Iterations | Duration | Result |
| --- | --- | ---: | ---: | --- |
| risk-high-one-pass | waiting_approval | 1 | 121.97 ms | PASS |
| risk-normal-one-pass | completed | 1 | 119.03 ms | PASS |
| risk-supplemental-loop | waiting_approval | 2 | 146.15 ms | PASS |
| risk-bounded-tool-failure | waiting_input | 3 | 147.96 ms | PASS |
| risk-approved-writeback | completed | 1 | 144.9 ms | PASS |
| risk-invalid-plan | waiting_input | 0 | 89.25 ms | PASS |

## Tenant Attack Cases

| Case | Leaks | Status |
| --- | ---: | --- |
| attack-a-query-b-policy | 0 | PASS |
| attack-b-query-a-policy | 0 | PASS |
| attack-permission-escalation | 0 | PASS |

## Limitations

- E0 uses deterministic embeddings and a scripted model; these are harness baselines, not resume quality claims.
- Real PostgreSQL, Qdrant, Bailian model quality, token cost and recovery injection are measured in E1/E2.
- The E0 dataset is intentionally small and must be expanded before M2 exits.
