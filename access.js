'use strict';

// access of users and groups: which rows a user sees, per selected branch. pure functions, no i/o:
//
//   validate(rows, schema)                      before saving a row ([row]) or linking rows to a user or group
//   level(rows, schema)                         the level of one user or group, from its rows
//   chain(levels)                               the levels of a user (user, group, parents, DEFAULT), strongest first
//   options(chain, branches, all)               the branches (and '$branches') the user can select
//   resolve(chain, { branch, branches, all })   the context of a request, placeholders replaced
//   checkSchema(schema)                         the schema check, shared with auth.js
//
// stored access: rows owned by the project, linked to users and groups (many per user or group, even
// several with the same key and type):
//
//   { key, type, filter }
//     key:    the selected branch the row applies to: a branch id, '*' (any branch without its own row)
//             or '$branches' (the "all my branches" option)
//     type:   1 = fallback (every entity without its own rule; filter is only { branch }),
//             >= 2 = the type of an enforced entity of the schema
//     filter: the rule: '*' (everything), {} (nothing), an object whose keys are columns (a list) or
//             relations (the rule of the related entity), or false (only key '$branches' with type 1:
//             blocks the option)
//
// every key of a rule adds visibility (OR). lists hold ids, null (rows where the column is null) and, only
// in branch columns, $self (the selected branch) and $branches (every selectable branch).
//
// level: the rows of one user or group, as { key: { entity | '*': rule } } ('*' = the fallback, type 1),
// rows with the same key and type merged with OR:
//
//   {
//       "*":         { "*": { "branch": ["$self", null] } },
//       "<branch>":  { "items": { "id": ["i1"] }, "*": { ... } },
//       "$branches": { "*": { "branch": ["$branches", null] }, "items": { ... } }
//   }
//
// a blocking row ($branches, type 1, false) is { "$branches": { "*": false, ... } }: the false is the
// fallback of $branches, so $branches entity rows can sit beside it and every context keeps the
// { entity: rule } shape. a whole context set to false ({ "$branches": false }) is not recognised.
//
// notes for the callers of validate() / level():
//   - rows read with the mysql driver bring JSON columns as strings: parse filter first. a string filter
//     fails validation ("rule must be '*', {} or an object", or "the else block must be an object")
//   - call validate() on the full set of rows of a user or group when a row is linked to them, so a merged
//     list longer than MAX_LIST is rejected before the link is saved, never at login (level() at login
//     runs the same checks)
//
// schema (owned by the project; json keys never reach the sql, only the names declared here):
//
//   {
//       <entity>: {
//           enforced:  true | false,             //optional, default false: only enforced entities may have
//                                                //rows of their own (validate)
//           type:      2,                        //the type of its rows: an integer >= 2, unique in the schema,
//                                                //required when enforced (1 is the fallback)
//           table:     '"schema"."table"',       //required, used in the EXISTS of relations (auth.js)
//           columns:   ['id', ...],              //required, non-empty: the columns a rule may use
//           branch:    'column',                 //optional, one of columns: the column of the fallback
//           relations: { <fk column>: <entity> },//optional, each target an entity of the same schema
//           custom:    { <column>: alias => sql }//optional, a column of columns that is not a plain
//                                                //"alias.col IN (?)": sql with one ? for the list
//       }
//   }
//
// every table has deleted (0 = active). an invalid schema is a programming error: a plain Error.

const MAX_LIST = 200; //the resolved access travels in a header

//the implicit last level of every chain: today's behavior (the selected branch; "Todas" = the user's branches,
//or every branch with all). rows without a branch (null) are not included, the same as the services' filter today.
//there is no full level: admin rights (.*) are about permissions, not about which rows are visible. a full level
//would widen what an admin limited to some branches sees (an admin of [A, B] who selects A would see every branch)
const DEFAULT = { '*': { '*': { branch: ['$self'] } }, '$branches': { '*': { branch: ['$branches'] } } };

const GUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const PLACEHOLDERS = ['$self', '$branches'];

class AccessError extends Error {
    constructor(path, message) {
        super(message);
        this.name = 'AccessError';
        this.path = path;
    }
}

const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const join = (path, key) => (path ? `${path}.${key}` : key);

// ---------------------------------------------------------------------------
// schema
// ---------------------------------------------------------------------------

