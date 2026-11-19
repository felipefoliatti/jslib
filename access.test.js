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
// an enforced entity with a branch column and a relation, the related entity (not enforced), an
// entity without a branch column and one with a custom column.
const SCHEMA = {
  items:   { enforced: true, table: '"store"."item"', columns: ['id', 'branch'], branch: 'branch', relations: { owner: 'owners' } },
  owners:  { table: '"store"."owner"', columns: ['id', 'branch'], branch: 'branch' },
  tags:    { table: '"store"."tag"', columns: ['id'] },
  members: { table: '"store"."member"', columns: ['id', 'branch'], branch: 'branch',
             custom: { branch: (alias) => `EXISTS (SELECT 1 FROM "store"."member_branch" mb WHERE mb.deleted=0 AND mb.member=${alias}.id AND mb.branch IN (?))` } },
};

// validate() checks branch ids, so its tests use real guids; options() / resolve() don't, so they use
// the A / B / C of the examples.
const A = 'aaaaaaaa-0000-0000-0000-000000000001';
const C = 'cccccccc-0000-0000-0000-000000000003';

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

/** validate() with the fixture schema. */
const validate = (value) => access.validate(value, SCHEMA);

// The stored access of the examples.
const STORED = {
  '*': {
    '*': { branch: ['$self', null] },
  },
  A: {
    items: { id: ['i1'], branch: ['$self'] },
    '*': { branch: ['$self', 'C', null] },
  },
  '$branches': {
    '*': { branch: ['$branches', null] },
  },
};

const BRANCHES = ['A', 'B', 'C'];

