'use strict';

// Run with:  npm test   (Node >= 18: node --test | any Node: mocha)
const runner = typeof global.describe === 'function' && typeof global.it === 'function'
  ? { describe: global.describe, test: global.it }
  : require('node:test');
const { describe, test } = runner;

const assert = require('assert').strict;
const jsonwebtoken = require('jsonwebtoken');
const Auth = require('./auth');

// ---------------------------------------------------------------------------
// Fixtures and helpers
// ---------------------------------------------------------------------------

// The schema is owned by the project; these tests use a generic one:
//   items      enforced (type 2), branch column and a relation (owner)
//   owners     the related entity
//   tags       no branch column
//   members    a custom branch column (an EXISTS)
//   shipments  a branch column with another name (origin) and two relations, for deeper paths
const SCHEMA = {
  items:     { enforced: true, type: 2, table: '"store"."item"', columns: ['id', 'branch'], branch: 'branch', relations: { owner: 'owners' } },
  owners:    { table: '"store"."owner"', columns: ['id', 'branch'], branch: 'branch' },
  tags:      { table: '"store"."tag"', columns: ['id'] },
  members:   { table: '"store"."member"', columns: ['id', 'branch'], branch: 'branch',
               custom: { branch: (alias) => `EXISTS (SELECT 1 FROM "store"."member_branch" mb WHERE mb.deleted=0 AND mb.member=${alias}.id AND mb.branch IN (?))` } },
  shipments: { table: '"store"."shipment"', columns: ['id', 'origin', 'destination'], branch: 'origin', relations: { owner: 'owners', item: 'items' } },
};

const auth = Auth.schema(SCHEMA);

/** A fake express request carrying `claims` as a signed bearer token (no claims: no header). */
function req(claims) {
  if (claims === undefined) return { headers: {} };
  return { headers: { authorization: `Bearer ${jsonwebtoken.sign(claims, 'secret')}` } };
}

const internal = (access, branch = 'A') => req({ typ: 'internal', id: 'u1', company: 'c1', branch, access });
const small = () => req({ typ: 'access', id: 'u1' });
const old = (branches) => req({ id: 'u1', company: 'c1', ...(branches ? { branches: branches.map((id) => ({ id })) } : {}) });

const ALL = { sql: '1=1', values: [] };
const NONE = { sql: '1=0', values: [] };