const DEFINITION_KEYS = ['enforced', 'type', 'table', 'columns', 'branch', 'relations', 'custom'];
const FALLBACK = 1; //the type of the fallback rows: never declared in the schema
const checked = new WeakSet(); //schemas already checked: validate() doesn't check them again on every call

//throws a plain Error (a programming error) naming the entity and the property
function checkSchema(schema) {
    if (isObject(schema) && checked.has(schema)) return;
    if (!isObject(schema) || !Object.keys(schema).length) throw new Error('access schema: must be a non-empty object');

    const fail = (entity, property, message) => { throw new Error(`access schema: ${entity}.${property} ${message}`); };
    const isName = value => typeof value === 'string' && value.trim() !== '';
    const types = {}; //type -> entity, to find duplicates

    for (const entity of Object.keys(schema)) {
        const definition = schema[entity];
        if (!isObject(definition)) throw new Error(`access schema: ${entity} must be an object`);

        for (const key of Object.keys(definition)) {
            if (!DEFINITION_KEYS.includes(key)) fail(entity, key, `is not a property (${DEFINITION_KEYS.join(', ')})`);
        }

        if (definition.enforced !== undefined && typeof definition.enforced !== 'boolean') fail(entity, 'enforced', 'must be a boolean');
        if (definition.type !== undefined) {
            if (!Number.isInteger(definition.type) || definition.type <= FALLBACK) fail(entity, 'type', `must be an integer >= 2 (${FALLBACK} is the fallback)`);
            if (has(types, definition.type)) fail(entity, 'type', `${definition.type} is already the type of '${types[definition.type]}'`);
            types[definition.type] = entity;
        } else if (definition.enforced) {
            fail(entity, 'type', 'is required when enforced');
        }
        if (!isName(definition.table)) fail(entity, 'table', 'must be a non-empty string');
        if (!Array.isArray(definition.columns) || !definition.columns.length || !definition.columns.every(isName)) {
            fail(entity, 'columns', 'must be a non-empty list of non-empty strings');
        }
        if (definition.branch !== undefined && !definition.columns.includes(definition.branch)) {
            fail(entity, 'branch', `must be one of its columns, got '${definition.branch}'`);
        }

        if (definition.relations !== undefined) {
            if (!isObject(definition.relations)) fail(entity, 'relations', 'must be an object { <fk column>: <entity> }');
            for (const key of Object.keys(definition.relations)) {
                if (!has(schema, definition.relations[key])) fail(entity, `relations.${key}`, `points to unknown entity '${definition.relations[key]}'`);
            }
        }

        if (definition.custom !== undefined) {
            if (!isObject(definition.custom)) fail(entity, 'custom', 'must be an object { <column>: alias => sql }');
            for (const key of Object.keys(definition.custom)) {
                if (!definition.columns.includes(key)) fail(entity, `custom.${key}`, 'is not one of its columns');
                if (typeof definition.custom[key] !== 'function') fail(entity, `custom.${key}`, 'must be a function alias => sql');
            }
        }
    }

    checked.add(schema);
}

// ---------------------------------------------------------------------------
// validate
// ---------------------------------------------------------------------------

//the entity whose rows have this type (undefined when none)
const entityOfType = (schema, type) => Object.keys(schema).find(entity => schema[entity].type === type);

//the rows of one user or group ([row] to save a single row): undefined, or an AccessError on the first
//problem. a plain Error when the schema is invalid or missing. null, undefined and [] are valid
//   a row:          path inside the row (key, type, filter.id) and index, its position in rows
//   merged rows:    rows with the same key and type are merged with OR (see mergeRule); a list longer than
//                   MAX_LIST once merged: path inside the level (<key>.<entity>.<column>), no index
function validate(rows, schema) {
    if (checkRows(rows, schema)) merge(rows, schema);
}

//checks the schema and every row; false when there are no rows
function checkRows(rows, schema) {
    checkSchema(schema);
    if (rows === null || rows === undefined) return false;
    if (!Array.isArray(rows)) throw new AccessError('', 'rows must be a list of { key, type, filter }');

    rows.forEach((row, index) => {
        try {
            checkRow(row, schema);
        } catch (err) {
            if (err instanceof AccessError) err.index = index;
            throw err;
        }
    });
    return rows.length > 0;
}

