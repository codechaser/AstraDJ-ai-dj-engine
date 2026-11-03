import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import { mountProductionFrontend } from '../src/middleware/productionFrontend.js';
import { app as runtimeApp } from '../src/app.js';

describe('production frontend hosting', () => {
  let distDirectory;
  let app;

  beforeAll(() => {
    distDirectory = mkdtempSync(path.join(tmpdir(), 'astradj-render-dist-'));
    mkdirSync(path.join(distDirectory, 'assets'), { recursive: true });
    mkdirSync(path.join(distDirectory, 'audio'), { recursive: true });
    writeFileSync(path.join(distDirectory, 'index.html'), '<!doctype html><main id="root">AstraDJ test shell</main>');
    writeFileSync(path.join(distDirectory, 'assets', 'cover.webp'), 'cover-bytes');
    writeFileSync(path.join(distDirectory, 'audio', 'demo.ogg'), 'audio-bytes');

    app = express();
    app.get('/health', (_req, res) => res.json({ status: 'ok' }));
    app.get('/api/v1/known', (_req, res) => res.json({ item: 'api' }));
    mountProductionFrontend(app, distDirectory);
    app.use((_req, res) => res.status(404).json({ error: { code: 'ROUTE_NOT_FOUND' } }));
  });

  afterAll(() => {
    if (distDirectory) rmSync(distDirectory, { recursive: true, force: true });
  });

  test.each(['/now-playing', '/profile', '/podcasts', '/radio'])('serves the SPA shell on direct GET %s', async (route) => {
    const response = await request(app).get(route).set('Accept', 'text/html');
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/text\/html/);
    expect(response.text).toContain('AstraDJ test shell');
  });

  test('serves Vite assets including artwork and audio from dist', async () => {
    expect((await request(app).get('/assets/cover.webp')).status).toBe(200);
    expect((await request(app).get('/audio/demo.ogg')).status).toBe(200);
  });

  test('handles health and known API routes before frontend fallback', async () => {
    expect((await request(app).get('/health').set('Accept', 'text/html')).body).toEqual({ status: 'ok' });
    expect((await request(app).get('/api/v1/known').set('Accept', 'text/html')).body).toEqual({ item: 'api' });
  });

  test.each(['/api/v1/not-a-route', '/socket.io/?EIO=4&transport=polling', '/health/unknown'])('%s never receives the SPA shell', async (route) => {
    const response = await request(app).get(route).set('Accept', 'text/html');
    expect(response.status).toBe(404);
    expect(response.headers['content-type']).toMatch(/application\/json/);
    expect(response.text).not.toContain('AstraDJ test shell');
  });

  test('does not replace non-HTML requests with the SPA shell', async () => {
    const response = await request(app).get('/profile').set('Accept', 'application/json');
    expect(response.status).toBe(404);
    expect(response.text).not.toContain('AstraDJ test shell');
  });

  test('does not mount the frontend static handler outside production', async () => {
    const response = await request(runtimeApp).get('/now-playing').set('Accept', 'text/html');
    expect(response.status).toBe(404);
    expect(response.text).not.toContain('AstraDJ test shell');
  });
});