// ===========================================================================
describe('Auth.schema: the methods of a service', () => {
  test('returns where, allows, allowsBranch, branch and filter', () => {
    assert.deepEqual(Object.keys(auth).sort(), ['allows', 'allowsBranch', 'branch', 'filter', 'where']);
    Object.values(auth).forEach((method) => assert.equal(typeof method, 'function'));
  });

  test('filter and branch stay static (no schema needed); where / allows / allowsBranch are not', () => {
    assert.deepEqual(Auth.filter(old(['A', 'B'])), ['A', 'B']);
    assert.equal(Auth.branch(old(['A'])), 'A');
    assert.equal(Auth.where, undefined);
    assert.equal(Auth.allows, undefined);
    assert.equal(Auth.allowsBranch, undefined);
  });

  test('two schemas bound at the same time do not interfere', () => {
    const other = Auth.schema({ boxes: { table: '"depot"."box"', columns: ['id', 'site'], branch: 'site' } });
    const request = internal({ '*': { branch: ['A'] } });

    assert.deepEqual(other.where(request, 'boxes', 'b'), { sql: '(b.site IN (?))', values: [['A']] });
    assert.deepEqual(auth.where(request, 'items', 'i'), { sql: '(i.branch IN (?))', values: [['A']] });
    assert.throws(() => other.where(request, 'items', 'i'), /unknown entity 'items'/);
    assert.throws(() => auth.where(request, 'boxes', 'b'), /unknown entity 'boxes'/);
  });

  describe('an invalid schema throws a plain Error at once (startup), naming the entity and the property', () => {
    const entity = (definition) => ({ things: { table: '"store"."thing"', columns: ['id', 'branch'], ...definition } });
    const cases = [
      ['not an object', undefined, /schema: must be a non-empty object/],
      ['empty', {}, /schema: must be a non-empty object/],
      ['a definition that is not an object', { things: [] }, /things must be an object/],
      ['table missing', entity({ table: undefined }), /things\.table must be a non-empty string/],
      ['columns empty', entity({ columns: [] }), /things\.columns must be a non-empty list/],
      ['a column that is not a non-empty string', entity({ columns: ['id', ''] }), /things\.columns must be a non-empty list/],
      ['branch not in columns', entity({ branch: 'site' }), /things\.branch must be one of its columns/],
      ['relations not an object', entity({ relations: 'owner' }), /things\.relations must be an object/],
      ['a relation to an unknown entity', entity({ relations: { owner: 'owners' } }), /things\.relations\.owner points to unknown entity 'owners'/],
      ['custom not an object', entity({ custom: [] }), /things\.custom must be an object/],
      ['custom on a column that does not exist', entity({ custom: { site: () => 'x' } }), /things\.custom\.site is not one of its columns/],
      ['custom that is not a function', entity({ custom: { branch: 'x' } }), /things\.custom\.branch must be a function/],
      ['enforced not a boolean', entity({ enforced: 1 }), /things\.enforced must be a boolean/],
      ['an unknown property (typo)', entity({ relation: {} }), /things\.relation is not a property/],
      ['type not an integer', entity({ type: '2' }), /things\.type must be an integer >= 2/],
      ['type less than 2 (1 is the fallback)', entity({ type: 1 }), /things\.type must be an integer >= 2/],
      ['type duplicated', { ...entity({ type: 2 }), others: { type: 2, table: '"store"."other"', columns: ['id'] } }, /others\.type 2 is already the type of 'things'/],
      ['type missing on an enforced entity', entity({ enforced: true }), /things\.type is required when enforced/],
    ];

    for (const [title, schema, message] of cases) {
      test(title, () => {
        assert.throws(() => Auth.schema(schema), (err) => err.constructor === Error && message.test(err.message));
      });
    }
  });
});

// ===========================================================================
describe('filter (copied unchanged from the services)', () => {
  test('branch ids of the token, null for every branch', () => {
    assert.equal(auth.filter(req()), null);
    assert.equal(auth.filter(old()), null);
    assert.deepEqual(auth.filter(old(['A', 'B'])), ['A', 'B']);
    assert.equal(auth.filter(old(['A', 'B']), true), 'A,B');
  });
});

