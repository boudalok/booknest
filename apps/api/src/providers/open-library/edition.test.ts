import { describe, expect, it } from 'vitest';
import { mapEdition } from './edition.js';

const work = {
  key: '/works/OL16917879W',
  title: 'Neuroscience',
  author_name: ['Dale Purves'],
  isbn: ['9781605358413','0878936467','9780878937257'],
  cover_i: 674022,
  number_of_pages_median: 787,
};

describe('Open Library edition-safe resolver', () => {
  it('does not leak work-level cover or page count into the 2018 edition', () => {
    const found = mapEdition({
      key:'/books/OL29407952M',
      title:'Neuroscience',
      isbn_13:['9781605358413'],
      publish_date:'2018',
      number_of_pages:960,
      publishers:['Oxford University Press, Incorporated'],
    },work);
    expect(found).toHaveLength(1);
    expect(found[0]?.isbn10).toBe('160535841X');
    expect(found[0]?.isbn13).toBe('9781605358413');
    expect(found[0]?.pageCount).toBe(960);
    expect(found[0]?.coverUrl).toBeUndefined();
    expect(found[0]?.externalId).toBe('/books/OL29407952M');
  });
  it('keeps the 2004 Neuroscience edition separate', () => {
    const older = mapEdition({
      key:'/books/OL8127194M',
      isbn_13:['9780878937257'],
      publish_date:'June 2004',
      covers:[674022],
      number_of_pages:773,
    },work);
    expect(older[0]?.isbn10).toBe('0878937250');
    expect(older[0]?.pageCount).toBe(773);
    expect(older[0]?.coverUrl).toContain('674022');
  });
  it('recognizes the exact Calculus International Metric Edition', () => {
    const result = mapEdition({
      key:'/books/OL12345M',
      title:'Calculus, Early Transcendentals, International Metric Edition',
      isbn_10:['1305272374'],
      isbn_13:['9781305272378'],
    },{key:'/works/OL20305330W',title:'Calculus, Early Transcendentals, International Metric Edition',author_name:['James Stewart']});
    expect(result).toHaveLength(1);
    expect(result[0]?.isbn13).toBe('9781305272378');
    expect(result[0]?.isbn10).toBe('1305272374');
  });
  it('rejects invalid ISBNs without borrowing from neighboring editions', () => {
    expect(mapEdition({key:'/books/OL1M',title:'Neuroscience',isbn_13:['9781605358410']},work)).toEqual([]);
  });
});
