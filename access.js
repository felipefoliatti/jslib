'use strict';

// access of users and groups: which rows a user sees, per selected branch. pure functions, no i/o:
//
//   validate(access, schema)                    before saving the access of a user or group
//   chain(levels)                               the levels of a user (user, group, parents), strongest first
//   options(chain, branches)                    the contexts the user can select
//   resolve(chain, { branch, branches, all })   the context of a request, placeholders replaced
//   checkSchema(schema)                         the schema check, shared with auth.js
//
// stored access:
//
//   {
//       "*":         { "*": { "branch": ["$self", null] } },       //any single branch without its own entry
//       "<branch>":  { "items": { "id": ["i1"] }, "*": { ... } },  //rules when working in that branch
//       "$branches": { "*": { "branch": ["$branches", null] } }    //the "all my branches" context, or false
//   }
//
// each context maps entities of the schema passed by the caller (or "*", the else block: only branch) to
// a rule: '*' (everything), {} (nothing) or an object whose keys are columns (a list) or relations (the
// rule of the related entity). every key adds visibility (OR). lists hold ids, null (rows where the column
// is null) and, only in branch columns, $self (the selected branch) and $branches (every selectable branch).
//
// schema (owned by the project; json keys never reach the sql, only the names declared here):
//
//   {
//       <entity>: {
//           enforced:  true | false,             //optional, default false: only enforced entities may have
//                                                //their own rule in a stored access (validate)
//           table:     '"schema"."table"',       //required, used in the EXISTS of relations (auth.js)
//           columns:   ['id', ...],              //required, non-empty: the columns a rule may use
//           branch:    'column',                 //optional, one of columns: the column of the else block
//           relations: { <fk column>: <entity> },//optional, each target an entity of the same schema
//           custom:    { <column>: alias => sql }//optional, a column of columns that is not a plain
//                                                //"alias.col IN (?)": sql with one ? for the list
//       }
//   }
//
// every table has deleted (0 = active). an invalid schema is a programming error: a plain Error.

const MAX_LIST = 200; //the resolved access travels in a header

//the implicit full level appended to the chain of admins
const FULL = { '*': { '*': { branch: '*' } }, '$branches': { '*': { branch: '*' } } };

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

const DEFINITION_KEYS = ['enforced', 'table', 'columns', 'branch', 'relations', 'custom'];
const checked = new WeakSet(); //schemas already checked: validate() doesn't check them again on every call

//throws a plain Error (a programming error) naming the entity and the property
function checkSchema(schema) {
    if (isObject(schema) && checked.has(schema)) return;
    if (!isObject(schema) || !Object.keys(schema).length) throw new Error('access schema: must be a non-empty object');

    const fail = (entity, property, message) => { throw new Error(`access schema: ${entity}.${property} ${message}`); };
    const isName = value => typeof value === 'string' && value.trim() !== '';

    for (const entity of Object.keys(schema)) {
        const definition = schema[entity];
        if (!isObject(definition)) throw new Error(`access schema: ${entity} must be an object`);

        for (const key of Object.keys(definition)) {
            if (!DEFINITION_KEYS.includes(key)) fail(entity, key, `is not a property (${DEFINITION_KEYS.join(', ')})`);
        }

        if (definition.enforced !== undefined && typeof definition.enforced !== 'boolean') fail(entity, 'enforced', 'must be a boolean');
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

//throws an AccessError on the first problem; null is a level without access
function validate(access, schema) {
    checkSchema(schema);
    if (access === null || access === undefined) return;
    if (!isObject(access)) throw new AccessError('', 'access must be an object');

    for (const key of Object.keys(access)) {
        if (key !== '*' && key !== '$branches' && !GUID.test(key)) {
            throw new AccessError(key, `'${key}' is not '*', '$branches' or a branch id`);
        }

        const context = access[key];
        if (context === false) {
            if (key !== '$branches') throw new AccessError(key, 'only $branches can be false');
            continue;
        }
        if (!isObject(context)) throw new AccessError(key, 'context must be an object');

        validateContext(context, key, key === '$branches', schema);
    }
}

function validateContext(context, path, inBranches, schema) {
    if (!has(context, '*')) throw new AccessError(join(path, '*'), 'the else block (*) is required');

    for (const key of Object.keys(context)) {
        if (key === '*') {
            validateElse(context['*'], join(path, '*'), inBranches);
        } else if (has(schema, key)) {
            if (!schema[key].enforced) throw new AccessError(join(path, key), `entity '${key}' not supported yet`);
            validateRule(key, context[key], join(path, key), inBranches, schema);
        } else {
            throw new AccessError(join(path, key), `unknown entity '${key}'`);
        }
    }
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
// chain, options, resolve
// ---------------------------------------------------------------------------

//levels from the strongest to the weakest (user, group, parent, grandparent, FULL); empty ones removed
function chain(levels) {
    return (levels || []).filter(level => level !== null && level !== undefined);
}

//the branch ids (of branches) some level covers, plus '$branches' when it can be selected
function options(levels, branches) {
    const out = branches.filter(id => levels.some(level => has(level, id) || has(level, '*')));

    //the first level that mentions $branches decides: an object allows it, false blocks the levels below
    const level = levels.find(item => has(item, '$branches'));
    const context = level && level['$branches'];
    if (isObject(context) && hasBranch(resolveValue(elseBranch(context), { branch: '$branches', branches, all: false }))) {
        out.push('$branches');
    }

    return out;
}

const elseBranch = context => (isObject(context['*']) ? context['*'].branch : undefined);
const hasBranch = value => value === '*' || (Array.isArray(value) && value.some(item => item !== null));

//the context of the selected branch with the placeholders replaced (only ids left)
function resolve(levels, { branch, branches, all = false }) {
    if (!options(levels, branches).includes(branch)) throw new Error(`access: '${branch}' is not an option`);

    let context;
    if (branch === '$branches') {
        context = levels.find(level => has(level, '$branches'))['$branches'];
    } else {
        //within each level the branch wins over '*'; the context is used whole (no merge between levels)
        const level = levels.find(item => has(item, branch) || has(item, '*'));
        context = has(level, branch) ? level[branch] : level['*'];
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

module.exports = { validate, chain, options, resolve, checkSchema, AccessError, MAX_LIST, FULL };
