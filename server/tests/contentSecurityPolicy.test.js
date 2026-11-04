import { describe, expect, test } from '@jest/globals';
import request from 'supertest';
import { app } from '../src/app.js';

function parseCsp(header) {
  return Object.fromEntries(header.split(';').map((directive) => {
    const [name, ...values] = directive.trim().split(/\s+/);
    return [name, values];
  }));
}

describe('Content Security Policy', () => {
  test('allows only the external image origins used by the app and retains Helmet defaults', async () => {
    const response = await request(app).get('/health');
    const csp = parseCsp(response.headers['content-security-policy']);

    expect(csp['img-src']).toEqual([
      "'self'",
      'data:',
      'https://images.unsplash.com',
      'https://is1-ssl.mzstatic.com',
    ]);
    expect(csp['default-src']).toEqual(["'self'"]);
    expect(csp['script-src']).toEqual(["'self'"]);
    expect(csp['font-src']).toEqual(["'self'", 'https:', 'data:']);
    expect(csp['style-src']).toEqual(["'self'", 'https:', "'unsafe-inline'"]);
    expect(csp['img-src']).not.toContain('https:');
    expect(csp['img-src']).not.toContain('*');
  });
});
