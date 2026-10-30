/**
 * Open Library Provider。
 * 默认启用，rate limit 60/min，cache 90 天。
 *
 * 接口：
 *   GET https://openlibrary.org/search.json?q=isbn:{isbn}
 *   GET https://openlibrary.org/search.json?q={query}&limit={n}
 */

import type {
  BookProvider,
  ProviderFetchResult,
  SearchAuthorParams,
  SearchTitleParams,
} from '@booknest/shared';
import { parseISBN } from '@booknest/shared';
import { fetchJson } from '../../lib/http.js';
import { mapEdition, type OLEditionsResponse } from './edition.js';
import type { OLSearchResponse } from './types.js';

const BASE = 'https://openlibrary.org/search.json';
const FIELDS = [
  'key',
  'title',
  'subtitle',
  'author_name',
  'author_key',
  'publisher',
  'publish_date',
  'publish_year',
  'first_publish_year',
  'isbn',
  'language',
  'cover_i',
  'cover_edition_key',
  'edition_key',
  'number_of_pages_median',
  'first_sentence',
  'subject',
].join(',');

function buildUrl(query: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined) continue;
    params.set(k, String(v));
  }
  return `${BASE}?${params.toString()}`;
}

export class OpenLibraryProvider implements BookProvider {
  readonly name = 'open_library';

  async searchByISBN(isbn: string, signal?: AbortSignal): Promise<ProviderFetchResult> {
    const url = buildUrl({
      q: `isbn:${isbn}`,
      fields: FIELDS,
      limit: 5,
    });
    const data = await fetchJson<OLSearchResponse>(url, {
      provider: this.name,
      timeoutMs: 8000,
      signal,
    });
    const expected = parseISBN(isbn)?.isbn13;
    const resolved = await mapEditionDocs(data, signal);
    const candidates = resolved.filter((candidate) => candidate.isbn13 === expected);
    return { candidates, snapshot: data };
  }

  async searchByTitle(params: SearchTitleParams, signal?: AbortSignal): Promise<ProviderFetchResult> {
    let q = params.author ? `${params.title} ${params.author}` : params.title;
    if (Array.from(q).length < 3) {
      q = `title:${q}`;
    }
    const url = buildUrl({
      q,
      fields: FIELDS,
      limit: params.limit ?? 10,
      ...(params.language ? { language: olLangCode(params.language) } : {}),
    });
    const data = await fetchJson<OLSearchResponse>(url, {
      provider: this.name,
      timeoutMs: 8000,
      signal,
    });
    return { candidates: await mapEditionDocs(data, signal), snapshot: data };
  }

  async searchByAuthor(params: SearchAuthorParams, signal?: AbortSignal): Promise<ProviderFetchResult> {
    const url = buildUrl({
      author: params.author,
      fields: FIELDS,
      limit: params.limit ?? 20,
      ...(params.language ? { language: olLangCode(params.language) } : {}),
    });
    const data = await fetchJson<OLSearchResponse>(url, {
      provider: this.name,
      timeoutMs: 8000,
      signal,
    });
    return { candidates: await mapEditionDocs(data, signal), snapshot: data };
  }
}

function olLangCode(iso6391: string): string | undefined {
  const map: Record<string, string> = {
    zh: 'chi',
    en: 'eng',
    ja: 'jpn',
    ko: 'kor',
    fr: 'fre',
    de: 'ger',
    ru: 'rus',
    es: 'spa',
    it: 'ita',
  };
  return map[iso6391.toLowerCase()];
}


/**
 * Title/author searches return WORKS, not editions. Resolve each work to its
 * editions before emitting any ISBN. Never reuse the work-level cover, page
 * count, date, or unordered ISBN list as edition-specific evidence.
 * Bound enrichment to eight works to avoid excessive upstream requests.
 */
async function mapEditionDocs(data: OLSearchResponse, signal?: AbortSignal) {
  const candidates: ReturnType<typeof mapEdition> = [];
  const works = (data.docs ?? []).filter((doc) => /^\/works\/OL[^/]+W$/.test(doc.key)).slice(0, 8);
  const results = await Promise.allSettled(works.map(async (work) => {
    const url = `https://openlibrary.org${work.key}/editions.json?limit=100`;
    const editions = await fetchJson<OLEditionsResponse>(url, {
      provider: 'open_library',
      timeoutMs: 8000,
      signal,
    });
    return (editions.entries ?? []).flatMap((edition) => mapEdition(edition, work));
  }));
  for (const result of results) if (result.status === 'fulfilled') candidates.push(...result.value);
  return candidates;
}
