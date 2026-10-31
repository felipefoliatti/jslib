'use strict';

// Run with:  npm test   (Node >= 18: node --test | any Node: mocha)
//
// This file works with both runners: under mocha, `describe` / `it` already exist as globals;
// otherwise it falls back to the built-in node:test (Node >= 18).
const runner = typeof global.describe === 'function' && typeof global.it === 'function'
  ? { describe: global.describe, test: global.it }
  : require('node:test');
const { describe, test } = runner;

const assert = require('assert').strict; // strict semantics, also available on older Node versions
const querystring = require('querystring');
const operators = require('./filter3');
const { FilterError } = operators;

// Fail once, with a clear message, instead of dozens of "operators.for is not a function" errors.
// This happens when ./filter3 is empty, truncated, or is not the library file.
if (typeof operators.for !== 'function' || typeof operators.configure !== 'function') {
  throw new Error(
    `./filter3 does not export the library API (found: ${Object.keys(operators).join(', ') || 'nothing'}). ` +
    "Expected 'for', 'configure', 'Operator', 'FilterError', 'DEFAULT_ERROR' and 'OPERATORS'. " +
    'Check that filter3.js is the complete file and ends with module.exports = { ... }.'
  );
}

// ---------------------------------------------------------------------------
// Fixtures and helpers
//
// Every test below declares its own `operators.for(...)` chain on purpose: what is
// being declared is part of what is being tested, so it stays visible in the test.
// ---------------------------------------------------------------------------

/** Collapses whitespace runs, so assertions do not depend on the line breaks the lib inserts. */
const normalize = (sql) => sql.replace(/\s+/g, ' ').trim();

/** Runs `fn` and returns the error it throws (the test fails if nothing is thrown). */
function thrown(fn) {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return assert.fail('expected an error to be thrown');
}

const SELECT = 'SELECT adr.id FROM "clients"."address" adr';

// The base query most tests start from: it already has a WHERE of its own.
const BASE = `${SELECT} WHERE adr.deleted=0`;

// What BASE looks like once a filter is added: the existing WHERE is wrapped in
// parentheses and our conditions are appended with AND.
const BASE_AND = `${SELECT} WHERE (adr.deleted=0) AND`;

// The request used as the example in the documentation.
const QUERYSTRING = 'product[in]=1,2,3&order[gt]=1&type[nin]=1,2&sort=qtd,-date';

// ===========================================================================
describe('complete example', () => {
  test('filters + sort from the documentation example', () => {
    const op = operators.for(QUERYSTRING)
                        .where.add('product', 'adr.id', ['in', 'nin', 'gt'], { type: 'int' })
                        .where.add('order', 'adr.ord', ['gt'], { type: 'int' })
                        .where.add('type', 'adr.type', ['in', 'nin'], { type: 'int' })
                        .order.add('qtd', 'adr.qtd', ['asc', 'desc'])
                        .order.add('date', 'adr.created_at', ['asc', 'desc']);

    assert.equal(
      normalize(op.query(BASE)),
      `${BASE_AND} ((adr.id IN ($1, $2, $3)) AND (adr.ord > $4) AND (adr.type NOT IN ($5, $6)))` +
      ' ORDER BY adr.qtd ASC, adr.created_at DESC'
    );
    // Values are converted to numbers because the filters were declared with type 'int'.
    assert.deepEqual(op.values, [1, 2, 3, 1, 1, 2]);
  });

  test('count() applies the same filters but no ORDER BY', () => {
    const op = operators.for(QUERYSTRING)
                        .where.add('product', 'adr.id', ['in', 'nin', 'gt'], { type: 'int' })
                        .where.add('order', 'adr.ord', ['gt'], { type: 'int' })
                        .where.add('type', 'adr.type', ['in', 'nin'], { type: 'int' })
                        .order.add('qtd', 'adr.qtd', ['asc', 'desc'])
                        .order.add('date', 'adr.created_at', ['asc', 'desc']);

    assert.equal(
      normalize(op.count('SELECT count(1) FROM "clients"."address" adr WHERE adr.deleted=0')),
      'SELECT count(1) FROM "clients"."address" adr WHERE (adr.deleted=0) AND ' +
      '((adr.id IN ($1, $2, $3)) AND (adr.ord > $4) AND (adr.type NOT IN ($5, $6)))'
    );
    assert.deepEqual(op.values, [1, 2, 3, 1, 1, 2]);
  });

  test('count() still validates the sort parameter, even though it does not apply it', () => {
    const op = operators.for('sort=-id').order.add('id', 'adr.id', ['asc']); // only ascending is allowed

    assert.throws(() => op.count(BASE), FilterError);
  });

  test('without any input the SQL is returned untouched', () => {
    for (const input of [undefined, null, {}, '']) {
      const op = operators.for(input)
                          .where.add('product', 'adr.id', ['in'], { type: 'int' })
                          .order.add('date', 'adr.created_at', ['asc', 'desc']);

      assert.equal(op.query(BASE), BASE);
      assert.deepEqual(op.values, []);
    }
  });

  test('where.add / order.add return the operator, so calls can be chained', () => {
    const op = operators.for({});

    assert.equal(op.where.add('a', 'a.a', ['eq']), op);
    assert.equal(op.order.add('a', ['asc']), op);
  });
});

// ===========================================================================
describe('input formats', () => {
  // Each format below must produce exactly the same SQL and values.
  const EXPECTED_SQL = `${BASE_AND} ((adr.id IN ($1, $2, $3)))`;
  const EXPECTED_VALUES = [1, 2, 3];

  test('raw query string', () => {
    const op = operators.for('product[in]=1,2,3')
                        .where.add('product', 'adr.id', ['in'], { type: 'int' });

    assert.equal(normalize(op.query(BASE)), EXPECTED_SQL);
    assert.deepEqual(op.values, EXPECTED_VALUES);
  });

  test('raw query string with percent-encoded brackets', () => {
    const op = operators.for('product%5Bin%5D=1,2,3')
                        .where.add('product', 'adr.id', ['in'], { type: 'int' });

    assert.equal(normalize(op.query(BASE)), EXPECTED_SQL);
    assert.deepEqual(op.values, EXPECTED_VALUES);
  });

  test("flat keys, as produced by node's querystring.parse", () => {
    const input = querystring.parse('product[in]=1,2,3'); // { 'product[in]': '1,2,3' }
    const op = operators.for(input)
                        .where.add('product', 'adr.id', ['in'], { type: 'int' });

    assert.equal(normalize(op.query(BASE)), EXPECTED_SQL);
    assert.deepEqual(op.values, EXPECTED_VALUES);
  });

  test('nested object, as produced by Express / qs', () => {
    const input = { product: { in: '1,2,3' } };
    const op = operators.for(input)
                        .where.add('product', 'adr.id', ['in'], { type: 'int' });

    assert.equal(normalize(op.query(BASE)), EXPECTED_SQL);
    assert.deepEqual(op.values, EXPECTED_VALUES);
  });

  test('JSON body: a list is still the comma separated string, and plain numbers are accepted', () => {
    const list = operators.for({ product: { in: '1,2,3' } })
                          .where.add('product', 'adr.id', ['in'], { type: 'int' });
    const single = operators.for({ product: { in: 5 } })
                            .where.add('product', 'adr.id', ['in'], { type: 'int' });

    assert.equal(normalize(list.query(BASE)), EXPECTED_SQL);
    assert.deepEqual(list.values, EXPECTED_VALUES);
    assert.equal(normalize(single.query(BASE)), `${BASE_AND} ((adr.id IN ($1)))`);
    assert.deepEqual(single.values, [5]);
  });

  test('sort as an array (JSON body)', () => {
    const op = operators.for({ sort: ['qtd', '-date'] })
                        .order.add('qtd', 'adr.qtd', ['asc', 'desc'])
                        .order.add('date', 'adr.created_at', ['asc', 'desc']);

    assert.equal(normalize(op.query(BASE)), `${BASE} ORDER BY adr.qtd ASC, adr.created_at DESC`);
  });

  test('sort as an object { field: direction }', () => {
    const op = operators.for({ sort: { qtd: 'asc', date: 'DESC' } })
                        .order.add('qtd', 'adr.qtd', ['asc', 'desc'])
                        .order.add('date', 'adr.created_at', ['asc', 'desc']);

    assert.equal(normalize(op.query(BASE)), `${BASE} ORDER BY adr.qtd ASC, adr.created_at DESC`);
  });

  test('a leading "+" means ascending (it arrives as a space in a raw query string)', () => {
    const op = operators.for('sort=+qtd,-date')
                        .order.add('qtd', 'adr.qtd', ['asc', 'desc'])
                        .order.add('date', 'adr.created_at', ['asc', 'desc']);

    assert.equal(normalize(op.query(BASE)), `${BASE} ORDER BY adr.qtd ASC, adr.created_at DESC`);
  });
});

