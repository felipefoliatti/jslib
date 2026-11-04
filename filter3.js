'use strict';

/**
 * query-filter — declarative filters/sorting for APIs, safely injected into SQL.
 *
 * Understands inputs such as:
 *   ?product[in]=1,2,3&order[gt]=1&type[nin]=1,2&sort=qtd,-date
 * coming from req.query (nested `qs` style or flat "product[in]" keys), req.body (JSON)
 * or a raw query string.
 *
 * SECURITY: no user-supplied value is ever concatenated into the SQL text. Columns and
 * expressions come only from your declarations; values become placeholders ($1.. or ?).
 *
 * @example
 * const operators = require('./query-filter');
 *
 * const op = operators.for(req.query)
 *   .where.add('product', 'adr.id', ['in', 'nin', 'gt'],
 *              { type: 'int', required: true },                 // 4th: type / required
 *              { status: 422, code: 1022, message: 'filter product not supplied' }) // 5th: custom error
 *   .where.add('qtd', 'adr.qtd', ['eq', 'neq', 'gt'], { type: 'int' })
 *   .where.add('hasClient', () => 'exists (select 1 from clients.client cl where cl.address = adr.id)', ['eq'])
 *   .order.add('qtd',  'adr.qtd',        ['asc', 'desc'])
 *   .order.add('date', 'adr.created_at', ['asc', 'desc']);
 *
 * const rows  = await db.query(op.query('SELECT adr.id FROM clients.address adr WHERE adr.deleted = 0'), op.values);
 * const total = await db.query(op.count('SELECT count(1) FROM clients.address adr WHERE adr.deleted = 0'), op.values);
 * // or, for the "pg" driver: db.query(op.toQuery(sql))  ->  { text, values }
 *
 * Operators: eq, neq, gt, gte, lt, lte, in, nin, like (contains), nlike (does not contain),
 *            starts, ends, ilike / nilike (case-insensitive like / nlike; LIKE / NOT LIKE on
 *            the mysql dialect), btw (a,b), null (true|false).
 * Types (4th argument of where.add): string (default), int, number, bool, date, json (see below).
 *
 * Errors: every validation problem throws a FilterError carrying `status` and `code`
 * (defaults: 422 / 1052) so an error middleware can answer with them directly.
 * The defaults can be changed once, right after the import, and overridden at each level
 * (the most specific one wins):
 *
 *   operators.configure({ error: { status: 400, code: 2000, message: 'filter {name} not supplied' } }); // 1) process-wide
 *   operators.for(req.query, { error: { status: 409 } })                                               // 2) per operator
 *   .where.add('p', 'adr.id', ['in'], { required: true }, { code: 1022, message: 'p is mandatory' })   // 3) per filter
 *
 * `message` is only used for "not supplied" errors (required filters). It may be a string
 * ("{name}" is replaced by the filter name) or a function (name) => string.
 *
 * Lists and AND: a list is ALWAYS a comma separated string (`product[in]=1,2,3`).
 * Sending the same parameter more than once is an AND, for every operator:
 *
 *   ?product[in]=1,2,3                    ->  adr.id IN (1, 2, 3)
 *   ?product[in]=1,2&product[in]=2,3      ->  adr.id IN (1, 2) AND adr.id IN (2, 3)
 *   ?name[like]=ana&name[like]=silva      ->  adr.name LIKE '%ana%' AND adr.name LIKE '%silva%'
 *   ?qtd[btw]=1,10&qtd[btw]=5,20          ->  adr.qtd BETWEEN 1 AND 10 AND adr.qtd BETWEEN 5 AND 20
 *
 * Different operators / different filters are ANDed as well (there is no OR).
 * In a JSON body the same rule holds: a list is the string "1,2,3", and an ARRAY means "repeated"
 * (`{ in: ['1,2', '3'] }` is two ANDed conditions, `{ in: [1, 2, 3] }` is three).
 *
 * Default operator: a value sent WITHOUT an operator (`?product=1,2,3`, as opposed to
 * `?product[eq]=1`) uses the FIRST operator declared for the filter, unless the filter names
 * another one of its operators in `operator`. Explicit operators are never affected.
 *
 *   .where.add('product', 'adr.id', ['in', 'eq'])                     // ?product=1,2  ->  IN (1, 2)
 *   .where.add('name', 'adr.name', ['eq', 'neq', 'like'])             // ?name=Ana     ->  = 'Ana'
 *   .where.add('name', 'adr.name', ['eq', 'neq', 'like'], { operator: 'like' })  // -> LIKE '%Ana%'
 *
 * JSON columns: `type: 'json'` filters inside a json/jsonb column. Only the declared `paths` can be
 * filtered (a whitelist), each with its own type and operators; the path is never taken from the request.
 *
 *   .where.add('extra', 'adr.extra', {          // no operator list: each path has its own
 *     type: 'json',
 *     paths: {
 *       'load':           'int',                                   // short form: type only
 *       'address.street': { type: 'string', ops: ['ilike', 'eq'] },  // full form: type + operators
 *       'address.number': { type: 'int', required: true },
 *     },
 *   })
 *
 *   ?extra.load[gt]=5  ==  ?extra[load][gt]=5  ==  { extra: { load: { gt: 5 } } }
 *     pg     ->  (adr.extra->>'load')::bigint > $1
 *     mysql  ->  CAST(JSON_UNQUOTE(JSON_EXTRACT(adr.extra, '$.load')) AS SIGNED) > ?
 *   ?extra.address.street[ilike]=main   ->  adr.extra #>> '{address,street}' ILIKE $1
 *   ?extra.load[null]=true    ->  the key is missing OR holds a JSON null
 *   ?extra.load[exists]=true  ->  the key is present (even when it holds null)
 *   ?extra[null]=true         ->  the column itself IS NULL (the only operator allowed without a path)
 *
 * A path's operators are the ones it declares in `ops`, or else every operator that suits its type:
 *   all types         eq, neq, in, nin, null, exists
 *   string            + like, nlike, ilike, nilike, starts, ends
 *   int/number/date   + gt, gte, lt, lte, btw
 * A path's default operator is its own `operator`, else the filter's `operator`, else its first one
 * (`eq` when `ops` is not declared). `ilike` above is the default of 'address.street'.
 * Casts: int -> bigint/SIGNED, number -> numeric/DECIMAL, date -> timestamptz/DATETIME,
 * bool -> boolean (mysql compares 'true'/'false'). A stored value that does not fit the cast makes
 * the database reject the query, so declare the type the data really has.
 *
 * Subqueries: `exists` / `in` apply the filter's operators to a column INSIDE a subquery, e.g.
 * "volumes that have a tag like x". The column of where.add is the inner one (tg.code below).
 *
 *   // exists, full: you write the link to the outer row in `where`
 *   .where.add('tag', 'tg.code', ['like', 'nlike', 'in', 'nin'], {
 *     exists: { from: 'tag tg', where: 'tg.volume = v.id AND tg.deleted = 0' },
 *   })
 *   // exists, short: the whole subquery; the condition is added to its WHERE
 *   .where.add('tag', 'tg.code', ['like', 'nlike', 'in', 'nin'], {
 *     exists: 'SELECT 1 FROM tag tg WHERE tg.volume = v.id AND tg.deleted = 0',
 *   })
 *   //   ?tag=urgent         ->  EXISTS (SELECT 1 FROM tag tg WHERE (tg.volume = v.id AND tg.deleted = 0) AND (tg.code LIKE $1))
 *   //   ?tag[nlike]=urgent  ->  NOT EXISTS (… AND (tg.code LIKE $1))
 *
 *   // in, full: the lib compares `column` with what the subquery selects
 *   .where.add('tag', 'tg.code', ['like', 'nlike', 'in', 'nin'], {
 *     in: { column: 'v.id', select: 'tg.volume', from: 'tag tg', where: 'tg.deleted = 0' },
 *   })
 *   //   ?tag=urgent         ->  v.id IN (SELECT tg.volume FROM tag tg WHERE (tg.deleted = 0) AND (tg.code LIKE $1))
 *   //   ?tag[nlike]=urgent  ->  v.id NOT IN (SELECT … WHERE (tg.deleted = 0) AND (tg.volume IS NOT NULL) AND (tg.code LIKE $1))
 *
 *   // in, short: no `where`
 *   .where.add('tag', 'tg.code', ['like', 'nlike', 'in', 'nin'], {
 *     in: { column: 'v.id', select: 'tg.volume', from: 'tag tg' },
 *   })
 *   //   ?tag[nin]=a,b       ->  v.id NOT IN (SELECT tg.volume FROM tag tg WHERE (tg.volume IS NOT NULL) AND (tg.code IN ($1, $2)))
 *
 * Negated operators (neq, nin, nlike, nilike) run their positive form inside and negate the
 * subquery, so `tag[nlike]=x` means "has NO tag like x". `NOT IN` gets `select IS NOT NULL` so a
 * NULL returned by the subquery cannot empty the result. Rows whose outer column is NULL are kept
 * by NOT EXISTS but dropped by NOT IN. Repeated values are one subquery each, ANDed
 * (tag[in]=a&tag[in]=b: has a AND has b; tag[in]=a,b: has a OR b). `null` is not allowed.
 * The subquery SQL is the developer's; it must not contain placeholders of its own.
 *
 * Limits of the base SQL: GROUP BY / HAVING / ORDER BY / LIMIT / OFFSET are detected at the
 * top level (outside parentheses and strings) and WHERE / ORDER BY are inserted before them.
 * UNION is not supported.
 */

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

