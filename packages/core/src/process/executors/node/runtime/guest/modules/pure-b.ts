/**
 * Guest source for the pure-b family: vm, domain, inspector (and inspector/promises)
 * and repl. Plain JavaScript inside a String.raw snippet; everything lives in one IIFE
 * that only registers BF factories, so no globals are introduced.
 *
 * vm model: a context is a sandbox object. Code runs through a `with` scope backed by
 * a Proxy: names the sandbox owns resolve there, ES builtins fall through to a second
 * realm -- the one the code itself runs in -- and every other free name reads and writes
 * the sandbox, so undeclared assignments and top-level var declarations land on the
 * sandbox. Top-level function declarations are copied onto the sandbox after each run.
 * The code runs in that second realm and not in this one, so a value it makes is of
 * another realm as it is made and is handed back as it is: prototypes, builtins and
 * instanceof of what comes back are that realm's, as they are for a value host Node hands
 * back from another context. See vmEval. The one value a context makes of its own realm
 * still is the ERR_SCRIPT_EXECUTION_TIMEOUT of a timeout, raised here; see outOfRecord.
 */
export const SRC = String.raw`
(function () {
  var ES_NAMES = Object.create(null);
  var ES_LIST = ['AggregateError', 'Array', 'ArrayBuffer', 'AsyncDisposableStack', 'Atomics',
    'BigInt', 'BigInt64Array', 'BigUint64Array', 'Boolean', 'DataView', 'Date', 'DisposableStack',
    'Error', 'EvalError', 'FinalizationRegistry', 'Float16Array', 'Float32Array', 'Float64Array',
    'Function', 'Infinity', 'Int8Array', 'Int16Array', 'Int32Array', 'Intl', 'Iterator', 'JSON',
    'Map', 'Math', 'NaN', 'Number', 'Object', 'Promise', 'Proxy', 'RangeError', 'ReferenceError',
    'Reflect', 'RegExp', 'Set', 'SharedArrayBuffer', 'String', 'SuppressedError', 'Symbol',
    'SyntaxError', 'TypeError', 'Uint8Array', 'Uint8ClampedArray', 'Uint16Array', 'Uint32Array',
    'URIError', 'WeakMap', 'WeakRef', 'WeakSet', 'WebAssembly', 'decodeURI', 'decodeURIComponent',
    'encodeURI', 'encodeURIComponent', 'escape', 'eval', 'isFinite', 'isNaN', 'parseFloat',
    'parseInt', 'undefined', 'unescape'];
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
    /* Two more depths beside the one the braces give: pd counts the round and the square brackets
       as well, so a comma inside them is not the comma between two declarators, and fn counts only
       the braces that open a body -- a function's, a method's, a class's or an object's -- which
       is the one an await inside is not a top-level await for. */
    var pd = 0;
    var fnDepth = 0;
    var fnStack = [];
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
      if (tok.t === 'punct' && ch === '}') {
        depth--;
        if (fnStack.pop() === false) fnDepth--;
      }
      if (tok.t === 'punct' && (ch === ')' || ch === ']')) pd--;
      tok.depth = depth;
      tok.pd = pd;
      tok.fn = fnDepth;
      if (tok.t === 'punct' && ch === '{') {
        fnStack.push(opensBlock(toks, toks.length));
        if (fnStack[fnStack.length - 1] === false) fnDepth++;
        depth++;
      }
      if (tok.t === 'punct' && (ch === '(' || ch === '[')) pd++;
      toks.push(tok);
      last = tok;
    }
    return { toks: toks, unterminated: unterminated };
  }

  /* The words a '{' can stand after that make it a block and not a body: the ones an await inside
     is still a top-level await for, being a statement of the line rather than of a function. */
  var BLOCK_OPENERS = { if: true, for: true, while: true, do: true, switch: true, try: true,
    catch: true, finally: true, else: true, with: true };

  /* Whether the brace being opened at index b of toks is one of those: a ')' before it is the
     header of an 'if', a 'for' or a 'catch' -- a block -- or of a function or a method -- a body;
     '=>' opens an arrow's body; and a bare brace, one after a ';', a '{' or a '}', is a block. */
  function opensBlock(toks, b) {
    var prev = toks[b - 1];
    if (prev === undefined) return true;
    if (prev.t === 'punct') {
      if (prev.v === '=>') return false;
      if (prev.v === ';' || prev.v === '{' || prev.v === '}') return true;
      if (prev.v !== ')') return false;
      var d = 0;
      for (var p = b - 1; p >= 0; p--) {
        if (toks[p].t !== 'punct') continue;
        if (toks[p].v === ')') d++;
        else if (toks[p].v === '(') {
          d--;
          if (d === 0) {
            var head = toks[p - 1];
            return head !== undefined && head.t === 'id' && BLOCK_OPENERS[head.v] === true;
          }
        }
      }
      return false;
    }
    if (prev.t === 'id') return BLOCK_OPENERS[prev.v] === true;
    return true;
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
      if (t.t !== 'id' || t.depth !== 0 || (t.v !== 'let' && t.v !== 'const' && t.v !== 'class')) continue;
      var prev = toks[k - 1];
      if (prev && !(prev.t === 'punct' && (prev.v === ';' || prev.v === '}'))) continue;
      /* A class binds its name the way a let does, and so loses it at the end of the line here,
         where Node's context keeps it: written as the var assignment it is -- 'class A {}' as
         'var A = class A {}' -- the name reaches the next line the way a function's does. */
      if (t.v === 'class') {
        var cname = toks[k + 1];
        if (cname === undefined || cname.t !== 'id') continue;
        out += src.slice(cursor, t.pos) + 'var ' + cname.v + ' = ';
        cursor = t.pos;
        continue;
      }
      out += src.slice(cursor, t.pos) + 'var';
      cursor = t.end;
    }
    return out + src.slice(cursor);
  }

  /* REPL only: the names a line binds at its own top level, split the way node's context holds
     them. A let, a const and a class are lexical, and a context that already binds the name
     refuses the second one with a SyntaxError that names it; a var and a function are not, and
     may be declared again. Only a declaration the line opens with is one: a let a for keeps
     inside its parens and one a block keeps inside its braces are at a depth that is not 0, and
     a name that is not an identifier -- a destructuring pattern, a generator's star -- is left
     out rather than guessed at. */
  /* The names one declarator binds: the identifier itself, or every binding position of a
     destructuring pattern -- 'let [w] = [1]' binds w, 'const { a: b } = x' binds b and not the
     key a, 'let { c } = x' binds c, and a default value or a computed key of a pattern is read
     and not bound. */
  /* The index of the token that closes the bracket opened at 'from', or the last index there is. */
  function replSkipGroup(toks, from) {
    var open = toks[from];
    var close = open.v === '(' ? ')' : (open.v === '[' ? ']' : '}');
    var level = open.pd;
    for (var k = from + 1; k < toks.length; k++) {
      var p = toks[k];
      if (p.t === 'punct' && p.v === close && p.pd === level) return k;
    }
    return toks.length - 1;
  }

  function replDeclNames(toks, from) {
    var names = [];
    var open = toks[from];
    if (open === undefined) return names;
    if (open.t === 'id') { names.push(open.v); return names; }
    if (open.t !== 'punct' || (open.v !== '[' && open.v !== '{')) return names;
    var obj = open.v === '{';
    var level = open.pd;
    var k = from + 1;
    while (k < toks.length) {
      var p = toks[k];
      if (p.t === 'punct') {
        /* The closer of the pattern itself: nothing after it belongs to it. */
        if ((p.v === ']' || p.v === '}') && p.pd === level) break;
        /* A computed key's expression: read, never bound. */
        if (p.v === '[' || p.v === '(') { k = replSkipGroup(toks, k) + 1; continue; }
        /* A default value: 'let { a = b }' binds a and only reads b. */
        if (p.v === '=') {
          k++;
          while (k < toks.length) {
            var s = toks[k];
            if (s.t === 'punct' && (s.v === ',' ? s.pd === level + 1
                : ((s.v === '}' || s.v === ']') && s.pd === level))) break;
            k++;
          }
          continue;
        }
        k++;
        continue;
      }
      var nx = toks[k + 1];
      /* '{ a: b }': the name in front of the colon is the key the pattern reads, not one it binds. */
      if (p.t === 'id' && !(obj && nx !== undefined && nx.t === 'punct' && nx.v === ':')) names.push(p.v);
      k++;
    }
    return names;
  }

  function replTopDecls(src) {
    var toks = vmLex(src).toks;
    var lexical = [];
    var loose = [];
    for (var k = 0; k < toks.length; k++) {
      var t = toks[k];
      if (t.t !== 'id' || t.depth !== 0 || t.pd !== 0) continue;
      var lexicalKind = t.v === 'let' || t.v === 'const' || t.v === 'class';
      if (lexicalKind !== true && t.v !== 'var' && t.v !== 'function') continue;
      var prev = toks[k - 1];
      var starts = prev === undefined || (prev.t === 'punct' && (prev.v === ';' || prev.v === '}'));
      /* 'async function f(){}' opens with the word in front of 'function', which is itself at the
         start of a declaration and not, say, the tail of 'x = async function'. */
      if (starts !== true && prev !== undefined && prev.t === 'id' && prev.v === 'async') {
        var pre = toks[k - 2];
        starts = pre === undefined || (pre.t === 'punct' && (pre.v === ';' || pre.v === '}'));
      }
      if (starts !== true) continue;
      /* Every declarator of the declaration, not only the first: 'let p = 1, q = 2' binds q too.
         A comma of a declarator list is at the depth and the bracket level the keyword is; one of
         an initialiser, of an argument list or of a pattern's own group is not. */
      var c = k + 1;
      for (;;) {
        var one = replDeclNames(toks, c);
        for (var j = 0; j < one.length; j++) {
          if (lexicalKind === true) lexical.push(one[j]);
          else loose.push(one[j]);
        }
        var next = -1;
        for (var m = c; m < toks.length; m++) {
          var s = toks[m];
          if (s.t !== 'punct' || s.depth !== t.depth || s.pd !== 0) continue;
          if (s.v === ',') { next = m + 1; break; }
          if (s.v === ';' || s.v === '}') { m = toks.length; break; }
        }
        if (next < 0) break;
        c = next;
      }
    }
    return { lexical: lexical, loose: loose };
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

  /* A 'throw 1;' put in front of the line throws before the first statement of the line can, so
     nothing of the line runs whether it parses or not -- which is what lets the parse be tried at
     all. A function body is not a script: '{ return 1 }' is one a 'new Function' takes and a
     script does not, so 'compiles' answers true for a line no script will run. */
  var SCRIPT_PROBE = 'throw 1;';

  function scriptParses(code) {
    try {
      (0, eval)(SCRIPT_PROBE + code);
    } catch (e) {
      return !(isObjectLike(e) && e.name === 'SyntaxError');
    }
    return true;
  }

  /* Whether node would call the line syntactically valid, which is what it asks before it wraps a
     line that opens with a brace: the line parses, or it parses with its 'await's taken out, the
     way node's own isValidSyntax asks -- '{ await 3 }' becomes '{  3 }' and is wrapped, while
     '{ yield 3 }' and '{ return 1 }' parse neither way and are left as they were written. */
  function replIsValidSyntax(code) {
    /* Node asks twice: does the line parse as it stands, and does it parse where an expression is
       wanted -- '{ "a": 1 }' is not a program and is an object, so the second reading is the one
       that makes it a line worth wrapping. */
    if (scriptParses(code) || scriptParses('_=' + code)) return true;
    var noAwait = String(code).replace(/\bawait\b/g, '');
    if (noAwait === code) return false;
    return scriptParses(noAwait) || scriptParses('_=' + noAwait);
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

  /* The ES globals the code of a vm context sees: that context's own realm's, not this one's, and
     not another context's: every context is a realm of its own, so the names are read out of the
     realm of the one asking, once each. */
  function realmEs(rec, key) {
    if (rec.es === null) {
      rec.es = false;
      try {
        callCap('vm.es', { id: rec.id });
        if (api.vmEs !== undefined && api.vmEs !== null) rec.es = api.vmEs;
        api.vmEs = undefined;
      } catch (esErr) {
        rec.es = false;
      }
    }
    if (rec.es === false) return undefined;
    try {
      return rec.es[key];
    } catch (esErr) {
      return undefined;
    }
  }

  function fallbackGet(rec, key) {
    if (key === 'globalThis') return rec.G;
    if (key === 'console') return rec.console;
    if (ES_NAMES[key] === true) {
      var es = realmEs(rec, key);
      return es === undefined ? globalThis[key] : es;
    }
    return undefined;
  }

  var vmSeq = 0;

  function makeRecord(sb) {
    var rec = { sb: sb, console: silentConsole(), G: null, id: ++vmSeq, es: null };
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
        /* The ReferenceError a context raises for a name it does not know is one of the context's
           own realm, as every error host Node 24.15 raises inside one is: outside it, an error out
           of a context answers false to instanceof ReferenceError and to instanceof Error both. */
        var Ref = realmEs(rec, 'ReferenceError');
        throw new (typeof Ref === 'function' ? Ref : ReferenceError)(key + ' is not defined');
      },
      set: function (target, key, value) {
        target[key] = value;
        return true;
      }
    };
  }

  // Runs with this = the global view. Free identifiers inside the eval resolve through
  // the with-proxy; internal __owcVm names and top-level function names stay local.
  var NO_REALM = {};
  /* Whether the last run through the second realm was stopped by an armed deadline, rather than by
     the code in it. Set from the answer vm.exec gives, because an interruption QuickJS raises inside
     the realm reaches the guest as an ordinary throw and not as the uncatchable error it is. */
  var vmFired = false;

  /* The code of a context, compiled and run as global code of that context's own realm: the host
     syncs the sandbox onto the realm's global object first and back onto the sandbox afterwards, so
     everything the code makes is of that realm as it is made and comes back as it is, which is what
     a rebuild of it could only approximate. NO_REALM means no realm could be made for the context,
     and the run falls back to this one, under a with scope instead. */
  function vmEval(rec, code, file, offset, frames) {
    api.vmCode = code;
    api.vmSb = rec.sb;
    api.vmG = rec.G;
    api.vmConsole = rec.console;
    api.vmOut = undefined;
    api.vmThrow = undefined;
    var res;
    try {
      res = callCap('vm.exec', { id: rec.id, filename: file, lineOffset: offset });
    } finally {
      api.vmCode = undefined;
      api.vmSb = undefined;
      api.vmG = undefined;
      api.vmConsole = undefined;
    }
    if (res.unbound) return NO_REALM;
    var out = api.vmOut;
    var thrown = api.vmThrow;
    vmFired = res.fired === true;
    api.vmOut = undefined;
    api.vmThrow = undefined;
    if (res.ok) return errorOwnNames(out);
    throw errorOwnNames(vmDress(thrown, code, file, offset === undefined ? 0 : offset, frames));
  }

  /*
   * The order of an error's own names, which is the whole of what Object.getOwnPropertyNames reads
   * and nothing else. Host Node 24.15 builds 'stack' first -- 'stack','message' for a plain Error,
   * 'stack','message','errors' for an AggregateError -- where this engine puts 'message' on first and
   * appends 'stack' after it, and the error a context hands out is the one its own realm built, so it
   * crossed with the names in the engine's order. They are taken off and put back in the host's,
   * descriptors and all, which leaves the error the error it was: 'stack' is an accessor on both,
   * and redefining it under the same getter and setter changes nothing but its place.
   */
  function errorOwnNames(err) {
    if (!isObjectLike(err) || Object.prototype.toString.call(err) !== '[object Error]') return err;
    var had;
    try { had = Object.getOwnPropertyNames(err); } catch (e1) { return err; }
    var wanted = ['stack', 'message', 'errors'];
    var order = [];
    var i;
    for (i = 0; i < wanted.length; i++) { if (had.indexOf(wanted[i]) >= 0) order.push(wanted[i]); }
    for (i = 0; i < had.length; i++) { if (order.indexOf(had[i]) < 0) order.push(had[i]); }
    if (order.join(',') === had.join(',')) return err;
    try {
      var kept = [];
      for (i = 0; i < order.length; i++) kept.push(Object.getOwnPropertyDescriptor(err, order[i]));
      for (i = 0; i < order.length; i++) { try { delete err[order[i]]; } catch (x1) { } }
      for (i = 0; i < order.length; i++) {
        if (kept[i] !== undefined) Object.defineProperty(err, order[i], kept[i]);
      }
    } catch (e2) { /* an error that will not be reordered still crosses as itself */ }
    return err;
  }

  /* The frames host Node 24.15 puts under the frame of a script a context ran: its own vm entry
     point, and nothing of the caller's, which no context can know. */
  var VM_FRAMES = {
    runInContext: ['    at Script.runInContext (node:vm:149:12)',
      '    at Object.runInContext (node:vm:301:6)'],
    runInNewContext: ['    at Script.runInContext (node:vm:149:12)',
      '    at Script.runInNewContext (node:vm:154:17)',
      '    at Object.runInNewContext (node:vm:310:38)'],
    script: ['    at Script.runInContext (node:vm:149:12)'],
    scriptNew: ['    at Script.runInContext (node:vm:149:12)',
      '    at Script.runInNewContext (node:vm:154:17)']
  };

  /* The stack a script of a context carries out with it, as host Node 24.15 writes one: the file
     and the line, the line of the source, a caret, and the error under it. A script is compiled
     under the filename it was given, so the line is the one the host would name -- and this engine
     names an identifier it does not know with quotes round it, where node does not. */
  function vmDress(err, code, file, offset, frames) {
    if (!isObjectLike(err)) return err;
    try {
      if (err.name === 'ReferenceError' && typeof err.message === 'string') {
        var quoted = /^'([^']*)' is not defined$/.exec(err.message);
        if (quoted !== null) err.message = quoted[1] + ' is not defined';
      }
    } catch (dressErr) { /* an error that will not be dressed still crosses as itself */ }
    try {
      var at = /:(\d+):(\d+)/.exec(String(err.stack === undefined || err.stack === null ? '' : err.stack));
      var line = at === null ? 1 : Number(at[1]);
      var col = at === null ? 1 : Number(at[2]);
      var shown = String(code).split('\n')[line - 1 - offset];
      if (shown === undefined) shown = '';
      var name = err.name === undefined || err.name === null ? 'Error' : String(err.name);
      var stack = file + ':' + line + '\n' + shown + '\n^\n\n' + name
        + (err.message ? ': ' + err.message : '')
        + '\n    at ' + file + ':' + line + ':' + col
        + (frames === null || frames === undefined ? '' : '\n' + frames.join('\n'));
      Object.defineProperty(err, 'stack', { value: stack, writable: true, configurable: true });
    } catch (dressErr) { /* as above */ }
    return err;
  }

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

  function runInRecord(rec, code, file, offset, frames) {
    var src = vmCode(code);
    /* The code runs in the context's own realm, so what it answers -- and what it throws -- is
       already of another realm: an error out of one is no more an Error of the caller than an array
       is. The one error a context has no hand in is the ERR_SCRIPT_EXECUTION_TIMEOUT of a timeout,
       which is raised here and rehomed on its way out like any other value this realm built. */
    var out = vmEval(rec, src, file === undefined ? 'evalmachine.<anonymous>' : file, offset, frames);
    if (out !== NO_REALM) return out;
    /* No realm for this context: the code runs in this one, under a with scope over the sandbox,
       and loses the top-level bindings a realm would keep for it. */
    var fns = topLevelFunctionNames(src);
    var fnSet = Object.create(null);
    for (var i = 0; i < fns.length; i++) {
      fnSet[fns[i]] = true;
      if (!(fns[i] in rec.sb)) rec.sb[fns[i]] = undefined;
    }
    var decl = declaredNames(src);
    var scope = new Proxy(rec.sb, withHandler(rec, fnSet, decl));
    return runWrapped.call(rec.G, scope, rewriteTypeof(src), fns, rec.sb);
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
   * A value this realm built that a context hands out as one of the context's own: an object of
   * another realm, as host Node hands it back.
   *
   * The host keeps a second realm -- a second QuickJS context on the same runtime -- and rebuilds
   * the value there, so the ERR_SCRIPT_EXECUTION_TIMEOUT of a timeout answers false to
   * instanceof Error while still carrying its own code, its name and its message. A value the
   * code of a context made is already of that realm and is not rebuilt at all (see vmEval), and a
   * value the caller put into the sandbox is not rebuilt either: a copy of it would drift from the
   * original the moment either was changed, and Node hands the very same object back.
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
      callCap('vm.realm', { id: rec.id });
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
      /* Any await the line carries and no function owns, so one inside the braces of an 'if', a
         'for' or a 'try' is in: it is a statement of the line still. One inside a function or a
         class body is not, and is left to fail as the syntax error it is. */
      if (toks[q].t !== 'id' || toks[q].v !== 'await' || toks[q].fn !== 0) continue;
      var before = toks[q - 1];
      if (before !== undefined && before.t === 'punct' && before.v === '.') continue;
      awaited = true;
      break;
    }
    if (awaited !== true && templateHasAwait(src) === true) awaited = true;
    if (awaited !== true) return null;
    function noWrap() { return { awaited: true, code: null }; }

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
          /* not a comma a bracket of its own holds: the one in 'var a = await [1, 2]' is
             inside the array, and splitting on it would leave two declarators that are not */
          if (toks[c].t !== 'punct' || toks[c].v !== ',' || toks[c].depth !== 0 || toks[c].pd !== 0) continue;
          if (toks[c].pos <= first.end || toks[c].pos >= to) continue;
          cuts.push(toks[c].pos, toks[c].end);
        }
        cuts.push(to);
        var assigned = [];
        for (var d = 0; d + 1 < cuts.length; d += 2) {
          var lead = firstTokenIn(cuts[d], cuts[d + 1]);
          if (lead === null || lead.t !== 'id') return noWrap();
          var rest = src.slice(lead.end, cuts[d + 1]).replace(/^\s+/, '');
          var init = 'undefined';
          if (rest.charAt(0) === '=') init = rest.slice(1);
          else if (rest !== '') return noWrap();
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
        if (named === null || closed < 0) return noWrap();
        if (src.slice(toks[closed].end, to).replace(/\s+/g, '') !== '') return noWrap();
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
    /* The line carries an await whether or not the wrapper compiles: it is what decides how a
       syntax error out of the line is reported, even when the line is left to run as it stands. */
    return { awaited: true, code: compiles(wrapper) ? wrapper : null };
  }

  /* The spans a template's substitutions hold -- a dollar and a brace, written apart because this
     whole module is one template literal. The lexer keeps a whole template as one token, so an
     await inside one of them is no token at all and has to be looked for where it stands. */
  function templateHoles(src, start) {
    var out = [];
    var n = src.length;
    var i = start + 1;
    while (i < n) {
      var c = src.charAt(i);
      if (c === '\\') { i += 2; continue; }
      if (c === '\x60') break;
      if (c === '$' && src.charAt(i + 1) === '{') {
        var from = i + 2;
        var to = skipTemplateExpr(src, from);
        if (to < 0) break;
        out.push([from, to - 1]);
        i = to;
        continue;
      }
      i++;
    }
    return out;
  }

  /* Whether any hole of any template in the line awaits. The word is what decides and nothing
     else -- a property named await is not one, being preceded by a dot, and a longer name that
     begins with the word is not either. */
  function templateHasAwait(src) {
    var n = src.length;
    var i = 0;
    while (i < n) {
      var c = src.charAt(i);
      if (c === '\x60') {
        var holes = templateHoles(src, i);
        var past = skipTemplate(src, i + 1);
        i = past < 0 ? n : past;
        for (var h = 0; h < holes.length; h++) {
          if (/(^|[^\w$.])await(?![\w$])/.test(src.slice(holes[h][0], holes[h][1]))) return true;
        }
        continue;
      }
      if (c === '"' || c === "'") { i = skipQuoted(src, i, c); continue; }
      if (c === '/' && src.charAt(i + 1) === '/') {
        var nl = src.indexOf('\n', i);
        i = nl < 0 ? n : nl + 1;
        continue;
      }
      if (c === '/' && src.charAt(i + 1) === '*') {
        var close = src.indexOf('*/', i + 2);
        i = close < 0 ? n : close + 2;
        continue;
      }
      i++;
    }
    return false;
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
    var pos = null;
    try {
      (0, eval)(SCRIPT_PROBE + code);
    } catch (inner) {
      /* Only a line the script itself refused has a position to show: a SyntaxError a line threw
         as it ran has none, and re-running a line that ran is not a thing this may do. */
      if (isObjectLike(inner) && inner.name === 'SyntaxError') {
        var at = /<input>:(\d+):(\d+)/.exec(String(inner && inner.stack));
        if (at !== null) {
          var atLine = Number(at[1]);
          pos = { line: atLine, col: Number(at[2]) - (atLine === 1 ? SCRIPT_PROBE.length : 0) };
        }
      }
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

  /* The two halves of that header, for the one shape that prints them apart: a syntax error out of
     a line that awaits names the error above the frame and says what is wrong below it. */
  function replErrorName(err) {
    if (isObjectLike(err) && typeof err.name === 'string') return String(err.name);
    return inspectValue(err);
  }

  function replErrorMessage(err) {
    if (isObjectLike(err) && err.message !== undefined && err.message !== null && err.message !== '') {
      return String(err.message);
    }
    return replErrorName(err);
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
      /* The filename and the line offset a script is compiled under: host Node 24.15 compiles it
         with them, so the frames of the error it throws name them, and a run of the script answers
         to them unless the options of that run name their own. */
      var held = options === null || typeof options !== 'object' ? {} : options;
      Object.defineProperty(this, '_owcFile', {
        value: typeof held.filename === 'string' ? held.filename : undefined
      });
      Object.defineProperty(this, '_owcOffset', {
        value: typeof held.lineOffset === 'number' && held.lineOffset >= 0 ? held.lineOffset : 0
      });
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
      vmFired = false;
      api.vmThunk = function () {
        try { slot = { ok: true, value: run() }; } catch (err) { slot = { ok: false, error: err, fired: vmFired }; }
      };
      var outcome;
      try {
        outcome = callCap('vm.run', { timeout: timeout });
      } finally {
        api.vmThunk = undefined;
      }
      if (outcome.unbound) return run();
      /* A deadline that stopped the code of a context: host Node raises ERR_SCRIPT_EXECUTION_TIMEOUT
         in the realm of the context that overran it, and an interruption QuickJS raises inside the
         second realm reaches this catch as an ordinary throw, so what says one happened is the
         answer vm.exec gave rather than the error itself. */
      if (outcome.interrupted || (slot !== null && slot.fired === true)) {
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
      return runScript(this, recordOf(contextifiedObject), options, VM_FRAMES.script);
    };
    Script.prototype.runInNewContext = function (contextObject, options) {
      return runScript(this, recordOf(createContextObject(contextObject)), options, VM_FRAMES.scriptNew);
    };

    /* One run of a script in a context: the file and the offset the options name win over the ones
       the script was compiled with, as they do on host Node 24.15. */
    function runScript(script, rec, options, frames) {
      var code = script._owcCode;
      var file = options !== null && typeof options === 'object' && typeof options.filename === 'string'
        ? options.filename : script._owcFile;
      var offset = options !== null && typeof options === 'object' && typeof options.lineOffset === 'number'
        ? options.lineOffset : script._owcOffset;
      return vmGuarded(options, function () { return runInRecord(rec, code, file, offset, frames); }, rec);
    }
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
          '(function (' + list.join(', ') + ') {\n' + code + '\n})', undefined, 0, null);
      }
      return Function.apply(null, list.concat([code]));
    }

    /* The script a context is handed, compiled for it.
       Host Node 24.15 compiles the code of runInContext and runInNewContext inside the context it
       will run in, so the SyntaxError a bad script raises there is an error of that context and not
       of the caller: vm.runInNewContext('var y = {') answers false to (e instanceof SyntaxError),
       where new vm.Script('var y = {') -- a compile no context was named for -- answers true, and so
       does new vm.Script('var y = {').runInContext(ctx), because that one throws before the context
       is ever reached. A context here is a sandbox of the caller's own realm, so the compile is the
       caller's too; the error is rehomed on the way out, the way a value the context hands back is. */
    function scriptFor(rec, code) {
      try {
        return new Script(code);
      } catch (err) {
        throw outOfRecord(rec, err);
      }
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
      /* The context is resolved before the code is compiled, as on host Node 24.15: a bad
         context object is an ERR_INVALID_ARG_TYPE there even when the code is bad syntax too. */
      runInContext: function (code, contextifiedObject, options) {
        var rec = recordOf(contextifiedObject);
        return runScript(scriptFor(rec, code), rec, options, VM_FRAMES.runInContext);
      },
      runInNewContext: function (code, sandbox, options) {
        var rec = recordOf(createContextObject(sandbox));
        return runScript(scriptFor(rec, code), rec, options, VM_FRAMES.runInNewContext);
      },
      compileFunction: compileFunction,
      measureMemory: function () {
        /* An experimental host API: what node answers is the heap of the isolate it measured, and
           this container has no isolate of its own to measure, so the numbers are the ones the
           process reports for itself and the shape is node's. */
        var used = 0;
        try {
          var mu = typeof process === 'object' && process !== null && typeof process.memoryUsage === 'function'
            ? process.memoryUsage() : null;
          if (mu !== null && typeof mu.heapUsed === 'number') used = mu.heapUsed;
        } catch (memErr) { used = 0; }
        return Promise.resolve({ total: { jsHeapSizeUsed: used, jsHeapSizeTotal: used, physicalSize: used } });
      },
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
     * The two hooks the loader asks a domain for, as symbol-keyed properties of the instance:
     * Object.getOwnPropertyNames of a fresh domain on host node 24.15 is
     * _events,_eventsCount,_maxListeners,domain,members and nothing else, so they cannot be string
     * keys of their own, and Domain.prototype there carries exactly _errorHandler, add, bind,
     * constructor, enter, exit, intercept, members, remove and run -- ten names -- so they cannot
     * live there either. Symbol.for is the same symbol in every script of this realm, which is how
     * the loader reaches them.
     */
    var DOMAIN_UNCAUGHT = Symbol.for('owc.domain.uncaught');
    var DOMAIN_ENTERED = Symbol.for('owc.domain.entered');

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
    /*
     * A promise reaction a domain owns runs inside it, and host node 24.15 takes it out again even
     * when the reaction failed: every PROMISE resource made while process.domain is a domain is
     * paired with it in async_hooks' init, entered in before and *left* in after, and the after
     * runs for a reaction that threw as well. d.bind() has no finally -- node's Domain.prototype.run
     * is enter, call, exit -- so a throw out of the reaction skipped the leave and the process ran
     * the rest of its life inside the domain. Measured on host node 24.15 against this container
     * (adv12): a reaction that throws leaves domain._stack at 0 and process.domain at undefined
     * inside the 'error' handler and at every timer after it (h4, h5, h8), and the same is true of
     * one whose rejection is caught by its own .catch or by a later one, where no route runs at all
     * (h6, h7) -- against later-stack 1 and later-pd the domain here. The leave is the reaction's
     * own and not the route's, so it is made here: an ordinary exit(), which is what after() calls.
     *
     * It is owed at the throw and spent once the rejection has been recorded, because that is the
     * order host node 24.15 has them in: the promise's rejection is recorded -- with the domain the
     * reaction ran in -- as the job fails, and the after() that leaves the domain runs after it.
     * Leaving first lost the domain the rejection belongs to and ended the process at exit 1 where
     * host node 24.15 prints the domain's handler. The tracker spends it (see
     * _owcLeaveReactionDomain, and the call to it in the rejection tracker in node/process.ts).
     */
    var owedLeave = null;
    function spendOwedLeave() {
      var dom = owedLeave;
      owedLeave = null;
      if (dom === null) return;
      try { dom.exit(); } catch (inner) { /* a leave that cannot be made is not a new error */ }
    }
    /* A bind() made for a promise reaction and not for a caller: the marker is read while the bound
       function is built and kept in its closure, so neither the function nor its stack carries it. */
    var bindingReaction = false;
    function bindInDomain(dom, cb) {
      if (typeof cb !== 'function') return cb;
      var prior = bindingReaction;
      bindingReaction = true;
      try {
        return dom.bind(cb);
      } finally {
        bindingReaction = prior;
      }
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

    /*
     * Node's own updateExceptionCapture (lib/domain.js), run on every enter, every exit, every
     * clear and on the 'newListener' and 'removeListener' events of every domain: the uncaught-
     * exception capture callback is registered only while a domain on the stack listens for
     * 'error', and it is dropped otherwise. Two measurements hang on the exact moment it runs.
     * The event fires *before* the listener is added, so a domain that is entered and only then
     * given an 'error' listener still answers hasUncaughtExceptionCaptureCallback() false --
     * d.enter(); d.on('error', fn) is false on host node 24.15 and was true here. And a domain
     * entered with no 'error' listener of its own keeps the callback off, which is what sends the
     * error on to an 'uncaughtException' listener instead.
     */
    function updateExceptionCapture() {
      if (typeof process !== 'object' || process === null) return;
      if (typeof process.setUncaughtExceptionCaptureCallback !== 'function') return;
      var listening = false;
      for (var i = 0; i < stack.length; i++) {
        if (stack[i].listenerCount('error') !== 0) { listening = true; break; }
      }
      process.setUncaughtExceptionCaptureCallback(null);
      if (listening) process.setUncaughtExceptionCaptureCallback(captureUncaught);
    }

    function setActive(d) {
      exp.active = d;
      if (typeof process === 'object' && process !== null) {
        process.domain = d;
        updateExceptionCapture();
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
    /* the leave a promise reaction that threw owes the domain it ran in: see bindInDomain above, and
       the rejection tracker that spends it in node/process.ts */
    if (typeof process === 'object' && process !== null && typeof process._owcLeaveReactionDomain !== 'function') {
      Object.defineProperty(process, '_owcLeaveReactionDomain', { value: spendOwedLeave, writable: true, configurable: true });
    }

    /*
     * The listener host node 24.15 puts first on every process 'uncaughtException' list while the
     * domain module is loaded (lib/domain.js): it empties the stack and puts process.domain back to
     * null, which is why a handler that receives an error reads null and not the undefined an
     * ordinary leave writes. It is added on 'newListener' and dropped on 'removeListener', so it is
     * never the only listener and never last. Measured on host node 24.15 (adv12): a rejection a
     * silent domain owns while that domain is entered falls through to an 'uncaughtException'
     * listener, and there process.domain is null, the stack 0 and a later timer null too, where
     * this container left the domain entered (h3); the same fall-through after the domain was
     * already left read null on the host and undefined here (f06, f10).
     */
    if (typeof process === 'object' && process !== null
      && typeof process.on === 'function' && typeof process.prependListener === 'function'
      && typeof process.removeListener === 'function') {
      var clearOnProcess = function () { clearDomains(); };
      process.on('newListener', function (name, listener) {
        if (name !== 'uncaughtException' || listener === clearOnProcess) return;
        process.removeListener(name, clearOnProcess);
        process.prependListener(name, clearOnProcess);
      });
      process.on('removeListener', function (name, listener) {
        if (name !== 'uncaughtException' || listener === clearOnProcess) return;
        var left = typeof process.listeners === 'function' ? process.listeners(name) : [];
        if (left.length === 1 && left[0] === clearOnProcess) process.removeListener(name, clearOnProcess);
      });
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
      /*
       * The two hooks the loader asks a domain for, under the symbol keys named above.
       */
      var self = this;
      /* node's own shape for a fresh domain: a non-enumerable, writable domain of null */
      Object.defineProperty(this, 'domain', { value: null, writable: true, enumerable: false, configurable: true });
      Object.defineProperty(this, DOMAIN_UNCAUGHT, {
        value: function (err) { return uncaughtInDomain(self, err); },
        writable: true,
        configurable: true
      });
      Object.defineProperty(this, DOMAIN_ENTERED, {
        get: function () { return stack.lastIndexOf(self) !== -1; },
        configurable: true
      });
      /*
       * The two listeners node's own Domain constructor registers, and the reason a fresh domain on
       * host node 24.15 is not the empty emitter this container used to build: _eventsCount is 2,
       * eventNames() answers 'newListener,removeListener' and each has one listener, and adding an
       * 'error' listener makes three. They are also what runs updateExceptionCapture whenever a
       * listener comes or goes.
       */
      this.on('removeListener', updateExceptionCapture);
      this.on('newListener', updateExceptionCapture);
    }
    Domain.prototype = Object.create(EventEmitter.prototype);
    Object.defineProperty(Domain.prototype, 'constructor', { value: Domain, writable: true, configurable: true });
    /* node's own shape: an enumerable, writable, configurable members with no value yet, shadowed by every instance */
    Domain.prototype.members = undefined;

    /*
     * The route an error with no caller takes, under the name host node 24.15 gives it: lib/domain.js
     * puts _errorHandler on Domain.prototype and reaches it from process._fatalException. Host node
     * 24.15 has no Domain.prototype.dispose at all -- it was removed -- and this container's own
     * machinery is on the instance, so the prototype's own names are node's ten.
     */
    Domain.prototype._errorHandler = function (er) { return uncaughtInDomain(this, er); };

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
     * The order these names go onto the prototype is the one host node 24.15's own source gives
     * them -- members, _errorHandler, enter, exit, add, remove, run, intercept, bind -- which is the
     * order Object.keys(Domain.prototype) reads them in there.
     */
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
        /* what is left below every entry of dom: the domains the route leaves entered */
        var outerLeft = stack.length;
        if (isObjectLike(err)) {
          Object.defineProperty(err, 'domain', { value: dom, writable: true, configurable: true });
          err.domainThrown = true;
        }
        /*
         * A handler that throws is host node 24.15's own shape (lib/domain.js): the throw is
         * offered to the domain left on top of the stack -- an inner domain's handler throwing
         * prints the outer domain's handler and the process runs on -- and with nothing left it is
         * thrown out of process._fatalException, which node answers with the fatal "the internal
         * exception handler threw" and the status 7, not 1. Measured on host node 24.15 (n17,
         * b17, c17, c18, and the two-deep shape): DOMAIN=c17 and nothing after it, exit 7.
         */
        try {
          dom.emit('error', err);
        } catch (er2) {
          updateExceptionCapture();
          if (stack.length > 0) {
            var outer = stack[stack.length - 1];
            setActive(outer);
            return uncaughtInDomain(outer, er2);
          }
          clearDomains();
          /*
           * Nothing is left to receive it, so the status is the one node gives a fatal exception
           * whose own handler threw: 7. reallyExit writes it and ends the run without waiting for
           * anything -- host node 24.15 runs no 'exit' handler on this path either -- and the exit
           * code goes on process as well, because that is what the run leaves with.
           */
          if (typeof process === 'object' && process !== null) {
            try { process.exitCode = 7; } catch (inner) { /* a status that cannot be written */ }
            if (typeof process.reallyExit === 'function') process.reallyExit(7);
          }
          throw er2;
        }
        clearDomains();
        /*
         * The idle value host node 24.15 settles on is null -- that is what
         * domainUncaughtExceptionClear writes -- with one shape excepted: when a domain was still
         * entered *below* the one that handled the error, a later timer reads process.domain and
         * domain.active as undefined, not null. Measured on host node 24.15: one domain entered, a
         * later timer reads null (and so does a nextTick); two entered and the inner one handling
         * it, the same timer reads undefined and so does every one after it; two entered with the
         * *outer* one handling it -- the inner one has no 'error' listener -- it reads null again.
         * The undefined arrives after the ticks of the tick that ran the route -- a nextTick
         * scheduled before the throw still reads null -- so the flag is left for the driver to
         * spend when the next timer is due, which is where host node 24.15 has it.
         *
         * "Below" is a second domain, not a second entry of the same one: a timer the domain owns
         * calling d.bind(...) puts that domain on the stack twice -- the driver's bind plus the
         * one bind's runInDomain does -- and host node 24.15 pops every duplicate and settles on
         * null, not undefined (measured: b06, t05, t07, v1, v3).
         *
         * Nor does the handling domain have to be the innermost one. Host node 24.15 reaches
         * _errorHandler through process.domain and, when that domain has no 'error' listener,
         * recurses outward -- EventEmitter rethrows the error and the catch hands it to
         * stack[stack.length-1] -- so what is left below the domain that ends up handling it is
         * what decides the idle value, whichever link of the chain that domain is. Three domains
         * entered with only the middle one listening: host node 24.15 reads undefined and so did
         * this container before, which read null because it asked only about the innermost link
         * (measured: a7, a22, a23, a27, a29, a31).
         */
        if (index > 0 && outerLeft > 0 && typeof process === 'object' && process !== null) {
          Object.defineProperty(process, '_owcIdleUndefined', { value: true, writable: true, configurable: true });
        }
        return true;
      }
      /*
       * Nothing in the chain listens, so the process gets the error -- and it gets it with the
       * domain still entered, because host node 24.15 never leaves it here.
       *
       * Domain.prototype._errorHandler -- the route that ends with domainUncaughtExceptionClear --
       * is only ever reached through the uncaught-exception capture callback, and that callback is
       * off while no domain on the stack listens for 'error'. So what empties the stack on the way
       * to an 'uncaughtException' listener is not the route at all: it is the listener lib/domain.js
       * prepends, and it is prepended by the 'newListener' handler this module installs when it is
       * loaded -- so it is absent whenever every 'uncaughtException' listener was registered before
       * require('domain'), and host node 24.15 then hands the error over with the domain entered
       * and leaves it entered for the rest of the process. Measured on host node 24.15 (n08, d02,
       * d03): pd-in-uc=d / stack-in-uc=1 and a timer that fires afterwards reads pd=d / stack=1,
       * against null and 0 here. Clearing here is what broke those three; the prepended listener
       * above clears whenever node's does.
       *
       * Measured on host node 24.15: a timer bound to a domain that has no 'error' listener,
       * throwing with an 'uncaughtException' listener registered *after* require('domain'), prints
       * that handler with domain._stack at 0, process.domain not the domain and
       * hasUncaughtExceptionCaptureCallback() false, and a timer that fires afterwards runs outside
       * the domain -- the prepended listener's doing, not the route's.
       */
      return false;
    }
    /* the two hooks above are defined on the instance, in Domain(), not here */

    Domain.prototype.run = function (fn) {
      installDomainPromiseHook();
      return runInDomain(this, fn, this, Array.prototype.slice.call(arguments, 1));
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

    Domain.prototype.bind = function (cb) {
      var self = this;
      installDomainPromiseHook();
      var isReaction = bindingReaction;
      function runBound() {
        if (!isReaction) return runInDomain(self, cb, this, Array.prototype.slice.call(arguments));
        spendOwedLeave();
        try {
          return runInDomain(self, cb, this, Array.prototype.slice.call(arguments));
        } catch (err) {
          /* the leave a reaction that threw owes is spent by the rejection tracker: see bindInDomain */
          owedLeave = self;
          throw err;
        }
      }
      Object.defineProperty(runBound, 'domain', { value: this, writable: true, configurable: true });
      return runBound;
    };

    // Emitters bound with add() route unhandled 'error' events to their domain.
    var eeEmit = EventEmitter.prototype.emit;
    EventEmitter.prototype.emit = function emit() {
      var args = Array.prototype.slice.call(arguments);
      var dom = this.domain;
      var type = args[0];
      if (type !== 'error' || this === process || !(dom instanceof Domain) || this.listenerCount('error') > 0) {
        /*
         * The other half of an emitter a domain owns: host node 24.15 (lib/domain.js) runs the
         * listeners of every event but 'error' -- which has the route below -- *inside* that
         * domain, and does it the way topLevelDomainCallback does: enter, emit, exit, with no
         * finally, so a listener that throws leaves the domain entered for the uncaught route to
         * find. An 'error' with a listener of its own, an emitter no domain owns and process
         * itself are the three shapes it leaves alone. Measured on host node 24.15 (m3, m10,
         * p07): the listener reads process.domain as the domain that owns the emitter where this
         * container read null, and the leave that exit writes is what a timer that fires later
         * reads -- undefined on the host, the null the uncaught route wrote here -- which is why
         * an emit with no listener at all moves that value too.
         */
        if (type !== 'error' && this !== process && dom instanceof Domain) {
          dom.enter();
          var ret = eeEmit.apply(this, args);
          dom.exit();
          return ret;
        }
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

  /*
   * The domains the Chrome DevTools Protocol defines. A method of one of these this runtime cannot
   * answer is an unimplemented one; a method of any other is a name the protocol has never heard of,
   * which a host refuses differently.
   */
  var PROTOCOL_DOMAINS = {
    Accessibility: true, Animation: true, Audits: true, BackgroundService: true, Browser: true,
    CSS: true, CacheStorage: true, Cast: true, Console: true, DOM: true, DOMDebugger: true,
    DOMSnapshot: true, Database: true, Debugger: true, DeviceAccess: true, DeviceOrientation: true,
    Emulation: true, EventBreakpoints: true, FedCm: true, HeadlessExperimental: true, HeapProfiler: true,
    IO: true, IndexedDB: true, Input: true, Inspector: true, LayerTree: true, Log: true, Media: true,
    Memory: true, Network: true, NodeRuntime: true, NodeTracing: true, NodeWorker: true, Overlay: true,
    Page: true, Performance: true, Preload: true, Profiler: true, Runtime: true, Schema: true,
    Security: true, ServiceWorker: true, Storage: true, SystemInfo: true, Target: true, Tethering: true,
    Tracing: true, WebAudio: true, WebAuthn: true
  };
  /* The commands the protocol defines for the six domains a caller asks about here. A command a
     domain does not define is not an unimplemented one, and a host says so with the protocol's own
     'wasn't found' rather than with the answer it gives for a command it has and cannot run:
     Runtime.noSuchMethod is -32601 on a host, and so is Bogus.method, while Debugger.enable is a
     real command this runtime has no debugger for. Only a domain named here has a list to check a
     method against; a method of any other domain is answered as it always was.
     row owc-inspector-returnbyvalue-notifications. */
  var PROTOCOL_METHODS = {
    Runtime: ['addBinding', 'awaitPromise', 'callFunctionOn', 'compileScript', 'disable',
      'discardConsoleEntries', 'enable', 'evaluate', 'getExceptionDetails', 'getHeapUsage',
      'getIsolateId', 'getProperties', 'globalLexicalScopeNames', 'queryObjects', 'releaseObject',
      'releaseObjectGroup', 'removeBinding', 'runIfWaitingForDebugger', 'runScript',
      'setAsyncCallStackDepth', 'setCustomObjectFormatterEnabled', 'setMaxCallStackSizeToCapture',
      'terminateExecution'],
    Debugger: ['continueToLocation', 'enable', 'disable', 'evaluateOnCallFrame', 'getPossibleBreakpoints',
      'getScriptSource', 'getStackTrace', 'pause', 'removeBreakpoint', 'restartFrame', 'resume',
      'searchInContent', 'setAsyncCallStackDepth', 'setBlackboxedRanges', 'setBlackboxPatterns',
      'setBreakpoint', 'setBreakpointByUrl', 'setBreakpointsActive', 'setBreakpointOnFunctionCall',
      'setInstrumentationBreakpoint', 'setPauseOnExceptions', 'setReturnValue', 'setScriptSource',
      'setSkipAllPauses', 'setVariableValue', 'stepInto', 'stepOut', 'stepOver'],
    Profiler: ['disable', 'disableCounters', 'disableRuntimeCallStats', 'enable', 'enableCounters',
      'enableRuntimeCallStats', 'getBestEffortCoverage', 'setCounterSamplingInterval',
      'setSamplingInterval', 'start', 'startPreciseCoverage', 'startTypeProfile', 'stop',
      'stopPreciseCoverage', 'stopTypeProfile', 'takePreciseCoverage', 'takeTypeProfile'],
    HeapProfiler: ['addInspectedHeapObject', 'collectGarbage', 'disable', 'enable', 'getHeapObjectId',
      'getObjectByHeapObjectId', 'getSamplingProfile', 'startSampling', 'startTrackingHeapObjects',
      'stopSampling', 'stopTrackingHeapObjects', 'takeHeapSnapshot'],
    Network: ['addBlockedURL', 'canClearBrowserCache', 'canClearBrowserCookies', 'canEmulateNetworkConditions',
      'clearBrowserCache', 'clearBrowserCookies', 'continueInterceptedRequest', 'deleteCookies', 'disable',
      'emulateNetworkConditions', 'enable', 'enableReportingApi', 'getAllCookies', 'getCertificate',
      'getCookies', 'getRequestPostData', 'getResponseBody', 'getSecurityIsolationStatus',
      'loadNetworkResource', 'replayXHR', 'removeBlockedURL', 'requestPostData', 'searchInResponseBody',
      'setAcceptedEncodings', 'setAttachDebugStack', 'setBlockedURLs', 'setBypassServiceWorker',
      'setCacheDisabled', 'setCookie', 'setCookieControlsEnabled', 'setExtraHTTPHeaders',
      'setMonitoringXHR', 'setRequestInterception', 'setUserAgentOverride', 'streamResource'],
    NodeRuntime: ['awaitAllPromise', 'cancelWaitForWorkerShutdown', 'getArgs', 'getEnv',
      'notifyWhenWaitingForDisconnect', 'startAsyncInstrumentation', 'stopAsyncInstrumentation',
      'waitForWorkerShutdown']
  };
  var PROTOCOL_METHOD_SETS = Object.create(null);
  Object.keys(PROTOCOL_METHODS).forEach(function (domain) {
    var set = Object.create(null);
    var list = PROTOCOL_METHODS[domain];
    for (var at = 0; at < list.length; at++) set[list[at]] = true;
    PROTOCOL_METHOD_SETS[domain] = set;
  });

  // ---- inspector ----

  BF['inspector'] = function () {
    var EventEmitter = requireBuiltin('events');
    var exp = {};

    /*
     * The protocol's own events, which a session reads off 'inspectorNotification': a host emits
     * Runtime.executionContextCreated when Runtime is enabled and Runtime.consoleAPICalled for
     * everything the program writes to the console while it is. This runtime has no debugger behind
     * the protocol, but it does have the console, so the two events that need nothing but a running
     * program are emitted -- and a session that has not enabled Runtime is told nothing, as on a
     * host. What a host cannot reproduce here is named in the Readme: the context name carries the
     * pid, and an event carries a timestamp and a stack trace.
     */
    var enabledSessions = [];
    var connectedSessions = [];
    var consoleHooked = false;
    var CONSOLE_TYPES = { log: 'log', info: 'info', warn: 'warning', error: 'error', debug: 'debug' };

    /* exceptionId and scriptId are the protocol's own serials. A host numbers the exceptions it
       reports from 1 and goes on numbering them for as long as the isolate lives: a second session
       does not start again, so two sessions that throw once each report 1 and 2. Every script it
       compiles gets an id of its own, and Runtime.evaluate compiles one per call, so a session
       that evaluates six expressions hands out six. Both are opaque to whoever reads them -- they
       are keys into the protocol's own tables, and no caller computes with them -- and both are
       this runtime's numbering, exactly as V8's are V8's: they start where this runtime's owns
       scripts and reported exceptions leave them, and no two runs agree on the number itself.
       row owc-inspector-returnbyvalue-notifications. */
    var exceptionSerial = 0;
    var scriptSerial = 0;
    function nextExceptionId() { exceptionSerial += 1; return exceptionSerial; }
    function nextScriptId() { scriptSerial += 1; return String(scriptSerial); }

    function notify(session, method, params) {
      try {
        /* A host fires one notification on two channels: 'inspectorNotification' carries the
           protocol's own envelope, and an event named after the method itself carries nothing but
           its params -- which is the one a caller that writes
           session.on('Runtime.consoleAPICalled', fn) is listening on, and which was the only channel
           this runtime did not fire. row owc-inspector-returnbyvalue-notifications. */
        session.emit('inspectorNotification', { method: method, params: params });
        session.emit(method, params);
      } catch (err) {
        // a listener that throws must not stop the program that wrote the line
      }
    }

    function hookConsole() {
      if (consoleHooked) return;
      consoleHooked = true;
      Object.keys(CONSOLE_TYPES).forEach(function (name) {
        var original = globalThis.console[name];
        if (typeof original !== 'function') return;
        globalThis.console[name] = function () {
          var args = Array.prototype.slice.call(arguments);
          var type = CONSOLE_TYPES[name];
          for (var i = 0; i < connectedSessions.length; i++) {
            var event = {
              type: type,
              args: args.map(function (arg) { return remoteObjectOf(arg, { noId: true }); }),
              executionContextId: 1
            };
            var session = connectedSessions[i];
            if (enabledSessions.indexOf(session) >= 0) notify(session, 'Runtime.consoleAPICalled', event);
            else if (session._owcPending.length < 1000) session._owcPending.push(event);
          }
          return original.apply(this, args);
        };
      });
    }

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
      /* A host starts recording the console the moment a session connects and hands the session
         what it recorded when Runtime is enabled, so the lines a program wrote in between are not
         lost -- they are the first Runtime.consoleAPICalled events the session sees. */
      this._owcPending = [];
      hookConsole();
      if (connectedSessions.indexOf(this) < 0) connectedSessions.push(this);
    };

    Session.prototype.connectToMainThread = function () {
      throw nodeError(Error, 'ERR_INSPECTOR_NOT_WORKER', 'Current thread is not a worker');
    };

    Session.prototype.disconnect = function () {
      var at = enabledSessions.indexOf(this);
      if (at >= 0) enabledSessions.splice(at, 1);
      var where = connectedSessions.indexOf(this);
      if (where >= 0) connectedSessions.splice(where, 1);
      this._owcPending = [];
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

    /* An object the protocol hands an id out for is reachable only through that id: the objectId a
       Runtime.evaluate without returnByValue answers with is the one Runtime.getProperties is
       called back with, and without it that half of the protocol cannot be reached at all. The
       object is therefore kept here for as long as the session lives. The id is three dot-separated
       numbers, the shape a host's has -- its first is a V8 isolate's own serial, which no two runs
       of a host agree on either. row owc-inspector-returnbyvalue-notifications. */
    var remoteObjects = [];
    function objectIdOf(value) {
      for (var i = 0; i < remoteObjects.length; i++) if (remoteObjects[i] === value) return '1.1.' + (i + 1);
      remoteObjects.push(value);
      return '1.1.' + remoteObjects.length;
    }
    function objectForId(id) {
      var parts = String(id).split('.');
      var at = Number(parts[parts.length - 1]);
      if (!(at >= 1 && at <= remoteObjects.length)) return undefined;
      return remoteObjects[at - 1];
    }
    function classNameOf(value) {
      return value && value.constructor && typeof value.constructor.name === 'string'
        ? value.constructor.name : 'Object';
    }
    /* A host describes an object it has handed an id out for by its class -- 'Object', not the
       '{ x: 1, y: 2 }' it would print -- and an array by its length. An error is the exception:
       what V8 describes there is the error's own text, stack and all. */
    function descriptionOf(value) {
      if (value instanceof Error) return inspectValue(value);
      if (Array.isArray(value)) return 'Array(' + value.length + ')';
      return classNameOf(value);
    }
    function propertiesOf(value) {
      var out = [];
      var names = Object.getOwnPropertyNames(value);
      for (var i = 0; i < names.length; i++) {
        var described = Object.getOwnPropertyDescriptor(value, names[i]);
        out.push({
          name: names[i],
          value: remoteObjectOf(described.value),
          writable: !!described.writable,
          configurable: !!described.configurable,
          enumerable: !!described.enumerable,
          isOwn: true
        });
      }
      return out;
    }
    function previewValueOf(value) {
      if (value === undefined) return undefined;
      if (typeof value === 'string') return value;
      return String(value);
    }
    function previewOf(value) {
      var names = Object.keys(value);
      var limit = names.length > 100 ? 100 : names.length;
      var shown = [];
      for (var i = 0; i < limit; i++) {
        var ro = remoteObjectOf(value[names[i]], { noId: true });
        shown.push({ name: names[i], type: ro.type, value: previewValueOf(value[names[i]]) });
      }
      return { type: 'object', description: descriptionOf(value), overflow: names.length > limit, properties: shown };
    }

    function remoteObjectOf(value, options) {
      var withId = !(options && options.noId === true);
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
      if (kind === 'function') {
        var asFunction = { type: 'function', className: 'Function', description: inspectValue(value) };
        if (withId) asFunction.objectId = objectIdOf(value);
        return asFunction;
      }
      var described = { type: 'object', className: classNameOf(value), description: descriptionOf(value) };
      if (Array.isArray(value)) described.subtype = 'array';
      else if (value instanceof Error) described.subtype = 'error';
      if (withId) described.objectId = objectIdOf(value);
      return described;
    }

    /* A value with a cycle in it has no JSON form at all, and a host refuses to hand one back by
       value rather than answering with a description of it: -32000, 'Object reference chain is too
       long', and no result. The cycle is found by walking the value with the objects already on the
       path held beside it, and not by letting JSON.stringify throw, because a value that fails to
       serialise for any other reason still comes back described -- a getter that throws, say -- and
       a host answers that one with the described form.
       row owc-inspector-returnbyvalue-notifications. */
    function hasCycleOf(value) {
      var path = [];
      function walk(inner) {
        if (inner === null || typeof inner !== 'object') return false;
        if (path.indexOf(inner) >= 0) return true;
        path.push(inner);
        var names;
        try {
          names = Object.getOwnPropertyNames(inner);
        } catch (errNames) {
          names = [];
        }
        for (var i = 0; i < names.length; i++) {
          var described;
          try {
            described = Object.getOwnPropertyDescriptor(inner, names[i]);
          } catch (errDescriptor) {
            described = undefined;
          }
          if (described === undefined || described.get !== undefined) continue;
          if (walk(described.value)) return true;
        }
        path.pop();
        return false;
      }
      return walk(value);
    }
    function cycleErrorOf(value, byValue) {
      if (byValue !== true || !hasCycleOf(value)) return undefined;
      return nodeError(Error, 'ERR_INSPECTOR_COMMAND',
        'Inspector error -32000: Object reference chain is too long');
    }

    /*
     * The same object under returnByValue, which the protocol answers with the value itself rather
     * than with a description of it: a host hands back the value of ({a:1}) with the flag and its
     * className and description without it. A function has no JSON form at all, so it comes back as
     * the empty object a host gives for one, and a value JSON cannot carry -- a cycle, a getter that
     * throws -- falls back to the described form rather than failing the evaluate.
     * the described form rather than failing the evaluate.
     */
    function returnByValueOf(value) {
      if (value === undefined) return { type: 'undefined' };
      if (value === null) return { type: 'object', subtype: 'null', value: null };
      var kind = typeof value;
      if (kind === 'number' || kind === 'string' || kind === 'boolean' || kind === 'bigint'
        || kind === 'symbol') return remoteObjectOf(value);
      if (kind === 'function') return { type: 'function', value: {} };
      var asJson;
      try {
        asJson = JSON.parse(JSON.stringify(value));
      } catch (err) {
        return remoteObjectOf(value);
      }
      /* A value whose JSON form is not an object at all -- a Date, which JSON writes as a string --
         is one V8 hands back as the empty object rather than as that string. */
      if (asJson === null || typeof asJson !== 'object') return { type: 'object', value: {} };
      return { type: 'object', value: asJson };
    }

    /* The column an uncaught throw is attributed to is the column of its own throw keyword: a host
       points the exceptionDetails at the statement that threw rather than at the value it threw,
       so '  throw x' is 2, and a throw inside a function the expression calls is where that
       function's keyword sits -- '(function(){ throw new Error("q") })()' is 13. The token is read
       off the expression itself, skipping the string, template and comment text a throw spelled
       inside is not one; -1 is the answer for an expression with no throw in it at all, which is
       the only case in which the column comes from the error instead. */
    var THROW_WORD = 'throw';
    var QUOTE_TICK = String.fromCharCode(96);
    var isNameChar = /[A-Za-z0-9_$]/;
    function throwColumnOf(expression) {
      var text = String(expression);
      var len = text.length;
      var at = 0;
      while (at < len) {
        var ch = text.charAt(at);
        /* A string, a template or a comment is skipped whole: a throw spelled inside one is text,
           and the first one outside them is the statement the exception belongs to. */
        if (ch === '"' || ch === "'" || ch === QUOTE_TICK) {
          var quote = ch;
          at++;
          while (at < len) {
            var inside = text.charAt(at);
            if (inside === '\\') { at += 2; continue; }
            if (inside === quote) { at++; break; }
            at++;
          }
          continue;
        }
        if (ch === '/' && text.charAt(at + 1) === '/') {
          while (at < len && text.charAt(at) !== '\n') at++;
          continue;
        }
        if (ch === '/' && text.charAt(at + 1) === '*') {
          at += 2;
          while (at < len && !(text.charAt(at) === '*' && text.charAt(at + 1) === '/')) at++;
          at += 2;
          continue;
        }
        /* throw is a word of its own: the character in front of it and the one after it are not
           parts of a name, or the word is inside one -- 'athrow' and 'throws' are not it. */
        if (text.slice(at, at + 5) === THROW_WORD
          && !isNameChar.test(at === 0 ? '' : text.charAt(at - 1))
          && !isNameChar.test(text.charAt(at + 5))) {
          return at;
        }
        at++;
      }
      return -1;
    }

    /* An error the engine raises itself -- a property read off null, a name that is not defined --
       is one no throw statement is behind, and the position a host reports for it is the one in
       the engine's own stack: 'null.z' is 'at <eval> (<input>:1:5)' and 5 is the column a host
       answers for it, as '({}).a.b' is 1:7 and 7. The frame says nothing when the error came out
       of a native function instead -- 'at parse (native)' -- and there is no column to report
       then, so it stays 0. row owc-inspector-returnbyvalue-notifications */
    function columnOf(error, expression) {
      var throwAt = throwColumnOf(expression);
      if (throwAt >= 0) return throwAt;
      var stack = error && error.stack ? String(error.stack) : '';
      var frame = /:(\d+):(\d+)/.exec(stack.split('\n')[0] || '');
      return frame ? Number(frame[2]) : 0;
    }

    function evaluateForInspector(params, scriptId) {
      /* Two requests the protocol answers before it evaluates anything: one with no expression at
         all, which is -32602, and one naming a context this runtime has not created, which is
         -32000 -- a host does not quietly evaluate it in the only context there is.
         row owc-inspector-returnbyvalue-notifications. */
      if (params === undefined || params === null || typeof params.expression !== 'string') {
        return { protocolError: nodeError(Error, 'ERR_INSPECTOR_COMMAND', 'Inspector error -32602: Invalid parameters') };
      }
      if (params.contextId !== undefined && params.contextId !== null && params.contextId !== 1) {
        return { protocolError: nodeError(Error, 'ERR_INSPECTOR_COMMAND',
          'Inspector error -32000: Cannot find context with specified id') };
      }
      var expression = params.expression;
      var byValue = params.returnByValue === true;
      var preview = params.generatePreview === true;
      var evaluated;
      try {
        evaluated = (0, eval)(expression);
      } catch (err) {
        /* A host answers a throwing expression with the exceptionDetails and with a result holding
           the value that was thrown, which is what a caller that reads result alone sees. */
        return {
          result: remoteObjectOf(err),
          exceptionDetails: {
            exception: remoteObjectOf(err),
            text: 'Uncaught',
            lineNumber: 0,
            columnNumber: columnOf(err, expression),
            exceptionId: nextExceptionId(),
            scriptId: scriptId
          }
        };
      }
      /* A symbol has no JSON form at all, and a host refuses to hand one back by value: it answers
         -32000 and no result, where this answered with a description of the symbol. */
      if (byValue && typeof evaluated === 'symbol') {
        return { protocolError: nodeError(Error, 'ERR_INSPECTOR_COMMAND',
          'Inspector error -32000: Object couldn\'t be returned by value') };
      }
      /* A cyclic value under returnByValue: a host refuses it with -32000 rather than answering a
         description of it. Checked before the promise is awaited and again when it settles, since
         what has to have no cycle in it is the value the caller is handed. */
      var cyclic = cycleErrorOf(evaluated, byValue);
      if (cyclic !== undefined) return { protocolError: cyclic };
      /* awaitPromise: a host settles the promise before it answers, so the result is the value the
         promise resolves to -- or the exceptionDetails of the value it rejects with -- and the
         answer waits for it, the one case in which post cannot call back synchronously. */
      if (params && params.awaitPromise === true && evaluated
        && (typeof evaluated === 'object' || typeof evaluated === 'function')
        && typeof evaluated.then === 'function') {
        return { thenable: evaluated, byValue: byValue, preview: preview, scriptId: scriptId, expression: expression };
      }
      return { result: remoteResultOf(evaluated, byValue, preview) };
    }

    function remoteResultOf(value, byValue, preview) {
      var out = byValue ? returnByValueOf(value) : remoteObjectOf(value);
      /* generatePreview: a host answers with the object's own enumerable entries under a preview,
         and stops at a hundred of them, which is what overflow reports. */
      if (preview && !byValue && out.type === 'object' && out.subtype !== 'null') out.preview = previewOf(value);
      return out;
    }

    /* A host's post calls back from inside the call, which is what puts a callback's own output
       before the line the program writes after it; deferring it to a timer, as this did, reorders
       every program that posts in a loop. */
    function deliver(done, error, result) {
      if (typeof done !== 'function') return;
      done(error, result);
    }

    function settleEvaluation(done, request, value, thrown) {
      if (thrown) {
        /* A promise that rejects is not a statement that threw: a host words it 'Uncaught
           (in promise)' and follows that, for an error and for nothing else, with the error's own
           name and message -- a rejection with 42 in it is the bare words. Its column and script
           id are the same as any other exception's here, and a host's own are not one thing: the
           rejection is the first evaluate of a session and it answers 0 and null, the same
           expression evaluated before it and it answers the column and the id of the script that
           created it, so what is stable about it is the wording and nothing else. */
        var promised = 'Uncaught (in promise)';
        if (value instanceof Error) promised += ' ' + String(value.name) + ': ' + String(value.message);
        deliver(done, null, {
          exceptionDetails: {
            exception: remoteObjectOf(value),
            text: promised,
            lineNumber: 0,
            columnNumber: columnOf(value, request.expression),
            exceptionId: nextExceptionId(),
            scriptId: request.scriptId
          }
        });
        return;
      }
      var settledCycle = cycleErrorOf(value, request.byValue);
      if (settledCycle !== undefined) return deliver(done, settledCycle, undefined);
      deliver(done, null, { result: remoteResultOf(value, request.byValue, request.preview) });
    }

    Session.prototype.post = function (method, params, callback) {
      if (typeof method !== 'string') throw argError('method', 'of type string', method);
      if (typeof params === 'function') {
        callback = params;
        params = undefined;
      }
      if (!this._owcConnected) throw nodeError(Error, 'ERR_INSPECTOR_NOT_CONNECTED', 'Session is not connected');
      if (method === 'Runtime.evaluate') {
        var outcome = evaluateForInspector(params, nextScriptId());
        /* A request the protocol refuses outright answers with the error alone: no result, and no
           exceptionDetails, which is what distinguishes it from an expression that threw. */
        if (outcome.protocolError !== undefined) {
          deliver(callback, outcome.protocolError, undefined);
          return undefined;
        }
        if (outcome.thenable === undefined) {
          deliver(callback, null, outcome);
          return undefined;
        }
        var settle = function (value, thrown) { settleEvaluation(callback, outcome, value, thrown); };
        try {
          outcome.thenable.then(function (v) { settle(v, false); }, function (err) { settle(err, true); });
        } catch (errSettling) {
          settle(errSettling, true);
        }
        return undefined;
      }
      /* Runtime.getProperties is the other half of the objectId above: the own entries of the object
         the id names, each one as the protocol describes a value. An id this session never handed
         out names nothing, which is the empty answer a host gives for one. */
      if (method === 'Runtime.getProperties') {
        var asked = params && params.objectId !== undefined ? objectForId(params.objectId) : undefined;
        /* An id this session never handed out names no object at all, and a host says so with the
           protocol's own error rather than with an empty answer: -32000, and no result. */
        if (asked === undefined) {
          deliver(callback, nodeError(Error, 'ERR_INSPECTOR_COMMAND',
            'Inspector error -32000: Cannot find context with specified id'), undefined);
          return undefined;
        }
        deliver(callback, null, { result: propertiesOf(asked), internalProperties: [] });
        return undefined;
      }
      if (method === 'Runtime.enable' || method === 'Runtime.disable' || method === 'Runtime.runIfWaitingForDebugger') {
        if (method === 'Runtime.enable') {
          if (enabledSessions.indexOf(this) < 0) enabledSessions.push(this);
          hookConsole();
          notify(this, 'Runtime.executionContextCreated', {
            context: { id: 1, origin: '', name: 'node[' + globalThis.process.pid + ']', auxData: { isDefault: true } }
          });
          /* What the console wrote while the session was connected but Runtime was not: a host
             delivers these first, in the order they were written. */
          var pending = this._owcPending || [];
          this._owcPending = [];
          for (var pendingAt = 0; pendingAt < pending.length; pendingAt++) {
            notify(this, 'Runtime.consoleAPICalled', pending[pendingAt]);
          }
        } else if (method === 'Runtime.disable') {
          var at = enabledSessions.indexOf(this);
          if (at >= 0) enabledSessions.splice(at, 1);
        }
        deliver(callback, null, {});
        return undefined;
      }
      /* Runtime.callFunctionOn: the declaration is compiled and called here, in the realm the
         program runs in, against the object the objectId names -- or with no receiver when the
         caller gave none -- and what comes back is the value it returned, described the way a
         Runtime.evaluate result is. A declaration that is not a function at all, or that throws
         when it is called, is answered the way a host answers it: -32602 for the one, and the
         exceptionDetails plus the thrown value for the other.
         row owc-inspector-returnbyvalue-notifications. */
      if (method === 'Runtime.callFunctionOn') {
        var declaration = params !== undefined && params !== null && typeof params.functionDeclaration === 'string'
          ? params.functionDeclaration : undefined;
        if (declaration === undefined) {
          deliver(callback, nodeError(Error, 'ERR_INSPECTOR_COMMAND',
            'Inspector error -32602: Invalid parameters'), undefined);
          return undefined;
        }
        var called;
        try {
          called = (0, eval)('(' + declaration + ')');
        } catch (errCompiling) {
          called = undefined;
        }
        if (typeof called !== 'function') {
          deliver(callback, nodeError(Error, 'ERR_INSPECTOR_COMMAND',
            'Inspector error -32602: Invalid parameters'), undefined);
          return undefined;
        }
        var receiver = params.objectId !== undefined ? objectForId(params.objectId) : undefined;
        var applied = [];
        var givenArgs = params.arguments;
        if (Array.isArray(givenArgs)) {
          for (var argAt = 0; argAt < givenArgs.length; argAt++) {
            var one = givenArgs[argAt];
            if (one !== null && typeof one === 'object' && one.objectId !== undefined) applied.push(objectForId(one.objectId));
            else if (one !== null && typeof one === 'object' && typeof one.unserializableValue === 'string') {
              applied.push(one.unserializableValue === 'NaN' ? NaN
                : one.unserializableValue === 'Infinity' ? Infinity
                  : one.unserializableValue === '-Infinity' ? -Infinity
                    : one.unserializableValue === '-0' ? -0 : undefined);
            } else applied.push(one === null || one === undefined ? undefined : one.value);
          }
        }
        var returned;
        try {
          returned = called.apply(receiver, applied);
        } catch (errCall) {
          deliver(callback, null, {
            result: remoteObjectOf(errCall),
            exceptionDetails: {
              exception: remoteObjectOf(errCall),
              text: 'Uncaught',
              lineNumber: 0,
              columnNumber: 0,
              exceptionId: nextExceptionId(),
              scriptId: nextScriptId()
            }
          });
          return undefined;
        }
        var functionCycle = cycleErrorOf(returned, params.returnByValue === true);
        if (functionCycle !== undefined) {
          deliver(callback, functionCycle, undefined);
          return undefined;
        }
        deliver(callback, null, { result: remoteResultOf(returned, params.returnByValue === true,
          params.generatePreview === true) });
        return undefined;
      }
      /* Debugger.enable is a host's answer to a frontend attaching, and the id it hands back is the
         debugger's own, opaque to whoever reads it. This runtime has no debugger, so no id of its
         own is one a host's ever is; what is reproduced is the answer's shape, a pair of numbers.
         Debugger.getScriptSource names a script the debugger knows, and there is none here: a
         scriptId this runtime hands out on Runtime.evaluate is its own serial and not a script the
         Debugger domain has, so every id is answered as a host answers one it does not know --
         -32000, naming the id. row owc-inspector-returnbyvalue-notifications. */
      if (method === 'Debugger.enable') {
        deliver(callback, null, { debuggerId: '1.1' });
        return undefined;
      }
      if (method === 'Debugger.getScriptSource') {
        var wanted = params !== undefined && params !== null && params.scriptId !== undefined
          ? String(params.scriptId) : '';
        deliver(callback, nodeError(Error, 'ERR_INSPECTOR_COMMAND',
          'Inspector error -32000: No script for id: ' + wanted), undefined);
        return undefined;
      }
      /* The three enable commands a host answers with nothing at all -- turning a domain on is not
         a question about the program -- and NodeRuntime.notifyWhenWaitingForDisconnect, which asks
         for one notification when the process is about to exit and needs no debugger to promise.
         row owc-inspector-returnbyvalue-notifications. */
      if (method === 'Profiler.enable' || method === 'HeapProfiler.enable' || method === 'Network.enable'
        || method === 'NodeRuntime.notifyWhenWaitingForDisconnect') {
        deliver(callback, null, {});
        return undefined;
      }
      /* A method of a domain the protocol has never heard of is not an unimplemented one, and a
         host says so with the protocol's own error: -32601, and the name of the method. */
      var dot = method.indexOf('.');
      var domain = dot > 0 ? method.slice(0, dot) : method;
      if (PROTOCOL_DOMAINS[domain] !== true) {
        deliver(callback, nodeError(Error, 'ERR_INSPECTOR_COMMAND',
          'Inspector error -32601: \'' + method + '\' wasn\'t found'), undefined);
        return undefined;
      }
      /* A domain the protocol has, but a command it does not define: 'wasn't found' is the answer
         for that one too, and not 'not available', which is what a command the protocol defines
         and this runtime cannot run gets. A domain with no list here is left as it was.
         row owc-inspector-returnbyvalue-notifications. */
      var known = PROTOCOL_METHOD_SETS[domain];
      if (known !== undefined && known[method.slice(dot + 1)] !== true) {
        deliver(callback, nodeError(Error, 'ERR_INSPECTOR_COMMAND',
          'Inspector error -32601: \'' + method + '\' wasn\'t found'), undefined);
        return undefined;
      }
      deliver(callback, nodeError(Error, 'ERR_INSPECTOR_NOT_AVAILABLE',
        'Inspector protocol is not available in this runtime'), undefined);
      return undefined;
    };

    exp.Session = Session;
    exp.open = function () {};
    exp.close = function () {};
    exp.url = function () { return undefined; };
    exp.waitForDebugger = function () {
      throw nodeError(Error, 'ERR_INSPECTOR_NOT_ACTIVE', 'Inspector is not active');
    };
    exp.console = globalThis.console;
    /*
     * The Network domain: nine events a host exposes as callable notifiers, each of which hands
     * its params to whatever frontend is attached. There is no frontend here and no network the
     * protocol is watching, so each takes the params a host's takes and reports nothing, which is
     * what a host does when nothing has subscribed.
     */
    var NETWORK_EVENTS = ['requestWillBeSent', 'responseReceived', 'loadingFinished', 'loadingFailed',
      'dataSent', 'dataReceived', 'webSocketCreated', 'webSocketClosed',
      'webSocketHandshakeResponseReceived'];
    exp.Network = {};
    for (var ne = 0; ne < NETWORK_EVENTS.length; ne++) {
      exp.Network[NETWORK_EVENTS[ne]] = function () { return undefined; };
    }
    /*
     * NetworkResources.put hands a resource to the frontend. It is behind a command-line flag a
     * host is not started with by default, and with the flag off a host warns and does nothing
     * before it validates its arguments -- so the warning, not the validation, is what a caller
     * sees, and it is what this emits.
     */
    exp.NetworkResources = {
      put: function () {
        var proc = globalThis.process;
        if (proc !== undefined && proc !== null && typeof proc.emitWarning === 'function') {
          proc.emitWarning('The --experimental-inspector-network-resource option is not enabled. ' +
            'Please enable it to use the putNetworkResource function');
        }
        return undefined;
      }
    };
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
      /* The two domains the promise form carries as well: they are not sessions, so there is
         nothing for a promise to wrap, and node hands over the very objects its inspector holds --
         a caller of inspector/promises.Network lands on inspector.Network there, as here. */
      Network: base.Network,
      NetworkResources: base.NetworkResources,
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
  api.startRepl = function (terminal) {
    var proc = globalThis.process;
    /* The two lines a host node writes above its first prompt, and the version it names is the one
       this node answers --version with. They are written here rather than in node:repl because
       they belong to the session a node starts, not to the repl a script starts itself. */
    proc.stdout.write('Welcome to Node.js ' + proc.version + '.\n' +
      'Type ".help" for more information.\n');
    var server = requireBuiltin('repl').start({
      input: api.openStdin(),
      output: proc.stdout,
      prompt: '> ',
      /* A session a pipe feeds is not a terminal one, and it writes back nothing of what it read:
         nothing typed it, so an echo would be characters nobody sent. */
      terminal: terminal !== false
    });
    server.on('exit', function () { host.exit(0); });
    return true;
  };

  BF['repl'] = function () {
    var EventEmitter = requireBuiltin('events');
    var vm = requireBuiltin('vm');
    var exp = {};

    /*
     * vm.Script compiles a line without running it, which is exactly the question isValidSyntax
     * asks: a throw out of the constructor is a line that is not syntax, and anything else is.
     */
    function scriptParses(code) {
      try {
        new vm.Script(code);
        return true;
      } catch (parseErr) {
        return false;
      }
    }

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
      /* A line that awaits is still being answered when the next one arrives, so what arrives
         waits here until the value it is waiting for has been printed. */
      this._awaitPending = false;
      this._awaitQueue = [];
      /* The names this session has bound at its top level: _lexical the ones a let, a const or a
         class made, and _bound every one of them, which is what a second declaration is checked
         against -- node's context refuses a name it already holds, and the rewrite that keeps a
         binding alive across lines would otherwise hide that. */
      this._lexical = Object.create(null);
      this._bound = Object.create(null);
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
      /* A session that has closed does not prompt again, which is why a value a .exit waited for
         is the last thing on its output: the prompt belongs to a line that will never be read. */
      if (this._closed) return;
      this._writeOut(this._buffer !== '' ? '| ' : this._prompt);
    };
    /* The same, for a close that has been asked for but not finished: a .exit defers the close to
       a turn of its own, and a prompt written before that turn would outlive the session. */
    REPLServer.prototype.displayPromptAfter = function () {
      if (this._closeScheduled === true) return;
      this.displayPrompt();
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
      this._awaited = false;
      this._awaitValue = false;
      /* A line that opens with a brace: node wraps it in one pair of parens so it reads as an
         object literal and not as a block, and decides without ever trying the wrapped form --
         a line that opens with a brace and does not end in a semicolon is wrapped whenever the
         line *as written* parses, with its 'await's taken out when only those stop it. So
         '{ await 3 }' is wrapped and is reported wrapped even though neither reading runs, while
         '{ yield 3 }' and '{ return 1 }' parse neither way and are left as they were written.
         The wrap is undone again when only the wrapped form is the one that does not parse --
         '{ 1 }', '{ let x = 1 }' and '{ a: 1 } // c', whose comment would eat the closing paren.
         Measured against host node 24.15 over twelve brace shapes; the message the engine words
         is its own either way. */
      if (/^\s*\{/.test(src) && !/;\s*$/.test(src) && replIsValidSyntax(src)) {
        var braced = '(' + src.replace(/^\s+/, '').replace(/\s+$/, '') + ')\n';
        code = scriptParses(braced) === false && scriptParses(src) === true ? src : braced;
      }
      /* The source the engine is handed, kept for the frame a syntax error is reported with: the
         line as it was written, and not the wrapper, which is what Node underlines too. Read
         before the rewrite below, which turns a let, a const and a class into a var and so would
         leave nothing to tell one from another. */
      this._code = code;
      var decls = replTopDecls(code);
      /* A name the line binds twice is refused by node's own context, which sees the whole line at
         once: 'let s = 1; let s = 2' and 'var s = 1; let s = 2' are both one name declared twice.
         A var and a function declared again in one line are not, and nor is one of each. */
      var lineNames = Object.create(null);
      for (var dl = 0; dl < decls.lexical.length; dl++) {
        var ln = decls.lexical[dl];
        if (this._bound[ln] === true || lineNames[ln] !== undefined) {
          throw new SyntaxError("Identifier '" + ln + "' has already been declared");
        }
        lineNames[ln] = 'lexical';
      }
      for (var dd = 0; dd < decls.loose.length; dd++) {
        var dn0 = decls.loose[dd];
        if (this._lexical[dn0] === true || lineNames[dn0] === 'lexical') {
          throw new SyntaxError("Identifier '" + dn0 + "' has already been declared");
        }
        lineNames[dn0] = 'loose';
      }
      code = rewriteTopLexical(code);
      /* A line with a top-level await runs inside the wrapper instead, and says so: the value the
         promise it hands back resolves to is what the session sees, and the prompt waits for it. */
      var wrapped = replTopLevelAwait(code);
      /* Whether the line is one Node would have wrapped, which is not whether this one was: Node
         looks no further than the six letters, so 'var awaited = ;' and an await inside a string
         are as much an awaiting line to it as one that awaits, and a syntax error out of any of
         them is worded the way an awaiting line's is. */
      this._awaited = code.indexOf('await') >= 0;
      this._awaitValue = wrapped !== null && wrapped.code !== null;
      if (this._awaitValue === true) code = wrapped.code;
      var value;
      var thrown = null;
      try {
        value = this.useGlobal ? (0, eval)(code) : vm.runInContext(code, this.context);
      } catch (fail) {
        thrown = fail;
      }
      /* A binding that survived the line is one the next line cannot make again: the rewrite
         above turns a let, a const and a class into a var, so the context they run in never sees
         the name twice and would never refuse it. Node's does, so the names are kept here.
         A line that bound a name and then threw keeps the binding all the same -- 'let t = 1;
         throw new Error("x")' leaves t at 1 on a host, and a second 'let t' is refused there --
         because the names of a script are made before its statements run. A line the engine
         could not compile made none, which is what a SyntaxError out of the compile means. */
      if (thrown === null || !(isObjectLike(thrown) && thrown.name === 'SyntaxError')) {
        for (var dn = 0; dn < decls.lexical.length; dn++) {
          this._lexical[decls.lexical[dn]] = true;
          this._bound[decls.lexical[dn]] = true;
        }
        for (var dv = 0; dv < decls.loose.length; dv++) this._bound[decls.loose[dv]] = true;
      }
      if (thrown !== null) throw thrown;
      return value;
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
        /* A line that carries an await is compiled inside the wrapper, and Node reports the
           syntax error out of that compile with the header first and the message last: 'Uncaught
           SyntaxError: ', then the offending line and the caret, then the words. Any other line
           is the other way round -- the frame first, and then 'Uncaught' and the words. */
        var frame = replErrorFrame(this._code === undefined ? src : this._code, err);
        if (this._awaited === true && isObjectLike(err) && err.name === 'SyntaxError') {
          this._writeOut('Uncaught ' + replErrorName(err) + ': \n' + frame + replErrorMessage(err) + '\n');
          return false;
        }
        this._writeOut(frame + 'Uncaught ' + replErrorHeader(err) + '\n');
        return false;
      }
      if (this._awaitValue === true && isObjectLike(result) && typeof result.then === 'function') {
        var repl = this;
        this._awaitValue = false;
        /* A line that awaits is not done when the prompt comes back: the value it waits for is
           what the session prints, and Node reads no further line until it has. So the lines that
           arrive behind it wait here, and a .exit among them still sees its value printed. */
        this._awaitPending = true;
        result.then(function (value) {
          repl._awaitPending = false;
          repl._showResult(replUnwrapAwait(value));
          /* What waited for this value is read before the prompt is written, so a .exit among it
             has closed the session by then and no prompt follows the value it waited for. */
          repl._readAwaitQueue();
          repl.displayPromptAfter();
        }, function (err) {
          repl._awaitPending = false;
          repl._writeOut('Uncaught ' + replErrorHeader(err) + '\n');
          repl._readAwaitQueue();
          repl.displayPromptAfter();
        });
        return true;
      }
      this._showResult(result);
      return false;
    };

    REPLServer.prototype._readAwaitQueue = function () {
      if (this._closed) return;
      var queue = this._awaitQueue;
      this._awaitQueue = [];
      for (var i = 0; i < queue.length; i++) this._onLine(queue[i]);
    };

    REPLServer.prototype._onLine = function (line) {
      if (this._closed) return;
      this.line = '';
      var trimmed = line.replace(/^\s+/, '');
      if (this._buffer === '' && /^\.[A-Za-z_]/.test(trimmed)) {
        /* A keyword that arrives while a line is still awaiting waits for it: host node prints
           the value it is waiting for before it closes the session on a .exit, and a session
           that ends first would never print it. An ordinary line does not wait -- host node
           reads on, and the value is written where it falls, behind the lines that came after. */
        if (this._awaitPending === true) { this._awaitQueue.push(line); return; }
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
    /*
     * repl.isValidSyntax answers whether a line is complete syntax, which a host decides by
     * parsing it twice -- once as it stands and once wrapped in an assignment, so that both an
     * expression and a declaration pass. The parser here is the one behind vm.Script, which is the
     * script grammar a host's parser is given for the same question: a module-only form -- an
     * 'export', a bare 'import' declaration, a 'return' with no function around it -- is no more
     * a script here than there, so those are the two answers a host gives. A top-level 'await'
     * is the one shape the script grammar refuses and a host's REPL prompt accepts, so a line
     * holding one is parsed a third time, in the position it sits in at that prompt.
     */
    exp.isValidSyntax = function (input) {
      var code = String(input);
      if (scriptParses(code)) return true;
      if (scriptParses('_=' + code)) return true;
      return /\bawait\b/.test(code) === true && scriptParses('(async()=>{\n' + code + '\n})');
    };
    return exp;
  };

  // ---- the private modules node's own builtinModules list names ---------------------------

  /*
   * builtinModules is node's list of everything its binary carries, and isBuiltin answers for the
   * same list, so a name the list holds and BF does not is a module node has and this runtime
   * does not: require says MODULE_NOT_FOUND for a name isBuiltin has just called a built-in. These
   * are the private ones -- the underscore names, which in node are the pieces http, stream and
   * tls are built out of rather than modules of their own -- and the four the list writes with its
   * own node: prefix. Each is assembled from the module it is a piece of, so a class a caller gets
   * from '_stream_readable' is the very class 'stream' hands out and not a copy of one.
   * row owc-module-export-table-incomplete.
   */
  var PRIVATE_STREAM_PARTS = [
    ['_stream_readable', 'Readable'], ['_stream_writable', 'Writable'], ['_stream_duplex', 'Duplex'],
    ['_stream_transform', 'Transform'], ['_stream_passthrough', 'PassThrough']
  ];
  for (var privateStreamAt = 0; privateStreamAt < PRIVATE_STREAM_PARTS.length; privateStreamAt++) {
    (function (pair) {
      BF[pair[0]] = function () { return requireBuiltin('stream')[pair[1]]; };
    })(PRIVATE_STREAM_PARTS[privateStreamAt]);
  }

  /* _tls_wrap is tls as http2 and https reach it: the socket, the server and the two calls that
     build them. _tls_common is what a secure context is made of. */
  BF['_tls_wrap'] = function () {
    var tls = requireBuiltin('tls');
    return { TLSSocket: tls.TLSSocket, Server: tls.Server, createServer: tls.createServer, connect: tls.connect };
  };
  BF['_tls_common'] = function () {
    var tls = requireBuiltin('tls');
    return {
      SecureContext: tls.SecureContext,
      createSecureContext: tls.createSecureContext,
      /* translatePeerCertificate turns the object the peer's certificate parses into the object
         getPeerCertificate hands a caller: subject and issuer split into their fields, the
         validity dates, the fingerprint, and the subject alt name spelled out. The parts are read
         off the certificate as it parses, so a field the certificate does not carry is absent here
         as it is there. */
      translatePeerCertificate: function (certificate) {
        if (certificate === null || typeof certificate !== 'object') return certificate;
        var translated = {};
        var names = Object.keys(certificate);
        for (var nameAt = 0; nameAt < names.length; nameAt++) translated[names[nameAt]] = certificate[names[nameAt]];
        if (translated.subject !== undefined && translated.subject !== null) {
          translated.subject = translateDistinguishedName(translated.subject);
        }
        if (translated.issuer !== undefined && translated.issuer !== null) {
          translated.issuer = translateDistinguishedName(translated.issuer);
        }
        return translated;
      }
    };
  };
  /* node spells a distinguished name two ways -- 'C=US, ST=CA, O=Acme' as one string and the same
     name as an object -- and hands a caller both, so the string is what is split here. */
  function translateDistinguishedName(name) {
    if (typeof name !== 'string') return name;
    var out = Object.create(null);
    var fields = name.split(',');
    for (var fieldAt = 0; fieldAt < fields.length; fieldAt++) {
      var at = fields[fieldAt].indexOf('=');
      if (at <= 0) continue;
      out[fields[fieldAt].slice(0, at).trim()] = fields[fieldAt].slice(at + 1).trim();
    }
    return out;
  }

  /* The three private http modules: the agent a request is made through, the request a client
     makes, the message a client receives, the message a server answers with, and the status codes
     both spell. Each is the class http itself exports, and the two validators an outgoing message
     checks a header against are http's own, which is what _http_outgoing hands to its callers. */
  BF['_http_agent'] = function () {
    var http = requireBuiltin('http');
    return { Agent: http.Agent, globalAgent: http.globalAgent };
  };
  BF['_http_client'] = function () {
    return { ClientRequest: requireBuiltin('http').ClientRequest };
  };
  BF['_http_incoming'] = function () {
    var http = requireBuiltin('http');
    return {
      IncomingMessage: http.IncomingMessage,
      /* readStart and readStop are how node's http tells a socket to start and stop flowing, and
         there is nothing behind them but the stream's own two calls. */
      readStart: function (socket) { if (socket !== null && typeof socket.resume === 'function') socket.resume(); },
      readStop: function (socket) { if (socket !== null && typeof socket.pause === 'function') socket.pause(); }
    };
  };
  BF['_http_outgoing'] = function () {
    var http = requireBuiltin('http');
    return {
      OutgoingMessage: http.OutgoingMessage,
      validateHeaderName: http.validateHeaderName,
      validateHeaderValue: http.validateHeaderValue
    };
  };
  BF['_http_server'] = function () {
    var http = requireBuiltin('http');
    return {
      STATUS_CODES: http.STATUS_CODES,
      Server: http.Server,
      ServerResponse: http.ServerResponse
    };
  };

  /* assert/strict is assert itself with every comparison run in strict mode: the same assertion
     calls, and 'equal' behaving as 'strictEqual'. */
  BF['assert/strict'] = function () {
    return requireBuiltin('assert').strict;
  };

  /*
   * trace_events: a tracing object over the categories a caller names, and the answer to which
   * categories are on. Node writes its trace events into a file the process owns; there is no such
   * file here and no category for one to be enabled on, so enable and disable report success
   * without writing anything -- as node's own do for a category no producer owns -- and
   * getEnabledCategories answers undefined, which is what it answers while no tracing is on.
   */
  BF['trace_events'] = function () {
    function Tracing(categories) {
      this.categories = categories;
      this.enabled = false;
    }
    Tracing.prototype.enable = function () {
      this.enabled = true;
      return undefined;
    };
    Tracing.prototype.disable = function () {
      this.enabled = false;
      return undefined;
    };
    return {
      createTracing: function (options) {
        var categories = options !== null && typeof options === 'object' && Array.isArray(options.categories)
          ? options.categories.join(',') : '';
        return new Tracing(categories);
      },
      getEnabledCategories: function () { return undefined; }
    };
  };

  /*
   * node:test: a runner that really runs what a caller hands it. A test is a function the runner
   * calls, and its promise -- or its throw -- is what decides the pass and the fail; a suite is a
   * function the runner calls to collect the tests inside it, and the hooks are functions it calls
   * around them. What this runtime cannot reproduce is the reporter's own voice: a host prints the
   * duration of every test and the V8 stack of every failure, and neither is a number or a frame
   * this runtime has. So the shape of the report is the host's -- the mark, the name, the counts
   * and the list of failures -- and the timings and stacks in it are this runtime's own.
   * row owc-module-export-table-incomplete.
   */
  BF['test'] = function () {
    var root = { name: undefined, items: [], before: [], after: [], beforeEach: [], afterEach: [] };
    var cursor = root;
    var queued = false;
    var passed = 0;
    var failed = 0;
    var skipped = 0;
    var todos = 0;
    var cancelled = 0;
    var suiteCount = 0;
    var failures = [];
    var startedAt = 0;

    function line(text) {
      if (globalThis.console !== undefined && typeof globalThis.console.log === 'function') globalThis.console.log(text);
    }
    function durationOf(from) { return (Date.now() - from) + 'ms'; }

    function optionsOf(args) {
      for (var i = 0; i < args.length; i++) {
        if (args[i] !== null && typeof args[i] === 'object' && typeof args[i] !== 'function') return args[i];
      }
      return {};
    }
    /* The name, the options and the function out of a call that may carry any two of the three: a
       name is a string, options an object, and the test itself the one function among them. */
    function partsOf(args) {
      var name = undefined;
      var options = {};
      var fn = undefined;
      for (var i = 0; i < args.length; i++) {
        var one = args[i];
        if (typeof one === 'function') fn = one;
        else if (typeof one === 'string') name = one;
        else if (one !== null && typeof one === 'object') options = one;
      }
      return { name: name, options: options, fn: fn };
    }

    function addHook(kind, fn) {
      if (typeof fn !== 'function') return undefined;
      cursor[kind].push(fn);
      schedule();
      return undefined;
    }

    function addTest(args) {
      var parts = partsOf(args);
      /* skip and todo take a reason as well as a true: a string is the reason the report names
         behind the mark, and skip: false is the one value that is not a skip at all. */
      var skip = parts.options.skip === true ? true : typeof parts.options.skip === 'string' ? parts.options.skip
        : parts.options.skip === false ? false : parts.options.skip === undefined ? false : Boolean(parts.options.skip);
      var todo = parts.options.todo === true ? true : typeof parts.options.todo === 'string' ? parts.options.todo
        : parts.options.todo === false ? false : parts.options.todo === undefined ? false : Boolean(parts.options.todo);
      var item = { kind: 'test', name: parts.name || '<anonymous>', fn: parts.fn, options: parts.options,
        skip: skip, todo: todo,
        only: parts.options.only === true, expectFailure: parts.options.expectFailure === true, hooks: [] };
      cursor.items.push(item);
      schedule();
      /* node's test() answers the promise of the run it just joined, which is how a caller waits
         for the report: awaiting it is a thing programs do, and it answers undefined otherwise. */
      return draining;
    }

    function addSuite(args) {
      var parts = partsOf(args);
      var suite = { kind: 'suite', name: parts.name || '<anonymous>', fn: parts.fn, options: parts.options,
        items: [], before: [], after: [], beforeEach: [], afterEach: [], parent: cursor };
      cursor.items.push(suite);
      suiteCount += 1;
      if (typeof parts.fn === 'function') {
        var outer = cursor;
        cursor = suite;
        try {
          parts.fn();
        } finally {
          cursor = outer;
        }
      }
      schedule();
      return undefined;
    }

    var draining = null;
    function schedule() {
      if (queued) return;
      queued = true;
      startedAt = Date.now();
      draining = new Promise(function (resolve) {
        setTimeout(function () { runAll().then(resolve, resolve); }, 0);
      });
    }

    function callEach(list, context) {
      var chain = Promise.resolve();
      list.forEach(function (fn) {
        chain = chain.then(function () { return fn(context); });
      });
      return chain;
    }

    /* The hooks hung on the module itself are the outermost pair: node runs a module-level
       beforeEach ahead of every test it collected, whatever suite the test sits in, and its
       afterEach behind every one. */
    function hooksAround(item, ancestors) {
      var beforeEach = root.beforeEach.slice();
      var afterEach = [];
      for (var i = 0; i < ancestors.length; i++) {
        beforeEach = beforeEach.concat(ancestors[i].beforeEach);
        afterEach = ancestors[i].afterEach.concat(afterEach);
      }
      return { before: beforeEach, after: afterEach.concat(root.afterEach) };
    }

    /*
     * The context a test body is handed. Node's own is an instance of TestContext and carries
     * nothing of its own: the name, the signal, the assertions, the mock, the sub-test and the
     * hooks are all accessors on its prototype, so Object.keys and getOwnPropertyNames of a
     * context are both empty and every name is still read off it. The values behind them are
     * per-test, so they are kept beside the instance rather than on it.
     */
    var CTX = new WeakMap();
    function TestContext() { /* nothing of its own: every name is read off the prototype */ }
    function ctxAccessor(name, read) {
      Object.defineProperty(TestContext.prototype, name, {
        get: function () { var state = CTX.get(this); return state === undefined ? undefined : read(state); },
        configurable: true, enumerable: true
      });
    }
    function newTestContext(item, pad) {
      var context = new TestContext();
      var state = { item: item, pad: pad, mark: undefined };
      CTX.set(context, state);
      return context;
    }
    var abortControllerOf = function () {
      var controller = typeof globalThis.AbortController === 'function' ? new globalThis.AbortController() : undefined;
      return controller;
    };
    ctxAccessor('name', function (state) { return state.item.name; });
    ctxAccessor('fullName', function (state) { return state.item.fullName === undefined ? state.item.name : state.item.fullName; });
    ctxAccessor('signal', function (state) {
      if (state.signal === undefined) {
        var controller = abortControllerOf();
        state.signal = controller === undefined ? undefined : controller.signal;
      }
      return state.signal;
    });
    ctxAccessor('assert', function (state) {
      if (state.assert === undefined) state.assert = Object.create(requireBuiltin('assert'));
      return state.assert;
    });
    ctxAccessor('mock', function (state) {
      if (state.mock === undefined) state.mock = testMock();
      return state.mock;
    });
    ctxAccessor('test', function (state) {
      return function (name, options, fn) { return addTest(Array.prototype.slice.call(arguments)); };
    });
    ctxAccessor('runOnly', function (state) { return state.item.only === true ? true : undefined; });
    ctxAccessor('before', function (state) { return function (fn) { state.item.hooks.push(['before', fn]); return undefined; }; });
    ctxAccessor('after', function (state) { return function (fn) { state.item.hooks.push(['after', fn]); return undefined; }; });
    ctxAccessor('beforeEach', function (state) { return function (fn) { state.item.hooks.push(['beforeEach', fn]); return undefined; }; });
    ctxAccessor('afterEach', function (state) { return function (fn) { state.item.hooks.push(['afterEach', fn]); return undefined; }; });
    ctxAccessor('diagnostic', function (state) {
      return function (text) { line(state.pad + '  ' + text); };
    });
    /* skip and todo are not verdicts a body reaches on its own: they are the body's own answer,
       given while it runs, and they mark the test skipped or todo whenever it ends -- after the
       rest of the body has had its say, which is why a line the body prints first comes first. */
    ctxAccessor('skip', function (state) {
      return function () { if (state.mark === undefined) state.mark = 'skip'; };
    });
    ctxAccessor('todo', function (state) {
      return function () { if (state.mark === undefined) state.mark = 'todo'; };
    });

    /* The mark a test ends with: a skipped one is a small hyphen and '# SKIP', a todo the ordinary
       tick and '# TODO', and one its author said must fail carries '# EXPECTED FAILURE' whichever
       way it went. */
    function expectedSuffix(item) { return item.expectFailure === true ? ' # EXPECTED FAILURE' : ''; }
    /* The word behind the mark: the reason the test's author wrote, when one was written, and
       node's own word otherwise. A test that decided to skip or to todo while it ran has no
       reason of its own, so it gets node's. */
    function markSuffix(kind, value) {
      return typeof value === 'string' && value !== '' ? ' # ' + value
        : kind === 'skip' ? ' # SKIP' : ' # TODO';
    }
    function lineOk(item, pad, at) { line(pad + '✔ ' + item.name + ' (' + durationOf(at) + ')' + expectedSuffix(item)); }
    function lineNo(item, pad, at) { line(pad + '✖ ' + item.name + ' (' + durationOf(at) + ')' + expectedSuffix(item)); }
    /* A todo is not a pass and not a fail, and node marks it with the warning sign rather than
       with the tick a pass gets. */
    function lineSkipped(item, pad, at) { line(pad + '﹣ ' + item.name + ' (' + durationOf(at) + ')' + markSuffix('skip', item.skip)); }
    function lineTodo(item, pad, at) { line(pad + '⚠ ' + item.name + ' (' + durationOf(at) + ')' + markSuffix('todo', item.todo)); }

    function runTest(item, ancestors, depth, tailAfter) {
      var pad = new Array(depth + 1).join('  ');
      if (item.skip !== false || item.todo !== false) {
        var at0 = Date.now();
        if (item.todo !== false) { todos += 1; lineTodo(item, pad, at0); }
        else { skipped += 1; lineSkipped(item, pad, at0); }
        return Promise.resolve();
      }
      var around = hooksAround(item, ancestors);
      var context = newTestContext(item, pad);
      var at = Date.now();
      /* A test marked expectFailure is one its author says must not pass, so the verdict is
         inverted: a throw is the pass and a clean run is the failure. That is the whole meaning of
         the keyword, and it is decided here where the two outcomes already part. */
      var expectFail = item.expectFailure === true;
      var body = callEach(item.hooks.filter(function (h) { return h[0] === 'before'; }).map(function (h) { return h[1]; }), context)
        .then(function () { return callEach(around.before, context); })
        .then(function () { return typeof item.fn === 'function' ? item.fn(context) : undefined; });
      /* A timeout is a cancellation, not a failure: node stops waiting when the clock passes it,
         reports the test as cancelled and names the limit in the one string it throws. The body it
         abandoned is left to finish on its own, which is why its own lines still come after. */
      var limit = item.options !== undefined && typeof item.options.timeout === 'number'
        ? item.options.timeout : undefined;
      if (limit !== undefined) {
        body = Promise.race([body, new Promise(function (resolve, reject) {
          setTimeout(function () { reject('test timed out after ' + limit + 'ms'); }, limit);
        })]);
      }
      var trail = function () {
        return callEach(around.after, context).then(function () {
          return callEach(item.hooks.filter(function (h) { return h[0] === 'after'; }).map(function (h) { return h[1]; }), context);
        }).then(function () { return callEach(tailAfter === undefined ? [] : tailAfter, context); });
      };
      return body.then(function () {
        return trail().then(function () {
          var mark = CTX.get(context).mark;
          if (mark === 'skip') { skipped += 1; lineSkipped(item, pad, at); return undefined; }
          if (mark === 'todo') { todos += 1; lineTodo(item, pad, at); return undefined; }
          if (expectFail) {
            failed += 1;
            failures.push({ name: item.name, error: 'test was expected to fail but passed', mark: ' (' + durationOf(at) + ')' + expectedSuffix(item) });
            lineNo(item, pad, at);
            return undefined;
          }
          passed += 1;
          lineOk(item, pad, at);
        });
      }, function (err) {
        return trail().then(function () {
          if (typeof err === 'string' && limit !== undefined && String(err).indexOf('timed out') >= 0) {
            cancelled += 1;
            failures.push({ name: item.name, error: err, mark: ' (' + durationOf(at) + ')' + expectedSuffix(item) });
            lineNo(item, pad, at);
            return undefined;
          }
          if (expectFail) {
            passed += 1;
            lineOk(item, pad, at);
            return undefined;
          }
          failed += 1;
          failures.push({ name: item.name, error: err, mark: ' (' + durationOf(at) + ')' + expectedSuffix(item) });
          lineNo(item, pad, at);
        }, function () {
          failed += 1;
          failures.push({ name: item.name, error: err, mark: ' (' + durationOf(at) + ')' + expectedSuffix(item) });
          lineNo(item, pad, at);
        });
      });
    }

    function runSuite(suite, ancestors, depth) {
      var pad = new Array(depth + 1).join('  ');
      line(pad + '▶ ' + suite.name);
      var at = Date.now();
      var lost = failed + cancelled;
      var chain = callEach(suite.before, { name: suite.name });
      var inner = ancestors.concat([suite]);
      suite.items.forEach(function (item) {
        chain = chain.then(function () {
          return item.kind === 'suite' ? runSuite(item, inner, depth + 1) : runTest(item, inner, depth + 1);
        });
      });
      return chain.then(function () {
        return callEach(suite.after, { name: suite.name });
      }).then(function () {
        /* A suite is reported the way a test is once its children have gone: a mark of its own,
           failing if any of them did, which is the line a nested suite's name stands on. */
        if (failed + cancelled > lost) lineNo(suite, pad, at);
        else line(pad + '✔ ' + suite.name + ' (' + durationOf(at) + ')');
      });
    }

    function runAll() {
      var chain = callEach(root.before, { name: undefined });
      var items = root.items.filter(function (item) { return item.only === true; });
      var chosen = items.length > 0 ? items : root.items;
      chosen.forEach(function (item, index) {
        /* The module's own after runs once, behind everything it collected -- and ahead of the
           mark of the last test, which is where node puts it. */
        var tailAfter = index === chosen.length - 1 && item.kind === 'test' ? root.after : [];
        chain = chain.then(function () {
          return item.kind === 'suite' ? runSuite(item, [], 0) : runTest(item, [], 0, tailAfter);
        });
      });
      return chain.then(report);
    }

    function report() {
      /* A test that was cancelled still ran: node counts it among the tests it reports. */
      line('ℹ tests ' + (passed + failed + skipped + todos + cancelled));
      line('ℹ suites ' + suiteCount);
      line('ℹ pass ' + passed);
      line('ℹ fail ' + failed);
      line('ℹ cancelled ' + cancelled);
      line('ℹ skipped ' + skipped);
      line('ℹ todo ' + todos);
      line('ℹ duration_ms ' + (Date.now() - startedAt));
      if (failures.length > 0) {
        line('');
        line('✖ failing tests:');
        line('');
        failures.forEach(function (one) {
          line(one.name);
          line('✖ ' + one.name + (one.mark === undefined ? '' : one.mark));
          /* What failed is printed the way node prints it: an Error by its stack, and a value a
             test threw that is not one -- the string a timeout is cancelled with -- quoted. */
          line('  ' + (typeof one.error === 'string' ? "'" + one.error + "'"
            : String(one.error && one.error.stack ? one.error.stack : one.error)));
        });
      }
      /* A run that failed or was cancelled is a run that failed: node's test runner ends the
         process on 1 for it, and does so by writing the code the process exits with. */
      if (failed + cancelled > 0 && typeof globalThis.process === 'object' && globalThis.process !== null) {
        try { globalThis.process.exitCode = 1; } catch (e) { /* a code that will not take stays */ }
      }
      return undefined;
    }

    /* Three parameters, as node's own test is: a call may carry any two of a name, an options
       object and the test, and .length is what a caller that inspects the function reads. */
    function test(name, options, fn) { return addTest(Array.prototype.slice.call(arguments)); }
    test.test = test;
    /* describe is node's suite, and it is the same function under a second name there -- its .name
       reads 'test', not 'describe' -- so the name is put on it rather than inferred. */
    var addSuiteFn = function (name, options, fn) { return addSuite(Array.prototype.slice.call(arguments)); };
    try { Object.defineProperty(addSuiteFn, 'name', { value: 'test', configurable: true }); } catch (e) { /* a name that will not take stays */ }
    test.describe = addSuiteFn;
    test.suite = addSuiteFn;
    test.it = test;
    test.before = function (fn) { return addHook('before', fn); };
    test.after = function (fn) { return addHook('after', fn); };
    test.beforeEach = function (fn) { return addHook('beforeEach', fn); };
    test.afterEach = function (fn) { return addHook('afterEach', fn); };
    /* The mock surface, built by a factory because a context needs one of its own: node's is an
       object with no own names at all -- fn is there and is not enumerable, so a walk of the
       surface answers nothing -- and a call it remembers is the arguments it was given, what it
       answered, and the stack the call was made from, in that order. fn is on the prototype the
       surface stands on, not on the surface itself, which is why a walk of it answers nothing. */
    var MockSurface = {};
    function testMock() {
      function fn(impl) {
        var calls = [];
        var spy = function () {
          var args = Array.prototype.slice.call(arguments);
          var answer = typeof impl === 'function' ? impl.apply(this, args) : undefined;
          calls.push({ arguments: args, result: answer, stack: new Error() });
          return answer;
        };
        spy.mock = { calls: calls, callCount: function () { return calls.length; } };
        return spy;
      }
      Object.defineProperty(MockSurface, 'fn', { value: fn, writable: true, enumerable: true, configurable: true });
      return Object.create(MockSurface);
    }
    test.mock = testMock();
    test.run = function () {
      if (draining === null) return Promise.resolve();
      return draining;
    };
    Object.defineProperty(test.run, 'name', { value: 'run', configurable: true });
    /*
     * The four keywords node:test exports beside the test itself -- only, skip, todo and
     * expectFailure -- each register a test carrying the flag its name is, and change nothing else
     * about it: the runner reads the first three off the item already, and expectFailure inverts the
     * verdict there. The options a caller passed are copied rather than written into, because they
     * are the caller's object. Each is node's own shape -- an anonymous function of three
     * parameters, as a call may carry any two of a name, an options object and the test -- which is
     * why each is handed back by a factory: a function expression assigned to a property would
     * take that property's name.
     */
    function keywordTest(keyword) {
      return function (name, options, fn) {
        var parts = partsOf(Array.prototype.slice.call(arguments));
        var overridden = {};
        var keys = Object.keys(parts.options);
        for (var i = 0; i < keys.length; i++) overridden[keys[i]] = parts.options[keys[i]];
        overridden[keyword] = true;
        return addTest([parts.name, overridden, parts.fn]);
      };
    }
    test.only = keywordTest('only');
    test.skip = keywordTest('skip');
    test.todo = keywordTest('todo');
    test.expectFailure = keywordTest('expectFailure');
    /*
     * The assertion surface node:test hangs off the module: one name, register, on an object with no
     * prototype, which is what node's own is. A registered assertion is reachable by the name it was
     * given and is not one of the object's own names, so the surface stays node's single key, as it
     * does there after a register.
     */
    var ASSERTIONS = Object.create(null);
    test.assert = Object.create(requireBuiltin('assert'));
    test.assert.register = function (name, fn) {
      if (typeof name !== 'string') throw argError('name', 'of type string', name);
      if (typeof fn !== 'function') throw argError('fn', 'of type function', fn);
      ASSERTIONS[name] = fn;
    };
    Object.defineProperty(test.assert.register, 'name', { value: 'register', configurable: true });
    /*
     * Snapshot testing's two settings: the serializers a snapshot is written with, and the function
     * that names the file it is written to. Both are kept, and neither has a reader yet -- a
     * snapshot is a file and this runner writes none -- so what is answered here is node's own two
     * names and node's own refusal of a wrong argument.
     */
    var SNAPSHOT_SERIALIZERS = [];
    var SNAPSHOT_RESOLVER = undefined;
    test.snapshot = {
      setDefaultSnapshotSerializers: function (serializers) {
        if (!Array.isArray(serializers)) throw argError('serializers', 'an instance of Array', serializers);
        for (var i = 0; i < serializers.length; i++) {
          if (typeof serializers[i] !== 'function') throw argError('serializers[' + i + ']', 'of type function', serializers[i]);
        }
        SNAPSHOT_SERIALIZERS = serializers.slice();
      },
      setResolveSnapshotPath: function (fn) {
        if (typeof fn !== 'function') throw argError('fn', 'of type function', fn);
        SNAPSHOT_RESOLVER = fn;
      }
    };
    /* Node's snapshot surface stands on no prototype at all, so a walk of its own names is the
       whole of it and Object.getPrototypeOf answers null. */
    try { Object.setPrototypeOf(test.snapshot, null); } catch (e) { /* a prototype that will not move stays */ }
    return test;
  };

  /*
   * node:sea is the single-executable-application surface, and this process is not one: it was
   * started as a script. So isSea answers false and every call that reads an asset out of the
   * executable answers the error node answers when there is no executable to read one from,
   * naming the code a caller branches on.
   */
  BF['sea'] = function () {
    function notSingleExecutable() {
      return nodeError(Error, 'ERR_NOT_IN_SINGLE_EXECUTABLE_APPLICATION',
        'Operation cannot be invoked when not in a single-executable application');
    }
    return {
      isSea: function () { return false; },
      getAsset: function () { throw notSingleExecutable(); },
      getRawAsset: function () { throw notSingleExecutable(); },
      getAssetAsBlob: function () { throw notSingleExecutable(); },
      getAssetKeys: function () { throw notSingleExecutable(); }
    };
  };

})();
`;
