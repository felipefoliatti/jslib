'use strict';
const jwt = require('jsonwebtoken');
const { checkSchema } = require('./access');

// what the token of a request may see (see access.js for the stored access, its resolution and the
// format of the schema). the project owns the schema and binds it once per service:
//
//   const auth = require('jslib/auth').schema(require('./access.schema'));
//
//   auth.where(req, entity, alias, joins)     { sql, values } to AND in a query: rows the token sees
//   auth.allows(req, entity, record)          whether the token sees a record already in memory
//   auth.allowsBranch(req, entity, branch)    whether the token may create a record in a branch
//   auth.branch(req)                          branch for creates (null = none selected)
//   auth.filter(req)                          branch ids of an old token (null = every branch)
//
// filter and branch don't need a schema: require('jslib/auth').filter(req) / .branch(req) work as well.
//
// tokens, told apart by typ:
//   no authorization header   internal call: no restriction
//   typ 'internal'            built by the gateway of the project: uses its resolved access
//   typ 'access'              small client token, replaced before reaching a service: grants nothing (fail closed)
//   no typ                    old full token (COMPATIBILITY): its branches, like filter
//
// rule of an entity (internal token): access[entity] when present, else access['*'].branch on the
// entity's branch column (entities without one: no restriction); access without '*': nothing.
//   '*' everything (null rows included) | ['A', null] col IN (?) OR col IS NULL | [] or {} nothing

const ALL = { sql: '1=1', values: [] };
const NONE = { sql: '1=0', values: [] };

const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const join = (path, key) => (path ? `${path}.${key}` : key);

class Auth {
    constructor(){}

    static filter(req, join){
        let auth = req.headers['authorization'] || '';
        let token = auth.replace('Bearer ', '');

        let otoken = jwt.decode(token) || {};

        //return the branches allowed to use the data
        let branches = [];

        //check profiles allowed for the resource usage.
        if (!auth)
        {
            branches = null; //allow everything - ignore the branches field
        }
        else
        {
            if (!otoken.branches || otoken.branches.length == 0){
                branches = null; //allow everything - ignore the branches field
            }
            else {
                branches = otoken.branches.map(e => e.id);
            }
        }

        //if join is true, return a string with the users joined by comma
        if (branches && join)
        {
            branches = branches.join(',');
        }

        return branches;
    }

    //binds a schema (checked now: an invalid one fails at startup) and returns the methods of a service
    static schema(schema){
        checkSchema(schema);

        return {
            where: (req, entity, alias, joins = {}) => where(schema, req, entity, alias, joins),
            allows: (req, entity, record) => allows(schema, req, entity, record),
            allowsBranch: (req, entity, branch) => allowsBranch(schema, req, entity, branch),
            branch: req => Auth.branch(req),
            filter: (req, join) => Auth.filter(req, join)
        };
    }

    //branch for creates: the selected branch, null when none ('$branches', small token, no header)
    static branch(req){
        const token = decode(req);

        switch (token.kind) {
            case 'internal':
                return typeof token.claims.branch === 'string' && !token.claims.branch.startsWith('$') ? token.claims.branch : null;
            case 'legacy': {
                // COMPATIBILITY: old full token (no typ): its only branch. remove when the old token is gone.
                const branches = Auth.filter(req);
                return branches && branches.length == 1 ? branches[0] : null;
                // COMPATIBILITY
            }
            default:
                return null;
        }
    }
}

// ---------------------------------------------------------------------------
// bound by Auth.schema
// ---------------------------------------------------------------------------

//{ sql, values } with the rows of entity (table alias) the token sees; joins: relation path -> alias of
//a join already in the query ({ owner: 'o', 'item.owner': 'x' }), the others become an EXISTS
function where(schema, req, entity, alias, joins) {
    const definition = entityOf(schema, entity);
    checkJoins(schema, entity, joins);

    const rule = ruleOf(req, entity, definition);
    if (rule === '*') return ALL;

    const condition = compile(schema, entity, rule, alias, joins, '', 0);
    if (condition === '*') return ALL;
    if (!condition) return NONE;
    return { sql: `(${condition.sql})`, values: condition.values };
}

//same rules as where, on a record in memory with the columns of the schema (relations: nested objects)
function allows(schema, req, entity, record) {
    const definition = entityOf(schema, entity);

    const rule = ruleOf(req, entity, definition);
    return evaluate(schema, entity, rule, record, '');
}

//whether a new record of entity can be created in branch (ids and relations are ignored)
function allowsBranch(schema, req, entity, branch) {
    const definition = entityOf(schema, entity);
    if (decode(req).kind === 'denied') return false; //small token: nothing, not even entities without a branch column
    if (!definition.branch) return true;

    const rule = ruleOf(req, entity, definition);
    if (rule === '*') return true;
    if (!isObject(rule)) return false;

    const list = rule[definition.branch];
    if (list === '*') return true;
    return Array.isArray(list) && list.includes(branch === undefined ? null : branch);
}

// ---------------------------------------------------------------------------
// token
// ---------------------------------------------------------------------------

//decodes the authorization header once (no req.auth: some endpoints don't use the jwt middleware)
function decode(req) {
    const header = (req.headers && req.headers['authorization']) || '';
    if (!header) return { kind: 'none' };

    const claims = jwt.decode(header.replace('Bearer ', '')) || {};
    switch (claims.typ) {
        case 'internal':
            return { kind: 'internal', claims };
        case undefined:
            return { kind: 'legacy', claims };
        default:
            return { kind: 'denied', claims }; //'access' (small client token) or anything unknown: fail closed
    }
}

