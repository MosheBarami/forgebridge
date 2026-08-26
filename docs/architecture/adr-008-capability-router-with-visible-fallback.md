# ADR-008: Capability-based routing with visible fallback

## Status
Accepted

## Context
Hundreds of models, wildly different capabilities (tool calling, structured output,
context window, vision), and free models that rate-limit hard. A run must survive a 429
without the user babysitting it — but a silent substitution is a lie about what wrote the
code, and in a codegen tool that is a serious lie.

## Options considered
| Option | Pros | Cons | Complexity | When valid |
|---|---|---|---|---|
| A. User picks one model, failures surface | Maximum honesty; trivial | Free models 429 constantly; miserable UX | Low | Expert tools |
| B. Silent automatic fallback | Smooth | User cannot know what produced their code; unreproducible | Medium | Chat products |
| C. **Capability filter + policy ordering + fallback, all logged** | Robust *and* honest | More moving parts; log must be surfaced well | Medium | This product |

## Decision
**Option C.** Per run: filter the registry by required capabilities, order by the user's
policy (`free-first` | `fastest` | `cheapest` | `best` | `pinned`), attempt in order, and
record every attempt with its outcome. A per-provider circuit breaker suppresses known-bad
providers. The run log naming each attempt is part of the run's permanent record.

### Health signals come from upstream, not only from our own failures

The first live catalog pull confirmed OpenRouter exposes, per model *endpoint*: 5-minute /
1-day / 30-minute uptime, p50–p99 latency, p50–p99 throughput, quantisation, zero-data-retention
tags, and a status flag. `z-ai/glm-5.2` alone is served by roughly thirty endpoints whose p50
latency spans 480 ms to 7.7 s and whose 1-day uptime spans 75% to 100%.

So the breaker does not have to learn everything the hard way. It seeds from published health and
then *overrides* with what we actually observe — a provider that is green upstream but failing for
us is still opened. Learning only from our own 429s would mean every user pays for the same
discovery.

### Provider metadata makes a privacy policy possible

The provider list carries headquarters country, datacenter regions, privacy-policy and
terms-of-service URLs, and status pages for roughly a hundred providers. That turns two policies
that would otherwise be undeliverable into ordinary filters: `region: 'eu'` and `zdr: true`
(zero data retention). For a project whose pitch is "your keys and your code stay yours", being
able to say *which jurisdictions a run may touch* is worth more than another point of benchmark.

## Rationale
1. Capability filtering is not optional — the pipeline requires tool calling and structured
   output, and offering a model that lacks them produces a confusing failure deep in a run.
2. The honesty requirement is architectural, not cosmetic: reproducing a run means knowing
   which model actually ran.
3. `pinned` exists so a user who wants exactly one model can have exactly one model, and
   see it fail.

## Trade-offs
A run can cost more or take longer than the user's first choice implied. Fallback across
providers means output quality varies within a single project's history.

## Consequences
- **Positive**: free models become usable despite rate limits; runs are reproducible.
- **Negative**: variable quality and latency; a busy run log.
- **Mitigation**: the log is collapsed to one line ("Ox Alpha → rate limited → Hy3") and
  expands on click; `pinned` policy disables fallback entirely.

## Revisit trigger
If users routinely pin a model to escape fallback surprise, the default policy is wrong and
should become `pinned` with fallback as opt-in.
