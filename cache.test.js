'use strict';

// Run with:  npm test   (Node >= 18: node --test | any Node: mocha)
const runner = typeof global.describe === 'function' && typeof global.it === 'function'
  ? { describe: global.describe, test: global.it, beforeEach: global.beforeEach }
  : require('node:test');
const { describe, test, beforeEach } = runner;

const assert = require('assert').strict;
const path = require('path');
const Module = require('module');
const EventEmitter = require('events');

// ---------------------------------------------------------------------------
// Fixtures and helpers
// ---------------------------------------------------------------------------

// request-promise-native is provided by the services (it is not a jslib dependency): cache.js gets a
// fake that records every call and answers with `reply(options)`.
const calls = [];
let reply = (options) => ({ data: options.qs.id.split(',').map((id) => ({ id, name: `name ${id}` })) });

const FAKE = path.join(__dirname, '__fake_request_promise_native__.js');
const fake = new Module(FAKE);
fake.filename = FAKE;
fake.loaded = true;
fake.exports = async (options) => {
  calls.push(options);
  return reply(options);
};
require.cache[FAKE] = fake;

const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  return request === 'request-promise-native' ? FAKE : resolve.call(this, request, ...rest);
};
const Cache = require('./cache');
Module._resolveFilename = resolve;

/** In-memory cache with the node-cache methods the Cache uses. */
function memory() {
  const map = new Map();
  return {
    get: (key) => map.get(key),
    set: (key, value) => map.set(key, value),
    del: (keys) => [].concat(keys).forEach((key) => map.delete(key)),
    keys: () => [...map.keys()],
  };
}

/** A topic that never connects; `handler` is the callback the Cache subscribed. */
function topic() {
  return { event: new EventEmitter(), handler: null, subscribe(fn) { this.handler = fn; } };
}

/** A Cache of vehicles whose request is built by DEFAULT_REQUEST(options). */
function vehicles(options = {}) {
  return new Cache({
    cache: memory(),
    topic: topic(),
    key: 'vehicles:v4',
    fn: Cache.fn.DEFAULT_REQUEST({ uri: 'http://vehicles:80', ...options }),
    handler: { response: Cache.fn.DEFAULT_RESPONSE_HANDLER(), topic: Cache.fn.DEFAULT_TOPIC_ID_HANDLER() },
  });
}

/** An express-like request carrying a token. */
const withToken = { get: (header) => (header.toLowerCase() === 'authorization' ? 'Bearer user-token' : undefined) };

beforeEach(() => {
  calls.length = 0;
});

// ===========================================================================
describe('DEFAULT_REQUEST: the token', () => {
  test('default: no authorization header, even when req has one', async () => {
    await vehicles().get({ req: withToken, keys: ['v1'] });

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].headers, {});
  });

  test('forward: true with a token: the header is sent', async () => {
    await vehicles({ forward: true }).get({ req: withToken, keys: ['v1'] });

    assert.deepEqual(calls[0].headers, { authorization: 'Bearer user-token' });
  });

  test('forward: true without req, or without a token: no header and no crash', async () => {
    await vehicles({ forward: true }).get({ keys: ['v1'] });
    await vehicles({ forward: true }).get({ req: { get: () => undefined }, keys: ['v2'] });
    await vehicles({ forward: true }).get({ req: {}, keys: ['v3'] });

    assert.equal(calls.length, 3);
    calls.forEach((call) => assert.ok(!('authorization' in call.headers)));
  });
});

// ===========================================================================
describe('DEFAULT_REQUEST: the query', () => {
  test('defaults as before: version 1, id, limit = number of keys', async () => {
    await vehicles().get({ keys: ['v1', 'v2'] });

    assert.deepEqual(calls[0], {
      method: 'GET',
      uri: 'http://vehicles:80',
      headers: {},
      qs: { version: '1', id: 'v1,v2', limit: 2 },
      json: true,
    });
  });

  test('version, key and limit as before', async () => {
    reply = (options) => ({ data: options.qs.tag.split(',').map((tag) => ({ id: `id-${tag}`, tag })) });
    const cache = new Cache({
      cache: memory(),
      topic: topic(),
      key: 'drivers:v2',
      fn: Cache.fn.DEFAULT_REQUEST({ uri: 'http://drivers:80', key: 'tag', version: 2, limit: '*' }),
      handler: { response: Cache.fn.DEFAULT_RESPONSE_HANDLER({ key: 'tag' }), topic: Cache.fn.DEFAULT_TOPIC_ID_HANDLER() },
    });

    await cache.get({ keys: ['t1'] });

    assert.deepEqual(calls[0].qs, { version: 2, tag: 't1', limit: '*' });
    reply = (options) => ({ data: options.qs.id.split(',').map((id) => ({ id, name: `name ${id}` })) });
  });

  test('params are merged into qs', async () => {
    await vehicles({ version: 4, params: { including: 'other-vehicles' } }).get({ keys: ['v1'] });

    assert.deepEqual(calls[0].qs, { version: 4, id: 'v1', limit: 1, including: 'other-vehicles' });
  });
});

// ===========================================================================
describe('get', () => {
  test('the second call is served from the cache: the request runs once', async () => {
    const cache = vehicles();

    const first = await cache.get({ req: withToken, keys: ['v1'] });
    const second = await cache.get({ req: withToken, keys: ['v1'] });

    assert.equal(calls.length, 1);
    assert.deepEqual(first.asArray(), [{ id: 'v1', name: 'name v1' }]);
    assert.deepEqual(second.asArray(), [{ id: 'v1', name: 'name v1' }]);
    assert.deepEqual(second.asHash(), { v1: { id: 'v1', name: 'name v1' } });
  });

  test('only the missing keys are requested', async () => {
    const cache = vehicles();

    await cache.get({ keys: ['v1'] });
    await cache.get({ keys: ['v1', 'v2'] });

    assert.equal(calls.length, 2);
    assert.equal(calls[1].qs.id, 'v2');
  });
});

// ===========================================================================
describe('topic', () => {
  test('a change on the topic removes the entry from the cache', async () => {
    const cache = vehicles();
    await cache.get({ keys: ['v1'] });

    cache.topic.handler(JSON.stringify({ type: 2, id: 'v1' }));
    await cache.get({ keys: ['v1'] });

    assert.equal(calls.length, 2);
  });

  test('wrong data is logged with the cache key', () => {
    const cache = vehicles();
    const logged = [];
    const log = console.log;
    console.log = (message) => logged.push(message);
    try {
      cache.topic.handler('not json');
    } finally {
      console.log = log;
    }

    assert.equal(logged.length, 1);
    assert.match(logged[0], /^vehicles:v4 - .* - wrong data received: not json$/);
  });
});
