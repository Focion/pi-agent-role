// ═══════════════════════════════════════════════════════════════════════════
// 可替换向量检索后端（O03 · §14.2.3 后端抽象）
//
// 把「文本 → 相关情节候选」抽象成 RetrievalBackend，使 FTS5（bm25 负值，越负越相关）
// 与未来的向量检索（余弦相似度，越高越相关）能在同一条 rankCandidatesWithSubjects 打分
// 链之后被替换，无需改动排序/预算/强化逻辑。两份实现都能产出带 `relevance` 的
// EpisodeCandidate（relevance 越高越相关），rank 层不再依赖「bm25 是负值」这一 FTS 细节。
//
// · id 写入 retrieval_log.query_json 的回放元数据（与 model_config_hash 一起构成
//   「哪个后端 + 哪个模型配置」产生这次检索的可回放证据）。
// · compareRetrieval 供后端迁移用：同 owner/query/预算跑两套后端，交并集对齐召回面。
// 纪律（§22.4）：本文件不 import @pi/agent-mesh；不写 SQL——后端委托 dao，向量后端再把
// 委托换成向量索引，SQL 仍收敛在 dao 内。
// ═══════════════════════════════════════════════════════════════════════════

import type { EpisodeCandidate, MemoryDao } from "./dao.js";
import { RETRIEVAL } from "./constants.js";

/** 一次检索查询的参数（owner 隔离键 + 状态范围 + 候选上限）。 */
export interface RetrievalQuery {
  owner: string;
  query: string;
  includeFaded: boolean;
  /** 候选上限；缺省取 RETRIEVAL.candidateLimit（与 dao 默认一致）。 */
  limit?: number;
}

/** 检索后端接口：文本查询 → 相关情节候选（relevance 越高越相关）。 */
export interface RetrievalBackend {
  readonly id: string;
  searchCandidates(q: RetrievalQuery): EpisodeCandidate[];
}

/** 默认后端：FTS5 + trigram（§14.2.3）。dao.searchCandidates 的 bm25 在 rowToCandidate
 *  已取反为 relevance（越高越相关），故本类只做入参透传。 */
export class Fts5Backend implements RetrievalBackend {
  readonly id = "fts5";

  constructor(private readonly dao: MemoryDao) {}

  searchCandidates(q: RetrievalQuery): EpisodeCandidate[] {
    return this.dao.searchCandidates(q.owner, q.query, q.includeFaded, q.limit ?? RETRIEVAL.candidateLimit);
  }
}

/** 后端比较产物：两套后端在同 owner/query/预算下的召回 episode 集合及其交并差。 */
export interface RetrievalComparison {
  owner: string;
  query: string;
  includeFaded: boolean;
  limit: number;
  a: { backendId: string; episodeIds: string[] };
  b: { backendId: string; episodeIds: string[] };
  /** 两后端都召回的 episode id（按 a 的顺序）。 */
  common: string[];
  /** 仅 a 召回的 episode id。 */
  aOnly: string[];
  /** 仅 b 召回的 episode id。 */
  bOnly: string[];
}

/**
 * 同输入/预算比较两个后端（§14.2.3 / O03）：各自跑一遍 searchCandidates，返回 id 集合的
 * 交并差。用于向量后端上线前对齐 FTS5 召回面、或在回放中对同一 query 复现两次检索做差。
 * 保持 owner 隔离——q.owner 直接下传，不跨 owner 合并。
 */
export function compareRetrieval(a: RetrievalBackend, b: RetrievalBackend, q: RetrievalQuery): RetrievalComparison {
  const ids = (backend: RetrievalBackend): string[] => backend.searchCandidates(q).map((c) => c.episodeId);
  const aIds = ids(a);
  const bIds = ids(b);
  const aSet = new Set(aIds);
  const bSet = new Set(bIds);
  return {
    owner: q.owner,
    query: q.query,
    includeFaded: q.includeFaded,
    limit: q.limit ?? RETRIEVAL.candidateLimit,
    a: { backendId: a.id, episodeIds: aIds },
    b: { backendId: b.id, episodeIds: bIds },
    common: aIds.filter((id) => bSet.has(id)),
    aOnly: aIds.filter((id) => !bSet.has(id)),
    bOnly: bIds.filter((id) => !aSet.has(id)),
  };
}