const DEFAULT_ERROR = Object.freeze({ status: 422, code: 1052 });
const DEFAULT_MESSAGE = 'filter {name} not supplied';

// Process-wide overrides set through configure(); empty means "use the built-in defaults".
let globalError = {};

// The default operator used to be configurable process-wide / per operator; it is now the
// filter's first operator (or its `operator` option). Old settings fail loudly instead of being ignored.
const DEFAULT_OPERATOR_REMOVED =
  "defaultOperator was removed: a value sent without an operator uses the filter's first operator " +
  "(or its `operator` option)";

/** Throws unless `op` is one of the built-in operators. */
function assertBuiltinOperator(op, where) {
  if (typeof op !== 'string' || !Object.prototype.hasOwnProperty.call(OPERATORS, op)) {
    throw new Error(`${where}: unknown operator '${op}'`);
  }
}

class FilterError extends Error {
  /**
   * @param {string} message
   * @param {string} [param]   name of the filter / sort parameter that caused the error
   * @param {{status?: number, code?: number|string}} [config]  overrides for status and code
   */
  constructor(message, param, config = {}) {
    super(message);
    this.name = 'FilterError';
    this.param = param;
    this.status = globalError.status !== undefined ? globalError.status : DEFAULT_ERROR.status;
    this.statusCode = this.status; // alias: some frameworks read `statusCode`
    this.code = globalError.code !== undefined ? globalError.code : DEFAULT_ERROR.code;
    this.apply(config);
  }

  /** Overrides status/code with whatever the declaration provided (message is left untouched). */
  apply(config = {}) {
    if (config.status !== undefined) {
      this.status = config.status;
      this.statusCode = config.status;
    }
    if (config.code !== undefined) this.code = config.code;
    return this;
  }
}

/** Replaces "{name}" in a string template, or calls the function template with the filter name. */
const resolveMessage = (template, name) =>
  typeof template === 'function' ? String(template(name)) : template.replace(/\{name\}/g, name);

/** Validates an `{ status, code, message }` object (where.add, order.add, for() options, configure()). */
function normalizeErrorConfig(config, where) {
  if (config === undefined || config === null) return {};
  if (!isPlainObject(config)) throw new Error(`${where}: error config must be an object { status, code, message }`);

  const { status, code, message } = config;
  if (status !== undefined && !(Number.isInteger(status) && status >= 100 && status <= 599)) {
    throw new Error(`${where}: error status must be an HTTP status code (100-599)`);
  }
  if (message !== undefined && typeof message !== 'string' && typeof message !== 'function') {
    throw new Error(`${where}: error message must be a string or a function`);
  }

  const out = {};
  if (status !== undefined) out.status = status;
  if (code !== undefined) out.code = code;
  if (message !== undefined) out.message = message;
  return out;
}

// ---------------------------------------------------------------------------
// Operators and types
// ---------------------------------------------------------------------------

/** Escapes LIKE wildcards so user input is matched literally (backslash is the default escape char). */
const escapeLike = (s) => s.replace(/[\\%_]/g, '\\$&');

/**
 * kind: how the value is parsed and rendered
 *   scalar  -> one comparison per value          (col = $1)
 *   list    -> comma separated / array           (col IN ($1, $2))
 *   pattern -> LIKE with a wrapped, escaped value
 *   pair    -> exactly two values                (col BETWEEN $1 AND $2)
 *   flag    -> boolean, renders IS [NOT] NULL
 */