// ===========================================================================
describe('filter operators', () => {
  test('eq, neq and gt on an int column', () => {
    const op = operators.for('qtd[eq]=5&qtd[gt]=2&qtd[neq]=9')
                        .where.add('qtd', 'adr.qtd', ['eq', 'neq', 'gt'], { type: 'int' });

    // Conditions follow the declaration order (eq, neq, gt), not the order of the request.
    assert.equal(
      normalize(op.query(BASE)),
      `${BASE_AND} ((adr.qtd = $1) AND (adr.qtd <> $2) AND (adr.qtd > $3))`
    );
    assert.deepEqual(op.values, [5, 9, 2]);
  });

  test('a field without operator means in (comma separated list)', () => {
    const op = operators.for('qtd=7,8')
                        .where.add('qtd', 'adr.qtd', ['in'], { type: 'int' });

    assert.equal(normalize(op.query(BASE)), `${BASE_AND} ((adr.qtd IN ($1, $2)))`);
    assert.deepEqual(op.values, [7, 8]);
  });

  test('btw needs exactly two values and renders BETWEEN', () => {
    const declare = (input) => operators.for(input)
                                        .where.add('qtd', 'adr.qtd', ['btw'], { type: 'int' });

    const op = declare('qtd[btw]=1,10');
    assert.equal(normalize(op.query(BASE)), `${BASE_AND} ((adr.qtd BETWEEN $1 AND $2))`);
    assert.deepEqual(op.values, [1, 10]);

    assert.throws(() => declare('qtd[btw]=1').query(BASE), FilterError);     // too few
    assert.throws(() => declare('qtd[btw]=1,2,3').query(BASE), FilterError); // too many
  });

  test('"between" no longer exists: neither as a declaration nor in a request', () => {
    assert.throws(
      () => operators.for({}).where.add('qtd', 'adr.qtd', ['between']),
      /unknown operator 'between'/
    );

    const op = operators.for('qtd[between]=1,2').where.add('qtd', 'adr.qtd', ['btw']);
    assert.throws(() => op.query(BASE), FilterError);
  });

  test('"not-eq" and "not-in" no longer exist: they are now "neq" and "nin"', () => {
    assert.throws(
      () => operators.for({}).where.add('qtd', 'adr.qtd', ['not-eq']),
      /unknown operator 'not-eq'/
    );
    assert.throws(
      () => operators.for({}).where.add('type', 'adr.type', ['not-in']),
      /unknown operator 'not-in'/
    );

    // In a request, the old name is just an operator that was not declared for the filter.
    const op = operators.for('type[not-in]=1')
                        .where.add('type', 'adr.type', ['nin'], { type: 'int' });
    assert.throws(() => op.query(BASE), FilterError);
  });

  test('like, starts and ends escape % and _ so they are matched literally', () => {
    const op = operators.for('name[like]=50%_off&name[starts]=ab&name[ends]=yz')
                        .where.add('name', 'adr.name', ['like', 'starts', 'ends']);

    assert.equal(
      normalize(op.query(BASE)),
      `${BASE_AND} ((adr.name LIKE $1) AND (adr.name LIKE $2) AND (adr.name LIKE $3))`
    );
    assert.deepEqual(op.values, ['%50\\%\\_off%', 'ab%', '%yz']);
  });

  test('ilike is ILIKE on postgres and plain LIKE on mysql', () => {
    const pg = operators.for('name[ilike]=a')
                        .where.add('name', 'adr.name', ['ilike']);
    const mysql = operators.for('name[ilike]=a', { dialect: 'mysql' })
                           .where.add('name', 'adr.name', ['ilike']);

    assert.equal(normalize(pg.query(BASE)), `${BASE_AND} ((adr.name ILIKE $1))`);
    assert.equal(normalize(mysql.query(BASE)), `${BASE_AND} ((adr.name LIKE ?))`);
  });

  test('null takes true / false and produces no parameter', () => {
    const declare = (input) => operators.for(input)
                                        .where.add('active', 'adr.active', ['null']);

    const isNull = declare('active[null]=true');
    assert.equal(normalize(isNull.query(BASE)), `${BASE_AND} ((adr.active IS NULL))`);
    assert.deepEqual(isNull.values, []);

    const isNotNull = declare('active[null]=false');
    assert.equal(normalize(isNotNull.query(BASE)), `${BASE_AND} ((adr.active IS NOT NULL))`);
  });

  test('bool and date types convert / validate their values', () => {
    const op = operators.for('active[eq]=false&created[gte]=2024-01-31')
                        .where.add('active', 'adr.active', ['eq'], { type: 'bool' })
                        .where.add('created', 'adr.created_at', ['gte'], { type: 'date' });

    assert.equal(
      normalize(op.query(BASE)),
      `${BASE_AND} ((adr.active = $1) AND (adr.created_at >= $2))`
    );
    assert.deepEqual(op.values, [false, '2024-01-31']); // a real boolean; the date text is kept as is
  });

  test('empty values add no condition at all', () => {
    const op = operators.for('product[in]=&qtd[eq]=&type[in]=,,')
                        .where.add('product', 'adr.id', ['in'], { type: 'int' })
                        .where.add('qtd', 'adr.qtd', ['eq'], { type: 'int' })
                        .where.add('type', 'adr.type', ['in'], { type: 'int' });

    assert.equal(op.query(BASE), BASE);
    assert.deepEqual(op.values, []);
  });

  test('repeating a parameter is an AND, for lists and scalars alike', () => {
    const op = operators.for('product[in]=1,2&product[in]=3&qtd[gt]=1&qtd[gt]=2')
                        .where.add('product', 'adr.id', ['in'], { type: 'int' })
                        .where.add('qtd', 'adr.qtd', ['gt'], { type: 'int' });

    // A list is the comma separated string; each repetition is its own condition.
    assert.equal(
      normalize(op.query(BASE)),
      `${BASE_AND} ((adr.id IN ($1, $2)) AND (adr.id IN ($3)) AND (adr.qtd > $4) AND (adr.qtd > $5))`
    );
    assert.deepEqual(op.values, [1, 2, 3, 1, 2]);
  });

  test('nin repeated: each repetition excludes its own list', () => {
    const op = operators.for('type[nin]=1,2&type[nin]=3')
                        .where.add('type', 'adr.type', ['nin'], { type: 'int' });

    assert.equal(
      normalize(op.query(BASE)),
      `${BASE_AND} ((adr.type NOT IN ($1, $2)) AND (adr.type NOT IN ($3)))`
    );
    assert.deepEqual(op.values, [1, 2, 3]);
  });

  test('btw repeated: each repetition is its own BETWEEN and needs exactly two values', () => {
    const declare = (input) => operators.for(input)
                                        .where.add('qtd', 'adr.qtd', ['btw'], { type: 'int' });

    const op = declare('qtd[btw]=1,10&qtd[btw]=5,20');
    assert.equal(
      normalize(op.query(BASE)),
      `${BASE_AND} ((adr.qtd BETWEEN $1 AND $2) AND (adr.qtd BETWEEN $3 AND $4))`
    );
    assert.deepEqual(op.values, [1, 10, 5, 20]);

    assert.throws(() => declare('qtd[btw]=1,10&qtd[btw]=5').query(BASE), FilterError);
  });

  test('null repeated: each repetition is its own IS [NOT] NULL', () => {
    const op = operators.for('active[null]=true&active[null]=false')
                        .where.add('active', 'adr.active', ['null']);

    assert.equal(
      normalize(op.query(BASE)),
      `${BASE_AND} ((adr.active IS NULL) AND (adr.active IS NOT NULL))`
    );
  });

  test('an empty repetition adds nothing', () => {
    const op = operators.for('product[in]=1&product[in]=,,&product[in]=')
                        .where.add('product', 'adr.id', ['in'], { type: 'int' });

    assert.equal(normalize(op.query(BASE)), `${BASE_AND} ((adr.id IN ($1)))`);
    assert.deepEqual(op.values, [1]);
  });

  test('JSON body: an array means "repeated", so each item is its own condition', () => {
    const op = operators.for({ product: { in: ['1,2', '3'] } })
                        .where.add('product', 'adr.id', ['in'], { type: 'int' });
    assert.equal(normalize(op.query(BASE)), `${BASE_AND} ((adr.id IN ($1, $2)) AND (adr.id IN ($3)))`);

    // Careful: [1, 2, 3] is NOT a list, it is three repetitions (use "1,2,3" for a list).
    const numbers = operators.for({ product: { in: [1, 2, 3] } })
                             .where.add('product', 'adr.id', ['in'], { type: 'int' });
    assert.equal(
      normalize(numbers.query(BASE)),
      `${BASE_AND} ((adr.id IN ($1)) AND (adr.id IN ($2)) AND (adr.id IN ($3)))`
    );
  });

  test('lists are limited to maxListSize (500 by default)', () => {
    const tooMany = Array.from({ length: 501 }, (_, i) => i).join(',');

    const limited = operators.for(`product[in]=${tooMany}`)
                             .where.add('product', 'adr.id', ['in'], { type: 'int' });
    assert.throws(() => limited.query(BASE), FilterError);

    const raised = operators.for(`product[in]=${tooMany}`, { maxListSize: 1000 })
                            .where.add('product', 'adr.id', ['in'], { type: 'int' });
    raised.query(BASE);
    assert.equal(raised.values.length, 501);
  });
});