// ===========================================================================
describe('where', () => {
  describe('the examples (entity items, alias i)', () => {
    const cases = [
      ['no header', req(), ALL],
      ['old token, branches [A]', old(['A']), { sql: '(i.branch IN (?))', values: [['A']] }],
      ['old token without branches', old(), ALL],
      ["small token (typ 'access')", small(), NONE],
      ["access { '*': { branch: '*' } }", internal({ '*': { branch: '*' } }), ALL],
      ["access { '*': { branch: ['A'] } }", internal({ '*': { branch: ['A'] } }), { sql: '(i.branch IN (?))', values: [['A']] }],
      ["access { '*': { branch: ['A', null] } }", internal({ '*': { branch: ['A', null] } }), { sql: '(i.branch IN (?) OR i.branch IS NULL)', values: [['A']] }],
      ["access { '*': { branch: [] } }", internal({ '*': { branch: [] } }), NONE],
      ['access {}', internal({}), NONE],
      ["access { '*': A, items: { id: ['i1'], branch: ['C'] } }", internal({ '*': { branch: ['A'] }, items: { id: ['i1'], branch: ['C'] } }), { sql: '(i.id IN (?) OR i.branch IN (?))', values: [['i1'], ['C']] }],
      ['relation without a join: EXISTS', internal({ items: { owner: { branch: ['B'] } } }), { sql: '(EXISTS (SELECT 1 FROM "store"."owner" a1 WHERE a1.id=i.owner AND a1.deleted=0 AND (a1.branch IN (?))))', values: [['B']] }],
      ["access { items: '*' }", internal({ items: '*' }), ALL],
      ['access { items: {} }', internal({ items: {} }), NONE],
    ];

    for (const [title, request, expected] of cases) {
      test(title, () => {
        assert.deepEqual(auth.where(request, 'items', 'i'), expected);
      });
    }

    test("relation with a join: { owner: 'o' }", () => {
      assert.deepEqual(auth.where(internal({ items: { owner: { branch: ['B'] } } }), 'items', 'i', { owner: 'o' }), { sql: '(o.branch IN (?))', values: [['B']] });
    });
  });

  test('[null] is IS NULL with no value; duplicated ids are sent once', () => {
    assert.deepEqual(auth.where(internal({ '*': { branch: [null] } }), 'items', 'i'), { sql: '(i.branch IS NULL)', values: [] });
    assert.deepEqual(auth.where(internal({ items: { id: ['i1', 'i1', 'i2'] } }), 'items', 'i'), { sql: '(i.id IN (?))', values: [['i1', 'i2']] });
  });

  test("a '*' column or relation is no restriction for the whole rule", () => {
    assert.deepEqual(auth.where(internal({ items: { id: ['i1'], branch: '*' } }), 'items', 'i'), ALL);
    assert.deepEqual(auth.where(internal({ items: { id: ['i1'], owner: '*' } }), 'items', 'i'), ALL);
  });

  test('access without the else block grants nothing (fail closed)', () => {
    assert.deepEqual(auth.where(internal({ shipments: '*' }), 'items', 'i'), NONE);
    assert.deepEqual(auth.where(internal({ shipments: '*' }), 'tags', 't'), NONE);
  });

  test('an unknown typ grants nothing', () => {
    assert.deepEqual(auth.where(req({ typ: 'refresh', branches: [{ id: 'A' }] }), 'items', 'i'), NONE);
  });

  describe('entities with another branch column', () => {
    test('tags (no branch column): the else block does not restrict it, its own rule does', () => {
      assert.deepEqual(auth.where(internal({ '*': { branch: ['A'] } }), 'tags', 't'), ALL);
      assert.deepEqual(auth.where(internal({ '*': { branch: ['A'] }, tags: { id: ['t1'] } }), 'tags', 't'), { sql: '(t.id IN (?))', values: [['t1']] });
      assert.deepEqual(auth.where(old(['A']), 'tags', 't'), ALL);
    });

    test('shipments: the else block goes to origin', () => {
      assert.deepEqual(auth.where(internal({ '*': { branch: ['A', null] } }), 'shipments', 's'), { sql: '(s.origin IN (?) OR s.origin IS NULL)', values: [['A']] });
      assert.deepEqual(auth.where(old(['A']), 'shipments', 's'), { sql: '(s.origin IN (?))', values: [['A']] });
    });

    test('members: the branch is the custom EXISTS (null in the list matches nothing)', () => {
      const exists = '(EXISTS (SELECT 1 FROM "store"."member_branch" mb WHERE mb.deleted=0 AND mb.member=m.id AND mb.branch IN (?)))';
      assert.deepEqual(auth.where(internal({ '*': { branch: ['A', null] } }), 'members', 'm'), { sql: exists, values: [['A']] });
      assert.deepEqual(auth.where(internal({ '*': { branch: [null] } }), 'members', 'm'), NONE);
      assert.deepEqual(auth.where(old(['A']), 'members', 'm'), { sql: exists, values: [['A']] });
    });
  });

  describe('deeper relations (shipments -> item -> owner)', () => {
    const request = internal({ shipments: { item: { owner: { branch: ['B'] } } } });

    test('no joins: nested EXISTS with an alias per depth', () => {
      assert.deepEqual(auth.where(request, 'shipments', 's'), {
        sql: '(EXISTS (SELECT 1 FROM "store"."item" a1 WHERE a1.id=s.item AND a1.deleted=0 AND ' +
             '(EXISTS (SELECT 1 FROM "store"."owner" a2 WHERE a2.id=a1.owner AND a2.deleted=0 AND (a2.branch IN (?))))))',
        values: [['B']],
      });
    });

    test("joins { item: 'x' }: the owner is an EXISTS on x", () => {
      assert.deepEqual(auth.where(request, 'shipments', 's', { item: 'x' }), {
        sql: '(EXISTS (SELECT 1 FROM "store"."owner" a1 WHERE a1.id=x.owner AND a1.deleted=0 AND (a1.branch IN (?))))',
        values: [['B']],
      });
    });

    test("joins { item: 'x', 'item.owner': 'o' }: straight on o", () => {
      assert.deepEqual(auth.where(request, 'shipments', 's', { item: 'x', 'item.owner': 'o' }), { sql: '(o.branch IN (?))', values: [['B']] });
    });

    test('siblings at the same depth each get their own EXISTS', () => {
      const both = internal({ shipments: { owner: { branch: ['A'] }, item: { branch: ['B'] } } });
      assert.deepEqual(auth.where(both, 'shipments', 's'), {
        sql: '(EXISTS (SELECT 1 FROM "store"."owner" a1 WHERE a1.id=s.owner AND a1.deleted=0 AND (a1.branch IN (?))) OR ' +
             'EXISTS (SELECT 1 FROM "store"."item" a1 WHERE a1.id=s.item AND a1.deleted=0 AND (a1.branch IN (?))))',
        values: [['A'], ['B']],
      });
    });
  });

  test('programming errors throw: unknown entity, column, relation, joins path', () => {
    assert.throws(() => auth.where(req(), 'trucks', 't'), /unknown entity 'trucks'/);
    assert.throws(() => auth.where(internal({ items: { color: ['red'] } }), 'items', 'i'), /'color' is not a column or relation of 'items'/);
    assert.throws(() => auth.where(internal({ items: { owner: { item: '*' } } }), 'items', 'i'), /'owner.item' is not a column or relation of 'owners'/);
    assert.throws(() => auth.where(req(), 'items', 'i', { trucks: 't' }), /'trucks' is not a column or relation of 'items'/);
    assert.throws(() => auth.where(req(), 'items', 'i', { 'owner.item': 'x' }), /'owner.item' is not a column or relation of 'owners'/);
  });
});

