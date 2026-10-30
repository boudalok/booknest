/**
 * 合并候选 → DB 持久化（works / editions / contributors / edition_sources / external_identifiers）。
 *
 * Work 关联（v0.1.1）：
 * - 同 normalizedTitle + 第一作者 → 复用已有 Work
 * - 不同 ISBN / 出版社 / 译者 → 仍各为独立 Edition
 * - 按 ISBN-13、ISBN-10 顺序匹配已有 Edition；无则插入
 * - 字段直接覆盖（candidate 总是当前合并的最新结果）
 *
 * 持久化失败不影响搜索返回——上层用 try-catch 包裹。
 */

import { eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import type { ContributorRole } from '@booknest/shared';
import { normalizeAuthorName, normalizeChineseTitle } from '@booknest/shared';
import { getDb } from '../db/client.js';
import {
  contributors,
  editionContributors,
  editionSources,
  editions,
  externalIdentifiers,
  works,
} from '../db/schema.js';
import type { MergedCandidate } from './merge.js';
import { findWorkForCandidate } from './work-link.js';

interface ContributorRow {
  name: string;
  role: ContributorRole;
  position: number;
}

function collectContributors(candidate: MergedCandidate): ContributorRow[] {
  const rows: ContributorRow[] = [];
  let pos = 0;
  for (const name of candidate.authors) {
    rows.push({ name, role: 'author', position: pos++ });
  }
  for (const name of candidate.translators ?? []) {
    rows.push({ name, role: 'translator', position: pos++ });
  }
  for (const name of candidate.editors ?? []) {
    rows.push({ name, role: 'editor', position: pos++ });
  }
  return rows;
}

export interface PersistResult {
  editionId: string;
  workId: string;
}

export function persistMergedCandidate(
  candidate: MergedCandidate,
  confidence: number,
): PersistResult {
  const db = getDb();

  return db.transaction((tx) => {
    let existing = candidate.isbn13
      ? (tx.select().from(editions).where(eq(editions.isbn13, candidate.isbn13)).get() ?? null)
      : null;
    if (!existing && candidate.isbn10) {
      existing = tx.select().from(editions).where(eq(editions.isbn10, candidate.isbn10)).get() ?? null;
    }

    const normalizedTitle = normalizeChineseTitle(candidate.title);
    const now = new Date().toISOString();
    const needsReview = confidence < 60;

    let editionId: string;
    let workId: string;

    if (existing) {
      editionId = existing.id;
      workId = existing.workId ?? findOrCreateWork(tx, candidate, normalizedTitle);
      tx.update(editions)
        .set({
          workId,
          title: candidate.title,
          normalizedTitle,
          subtitle: candidate.subtitle,
          publisher: candidate.publisher,
          publishedDate: candidate.publishedDate,
          isbn10: candidate.isbn10,
          isbn13: candidate.isbn13,
          pageCount: candidate.pageCount,
          language: candidate.language,
          coverUrl: candidate.coverUrl,
          description: candidate.description,
          categories: candidate.categories ?? null,
          confidence: Math.max(confidence, existing.confidence),
          needsReview,
          updatedAt: now,
        })
        .where(eq(editions.id, editionId))
        .run();
    } else {
      workId = findOrCreateWork(tx, candidate, normalizedTitle);
      editionId = nanoid();
      tx.insert(editions)
        .values({
          id: editionId,
          workId,
          title: candidate.title,
          normalizedTitle,
          subtitle: candidate.subtitle,
          publisher: candidate.publisher,
          publishedDate: candidate.publishedDate,
          isbn10: candidate.isbn10,
          isbn13: candidate.isbn13,
          pageCount: candidate.pageCount,
          language: candidate.language,
          coverUrl: candidate.coverUrl,
          description: candidate.description,
          categories: candidate.categories ?? null,
          confidence,
          needsReview,
        })
        .run();
    }

    syncContributors(tx, editionId, collectContributors(candidate));
    syncEditionSources(tx, editionId, candidate);
    syncExternalIdentifiers(tx, editionId, workId, candidate);

    return { editionId, workId };
  });
}

function syncContributors(
  tx: Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0],
  editionId: string,
  rows: ContributorRow[],
): void {
  tx.delete(editionContributors).where(eq(editionContributors.editionId, editionId)).run();

  for (const { name, role, position } of rows) {
    const normalizedName = normalizeAuthorName(name);
    if (!normalizedName) continue;

    tx.insert(contributors)
      .values({ id: nanoid(), name, normalizedName })
      .onConflictDoUpdate({
        target: contributors.normalizedName,
        set: { name },
      })
      .run();

    const contrib = tx
      .select()
      .from(contributors)
      .where(eq(contributors.normalizedName, normalizedName))
      .get();
    if (!contrib) continue;

    tx.insert(editionContributors)
      .values({
        editionId,
        contributorId: contrib.id,
        role,
        position,
      })
      .run();
  }
}

function syncEditionSources(
  tx: Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0],
  editionId: string,
  candidate: MergedCandidate,
): void {
  tx.delete(editionSources).where(eq(editionSources.editionId, editionId)).run();

  // One edition may have several Open Library edition links, but this table
  // enforces a single row per (edition, provider). Retain one canonical row.
  const sourcesSeen = new Set<string>();
  for (const meta of candidate.sourceMeta) {
    if (sourcesSeen.has(meta.name)) continue;
    sourcesSeen.add(meta.name);
    tx.insert(editionSources)
      .values({
        editionId,
        source: meta.name,
        externalId: meta.externalId ?? null,
        externalUrl: meta.externalUrl ?? null,
      })
      .run();
  }
}

function syncExternalIdentifiers(
  tx: Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0],
  editionId: string,
  workId: string,
  candidate: MergedCandidate,
): void {
  for (const ext of candidate.identifiers ?? []) {
    const source = ext.source ?? candidate.sources[0] ?? 'unknown';
    tx.insert(externalIdentifiers)
      .values({
        id: nanoid(),
        editionId,
        workId,
        source,
        identifierType: ext.type,
        identifierValue: ext.value,
      })
      .onConflictDoNothing()
      .run();
  }

  for (const meta of candidate.sourceMeta) {
    if (!meta.externalId) continue;
    tx.insert(externalIdentifiers)
      .values({
        id: nanoid(),
        editionId,
        workId,
        source: meta.name,
        identifierType: 'provider_id',
        identifierValue: meta.externalId,
        externalUrl: meta.externalUrl ?? null,
      })
      .onConflictDoNothing()
      .run();
  }
}

function findOrCreateWork(
  tx: Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0],
  candidate: MergedCandidate,
  normalizedTitle: string,
): string {
  const existingId = findWorkForCandidate(tx, normalizedTitle, candidate);
  if (existingId) {
    const now = new Date().toISOString();
    tx.update(works)
      .set({
        canonicalTitle: candidate.title,
        subtitle: candidate.subtitle,
        description: candidate.description,
        language: candidate.language,
        updatedAt: now,
      })
      .where(eq(works.id, existingId))
      .run();
    return existingId;
  }

  const workId = nanoid();
  tx.insert(works)
    .values({
      id: workId,
      canonicalTitle: candidate.title,
      normalizedTitle,
      subtitle: candidate.subtitle,
      description: candidate.description,
      language: candidate.language,
    })
    .run();
  return workId;
}
