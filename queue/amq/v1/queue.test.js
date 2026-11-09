'use strict';

// Run with:  npm test   (Node >= 18: node --test | any Node: mocha)
//
// Most tests run against a fake STOMP broker defined below: it answers CONNECT and records every
// frame the client sends, so they check what really goes over the wire. The last group needs a real
// ActiveMQ and only runs when AMQ_PORT is set (credentials admin/admin unless AMQ_USER / AMQ_PASSWORD):
//
//   docker run -d --rm --name amq -p 61613:61613 webcenter/activemq
//   AMQ_PORT=61613 npm test
const runner = typeof global.describe === 'function' && typeof global.it === 'function'
  ? { describe: global.describe, test: global.it, before: global.before, after: global.after, afterEach: global.afterEach }
  : require('node:test');
const { describe, test, before, after, afterEach } = runner;

const assert = require('assert').strict;
const net = require('net');
const { Queue } = require('./queue');

// ---------------------------------------------------------------------------
// Fake broker and helpers
// ---------------------------------------------------------------------------

/** Just enough STOMP: answers CONNECT with CONNECTED (unless `silent`) and records every frame. */
class FakeBroker {
  constructor({ silent = false } = {}) {
    this.silent = silent;
    this.frames = [];   // { conn, command, headers }
    this.sockets = [];  // index = conn - 1
    this.server = net.createServer((sock) => this.accept(sock));
  }

  start() {
    return new Promise((resolve) => this.server.listen(0, '127.0.0.1', () => resolve(this)));
  }

  get port() { return this.server.address().port; }

  accept(sock) {
    this.sockets.push(sock);
    const conn = this.sockets.length;
    let buffer = '';
    sock.on('error', () => {});
    sock.on('data', (data) => {
      buffer += data.toString();
      let end;
      while ((end = buffer.indexOf('\0')) >= 0) {
        const raw = buffer.slice(0, end).replace(/^\n+/, ''); // heart-beats are bare newlines
        buffer = buffer.slice(end + 1);
        if (!raw) continue;
        const [command, ...lines] = raw.split('\n\n')[0].split('\n');
        const headers = Object.fromEntries(lines.map((l) => [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':') + 1)]));
        this.frames.push({ conn, command, headers });
        if (command === 'CONNECT' && !this.silent) this.connected(conn);
      }
    });
  }

  /** Sends CONNECTED on connection `conn` (no heart-beat header, so the client starts no timers). */
  connected(conn) { this.sockets[conn - 1].write(`CONNECTED\nversion:1.1\nsession:s${conn}\n\n\0`); }

  /** Frames with this command, optionally on one connection only. */
  sent(command, conn) { return this.frames.filter((f) => f.command === command && (conn === undefined || f.conn === conn)); }

  /** Delivers a MESSAGE on the latest connection. */
  deliver(destination, body, messageId = 'm1') {
    this.sockets[this.sockets.length - 1].write(`MESSAGE\ndestination:${destination}\nmessage-id:${messageId}\nsubscription:x\n\n${body}\0`);
  }

  error(message) {
    this.sockets[this.sockets.length - 1].write(`ERROR\nmessage:${message}\n\n\0`);
  }

  /** Drops every connection: the client reconnects by itself (the 'reconnect' event). */
  drop() { this.sockets.forEach((s) => s.destroy()); }

  stop() {
    this.drop();
    return new Promise((resolve) => this.server.close(resolve));
  }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits until `condition()` is true (fails the test after `ms`). */
async function until(condition, ms = 3000) {
  for (let t = 0; t < ms; t += 10) {
    if (condition()) return;
    await wait(10);
  }
  assert.fail('condition not met in time');
}

/** Triggers the path taken after the client gave up reconnecting: a brand new connection. */
const fullReconnect = (queue) => queue.mq.emit('error', new Error('Server has gone away [reconnect attempts reached]'));

// Every Queue and broker a test opens is closed after it, so no socket or timer keeps the process alive.
let opened = [];
let brokers = [];

