/** Edition-specific Open Library mapping. Never infer an edition ISBN from a work-level ISBN array. */
import type { BookCandidate } from '@booknest/shared';
import { parseISBN } from '@booknest/shared';
import type { OLSearchDoc } from './types.js';

export interface OLEdition {
  key: string;
  title?: string;
  subtitle?: string;
  isbn_13?: string[];
  isbn_10?: string[];
  publish_date?: string;
  publishers?: string[];
  number_of_pages?: number;
  physical_format?: string;
  covers?: number[];
  languages?: Array<{ key: string }>;
}
export interface OLEditionsResponse { entries?: OLEdition[]; }

export function mapEdition(edition: OLEdition, work: OLSearchDoc): BookCandidate[] {
  if (!edition.key?.startsWith('/books/') || !(edition.title || work.title)) return [];
  const unique = new Map<string, {isbn10?:string; isbn13:string}>();
  for (const raw of [...(edition.isbn_13 ?? []), ...(edition.isbn_10 ?? [])]) {
    const pair = parseISBN(raw);
    if (pair) unique.set(pair.isbn13, pair);
  }
  const cover = edition.covers?.[0];
  const lang = edition.languages?.[0]?.key.split('/').pop();
  const iso: Record<string,string> = { eng:'en',fre:'fr',fra:'fr',ger:'de',deu:'de',spa:'es',dut:'nl',nld:'nl' };
  const candidates: BookCandidate[] = [];
  for (const pair of unique.values()) {
    candidates.push({
      title: edition.title ?? work.title!,
      subtitle: edition.subtitle,
      authors: work.author_name ?? [],
      publisher: edition.publishers?.[0],
      publishedDate: edition.publish_date,
      isbn10: pair.isbn10,
      isbn13: pair.isbn13,
      language: lang ? (iso[lang] ?? lang) : undefined,
      pageCount: edition.number_of_pages,
      coverUrl: cover ? `https://covers.openlibrary.org/b/id/${cover}-L.jpg` : undefined,
      source: 'open_library',
      externalId: edition.key,
      externalUrl: `https://openlibrary.org${edition.key}`,
      raw: { edition, workKey:work.key },
    });
  }
  return candidates;
}