const OPERATORS = {
  eq:       { kind: 'scalar', sql: '=' },
  neq:      { kind: 'scalar', sql: '<>' },
  gt:       { kind: 'scalar', sql: '>' },
  gte:      { kind: 'scalar', sql: '>=' },
  lt:       { kind: 'scalar', sql: '<' },
  lte:      { kind: 'scalar', sql: '<=' },
  in:       { kind: 'list',   sql: 'IN' },
  nin:      { kind: 'list',   sql: 'NOT IN' },
  like:     { kind: 'pattern', sql: 'LIKE',  wrap: (v) => `%${escapeLike(v)}%` },
  nlike:    { kind: 'pattern', sql: 'NOT LIKE',  wrap: (v) => `%${escapeLike(v)}%` },
  ilike:    { kind: 'pattern', sql: 'ILIKE', wrap: (v) => `%${escapeLike(v)}%` },
  nilike:   { kind: 'pattern', sql: 'NOT ILIKE', wrap: (v) => `%${escapeLike(v)}%` },
  starts:   { kind: 'pattern', sql: 'LIKE',  wrap: (v) => `${escapeLike(v)}%` },
  ends:     { kind: 'pattern', sql: 'LIKE',  wrap: (v) => `%${escapeLike(v)}` },
  btw:      { kind: 'pair' },
  null:     { kind: 'flag' },
};

const invalidValue = (param, value, type) =>
  new FilterError(`Invalid ${type} value for '${param}': ${JSON.stringify(value)}`, param);

/** Strict parsers: anything that does not look exactly like the type is rejected (never coerced loosely). */
const TYPES = {
  string: (v) => String(v),

  int: (v, param) => {
    const s = String(v).trim();
    if (!/^-?\d+$/.test(s) || !Number.isSafeInteger(Number(s))) throw invalidValue(param, v, 'int');
    return Number(s);
  },

  number: (v, param) => {
    const s = String(v).trim();
    // Regex instead of Number() alone: Number('0x10') === 16 and Number('') === 0 would slip through.
    if (!/^-?\d+(\.\d+)?$/.test(s)) throw invalidValue(param, v, 'number');
    return Number(s);
  },

  bool: (v, param) => {
    const s = String(v).trim().toLowerCase();
    if (s === 'true' || s === '1') return true;
    if (s === 'false' || s === '0') return false;
    throw invalidValue(param, v, 'bool');
  },

  date: (v, param) => {
    const s = String(v).trim();
    if (Number.isNaN(Date.parse(s))) throw invalidValue(param, v, 'date');
    return s; // keep the original text; the database does the final parsing
  },
};

// ---------------------------------------------------------------------------
// JSON columns
// ---------------------------------------------------------------------------

// Operators only json filters have. `exists` takes true|false: is the key present (even holding null)?
const JSON_ONLY_OPERATORS = ['exists'];
const isOperatorName = (key) =>
  Object.prototype.hasOwnProperty.call(OPERATORS, key) || JSON_ONLY_OPERATORS.includes(key);

// Operators that make sense for each type of value stored in a path.
const JSON_COMMON_OPS = ['eq', 'neq', 'in', 'nin', 'null', 'exists'];
const JSON_ORDERED_OPS = [...JSON_COMMON_OPS, 'gt', 'gte', 'lt', 'lte', 'btw'];
const JSON_TYPE_OPS = {
  string: [...JSON_COMMON_OPS, 'like', 'nlike', 'ilike', 'nilike', 'starts', 'ends'],
  int: JSON_ORDERED_OPS,
  number: JSON_ORDERED_OPS,
  date: JSON_ORDERED_OPS,
  bool: JSON_COMMON_OPS,
};

// The path is written into the SQL text, so every segment must be a plain identifier.
const JSON_SEGMENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

const JSON_CASTS = {
  pg: { int: 'bigint', number: 'numeric', bool: 'boolean', date: 'timestamptz' },
  mysql: { int: 'SIGNED', number: 'DECIMAL(65,30)', date: 'DATETIME' }, // bool: compared as 'true'/'false'
};

/**
 * Validates `paths` of a json filter and returns a Map path -> { name, segments, type, ops, operator, required }.
 * `filterOperator` is the filter's own `operator` option: the default of every path that does not set one.
 */