// ===========================================================================
describe('validate', () => {
  describe('valid', () => {
    test('null / undefined: a level without access', () => {
      assert.equal(validate(null), undefined);
      assert.equal(validate(undefined), undefined);
    });

    test('the stored access of the examples (with real branch ids)', () => {
      validate({
        '*': { '*': { branch: ['$self', null] } },
        [A]: {
          items: { id: ['i1'], branch: ['$self'] },
          '*': { branch: ['$self', C, null] },
        },
        '$branches': { '*': { branch: ['$branches', null] } },
      });
    });

    test("'*' rules, {} rules, '*' columns and $branches: false", () => {
      validate({
        '*': { '*': { branch: '*' }, items: '*' },
        [A]: { '*': { branch: [A] }, items: {} },
        [C]: { '*': { branch: [C] }, items: { id: '*' } },
        '$branches': false,
      });
    });

    test('placeholders in the branch column of a related entity (not enforced itself)', () => {
      validate({
        '*': {
          '*': { branch: ['$self'] },
          items: { owner: { branch: ['$self', '$branches', null], id: ['o1'] } },
        },
      });
    });

    test('$branches inside the $branches context', () => {
      validate({ '$branches': { '*': { branch: ['$branches'] }, items: { branch: ['$branches'] } } });
    });

    test(`a list of exactly MAX_LIST (${MAX_LIST}) items`, () => {
      const ids = Array.from({ length: MAX_LIST }, (_, i) => `i${i}`);
      validate({ '*': { '*': { branch: '*' }, items: { id: ids } } });
    });
  });

  describe('invalid (every case checks the path)', () => {
    test('the access is not an object', () => {
      assert.equal(rejected(() => validate([])).path, '');
      assert.equal(rejected(() => validate('*')).path, '');
    });

    test("a context key that is not '*', '$branches' or a branch id", () => {
      const err = rejected(() => validate({ A: { '*': { branch: '*' } } }));
      assert.equal(err.path, 'A');
      assert.equal(err.name, 'AccessError');
    });

    test('false is accepted only for $branches', () => {
      assert.equal(rejected(() => validate({ '*': false })).path, '*');
      assert.equal(rejected(() => validate({ [A]: false })).path, A);
    });

    test('a context that is not an object', () => {
      assert.equal(rejected(() => validate({ '*': [] })).path, '*');
      assert.equal(rejected(() => validate({ '$branches': true })).path, '$branches');
    });

    test('missing else block', () => {
      assert.equal(rejected(() => validate({ [A]: { items: '*' } })).path, `${A}.*`);
    });

    test('else block: not an object, extra keys, missing branch', () => {
      assert.equal(rejected(() => validate({ '*': { '*': '*' } })).path, '*.*');
      assert.equal(rejected(() => validate({ '*': { '*': { branch: '*', id: ['x'] } } })).path, '*.*.id');
      assert.equal(rejected(() => validate({ '*': { '*': {} } })).path, '*.*.branch');
    });

    test('else block: empty list, or only null', () => {
      assert.equal(rejected(() => validate({ '*': { '*': { branch: [] } } })).path, '*.*.branch');
      assert.equal(rejected(() => validate({ '*': { '*': { branch: [null] } } })).path, '*.*.branch');
    });

    test('an entity that is not enforced yet, or not in the schema', () => {
      const err = rejected(() => validate({ [A]: { '*': { branch: '*' }, owners: '*' } }));
      assert.equal(err.path, `${A}.owners`);
      assert.match(err.message, /not supported yet/);

      assert.equal(rejected(() => validate({ '*': { '*': { branch: '*' }, trucks: '*' } })).path, '*.trucks');
    });

    test('a rule that is not "*", {} or an object', () => {
      assert.equal(rejected(() => validate({ '*': { '*': { branch: '*' }, items: 5 } })).path, '*.items');
    });

    test('unknown column or relation, also inside a relation', () => {
      assert.equal(rejected(() => validate({ '*': { '*': { branch: '*' }, items: { color: ['red'] } } })).path, '*.items.color');
      assert.equal(rejected(() => validate({ '*': { '*': { branch: '*' }, items: { owner: { color: '*' } } } })).path, '*.items.owner.color');
    });

    test('a column value that is not a list or "*", items that are not strings or null', () => {
      assert.equal(rejected(() => validate({ '*': { '*': { branch: '*' }, items: { id: 'i1' } } })).path, '*.items.id');
      assert.equal(rejected(() => validate({ '*': { '*': { branch: '*' }, items: { id: [1] } } })).path, '*.items.id');
      assert.equal(rejected(() => validate({ '*': { '*': { branch: 'A' } } })).path, '*.*.branch');
    });

    test('unknown placeholder', () => {
      const err = rejected(() => validate({ '*': { '*': { branch: ['$all'] } } }));
      assert.equal(err.path, '*.*.branch');
      assert.match(err.message, /unknown placeholder '\$all'/);
    });

    test('a placeholder outside a branch column (id), also inside a relation', () => {
      assert.equal(rejected(() => validate({ '*': { '*': { branch: '*' }, items: { id: ['$self'] } } })).path, '*.items.id');
      assert.equal(rejected(() => validate({ '*': { '*': { branch: '*' }, items: { owner: { id: ['$branches'] } } } })).path, '*.items.owner.id');
    });

    test('$self inside the $branches context', () => {
      assert.equal(rejected(() => validate({ '$branches': { '*': { branch: ['$self'] } } })).path, '$branches.*.branch');
      assert.equal(rejected(() => validate({ '$branches': { '*': { branch: '*' }, items: { owner: { branch: ['$self'] } } } })).path, '$branches.items.owner.branch');
    });

    test(`a list longer than MAX_LIST (${MAX_LIST})`, () => {
      const ids = Array.from({ length: MAX_LIST + 1 }, (_, i) => `i${i}`);
      assert.equal(rejected(() => validate({ '*': { '*': { branch: '*' }, items: { id: ids } } })).path, '*.items.id');
    });
  });

  describe('the schema', () => {
    /** The plain Error validate() throws for this schema (not an AccessError: it is a programming error). */
    function invalid(schema) {
      try {
        access.validate(null, schema);
      } catch (err) {
        assert.ok(!(err instanceof AccessError), `expected a plain Error, got an AccessError: ${err.message}`);
        return err.message;
      }
      return assert.fail('expected the schema to be rejected');
    }

    const entity = (definition) => ({ things: { table: '"store"."thing"', columns: ['id', 'branch'], ...definition } });

    test('validate without a schema throws, even for a null access', () => {
      assert.match(invalid(undefined), /schema: must be a non-empty object/);
      assert.throws(() => access.validate({ '*': { '*': { branch: '*' } } }), /schema: must be a non-empty object/);
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

    test('a schema is checked once: later calls with the same object skip the check', () => {
      const schema = entity({});
      access.checkSchema(schema);
      schema.things.columns = []; // invalid now, but already checked
      assert.equal(access.validate(null, schema), undefined);

      assert.throws(() => access.checkSchema({ things: { ...schema.things } }), /things\.columns/); // another object: checked
    });
  });
});

// ===========================================================================
describe('chain', () => {
  test('removes null / undefined levels and keeps the order', () => {
    const user = { '*': { '*': { branch: ['$self'] } } };
    const parent = { '$branches': false };

    assert.deepEqual(access.chain([user, null, parent, undefined, FULL]), [user, parent, FULL]);
  });

  test('nothing configured: an empty chain', () => {
    assert.deepEqual(access.chain([null, undefined]), []);
    assert.deepEqual(access.chain(undefined), []);
  });

  test('FULL is the implicit full level for admins', () => {
    assert.deepEqual(FULL, { '*': { '*': { branch: '*' } }, '$branches': { '*': { branch: '*' } } });
    validate(FULL);
    assert.deepEqual(access.options(access.chain([null, FULL]), BRANCHES), ['A', 'B', 'C', '$branches']);
  });
});

// ===========================================================================
describe('options', () => {
  const ELSE = { '*': { branch: ['$self'] } };

  test('the stored access of the examples: every branch and $branches', () => {
    assert.deepEqual(access.options([STORED], BRANCHES), ['A', 'B', 'C', '$branches']);
  });

  test('branches covered by their id or "*" at different levels; the others are not options', () => {
    assert.deepEqual(access.options([{ A: ELSE }, { B: ELSE }], BRANCHES), ['A', 'B']);
    assert.deepEqual(access.options([{ A: ELSE }, { '*': ELSE }], BRANCHES), ['A', 'B', 'C']);
  });

  test('access keys never add branches the user cannot select', () => {
    assert.deepEqual(access.options([{ D: ELSE, A: ELSE }], BRANCHES), ['A']);
  });

  test('$branches absent: not an option', () => {
    assert.deepEqual(access.options([{ '*': ELSE }], BRANCHES), ['A', 'B', 'C']);
  });

  test('$branches: false at a higher level blocks the levels below', () => {
    const levels = [{ '$branches': false }, { '$branches': { '*': { branch: ['$branches'] } } }];
    assert.deepEqual(access.options(levels, BRANCHES), []);
  });

  test('$branches granted by a parent when the levels above do not mention it', () => {
    const levels = [{ A: ELSE }, { B: ELSE }, { '$branches': { '*': { branch: ['$branches'] } } }];
    assert.deepEqual(access.options(levels, BRANCHES), ['A', 'B', '$branches']);
  });

  test('$branches whose else block resolves to nothing is not an option', () => {
    assert.deepEqual(access.options([{ '$branches': { '*': { branch: [null] } } }], BRANCHES), []);
    assert.deepEqual(access.options([{ '$branches': { '*': { branch: ['$branches'] } } }], []), []);
    assert.deepEqual(access.options([{ '$branches': { '*': { branch: '*' } } }], []), ['$branches']);
  });

  test('empty chain: no options', () => {
    assert.deepEqual(access.options([], BRANCHES), []);
  });
});

// ===========================================================================
describe('resolve', () => {
  describe('the stored access of the examples (branches A, B, C)', () => {
    test('A: its own context, $self -> A', () => {
      assert.deepEqual(access.resolve([STORED], { branch: 'A', branches: BRANCHES, all: false }), {
        '*': { branch: ['A', 'C', null] },
        items: { id: ['i1'], branch: ['A'] },
      });
    });

    test('B: the "*" context', () => {
      assert.deepEqual(access.resolve([STORED], { branch: 'B', branches: BRANCHES, all: false }), {
        '*': { branch: ['B', null] },
      });
    });

    test('$branches: every branch of the user', () => {
      assert.deepEqual(access.resolve([STORED], { branch: '$branches', branches: BRANCHES, all: false }), {
        '*': { branch: ['A', 'B', 'C', null] },
      });
    });

    test('$branches with all (user without branches of their own): everything', () => {
      assert.deepEqual(access.resolve([STORED], { branch: '$branches', branches: BRANCHES, all: true }), {
        '*': { branch: '*' },
      });
    });
  });

  describe('the chain: the first level with the branch or "*" wins, used whole', () => {
    const U = { '*': { branch: ['U'] } };
    const G = { '*': { branch: ['G'] } };
    const G2 = { '*': { branch: ['G2'] } };
    const P = { '*': { branch: ['P'] } };

    test("the user's '*' wins over the group's A", () => {
      assert.deepEqual(access.resolve([{ '*': U }, { A: G }], { branch: 'A', branches: BRANCHES }), U);
    });

    test("a group's A wins over its own '*'", () => {
      assert.deepEqual(access.resolve([{ B: U }, { A: G, '*': G2 }], { branch: 'A', branches: BRANCHES }), G);
    });

    test("a branch the user level doesn't cover falls to the group's '*'", () => {
      assert.deepEqual(access.resolve([{ B: U }, { '*': G2 }], { branch: 'C', branches: BRANCHES }), G2);
    });

    test('$branches: false above: not an option, resolve throws', () => {
      const levels = [{ '$branches': false }, { '$branches': G }];
      assert.ok(!access.options(levels, BRANCHES).includes('$branches'));
      assert.throws(() => access.resolve(levels, { branch: '$branches', branches: BRANCHES }), /not an option/);
    });

    test('$branches from the parent when the group does not mention it', () => {
      const levels = [{ '*': G2 }, { '$branches': P }];
      assert.deepEqual(access.resolve(levels, { branch: '$branches', branches: BRANCHES }), P);
    });
  });

  test('placeholders inside relations, with dedup ("*" and null kept)', () => {
    const levels = [{
      '*': {
        '*': { branch: ['$self', '$self', 'A', null, null] },
        items: { id: '*', owner: { branch: ['$self', '$branches'] } },
      },
    }];

    assert.deepEqual(access.resolve(levels, { branch: 'A', branches: BRANCHES }), {
      '*': { branch: ['A', null] },
      items: { id: '*', owner: { branch: ['A', 'B', 'C'] } },
    });
    assert.deepEqual(access.resolve(levels, { branch: 'B', branches: BRANCHES, all: true }), {
      '*': { branch: ['B', 'A', null] },
      items: { id: '*', owner: { branch: '*' } },
    });
  });

  test('the stored chain is not modified', () => {
    const levels = [JSON.parse(JSON.stringify(STORED))];
    access.resolve(levels, { branch: 'A', branches: BRANCHES });
    assert.deepEqual(levels, [STORED]);
  });

  test('a branch outside the options throws', () => {
    assert.throws(() => access.resolve([STORED], { branch: 'D', branches: BRANCHES }), /'D' is not an option/);
    assert.throws(() => access.resolve([{ A: { '*': { branch: ['$self'] } } }], { branch: 'B', branches: BRANCHES }), /not an option/);
  });
});