async function broker(options) {
  const b = await new FakeBroker(options).start();
  brokers.push(b);
  return b;
}

function open(destination, port, auth = { user: 'u', password: 'p' }) {
  const queue = new Queue({ host: 'http://127.0.0.1', port, destination, ...auth });
  opened.push(queue);
  return queue;
}

function close(queue) {
  const mq = queue.mq;
  mq.removeAllListeners();
  mq.on('error', () => {});
  mq.stopHeartBeats();
  clearTimeout(mq._reconnectTimer);
  if (mq.stream) mq.stream.destroy();
}

// The Queue logs every connection event; keep the test output readable.
const consoleInfo = console.info;
const consoleError = console.error;

before(() => {
  console.info = () => {};
  console.error = () => {};
});

after(() => {
  console.info = consoleInfo;
  console.error = consoleError;
});

afterEach(async () => {
  opened.forEach(close);
  await Promise.all(brokers.map((b) => b.stop()));
  opened = [];
  brokers = [];
});

// ===========================================================================
describe('subscribe headers', () => {
  test('topics subscribe with ack auto by default, queues with client-individual', async () => {
    const b = await broker();
    const topic = open('/topic/news', b.port);
    const queue = open('/queue/work', b.port);
    await topic.connect();
    await queue.connect();

    await topic.subscribe(() => {});
    await queue.subscribe(() => {});

    await until(() => b.sent('SUBSCRIBE').length === 2);
    const ack = Object.fromEntries(b.sent('SUBSCRIBE').map((f) => [f.headers.destination, f.headers.ack]));
    assert.deepEqual(ack, { '/topic/news': 'auto', '/queue/work': 'client-individual' });
  });

  test('custom headers are sent, an explicit ack wins over the default, the id is always generated', async () => {
    const b = await broker();
    const topic = open('/topic/news', b.port);
    await topic.connect();

    await topic.subscribe(() => {}, { ack: 'client-individual', selector: "type='1'", id: 'mine', destination: '/topic/other' });

    await until(() => b.sent('SUBSCRIBE').length === 1);
    const { headers } = b.sent('SUBSCRIBE')[0];
    assert.equal(headers.ack, 'client-individual');
    assert.equal(headers.selector, "type='1'");
    assert.equal(headers.destination, '/topic/news'); // the destination is the Queue's
    assert.notEqual(headers.id, 'mine');                // delete() / unsubscribe() rely on the generated id
    assert.equal(headers.id, topic.subscription);
  });

  test('a second subscribe() adds a callback but no SUBSCRIBE: the first headers apply', async () => {
    const b = await broker();
    const topic = open('/topic/prices', b.port);
    await topic.connect();

    const got = [];
    await topic.subscribe((body) => got.push(`first:${body}`));
    await topic.subscribe((body) => got.push(`second:${body}`), { ack: 'client' });
    await wait(50);

    assert.equal(b.sent('SUBSCRIBE').length, 1);
    assert.equal(b.sent('SUBSCRIBE')[0].headers.ack, 'auto');

    b.deliver('/topic/prices', 'x');
    await until(() => got.length === 2);
    assert.deepEqual(got, ['first:x', 'second:x']);
  });
});

// ===========================================================================
describe('subscribing before the connection is up', () => {
  test('SUBSCRIBE is sent after CONNECT, once', async () => {
    const b = await broker();
    const topic = open('/topic/news', b.port);
    topic.subscribe(() => {}); // right after new Queue(), as the services' caches do

    await until(() => b.sent('SUBSCRIBE').length === 1);
    await wait(50);
    assert.deepEqual(b.frames.map((f) => f.command), ['CONNECT', 'SUBSCRIBE']);
  });

  test('subscribe() resolves at once, and the SUBSCRIBE waits for CONNECTED', async () => {
    const b = await broker({ silent: true }); // accepts the connection but does not answer CONNECT yet
    const topic = open('/topic/news', b.port);

    await topic.subscribe(() => {}); // must not hang while the broker is unavailable
    await until(() => b.sent('CONNECT').length === 1);
    await wait(50);
    assert.equal(b.sent('SUBSCRIBE').length, 0);

    b.connected(1);
    await until(() => b.sent('SUBSCRIBE').length === 1);
  });
});