// ===========================================================================
describe('custom filters (column declared as a function)', () => {
  test('returning a plain string: it is used verbatim, as trusted SQL', () => {
    const calls = [];
    const op = operators.for('hasClient[eq]=true')
                        .where.add('hasClient', (name, operator, value) => {
                          calls.push([name, operator, value]);
                          return 'exists (select 1 from clients.client cl where cl.address=adr.id)';
                        }, ['eq']);

    assert.equal(
      normalize(op.query(BASE)),
      `${BASE_AND} ((exists (select 1 from clients.client cl where cl.address=adr.id)))`
    );
    // The function receives the filter name, the operator and the raw request value.
    assert.deepEqual(calls, [['hasClient', 'eq', 'true']]);
    assert.deepEqual(op.values, []);
  });

  test('the SQL can depend on the value', () => {
    const declare = (input) => operators.for(input)
                                        .where.add('hasClient', (name, operator, value) =>
                                          value === 'false' ? 'not exists (select 1)' : 'exists (select 1)', ['eq']);

    assert.ok(declare('hasClient[eq]=false').query(BASE).includes('not exists (select 1)'));
    assert.ok(declare('hasClient[eq]=true').query(BASE).includes('(exists (select 1))'));
  });

  test('returning { sql, values }: each ? becomes a real placeholder, ?? is a literal ?', () => {
    const op = operators.for('qtd[gt]=3&q[eq]=abc')
                        .where.add('qtd', 'adr.qtd', ['gt'], { type: 'int' })
                        .where.add('q', (name, operator, value) => ({
                          sql: '(adr.a = ? OR adr.b = ?) AND adr.j ?? ?',
                          values: [value, value, 'k'],
                        }), ['eq']);

    assert.equal(
      normalize(op.query(BASE)),
      `${BASE_AND} ((adr.qtd > $1) AND ((adr.a = $2 OR adr.b = $3) AND adr.j ? $4))`
    );
    assert.deepEqual(op.values, [3, 'abc', 'abc', 'k']);
  });

  test('a mismatch between ? and values is a programming error', () => {
    const op = operators.for('q[eq]=1')
                        .where.add('q', () => ({ sql: 'x = ?', values: [] }), ['eq']);

    assert.throws(() => op.query(BASE), /placeholder/);
  });

  test('a repeated parameter calls the function once per repetition, and the results are ANDed', () => {
    const calls = [];
    const op = operators.for('q[eq]=ana&q[eq]=silva')
                        .where.add('q', (name, operator, value) => {
                          calls.push(value);
                          return { sql: 'adr.name ILIKE ?', values: [`%${value}%`] };
                        }, ['eq']);

    assert.equal(
      normalize(op.query(BASE)),
      `${BASE_AND} ((adr.name ILIKE $1) AND (adr.name ILIKE $2))`
    );
    assert.deepEqual(calls, ['ana', 'silva']);
    assert.deepEqual(op.values, ['%ana%', '%silva%']);
  });

  test('returning a falsy value means "this filter does not apply"', () => {
    const op = operators.for('q[eq]=1')
                        .where.add('q', () => null, ['eq']);

    assert.equal(op.query(BASE), BASE);
  });
});

// ===========================================================================
describe('security', () => {
  test('SQL injection payloads only ever reach `values`, never the SQL text', () => {
    const payload = "x'); DROP TABLE clients.address;--";
    const op = operators.for({ name: { eq: payload, like: payload } })
                        .where.add('name', 'adr.name', ['eq', 'like']);

    const text = op.query(BASE);

    assert.ok(!text.includes('DROP'));
    assert.deepEqual(op.values, [payload, `%${payload}%`]);
  });

  test('sort only accepts declared fields: arbitrary columns are ignored', () => {
    const op = operators.for({ sort: 'qtd; DROP TABLE x,adr.password' })
                        .order.add('qtd', 'adr.qtd', ['asc', 'desc']);

    // Neither "qtd; DROP TABLE x" nor "adr.password" matches a declared field.
    assert.equal(op.query(BASE), BASE);
  });

  test('values that do not look like an int are rejected', () => {
    for (const value of ['1 or 1=1', '1.5', 'abc', '0x10']) {
      const op = operators.for({ product: { in: value } })
                          .where.add('product', 'adr.id', ['in'], { type: 'int' });

      const err = thrown(() => op.query(BASE));
      assert.ok(err instanceof FilterError);
      assert.equal(err.status, 422);
      assert.equal(err.code, 1052);
    }
  });

  test('an operator that was not declared for the field is rejected', () => {
    const declare = (input) => operators.for(input)
                                        .where.add('product', 'adr.id', ['in'], { type: 'int' });

    const err = thrown(() => declare('product[lt]=3').query(BASE));
    assert.ok(err instanceof FilterError);
    assert.equal(err.param, 'product');

    assert.throws(() => declare('product[__proto__]=3').query(BASE), FilterError);
  });

  test('a sort direction that was not declared is rejected', () => {
    const declare = (input) => operators.for(input)
                                        .order.add('id', 'id', ['asc']); // ascending only

    assert.throws(() => declare('sort=-id').query(BASE), FilterError);
    assert.ok(declare('sort=id').query(BASE).endsWith('ORDER BY id ASC'));
  });

  test('nested objects as values are rejected', () => {
    const op = operators.for({ qtd: { eq: { a: 1 } } })
                        .where.add('qtd', 'adr.qtd', ['eq'], { type: 'int' });

    assert.throws(() => op.query(BASE), FilterError);
  });

  test('__proto__ / constructor keys in a JSON body neither break nor pollute anything', () => {
    const body = JSON.parse(
      '{"__proto__":{"in":"1"},"constructor":{"prototype":{"x":1}},"product":{"in":"1"}}'
    );
    const op = operators.for(body)
                        .where.add('product', 'adr.id', ['in'], { type: 'int' });

    assert.ok(op.query(BASE).includes('adr.id IN ($1)'));
    assert.equal({}.in, undefined);
    assert.equal({}.x, undefined);
  });

  test('unknown filters and sort fields: ignored by default, errors in strict mode', () => {
    const lenient = operators.for('page=2&foo[in]=1&sort=nope')
                             .where.add('product', 'adr.id', ['in'], { type: 'int' });
    assert.equal(lenient.query(BASE), BASE);

    const strictFilter = operators.for('foo[in]=1', { strict: true })
                                  .where.add('product', 'adr.id', ['in'], { type: 'int' });
    assert.throws(() => strictFilter.query(BASE), FilterError);

    const strictSort = operators.for('sort=nope', { strict: true })
                                .order.add('qtd', 'adr.qtd', ['asc', 'desc']);
    assert.throws(() => strictSort.query(BASE), FilterError);
  });
});

