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
var startedAt = host.now();

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
function requireStackOf(parent) {
  var names = [];
  var cursor = parent;
  while (cursor !== null && cursor !== undefined) {
    names.push(cursor.filename || cursor.id);
    cursor = cursor.parent;
  }
  return names.length === 0 ? '' : '\nRequire stack:\n- ' + names.join('\n- ');
}

function moduleNotFound(id, parent) {
  var err = new Error("Cannot find module '" + id + "'" + requireStackOf(parent));
  err.code = 'MODULE_NOT_FOUND';
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
  if (CURRENT_FILE === '') return REAL_FUNCTION.apply(REAL_FUNCTION, arguments);
  var params = [];
  for (var k = 0; k < argc - 1; k++) params.push(String(arguments[k]));
  var body = argc === 0 ? '' : String(arguments[argc - 1]);
  var compiled = host.compileFunction(
    '(function anonymous(' + params.join(',') + '\n) {\n' + body + '\n})',
    CURRENT_FILE
  );
  if (typeof compiled === 'string') throw new SyntaxError(compiled);
  return compiled;
};
globalThis.Function.prototype = REAL_FUNCTION.prototype;

function readSource(filename) {
  var src = host.readText(filename);
  if (src === null) throw moduleNotFound(filename);
  return src;
}

function stripHashbang(src) {
  return src.charAt(0) === '#' && src.charAt(1) === '!' ? '//' + src.slice(2) : src;
}

function Module(filename, parent) {
  this.id = filename;
  this.filename = filename;
  this.path = dirnameOf(filename);
  this.exports = {};
  this.parent = parent;
  this.loaded = false;
  this.children = [];
  this.paths = [];
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
Module._nodeModulePaths = function _nodeModulePaths() { return []; };
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
    if (isBuiltinName(id)) return stripNodePrefix(id);
    var found = host.resolve(String(id), mod.path, 'require');
    if (!found) throw notFoundError(id, mod.path, mod);
    return found;
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

/* The host compiles the wrapper, not an in-guest eval: the engine names eval'd code <input>, so
   every CommonJS module would share one nameless script and its stack frames would carry no path.
   Packages that locate their binary from a stack frame (bindings, and anything built on it) read
   CallSite.getFileName() and fail on that. A failed compile comes back as the message string. */
function compileCjs(src, filename) {
  var compiled = host.compileCjs(src, filename);
  if (typeof compiled === 'string') throw new SyntaxError(compiled);
  return compiled;
}

function compileCjsWrapper(src, filename) {
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
  if (cached) return cached;
  var mod = new Module(filename, parent);
  if (isMain) mainModule = mod;
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

/* require() of an ES module. The host reports a failure as a record of the error it met, so what
   require() throws is the error Node throws: a module that does not parse is a SyntaxError, one
   that throws reports its own error, and one whose own import is missing ERR_MODULE_NOT_FOUND.
   Only a failure the host cannot describe is left as ERR_REQUIRE_ESM. */
function loadEsmFromRequire(filename, mod) {
  var token = nextEsmToken++;
  var failure = host.esmLoad(filename, token);
  if (failure) throw requireEsmFailureOf(failure);
  var registry = globalThis.__owc_esm_registry || {};
  var namespace = registry[token];
  delete registry[token];
  if (namespace === undefined) {
    var asyncErr = new Error('require() cannot be used on an ESM graph with top-level await. Use import() instead.');
    asyncErr.code = 'ERR_REQUIRE_ASYNC_MODULE';
    throw asyncErr;
  }
  /* A module with a default export is the one Node marks, so a transpiled CommonJS consumer that
     looks for __esModule finds it; one with no default export is handed over as it stands. */
  mod.exports = Object.prototype.hasOwnProperty.call(namespace, 'default')
    ? markedNamespace(namespace)
    : namespace;
  mod.loaded = true;
  return mod;
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
    }
  });
}

function requireEsmFailureOf(failure) {
  var info = null;
  try { info = JSON.parse(failure); } catch (e) { info = null; }
  if (info === null || typeof info !== 'object' || typeof info.name !== 'string') {
    var plain = new Error(failure);
    plain.code = 'ERR_REQUIRE_ESM';
    return plain;
  }
  var Ctor = globalThis[info.name];
  var err = typeof Ctor === 'function' ? new Ctor(info.message) : new Error(info.message);
  if (typeof info.code === 'string' && info.code !== '') {
    try { err.code = info.code; } catch (e) { /* a frozen error keeps the message it has */ }
  }
  return err;
}

