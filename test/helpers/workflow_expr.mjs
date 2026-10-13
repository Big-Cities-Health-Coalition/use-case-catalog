/**
 * A small evaluator for the GitHub Actions expressions the workflow tests
 * reason about: a job's `if:` against an event, rather than a regex over its
 * text. It covers the subset this repository's `if:`s use —
 * `&&`, `||`, `!`, `==`, `!=`, parentheses, string/number/boolean/null
 * literals, property paths with `.*` filters, and contains(), startsWith(),
 * endsWith(), join(), fromJSON(), and the status functions — with GitHub's
 * semantics where they differ from JavaScript's: string comparison and
 * contains()/startsWith() ignore case, a missing property is null, and an
 * empty string is falsy. Anything outside that subset throws, so a test can
 * never pass on an expression this file does not understand.
 */

const STATUS = { success: true, always: true, cancelled: false, failure: false };

function tokenize(source) {
  const tokens = [];
  let at = 0;
  while (at < source.length) {
    const rest = source.slice(at);
    const space = rest.match(/^\s+/);
    if (space) {
      at += space[0].length;
      continue;
    }
    const op = rest.match(/^(&&|\|\||==|!=|[!().,*[\]])/);
    if (op) {
      tokens.push({ kind: 'op', value: op[1] });
      at += op[1].length;
      continue;
    }
    if (rest[0] === "'") {
      let end = 1;
      let text = '';
      for (;;) {
        if (end >= rest.length) throw new Error(`unterminated string in: ${source}`);
        if (rest[end] === "'") {
          if (rest[end + 1] === "'") {
            text += "'";
            end += 2;
            continue;
          }
          break;
        }
        text += rest[end];
        end += 1;
      }
      tokens.push({ kind: 'string', value: text });
      at += end + 1;
      continue;
    }
    const number = rest.match(/^-?\d+(\.\d+)?/);
    if (number) {
      tokens.push({ kind: 'number', value: Number(number[0]) });
      at += number[0].length;
      continue;
    }
    const ident = rest.match(/^[A-Za-z_][A-Za-z0-9_-]*/);
    if (ident) {
      tokens.push({ kind: 'ident', value: ident[0] });
      at += ident[0].length;
      continue;
    }
    throw new Error(`cannot read "${rest.slice(0, 20)}" in: ${source}`);
  }
  return tokens;
}

const truthy = (value) =>
  !(
    value === null ||
    value === undefined ||
    value === false ||
    value === '' ||
    value === 0 ||
    Number.isNaN(value)
  );

function loose(value) {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string') return value.trim() === '' ? 0 : Number(value);
  return typeof value === 'number' ? value : NaN;
}

function equal(left, right) {
  if (typeof left === 'string' && typeof right === 'string')
    return left.toLowerCase() === right.toLowerCase();
  if (typeof left === typeof right && typeof left !== 'object') return left === right;
  if (left === null && right === null) return true;
  if (typeof left === 'object' || typeof right === 'object') return left === right;
  return loose(left) === loose(right);
}

const text = (value) => (value === null || value === undefined ? '' : String(value));

const FUNCTIONS = {
  contains(search, item) {
    if (Array.isArray(search)) return search.some((value) => equal(value, item));
    return text(search).toLowerCase().includes(text(item).toLowerCase());
  },
  startsWith: (value, prefix) => text(value).toLowerCase().startsWith(text(prefix).toLowerCase()),
  endsWith: (value, suffix) => text(value).toLowerCase().endsWith(text(suffix).toLowerCase()),
  join: (values, separator = ',') =>
    Array.isArray(values) ? values.map(text).join(separator) : text(values),
  fromJSON: (value) => JSON.parse(text(value)),
};

/**
 * Evaluate one expression (with or without the `${{ }}` wrapper).
 * @param {string} source
 * @param {object} context `{ github, vars, needs, ... }`; the status
 *   functions answer as for a run where nothing failed or was cancelled
 * @returns {unknown}
 */
