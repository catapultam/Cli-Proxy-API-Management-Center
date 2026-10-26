import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';
import { createInstance } from 'i18next';
import { createStaticHandler, createStaticRouter, StaticRouterProvider } from 'react-router';
import { GatewayModelsPage } from '@/features/gatewayModels/GatewayModelsPage';
import en from '../src/i18n/locales/en.json';

const i18n = createInstance();
await i18n.init({ lng: 'en', resources: { en: { translation: en } } });

describe('GatewayModelsPage', () => {
  test('first paint is a loading state with the explanation and sync note, and no editable save', async () => {
    const routes = [{ path: '/', element: createElement(GatewayModelsPage) }];
    const handler = createStaticHandler(routes);
    const context = await handler.query(new Request('http://localhost/'));
    if (context instanceof Response) throw new Error('unexpected redirect');
    const router = createStaticRouter(handler.dataRoutes, context);
    const markup = renderToStaticMarkup(
      createElement(
        I18nextProvider,
        { i18n },
        createElement(StaticRouterProvider, { router, context })
      )
    );
    expect(markup).toContain('Gateway models');
    expect(markup).toContain('/model picker');
    expect(markup).toContain('Install it once per client');
    expect(markup).toContain('new sessions');
    // Collapsed setup instructions with both commands and named copy buttons.
    expect(markup).toContain('Set up a client');
    expect(markup).toMatch(/<details(?![^>]*\sopen)/);
    expect(markup).toContain('claude plugin install gateway-models@homelab');
    expect(markup).toContain('/gateway-models-setup');
    expect(markup).toContain('Requires Node.js');
    expect(markup).toContain('aria-label="Copy the install command"');
    expect(markup).toContain('aria-label="Copy the setup command"');
    expect(markup).toContain('aria-label="Loading..."');
    expect(markup).not.toContain('Add model');
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>[^<]*(<[^>]+>)*Save changes/);
  });
});