// ===========================================================================
describe('branch', () => {
  test('internal token: the selected branch, null for $branches', () => {
    assert.equal(auth.branch(internal({ '*': { branch: '*' } }, 'A')), 'A');
    assert.equal(auth.branch(internal({ '*': { branch: '*' } }, '$branches')), null);
  });

  test('small token and no header: null', () => {
    assert.equal(auth.branch(small()), null);
    assert.equal(auth.branch(req()), null);
  });

  test('old token: its only branch, else null', () => {
    assert.equal(auth.branch(old(['A'])), 'A');
    assert.equal(auth.branch(old(['A', 'B'])), null);
    assert.equal(auth.branch(old()), null);
  });
});

// ===========================================================================
describe('allows', () => {
  test('no header: true; small token: false', () => {
    assert.equal(auth.allows(req(), 'items', { id: 'i1', branch: 'Z' }), true);
    assert.equal(auth.allows(small(), 'items', { id: 'i1', branch: 'A' }), false);
  });

  test('internal token, else block: branch list and null', () => {
    const request = internal({ '*': { branch: ['A', null] } });
    assert.equal(auth.allows(request, 'items', { id: 'i1', branch: 'A' }), true);
    assert.equal(auth.allows(request, 'items', { id: 'i1', branch: null }), true);
    assert.equal(auth.allows(request, 'items', { id: 'i1', branch: 'B' }), false);
    assert.equal(auth.allows(internal({}), 'items', { id: 'i1', branch: 'A' }), false);
  });

  test('internal token, entity rule: every key adds visibility', () => {
    const request = internal({ '*': { branch: ['A'] }, items: { id: ['i1'], branch: ['C'] } });
    assert.equal(auth.allows(request, 'items', { id: 'i1', branch: 'B' }), true);
    assert.equal(auth.allows(request, 'items', { id: 'i2', branch: 'C' }), true);
    assert.equal(auth.allows(request, 'items', { id: 'i2', branch: 'A' }), false); //the entity rule replaces the else block
  });

  test('relations need the related record as an object; "*" and {} need nothing', () => {
    const request = internal({ items: { owner: { branch: ['B'] } } });
    assert.equal(auth.allows(request, 'items', { id: 'i1', branch: 'A', owner: { id: 'o1', branch: 'B' } }), true);
    assert.equal(auth.allows(request, 'items', { id: 'i1', branch: 'A', owner: { id: 'o1', branch: 'C' } }), false);
    assert.throws(() => auth.allows(request, 'items', { id: 'i1', branch: 'A', owner: 'o1' }), /'owner' is not a record in memory, use where/);

    assert.equal(auth.allows(internal({ items: { owner: '*' } }), 'items', { id: 'i1', owner: 'o1' }), true);
    assert.equal(auth.allows(internal({ items: { owner: {} } }), 'items', { id: 'i1', owner: 'o1' }), false);
  });

  test('custom columns throw (use where); a column missing from the record throws', () => {
    assert.throws(() => auth.allows(internal({ '*': { branch: ['A'] } }), 'members', { id: 'm1' }), /custom column, use where/);
    assert.throws(() => auth.allows(internal({ '*': { branch: ['A'] } }), 'items', { id: 'i1' }), /the record has no 'branch'/);
  });

  test('entity without a branch column: the else block does not restrict it', () => {
    assert.equal(auth.allows(internal({ '*': { branch: ['A'] } }), 'tags', { id: 't1' }), true);
  });

  test('old token: its branches on the branch column', () => {
    assert.equal(auth.allows(old(['A']), 'items', { id: 'i1', branch: 'A' }), true);
    assert.equal(auth.allows(old(['A']), 'items', { id: 'i1', branch: 'B' }), false);
    assert.equal(auth.allows(old(), 'items', { id: 'i1', branch: 'B' }), true);
  });
});

