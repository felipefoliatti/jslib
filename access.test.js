'use strict';

// Run with:  npm test   (Node >= 18: node --test | any Node: mocha)
const runner = typeof global.describe === 'function' && typeof global.it === 'function'
  ? { describe: global.describe, test: global.it }
  : require('node:test');
const { describe, test } = runner;

const assert = require('assert').strict;
const access = require('./access');
const { AccessError, MAX_LIST, FULL } = access;

// ---------------------------------------------------------------------------
// Fixtures and helpers
// ---------------------------------------------------------------------------

// The schema is owned by the project; these tests use a generic one with the shapes they need:
// an enforced entity with a branch column and a relation (items, type 2), the related entity (owners,
// type 3, not enforced), an entity without a branch column or type (tags) and one with a custom column.
const SCHEMA = {
  items:   { enforced: true, type: 2, table: '"store"."item"', columns: ['id', 'branch'], branch: 'branch', relations: { owner: 'owners' } },
  owners:  { type: 3, table: '"store"."owner"', columns: ['id', 'branch'], branch: 'branch' },
  tags:    { table: '"store"."tag"', columns: ['id'] },
  members: { type: 4, table: '"store"."member"', columns: ['id', 'branch'], branch: 'branch',
             custom: { branch: (alias) => `EXISTS (SELECT 1 FROM "store"."member_branch" mb WHERE mb.deleted=0 AND mb.member=${alias}.id AND mb.branch IN (?))` } },
};

const FALLBACK = 1;
const ITEMS = 2;

// Keys of rows are validated, so the branches are real guids (named A, B, C, D in the tests).
const A = 'aaaaaaaa-0000-0000-0000-000000000001';
const B = 'bbbbbbbb-0000-0000-0000-000000000002';
const C = 'cccccccc-0000-0000-0000-000000000003';
const D = 'dddddddd-0000-0000-0000-000000000004';
const BRANCHES = [A, B, C];

/** One access row. */
const row = (key, type, filter) => ({ key, type, filter });

/** validate() of a single row with the fixture schema (as when a row is saved). */
const validateOne = (value) => access.validate([value], SCHEMA);

/** The level of one user or group, from its rows. */
const level = (...rows) => access.level(rows, SCHEMA);

/** Runs `fn` and returns the AccessError it throws (the test fails otherwise). */
function rejected(fn) {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof AccessError, `expected an AccessError, got ${err}`);
    return err;
  }
  return assert.fail('expected an AccessError to be thrown');
}

// The rows of the examples: a fallback for any branch, an items rule and a wider fallback in A, and the
// "all my branches" option.
const STORED = [
  row('*', FALLBACK, { branch: ['$self', null] }),
  row(A, ITEMS, { id: ['i1'], branch: ['$self'] }),
  row(A, FALLBACK, { branch: ['$self', C, null] }),
  row('$branches', FALLBACK, { branch: ['$branches', null] }),
];

