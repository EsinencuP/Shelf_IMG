import { describe, expect, it } from 'vitest';
import {
  nativeQueries,
  webQueries,
  canonicalText,
  titleRelevance,
} from '@/lib/server/search-queries';
import { matchCandidate } from '@/lib/server/matching';
import { catalogProducts, paced } from '@/lib/server/catalog-utils';
import { ApiError } from '@/lib/server/http';
import {
  zakazCandidates,
  ZAKAZ_STORES,
  linellaLinks,
  bucuriaLinks,
  bucuriaProductCandidates,
} from '@/lib/server/regional-search';
import {
  upcCandidates,
  openCatalogCandidates,
  OPEN_CATALOGS,
} from '@/lib/server/supplemental-search';
import type { Candidate } from '@/lib/types';

const product = {
  ean: '4840053004404',
  nameRu: 'Творог JLC 0% 500 г',
  nameRo: 'Branza JLC 0% 500g',
  brand: 'JLC',
  quantity: '500g',
};
const image: Candidate = {
  id: 'x',
  title: 'Творог JLC 0% 500г',
  brand: 'JLC',
  quantity: '500g',
  gtin: '04840053004404',
  imageUrl: 'https://img1.zakaz.md/x-s1350x1350.jpg',
  pageUrl: 'https://metro.zakaz.md/ru/products/jlc--04840053004404/',
  source: 'METRO Moldova',
  rights: 'unknown',
  gtinExact: true,
  warnings: [],
};

describe('Moldova and bilingual discovery', () => {
  it('uses a barcode, both language descriptions and a bounded manufacturer query', () => {
    const queries = webQueries(product, 4);
    expect(queries[0]).toBe('"4840053004404"');
    expect(queries.some((query) => query.includes('Творог'))).toBe(true);
    expect(queries.some((query) => query.includes('Branza'))).toBe(true);
    expect(queries.some((query) => query.includes('site:jlc.md'))).toBe(true);
    expect(queries.every((query) => query.length <= 400)).toBe(true);
    expect(webQueries(product, 1)).toHaveLength(1);
    expect(nativeQueries(product)[0]).toBe(product.ean);
  });
  it('normalizes CIS brand spelling and matches RU/RO category terms', () => {
    expect(canonicalText('Махеевъ')).toBe(canonicalText('Maheev'));
    expect(canonicalText('Рошен')).toBe(canonicalText('Roshen'));
    expect(titleRelevance({ ...product, nameRo: '' }, 'Branza JLC 0% 500g')).toBeGreaterThan(0.5);
    expect(matchCandidate({ ...product, brand: 'ДжЛЦ' }, image).rejected).toBe(false);
  });
  it('rejects different fat percentage or flavor even for similar packaging', () => {
    expect(matchCandidate(product, { ...image, title: 'Творог JLC 5% 500г' }).rejected).toBe(true);
    expect(
      matchCandidate(
        { ...product, nameRu: 'Йогурт JLC клубника 500г', nameRo: '', ean: '' },
        { ...image, gtin: undefined, title: 'Iaurt JLC piersica 500g' },
      ).rejected,
    ).toBe(true);
    expect(
      matchCandidate(
        { ...product, nameRu: 'Йогурт JLC клубника 500г', nameRo: '', ean: '' },
        { ...image, gtin: undefined, title: 'Iaurt JLC capsuna 500g' },
      ).rejected,
    ).toBe(false);
  });
});