// ===========================================================================
describe('injection into the base SQL', () => {
  // Every test below uses the same small declaration: one filter and one sort field.

  test('base SQL without WHERE: a WHERE is added', () => {
    const op = operators.for('qtd[gt]=1&sort=-date')
                        .where.add('qtd', 'adr.qtd', ['gt'], { type: 'int' })
                        .order.add('date', 'adr.created_at', ['asc', 'desc']);

    assert.equal(
      normalize(op.query('SELECT 1 FROM t adr')),
      'SELECT 1 FROM t adr WHERE (adr.qtd > $1) ORDER BY adr.created_at DESC'
    );
  });

  test('base SQL with WHERE: AND is used, and the existing OR stays protected', () => {
    const op = operators.for('qtd[gt]=1&sort=-date')
                        .where.add('qtd', 'adr.qtd', ['gt'], { type: 'int' })
                        .order.add('date', 'adr.created_at', ['asc', 'desc']);

    // Without the parentheses around "a=1 OR b=2" our AND would bind to "b=2" only.
    assert.equal(
      normalize(op.query('SELECT 1 FROM t adr WHERE a=1 OR b=2')),
      'SELECT 1 FROM t adr WHERE (a=1 OR b=2) AND ((adr.qtd > $1)) ORDER BY adr.created_at DESC'
    );
  });

  test('GROUP BY / HAVING / LIMIT / OFFSET stay after the new WHERE and ORDER BY', () => {
    const op = operators.for('qtd[gt]=1&sort=-date')
                        .where.add('qtd', 'adr.qtd', ['gt'], { type: 'int' })
                        .order.add('date', 'adr.created_at', ['asc', 'desc']);

    const sql = 'SELECT adr.id, count(*) FROM t adr WHERE a=1 GROUP BY adr.id HAVING count(*) > 1 LIMIT 10 OFFSET 20';

    assert.equal(
      normalize(op.query(sql)),
      'SELECT adr.id, count(*) FROM t adr WHERE (a=1) AND ((adr.qtd > $1)) ' +
      'GROUP BY adr.id HAVING count(*) > 1 ORDER BY adr.created_at DESC LIMIT 10 OFFSET 20'
    );
  });

  test('an existing ORDER BY keeps priority; the requested sort is appended as tie-breaker', () => {
    const op = operators.for('qtd[gt]=1&sort=-date')
                        .where.add('qtd', 'adr.qtd', ['gt'], { type: 'int' })
                        .order.add('date', 'adr.created_at', ['asc', 'desc']);

    assert.equal(
      normalize(op.query('SELECT 1 FROM t adr WHERE a=1 ORDER BY adr.id LIMIT 5')),
      'SELECT 1 FROM t adr WHERE (a=1) AND ((adr.qtd > $1)) ORDER BY adr.id, adr.created_at DESC LIMIT 5'
    );
  });

  test('keywords inside subqueries, strings and comments are ignored', () => {
    const op = operators.for('qtd[gt]=1&sort=-date')
                        .where.add('qtd', 'adr.qtd', ['gt'], { type: 'int' })
                        .order.add('date', 'adr.created_at', ['asc', 'desc']);

    // The first "where", "limit" and "order by" are inside a subquery, a string and comments.
    const sql = `SELECT (select x from y where z limit 1) AS s, 'where order by' AS lit /* where */
                 FROM t adr -- limit 1
                 WHERE a = 'group by'`;

    assert.ok(normalize(op.query(sql)).includes(
      "WHERE (a = 'group by') AND ((adr.qtd > $1)) ORDER BY adr.created_at DESC"
    ));
  });

  test('a subquery in FROM that has its own WHERE does not count as the outer WHERE', () => {
    const op = operators.for('qtd[gt]=1&sort=-date')
                        .where.add('qtd', 'adr.qtd', ['gt'], { type: 'int' })
                        .order.add('date', 'adr.created_at', ['asc', 'desc']);

    assert.equal(
      normalize(op.query('SELECT * FROM (SELECT * FROM t WHERE x=1) adr')),
      'SELECT * FROM (SELECT * FROM t WHERE x=1) adr WHERE (adr.qtd > $1) ORDER BY adr.created_at DESC'
    );
  });

  test('a trailing semicolon is removed', () => {
    const op = operators.for('qtd[gt]=1')
                        .where.add('qtd', 'adr.qtd', ['gt'], { type: 'int' });

    assert.ok(!op.query('SELECT 1 FROM t adr;  ').includes(';'));
  });

  test('a trailing line comment in the existing WHERE does not swallow the closing parenthesis', () => {
    const op = operators.for('qtd[gt]=1')
                        .where.add('qtd', 'adr.qtd', ['gt'], { type: 'int' });

    assert.ok(op.query('SELECT 1 FROM t adr WHERE a=1 -- note').includes('-- note\n) AND'));
  });
});

// ===========================================================================
describe('placeholders and dialects', () => {
  test('parameters already used by the base SQL shift the $n numbering', () => {
    const op = operators.for('product[in]=7,8')
                        .where.add('product', 'adr.id', ['in'], { type: 'int' });

    const sql = op.query('SELECT 1 FROM t adr WHERE adr.owner = $1 AND adr.kind = $2', 'me', 5);

    assert.ok(sql.includes('adr.id IN ($3, $4)'));
    assert.deepEqual(op.values, ['me', 5, 7, 8]);
  });

  test('count() also respects the base parameters', () => {
    const op = operators.for('product[in]=7')
                        .where.add('product', 'adr.id', ['in'], { type: 'int' });

    op.count('SELECT count(1) FROM t adr WHERE adr.owner = $1', 'me');

    assert.deepEqual(op.values, ['me', 7]);
  });

  test('toQuery / toCount return { text, values } for the "pg" driver', () => {
    const op = operators.for('product[in]=7&sort=-date')
                        .where.add('product', 'adr.id', ['in'], { type: 'int' })
                        .order.add('date', 'adr.created_at', ['asc', 'desc']);

    const query = op.toQuery(BASE);
    assert.equal(query.text, op.query(BASE));
    assert.deepEqual(query.values, [7]);

    const count = op.toCount(BASE);
    assert.ok(!/order by/i.test(count.text));
    assert.deepEqual(count.values, [7]);
  });

  test('the mysql dialect uses ? instead of $n', () => {
    const op = operators.for('product[in]=1,2&qtd[gt]=3', { dialect: 'mysql' })
                        .where.add('product', 'adr.id', ['in'], { type: 'int' })
                        .where.add('qtd', 'adr.qtd', ['gt'], { type: 'int' });

    assert.equal(normalize(op.query(BASE)), `${BASE_AND} ((adr.id IN (?, ?)) AND (adr.qtd > ?))`);
    assert.deepEqual(op.values, [1, 2, 3]);
  });

  test('the sort parameter name can be changed with sortKey', () => {
    const op = operators.for('orderBy=-date', { sortKey: 'orderBy' })
                        .order.add('date', 'adr.created_at', ['asc', 'desc']);

    assert.ok(op.query(BASE).endsWith('ORDER BY adr.created_at DESC'));
  });
});

// ===========================================================================
describe('declaration errors (programming mistakes, not request errors)', () => {
  test('unknown operator, unknown type, duplicated name, invalid direction, unknown dialect', () => {
    const op = operators.for({});

    assert.throws(() => op.where.add('a', 'a.a', ['nope']), /unknown operator/);
    assert.throws(() => op.where.add('a', 'a.a', ['eq'], { type: 'xx' }), /unknown type/);
    assert.throws(() => op.order.add('o', 'o.o', ['up']), /directions/);
    assert.throws(() => operators.for({}, { dialect: 'oracle' }), /dialect/);

    op.where.add('a', 'a.a', ['eq']);
    assert.throws(() => op.where.add('a', 'a.a', ['eq']), /already declared/);
  });

  test('short forms: the name doubles as the column', () => {
    const op = operators.for('a[gt]=1&sort=-b')
                        .where.add('a', ['gt'], { type: 'int' }) // where.add(name, operators, options)
                        .order.add('b');                         // order.add(name): asc + desc

    assert.equal(normalize(op.query('SELECT 1 FROM t')), 'SELECT 1 FROM t WHERE (a > $1) ORDER BY b DESC');
  });
});

