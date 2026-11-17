import test from 'node:test';
import assert from 'node:assert/strict';

import { PRIVATE_API_BASE, PUBLIC_API_BASE } from '../src/lib/utils.js';

test('public and private API origins remain explicit and separate', () => {
  assert.equal(PUBLIC_API_BASE, 'https://barktown-api.enchart.me');
  assert.equal(PRIVATE_API_BASE, 'https://barktown-private.tail523149.ts.net');
  assert.notEqual(new URL(PUBLIC_API_BASE).origin, new URL(PRIVATE_API_BASE).origin);
});