describe('regional catalog adapters', () => {
  it('stops repeated calls to an unavailable upstream while other sources can continue', async () => {
    let calls = 0;
    const host = `outage-${crypto.randomUUID()}`;
    const results = await Promise.allSettled(
      [1, 2, 3].map(() =>
        paced(host, 0, async () => {
          calls++;
          throw new ApiError(504, 'Timeout');
        }),
      ),
    );
    expect(calls).toBe(1);
    expect(results.every((result) => result.status === 'rejected')).toBe(true);
    expect((results[1] as PromiseRejectedResult).reason.status).toBe(503);
    expect(await paced(`healthy-${crypto.randomUUID()}`, 0, async () => 42)).toBe(42);
  });
  it('rejects a nut variant when a cocoa variant was requested', () => {
    expect(
      matchCandidate(
        {
          ...product,
          ean: '',
          nameRu: '',
          nameRo: 'Roshen Konafetto cacao 140g',
          brand: 'Roshen',
          quantity: '140g',
        },
        {
          ...image,
          gtin: undefined,
          title: 'Roshen Konafetto nuci 140g',
          brand: 'Roshen',
          quantity: '140g',
        },
      ).rejected,
    ).toBe(true);
  });
  it('binds each manufacturer photo to its published packaging weight', () => {
    const html =
      '<div class="product-content-desc"><div class="product-title">Do-Re-Mi</div></div><div id="product-weight-block"><div class="weight-link" data-id="5" data-link="/ru/product/do-re-mi?offer-packaging=267"><span class="product-weight-item">Коробки</span></div></div><div id="product-weight-block-weights"><div class="weight-link" data-image="/photos/box200.webp" data-weight-fade-id="5"><div class="product-weight-item">200 г</div></div><div class="weight-link" data-image="/photos/box400.webp" data-weight-fade-id="5"><div class="product-weight-item">400 г</div></div></div>';
    const results = bucuriaProductCandidates(html, 'https://www.bucuria.md/ru/product/do-re-mi');
    expect(results).toHaveLength(2);
    expect(results[0].quantity).toBe('200 г');
    expect(results[1].quantity).toBe('400 г');
    expect(results[0].imageUrl).toBe('https://www.bucuria.md/photos/box200.webp');
    expect(
      matchCandidate(
        {
          ean: '',
          nameRu: 'Bucuria Do-Re-Mi 200 г',
          nameRo: '',
          brand: 'Bucuria',
          quantity: '200g',
        },
        results[1],
      ).rejected,
    ).toBe(true);
  });
  it('keeps original high-resolution images bound to a store EAN, not producer logos', () => {
    const results = zakazCandidates(
      {
        results: [
          {
            ean: image.gtin,
            title: image.title,
            web_url: image.pageUrl,
            img: { s350x350: 'https://img1.zakaz.md/small.jpg', s1350x1350: image.imageUrl },
            producer: {
              trademark: 'JLC',
              name: 'JLC Group',
              logo: { s64x64: 'https://img1.zakaz.md/logo.png' },
            },
          },
        ],
      },
      ZAKAZ_STORES[0],
    );
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      gtin: image.gtin,
      imageUrl: image.imageUrl,
      gtinExact: true,
      rights: 'unknown',
    });
    expect(matchCandidate(product, results[0]).candidate.gtinExact).toBe(true);
  });
  it('extracts only local product-card links and rejects foreign URLs', () => {
    const html =
      '<div class="ut2-gl__item"><img src="https://linella.md/images/x.jpg"><a class="product-title" href="/lactate/jlc/">JLC Smantana 15% 325g</a></div><a class="product-title" href="https://evil.site/">Other</a>';
    expect(linellaLinks(html, 'https://linella.md/')).toEqual([
      {
        title: 'JLC Smantana 15% 325g',
        url: 'https://linella.md/lactate/jlc/',
        thumbnail: 'https://linella.md/images/x.jpg',
      },
    ]);
    expect(
      bucuriaLinks(
        '<a class="product-title" href="/ru/product/do-re-mi">Do-Re-Mi</a><a class="product-title" href="/ru/login">Login</a>',
      ),
    ).toEqual([{ title: 'Do-Re-Mi', url: 'https://www.bucuria.md/ru/product/do-re-mi' }]);
  });
  it('marks absent barcode as unverified and excludes a different barcode and recommendations', () => {
    const html =
      '<script type="application/ld+json">' +
      JSON.stringify({
        '@type': 'Product',
        name: image.title,
        brand: { name: 'JLC' },
        image: [image.imageUrl],
        relatedProducts: { '@type': 'Product', name: 'Other', image: 'https://cdn.site/other.jpg' },
      }) +
      '</script>';
    expect(catalogProducts(html, image.pageUrl, product)).toEqual([]);
    const results = catalogProducts(html, image.pageUrl, product, true);
    expect(results).toHaveLength(1);
    expect(results[0].gtinExact).toBe(false);
    const different =
      '<script type="application/ld+json">' +
      JSON.stringify({
        '@type': 'Product',
        name: image.title,
        gtin13: '3017620422003',
        image: image.imageUrl,
      }) +
      '</script>';
    expect(catalogProducts(different, image.pageUrl, product, true)).toEqual([]);
  });
  it('uses UPC and other Open Facts only for the requested GTIN', () => {
    expect(
      upcCandidates(
        { items: [{ ean: product.ean, title: image.title, images: [image.imageUrl] }] },
        product,
      ),
    ).toHaveLength(1);
    expect(
      upcCandidates(
        { items: [{ ean: '3017620422003', title: image.title, images: [image.imageUrl] }] },
        product,
      ),
    ).toEqual([]);
    const results = openCatalogCandidates(
      {
        product: {
          code: product.ean,
          product_name: 'Cream',
          image_front_url: 'https://images.openbeautyfacts.org/x.jpg',
        },
      },
      product,
      OPEN_CATALOGS[0],
    );
    expect(results[0]).toMatchObject({
      source: 'Open Beauty Facts',
      gtinExact: true,
      rights: 'open_license',
    });
    expect(
      openCatalogCandidates(
        {
          product: {
            code: '3017620422003',
            image_front_url: 'https://images.openbeautyfacts.org/x.jpg',
          },
        },
        product,
        OPEN_CATALOGS[0],
      ),
    ).toEqual([]);
  });
});