function normalizeJsonPaths(name, paths, filterOperator) {
  const where = `where.add('${name}')`;
  if (!isPlainObject(paths) || !Object.keys(paths).length) {
    throw new Error(`${where}: type 'json' needs a non-empty paths object`);
  }

  const out = new Map();
  for (const path of Object.keys(paths)) {
    const segments = path.split('.');
    if (!segments.every((s) => JSON_SEGMENT.test(s))) throw new Error(`${where}: invalid path '${path}'`);
    // A segment named like an operator would make "extra[in][eq]" ambiguous.
    const clash = segments.find(isOperatorName);
    if (clash) throw new Error(`${where}: path '${path}' cannot use the operator name '${clash}'`);

    const spec = typeof paths[path] === 'string' ? { type: paths[path] } : paths[path];
    if (!isPlainObject(spec)) throw new Error(`${where}: path '${path}' must be a type or { type, ops, operator, required }`);

    const type = spec.type || 'string';
    if (!Object.prototype.hasOwnProperty.call(JSON_TYPE_OPS, type)) throw new Error(`${where}: unknown type '${type}' for path '${path}'`);
    if (spec.required !== undefined && typeof spec.required !== 'boolean') {
      throw new Error(`${where}: required of path '${path}' must be a boolean`);
    }

    // Without `ops`, a path accepts every operator that suits its type.
    const ops = spec.ops === undefined ? JSON_TYPE_OPS[type] : spec.ops;
    if (!Array.isArray(ops) || !ops.length) throw new Error(`${where}: ops of path '${path}' must be a non-empty array`);
    for (const op of ops) {
      if (!isOperatorName(op)) throw new Error(`${where}: unknown operator '${op}' for path '${path}'`);
      if (!JSON_TYPE_OPS[type].includes(op)) {
        throw new Error(`${where}: operator '${op}' is not valid for path '${path}' (${type})`);
      }
    }

    // Default operator: the path's own, else the filter's, else the path's first one.
    const operator = [spec.operator, filterOperator, ops[0]].find((op) => op !== undefined);
    if (!ops.includes(operator)) {
      const owner = spec.operator !== undefined ? `operator '${operator}' of path '${path}'` : `operator '${operator}'`;
      throw new Error(`${where}: ${owner} must be one of the operators of path '${path}' [${ops.join(', ')}]`);
    }

    out.set(path, { name: `${name}.${path}`, segments, type, ops, operator, required: spec.required === true });
  }

  // "address" and "address.street" cannot both be leaves: a value is either an object or a scalar.
  for (const a of out.keys()) {
    for (const b of out.keys()) {
      if (b.startsWith(`${a}.`)) throw new Error(`${where}: path '${a}' cannot also be the parent of '${b}'`);
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Subqueries (exists / in)
// ---------------------------------------------------------------------------

// Negated operators run their positive form inside a subquery, and the subquery itself is negated.
const NEGATIONS = { neq: 'eq', nin: 'in', nlike: 'like', nilike: 'ilike' };

const SUBQUERY_KEYS = {
  exists: { required: ['from', 'where'], optional: [] },
  in: { required: ['column', 'select', 'from'], optional: ['where'] },
};

/**
 * Validates the `exists` / `in` option of where.add and returns
 *   { kind: 'exists', sql }                          (string shortcut: the whole subquery)
 *   { kind: 'exists', from, where }
 *   { kind: 'in', column, select, from, where }
 * or undefined when the filter has neither.
 */
function normalizeSubquery(name, opts) {
  const where = `where.add('${name}')`;
  if (opts.exists !== undefined && opts.in !== undefined) throw new Error(`${where}: use exists or in, not both`);

  const kind = opts.exists !== undefined ? 'exists' : opts.in !== undefined ? 'in' : undefined;
  if (!kind) return undefined;
  const config = opts[kind];

  if (kind === 'exists' && typeof config === 'string') {
    const sql = config.trim().replace(/[\s;]+$/, '');
    if (!sql) throw new Error(`${where}: exists must be a non-empty SQL string or { from, where }`);
    return { kind, sql };
  }

  const { required, optional } = SUBQUERY_KEYS[kind];
  if (!isPlainObject(config)) throw new Error(`${where}: ${kind} must be { ${required.concat(optional).join(', ')} }`);
  for (const key of Object.keys(config)) {
    if (!required.includes(key) && !optional.includes(key)) throw new Error(`${where}: unknown ${kind} option '${key}'`);
  }
  for (const key of required.concat(optional)) {
    const value = config[key];
    if (value === undefined && optional.includes(key)) continue;
    if (typeof value !== 'string' || !value.trim()) throw new Error(`${where}: ${kind}.${key} must be a non-empty string`);
  }
  return { kind, ...config };
}

// ---------------------------------------------------------------------------
// Input normalization
// ---------------------------------------------------------------------------

const BRACKET = /^([^\[\]]+)\[([^\[\]]+)\]$/; // "product[in]" -> ["product", "in"]
// "extra[address][street][eq]" -> name "extra.address.street", operator "eq" (json paths)
const NESTED = /^([^\[\]]+)((?:\[[^\[\]]+\]){2,})$/;

// Bucket key for a value sent without any operator ("?product=1,2"). It is an empty string on
// purpose: BRACKET needs at least one character between the brackets, so no request can produce
// it by writing "product[...]". It is resolved to a real operator later (see _conditions),
// because only then do we know which filter it belongs to.
const BARE = '';

const isPlainObject = (v) =>
  v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date);

const isEmpty = (v) =>
  v === null ||
  v === undefined ||
  (typeof v === 'string' && v.trim() === '') ||
  (Array.isArray(v) && v.length === 0);

/** Stores map[name][op] = value; repeated keys accumulate into an array. */
function put(map, name, op, value) {
  // Prototype-less objects: keys like "__proto__" or "constructor" are plain data, never special.
  const bucket = map[name] || (map[name] = Object.create(null));
  bucket[op] = op in bucket ? [].concat(bucket[op], value) : value;
}

/**
 * Converts every supported input shape into { name: { operator: value } }.
 *
 *   'product[in]=1,2'              -> { product: { in: '1,2' } }
 *   { 'product[in]': '1,2' }       -> { product: { in: '1,2' } }   (node's querystring.parse)
 *   { product: { in: '1,2' } }     -> { product: { in: '1,2' } }   (express / qs / JSON body)
 *   { product: 5 }                 -> { product: { [BARE]: 5 } }   (no operator: resolved later)
 *   'extra[a][b][eq]=1'            -> { 'extra.a.b': { eq: '1' } }  (json paths, see _compileJson)
 */
function normalize(input) {
  const map = Object.create(null);

  const add = (key, value) => {
    const match = BRACKET.exec(key);
    if (match) return put(map, match[1], match[2], value);

    const nested = NESTED.exec(key);
    if (nested) {
      const segments = nested[2].slice(1, -1).split('][');
      const op = segments.pop();
      return put(map, [nested[1], ...segments].join('.'), op, value);
    }

    if (isPlainObject(value)) {
      for (const op of Object.keys(value)) put(map, key, op, value[op]);
    } else {
      put(map, key, BARE, value);
    }
  };

  if (typeof input === 'string') {
    const params = new URLSearchParams(input);
    for (const key of new Set(params.keys())) {
      const all = params.getAll(key);
      add(key, all.length > 1 ? all : all[0]);
    }
  } else if (isPlainObject(input)) {
    for (const key of Object.keys(input)) add(key, input[key]);
  }

  return map;
}

/** Rejects nested objects (e.g. `qtd[eq][a]=1`) so they never reach String() / SQL parameters. */
function assertPrimitive(value, param) {
  for (const v of [].concat(value)) {
    if (v !== null && typeof v === 'object') throw new FilterError(`Invalid value for '${param}'`, param);
  }
}

// ---------------------------------------------------------------------------
// Base SQL inspection
// ---------------------------------------------------------------------------

/**
 * Returns the SQL with everything that must NOT be searched for keywords replaced by spaces:
 * string literals, quoted identifiers, comments and anything inside parentheses (subqueries,
 * function calls, window definitions). Positions are preserved, so an index found in the
 * masked text is valid in the original SQL.
 *
 *   SELECT (select 1 where x) , 'where' FROM t WHERE a=1   ->   only the last WHERE is visible
 */
function maskTopLevel(sql) {
  let out = '';
  let depth = 0;

  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    const next = sql[i + 1];

    if (c === "'" || c === '"') {
      // Quoted text: skip to the closing quote; a doubled quote ('' or "") is an escaped quote.
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === c) {
          if (sql[j + 1] === c) { j += 2; continue; }
          break;
        }
        j++;
      }
      const end = Math.min(j, sql.length - 1); // tolerate an unterminated literal
      out += ' '.repeat(end - i + 1);
      i = end;
    } else if (c === '-' && next === '-') {
      // Line comment: up to (not including) the newline.
      let j = sql.indexOf('\n', i);
      if (j < 0) j = sql.length;
      out += ' '.repeat(j - i);
      i = j - 1;
    } else if (c === '/' && next === '*') {
      // Block comment: up to and including "*/".
      let j = sql.indexOf('*/', i + 2);
      j = j < 0 ? sql.length : j + 2;
      out += ' '.repeat(j - i);
      i = j - 1;
    } else if (c === '(') {
      depth++;
      out += ' ';
    } else if (c === ')') {
      depth = Math.max(0, depth - 1);
      out += ' ';
    } else {
      out += depth === 0 ? c : (c === '\n' ? '\n' : ' ');
    }
  }

  return out;
}

const FOR_LOCK = 'for\\s+(?:update|share|no\\s+key\\s+update|key\\s+share)';
// First keyword that ends the WHERE area of a query ...
const WHERE_END_RE = new RegExp(`\\b(group\\s+by|having|window|order\\s+by|limit|offset|fetch|${FOR_LOCK})\\b`, 'i');
// ... and the first keyword that ends the ORDER BY area.
const ORDER_END_RE = new RegExp(`\\b(limit|offset|fetch|${FOR_LOCK})\\b`, 'i');