function scheduleTimer(fn, ms, args, repeat) {
  if (typeof fn !== 'function') {
    throw new TypeError('The "callback" argument must be of type function. Received ' + typeof fn);
  }
  var delay = Number(ms);
  if (!(delay >= 1)) delay = 1;
  var id = nextTimerId++;
  timers[id] = { fn: fn, args: args, repeat: repeat, delay: delay, refed: true, ctx: captureAsyncContext() };
  host.ref(1);
  host.setTimer(id, delay);
  return makeTimeout(id);
}

function makeTimeout(id) {
  var handle = {
    _owcTimerId: id,
    ref: function () { setTimerRef(id, true); return this; },
    unref: function () { setTimerRef(id, false); return this; },
    hasRef: function () { return !!(timers[id] && timers[id].refed); },
    refresh: function () { return this; }
  };
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
  delete timers[id];
  host.clearTimer(id);
}

function fireTimer(id) {
  var t = timers[id];
  if (!t) return;
  if (t.repeat) {
    host.setTimer(id, t.delay);
  } else {
    delete timers[id];
    if (t.refed) host.ref(-1);
  }
  runInAsyncContext(t.ctx, function () {
    t.fn.apply(undefined, t.args);
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
  return scheduleTimer(bindToActiveDomain(fn), 0, Array.prototype.slice.call(arguments, 1), false);
}

/* process.nextTick queue: drained by the host before each promise job, as Node does */
var TICK_QUEUE = [];
var PENDING_UNCAUGHT = null;

/* async-local context: the async_hooks module installs capture() and run(token, fn) when it loads */
var ASYNC_CONTEXT = { capture: null, run: null };

function captureAsyncContext() {
  return ASYNC_CONTEXT.capture ? ASYNC_CONTEXT.capture() : null;
}

function runInAsyncContext(token, fn) {
  if (token === null || token === undefined || !ASYNC_CONTEXT.run) return fn();
  return ASYNC_CONTEXT.run(token, fn);
}

function enqueueTick(fn, args) {
  TICK_QUEUE.push({ fn: fn, args: args, ctx: captureAsyncContext() });
}

/* an exception that escapes a callback with no caller to receive it ends the process (first one wins) */
function reportUncaught(err) {
  if (PENDING_UNCAUGHT === null) PENDING_UNCAUGHT = { error: err };
}

function drainTicks() {
  while (TICK_QUEUE.length > 0) {
    var job = TICK_QUEUE.shift();
    try {
      runInAsyncContext(job.ctx, function () {
        job.fn.apply(undefined, job.args);
      });
    } catch (err) {
      reportUncaught(err);
    }
  }
}

function queueMicrotaskImpl(fn) {
  if (typeof fn !== 'function') throw new TypeError('The "callback" argument must be of type function');
  fn = bindToActiveDomain(fn);
  var ctx = captureAsyncContext();
  Promise.resolve().then(function () {
    try {
      runInAsyncContext(ctx, function () {
        fn();
      });
    } catch (err) {
      reportUncaught(err);
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
function importWrap(promise) {
  return promise.then(null, function (err) {
    var code = globalThis.__owc_import_failure;
    globalThis.__owc_import_failure = undefined;
    if (typeof code === 'string' && err !== null && typeof err === 'object' && err.code === undefined) {
      try { err.code = code; } catch (e) { /* a frozen error keeps the message it already has */ }
    }
    throw err;
  });
}

Object.defineProperty(globalThis, '__owc_importMeta', { value: importMetaOf, writable: true, configurable: true });
Object.defineProperty(globalThis, '__owc_importArg', { value: importArgOf, writable: true, configurable: true });
Object.defineProperty(globalThis, '__owc_importWrap', { value: importWrap, writable: true, configurable: true });

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
    loadCJS(filename, null, true);
  },
  fire: fireTimer,
  clearAll: function () {
    timers = Object.create(null);
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
    var wrapper = compileCjs(source, filename);
    wrapper.call(mod.exports, mod.exports, makeRequire(mod), mod, filename, mod.path);
  },
  uptimeMs: function () {
    return host.now() - startedAt;
  }
};
`;