// ===========================================================================
describe('validate', () => {
  describe('valid', () => {
    test('fallback rows (type 1): any branch, a branch id, $branches, and false for $branches', () => {
      validateOne(row('*', FALLBACK, { branch: ['$self', null] }));
      validateOne(row(A, FALLBACK, { branch: ['$self', C, null] }));
      validateOne(row('$branches', FALLBACK, { branch: ['$branches', null] }));
      validateOne(row('$branches', FALLBACK, { branch: '*' }));
      validateOne(row('$branches', FALLBACK, false));
    });

    test("entity rows: '*' rules, {} rules, '*' columns", () => {
      validateOne(row('*', ITEMS, '*'));
      validateOne(row(A, ITEMS, {}));
      validateOne(row(C, ITEMS, { id: '*' }));
      validateOne(row(A, ITEMS, { id: ['i1'], branch: ['$self'] }));
    });

    test('placeholders in the branch column of a related entity (not enforced itself)', () => {
      validateOne(row('*', ITEMS, { owner: { branch: ['$self', '$branches', null], id: ['o1'] } }));
    });

    test('$branches inside the $branches option', () => {
      validateOne(row('$branches', ITEMS, { branch: ['$branches'] }));
    });

    test(`a list of exactly MAX_LIST (${MAX_LIST}) items`, () => {
      const ids = Array.from({ length: MAX_LIST }, (_, i) => `i${i}`);
      validateOne(row('*', ITEMS, { id: ids }));
    });
  });

  describe('invalid (every case checks the path)', () => {
    test('the row is not an object', () => {
      assert.equal(rejected(() => validateOne(null)).path, '');
      assert.equal(rejected(() => validateOne([])).path, '');
    });

    test("a key that is not '*', '$branches' or a branch id", () => {
      const err = rejected(() => validateOne(row('A', FALLBACK, { branch: '*' })));
      assert.equal(err.path, 'key');
      assert.equal(err.name, 'AccessError');
    });

    test('false only for the fallback of $branches', () => {
      assert.equal(rejected(() => validateOne(row('*', FALLBACK, false))).path, 'filter');
      assert.equal(rejected(() => validateOne(row(A, FALLBACK, false))).path, 'filter');
      assert.equal(rejected(() => validateOne(row('$branches', ITEMS, false))).path, 'filter');
    });

    test('fallback: not an object, extra keys, missing branch', () => {
      assert.equal(rejected(() => validateOne(row('*', FALLBACK, '*'))).path, 'filter');
      assert.equal(rejected(() => validateOne(row('*', FALLBACK, { branch: '*', id: ['x'] }))).path, 'filter.id');
      assert.equal(rejected(() => validateOne(row('*', FALLBACK, {}))).path, 'filter.branch');
    });

    test('fallback: empty list, or only null', () => {
      assert.equal(rejected(() => validateOne(row('*', FALLBACK, { branch: [] }))).path, 'filter.branch');
      assert.equal(rejected(() => validateOne(row('*', FALLBACK, { branch: [null] }))).path, 'filter.branch');
    });

    test('a type that is not in the schema, or of an entity not enforced yet', () => {
      assert.equal(rejected(() => validateOne(row('*', 9, '*'))).path, 'type');
      assert.match(rejected(() => validateOne(row('*', '2', '*'))).message, /unknown type '2'/);

      const err = rejected(() => validateOne(row(A, 3, '*')));
      assert.equal(err.path, 'type');
      assert.match(err.message, /entity 'owners' not supported yet/);
    });

    test('a rule that is not "*", {} or an object', () => {
      assert.equal(rejected(() => validateOne(row('*', ITEMS, 5))).path, 'filter');
    });

    test('a filter still as a string (mysql brings JSON columns as strings: the caller parses it)', () => {
      const entity = rejected(() => validateOne(row('*', ITEMS, '{"id":["i1"]}')));
      assert.equal(entity.path, 'filter');
      assert.match(entity.message, /rule must be '\*', \{\} or an object/);

      const fallback = rejected(() => validateOne(row('*', FALLBACK, '{"branch":["$self"]}')));
      assert.equal(fallback.path, 'filter');
      assert.match(fallback.message, /the else block must be an object/);
    });

    test('unknown column or relation, also inside a relation', () => {
      assert.equal(rejected(() => validateOne(row('*', ITEMS, { color: ['red'] }))).path, 'filter.color');
      assert.equal(rejected(() => validateOne(row('*', ITEMS, { owner: { color: '*' } }))).path, 'filter.owner.color');
    });

    test('a column value that is not a list or "*", items that are not strings or null', () => {
      assert.equal(rejected(() => validateOne(row('*', ITEMS, { id: 'i1' }))).path, 'filter.id');
      assert.equal(rejected(() => validateOne(row('*', ITEMS, { id: [1] }))).path, 'filter.id');
      assert.equal(rejected(() => validateOne(row('*', FALLBACK, { branch: 'A' }))).path, 'filter.branch');
    });

    test('unknown placeholder', () => {
      const err = rejected(() => validateOne(row('*', FALLBACK, { branch: ['$all'] })));
      assert.equal(err.path, 'filter.branch');
      assert.match(err.message, /unknown placeholder '\$all'/);
    });

    test('a placeholder outside a branch column (id), also inside a relation', () => {
      assert.equal(rejected(() => validateOne(row('*', ITEMS, { id: ['$self'] }))).path, 'filter.id');
      assert.equal(rejected(() => validateOne(row('*', ITEMS, { owner: { id: ['$branches'] } }))).path, 'filter.owner.id');
    });

    test('$self inside the $branches option', () => {
      assert.equal(rejected(() => validateOne(row('$branches', FALLBACK, { branch: ['$self'] }))).path, 'filter.branch');
      assert.equal(rejected(() => validateOne(row('$branches', ITEMS, { owner: { branch: ['$self'] } }))).path, 'filter.owner.branch');
    });

    test(`a list longer than MAX_LIST (${MAX_LIST})`, () => {
      const ids = Array.from({ length: MAX_LIST + 1 }, (_, i) => `i${i}`);
      assert.equal(rejected(() => validateOne(row('*', ITEMS, { id: ids }))).path, 'filter.id');
    });
  });

  describe('a list of rows', () => {
    test('no rows (null, undefined, []) is valid', () => {
      assert.equal(access.validate(null, SCHEMA), undefined);
      assert.equal(access.validate(undefined, SCHEMA), undefined);
      assert.equal(access.validate([], SCHEMA), undefined);
    });

    test('rows that are not a list', () => {
      const err = rejected(() => access.validate(row('*', FALLBACK, { branch: '*' }), SCHEMA));
      assert.equal(err.path, '');
      assert.equal(err.index, undefined);
    });

    test('index: the position of the row that failed; path stays inside the row', () => {
      const ok = row('*', FALLBACK, { branch: ['$self'] });
      const err = rejected(() => access.validate([ok, row(A, ITEMS, { id: ['$self'] }), ok], SCHEMA));
      assert.equal(err.index, 1);
      assert.equal(err.path, 'filter.id');

      assert.equal(rejected(() => validateOne(row('A', FALLBACK, { branch: '*' }))).index, 0); // a single row
    });

    test(`merged rows: a list longer than MAX_LIST (${MAX_LIST}) once merged; path inside the level, no index`, () => {
      const half = (from) => Array.from({ length: 101 }, (_, i) => `i${from + i}`);
      const err = rejected(() => access.validate([row(A, ITEMS, { id: half(0) }), row(A, ITEMS, { id: half(101) })], SCHEMA));
      assert.equal(err.path, `${A}.items.id`);
      assert.equal(err.index, undefined);

      // the same rows under different keys are not merged: valid
      assert.equal(access.validate([row(A, ITEMS, { id: half(0) }), row(B, ITEMS, { id: half(101) })], SCHEMA), undefined);
    });

    test('the rows of the examples are valid', () => {
      assert.equal(access.validate(STORED, SCHEMA), undefined);
    });
  });

  describe('the schema', () => {
    /** The plain Error validate() throws for this schema (not an AccessError: it is a programming error). */
    function invalid(schema) {
      try {
        access.validate([row('*', FALLBACK, { branch: '*' })], schema);
      } catch (err) {
        assert.ok(!(err instanceof AccessError), `expected a plain Error, got an AccessError: ${err.message}`);
        return err.message;
      }
      return assert.fail('expected the schema to be rejected');
    }

    const entity = (definition) => ({ things: { table: '"store"."thing"', columns: ['id', 'branch'], ...definition } });

    test('validate without a schema throws, even without rows', () => {
      assert.match(invalid(undefined), /schema: must be a non-empty object/);
      assert.throws(() => access.validate([], undefined), /schema: must be a non-empty object/);
    });

    test('the schema is a non-empty object; each definition an object', () => {
      assert.match(invalid({}), /must be a non-empty object/);
      assert.match(invalid([]), /must be a non-empty object/);
      assert.match(invalid({ things: 'x' }), /things must be an object/);
    });

    test('table: a non-empty string', () => {
      assert.match(invalid(entity({ table: undefined })), /things\.table must be a non-empty string/);
      assert.match(invalid(entity({ table: ' ' })), /things\.table must be a non-empty string/);
    });

    test('columns: a non-empty list of non-empty strings', () => {
      assert.match(invalid(entity({ columns: undefined })), /things\.columns must be a non-empty list/);
      assert.match(invalid(entity({ columns: [] })), /things\.columns must be a non-empty list/);
      assert.match(invalid(entity({ columns: ['id', ''] })), /things\.columns must be a non-empty list/);
      assert.match(invalid(entity({ columns: ['id', 7] })), /things\.columns must be a non-empty list/);
    });

    test('branch: one of the columns', () => {
      assert.match(invalid(entity({ branch: 'place' })), /things\.branch must be one of its columns, got 'place'/);
    });

    test('relations: an object whose targets are entities of the same schema', () => {
      assert.match(invalid(entity({ relations: ['owner'] })), /things\.relations must be an object/);
      assert.match(invalid(entity({ relations: { owner: 'owners' } })), /things\.relations\.owner points to unknown entity 'owners'/);
    });

    test('custom: an object of columns -> functions', () => {
      assert.match(invalid(entity({ custom: 'x' })), /things\.custom must be an object/);
      assert.match(invalid(entity({ custom: { place: () => 'x' } })), /things\.custom\.place is not one of its columns/);
      assert.match(invalid(entity({ custom: { branch: 'EXISTS (...)' } })), /things\.custom\.branch must be a function/);
    });

    test('enforced: a boolean; unknown properties are rejected (typos)', () => {
      assert.match(invalid(entity({ enforced: 'yes' })), /things\.enforced must be a boolean/);
      assert.match(invalid(entity({ relation: { owner: 'things' } })), /things\.relation is not a property/);
    });

    test('type: an integer >= 2 (1 is the fallback)', () => {
      assert.match(invalid(entity({ type: '2' })), /things\.type must be an integer >= 2/);
      assert.match(invalid(entity({ type: 2.5 })), /things\.type must be an integer >= 2/);
      assert.match(invalid(entity({ type: 1 })), /things\.type must be an integer >= 2/);
      assert.match(invalid(entity({ type: 0 })), /things\.type must be an integer >= 2/);
    });

    test('type: unique in the schema', () => {
      const schema = { ...entity({ type: 2 }), others: { type: 2, table: '"store"."other"', columns: ['id'] } };
      assert.match(invalid(schema), /others\.type 2 is already the type of 'things'/);
    });

    test('type: required when enforced', () => {
      assert.match(invalid(entity({ enforced: true })), /things\.type is required when enforced/);
      assert.equal(access.validate([row('*', 2, '*')], entity({ enforced: true, type: 2 })), undefined);
    });

    test('a schema is checked once: later calls with the same object skip the check', () => {
      const schema = entity({});
      access.checkSchema(schema);
      schema.things.columns = []; // invalid now, but already checked
      assert.equal(access.validate([row('*', FALLBACK, { branch: '*' })], schema), undefined);

      assert.throws(() => access.checkSchema({ things: { ...schema.things } }), /things\.columns/); // another object: checked
    });
  });
});

