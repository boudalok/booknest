/**
 * 顶层查询编排。
 *
 * 流程（设计文档 §6）：
 *   parse query
 *     → 对每个 enabled provider:
 *         1. 查 cache（命中即返回）
 *         2. circuit breaker 检查
 *         3. rate limit 检查
 *         4. 真实调用（带 per-provider timeout）
 *         5. 成功：写 snapshot + cache + 记录健康；失败：短 TTL 缓存空结果 + 记录健康
 *     → 收齐结果（Promise.allSettled，源之间互不影响）
 *     → 合并（按 ISBN/title 分组 + FIELD_PRIORITY）
 *     → 评分（§11.2）
 *     → 按 §11.3 决定 recommended / needsReview
 */

import { nanoid } from 'nanoid';
import type {
  BookCandidate,
  BookContributor,
  BookProvider,
  ProviderConfig,
  RankedBook,
  SearchQuery,
} from '@booknest/shared';
import { BookNestError } from '@booknest/shared';
import { env } from '../config/env.js';
import { getEnabledProviders } from '../config/providers.js';
import { getDb } from '../db/client.js';
import { sourceSnapshots } from '../db/schema.js';
import type { ProviderFetchResult } from '@booknest/shared';
import { buildCacheKey, readCache, writeCache } from './cache.js';
import { canCall, recordFailure, recordSuccess } from './circuit-breaker.js';
import { mergeCandidates, type MergedCandidate } from './merge.js';
import { persistMergedCandidate } from './persist.js';
import { ensureConfigured, tryAcquire } from './rate-limit.js';
import { scoreCandidate } from './score.js';

const GLOBAL_TIMEOUT_MS = 12_000;

export interface SearchResult {
  query: SearchQuery;
  results: RankedBook[];
}

export async function searchBooks(query: SearchQuery): Promise<SearchResult> {
  validateQuery(query);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('global-timeout')), GLOBAL_TIMEOUT_MS);
  try {
    const enabled = getEnabledProviders().filter((p) => {
      if (query.queryType === 'isbn') return p.config.supportsISBN;
      if (query.queryType === 'author') return p.config.supportsAuthorSearch === true;
      return p.config.supportsTitleSearch;
    });

    const settled = await Promise.allSettled(
      enabled.map((e) => fetchFromProvider(e.config, e.provider, query, ctrl.signal)),
    );

    const all: BookCandidate[] = [];
    for (const r of settled) {
      if (r.status === 'fulfilled') all.push(...r.value.candidates);
    }

    const merged = mergeCandidates(all);
    const scored = merged
      .map((m) => ({ m, s: scoreCandidate(m, query) }))
      .sort((a, b) => b.s - a.s);

    const ranked = scored.map(({ m, s }) => {
      const { id, workId, persisted } = persistWithRetry(m, s);
      return toRanked(m, s, id, workId, persisted);
    });
    applyReturnPolicy(query, scored, ranked);

    const limit = query.limit ?? 20;
    return { query, results: ranked.slice(0, limit) };
  } finally {
    clearTimeout(timer);
  }
}

function persistWithRetry(
  m: MergedCandidate,
  score: number,
): { id: string; workId?: string; persisted: boolean } {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { editionId, workId } = persistMergedCandidate(m, score);
      return { id: editionId, workId, persisted: true };
    } catch (err) {
      if (attempt === 0) continue;
      // eslint-disable-next-line no-console
      console.warn('[persist] failed after retry:', (err as Error).message);
    }
  }
  return { id: nanoid(), persisted: false };
}

function validateQuery(query: SearchQuery): void {
  if (query.queryType === 'isbn' && !query.isbn) {
    throw new BookNestError('INVALID_QUERY', 'ISBN query requires isbn field', 400);
  }
  if (query.queryType === 'author' && !query.author) {
    throw new BookNestError('INVALID_QUERY', 'author query requires author field', 400);
  }
  if (
    (query.queryType === 'title' || query.queryType === 'title_author') &&
    !query.title
  ) {
    throw new BookNestError('INVALID_QUERY', 'title query requires title field', 400);
  }
}

