# default_memory 移植规划

目标：把 `D:\Coding\Shiori` 的 `plugins/default_memory` + `memory2` + `core/memory` 的**核心语义**
复刻为 dsh 插件的 TypeScript 实现。**不做全量 1:1**：砍掉 HyDE、query-rewriter、sufficiency、
LLM-dedup、procedure-tagger、rule_schema、Markdown consolidation 等重组件，
聚焦「记忆持续更新（抽取 + 强化 + supersede/merge）+ 检索稳定可靠（两路 RRF + 降级）」。

## 模块映射（Shiori Python → 本插件 TS）

| Shiori 模块 | 本插件文件 | 状态 |
|---|---|---|
| core/memory/engine.py + events.py | src/memory-engine/contracts.ts | ✅ 完成 |
| memory2/store/{common,connection,write,vector,admin,temporal}.py | src/memory-engine/store.ts（SQLite, node:sqlite） | ✅ 完成 |
| memory2/embedder.py | src/memory-engine/llm.ts（Embedder + ChatClient） | ✅ 完成 |
| memory2/retriever.py + injection_planner.py + query_builder.py | src/memory-engine/retriever.ts | ✅ 完成 |
| memory2/memorizer.py（save_item_with_supersede/merge 核心） | src/memory-engine/engine.ts | ✅ 完成 |
| engine/{query,mutation,policy,lifecycle,prompts}.py | src/memory-engine/engine.ts（DefaultMemoryEngine） | ✅ 完成 |
| post_response_worker.py（implicit 抽取，砍 invalidation） | src/memory-engine/engine.ts（ingest） | ✅ 完成 |
| 工具注册 | src/memory-engine/tools.ts | ✅ 完成 |
| 接线 | src/service.ts（Config.memory + engine 装配） | ✅ 完成 |
| HyDE / query-rewriter / sufficiency / dedup-decider / tagger / rule_schema | — | ⛔ 砍掉（重组件） |
| core/memory/markdown/consolidation.py | semantic-consolidation.ts + markdown-memory.ts | ✅ 迁移语义提取及 HISTORY/PENDING/RECENT_CONTEXT 投影，使用 Harness shadowedSeqs |
| proactive_v2/memory_optimizer.py | markdown-memory.ts + self-memory.ts + role-files.ts | ✅ 迁移 PENDING 两阶段提交、MEMORY 合并、SELF 初始化与维护；compaction 后即时执行 |

## 存储层（SQLite，node:sqlite 内置，零依赖）

### memory_items 表
```sql
CREATE TABLE memory_items (
  id TEXT PRIMARY KEY,
  memory_type TEXT NOT NULL,        -- procedure|preference|event|profile
  summary TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  embedding TEXT,                   -- JSON 数组
  reinforcement INTEGER NOT NULL DEFAULT 1,
  emotional_weight INTEGER NOT NULL DEFAULT 0,
  extra_json TEXT,                  -- {role_id, memory_domain, scope_channel, scope_chat_id, category, tool_requirement, steps, rule_schema, trigger_tags, ...}
  source_ref TEXT,
  happened_at TEXT,
  status TEXT NOT NULL DEFAULT 'active',   -- active|superseded
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX ux_items_hash ON memory_items (content_hash, memory_type);
```
- content_hash = sha256(空白归一化小写 summary + memory_type)[:16]
- id = md5(hash + time.time())[:12]
- embedding 存 JSON（Shiori 用 float32 blob + sqlite-vec；TS 用 JSON + 全表扫描，语义等价）

### consolidation_events（source_ref 主键，同一 source_ref 只写一次 event）
### consolidation_long_term_refs（source_ref 主键，同一长期候选只写一次）
### completed_compactions（source_ref 主键，完整维护成功后标记）
### memory_replacements（supersede/merge 溯源）
- old_item_id/old_memory_type/old_summary/old_extra_json/old_happened_at/old_source_ref
- new_item_id/.../relation_type('supersede')/source_ref/created_at

### 关键函数（1:1 语义）
- upsert_item → 'new:id' | 'reinforced:id'；superseded 命中时复活 + reinforcement+1
- upsert_consolidation_event（事务内：consolidation_events 去重 + event upsert）
- mark_superseded / mark_superseded_batch / reinforce_items_batch / merge_item_raw（hash 冲突回退 supersede+upsert）
- record_replacements / list_replacements
- vector_search（cosine、score_threshold、hotness 融合 final=(1-alpha)*semantic+alpha*hotness、top_k、scope/type/domain/role 过滤）
- hotness_score = sigmoid(reinforcement) * 2^(-age_days / effective_half_life)；effective_half_life = half_life*(1+0.5*emotional/10)
- keyword_search_summary：OR-LIKE、按命中词数降序、keyword_score=命中/词数（供 RRF）
- list_events_by_time_range（event + happened_at 范围）、find_similar_recent_events（7 天、阈值 0.92）
- keyword_match_procedures（trigger_tags.scope=tool_triggered 关键字匹配）
- admin：list_items_for_admin / get_item_for_admin / update_item_for_admin / delete_item(s) / invalidate_role_memories / find_similar_items_for_admin

## 关键常量

