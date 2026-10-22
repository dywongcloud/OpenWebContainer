/**
 * Guest-side source compatibility. Plain JavaScript inside String.raw, prepended to
 * LOADER_SRC. A CommonJS module is rewritten only after QuickJS rejects the whole module that
 * Node accepts (see compileCjsWrapper in loader.ts), so one that compiles today is never
 * rewritten. An ES module cannot be recompiled after it fails, so the host asks for its rewrite
 * through api.compatRewrite and uses it only when it changes the source and a test compile shows
 * the engine rejects the source as it is (esmSource in process.ts).
 * Three rewrites, each exact in meaning:
 *  - a regex literal the engine rejects gets each identity hyphen escape replaced by the hex
 *    escape of the same character (QuickJS rejects backslash-minus inside a class under the u
 *    flag; a hex escape is an atom, never a range operator);
 *  - a class element named get, set or async and followed by a semicolon is written as the quoted
 *    name, declaring the same field (QuickJS parses the bare form as an accessor and fails with
 *    "invalid property name");
 *  - a for-of whose iterable holds a yield gets that iterable hoisted into a const of its own,
 *    because QuickJS 0.31 and 0.32 abort the compile with 'stack underflow' and the loop then
 *    reads the value from the const (see rxForOfYields).
 * Function.prototype.toString puts that hoist back out before it prints, so a body that was
 * rewritten still prints the source it was written with.
 * The scanner tracks strings, template literals, comments, regex literals (previous-token rule),
 * control headers, object literals and class bodies, so only real literals and class elements are
 * touched: a '/' is a regex where a value cannot continue and a division where one can.
 */