/** Adds `cond` with WHERE (none yet) or AND (WHERE already present), before GROUP BY/HAVING/ORDER BY/LIMIT… */
function injectWhere(sql, cond) {
  const top = maskTopLevel(sql);
  const stop = top.search(WHERE_END_RE);
  const cut = stop === -1 ? sql.length : stop; // insertion point
  const where = /\bwhere\b/i.exec(top.slice(0, cut));
  const tail = sql.slice(cut);

  let head;
  if (where) {
    // The base query already filters: wrap its conditions in parentheses so that an
    // "a = 1 OR b = 2" cannot swallow our AND (operator precedence!).
    const afterWhere = where.index + where[0].length;
    const existing = sql.slice(afterWhere, cut).trim();
    const newline = existing.includes('--') ? '\n' : ''; // keep a trailing line comment from eating ")"
    head = `${sql.slice(0, afterWhere)} (${existing}${newline}) AND (${cond})`;
  } else {
    head = `${sql.slice(0, cut).trimEnd()}\nWHERE ${cond}`;
  }

  return tail ? `${head}\n${tail}` : head;
}

/** Adds ORDER BY (or appends to an existing one) before LIMIT/OFFSET/FETCH/FOR UPDATE. */
function injectOrder(sql, order) {
  const top = maskTopLevel(sql);
  const stop = top.search(ORDER_END_RE);
  const cut = stop === -1 ? sql.length : stop;
  const hasOrder = /\border\s+by\b/i.test(top.slice(0, cut));
  const head = sql.slice(0, cut).trimEnd();
  const tail = sql.slice(cut);

  // Existing ORDER BY keeps priority; ours act as tie-breakers.
  const merged = hasOrder ? `${head}, ${order}` : `${head}\nORDER BY ${order}`;
  return tail ? `${merged}\n${tail}` : merged;
}

// ---------------------------------------------------------------------------
// Operator (the object returned by operators.for)
// ---------------------------------------------------------------------------

class Operator {
  /**
   * @param {object|string} input  req.query, req.body or a raw query string
   * @param {object} [options]
   * @param {'pg'|'mysql'} [options.dialect='pg']  pg => $1,$2…   mysql => ?
   * @param {string}  [options.sortKey='sort']     name of the sorting parameter
   * @param {boolean} [options.strict=false]       true => unknown filters / sort fields are errors
   * @param {number}  [options.maxListSize=500]    max items in in / nin / btw
   * @param {object}  [options.error]              { status, code, message } defaults for this operator
   */
  constructor(input, options = {}) {
    this.options = { dialect: 'pg', sortKey: 'sort', strict: false, maxListSize: 500, ...options };
    if (!['pg', 'mysql'].includes(this.options.dialect)) {
      throw new Error(`Unknown dialect '${this.options.dialect}'`);
    }

    if (options.defaultOperator !== undefined) throw new Error(`operators.for: ${DEFAULT_OPERATOR_REMOVED}`);

    // Per-operator error defaults; sit between the process-wide ones and each filter's own config.
    this.options.error = normalizeErrorConfig(options.error, 'operators.for');

    this._input = normalize(input);
    this._filters = []; // declared by where.add
    this._orders = [];  // declared by order.add
    this._base = [];    // parameters already used by the base SQL (see query())

    // Both return `this`, which is what makes  .where.add(...).where.add(...).order.add(...)  chainable.
    this.where = { add: (...args) => { this._addWhere(...args); return this; } };
    this.order = { add: (...args) => { this._addOrder(...args); return this; } };
  }

  // ----- declaration ------------------------------------------------------

  /**
   * where.add(name, column, operators, { type, required, operator }, { status, code, message })
   * where.add(name, operators, { type, required, operator }, { status, code, message })   // column = name
   * where.add(name, column, { type: 'json', paths, required, operator }, { status, code, message })
   *
   * A value sent without an operator (?name=…) uses the first of `operators`, or `operator`
   * when given (it must be one of this filter's `operators`).
   *
   * `column` may be a function (name, operator, value) => string | { sql, values } | falsy.
   *
   * A json filter takes no operator list: each path declares its own (see normalizeJsonPaths).
   *
   * `exists` / `in` (4th argument) apply the operators to `column` inside a subquery (see the header).
   */
  _addWhere(name, column, ops, opts, error) {
    // Short form: the second argument is the operator list, so every argument shifts by one.
    if (Array.isArray(column)) [column, ops, opts, error] = [name, column, ops, opts];
    // No operator list: the options come right after the column (or the name).
    else if (isPlainObject(column)) [column, ops, opts, error] = [name, undefined, column, ops];
    else if (isPlainObject(ops)) [ops, opts, error] = [undefined, ops, opts];

    if (typeof name !== 'string' || !name) throw new Error('where.add: name is required');
    if (this._filters.some((f) => f.name === name)) throw new Error(`where.add: '${name}' already declared`);
    if (typeof column !== 'string' && typeof column !== 'function') {
      throw new Error(`where.add('${name}'): column must be a string or a function`);
    }

    opts = opts || {};
    const type = opts.type || 'string';
    const json = type === 'json';
    if (!TYPES[type] && !json) throw new Error(`where.add('${name}'): unknown type '${type}'`);
    if (!json && opts.paths !== undefined) throw new Error(`where.add('${name}'): paths need type 'json'`);
    if (opts.required !== undefined && typeof opts.required !== 'boolean') {
      throw new Error(`where.add('${name}'): required must be a boolean`);
    }

    const subquery = normalizeSubquery(name, opts);
    if (subquery && (json || typeof column !== 'string')) {
      throw new Error(`where.add('${name}'): ${subquery.kind} needs a plain column (not a function nor type 'json')`);
    }

    if (json) {
      if (typeof column !== 'string') throw new Error(`where.add('${name}'): type 'json' needs a column, not a function`);
      if (ops !== undefined) {
        throw new Error(`where.add('${name}'): type 'json' takes no operator list; declare the operators of each path in paths`);
      }
      if (opts.operator !== undefined) assertBuiltinOperator(opts.operator, `where.add('${name}')`);
    } else {
      ops = ops === undefined ? ['eq'] : ops;
      if (!Array.isArray(ops) || !ops.length) throw new Error(`where.add('${name}'): operators must be a non-empty array`);
      // A custom function may define its own operator names; a plain column may only use built-ins.
      if (typeof column === 'string') {
        for (const op of ops) {
          if (!OPERATORS[op]) throw new Error(`where.add('${name}'): unknown operator '${op}'`);
        }
      }
      // "has a tag that is null" means nothing; "has no tags" is a filter of its own.
      if (subquery && ops.includes('null')) {
        throw new Error(`where.add('${name}'): operator 'null' cannot be used with ${subquery.kind}`);
      }

      if (opts.operator !== undefined) {
        if (typeof column === 'string') assertBuiltinOperator(opts.operator, `where.add('${name}')`);
        if (!ops.includes(opts.operator)) {
          throw new Error(`where.add('${name}'): operator '${opts.operator}' must be one of its operators [${ops.join(', ')}]`);
        }
      }
    }

    this._filters.push({
      name,
      column,
      ops,
      type,
      paths: json ? normalizeJsonPaths(name, opts.paths, opts.operator) : undefined,
      subquery,
      // Operator for a value sent without one (json filters resolve it per path).
      operator: json ? undefined : (opts.operator !== undefined ? opts.operator : ops[0]),
      required: opts.required === true,
      error: normalizeErrorConfig(error, `where.add('${name}')`),
    });
  }

