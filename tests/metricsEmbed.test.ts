import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';
import { createInstance } from 'i18next';
import { MetricsPage } from '@/features/metrics/MetricsPage';
import {
  METRICS_EMBED_PATH,
  isMetabaseEmbedUrl,
  metricsEmbedRefreshDelay,
  normalizeMetricsEmbed,
} from '@/services/api/metricsEmbed';
import en from '../src/i18n/locales/en.json';

const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjF9.c2ln';
const URL_OK = `https://cakebox.example.ts.net:8447/embed/dashboard/${TOKEN}#bordered=true&titled=true`;

const i18n = createInstance();
await i18n.init({ lng: 'en', resources: { en: { translation: en } } });

describe('metrics embed API', () => {
  test('uses the fixed v8 observability route with no caller-selected resource', () => {
    expect(METRICS_EMBED_PATH).toBe('/observability/usage/metrics-embed');
    const source = readFileSync('src/services/api/metricsEmbed.ts', 'utf8');
    expect(source).toContain('apiClient.get<unknown>(METRICS_EMBED_PATH)');
    expect(source).not.toMatch(/params|dashboard_id|dashboardId/);
  });

  test('normalizes configured and unconfigured responses', () => {
    expect(normalizeMetricsEmbed({ configured: false })).toEqual({ configured: false });
    expect(
      normalizeMetricsEmbed({ configured: true, url: URL_OK, expires_at: '2027-01-15T08:00:00Z' })
    ).toEqual({ configured: true, url: URL_OK, expiresAt: Date.parse('2027-01-15T08:00:00Z') });
  });

  test('rejects any URL that is not an https Metabase dashboard embed', () => {
    for (const url of [
      'javascript:alert(1)',
      `http://cakebox.example/embed/dashboard/${TOKEN}`,
      'https://cakebox.example/dashboard/1',
      `https://u:p@cakebox.example/embed/dashboard/${TOKEN}`,
      `https://cakebox.example/embed/question/${TOKEN}`,
      'data:text/html,<p>x</p>',
    ]) {
      expect(isMetabaseEmbedUrl(url)).toBe(false);
      expect(() =>
        normalizeMetricsEmbed({ configured: true, url, expires_at: '2027-01-15T08:00:00Z' })
      ).toThrow();
    }
    expect(() => normalizeMetricsEmbed({ configured: true, url: URL_OK })).toThrow();
    expect(() => normalizeMetricsEmbed(null)).toThrow();
  });

  test('refreshes one minute before expiry, never sooner than 30 seconds', () => {
    expect(metricsEmbedRefreshDelay(600_000, 0)).toBe(540_000);
    expect(metricsEmbedRefreshDelay(10_000, 0)).toBe(30_000);
    expect(metricsEmbedRefreshDelay(3_600_000, 0)).toBe(540_000);
  });
});

describe('MetricsPage', () => {
  test('first paint is a loading state with the page title and no iframe', () => {
    const markup = renderToStaticMarkup(
      createElement(I18nextProvider, { i18n }, createElement(MetricsPage))
    );
    expect(markup).toContain('<h1');
    expect(markup).toContain(en.metrics.title);
    expect(markup).toContain('role="status"');
    expect(markup).not.toContain('<iframe');
  });

  test('iframe has an accessible title, no referrer, sandbox without top navigation', () => {
    const source = readFileSync('src/features/metrics/MetricsPage.tsx', 'utf8');
    expect(source).toContain("title={t('metrics.frame_title')}");
    expect(source).toContain('referrerPolicy="no-referrer"');
    expect(source).toMatch(/sandbox="[^"]*allow-scripts[^"]*"/);
    expect(source).not.toContain('allow-top-navigation');
    expect(source).not.toContain('dangerouslySetInnerHTML');
    expect(source).toContain('visibilitychange');
    expect(source).toContain("state.isAuthenticated ? state.apiBase : ''");
  });

  test('route and observe nav entry exist, with keys in every locale', () => {
    expect(readFileSync('src/router/MainRoutes.tsx', 'utf8')).toContain(
      "{ path: '/metrics', element: <MetricsPage /> }"
    );
    expect(readFileSync('src/components/layout/MainLayout.tsx', 'utf8')).toContain(
      "path: '/metrics',"
    );
    for (const lang of ['en', 'zh-CN', 'zh-TW', 'ru']) {
      const locale = JSON.parse(readFileSync(`src/i18n/locales/${lang}.json`, 'utf8'));
      expect(Object.keys(locale.metrics).sort()).toEqual(Object.keys(en.metrics).sort());
      expect(typeof locale.nav.metrics).toBe('string');
      expect(typeof locale.nav_meta.metrics).toBe('string');
    }
  });
});