// ===========================================================================
describe('level', () => {
  test('no rows: null (chain drops it)', () => {
    assert.equal(access.level(null, SCHEMA), null);
    assert.equal(access.level(undefined, SCHEMA), null);
    assert.equal(access.level([], SCHEMA), null);
    assert.deepEqual(access.chain([access.level([], SCHEMA)]), []);
  });

  test('rows map to { key: { entity | "*": rule } } by type (1 = "*", the fallback)', () => {
    assert.deepEqual(level(...STORED), {
      '*': { '*': { branch: ['$self', null] } },
      [A]: { items: { id: ['i1'], branch: ['$self'] }, '*': { branch: ['$self', C, null] } },
      '$branches': { '*': { branch: ['$branches', null] } },
    });
  });

  test('fallback rows with the same key are merged with OR (union, first-seen order, no duplicates)', () => {
    assert.deepEqual(level(row('*', FALLBACK, { branch: ['$self', null] }), row('*', FALLBACK, { branch: [C, null, '$self'] })), {
      '*': { '*': { branch: ['$self', null, C] } },
    });
    assert.deepEqual(level(row('*', FALLBACK, { branch: ['$self'] }), row('*', FALLBACK, { branch: '*' })), {
      '*': { '*': { branch: '*' } },
    });
  });

  test("rules with the same key and type are merged with OR: '*' wins, {} adds nothing, keys are united", () => {
    assert.deepEqual(level(row(A, ITEMS, { id: ['i1'] }), row(A, ITEMS, '*')), { [A]: { items: '*' } });
    assert.deepEqual(level(row(A, ITEMS, '*'), row(A, ITEMS, { id: ['i1'] })), { [A]: { items: '*' } });
    assert.deepEqual(level(row(A, ITEMS, {}), row(A, ITEMS, {})), { [A]: { items: {} } });
    assert.deepEqual(level(row(A, ITEMS, {}), row(A, ITEMS, { id: ['i1'] })), { [A]: { items: { id: ['i1'] } } });
    assert.deepEqual(level(row(A, ITEMS, { id: ['i1', 'i2'] }), row(A, ITEMS, { branch: [C], id: ['i2', 'i3'] })), {
      [A]: { items: { id: ['i1', 'i2', 'i3'], branch: [C] } },
    });
    assert.deepEqual(level(row(A, ITEMS, { id: ['i1'] }), row(A, ITEMS, { id: '*' })), { [A]: { items: { id: '*' } } });
  });

  test('relations present in both rows are merged recursively', () => {
    assert.deepEqual(level(row(A, ITEMS, { owner: { branch: [A] } }), row(A, ITEMS, { owner: { branch: [B], id: ['o1'] } })), {
      [A]: { items: { owner: { branch: [A, B], id: ['o1'] } } },
    });
    assert.deepEqual(level(row(A, ITEMS, { owner: { branch: [A] } }), row(A, ITEMS, { owner: '*' })), {
      [A]: { items: { owner: '*' } },
    });
  });

  test('rows with different keys or types are not merged', () => {
    assert.deepEqual(level(row(A, ITEMS, { id: ['i1'] }), row(B, ITEMS, { id: ['i2'] }), row(A, FALLBACK, { branch: [A] })), {
      [A]: { items: { id: ['i1'] }, '*': { branch: [A] } },
      [B]: { items: { id: ['i2'] } },
    });
  });

  test('false (the $branches fallback) wins over an object in the same level, in any order', () => {
    const open = row('$branches', FALLBACK, { branch: ['$branches'] });
    const blocked = row('$branches', FALLBACK, false);
    assert.deepEqual(level(open, blocked), { '$branches': { '*': false } });
    assert.deepEqual(level(blocked, open), { '$branches': { '*': false } });
  });

  test(`a merged list longer than MAX_LIST (${MAX_LIST}) throws`, () => {
    const half = (from) => Array.from({ length: 101 }, (_, i) => `i${from + i}`);
    // the path is inside the level (<key>.<entity>.<column>): which key, entity and column went over
    const err = rejected(() => level(row(A, ITEMS, { id: half(0) }), row(A, ITEMS, { id: half(101) })));
    assert.equal(err.path, `${A}.items.id`);
    assert.match(err.message, /more than 200 items once the rows are merged/);

    // 150 + 150 branch ids overlapping in 50: 250 once merged
    const ids = Array.from({ length: 250 }, (_, i) => `bbbbbbbb-0000-0000-0000-${String(i).padStart(12, '0')}`);
    assert.equal(rejected(() => level(row('*', FALLBACK, { branch: ids.slice(0, 150) }), row('*', FALLBACK, { branch: ids.slice(100) }))).path, '*.*.branch');
  });

  test('an invalid row throws, like validate: path inside the row and its index (e.g. a type no longer in the schema)', () => {
    const err = rejected(() => level(row('*', FALLBACK, { branch: ['$self'] }), row('*', 9, '*')));
    assert.equal(err.path, 'type');
    assert.equal(err.index, 1);
    assert.equal(rejected(() => level(row('*', ITEMS, { id: ['$self'] }))).path, 'filter.id');
  });

  test('the rows are not modified, and the level does not share their objects (merged or not)', () => {
    const rows = [
      row(A, ITEMS, { owner: { branch: [A] } }), row(A, ITEMS, { owner: { branch: [B] } }), // merged
      row('*', FALLBACK, { branch: ['$self'] }),                                             // alone
    ];
    const copy = JSON.parse(JSON.stringify(rows));
    const built = access.level(rows, SCHEMA);
    built[A].items.owner.branch.push(C);
    built['*']['*'].branch.push(C);

    assert.deepEqual(rows, copy);
  });

  test('level checks the schema first, even without rows', () => {
    assert.throws(() => access.level([row('*', FALLBACK, { branch: '*' })]), /schema: must be a non-empty object/);
    assert.throws(() => access.level([], undefined), (err) => !(err instanceof AccessError) && /schema: must be a non-empty object/.test(err.message));
    assert.throws(() => access.level(null, {}), /schema: must be a non-empty object/);
  });
});