  /**
   * order.add(name, column, directions, { status, code, message })
   * order.add(name, directions, { status, code, message })      // column = name
   * order.add(name)                                             // column = name, asc + desc
   */
  _addOrder(name, column, dirs, error) {
    if (Array.isArray(column) || column === undefined) [column, dirs, error] = [name, column, dirs];

    if (typeof name !== 'string' || !name) throw new Error('order.add: name is required');
    if (this._orders.some((o) => o.name === name)) throw new Error(`order.add: '${name}' already declared`);
    if (typeof column !== 'string' || !column) throw new Error(`order.add('${name}'): column must be a string`);

    dirs = (dirs || ['asc', 'desc']).map((d) => String(d).toLowerCase());
    if (!dirs.length || dirs.some((d) => d !== 'asc' && d !== 'desc')) {
      throw new Error(`order.add('${name}'): directions must be 'asc' and/or 'desc'`);
    }

    this._orders.push({ name, column, dirs, error: normalizeErrorConfig(error, `order.add('${name}')`) });
  }

  // ----- compilation ------------------------------------------------------

  /**
   * Stamps an error with status/code using the precedence:
   *   built-in < configure() < operators.for(…, { error }) < the filter's own config.
   * (configure() is already applied by the FilterError constructor.)
   */
  _scope(err, own = {}) {
    err.apply(this.options.error);
    err.apply(own);
    err._scoped = true; // marks "already resolved" so _render does not apply the operator-level config again
    return err;
  }

  /** Message for a "not supplied" error: filter config > operator config > configure() > built-in. */
  _notSuppliedMessage(def, name = def.name) {
    const template = [def.error.message, this.options.error.message, globalError.message, DEFAULT_MESSAGE]
      .find((m) => m !== undefined);
    return resolveMessage(template, name);
  }

  /** Collects parameter values and hands out placeholders ($n continues after the base SQL's own). */
  _ctx(offset) {
    const values = [];
    const mysql = this.options.dialect === 'mysql';
    return {
      values,
      param: (value) => {
        values.push(value);
        return mysql ? '?' : `$${offset + values.length}`;
      },
    };
  }

  /** One occurrence of a list parameter: "1,2,3" -> ['1', '2', '3'] (blank items dropped, size limited). */
  _list(value, def) {
    const items = []
      .concat(value)
      .flatMap((x) => (typeof x === 'string' ? x.split(',') : [x]))
      .map((x) => (typeof x === 'string' ? x.trim() : x))
      .filter((x) => !isEmpty(x));

    if (items.length > this.options.maxListSize) {
      throw new FilterError(`Too many values for '${def.name}' (max ${this.options.maxListSize})`, def.name);
    }
    return items;
  }

  /**
   * Condition for ONE occurrence of a parameter on a declared column (string).
   * Repeated occurrences are handled by the caller, which ANDs one condition per occurrence.
   * Returns an array of SQL fragments (empty when the occurrence has nothing to filter by).
   */
  _builtin(def, op, value, ctx) {
    const spec = OPERATORS[op];
    const col = def.column;
    const cast = def.cast || ((v) => TYPES[def.type](v, def.name));

    switch (spec.kind) {
      case 'scalar':
        return [`${col} ${spec.sql} ${ctx.param(cast(value))}`];

      case 'pattern': {
        // mysql has no ILIKE: its default collations already compare case-insensitively.
        const sqlOp = this.options.dialect === 'mysql' ? spec.sql.replace('ILIKE', 'LIKE') : spec.sql;
        return [`${col} ${sqlOp} ${ctx.param(spec.wrap(String(value)))}`];
      }

      case 'list': {
        const items = this._list(value, def).map(cast);
        if (!items.length) return []; // e.g. "in=,," -> nothing to filter by
        return [`${col} ${spec.sql} (${items.map((i) => ctx.param(i)).join(', ')})`];
      }

      case 'pair': {
        const items = this._list(value, def).map(cast);
        if (items.length !== 2) throw new FilterError(`'${def.name}[btw]' requires exactly 2 values`, def.name);
        return [`${col} BETWEEN ${ctx.param(items[0])} AND ${ctx.param(items[1])}`];
      }

      case 'flag':
        return [`${col} IS ${TYPES.bool(value, def.name) ? '' : 'NOT '}NULL`];

      default:
        return [];
    }
  }

  /** Conditions produced by a user supplied function. */
  _custom(def, op, value, ctx) {
    const result = def.column(def.name, op, value);
    if (!result) return []; // function decided the filter does not apply

    // Plain string: trusted SQL written by the developer, used verbatim.
    if (typeof result === 'string') return [result];

    // { sql, values }: every "?" becomes a real placeholder; "??" is an escaped literal "?"
    // (useful for the PostgreSQL jsonb operators).
    if (typeof result.sql === 'string') {
      const values = result.values || [];
      let used = 0;
      const sql = result.sql.replace(/\?\?|\?/g, (m) => (m === '??' ? '?' : ctx.param(values[used++])));
      if (used !== values.length) {
        throw new Error(`where '${def.name}': custom sql has ${used} placeholder(s) but ${values.length} value(s)`);
      }
      return [sql];
    }

    throw new TypeError(`where '${def.name}': custom function must return a string or { sql, values }`);
  }

  /**
   * Turns the { operator: value } sent for one parameter into SQL fragments.
   * `name` is used in error messages, `ops` are the allowed operators, `bareOp` takes a value
   * sent without an operator and `build(op, value)` renders one occurrence.
   */
  _conditions(name, sent, ops, bareOp, build) {
    // Work on a copy: the bare value is moved under its real operator, and the input must stay intact
    // (the `values` getter compiles again).
    const given = Object.assign(Object.create(null), sent);
    if (BARE in given) {
      const op = bareOp;
      const value = given[BARE];
      delete given[BARE];
      // "?product=1&product[in]=2": both end up under the same operator.
      given[op] = op in given ? [].concat(given[op], value) : value;
    }

    // 1) Reject operators the declaration does not allow (e.g. product[lt]=3).
    for (const op of Object.keys(given)) {
      if (!ops.includes(op)) {
        throw new FilterError(`Operator '${op}' is not allowed for filter '${name}'`, name);
      }
    }

    // 2) Build conditions in declaration order, so the output does not depend on the request's key order.
    const parts = [];
    for (const op of ops) {
      if (!(op in given) || isEmpty(given[op])) continue; // not supplied -> no condition
      assertPrimitive(given[op], name);

      // The same parameter sent more than once arrives as an array: every occurrence is its own
      // condition, and the conditions are ANDed. (A list is a comma separated string inside ONE
      // occurrence, e.g. product[in]=1,2,3, so it never gets here as an array.)
      const occurrences = [].concat(given[op]).filter((v) => !isEmpty(v));

      for (const occurrence of occurrences) parts.push(...build(op, occurrence));
    }
    return parts;
  }