// ===========================================================================
describe('reconnection', () => {
  test("the client's own reconnect sends the same SUBSCRIBE again (headers and id), once", async () => {
    const b = await broker();
    const topic = open('/topic/news', b.port);
    await topic.connect();
    await topic.subscribe(() => {}, { selector: "type='1'" });
    await until(() => b.sent('SUBSCRIBE').length === 1);
    const first = b.sent('SUBSCRIBE')[0].headers;

    b.drop();
    await until(() => b.sent('SUBSCRIBE', 2).length === 1);
    await wait(50);

    assert.equal(b.sent('SUBSCRIBE', 2).length, 1);
    assert.deepEqual(b.sent('SUBSCRIBE', 2)[0].headers, first);
    assert.equal(topic.subscription, first.id);
  });

  test('a full reconnect restores every callback, with the same headers', async () => {
    const b = await broker();
    const topic = open('/topic/prices', b.port);
    await topic.connect();
    const got = [];
    await topic.subscribe((body) => got.push(`first:${body}`), { selector: "type='1'" });
    await topic.subscribe((body) => got.push(`second:${body}`));
    await until(() => b.sent('SUBSCRIBE').length === 1);

    fullReconnect(topic);
    await until(() => b.sent('SUBSCRIBE', 2).length === 1);
    await wait(50);

    const { headers } = b.sent('SUBSCRIBE', 2)[0];
    assert.equal(b.sent('SUBSCRIBE', 2).length, 1);
    assert.equal(headers.ack, 'auto');
    assert.equal(headers.selector, "type='1'");
    assert.equal(headers.id, topic.subscription);

    b.deliver('/topic/prices', 'y');
    await until(() => got.length === 2);
    assert.deepEqual(got, ['first:y', 'second:y']);
  });

  test('delete() does not cancel the resubscription after a full reconnect', async () => {
    const b = await broker();
    const queue = open('/queue/work', b.port);
    await queue.connect();
    await queue.subscribe(() => {});
    await until(() => b.sent('SUBSCRIBE').length === 1);

    await queue.delete('m1');
    fullReconnect(queue);

    await until(() => b.sent('SUBSCRIBE', 2).length === 1);
  });
});

// ===========================================================================
describe('ack', () => {
  test('the client never acks by itself', async () => {
    const b = await broker();
    const queue = open('/queue/work', b.port);
    await queue.connect();
    let got = 0;
    await queue.subscribe(() => got++);
    await until(() => b.sent('SUBSCRIBE').length === 1);

    b.deliver('/queue/work', 'a', 'm1');
    b.deliver('/queue/work', 'b', 'm2');
    await until(() => got === 2);
    await wait(50);

    assert.equal(b.sent('ACK').length, 0);
  });

  test('delete() acks the message on a client-individual subscription', async () => {
    const b = await broker();
    const queue = open('/queue/work', b.port);
    await queue.connect();
    await queue.subscribe(() => {});
    await until(() => b.sent('SUBSCRIBE').length === 1);

    await queue.delete('m7');

    await until(() => b.sent('ACK').length === 1);
    assert.deepEqual(b.sent('ACK')[0].headers, { 'message-id': 'm7', subscription: queue.subscription });
  });

  test('delete() sends nothing on an ack auto subscription (the broker would answer with an error)', async () => {
    const b = await broker();
    const topic = open('/topic/news', b.port);
    await topic.connect();
    await topic.subscribe(() => {});
    await until(() => b.sent('SUBSCRIBE').length === 1);

    await topic.delete('m7');
    await wait(50);

    assert.equal(b.sent('ACK').length, 0);
  });

  test('delete() without a subscription rejects', async () => {
    const b = await broker();
    const queue = open('/queue/work', b.port);
    await queue.connect();

    await assert.rejects(queue.delete('m1'), /no subscription active/);
  });
});