//one row { key, type, filter }: AccessError with the path inside the row
function checkRow(row, schema) {
    if (!isObject(row)) throw new AccessError('', 'row must be an object { key, type, filter }');

    const { key, type, filter } = row;
    if (key !== '*' && key !== '$branches' && !GUID.test(key)) {
        throw new AccessError('key', `'${key}' is not '*', '$branches' or a branch id`);
    }
    const inBranches = key === '$branches'; //$self is not valid there

    if (type === FALLBACK) {
        if (filter === false) {
            if (!inBranches) throw new AccessError('filter', 'only the fallback of $branches can be false');
            return;
        }
        validateElse(filter, 'filter', inBranches);
        return;
    }

    //no coercion: type is a number (a TINYINT); the string '2' is an unknown type
    const entity = entityOfType(schema, type);
    if (!entity) throw new AccessError('type', `unknown type '${type}'`);
    if (!schema[entity].enforced) throw new AccessError('type', `entity '${entity}' not supported yet`);
    if (filter === false) throw new AccessError('filter', 'only the fallback (type 1) of $branches can be false');

    validateRule(entity, filter, 'filter', inBranches, schema);
}

//the else block only has branch: '*' or a list with at least one id or placeholder
function validateElse(block, path, inBranches) {
    if (!isObject(block)) throw new AccessError(path, 'the else block must be an object { branch }');

    for (const key of Object.keys(block)) {
        if (key !== 'branch') throw new AccessError(join(path, key), 'the else block only accepts branch');
    }
    if (!has(block, 'branch')) throw new AccessError(join(path, 'branch'), 'branch is required');

    const branch = block.branch;
    if (branch === '*') return;

    validateList(branch, join(path, 'branch'), true, inBranches);
    //[] or [null] would leave the services not migrated yet without any branch
    if (!branch.some(item => item !== null)) {
        throw new AccessError(join(path, 'branch'), 'branch needs at least one id or placeholder');
    }
}

function validateRule(entity, rule, path, inBranches, schema) {
    if (rule === '*') return;
    if (!isObject(rule)) throw new AccessError(path, "rule must be '*', {} or an object");

    const definition = schema[entity];
    for (const key of Object.keys(rule)) {
        if (definition.columns.includes(key)) {
            if (rule[key] !== '*') validateList(rule[key], join(path, key), key === definition.branch, inBranches);
        } else if (definition.relations && has(definition.relations, key)) {
            //related entities don't need to be enforced: the enforced entity's service evaluates the rule
            validateRule(definition.relations[key], rule[key], join(path, key), inBranches, schema);
        } else {
            throw new AccessError(join(path, key), `unknown column or relation of '${entity}'`);
        }
    }
}

function validateList(list, path, branchColumn, inBranches) {
    if (!Array.isArray(list)) throw new AccessError(path, "must be '*' or a list");
    if (list.length > MAX_LIST) throw new AccessError(path, `more than ${MAX_LIST} items`);

    for (const item of list) {
        if (item === null) continue;
        if (typeof item !== 'string') throw new AccessError(path, 'items must be strings or null');
        if (!item.startsWith('$')) continue;

        if (!PLACEHOLDERS.includes(item)) throw new AccessError(path, `unknown placeholder '${item}'`);
        if (item === '$self' && inBranches) throw new AccessError(path, '$self is not valid inside $branches');
        if (!branchColumn) throw new AccessError(path, 'placeholders are allowed only in branch columns');
    }
}

// ---------------------------------------------------------------------------
// level
// ---------------------------------------------------------------------------

//builds the level of one user or group from its rows.
//
//input:  the rows of that user or group: [{ key, type, filter }]
//output: { <key>: { <entity>: rule } }, or null when there are no rows
//  <key>     the branch the rows apply to: a branch id, '*' or '$branches'
//  <entity>  the entity of the row's type; '*' is the fallback (type 1)
//  rule      the filter of the row, with the placeholders ($self, $branches) not replaced yet
//
//rows with the same key and type become a single rule (merged with OR, see merge below).
//it runs the same checks as validate(): an invalid row throws an AccessError with path and index.
//it copies every filter: the rows passed in are never changed, so the caller can cache them.
//
//example:
//  rows:
//    { key: '*',         type: 1, filter: { branch: ['$self', null] } }
//    { key: A,           type: 2, filter: { branch: ['$self', C] } }
//    { key: A,           type: 2, filter: { id: ['i9'] } }
//    { key: '$branches', type: 1, filter: { branch: ['$branches'] } }
//  level:
//    {
//      '*':         { '*':   { branch: ['$self', null] } },
//      A:           { items: { branch: ['$self', C], id: ['i9'] } },
//      '$branches': { '*':   { branch: ['$branches'] } }
//    }
function level(rows, schema) {
    return checkRows(rows, schema) ? merge(rows, schema) : null;
}

