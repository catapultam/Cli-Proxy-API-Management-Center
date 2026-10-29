/**
 * Source-contract test: the Docker nginx config must never pin HSTS on this host
 * (it breaks the plain HTTP UI port), and the Metabase server must keep its route.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const conf = readFileSync(new URL('../docker/nginx.conf.template', import.meta.url), 'utf8');
const dockerfile = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');
const [, uiServer, metabaseServer] = conf.split(/^server \{$/m);
const HSTS0 = 'add_header Strict-Transport-Security "max-age=0" always;';

describe('docker nginx HSTS', () => {
  test('two servers: UI on 80, Metabase on 8081', () => {
    expect(conf.match(/^server \{$/gm)).toHaveLength(2);
    expect(uiServer).toContain('listen 80;');
    expect(metabaseServer).toContain('listen 8081;');
  });

  test('every server and every location with add_header also sends HSTS max-age=0', () => {
    for (const server of [uiServer, metabaseServer]) {
      expect(server).toContain('proxy_hide_header Strict-Transport-Security;');
      const serverLevel = server.replace(/location [^{]*\{[^}]*\}/g, '');
      expect(serverLevel).toContain(HSTS0);
      // nginx drops inherited add_header when a location sets its own.
      for (const loc of server.match(/location [^{]*\{[^}]*\}/g) ?? []) {
        if (loc.includes('add_header')) expect(loc).toContain(HSTS0);
        if (loc.includes('proxy_hide_header')) {
          expect(loc).toContain('proxy_hide_header Strict-Transport-Security;');
        }
      }
    }
    expect(conf).not.toMatch(/Strict-Transport-Security "max-age=[1-9]/);
  });

  test('UI API proxy route is unchanged', () => {
    expect(uiServer).toContain('proxy_pass ${CPA_BACKEND};');
    expect(uiServer).toContain('proxy_set_header X-Forwarded-Proto $scheme;');
  });

  test('Metabase server uses runtime DNS and forwards as HTTPS', () => {
    expect(metabaseServer).toContain('resolver 127.0.0.11 valid=30s ipv6=off;');
    expect(metabaseServer).toContain('set $metabase_backend ${CPA_METABASE_BACKEND};');
    // Variable without URI: nginx passes the client request URI and query unchanged.
    expect(metabaseServer).toContain('proxy_pass $metabase_backend;');
    expect(metabaseServer).toContain('proxy_set_header Host $http_host;');
    expect(metabaseServer).toContain('proxy_set_header X-Forwarded-Host $http_host;');
    expect(metabaseServer).toContain('proxy_set_header X-Forwarded-Proto https;');
    expect(metabaseServer).toContain('proxy_set_header Connection $connection_upgrade;');
    expect(metabaseServer).toContain('proxy_buffering off;');
    expect(metabaseServer).toContain('access_log off;');
    expect(metabaseServer).toContain('error_log /var/log/nginx/error.log crit;');
  });

  test('Metabase server keeps its other security headers and cookies', () => {
    expect(metabaseServer).not.toMatch(
      /proxy_hide_header (Content-Security-Policy|X-Frame-Options|Set-Cookie)/i
    );
    expect(metabaseServer).not.toMatch(/proxy_cookie_/);
  });

  test('Dockerfile sets the Metabase backend and exposes 8081', () => {
    expect(dockerfile).toContain('ENV CPA_METABASE_BACKEND=http://proxy-analytics-metabase:3000');
    expect(dockerfile).toMatch(/^EXPOSE 80 8081$/m);
  });
});
