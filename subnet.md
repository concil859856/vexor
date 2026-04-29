# Vocence Subnet 78 — Technical Knowledge Base

A detailed technical reference for the **Vocence** voice intelligence subnet on Bittensor (Subnet 78). Use this to answer questions about architecture, scoring, miner/validator flows, APIs, and code locations.

**Repository:** [https://github.com/vocence-78/vocence](https://github.com/vocence-78/vocence)

---

## Table of contents

1. [Big picture](#1-big-picture)
2. [Repository structure and file map](#2-repository-structure-and-file-map)
3. [Roles (miner, validator, owner)](#3-roles-miner-validator-owner)
4. [Scoring and winner selection](#4-scoring-and-winner-selection)
5. [Miner: engine contract, Chutes, wrapper](#5-miner-engine-contract-chutes-wrapper)
6. [Validator: sample generation and weight setting](#6-validator-sample-generation-and-weight-setting)
7. [Owner, base model, and burn key](#7-owner-base-model-and-burn-key)
8. [Configuration (env and config.py)](#8-configuration-env-and-configpy)
9. [APIs and endpoints](#9-apis-and-endpoints)
10. [CLI reference](#10-cli-reference)
11. [Documentation index](#11-documentation-index)
12. [Reference links](#12-reference-links)
13. [Quick answers (FAQ)](#13-quick-answers-faq)

---

## 1. Big picture

### What is Vocence?

**Vocence** is a **Bittensor subnet** (Subnet 78) focused on **voice intelligence**: development and evaluation of models for Prompt-based Text-to-Speech (PromptTTS), Speech-to-Text (STT), Speech-to-Speech (STS), voice cloning, and related multimodal voice tasks.

- **Current focus (Q1):** **PromptTTS** — miners deploy models that generate speech from **text + natural-language voice instructions** (e.g. “A calm middle-aged male voice with a warm tone, speaking slowly…”). Validators score them on content correctness, audio quality, and prompt adherence.
- **Incentive model:** Decentralized marketplace: miners compete on measurable performance; validators run a shared evaluation pipeline and set weights on chain; rewards follow a **winner-take-all** rule with a **”beat predecessors by threshold”** condition (see [§4](#4-scoring-and-winner-selection)). Additionally, each hotkey is limited to a maximum of **2** valid on-chain commits after block 8,081,000 — exceeding this cap marks the miner invalid.

### Why Bittensor?

- Miners compete on **measurable model performance** (no central gatekeeper).
- Validators are rewarded for running evaluation correctly.
- Model artifacts stay **open and reproducible** (Hugging Face + Chutes).
- Subnet uses the chain for registration, weight assignment, and incentives; evaluation data and samples live in **Hippius** (S3-compatible) and optional DB.

### Ecosystem integration

- **Chutes** ([chutes.ai](https://chutes.ai)): model deployment; miners deploy as Chutes, validators call miner Chutes for `/speak`.
- **Hippius**: corpus bucket (owner uploads source audio), validator buckets (samples and metadata).
- **Owner API**: centralized service for valid miner list, blocklist, evaluation submission, metrics; validators and owner use it; see [§9](#9-apis-and-endpoints).

---

## 2. Repository structure and file map

All paths and links refer to: [https://github.com/vocence-78/vocence](https://github.com/vocence-78/vocence) (branch `master`).

### Top-level layout

| Path | Purpose |
|------|--------|
| [README.md](https://github.com/vocence-78/vocence/blob/master/README.md) | Project overview, roles, credentials, quick starts |
| [pyproject.toml](https://github.com/vocence-78/vocence/blob/master/pyproject.toml) | Python 3.12+, deps (bittensor, minio, openai, audiojudge, chutes, etc.), CLI entry `vocence = vocence.gateway.cli.main:cli` |
| [env.example](https://github.com/vocence-78/vocence/blob/master/env.example) | Example env vars for miner, validator, owner |
| [Dockerfile](https://github.com/vocence-78/vocence/blob/master/Dockerfile) | Validator image (used by Docker + Watchtower) |
| [docker-compose.yml](https://github.com/vocence-78/vocence/blob/master/docker-compose.yml) | Validator + Watchtower stack |
| [CHANGELOG.md](https://github.com/vocence-78/vocence/blob/master/CHANGELOG.md) | Version history (e.g. v0.1.0) |

### Package `vocence/` — core logic

| Module | Purpose | Key files |
|--------|--------|-----------|
| [vocence/domain](https://github.com/vocence-78/vocence/tree/master/vocence/domain) | Config and domain types | [config.py](https://github.com/vocence-78/vocence/blob/master/vocence/domain/config.py) — all env-driven settings (cycle, scoring, Hippius, Chutes, base model, burn UID) |
| [vocence/engine](https://github.com/vocence-78/vocence/tree/master/vocence/engine) | Validator orchestration | [coordinator.py](https://github.com/vocence-78/vocence/blob/master/vocence/engine/coordinator.py) — sample generation loop, weight-setting cycle, winner selection, `set_weights` |
| [vocence/ranking](https://github.com/vocence-78/vocence/tree/master/vocence/ranking) | Score calculation | [calculator.py](https://github.com/vocence-78/vocence/blob/master/vocence/ranking/calculator.py) — read samples from S3, compute win rates (last N evals) |
| [vocence/pipeline](https://github.com/vocence-78/vocence/tree/master/vocence/pipeline) | Sample generation | Pipeline: corpus → transcription/traits (GPT) → miner `/speak` → forced-choice eval → upload to validator bucket |
| [vocence/adapters](https://github.com/vocence-78/vocence/tree/master/vocence/adapters) | External services | Storage (Hippius/Minio), API client (owner) |
| [vocence/gateway](https://github.com/vocence-78/vocence/tree/master/vocence/gateway) | CLI entry | [cli/main.py](https://github.com/vocence-78/vocence/blob/master/vocence/gateway/cli/main.py) — `vocence serve`, `vocence miner push/commit`, `vocence owner serve`, etc. |
| [vocence/registry](https://github.com/vocence-78/vocence/tree/master/vocence/registry) | Registration / chain | Miner commit, metagraph |
| [vocence/shared](https://github.com/vocence-78/vocence/tree/master/vocence/shared) | Logging, utilities | Shared helpers |

### Miner sample and template

| Path | Purpose |
|------|--------|
| [miner_sample/](https://github.com/vocence-78/vocence/tree/master/miner_sample) | Reference for building a miner |
| [miner_sample/MINER_GUIDE.md](https://github.com/vocence-78/vocence/blob/master/miner_sample/MINER_GUIDE.md) | Repo layout, engine contract, template variables, render/build/deploy, wrapper integrity |
| [miner_sample/chute_template/](https://github.com/vocence-78/vocence/tree/master/miner_sample/chute_template) | Canonical Jinja2 wrapper (only four variables allowed) |
| [miner_sample/example_repo/](https://github.com/vocence-78/vocence/tree/master/miner_sample/example_repo) | Example HF repo layout: `miner.py`, `chute_config.yml`, `vocence_config.yaml` |

### Documentation

| Path | Purpose |
|------|--------|
| [docs/CLI.md](https://github.com/vocence-78/vocence/blob/master/docs/CLI.md) | Full CLI reference (validator, owner, miner, query) |
| [docs/scoring.md](https://github.com/vocence-78/vocence/blob/master/docs/scoring.md) | Full scoring and winner-selection reference (element weights, pass threshold, global scoring, tie-breaks, burn conditions) |
| [docs/validator-setup.md](https://github.com/vocence-78/vocence/blob/master/docs/validator-setup.md) | Docker + Watchtower validator setup |
| [docs/base-model-protocol.md](https://github.com/vocence-78/vocence/blob/master/docs/base-model-protocol.md) | Base model and burn-key protocol (owner ↔ validators) |
| [docs/cicd-pipeline.md](https://github.com/vocence-78/vocence/blob/master/docs/cicd-pipeline.md) | How the validator image is built and published |
| [docs/setup-postgres-vocence.md](https://github.com/vocence-78/vocence/blob/master/docs/setup-postgres-vocence.md) | Optional Postgres for owner API |

---

## 3. Roles (miner, validator, owner)

### Miners

- **What they do:** Train PromptTTS models, publish them on **Hugging Face**, deploy on **Chutes** using the **canonical Vocence wrapper**, expose a single **`/speak`** API (instruction + text → WAV). Rewards come from validator scores (winner-take-all with threshold; see [§4](#4-scoring-and-winner-selection)).
- **Credentials:** Chutes account (deploy with `chutes build` / `chutes deploy`); Hugging Face repo; Bittensor wallet (coldkey + hotkey) to commit on chain. **Chute name must contain `"vocence"`** (case-insensitive) for owner validation.
- **References:** [README — Miners](https://github.com/vocence-78/vocence/blob/master/README.md), [miner_sample/MINER_GUIDE.md](https://github.com/vocence-78/vocence/blob/master/miner_sample/MINER_GUIDE.md), [docs/CLI.md — Miner commands](https://github.com/vocence-78/vocence/blob/master/docs/CLI.md).

### Validators

- **What they do:** Pull the list of **valid** miners from the owner API; run **sample generation** (corpus → GPT transcription/traits → miner `/speak` → forced-choice evaluation) and upload results to their **own Hippius bucket**; every **CYCLE_LENGTH** blocks, compute scores from the last **MAX_EVALS_FOR_SCORING** evaluations and **set weights** (winner-take-all with “beat predecessors by threshold”; burn if no eligible miner).
- **Credentials:** Bittensor wallet; **Chutes permission** (granted by Vocence team) to call miners’ Chutes; **API_URL** (owner API); **Hippius** corpus keys (read) + validator bucket keys (write); **OpenAI** key for AudioJudge (e.g. GPT-4o-audio-preview).
- **References:** [README — Validators](https://github.com/vocence-78/vocence/blob/master/README.md), [docs/validator-setup.md](https://github.com/vocence-78/vocence/blob/master/docs/validator-setup.md), [docs/CLI.md — Validator commands](https://github.com/vocence-78/vocence/blob/master/docs/CLI.md).

### Owner (centralized service)

- **What they do:** Run the **owner API** (participants, evaluations, metrics, blocklist, status); run **participant validation** (Chutes fetch, wrapper integrity, etc.) and mark valid miners; optionally run **source audio downloader** (e.g. LibriVox → corpus bucket). Deploy **base model** Chute(s); never commit on chain; config includes **BASE_MODEL_COMMIT_BLOCK** so miners must beat the base model by the threshold to win.
- **Credentials:** Owner Hippius (corpus bucket); DB if API uses it; Chutes/API as needed for validation.
- **References:** [docs/base-model-protocol.md](https://github.com/vocence-78/vocence/blob/master/docs/base-model-protocol.md), [docs/CLI.md — Owner commands](https://github.com/vocence-78/vocence/blob/master/docs/CLI.md).

---

## 4. Scoring and winner selection

### Evaluation dimensions

Validators measure **three dimensions** (Q1 PromptTTS):

1. **Content correctness** — Does the speech match the requested text?
2. **Audio quality** — Clarity, naturalness, absence of artifacts.
3. **Prompt adherence** — How well does the voice match the requested traits (gender, tone, speed, etc.)?

Evaluation is done via **forced-choice** (e.g. GPT-4o-audio-preview as “AudioJudge”): miner-generated audio vs reference; “win” = judge prefers miner output.

### Where scoring is implemented (v0.1.2+ — global consensus)

As of **v0.1.2** (2026-03-20), scoring is **global across all active validator buckets**, not per-validator. The authoritative reference is [docs/scoring.md](https://github.com/vocence-78/vocence/blob/master/docs/scoring.md).

- **Cross-validator sample reading:** validators load `VALIDATOR_BUCKETS_JSON` from `.env` and read recent evaluation windows from **every active validator bucket**, not just their own. Active validator discovery is served by the owner API (default activity window: `ACTIVE_VALIDATOR_WINDOW_HOURS = 24`).
- **Stake-weighted aggregation:** per-hotkey **binary** win rates across validators are combined with **`sqrt(stake)`** weighting before applying the threshold rule. If all stakes resolve to zero, it falls back to equal weights.
- **Shared helpers:** validator weight-setting and owner-side dashboard metrics go through the same global scoring helpers ([vocence/ranking/global_scoring.py](https://github.com/vocence-78/vocence/blob/master/vocence/ranking/global_scoring.py)), so a single winner is computed subnet-wide.
- **Scores from storage:** [vocence/ranking/calculator.py](https://github.com/vocence-78/vocence/blob/master/vocence/ranking/calculator.py) — reads `metadata.json` from validator Hippius samples buckets; uses only the **most recent N** evaluations (by evaluation_id); computes per-hotkey `wins`, `total`, `win_rate` (binary), `score_sum`, `mean_score` (continuous, diagnostic only); supports `valid_hotkeys` filter.
- **Winner selection and set_weights:** [vocence/engine/coordinator.py](https://github.com/vocence-78/vocence/blob/master/vocence/engine/coordinator.py) — `execute_cycle()`: fetches valid participants + active validators from the owner API, aggregates scores globally, applies the rules below, then calls `subtensor.set_weights()`.
- **Global scoring snapshots** are persisted owner-side for dashboard consumption (miner ranking, winner reasoning, threshold checks, per-validator breakdowns).

### Per-evaluation scoring rubric (element-by-element)

Each miner output is scored on 9 elements using two GPT-4o audio calls (pointwise trait extraction + pairwise naturalness). Weights sum to `1.0`. See [vocence/pipeline/evaluation.py](https://github.com/vocence-78/vocence/blob/master/vocence/pipeline/evaluation.py).

| Element | Weight | Scoring rule |
|---|---|---|
| `script` | **0.30** | `1 − WER(spec.transcription, miner.transcription)`, clamped to `[0, 1]` (Levenshtein on lowercase word tokens) |
| `naturalness` | **0.15** | `1.0` if judge picks miner clip over source for naturalness (randomized order), else `0.0` |
| `gender` | **0.10** | Exact enum match (`1.0` / `0.0`) |
| `speed` | **0.10** | Ordinal (exact=1.0, ±1 bucket=0.5, else=0.0) |
| `emotion` | **0.10** | Exact enum match |
| `age_group` | **0.10** | Ordinal (exact=1.0, ±1 bucket=0.5, else=0.0) |
| `pitch` | **0.05** | Ordinal (exact=1.0, ±1 bucket=0.5, else=0.0) |
| `accent` | **0.05** | Exact enum match |
| `tone` | **0.05** | Exact enum match |

### The binary win primitive

- Each evaluation produces a **continuous score** in `[0, 1]` (weighted sum above).
- `generated_wins = true` when `score >= PASS_THRESHOLD` (default **`0.9`**, raised in v0.1.2).
- **`generated_wins` is the ranking primitive.** Per-validator and global aggregates both use the binary win/lose signal. `win_rate = wins / total` is what drives winner selection; the continuous `score` is stored only for diagnostics/dashboards.
- `PASS_THRESHOLD` and `ELEMENT_WEIGHTS` must be identical across all honest validators for consensus.

### Winner-selection algorithm (exact logic)

Code reference: [coordinator.py](https://github.com/vocence-78/vocence/blob/master/vocence/engine/coordinator.py) and [global_scoring.py](https://github.com/vocence-78/vocence/blob/master/vocence/ranking/global_scoring.py). Full spec: [docs/scoring.md](https://github.com/vocence-78/vocence/blob/master/docs/scoring.md).

1. **Order participants by commit block (ascending).**  
   Earlier commit block = “earlier” in the chain; base model is injected at `BASE_MODEL_COMMIT_BLOCK` (e.g. 1000) so it is first.

2. **Compute per-validator binary win rates.**  
   For each (miner, validator-bucket) pair, compute `wins / total` where a win = per-eval continuous score `≥ PASS_THRESHOLD` (0.9). A validator only contributes to a miner's global score when the miner has at least `MIN_EVALS_PER_VALIDATOR_FOR_GLOBAL_SCORE` (default 1) evaluations with that validator.

3. **Stake-weighted global win rate:**  
   `global_win_rate(miner) = Σ sqrt(stake_v) · win_rate_v / Σ sqrt(stake_v)` over contributing active validators.

4. **Global eligibility (v0.1.2):**  
   A miner is **eligible** iff it has **more than `MIN_EVALS_TO_COMPETE`** (default **40**) evaluations in **at least `MIN_VALIDATOR_APPEARANCES_FOR_ELIGIBILITY` (default 3)** distinct active validator buckets. This uses `eligible_validator_count`, not the summed global total.

5. **Threshold rule:**  
   A candidate wins iff it beats **every earlier eligible miner** (by commit block) by at least **`THRESHOLD_MARGIN`** (default **0.02**) on `global_win_rate`:  
   `candidate_global_win_rate >= prior_global_win_rate + THRESHOLD_MARGIN`.

6. **Tie-break among candidates that pass the threshold** (deterministic ordering):  
   1. higher `global_win_rate`  
   2. higher `eligible_validator_count`  
   3. higher `weighted_evals` (stake-weighted eval volume)  
   4. earlier commit block  
   5. lexicographically smaller hotkey

7. **Burn (set weight 1.0 on UID 0)** when **any** of these hold:  
   - Fewer than `MIN_ACTIVE_VALIDATORS_FOR_GLOBAL_SCORING` (default 3) validators are returned as active by the owner API  
   - Fewer than `MIN_ACTIVE_VALIDATORS_FOR_GLOBAL_SCORING` active validators can be matched locally in `VALIDATOR_BUCKETS_JSON`  
   - No usable global scoring data across active validator buckets  
   - No miner satisfies global eligibility  
   - No eligible miner beats every earlier eligible miner by `THRESHOLD_MARGIN`  
   
   Burning is preferred over setting inconsistent non-burn weights from weak evidence.

### Key config (config.py)

| Variable | Default | Description |
|----------|---------|-------------|
| `CYCLE_LENGTH` | 150 | Blocks between weight-setting cycles (~30 min) |
| `CYCLE_OFFSET_BLOCKS` | 15 | `block % CYCLE_LENGTH == offset` triggers a cycle |
| `CYCLE_BLOCK_TOLERANCE` | 2 | ± block tolerance around cycle/slot targets |
| `MIN_EVALS_TO_COMPETE` | 40 | Miner must have more than this many evals per validator bucket to be eligible |
| `MIN_VALIDATOR_APPEARANCES_FOR_ELIGIBILITY` | 3 | Must appear in ≥ this many validator buckets with `>MIN_EVALS_TO_COMPETE` evals (v0.1.2+) |
| `MIN_EVALS_PER_VALIDATOR_FOR_GLOBAL_SCORE` | 1 | Min evals for a validator bucket to contribute to global score (v0.1.2+) |
| `MIN_ACTIVE_VALIDATORS_FOR_GLOBAL_SCORING` | 3 | If fewer active validators are usable, cycle burns (v0.1.2+) |
| `ACTIVE_VALIDATOR_WINDOW_HOURS` | 24 | Recent-submission window for "active validator" status (v0.1.2+) |
| `THRESHOLD_MARGIN` | 0.02 | Must beat each earlier eligible miner's `global_win_rate` by this margin |
| `COMMIT_LOCK_BLOCK` | 8081000 | Block after which per-hotkey commit cap is enforced |
| `MAX_POST_CUTOVER_COMMITS` | 2 | Max valid on-chain commits per hotkey after `COMMIT_LOCK_BLOCK`; exceeding = invalid |
| `MAX_EVALS_FOR_SCORING` | 50 | Use only the most recent N evals per bucket for scoring |
| `PASS_THRESHOLD` | 0.9 | Per-eval continuous score ≥ this = binary "win" (v0.1.2+); code constant in [evaluation.py](https://github.com/vocence-78/vocence/blob/master/vocence/pipeline/evaluation.py) |
| `VALIDATOR_BUCKETS_JSON` | *(set in .env)* | JSON of readonly bucket creds for cross-validator reading (v0.1.2+) |
| `MAX_PARALLEL_MINERS` | 20 | Concurrent miner `/speak` calls per round |
| `MAX_PARALLEL_EVALS` | 4 | Concurrent OpenAI judge calls per round |
| `BURN_UID` | 0 | UID for burning when no eligible winner |
| `BASE_MODEL_COMMIT_BLOCK` | 1000 | Virtual commit block for owner base model |
| `PARTICIPANT_VALIDATION_INTERVAL` | 1800 | Owner-side miner validation worker interval (seconds) |
| `METRICS_CALCULATION_INTERVAL` | 1800 | Owner-side metrics worker interval (seconds) |

---

## 5. Miner: engine contract, Chutes, wrapper

### Engine contract (miner.py in HF repo)

From [miner_sample/MINER_GUIDE.md](https://github.com/vocence-78/vocence/blob/master/miner_sample/MINER_GUIDE.md):

- **Class:** `Miner`
- **Constructor:** `Miner(path_hf_repo: Path)` — load config/weights only from this path (HF repo clone).
- **Methods:**  
  - `warmup()` — Optional; one short `generate_wav` to avoid first-request timeout.  
  - `generate_wav(instruction: str, text: str) -> tuple[np.ndarray, int]` — Return mono float32 PCM and sample rate.

Only **stdlib and site-packages** may be imported in `miner.py`; no other repo files.

### Required files in Hugging Face repo

| File | Required | Description |
|------|----------|-------------|
| `miner.py` | Yes | PromptTTS engine (class `Miner`, `__init__`, `warmup`, `generate_wav`) |
| `chute_config.yml` | Yes | Image, NodeSelector (e.g. GPU), Chute scaling (used at Chutes build time) |
| `vocence_config.yaml` | No | Optional PromptTTS options (sample_rate, limits); read by engine if present |

### Approved template variables (only these)

The canonical wrapper is generated from [miner_sample/chute_template/](https://github.com/vocence-78/vocence/tree/master/miner_sample/chute_template). Only these four variables may be changed:

| Variable | Meaning |
|----------|--------|
| `VOCENCE_REPO` | Hugging Face repo ID (e.g. `user/model-name`) |
| `VOCENCE_REVISION` | Repo revision (commit hash strongly recommended) |
| `VOCENCE_CHUTES_USER` | Chutes username |
| `VOCENCE_CHUTE_ID` | Chute **name** in Chutes (e.g. `vocence-tts-001`). **Must contain `vocence`** (case-insensitive). Owner validates by chute **name** from Chutes API, not the chute_id (UUID) on chain. |

Any other change to the wrapper causes **wrapper integrity** check to fail on the owner side.

### Wrapper integrity (owner-side)

Owner fetches deploy script from Chutes (`GET /chutes/code/{chute_id}`), masks the four variables, normalizes (e.g. AST), hashes, and compares to the hash of the canonical template. Mismatch → participant marked invalid (`wrapper_hash_mismatch`). Validators do **not** perform this check; they only call `/health` and `/speak`.

### Miner flow summary

1. Create HF repo with `miner.py`, `chute_config.yml`, optional `vocence_config.yaml`.  
2. Render canonical template with the four variables; build and deploy Chute (`chutes build`, `chutes deploy`).  
3. Commit on chain: `vocence miner commit --model-name <repo> --model-revision <sha> --chute-id <chute_uuid>`.  
   - The **chute_id** on chain is the Chutes UUID; the **chute name** (used by owner) must contain `vocence`.

---

## 6. Validator: sample generation and weight setting

### Architecture (coordinator)

From [vocence/engine/coordinator.py](https://github.com/vocence-78/vocence/blob/master/vocence/engine/coordinator.py):

- **Sample generation:** Background task `generate_samples_continuously()` (from [vocence/pipeline/generation](https://github.com/vocence-78/vocence/tree/master/vocence/pipeline)): download audio from corpus bucket → get transcription + voice traits (e.g. GPT-4o-audio) → query each valid miner’s Chutes `/speak` → run forced-choice evaluation (count as win when judge probability ≥ `pass_threshold`, default **0.9**) → upload sample + metadata to **validator’s** Hippius bucket.
- **Weight setting (v0.1.2+):** Every `CYCLE_LENGTH` blocks (with offset and tolerance), `cycle_step()` runs `execute_cycle()`: fetch valid participants + active validators from owner API → read recent evaluation windows from **every active validator bucket** (via `VALIDATOR_BUCKETS_JSON`) → aggregate per-hotkey scores stake-weighted by `sqrt(stake)` → apply global winner-selection rules (eligibility needs ≥3 validator-bucket appearances) → `subtensor.set_weights()` (winner-take-all or burn on UID 0).

### Block-based cycle and slots

- **Cycle:** `(block - CYCLE_OFFSET_BLOCKS) % CYCLE_LENGTH == 0` (with ±`CYCLE_BLOCK_TOLERANCE`). Executed at most once per logical cycle.  
- **Sample slots:** Staggered by validator ID (e.g. every `SAMPLE_SLOT_INTERVAL_BLOCKS`, offset per validator). Config in [config.py](https://github.com/vocence-78/vocence/blob/master/vocence/domain/config.py): `CYCLE_OFFSET_BLOCKS`, `CYCLE_BLOCK_TOLERANCE`, `SAMPLE_SLOT_INTERVAL_BLOCKS`, `SAMPLE_SLOT_OFFSET_BLOCKS`, `VALIDATOR_ID`.

### Running the validator

- **Docker (recommended):** Clone repo, copy `env.example` to `.env`, set wallet, Chutes, API_URL, Hippius, OpenAI; create `logs` and set ownership; `docker compose up -d`. Watchtower auto-updates the validator image. See [docs/validator-setup.md](https://github.com/vocence-78/vocence/blob/master/docs/validator-setup.md).  
- **From source:** `uv sync`, then `uv run vocence serve` (full validator). Optional: `vocence services generator` and `vocence services validator` for split scaling.

---

## 7. Owner, base model, and burn key

### Base model (owner-deployed reference)

- Owner runs a **base model** (e.g. qwen3-voice-design) in a Chute. It is **never committed on chain** by the normal miner flow; it is injected in config with a fixed **commit block** (`BASE_MODEL_COMMIT_BLOCK`, e.g. 1000) so that in winner selection it is treated as the “earliest” participant.  
- **Miners must beat the base model’s win rate by THRESHOLD_MARGIN** (2%) to be able to win. This prevents miners from simply reusing the base model.  
- Config: [config.py](https://github.com/vocence-78/vocence/blob/master/vocence/domain/config.py) — `OWNER_UID`, `OWNER_HOTKEY`, `BASE_MODEL_CHUTE_ID`, `BASE_MODEL_MODEL_NAME`, `BASE_MODEL_MODEL_REVISION`, `BASE_MODEL_COMMIT_BLOCK`.  
- Owner marks the participant whose `chute_id == BASE_MODEL_CHUTE_ID` as always valid (skip other checks). See [docs/base-model-protocol.md](https://github.com/vocence-78/vocence/blob/master/docs/base-model-protocol.md).

### Burn key (UID 0)

- **UID 0** on Bittensor is the burn key. When **no miner is eligible** (or no one beats all earlier participants by the threshold), validators set **weight 1 on UID 0** so that incentives are **burned** (no miner receives them).  
- Implemented in [coordinator.py](https://github.com/vocence-78/vocence/blob/master/vocence/engine/coordinator.py): when `leader is None`, call `set_weights` with `uids=[BURN_UID]`, `weights=[1.0]`.

---

## 8. Configuration (env and config.py)

All configuration is loaded from environment (e.g. `.env`); defaults and semantics are in [vocence/domain/config.py](https://github.com/vocence-78/vocence/blob/master/vocence/domain/config.py). Example env: [env.example](https://github.com/vocence-78/vocence/blob/master/env.example).

### Bittensor / chain

- `CHAIN_NETWORK` / `NETWORK`: `finney` (mainnet), `test` (testnet).  
- `SUBNET_ID` / `NETUID`: subnet id (default **78** for mainnet).  
- `CYCLE_LENGTH`, `CYCLE_OFFSET_BLOCKS`, `CYCLE_BLOCK_TOLERANCE`, `SUBTENSOR_TIMEOUT_SEC`.

### Scoring and cycle

- `MIN_EVALS_TO_COMPETE` (40), `THRESHOLD_MARGIN` (0.02), `MAX_EVALS_FOR_SCORING` (50).
- `COMMIT_LOCK_BLOCK` (8081000) — block after which per-hotkey commit cap applies.  
- `MAX_POST_CUTOVER_COMMITS` (2) — max valid on-chain commits per hotkey after `COMMIT_LOCK_BLOCK`; exceeding this marks the miner invalid.  
- `MIN_VALIDATOR_APPEARANCES_FOR_ELIGIBILITY` (3), `MIN_ACTIVE_VALIDATORS_FOR_GLOBAL_SCORING` (3), `MIN_EVALS_PER_VALIDATOR_FOR_GLOBAL_SCORE` (1).  
- `ACTIVE_VALIDATOR_WINDOW_HOURS` (24) — recent-submission window for active-validator status.  
- `PASS_THRESHOLD` (0.9, code constant) — per-eval continuous score ≥ this counts as a binary win.  
- `VALIDATOR_BUCKETS_JSON` — readonly bucket credentials for cross-validator reading.  
- `VALIDATOR_ID`, `SAMPLE_SLOT_INTERVAL_BLOCKS`, `SAMPLE_SLOT_OFFSET_BLOCKS` for sample timing (offset = `(VALIDATOR_ID % 6) * 25`).

### Chutes

- `CHUTES_BASE_URL`, `CHUTES_AUTH_KEY` / `CHUTES_API_KEY`. Validators need Chutes access granted by the team.

### Hippius (S3)

- **Owner:** `HIPPIUS_OWNER_ACCESS_KEY`, `HIPPIUS_OWNER_SECRET_KEY` (corpus bucket).  
- **Validator:** `HIPPIUS_CORPUS_ACCESS_KEY`, `HIPPIUS_CORPUS_SECRET_KEY` (read corpus); `HIPPIUS_VALIDATOR_ACCESS_KEY`, `HIPPIUS_VALIDATOR_SECRET_KEY` (validator’s samples bucket).  
- Bucket names: `AUDIO_SOURCE_BUCKET`, `AUDIO_SAMPLES_BUCKET` (derived from `VALIDATOR_NAME` if not set).

### OpenAI / evaluation

- `OPENAI_AUTH_KEY` / `OPENAI_API_KEY`, `GPT_AUDIO_MODEL` (e.g. `gpt-4o-audio-preview`).

### Owner / API

- `API_URL` — owner API endpoint (validators and generator use this).  
- Base model / burn: `OWNER_UID`, `BURN_UID`, `BASE_MODEL_*` in config (see [§7](#7-owner-base-model-and-burn-key)).

### Wallet

- `COLDKEY_NAME` / `WALLET_NAME`, `HOTKEY_NAME`.

---

## 9. APIs and endpoints

### Miner API (per Chute)

- **GET /health** — Returns `status`, `hf_repo_id`, `hf_revision`, `model_loaded`, `sample_rate`, `adapter`.  
- **POST /speak** — JSON body: `{"instruction": "...", "text": "..."}`. Response: `audio/wav` (raw WAV bytes).

Defined by the canonical wrapper; validators call these for each valid miner.

### Owner API (centralized)

Validators and generator call the owner API (base URL from `API_URL`). Typical endpoints:

- **GET /participants/valid** — List of valid miners (used by validators for participant list).  
- **POST /evaluations** — Submit evaluation results (e.g. for dashboard).  
- **GET /metrics** — Network metrics.  
- **GET /blocklist** — Blocked miners.  
- **GET /status** — Service status.

Exact routes and request/response shapes are defined in the owner service code (not in the public vocence repo linked here; refer to any owner-specific docs you have).

---

## 10. CLI reference

Entry point: `vocence` (from [pyproject.toml](https://github.com/vocence-78/vocence/blob/master/pyproject.toml) — `vocence.gateway.cli.main:cli`). Run with `uv run vocence` or after `pip install -e .`.

Full reference: [docs/CLI.md](https://github.com/vocence-78/vocence/blob/master/docs/CLI.md).

### Validator

- `vocence serve` — Full validator (sample generation + weight setting).  
- `vocence services generator` — Sample generation only.  
- `vocence services validator` — Weight setting only.

### Owner

- `vocence owner serve` — API + source audio downloader (optional `--no-api`, `--rounds`, `--delay`).  
- `vocence corpus source-downloader` — LibriVox downloader only.  
- `vocence api` — HTTP API only.

### Miner

- `vocence miner push --model-name <repo> --model-revision <sha>` — Deploy model to Chutes.  
- `vocence miner commit --model-name <repo> --model-revision <sha> --chute-id <id>` — Commit model + Chute ID on chain (optional `--network`, `--netuid`, `--coldkey`, `--hotkey`).

### Query

- `vocence get-miners` — List miners and committed Chutes from chain.

---

## 11. Documentation index

| Doc | Link | Content |
|-----|------|---------|
| README | [README.md](https://github.com/vocence-78/vocence/blob/master/README.md) | Overview, roles, credentials, quick starts |
| CLI | [docs/CLI.md](https://github.com/vocence-78/vocence/blob/master/docs/CLI.md) | All commands and options |
| Scoring | [docs/scoring.md](https://github.com/vocence-78/vocence/blob/master/docs/scoring.md) | Element rubric, pass threshold, global scoring, tie-breaks, burn conditions |
| Validator setup | [docs/validator-setup.md](https://github.com/vocence-78/vocence/blob/master/docs/validator-setup.md) | Docker + Watchtower, logs, troubleshooting |
| Base model & burn | [docs/base-model-protocol.md](https://github.com/vocence-78/vocence/blob/master/docs/base-model-protocol.md) | Owner vs validator behavior, burn key |
| CI/CD | [docs/cicd-pipeline.md](https://github.com/vocence-78/vocence/blob/master/docs/cicd-pipeline.md) | Validator image build and publish |
| Miner guide | [miner_sample/MINER_GUIDE.md](https://github.com/vocence-78/vocence/blob/master/miner_sample/MINER_GUIDE.md) | Repo layout, engine contract, template, wrapper integrity |
| Postgres | [docs/setup-postgres-vocence.md](https://github.com/vocence-78/vocence/blob/master/docs/setup-postgres-vocence.md) | Optional DB for owner API |
| Changelog | [CHANGELOG.md](https://github.com/vocence-78/vocence/blob/master/CHANGELOG.md) | Version history |

---

## 12. Reference links

### Official and repo

- **Website:** [https://vocence.ai](https://vocence.ai)  
- **GitHub:** [https://github.com/vocence-78/vocence](https://github.com/vocence-78/vocence)  
- **Releases:** [https://github.com/vocence-78/vocence/releases](https://github.com/vocence-78/vocence/releases) (e.g. v0.1.0)

### Code (master)

- Config: [vocence/domain/config.py](https://github.com/vocence-78/vocence/blob/master/vocence/domain/config.py)  
- Coordinator (validator loop, winner selection, burn): [vocence/engine/coordinator.py](https://github.com/vocence-78/vocence/blob/master/vocence/engine/coordinator.py)  
- Score calculation: [vocence/ranking/calculator.py](https://github.com/vocence-78/vocence/blob/master/vocence/ranking/calculator.py)  
- CLI: [vocence/gateway/cli/main.py](https://github.com/vocence-78/vocence/blob/master/vocence/gateway/cli/main.py)

### Ecosystem

- **Chutes:** [https://chutes.ai](https://chutes.ai)  
- **Bittensor:** [https://bittensor.com](https://bittensor.com) / [docs](https://docs.bittensor.com)  
- **Hippius:** [https://console.hippius.com](https://console.hippius.com/dashboard/settings) (S3-compatible storage)

### Voice traits (PromptTTS — closed enums used by the judge)

The task spec is extracted from source audio via a single GPT-4o-audio-preview call and serialized to the miner as `instruction`. The judge extracts the same 8 fields from the miner's output and scores element-by-element. All dimensions use **closed enum sets** (trait aliases like `"american"` are coerced to `us`):

| Dimension | Allowed values |
|-----------|----------|
| `transcription` | free-form exact words |
| `gender` | `male`, `female`, `neutral` |
| `pitch` | `low`, `mid`, `high` |
| `speed` | `slow`, `normal`, `fast` |
| `age_group` | `child`, `young_adult`, `adult`, `senior` |
| `emotion` | `neutral`, `happy`, `sad`, `angry`, `calm`, `excited`, `serious`, `fearful` |
| `tone` | `warm`, `cold`, `friendly`, `formal`, `casual`, `authoritative` |
| `accent` | `us`, `uk`, `au`, `in`, `neutral`, `other` |

Canonical `/speak` payload: `{"text": "<transcription>", "instruction": "gender: ... | pitch: ... | speed: ... | age_group: ... | emotion: ... | tone: ... | accent: ..."}`.

---

## 13. Quick answers (FAQ)

- **How do I become eligible to win rewards?** (v0.1.2+) You need more than **`MIN_EVALS_TO_COMPETE`** (default 40) evaluations in at least **`MIN_VALIDATOR_APPEARANCES_FOR_ELIGIBILITY`** (default 3) distinct active validator buckets, **and** you must beat **every** earlier eligible miner (by commit block), including the base model, by at least **`THRESHOLD_MARGIN`** (default **2%**) on the stake-weighted **global binary win rate** (a "win" = per-eval continuous score ≥ `PASS_THRESHOLD` 0.9). Additionally, each hotkey is limited to **2** valid on-chain commits after block 8,081,000 — exceeding this cap marks you invalid.
- **What counts as a "win" per evaluation?** Each evaluation produces a continuous score in `[0,1]` from 9 weighted elements (script 0.30, naturalness 0.15, gender 0.10, speed 0.10, emotion 0.10, age_group 0.10, pitch 0.05, accent 0.05, tone 0.05). If that score ≥ **0.9**, `generated_wins = true`. The binary win/lose flag — not the continuous score — is what drives ranking.
- **What if no miner is eligible?** Validators set weight **1.0 on UID 0** (burn key). All incentives for that cycle are burned. Burn also triggers if fewer than 3 active validators are usable, or no one beats every earlier participant by the margin.
- **Why must my chute name contain "vocence"?** The owner validates participants by checking the Chutes deployment **name** (from Chutes API). This restricts the subnet to Vocence-related miners.
- **How often are weights set?** Every **`CYCLE_LENGTH`** blocks (default 150, ~30 minutes). Executed at `block % CYCLE_LENGTH == CYCLE_OFFSET_BLOCKS` (default 15), ± `CYCLE_BLOCK_TOLERANCE` (2). Config: [config.py](https://github.com/vocence-78/vocence/blob/master/vocence/domain/config.py).
- **What is the base model?** An owner-deployed reference model (e.g. qwen3-voicedesign-base). It is treated as committed at **`BASE_MODEL_COMMIT_BLOCK`** (1000). Miners must beat its global win rate by **2%** to win. See [docs/base-model-protocol.md](https://github.com/vocence-78/vocence/blob/master/docs/base-model-protocol.md).
- **What is the per-hotkey commit cap?** After block **8,081,000**, each hotkey can have at most **2** valid on-chain commits. Only field-valid commits count toward the cap (malformed commits are ignored). If a hotkey exceeds the limit, it is marked invalid (`too_many_commits`). This is enforced in the owner-side participant validation. Config: `COMMIT_LOCK_BLOCK` (8081000), `MAX_POST_CUTOVER_COMMITS` (2).
- **How does winner selection work?** Order by commit block → keep only globally eligible miners → among eligible, keep only those whose `global_win_rate` beats **every** earlier eligible miner by `THRESHOLD_MARGIN` → tie-break by (1) global_win_rate, (2) eligible_validator_count, (3) weighted_evals, (4) earliest commit block, (5) lexicographically smaller hotkey. Code: [coordinator.py](https://github.com/vocence-78/vocence/blob/master/vocence/engine/coordinator.py), [global_scoring.py](https://github.com/vocence-78/vocence/blob/master/vocence/ranking/global_scoring.py).
- **What makes a validator "active"?** It submitted evaluation data within the last `ACTIVE_VALIDATOR_WINDOW_HOURS` (default 24). The owner API publishes this list; validators use it to decide whose buckets to read.
- **Can I run generator and validator separately?** Yes: `vocence services generator` and `vocence services validator`. See [docs/CLI.md](https://github.com/vocence-78/vocence/blob/master/docs/CLI.md).
- **Where are evaluation samples generated?** Corpus (LibriVox, 20–25s clips) → GPT-4o-audio extracts an 8-field task spec (transcription + 7 voice traits) → query each miner's `/speak` → 2 GPT-4o calls per miner (pointwise trait extraction + pairwise naturalness) → upload to validator's Hippius bucket. Pipeline: [vocence/pipeline](https://github.com/vocence-78/vocence/tree/master/vocence/pipeline).

---

*This knowledge base is used by the Vocence Discord/Telegram assistant. Last updated: 2026-04-29 (reflects PR #7 — threshold margin lowered to 2%, per-hotkey commit cap of 2 after block 8,081,000). For the single source of truth, always refer to the [vocence-78/vocence](https://github.com/vocence-78/vocence) repository and its docs.*