// ===========================================================================
describe('chain', () => {
  test('removes null / undefined levels and keeps the order', () => {
    const user = level(row('*', FALLBACK, { branch: ['$self'] }));
    const parent = level(row('$branches', FALLBACK, false));

    assert.deepEqual(access.chain([user, null, parent, undefined, FULL]), [user, parent, FULL]);
  });

  test('nothing configured: an empty chain', () => {
    assert.deepEqual(access.chain([null, undefined]), []);
    assert.deepEqual(access.chain(undefined), []);
  });

  test('FULL is the implicit full level for admins', () => {
    assert.deepEqual(FULL, { '*': { '*': { branch: '*' } }, '$branches': { '*': { branch: '*' } } });
    assert.deepEqual(access.options(access.chain([null, FULL]), BRANCHES), [A, B, C, '$branches']);
  });
});

// ===========================================================================
describe('options', () => {
  const fallback = (key) => row(key, FALLBACK, { branch: ['$self'] });

  test('the rows of the examples: every branch and $branches', () => {
    assert.deepEqual(access.options([level(...STORED)], BRANCHES), [A, B, C, '$branches']);
  });

  test('branches whose fallback some level has, by their id or "*"; the others are not options', () => {
    assert.deepEqual(access.options([level(fallback(A)), level(fallback(B))], BRANCHES), [A, B]);
    assert.deepEqual(access.options([level(fallback(A)), level(fallback('*'))], BRANCHES), [A, B, C]);
  });

  test('rows never add branches the user cannot select', () => {
    assert.deepEqual(access.options([level(fallback(D), fallback(A))], BRANCHES), [A]);
  });

  test('entity rows without a fallback for the branch in any level: not an option', () => {
    assert.deepEqual(access.options([level(row(A, ITEMS, '*'), row('*', ITEMS, '*'))], BRANCHES), []);
    assert.deepEqual(access.options([level(row(A, ITEMS, '*')), level(fallback(B))], BRANCHES), [B]);
  });

  test('$branches absent: not an option', () => {
    assert.deepEqual(access.options([level(fallback('*'))], BRANCHES), [A, B, C]);
  });

  test('$branches: false in a nearer level blocks the levels below', () => {
    const levels = [level(row('$branches', FALLBACK, false)), level(row('$branches', FALLBACK, { branch: ['$branches'] }))];
    assert.deepEqual(access.options(levels, BRANCHES), []);
  });

  test('a blocking row lives at ($branches, "*"); a whole $branches context set to false is not recognised', () => {
    const blocked = level(row('$branches', FALLBACK, false), row('$branches', ITEMS, '*'));
    assert.deepEqual(blocked, { '$branches': { '*': false, items: '*' } });

    // the old shape blocks nothing: the level below still grants $branches
    const below = level(row('$branches', FALLBACK, { branch: ['$branches'] }));
    assert.deepEqual(access.options([{ '$branches': false }, below], BRANCHES), ['$branches']);
  });

  test('$branches granted by a parent when the levels above have no $branches fallback', () => {
    const levels = [level(fallback(A)), level(fallback(B), row('$branches', ITEMS, '*')), level(row('$branches', FALLBACK, { branch: ['$branches'] }))];
    assert.deepEqual(access.options(levels, BRANCHES), [A, B, '$branches']);
  });

  test('$branches whose fallback resolves to nothing is not an option', () => {
    // validateOne rejects [null], but levels can also be built by hand (FULL, tests): options must handle it
    assert.deepEqual(access.options([{ '$branches': { '*': { branch: [null] } } }], BRANCHES), []);
    assert.deepEqual(access.options([level(row('$branches', FALLBACK, { branch: ['$branches'] }))], []), []);
    assert.deepEqual(access.options([level(row('$branches', FALLBACK, { branch: '*' }))], []), ['$branches']);
  });

  test('empty chain: no options', () => {
    assert.deepEqual(access.options([], BRANCHES), []);
  });

  test('empty branches: no options, never every branch (pass the company branches for a user without their own)', () => {
    const levels = [level(fallback('*'), row('$branches', FALLBACK, { branch: ['$branches'] }))];
    assert.deepEqual(access.options(levels, []), []);
    assert.deepEqual(access.options(levels, BRANCHES), [A, B, C, '$branches']);
    assert.deepEqual(access.resolve(levels, { branch: '$branches', branches: BRANCHES, all: true }), { '*': { branch: '*' } });
  });
});