// ===========================================================================
describe('custom errors and required filters', () => {
  test('defaults: status 422 and code 1052', () => {
    const op = operators.for('product[lt]=3')
                        .where.add('product', 'adr.id', ['in'], { type: 'int' });

    const err = thrown(() => op.query(BASE));

    assert.ok(err instanceof FilterError);
    assert.equal(err.status, 422);
    assert.equal(err.statusCode, 422); // alias of `status`
    assert.equal(err.code, 1052);
    assert.equal(operators.DEFAULT_ERROR.status, 422);
  });

  test('status and code of the filter apply to invalid values and disallowed operators', () => {
    for (const input of ['product[in]=abc', 'product[gt]=1']) {
      const op = operators.for(input)
                          .where.add('product', 'adr.id', ['in'], { type: 'int' }, { status: 409, code: 1022 });

      const err = thrown(() => op.query(BASE));

      assert.equal(err.status, 409);
      assert.equal(err.code, 1022);
      assert.equal(err.param, 'product');
    }
  });

  test('a partial config only overrides what it declares', () => {
    const op = operators.for('product[in]=x')
                        .where.add('product', 'adr.id', ['in'], { type: 'int' }, { code: 7 });

    const err = thrown(() => op.query(BASE));

    assert.equal(err.status, 422); // default
    assert.equal(err.code, 7);     // overridden
  });

  test('a filter that was not supplied is NOT an error unless it is required', () => {
    const op = operators.for({})
                        .where.add('product', 'adr.id', ['in'], { type: 'int' }, { status: 409 });

    assert.equal(op.query(BASE), BASE);
  });

  test('required: default message is "filter <name> not supplied"', () => {
    const op = operators.for({})
                        .where.add('product', 'adr.id', ['in'], { type: 'int', required: true });

    const err = thrown(() => op.query(BASE));

    assert.equal(err.message, 'filter product not supplied');
    assert.equal(err.status, 422);
    assert.equal(err.code, 1052);
  });

  test('required: custom status, code and message', () => {
    const op = operators.for({})
                        .where.add('product', 'adr.id', ['in'], { type: 'int', required: true },
                          { status: 422, code: 1022, message: 'filter product not supplied!' });

    const err = thrown(() => op.query(BASE));

    assert.equal(err.message, 'filter product not supplied!');
    assert.equal(err.code, 1022);
  });

  test('required: an empty value (or only commas) counts as not supplied; a real value passes', () => {
    const declare = (input) => operators.for(input)
                                        .where.add('product', 'adr.id', ['in'], { type: 'int', required: true });

    for (const input of ['product[in]=', 'product[in]=,,', 'other=1']) {
      assert.throws(() => declare(input).query(BASE), /not supplied/);
    }
    assert.ok(declare('product[in]=1').query(BASE).includes('adr.id IN ($1)'));
  });

  test('required also works for custom (function) filters', () => {
    const declare = (input) => operators.for(input)
                                        .where.add('has', () => 'exists (select 1)', ['eq'], { required: true });

    assert.throws(() => declare({}).query(BASE), /filter has not supplied/);
    assert.ok(declare('has[eq]=true').query(BASE).includes('exists (select 1)'));
  });

  test('short form where.add(name, operators, options, error) keeps type, required and error', () => {
    const op = operators.for('a[gt]=x')
                        .where.add('a', ['gt'], { type: 'int' }, { status: 400, code: 1 });

    const err = thrown(() => op.query(BASE));

    assert.equal(err.status, 400);
    assert.equal(err.code, 1);
  });

  test('order.add also accepts an error config (full and short form)', () => {
    const full = operators.for('sort=-id')
                          .order.add('id', 'adr.id', ['asc'], { status: 409, code: 55 });
    const short = operators.for('sort=-id')
                           .order.add('id', ['asc'], { status: 409, code: 55 });

    for (const op of [full, short]) {
      const err = thrown(() => op.query(BASE));

      assert.equal(err.status, 409);
      assert.equal(err.code, 55);
    }
  });

  test('sort errors without a config use the defaults', () => {
    const op = operators.for('sort=-id')
                        .order.add('id', 'adr.id', ['asc']);

    const err = thrown(() => op.query(BASE));

    assert.equal(err.status, 422);
    assert.equal(err.code, 1052);
  });

  test('an invalid error config is a declaration error', () => {
    const op = operators.for({});

    assert.throws(() => op.where.add('a', 'a.a', ['eq'], {}, { status: 'x' }), /status/);
    assert.throws(() => op.where.add('b', 'b.b', ['eq'], {}, { message: 1 }), /message/);
    assert.throws(() => op.where.add('c', 'c.c', ['eq'], {}, 'oops'), /error config/);
    assert.throws(() => op.where.add('d', 'd.d', ['eq'], { required: 'yes' }), /required/);
  });
});

// ===========================================================================
describe('configurable error defaults: configure() < for({ error }) < where.add(..., error)', () => {
  // configure() is process-wide state, so every test that uses it restores the defaults at the end.
  const resetDefaults = () => operators.configure({ error: null });

  test('configure() sets status, code and message for the whole process', () => {
    operators.configure({ error: { status: 400, code: 2000, message: 'missing {name}' } });
    try {
      const required = operators.for({})
                                .where.add('product', 'adr.id', ['in'], { type: 'int', required: true });
      const missing = thrown(() => required.query(BASE));
      assert.equal(missing.status, 400);
      assert.equal(missing.code, 2000);
      assert.equal(missing.message, 'missing product'); // {name} is replaced by the filter name

      // The same defaults apply to every other kind of FilterError.
      const invalidValue = operators.for('qtd[eq]=abc').where.add('qtd', 'adr.qtd', ['eq'], { type: 'int' });
      assert.equal(thrown(() => invalidValue.query(BASE)).code, 2000);

      const badOperator = operators.for('product[lt]=1').where.add('product', 'adr.id', ['in']);
      assert.equal(thrown(() => badOperator.query(BASE)).status, 400);

      const badSort = operators.for('sort=-id').order.add('id', 'adr.id', ['asc']);
      assert.equal(thrown(() => badSort.query(BASE)).code, 2000);

      const strict = operators.for('foo=1', { strict: true });
      assert.equal(thrown(() => strict.query(BASE)).status, 400);

      assert.equal(new FilterError('x').code, 2000);
    } finally {
      resetDefaults();
    }
  });

  test('the filter config overrides the global one field by field', () => {
    operators.configure({ error: { status: 400, code: 2000, message: 'missing {name}' } });
    try {
      // Only `code` is overridden: status and message are inherited from configure().
      const partial = operators.for({})
                               .where.add('product', 'adr.id', ['in'], { required: true }, { code: 1022 });
      const a = thrown(() => partial.query(BASE));
      assert.equal(a.code, 1022);
      assert.equal(a.status, 400);
      assert.equal(a.message, 'missing product');

      // Everything overridden.
      const full = operators.for({})
                            .where.add('p', 'adr.p', ['in'], { required: true },
                              { status: 422, code: 1, message: 'p is mandatory' });
      const b = thrown(() => full.query(BASE));
      assert.deepEqual([b.status, b.code, b.message], [422, 1, 'p is mandatory']);
    } finally {
      resetDefaults();
    }
  });

  test('operators.for(..., { error }) sits between the global config and the filter config', () => {
    operators.configure({ error: { status: 400, code: 2000 } });
    try {
      // The operator config can also provide the message, as a function of the filter name.
      const fromOperator = operators.for({}, { error: { status: 409, message: (name) => `no ${name}!` } })
                                    .where.add('a', 'a.a', ['eq'], { required: true });
      const a = thrown(() => fromOperator.query(BASE));
      assert.deepEqual([a.status, a.code, a.message], [409, 2000, 'no a!']);

      // The filter's own config wins over the operator's.
      const fromFilter = operators.for({}, { error: { status: 409 } })
                                  .where.add('b', 'b.b', ['eq'], { required: true }, { status: 418 });
      assert.equal(thrown(() => fromFilter.query(BASE)).status, 418);
    } finally {
      resetDefaults();
    }
  });

  test('errors raised outside a filter declaration (strict mode, sort) use the operator config', () => {
    const strict = operators.for('foo=1', { strict: true, error: { status: 409, code: 9 } });
    const a = thrown(() => strict.query(BASE));
    assert.deepEqual([a.status, a.code], [409, 9]);

    const sort = operators.for('sort=-id', { error: { code: 8 } })
                          .order.add('id', 'adr.id', ['asc']);
    const b = thrown(() => sort.query(BASE));
    assert.deepEqual([b.status, b.code], [422, 8]);
  });

  test('configure({ error: null }) restores 422 / 1052 and configure() is chainable', () => {
    assert.equal(operators.configure({ error: { status: 400 } }), operators);
    resetDefaults();

    const op = operators.for({})
                        .where.add('product', 'adr.id', ['in'], { required: true });
    const err = thrown(() => op.query(BASE));

    assert.deepEqual([err.status, err.code, err.message], [422, 1052, 'filter product not supplied']);
  });

  test('an invalid configuration is rejected', () => {
    assert.throws(() => operators.configure({ error: { status: 99 } }), /status/);
    assert.throws(() => operators.configure({ error: { message: 5 } }), /message/);
    assert.throws(() => operators.for({}, { error: 'x' }), /error config/);
    resetDefaults();
  });
});

