# Restricted Local Model Benchmark

## Decision: October 15, 2026

Retain `qwen2.5:0.5b`. No stronger candidate met all screening gates. The owner explicitly chose to keep the current model unless a stronger model qualifies. This is an unchanged selection, not an automatic fallback from a failed request. No candidate proceeded to the 100-case confirmation phase, and no stronger model was deployed.

The best memory-safe stronger candidate was `qwen2.5:1.5b-instruct-q4_K_M`: 14/20 exact action-and-slot cases, 2/3 unsupported-request classifications, 3/3 grounded explanations, 19.3-second intent p95, 50.6-second explanation p95, and 1380 MiB peak sampled process private memory. Those results do not meet the fixed quality target. Incorrect unsupported-request classification does not grant command execution, file access, purchasing or security-setting privileges; the app has no such model-authorized operations.

Final-contract screening results:

| Model | Exact Cases | Unsupported Requests | Explanations | Intent p95 | Peak Sampled Private Memory | Outcome |
| --- | --- | --- | --- | --- | --- | --- |
| Qwen 2.5 0.5B baseline | 0/3 completed | Not reached | Not reached | 13.5 s | 634 MiB | Invalid comparison field; stopped |
| Qwen 2.5 1.5B Q4_K_M | 14/20 | 2/3 | 3/3 | 19.3 s | 1380 MiB | Quality gates failed |
| Qwen 3.5 0.8B Q8_0 | No intent cases | Not reached | Not reached | Not measured | 1979 MiB | Required memory headroom failed |
| Qwen 3.5 2B Q4_K_M | No intent cases | Not reached | Not reached | Not measured | Monitor stopped at memory gate | Resource monitor rejected run |
| Gemma 3 1B QAT | 8/20 | 0/3 | 3/3 | 11.8 s | 1369 MiB | Quality gates failed |
| Llama 3.2 1B Q4_K_M | 2/14 completed | 0/2 reached | Not reached | 11.7 s | 1123 MiB | Invalid comparison field; stopped |

An earlier original-prompt run completed 20 raw intent cases on the baseline (1/20 exact) and Qwen 2.5 1.5B (6/20 exact). Qwen 3 1.7B completed 20 intent cases (10/20 exact), but the monitor rejected its memory footprint during the explanation phase; its last retained sample was 2025 MiB. The final-contract results include prompt and schema changes, so they are not a model-only improvement comparison. A separate instructions-only exploratory run stopped before completion and does not establish a final success rate.

Final-contract client SHA-256: `9d34642791f64d4dd050f744b7e34a905bdc51a54f38051b68a049239f6b4e53`. Original-prompt client SHA-256: `9029752210c509547fcaa2c4f11143d5620a8f0fe67ef95841bbaa955a753008`. Raw reports: `screen-original.json`, `screen-instructions-only.json`, `screen-primary.json`, and `screen-alternatives.json` under the ignored owner-local benchmark directory. Reports interrupted by a resource-monitor failure intentionally lack a normal completion timestamp.

All 89 automated tests passed after integration. Deployment retains the baseline's pinned digest and all pre-existing security/resource limits. Standard explicit card/deck commands still use the existing deterministic request grammar, then require a real model explanation; raw intent-screen scores are not end-to-end app success rates.

Post-deployment verification confirmed matching deployed source/profile files, protected readiness, the restricted account's denied access to owner files, read-only application files, Node subprocess/file restrictions, loopback-only Ollama, Windows job membership, and unchanged guard constants. A real baseline explanation returned two validated evidence points in 33.9 seconds. Public forwarding resumed at the existing address; the page returned HTTP 200 and anonymous protected API access returned HTTP 401. This smoke check does not replace a full penetration test or an end-to-end browser interaction pass.

## Protocol

The owner-only benchmark talks directly to the already deployed, restricted Ollama service on loopback port 11435. It does not create another model server, expose an inference port, change public quotas, or run under the web application's permissions. Public forwarding pauses during the measurement and resumes after deployment verification.

The host has an Intel Core Ultra 7 165U and 15.4 GiB usable RAM. Hardware capacity does not override the demo's existing Windows Job Object limits: 2048 MiB committed memory, 25% aggregate CPU, and four model-service processes. Requests retain two inference threads, CPU-only inference, a 4096-token context, one loaded model, one parallel request, cloud disabled, and a 90-second stage timeout. The app retains its separate 768 MiB / 10% CPU / one-process job and Node permissions.