// ===========================================================================
describe('resolve', () => {
  describe('the rows of the examples (branches A, B, C)', () => {
    test('A: its own fallback and items rule, $self -> A', () => {
      assert.deepEqual(access.resolve([level(...STORED)], { branch: A, branches: BRANCHES, all: false }), {
        '*': { branch: [A, C, null] },
        items: { id: ['i1'], branch: [A] },
      });
    });

    test('B: the "*" fallback, no items rule', () => {
      assert.deepEqual(access.resolve([level(...STORED)], { branch: B, branches: BRANCHES, all: false }), {
        '*': { branch: [B, null] },
      });
    });

    test('$branches: every branch of the user', () => {
      assert.deepEqual(access.resolve([level(...STORED)], { branch: '$branches', branches: BRANCHES, all: false }), {
        '*': { branch: [A, B, C, null] },
      });
    });

    test('$branches with all (user without branches of their own): everything', () => {
      assert.deepEqual(access.resolve([level(...STORED)], { branch: '$branches', branches: BRANCHES, all: true }), {
        '*': { branch: '*' },
      });
    });
  });

  describe('per entity: the nearest level with a row wins, X before "*" within a level', () => {
    // The example: the group restricts items in A, the user hides items everywhere.
    const group = level(row('*', FALLBACK, { branch: ['$self', null] }), row(A, ITEMS, { branch: ['$self', C] }));

    test('the user has ("*", items): the user is nearer, so items is {} even though the group names A', () => {
      const user = level(row('*', FALLBACK, { branch: ['$self'] }), row('*', ITEMS, {}));
      assert.deepEqual(access.resolve([user, group], { branch: A, branches: BRANCHES }), {
        '*': { branch: [A] },
        items: {},
      });
    });

    test("the user has no items row: items is the group's, the fallback stays the user's", () => {
      const user = level(row('*', FALLBACK, { branch: ['$self'] }));
      assert.deepEqual(access.resolve([user, group], { branch: A, branches: BRANCHES }), {
        '*': { branch: [A] },
        items: { branch: [A, C] },
      });
    });

    test("the user's '*' wins over the group's A, for the fallback and for an entity", () => {
      const user = level(row('*', FALLBACK, { branch: ['$self'] }), row('*', ITEMS, { id: ['u1'] }));
      const groupA = level(row(A, FALLBACK, { branch: [C] }), row(A, ITEMS, { id: ['g1'] }));
      assert.deepEqual(access.resolve([user, groupA], { branch: A, branches: BRANCHES }), {
        '*': { branch: [A] },
        items: { id: ['u1'] },
      });
    });

    test('within one level, X wins over "*", for the fallback and for an entity', () => {
      const only = level(
        row('*', FALLBACK, { branch: ['$self'] }), row(A, FALLBACK, { branch: [C] }),
        row('*', ITEMS, { id: ['any'] }), row(A, ITEMS, { id: ['inA'] })
      );
      assert.deepEqual(access.resolve([only], { branch: A, branches: BRANCHES }), { '*': { branch: [C] }, items: { id: ['inA'] } });
      assert.deepEqual(access.resolve([only], { branch: B, branches: BRANCHES }), { '*': { branch: [B] }, items: { id: ['any'] } });
    });

    test("a branch the user level doesn't cover falls to the group's '*'", () => {
      const user = level(row(B, FALLBACK, { branch: ['$self'] }));
      const groupAny = level(row('*', FALLBACK, { branch: [C] }));
      assert.deepEqual(access.resolve([user, groupAny], { branch: C, branches: BRANCHES }), { '*': { branch: [C] } });
    });

    test('$branches entity rows come only from $branches, never from "*"', () => {
      const only = level(row('$branches', FALLBACK, { branch: ['$branches'] }), row('*', ITEMS, { id: ['any'] }));
      assert.deepEqual(access.resolve([only], { branch: '$branches', branches: BRANCHES }), { '*': { branch: BRANCHES } });

      const withRow = level(row('$branches', FALLBACK, { branch: ['$branches'] }), row('*', ITEMS, { id: ['any'] }), row('$branches', ITEMS, { id: ['all'] }));
      assert.deepEqual(access.resolve([withRow], { branch: '$branches', branches: BRANCHES }), { '*': { branch: BRANCHES }, items: { id: ['all'] } });
    });

    test('$branches: false in a nearer level: not an option, resolve throws', () => {
      const levels = [level(row('$branches', FALLBACK, false)), level(row('$branches', FALLBACK, { branch: ['$branches'] }))];
      assert.ok(!access.options(levels, BRANCHES).includes('$branches'));
      assert.throws(() => access.resolve(levels, { branch: '$branches', branches: BRANCHES }), /not an option/);
    });

    test('$branches from the parent when the group has no $branches fallback', () => {
      const levels = [level(row('*', FALLBACK, { branch: ['$self'] })), level(row('$branches', FALLBACK, { branch: [B] }))];
      assert.deepEqual(access.resolve(levels, { branch: '$branches', branches: BRANCHES }), { '*': { branch: [B] } });
    });

    test('FULL as the last level still gives everything', () => {
      assert.deepEqual(access.resolve([FULL], { branch: A, branches: BRANCHES }), { '*': { branch: '*' } });
      assert.deepEqual(access.resolve([FULL], { branch: '$branches', branches: BRANCHES }), { '*': { branch: '*' } });

      const user = level(row('*', ITEMS, { id: ['i1'] })); // entity rows only: the fallback comes from FULL
      assert.deepEqual(access.resolve([user, FULL], { branch: A, branches: BRANCHES }), { '*': { branch: '*' }, items: { id: ['i1'] } });
    });
  });

  test('placeholders inside relations, with dedup ("*" and null kept)', () => {
    const levels = [level(
      row('*', FALLBACK, { branch: ['$self', '$self', A, null, null] }),
      row('*', ITEMS, { id: '*', owner: { branch: ['$self', '$branches'] } })
    )];

    assert.deepEqual(access.resolve(levels, { branch: A, branches: BRANCHES }), {
      '*': { branch: [A, null] },
      items: { id: '*', owner: { branch: [A, B, C] } },
    });
    assert.deepEqual(access.resolve(levels, { branch: B, branches: BRANCHES, all: true }), {
      '*': { branch: [B, A, null] },
      items: { id: '*', owner: { branch: '*' } },
    });
  });

  test('the levels are not modified', () => {
    const levels = [level(...STORED)];
    const copy = JSON.parse(JSON.stringify(levels));
    access.resolve(levels, { branch: A, branches: BRANCHES });
    assert.deepEqual(levels, copy);
  });

  test('a branch outside the options throws', () => {
    assert.throws(() => access.resolve([level(...STORED)], { branch: D, branches: BRANCHES }), new RegExp(`'${D}' is not an option`));
    assert.throws(() => access.resolve([level(row(A, FALLBACK, { branch: ['$self'] }))], { branch: B, branches: BRANCHES }), /not an option/);
  });
});
