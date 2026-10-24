import { REGEX_COMPAT_SRC } from './regex-compat';
/**
 * Guest-side module system: builtin registry, CommonJS loader with node_modules
 * resolution delegated to the host, timers driven by host callbacks, and the
 * API object the host calls into. Plain JavaScript, no template interpolation.
 */
export const LOADER_SRC = REGEX_COMPAT_SRC + String.raw`
var BF = Object.create(null);
var BC = Object.create(null);
var MODULE_CACHE = Object.create(null);
var EXIT_SIGNAL = { __owcExit: true };
var mainModule = undefined;
var timers = Object.create(null);
var nextTimerId = 1;
/*
 * The immediate queue: setImmediate arms no host timer of its own ordering, because a host timer
 * cannot be cheaper than 1 ms and an ordered against setTimeout(f, 1) as another 1 ms timer is
 * exactly the divergence this queue exists to remove. An immediate is queued here instead and runs
 * in the loop's check phase -- after the I/O callbacks of the turn, and before the next turn's
 * timers -- which the host asks for by draining it (see fireTimer).
 */
var IMMEDIATE_QUEUE = [];
/* The one host timer the queue holds: armed for the head so that a process whose only pending work
   is an immediate still has something to wake the loop, and re-armed as the head moves. */
var IMMEDIATE_WAKE = 0;
/*
 * The poll phase, which is the turn host node 24.15 spends in it before it reaches the check phase.
 * A file operation Node answers in one round trip -- a stat, an access, a readdir -- comes back in
 * the poll phase of the turn after the one that asked, so it still runs ahead of an immediate armed
 * with it. One Node answers in more than one round trip -- a readFile, whose open is a request of
 * its own and whose read is a second one -- costs a whole extra turn, and that turn is what puts an
 * immediate armed before it in front of it: host node 24.15 measures 'iFI' where this container,
 * settling every callback inside the turn that asked, measured 'FiI'.
 *
 * IO_QUEUE holds the callbacks the poll phase of the next turn owes; IO_LATER holds the ones an
 * extra round trip defers past that turn's check phase. Both run before the check phase they
 * precede, which is the order host node 24.15 runs them in.
 */
var IO_QUEUE = [];
var IO_LATER = [];
/* The reserved host timer id the two queues wake on: never a timer-table id, which start at 1. */
var TURN_TIMER = 0;
var TURN_ARMED = false;
var startedAt = host.now();

/*
 * The object the host bridge's own names stand on.
 *
 * Node's global object carries none of them, so the global object's own names here read as Node's
 * do, and a name the loader or a generated module reaches through globalThis would otherwise
 * become one of them: an assignment to a name found on the prototype chain lands on the receiver,
 * not where it was found. Each name is therefore an accessor on the bridge, whose setter keeps the
 * value beside it, so assigning globalThis.__owc_api still reaches the bridge and still leaves the
 * global object's own names alone.
 *
 * The bridge stands behind the global object rather than on it, and one object stands in front of
 * it: the one Node has there, whose only own name is 'constructor' -- so a walk that reaches the
 * global object's prototype finds the names Node's walk finds, and a lookup one step further finds
 * the bridge.
 */
var OWC_BRIDGE_VALUES = Object.create(null);
var OWC_BRIDGE = Object.create(Object.prototype);
function owcBridgeName(name) {
  Object.defineProperty(OWC_BRIDGE, name, {
    get: function () { return OWC_BRIDGE_VALUES[name]; },
    set: function (value) { OWC_BRIDGE_VALUES[name] = value; },
    enumerable: false,
    configurable: true
  });
}
['__owc_api', '__owcErrname', '__owc_importArg', '__owc_importMeta', '__owc_importWrap',
  '__owc_moduleView', '__owc_import_failure', '__owcDependencyRequire', '__owc_esm_registry',
  /* Set for the length of one dynamic import: the argument of 'import(spec)' is read before the
     engine loads the module it names, so the flag is already standing when the host is asked for
     that module's source and is what tells a load a program started from a dependency the entry
     linked -- which is the only difference between the two stacks node prints for a module that
     will not compile. The host clears it as it answers, so a later load does not inherit it. */
  '__owc_dynamic_load',
  /* The two records util.types.isProxy and util.inspect read, written from util-assert.ts, which
     runs after this: they are the bridge's and not a program's, so they stand here with the rest
     rather than as own names of the global object, where Object.getOwnPropertyNames would find
     them. An assignment to globalThis.<name> reaches the setter below, so the writer there is
     unchanged. */
  '__owcIsProxy', '__owcNotePromise'
].forEach(owcBridgeName);
var OWC_BRIDGE_FRONT = Object.create(OWC_BRIDGE);
OWC_BRIDGE_FRONT.constructor = Object;
Object.setPrototypeOf(globalThis, OWC_BRIDGE_FRONT);

function stripNodePrefix(name) {
  return name.indexOf('node:') === 0 ? name.slice(5) : name;
}

function isBuiltinName(name) {
  return Object.prototype.hasOwnProperty.call(BF, stripNodePrefix(name));
}

function requireBuiltin(name) {
  var key = stripNodePrefix(name);
  if (Object.prototype.hasOwnProperty.call(BC, key)) return BC[key];
  var factory = BF[key];
  if (!factory) return undefined;
  var exported = factory();
  BC[key] = exported;
  return exported;
}

function dirnameOf(p) {
  var i = p.lastIndexOf('/');
  return i <= 0 ? '/' : p.slice(0, i);
}

/* The files a require came from, as Node lists them under a resolution failure: the module that
   made the require first, then the one that required it, and so on up to the entry. A require with
   no module behind it -- one the host made, or one made from a path with no file of its own -- has
   no stack, as it has in Node. */
function requireStackNames(parent) {
  var names = [];
  var cursor = parent;
  while (cursor !== null && cursor !== undefined) {
    names.push(cursor.filename || cursor.id);
    cursor = cursor.parent;
  }
  return names;
}

function requireStackOf(parent) {
  var names = requireStackNames(parent);
  return names.length === 0 ? '' : '\nRequire stack:\n- ' + names.join('\n- ');
}

function moduleNotFound(id, parent) {
  var err = new Error("Cannot find module '" + id + "'" + requireStackOf(parent));
  err.code = 'MODULE_NOT_FOUND';
  /* Node carries the same list on the error as a field, not only in the message: a package that
     prints where a dependency was asked for reads err.requireStack, and a resolve failure names the
     file it was asked from just as a require does. */
  err.requireStack = requireStackNames(parent);
  return err;
}

/* Why a resolve found nothing, when the reason is not a plain missing file: a package whose
   "exports" map defines no such subpath, which Node reports as ERR_PACKAGE_PATH_NOT_EXPORTED in
   require() as well as in import(), naming the package.json that defines the map; a name no
   "imports" map defines, which is ERR_PACKAGE_IMPORT_NOT_DEFINED; or an exports target that names a
   file which is not there, which Node names by that path. A subpath a package's own "exports" does
   not define is the one case Node also names the file that asked for -- an 'imported from' tail a
   subpath of a package under node_modules does not carry. */
function notFoundError(id, fromDir, parent) {
  var info = null;
  try { info = JSON.parse(host.resolveFailure(String(id), fromDir, 'require')); } catch (e) { info = null; }
  if (info === null || typeof info !== 'object') return moduleNotFound(id, parent);
  if (info.kind === 'not-exported') {
    var from = info.self ? ' imported from ' + (parent && parent.filename ? parent.filename : fromDir) : '';
    var err = new Error("Package subpath '" + info.subpath + "' is not defined by \"exports\" in " + info.packageDir + '/package.json' + from);
    err.code = 'ERR_PACKAGE_PATH_NOT_EXPORTED';
    return err;
  }
  if (info.kind === 'import-not-defined') {
    var e2 = new TypeError("Package import specifier \"" + info.specifier + "\" is not defined in package " + info.packageDir + '/package.json imported from ' + importFromOf(parent, fromDir));
    e2.code = 'ERR_PACKAGE_IMPORT_NOT_DEFINED';
    return e2;
  }
  /* An "exports" target that names a directory: Node reads no index out of it, so the require is
     a missing module -- and names the directory the map pointed at, not the specifier. */
  if (info.kind === 'dir-target') return moduleNotFound(info.dir, parent);
  if (info.kind === 'missing' && typeof info.file === 'string') return moduleNotFound(info.file, parent);
  return moduleNotFound(id, parent);
}

/* The file a require or a resolve failure names as the one that asked: a require with no module
   behind it has no file, and Node then names the directory it resolved from. */
function importFromOf(parent, fromDir) {
  return parent && parent.filename ? parent.filename : fromDir;
}

/* The file whose code is running, for the one piece of code that carries no file of its own: a
   new Function body, which the engine names <input>. A dynamic import written in one has nothing to
   resolve against, and Node resolves it from the file that created the function, so that file is
   recorded here while a CommonJS module body runs. */
var CURRENT_FILE = '';

/* Every file the host compiled inside the CommonJS wrapper. A frame the engine names for line 1 of
   one counts the wrapper's own columns in front of the module's, and only these files. */
var WRAPPED_FILES = Object.create(null);

function setCurrentFile(file) {
  CURRENT_FILE = typeof file === 'string' ? file : '';
}

/* new Function: the body is compiled by the host under the file that is running, so a dynamic
   import in it resolves from that file, as it does in Node. A body built outside any module -- the
   top of a -e script, or a REPL line -- has no file to name and is left to the engine, which
   resolves an import in it from the working directory, as Node resolves one there. */
var REAL_FUNCTION = globalThis.Function;

globalThis.Function = function Function() {
  var argc = arguments.length;
  var params = [];
  for (var k = 0; k < argc - 1; k++) params.push(String(arguments[k]));
  var body = argc === 0 ? '' : String(arguments[argc - 1]);
  var src = '(function anonymous(' + params.join(',') + '\n) {\n' + body + '\n})';
  if (CURRENT_FILE === '') {
    /* No module is running -- an ES module body, a -e script's top level, a REPL line -- so the
       engine compiles the body itself and resolves an import in it from the working directory, as
       Node resolves one there. A body the engine refuses is still given the compatibility rewrite's
       second chance, the same one a module body gets: a for-of whose iterable holds a yield aborts
       the compile with 'stack underflow', and a package that builds one in an ES module (or inside
       a -e line) is as entitled to the hoist as a CommonJS module is. */
    try {
      return REAL_FUNCTION.apply(REAL_FUNCTION, arguments);
    } catch (engineErr) {
      var retry = null;
      try { retry = rxRewrite(body); } catch (rewriteErr) { retry = null; }
      if (retry === null) throw engineErr;
      return REAL_FUNCTION.apply(REAL_FUNCTION, params.concat([retry]));
    }
  }
  var compiled = host.compileFunction(src, CURRENT_FILE);
  if (typeof compiled === 'string') {
    /* The compatibility rewrite a module gets before its second compile (see compileCjsWrapper):
       a body that QuickJS refuses to compile gets the same second chance, and a rewrite that does
       not clear it still reports the engine's own message, as the module path does. */
    var fixed = null;
    try { fixed = rxRewrite(src); } catch (rewriteErr) { fixed = null; }
    if (fixed !== null) {
      var retried = host.compileFunction(fixed, CURRENT_FILE);
      if (typeof retried !== 'string') return retried;
    }
    throw new SyntaxError(compiled);
  }
  return compiled;
};
globalThis.Function.prototype = REAL_FUNCTION.prototype;

/* eval keeps the engine's own: QuickJS grants a direct eval -- the one that reads the caller's
   scope -- only through the real global eval, so a wrapper there would cost every direct eval its
   scope (vm.runInContext reads its sandbox through a with-scoped direct eval, and a package that
   evals "require('x')" reads the module's own binding). What that leaves unfixed is a string an
   eval compiles with the one construct above in it, which no wrapper can reach without that cost. */

function readSource(filename) {
  var src = host.readText(filename);
  if (src === null) throw moduleNotFound(filename);
  return src;
}

function stripHashbang(src) {
  return src.charAt(0) === '#' && src.charAt(1) === '!' ? '//' + src.slice(2) : src;
}

/*
 * module.paths is the list of node_modules directories a require from this file searches: one
 * beside the file's own directory, then one beside each directory above it, out to the root. It was
 * empty, so a package that walks it -- and one that asks module.paths.length -- found no place to
 * look in a container that resolves through them. Relative resolution still goes through the host;
 * this is only the list Node reports.
 */
function nodeModulePaths(dir) {
  var parts = String(dir).split('/');
  var out = [];
  var at = '';
  for (var i = 0; i < parts.length; i++) {
    var part = parts[i];
    if (part === '' || part === '.' || part === '..') continue;
    at += '/' + part;
    out.push(at + '/node_modules');
  }
  out.reverse();
  if (String(dir).charAt(0) === '/') out.push('/node_modules');
  return out;
}

function Module(filename, parent) {
  this.id = filename;
  this.filename = filename;
  this.path = dirnameOf(filename);
  this.exports = {};
  this.parent = parent;
  this.loaded = false;
  this.children = [];
  this.paths = nodeModulePaths(this.path);
}

/* require('module') exports this class, so its statics are Node's: a package that patches
   Module._resolveFilename or Module.prototype.require to hook resolution (next's
   dist/server/require-hook.js does both, at load time) finds the real thing rather than an object
   with no prototype. Resolution itself still goes through the host, and a patch to _resolveFilename
   or to prototype.require therefore changes what a caller of those two sees, not what the loader
   does: the loader resolves with host.resolve, which no patch reaches. */
Module._cache = MODULE_CACHE;
Module._extensions = EXTENSIONS;
Module._pathCache = Object.create(null);
Module.globalPaths = [];
Module.wrapper = ['(function (exports, require, module, __filename, __dirname) { ', '\n});'];
Module.wrap = function wrap(script) { return Module.wrapper[0] + script + Module.wrapper[1]; };
Module.Module = Module;
Module.isBuiltin = isBuiltinName;
Module.createRequire = function createRequire(filename) { return createRequireFor(String(filename)); };
Module.createRequireFromPath = function createRequireFromPath(filename) { return createRequireFor(String(filename)); };
Module._initPaths = function _initPaths() { return undefined; };
Module._nodeModulePaths = function _nodeModulePaths(from) { return nodeModulePaths(from); };
Module._preloadModules = function _preloadModules() { return undefined; };
Module.syncBuiltinESMExports = function syncBuiltinESMExports() { return undefined; };
Module._resolveFilename = function _resolveFilename(request, parent, isMain, options) {
  if (isBuiltinName(request)) return stripNodePrefix(request);
  var base = parent && parent.path ? parent.path : host.cwd();
  var found = host.resolve(String(request), base, 'require');
  if (!found) throw notFoundError(String(request), base, parent);
  return found;
};
Module._load = function _load(request, parent, isMain) {
  if (isBuiltinName(request)) return requireBuiltin(request);
  return requireFrom(parent, request);
};
Module.prototype.require = function _require(request) { return requireFrom(this, request); };

/* require.extensions (Module._extensions): .node files load through it, by process.dlopen; .js and .json files load in loadCJS */
var EXTENSIONS = {
  '.js': function (module, filename) {
    var wrapper = compileCjsWrapper(stripHashbang(readSource(filename)), filename);
    wrapper.call(module.exports, module.exports, makeRequire(module), module, filename, dirnameOf(filename));
  },
  '.json': function (module, filename) {
    module.exports = JSON.parse(readSource(filename));
  },
  '.node': function (module, filename) {
    return process.dlopen(module, filename);
  }
};

function makeRequire(mod) {
  var req = function require(id) {
    return requireFrom(mod, id);
  };
  req.resolve = function resolve(id) {
    /* A built-in is answered with the name it was asked for: node hands back 'node:fs' for
       'node:fs' and 'fs' for 'fs', and stripping the prefix here answered 'fs' to both. */
    if (isBuiltinName(id)) return String(id);
    var found = host.resolve(String(id), mod.path, 'require');
    if (!found) throw notFoundError(id, mod.path, mod);
    return found;
  };
  /* resolve.paths: the folders a bare request is looked for in -- the module's own node_modules
     chain followed by the global folders, and null for a built-in, which has none -- which is what
     every CommonJS require here was missing, not only the one createRequire hands out.
     row owc-module-export-table-incomplete. */
  req.resolve.paths = function paths(request) {
    if (typeof request !== 'string') {
      throw new TypeError('The "request" argument must be of type string. Received ' + typeof request);
    }
    return Module._resolveLookupPaths(request, mod);
  };
  req.cache = MODULE_CACHE;
  req.main = mainModule;
  req.extensions = EXTENSIONS;
  return req;
}

function requireFrom(parent, id) {
  if (typeof id !== 'string') {
    throw new TypeError('The "id" argument must be of type string. Received ' + typeof id);
  }
  if (isBuiltinName(id)) {
    // DEP0040 is a warning for user code: node does not print it when a package in node_modules requires punycode
    if (!(parent && parent.filename && parent.filename.indexOf('/node_modules/') >= 0)) return requireBuiltin(id);
    globalThis.__owcDependencyRequire = true;
    try {
      return requireBuiltin(id);
    } finally {
      globalThis.__owcDependencyRequire = false;
    }
  }
  var base = parent && parent.path ? parent.path : host.cwd();
  var filename = host.resolve(id, base, 'require');
  if (!filename) throw notFoundError(id, base, parent);
  return loadCJS(filename, parent, false).exports;
}

/* Every "import" token in a script that opens a dynamic import: where the token stands, where its
   argument starts and where its call closes. "import" is a reserved word but a legal property and
   method name, so the scan is this rewrite's whole risk -- the token is one only when no '.' or
   '?.' stands in front of it -- and strings, template literals, comments and regular expressions
   are walked whole, so text that merely looks like a call is never touched. Punctuator bookkeeping
   is the same the regex compatibility scan keeps (rxRegexAllowed reads it), so a '/' is a regex
   where a value cannot continue and a division where one can. */
function cjsImportParens(src) {
  var n = src.length, i = 0, st = { nl: false }, look = { nl: false };
  var last = null, stack = [], out = [];
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
      if (!afterDot && word === 'import') {
        var open = rxSkip(src, j, look);
        if (open < n && src.charCodeAt(open) === 40) {
          out.push({ s: i, argAt: open + 1, close: -1 });
          stack.push(out.length - 1);
          last = { k: 'p', v: '(' };
          i = open + 1;
          continue;
        }
      }
      last = afterDot ? { k: 'val', v: word }
        : RX_REGEX_AFTER_WORD.hasOwnProperty(word) ? { k: 'kw', v: word } : { k: 'id', v: word };
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
        last = { k: 'val', v: '' };
        i = re.e;
        continue;
      }
      last = { k: 'p', v: '/' };
      i += src.charCodeAt(i + 1) === 61 ? 2 : 1;
      continue;
    }
    if (c === 40) {
      stack.push(-1);
      last = { k: 'p', v: '(' };
      i++;
      continue;
    }
    if (c === 41) {
      var opened = stack.pop();
      if (typeof opened === 'number' && opened >= 0) out[opened].close = i;
      last = { k: 'p', v: ')' };
      i++;
      continue;
    }
    if (c === 91) {
      stack.push('A');
      last = { k: 'p', v: '[' };
      i++;
      continue;
    }
    if (c === 93) {
      stack.pop();
      last = { k: 'p', v: ']' };
      i++;
      continue;
    }
    if (c === 123) {
      stack.push('B');
      last = { k: 'p', v: '{' };
      i++;
      continue;
    }
    if (c === 125) {
      var brace = stack.pop();
      if (brace === 'T') {
        var t2 = rxTemplateText(src, i + 1);
        last = t2.sub ? { k: 'p', v: 'tsub' } : { k: 'val', v: '' };
        if (t2.sub) stack.push('T');
        i = t2.next;
        continue;
      }
      last = { k: 'p', v: '}' };
      i++;
      continue;
    }
    if (c === 63 && src.charCodeAt(i + 1) === 46) {
      last = { k: 'p', v: '?.' };
      i += 2;
      continue;
    }
    if (c === 46) {
      last = { k: 'p', v: '.' };
      i++;
      continue;
    }
    last = { k: 'p', v: src.charAt(i) };
    i++;
  }
  return out;
}

/*
 * Whether a script body is strict, which is what the language asks of its first statement: a
 * directive is only a directive in directive position, so "use strict" after a comment or a blank
 * line still opens a strict body and the same words after a statement are an inert string.
 */
function cjsIsStrict(src) {
  var i = rxSkip(src, src.charAt(0) === '#' && src.charAt(1) === '!' ? 2 : 0, { nl: false });
  if (i >= src.length) return false;
  var quote = src.charCodeAt(i);
  if (quote !== 34 && quote !== 39) return false;
  var j = i + 1;
  while (j < src.length) {
    var c = src.charCodeAt(j);
    if (c === 92) { j += 2; continue; }
    if (c === quote || rxIsNewline(c)) break;
    j++;
  }
  return src.slice(i + 1, j) === 'use strict';
}

/*
 * A dynamic import() written in a CommonJS body is answered with the engine's own module namespace,
 * because a script -- unlike an ES module -- is compiled with no rewrite pass, so a program that
 * tries to change what it got reads the engine's refusal rather than Node's. This puts the same two
 * ends around the call that prepareEsmSource puts around an ES module's -- the argument through the
 * attribute check, the promise through moduleViewOf -- so a CommonJS importer and an ES module
 * importer get one object, as they do in Node. A parameter list a body follows is a method named
 * import, not a call, and a call whose close the scan never met is left alone; no edit crosses a
 * line, so every statement keeps the line it had.
 */
function cjsImportSource(src, filename) {
  if (src.indexOf('import') < 0) return src;
  var calls = null;
  try { calls = cjsImportParens(src); } catch (scanErr) { return src; }
  if (calls === null || calls.length === 0) return src;
  var file = JSON.stringify(String(filename));
  var strict = cjsIsStrict(src) ? '' : ', false';
  var out = '', cursor = 0;
  for (var i = 0; i < calls.length; i++) {
    var one = calls[i];
    if (one.close < 0 || one.s < cursor) continue;
    var after = rxSkip(src, one.close + 1, { nl: false });
    if (after < src.length && src.charCodeAt(after) === 123) continue;
    out += src.slice(cursor, one.s) + 'globalThis.__owc_importWrap(';
    out += src.slice(one.s, one.argAt) + 'globalThis.__owc_importArg(';
    out += src.slice(one.argAt, one.close) + ', ' + file + '))' + strict;
    cursor = one.close;
  }
  if (cursor === 0) return src;
  return out + src.slice(cursor);
}

/*
 * The host compiles the wrapper, not an in-guest eval: the engine names eval'd code <input>, so
 * every CommonJS module would share one nameless script and its stack frames would carry no path.
 * Packages that locate their binary from a stack frame (bindings, and anything built on it) read
 * CallSite.getFileName() and fail on that. A failed compile comes back as the message string.
 * The file is recorded as one compiled inside that wrapper, because the wrapper sits in front of
 * the module's first line and a frame the engine names there counts its columns too (see
 * frameColumnUnwrapped in globals.ts).
 */
function compileCjs(src, filename) {
  var compiled = compileCjsWrapped(src, filename);
  if (typeof compiled === 'string') throw new SyntaxError(compiled);
  return compiled;
}

function compileCjsWrapped(src, filename) {
  WRAPPED_FILES[filename] = true;
  return host.compileCjs(src, filename);
}

function compileCjsWrapper(src, filename) {
  /* The wrapped body is used only when it compiles: a source the rewrite turned into something the
     engine rejects keeps the compile it had, and so keeps the failure -- and the failure's own
     words -- that the source as written earns. */
  var wrapped = cjsImportSource(src, filename);
  if (wrapped !== src) {
    var tried = compileCjsWrapped(wrapped, filename);
    if (typeof tried !== 'string') return tried;
  }
  try {
    return compileCjs(src, filename);
  } catch (err) {
    var fixed = null;
    if (err instanceof SyntaxError) {
      try { fixed = rxRewrite(src); } catch (rewriteErr) { fixed = null; }
    }
    if (fixed === null) throw err;
    try { return compileCjs(fixed, filename); } catch (retryErr) { throw err; }
  }
}

function loadCJS(filename, parent, isMain) {
  var cached = MODULE_CACHE[filename];
  if (cached) {
    /* A require() that reaches an ES module still being required is a cycle Node refuses rather
       than a module it hands back half-built: the module is in the cache already, so the check is
       made here, where the cache answers. */
    var cycle = requireCycleOf(filename);
    if (cycle !== undefined) throw cycle;
    return cached;
  }
  var mod = new Module(filename, parent);
  /* Node's process.mainModule is the module the entry was loaded as, and it is there only for an
     entry the CommonJS loader loaded: an ES module entry leaves the name off process entirely,
     which is why this is set here and not where process is built. */
  if (isMain) { mainModule = mod; proc.mainModule = mod; }
  MODULE_CACHE[filename] = mod;
  try {
    if (filename.slice(-5) === '.json') {
      mod.exports = JSON.parse(readSource(filename));
    } else if (filename.slice(-5) === '.node') {
      EXTENSIONS['.node'](mod, filename);
    } else {
      if (filename.slice(-4) === '.mjs' || host.isESM(filename)) {
        return loadEsmFromRequire(filename, mod);
      }
      var src = stripHashbang(readSource(filename));
      var wrapper = compileCjsWrapper(src, filename);
      /* The body runs as this file, so a new Function it builds -- and a dynamic import in that
         body -- is resolved from here, as it is in Node. */
      var savedFile = CURRENT_FILE;
      setCurrentFile(filename);
      try {
        wrapper.call(mod.exports, mod.exports, makeRequire(mod), mod, filename, mod.path);
      } finally {
        setCurrentFile(savedFile);
      }
    }
    mod.loaded = true;
  } catch (err) {
    delete MODULE_CACHE[filename];
    throw err;
  }
  if (parent && parent.children) parent.children.push(mod);
  return mod;
}

var nextEsmToken = 1;

/* The message of a require() Node cannot make of an ESM graph with top-level await, and the two
   lines it writes under it: the module that made the require, then the module it was made of, each
   with one trailing space. The host builds the message without the two files, since only the loader
   knows both names, so they are written here -- for the failure the host reported as much as for
   the one the loader raises itself. */
var REQUIRE_ASYNC_MESSAGE = 'require() cannot be used on an ESM graph with top-level await. Use import() instead.' +
  ' To see where the top-level await comes from, use --experimental-print-required-tla.';

/* The ES modules a require() is loading right now, innermost last. An entry is the file together
   with the module whose require() began loading it, which is the one Node names after "in a
   cycle". */
var ESM_REQUIRE_STACK = [];

function requireCycleErrorOf(filename, from) {
  var err = new Error('Cannot require() ES Module ' + filename + ' in a cycle.' +
    (typeof from === 'string' && from !== '' ? ' (from ' + from + ')' : ''));
  err.code = 'ERR_REQUIRE_CYCLE_MODULE';
  return err;
}

function requireCycleOf(filename) {
  for (var i = ESM_REQUIRE_STACK.length - 1; i >= 0; i--) {
    if (ESM_REQUIRE_STACK[i].file === filename) {
      return requireCycleErrorOf(filename, ESM_REQUIRE_STACK[i].from);
    }
  }
  return undefined;
}

function requireAsyncContext(mod, filename) {
  var from = mod && mod.parent ? mod.parent.filename : undefined;
  var text = '';
  if (typeof from === 'string' && from !== '') text += '\n  From ' + from + ' ';
  return text + '\n  Requiring ' + filename + ' ';
}

function requireAsyncErrorOf(err, mod, filename) {
  if (err === null || typeof err !== 'object' || err.code !== 'ERR_REQUIRE_ASYNC_MODULE') return err;
  var message = String(err.message);
  if (message.indexOf('\n  From ') < 0 && message.indexOf('\n  Requiring ') < 0) {
    try { err.message = message + requireAsyncContext(mod, filename); } catch (e) { /* a frozen error keeps the message it has */ }
  }
  return err;
}

/* require() of an ES module. The host reports a failure as a record of the error it met, so what
   require() throws is the error Node throws: a module that does not parse is a SyntaxError, one
   that throws reports its own error, and one whose own import is missing ERR_MODULE_NOT_FOUND.
   Only a failure the host cannot describe is left as ERR_REQUIRE_ESM. */
function loadEsmFromRequire(filename, mod) {
  var token = nextEsmToken++;
  ESM_REQUIRE_STACK.push({ file: filename, from: mod && mod.parent ? mod.parent.filename : undefined });
  var failure;
  try {
    failure = host.esmLoad(filename, token);
  } finally {
    ESM_REQUIRE_STACK.pop();
  }
  if (failure) throw requireAsyncErrorOf(requireEsmFailureOf(failure), mod, filename);
  var registry = globalThis.__owc_esm_registry || {};
  var namespace = registry[token];
  delete registry[token];
  if (namespace === undefined) {
    var asyncErr = new Error(REQUIRE_ASYNC_MESSAGE + requireAsyncContext(mod, filename));
    asyncErr.code = 'ERR_REQUIRE_ASYNC_MODULE';
    throw asyncErr;
  }
  /* A module with a default export is the one Node marks, so a transpiled CommonJS consumer that
     looks for __esModule finds it; one with no default export is handed over as it stands. */
  mod.exports = Object.prototype.hasOwnProperty.call(namespace, 'default')
    ? markedNamespace(namespace)
    : moduleViewOf(namespace);
  mod.loaded = true;
  return mod;
}

/*
 * How Node answers a program that tries to change a module namespace, or to make a primitive of
 * one. Every property of a namespace is writable but never configurable, the object cannot be
 * extended and its prototype is null, so all three attempts fail -- and what a program reads is
 * Node's own message, which names the property and the object as '[object Module]', not the
 * engine's words for a failed write. MODULE_TRAPS is that answer, over a namespace the engine
 * built: the reads still go through to the module, so a binding it reassigns still reads as its new
 * value, and only the three ways of changing one are answered for it.
 */
var MODULE_VIEWS = typeof WeakMap === 'function' ? new WeakMap() : null;
/* One for a namespace a sloppy CommonJS body reached: see SLOPPY_MODULE_TRAPS. */
var MODULE_VIEWS_SLOPPY = typeof WeakMap === 'function' ? new WeakMap() : null;

function moduleToPrimitive() {
  throw new TypeError('Cannot convert object to primitive value');
}

/* Whether a descriptor asks for the property that is already there: every field it carries is absent
   or already has the value it names, so carrying it out would change nothing. */
function describesSameProperty(current, desc) {
  if (desc === null || typeof desc !== 'object') return true;
  if ('get' in desc || 'set' in desc) return false;
  var fields = ['value', 'writable', 'enumerable', 'configurable'];
  for (var i = 0; i < fields.length; i++) {
    var field = fields[i];
    if (!(field in desc)) continue;
    /* A value is compared the way the language compares it: NaN is the NaN it already is. */
    if (field === 'value' ? !sameValue(desc.value, current.value) : desc[field] !== current[field]) return false;
  }
  return true;
}

function sameValue(a, b) {
  return a === b || (a !== a && b !== b);
}

function moduleKeyText(key) {
  return typeof key === 'symbol' ? String(key) : String(key);
}

var MODULE_TRAPS = {
  get: function (target, key) {
    /* String(ns), ns + '' and ns == null all ask the object for a primitive, and a namespace
       has no way to make one: Node refuses rather than reading the engine's own refusal. */
    if (key === Symbol.toPrimitive) return moduleToPrimitive;
    return target[key];
  },
  set: function (target, key) {
    /* A binding the namespace already has is read-only; a name it does not have cannot be added to
       an object that cannot be extended -- and Node says which of the two it was. */
    if (Object.prototype.hasOwnProperty.call(target, key)) {
      throw new TypeError("Cannot assign to read only property '" + moduleKeyText(key) + "' of object '[object Module]'");
    }
    throw new TypeError('Cannot add property ' + moduleKeyText(key) + ', object is not extensible');
  },
  /* Node lets a define through when it changes nothing -- that is what makes Object.seal() succeed
     on a namespace, whose properties are already non-configurable -- and refuses one that would
     change anything with the same words whether the name is already there or not. */
  defineProperty: function (target, key, desc) {
    var current = Object.getOwnPropertyDescriptor(target, key);
    if (current !== undefined && describesSameProperty(current, desc)) return true;
    throw new TypeError('Cannot redefine property: ' + moduleKeyText(key));
  },
  deleteProperty: function (target, key) {
    throw new TypeError("Cannot delete property '" + moduleKeyText(key) + "' of [object Module]");
  },
  /* A namespace's prototype is null and the object cannot be extended, so Node refuses a
     setPrototypeOf that asks for any other one -- with the words it uses for a namespace, and not
     the engine's own for a bad prototype. The set that asks for the prototype it already has
     changes nothing and is granted, as it is in Node. Object.setPrototypeOf throws in a sloppy
     body too, so both views answer this the same way. */
  setPrototypeOf: function (target, proto) {
    if (proto === Object.getPrototypeOf(target)) return true;
    throw new TypeError('[object Module] is not extensible');
  }
};

/* An assignment and a delete that fail are silent in a sloppy CommonJS body -- that is the whole
   difference between the two modes, and it is the caller's, not the object's: no trap is told
   whether the code that reached it was strict. So a body the loader knows to be sloppy gets a view
   whose two traps answer false instead of throwing, and the engine keeps them quiet, exactly as it
   keeps the assignment quiet. A define is refused in both modes -- Object.defineProperty throws
   whatever the surrounding mode is -- and so is every other way of changing a namespace. */
var SLOPPY_MODULE_TRAPS = {
  get: MODULE_TRAPS.get,
  set: function (target, key) {
    return false;
  },
  defineProperty: MODULE_TRAPS.defineProperty,
  deleteProperty: function (target, key) {
    return false;
  },
  setPrototypeOf: MODULE_TRAPS.setPrototypeOf
};

/* The same three refusals read through Reflect.*, which reports one as false instead of throwing:
   a namespace refuses a set, a define and a delete of a property it has, and only a delete of a
   name it does not have is granted. The engine has no way to tell such a call from the assignment,
   the define and the delete that must throw, so Reflect answers for a namespace itself and leaves
   every other object -- a proxy among them -- to the engine. */
function isModuleNamespace(value) {
  return value !== null && typeof value === 'object' && value[Symbol.toStringTag] === 'Module';
}

(function () {
  if (typeof Reflect !== 'object' || Reflect === null) return;
  var set = Reflect.set;
  var define = Reflect.defineProperty;
  var drop = Reflect.deleteProperty;
  if (typeof set !== 'function' || typeof define !== 'function' || typeof drop !== 'function') return;
  Reflect.set = function (target) {
    return isModuleNamespace(target) ? false : set.apply(Reflect, arguments);
  };
  Reflect.defineProperty = function (target, key, desc) {
    if (!isModuleNamespace(target)) return define.apply(Reflect, arguments);
    var current = Object.getOwnPropertyDescriptor(target, key);
    return current !== undefined && describesSameProperty(current, desc);
  };
  Reflect.deleteProperty = function (target, key) {
    return isModuleNamespace(target)
      ? !Object.prototype.hasOwnProperty.call(target, key)
      : drop.apply(Reflect, arguments);
  };
})();

/* A namespace as Node hands one out, whichever way the module was reached. Only a namespace is
   wrapped: a module's tag is what makes it one, and whatever else an import resolves to -- a
   CommonJS exports object, the value of a JSON module -- is left exactly as it was. */
function moduleViewOf(value, strict) {
  if (value === null || typeof value !== 'object') return value;
  if (value[Symbol.toStringTag] !== 'Module') return value;
  /* A sloppy body and a strict one get two views of one namespace, because the two answer an
     assignment differently; within either one the same import always resolves to the same object. */
  var sloppy = strict === false;
  var views = sloppy ? MODULE_VIEWS_SLOPPY : MODULE_VIEWS;
  if (views === null) return value;
  var seen = views.get(value);
  if (seen !== undefined) return seen;
  var view = new Proxy(value, sloppy ? SLOPPY_MODULE_TRAPS : MODULE_TRAPS);
  views.set(value, view);
  return view;
}

/* A property of Node's namespace: writable and enumerable, and never configurable, which is what
   makes the whole object sealed without freezing any one value. */
function defineNamespaceProperty(target, key, value) {
  Object.defineProperty(target, key, { value: value, writable: true, enumerable: true, configurable: false });
}

/* Node marks the namespace of a module that has a default export with __esModule, the marker a
   transpiled CommonJS consumer looks for; a module with no default export gets none. The engine
   seals its namespaces, so the marked one is a sealed view that reads through to the original:
   the same exports in the same order, a null prototype and the '[object Module]' tag, and -- the
   part a copy cannot do -- a binding the module later reassigns still reads as its new value. */
function markedNamespace(namespace) {
  var target = Object.create(null);
  var keys = Object.keys(namespace);
  keys.push('__esModule');
  keys.sort();
  for (var i = 0; i < keys.length; i++) {
    defineNamespaceProperty(target, keys[i], keys[i] === '__esModule' ? true : namespace[keys[i]]);
  }
  Object.defineProperty(target, Symbol.toStringTag, { value: 'Module' });
  Object.preventExtensions(target);
  return new Proxy(target, {
    get: function (t, key) {
      if (key === Symbol.toPrimitive) return moduleToPrimitive;
      if (key === '__esModule') return true;
      if (key === Symbol.toStringTag) return 'Module';
      return namespace[key];
    },
    /* A read of the descriptor sees the binding's current value too, as it does in Node: the
       property stays a writable, non-configurable data property either way. */
    getOwnPropertyDescriptor: function (t, key) {
      var desc = Object.getOwnPropertyDescriptor(t, key);
      if (desc === undefined || key === '__esModule' || key === Symbol.toStringTag) return desc;
      desc.value = namespace[key];
      return desc;
    },
    /* the three ways of changing one, answered the way Node answers them */
    set: MODULE_TRAPS.set,
    defineProperty: MODULE_TRAPS.defineProperty,
    deleteProperty: MODULE_TRAPS.deleteProperty,
    setPrototypeOf: MODULE_TRAPS.setPrototypeOf
  });
}

/* A module that threw a value that is not an Error threw *that value*: Node hands the caller the
   string, the number, the undefined or the null the module threw, and not an Error built out of a
   record that has neither name nor message. The host carries such a value as its kind and its text
   because a value that is not an object cannot be rebuilt from a name. */
/* The one thing Node writes to stderr when a require()d ES module throws a value that is not an
   object: a code frame with no header, naming the line of its own loader the evaluation happened
   on. It is written once however many such requires there are and whatever the program does with
   the error, and never for an object -- a real Error among them -- so it is written here and
   nowhere else. */
var REQUIRE_THROWN_FRAME_WRITTEN = false;

function noteRequireThrownFrame() {
  if (REQUIRE_THROWN_FRAME_WRITTEN) return;
  REQUIRE_THROWN_FRAME_WRITTEN = true;
  try {
    host.stderr('\nnode:internal/modules/esm/module_job:541\n' +
      '      const namespace = this.module.evaluateSync(filename, parentFilename);\n' +
      ' '.repeat(36) + '^\n');
  } catch (e) { /* a guest with nowhere left to write keeps quiet */ }
}

function thrownValueOf(thrown) {
  if (thrown === null || typeof thrown !== 'object') return undefined;
  switch (thrown.kind) {
    case 'undefined': return undefined;
    case 'null': return null;
    case 'string': return String(thrown.text);
    case 'number': return Number(thrown.text);
    case 'boolean': return thrown.text === 'true';
    case 'symbol': return typeof Symbol === 'function' ? Symbol(thrown.text) : undefined;
    case 'object':
      try { return JSON.parse(String(thrown.json)); } catch (e) { return undefined; }
    default: return undefined;
  }
}

/* An Error of a class the guest has no constructor for -- one the module declared itself -- built
   so that err.constructor.name is the class's name and 'instanceof Error' still holds, which is
   what a caller reads of an error node rebuilt from a class it never had. */
function errorOfClassName(ctorName, message) {
  var Ctor = function (m) {
    var err = new Error(m);
    Object.setPrototypeOf(err, Ctor.prototype);
    return err;
  };
  try { Object.defineProperty(Ctor, 'name', { value: ctorName, configurable: true }); } catch (e) { /* a name that will not take stays */ }
  var proto = Object.create(Error.prototype);
  proto.constructor = Ctor;
  Ctor.prototype = proto;
  return Ctor(message);
}

function requireEsmFailureOf(failure) {
  var info = null;
  try { info = JSON.parse(failure); } catch (e) { info = null; }
  if (info === null || typeof info !== 'object') {
    var plain = new Error(failure);
    plain.code = 'ERR_REQUIRE_ESM';
    return plain;
  }
  /* A value that is not an object cannot be rebuilt from a name, so the host carries it as its own
     kind and text and require() throws it as it stands -- a string, a number, a symbol, an
     undefined or a null, exactly what the module threw. */
  if (typeof info.thrown === 'object' && info.thrown !== null && typeof info.thrown.kind === 'string') {
    noteRequireThrownFrame();
    return thrownValueOf(info.thrown);
  }
  if (typeof info.name !== 'string') {
    var unnamed = new Error(failure);
    unnamed.code = 'ERR_REQUIRE_ESM';
    return unnamed;
  }
  var Ctor = globalThis[info.name];
  /* A class the guest has no global for -- an Error subclass the module declared -- is rebuilt by
     its name, because err.constructor.name is what a caller reads of such an error; a name the
     guest does have is the constructor it has always been built with. */
  var err = typeof Ctor === 'function'
    ? new Ctor(info.message)
    : typeof info.ctorName === 'string' && info.ctorName !== '' && typeof globalThis[info.ctorName] !== 'function'
      ? errorOfClassName(info.ctorName, info.message)
      : new Error(info.message);
  /* The name on the error is its own and not always its class's: MyErr on an object whose
     constructor is My, which is the one thing a rebuilt class cannot know. */
  if (typeof info.name === 'string' && info.name !== '') {
    try { if (err.name !== info.name) err.name = info.name; } catch (e) { /* a frozen error keeps the name it has */ }
  }
  if (typeof info.code === 'string' && info.code !== '') {
    try { err.code = info.code; } catch (e) { /* a frozen error keeps the message it has */ }
  }
  return err;
}

function scheduleTimer(fn, ms, args, repeat, immediate) {
  if (typeof fn !== 'function') {
    throw new TypeError('The "callback" argument must be of type function. Received ' + typeof fn);
  }
  var delay = Number(ms);
  if (!(delay >= 1)) delay = 1;
  var id = nextTimerId++;
  timers[id] = { fn: fn, args: args, repeat: repeat, delay: delay, refed: true, ctx: captureAsyncContext(), immediate: immediate === true, at: host.now() };
  host.ref(1);
  host.setTimer(id, delay);
  var handle = makeTimeout(id);
  if (timers[id]) timers[id].handle = handle;
  return handle;
}

/*
 * setImmediate's own arm, which is not scheduleTimer's: the clamp there is what setTimeout wants
 * (host node 24.15 prices setTimeout(f, 0) at the 1 ms floor too) and it is the one thing an
 * immediate must not inherit. The entry still stands in the timer table -- so clearImmediate,
 * ref/unref, hasRef and the id all read as they did -- but its ordering comes from the queue.
 */
function scheduleImmediate(fn, args) {
  if (typeof fn !== 'function') {
    throw new TypeError('The "callback" argument must be of type function. Received ' + typeof fn);
  }
  var id = nextTimerId++;
  timers[id] = { fn: fn, args: args, repeat: false, delay: 0, refed: true, ctx: captureAsyncContext(), immediate: true, at: host.now() };
  host.ref(1);
  IMMEDIATE_QUEUE.push(id);
  var handle = makeTimeout(id);
  if (timers[id]) timers[id].handle = handle;
  armImmediateWake();
  return handle;
}

/*
 * The host timer that wakes the loop for the queue. It stands on the head, so one wake covers the
 * whole queue, and it is moved along whenever the head is spent; a head that was already cleared is
 * dropped here rather than waited on, since the host timer it held is gone with it.
 */
/*
 * Settles a callback the way host node 24.15 settles an I/O callback: in the poll phase of the next
 * turn, or -- when the operation costs it a second round trip -- in the poll phase of the turn after
 * that one's check phase.
 */
function settleIO(fn, later) {
  /* a pending request keeps the loop alive, as host node 24.15's own in-flight file request does */
  host.ref(1);
  if (later === true) IO_LATER.push(fn);
  else IO_QUEUE.push(fn);
  armTurn();
}

/*
 * The one host timer both queues and the immediate queue wake on. They are one turn's phases and not
 * three races, so a single timer runs them in their order instead of leaving the host's own timer
 * order to decide which comes first.
 */
function armTurn() {
  if (TURN_ARMED) return;
  if (IMMEDIATE_QUEUE.length === 0 && IO_QUEUE.length === 0 && IO_LATER.length === 0) return;
  TURN_ARMED = true;
  host.setTimer(TURN_TIMER, 0);
}

/*
 * One turn of the loop: the I/O callbacks already owed (the poll phase), the immediates standing when
 * they have run (the check phase), then the callbacks a second round trip deferred -- which is the
 * poll phase of the following turn, reached here because this container's smallest turn is the 1 ms
 * floor a host timer cannot go under, and host node 24.15's own readFile lands well inside that.
 */
function runTurnPhases(due) {
  var ready = IO_QUEUE;
  IO_QUEUE = [];
  for (var i = 0; i < ready.length; i++) {
    host.ref(-1);
    ready[i]();
  }
  /* a tick a callback queued is owed before the check phase, as it is on host node 24.15 */
  drainTicks();
  drainImmediatesUntil(due);
  var later = IO_LATER;
  IO_LATER = [];
  if (later.length > 0) {
    for (var j = 0; j < later.length; j++) {
      host.ref(-1);
      later[j]();
    }
    drainTicks();
    /* the check phase of the turn those callbacks landed in, which owes every immediate standing */
    drainImmediatesUntil(Infinity);
  }
}

function armImmediateWake() {
  while (IMMEDIATE_QUEUE.length > 0 && !timers[IMMEDIATE_QUEUE[0]]) {
    var spent = IMMEDIATE_QUEUE.shift();
    if (IMMEDIATE_WAKE === spent) IMMEDIATE_WAKE = 0;
  }
  if (IMMEDIATE_QUEUE.length === 0) IMMEDIATE_WAKE = 0;
  else IMMEDIATE_WAKE = IMMEDIATE_QUEUE[0];
  armTurn();
}

function dropImmediate(id) {
  var at = IMMEDIATE_QUEUE.indexOf(id);
  if (at >= 0) IMMEDIATE_QUEUE.splice(at, 1);
  if (IMMEDIATE_WAKE === id) IMMEDIATE_WAKE = 0;
}

/*
 * The check phase: every immediate armed at or before the due time it is handed runs now, in the
 * order it was queued. That time is what separates the two orders node separates -- an immediate armed while a timer was
 * still pending was queued for a turn that has already gone by, so it runs ahead of that timer; one
 * armed after the timer came due has not come up yet and waits for a later turn, so a timer already
 * overdue when the immediate was armed keeps the priority it has in node.
 */
function drainImmediatesUntil(due) {
  while (IMMEDIATE_QUEUE.length > 0) {
    var id = IMMEDIATE_QUEUE[0];
    var t = timers[id];
    if (!t) {
      IMMEDIATE_QUEUE.shift();
      if (IMMEDIATE_WAKE === id) IMMEDIATE_WAKE = 0;
      continue;
    }
    if (t.at > due) break;
    IMMEDIATE_QUEUE.shift();
    if (IMMEDIATE_WAKE === id) IMMEDIATE_WAKE = 0;
    runTimerEntry(id);
  }
  armImmediateWake();
}

/*
 * The object setTimeout, setInterval and setImmediate hand back, shaped the way host node 24.15
 * shapes it. close() and _idleTimeout belong to a Timeout and to an Interval; an Immediate carries
 * neither -- host node 24.15's Immediate has a _destroyed and no more. _destroyed reads false
 * while the timer is live and true once it is spent, whether it was cleared or fired.
 *
 * hasRef() answers the handle's own ref state and not whether the timer still stands in the table:
 * host node 24.15 takes a cleared timer out of its list without unrefing the object the caller
 * holds, so hasRef() is still true after a clearTimeout, and a fired one-shot is the same.
 */
function makeTimeout(id) {
  var entry = timers[id];
  var handle = {
    _owcTimerId: id,
    _owcRefed: true,
    _destroyed: false,
    ref: function () { handle._owcRefed = true; setTimerRef(id, true); return this; },
    unref: function () { handle._owcRefed = false; setTimerRef(id, false); return this; },
    hasRef: function () { return handle._owcRefed; },
    refresh: function () { return this; }
  };
  if (!(entry && entry.immediate)) {
    handle._idleTimeout = entry ? entry.delay : 1;
    handle.close = function () { clearTimer(id); return this; };
  }
  handle[Symbol.toPrimitive] = function () { return id; };
  return handle;
}

function setTimerRef(id, on) {
  var t = timers[id];
  if (!t || t.refed === on) return;
  t.refed = on;
  host.ref(on ? 1 : -1);
}

function timerIdOf(t) {
  if (typeof t === 'number') return t;
  if (t && typeof t === 'object' && t._owcTimerId !== undefined) return t._owcTimerId;
  return undefined;
}

function clearTimer(t) {
  var id = timerIdOf(t);
  if (id === undefined || !timers[id]) return;
  if (timers[id].refed) host.ref(-1);
  var wasImmediate = timers[id].immediate === true;
  var handle = timers[id].handle;
  delete timers[id];
  host.clearTimer(id);
  /* an immediate is taken out of the queue as well, and the wake moves to the next one standing */
  if (wasImmediate) {
    dropImmediate(id);
    armImmediateWake();
  }
  if (!handle) return;
  handle._destroyed = true;
  /* host node 24.15's clearTimeout writes -1 over _idleTimeout; an Immediate has none to write */
  if (handle._idleTimeout !== undefined) handle._idleTimeout = -1;
}

function fireTimer(id) {
  /*
   * The idle domain value a nested uncaught route leaves behind: see the note in uncaughtInDomain
   * in pure-b.ts. It is spent here and not at the route, because a nextTick queued before the throw
   * runs first and reads the null the route itself wrote.
   */
  var proc = globalThis.process;
  if (proc && proc._owcIdleUndefined === true) {
    proc._owcIdleUndefined = false;
    if (typeof proc._owcSetDomainContext === 'function') proc._owcSetDomainContext(undefined);
  }
  if (IMMEDIATE_WAKE === id) IMMEDIATE_WAKE = 0;
  if (id === TURN_TIMER) {
    TURN_ARMED = false;
    runTurnPhases(Infinity);
    armTurn();
    return;
  }
  var entry = timers[id];
  if (!entry) return;
  if (entry.immediate) {
    /*
     * The queue's own wake, which is the check phase of this turn: every immediate standing in the
     * queue runs in it, and so does one a callback arms while it runs -- host node 24.15 drains its
     * immediate queue whole, and a 300-hop setImmediate chain measures 5 ms there against 300 turns
     * of 1 ms here when each hop waits for a turn of its own.
     */
    drainImmediatesUntil(Infinity);
    return;
  }
  runTurnPhases(entry.at + entry.delay);
  if (!timers[id]) return;
  runTimerEntry(id);
}

function runTimerEntry(id) {
  var t = timers[id];
  if (!t) return;
  if (t.repeat) {
    t.at = host.now();
    host.setTimer(id, t.delay);
  } else {
    delete timers[id];
    if (t.refed) host.ref(-1);
    /* a one-shot that has fired is spent: host node 24.15 leaves _idleTimeout at its delay and
       marks the object destroyed, so hasRef() still answers true there */
    if (t.handle) t.handle._destroyed = true;
  }
  runInAsyncContext(t.ctx, function () {
    /*
     * An immediate runs one domain deeper than a timer or a tick does when a domain is entered
     * while it fires: host node 24.15's processImmediate invokes the callback through MakeCallback,
     * which enters process.domain itself -- the deprecated path the DEP0097 warning names -- on top
     * of the enter the bound callback does. Measured on host node 24.15 against this container:
     * one d.enter() and an immediate, domain._stack is 3 there and was 2 here (s1), two nested
     * enters 4 against 3 (s2), enter/enter/exit 3 against 2 (s6), an immediate inside an immediate
     * 3 against 2 (s8) -- while a timer and a tick scheduled the same way agree at 2 (s9), and an
     * immediate that fires with no domain entered agrees at 1 (i1, i7). It is an enter the driver
     * undoes on the way out, not a leak: a later timer reads the same depth on both sides (j1).
     */
    var dom = t.immediate && proc ? proc.domain : null;
    if (!(dom && typeof dom.enter === 'function' && typeof dom.exit === 'function')) {
      try {
        t.fn.apply(undefined, t.args);
      } catch (err) {
        uncaughtFromCallback(err);
        leaveBoundDomain(t.fn);
      }
      return;
    }
    dom.enter();
    try {
      t.fn.apply(undefined, t.args);
    } catch (err) {
      /*
       * A throw out of the callback leaves the extra enter in place, and the route is reached with
       * process.domain still the innermost one -- which is host node 24.15's rule too. Node's
       * topLevelDomainCallback enters in a plain statement pair, with no try/finally, and its
       * async_hooks after() -- the domain.exit() that would undo the immediate's own enter -- is
       * skipped for a callback that failed, so the uncaught route reads process.domain as the
       * domain the callback ran in and not the one entered when it fired. Exiting here instead
       * splices at the lastIndexOf() of the entered domain, which takes the callback's own domain
       * off the stack with it and routes the error to the outer one: three domains entered, the
       * callback owned by the middle one, host node 24.15 runs the middle handler and this
       * container ran the outer one (measured: b11, b15, b18, and b17, where the entered domain is
       * silent and host node 24.15 still handles the error where this container fell through to
       * 'uncaughtException'). The route empties the stack either way, so the enter is not a leak.
       */
      uncaughtFromCallback(err);
      /*
       * An immediate that throws leaves the process on undefined at the next timer, not on the null
       * the route wrote -- measured on host node 24.15 (k1 with an 'uncaughtException' listener, k3
       * without, k5 with a tick and a 0 ms timer before it): the leave host node owes the immediate
       * lands after the route has already cleared, and a leave with nothing on the stack writes the
       * undefined an ordinary leave writes. Same flag the nested route in uncaughtInDomain leaves,
       * spent the same way, at the next timer.
       */
      if (proc && proc.domain === null) proc._owcIdleUndefined = true;
      leaveBoundDomain(t.fn);
      return;
    }
    dom.exit();
  });
}

/* a callback scheduled while a domain is active runs bound to it, so its errors reach the domain's 'error' listeners */
function bindToActiveDomain(fn) {
  var proc = globalThis.process;
  var dom = proc && proc.domain;
  return dom && typeof dom.bind === 'function' && typeof fn === 'function' ? dom.bind(fn) : fn;
}

function setTimeoutImpl(fn, ms) {
  return scheduleTimer(bindToActiveDomain(fn), ms, Array.prototype.slice.call(arguments, 2), false);
}

function setIntervalImpl(fn, ms) {
  return scheduleTimer(bindToActiveDomain(fn), ms, Array.prototype.slice.call(arguments, 2), true);
}

function setImmediateImpl(fn) {
  /* the one timer kind host node 24.15 runs a domain deeper: see the note in fireTimer */
  return scheduleImmediate(bindToActiveDomain(fn), Array.prototype.slice.call(arguments, 1));
}

/* process.nextTick queue: drained by the host before each promise job, as Node does */
var TICK_QUEUE = [];
var PENDING_UNCAUGHT = null;

/* async-local context: the async_hooks module installs capture() and run(token, fn) when it loads */
var ASYNC_CONTEXT = { capture: null, run: null };

function captureAsyncContext() {
  return ASYNC_CONTEXT.capture ? ASYNC_CONTEXT.capture() : null;
}

/* A callback scheduled with no frame captured must run with no frame, and not inherit one a later
   enterWith leaves behind: node gives a timer queued before als.enterWith('E') undefined. */
function runInAsyncContext(token, fn) {
  if (!ASYNC_CONTEXT.run) return fn();
  return ASYNC_CONTEXT.run(token, fn);
}

function enqueueTick(fn, args) {
  TICK_QUEUE.push({ fn: fn, args: args, ctx: captureAsyncContext() });
}

/* an exception that escapes a callback with no caller to receive it ends the process (first one wins) */
function reportUncaught(err) {
  if (PENDING_UNCAUGHT === null) PENDING_UNCAUGHT = { error: err };
}

/*
 * The two hooks the domain module puts on every instance it builds, under symbol keys so that a
 * domain's own names stay host node 24.15's: see the note at BF.domain in pure-b.ts.
 */
var DOMAIN_UNCAUGHT = Symbol.for('owc.domain.uncaught');
var DOMAIN_ENTERED = Symbol.for('owc.domain.entered');

/*
 * The leave host node 24.15 owes the resource whose callback just threw: its async_hooks after()
 * hook exits the domain that resource was paired with -- the one active when the callback was
 * scheduled, which is the one d.bind() puts on the wrapper and the one the wrapper entered -- once
 * the uncaught route has run. Measured on host node 24.15 (k23 a timer, k24 a tick, k25 an
 * immediate, g06, each throwing inside d.run() with every 'uncaughtException' listener registered
 * before require('domain')): the handler itself reads process.domain as the domain and
 * domain._stack.length 1 on both sides, and a timer that fires afterwards reads undefined and 0
 * there against the domain still entered here -- the undefined an exit() writes when nothing is
 * left on the stack, because nothing else clears it. A callback no domain was bound to is left
 * alone, which is what host node 24.15 does too: an unpaired resource has no after() to run.
 *
 * A route that did clear -- a domain that listened, or the listener lib/domain.js prepends --
 * empties the stack first, and then there is nothing on it for this to exit.
 */
function leaveBoundDomain(fn) {
  var dom = fn && typeof fn === 'function' ? fn.domain : null;
  if (!dom || typeof dom.exit !== 'function' || dom[DOMAIN_ENTERED] !== true) return;
  dom.exit();
}

/*
 * An 'uncaughtException' listener, given an error no caller is going to receive: true once one has
 * run, and true as well when the listener itself throws something other than the exit signal, since
 * node lets that one end the process too. The listener is counted when the error is in hand and not
 * when the callback was scheduled, because a program registers it at the top and throws at the
 * bottom. False when there is none, which leaves the caller the fatal path.
 *
 * A domain comes before the process: node hands an error no caller is going to receive to the
 * domain the domain module has entered, not to 'uncaughtException', so d.run(() => { throw })
 * prints the domain's 'error' handler on host node 24.15 whether or not an 'uncaughtException'
 * listener is registered at all. A domain with no 'error' listener answers false, and then the
 * process gets the error exactly as it did before.
 */
function emitUncaught(err, skipDomain) {
  var proc = globalThis.process;
  var dom = proc && !skipDomain ? proc.domain : null;
  if (dom && typeof dom[DOMAIN_UNCAUGHT] === 'function') {
    try {
      if (dom[DOMAIN_UNCAUGHT](err)) return true;
    } catch (again) {
      /* a handler that ends the process throws the exit signal, as an uncaughtException one may */
      if (again !== EXIT_SIGNAL) throw again;
      return true;
    }
  }
  if (!(proc && typeof proc.emit === 'function' && proc.listenerCount('uncaughtException') > 0)) return false;
  try {
    proc.emit('uncaughtException', err);
  } catch (again) {
    if (again !== EXIT_SIGNAL) throw again;
  }
  return true;
}

/* what an error out of a timer or a tick does: a listener is given it, or it ends the process */
function uncaughtFromCallback(err, skipDomain) {
  if (!emitUncaught(err, skipDomain)) reportUncaught(err);
}

function drainTicks() {
  while (TICK_QUEUE.length > 0) {
    var job = TICK_QUEUE.shift();
    try {
      runInAsyncContext(job.ctx, function () {
        job.fn.apply(undefined, job.args);
      });
    } catch (err) {
      uncaughtFromCallback(err);
      leaveBoundDomain(job.fn);
    }
  }
}

/*
 * queueMicrotask is not a promise reaction a domain binds, so the callback is not bound when it is
 * queued and the reaction that runs it is queued with the engine's own then, taken before the
 * domain module patches it. The job is not what enters the domain, though: it runs with the domain
 * that was active when it was queued as its async context, which is what host node 24.15 measures
 * -- queued inside d.run(), whose exit has run by the time the job does, process.domain is still d
 * and process.hasUncaughtExceptionCaptureCallback() is still true inside it.
 *
 * Routing is the other half and follows the enter/exit stack, not that context: a throw out of a
 * microtask queued inside d.run() reaches 'uncaughtException' (and ends the process when there is
 * none), while one queued while a domain is still entered reaches that domain.
 */
var ENGINE_THEN = Promise.prototype.then;

/* the domain a job runs with as its context: set without entering it, so no stack is touched */
function setDomainContext(dom) {
  var proc = globalThis.process;
  if (!proc || typeof proc._owcSetDomainContext !== 'function') return undefined;
  return proc._owcSetDomainContext(dom);
}

function queueMicrotaskImpl(fn) {
  if (typeof fn !== 'function') throw new TypeError('The "callback" argument must be of type function');
  var proc = globalThis.process;
  var dom = proc ? proc.domain : null;
  var ctx = captureAsyncContext();
  ENGINE_THEN.call(Promise.resolve(), function () {
    var prior = dom ? setDomainContext(dom) : undefined;
    var settled = false;
    try {
      runInAsyncContext(ctx, function () {
        fn();
      });
    } catch (err) {
      /*
       * A throw out of the job settles the process domain for the rest of the run, so neither the
       * context it was given nor the one it replaced may be put back over what the route left:
       * host node 24.15 leaves the value the route itself wrote -- the null the listener
       * lib/domain.js prepends to every 'uncaughtException' list, or the domain when no listener was
       * registered before require('domain') and there is no clear to run -- and restoring the
       * pre-job context over it is what made a later timer read undefined where the host read null
       * (f12, k04). The context is not nulled for the route either: the domain is only this job's
       * context and not entered, so what asks the process instead of the domain is the flag, and
       * the route itself sees the domain, as it does on host node 24.15.
       */
      settled = true;
      uncaughtFromCallback(err, !!dom && dom[DOMAIN_ENTERED] !== true);
    } finally {
      if (dom && !settled) setDomainContext(prior);
    }
  });
}

function createRequireFor(filename) {
  var path = filename.indexOf('file://') === 0 ? decodeURIComponent(filename.slice(7)) : filename;
  return makeRequire(new Module(path, null));
}

/* The REPL's own require. It resolves from the working directory, the way a file there would, but
   Node names the module it resolves from '<repl>', and that is the name a resolution failure prints
   in its require stack: '- <repl>' under the message, and nothing else. */
var REPL_MODULE = '<repl>';

function createReplRequire(directory) {
  var mod = new Module(String(directory) + '/x', null);
  mod.id = REPL_MODULE;
  mod.filename = REPL_MODULE;
  return makeRequire(mod);
}

/* import.meta and import attributes: the host rewrites ES module sources to call these two */
var IMPORT_META = Object.create(null);
var ATTRIBUTE_MISSING = '\u0001owc-attr-missing';

/* A data URL is already a URL: 'file://' is not put in front of one, in import.meta.url or in an
   import attribute message. */
function fileUrlOf(p) {
  if (p.indexOf('data:') === 0) return p;
  return 'file://' + encodeURI(p).replace(/\?/g, '%3F').replace(/#/g, '%23');
}

/* The query and fragment a specifier carries into the module it names, '' when it carries none:
   './m.mjs?x=1#f' is '?x=1#f'. A bare specifier carries none -- its query is part of a subpath --
   which is why 'pkg/sub?x=1' is a subpath no "exports" map defines rather than 'pkg/sub'. A file:
   URL carries them as a URL does; a data: URL carries none, its text being the module. */
function urlSuffixOf(spec) {
  if (spec.indexOf('file:') === 0) {
    var hash = spec.indexOf('#');
    var query = spec.indexOf('?');
    var at = hash < 0 ? query : query < 0 ? hash : Math.min(query, hash);
    return at < 0 ? '' : spec.slice(at);
  }
  if (spec.indexOf('data:') === 0) return '';
  var h = spec.indexOf('#');
  var noFragment = hash < 0 ? spec : spec.slice(0, hash);
  var query = noFragment.indexOf('?');
  var bare = query < 0 ? noFragment : noFragment.slice(0, query);
  if (bare === spec) return '';
  if (bare.charAt(0) !== '/' && bare !== '.' && bare !== '..' && bare.indexOf('./') !== 0 && bare.indexOf('../') !== 0) return '';
  return spec.slice(bare.length);
}

/* urlSuffix is the query and fragment of the specifier that named this module: they belong to its
   URL and to its identity, as they do in Node, but not to the file it was read from. */
function importMetaOf(filename, isMain, urlSuffix) {
  var suffix = typeof urlSuffix === 'string' ? urlSuffix : '';
  var key = filename + '\u0000' + suffix;
  var cached = IMPORT_META[key];
  if (cached) return cached;
  var meta = Object.create(null);
  meta.url = fileUrlOf(filename) + suffix;
  meta.dirname = dirnameOf(filename);
  meta.filename = filename;
  meta.main = !!isMain;
  meta.resolve = function resolve(specifier) {
    var spec = String(specifier);
    if (isBuiltinName(spec)) return 'node:' + stripNodePrefix(spec);
    /* Node's import.meta.resolve does not look at the file system: a specifier that names a path or
       a URL gets its URL back whether or not the file is there. Only a specifier that names no URL
       at all fails, with the reason the resolve gives. */
    var url = host.resolveMeta(spec, dirnameOf(filename));
    if (url !== '') return url;
    var info = null;
    try { info = JSON.parse(host.resolveFailure(spec, dirnameOf(filename), 'import')); } catch (e) { info = null; }
    if (info !== null && typeof info === 'object') {
      if (info.kind === 'not-exported') {
        var e1 = new Error("Package subpath '" + info.subpath + "' is not defined by \"exports\" in " + info.packageDir + '/package.json imported from ' + filename);
        e1.code = 'ERR_PACKAGE_PATH_NOT_EXPORTED';
        throw e1;
      }
      if (info.kind === 'import-not-defined') {
        var e2 = new TypeError("Package import specifier \"" + info.specifier + "\" is not defined in package " + info.packageDir + '/package.json imported from ' + filename);
        e2.code = 'ERR_PACKAGE_IMPORT_NOT_DEFINED';
        throw e2;
      }
      if (info.kind === 'bad-file-url') {
        var e3 = info.ctor === 'URIError' ? new URIError(info.message) : new TypeError(info.message);
        if (info.code !== '') e3.code = info.code;
        throw e3;
      }
      if (info.target === 'package') {
        var e4 = new Error("Cannot find package '" + info.name + "' imported from " + filename);
        e4.code = 'ERR_MODULE_NOT_FOUND';
        throw e4;
      }
    }
    var err = new Error("Cannot find module '" + spec + "' imported from " + filename);
    err.code = 'ERR_MODULE_NOT_FOUND';
    throw err;
  };
  IMPORT_META[key] = meta;
  return meta;
}

function importUrlOf(spec, filename) {
  var base = dirnameOf(typeof filename === 'string' && filename !== '' ? filename : host.cwd() + '/x');
  var found = host.resolve(String(spec), base, 'import');
  return found ? fileUrlOf(found) + urlSuffixOf(String(spec)) : undefined;
}

/* The module name of a module whose evaluation throws a recorded error: the host builds the module
   from it, so an import Node rejects throws the error Node throws, code included. */
function errorModuleOf(info) {
  return 'owc-error:' + encodeURIComponent(JSON.stringify(info));
}

/* Import attributes on a dynamic import, the way Node reads them: an attribute that is not "type",
   or a type the loader does not support, is ERR_IMPORT_ATTRIBUTE_UNSUPPORTED; "type": "json" on a
   module that is not JSON is ERR_IMPORT_ATTRIBUTE_TYPE_INCOMPATIBLE; a .json module imported
   without "type": "json" is ERR_IMPORT_ATTRIBUTE_MISSING. A specifier that resolves to nothing is
   left alone, so it fails as a missing module, as it does in Node. */
function importArgOf(spec, options, filename) {
  globalThis.__owc_dynamic_load = true;
  var s = String(spec);
  var attrs = options && typeof options === 'object' && options.with && typeof options.with === 'object' ? options.with : null;
  /* JSON is named by a .json path, and by a data: URL whose media type is application/json. */
  var isJson = s.slice(-5) === '.json' || /^data:application\/json[,;]/.test(s.toLowerCase());
  var url = importUrlOf(s, filename);
  if (attrs !== null && url !== undefined) {
    var keys = Object.keys(attrs);
    var failure = null;
    var typeJson = false;
    for (var k = 0; k < keys.length && failure === null; k++) {
      var value = attrs[keys[k]];
      if (keys[k] !== 'type') {
        failure = { code: 'ERR_IMPORT_ATTRIBUTE_UNSUPPORTED', ctor: 'TypeError', message: 'Import attribute ' + JSON.stringify(keys[k]) + ' with value ' + JSON.stringify(String(value)) + ' is not supported in ' + url };
      } else if (value !== 'json') {
        failure = { code: 'ERR_IMPORT_ATTRIBUTE_UNSUPPORTED', ctor: 'TypeError', message: 'Import attribute "type" with value ' + JSON.stringify(String(value)) + ' is not supported in ' + url };
      } else {
        typeJson = true;
      }
    }
    if (failure === null && typeJson && !isJson) {
      failure = { code: 'ERR_IMPORT_ATTRIBUTE_TYPE_INCOMPATIBLE', ctor: 'TypeError', message: 'Module ' + JSON.stringify(url) + ' is not of type "json"' };
    }
    if (failure !== null) return errorModuleOf(failure);
  }
  if (isJson && !(attrs !== null && attrs.type === 'json')) return s + ATTRIBUTE_MISSING;
  return s;
}

/* The engine rebuilds a module loader error as a plain Error and drops everything else that was on
   it, so the host publishes the code of the failure it raised and this wrapper sets it back on the
   rejection: a module that resolves to no file carries ERR_MODULE_NOT_FOUND, and a specifier no
   loader can read carries ERR_UNSUPPORTED_ESM_URL_SCHEME. */
function importWrap(promise, strict) {
  return promise.then(function (value) {
    return moduleViewOf(value, strict);
  }, function (err) {
    var code = globalThis.__owc_import_failure;
    var url = globalThis.__owc_import_failure_url;
    globalThis.__owc_import_failure = undefined;
    globalThis.__owc_import_failure_url = undefined;
    if (err !== null && typeof err === 'object') {
      if (typeof code === 'string' && err.code === undefined) {
        try { err.code = code; } catch (e) { /* a frozen error keeps the message it already has */ }
      }
      /* The url is dropped the way the code is, and is put back the same way: it names the file the
         specifier pointed at, and a bare name that resolves to no package has none -- so it is
         written only when there is one, and never as undefined. */
      if (typeof url === 'string' && err.url === undefined) {
        try { err.url = url; } catch (e) { /* a frozen error keeps the message it already has */ }
      }
    }
    throw err;
  });
}

OWC_BRIDGE.__owc_importMeta = importMetaOf;
OWC_BRIDGE.__owc_moduleView = moduleViewOf;
OWC_BRIDGE.__owc_importArg = importArgOf;
OWC_BRIDGE.__owc_importWrap = importWrap;

var api = {
  drainTicks: function () {
    drainTicks();
    return api.takeUncaught();
  },
  takeUncaught: function () {
    if (PENDING_UNCAUGHT === null) return null;
    var pending = PENDING_UNCAUGHT;
    PENDING_UNCAUGHT = null;
    return api.formatUncaught(pending.error);
  },
  runMain: function (filename) {
    /*
     * An exception that reaches the top of the main module ends the process -- but only after an
     * 'uncaughtException' listener has been given it, and a listener that has been given it *keeps*
     * the process alive: node does not exit once one has run, so what happens next is the handler's
     * to decide (it may well call process.exit, and then that code is the status). With no listener
     * and no domain entered the error goes exactly where it has always gone, out of the main module
     * and off the end of the process, which is the fatal path that ends it with status 1.
     */
    try {
      loadCJS(filename, null, true);
    } catch (err) {
      /* The listener is counted when the error is in hand, not when the module starts: a program
         registers it at the top and throws at the bottom, so at the start there is none. The
         domain is asked first, as it is everywhere else an error has no caller to receive it. */
      if (!emitUncaught(err)) throw err;
    }
  },
  fire: fireTimer,
  clearAll: function () {
    timers = Object.create(null);
    IMMEDIATE_QUEUE.length = 0;
    IMMEDIATE_WAKE = 0;
    IO_QUEUE = [];
    IO_LATER = [];
    TURN_ARMED = false;
  },
  keysOf: function (id, builtin) {
    var exported = builtin ? requireBuiltin(id) : loadCJS(id, null, false).exports;
    return JSON.stringify(Object.keys(exported === undefined || exported === null ? {} : exported));
  },
  exportsOf: function (id, builtin) {
    return builtin ? requireBuiltin(id) : loadCJS(id, null, false).exports;
  },
  /* the REPL's require: see createReplRequire */
  createReplRequire: function (directory) {
    return createReplRequire(directory);
  },
  /* the host compiles ES modules itself, so it asks for the compatibility rewrite here; the source comes back unchanged when nothing applies */
  compatRewrite: function (source) {
    var fixed = null;
    try { fixed = rxRewrite(source); } catch (rewriteErr) { fixed = null; }
    return fixed === null ? source : fixed;
  },
  builtinNames: function () {
    return JSON.stringify(Object.keys(BF));
  },
  runEval: function (source) {
    var filename = host.cwd() + '/[eval]';
    var mod = new Module(filename, null);
    mainModule = mod;
    var wrapper = compileCjsWrapper(source, filename);
    wrapper.call(mod.exports, mod.exports, makeRequire(mod), mod, filename, mod.path);
  },
  uptimeMs: function () {
    return host.now() - startedAt;
  }
};
`;