// ===========================================================================
describe('allowsBranch', () => {
  test('no header: true; small token: false, also for an entity without a branch column', () => {
    assert.equal(auth.allowsBranch(req(), 'items', 'A'), true);
    assert.equal(auth.allowsBranch(small(), 'items', 'A'), false);
    assert.equal(auth.allowsBranch(small(), 'tags', null), false);
  });

  test('internal token: the list of the branch column, null included', () => {
    const request = internal({ '*': { branch: ['A', null] } });
    assert.equal(auth.allowsBranch(request, 'items', 'A'), true);
    assert.equal(auth.allowsBranch(request, 'items', null), true);
    assert.equal(auth.allowsBranch(request, 'items', 'B'), false);
    assert.equal(auth.allowsBranch(internal({ '*': { branch: ['A'] } }), 'items', null), false);
  });

  test("internal token: '*' allows any branch; ids and relations are ignored", () => {
    assert.equal(auth.allowsBranch(internal({ '*': { branch: '*' } }), 'items', 'B'), true);
    assert.equal(auth.allowsBranch(internal({ items: '*' }), 'items', 'B'), true);
    assert.equal(auth.allowsBranch(internal({ items: { id: ['i1'], owner: { branch: ['B'] } } }), 'items', 'B'), false);
    assert.equal(auth.allowsBranch(internal({}), 'items', 'A'), false);
  });

  test('entity without a branch column: true', () => {
    assert.equal(auth.allowsBranch(internal({ '*': { branch: ['A'] } }), 'tags', null), true);
  });

  test('old token: filter(req) is null or includes the branch', () => {
    assert.equal(auth.allowsBranch(old(), 'items', 'B'), true);
    assert.equal(auth.allowsBranch(old(['A']), 'items', 'A'), true);
    assert.equal(auth.allowsBranch(old(['A']), 'items', 'B'), false);
  });
});
