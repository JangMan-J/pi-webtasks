> ## Documentation Index
> Fetch the complete documentation index at: https://docs.parallel.ai/llms.txt
> Use this file to discover all available pages before exploring further.

# Parallel API Pricing

<div className="sr-only" aria-hidden="false">
  For AI agents: a documentation index is available at [https://docs.parallel.ai/llms.txt](https://docs.parallel.ai/llms.txt). The full text of all docs is at [https://docs.parallel.ai/llms-full.txt](https://docs.parallel.ai/llms-full.txt). You may also fetch any page as Markdown by appending `.md` to its URL or sending `Accept: text/markdown`.

  For Search and Extract, use `/v1/search` and `/v1/extract` for all new integrations and agent tool calls. Use `/v1beta/search` and `/v1beta/extract` only when maintaining an existing integration that already uses them. Do not substitute `/v1` for the documented FindAll or Ingest endpoint paths.
</div>

## Summary

<div className="pricing-summary">
  | API                                                                          | Pricing (USD)                                                                                                                                           | Timing & processing                                         |
  | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
  | **Search**<br />Pages and excerpts for latency-sensitive queries             | **\$1–\$5** / 1,000 requests<br /><br />Includes 10 results per request.<br />Additional results: \$1 / 1,000.<br /><br />[Mode pricing →](#search-api) | **200 ms–3 s**<br />Synchronous<br />Reasoning: n/a         |
  | **Extract**<br />Retrieve page content                                       | **\$1** / 1,000 URLs                                                                                                                                    | **1–20 s**<br />Synchronous<br />Reasoning: n/a             |
  | **Task**<br />Deep research, enrichment and custom research                  | **\$5–\$2,400** / 1,000 successful runs<br /><br />One charge per run, regardless of output fields.<br /><br />[Processor pricing →](#task-api)         | **10 s–2 hr**<br />Asynchronous<br />Reasoning: low to high |
  | **Responses**<br />Answers grounded in live web research (OpenAI-compatible) | **\$10–\$250** / 1,000 successful requests<br /><br />[Reasoning tier pricing →](#responses-api)                                                        | **5–60 s**<br />Synchronous<br />Reasoning: low to high     |
  | **Monitor**<br />Always-on web monitoring                                    | **\$3–\$10** / 1,000 checks<br /><br />Each execution counts as one check.<br /><br />[Processor pricing →](#monitor-api)                               | **Ongoing**<br />Asynchronous<br />Reasoning: low           |
  | **FindAll**<br />Build verified lists and databases                          | **\$0.25** / run + **\$0.03** / match<br /><br />Base tier<br />Enrichment billed separately.<br /><br />[All tiers & preview pricing →](#findall-api)  | **10 s–2 hr**<br />Asynchronous<br />Reasoning: low to high |
  | **Entity Search**<br />Find people and companies                             | **\$5** / 1,000 requests<br /><br />Includes 100 results per request.<br />Additional results: \$0.05 / 1,000.                                          | **1–3 s**<br />Synchronous<br />Reasoning: n/a              |
</div>

## Web Tools

### Search API

By default, the Search API returns 10 page results and their excerpts per request. Pricing varies by [mode](/search/modes).

| Component                                                     | Cost (\$/1000) |
| ------------------------------------------------------------- | -------------- |
| Per 1,000 `turbo` or `fast` requests (default 10 results)     | 1              |
| Per 1,000 `basic` or `advanced` requests (default 10 results) | 5              |
| Per 1,000 additional page results & excerpts                  | 1              |

**Cost formula (`turbo` / `fast`):**

$$
\text{total cost} = 0.001 + (0.001 \times \text{additional results \& excerpts})
$$

**Cost formula (`basic` / `advanced`):**

$$
\text{total cost} = 0.005 + (0.001 \times \text{additional results \& excerpts})
$$

### Extract API

| Component      | Cost (\$/1000) |
| -------------- | -------------- |
| Per 1,000 URLs | 1              |

## Web Agents

### Task API

Task API pricing is based on the [processor](/task-api/guides/choose-a-processor) you select. Cost is per 1,000 Task Runs. Fast processors have the same pricing as their standard counterparts.

<Tabs>
  <Tab title="Standard">
    | Processor | Cost (\$/1000) | Latency      | Strengths                                    |
    | --------- | -------------- | ------------ | -------------------------------------------- |
    | `lite`    | 5              | 10s - 60s    | Basic metadata, fallback, low latency        |
    | `base`    | 10             | 15s - 100s   | Reliable standard enrichments                |
    | `core`    | 25             | 60s - 5min   | Cross-referenced, moderately complex outputs |
    | `core2x`  | 50             | 60s - 10min  | High complexity cross referenced outputs     |
    | `pro`     | 100            | 2min - 10min | Exploratory web research                     |
    | `ultra`   | 300            | 5min - 25min | Advanced multi-source deep research          |
    | `ultra2x` | 600            | 5min - 50min | Difficult deep research                      |
    | `ultra4x` | 1200           | 5min - 90min | Very difficult deep research                 |
    | `ultra8x` | 2400           | 5min - 2hr   | The most difficult deep research             |
  </Tab>

  <Tab title="Fast">
    | Processor      | Cost (\$/1000) | Latency      | Strengths                                    |
    | -------------- | -------------- | ------------ | -------------------------------------------- |
    | `lite-fast`    | 5              | 10s - 20s    | Basic metadata, fallback, lowest latency     |
    | `base-fast`    | 10             | 15s - 50s    | Reliable standard enrichments                |
    | `core-fast`    | 25             | 15s - 100s   | Cross-referenced, moderately complex outputs |
    | `core2x-fast`  | 50             | 15s - 3min   | High complexity cross referenced outputs     |
    | `pro-fast`     | 100            | 30s - 5min   | Exploratory web research                     |
    | `ultra-fast`   | 300            | 1min - 10min | Advanced multi-source deep research          |
    | `ultra2x-fast` | 600            | 1min - 20min | Difficult deep research                      |
    | `ultra4x-fast` | 1200           | 1min - 40min | Very difficult deep research                 |
    | `ultra8x-fast` | 2400           | 1min - 1hr   | The most difficult deep research             |
  </Tab>
</Tabs>

<Note>
  Pricing is per Task Run (row), not per output field (cell). A single Task Run can populate many output fields—whether you request 1 field or 20 fields, the cost is the same.
</Note>

<Note>
  You are only charged for successfully completed runs. Failed runs are not billed.
</Note>

### Responses API

[Responses API](/responses-api/responses-quickstart) pricing is based on the `reasoning.effort` tier you select. Cost is per 1,000 requests. You are only charged for successful responses.

| Reasoning effort   | Cost (\$/1000) | Latency  | Designed for                                                     |
| ------------------ | -------------- | -------- | ---------------------------------------------------------------- |
| `low`              | 10             | \~5-10s  | Simple fact-retrieval questions                                  |
| `medium` (default) | 50             | \~15-20s | Multi-hop fact-retrieval questions                               |
| `high`             | 250            | \~30-60s | Deep-research questions requiring extensive search and synthesis |

### Monitor API

Monitor requests are priced per execution on a per-thousand (CPM) basis. Choose a processor based on query scope; both tiers deduplicate and reason over results.

| Processor | Cost (\$/1000) | Best for                                                 |
| --------- | -------------- | -------------------------------------------------------- |
| `lite`    | 3              | Narrow queries — a single entity, domain, or signal type |
| `base`    | 10             | Wide queries — entity classes, topic areas, regions      |

**Cost formula:**

$$
\text{total cost} = \text{cost per 1,000} \times \text{number of executions} / 1000
$$

### FindAll API

FindAll API pricing is based on the [generator](/findall-api/core-concepts/findall-generator-pricing) you select, with a fixed cost plus a per-match cost.

| Generator | Fixed Cost | Per Match | Best For                                                  |
| --------- | ---------- | --------- | --------------------------------------------------------- |
| `preview` | \$0.10     | \$0.00    | Testing queries (\~10 candidates)                         |
| `base`    | \$0.25     | \$0.03    | Broad, common queries where you expect many matches       |
| `core`    | \$2.00     | \$0.15    | Specific queries with moderate expected matches           |
| `pro`     | \$10.00    | \$1.00    | Highly specific queries with rare or hard-to-find matches |

**Cost formula:**

$$
\text{total cost} = \text{fixed cost} + (\text{cost per match} \times \text{\# matches})
$$

If you add [enrichments](/findall-api/features/findall-enrich), each enrichment adds its own per-match cost based on the Task API processor you choose (see Task API pricing above).

#### Entity Search

[Entity Search](/findall-api/entity-search) is a fast, synchronous people-and-company search, the real-time counterpart to FindAll. It is priced per request, including 100 results by default.

| Component                                | Cost (\$/1000) |
| ---------------------------------------- | -------------- |
| Per 1,000 requests (default 100 results) | 5              |
| Per 1,000 additional results             | 0.05           |

**Cost formula:**

$$
\text{total cost} = 0.005 + (0.00005 \times \text{additional results})
$$