//merges valid rows into a level (see below)
function merge(rows, schema) {
    const out = {};
    for (const row of rows) {
        const entity = row.type === FALLBACK ? '*' : entityOfType(schema, row.type);
        const context = out[row.key] || (out[row.key] = {});
        const path = join(row.key, entity);
        const filter = JSON.parse(JSON.stringify(row.filter)); //never share the caller's objects

        if (!has(context, entity)) context[entity] = filter;
        else if (entity === '*') context[entity] = mergeFallback(context[entity], filter, path);
        else context[entity] = mergeRule(entity, context[entity], filter, path, schema);
    }
    return out;
}

// rows with the same key and type are merged with OR (each row adds visibility):
//   fallback  false with anything is false: a blocking $branches row of the same level wins;
//             otherwise { branch: the OR of both lists }
//   rule      '*' with anything is '*'; two objects give the union of their keys, a key present in
//             both merged as a list (column) or as a rule (relation, recursively); {} adds nothing
//   list      '*' with anything is '*'; otherwise the union, without duplicates, in first-seen order.
//             longer than MAX_LIST: AccessError with the path inside the level, <key>.<entity>.<column>
//             (e.g. <branch>.items.id, *.*.branch), so the link of the row is rejected before it's saved
function mergeFallback(a, b, path) {
    if (a === false || b === false) return false;
    return { branch: mergeList(a.branch, b.branch, join(path, 'branch')) };
}

function mergeRule(entity, a, b, path, schema) {
    if (a === '*' || b === '*') return '*';

    const definition = schema[entity];
    const out = Object.assign({}, a);
    for (const key of Object.keys(b)) {
        if (!has(out, key)) out[key] = b[key];
        else if (definition.columns.includes(key)) out[key] = mergeList(out[key], b[key], join(path, key));
        else out[key] = mergeRule(definition.relations[key], out[key], b[key], join(path, key), schema);
    }
    return out;
}

function mergeList(a, b, path) {
    if (a === '*' || b === '*') return '*';

    const out = [];
    for (const item of a.concat(b)) if (!out.includes(item)) out.push(item);
    if (out.length > MAX_LIST) throw new AccessError(path, `more than ${MAX_LIST} items once the rows are merged`);
    return out;
}

// ---------------------------------------------------------------------------
// chain, options, resolve
// ---------------------------------------------------------------------------

//levels from the strongest to the weakest (user, group, parent, grandparent, DEFAULT); empty ones removed
function chain(levels) {
    return (levels || []).filter(level => level !== null && level !== undefined);
}

// resolution is per entity, the levels strongest first (user, group, parent, grandparent, DEFAULT).
// for the selected branch X:
//
//   fallback ('*' block) of X:  the first level that has (X, '*') or ('*', '*'); within that level X wins over '*'
//   rule of entity E of X:      the first level that has (X, E) or ('*', E); within that level X wins over '*';
//                               when no level has a row for E, E has no own rule (it uses the fallback)
//
//   $branches: the same, but only key '$branches' (never '*'):
//     fallback: the first level that has ($branches, '*'); false there blocks the levels below
//     entity E: the first level that has ($branches, E)
//
// e.g. group: ('*', '*') { branch: [$self, null] }, (A, items) { branch: [$self, C] }
//      user:  ('*', '*') { branch: [$self] },       ('*', items) {}
//   selected A: fallback = the user's ('*', '*') -> [A]; items = the user's ('*', items) -> {} (the user is
//   the nearest level, even though the group's row names A). without the user's items row, items would be
//   the group's { branch: [A, C] } while the fallback stays the user's [A].
const keysOf = branch => (branch === '$branches' ? ['$branches'] : [branch, '*']);