// ===========================================================================
describe('unsubscribe', () => {
  test('sends UNSUBSCRIBE with the subscription id, and the callbacks stop', async () => {
    const b = await broker();
    const topic = open('/topic/news', b.port);
    await topic.connect();
    let got = 0;
    await topic.subscribe(() => got++);
    await until(() => b.sent('SUBSCRIBE').length === 1);
    const id = topic.subscription;

    await topic.unsubscribe();

    await until(() => b.sent('UNSUBSCRIBE').length === 1);
    assert.deepEqual(b.sent('UNSUBSCRIBE')[0].headers, { id, destination: '/topic/news' });
    b.deliver('/topic/news', 'late');
    await wait(50);
    assert.equal(got, 0);
  });

  test('is not undone by a full reconnect', async () => {
    const b = await broker();
    const topic = open('/topic/news', b.port);
    await topic.connect();
    await topic.subscribe(() => {});
    await until(() => b.sent('SUBSCRIBE').length === 1);
    await topic.unsubscribe();

    fullReconnect(topic);
    await until(() => b.sent('CONNECT', 2).length === 1);
    await wait(100);

    assert.equal(b.sent('SUBSCRIBE', 2).length, 0);
  });

  test('without a subscription rejects', async () => {
    const b = await broker();
    const topic = open('/topic/news', b.port);
    await topic.connect();

    await assert.rejects(topic.unsubscribe(), /nothing to unsubscribe/);
  });
});

// ===========================================================================
describe('errors', () => {
  test("a broker ERROR is emitted once as 'exception'", async () => {
    const b = await broker();
    const topic = open('/topic/news', b.port);
    await topic.connect();
    const exceptions = [];
    topic.event.on('exception', (e) => exceptions.push(e.error.message));

    b.error('something went wrong');
    await until(() => exceptions.length === 1);
    await wait(50);

    assert.deepEqual(exceptions, ['something went wrong']);
  });
});

// ===========================================================================
// Real ActiveMQ: only with AMQ_PORT (see the top of the file).
const AMQ = process.env.AMQ_PORT && {
  port: process.env.AMQ_PORT,
  auth: { user: process.env.AMQ_USER || 'admin', password: process.env.AMQ_PASSWORD || 'admin' },
};
const describeBroker = AMQ ? describe : describe.skip;