  /**
   * Condition for ONE occurrence on a filter declared with `exists` / `in`: the operator is applied
   * to the column inside the subquery; a negated operator runs positive inside and negates the subquery.
   */
  _subquery(def, op, value, ctx) {
    const positive = NEGATIONS[op] || op;
    const negated = positive !== op;
    const [condition] = this._builtin(def, positive, value, ctx);
    if (!condition) return []; // e.g. "in=,," -> nothing to filter by

    const sub = def.subquery;
    const not = negated ? 'NOT ' : '';

    // String shortcut: the developer wrote the whole subquery; add the condition to its WHERE.
    if (sub.sql) return [`${not}EXISTS (${injectWhere(sub.sql, condition)})`];

    const wheres = [sub.where];
    // A NULL among the values NOT IN compares with makes it match nothing.
    if (sub.kind === 'in' && negated) wheres.push(`${sub.select} IS NOT NULL`);
    wheres.push(condition);
    const where = wheres.filter(Boolean).map((w) => `(${w})`).join(' AND ');

    return sub.kind === 'exists'
      ? [`${not}EXISTS (SELECT 1 FROM ${sub.from} WHERE ${where})`]
      : [`${sub.column} ${not}IN (SELECT ${sub.select} FROM ${sub.from} WHERE ${where})`];
  }

  /** Compiles one declared filter. Returns its SQL fragments (empty when nothing was supplied). */
  _compileFilter(def, ctx) {
    if (def.paths) return this._compileJson(def, ctx);

    const parts = this._conditions(def.name, this._input[def.name], def.ops, def.operator, (op, value) => {
      if (typeof def.column === 'function') return this._custom(def, op, value, ctx);
      if (def.subquery) return this._subquery(def, op, value, ctx);
      return this._builtin(def, op, value, ctx);
    });

    // "required" means: at least one condition must come out of this filter.
    if (def.required && !parts.length) {
      throw this._scope(new FilterError(this._notSuppliedMessage(def), def.name), def.error);
    }

    return parts;
  }

  /**
   * Gathers what was sent for a json filter as Map path -> { operator: value } ('' = the column).
   * The same request may arrive in several shapes:
   *   { extra: { address: { street: { eq: 'x' } } } }   (qs / JSON body)
   *   { 'extra.address.street': { eq: 'x' } }            (extra.address.street[eq]=x, extra[address][street][eq]=x)
   * Walking down, a key is an operator when it has an operator's name or the path so far is a
   * declared one (paths cannot use operator names); any other key is one more path segment.
   */
  _jsonInput(def) {
    const given = new Map();
    const add = (path, op, value) => {
      if (!given.has(path)) given.set(path, Object.create(null));
      const bucket = given.get(path);
      bucket[op] = op in bucket ? [].concat(bucket[op], value) : value; // repeated -> AND, as in put()
    };

    const walk = (path, bucket) => {
      for (const key of Object.keys(bucket)) {
        const value = bucket[key];
        if (key === BARE || isOperatorName(key) || def.paths.has(path)) {
          add(path, key, value);
        } else {
          const next = path ? `${path}.${key}` : key;
          if (isPlainObject(value)) walk(next, value);
          else add(next, BARE, value); // "?extra.load=5": a value without an operator
        }
      }
    };

    const prefix = `${def.name}.`;
    for (const key of Object.keys(this._input)) {
      if (key === def.name) walk('', this._input[key]);
      else if (key.startsWith(prefix)) walk(key.slice(prefix.length), this._input[key]);
    }
    return given;
  }

  /** Compiles a `type: 'json'` filter: one set of conditions per declared path, in declaration order. */
  _compileJson(def, ctx) {
    const given = this._jsonInput(def);

    // The paths come from the declaration only: anything else in the request is rejected.
    for (const path of given.keys()) {
      if (path && !def.paths.has(path)) {
        throw new FilterError(`Path '${path}' is not allowed for filter '${def.name}'`, def.name);
      }
    }

    // Without a path, only "is the column itself null?" makes sense.
    const root = given.get('') || {};
    for (const op of Object.keys(root)) {
      if (op !== 'null' && !isEmpty(root[op])) {
        const example = `${def.name}.${def.paths.keys().next().value}[eq]=…`;
        throw new FilterError(`Filter '${def.name}' needs a path (e.g. ${example})`, def.name);
      }
    }
    const parts = 'null' in root
      ? this._conditions(def.name, { null: root.null }, ['null'], 'null',
        (op, value) => this._builtin(def, op, value, ctx))
      : [];

    for (const [path, spec] of def.paths) {
      const own = this._conditions(spec.name, given.get(path), spec.ops, spec.operator,
        (op, value) => this._jsonCondition(def, spec, op, value, ctx));

      if (spec.required && !own.length) {
        throw new FilterError(this._notSuppliedMessage(def, spec.name), spec.name);
      }
      parts.push(...own);
    }

    if (def.required && !parts.length) {
      throw this._scope(new FilterError(this._notSuppliedMessage(def), def.name), def.error);
    }
    return parts;
  }

