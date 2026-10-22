# 2026-10-22 Langfuse rollout

- UI/API base: https://ai-tutor-helper.corp.youdao.com/langfuse
- Upstream: Langfuse v4.66.0, commit `29a40eb027c5f4bb8c72c2f6d2d7e98aa1ce0cbf`.
- Source patch: [`../../patches/reasoning-content.patch`](../../patches/reasoning-content.patch).
- Patch SHA-256: `e8a6e511e34aecb0571619c18857f359318b38f1b34dd2bd597a5d814acbb44f`.
- Deployed image: `context-lab/langfuse-web:4.66.0-reasoning-subpath`.
- Image ID: `sha256:585bf768162bb925f5186e76255ea8b04c388216840e5c5970b937a05c136be5`.

`build-receipt.json` and `build-provenance.json` record the verified Linux x64
source build, embedded `/langfuse` path, compiler, tools and image identity.
TypeScript, 87 static pages, the OTel ingestion worker smoke test and the
385-file client-bundle scan passed. No compiled JavaScript was edited by hand.

`evidence.json` preserves the exact five-arm experiment used for this deployment.
Its SHA-256 is `790c39c98c786a07c403c77e85497325db5b6213cc019be5e0c5a33e23f348af`.
`import-receipt.json` contains only the dataset/experiment identifiers needed
for read-only verification. `data-verification.json` records all 51 observations,
25 scores, 17 generations and 23,302 tokens, with exact recorded inputs,
outputs and parents matching the pre-rollout baseline.

Browser review verified login with the existing account and expanded Thinking
in Formatted. The full-context second generation has both historical and current
Thinking; the no-reasoning arm has only current Thinking. Raw observations were
preserved, and the deployment did not rerun or re-import the experiment.

`gateway-verification.json` records HTTPS health, Android downloads and a real
APK byte-range response. Retired tutor routes remained offline. Runtime secrets,
login passwords, VM disks and build caches are intentionally excluded from Git.
