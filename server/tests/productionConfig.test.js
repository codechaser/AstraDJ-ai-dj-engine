import { describe, expect, test } from '@jest/globals';
import { assertRuntimeConfig } from '../src/config/env.js';
import { refreshCookieOptions } from '../src/controllers/authController.js';

const productionConfig = (overrides = {}) => ({
  nodeEnv: 'production',
  clientOrigin: 'https://astradj.example',
  mongoUri: 'mongodb://127.0.0.1:27017/astradj_deployment_config_test',
  jwtAccessSecret: 'deployment-test-placeholder-secret-0001',
  refreshTtlDays: 7,
  ...overrides,
});

describe('production runtime configuration', () => {
  test('requires an explicit secure same-origin CORS origin', () => {
    expect(() => assertRuntimeConfig(productionConfig({ clientOrigin: null }))).toThrow('CLIENT_ORIGIN is required in production');
    expect(() => assertRuntimeConfig(productionConfig({ clientOrigin: 'http://astradj.example' }))).toThrow('CLIENT_ORIGIN must use HTTPS in production');
    expect(() => assertRuntimeConfig(productionConfig())).not.toThrow();
    expect(() => assertRuntimeConfig(productionConfig({ nodeEnv: 'development', clientOrigin: null }))).not.toThrow();
  });

  test('keeps refresh cookies HttpOnly and SameSite=Strict, and marks them Secure in production', () => {
    expect(refreshCookieOptions({ cookieSecure: true, refreshTtlDays: 7 })).toMatchObject({
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: '/api/v1/auth',
    });
    expect(refreshCookieOptions({ cookieSecure: false, refreshTtlDays: 7 })).toMatchObject({
      httpOnly: true,
      secure: false,
      sameSite: 'strict',
    });
  });
});
