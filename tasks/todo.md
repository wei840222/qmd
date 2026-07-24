# qmd CJK／OpenAI 實作待辦

> 詳細內容、驗收條件與依賴關係見 `tasks/plan.md`。本檔是摘要；各項驗證的權威狀態以 `tasks/plan.md` 為準。

## Phase 0：Baseline 與技術風險

- [x] T1：擴充 benchmark metrics，建立繁體中文 retrieval corpus 與 char baseline
- [x] T2：以 packed tarball 與 CI matrix 驗證 `@node-rs/jieba` 的 Node／Bun／平台相容性
- [x] T3：定義 `EmbeddingProvider` contract 與 local adapter

### Checkpoint A

- [x] Baseline、native dependency 與 provider contract 通過人工 review
- [x] Targeted tests 與 typecheck通過

## Phase 1A：CJK lexical search

- [x] T4：建立 index/query 共用的 CJK analyzer
- [x] T5：建立可隨 package 發布的版本化繁中技術詞典、來源 metadata 與 third-party notice
- [x] T6：新增 mutation-consistent word／bigram FTS shadow schema 與 analyzer fingerprint
- [x] T7：以 transaction／dirty marker 同步所有文件與 collection mutation path
- [x] T8：實作 char／word／bigram RRF、nested trace 與獨立 strong-signal diagnostics
- [x] T9：CJK 預設 bypass expansion，加入 explicit `--expand`

### Checkpoint B

- [x] Crash-safe rebuild、增量同步與 concurrency tests 通過
- [x] CLI／SDK／MCP 使用同一 analyzer 與 query behavior
- [x] `Recall@10`／`MRR@10` 不低於 char baseline

## Phase 1B：Embedding provider

- [x] T10：一次完成 typed config/resolver、雙 composition root provider seam 與 ownership lifecycle
- [x] T11：移除 destructive cleanup，實作 guarded in-place vector state、full fingerprint、metadata/vector 同 transaction、statement-boundary crash repair、lease 與 partial resume
- [x] T12：實作 OpenAI embedding HTTP client、strict validation／safe error、retry-budget terminal fail-fast與無 fan-out mock tests
- [x] T13：完成 side-effect-free preflight、durable ack後非敏感 capability probe、雙重 rebuild 授權、purpose-scoped全域guard與no-local-fallback
- [x] T14：補齊 `doctor`、status 與 SDK 診斷

### Checkpoint C

- [x] Local-only 行為與既有設定完全相容
- [x] OpenAI tests 沒有真實 remote request
- [x] Consent、pre-reset capability probe、retry fail-fast／request-count guard、resume、dimension guard 與 secret redaction 通過

## Phase 2：整合與文件

- [x] T15：執行整合、品質、安全與效能驗收
  - [x] 修正 `CLI Status Command > status and normal store startup restore canonical embedding config when YAML is missing` 的 canonical config regression，補齊 Node／Bun targeted coverage
  - [x] 以 current tree 重跑 CJK quality gate、同機效能量測、generator deterministic／negative validation、frozen install 與 dependency audit
  - [x] 依 `scripts/test-runtime.mjs` 分程序序列執行 local-model groups，完成 hash-stable Node／Bun full regression
- [x] T16：更新使用者文件、Mermaid 架構與 `CHANGELOG.md`
  - [x] 稽核並修正 `README.md`、`docs/architecture-cjk-openai.zh-TW.md`、CLI help 與 `CHANGELOG.md` 草稿，使其符合 current implementation
  - [x] 實際執行 source CLI help，驗證 command、config key、remote consent／no-rollback warning 與 expansion precedence
  - [x] Fresh hash-stable 文件 review 通過（final5 manifest 110/110，START／END SHA-256一致，APPROVED且無finding）

### Checkpoint D

- [x] Current-tree Node／Bun full suites 全綠，且起訖 tree hash 一致（`FINAL_DISPOSAL_DRAIN_FULL_GATE_OK`與final5 review起訖hash certification均通過）
- [x] `pnpm run test:types`、`pnpm run build`、`pnpm run test:package`、frozen install 與 dependency audit 全綠
- [x] Current-tree hash-stable code review 與 scoped code simplification 完成，無 blocker（final5 manifest 110/110，APPROVED且無Required finding）
- [x] 使用者已核准由 `feat/cjk-openai-embeddings` commit／push並建立target為 `local` 的PR（外部執行結果以Git／Gitea為準）

## 實作前問題（已全部定案）

- [x] OQ1：採 deterministic segment-level script gating；含 Kana／Hangul 的句段只使用 char/bigram
- [x] OQ2：已由規格定案；所有 remote query 都需要既有 full fingerprint acknowledgement
- [x] OQ3：採版本化靜態價格＋UTF-8 byte conservative upper bound＋API usage 事後校對
- [x] OQ4：固定 zhtw-mcp commit、blob SHA、SHA-256 與 MIT attribution
- [x] OQ5：採 CLI／SDK two-phase consent service；MCP 只讀 status/preflight，不能授權