describeBroker('real broker (AMQ_PORT)', () => {
  const unique = (name) => `${name}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;

  /** Sends `count` messages with a raw connection, then waits for the broker to confirm them. */
  function produce(destination, count, from = 1) {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection(AMQ.port, '127.0.0.1', () => {
        let out = `CONNECT\naccept-version:1.1\nlogin:${AMQ.auth.user}\npasscode:${AMQ.auth.password}\n\n\0`;
        for (let i = from; i < from + count; i++) out += `SEND\ndestination:${destination}\n\n${i}\0`;
        sock.write(`${out}DISCONNECT\nreceipt:done\n\n\0`);
      });
      let buffer = '';
      sock.on('data', (d) => {
        buffer += d;
        if (buffer.includes('receipt-id:done')) { sock.destroy(); resolve(); }
      });
      sock.on('error', reject);
    });
  }

  /** Broker errors only: the simulated full reconnect raises one on purpose. */
  function brokerErrors(queue) {
    const errors = [];
    queue.event.on('exception', (e) => {
      if (!e.error.message.includes('[reconnect attempts reached]')) errors.push(e.error.message);
    });
    return errors;
  }

  test('a topic listener that never acks keeps receiving past the prefetch limit', async () => {
    // The real default limit is 32767 messages; a small activemq.prefetchSize shows the same thing fast.
    const destination = `/topic/${unique('prefetch')}`;
    const clientAcks = open(destination, AMQ.port, AMQ.auth);
    const auto = open(destination, AMQ.port, AMQ.auth);
    await clientAcks.connect();
    await auto.connect();
    let clientGot = 0;
    let autoGot = 0;
    await clientAcks.subscribe(() => clientGot++, { ack: 'client-individual', 'activemq.prefetchSize': 5 });
    await auto.subscribe(() => autoGot++, { 'activemq.prefetchSize': 5 });
    await wait(300);

    await produce(destination, 20);
    await until(() => autoGot === 20, 10000);
    await wait(300);

    assert.equal(clientGot, 5); // stuck: nothing is acked
    assert.equal(autoGot, 20);
  });

  test('subscribe() before the connection is up: messages arrive and the broker reports no error', async () => {
    const destination = `/topic/${unique('early')}`;
    const topic = open(destination, AMQ.port, AMQ.auth);
    const errors = brokerErrors(topic);
    let got = 0;
    topic.subscribe(() => got++);

    await until(() => topic.subscription, 10000);
    await wait(200);
    await produce(destination, 3);
    await until(() => got === 3, 10000);
    assert.deepEqual(errors, []); // used to be "Not connected."
  });

  test('delete() on a topic (ack auto) causes no broker error', async () => {
    const destination = `/topic/${unique('delete')}`;
    const topic = open(destination, AMQ.port, AMQ.auth);
    const errors = brokerErrors(topic);
    await topic.connect();
    let got = 0;
    await topic.subscribe((body, headers) => { got++; topic.delete(headers['message-id']); });
    await wait(300);

    await produce(destination, 3);
    await until(() => got === 3, 10000);
    await wait(300);
    assert.deepEqual(errors, []); // used to be "Unexpected ACK received"
  });

  test('acked queue messages are not redelivered, and the subscription survives a full reconnect', async () => {
    const destination = `/queue/${unique('acks')}`;
    const queue = open(destination, AMQ.port, AMQ.auth);
    const errors = brokerErrors(queue);
    await queue.connect();
    const got = [];
    await queue.subscribe((body, headers) => { got.push(body); queue.delete(headers['message-id']); });
    await wait(300);

    await produce(destination, 2);
    await until(() => got.length === 2, 10000);
    const discarded = queue.mq;
    assert.ok(discarded.outboundHeartBeatInterval); // the real broker negotiates heart-beats
    fullReconnect(queue);
    assert.equal(discarded.outboundHeartBeatInterval, undefined); // stopped: they used to run forever
    await until(() => queue.connected && queue.subscription, 10000);
    await wait(300);
    await produce(destination, 2, 3);
    await until(() => got.length === 4, 10000);
    await wait(300);

    assert.deepEqual(got, ['1', '2', '3', '4']);
    assert.deepEqual(errors, []);
  });

  test('unsubscribe() stops the broker, also after a full reconnect', async () => {
    const destination = `/topic/${unique('unsubscribe')}`;
    const topic = open(destination, AMQ.port, AMQ.auth);
    const errors = brokerErrors(topic);
    await topic.connect();
    await topic.subscribe(() => {});
    await wait(300);
    await topic.unsubscribe();
    await wait(300);

    // Count MESSAGE frames on the socket: the client would drop them anyway, the broker must not send them.
    const count = () => {
      const frames = { n: 0 };
      topic.mq.stream.on('data', (d) => { frames.n += (d.toString().match(/MESSAGE\n/g) || []).length; });
      return frames;
    };
    const before = count();
    await produce(destination, 3);
    await wait(500);

    fullReconnect(topic);
    await until(() => topic.connected, 10000);
    await wait(300);
    const afterReconnect = count();
    await produce(destination, 3);
    await wait(500);

    assert.equal(before.n, 0);
    assert.equal(afterReconnect.n, 0);
    assert.deepEqual(errors, []); // used to be "UNSUBSCRIBE received without a subscription id!"
  });
});