  /** Condition for ONE occurrence of an operator on a json path. Paths were validated at declaration. */
  _jsonCondition(def, spec, op, value, ctx) {
    const col = def.column;
    const { segments, type } = spec;

    if (this.options.dialect === 'mysql') {
      const extract = `JSON_EXTRACT(${col}, '$.${segments.join('.')}')`;
      const text = `JSON_UNQUOTE(${extract})`;
      if (op === 'exists') {
        return [`JSON_CONTAINS_PATH(${col}, 'one', '$.${segments.join('.')}') IS ${TYPES.bool(value, spec.name) ? '' : 'NOT '}TRUE`];
      }
      if (op === 'null') {
        // JSON_EXTRACT gives SQL NULL for a missing key and a JSON null (JSON_TYPE 'NULL') for a null one.
        return [`COALESCE(JSON_TYPE(${extract}), 'NULL') ${TYPES.bool(value, spec.name) ? '=' : '<>'} 'NULL'`];
      }
      const cast = JSON_CASTS.mysql[type];
      const column = cast ? `CAST(${text} AS ${cast})` : text;
      // A JSON boolean unquotes to the text 'true' / 'false'.
      const toValue = type === 'bool' ? (v) => String(TYPES.bool(v, spec.name)) : undefined;
      return this._builtin({ name: spec.name, column, type, cast: toValue }, op, value, ctx);
    }

    // pg: works for json and jsonb. #>> / ->> give text (SQL NULL for a missing key or a JSON null);
    // #> / -> give the json value itself (a JSON null is not SQL NULL), which is what `exists` needs.
    const single = segments.length === 1;
    const text = single ? `${col}->>'${segments[0]}'` : `${col} #>> '{${segments.join(',')}}'`;
    if (op === 'exists') {
      const node = single ? `${col}->'${segments[0]}'` : `${col} #> '{${segments.join(',')}}'`;
      return [`${node} IS ${TYPES.bool(value, spec.name) ? 'NOT ' : ''}NULL`];
    }
    if (op === 'null') return [`${text} IS ${TYPES.bool(value, spec.name) ? '' : 'NOT '}NULL`];

    const cast = JSON_CASTS.pg[type];
    const column = cast ? `(${text})::${cast}` : text;
    return this._builtin({ name: spec.name, column, type }, op, value, ctx);
  }

  _compileWhere(ctx) {
    if (this.options.strict) {
      for (const key of Object.keys(this._input)) {
        const known = key === this.options.sortKey ||
          this._filters.some((f) => f.name === key || (f.paths && key.startsWith(`${f.name}.`)));
        if (!known) throw new FilterError(`Unknown filter '${key}'`, key);
      }
    }

    const out = [];
    for (const def of this._filters) {
      try {
        out.push(...this._compileFilter(def, ctx));
      } catch (err) {
        // Any validation error of this filter carries the status/code declared for it.
        if (err instanceof FilterError) this._scope(err, def.error);
        throw err;
      }
    }

    // Parenthesize each fragment: a custom SQL containing OR must not leak into its neighbours.
    return out.map((c) => `(${c})`);
  }

  /** Parses `sort=qtd,-date` (or an array / { field: 'asc' } object) into ["adr.qtd ASC", ...]. */
  _compileOrder() {
    const sortKey = this.options.sortKey;
    const bucket = this._input[sortKey];
    if (!bucket) return [];

    // Step 1: collect [field, direction] pairs from whichever shape was used.
    const requested = [];
    for (const key of Object.keys(bucket)) {
      assertPrimitive(bucket[key], sortKey);

      if (key === BARE) {
        // "sort=qtd,-date": a leading "-" means DESC, a leading "+" (or nothing) means ASC.
        for (const item of this._list(bucket[BARE], { name: sortKey })) {
          const text = String(item);
          requested.push([text.replace(/^[+-]/, '').trim(), text.startsWith('-') ? 'desc' : 'asc']);
        }
      } else {
        // "sort[qtd]=desc"  or  { sort: { qtd: 'desc' } }
        const dir = String(bucket[key]).trim().toLowerCase();
        if (dir !== 'asc' && dir !== 'desc') throw new FilterError(`Invalid sort direction for '${key}'`, sortKey);
        requested.push([key, dir]);
      }
    }

    // Step 2: keep only declared fields/directions. Columns come from the declaration, never from the user.
    const seen = new Set();
    const out = [];
    for (const [name, dir] of requested) {
      const def = this._orders.find((o) => o.name === name);

      if (!def) {
        if (this.options.strict) throw new FilterError(`Unknown sort field '${name}'`, sortKey);
        continue; // lenient mode: silently ignore
      }
      if (!def.dirs.includes(dir)) {
        throw this._scope(new FilterError(`Sort direction '${dir}' is not allowed for '${name}'`, sortKey), def.error);
      }
      if (seen.has(name)) continue; // the first occurrence wins

      seen.add(name);
      out.push(`${def.column} ${dir.toUpperCase()}`);
    }
    return out;
  }

  _render(sql, baseValues, withOrder) {
    try {
      return this._build(sql, baseValues, withOrder);
    } catch (err) {
      // Errors raised outside a filter/order declaration (unknown field in strict mode, bad sort
      // direction format, nested objects…) still honour the operator-level defaults.
      if (err instanceof FilterError && !err._scoped) this._scope(err);
      throw err;
    }
  }

  _build(sql, baseValues, withOrder) {
    if (typeof sql !== 'string' || !sql.trim()) throw new TypeError('sql must be a non-empty string');

    const ctx = this._ctx(baseValues.length);
    const conditions = this._compileWhere(ctx);
    const order = this._compileOrder(); // always validated, even when it is not applied (count)

    let text = sql.replace(/[\s;]+$/, ''); // drop trailing whitespace / semicolons
    if (conditions.length) text = injectWhere(text, conditions.join(' AND '));
    if (withOrder && order.length) text = injectOrder(text, order.join(', '));

    return { text, values: [...baseValues, ...ctx.values] };
  }

  // ----- public API -------------------------------------------------------

  /**
   * SQL with filters + ORDER BY.
   * Extra arguments are the values the base SQL already uses ($1, $2…); numbering continues after them.
   */
  query(sql, ...baseValues) {
    const { text } = this._render(sql, baseValues, true);
    this._base = baseValues;
    return text;
  }

  /** Same filters, no ORDER BY (for count queries). */
  count(sql, ...baseValues) {
    const { text } = this._render(sql, baseValues, false);
    this._base = baseValues;
    return text;
  }

  /** Values in placeholder order: [...baseValues, ...filterValues]. Read it after query()/count(). */
  get values() {
    const ctx = this._ctx(this._base.length);
    this._compileWhere(ctx);
    return [...this._base, ...ctx.values];
  }

  /** { text, values } ready for the "pg" driver (stateless alternative to query() + values). */
  toQuery(sql, ...baseValues) { return this._render(sql, baseValues, true); }
  toCount(sql, ...baseValues) { return this._render(sql, baseValues, false); }
}

/**
 * Changes the process-wide error defaults. Call it once, right after require().
 * Pass `{ error: null }` to go back to the built-in defaults (422 / 1052).
 *
 *   operators.configure({ error: { status: 400, code: 2000, message: 'filter {name} not supplied' } });
 */
function configure({ error, defaultOperator } = {}) {
  if (defaultOperator !== undefined) throw new Error(`configure: ${DEFAULT_OPERATOR_REMOVED}`);
  const normalizedError = error === undefined || error === null ? error : normalizeErrorConfig(error, 'configure');

  if (error === null) globalError = {};
  else if (error !== undefined) globalError = { ...globalError, ...normalizedError };

  return module.exports;
}

module.exports = {
  for: (input, options) => new Operator(input, options),
  configure,
  Operator,
  FilterError,
  DEFAULT_ERROR,
  OPERATORS: Object.keys(OPERATORS),
};