| 常量 | 值 | 位置 |
|---|---|---|
| VEC_DIM | 1024（可覆盖） | store |
| RRF_K | 60；向量权重 1.0，关键词权重 0.5 | retriever |
| VECTOR_SCORE_THRESHOLD（answer） | 0.35 | query |
| 默认 score_threshold | 0.45 | retriever |
| VECTOR_TOP_K | 15 | query |
| KEYWORD_LIMIT_FLOOR | 30；MULTIPLIER 2 | retriever |
| hotness_alpha | 0.20 | retriever |
| supersede_threshold | 0.90；merge 0.70 | memorizer |
| 事件语义去重 | 0.92 / 7 天 | memorizer |
| dedup 预筛 | 0.45；批内 0.90 | dedup |
| token 预算/回合 | 1000（invalidation 96*2 + implicit 600） | post-response |
| INJECT_MAX_CHARS | 1200；forced 3；procedure/preference 4；event/profile 2 | retriever |
| _LOCAL_TZ | Asia/Shanghai（时间过滤 margin 2 天） | store |

## 回合后处理流程（post_response_worker.run）
1. 收集本轮显式 memorize 结果（tool_chain 里 name=memorize 的参数 summary + 结果 id）→ summaries 排重、protected_ids 保护
2. invalidation：从 user_msg 提取"否定旧行为"主题（LLM）→ retriever 召回 procedure/preference（阈值 0.82，top 5）→ LLM 判断 supersede ids → mark_superseded_batch
3. implicit：预算允许时调用 _extract_and_save_post_response：
   - conversation = `USER: {user_msg}\nASSISTANT: {assistant_response}`
   - existing_profile = 现有 profile/preference/procedure 摘要（截 6000 字符）
   - LLM 输出 {profile:[], preference:[], procedure:[]}（含 emotional_weight/category/happened_at）
   - 保存：profile 带 category + `#profile` 后缀 source_ref；preference/procedure 带 `#implicit`

## 写入（_remember）
- procedure 无 tool_requirement/steps → 降级 preference
- extra: {tool_requirement, steps, role_id, memory_domain, rule_schema?, trigger_tags?}
- 默认 domain：profile/preference/procedure/event → relationship；identity/background/principle → role_self；shared 需授权
- save_item_with_supersede：procedure/preference 召回 top5（阈值 min(0.70,0.90)）→ procedure 找同 tool_requirement merge 目标（合并 summary 用 `；`）；相似度 ≥0.90 的旧条目 supersede；profile status/purchase 同 category ≥0.90（emotional≥7 时 0.92）supersede

## 检索（retrieve）
- 向量 lane（query + aux 查询去重 embed）→ threshold 过滤 → vector_search
- 关键词 lane（_extract_terms：ASCII token + CJK bigram 去停用词，limit 20 词）
- RRF 融合：1/(60+vec_rank) + 0.5/(60+kw_rank)，按 (rrf, raw_score) 排序
- answer intent：HyDE（假想查询 + union dedup）+ 双 hypothesis（event/general 风格）
- context/procedure intent：procedure query 改写（LLM）
- 注入规划：forced procedure（tool_requirement）→ 偏好/流程 → 事件/画像；字符预算截断

## Compaction 与 Markdown 角色记忆

Harness 保持唯一的上下文压缩策略。插件监听成功的 compaction，按 `shadowedSeqs` 读取原始窗口，复用 Shiori consolidation 语义提取。每个角色独立串行执行：追加 `HISTORY.md` 和 `PENDING.md`，快照 pending，执行 `PENDING.md -> MEMORY.md` optimizer，用同一份 pending 更新 `SELF.md`，生成 `RECENT_CONTEXT.md`，再提交快照。任一 optimizer 失败都会回滚 pending；整条链路成功后才写入 `completed_compactions`。SQLite 同时保存逐条 event 和长期候选，source ref 分别使用 `#event:<index>` 与 `#long-term:<index>`。

## 事件（dsh 适配）
- TurnCommitted → agent/turn-stopping（异步 fire-and-forget）
- agent/turn-stopping → 通过当前 Harness 模型独立抽取并等待 memory2.db 写入
- RetrievalCompleted / MemoryWritten → 内部回调（可发布日志）

## 实施顺序（已完成）
1. ✅ contracts.ts + config.ts + llm.ts
2. ✅ store.ts（SQLite：schema/upsert/supersede/reinforce/merge/consolidation_events/replacements/vector/keyword/timeline/admin）
3. ✅ retriever.ts（两路独立召回 + RRF + hotness + 注入规划）
4. ✅ engine.ts（query 意图分发 / remember+supersede+merge / forget / ingest 抽取 / admin / recall）
5. ✅ tools.ts（recall_memory / memorize / forget_memory + 上下文注入）
6. ✅ service.ts 接线（角色目录 SQLite；turn-stopping → engine.ingest）
7. ✅ 角色文件、SQLite 引擎与完整 compaction 流程均有 focused tests

## 与现有代码关系
- src/memory.ts（旧简化版）保留导出（兼容旧测试/API），service.ts 已切换到 memory-engine
- src/file-memory-table.ts 仅保留旧结构化 JSON 测试实现；角色目录的 `memory/` 维护五个 Shiori Markdown 文件
- 存储路径：`<memoryRoot>/shiori-plugin/role/<role-id>/memory/memory2.db`。