// ===========================================================================
describe('default operator: a value sent without an operator (?product=1,2,3)', () => {
  test('the first declared operator is the default: "?product=1,2,3" and "?product[in]=1,2,3" are the same', () => {
    const bare = operators.for('product=1,2,3')
                          .where.add('product', 'adr.id', ['in', 'gt'], { type: 'int' });
    const explicit = operators.for('product[in]=1,2,3')
                              .where.add('product', 'adr.id', ['in', 'gt'], { type: 'int' });

    assert.equal(normalize(bare.query(BASE)), `${BASE_AND} ((adr.id IN ($1, $2, $3)))`);
    assert.deepEqual(bare.values, [1, 2, 3]);
    assert.equal(normalize(explicit.query(BASE)), normalize(bare.query(BASE)));
  });

  test('the order of the operators matters: [eq, neq, like] makes eq the default', () => {
    const op = operators.for('name=Ana')
                        .where.add('name', 'adr.name', ['eq', 'neq', 'like']);

    assert.equal(normalize(op.query(BASE)), `${BASE_AND} ((adr.name = $1))`);
    assert.deepEqual(op.values, ['Ana']);
  });

  test('the "operator" option picks another of the declared operators', () => {
    const op = operators.for('name=Ana')
                        .where.add('name', 'adr.name', ['eq', 'neq', 'like'], { operator: 'neq' });

    assert.equal(normalize(op.query(BASE)), `${BASE_AND} ((adr.name <> $1))`);
  });

  test('without an operator list the filter only has eq, which is then its default', () => {
    const op = operators.for('qtd=7')
                        .where.add('qtd', 'adr.qtd', { type: 'int' });

    assert.equal(normalize(op.query(BASE)), `${BASE_AND} ((adr.qtd = $1))`);
  });

  test('explicit operators are never affected by the default', () => {
    const op = operators.for('product[gt]=5')
                        .where.add('product', 'adr.id', ['in', 'gt'], { type: 'int' });

    assert.equal(normalize(op.query(BASE)), `${BASE_AND} ((adr.id > $1))`);
  });

  test('repeated bare parameters, and a bare value mixed with an explicit one, are ANDed', () => {
    const repeated = operators.for('product=1&product=2')
                              .where.add('product', 'adr.id', ['in'], { type: 'int' });
    assert.equal(normalize(repeated.query(BASE)), `${BASE_AND} ((adr.id IN ($1)) AND (adr.id IN ($2)))`);

    const mixed = operators.for('product=1&product[in]=2')
                           .where.add('product', 'adr.id', ['in'], { type: 'int' });
    assert.equal(normalize(mixed.query(BASE)), `${BASE_AND} ((adr.id IN ($1)) AND (adr.id IN ($2)))`);
    assert.deepEqual([...mixed.values].sort(), [1, 2]); // both values are there, whatever the order
  });

  test('values are still validated by the filter type', () => {
    const op = operators.for('product=1,abc')
                        .where.add('product', 'adr.id', ['in'], { type: 'int' });

    assert.throws(() => op.query(BASE), FilterError);
  });

  test('custom (function) filters: their first operator is the default too', () => {
    const declare = (input) => operators.for(input)
                                        .where.add('hasClient', () => 'exists (select 1)', ['eq']);

    assert.ok(declare('hasClient=true').query(BASE).includes('(exists (select 1))'));
  });

  test('required is satisfied by a bare value', () => {
    const declare = (input) => operators.for(input)
                                        .where.add('product', 'adr.id', ['in'], { type: 'int', required: true });

    assert.ok(declare('product=1,2').query(BASE).includes('adr.id IN ($1, $2)'));
    assert.throws(() => declare({}).query(BASE), /filter product not supplied/);
  });

  test('the mysql dialect renders the same IN list with ? placeholders', () => {
    const op = operators.for('product=1,2,3', { dialect: 'mysql' })
                        .where.add('product', 'adr.id', ['in'], { type: 'int' });

    assert.equal(normalize(op.query(BASE)), `${BASE_AND} ((adr.id IN (?, ?, ?)))`);
  });

  test('the "operator" option must be one of the declared operators', () => {
    assert.throws(
      () => operators.for({}).where.add('a', 'a.a', ['eq'], { operator: 'in' }),
      /must be one of its operators/
    );
    assert.throws(
      () => operators.for({}).where.add('a', 'a.a', ['eq'], { operator: 'nope' }),
      /unknown operator 'nope'/
    );
  });

  test('defaultOperator was removed from configure() and for(): using it is an error', () => {
    assert.throws(() => operators.configure({ defaultOperator: 'eq' }), /defaultOperator was removed/);
    assert.throws(() => operators.configure({ defaultOperator: null }), /defaultOperator was removed/);
    assert.throws(() => operators.for({}, { defaultOperator: 'eq' }), /defaultOperator was removed/);
  });
});

// ===========================================================================
describe('negated patterns: nlike and nilike', () => {
  test('nlike renders NOT LIKE and escapes wildcards like like does', () => {
    const op = operators.for('name[nlike]=50%_off')
                        .where.add('name', 'adr.name', ['like', 'nlike']);

    assert.equal(normalize(op.query(BASE)), `${BASE_AND} ((adr.name NOT LIKE $1))`);
    assert.deepEqual(op.values, ['%50\\%\\_off%']);
  });

  test('nilike is NOT ILIKE on postgres and NOT LIKE on mysql', () => {
    const pg = operators.for('name[nilike]=ana')
                        .where.add('name', 'adr.name', ['ilike', 'nilike']);
    assert.equal(normalize(pg.query(BASE)), `${BASE_AND} ((adr.name NOT ILIKE $1))`);
    assert.deepEqual(pg.values, ['%ana%']);

    const mysql = operators.for('name[nilike]=ana', { dialect: 'mysql' })
                           .where.add('name', 'adr.name', ['ilike', 'nilike']);
    assert.equal(normalize(mysql.query(BASE)), `${BASE_AND} ((adr.name NOT LIKE ?))`);
  });

  test('repeated, they exclude every value: an AND of NOT LIKEs', () => {
    const op = operators.for('name[nlike]=ana&name[nlike]=bia')
                        .where.add('name', 'adr.name', ['nlike']);

    assert.equal(normalize(op.query(BASE)), `${BASE_AND} ((adr.name NOT LIKE $1) AND (adr.name NOT LIKE $2))`);
  });

  test('they are available on json string paths', () => {
    const op = operators.for('extra.street[nilike]=main')
                        .where.add('extra', 'adr.extra', { type: 'json', paths: { street: 'string' } });

    assert.equal(normalize(op.query(BASE)), `${BASE_AND} ((adr.extra->>'street' NOT ILIKE $1))`);
  });
});