export function evaluate(source, context) {
  const body = String(source)
    .trim()
    .replace(/^\$\{\{([\s\S]*)\}\}$/, '$1');
  const tokens = tokenize(body);
  let at = 0;
  const peek = () => tokens[at];
  const isOp = (value) => peek()?.kind === 'op' && peek().value === value;
  const expect = (value) => {
    if (!isOp(value)) throw new Error(`expected "${value}" at token ${at} in: ${body}`);
    at += 1;
  };

  function or() {
    let value = and();
    while (isOp('||')) {
      at += 1;
      const right = and();
      value = truthy(value) ? value : right;
    }
    return value;
  }
  function and() {
    let value = comparison();
    while (isOp('&&')) {
      at += 1;
      const right = comparison();
      value = truthy(value) ? right : value;
    }
    return value;
  }
  function comparison() {
    const left = unary();
    if (isOp('==') || isOp('!=')) {
      const negate = peek().value === '!=';
      at += 1;
      const same = equal(left, unary());
      return negate ? !same : same;
    }
    return left;
  }
  function unary() {
    if (isOp('!')) {
      at += 1;
      return !truthy(unary());
    }
    return primary();
  }
  function primary() {
    const token = peek();
    if (!token) throw new Error(`unexpected end of: ${body}`);
    if (isOp('(')) {
      at += 1;
      const value = or();
      expect(')');
      return value;
    }
    if (token.kind === 'string' || token.kind === 'number') {
      at += 1;
      return token.value;
    }
    if (token.kind !== 'ident') throw new Error(`unexpected "${token.value}" in: ${body}`);
    at += 1;
    if (token.value === 'true' || token.value === 'false') return token.value === 'true';
    if (token.value === 'null') return null;
    if (isOp('(')) {
      at += 1;
      const args = [];
      while (!isOp(')')) {
        args.push(or());
        if (isOp(',')) at += 1;
        else break;
      }
      expect(')');
      if (Object.hasOwn(STATUS, token.value)) return STATUS[token.value];
      if (!Object.hasOwn(FUNCTIONS, token.value))
        throw new Error(`unknown function ${token.value}() in: ${body}`);
      return FUNCTIONS[token.value](...args);
    }
    let value = Object.hasOwn(context, token.value) ? context[token.value] : null;
    let filtered = false;
    while (isOp('.')) {
      at += 1;
      if (isOp('*')) {
        at += 1;
        value = Array.isArray(value) ? value : value && typeof value === 'object' ? Object.values(value) : [];
        filtered = true;
        continue;
      }
      const name = peek();
      if (name?.kind !== 'ident') throw new Error(`expected a property name in: ${body}`);
      at += 1;
      const read = (item) =>
        item && typeof item === 'object' && Object.hasOwn(item, name.value) ? item[name.value] : null;
      value = filtered ? value.map(read).filter((item) => item !== null) : read(value);
    }
    return value ?? null;
  }

  const result = or();
  if (at !== tokens.length) throw new Error(`unread input from token ${at} in: ${body}`);
  return result;
}

/**
 * Whether a job would run. GitHub puts an implicit `success() &&` in front of
 * an `if:` that calls no status function, so a job whose `needs` was skipped
 * is skipped too unless its `if:` says otherwise (`!cancelled()`, `always()`).
 * @param {{if?: string}} job
 * @param {object} context see evaluate()
 * @param {{upstreamSkipped?: boolean}} [options] whether a job it needs was skipped
 * @returns {boolean}
 */
export function runs(job, context, { upstreamSkipped = false } = {}) {
  const condition = job.if === undefined ? '' : String(job.if);
  if (upstreamSkipped && !/\b(success|always|cancelled|failure)\(\)/.test(condition)) return false;
  return condition === '' ? true : truthy(evaluate(condition, context));
}