//{ found, value } of the first level with a row for entity under one of keys (in that order within a level)
function lookup(levels, keys, entity) {
    for (const item of levels) {
        for (const key of keys) {
            if (isObject(item[key]) && has(item[key], entity)) return { found: true, value: item[key][entity] };
        }
    }
    return { found: false };
}

//the branch ids (of branches) whose fallback resolves, plus '$branches' when it can be selected.
//all: true when the user has no branches of their own (pass the company's branches as branches):
//  with all, $branches means every branch ('*'), so it is an option even when branches is empty.
//  without all, an empty branches still means no options, never every branch.
//all only changes $branches: branch ids are still limited to branches, and a false $branches fallback in a
//nearer level still blocks the option
function options(levels, branches, all = false) {
    //entity rows alone don't make a branch selectable: it needs a fallback in some level
    const out = branches.filter(id => lookup(levels, keysOf(id), '*').found);

    //the first level with a $branches fallback decides: an object that resolves to some branch allows it,
    //false blocks the levels below
    const fallback = lookup(levels, keysOf('$branches'), '*');
    if (fallback.found && isObject(fallback.value) &&
        hasBranch(resolveValue(fallback.value.branch, { branch: '$branches', branches, all }))) {
        out.push('$branches');
    }

    return out;
}

const hasBranch = value => value === '*' || (Array.isArray(value) && value.some(item => item !== null));

//returns the access of one request: the rules of the selected branch, combining all the levels.
//
//input:
//  levels    the levels of the user, nearest first (user, group, parent, grandparent, DEFAULT)
//  branch    the selected branch, a branch id or '$branches': it must be one of options(levels, branches, all)
//  branches  the branches the user can select (the same list given to options)
//  all       true when the user has no branches of their own: $branches then means every branch ('*'),
//            so it can be selected even when branches is empty. without all, an empty branches has no options
//output: { '*': fallback, <entity>: rule, ... }
//  one rule per entity that has a row for this branch in some level; the fallback '*' covers the others.
//  the placeholders are replaced: $self is the selected branch, $branches is branches (or '*' with all).
//  this is the access of the internal jwt, read by auth.js.
//
//example, with levels [user, group] and branches [A, B, C]:
//  user rows:  { key: '*', type: 1, filter: { branch: ['$self'] } }
//  group rows: the rows of the example of level() above
//
//  branch A          ->  { '*': { branch: [A] }, items: { branch: [A, C], id: ['i9'] } }
//  branch B          ->  { '*': { branch: [B] } }
//  '$branches'       ->  { '*': { branch: [A, B, C] } }
//  '$branches', all  ->  { '*': { branch: '*' } }
//
//  in A, the fallback comes from the user, the nearest level; items comes from the group, because the user has no items row.
//  in B, no level has an items row, so items uses the fallback.
function resolve(levels, { branch, branches, all = false }) {
    if (!options(levels, branches, all).includes(branch)) throw new Error(`access: '${branch}' is not an option`);

    const keys = keysOf(branch);
    const context = { '*': lookup(levels, keys, '*').value };

    //every entity some level has a row for, under these keys, in first-seen order
    for (const item of levels) {
        for (const key of keys) {
            if (!isObject(item[key])) continue;
            for (const entity of Object.keys(item[key])) {
                if (entity !== '*' && !has(context, entity)) context[entity] = lookup(levels, keys, entity).value;
            }
        }
    }

    return resolveValue(context, { branch, branches, all });
}

//replaces $self / $branches recursively (relations too); lists are deduplicated
function resolveValue(value, { branch, branches, all }) {
    if (Array.isArray(value)) {
        if (all && value.includes('$branches')) return '*'; //user without branches of their own: everything

        const out = [];
        for (const item of value) {
            //$self never reaches the $branches context (validate), but it must not become '$branches'
            const items = item === '$self' ? (branch === '$branches' ? [] : [branch]) : item === '$branches' ? branches : [item];
            for (const id of items) if (!out.includes(id)) out.push(id);
        }
        return out;
    }

    if (isObject(value)) {
        const out = {};
        for (const key of Object.keys(value)) out[key] = resolveValue(value[key], { branch, branches, all });
        return out;
    }

    return value;
}

module.exports = { validate, level, chain, options, resolve, checkSchema, AccessError, MAX_LIST, DEFAULT };