//the rule of entity for the token of req: '*', {} or an object of columns / relations
function ruleOf(req, entity, definition) {
    const token = decode(req);

    switch (token.kind) {
        case 'none':
            return '*';
        case 'internal': {
            const access = token.claims.access;
            if (!isObject(access)) return {};
            if (has(access, entity)) return access[entity];

            //the else block: only the branch column; access without it grants nothing
            if (!isObject(access['*'])) return {};
            if (!definition.branch) return '*';
            return has(access['*'], 'branch') ? { [definition.branch]: access['*'].branch } : {};
        }
        case 'legacy': {
            // COMPATIBILITY: old full token (no typ): its branches on the entity's branch column, like
            // filter. remove when the old token is gone.
            const branches = Auth.filter(req);
            if (!branches || !definition.branch) return '*';
            return { [definition.branch]: branches };
            // COMPATIBILITY
        }
        default:
            return {};
    }
}

// ---------------------------------------------------------------------------
// schema checks (programming errors)
// ---------------------------------------------------------------------------

function entityOf(schema, entity) {
    if (!has(schema, entity)) throw new Error(`auth: unknown entity '${entity}'`);
    return schema[entity];
}

function relationOf(schema, entity, key, path) {
    const definition = schema[entity];
    if (!definition.relations || !has(definition.relations, key)) {
        throw new Error(`auth: '${join(path, key)}' is not a column or relation of '${entity}'`);
    }
    return definition.relations[key];
}

//every joins key must be a relation path of entity ('owner', 'item.owner')
function checkJoins(schema, entity, joins) {
    for (const path of Object.keys(joins)) {
        let current = entity;
        let walked = '';
        for (const key of path.split('.')) {
            current = relationOf(schema, current, key, walked);
            walked = join(walked, key);
        }
    }
}

// ---------------------------------------------------------------------------
// sql (where)
// ---------------------------------------------------------------------------

//the OR of the keys of rule: '*' (no restriction), null (nothing) or { sql, values }
function compile(schema, entity, rule, alias, joins, path, depth) {
    if (rule === '*') return '*';
    if (!isObject(rule)) return null;

    const definition = schema[entity];
    const parts = [];
    const values = [];

    for (const key of Object.keys(rule)) {
        const value = rule[key];
        let part;

        if (definition.columns.includes(key)) {
            if (value === '*') return '*';
            part = Array.isArray(value) ? column(definition, key, value, alias) : null;
        } else {
            const related = relationOf(schema, entity, key, path);
            const relation = join(path, key);

            if (has(joins, relation)) {
                part = compile(schema, related, value, joins[relation], joins, relation, depth);
            } else {
                //a generated alias per depth: siblings live in separate EXISTS, so they can share it
                const inner = `a${depth + 1}`;
                const condition = compile(schema, related, value, inner, joins, relation, depth + 1);
                part = condition && condition !== '*'
                    ? { sql: `EXISTS (SELECT 1 FROM ${schema[related].table} ${inner} WHERE ${inner}.id=${alias}.${key} AND ${inner}.deleted=0 AND (${condition.sql}))`, values: condition.values }
                    : condition;
            }
        }

        if (part === '*') return '*';
        if (part) {
            parts.push(part.sql);
            values.push(...part.values);
        }
    }

    return parts.length ? { sql: parts.join(' OR '), values } : null;
}

//a list on a column: ids go as one array per IN (?) (the mysql driver expands it), null as IS NULL
function column(definition, key, list, alias) {
    const ids = list.filter((item, index) => item !== null && list.indexOf(item) === index);
    const custom = definition.custom && definition.custom[key];

    if (custom) return ids.length ? { sql: custom(alias), values: [ids] } : null; //null matches nothing

    const parts = [];
    if (ids.length) parts.push(`${alias}.${key} IN (?)`);
    if (list.includes(null)) parts.push(`${alias}.${key} IS NULL`);
    return parts.length ? { sql: parts.join(' OR '), values: ids.length ? [ids] : [] } : null;
}

// ---------------------------------------------------------------------------
// js (allows)
// ---------------------------------------------------------------------------

function evaluate(schema, entity, rule, record, path) {
    if (rule === '*') return true;
    if (!isObject(rule)) return false;

    const definition = schema[entity];
    for (const key of Object.keys(rule)) {
        const value = rule[key];

        if (definition.columns.includes(key)) {
            if (definition.custom && definition.custom[key]) throw new Error(`auth.allows: '${join(path, key)}' is a custom column, use where`);
            if (value === '*') return true;
            if (!Array.isArray(value)) continue;
            if (!has(record, key)) throw new Error(`auth.allows: the record has no '${join(path, key)}'`);
            if (value.includes(record[key] === undefined ? null : record[key])) return true;
        } else {
            const related = relationOf(schema, entity, key, path);
            if (value === '*') return true;
            if (isObject(value) && !Object.keys(value).length) continue; //{} grants nothing

            if (!isObject(record[key])) throw new Error(`auth.allows: '${join(path, key)}' is not a record in memory, use where`);
            if (evaluate(schema, related, value, record[key], join(path, key))) return true;
        }
    }

    return false;
}

module.exports = Auth