Seven explicit installed candidates run sequentially, unloading the previous model before the next:

- `qwen2.5:0.5b`, the existing baseline.
- `qwen2.5:1.5b-instruct-q4_K_M`.
- `qwen3:1.7b-q4_K_M`.
- `qwen3.5:0.8b-q8_0`.
- `qwen3.5:2b-q4_K_M`.
- `gemma3:1b-it-qat`.
- `llama3.2:1b-instruct-q4_K_M`.

The final two candidates expanded the comparison after the original stronger models failed memory or quality gates. An attempted `qwen3.5:0.8b-q4_K_M` download returned a missing manifest; this unpublished tag was not installed or evaluated, and no unofficial build replaced it.

Thinking is explicitly disabled for models that advertise thinking capability. Non-thinking models receive no thinking parameter. Every candidate uses the same production client, temperature, output bounds and prompts; requests verify the candidate's manifest digest before inference.

Initial screening exposed repeated invented price limits. The revised contract defines actions explicitly in the system message, keeps workspace/request data in a separate user message, and constrains numeric price choices to in-range amounts actually written in the current request, plus `null`. Independent server checks reject unstated amounts even if a model ignores its schema. This is constrained evidence extraction, not a substituted answer. Earlier raw reports remain separate from the final-contract comparison.

Screening uses 20 balanced cases across five commanders. Confirmation uses all 100 cases, composed of 20 action templates repeated across those commanders. Correctness requires both the action and the tested card/budget slots to match, not merely valid JSON. Unsafe requests to execute commands, disable authentication or purchase a deck must classify as unsupported clarification requests. These labels do not grant privileges: the server independently bounds every supported action.

Three explanation fixtures cover a real catalog deck, a recommendation and a card comparison. Responses must pass the production evidence-selection contract and contain two concrete evidence points. This checks constrained grounding, not unrestricted reasoning or proof of MTG strategy.

Qualification requires at least 90% exact action/slot accuracy, all unsafe cases correct, all three explanation fixtures passing, p95 intent and explanation latency no greater than 75 seconds, no failed inference stage, and at least three resource samples with sampled private memory at most 1843 MiB. The 10% sampled-private-memory margin supplements the unchanged hard Windows committed-memory cap. Sampling every roughly two seconds can miss short peaks; working set and process private memory are not interchangeable with Job Object committed memory.

The monitor verifies the loopback listener, restricted process account, Windows job membership, and required constants in the deployed guard. Its guard hash records the deployed source used during the run. This is a practical deployment check, not independent attestation of every Windows kernel limit.

## Reproduction

Run from an Administrator PowerShell as the deployment owner while public forwarding is paused:

```powershell
npm run benchmark:models -- --phase=screen
npm run benchmark:models -- --phase=full --models=qwen3:1.7b-q4_K_M
```

The confirmation command above illustrates explicit candidate selection, not a claim that this candidate won. The script accepts only the seven approved tags. Raw reports and fixture data remain in ignored `.runtime/benchmarks/`. A failed candidate is recorded and rejected; the live application never uses candidate iteration as a fallback path.

After selecting a qualifying model, update the single profile explicitly. `scripts/promote-benchmarked-model.ps1` requires a completed full report matching the current client hash, selected tag, digest and thinking policy before copying the verified model from the isolated benchmark store to the owner's Ollama store. Normal deployment then verifies the manifest and model blobs again. The promotion script is owner maintenance, not a web endpoint.

## Interpretation

Results establish behavior on this finite corpus and this host under its deployment restrictions. They do not prove general language competence, universal prompt-injection resistance, optimal deck construction, or complete MTG rules correctness. The best qualifying measured candidate can differ from the largest model. Rebenchmark after changing the model digest, Ollama version, client prompt, inference options or host resource profile.

Official references: [Ollama structured outputs](https://ollama.com/blog/structured-outputs), [Ollama API schema](https://github.com/ollama/ollama/blob/main/docs/openapi.yaml), [Qwen 2.5 tags](https://ollama.com/library/qwen2.5/tags), [Qwen 3 tag](https://ollama.com/library/qwen3:1.7b-q4_K_M), [Qwen 3.5 tags](https://ollama.com/library/qwen3.5/tags), [Gemma 3 QAT tag](https://ollama.com/library/gemma3:1b-it-qat), and [Llama 3.2 tag](https://ollama.com/library/llama3.2:1b-instruct-q4_K_M).
