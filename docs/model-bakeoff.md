# Builder model bake-off (2026-10-05)

Real run on account `4773fbab...` through AI Gateway `queenos`, using the **actual drone code**
(`apps/drones/src/{prompt,generate,change-set,build}.ts`) in a throwaway Worker `queenos-day1-models`
(deleted afterwards; `wrangler delete` succeeded, the workers.dev URL returns 404, and it is absent from
the account's script list). Each model got one request, no fallbacks, `response_format: json_schema`
(accepted by all six), the real system prompt, and the `templates/worker-starter` file list + key files
(`src/features/index.js`, `src/index.js`, `.queen/deploy.json`) as context (~1.4k input tokens).

Prompts: (a) "Add a /status endpoint that reports uptime", (b) "Add a /quote endpoint returning a random quote from a list of 5".

Checks per result: valid change set (first try / after the one repair turn / failed), wall latency (one model
call), output size, and a static template-fit check: acorn parses every `.js` as an ES module, every import is
relative and resolves, the feature module exports `slug` and `handle`, the model registered its module in
`src/features/index.js` itself, and the registry still holds the module after `withMergedRegistry`. No model
touched `src/index.js`. (Actually evaluating the modules was not possible inside a Worker; static checks only.)

| Model | Prompt | Result | Latency | Output chars (out tokens) | Code bytes | Fits template |
|---|---|---|---|---|---|---|
| kimi-k2.7-code | status | first try | 21.2 s | 1012 (351) | 475 | yes, self-registered |
| kimi-k2.7-code | quote | first try | 17.5 s | 1788 (1046) | 1017 | yes, self-registered |
| glm-5.3 | status | first try | 29.3 s | 1666 (1474) | 927 | yes, self-registered |
| glm-5.3 | quote | first try | 150.9 s | 2073 (3681) | 1129 | yes, self-registered |
| deepseek-v4-pro-0813 | status | first try | 12.9 s | 755 (532) | 349 | yes, self-registered |
| deepseek-v4-pro-0813 | quote | first try | 14.5 s | 1016 (534) | 588 | yes, self-registered |
| glm-5.3-flash | status | first try | 24.5 s (1) | 1660 (516) | 853 | yes, self-registered |
| glm-5.3-flash | quote | first try | 18.7 s | 1500 (658) | 805 | yes, self-registered |
| deepseek-v4-flash-0731 | status | first try | 11.3 s | 874 (737) | 383 | yes, self-registered |
| deepseek-v4-flash-0731 | quote | first try | 22.2 s | 1323 (1462) | 749 | yes, self-registered |
| qwen3.8-27b | status | first try | 19.0 s | 1185 (726) | 452 | yes, self-registered |
| qwen3.8-27b | quote | first try | 42.4 s | 984 (933) | 537 | yes, self-registered |

(1) The first call took 24.5 s; a repeat of the identical request was served from the gateway in 0.3 s.

Result: 12/12 valid on the first try, 0 repairs, 0 failures, 12/12 fit the template. The repair turn and
model fallback are therefore insurance, not the common path, with this prompt. Sample size is small (2 prompts,
1 run each): treat the latency ordering as indicative. Observations:

- All six accept `response_format: {type: "json_schema"}` and return clean JSON in `choices[0].message.content` or `response`.
- GLM-5.3 reasons for a long time ("reasoning cannot be disabled"); the quote prompt used 3.7k output tokens and 151 s.
  That is inside the 5 minute step limit but is the one case that came close to the drone's 200 s per-build time budget
  (the drone skips starting another model once 200 s have elapsed).
- Models stuck to the template: slug-named modules, no top-level routes (`/status` is served at `/features/status`),
  no router edits. Some add a `.md` doc (`features/<slug>.md`, or `src/features/<slug>.md`, which is harmless).

## Recommended catalog order (apply in `MODEL_CATALOG`)

Order within a tier = default preference before track record exists (reliability first, then latency, then cost).

- **frontier:** `@cf/deepseek-ai/deepseek-v4-pro-0813`, `@cf/moonshotai/kimi-k2.7-code`, `@cf/zai-org/glm-5.3`
  (DeepSeek Pro was fastest and terse; Kimi consistent at 17-21 s; GLM-5.3 correct but slow and the most variable).
- **fast:** `@cf/deepseek-ai/deepseek-v4-flash-0731`, `@cf/zai-org/glm-5.3-flash`, `@cf/qwen/qwen3.8-27b`
  (DeepSeek Flash 11-22 s; GLM Flash 19-25 s and the configured default; Qwen valid but up to 42 s).
- **light** (scribe/genesis, not builder-tested): keep `@cf/zai-org/glm-4.7-flash` first, then granite, then llama-3.2-3b.

Suggested fallback chains for the Queen: fast tier `deepseek-v4-flash -> glm-5.3-flash -> qwen3.8-27b`;
frontier `deepseek-v4-pro -> kimi-k2.7-code -> glm-5.3` (put the slow reasoner last, never as the only choice).