async function fetchFromProvider(
  config: ProviderConfig,
  provider: BookProvider,
  query: SearchQuery,
  outerSignal: AbortSignal,
): Promise<ProviderFetchResult> {
  const cacheKey = buildCacheKey({
    provider: config.name,
    queryType: query.queryType,
    // Invalidate cached empty Google results from the previous strict title query.
    query: config.name === 'google_books' ? `google-v2:${cacheQueryString(query)}` : cacheQueryString(query),
    language: query.language,
  });

  const cached = readCache<BookCandidate[]>(cacheKey);
  if (cached !== null) {
    console.info(`[provider] ${config.name} cache-hit count=${cached.length}`);
    return { candidates: cached, snapshot: null };
  }

  if (!canCall(config.name)) return { candidates: [], snapshot: null };
  ensureConfigured(config.name, config.rateLimitPerMinute);
  if (!tryAcquire(config.name)) return { candidates: [], snapshot: null };

  const ctrl = new AbortController();
  const timer = setTimeout(
    () => ctrl.abort(new Error('provider-timeout')),
    config.timeoutMs,
  );
  const onOuter = () => ctrl.abort();
  outerSignal.addEventListener('abort', onOuter, { once: true });

  try {
    const outcome = await queryProvider(provider, query, ctrl.signal);
    console.info(`[provider] ${config.name} fetched count=${outcome.candidates.length}`);
    recordSuccess(config.name);
    if (outcome.snapshot !== null) {
      recordSnapshot({
        source: config.name,
        queryType: query.queryType,
        query: cacheQueryString(query),
        data: outcome.snapshot,
      });
    }
    writeCache(cacheKey, outcome.candidates, config.cacheTtlDays, {
      query: cacheQueryString(query),
      queryType: query.queryType,
    });
    return outcome;
  } catch (e) {
    const msg = (e as Error).message;
    console.warn(`[provider] ${config.name} failed: ${msg.replace(/https?:\/\/\S+/g, '[upstream-url]')}`);
    recordFailure(config.name, msg);
    writeCache(cacheKey, [] as BookCandidate[], env.FAILURE_CACHE_TTL_DAYS, {
      query: cacheQueryString(query),
      queryType: query.queryType,
    });
    return { candidates: [], snapshot: null };
  } finally {
    clearTimeout(timer);
    outerSignal.removeEventListener('abort', onOuter);
  }
}

async function queryProvider(
  provider: BookProvider,
  query: SearchQuery,
  signal: AbortSignal,
): Promise<ProviderFetchResult> {
  if (query.queryType === 'isbn' && query.isbn) {
    return provider.searchByISBN(query.isbn, signal);
  }
  if (query.queryType === 'author' && query.author && provider.searchByAuthor) {
    return provider.searchByAuthor(
      {
        author: query.author,
        limit: query.limit ?? 20,
        language: query.language,
      },
      signal,
    );
  }
  if (!query.title) return { candidates: [], snapshot: null };
  return provider.searchByTitle(
    {
      title: query.title,
      author: query.author,
      limit: query.limit ?? 10,
      language: query.language,
    },
    signal,
  );
}

function cacheQueryString(query: SearchQuery): string {
  if (query.queryType === 'isbn') return query.isbn ?? query.raw;
  if (query.queryType === 'author') return `author:${query.author ?? query.raw}`;
  if (query.queryType === 'title_author') {
    return [query.title, query.author].filter(Boolean).join('|');
  }
  return query.title ?? query.raw;
}

function recordSnapshot(input: {
  source: string;
  queryType: string;
  query: string;
  data: unknown;
}): void {
  try {
    const db = getDb();
    db.insert(sourceSnapshots)
      .values({
        id: nanoid(),
        source: input.source,
        query: input.query,
        queryType: input.queryType,
        responseJson: input.data as object,
      })
      .run();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[snapshot] failed:', (err as Error).message);
  }
}

function mergedContributors(m: MergedCandidate): BookContributor[] {
  const out: BookContributor[] = m.authors.map((name) => ({ name, role: 'author' as const }));
  for (const name of m.translators ?? []) {
    out.push({ name, role: 'translator' });
  }
  for (const name of m.editors ?? []) {
    out.push({ name, role: 'editor' });
  }
  return out;
}

function toRanked(
  merged: MergedCandidate,
  score: number,
  id: string,
  workId: string | undefined,
  persisted: boolean,
): RankedBook {
  return {
    id,
    workId,
    title: merged.title,
    subtitle: merged.subtitle,
    authors: mergedContributors(merged),
    publisher: merged.publisher,
    publishedDate: merged.publishedDate,
    isbn10: merged.isbn10,
    isbn13: merged.isbn13,
    language: merged.language,
    pageCount: merged.pageCount,
    coverUrl: merged.coverUrl,
    description: merged.description,
    categories: merged.categories,
    confidence: score,
    recommended: false,
    needsReview: score < 60,
    sources: merged.sourceMeta.map((s) => ({
      name: s.name,
      externalId: s.externalId,
      externalUrl: s.externalUrl,
    })),
    ...(persisted ? {} : { ephemeral: true }),
  };
}

function applyReturnPolicy(
  query: SearchQuery,
  scored: Array<{ m: MergedCandidate; s: number }>,
  ranked: RankedBook[],
): void {
  const top = scored[0];
  if (!top) return;
  const second = scored[1];
  const isISBN = query.queryType === 'isbn';

  if (isISBN && top.s >= 80) {
    ranked[0]!.recommended = true;
  } else if (!isISBN && (second === undefined || top.s - second.s > 20)) {
    ranked[0]!.recommended = true;
  }
}