export const REGEX_COMPAT_SRC = String.raw`
var RX_NATIVE_REGEXP = RegExp;
var RX_REGEX_AFTER_WORD ={ 'return': 1, 'typeof': 1, 'instanceof': 1, 'in': 1, 'of': 1, 'new': 1, 'delete': 1, 'void': 1, 'throw': 1, 'case': 1, 'do': 1, 'else': 1, 'yield': 1, 'await': 1 };
var RX_CTRL_PAREN = { 'if': 1, 'while': 1, 'for': 1, 'with': 1, 'switch': 1 };
var RX_BLOCK_WORD = { 'do': 1, 'else': 1, 'try': 1, 'catch': 1, 'finally': 1 };
var RX_BLOCK_AFTER = { ';': 1, '{': 1, '}': 1, ')': 1, ']': 1, 'hdr': 1, '=>': 1 };
var RX_VALUE_WORD = { 'this': 1, 'super': 1, 'null': 1, 'true': 1, 'false': 1 };
var RX_ELEMENT_NAME = { 'get': 1, 'set': 1, 'async': 1 };
function rxIsSpace(c) {
  return c === 32 || (c >= 9 && c <= 13) || c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
}
function rxIsNewline(c) { return c === 10 || c === 13 || c === 0x2028 || c === 0x2029; }
function rxIsIdStart(c) {
  return (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c === 36 || c === 95 || (c > 127 && !rxIsSpace(c));
}
function rxIsIdPart(c) { return rxIsIdStart(c) || (c >= 48 && c <= 57); }
function rxSkip(src, i, st) {
  var n = src.length;
  while (i < n) {
    var c = src.charCodeAt(i);
    if (rxIsSpace(c)) {
      if (rxIsNewline(c)) st.nl = true;
      i++;
      continue;
    }
    if (c === 47) {
      var d = src.charCodeAt(i + 1);
      if (d === 47) {
        i += 2;
        while (i < n && !rxIsNewline(src.charCodeAt(i))) i++;
        continue;
      }
      if (d === 42) {
        var end = src.indexOf('*/', i + 2);
        if (end < 0) return n;
        for (var k = i; k < end; k++) if (rxIsNewline(src.charCodeAt(k))) st.nl = true;
        i = end + 2;
        continue;
      }
    }
    return i;
  }
  return i;
}
function rxTemplateText(src, i) {
  var n = src.length;
  while (i < n) {
    var c = src.charCodeAt(i);
    if (c === 92) { i += 2; continue; }
    if (c === 96) return { next: i + 1, sub: false };
    if (c === 36 && src.charCodeAt(i + 1) === 123) return { next: i + 2, sub: true };
    i++;
  }
  return { next: n, sub: false };
}
function rxReadRegex(src, start) {
  var n = src.length, i = start + 1, inClass = false;
  while (i < n) {
    var c = src.charCodeAt(i);
    if (rxIsNewline(c)) return null;
    if (c === 92) { i += 2; continue; }
    if (inClass) { if (c === 93) inClass = false; }
    else if (c === 91) inClass = true;
    else if (c === 47) break;
    i++;
  }
  if (i >= n) return null;
  var flagEnd = i + 1;
  while (flagEnd < n && rxIsIdPart(src.charCodeAt(flagEnd))) flagEnd++;
  return { s: start, e: flagEnd, body: src.slice(start + 1, i), flags: src.slice(i + 1, flagEnd) };
}
/* A '/' that follows one of these can only be a division, not a regex, so long as it stays on the
   same line: an object literal, a call or a group ends a value. After a line break the value is
   already a whole statement and the '/' starts a new one, so there it is a regex again. */
function rxRegexAllowed(last, nl) {
  if (last === null || last.k === 'kw') return true;
  if (last.k !== 'p') return false;
  if (last.v === ')' || last.v === ']' || last.v === 'obj}') return nl;
  return true;
}
/* Whether a value may stand where the last token ended: after '=', '(', '[', ',' or an operator it
   may, after ';', '{', '}', ')' (a body follows), a control header, '=>' or a block keyword it may
   not. Both the class expression and the object literal are told apart by this. */
function rxValuePosition(last) {
  if (last === null) return false;
  if (last.k === 'p') return !RX_BLOCK_AFTER.hasOwnProperty(last.v);
  return (last.k === 'kw' || last.k === 'id') && !RX_BLOCK_WORD.hasOwnProperty(last.v);
}
function rxScan(src) {
  var n = src.length, i = 0, st = { nl: false }, look = { nl: false };
  var stack = [], regexes = [], names = [], fors = [];
  var last = null, classHead = -1, classValue = false;
  /* for the third rewrite: where the last identifier token began, what stood before it, and the
     label (if any) that the most recent ':' closed. A label is recorded only when it is a statement
     label: 'case x:' and 'default:' open a clause, and a statement cannot be inserted before them.
     pendingLabelPrev is what stood before that label, which says whether the label is itself a bare
     body: 'if (c) lbl: for (...)' has nowhere to put a declaration either side of the label. */
  var lastIdStart = -1, lastIdPrev = null, pendingLabel = -1, pendingLabelPrev = null;
  while (i < n) {
    i = rxSkip(src, i, st);
    if (i >= n) break;
    var nl = st.nl;
    st.nl = false;
    var c = src.charCodeAt(i);
    if (rxIsIdStart(c) || c === 92) {
      var j = i + 1;
      while (j < n) {
        var d = src.charCodeAt(j);
        if (rxIsIdPart(d)) j++;
        else if (d === 92) j += 2;
        else break;
      }
      var word = src.slice(i, j);
      var afterDot = last !== null && last.k === 'p' && (last.v === '.' || last.v === '?.');
      if (word === 'class' && !afterDot) {
        var nx = rxSkip(src, j, look);
        if (nx < n && (rxIsIdStart(src.charCodeAt(nx)) || src.charCodeAt(nx) === 123)) {
          classHead = stack.length;
          classValue = rxValuePosition(last);
        }
      }
      if (!afterDot && RX_ELEMENT_NAME.hasOwnProperty(word) && stack.length > 0 &&
          (stack[stack.length - 1] === 'C' || stack[stack.length - 1] === 'c')) {
        var starts = last !== null && ((last.k === 'p' && (last.v === '{' || last.v === ';' || last.v === '}' || last.v === 'obj}')) ||
          (last.k === 'id' && last.v === 'static') ||
          (nl && (last.k === 'val' || last.k === 'id' || (last.k === 'p' && (last.v === ')' || last.v === ']')))));
        if (starts) {
          var semi = rxSkip(src, j, look);
          if (semi < n && src.charCodeAt(semi) === 59) names.push({ s: i, e: j, text: '"' + word + '"' });
        }
      }
      var prevTok = last;
      if (!afterDot && RX_REGEX_AFTER_WORD.hasOwnProperty(word)) last = { k: 'kw', v: word };
      else if (afterDot || RX_VALUE_WORD.hasOwnProperty(word)) last = { k: 'val', v: word };
      else last = { k: 'id', v: word };
      if (last.k === 'id') { lastIdPrev = prevTok; lastIdStart = i; }
      if (word === 'for' && !afterDot) {
        fors.push({ s: i, pk: prevTok === null ? null : prevTok.k, pv: prevTok === null ? null : prevTok.v, ls: pendingLabel, lp: pendingLabelPrev });
      }
      i = j;
      continue;
    }
    if ((c >= 48 && c <= 57) || (c === 46 && src.charCodeAt(i + 1) >= 48 && src.charCodeAt(i + 1) <= 57)) {
      var k2 = i + 1;
      while (k2 < n && (rxIsIdPart(src.charCodeAt(k2)) || src.charCodeAt(k2) === 46)) k2++;
      last = { k: 'val', v: '' };
      i = k2;
      continue;
    }
    if (c === 34 || c === 39) {
      var k3 = i + 1;
      while (k3 < n) {
        var e3 = src.charCodeAt(k3);
        if (e3 === 92) { k3 += src.charCodeAt(k3 + 1) === 13 && src.charCodeAt(k3 + 2) === 10 ? 3 : 2; continue; }
        if (e3 === c || rxIsNewline(e3)) break;
        k3++;
      }
      last = { k: 'val', v: '' };
      i = k3 < n && src.charCodeAt(k3) === c ? k3 + 1 : k3;
      continue;
    }
    if (c === 96) {
      var t1 = rxTemplateText(src, i + 1);
      last = t1.sub ? { k: 'p', v: 'tsub' } : { k: 'val', v: '' };
      if (t1.sub) stack.push('T');
      i = t1.next;
      continue;
    }
    if (c === 47) {
      var re = rxRegexAllowed(last, nl) ? rxReadRegex(src, i) : null;
      if (re !== null) {
        regexes.push(re);
        last = { k: 'val', v: '' };
        i = re.e;
        continue;
      }
      last = { k: 'p', v: '/' };
      i += src.charCodeAt(i + 1) === 61 ? 2 : 1;
      continue;
    }
    if (c === 40 || c === 91) {
      if (c === 40) {
        /* the header of if, while, for, with and switch ends with a ')' that a regex may follow
           ('if (a) /x/.test(b)'), unlike the ')' of a call or a grouping; the stack remembers which
           one it opened so the '/' after it is read as a regex and not as a division */
        stack.push(last !== null && last.k === 'id' && RX_CTRL_PAREN.hasOwnProperty(last.v) ? 'K' : 'P');
        last = { k: 'p', v: '(' };
      } else {
        stack.push('A');
        last = { k: 'p', v: '[' };
      }
      i++;
      continue;
    }
    if (c === 123) {
      if (classHead === stack.length) {
        /* 'c' is a class expression: its body ends a value, so a '/' after it divides */
        stack.push(classValue ? 'c' : 'C');
        classHead = -1;
      } else if (rxValuePosition(last)) stack.push('O');
      else stack.push('B');
      last = { k: 'p', v: '{' };
      i++;
      continue;
    }
    if (c === 125) {
      if (stack.length > 0 && stack[stack.length - 1] === 'T') {
        stack.pop();
        var t2 = rxTemplateText(src, i + 1);
        last = t2.sub ? { k: 'p', v: 'tsub' } : { k: 'val', v: '' };
        if (t2.sub) stack.push('T');
        i = t2.next;
        continue;
      }
      var closedBrace = stack.pop();
      last = { k: 'p', v: closedBrace === 'O' || closedBrace === 'c' ? 'obj}' : '}' };
      i++;
      continue;
    }
    if (c === 41 || c === 93) {
      var closed = stack.pop();
      last = { k: 'p', v: c === 93 ? ']' : (closed === 'K' ? 'hdr' : ')') };
      i++;
      continue;
    }
    if ((c === 43 || c === 45) && src.charCodeAt(i + 1) === c) {
      last = { k: 'val', v: '' };
      i += 2;
      continue;
    }
    if (c === 63 && src.charCodeAt(i + 1) === 46 && !(src.charCodeAt(i + 2) >= 48 && src.charCodeAt(i + 2) <= 57)) {
      last = { k: 'p', v: '.' };
      i += 2;
      continue;
    }
    if (c === 46) {
      i += src.charCodeAt(i + 1) === 46 && src.charCodeAt(i + 2) === 46 ? 3 : 1;
      last = { k: 'p', v: '.' };
      continue;
    }
    if (c === 61 && src.charCodeAt(i + 1) === 62) {
      last = { k: 'p', v: '=>' };
      i += 2;
      continue;
    }
    if (c === 58) {
      var labelled = last !== null && last.k === 'id' && last.v !== 'default' &&
        !(lastIdPrev !== null && lastIdPrev.k === 'kw' && lastIdPrev.v === 'case');
      pendingLabel = labelled ? lastIdStart : -1;
      pendingLabelPrev = labelled ? lastIdPrev : null;
    }
    last = { k: 'p', v: String.fromCharCode(c) };
    i++;
  }
  return { regexes: regexes, names: names, fors: fors };
}
function rxCompiles(body, flags) {
  try { new RX_NATIVE_REGEXP(body, flags); return true; } catch (e) { return false; }
}
function rxFixBody(body) {
  var out = '';
  var n = body.length;
  for (var k = 0; k < n; k++) {
    var ch = body.charAt(k);
    if (ch === '\\' && k + 1 < n) {
      var nx = body.charAt(k + 1);
      out += nx === '-' ? '\\x2d' : ch + nx;
      k++;
    } else {
      out += ch;
    }
  }
  return out;
}
function rxSkipString(src, i, quote) {
  var n = src.length, k = i + 1;
  while (k < n) {
    var c = src.charCodeAt(k);
    if (c === 92) { k += src.charCodeAt(k + 1) === 13 && src.charCodeAt(k + 2) === 10 ? 3 : 2; continue; }
    if (c === quote || rxIsNewline(c)) break;
    k++;
  }
  return k < n && src.charCodeAt(k) === quote ? k + 1 : k;
}
/* A template literal is walked rather than skipped whole, so a yield inside a substitution is seen
   and the substitution's own '}' is not taken for the '}' of an enclosing block: the braces of the
   substitution and of any object literal in it balance, so '}' closes the innermost one. */
function rxWalkTemplate(src, i, stop) {
  var n = stop === undefined ? src.length : stop;
  var td = 0, sawYield = false, k = i + 1;
  while (k < n) {
    var c = src.charCodeAt(k);
    if (c === 92) { k += 2; continue; }
    if (c === 96 && td === 0) { k++; break; }
    if (c === 36 && src.charCodeAt(k + 1) === 123) { td++; k += 2; continue; }
    if (c === 123) { td++; k++; continue; }
    if (c === 125) { if (td > 0) td--; k++; continue; }
    if (td > 0 && rxIsIdStart(c)) {
      var j = k + 1;
      while (j < n && rxIsIdPart(src.charCodeAt(j))) j++;
      if (src.slice(k, j) === 'yield') sawYield = true;
      k = j;
      continue;
    }
    k++;
  }
  return { next: k, sawYield: sawYield };
}
/* Whether the slice holds a yield at all. Brackets do not decide it: one inside an array element, an
   index, a group or an object literal of the iterable is still the generator's own, and one inside a
   nested function body belongs to that function -- but hoisting that one is value- and order-neutral
   as well, since the const only evaluates the same iterable in the same place, so any yield in the
   iterable is reason enough to want the hoist. */
function rxHasTopYield(src, s, e) {
  var q = s;
  while (q < e) {
    q = rxSkip(src, q, { nl: false });
    if (q >= e) break;
    var c = src.charCodeAt(q);
    if (c === 40 || c === 91 || c === 123 || c === 41 || c === 93 || c === 125) { q++; continue; }
    if (c === 34 || c === 39) { q = rxSkipString(src, q, c); continue; }
    if (c === 96) {
      var w = rxWalkTemplate(src, q, e);
      if (w.sawYield) return true;
      q = w.next;
      continue;
    }
    if (rxIsIdStart(c)) {
      var j = q + 1;
      while (j < e && rxIsIdPart(src.charCodeAt(j))) j++;
      if (src.slice(q, j) === 'yield') return true;
      q = j;
      continue;
    }
    q++;
  }
  return false;
}
/* Where the statement that follows a control header runs out: at its ';', or at the '}' or ')'
   that closes whatever it is standing in. Used only to brace a loop that needs a declaration of
   its own and has nowhere to put one. A loop that owns a block body ends with that block: the
   statements after it are siblings of the loop, not part of it, and must stay outside the brace. */
function rxStatementEnd(src, s) {
  var n = src.length, q = rxSkip(src, s, { nl: false });
  if (q < n && src.charCodeAt(q) === 123) {
    var d = 0, k = q;
    while (k < n) {
      k = rxSkip(src, k, { nl: false });
      if (k >= n) break;
      var b = src.charCodeAt(k);
      if (b === 34 || b === 39) { k = rxSkipString(src, k, b); continue; }
      if (b === 96) { k = rxWalkTemplate(src, k).next; continue; }
      if (b === 123) { d++; k++; continue; }
      if (b === 125) { k++; if (--d === 0) return k; continue; }
      k++;
    }
    return n;
  }
  return rxStatementScan(src, q);
}
function rxStatementScan(src, s) {
  var n = src.length, d = 0, q = s;
  while (q < n) {
    q = rxSkip(src, q, { nl: false });
    if (q >= n) break;
    var c = src.charCodeAt(q);
    if (c === 40 || c === 91 || c === 123) { d++; q++; continue; }
    if (c === 41 || c === 93 || c === 125) { if (d === 0) return q; d--; q++; continue; }
    if (c === 59 && d === 0) return q + 1;
    if (c === 34 || c === 39) { q = rxSkipString(src, q, c); continue; }
    if (c === 96) { q = rxWalkTemplate(src, q).next; continue; }
    q++;
  }
  return n;
}
/* QuickJS 0.31 and 0.32 raise 'stack underflow' while compiling 'for (const x of (yield e))' and
   the same shape under 'for await', so the iterable is evaluated into a const of its own and the
   loop reads it from there. The iterable of a for-of is evaluated once, before the first step of
   the iterator, so hoisting it changes no value and no order. The const goes before the for only
   where a statement may start (and before its label when the for carries one); anywhere else the
   loop is left alone rather than rewritten into something that does not parse. */
function rxForOfYields(src, fors) {
  var out = [], seq = 0;
  for (var f = 0; f < fors.length; f++) {
    var t = fors[f];
    var insertAt = t.s, brace = false;
    if (t.pk === 'p' && t.pv === ':') {
      /* after a ':' a statement may start: a label keeps the loop labelled only if the const goes
         before the label, and a 'case' or 'default' clause takes the const where the loop stood */
      if (t.ls >= 0) {
        insertAt = t.ls;
        /* the label may itself be the bare body of if, while, for, with, do or else, where no
           declaration may stand before it either: there the label and its loop are braced together */
        if (t.lp !== null && (t.lp.v === 'hdr' || t.lp.k === 'kw')) brace = true;
      }
    } else if (t.pk === null || (t.pk === 'p' && (t.pv === '{' || t.pv === '}' || t.pv === ';' || t.pv === 'obj}'))) {
      /* a statement list: the const simply goes before the loop */
    } else if (t.pv === 'hdr' || t.pk === 'kw') {
      /* the bare body of if, while, for, with, do or else: no declaration can stand before the
         loop there, so the loop and its declaration are braced together */
      brace = true;
    } else continue;
    var n = src.length;
    var p = rxSkip(src, t.s + 3, { nl: false });
    if (src.slice(p, p + 5) === 'await') {
      var an = p + 5;
      if (an >= n || !rxIsIdPart(src.charCodeAt(an))) p = rxSkip(src, an, { nl: false });
    }
    if (p >= n || src.charCodeAt(p) !== 40) continue;
    var depth = 1, ofAt = -1, closeAt = -1, semi = false, dotBefore = false, q = p + 1;
    while (q < n) {
      q = rxSkip(src, q, { nl: false });
      if (q >= n) break;
      var c = src.charCodeAt(q);
      if (c === 40 || c === 91 || c === 123) { depth++; dotBefore = false; q++; continue; }
      if (c === 41) {
        depth--;
        if (depth === 0) { closeAt = q; break; }
        dotBefore = false;
        q++;
        continue;
      }
      if (c === 93 || c === 125) { depth--; dotBefore = false; q++; continue; }
      if (c === 59 && depth === 1) semi = true;
      if (c === 46) { dotBefore = true; q++; continue; }
      if (c === 34 || c === 39) { q = rxSkipString(src, q, c); dotBefore = false; continue; }
      if (c === 96) { q = rxWalkTemplate(src, q).next; dotBefore = false; continue; }
      if (rxIsIdStart(c)) {
        var j = q + 1;
        while (j < n && rxIsIdPart(src.charCodeAt(j))) j++;
        if (!dotBefore && depth === 1 && !semi && ofAt < 0 && src.slice(q, j) === 'of') ofAt = q;
        dotBefore = false;
        q = j;
        continue;
      }
      if (c === 63 && src.charCodeAt(q + 1) === 46) { dotBefore = true; q += 2; continue; }
      dotBefore = false;
      q++;
    }
    if (ofAt < 0 || closeAt < 0) continue;
    var iterS = rxSkip(src, ofAt + 2, { nl: false });
    var iterE = closeAt;
    while (iterE > iterS && rxIsSpace(src.charCodeAt(iterE - 1))) iterE--;
    if (iterE <= iterS || !rxHasTopYield(src, iterS, iterE)) continue;
    if (brace) {
      var endAt = rxStatementEnd(src, closeAt + 1);
      if (endAt <= closeAt + 1) continue;
    }
    /* The name says whether the loop was braced: the un-hoist in Function.prototype.toString has to
       take the brace it added back out, and a '{ ' stands before a hoist in a function body as
       readily as before one this rewrite braced, so the text after the const cannot tell them
       apart. The 'B' is inside the name, so no freshness check or printed shape changes. */
    var name = '';
    do { seq++; name = (brace ? '__owcOfB' : '__owcOf') + seq; } while (src.indexOf(name) >= 0);
    var declare = 'const ' + name + ' = ' + src.slice(iterS, iterE) + '; ';
    out.push({ s: insertAt, e: insertAt, text: brace ? '{ ' + declare : declare });
    out.push({ s: iterS, e: iterE, text: name });
    if (brace) out.push({ s: endAt, e: endAt, text: ' }' });
  }
  return out;
}
function rxRewrite(src) {
  var scan = rxScan(src);
  var edits = [];
  for (var k = 0; k < scan.regexes.length; k++) {
    var re = scan.regexes[k];
    if (rxCompiles(re.body, re.flags)) continue;
    var fixed = rxFixBody(re.body);
    if (fixed !== re.body && rxCompiles(fixed, re.flags)) edits.push({ s: re.s, e: re.e, text: '/' + fixed + '/' + re.flags });
  }
  for (var m = 0; m < scan.names.length; m++) edits.push(scan.names[m]);
  var hoisted = rxForOfYields(src, scan.fors);
  for (var h = 0; h < hoisted.length; h++) edits.push(hoisted[h]);
  if (edits.length === 0) return null;
  edits.sort(function (a, b) { return a.s - b.s; });
  var out = '', at = 0;
  for (var q = 0; q < edits.length; q++) {
    out += src.slice(at, edits[q].s) + edits[q].text;
    at = edits[q].e;
  }
  return out + src.slice(at);
}
/* The third rewrite edits source text, and the engine prints the source it compiled, so without a
   fix Function.prototype.toString shows the hoist this file added instead of the body that was
   written. These take the hoist back out: the declaration the rewrite inserted is removed, the
   iterable is put back where it stood and the brace a braced pair added is closed again, so a
   function prints the text it was written with. The name the rewrite chose is fresh per source, so
   a '__owcOf' run in a printed body is always one this file put there. */
function rxDeclEnd(src, s) {
  var n = src.length, depth = 0, q = s;
  while (q < n) {
    q = rxSkip(src, q, { nl: false });
    if (q >= n) break;
    var c = src.charCodeAt(q);
    if (c === 40 || c === 91 || c === 123) { depth++; q++; continue; }
    if (c === 41 || c === 93 || c === 125) { depth--; q++; continue; }
    if (c === 34 || c === 39) { q = rxSkipString(src, q, c); continue; }
    if (c === 96) { q = rxWalkTemplate(src, q).next; continue; }
    if (c === 59 && depth === 0) return q;
    q++;
  }
  return -1;
}
/* The ')' that closes the header of the for the hoist was written for, read the way rxForOfYields
   reads it, so the end of that for's statement is found at the same place it was inserted. */
function rxForClose(src, from) {
  var n = src.length, q = rxSkip(src, from, { nl: false });
  if (src.slice(q, q + 5) === 'await' && !rxIsIdPart(src.charCodeAt(q + 5))) q = rxSkip(src, q + 5, { nl: false });
  if (q >= n || src.charCodeAt(q) !== 40) return -1;
  var depth = 1, k = q + 1;
  while (k < n) {
    k = rxSkip(src, k, { nl: false });
    if (k >= n) break;
    var c = src.charCodeAt(k);
    if (c === 40 || c === 91 || c === 123) { depth++; k++; continue; }
    if (c === 41) { depth--; if (depth === 0) return k; k++; continue; }
    if (c === 93 || c === 125) { depth--; k++; continue; }
    if (c === 34 || c === 39) { k = rxSkipString(src, k, c); continue; }
    if (c === 96) { k = rxWalkTemplate(src, k).next; continue; }
    k++;
  }
  return -1;
}
/* One '__owcOf<digits>' run and nothing longer, so '__owcOf1' is not found inside '__owcOf10'. */
function rxFindName(src, name, from) {
  var n = src.length, m = name.length, k = from;
  while (k >= 0 && k < n) {
    k = src.indexOf('__owcOf', k);
    if (k < 0) return -1;
    if (src.slice(k, k + m) === name && !rxIsIdPart(src.charCodeAt(k + m))) return k;
    k += 7;
  }
  return -1;
}
function rxUnhoist(src) {
  var guard = 0, seek = 0;
  while (guard++ < 64) {
    var p = src.indexOf('const __owcOf', seek);
    if (p < 0) break;
    var n0 = src.length, k = p + 13, braced = false;
    if (src.charCodeAt(k) === 66) { braced = true; k++; }
    while (k < n0 && src.charCodeAt(k) >= 48 && src.charCodeAt(k) <= 57) k++;
    if (k === p + 13 || (braced && k === p + 14)) { seek = p + 1; continue; }
    var name = src.slice(p + 6, k);
    var eq = rxSkip(src, k, { nl: false });
    if (eq >= n0 || src.charCodeAt(eq) !== 61) { seek = p + 1; continue; }
    var s = rxSkip(src, eq + 1, { nl: false });
    var semi = rxDeclEnd(src, s);
    if (semi < 0) { seek = p + 1; continue; }
    var expr = src.slice(s, semi);
    var end = semi + 1;
    if (src.charCodeAt(end) === 32) end++;
    var head = braced ? p - 2 : p;
    var use = rxFindName(src.slice(end), name, 0);
    /* A '__owcOf' this file did not write -- a string in the body can hold the same text -- has no
       use to put the iterable back into, so it is skipped and the search moves past it. */
    if (use < 0) { seek = p + 1; continue; }
    var out = src.slice(0, head) + src.slice(end, end + use) + expr + src.slice(end + use + name.length);
    if (braced) {
      var close = rxForClose(out, head + 3);
      if (close < 0) { seek = p + 1; continue; }
      var stop = rxStatementEnd(out, close + 1);
      if (stop < 0 || stop > out.length - 2 || out.slice(stop, stop + 2) !== ' }') { seek = p + 1; continue; }
      out = out.slice(0, stop) + out.slice(stop + 2);
    }
    src = out;
    seek = head;
  }
  return src;
}
/* Function.prototype.toString: the printed body is un-hoisted, so a generator whose for-of holds a
   yield prints the source it was written with. Nothing else about the method changes: the native
   one is still called, and a body with no hoist comes back exactly as it was printed. */
(function () {
  var RX_NATIVE_TOSTRING = Function.prototype.toString;
  function compatToString() {
    var text = RX_NATIVE_TOSTRING.call(this);
    try { return rxUnhoist(text); } catch (unhoistErr) { return text; }
  }
  Object.defineProperty(compatToString, 'name', { value: 'toString', configurable: true });
  Object.defineProperty(compatToString, 'length', { value: 0, configurable: true });
  Object.defineProperty(Function.prototype, 'toString', { value: compatToString, writable: true, configurable: true });
})();
/* Runtime RegExp: a pattern built with new RegExp (for example camelcase joining a class that has \- with a u flag) gets the same \- fix as a literal. The wrapper only retries a u-flag SyntaxError and otherwise keeps the native constructor's behaviour: same prototype, same statics. */
(function () {
  var NativeRegExp = RegExp;
  function CompatRegExp(pattern, flags) {
    var target = new.target || CompatRegExp;
    try {
      return Reflect.construct(NativeRegExp, [pattern, flags], target);
    } catch (error) {
      var unicode = typeof flags === 'string' && flags.indexOf('u') >= 0;
      if (!(error instanceof SyntaxError) || !unicode) throw error;
      var source = pattern instanceof NativeRegExp ? pattern.source : String(pattern);
      var fixed = rxFixBody(source);
      if (fixed === source) throw error;
      return Reflect.construct(NativeRegExp, [fixed, flags], target);
    }
  }
  CompatRegExp.prototype = NativeRegExp.prototype;
  Reflect.ownKeys(NativeRegExp).forEach(function (key) {
    if (key === 'length' || key === 'name' || key === 'prototype') return;
    Object.defineProperty(CompatRegExp, key, Object.getOwnPropertyDescriptor(NativeRegExp, key));
  });
  Object.defineProperty(CompatRegExp, 'name', { value: 'RegExp', configurable: true });
  Object.defineProperty(NativeRegExp.prototype, 'constructor', { value: CompatRegExp, writable: true, configurable: true });
  globalThis.RegExp = CompatRegExp;
})();
`;
