/**
 * Guest-side `util` (format/inspect with Node-style output, TextEncoder/TextDecoder)
 * and `assert` built-ins. Plain JavaScript inside a String.raw snippet.
 */
export const UTIL_ASSERT_SRC = String.raw`
function isIdentifierKey(k) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k);
}

function quoteStringLiteral(s) {
  var escaped = s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
  if (s.indexOf("'") >= 0 && s.indexOf('"') < 0) return '"' + escaped + '"';
  return "'" + escaped.replace(/'/g, "\\'") + "'";
}

/*
 * The stack the container prints for an error: the header, then the frames. An error the engine
 * raised itself carries the frames alone and no header, and they are the frames of the bootstrap
 * that loaded the module, so they are put through the same rewriting a guest's own error gets --
 * the frames of this container's own become the frames of node's CommonJS loader -- and the header
 * goes in front. An error the guest constructed already went through it, and once more changes
 * nothing. The empty line the engine ends every stack with is not one node writes.
 */
function formatErrorStack(err) {
  /* An error the host raised as the whole of what Node writes -- a module Node's stripper refuses
     to rewrite, whose report is the internal frame, the source and the error, and not a header and
     a stack -- carries that report with it, and it goes out as it stands: no name and colon go
     in front of a report that already holds the line Node opens with. */
  if (err && typeof err.__owcWhole === 'string') return err.__owcWhole;
  /* 'class Z extends Error {}' prints 'Z [Error]: s' on host node 24.15: the constructor's name
     in front and the error's own 'name' in brackets, because that name is the one Z inherited and
     not one the error carries. A name the error *does* carry -- 'e.name = "Foo"', or a subclass
     that sets its own -- is printed alone, as 'Foo: x', so what decides it is whether 'name' is
     the error's own property and not whether it differs from the constructor's. */
  var nameText = err.name === undefined || err.name === null ? 'Error' : String(err.name);
  var header = nameText;
  var ctorText = constructorNameOf(err);
  var subbed = false;
  if (ctorText && ctorText !== nameText && ctorText !== 'Object' &&
      !Object.prototype.hasOwnProperty.call(err, 'name')) {
    header = ctorText + ' [' + nameText + ']';
    subbed = true;
  }
  if (err.message) header += header === '' ? String(err.message) : ': ' + err.message;
  var stack = err.stack ? String(err.stack) : '';
  var lines = stack === '' ? [] : guestFramesOf(stack.split('\n'));
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  var body = lines.join('\n');
  /* The header the error's own stack carries is the one node prints for a plain error and the one
     it drops when it prints 'Z [Error]: s' instead: the stack of a subclass opens with 'Error: s',
     the name it inherited and not the name the constructor answers, and node's report opens with
     the constructor's and then goes on with the frames -- 'Error: s' is not a line it prints twice.
     The stack of an error out of a 'vm' context carries that header too now, so the same dropping
     is what keeps 'Z [Error]: s' from being followed by it there. */
  if (subbed) {
    var ownHeader = nameText + (err.message ? ': ' + String(err.message) : '');
    if (body === ownHeader || body.indexOf(ownHeader + '\n') === 0) body = body.slice(ownHeader.length + 1);
  }
  if (body === '') return header;
  /* A stack that is no stack at all -- one the error was given by hand, 'L1\nL2', with no frame in
     it -- is what node prints in brackets, '[L1\nL2]': not a report with a header in front of it
     and not one with the header left off. */
  if (body.indexOf('\n    at') < 0) return '[' + body + ']';
  /* The engine of a 'vm' realm writes a stack of frames and no header -- '    at <eval> (...)' --
     where node's own opens with 'Error: x', so the header goes in front. A stack that already
     carries the error's header or report gets none, which is what makes 'util.inspect' of an error
     thrown out of a 'vm' context open with the frame the host wrote, 'evalmachine.<anonymous>:1',
     and not with 'Error: th': that report holds its own 'Error: th' further down, and a header of
     ours in front would make the first line the one thing node does not print. */
  return body.indexOf(header) >= 0 ? body : header + '\n' + body;
}

function hexByte(b) {
  return (b < 16 ? '0' : '') + b.toString(16);
}

function constructorNameOf(obj) {
  var proto = Object.getPrototypeOf(obj);
  if (proto === null) return null;
  var ctor = proto.constructor;
  return ctor && ctor.name ? ctor.name : '';
}

/* A null-prototype object is named by its Symbol.toStringTag, not by 'Object' -- that is why a
   module namespace prints as '[Module: null prototype]' where an untagged one prints as
   '[Object: null prototype]'. */
function nullPrototypeTagOf(obj) {
  var tag = obj[Symbol.toStringTag];
  return typeof tag === 'string' && tag !== '' ? tag : 'Object';
}

/* The symbol Node hands a class that wants to write its own inspect output. A value carrying one
   is printed exactly as that function writes it, which is why a Response prints its fields where
   an ordinary object of the same shape would print nothing at all. */
var INSPECT_CUSTOM = typeof Symbol.for === 'function' ? Symbol.for('nodejs.util.inspect.custom') : undefined;

/* The 'fmt' of the 'inspectValue' walk now printing, so a value read out of a promise can be
   printed at the depth the walk is at. One walk at a time, so one is all there is to remember. */
var INSPECT_FMT = null;

function inspectValue(value, opts) {
  var maxDepth = opts && typeof opts.depth === 'number' ? opts.depth : 2;
  var stack = [];
  /* The objects a circular reference points back at, numbered from 1 in the order one was met.
     Cleared for every walk, so the count starts again and '<ref *1>' belongs to this value. */
  var REF_IDS = new WeakMap();
  var REF_NEXT = 1;
  /* The deepest level the walk has reached inside the value it is printing now, which node's
     'compact' is measured against. Raised by every value as it is printed and restored as the walk
     comes back out of it, so the difference at the top of a value is how far it nests. */
  var SUB_MAX = 0;

  function fmt(v, depth, indent) {
    if (v === null) return 'null';
    var t = typeof v;
    if (t === 'string') return quoteStringLiteral(v);
    if (t === 'number') return Object.is(v, -0) ? '-0' : String(v);
    if (t === 'bigint') return String(v) + 'n';
    if (t === 'boolean' || t === 'undefined' || t === 'symbol') return String(v);
    if (t === 'function') {
      var name = v.name ? v.name : '';
      if (/^class[\s{]/.test(Function.prototype.toString.call(v))) return '[class ' + (name || '(anonymous)') + ']';
      /* The three families node names by what they are: '[AsyncFunction: foo]',
         '[GeneratorFunction: foo]' and '[AsyncGeneratorFunction: foo]', where a plain function is
         '[Function: foo]'. The value's own prototype is what says which of the four it is -- its
         '.constructor' is the AsyncFunction or the GeneratorFunction itself -- and a function out of
         a 'vm' context carries the prototype of its own realm, which names it the same way. */
      var fnProto = Object.getPrototypeOf(v);
      var fnKind = 'Function';
      if (fnProto !== null && fnProto !== undefined && fnProto.constructor &&
          typeof fnProto.constructor.name === 'string') {
        var fnCtorName = fnProto.constructor.name;
        if (fnCtorName === 'AsyncFunction' || fnCtorName === 'GeneratorFunction' ||
            fnCtorName === 'AsyncGeneratorFunction') fnKind = fnCtorName;
      }
      /* A function with no name is '[Function (anonymous)]' and not '[Function: (anonymous)]':
         the colon belongs to the name that follows it, and node writes none when there is no name
         to write -- which is what 'util.inspect(function () {})' prints on host node 24.15. */
      return name ? '[' + fnKind + ': ' + name + ']' : '[' + fnKind + ' (anonymous)]';
    }
    /* A value the walk is already inside. Node numbers the objects a '[Circular *n]' marker points
       back at -- in the order it meets them, from 1 -- and writes '<ref *n> ' in front of the one
       it renders, which is why 'o.self = o' prints '<ref *1> { self: [Circular *1] }' and not
       '{ self: [Circular] }'. The number is per value, so one object pointed at twice keeps it. */
    if (stack.indexOf(v) >= 0) {
      var seen = REF_IDS.get(v);
      if (seen === undefined) { seen = REF_NEXT++; REF_IDS.set(v, seen); }
      return '[Circular *' + seen + ']';
    }
    /* The tag and not 'instanceof': a value out of a 'vm' context is of another realm, so
       'instanceof' answers false for it on host Node 24.15 too, and what 'util.inspect' reads
       there is the internal slot the tag is the face of. Asking 'instanceof' here made an error
       out of a context print 'Error {}' where the host prints 'Error: boom', and a promise
       'Promise {}' where the host prints 'Promise { 1 }'. */
    var vTag = utilTag(v);
    if (vTag === 'Error') return errorInspectOf(v, fmt, depth, indent, opts);
    if (vTag === 'Date') return isNaN(v.getTime()) ? 'Invalid Date' : v.toISOString();
    if (vTag === 'RegExp') return String(v);
    if (vTag === 'Promise') return promiseInspectOf(v, depth, indent);

    /* The one thing a weak collection shows of what it holds: nothing, and that word. Node prints
       'WeakMap { <items unknown> }' and 'WeakSet { <items unknown> }' for every one, empty or not,
       where this walk would reach them as plain objects with no keys and print 'WeakMap {}'. */
    if (utilBrandCheck(WeakMap.prototype.has, v)) return 'WeakMap { <items unknown> }';
    if (utilBrandCheck(WeakSet.prototype.has, v)) return 'WeakSet { <items unknown> }';

    /* A value that writes its own output wins: Node asks the custom function before it looks at
       the object's own keys, which is the whole of what a Response or a Headers prints. */
    if (INSPECT_CUSTOM !== undefined && typeof v[INSPECT_CUSTOM] === 'function') {
      var written = v[INSPECT_CUSTOM](maxDepth - depth, opts, function (inner) { return inspectValue(inner, opts); });
      return typeof written === 'string' ? written : String(written);
    }

    var ctor = constructorNameOf(v);
    if (ctor === 'Buffer') {
      var shown = [];
      for (var b = 0; b < v.length && b < 50; b++) shown.push(hexByte(v[b]));
      var more = v.length > 50 ? ' ... ' + (v.length - 50) + ' more bytes' : '';
      return '<Buffer' + (shown.length ? ' ' + shown.join(' ') : '') + more + '>';
    }

    var isArr = Array.isArray(v);
    /* The tag and not 'instanceof' for the DataView exception as well: a DataView out of a 'vm'
       context is of another realm, so 'v instanceof DataView' is false for it here and on host Node
       24.15 alike, and the typed-array branch below printed it as 'DataView(undefined) []'. */
    var isTyped = !isArr && ArrayBuffer.isView(v) && vTag !== 'DataView';
    var bare = Object.getPrototypeOf(v) === null;
    if (depth > maxDepth) {
      if (isArr) return '[Array]';
      return '[' + (bare ? nullPrototypeTagOf(v) + ': null prototype' : (ctor || 'Object')) + ']';
    }
    /* An ArrayBuffer, a SharedArrayBuffer and a DataView print what no walk of own keys can reach:
       node gives them the pseudo-entries '[Uint8Contents]' and '[byteLength]' -- and '[byteOffset]'
       and '[buffer]' to a view -- which is why a 4-byte buffer prints
       'ArrayBuffer { [Uint8Contents]: <00 00 00 00>, [byteLength]: 4 }' and not 'ArrayBuffer {}'.
       The tag is what names them, so one a 'vm' context handed out prints the way host Node 24.15
       prints it and not as a typed array of no length at all. */
    if (vTag === 'ArrayBuffer' || vTag === 'SharedArrayBuffer') return bufferInspectOf(v, indent, opts);
    if (vTag === 'DataView') {
      /* The buffer it views is one level down, and it is the deepest thing a DataView holds. */
      if (depth + 1 > SUB_MAX) SUB_MAX = depth + 1;
      return dataViewInspectOf(v, depth, indent, opts);
    }

    stack.push(v);
    /* How deep the walk goes below this value, which is the other half of what 'compact' is
       measured against: node lines the entries up only while the deepest value nested in this one
       is fewer levels down than 'compact' allows. Every child raises SUB_MAX as it is printed, so
       the difference is read after the walk of them and not before. */
    var savedMax = SUB_MAX;
    SUB_MAX = depth;
    var entries = [];
    var open = '{';
    var close = '}';
    var prefix = '';
    var i;
    if (isArr) {
      open = '[';
      close = ']';
      if (ctor && ctor !== 'Array') prefix = ctor + '(' + v.length + ') ';
      var limit = Math.min(v.length, 100);
      for (i = 0; i < limit; i++) entries.push(fmt(v[i], depth + 1, indent + 2));
      if (v.length > 100) entries.push('... ' + (v.length - 100) + ' more item' + (v.length - 100 > 1 ? 's' : ''));
    } else if (isTyped) {
      open = '[';
      close = ']';
      prefix = ctor + '(' + v.length + ') ';
      for (i = 0; i < v.length && i < 100; i++) entries.push(String(v[i]));
      /* What is left over past the hundred node prints of a typed array is said in the same words
         it says the items of an ordinary array in: '... 1 more item', singular, and '... 2 more
         items' past that. */
      if (v.length > 100) entries.push('... ' + (v.length - 100) + ' more item' + (v.length - 100 > 1 ? 's' : ''));
    } else if (utilBrandCheck(Map.prototype.has, v)) {
      prefix = 'Map(' + v.size + ') ';
      v.forEach(function (val, key) {
        entries.push(fmt(key, depth + 1, indent + 2) + ' => ' + fmt(val, depth + 1, indent + 2));
      });
    } else if (utilBrandCheck(Set.prototype.has, v)) {
      prefix = 'Set(' + v.size + ') ';
      v.forEach(function (val) {
        entries.push(fmt(val, depth + 1, indent + 2));
      });
    } else {
      if (bare) prefix = '[' + nullPrototypeTagOf(v) + ': null prototype] ';
      else if (ctor && ctor !== 'Object') prefix = ctor + ' ';
    }

    /* The keys node reads: every own property name and every own symbol under 'showHidden', and
       only the enumerable ones without it. That is the whole of the distance between '{ [nh]: 1 }'
       -- bracketed, because the key is not enumerable -- and '{}': a key the default options do not
       read is one the walk never sees, so it prints nothing at all rather than a value. */
    var showHidden = !!(opts && opts.showHidden);
    var keys = showHidden ? Object.getOwnPropertyNames(v) : Object.keys(v);
    var syms = showHidden && typeof Object.getOwnPropertySymbols === 'function'
      ? Object.getOwnPropertySymbols(v)
      : utilEnumerableSymbols(v);
    for (i = 0; i < keys.length; i++) {
      if (isArr && /^\d+$/.test(keys[i])) continue;
      if (isTyped && /^\d+$/.test(keys[i])) continue;
      entries.push(inspectEntryOf(fmt, v, keys[i], depth + 1, indent + 2));
    }
    /* The own SYMBOL keys, after the string ones and in the order they were put on. Node writes one
       where a string key goes, as 'Symbol(k): 1' -- no brackets and no quotes -- for an ordinary
       object, for an array and for a Map alike, and it brackets the ones that are not enumerable,
       which is what 'showHidden' asks for. */
    for (var si = 0; si < syms.length; si++) {
      entries.push(inspectEntryOf(fmt, v, syms[si], depth + 1, indent + 2));
    }
    var subDepth = SUB_MAX - depth;
    SUB_MAX = savedMax > SUB_MAX ? savedMax : SUB_MAX;
    stack.pop();

    /* 'sorted: true' puts the entries in the order the default string sort gives, and a function
       given for the option is the comparator. Node sorts an array's extra keys alone and every other
       value's whole output, so an array of indices is left in the order it was written in. */
    if (opts && opts.sorted && !isArr && !isTyped) {
      entries.sort(typeof opts.sorted === 'function' ? opts.sorted : undefined);
    }

    /* Read after the walk of the children and not before: a value is only a '<ref *n>' once a
       circular reference inside it has been met, which happens while its entries are printed. */
    var refNo = REF_IDS.get(v);
    var head = refNo === undefined ? '' : '<ref *' + refNo + '> ';
    prefix = head + prefix;

    if (entries.length === 0) return prefix + open + close;
    var multiline = false;
    for (var e = 0; e < entries.length; e++) {
      if (entries[e].indexOf('\n') >= 0) multiline = true;
    }
    /* Node packs the entries of an array before it decides how to print them, and an array of more
       than six that it packs never goes back to one line: eighty numbers come out twelve
       right-aligned to a line, fourteen short strings three to a line, and '[1,2,3,4,5,6,7]' is
       '[\n  1, 2, 3, 4,\n  5, 6, 7\n]' on host node 24.15 and not '[ 1, 2, 3, 4, 5, 6, 7 ]'. The
       packing is node's own rule -- as near a square of entries as the line width, four times
       'compact' and fifteen columns allow, a character being about 2.5 times as high as it is
       wide -- and numbers and bigints are right-aligned in their column where every other kind is
       left-aligned. */
    var packed = false;
    var shown = entries;
    if ((isArr || isTyped) && entries.length > 6 && groupable(opts)) {
      shown = groupArrayElements(entries, v, indent, compactOf(opts));
      packed = shown.length !== entries.length;
    }
    var start = entries.length + indent + open.length + prefix.length + 10;
    var totalLength = entries.length + start;
    /* 'compact: false' is one entry per line and never a fit test: node's own inspect writes
       '[1,2,3,4,5,6,7,8]' on one line by default and one number to a line under that option. So is
       a 'compact' below one, and so is a value that nests as deep as a number 'compact' lower than
       that: '{ a: { b: 1 } }' is one line at the default 3 and three lines at 'compact: 1'. */
    var fits = !multiline && !packed && compactAllowsOneLine(opts, subDepth) && totalLength + entries.length <= 80;
    for (var s = 0; fits && s < entries.length; s++) {
      totalLength += entries[s].length;
      if (totalLength > 80) fits = false;
    }
    if (fits) return prefix + open + ' ' + entries.join(', ') + ' ' + close;
    var pad = ' '.repeat(indent + 2);
    return prefix + open + '\n' + shown.map(function (entry) { return pad + entry; }).join(',\n') + '\n' + ' '.repeat(indent) + close;
  }

  INSPECT_FMT = fmt;
  return fmt(value, 0, 0);
}

function padBy(order, text, width) {
  return order === 'padStart' ? text.padStart(width, ' ') : text.padEnd(width, ' ');
}

/* 'compact', the option node's own inspect carries: 3 unless the caller said otherwise, and the
   packing of an array's entries is only done at all when it is a number of at least one -- 'compact:
   false' and 'compact: true' both print one entry per line. It is also what caps the columns at
   four times itself. */
function compactOf(opts) {
  if (opts === undefined || opts === null || opts.compact === undefined) return 3;
  return opts.compact;
}

function groupable(opts) {
  var compact = compactOf(opts);
  return compact !== true && typeof compact === 'number' && compact >= 1;
}

/* How node packs the entries of an array too long for one line: the 'groupArrayElements' of its
   own inspect, ports and all, in the terms of this walk. 'output' is the entries as they print,
   'value' the array they came from -- only whether each of its items is a number or a bigint is
   asked of it, because that is what decides which way the entries are padded -- and 'indent' the
   indent the array itself is printed at. 80 is 'breakLength' and 3 is 'compact', both node's
   defaults, and 100 is 'maxArrayLength', whose '... n more items' is not an entry to pack. */
function groupArrayElements(output, value, indent, compact) {
  var totalLength = 0;
  var maxLength = 0;
  var outputLength = output.length;
  if (100 < output.length) outputLength--;
  var dataLen = new Array(outputLength);
  for (var i = 0; i < outputLength; i++) {
    var len = output[i].length;
    dataLen[i] = len;
    totalLength += len + 2;
    if (maxLength < len) maxLength = len;
  }
  var actualMax = maxLength + 2;
  /* At least three entries have to fit next to each other, and an array whose entries are of very
     different lengths is left alone -- one entry longer than a fifth of all of them would leave
     an enormous gap beside the short ones. */
  if (actualMax * 3 + indent >= 80 ||
      (totalLength / actualMax <= 5 && maxLength > 6)) return output;
  var averageBias = Math.sqrt(actualMax - totalLength / output.length);
  var biasedMax = Math.max(actualMax - 3 - averageBias, 1);
  var columns = Math.min(
    Math.round(Math.sqrt(2.5 * biasedMax * outputLength) / biasedMax),
    Math.floor((80 - indent) / actualMax),
    compact * 4,
    15
  );
  if (columns <= 1) return output;
  var maxLineLength = [];
  for (var c = 0; c < columns; c++) {
    var lineMaxLength = 0;
    for (var j = c; j < output.length; j += columns) {
      if (dataLen[j] > lineMaxLength) lineMaxLength = dataLen[j];
    }
    maxLineLength[c] = lineMaxLength + 2;
  }
  var order = 'padStart';
  if (value !== undefined) {
    for (var q = 0; q < output.length; q++) {
      if (typeof value[q] !== 'number' && typeof value[q] !== 'bigint') { order = 'padEnd'; break; }
    }
  }
  var tmp = [];
  for (var at = 0; at < outputLength; at += columns) {
    var last = Math.min(at + columns, outputLength);
    var line = '';
    var k = at;
    for (; k < last - 1; k++) {
      /* Numbers and bigints are padded on the left of the comma and every other kind on the right,
         which is why a column of numbers is right-aligned numbers -- '0' in a column two wide
         prints as ' 0, ' and not as '   0, ' -- and a column of booleans is not. */
      line += padBy(order, output[k] + ', ', maxLineLength[k - at] + output[k].length - dataLen[k]);
    }
    if (order === 'padStart') line += output[k].padStart(maxLineLength[k - at] + output[k].length - dataLen[k] - 2, ' ');
    else line += output[k];
    tmp.push(line);
  }
  if (100 < output.length) tmp.push(output[outputLength]);
  return tmp;
}

function formatLogArgs(args) {
  var out = [];
  var start = 0;
  var first = args[0];
  if (typeof first === 'string' && args.length > 1 && first.indexOf('%') >= 0) {
    var text = '';
    var argIndex = 1;
    for (var j = 0; j < first.length; j++) {
      var ch = first.charAt(j);
      if (ch === '%' && j + 1 < first.length) {
        var spec = first.charAt(j + 1);
        if (spec === '%') {
          text += '%';
          j++;
          continue;
        }
        if (argIndex < args.length && 'sdifjoOc'.indexOf(spec) >= 0) {
          var a = args[argIndex++];
          j++;
          if (spec === 's') text += typeof a === 'string' ? a : (typeof a === 'object' && a !== null ? inspectValue(a, { depth: 1 }) : String(a));
          else if (spec === 'd' || spec === 'i') text += String(spec === 'i' ? parseInt(a, 10) : Number(a));
          else if (spec === 'f') text += String(parseFloat(a));
          else if (spec === 'j') text += JSON.stringify(a);
          else if (spec === 'o' || spec === 'O') text += inspectValue(a);
          continue;
        }
      }
      text += ch;
    }
    out.push(text);
    start = argIndex;
  }
  for (var i = start; i < args.length; i++) {
    out.push(typeof args[i] === 'string' ? args[i] : inspectValue(args[i]));
  }
  return out.join(' ');
}

function deepEqualValues(a, b, strict) {
  if (strict ? Object.is(a, b) : (a == b || (a !== a && b !== b))) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (strict && Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (a instanceof RegExp && b instanceof RegExp) return String(a) === String(b);
  if (a instanceof Error && b instanceof Error) {
    if (a.message !== b.message || a.name !== b.name) return false;
  }
  if (a instanceof Map && b instanceof Map) {
    if (a.size !== b.size) return false;
    var mapOk = true;
    a.forEach(function (val, key) {
      if (!b.has(key) || !deepEqualValues(val, b.get(key), strict)) mapOk = false;
    });
    return mapOk;
  }
  if (a instanceof Set && b instanceof Set) {
    if (a.size !== b.size) return false;
    var setOk = true;
    a.forEach(function (val) {
      if (b.has(val)) return;
      var found = false;
      b.forEach(function (other) {
        if (!found && deepEqualValues(val, other, strict)) found = true;
      });
      if (!found) setOk = false;
    });
    return setOk;
  }
  var ka = Object.keys(a);
  var kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (var i = 0; i < ka.length; i++) {
    if (!Object.prototype.hasOwnProperty.call(b, ka[i])) return false;
    if (!deepEqualValues(a[ka[i]], b[ka[i]], strict)) return false;
  }
  return true;
}

/*
 * TextEncoder, as the encoding standard and Node 24.15 have it: what an encoder knows of itself it
 * knows off the prototype and not off the instance, so Object.keys of one is empty and 'encoding'
 * is an accessor beside 'encode' and 'encodeInto'; and encodeInto writes into the Uint8Array it is
 * handed, stopping at the code point that would not fit, and answers how much of the string it
 * read and how many bytes it wrote -- a whole code point at a time, never half of one.
 */
var TEXT_ENCODER_STATE = new WeakMap();
function TextEncoderImpl() {
  TEXT_ENCODER_STATE.set(this, true);
}
/* 'Received <what>' as Node's own argument errors spell it: null and undefined bare, a primitive as
   its type and its value, and anything else as an instance of the constructor it came from. */
function encodeArgReceived(v) {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (typeof v !== 'object') {
    if (typeof v === 'symbol') return 'type symbol (' + String(v) + ')';
    if (typeof v === 'string') return 'type string (\'' + v + '\')';
    return 'type ' + typeof v + ' (' + String(v) + ')';
  }
  var n = v.constructor && v.constructor.name;
  return 'an instance of ' + (typeof n === 'string' && n !== '' ? n : 'Object');
}
/* 'Value of "this" must be of type TextEncoder': the brand no probe of the value itself gives,
   since an encoder carries nothing of its own -- only the record beside it says this object was
   ever built by this constructor. */
function textEncoderThis(state) {
  if (state !== true) {
    throw textDecoderError(TypeError, 'ERR_INVALID_THIS', 'Value of "this" must be of type TextEncoder');
  }
}
Object.defineProperty(TextEncoderImpl.prototype, 'encoding', {
  get: function () { textEncoderThis(TEXT_ENCODER_STATE.get(this)); return 'utf-8'; },
  enumerable: true, configurable: true
});
TextEncoderImpl.prototype.encode = function (input) {
  textEncoderThis(TEXT_ENCODER_STATE.get(this));
  return encodeUtf8(input === undefined ? '' : String(input));
};
TextEncoderImpl.prototype.encodeInto = function (input, dest) {
  textEncoderThis(TEXT_ENCODER_STATE.get(this));
  if (typeof input !== 'string') {
    throw textDecoderError(TypeError, 'ERR_INVALID_ARG_TYPE',
      'The "src" argument must be of type string. Received ' + encodeArgReceived(input));
  }
  if (!(dest instanceof Uint8Array)) {
    throw textDecoderError(TypeError, 'ERR_INVALID_ARG_TYPE',
      'The "dest" argument must be an instance of Uint8Array. Received ' + encodeArgReceived(dest));
  }
  var read = 0;
  var written = 0;
  var i = 0;
  while (i < input.length) {
    var unit = input.charCodeAt(i);
    var next = 1;
    var cp = unit;
    if (unit >= 0xd800 && unit <= 0xdbff && i + 1 < input.length) {
      var low = input.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        cp = 0x10000 + ((unit - 0xd800) << 10) + (low - 0xdc00);
        next = 2;
      }
    }
    /* A half of a pair whose other half is not there is not a code point at all, and the standard
       answers it with the replacement character rather than with the bytes of a surrogate. */
    var seq = (unit >= 0xd800 && unit <= 0xdfff && next === 1) ? [0xef, 0xbf, 0xbd]
      : cp < 0x80 ? [cp]
      : cp < 0x800 ? [0xc0 | (cp >> 6), 0x80 | (cp & 0x3f)]
      : cp < 0x10000 ? [0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f)]
      : [0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f)];
    if (written + seq.length > dest.length) break;
    for (var k = 0; k < seq.length; k++) dest[written + k] = seq[k];
    written += seq.length;
    i += next;
    read += next;
  }
  return { read: read, written: written };
};
/* Its name, which a program reads off the constructor, is 'TextEncoder' and not the name it was
   built under here. */
Object.defineProperty(TextEncoderImpl, 'name', { value: 'TextEncoder', configurable: true });
Object.defineProperty(TextEncoderImpl.prototype, Symbol.toStringTag, { value: 'TextEncoder', configurable: true });
/* The one argument encode takes is optional in Node's own signature and so is absent from its
   length: the arity a program reads is 0, and the method reads its argument all the same. */
Object.defineProperty(TextEncoderImpl.prototype.encode, 'length', { value: 0, configurable: true });

/*
 * TextDecoder, as the encoding standard and Node 24.15 have it: a label names one of the
 * encodings below and is answered by its canonical name, and one no label names is a RangeError
 * and not a decoder that answers garbage. What a decoder knows of itself -- encoding, fatal,
 * ignoreBOM -- the host reads off accessors on the prototype, so a decoder has no own names at all
 * and its streaming state is kept beside it, in a WeakMap, rather than on it.
 */
var TEXT_DECODER_LABELS = {
  'utf-8': 'utf-8', 'utf8': 'utf-8', 'unicode-1-1-utf-8': 'utf-8',
  'utf-16le': 'utf-16le', 'utf-16': 'utf-16le', 'ucs-2': 'utf-16le', 'unicode': 'utf-16le',
  'utf-16be': 'utf-16be',
  'latin1': 'windows-1252', 'iso-8859-1': 'windows-1252', 'iso8859-1': 'windows-1252',
  'windows-1252': 'windows-1252', 'cp1252': 'windows-1252', 'ascii': 'windows-1252',
  'us-ascii': 'windows-1252'
};
/* The single-byte encoding the label 'latin1' names: every byte below 0x80 and above 0x9f is the
   code point it already is, and the run between them is what windows-1252 puts there, which is
   not what latin-1 does -- a decoder that answered latin-1 would print a control character where
   Node prints a euro sign or a curly quote. */
var WINDOWS_1252_HIGH = {
  0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026, 0x86: 0x2020,
  0x87: 0x2021, 0x88: 0x02c6, 0x89: 0x2030, 0x8a: 0x0160, 0x8b: 0x2039, 0x8c: 0x0152,
  0x8e: 0x017d, 0x91: 0x2018, 0x92: 0x2019, 0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022,
  0x96: 0x2013, 0x97: 0x2014, 0x98: 0x02dc, 0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a,
  0x9c: 0x0153, 0x9e: 0x017e, 0x9f: 0x0178
};
var TEXT_DECODER_STATE = new WeakMap();

function textDecoderError(Ctor, code, message) {
  var err = new Ctor(message);
  err.code = code;
  return err;
}

/** The bytes of anything decode() is allowed to be given, or undefined if it is not allowed. */
function decodeInputBytes(input) {
  if (input instanceof ArrayBuffer || (typeof SharedArrayBuffer === 'function' && input instanceof SharedArrayBuffer)) {
    return new Uint8Array(input);
  }
  if (typeof ArrayBuffer.isView === 'function' && ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  return undefined;
}

/**
 * UTF-8, decoded the way the standard walks it: a lead byte says how many continuations follow and
 * what range the first of them may fall in -- which is what makes 0xc0 0x80, an overlong encoding
 * of NUL, invalid where a naive count would accept it. That array is the bytes of this chunk behind
 * the ones a previous chunk left; on a stream an incomplete sequence at the end is left for the
 * next chunk, and off a stream it is one replacement character.
 */
function decodeUtf8Run(values, fatal, stream) {
  var out = '';
  var i = 0;
  var n = values.length;
  while (i < n) {
    var b = values[i];
    var need, cp, lower, upper, k, c, ok;
    if (b <= 0x7f) { out += String.fromCharCode(b); i += 1; continue; }
    if (b >= 0xc2 && b <= 0xdf) { need = 1; cp = b & 0x1f; lower = 0x80; upper = 0xbf; }
    else if (b >= 0xe0 && b <= 0xef) {
      need = 2; cp = b & 0x0f;
      lower = b === 0xe0 ? 0xa0 : 0x80;
      upper = b === 0xed ? 0x9f : 0xbf;
    } else if (b >= 0xf0 && b <= 0xf4) {
      need = 3; cp = b & 0x07;
      lower = b === 0xf0 ? 0x90 : 0x80;
      upper = b === 0xf4 ? 0x8f : 0xbf;
    } else {
      if (fatal) throw textDecoderError(TypeError, 'ERR_ENCODING_INVALID_ENCODED_DATA', 'The encoded data was not valid for encoding utf-8');
      out += '�'; i += 1; continue;
    }
    if (i + need >= n) {
      /* A sequence the input ends in the middle of is one replacement character and no more: the
         bytes behind the lead are part of the sequence that failed and are not read again, which
         is what makes two truncated bytes one character where reading them again would make two.
         On a stream they are kept for the chunk that completes them. */
      if (stream) return { out: out, rest: values.slice(i) };
      if (fatal) throw textDecoderError(TypeError, 'ERR_ENCODING_INVALID_ENCODED_DATA', 'The encoded data was not valid for encoding utf-8');
      return { out: out + '�', rest: [] };
    }
    ok = true;
    for (k = 1; k <= need; k++) {
      c = values[i + k];
      if (c < (k === 1 ? lower : 0x80) || c > (k === 1 ? upper : 0xbf)) { ok = false; break; }
      cp = (cp << 6) | (c & 0x3f);
    }
    if (!ok) {
      /* The byte that broke the sequence is read again as the start of the next one -- which is
         what makes 'c3 28' a replacement character followed by '(' and not two of them. */
      if (fatal) throw textDecoderError(TypeError, 'ERR_ENCODING_INVALID_ENCODED_DATA', 'The encoded data was not valid for encoding utf-8');
      out += '�'; i += k; continue;
    }
    /* A code point past the basic plane is a surrogate pair, which is what string it as text. */
    if (cp > 0xffff) {
      cp -= 0x10000;
      out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
    } else out += String.fromCharCode(cp);
    i += need + 1;
  }
  return { out: out, rest: [] };
}

function decodeUtf16Run(values, little, stream) {
  var out = '';
  var i = 0;
  var n = values.length - (values.length % 2);
  for (; i < n; i += 2) {
    out += String.fromCharCode(little ? (values[i] | (values[i + 1] << 8)) : ((values[i] << 8) | values[i + 1]));
  }
  /* One byte left over: off a stream it is dropped, as the standard drops it; on a stream it waits
     for its pair. Either way a lone trailing byte is not an error the standard reports. */
  var rest = stream && values.length % 2 === 1 ? values.slice(values.length - 1) : [];
  return { out: out, rest: rest };
}

function textDecoderOptionsError(options) {
  /* A dictionary Node reads off an argument: an object is one, a function is one, and null and
     undefined are the absence of one. Anything else is refused in Node's own words, in which a
     string is quoted and every other type is printed as it prints. */
  if (options === undefined || options === null) return undefined;
  if (typeof options === 'object' || typeof options === 'function') return undefined;
  var got = typeof options === 'string' ? "string ('" + options + "')" : typeof options + ' (' + String(options) + ')';
  return textDecoderError(TypeError, 'ERR_INVALID_ARG_TYPE',
    'The "options" argument must be of type object. Received type ' + got);
}

function TextDecoderImpl(label, options) {
  /* Node's own is a class, and a class called without 'new' is refused in a class's own words --
     which name the class. This engine names the constructor differently, so what a program reads
     for the call is written here and the engine's own answer is never reached. */
  if (new.target === undefined) {
    throw new TypeError("Class constructor TextDecoder cannot be invoked without 'new'");
  }
  /* A label is a string, and one that is not -- a Symbol -- is refused by the conversion itself:
     String(symbol) would answer 'Symbol(s)', and this engine's own conversion answers it in words
     that are not Node's. Both are the same refusal, so the refusal is written here. */
  if (typeof label === 'symbol') throw new TypeError('Cannot convert a Symbol value to a string');
  var name = label === undefined ? 'utf-8' : '' + label;
  var canonical = TEXT_DECODER_LABELS[String(name).toLowerCase()];
  if (canonical === undefined) {
    throw textDecoderError(RangeError, 'ERR_ENCODING_NOT_SUPPORTED', 'The "' + name + '" encoding is not supported');
  }
  var bad = textDecoderOptionsError(options);
  if (bad !== undefined) throw bad;
  var opts = options === undefined || options === null ? {} : options;
  TEXT_DECODER_STATE.set(this, {
    encoding: canonical,
    fatal: Boolean(opts.fatal),
    ignoreBOM: Boolean(opts.ignoreBOM),
    /* The BOM is only ever the first thing a decoder sees: one is stripped from the first bytes
       of the stream and never from the middle of it, and a decoder told to ignore it keeps it as
       text. The flag is false until the first chunk has settled the question. */
    bom: false,
    rest: []
  });
}
/* The four the host's own prototype carries, and as the host carries them: a method and three
   accessors, all of them writable and enumerable, which is what makes Object.keys of the
   prototype answer their names. 'constructor' is the one name that is not. */
/* Which decoder a getter was asked about: the record beside it, or the brand error when there is
   no such record -- 'Value of "this" must be of type TextDecoder', which a getter reached with a
   foreign 'this' throws exactly as decode does. */
function textDecoderThis(target) {
  var state = TEXT_DECODER_STATE.get(target);
  if (state === undefined) {
    throw textDecoderError(TypeError, 'ERR_INVALID_THIS', 'Value of "this" must be of type TextDecoder');
  }
  return state;
}
Object.defineProperty(TextDecoderImpl.prototype, 'decode', { writable: true, enumerable: true, configurable: true });
Object.defineProperty(TextDecoderImpl.prototype, 'encoding', {
  get: function () { return textDecoderThis(this).encoding; }, enumerable: true, configurable: true
});
Object.defineProperty(TextDecoderImpl.prototype, 'fatal', {
  get: function () { return textDecoderThis(this).fatal; }, enumerable: true, configurable: true
});
Object.defineProperty(TextDecoderImpl.prototype, 'ignoreBOM', {
  get: function () { return textDecoderThis(this).ignoreBOM; }, enumerable: true, configurable: true
});
TextDecoderImpl.prototype.decode = function (input, options) {
  var state = TEXT_DECODER_STATE.get(this);
  /* 'Value of "this" must be of type TextDecoder': a brand no probe of the value itself can
     give, since a decoder has no own names and no tag of its own -- only the record beside it
     says this object was ever built by this constructor. */
  if (state === undefined) {
    throw textDecoderError(TypeError, 'ERR_INVALID_THIS', 'Value of "this" must be of type TextDecoder');
  }
  var bad = textDecoderOptionsError(options);
  if (bad !== undefined) throw bad;
  /* No argument at all is not "nothing to decode": it is the flush, and a stream that ended in the
     middle of a sequence still owes a replacement character for the bytes it kept. Only an argument
     that is there and is not bytes is the type error. */
  var bytes = [];
  if (input !== undefined) {
    bytes = decodeInputBytes(input);
    if (bytes === undefined) {
      throw textDecoderError(TypeError, 'ERR_INVALID_ARG_TYPE', 'The "list" argument must be an instance of SharedArrayBuffer, ArrayBuffer or ArrayBufferView.');
    }
  }
    var stream = options !== undefined && options !== null && Boolean(options.stream);
    var values = state.rest.slice();
    for (var i = 0; i < bytes.length; i++) values.push(bytes[i]);
    if (!state.bom && !state.ignoreBOM) {
      if (values.length >= 3) {
        state.bom = true;
        if (values[0] === 0xef && values[1] === 0xbb && values[2] === 0xbf) values = values.slice(3);
      } else if (stream && values.length > 0 && values[0] === 0xef) {
        /* Too early to say: the bytes could still turn out to be a BOM. */
        state.rest = values;
        return '';
      } else if (!stream) state.bom = true;
    }
    var run;
    if (state.encoding === 'utf-8') run = decodeUtf8Run(values, state.fatal, stream);
    else if (state.encoding === 'utf-16le' || state.encoding === 'utf-16be') {
      run = decodeUtf16Run(values, state.encoding === 'utf-16le', stream);
    } else {
      var out = '';
      for (var j = 0; j < values.length; j++) {
        var b = values[j];
        out += String.fromCharCode(b < 0x80 || b > 0x9f ? b : WINDOWS_1252_HIGH[b]);
      }
      run = { out: out, rest: [] };
    }
    state.rest = stream ? run.rest : [];
    return run.out;
  };
Object.defineProperty(TextDecoderImpl.prototype, 'decode', { enumerable: true, configurable: true });
/* Its name, which a program reads off the constructor, is 'TextDecoder' and not the name it was
   built under here. */
Object.defineProperty(TextDecoderImpl, 'name', { value: 'TextDecoder', configurable: true });
/* Both of the constructor's arguments are optional in Node's own signature too, so the arity a
   program reads off the constructor is 0 and not the 2 this implementation is written with. */
Object.defineProperty(TextDecoderImpl, 'length', { value: 0, configurable: true });
Object.defineProperty(TextDecoderImpl.prototype, Symbol.toStringTag, { value: 'TextDecoder', configurable: true });
/* The two arguments are optional in Node's own signature and so are absent from its length: the
   arity a program reads is 0, and the method reads its arguments all the same. */
Object.defineProperty(TextDecoderImpl.prototype.decode, 'length', { value: 0, configurable: true });

function utilArgError(code, message) {
  var err = new TypeError(message);
  err.code = code;
  return err;
}

function utilGetterOf(proto, name) {
  var desc = Object.getOwnPropertyDescriptor(proto, name);
  return desc && typeof desc.get === 'function' ? desc.get : null;
}

/* a brand check: the method or getter accepts the value only when it carries the matching internal slot */
function utilBrandCheck(fn, value) {
  if (fn === null || value === null || typeof value !== 'object') return false;
  try {
    fn.call(value);
    return true;
  } catch (err) {
    return false;
  }
}

var UTIL_TYPED_TAG = utilGetterOf(Object.getPrototypeOf(Uint8Array.prototype), Symbol.toStringTag);
var UTIL_ARRAY_BUFFER_LENGTH = utilGetterOf(ArrayBuffer.prototype, 'byteLength');
var UTIL_SHARED_BUFFER_LENGTH = typeof SharedArrayBuffer === 'function' ? utilGetterOf(SharedArrayBuffer.prototype, 'byteLength') : null;
var UTIL_DATA_VIEW_LENGTH = utilGetterOf(DataView.prototype, 'byteLength');

/*
 * A proxy is the one object no brand check and no tag can name: this engine answers nothing about
 * one, so util.types.isProxy had nothing to read. What it reads instead is a record of the proxies
 * this realm has made -- every one of them is built through a wrapper of the engine's own Proxy,
 * which keeps "new Proxy(t, h)", a subclass of Proxy and Proxy.revocable working exactly as they
 * did while leaving the record behind. The vm rebuild reads the same record through __owcIsProxy,
 * so a proxy a context hands back is still one when it crosses.
 */
var NATIVE_PROXY = globalThis.Proxy;
var NATIVE_REVOCABLE = NATIVE_PROXY.revocable;
var PROXIES_MADE = new WeakMap();
globalThis.Proxy = new NATIVE_PROXY(NATIVE_PROXY, {
  construct: function (target, args, newTarget) {
    var made = Reflect.construct(target, args, newTarget === undefined ? NATIVE_PROXY : newTarget);
    PROXIES_MADE.set(made, true);
    return made;
  }
});
Object.defineProperty(globalThis.Proxy, 'revocable', {
  value: function (target, handler) {
    var pair = NATIVE_REVOCABLE.call(NATIVE_PROXY, target, handler);
    PROXIES_MADE.set(pair.proxy, true);
    return pair;
  },
  writable: true, configurable: true
});
/* Written the way every name of the bridge is: this reaches the setter on the object behind the
   global object (see loader.ts) and so is no own name of it, where a walk of the global object's
   own names -- Object.keys, Object.getOwnPropertyNames -- would find it and Node's walk would not. */
globalThis.__owcIsProxy = function (value) {
  return value !== null && (typeof value === 'object' || typeof value === 'function') && PROXIES_MADE.has(value);
};
/*
 * What a promise settled with, which is the one thing about one no probe of this engine answers:
 * 'Object.getOwnPropertyNames(promise)' is '[]', and the state is a slot no reflection reaches,
 * so 'util.inspect' had no way to print 'Promise { 1 }' for a settled promise and answered
 * 'Promise { <pending> }' for every one -- where host Node 24.15 prints the value it settled with.
 * What it reads instead is a record of the promises this realm has seen settle: every promise
 * built through 'Promise' goes through one subclass, whose executor's 'resolve' and 'reject' are
 * wrapped so that the moment the promise settles the cell beside it holds how and with what.
 * The subclass is what 'globalThis.Promise' becomes, and it is the same shape the second realm of
 * a 'vm' context is given, so a promise a context makes is a recorded one as well.
 *
 * An 'async' function is the one gap and it is the engine's: its promise is built from the
 * intrinsic and never from the global binding, so no wrapper of 'Promise' sees it. Measured out
 * of the container with bare QuickJS 0.32, replacing 'globalThis.Promise' with a subclass leaves
 * '(async function () {})()' an instance of the native constructor and not of the subclass. Such a
 * promise is printed as pending, which is the answer for a promise that has not been seen settle.
 */
var NATIVE_PROMISE = globalThis.Promise;
var PROMISE_CELLS = new WeakMap();
class TrackedPromise extends NATIVE_PROMISE {
  constructor(executor) {
    var cell = { state: 0, value: undefined };
    if (typeof executor !== 'function') {
      /* 'new Promise()' with no resolver: the synchronous TypeError node raises, and not a
         rejection. The engine's own constructor throws one too -- 'not a function' -- but the
         rejection tracker's wrapper is under this one and turns the throw into a rejection, so
         it is raised here, where nothing is between it and the caller. */
      throw new TypeError('Promise resolver ' + String(executor) + ' is not a function');
    }
    super(function (resolve, reject) {
      /* What a promise settles with is the value the settling ends at, not the thenable it starts
         from: host node 24.15 prints 'Promise { 3 }' for 'Promise.resolve({ then: function (r)
         { r(3); } })' and 'Promise { 5 }' for 'new Promise(function (r) { r(Promise.resolve(5)); })'.
         A thenable is adopted by the engine alone -- it calls 'then' itself, and the value that
         call is handed reaches no wrapper -- so the resolve handed on here is a stand-in thenable
         of our own: it forwards the one call the engine makes and writes down what it was given.
         The real 'then' is still called once, by us and not twice over. */
      var resolveAdopting = function (value) {
        var then = undefined;
        try {
          if (value !== null && (typeof value === 'object' || typeof value === 'function')) then = value.then;
        } catch (x) { then = undefined; }
        if (typeof then !== 'function') {
          if (cell.state === 0) { cell.state = 1; cell.value = value; }
          return resolve(value);
        }
        /* A thenable leaves the promise pending until the adoption ends: host node 24.15 prints
           'Promise { <pending> }' for 'Promise.resolve({ then: ... })' read before the microtask
           that runs 'then', so the cell is left open here and the stand-in below closes it. */
        return resolve({
          then: function (onFulfilled, onRejected) {
            var wrote = function (how) {
              return function (inner) {
                if (cell.state === 0 || cell.state === 1) { cell.state = how; cell.value = inner; }
                return (how === 1 ? onFulfilled : onRejected)(inner);
              };
            };
            return then.call(value, wrote(1), wrote(2));
          }
        });
      };
      var took = function (how) {
        return function (value) {
          if (how !== 1) {
            if (cell.state === 0) { cell.state = how; cell.value = value; }
            return reject(value);
          }
          return resolveAdopting(value);
        };
      };
      var onResolve = took(1);
      var onReject = took(2);
      try {
        executor(onResolve, onReject);
      } catch (err) {
        onReject(err);
      }
    });
    PROMISE_CELLS.set(this, cell);
  }
}
/* A promise of a context, and one of this realm, both answer to the name 'Promise': host Node 24.15
   reads 'p.constructor.name' as 'Promise' for either, whatever class carries the record. */
Object.defineProperty(TrackedPromise, 'name', { value: 'Promise', configurable: true });
/* 'x instanceof Promise' stays true for a promise this wrapper never built -- an 'async' function's,
   which is of the native constructor -- exactly as 'instanceof' reads on the host. */
Object.defineProperty(TrackedPromise, Symbol.hasInstance, {
  value: function (x) { return x instanceof NATIVE_PROMISE; }, configurable: true
});
/* A promise derived from one -- 'p.then(...)', 'Promise.all([...])' -- is built through this
   constructor too, so it is a recorded one as the promise it came from was. */
Object.defineProperty(NATIVE_PROMISE, Symbol.species, {
  get: function () { return TrackedPromise; }, configurable: true
});
Object.defineProperty(globalThis, 'Promise', { value: TrackedPromise, writable: true, configurable: true });

/* 'Object.getOwnPropertyNames(Promise.prototype)' is 'catch', 'constructor', 'finally', 'then' on
   host Node 24.15, and is 'constructor' alone while 'Promise' is a subclass whose prototype is a
   fresh object: the three a promise answers to are own on the intrinsic's prototype and inherited
   here. They go on it -- the same functions under the same flags, so a promise reads them either
   way and only the list of own names changes. The rejection tracker of the process builds a
   subclass of this one for its own reasons and takes the same three from it, so both are complete. */
['then', 'catch', 'finally'].forEach(function (key) {
  var desc = Object.getOwnPropertyDescriptor(NATIVE_PROMISE.prototype, key);
  if (desc !== undefined) Object.defineProperty(TrackedPromise.prototype, key, desc);
});

/* The same record, written from the other side: the tracker of a 'vm' context's realm builds a
   cell of its own for every promise it sees, and hands it here so that a promise out of a context
   is in the record its own promises are in. It is the promise that is the key and not the cell,
   because the cell is what the promise is looked up by. */
globalThis.__owcNotePromise = function (promise, cell) {
  if (promise !== null && (typeof promise === 'object' || typeof promise === 'function')) PROMISE_CELLS.set(promise, cell);
};

/** What 'util.inspect' writes for a promise: the value it settled with, or why it is still open. */
function promiseInspectOf(v, depth, indent) {
  /* A subclass carries its own name in front: host node 24.15 prints 'P [Promise] { 1 }' for the
     promise 'class P extends Promise {}' resolves, and plain 'Promise { 1 }' for one whose
     constructor answers to the name 'Promise', which every promise this realm builds does. */
  var ctorText = constructorNameOf(v);
  var head = (ctorText && ctorText !== 'Promise' && ctorText !== 'Object') ? ctorText + ' [Promise]' : 'Promise';
  var cell = PROMISE_CELLS.get(v);
  if (cell === undefined || cell.state === 0) return head + ' { <pending> }';
  var inner = fmtPromiseValue(cell.value, depth, indent);
  var body = (cell.state === 2 ? '<rejected> ' : '') + inner;
  /* A value that prints on more than one line -- an error, whose stack is part of what it prints --
     opens the braces instead of sitting inside them: host node 24.15 writes
     'Promise {\n  <rejected> Error: r\n      at ...\n}' and not one line with a stack hanging off
     it. The rest of the value keeps its own indent, two in from the brace it is under. */
  if (body.indexOf('\n') >= 0) {
    var pad = ' '.repeat(indent + 2);
    return head + ' {\n' + pad + body.split('\n').join('\n' + pad) + '\n' + ' '.repeat(indent) + '}';
  }
  return head + ' { ' + body + ' }';
}

/* The value inside a promise, printed at the depth the promise itself is at: Node gives the
   settled value the one remaining level and no more, so 'Promise.resolve({a:{b:1}})' at depth 1
   prints 'Promise { { a: [Object] } }'. 'INSPECT_FMT' is the 'fmt' of the walk now printing, which
   is the only thing that can put a value at a depth. */
function fmtPromiseValue(value, depth, indent) {
  if (INSPECT_FMT === null) return typeof value === 'string' ? quoteStringLiteral(value) : String(value);
  return INSPECT_FMT(value, depth, indent);
}

/* One entry of an object-like value's output, in the terms node writes it. A key that is not
   enumerable is written in brackets -- '[nh]: 1' for a string key and '[Symbol(ne)]: 1' for a
   symbol -- and one that is an ACCESSOR is written as the descriptor it is and not as the value
   reading it would produce: node asks the descriptor before it reads, so '{ get a() { return 1 } }'
   is '{ a: [Getter] }' under the default options and not '{ a: 1 }', a setter alone is '[Setter]'
   and the pair is '[Getter/Setter]'. Only a plain data property is printed as its value. */
function inspectEntryOf(fmt, value, key, depth, indent) {
  var desc = undefined;
  try { desc = Object.getOwnPropertyDescriptor(value, key); } catch (e) { desc = undefined; }
  var text;
  if (desc !== undefined && (desc.get !== undefined || desc.set !== undefined)) {
    text = desc.get !== undefined ? (desc.set !== undefined ? '[Getter/Setter]' : '[Getter]') : '[Setter]';
  } else if (desc !== undefined && 'value' in desc) {
    text = fmt(desc.value, depth, indent);
  } else {
    text = fmt(value[key], depth, indent);
  }
  var name;
  if (typeof key === 'symbol') name = String(key);
  else name = isIdentifierKey(key) ? key : quoteStringLiteral(key);
  if (desc === undefined || desc.enumerable === false) name = '[' + name + ']';
  return name + ': ' + text;
}

/* The entries of an object-like value, one line when node's own fit test lets them be and one per
   line when it does not: the test the walk above uses, '{' and '}' for the braces, and two spaces
   of indent in front of every entry past the fit. 'subDepth' is how deep this value nests below
   the one being printed -- nothing for an ArrayBuffer, one buffer for a DataView -- and 'compact'
   is what it is measured against. */
function joinInspectEntries(prefix, entries, indent, opts, subDepth) {
  if (entries.length === 0) return prefix + '{}';
  var width = opts && typeof opts.breakLength === 'number' ? opts.breakLength : 80;
  var totalLength = entries.length + (entries.length + indent + 1 + prefix.length + 10);
  var fits = compactAllowsOneLine(opts, subDepth);
  for (var i = 0; fits && i < entries.length; i++) {
    totalLength += entries[i].length;
    if (totalLength > width) fits = false;
  }
  /* A prefix that already carries a line break -- the stack of an error, which is where its own
     properties hang -- never lets the entries line up behind it: node's own test asks the same, and
     that is why an error with a stack of two lines prints them and then '{\n  [stack]: ...\n}'. */
  if (fits && prefix.indexOf('\n') >= 0) fits = false;
  if (fits) return prefix + '{ ' + entries.join(', ') + ' }';
  var pad = ' '.repeat(indent + 2);
  return prefix + '{\n' + entries.map(function (entry) { return pad + entry; }).join(',\n') + '\n' + ' '.repeat(indent) + '}';
}

/* Whether node's 'compact' lets these entries go on one line at all. 'compact: false' is one entry
   per line and no fit test, and so is any 'compact' below one -- 0 included -- because node's own
   test is only reached for a number of at least one. A number that big still prints one entry per
   line for a value that nests as deep as that number, which is why an ArrayBuffer, with nothing
   nested in it, is one line at 'compact: 1' while a DataView, with a buffer nested in it, is not. */
function compactAllowsOneLine(opts, subDepth) {
  var compact = compactOf(opts);
  /* 'compact: true' is the one value that is not a number, and node's test is reached for it too --
     it is the option that asks for the tightest output there is, which is why
     'util.inspect({ a: { b: { c: 1 } } }, { compact: true })' stays on one line. */
  if (compact === true) return true;
  if (compact === false) return false;
  if (typeof compact !== 'number') return false;
  if (!(compact >= 1)) return false;
  return subDepth < compact;
}

/* What 'util.inspect' writes for an error: the report -- the header and the frames, or the
   bracketed stack -- and then the own properties node keeps for one, which are not the ones the
   report is made of. Without 'showHidden' the 'stack', and a 'message' or a 'name' the stack
   already carries, are left out; 'cause' goes in, and so do the 'errors' of an AggregateError,
   both bracketed because neither is enumerable. That is why an error carrying 'e.code = "ENOENT"'
   prints "[S] { code: 'ENOENT' }" and not "[S]". */
function errorInspectOf(err, fmt, depth, indent, opts) {
  var head = formatErrorStack(err);
  var showHidden = !!(opts && opts.showHidden);
  var keys = showHidden ? Object.getOwnPropertyNames(err) : Object.keys(err);
  if (!showHidden) {
    var stack = '';
    var message = undefined;
    var name = undefined;
    try { stack = err.stack === undefined || err.stack === null ? '' : String(err.stack); } catch (e) { stack = ''; }
    try { message = err.message; } catch (e) { message = undefined; }
    try { name = err.name; } catch (e) { name = undefined; }
    keys = keys.filter(function (k) {
      if (k === 'stack') return false;
      if (k === 'message') return !(typeof message === 'string' && stack.indexOf(message) >= 0);
      if (k === 'name') return !(typeof name === 'string' && stack.indexOf(name) >= 0);
      return true;
    });
  }
  if (Object.prototype.hasOwnProperty.call(err, 'cause') && keys.indexOf('cause') < 0) keys.push('cause');
  try {
    if (Array.isArray(err.errors) && Object.prototype.hasOwnProperty.call(err, 'errors') &&
        keys.indexOf('errors') < 0) keys.push('errors');
  } catch (e) { /* 'errors' is a getter that throws, and node ignores it too */ }
  if (keys.length === 0) return head;
  var entries = [];
  for (var i = 0; i < keys.length; i++) {
    entries.push(inspectEntryOf(fmt, err, keys[i], depth + 1, indent + 2));
  }
  if (opts && opts.sorted) entries.sort(typeof opts.sorted === 'function' ? opts.sorted : undefined);
  return joinInspectEntries(head + ' ', entries, indent, opts, 0);
}

/* The bytes a buffer prints: every one of them up to 'maxArrayLength' -- a hundred, node's default
   -- in lowercase hex two characters to a byte, and '... n more bytes' for the rest, inside the
   same angle brackets. That is why 'util.inspect(new ArrayBuffer(300))' prints a hundred bytes and
   '... 200 more bytes', and the same buffer under '{ maxArrayLength: 5 }' five and '... 295 more
   bytes'. A buffer that has been detached has no bytes to read and prints as none. */
function bufferBytesText(value, opts) {
  var max = opts && typeof opts.maxArrayLength === 'number' ? opts.maxArrayLength : 100;
  if (!(max >= 0)) max = 0;
  var bytes = [];
  var total = 0;
  try {
    var view = new Uint8Array(value);
    total = view.length;
    var shown = Math.min(view.length, max);
    for (var i = 0; i < shown; i++) bytes.push(hexByte(view[i]));
  } catch (e) { /* detached */ }
  var text = bytes.join(' ');
  /* The space in front of the ellipsis is node's and it is written whether or not any byte was
     printed, so a buffer under '{ maxArrayLength: 0 }' opens '< ... 4 more bytes>' and not
     '<... 4 more bytes>', and one byte left over is '... 1 more byte' -- singular, as node writes
     it -- where two are '... 2 more bytes'. */
  if (bytes.length < total) {
    var rest = total - bytes.length;
    text += ' ... ' + rest + ' more byte' + (rest === 1 ? '' : 's');
  }
  return '<' + text + '>';
}

/* What 'util.inspect' writes for an ArrayBuffer and for a SharedArrayBuffer. */
function bufferInspectOf(v, indent, opts) {
  var prefix = (constructorNameOf(v) || utilTag(v)) + ' ';
  var length = 0;
  try { length = v.byteLength; } catch (e) { /* detached */ }
  /* Nothing nests inside a buffer, so 'compact' is measured against a depth of 0. */
  return joinInspectEntries(prefix, ['[Uint8Contents]: ' + bufferBytesText(v, opts), '[byteLength]: ' + length], indent, opts, 0);
}

/* What 'util.inspect' writes for a DataView: the three things about it, the buffer it views last
   and at the next depth -- which is why 'util.inspect(new DataView(new ArrayBuffer(4)),
   { depth: 0 })' ends '[buffer]: [ArrayBuffer]' and not the buffer itself. */
function dataViewInspectOf(v, depth, indent, opts) {
  var prefix = (constructorNameOf(v) || 'DataView') + ' ';
  var length = 0;
  var offset = 0;
  try { length = v.byteLength; offset = v.byteOffset; } catch (e) { /* detached */ }
  var buffer = '[ArrayBuffer]';
  try {
    buffer = INSPECT_FMT === null ? '[ArrayBuffer]' : INSPECT_FMT(v.buffer, depth + 1, indent + 2);
  } catch (e) { /* detached */ }
  /* The buffer it views is one level of nesting, so 'compact' is measured against a depth of 1. */
  return joinInspectEntries(prefix, ['[byteLength]: ' + length, '[byteOffset]: ' + offset, '[buffer]: ' + buffer], indent, opts, 1);
}

/* the element type name of a typed array (Uint8Array and the rest), or undefined for any other value */
/* The own symbol keys of a value that 'util.inspect' prints: the enumerable ones, in the order
   they were put on. A non-enumerable symbol is not one of them, and neither is a symbol an object
   inherits -- both print as nothing at all, which is what host node 24.15 answers for each. */
function utilEnumerableSymbols(value) {
  if (typeof Object.getOwnPropertySymbols !== 'function') return [];
  var own = Object.getOwnPropertySymbols(value);
  var out = [];
  for (var i = 0; i < own.length; i++) {
    var shown = false;
    try { shown = Object.prototype.propertyIsEnumerable.call(value, own[i]); } catch (e) { shown = false; }
    if (shown) out.push(own[i]);
  }
  return out;
}

function utilTypedName(value) {  if (value === null || typeof value !== 'object') return undefined;
  if (UTIL_TYPED_TAG !== null) return UTIL_TYPED_TAG.call(value);
  var tag = Object.prototype.toString.call(value).slice(8, -1);
  return /Array$/.test(tag) ? tag : undefined;
}

function utilTag(value) {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return '';
  return Object.prototype.toString.call(value).slice(8, -1);
}

function utilIsArrayBuffer(value) {
  return utilBrandCheck(UTIL_ARRAY_BUFFER_LENGTH, value);
}

function utilIsSharedArrayBuffer(value) {
  return utilBrandCheck(UTIL_SHARED_BUFFER_LENGTH, value);
}

/* util.types in Node 24's key order */
function utilTypes() {
  function typedIs(name) {
    return function (value) {
      return utilTypedName(value) === name;
    };
  }
  return {
    isArgumentsObject: function (v) { return utilTag(v) === 'Arguments'; },
    isArrayBuffer: utilIsArrayBuffer,
    isAsyncFunction: function (v) {
      var tag = utilTag(v);
      return tag === 'AsyncFunction' || tag === 'AsyncGeneratorFunction';
    },
    isBigIntObject: function (v) { return typeof BigInt === 'function' && utilBrandCheck(BigInt.prototype.valueOf, v); },
    isBooleanObject: function (v) { return utilBrandCheck(Boolean.prototype.valueOf, v); },
    isDataView: function (v) { return utilBrandCheck(UTIL_DATA_VIEW_LENGTH, v); },
    isDate: function (v) { return utilTag(v) === 'Date'; },
    isExternal: function () { return false; },
    isGeneratorFunction: function (v) {
      var tag = utilTag(v);
      return tag === 'GeneratorFunction' || tag === 'AsyncGeneratorFunction';
    },
    isGeneratorObject: function (v) { return utilTag(v) === 'Generator'; },
    isMap: function (v) { return utilBrandCheck(Map.prototype.has, v); },
    isMapIterator: function (v) { return utilTag(v) === 'Map Iterator'; },
    isModuleNamespaceObject: function (v) { return utilTag(v) === 'Module'; },
    isNativeError: function (v) { return utilTag(v) === 'Error'; },
    isNumberObject: function (v) { return utilBrandCheck(Number.prototype.valueOf, v); },
    /* The tag and not 'instanceof': a promise out of a 'vm' context is of another realm, so
       'instanceof Promise' is false for it on host Node 24.15 as well, and 'util.types.isPromise'
       still answers true there -- it reads the internal slot and not the prototype. */
    isPromise: function (v) { return utilTag(v) === 'Promise'; },
    isProxy: function (v) { return globalThis.__owcIsProxy(v) === true; },
    isRegExp: function (v) { return utilTag(v) === 'RegExp'; },
    isSet: function (v) { return utilBrandCheck(Set.prototype.has, v); },
    isSetIterator: function (v) { return utilTag(v) === 'Set Iterator'; },
    isSharedArrayBuffer: utilIsSharedArrayBuffer,
    isStringObject: function (v) { return utilBrandCheck(String.prototype.valueOf, v); },
    isSymbolObject: function (v) { return utilBrandCheck(Symbol.prototype.valueOf, v); },
    isWeakMap: function (v) { return utilBrandCheck(WeakMap.prototype.has, v); },
    isWeakSet: function (v) { return utilBrandCheck(WeakSet.prototype.has, v); },
    isAnyArrayBuffer: function (v) { return utilIsArrayBuffer(v) || utilIsSharedArrayBuffer(v); },
    isBoxedPrimitive: function (v) {
      return utilBrandCheck(Number.prototype.valueOf, v) || utilBrandCheck(String.prototype.valueOf, v) ||
        utilBrandCheck(Boolean.prototype.valueOf, v) || utilBrandCheck(Symbol.prototype.valueOf, v) ||
        (typeof BigInt === 'function' && utilBrandCheck(BigInt.prototype.valueOf, v));
    },
    isArrayBufferView: function (v) { return ArrayBuffer.isView(v); },
    isTypedArray: function (v) { return utilTypedName(v) !== undefined; },
    isUint8Array: typedIs('Uint8Array'),
    isUint8ClampedArray: typedIs('Uint8ClampedArray'),
    isUint16Array: typedIs('Uint16Array'),
    isUint32Array: typedIs('Uint32Array'),
    isInt8Array: typedIs('Int8Array'),
    isInt16Array: typedIs('Int16Array'),
    isInt32Array: typedIs('Int32Array'),
    isFloat16Array: typedIs('Float16Array'),
    isFloat32Array: typedIs('Float32Array'),
    isFloat64Array: typedIs('Float64Array'),
    isBigInt64Array: typedIs('BigInt64Array'),
    isBigUint64Array: typedIs('BigUint64Array'),
    isKeyObject: function (v) { return v instanceof requireBuiltin('crypto').KeyObject; },
    isCryptoKey: function (v) { return v instanceof requireBuiltin('crypto').webcrypto.CryptoKey; }
  };
}

/* util.parseArgs: Node's tokenizer and strict checks; the messages are Node's */
function parseArgsImpl(config) {
  var cfg = config === undefined ? {} : config;
  if (cfg === null || typeof cfg !== 'object') {
    throw utilArgError('ERR_INVALID_ARG_TYPE', 'The "config" argument must be of type object.');
  }
  var args = cfg.args !== undefined ? cfg.args : (globalThis.process && Array.isArray(process.argv) ? process.argv.slice(2) : []);
  var strict = cfg.strict !== undefined ? cfg.strict : true;
  var allowPositionals = cfg.allowPositionals !== undefined ? cfg.allowPositionals : !strict;
  var returnTokens = cfg.tokens !== undefined ? cfg.tokens : false;
  var options = cfg.options !== undefined ? cfg.options : Object.create(null);
  if (!Array.isArray(args)) throw utilArgError('ERR_INVALID_ARG_TYPE', 'The "args" argument must be an instance of Array.');
  if (typeof strict !== 'boolean') throw utilArgError('ERR_INVALID_ARG_TYPE', 'The "strict" argument must be of type boolean.');
  if (typeof allowPositionals !== 'boolean') throw utilArgError('ERR_INVALID_ARG_TYPE', 'The "allowPositionals" argument must be of type boolean.');
  if (typeof returnTokens !== 'boolean') throw utilArgError('ERR_INVALID_ARG_TYPE', 'The "tokens" argument must be of type boolean.');
  if (options === null || typeof options !== 'object') throw utilArgError('ERR_INVALID_ARG_TYPE', 'The "options" argument must be of type object.');

  var names = Object.keys(options);
  for (var n = 0; n < names.length; n++) {
    var conf = options[names[n]];
    var where = 'options.' + names[n];
    if (conf === null || typeof conf !== 'object') {
      throw utilArgError('ERR_INVALID_ARG_TYPE', 'The "' + where + '" argument must be of type object.');
    }
    if (conf.type !== 'string' && conf.type !== 'boolean') {
      throw utilArgError('ERR_INVALID_ARG_VALUE', "The property '" + where + ".type' must be one of: 'string', 'boolean'.");
    }
    if (conf.short !== undefined) {
      if (typeof conf.short !== 'string') throw utilArgError('ERR_INVALID_ARG_TYPE', 'The "' + where + '.short" property must be of type string.');
      if (conf.short.length !== 1) throw utilArgError('ERR_INVALID_ARG_VALUE', "The property '" + where + ".short' must be a single character.");
    }
    if (conf.multiple !== undefined && typeof conf.multiple !== 'boolean') {
      throw utilArgError('ERR_INVALID_ARG_TYPE', 'The "' + where + '.multiple" property must be of type boolean.');
    }
  }

  function optionTypeOf(name) {
    return Object.prototype.hasOwnProperty.call(options, name) ? options[name].type : undefined;
  }

  function longNameOf(short) {
    for (var k = 0; k < names.length; k++) {
      if (options[names[k]].short === short) return names[k];
    }
    return short;
  }

  function unknownOption(rawName) {
    var hint = allowPositionals
      ? ". To specify a positional argument starting with a '-', place it at the end of the command after '--', as in '-- " + JSON.stringify(rawName) + "'"
      : '';
    return utilArgError('ERR_PARSE_ARGS_UNKNOWN_OPTION', "Unknown option '" + rawName + "'" + hint);
  }

  /* phase 1: the argument vector as tokens; a short-option group is expanded in place */
  var tokens = [];
  var index = -1;
  var groupCount = 0;
  var remaining = args.slice();
  while (remaining.length > 0) {
    var arg = remaining.shift();
    var nextArg = remaining[0];
    if (groupCount > 0) groupCount--;
    else index++;
    if (arg === '--') {
      tokens.push({ kind: 'option-terminator', index: index });
      while (remaining.length > 0) tokens.push({ kind: 'positional', index: ++index, value: remaining.shift() });
      break;
    }
    var isLong = arg.length > 2 && arg.charAt(0) === '-' && arg.charAt(1) === '-';
    var isShort = arg.length >= 2 && arg.charAt(0) === '-' && arg.charAt(1) !== '-';
    if (isShort && arg.length === 2) {
      var shortName = arg.charAt(1);
      var shortLong = longNameOf(shortName);
      var shortValue = undefined;
      var shortInline = undefined;
      if (optionTypeOf(shortLong) === 'string' && nextArg !== undefined) {
        shortValue = remaining.shift();
        shortInline = false;
      }
      tokens.push({ kind: 'option', name: shortLong, rawName: arg, index: index, value: shortValue, inlineValue: shortInline });
      if (shortValue !== undefined) ++index;
    } else if (isLong && arg.indexOf('=') === -1) {
      var longName = arg.slice(2);
      var longValue = undefined;
      var longInline = undefined;
      if (optionTypeOf(longName) === 'string' && nextArg !== undefined) {
        longValue = remaining.shift();
        longInline = false;
      }
      tokens.push({ kind: 'option', name: longName, rawName: arg, index: index, value: longValue, inlineValue: longInline });
      if (longValue !== undefined) ++index;
    } else if (isLong) {
      var equal = arg.indexOf('=');
      var attachedName = arg.slice(2, equal);
      tokens.push({ kind: 'option', name: attachedName, rawName: '--' + attachedName, index: index, value: arg.slice(equal + 1), inlineValue: true });
    } else if (isShort && optionTypeOf(longNameOf(arg.charAt(1))) === 'string') {
      var attachedShort = arg.charAt(1);
      tokens.push({ kind: 'option', name: longNameOf(attachedShort), rawName: '-' + attachedShort, index: index, value: arg.slice(2), inlineValue: true });
    } else if (isShort) {
      var group = [];
      for (var g = 1; g < arg.length; g++) group.push('-' + arg.charAt(g));
      remaining = group.concat(remaining);
      groupCount = group.length;
    } else {
      tokens.push({ kind: 'positional', index: index, value: arg });
    }
  }

  /* phase 2: strict checks and stored values */
  var values = Object.create(null);
  var positionals = [];
  var result = { values: values, positionals: positionals };
  if (returnTokens) result.tokens = tokens;

  function checkOptionUsage(token) {
    if (!Object.prototype.hasOwnProperty.call(options, token.name)) throw unknownOption(token.rawName);
    var conf = options[token.name];
    var shortAndLong = conf.short !== undefined ? '-' + conf.short + ', --' + token.name : '--' + token.name;
    if (conf.type === 'string' && typeof token.value !== 'string') {
      throw utilArgError('ERR_PARSE_ARGS_INVALID_OPTION_VALUE', "Option '" + shortAndLong + " <value>' argument missing");
    }
    if (conf.type === 'boolean' && token.value !== undefined) {
      throw utilArgError('ERR_PARSE_ARGS_INVALID_OPTION_VALUE', "Option '" + shortAndLong + "' does not take an argument");
    }
  }

  function checkOptionLikeValue(token) {
    if (!token.inlineValue && typeof token.value === 'string' && token.value.charAt(0) === '-') {
      var isShortForm = token.rawName.length === 2;
      throw utilArgError('ERR_PARSE_ARGS_INVALID_OPTION_VALUE',
        "Option '" + token.rawName + "' argument is ambiguous.\nDid you forget to specify the option argument for '" + token.rawName +
        "'?\nTo specify an option argument starting with a dash use '--" + token.name + "=-XYZ'" +
        (isShortForm ? " or '" + token.rawName + "-XYZ'" : '') + '.');
    }
  }

  function storeOption(name, value) {
    if (name === '__proto__') return;
    var conf = Object.prototype.hasOwnProperty.call(options, name) ? options[name] : {};
    var stored = value === undefined ? true : value;
    if (conf.multiple) {
      if (values[name] === undefined) values[name] = [];
      values[name].push(stored);
    } else {
      values[name] = stored;
    }
  }

  for (var t = 0; t < tokens.length; t++) {
    var token = tokens[t];
    if (token.kind === 'option') {
      if (strict) {
        checkOptionUsage(token);
        checkOptionLikeValue(token);
      }
      storeOption(token.name, token.value);
    } else if (token.kind === 'positional') {
      if (!allowPositionals) {
        throw utilArgError('ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL',
          "Unexpected argument '" + token.value + "'. This command does not take positional arguments");
      }
      positionals.push(token.value);
    }
  }

  /* phase 3: defaults for options that did not appear */
  for (var d = 0; d < names.length; d++) {
    var dconf = options[names[d]];
    if (values[names[d]] === undefined && dconf.default !== undefined) values[names[d]] = dconf.default;
  }
  return result;
}

BF.util = function () {
  var EE = null;
  var util = {
    format: function () {
      return formatLogArgs(arguments);
    },
    formatWithOptions: function (opts) {
      return formatLogArgs(Array.prototype.slice.call(arguments, 1));
    },
    inspect: function (value, opts) {
      return inspectValue(value, opts);
    },
    inherits: function (ctor, superCtor) {
      Object.setPrototypeOf(ctor.prototype, superCtor.prototype);
      Object.setPrototypeOf(ctor, superCtor);
      ctor.super_ = superCtor;
    },
    promisify: function (fn) {
      return function () {
        var self = this;
        var args = Array.prototype.slice.call(arguments);
        return new Promise(function (resolve, reject) {
          args.push(function (err, value) {
            if (err) reject(err);
            else resolve(value);
          });
          fn.apply(self, args);
        });
      };
    },
    callbackify: function (fn) {
      return function () {
        var args = Array.prototype.slice.call(arguments);
        var cb = args.pop();
        fn.apply(this, args).then(function (value) { cb(null, value); }, function (err) { cb(err); });
      };
    },
    deprecate: function (fn) {
      return fn;
    },
    debuglog: function () {
      return function () {};
    },
    isDeepStrictEqual: function (a, b) {
      return deepEqualValues(a, b, true);
    },
    __isDeepEqual: deepEqualValues,
    isArray: Array.isArray,
    isString: function (v) { return typeof v === 'string'; },
    isNumber: function (v) { return typeof v === 'number'; },
    isFunction: function (v) { return typeof v === 'function'; },
    isObject: function (v) { return v !== null && typeof v === 'object'; },
    stripVTControlCharacters: function (s) {
      return String(s).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
    },
    /*
     * The name of an errno, e.g. -2 -> 'ENOENT'. The table is libuv's, shared with
     * process.binding('uv').errname through __owcErrname, which globals.ts sets. Node rejects
     * anything that is not a negative integer with ERR_OUT_OF_RANGE, and so does this: execa takes
     * getSystemErrorName over the old binding when it finds one, so it has to behave the same way.
     */
    getSystemErrorName: function (err) {
      if (typeof err !== 'number') {
        var typeError = new TypeError('The "err" argument must be of type number. Received type ' + typeof err);
        typeError.code = 'ERR_INVALID_ARG_TYPE';
        throw typeError;
      }
      if (!Number.isInteger(err) || err >= 0) {
        var rangeError = new RangeError('The value of "err" is out of range. It must be a negative integer. Received ' + err);
        rangeError.code = 'ERR_OUT_OF_RANGE';
        throw rangeError;
      }
      var errname = globalThis.__owcErrname;
      return typeof errname === 'function' ? errname(err) : 'UNKNOWN';
    },
    types: utilTypes(),
    parseArgs: parseArgsImpl,
    TextEncoder: TextEncoderImpl,
    TextDecoder: TextDecoderImpl
  };
  return util;
};

BF['util/types'] = function () {
  return requireBuiltin('util').types;
};

BF.assert = function () {
  var util = requireBuiltin('util');

  function AssertionError(options) {
    var err = new Error(options.message);
    err.name = 'AssertionError';
    err.code = 'ERR_ASSERTION';
    err.actual = options.actual;
    err.expected = options.expected;
    err.operator = options.operator;
    err.generatedMessage = !options.userMessage;
    return err;
  }

  function fail(actual, expected, message, operator, defaultMessage) {
    if (message instanceof Error) throw message;
    throw AssertionError({
      message: message !== undefined ? message : defaultMessage,
      actual: actual,
      expected: expected,
      operator: operator,
      userMessage: message !== undefined
    });
  }

  function assertOk(value, message) {
    if (!value) fail(value, true, message, '==', 'The expression evaluated to a falsy value:\n\n  assert.ok(' + inspectValue(value) + ')\n');
  }

  var assert = function ok() {
    if (arguments.length === 0) fail(undefined, true, undefined, '==', 'No value argument passed to assert.ok()');
    assertOk(arguments[0], arguments[1]);
  };
  assert.ok = assertOk;
  assert.AssertionError = function (options) { return AssertionError(options); };
  assert.fail = function (message) {
    fail(undefined, undefined, message === undefined ? 'Failed' : message, 'fail', 'Failed');
  };
  assert.equal = function (actual, expected, message) {
    if (!(actual == expected || (actual !== actual && expected !== expected))) {
      fail(actual, expected, message, '==', inspectValue(actual) + ' == ' + inspectValue(expected));
    }
  };
  assert.notEqual = function (actual, expected, message) {
    if (actual == expected) fail(actual, expected, message, '!=', inspectValue(actual) + ' != ' + inspectValue(expected));
  };
  assert.strictEqual = function (actual, expected, message) {
    if (!Object.is(actual, expected)) {
      fail(actual, expected, message, 'strictEqual', 'Expected values to be strictly equal:\n\n' + inspectValue(actual) + ' !== ' + inspectValue(expected) + '\n');
    }
  };
  assert.notStrictEqual = function (actual, expected, message) {
    if (Object.is(actual, expected)) fail(actual, expected, message, 'notStrictEqual', 'Expected "actual" to be strictly unequal to: ' + inspectValue(expected));
  };
  assert.deepEqual = function (actual, expected, message) {
    if (!util.__isDeepEqual(actual, expected, false)) fail(actual, expected, message, 'deepEqual', 'Expected values to be loosely deep-equal:\n\n' + inspectValue(actual) + '\n\nshould loosely deep-equal\n\n' + inspectValue(expected));
  };
  assert.deepStrictEqual = function (actual, expected, message) {
    if (!util.__isDeepEqual(actual, expected, true)) fail(actual, expected, message, 'deepStrictEqual', 'Expected values to be strictly deep-equal:\n' + inspectValue(actual) + '\n\nshould equal\n\n' + inspectValue(expected));
  };
  assert.notDeepStrictEqual = function (actual, expected, message) {
    if (util.__isDeepEqual(actual, expected, true)) fail(actual, expected, message, 'notDeepStrictEqual', 'Expected "actual" not to be strictly deep-equal to: ' + inspectValue(expected));
  };
  assert.notDeepEqual = function (actual, expected, message) {
    if (util.__isDeepEqual(actual, expected, false)) fail(actual, expected, message, 'notDeepEqual', 'Expected "actual" not to be loosely deep-equal to: ' + inspectValue(expected));
  };
  assert.throws = function (fn, expected, message) {
    var threw = false;
    var error;
    try {
      fn();
    } catch (e) {
      threw = true;
      error = e;
    }
    if (!threw) fail(undefined, expected, typeof expected === 'string' ? expected : message, 'throws', 'Missing expected exception.');
    if (typeof expected === 'function' && expected.prototype !== undefined && !(error instanceof expected)) throw error;
    if (expected instanceof RegExp && !expected.test(String(error && error.message !== undefined ? error.message : error))) throw error;
  };
  assert.doesNotThrow = function (fn, message) {
    try {
      fn();
    } catch (e) {
      fail(e, undefined, message, 'doesNotThrow', 'Got unwanted exception.\nActual message: "' + (e && e.message) + '"');
    }
  };
  assert.rejects = function (promiseOrFn) {
    var promise = typeof promiseOrFn === 'function' ? promiseOrFn() : promiseOrFn;
    return promise.then(function () {
      fail(undefined, undefined, undefined, 'rejects', 'Missing expected rejection.');
    }, function () {
      return undefined;
    });
  };
  assert.match = function (string, regexp, message) {
    if (!regexp.test(string)) fail(string, regexp, message, 'match', 'The input did not match the regular expression ' + String(regexp));
  };
  assert.strict = assert;
  return assert;
};
`;