// ===========================================================================
describe('json columns (type: json)', () => {
  // The column used in every example: adr.extra holds
  //   { "load": 12, "address": { "street": "Main St", "number": 100 } }
  const EXTRA = {
    type: 'json',
    paths: {
      'address.street': 'string',
      'load':           'int',
      'address.number': 'int',
    },
  };

  describe('input formats', () => {
    // Each format below must produce exactly the same SQL and values.
    const EXPECTED_SQL =
      `${BASE_AND} ((adr.extra #>> '{address,street}' ILIKE $1) AND ((adr.extra->>'load')::bigint > $2)` +
      " AND ((adr.extra #>> '{address,number}')::bigint IN ($3, $4)))";
    const EXPECTED_VALUES = ['%main%', 5, 10, 20];

    const formats = {
      'raw query string, dotted path':
        'extra.address.street[ilike]=main&extra.load[gt]=5&extra.address.number[in]=10,20',
      'raw query string, one bracket per segment':
        'extra[address][street][ilike]=main&extra[load][gt]=5&extra[address][number][in]=10,20',
      "flat keys, as produced by node's querystring.parse":
        querystring.parse('extra[address][street][ilike]=main&extra.load[gt]=5&extra[address][number][in]=10,20'),
      'nested object, as produced by Express / qs (and JSON body)':
        { extra: { address: { street: { ilike: 'main' }, number: { in: '10,20' } }, load: { gt: 5 } } },
      'JSON body with dotted keys':
        { 'extra.address.street': { ilike: 'main' }, 'extra.load': { gt: 5 }, 'extra.address.number': { in: '10,20' } },
    };

    for (const [title, input] of Object.entries(formats)) {
      test(title, () => {
        const op = operators.for(input).where.add('extra', 'adr.extra', EXTRA);

        assert.equal(normalize(op.query(BASE)), EXPECTED_SQL);
        assert.deepEqual(op.values, EXPECTED_VALUES);
      });
    }
  });

  describe('postgres', () => {
    test('string path: eq, ilike and starts (no cast)', () => {
      const op = operators.for('extra.address.street[eq]=Main St&extra.address.street[starts]=Ma_')
                          .where.add('extra', 'adr.extra', EXTRA);

      assert.equal(
        normalize(op.query(BASE)),
        `${BASE_AND} ((adr.extra #>> '{address,street}' = $1) AND (adr.extra #>> '{address,street}' LIKE $2))`
      );
      assert.deepEqual(op.values, ['Main St', 'Ma\\_%']); // LIKE wildcards are escaped, as on any column
    });

    test('int paths are cast to bigint: top-level uses ->>, nested uses #>>', () => {
      const op = operators.for('extra.load[btw]=1,50&extra.address.number[nin]=1,2')
                          .where.add('extra', 'adr.extra', EXTRA);

      assert.equal(
        normalize(op.query(BASE)),
        `${BASE_AND} (((adr.extra->>'load')::bigint BETWEEN $1 AND $2)` +
        " AND ((adr.extra #>> '{address,number}')::bigint NOT IN ($3, $4)))"
      );
      assert.deepEqual(op.values, [1, 50, 1, 2]);
    });

    test('null: the key is missing or holds a JSON null', () => {
      const op = operators.for('extra.load[null]=true&extra.address.street[null]=false')
                          .where.add('extra', 'adr.extra', EXTRA);

      assert.equal(
        normalize(op.query(BASE)),
        `${BASE_AND} ((adr.extra #>> '{address,street}' IS NOT NULL) AND (adr.extra->>'load' IS NULL))`
      );
      assert.deepEqual(op.values, []);
    });

    test('exists: the key is present, even when it holds null', () => {
      const op = operators.for('extra.load[exists]=true&extra.address.number[exists]=false')
                          .where.add('extra', 'adr.extra', EXTRA);

      assert.equal(
        normalize(op.query(BASE)),
        `${BASE_AND} ((adr.extra->'load' IS NOT NULL) AND (adr.extra #> '{address,number}' IS NULL))`
      );
    });

    test('null without a path tests the column itself', () => {
      const op = operators.for('extra[null]=true')
                          .where.add('extra', 'adr.extra', EXTRA);

      assert.equal(normalize(op.query(BASE)), `${BASE_AND} ((adr.extra IS NULL))`);
    });
  });

  describe('mysql', () => {
    test('values go through JSON_EXTRACT / JSON_UNQUOTE, ints are cast to SIGNED', () => {
      const op = operators.for('extra.address.street[ilike]=main&extra.load[gt]=5&extra.address.number=10', { dialect: 'mysql' })
                          .where.add('extra', 'adr.extra', EXTRA);

      assert.equal(
        normalize(op.query(BASE)),
        `${BASE_AND} ((JSON_UNQUOTE(JSON_EXTRACT(adr.extra, '$.address.street')) LIKE ?)` +
        " AND (CAST(JSON_UNQUOTE(JSON_EXTRACT(adr.extra, '$.load')) AS SIGNED) > ?)" +
        " AND (CAST(JSON_UNQUOTE(JSON_EXTRACT(adr.extra, '$.address.number')) AS SIGNED) = ?))"
      );
      assert.deepEqual(op.values, ['%main%', 5, 10]);
    });

    test('null and exists', () => {
      const op = operators.for('extra.load[null]=true&extra.load[exists]=true&extra.address.number[exists]=false', { dialect: 'mysql' })
                          .where.add('extra', 'adr.extra', EXTRA);

      assert.equal(
        normalize(op.query(BASE)),
        `${BASE_AND} ((COALESCE(JSON_TYPE(JSON_EXTRACT(adr.extra, '$.load')), 'NULL') = 'NULL')` +
        " AND (JSON_CONTAINS_PATH(adr.extra, 'one', '$.load') IS TRUE)" +
        " AND (JSON_CONTAINS_PATH(adr.extra, 'one', '$.address.number') IS NOT TRUE))"
      );
    });

    test('bool paths compare the unquoted text with true / false', () => {
      const op = operators.for('extra.active[eq]=1', { dialect: 'mysql' })
                          .where.add('extra', 'adr.extra', { type: 'json', paths: { active: 'bool' } });

      assert.equal(normalize(op.query(BASE)), `${BASE_AND} ((JSON_UNQUOTE(JSON_EXTRACT(adr.extra, '$.active')) = ?))`);
      assert.deepEqual(op.values, ['true']);
    });
  });

  describe('operators per path', () => {
    test('short form: a path accepts every operator that suits its type', () => {
      const op = operators.for({}).where.add('extra', 'adr.extra', EXTRA);
      const { paths } = op._filters[0];

      assert.deepEqual(paths.get('address.street').ops, ['eq', 'neq', 'in', 'nin', 'null', 'exists', 'like', 'nlike', 'ilike', 'nilike', 'starts', 'ends']);
      assert.deepEqual(paths.get('load').ops, ['eq', 'neq', 'in', 'nin', 'null', 'exists', 'gt', 'gte', 'lt', 'lte', 'btw']);
    });

    test('full form: only the operators the path declares', () => {
      const op = operators.for('extra.address.street[eq]=x&extra.load[gt]=1')
                          .where.add('extra', 'adr.extra', {
                            type: 'json',
                            paths: {
                              'address.street': { type: 'string', ops: ['ilike'] },
                              'load':           { type: 'int', ops: ['eq', 'in'] },
                            },
                          });

      const err = thrown(() => op.query(BASE));
      assert.ok(err instanceof FilterError);
      assert.equal(err.message, "Operator 'eq' is not allowed for filter 'extra.address.street'");
      assert.equal(err.param, 'extra.address.street');
    });

    test('a type-incompatible operator is rejected (ilike on an int path)', () => {
      const op = operators.for('extra.load[ilike]=1')
                          .where.add('extra', 'adr.extra', EXTRA);

      assert.throws(() => op.query(BASE), /Operator 'ilike' is not allowed for filter 'extra.load'/);
    });

    test('a value without an operator uses the first operator of the path (eq when ops is not declared)', () => {
      const op = operators.for('extra.load=7&extra[address][street]=Main St')
                          .where.add('extra', 'adr.extra', {
                            type: 'json',
                            paths: { load: 'int', 'address.street': { type: 'string', ops: ['ilike', 'eq'] } },
                          });

      assert.equal(
        normalize(op.query(BASE)),
        `${BASE_AND} (((adr.extra->>'load')::bigint = $1) AND (adr.extra #>> '{address,street}' ILIKE $2))`
      );
      assert.deepEqual(op.values, [7, '%Main St%']);
    });

    test('the filter `operator` option applies to its paths; a path `operator` wins over it', () => {
      const op = operators.for('extra.load=1,2&extra.address.number=3')
                          .where.add('extra', 'adr.extra', {
                            type: 'json',
                            operator: 'in',
                            paths: { load: 'int', 'address.number': { type: 'int', operator: 'gte' } },
                          });

      assert.equal(
        normalize(op.query(BASE)),
        `${BASE_AND} (((adr.extra->>'load')::bigint IN ($1, $2)) AND ((adr.extra #>> '{address,number}')::bigint >= $3))`
      );
    });

    test('a default operator the path does not allow is a declaration error', () => {
      assert.throws(
        () => operators.for({}).where.add('extra', 'adr.extra', {
          type: 'json', paths: { load: { type: 'int', ops: ['eq'], operator: 'gt' } },
        }),
        /operator 'gt' of path 'load' must be one of the operators of path 'load' \[eq\]/
      );
      assert.throws(
        () => operators.for({}).where.add('extra', 'adr.extra', {
          type: 'json', operator: 'ilike', paths: { load: 'int' },
        }),
        /operator 'ilike' must be one of the operators of path 'load'/
      );
    });

    test('repeating a path parameter is an AND, also across input shapes', () => {
      const op = operators.for({ 'extra.load': { gt: 1 }, extra: { load: { gt: 2 } } })
                          .where.add('extra', 'adr.extra', EXTRA);

      assert.equal(
        normalize(op.query(BASE)),
        `${BASE_AND} (((adr.extra->>'load')::bigint > $1) AND ((adr.extra->>'load')::bigint > $2))`
      );
      assert.deepEqual(op.values, [1, 2]);
    });

    test('empty values add no condition', () => {
      const op = operators.for('extra.load[gt]=&extra.address.street[ilike]=')
                          .where.add('extra', 'adr.extra', EXTRA);

      assert.equal(op.query(BASE), BASE);
    });
  });

  describe('request errors', () => {
    test('a path that is not declared is rejected (the whitelist)', () => {
      const unknown = operators.for('extra.password[eq]=1')
                               .where.add('extra', 'adr.extra', EXTRA);
      const err = thrown(() => unknown.query(BASE));
      assert.ok(err instanceof FilterError);
      assert.equal(err.message, "Path 'password' is not allowed for filter 'extra'");
      assert.equal(err.status, 422);

      // A parent of a declared path is not a path itself.
      const parent = operators.for('extra.address[eq]=1')
                              .where.add('extra', 'adr.extra', EXTRA);
      assert.throws(() => parent.query(BASE), /Path 'address' is not allowed/);

      // Nor is anything below a declared path.
      const below = operators.for('extra[load][x][eq]=1')
                             .where.add('extra', 'adr.extra', EXTRA);
      assert.throws(() => below.query(BASE), /Path 'load.x' is not allowed/);
    });

    test('values are validated with the type of the path', () => {
      const op = operators.for('extra.address.number[eq]=10abc')
                          .where.add('extra', 'adr.extra', EXTRA);

      assert.throws(() => op.query(BASE), /Invalid int value for 'extra.address.number': "10abc"/);
    });

    test('without a path only null is accepted', () => {
      const op = operators.for('extra[eq]=1')
                          .where.add('extra', 'adr.extra', EXTRA);
      assert.throws(() => op.query(BASE), /Filter 'extra' needs a path \(e\.g\. extra\.address\.street\[eq\]=…\)/);

      const bare = operators.for('extra=1')
                            .where.add('extra', 'adr.extra', EXTRA);
      assert.throws(() => bare.query(BASE), /needs a path/);
    });

    test('nested objects as values are rejected', () => {
      const op = operators.for({ extra: { load: { eq: { a: 1 } } } })
                          .where.add('extra', 'adr.extra', EXTRA);

      assert.throws(() => op.query(BASE), FilterError);
    });

    test('the status and code of the filter apply to its paths', () => {
      const op = operators.for('extra.nope[eq]=1')
                          .where.add('extra', 'adr.extra', EXTRA, { status: 400, code: 77 });

      const err = thrown(() => op.query(BASE));
      assert.equal(err.status, 400);
      assert.equal(err.code, 77);
    });
  });

  describe('required', () => {
    test('a required path must be supplied; its name is the dotted path', () => {
      const declare = (input) => operators.for(input)
        .where.add('extra', 'adr.extra', {
          type: 'json',
          paths: { 'load': 'int', 'address.number': { type: 'int', required: true } },
        }, { code: 1022 });

      const err = thrown(() => declare('extra.load[eq]=1').query(BASE));
      assert.ok(err instanceof FilterError);
      assert.equal(err.message, 'filter extra.address.number not supplied');
      assert.equal(err.param, 'extra.address.number');
      assert.equal(err.code, 1022);

      assert.doesNotThrow(() => declare('extra.address.number[eq]=1').query(BASE));
    });

    test('a required filter needs at least one of its paths (or extra[null])', () => {
      const declare = (input) => operators.for(input)
        .where.add('extra', 'adr.extra', { ...EXTRA, required: true });

      assert.throws(() => declare('').query(BASE), /filter extra not supplied/);
      assert.doesNotThrow(() => declare('extra.load[gt]=1').query(BASE));
      assert.doesNotThrow(() => declare('extra[null]=false').query(BASE));
    });
  });

  describe('security', () => {
    test('injection payloads in values only reach `values`', () => {
      const payload = "x' OR 1=1 --";
      const op = operators.for({ extra: { address: { street: { eq: payload } } } })
                          .where.add('extra', 'adr.extra', EXTRA);

      assert.ok(!op.query(BASE).includes(payload));
      assert.deepEqual(op.values, [payload]);
    });

    test('injection payloads in the path never reach the SQL: undeclared paths are rejected', () => {
      const op = operators.for({ extra: { "load') OR 1=1 --": { eq: 1 } } })
                          .where.add('extra', 'adr.extra', EXTRA);

      assert.throws(() => op.query(BASE), /is not allowed for filter 'extra'/);
    });

    test('strict mode knows the json paths, and still rejects other filters', () => {
      const ok = operators.for('extra.load[gt]=1&extra[address][number]=2', { strict: true })
                          .where.add('extra', 'adr.extra', EXTRA);
      assert.doesNotThrow(() => ok.query(BASE));

      const unknown = operators.for('extras.load[gt]=1', { strict: true })
                               .where.add('extra', 'adr.extra', EXTRA);
      assert.throws(() => unknown.query(BASE), /Unknown filter 'extras.load'/);
    });

    test('__proto__ in a JSON body neither breaks nor pollutes anything', () => {
      const body = JSON.parse('{"extra":{"__proto__":{"eq":"1"},"load":{"eq":"2"}}}');
      const op = operators.for(body)
                          .where.add('extra', 'adr.extra', EXTRA);

      assert.throws(() => op.query(BASE), /Path '__proto__' is not allowed/);
      assert.equal({}.eq, undefined);
    });
  });

  describe('declaration errors', () => {
    const add = (opts, column = 'adr.extra') => () => operators.for({}).where.add('extra', column, opts);

    test('a json filter takes no operator list: the operators live in its paths', () => {
      assert.throws(
        () => operators.for({}).where.add('extra', 'adr.extra', ['eq', 'gt'], EXTRA),
        /type 'json' takes no operator list/
      );
      // Short form: the name doubles as the column.
      const op = operators.for('extra.load[gt]=1').where.add('extra', EXTRA);
      assert.equal(normalize(op.query('SELECT 1 FROM t')), "SELECT 1 FROM t WHERE ((extra->>'load')::bigint > $1)");
    });

    test('paths are required, and only for type json', () => {
      assert.throws(add({ type: 'json' }), /non-empty paths object/);
      assert.throws(add({ type: 'json', paths: {} }), /non-empty paths object/);
      assert.throws(add({ type: 'int', paths: { load: 'int' } }), /paths need type 'json'/);
      assert.throws(add(EXTRA, () => 'x'), /needs a column, not a function/);
    });

    test('invalid path names', () => {
      assert.throws(add({ type: 'json', paths: { 'a..b': 'int' } }), /invalid path 'a\.\.b'/);
      assert.throws(add({ type: 'json', paths: { "a'b": 'int' } }), /invalid path/);
      assert.throws(add({ type: 'json', paths: { '1a': 'int' } }), /invalid path/);
      assert.throws(add({ type: 'json', paths: { 'a.in': 'int' } }), /cannot use the operator name 'in'/);
      assert.throws(
        add({ type: 'json', paths: { address: 'string', 'address.street': 'string' } }),
        /'address' cannot also be the parent of 'address.street'/
      );
    });

    test('invalid types and operators', () => {
      assert.throws(add({ type: 'json', paths: { load: 'integer' } }), /unknown type 'integer' for path 'load'/);
      assert.throws(add({ type: 'json', paths: { load: 'json' } }), /unknown type 'json'/);
      assert.throws(add({ type: 'json', paths: { load: { type: 'int', ops: ['ilike'] } } }), /'ilike' is not valid for path 'load' \(int\)/);
      assert.throws(add({ type: 'json', paths: { load: { type: 'int', ops: ['nope'] } } }), /unknown operator 'nope' for path 'load'/);
      assert.throws(add({ type: 'json', paths: { load: { type: 'int', ops: [] } } }), /non-empty array/);
      assert.throws(add({ type: 'json', paths: { load: { type: 'int', required: 'yes' } } }), /required of path 'load'/);
      assert.throws(add({ ...EXTRA, operator: 'nope' }), /unknown operator 'nope'/);
    });

    test('exists is only an operator of json paths', () => {
      assert.throws(() => operators.for({}).where.add('a', 'a.a', ['exists']), /unknown operator 'exists'/);
      assert.doesNotThrow(add({ type: 'json', paths: { load: { type: 'int', ops: ['exists'] } } }));
    });
  });
});
