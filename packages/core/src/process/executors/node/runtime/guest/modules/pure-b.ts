/**
 * Guest source for the pure-b family: vm, domain, inspector (and inspector/promises)
 * and repl. Plain JavaScript inside a String.raw snippet; everything lives in one IIFE
 * that only registers BF factories, so no globals are introduced.
 *
 * vm model: a context is a sandbox object. Code runs through a `with` scope backed by
 * a Proxy: names the sandbox owns resolve there, ES builtins fall through to the host
 * realm, and every other free name reads and writes the sandbox, so undeclared
 * assignments and top-level var declarations land on the sandbox. Top-level function
 * declarations are copied onto the sandbox after each run. The code runs in this realm, so a
 * value it makes is rebuilt by the host inside a second one before it is handed back: prototypes,
 * builtins and instanceof of what comes back are that realm's, as they are for a value host
 * Node hands back from another context. See outOfRecord.
 */
export const SRC = String.raw`
(function () {
  var ES_NAMES = Object.create(null);
  var ES_LIST = ['AggregateError', 'Array', 'ArrayBuffer', 'Atomics', 'BigInt', 'BigInt64Array',
    'BigUint64Array', 'Boolean', 'DataView', 'Date', 'Error', 'EvalError', 'FinalizationRegistry',
    'Float32Array', 'Float64Array', 'Function', 'Infinity', 'Int8Array', 'Int16Array', 'Int32Array',
    'Intl', 'JSON', 'Map', 'Math', 'NaN', 'Number', 'Object', 'Promise', 'Proxy', 'RangeError',
    'ReferenceError', 'Reflect', 'RegExp', 'Set', 'SharedArrayBuffer', 'String', 'Symbol',
    'SyntaxError', 'TypeError', 'Uint8Array', 'Uint8ClampedArray', 'Uint16Array', 'Uint32Array',
    'URIError', 'WeakMap', 'WeakRef', 'WeakSet', 'decodeURI', 'decodeURIComponent', 'encodeURI',
    'encodeURIComponent', 'escape', 'eval', 'isFinite', 'isNaN', 'parseFloat', 'parseInt',
    'undefined', 'unescape'];
  for (var esi = 0; esi < ES_LIST.length; esi++) ES_NAMES[ES_LIST[esi]] = true;

  var vmRecords = new WeakMap();
  var REGEX_AFTER_WORD = { 'return': true, 'typeof': true, 'instanceof': true, 'in': true, 'of': true,
    'new': true, 'delete': true, 'void': true, 'throw': true, 'case': true, 'do': true, 'else': true,
    'yield': true, 'await': true };

  function isObjectLike(v) {
    return v !== null && (typeof v === 'object' || typeof v === 'function');
  }

  function nodeError(Ctor, code, message) {
    var err = new Ctor(message);
    err.code = code;
    return err;
  }

  function describeReceived(value) {
    if (value === null) return 'Received null';
    if (value === undefined) return 'Received undefined';
    var t = typeof value;
    if (t === 'function') return 'Received function ' + (value.name || '(anonymous)');
    if (t === 'object') {
      var proto = Object.getPrototypeOf(value);
      var ctor = proto ? proto.constructor : undefined;
      if (ctor && ctor.name) return 'Received an instance of ' + ctor.name;
      return 'Received ' + inspectValue(value);
    }
    return 'Received type ' + t + ' (' + inspectValue(value) + ')';
  }

  function argError(name, expected, value) {
    return nodeError(TypeError, 'ERR_INVALID_ARG_TYPE',
      'The "' + name + '" argument must be ' + expected + '. ' + describeReceived(value));
  }

  // ---- lexing (only enough JavaScript to find top-level structure) ----

  function isIdStartCode(c) {
    return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 36 || c > 127;
  }

  function isIdPartCode(c) {
    return isIdStartCode(c) || (c >= 48 && c <= 57);
  }

  function regexAllowedAfter(last) {
    if (last === null) return true;
    if (last.t === 'id') return REGEX_AFTER_WORD[last.v] === true;
    if (last.t === 'punct') return last.v !== ')' && last.v !== ']';
    return false;
  }

  function skipQuoted(src, i, q) {
    var n = src.length;
    i++;
    while (i < n) {
      var c = src.charAt(i);
      if (c === '\\') { i += 2; continue; }
      i++;
      if (c === q || c === '\n') return i;
    }
    return n;
  }

  function skipTemplate(src, i) {
    var n = src.length;
    while (i < n) {
      var c = src.charAt(i);
      if (c === '\\') { i += 2; continue; }
      if (c === '\x60') return i + 1;
      if (c === '$' && src.charAt(i + 1) === '{') {
        i = skipTemplateExpr(src, i + 2);
        if (i < 0) return -1;
        continue;
      }
      i++;
    }
    return -1;
  }

  function skipTemplateExpr(src, i) {
    var n = src.length;
    var d = 1;
    while (i < n) {
      var c = src.charAt(i);
      if (c === '"' || c === "'") { i = skipQuoted(src, i, c); continue; }
      if (c === '\x60') {
        i = skipTemplate(src, i + 1);
        if (i < 0) return -1;
        continue;
      }
      if (c === '{') d++;
      else if (c === '}') {
        d--;
        if (d === 0) return i + 1;
      }
      i++;
    }
    return -1;
  }

  function vmLex(src) {
    var toks = [];
    var n = src.length;
    var i = 0;
    var depth = 0;
    var unterminated = false;
    var last = null;
    while (i < n) {
      var code = src.charCodeAt(i);
      if (code <= 32) { i++; continue; }
      var ch = src.charAt(i);
      if (ch === '/' && src.charAt(i + 1) === '/') {
        var nl = src.indexOf('\n', i);
        i = nl < 0 ? n : nl + 1;
        continue;
      }
      if (ch === '/' && src.charAt(i + 1) === '*') {
        var endc = src.indexOf('*/', i + 2);
        if (endc < 0) { unterminated = true; i = n; } else { i = endc + 2; }
        continue;
      }
      var start = i;
      var tok;
      if (ch === '"' || ch === "'") {
        i = skipQuoted(src, i, ch);
        tok = { t: 'str', v: '' };
      } else if (ch === '\x60') {
        var after = skipTemplate(src, i + 1);
        if (after < 0) { unterminated = true; after = n; }
        i = after;
        tok = { t: 'tpl', v: '' };
      } else if (ch === '/' && regexAllowedAfter(last)) {
        i++;
        var inClass = false;
        while (i < n) {
          var rc = src.charAt(i);
          if (rc === '\\') { i += 2; continue; }
          if (rc === '\n') break;
          i++;
          if (rc === '[') inClass = true;
          else if (rc === ']') inClass = false;
          else if (rc === '/' && !inClass) break;
        }
        while (i < n && isIdPartCode(src.charCodeAt(i))) i++;
        tok = { t: 're', v: '' };
      } else if (isIdStartCode(code)) {
        i++;
        while (i < n && isIdPartCode(src.charCodeAt(i))) i++;
        tok = { t: 'id', v: src.slice(start, i) };
      } else if (code >= 48 && code <= 57) {
        i++;
        while (i < n && (isIdPartCode(src.charCodeAt(i)) || src.charAt(i) === '.')) i++;
        tok = { t: 'num', v: '' };
      } else {
        i++;
        tok = { t: 'punct', v: ch };
      }
      tok.pos = start;
      tok.end = i;
      if (tok.t === 'punct' && ch === '}') depth--;
      tok.depth = depth;
      if (tok.t === 'punct' && ch === '{') depth++;
      toks.push(tok);
      last = tok;
    }
    return { toks: toks, unterminated: unterminated };
  }

  // Names declared by top-level function declarations (depth 0, not property accesses).
  function topLevelFunctionNames(src) {
    var toks = vmLex(src).toks;
    var names = [];
    for (var k = 0; k < toks.length; k++) {
      var t = toks[k];
      if (t.t !== 'id' || t.v !== 'function' || t.depth !== 0) continue;
      var prev = toks[k - 1];
      if (prev && prev.t === 'punct' && prev.v === '.') continue;
      var nx = toks[k + 1];
      if (nx && nx.t === 'punct' && nx.v === '*') nx = toks[k + 2];
      if (nx && nx.t === 'id' && names.indexOf(nx.v) < 0) names.push(nx.v);
    }
    return names;
  }

  // REPL only: top-level let/const become var so bindings persist across lines.
  function rewriteTopLexical(src) {
    var toks = vmLex(src).toks;
    var out = '';
    var cursor = 0;
    for (var k = 0; k < toks.length; k++) {
      var t = toks[k];
      if (t.t !== 'id' || t.depth !== 0 || (t.v !== 'let' && t.v !== 'const')) continue;
      var prev = toks[k - 1];
      if (prev && !(prev.t === 'punct' && (prev.v === ';' || prev.v === '}'))) continue;
      out += src.slice(cursor, t.pos) + 'var';
      cursor = t.end;
    }
    return out + src.slice(cursor);
  }

  // Names introduced by var anywhere in the code. Reads of these resolve to undefined
  // instead of ReferenceError; nested-function vars over-approximate harmlessly.
  function declaredNames(src) {
    var toks = vmLex(src).toks;
    var names = Object.create(null);
    var inDecl = false;
    for (var k = 0; k < toks.length; k++) {
      var t = toks[k];
      var prev = toks[k - 1];
      if (t.t === 'id' && t.v === 'var') { inDecl = true; continue; }
      if (t.t === 'punct' && t.v === ';') { inDecl = false; continue; }
      if (inDecl && t.t === 'id' && prev &&
          ((prev.t === 'id' && prev.v === 'var') || (prev.t === 'punct' && prev.v === ','))) {
        names[t.v] = true;
      }
    }
    return names;
  }

  // typeof of a bare identifier must not throw for an undeclared name; rewrite it so the
  // ReferenceError from the with-scope is caught and yields 'undefined' as in Node.
  var TYPEOF_SKIP = { 'this': true, 'function': true, 'class': true, 'new': true, 'typeof': true,
    'void': true, 'delete': true, 'null': true, 'true': true, 'false': true, 'super': true,
    'import': true, 'yield': true, 'await': true };

  function rewriteTypeof(src) {
    var toks = vmLex(src).toks;
    var out = '';
    var cursor = 0;
    for (var k = 0; k + 1 < toks.length; k++) {
      var t = toks[k];
      if (t.t !== 'id' || t.v !== 'typeof') continue;
      var nx = toks[k + 1];
      if (nx.t !== 'id' || TYPEOF_SKIP[nx.v] === true) continue;
      var after = toks[k + 2];
      if (after && after.t === 'punct' && (after.v === '.' || after.v === '[' || after.v === '(')) continue;
      out += src.slice(cursor, t.pos) + '(function () { try { return typeof ' + nx.v +
        '; } catch (__owcVmE) { if (__owcVmE instanceof ReferenceError) return "undefined"; throw __owcVmE; } })()';
      cursor = nx.end;
      k++;
    }
    return out + src.slice(cursor);
  }

  function compiles(code) {
    try {
      new Function(code);
      return true;
    } catch (e) {
      return false;
    }
  }

  // ---- contexts ----

  function silentConsole() {
    var names = ['assert', 'clear', 'count', 'countReset', 'debug', 'dir', 'dirxml', 'error', 'group',
      'groupCollapsed', 'groupEnd', 'info', 'log', 'profile', 'profileEnd', 'table', 'time', 'timeEnd',
      'timeLog', 'timeStamp', 'trace', 'warn'];
    var c = {};
    for (var i = 0; i < names.length; i++) c[names[i]] = function () { return undefined; };
    return c;
  }

  function fallbackGet(rec, key) {
    if (key === 'globalThis') return rec.G;
    if (key === 'console') return rec.console;
    if (ES_NAMES[key] === true) return globalThis[key];
    return undefined;
  }

  function makeRecord(sb) {
    var rec = { sb: sb, console: silentConsole(), G: null };
    rec.G = new Proxy(sb, {
      get: function (target, key) {
        if (typeof key !== 'string' || (key in target)) return target[key];
        return fallbackGet(rec, key);
      },
      has: function (target, key) {
        if (typeof key !== 'string') return key in target;
        return (key in target) || key === 'globalThis' || key === 'console' || ES_NAMES[key] === true;
      }
    });
    return rec;
  }

  function withHandler(rec, fnSet, decl) {
    return {
      has: function (target, key) {
        if (typeof key !== 'string') return false;
        if (key.indexOf('__owcVm') === 0) return false;
        return fnSet[key] !== true;
      },
      get: function (target, key) {
        if (typeof key !== 'string') return target[key];
        if (key in target) return target[key];
        if (decl[key] === true) return undefined;
        if (key === 'globalThis' || key === 'console' || ES_NAMES[key] === true) return fallbackGet(rec, key);
        throw new ReferenceError(key + ' is not defined');
      },
      set: function (target, key, value) {
        target[key] = value;
        return true;
      }
    };
  }

  // Runs with this = the global view. Free identifiers inside the eval resolve through
  // the with-proxy; internal __owcVm names and top-level function names stay local.
  function runWrapped(__owcVmWith, __owcVmCode, __owcVmFns, __owcVmSb) {
    var __owcVmOut;
    try {
      with (__owcVmWith) {
        __owcVmOut = eval(__owcVmCode);
      }
    } finally {
      for (var __owcVmI = 0; __owcVmI < __owcVmFns.length; __owcVmI++) {
        try {
          __owcVmSb[__owcVmFns[__owcVmI]] = eval(__owcVmFns[__owcVmI]);
        } catch (__owcVmErr) {
          // not a binding of this script; drop the placeholder created before the run
          if (__owcVmSb[__owcVmFns[__owcVmI]] === undefined) delete __owcVmSb[__owcVmFns[__owcVmI]];
        }
      }
    }
    return __owcVmOut;
  }

  function runInRecord(rec, code) {
    var src = vmCode(code);
    var fns = topLevelFunctionNames(src);
    var fnSet = Object.create(null);
    for (var i = 0; i < fns.length; i++) {
      fnSet[fns[i]] = true;
      if (!(fns[i] in rec.sb)) rec.sb[fns[i]] = undefined;
    }
    var decl = declaredNames(src);
    var scope = new Proxy(rec.sb, withHandler(rec, fnSet, decl));
    var out;
    try {
      out = runWrapped.call(rec.G, scope, rewriteTypeof(src), fns, rec.sb);
    } catch (thrown) {
      /* A value the context throws out of itself crosses the way one it hands back does: an error of
         another realm, so e instanceof Error is false in the catch of
         vm.runInNewContext('throw new Error("x")'), as on host Node 24.15, with name and message and
         the properties its constructor put on it still reading as they did inside the context. */
      throw outOfRecord(rec, thrown);
    }
    return outOfRecord(rec, out);
  }

  /* A source this module compiles for a context gets the loader's compatibility rewrite, as a
     module body does: the engine aborts the compile of a for-of whose iterable holds a yield
     ('stack underflow'), and a script handed to a context is as entitled to the hoist as a module.
     The scan costs a pass over the source, so it is skipped unless the one token the rewrite
     needs can be in it. */
  function vmCode(code) {
    if (typeof code !== 'string' || code.indexOf('yield') < 0) return code;
    var fixed = null;
    try { fixed = rxRewrite(code); } catch (rewriteErr) { fixed = null; }
    return fixed === null ? code : fixed;
  }

  /**
   * A value a vm context hands back, as host Node hands it back: an object of another realm.
   *
   * The host keeps a second realm -- a second QuickJS context on the same runtime -- and rebuilds
   * the value there, so an array from runInContext answers false to instanceof Array while
   * Array.isArray still answers true, and Object.prototype.toString.call still says [object Array].
   * That is a copy rather than the object the context's code made, so a value the caller put into
   * the sandbox itself is not rebuilt: a copy of it would drift from the original the moment either
   * was changed, and Node hands the very same object back.
   */
  function outOfRecord(rec, out) {
    if (out === null || (typeof out !== 'object' && typeof out !== 'function')) return out;
    if (out === rec.G || out === rec.sb) return out;
    var keys = Object.keys(rec.sb);
    for (var i = 0; i < keys.length; i++) {
      if (rec.sb[keys[i]] === out) return out;
    }
    api.vmValue = out;
    var back;
    try {
      callCap('vm.realm', {});
      back = api.vmBack;
    } catch (e) {
      back = undefined;
    }
    api.vmValue = undefined;
    api.vmBack = undefined;
    return back === undefined ? out : back;
  }

  function createContextObject(obj) {
    if (obj === undefined) obj = {};
    if (!isObjectLike(obj)) throw argError('object', 'of type object', obj);
    if (!vmRecords.has(obj)) vmRecords.set(obj, makeRecord(obj));
    return obj;
  }

  function recordOf(obj) {
    var rec = isObjectLike(obj) ? vmRecords.get(obj) : undefined;
    if (rec === undefined) throw argError('contextifiedObject', 'an vm.Context', obj);
    return rec;
  }

  // ---- REPL helpers ----

  var OPEN_TO_CLOSE = { '(': ')', '[': ']', '{': '}' };

  /*
   * Whether the buffer is unfinished input rather than a syntax error. Node asks its parser where
   * the error was raised: one raised only after the parser has read end-of-input -- a comment, a
   * template, an unclosed bracket or an operator still waiting for its operand -- is input a later
   * line can complete, and one raised inside what is already written is reported at once. So a
   * buffer of 'var y = {' then '2+2' is an error and not an unfinished object, which is the whole
   * difference: depth alone kept buffering it forever and never reported anything.
   *
   * This runtime's parser reports no position with its errors, so the question is put to its
   * compiler instead: what closing its own open brackets cannot complete, with an operand offered
   * where a trailing operator waits for one, is a syntax error. A clause is owed as well as an
   * operand: 'try' still needs a catch or a finally, 'catch' a binding, 'do' a while, and a header
   * -- 'function f()', 'class A', 'for (;;)' -- the body that follows it, and none of those is a
   * value an operand could stand in for.
   */
  function replIncomplete(src) {
    if (compiles(src)) return false;
    var lx = vmLex(src);
    /* a comment or a template runs to the end of what is written, and the next line can close it */
    if (lx.unterminated) return true;
    /* a property name is still owed after a '.' -- but a run of dots is no property access: '...'
       is a spread or a rest, and an error however the line ends */
    if (/[^.][.]\s*$/.test(src)) return true;
    var stack = [];
    for (var i = 0; i < lx.toks.length; i++) {
      var t = lx.toks[i];
      if (t.t !== 'punct') continue;
      var want = OPEN_TO_CLOSE[t.v];
      if (want !== undefined) stack.push(want);
      else if (t.v === ')' || t.v === ']' || t.v === '}') {
        /* a closer with nothing of its own open is an error, not a bracket a line will close */
        if (stack.length === 0 || stack[stack.length - 1] !== t.v) return false;
        stack.pop();
      }
    }
    var tail = stack.reverse().join('');
    var owed = [tail, ' 1' + tail, tail + ' {}', 'e' + tail + '{}', tail + ' catch(e){}',
      tail + ' while(0);', ' f(){}'];
    for (var k = 0; k < owed.length; k++) if (compiles(src + owed[k])) return true;
    return false;
  }

  /* Words a statement can open with that has no value of its own: the last statement of a line is
     the line's value only when it opens with something else. */
  var REPL_NO_VALUE = { if: true, for: true, while: true, do: true, switch: true, try: true,
    catch: true, finally: true, else: true, throw: true, return: true, break: true, continue: true,
    with: true, var: true, function: true, class: true, debugger: true };

  /*
   * A line carrying a top-level await, which no engine will run as a script: outside an async
   * function await is only an identifier, so "var c = await 9" is two primary expressions in a
   * row and the line is refused. Node's repl answers by hoisting the declarations the line makes
   * out of an async wrapper and running the rest inside it -- "var c = await 9" becomes
   * "var c; (async () => { void (c = await 9) })()" -- so the binding outlives the await and the
   * completion value is still the one the line would have had: undefined for a declaration, which
   * is why each is wrapped in void, and the value of the last expression otherwise, which is why
   * that one is wrapped in a return of the value under the key unwrapAwait looks for.
   *
   * The same shape here, with the wrapper a function expression so nothing depends on the this of
   * a script. A line this engine accepts as it stands -- "await (x)", which it reads as a call of
   * an identifier named await where Node reads an await of x -- is rewritten too, because the
   * token is what decides and not the engine's reading of it; and a rewrite that does not itself
   * compile is thrown away, leaving the line to run or to fail exactly as it does now.
   */
  function replTopLevelAwait(src) {
    var toks = vmLex(src).toks;
    var awaited = false;
    for (var q = 0; q < toks.length; q++) {
      if (toks[q].t !== 'id' || toks[q].v !== 'await' || toks[q].depth !== 0) continue;
      var before = toks[q - 1];
      if (before !== undefined && before.t === 'punct' && before.v === '.') continue;
      awaited = true;
      break;
    }
    if (awaited !== true) return null;

    /* The statements of the line, split where a semicolon stands at the top level. */
    var edges = [0];
    for (var e = 0; e < toks.length; e++) {
      if (toks[e].t === 'punct' && toks[e].v === ';' && toks[e].depth === 0) {
        edges.push(toks[e].pos, toks[e].end);
      }
    }
    edges.push(src.length);

    function firstTokenIn(from, to) {
      for (var i = 0; i < toks.length; i++) {
        if (toks[i].pos >= from && toks[i].pos < to) return toks[i];
      }
      return null;
    }

    var hoisted = [];
    var parts = [];
    for (var s = 0; s + 1 < edges.length; s += 2) {
      var from = edges[s];
      var to = edges[s + 1];
      var text = src.slice(from, to);
      var bare = text.replace(/^\s+/, '');
      if (bare === '') continue;
      var first = firstTokenIn(from, to);
      var last = s + 2 >= edges.length;

      if (first !== null && first.t === 'id' && first.depth === 0 && first.v === 'var') {
        var cuts = [first.end];
        for (var c = 0; c < toks.length; c++) {
          if (toks[c].t !== 'punct' || toks[c].v !== ',' || toks[c].depth !== 0) continue;
          if (toks[c].pos <= first.end || toks[c].pos >= to) continue;
          cuts.push(toks[c].pos, toks[c].end);
        }
        cuts.push(to);
        var assigned = [];
        for (var d = 0; d + 1 < cuts.length; d += 2) {
          var lead = firstTokenIn(cuts[d], cuts[d + 1]);
          if (lead === null || lead.t !== 'id') return null;
          var rest = src.slice(lead.end, cuts[d + 1]).replace(/^\s+/, '');
          var init = 'undefined';
          if (rest.charAt(0) === '=') init = rest.slice(1);
          else if (rest !== '') return null;
          hoisted.push(lead.v);
          assigned.push(lead.v + ' = ' + init);
        }
        parts.push('void (' + assigned.join(', ') + ')');
        continue;
      }

      /* A function or a class becomes an assignment to the name hoisted above, which is how the
         binding reaches the session. Only when the declaration is the whole statement: a line that
         goes on to do something else after the closing brace is left alone rather than split. */
      if (first !== null && first.t === 'id' && first.depth === 0
          && (first.v === 'function' || first.v === 'class')) {
        var named = null;
        for (var n = 0; n < toks.length; n++) {
          if (toks[n].pos < first.end || toks[n].pos >= to) continue;
          if (toks[n].t === 'id') { named = toks[n]; break; }
          if (toks[n].t === 'punct' && toks[n].v === '*') continue;
          break;
        }
        var opened = -1;
        var closed = -1;
        for (var b = 0; b < toks.length; b++) {
          if (toks[b].pos < first.pos || toks[b].pos >= to) continue;
          if (opened < 0) {
            if (toks[b].t === 'punct' && toks[b].v === '{' && toks[b].depth === 0) opened = b;
            continue;
          }
          if (toks[b].t === 'punct' && toks[b].v === '}' && toks[b].depth === 0) { closed = b; break; }
        }
        if (named === null || closed < 0) return null;
        if (src.slice(toks[closed].end, to).replace(/\s+/g, '') !== '') return null;
        hoisted.push(named.v);
        parts.push(named.v + ' = ' + bare);
        continue;
      }

      /* The value of the line, when it has one: an expression, handed back in a wrapper of its
         own so that awaiting an object which happens to carry the same key still answers the
         object. Only a word that opens a control statement, or a label, or a declaration has no
         value, and anything else -- a literal, an operator, a bracket -- opens an expression. */
      if (last && (first === null || first.t !== 'id' || (REPL_NO_VALUE[first.v] !== true
          && !/^[A-Za-z_$][\w$]*\s*:/.test(bare)))) {
        parts.push('return { __owcReplValue: (' + bare + ') }');
        continue;
      }
      parts.push(text);
    }

    var wrapper = (hoisted.length === 0 ? '' : 'var ' + hoisted.join(', ') + '; ')
      + '(async function () {\n' + parts.join(';\n') + '\n})()';
    return compiles(wrapper) ? wrapper : null;
  }

  /* What the wrapper above handed back, with the one key of its own taken off: an object the line
     awaited is nested one level deeper and so comes back out as the object it is. */
  function replUnwrapAwait(value) {
    if (isObjectLike(value) && '__owcReplValue' in value) return value.__owcReplValue;
    return value;
  }

  /* The offending line and a caret under it, the way V8 carries them above a syntax error: a buffer
     of 'var y = {' then '2+2' answers "2+2\n ^\n\n". QuickJS words the error its own way and shows
     no source of its own, but it does put the position in the stack of a compile it did itself, and
     the token the lexer finds there is the span V8 underlines -- so the frame is recoverable in
     guest code even though the two words the engine says are not. Only a source that does not
     compile is handed to that compile, so nothing that reaches it can run. */
  function replErrorFrame(code, err) {
    if (!isObjectLike(err) || err.name !== 'SyntaxError') return '';
    if (compiles(code)) return '';
    var pos = null;
    try {
      (0, eval)(code);
    } catch (inner) {
      var at = /<input>:(\d+):(\d+)/.exec(String(inner && inner.stack));
      if (at !== null) pos = { line: Number(at[1]), col: Number(at[2]) };
    }
    if (pos === null) return '';
    var text = String(code).split('\n')[pos.line - 1];
    if (text === undefined) return '';
    var span = 1;
    var toks = vmLex(text).toks;
    for (var i = 0; i < toks.length; i++) {
      if (toks[i].pos === pos.col - 1 && toks[i].end > toks[i].pos) {
        span = toks[i].end - toks[i].pos;
        break;
      }
    }
    var caret = '';
    for (var k = 1; k < pos.col; k++) caret += ' ';
    for (var j = 0; j < span; j++) caret += '^';
    return text + '\n' + caret + '\n\n';
  }

  function replErrorHeader(err) {
    if (isObjectLike(err) && typeof err.name === 'string') {
      return String(err.name) + (err.message ? ': ' + err.message : '');
    }
    return inspectValue(err);
  }

  function replWriter(value) {
    return inspectValue(value);
  }

  // ---- vm ----

  BF['vm'] = function () {
    function Script(code, options) {
      if (!(this instanceof Script)) return new Script(code, options);
      if (typeof code !== 'string') throw argError('code', 'of type string', code);
      new Function(code);
      Object.defineProperty(this, '_owcCode', { value: code });
    }
    // A timeout option hands the evaluation to the host as a thunk (vm.run), which arms the deadline
    // around the call. QuickJS raises the interruption as an uncatchable error, so the host catches
    // it at the call boundary and reports it as a value; the timeout error is thrown here.
    function vmTimeoutOf(options) {
      if (options === null || typeof options !== 'object') return undefined;
      var timeout = options.timeout;
      if (timeout === undefined) return undefined;
      if (typeof timeout !== 'number') {
        throw nodeError(TypeError, 'ERR_INVALID_ARG_TYPE',
          'The "options.timeout" property must be of type number. ' + describeReceived(timeout));
      }
      if (!(timeout >= 1 && timeout <= 4294967295) || Math.floor(timeout) !== timeout) {
        throw nodeError(RangeError, 'ERR_OUT_OF_RANGE',
          'The value of "options.timeout" is out of range. It must be >= 1 && <= 4294967295. Received ' + String(timeout));
      }
      return timeout;
    }

    /* rec is the context the run belongs to, and undefined for runInThisContext, whose code runs in
       the caller's own realm: an error out of that one is the caller's, as on host Node 24.15. */
    function vmGuarded(options, run, rec) {
      var timeout = vmTimeoutOf(options);
      if (timeout === undefined) return run();
      function out(err) { return rec === undefined ? err : outOfRecord(rec, err); }
      var slot = null;
      api.vmThunk = function () {
        try { slot = { ok: true, value: run() }; } catch (err) { slot = { ok: false, error: err }; }
      };
      var outcome;
      try {
        outcome = callCap('vm.run', { timeout: timeout });
      } finally {
        api.vmThunk = undefined;
      }
      if (outcome.unbound) return run();
      if (outcome.interrupted) {
        /* Raised here rather than by the code that overran it, but host Node raises it in the
           context's realm, so the caller reads e instanceof Error as false there too. */
        throw out(nodeError(Error, 'ERR_SCRIPT_EXECUTION_TIMEOUT', 'Script execution timed out after ' + timeout + 'ms'));
      }
      if (outcome.error !== undefined) throw out(new Error(outcome.error));
      if (slot.ok) return slot.value;
      throw slot.error;
    }

    Script.prototype.runInThisContext = function (options) {
      var code = vmCode(this._owcCode);
      return vmGuarded(options, function () { return (0, eval)(code); });
    };
    Script.prototype.runInContext = function (contextifiedObject, options) {
      var rec = recordOf(contextifiedObject);
      var code = this._owcCode;
      return vmGuarded(options, function () { return runInRecord(rec, code); }, rec);
    };
    Script.prototype.runInNewContext = function (contextObject, options) {
      var rec = recordOf(createContextObject(contextObject));
      var code = this._owcCode;
      return vmGuarded(options, function () { return runInRecord(rec, code); }, rec);
    };
    Script.prototype.createCachedData = function () {
      return typeof Buffer !== 'undefined' ? Buffer.alloc(0) : new Uint8Array(0);
    };

    function compileFunction(code, params, options) {
      if (typeof code !== 'string') throw argError('code', 'of type string', code);
      var list = [];
      if (params !== undefined) {
        if (!Array.isArray(params)) throw argError('params', 'an instance of Array', params);
        for (var i = 0; i < params.length; i++) list.push(String(params[i]));
      }
      if (options && options.parsingContext !== undefined) {
        return runInRecord(recordOf(options.parsingContext),
          '(function (' + list.join(', ') + ') {\n' + code + '\n})');
      }
      return Function.apply(null, list.concat([code]));
    }

    return {
      Script: Script,
      createScript: function (code) { return new Script(code); },
      createContext: createContextObject,
      isContext: function (obj) {
        if (!isObjectLike(obj)) throw argError('object', 'of type object', obj);
        return vmRecords.has(obj);
      },
      runInThisContext: function (code, options) { return new Script(code).runInThisContext(options); },
      runInContext: function (code, contextifiedObject, options) {
        return new Script(code).runInContext(contextifiedObject, options);
      },
      runInNewContext: function (code, sandbox, options) {
        return new Script(code).runInNewContext(sandbox, options);
      },
      compileFunction: compileFunction,
      constants: {
        USE_MAIN_CONTEXT_DEFAULT_LOADER: Symbol('vm_dynamic_import_main_context_default'),
        DONT_CONTEXTIFY: Symbol('vm_context_no_contextify')
      }
    };
  };

  // ---- domain ----

  BF['domain'] = function () {
    var EventEmitter = requireBuiltin('events');
    var stack = [];
    var exp = { active: null };

    /*
     * The stack of entered domains, outermost first, as Node exposes it: domain._stack is the
     * array enter pushes onto and exit splices, so it is two deep inside a run nested in a
     * run and empty again once both have returned, and it is an enumerable own key of the
     * module -- Object.keys of it is Domain, _stack, active, create, createDomain on host
     * node 24.15, and was four names here with _stack the one missing.
     */
    Object.defineProperty(exp, '_stack', { get: function () { return stack; }, configurable: true, enumerable: true });

    /*
     * A promise reaction registered while a domain is active runs inside it, as it does in Node.
     * Node binds promises through the promise hooks of async_hooks; this is the same binding at
     * the one place a reaction is registered, so domain.active -- and process.domain, which
     * follows it -- is the domain inside a then, catch or finally callback. What a throw out of one
     * does is not decided here: bind() does not catch, so the throw becomes a rejection of the
     * promise then returned, and the domain's 'error' listeners see it only when nothing handled
     * that rejection -- measured on host node 24.15, where a reaction whose derived promise has a
     * handler prints 'rejected' and never reaches the domain, and one with no handler prints the
     * domain's error and no unhandled-rejection warning.
     * The patch is installed on the first domain, so a program that never builds one keeps the
     * engine's own then.
     */
    var domainThen = null;
    function bindInDomain(dom, cb) {
      return typeof cb === 'function' ? dom.bind(cb) : cb;
    }
    function installDomainPromiseHook() {
      if (domainThen !== null) return;
      domainThen = Promise.prototype.then;
      Promise.prototype.then = function then(onFulfilled, onRejected) {
        var dom = exp.active;
        if (dom === null || dom === undefined) return domainThen.call(this, onFulfilled, onRejected);
        return domainThen.call(this, bindInDomain(dom, onFulfilled), bindInDomain(dom, onRejected));
      };
    }

    function setActive(d) {
      exp.active = d;
      if (typeof process === 'object' && process !== null) {
        process.domain = d;
        /*
         * The uncaught-exception capture callback node registers for exactly as long as a domain is
         * entered: measured on host node 24.15, process.hasUncaughtExceptionCaptureCallback() is
         * false before d.run(), true inside it, true between enter() and exit(), and false again
         * after. Nothing here calls the callback -- the path that would hand an error over is the
         * host's, which reads no capture callback, so the loader routes an error with no caller by
         * asking process.domain -- but registering it is what makes the predicate agree with a host.
         */
        if (typeof process.setUncaughtExceptionCaptureCallback === 'function') {
          process.setUncaughtExceptionCaptureCallback(d ? captureUncaught : null);
        }
      }
    }

    /*
     * Set the domain a callback runs with as its context without entering it: no push onto the
     * stack, so exit() is not what undoes this and _owcEntered stays false. A microtask queued
     * inside d.run() is the case -- host node 24.15 reads process.domain as d inside it and
     * hasUncaughtExceptionCaptureCallback() as true, with the domain long exited. Returns the
     * domain that was there before, which is what a caller restores.
     */
    function setDomainContext(d) {
      var proc = typeof process === 'object' && process !== null ? process : null;
      if (!proc) return undefined;
      var prior = proc.domain;
      setActive(d);
      return prior;
    }
    if (typeof process === 'object' && process !== null && typeof process._owcSetDomainContext !== 'function') {
      Object.defineProperty(process, '_owcSetDomainContext', { value: setDomainContext, writable: true, configurable: true });
    }

    /* what the capture callback above would do with an error no caller is going to receive */
    function captureUncaught(err) {
      var dom = exp.active;
      if (!dom) return;
      uncaughtInDomain(dom, err);
    }

    function Domain() {
      EventEmitter.call(this);
      this.members = [];
    }
    Domain.prototype = Object.create(EventEmitter.prototype);
    Object.defineProperty(Domain.prototype, 'constructor', { value: Domain, writable: true, configurable: true });

    Domain.prototype.enter = function () {
      stack.push(this);
      setActive(this);
    };

    Domain.prototype.exit = function () {
      var index = stack.lastIndexOf(this);
      if (index === -1) return;
      stack.splice(index);
      setActive(stack.length === 0 ? undefined : stack[stack.length - 1]);
    };

    /*
     * run() and the bound callback bind() builds are both node's unguarded entry: enter, call, exit,
     * with no catch. A synchronous throw therefore propagates out of them to whoever called -- the
     * caller of run(), or the caller of the bound function -- and, the exit not being in a finally,
     * leaves the domain entered. Emitting it as 'error' here was the divergence: node routes an
     * error *no* caller catches, not one the caller is standing right next to. Measured on host node
     * 24.15, d.bind(() => { throw }) called inside a try prints the caller's catch and carries on,
     * while the same call with no try prints the domain's 'error' handler and never reaches the
     * statement after it, because the throw went out through the fatal path to the domain that was
     * still entered.
     */
    function runInDomain(self, fn, thisArg, args) {
      self.enter();
      var ret = fn.apply(thisArg, args);
      self.exit();
      return ret;
    }

    /*
     * The route node gives an error no caller is going to receive while a domain is entered: the
     * uncaught-exception capture callback node installs for as long as one is (true inside d.run()
     * and between enter() and exit() on host node 24.15, false again after) leaves the domain the
     * way exit() does and then emits the error on it, so the handler sees _stack without this
     * domain and process.domain as the next one out -- measured: one domain entered, the handler
     * sees _stack 0 and process.domain undefined; two entered, it sees _stack 1 and process.domain
     * the outer one, and a timer that fires afterwards runs outside the domain. err.domain is the
     * domain and domainThrown true, as on a host.
     *
     * False when no domain in the chain has an 'error' listener: node falls through to the process
     * then, leaving the domain first, so a domain entered with no listener of its own -- and no
     * enclosing one that has one -- prints the 'uncaughtException' handler outside the domain
     * instead, and one with no handler at all ends the process.
     *
     * Either way the route ends the way every uncaught exception does in lib/domain.js: the stack
     * is emptied and domain.active and process.domain go back to null -- not to the undefined an
     * ordinary exit() leaves behind, which is what a later timer used to read here.
     */
    /*
     * The leave a domain's own 'error' handler sees: lib/domain.js reaches _errorHandler with that
     * domain as the active one -- it pops the inner domains first and sets process.domain to the
     * next one out before it recurses -- and then pops *every* adjacent duplicate of it, in a
     * while-active-is-this loop of exit() calls. A timer the domain owns calling d.bind(...) is
     * what puts the same domain on the stack twice: the driver's own enter for the callback plus
     * the one bind's runInDomain does. Splicing a single entry left the second one behind, so the
     * process ran the rest of its life -- later timers included -- inside a domain host node 24.15
     * had already left (measured: b06, t04, t05, t07, t09).
     */
    function leaveDomainsAbove(dom) {
      var at = stack.lastIndexOf(dom);
      if (at === -1) return;
      stack.splice(at + 1);
      setActive(dom);
      while (exp.active === dom && stack.lastIndexOf(dom) !== -1) dom.exit();
    }
    /* domainUncaughtExceptionClear: how lib/domain.js ends every uncaught route. */
    function clearDomains() {
      stack.length = 0;
      setActive(null);
    }
    function uncaughtInDomain(self, err) {
      /*
       * Walk outward for a domain that listens: host node 24.15 does not stop at the innermost
       * one. An inner domain with no 'error' listener run inside an outer one that has one prints
       * the outer handler, not 'uncaughtException' -- measured. A domain that is only the async
       * context, not on the stack, is its own one-entry chain, which is the unhandled-rejection
       * path: it still handles the error.
       */
      var index = stack.lastIndexOf(self);
      var chain = index === -1 ? [self] : stack.slice(0, index + 1).reverse();
      for (var i = 0; i < chain.length; i++) {
        var dom = chain[i];
        if (dom.listenerCount('error') === 0) continue;
        leaveDomainsAbove(dom);
        if (isObjectLike(err)) {
          Object.defineProperty(err, 'domain', { value: dom, writable: true, configurable: true });
          err.domainThrown = true;
        }
        dom.emit('error', err);
        clearDomains();
        return true;
      }
      /*
       * Nothing in the chain listens, so the process gets the error -- but it gets it with every
       * domain this error was thrown inside already left. Measured on host node 24.15: a timer bound
       * to a domain that has no 'error' listener, throwing with an 'uncaughtException' listener
       * registered, prints that handler with domain._stack at 0, process.domain not the domain and
       * hasUncaughtExceptionCaptureCallback() false, and a timer that fires afterwards runs outside
       * the domain. Node leaves the domain before it falls through, so this does too.
       */
      clearDomains();
      return false;
    }
    /* the loader asks for this on process.domain: the one place an uncaught error is routed */
    Object.defineProperty(Domain.prototype, '_owcUncaught', {
      value: function (err) { return uncaughtInDomain(this, err); },
      writable: true,
      configurable: true
    });
    /* whether this domain is on the enter/exit stack, which is what routes a fatal throw */
    Object.defineProperty(Domain.prototype, '_owcEntered', {
      get: function () { return stack.lastIndexOf(this) !== -1; },
      configurable: true
    });

    Domain.prototype.run = function (fn) {
      installDomainPromiseHook();
      return runInDomain(this, fn, this, Array.prototype.slice.call(arguments, 1));
    };

    Domain.prototype.bind = function (cb) {
      var self = this;
      installDomainPromiseHook();
      function runBound() {
        return runInDomain(self, cb, this, Array.prototype.slice.call(arguments));
      }
      Object.defineProperty(runBound, 'domain', { value: this, writable: true, configurable: true });
      return runBound;
    };

    Domain.prototype.intercept = function (cb) {
      var self = this;
      function runIntercepted() {
        var args = Array.prototype.slice.call(arguments);
        if (args[0] && args[0] instanceof Error) {
          var er = args[0];
          er.domainBound = cb;
          er.domainThrown = false;
          Object.defineProperty(er, 'domain', { value: self, writable: true, configurable: true });
          self.emit('error', er);
          return undefined;
        }
        return runInDomain(self, cb, this, args.slice(1));
      }
      return runIntercepted;
    };

    Domain.prototype.add = function (ee) {
      if (ee.domain === this) return;
      if (ee.domain) ee.domain.remove(ee);
      if (this.domain && ee instanceof Domain) {
        for (var d = this.domain; d; d = d.domain) {
          if (ee === d) return;
        }
      }
      Object.defineProperty(ee, 'domain', { value: this, writable: true, configurable: true, enumerable: false });
      this.members.push(ee);
    };

    Domain.prototype.remove = function (ee) {
      ee.domain = null;
      var index = this.members.indexOf(ee);
      if (index !== -1) this.members.splice(index, 1);
    };

    Domain.prototype.dispose = function () {};

    // Emitters bound with add() route unhandled 'error' events to their domain.
    var eeEmit = EventEmitter.prototype.emit;
    EventEmitter.prototype.emit = function emit() {
      var args = Array.prototype.slice.call(arguments);
      var dom = this.domain;
      var type = args[0];
      if (type !== 'error' || this === process || !(dom instanceof Domain) || this.listenerCount('error') > 0) {
        return eeEmit.apply(this, args);
      }
      var er = args.length > 1 && args[1] ? args[1] : new Error('Unhandled error.');
      if (isObjectLike(er)) {
        er.domainEmitter = this;
        Object.defineProperty(er, 'domain', { value: dom, writable: true, configurable: true });
        er.domainThrown = false;
      }
      dom.emit('error', er);
      return true;
    };

    exp.Domain = Domain;
    exp.create = function createDomain() { installDomainPromiseHook(); return new Domain(); };
    exp.createDomain = exp.create;
    return exp;
  };

  // ---- inspector ----

  BF['inspector'] = function () {
    var EventEmitter = requireBuiltin('events');
    var exp = {};

    function Session() {
      EventEmitter.call(this);
      Object.defineProperty(this, '_owcConnected', { value: false, writable: true });
    }
    Session.prototype = Object.create(EventEmitter.prototype);
    Object.defineProperty(Session.prototype, 'constructor', { value: Session, writable: true, configurable: true });

    Session.prototype.connect = function () {
      if (this._owcConnected) {
        throw nodeError(Error, 'ERR_INSPECTOR_ALREADY_CONNECTED', 'The inspector session is already connected');
      }
      this._owcConnected = true;
    };

    Session.prototype.connectToMainThread = function () {
      throw nodeError(Error, 'ERR_INSPECTOR_NOT_WORKER', 'Current thread is not a worker');
    };

    Session.prototype.disconnect = function () {
      this._owcConnected = false;
    };

    /*
     * Runtime.evaluate is the one method of the protocol this runtime can answer: the expression
     * runs here, in the realm the program runs in, and what comes back is the RemoteObject the
     * protocol describes. The debugger, the profiler and the heap need a V8 this runtime has none
     * of, so every other method still reports ERR_INSPECTOR_NOT_AVAILABLE, as it did before.
     */
    function unserializableNumber(value) {
      if (value !== value) return 'NaN';
      if (value === Infinity) return 'Infinity';
      if (value === -Infinity) return '-Infinity';
      if (value === 0 && 1 / value === -Infinity) return '-0';
      return null;
    }

    function remoteObjectOf(value) {
      if (value === undefined) return { type: 'undefined' };
      if (value === null) return { type: 'object', subtype: 'null', value: null, description: 'null' };
      var kind = typeof value;
      if (kind === 'number') {
        var special = unserializableNumber(value);
        if (special !== null) return { type: 'number', unserializableValue: special, description: special };
        return { type: 'number', value: value, description: String(value) };
      }
      if (kind === 'string') return { type: 'string', value: value };
      if (kind === 'boolean') return { type: 'boolean', value: value, description: String(value) };
      if (kind === 'bigint') return { type: 'bigint', unserializableValue: String(value) + 'n', description: String(value) + 'n' };
      if (kind === 'symbol') return { type: 'symbol', value: String(value), description: String(value) };
      if (kind === 'function') return { type: 'function', className: 'Function', description: inspectValue(value) };
      var className = value && value.constructor && typeof value.constructor.name === 'string'
        ? value.constructor.name : 'Object';
      return { type: 'object', className: className, description: inspectValue(value) };
    }

    function evaluateForInspector(params) {
      var expression = params && typeof params.expression === 'string' ? params.expression : '';
      try {
        return { result: remoteObjectOf((0, eval)(expression)) };
      } catch (err) {
        return {
          exceptionDetails: {
            exception: remoteObjectOf(err),
            text: 'Uncaught',
            lineNumber: 0,
            columnNumber: 0
          }
        };
      }
    }

    function deliver(done, error, result) {
      if (typeof done !== 'function') return;
      setTimeout(function () { done(error, result); }, 0);
    }

    Session.prototype.post = function (method, params, callback) {
      if (typeof method !== 'string') throw argError('method', 'of type string', method);
      if (typeof params === 'function') {
        callback = params;
        params = undefined;
      }
      if (!this._owcConnected) throw nodeError(Error, 'ERR_INSPECTOR_NOT_CONNECTED', 'Session is not connected');
      if (method === 'Runtime.evaluate') {
        var outcome = evaluateForInspector(params);
        deliver(callback, null, outcome);
        return undefined;
      }
      if (method === 'Runtime.enable' || method === 'Runtime.disable' || method === 'Runtime.runIfWaitingForDebugger') {
        deliver(callback, null, {});
        return undefined;
      }
      deliver(callback, nodeError(Error, 'ERR_INSPECTOR_NOT_AVAILABLE',
        'Inspector protocol is not available in this runtime'), undefined);
      return undefined;
    };

    exp.Session = Session;
    exp.open = function () {};
    exp.close = function () {};
    exp.wait = function () {};
    exp.url = function () { return undefined; };
    exp.waitForDebugger = function () {
      throw nodeError(Error, 'ERR_INSPECTOR_NOT_ACTIVE', 'Inspector is not active');
    };
    exp.console = globalThis.console;
    return exp;
  };

  BF['inspector/promises'] = function () {
    var base = requireBuiltin('inspector');

    function PromiseSession() {
      base.Session.call(this);
    }
    PromiseSession.prototype = Object.create(base.Session.prototype);
    Object.defineProperty(PromiseSession.prototype, 'constructor', {
      value: PromiseSession, writable: true, configurable: true
    });
    PromiseSession.prototype.post = function (method, params) {
      var self = this;
      return new Promise(function (resolve, reject) {
        base.Session.prototype.post.call(self, method, params, function (err, result) {
          if (err) reject(err);
          else resolve(result);
        });
      });
    };

    return {
      Session: PromiseSession,
      open: base.open,
      close: base.close,
      url: base.url,
      waitForDebugger: base.waitForDebugger,
      console: base.console
    };
  };

  // ---- repl ----

  /*
   * "node" with no file: a REPL on this process's own stdin and stdout, in a context of its own.
   * stdin is opened rather than ended, so what the terminal sends reaches it; closing the REPL --
   * the .exit keyword, or the end of the input -- ends the process, as it does in Node.
   */
  api.startRepl = function () {
    var proc = globalThis.process;
    var server = requireBuiltin('repl').start({
      input: api.openStdin(),
      output: proc.stdout,
      prompt: '> ',
      terminal: true
    });
    server.on('exit', function () { host.exit(0); });
    return true;
  };

  BF['repl'] = function () {
    var EventEmitter = requireBuiltin('events');
    var vm = requireBuiltin('vm');
    var exp = {};

    function replConsole(repl) {
      var c = {};
      var logLike = ['log', 'info', 'debug', 'error', 'warn', 'trace'];
      for (var i = 0; i < logLike.length; i++) {
        c[logLike[i]] = function () { repl._writeOut(formatLogArgs(arguments) + '\n'); };
      }
      var noops = ['clear', 'count', 'countReset', 'dirxml', 'group', 'groupCollapsed', 'groupEnd', 'profile',
        'profileEnd', 'time', 'timeEnd', 'timeLog', 'timeStamp'];
      for (var j = 0; j < noops.length; j++) c[noops[j]] = function () { return undefined; };
      c.dir = function (value) { repl._writeOut(inspectValue(value) + '\n'); };
      c.assert = function (ok) {
        if (ok) return;
        var rest = Array.prototype.slice.call(arguments, 1);
        repl._writeOut('Assertion failed' + (rest.length ? ': ' + formatLogArgs(rest) : '') + '\n');
      };
      return c;
    }

    function defineBuiltinGetters(sb) {
      var names = Object.keys(BF);
      for (var i = 0; i < names.length; i++) {
        (function (name) {
          if (name.indexOf('/') >= 0 || name === 'console' || ES_NAMES[name] === true) return;
          Object.defineProperty(sb, name, {
            configurable: true,
            enumerable: false,
            get: function () { return requireBuiltin(name); },
            set: function (v) {
              Object.defineProperty(this, name, { value: v, writable: true, enumerable: true, configurable: true });
            }
          });
        })(names[i]);
      }

      /*
       * The rest of the runtime's globals: a fresh context has only its own intrinsics, so a REPL
       * started in one answers typeof WebAssembly as 'undefined' while Node's answers 'object'.
       * Each name the guest actually has is proxied, and assigning to one makes it an ordinary
       * property of the session, as in Node.
       */
      var REPL_GLOBALS = ['WebAssembly', 'Buffer', 'fetch', 'URL', 'URLSearchParams', 'TextEncoder', 'TextDecoder', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate', 'queueMicrotask', 'AbortController', 'AbortSignal', 'Event', 'EventTarget', 'CustomEvent', 'MessageChannel', 'MessagePort', 'MessageEvent', 'Blob', 'File', 'DOMException', 'structuredClone', 'performance', 'process', 'globalThis', 'global', 'atob', 'btoa', 'require'];
      for (var g = 0; g < REPL_GLOBALS.length; g++) {
        (function (name) {
          if (name in sb || !(name in globalThis)) return;
          Object.defineProperty(sb, name, {
            configurable: true,
            enumerable: false,
            get: function () { return globalThis[name]; },
            set: function (v) {
              Object.defineProperty(this, name, { value: v, writable: true, enumerable: true, configurable: true });
            }
          });
        })(REPL_GLOBALS[g]);
      }

      /* Node's REPL can require: it resolves against the working directory, as a file there would,
         and names the module it resolves from '<repl>', which is what a failure to resolve prints
         in its require stack. */
      if (!('require' in sb)) {
        try {
          var cwd = globalThis.process && typeof globalThis.process.cwd === 'function' ? globalThis.process.cwd() : '/';
          if (typeof api.createReplRequire === 'function') {
            Object.defineProperty(sb, 'require', { configurable: true, enumerable: false, writable: true, value: api.createReplRequire(cwd) });
          }
        } catch (requireError) { /* no require in this session; the rest of the context still works */ }
      }
    }

    function helpText(commands) {
      var names = Object.keys(commands).sort();
      var width = 0;
      for (var i = 0; i < names.length; i++) width = Math.max(width, names[i].length + 1);
      var lines = [];
      for (var j = 0; j < names.length; j++) {
        lines.push(('.' + names[j]).padEnd(width + 3) + commands[names[j]].help);
      }
      return lines.join('\n') + '\n\nPress Ctrl+C to abort current expression, Ctrl+D to exit the REPL\n';
    }

    function installBuiltinCommands(repl) {
      repl.commands['break'] = {
        help: 'Sometimes you get stuck, this gets you out',
        action: function () { this._buffer = ''; this.displayPrompt(); }
      };
      repl.commands['clear'] = {
        help: 'Break, and also clear the local context',
        action: function () {
          this._buffer = '';
          if (!this.useGlobal) {
            this._writeOut('Clearing context...\n');
            this._resetContext();
          }
          this.displayPrompt();
        }
      };
      repl.commands['exit'] = { help: 'Exit the REPL', action: function () { this.close(); } };
      repl.commands['help'] = {
        help: 'Print this help message',
        action: function () { this._writeOut(helpText(this.commands)); this.displayPrompt(); }
      };
      repl.commands['load'] = {
        help: 'Load JS from a file into the REPL session',
        action: function () { this.displayPrompt(); }
      };
      repl.commands['save'] = {
        help: 'Save all evaluated commands in this REPL session to a file',
        action: function () { this.displayPrompt(); }
      };
    }

    function REPLServer(options) {
      EventEmitter.call(this);
      if (typeof options === 'string') options = { prompt: options };
      options = options || {};
      var proc = typeof process === 'object' && process !== null ? process : undefined;
      this.input = options.input || (proc ? proc.stdin : undefined) || new EventEmitter();
      this.output = options.output || (proc ? proc.stdout : undefined) || { write: function () { return true; } };
      this.terminal = options.terminal === true;
      this.useGlobal = options.useGlobal === true;
      this.ignoreUndefined = options.ignoreUndefined === true;
      this.writer = typeof options.writer === 'function' ? options.writer : replWriter;
      this.commands = Object.create(null);
      this.line = '';
      this._prompt = options.prompt !== undefined ? String(options.prompt) : '> ';
      this._buffer = '';
      this._closed = false;
      this._detach = null;
      this._rl = null;
      this.context = undefined;
      installBuiltinCommands(this);
      this._resetContext();
      this._attachInput();
      this.displayPrompt();
    }
    REPLServer.prototype = Object.create(EventEmitter.prototype);
    Object.defineProperty(REPLServer.prototype, 'constructor', {
      value: REPLServer, writable: true, configurable: true
    });

    REPLServer.prototype._writeOut = function (text) {
      this.output.write(text);
    };

    REPLServer.prototype._resetContext = function () {
      if (this.useGlobal) {
        this.context = globalThis;
        return;
      }
      var sb = vm.createContext({});
      recordOf(sb).console = replConsole(this);
      defineBuiltinGetters(sb);
      this.context = sb;
    };

    REPLServer.prototype.getPrompt = function () {
      return this._prompt;
    };

    REPLServer.prototype.setPrompt = function (prompt) {
      this._prompt = String(prompt);
    };

    REPLServer.prototype.displayPrompt = function () {
      this._writeOut(this._buffer !== '' ? '| ' : this._prompt);
    };

    REPLServer.prototype.prompt = function () {
      this.displayPrompt();
    };

    REPLServer.prototype.defineCommand = function (keyword, cmd) {
      var name = String(keyword).replace(/^\./, '');
      var spec = typeof cmd === 'function' ? { action: cmd } : (cmd || {});
      this.commands[name] = {
        help: spec.help !== undefined ? String(spec.help) : '',
        action: typeof spec.action === 'function' ? spec.action.bind(this) : function () {}
      };
    };

    // Explicit close() defers the teardown to the next tick, as Node's REPL does.
    REPLServer.prototype.close = function () {
      if (this._closeScheduled || this._closed) return;
      this._closeScheduled = true;
      var repl = this;
      Promise.resolve().then(function () { repl._finishClose(); });
    };

    REPLServer.prototype._finishClose = function () {
      if (this._closed) return;
      this._closed = true;
      if (this._detach) this._detach();
      if (this._rl) this._rl.close();
      this.emit('close');
      this.emit('exit');
    };

    REPLServer.prototype._run = function (src) {
      var code = src;
      if (/^\s*\{/.test(src) && compiles('(' + src + '\n)')) code = '(' + src + '\n)';
      code = rewriteTopLexical(code);
      /* A line with a top-level await runs inside the wrapper instead, and says so: the value the
         promise it hands back resolves to is what the session sees, and the prompt waits for it. */
      var wrapped = replTopLevelAwait(code);
      this._awaitValue = wrapped !== null;
      if (this._awaitValue === true) code = wrapped;
      /* The source the engine was handed, kept for the frame a syntax error is reported with. */
      this._code = code;
      if (this.useGlobal) return (0, eval)(code);
      return vm.runInContext(code, this.context);
    };

    REPLServer.prototype._showResult = function (value) {
      this.context._ = value;
      if (value === undefined && this.ignoreUndefined) return;
      this._writeOut(String(this.writer(value)) + '\n');
    };

    /* True when the prompt is this call's to print: a line that awaits prints nothing until the
       promise settles, so the prompt has to come after it and not now. */
    REPLServer.prototype._evaluate = function (src) {
      var result;
      try {
        result = this._run(src);
      } catch (err) {
        this._writeOut(replErrorFrame(this._code === undefined ? src : this._code, err) +
          'Uncaught ' + replErrorHeader(err) + '\n');
        return false;
      }
      if (this._awaitValue === true && isObjectLike(result) && typeof result.then === 'function') {
        var repl = this;
        this._awaitValue = false;
        result.then(function (value) {
          repl._showResult(replUnwrapAwait(value));
          repl.displayPrompt();
        }, function (err) {
          repl._writeOut('Uncaught ' + replErrorHeader(err) + '\n');
          repl.displayPrompt();
        });
        return true;
      }
      this._showResult(result);
      return false;
    };

    REPLServer.prototype._onLine = function (line) {
      if (this._closed) return;
      this.line = '';
      var trimmed = line.replace(/^\s+/, '');
      if (this._buffer === '' && /^\.[A-Za-z_]/.test(trimmed)) {
        var m = /^\.(\S+)\s*([\s\S]*)$/.exec(trimmed);
        var name = m[1];
        var args = m[2].replace(/\s+$/, '');
        if (Object.prototype.hasOwnProperty.call(this.commands, name)) {
          this.commands[name].action.call(this, args);
        } else {
          this._writeOut('Invalid REPL keyword\n');
          this.displayPrompt();
        }
        return;
      }
      this._buffer = this._buffer === '' ? line : this._buffer + '\n' + line;
      if (replIncomplete(this._buffer)) {
        this.displayPrompt();
        return;
      }
      var src = this._buffer;
      this._buffer = '';
      if (src.replace(/\s+/g, '') !== '' && this._evaluate(src) === true) return;
      this.displayPrompt();
    };

    REPLServer.prototype._attachInput = function () {
      var repl = this;
      var input = this.input;
      if (!input || typeof input.on !== 'function') return;
      /* A terminal writes back what is typed, and nothing else does it for a REPL whose stdin is
         one: without this the characters a user types never appear. A newline comes back as the
         pair a terminal sends, so the cursor reaches the start of the next line. */
      if (this.terminal) {
        var echo = function (chunk) {
          if (repl._closed) return;
          repl._writeOut(String(chunk).replace(/\r\n?|\n/g, '\r\n'));
        };
        input.on('data', echo);
        this._detach = function () {
          if (typeof input.removeListener === 'function') input.removeListener('data', echo);
        };
      }
      var readline = requireBuiltin('readline');
      if (readline && typeof readline.createInterface === 'function') {
        var rl = readline.createInterface(input, undefined, undefined, false);
        rl.on('line', function (line) { repl._onLine(line); });
        rl.on('close', function () { repl._finishClose(); });
        this._rl = rl;
        return;
      }
      var detach = this._detach;
      var pending = '';
      var onData = function (chunk) {
        if (repl._closed) return;
        pending += typeof chunk === 'string' ? chunk : String(chunk);
        var idx = pending.indexOf('\n');
        while (idx >= 0) {
          var line = pending.slice(0, idx);
          pending = pending.slice(idx + 1);
          if (line.charAt(line.length - 1) === '\r') line = line.slice(0, -1);
          repl._onLine(line);
          if (repl._closed) return;
          idx = pending.indexOf('\n');
        }
      };
      var onEnd = function () {
        if (repl._closed) return;
        if (pending.length > 0) {
          var rest = pending;
          pending = '';
          repl._onLine(rest);
        }
        repl._finishClose();
      };
      input.on('data', onData);
      input.on('end', onEnd);
      this._detach = function () {
        if (detach !== null) detach();
        if (typeof input.removeListener === 'function') {
          input.removeListener('data', onData);
          input.removeListener('end', onEnd);
        }
      };
      if (typeof input.resume === 'function') input.resume();
    };

    function Recoverable(err) {
      this.err = err;
    }
    Recoverable.prototype = Object.create(SyntaxError.prototype);

    exp.start = function (options) { return new REPLServer(options); };
    exp.REPLServer = REPLServer;
    exp.REPL_MODE_SLOPPY = Symbol('repl-sloppy');
    exp.REPL_MODE_STRICT = Symbol('repl-strict');
    exp.writer = replWriter;
    exp.Recoverable = Recoverable;
    return exp;
  };

})();
`;
