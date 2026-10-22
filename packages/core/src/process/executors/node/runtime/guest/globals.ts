/**
 * The version this runtime reports as its own: what `node --version` prints, and what the guest's
 * `process.version` holds. One constant, so the two can never disagree.
 */
export const NODE_VERSION = 'v24.15.0';

/**
 * Guest-side globals: the `process` object (an EventEmitter), the console, the
 * standard globals (Buffer, timers, URL, TextEncoder, atob/btoa, performance,
 * crypto) and the finalize hooks the host calls at exit. Plain JavaScript inside a
 * String.raw snippet.
 */
export const GLOBALS_SRC = String.raw`
var EventEmitterCls = requireBuiltin('events');
var envStore = JSON.parse(host.envJSON());
/*
 * Node's own `process.env` is not a plain object: its prototype is an object of node's that is not
 * `Object.prototype`, and a package that asks which it is gets the answer the host gives. An empty
 * object stands in for it, so the properties still read, write and enumerate as an ordinary
 * object's do while `Object.getPrototypeOf(process.env) === Object.prototype` is false, as on the
 * host.
 */
var ENV_PROTO = {};
Object.setPrototypeOf(envStore, ENV_PROTO);
/*
 * A write to the environment is a change to *this process's* environment, and on the host that is
 * what a child inherits: `process.env.X = v` followed by a spawn hands `X` down. Publishing the
 * whole object after each write is what keeps the host's copy -- the one a spawn reads -- in step;
 * a symbol key is left alone, because no environment variable has one.
 */
var publishEnv = function () { host.setEnvJSON(JSON.stringify(envStore)); };
var procEnv = new Proxy(envStore, {
  set: function (target, name, value) {
    if (typeof name === 'symbol') { target[name] = value; return true; }
    target[name] = String(value);
    publishEnv();
    return true;
  },
  deleteProperty: function (target, name) {
    delete target[name];
    if (typeof name !== 'symbol') publishEnv();
    return true;
  }
});
var proc = Object.create(EventEmitterCls.prototype);
EventEmitterCls.call(proc);
proc.title = 'node';
proc.version = '${NODE_VERSION}';
proc.versions = { node: '24.15.0', v8: '13.6.233.10-node.24', uv: '1.51.0', owc: '0.1.0', napi: '10' };
proc.arch = 'x64';
proc.platform = 'linux';
proc.release = { name: 'node' };
Object.defineProperty(proc, Symbol.toStringTag, { value: 'process', configurable: true });
proc.features = {};
/*
 * The flags node 24.15 accepts in NODE_OPTIONS, as the Set process.allowedNodeEnvironmentFlags is:
 * a package asks `has()` of it before it puts a flag in the options it spawns with, and an
 * undefined here made that ask throw. The list is the one that node's own build reports, written
 * out rather than generated, because no guest can ask the node it models what it accepts.
 */
var ENV_FLAGS = ''.split(' ');
proc.allowedNodeEnvironmentFlags = new Set(ENV_FLAGS);
/*
 * Two internal bindings are provided: 'constants', which packages such as tmp read at load time,
 * and 'uv', which the old execa bundled into envinfo (a create-react-app dependency) reads to turn
 * an errno into a name -- it wants uv.errname and, failing that, the UV_E* constants. Every other
 * name fails as it does in node.
 */
proc.binding = function binding(name) {
  if (name === 'constants') {
    return {
      os: requireBuiltin('os').constants,
      fs: requireBuiltin('fs').constants,
      crypto: {},
      zlib: requireBuiltin('zlib').constants || {},
      trace: {}
    };
  }
  if (name === 'uv') return uvBinding();
  throw new Error('No such module: ' + name);
};
/*
 * libuv's errno table, which is all uv_err_name is: the numbers node 24.15 reports for these
 * constants on Linux, and a code's name is its constant with UV_ stripped, so errname(-2) is
 * 'ENOENT' and errname(-4094) is 'UNKNOWN'. Node's own errname asserts -- aborts the whole process
 * -- on a code that is not negative; this one answers 'UNKNOWN' instead, because a guest that kills
 * its container is worse than one that reports an error it cannot name. util.getSystemErrorName
 * shares the table through __owcErrname and keeps node's stricter RangeError.
 */
var UV_ERRNO = {
  UV_E2BIG: -7, UV_EACCES: -13, UV_EADDRINUSE: -48, UV_EADDRNOTAVAIL: -49, UV_EAFNOSUPPORT: -47, UV_EAGAIN: -35,
  UV_EAI_ADDRFAMILY: -3000, UV_EAI_AGAIN: -3001, UV_EAI_BADFLAGS: -3002, UV_EAI_BADHINTS: -3013, UV_EAI_CANCELED: -3003, UV_EAI_FAIL: -3004,
  UV_EAI_FAMILY: -3005, UV_EAI_MEMORY: -3006, UV_EAI_NODATA: -3007, UV_EAI_NONAME: -3008, UV_EAI_OVERFLOW: -3009, UV_EAI_PROTOCOL: -3014,
  UV_EAI_SERVICE: -3010, UV_EAI_SOCKTYPE: -3011, UV_EALREADY: -37, UV_EBADF: -9, UV_EBUSY: -16, UV_ECANCELED: -89,
  UV_ECHARSET: -4080, UV_ECONNABORTED: -53, UV_ECONNREFUSED: -61, UV_ECONNRESET: -54, UV_EDESTADDRREQ: -39, UV_EEXIST: -17,
  UV_EFAULT: -14, UV_EFBIG: -27, UV_EHOSTUNREACH: -65, UV_EINTR: -4, UV_EINVAL: -22, UV_EIO: -5,
  UV_EISCONN: -56, UV_EISDIR: -21, UV_ELOOP: -62, UV_EMFILE: -24, UV_EMSGSIZE: -40, UV_ENAMETOOLONG: -63,
  UV_ENETDOWN: -50, UV_ENETUNREACH: -51, UV_ENFILE: -23, UV_ENOBUFS: -55, UV_ENODEV: -19, UV_ENOENT: -2,
  UV_ENOMEM: -12, UV_ENONET: -4056, UV_ENOPROTOOPT: -42, UV_ENOSPC: -28, UV_ENOSYS: -78, UV_ENOTCONN: -57,
  UV_ENOTDIR: -20, UV_ENOTEMPTY: -66, UV_ENOTSOCK: -38, UV_ENOTSUP: -45, UV_EOVERFLOW: -84, UV_EPERM: -1,
  UV_EPIPE: -32, UV_EPROTO: -100, UV_EPROTONOSUPPORT: -43, UV_EPROTOTYPE: -41, UV_ERANGE: -34, UV_EROFS: -30,
  UV_ESHUTDOWN: -58, UV_ESPIPE: -29, UV_ESRCH: -3, UV_ETIMEDOUT: -60, UV_ETXTBSY: -26, UV_EXDEV: -18,
  UV_UNKNOWN: -4094, UV_EOF: -4095, UV_ENXIO: -6, UV_EMLINK: -31, UV_EHOSTDOWN: -64, UV_EREMOTEIO: -4030,
  UV_ENOTTY: -25, UV_EFTYPE: -79, UV_EILSEQ: -92, UV_ESOCKTNOSUPPORT: -44, UV_ENODATA: -96, UV_EUNATCH: -4023,
  UV_ENOEXEC: -8
};
var UV_NAMES = Object.create(null);
Object.keys(UV_ERRNO).forEach(function (key) {
  UV_NAMES[UV_ERRNO[key]] = key.slice(3);
});
function uvErrname(code) {
  var at = Number(code);
  if (!Number.isInteger(at) || at >= 0) return 'UNKNOWN';
  return UV_NAMES[at] || 'UNKNOWN';
}
globalThis.__owcErrname = uvErrname;
function uvBinding() {
  var binding = { errname: uvErrname };
  Object.keys(UV_ERRNO).forEach(function (key) {
    binding[key] = UV_ERRNO[key];
  });
  return binding;
}
/*
 * Node-API add-ons. Native code cannot load here: an add-on file whose basename (NAPI_BINARIES) or owning
 * package (NAPI_PACKAGES) a guest/modules/napi-<shim>.ts module registered gets the exports of that
 * JavaScript shim, owc:internal/napi/<shim>. Any other file fails as glibc's dlopen fails on it.
 */
var NAPI_BINARIES = Object.create(null);
var NAPI_PACKAGES = Object.create(null);
/*
 * What a Node-API shim gets when the host builds it. A shim that only computes needs none of this;
 * one that persists, like leveldown, gets fs: byte-level operations over the virtual filesystem,
 * resolved against the guest's cwd, with no encodings, streams or descriptors. See
 * src/napi/leveldown/fs.ts for the contract each one keeps. Buffer is a getter because the standard
 * globals are still being defined while this runs.
 */
var NAPI_HOST = (function () {
  var path_ = requireBuiltin('path');
  function rp (p) {
    return path_.resolve(p);
  }
  function bytes (b) {
    return Buffer.from(b.buffer, b.byteOffset, b.length);
  }
  return {
    fs: {
      read: function (p) {
        try {
          return new Uint8Array(requireBuiltin('fs').readFileSync(rp(p)));
        } catch (readError) {
          return undefined;
        }
      },
      write: function (p, b) {
        requireBuiltin('fs').writeFileSync(rp(p), bytes(b));
      },
      append: function (p, b) {
        requireBuiltin('fs').appendFileSync(rp(p), bytes(b));
      },
      rename: function (from, to) {
        requireBuiltin('fs').renameSync(rp(from), rp(to));
      },
      unlink: function (p) {
        try {
          requireBuiltin('fs').unlinkSync(rp(p));
        } catch (unlinkError) {}
      },
      mkdir: function (p) {
        var fsm = requireBuiltin('fs');
        var at = '';
        // create each level in turn, so a missing parent is not an error
        for (var i = 0; i < rp(p).split('/').length; i++) {
          var part = rp(p).split('/')[i];
          if (part === '') continue;
          at = at + '/' + part;
          try {
            fsm.mkdirSync(at);
          } catch (mkdirError) {}
        }
      },
      rmdir: function (p) {
        try {
          requireBuiltin('fs').rmdirSync(rp(p));
        } catch (rmdirError) {}
      },
      readdir: function (p) {
        try {
          return requireBuiltin('fs').readdirSync(rp(p));
        } catch (readdirError) {
          return undefined;
        }
      },
      stat: function (p) {
        try {
          return requireBuiltin('fs').statSync(rp(p)).isDirectory() ? 'dir' : 'file';
        } catch (statError) {
          return undefined;
        }
      }
    },
    /*
     * The container's own child processes, for the node-pty shim: it starts a shell (an interactive
     * ShellProcess when it is given no arguments) or a node child and reads its output and exit,
     * which is the closest thing the container has to a session on a terminal. Only spawn is
     * exposed, and the module is looked up when it is called, so a process that never loads the
     * add-on never loads child_process.
     */
    child: {
      spawn: function (file, args, options) {
        return requireBuiltin('child_process').spawn(file, args, options);
      }
    }
  };
})();
Object.defineProperty(NAPI_HOST, 'Buffer', { get: function () { return Buffer; }, configurable: true });
function dlopenError(message) {
  var err = new Error(message);
  err.code = 'ERR_DLOPEN_FAILED';
  return err;
}
function napiShimOf(file) {
  var base = file.slice(file.lastIndexOf('/') + 1);
  if (Object.prototype.hasOwnProperty.call(NAPI_BINARIES, base)) return NAPI_BINARIES[base];
  var at = file.lastIndexOf('/node_modules/');
  if (at < 0) return undefined;
  var parts = file.slice(at + 14).split('/');
  var pkg = parts[0].charAt(0) === '@' ? parts[0] + '/' + parts[1] : parts[0];
  return Object.prototype.hasOwnProperty.call(NAPI_PACKAGES, pkg) ? NAPI_PACKAGES[pkg] : undefined;
}
function loadNapiAddon(name) {
  // a name without a slash is searched for in the library path, never the working directory
  var file = name.charAt(0) === '/' ? name : name.indexOf('/') >= 0 ? requireBuiltin('path').resolve(name) : '';
  var raw = file ? host.statJSON(file) : null;
  if (raw === null) throw dlopenError(name + ': cannot open shared object file: No such file or directory');
  var st = JSON.parse(raw);
  if (st.type === 'dir') throw dlopenError(name + ': cannot read file data: Is a directory');
  var shim = napiShimOf(file);
  if (shim !== undefined) return requireBuiltin('owc:internal/napi/' + shim).createAddon(NAPI_HOST);
  if (st.size < 64) throw dlopenError(name + ': file too short (this container runs no native code: an add-on is served by a JavaScript shim, registered in src/napi/registry.ts, and a placeholder left by the installer is shorter than any real object file)');
  var head = decodeBase64(host.readBase64(file));
  if (head[0] !== 0x7f || head[1] !== 0x45 || head[2] !== 0x4c || head[3] !== 0x46) throw dlopenError(name + ': invalid ELF header');
  /*
   * Nothing in the registry owns this file, which is the only reason a real object file fails here. Say
   * so, and say what the registry does hold: the message is the whole explanation a caller gets, since
   * the alternative is a dlopen that fails the way it fails on Linux and names nothing.
   */
  var base = file.slice(file.lastIndexOf('/') + 1);
  var registered = Object.keys(NAPI_PACKAGES).sort().join(', ');
  throw dlopenError("Module did not self-register: '" + name + "'. Native code cannot run in this container: process.dlopen serves an add-on from a JavaScript shim (owc:internal/napi/<shim>, registered in src/napi/registry.ts) when its basename is in NAPI_BINARIES or the package that owns it is in NAPI_PACKAGES, and '" + base + "' is in neither; registered packages: " + registered + '.');
}
proc.dlopen = function dlopen(module, filename, flags) {
  if (arguments.length < 2) {
    var missing = new TypeError('process.dlopen needs at least 2 arguments');
    missing.code = 'ERR_MISSING_ARGS';
    throw missing;
  }
  if (arguments.length > 2) {
    try {
      flags | 0;
    } catch (flagError) {
      var badFlags = new TypeError('flag argument must be an integer.');
      badFlags.code = 'ERR_INVALID_ARG_TYPE';
      throw badFlags;
    }
  }
  if (module === undefined || module === null || module.exports === undefined || module.exports === null) {
    throw new TypeError('Cannot convert undefined or null to object');
  }
  module.exports = loadNapiAddon(typeof filename === 'symbol' ? '' : String(filename));
};
proc.config = {};
proc.pid = host.pid();
proc.ppid = 0;
proc.argv = JSON.parse(host.argvJSON());
proc.execPath = '/usr/local/bin/node';
proc.execArgv = [];
proc.env = procEnv;
proc.exitCode = undefined;
proc.cwd = function () {
  return host.cwd();
};
  /*
   * process.chdir moves the process's working directory, as it does in Node: the host owns it, so
   * a relative path is resolved against the current one, and what comes back is '' or the error
   * code Node would report. Everything that resolves a relative path afterwards -- require, fs, a
   * spawned child -- reads the new directory.
   */
  proc.chdir = function (dir) {
    if (typeof dir !== 'string') {
      var bad = new TypeError('The "directory" argument must be of type string. Received ' + (dir === null ? 'null' : typeof dir));
      bad.code = 'ERR_INVALID_ARG_TYPE';
      throw bad;
    }
    var failure = host.chdir(dir);
    if (failure === '') return undefined;
    var error = new Error(failure + ': ' + (failure === 'ENOTDIR' ? 'not a directory' : 'no such file or directory') + ', chdir \'' + dir + '\'');
    error.code = failure;
    error.errno = failure === 'ENOTDIR' ? -20 : -2;
    error.syscall = 'chdir';
    error.path = dir;
    throw error;
  };
/*
 * The first process.exit decides the status, and nothing runs after it -- exactly as in Node. The
 * host keeps the first code it was asked to leave with; this guard keeps the guest's own record in
 * step with it, so a callback still queued behind the exit (a rejection handler, an exit listener
 * that exits again) cannot overwrite the status the process already left with.
 */
var exitedByCall = false;
proc.exit = function (code) {
  if (exitedByCall) throw EXIT_SIGNAL;
  exitedByCall = true;
  var fallback = typeof proc.exitCode === 'number' ? proc.exitCode : 0;
  var finalCode = code === undefined ? fallback : Number(code);
  proc.exitCode = finalCode;
  try {
    api.emitExit(finalCode);
  } catch (listenerError) {
    host.stderr(formatErrorStack(listenerError instanceof Error ? listenerError : new Error(String(listenerError))) + '\n');
  }
  host.exit(finalCode);
  throw EXIT_SIGNAL;
};
proc.nextTick = function (fn) {
  if (typeof fn !== 'function') throw new TypeError('The "callback" argument must be of type function');
  enqueueTick(bindToActiveDomain(fn), Array.prototype.slice.call(arguments, 1));
};
proc.hrtime = function (previous) {
  var nowNs = Math.round((host.now() - startedAt) * 1e6);
  var sec = Math.floor(nowNs / 1e9);
  var nano = nowNs % 1e9;
  if (previous) {
    var ds = sec - previous[0];
    var dn = nano - previous[1];
    if (dn < 0) {
      ds -= 1;
      dn += 1e9;
    }
    return [ds, dn];
  }
  return [sec, nano];
};
proc.hrtime.bigint = function () {
  return BigInt(Math.round((host.now() - startedAt) * 1e6));
};
proc.uptime = function () {
  return (host.now() - startedAt) / 1000;
};
proc.memoryUsage = function () {
  return { rss: 0, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 };
};
proc.cpuUsage = function () {
  return { user: 0, system: 0 };
};
/*
 * Signals a child of this process, as Node does with the pids it knows. The container has no
 * signals across processes: every name that ends a process ends it the same way (terminate), and
 * the name is only reported back as the signal the child died of.
 *
 * A process may always signal itself, and that is the one pid the child registry does not hold:
 * signal 0 only reports that the process is there, and any other ends it with the status Node
 * leaves (128 + the signal number), so a program that ends itself this way behaves as it does
 * under Node. Every other pid the container does not know is ESRCH, the error Node's kill gives
 * for a pid that is not there -- a container process's world is its own children, and a pid that
 * is not one of them is no more reachable here than a dead one is in Node.
 */
var LETHAL_SIGNALS = { SIGTERM: 15, SIGKILL: 9, SIGINT: 2, SIGHUP: 1, SIGQUIT: 3, SIGABRT: 6 };
proc.kill = function (pid, signal) {
  var name = signal === undefined || signal === null ? 'SIGTERM' : String(signal);
  var num = Number(pid);
  // Signal 0 is the null signal: it only asks whether the process is there, and never ends it.
  if (name === '0') {
    if (num === proc.pid) return true;
    if (callCap('child.kill', { pid: num, signal: '0' }) === true) return true;
    throw esrchFor(pid);
  }
  if (num === proc.pid) {
    proc.exit(128 + (LETHAL_SIGNALS[name] === undefined ? 15 : LETHAL_SIGNALS[name]));
    return true;
  }
  var table = globalThis.__owcPtyFds;
  var record = table ? table[num] : undefined;
  // An id of a pty stands for the child behind it: the container gives a child its pid after
  // spawn has returned, so a pty has no process id to report when it is built.
  var ok = record && record.child && record.child.pid !== undefined
    ? callCap('child.kill', { pid: Number(record.child.pid), signal: name })
    : callCap('child.kill', { pid: num, signal: name });
  if (ok === true) return true;
  throw esrchFor(pid);
};
function esrchFor(pid) {
  var missing = new Error('kill ESRCH');
  missing.code = 'ESRCH';
  missing.errno = -3;
  missing.syscall = 'kill';
  return missing;
}
proc.umask = function () {
  return 18;
};
proc.emitWarning = function (warning) {
  host.stderr('(node) Warning: ' + (warning && warning.message ? warning.message : String(warning)) + '\n');
};
function makeStdioStream(writeText) {
  var stream = Object.create(EventEmitterCls.prototype);
  EventEmitterCls.call(stream);
  /*
   * No terminal is attached, and a stream node has with no terminal behind it has *no* isTTY and
   * *no* columns: a host run with its output piped reports `undefined` for both, not false and 80.
   * The difference is observable -- `columns || 80` never falls back here, and a library that reads
   * `isTTY` to decide whether it is talking to a person is answered with a value that says it is
   * not rather than with nothing. Both are left off the stream, as a piped host leaves them off.
   */
  stream.write = function (chunk, encoding, callback) {
    writeText(typeof chunk === 'string' ? chunk : String(chunk));
    var done = typeof encoding === 'function' ? encoding : callback;
    if (typeof done === 'function') queueMicrotask(function () { done(); });
    return true;
  };
  stream.end = function (chunk) {
    if (chunk !== undefined && typeof chunk !== 'function') stream.write(chunk);
    return stream;
  };
  stream.cork = function () {};
  stream.uncork = function () {};
  stream.setEncoding = function () { return stream; };
  return stream;
}
proc.stdout = makeStdioStream(function (text) {
  host.stdout(text);
});
proc.stderr = makeStdioStream(function (text) {
  host.stderr(text);
});
/* stdin has no input source unless the host feeds one. A process started with a pipe on fd 0 keeps it
   open until the host ends it, so a parent's write reaches a reader there as it does in Node; every
   other run's stdin ends at once, so a reader sees end of input. A REPL is the run the terminal feeds:
   the host keeps its stdin open and pushes into it what the terminal sends. */
var stdinStream = null;
var stdinOpen = false;
var stdinHeld = false;
/** The whole input of a synchronous parent, fed the first time the stream is built: the built-ins are
 *  not there yet while this source runs, so nothing is pushed into a stream until something reads it. */
var stdinPending = null;
/* A reader holds a ref while it listens, the way Node's stdin keeps the loop alive while it is read:
   a child that reads its stdin waits for the parent, and one that stops reading no longer waits. */
function stdinRef() {
  var listening = stdinOpen && stdinStream !== null
    && (stdinStream.listenerCount('data') > 0 || stdinStream.listenerCount('readable') > 0 || stdinStream.readableFlowing === true);
  if (listening === stdinHeld) return;
  stdinHeld = listening;
  holdRef(listening ? 1 : -1);
}
function stdinOf() {
  if (stdinStream === null) {
    var Readable = requireBuiltin('stream').Readable;
    stdinStream = new Readable({ read: function () {} });
    // as on stdout: a stream with no terminal behind it reports neither isTTY nor columns
    // text in, text out: a pushed chunk reaches a reader as the string it was written as
    stdinStream.setEncoding('utf8');
    /* newListener is emitted before the listener is added, so the count is read on the next turn */
    stdinStream.on('newListener', function (ev) { if (ev === 'data' || ev === 'readable') setImmediate(stdinRef); });
    stdinStream.on('removeListener', function (ev) { if (ev === 'data' || ev === 'readable') setImmediate(stdinRef); });
    stdinStream.once('end', function () { stdinOpen = false; stdinRef(); });
    if (stdinPending !== null) {
      // a synchronous parent's input is all there from the start, and ends as soon as it is read
      var pending = stdinPending;
      stdinPending = null;
      stdinStream.push(pending);
      stdinStream.push(null);
    } else if (!stdinOpen) {
      stdinStream.push(null);
    } else {
      stdinRef();
    }
  }
  return stdinStream;
}
Object.defineProperty(proc, 'stdin', {
  configurable: true,
  get: function () {
    var input = stdinOf();
    Object.defineProperty(proc, 'stdin', { value: input, configurable: true, writable: true });
    return input;
  }
});
/* Keeps stdin open for a REPL: nothing has read it yet, so it can still be fed. */
api.openStdin = function () {
  stdinOpen = true;
  return stdinOf();
};
/* One chunk of terminal input, pushed into the stream a REPL reads. */
api.pushStdin = function (text) {
  if (!stdinOpen) return false;
  stdinOf().push(typeof text === 'string' ? text : String(text));
  return true;
};
/* End of terminal input: Ctrl-D, or a terminal that closed. The reader sees end of file. */
api.endStdin = function () {
  if (!stdinOpen) return false;
  stdinOpen = false;
  stdinOf().push(null);
  return true;
};
/* What this run was started with: a pipe on fd 0 the parent may still write to, and the whole input of
   a synchronous parent (spawnSync's 'input'). Both are taken out of the environment here, before any
   user code can see them; only the flags are set now, because the stream needs built-ins this source
   runs ahead of. */
if (procEnv.OWC_STDIN_INPUT !== undefined) {
  stdinPending = procEnv.OWC_STDIN_INPUT;
  delete procEnv.OWC_STDIN_INPUT;
}
if (procEnv.OWC_STDIN === 'pipe') {
  delete procEnv.OWC_STDIN;
  stdinOpen = true;
}
globalThis.process = proc;
BF.process = function () {
  return proc;
};
BF.console = function () {
  return consoleObj;
};

/* V8 stack trace API: CallSite-like objects built from the engine's stack text, handed to Error.prepareStackTrace */
function makeCallSite(text) {
  var parsed = /^\s*at (.*?) \((.*)\)\s*$/.exec(text);
  var fnName = parsed ? parsed[1] : null;
  var location = parsed ? parsed[2] : text.replace(/^\s*at\s+/, '');
  var where = /^(.*?):(\d+)(?::(\d+))?$/.exec(location);
  var fileName = where ? where[1] : location;
  var lineNumber = where ? parseInt(where[2], 10) : null;
  var columnNumber = where && where[3] ? parseInt(where[3], 10) : null;
  var anonymous = fnName === null || fnName === '<anonymous>';
  return {
    getThis: function () { return undefined; },
    getTypeName: function () { return null; },
    getFunction: function () { return undefined; },
    getFunctionName: function () { return anonymous ? null : fnName; },
    getMethodName: function () { return null; },
    getFileName: function () { return fileName === '<input>' ? undefined : fileName; },
    getLineNumber: function () { return lineNumber; },
    getColumnNumber: function () { return columnNumber; },
    getEvalOrigin: function () { return undefined; },
    getScriptNameOrSourceURL: function () { return fileName === '<input>' ? undefined : fileName; },
    isToplevel: function () { return anonymous; },
    isEval: function () { return false; },
    isNative: function () { return location === 'native'; },
    isConstructor: function () { return false; },
    isAsync: function () { return false; },
    isPromiseAll: function () { return false; },
    getPromiseIndex: function () { return null; },
    toString: function () { return text.replace(/^\s*at\s+/, ''); }
  };
}

if (!Error.captureStackTrace) {
  Error.captureStackTrace = function (target) {
    if (!target || typeof target !== 'object') return;
    var frames = String(new Error('').stack || '').split('\n').slice(1);
    if (typeof Error.prepareStackTrace === 'function') {
      target.stack = Error.prepareStackTrace(target, frames.map(makeCallSite));
      return;
    }
    var header = String(target.name || 'Error') + (target.message ? ': ' + target.message : '');
    target.stack = frames.length ? header + '\n' + frames.join('\n') : header;
  };
}
if (Error.stackTraceLimit === undefined) Error.stackTraceLimit = 10;

var groupIndent = '';
var counters = Object.create(null);
var timeLabels = Object.create(null);

function writeConsole(text, toStderr) {
  var lines = groupIndent ? text.split('\n').map(function (l) { return groupIndent + l; }).join('\n') : text;
  if (toStderr) host.stderr(lines + '\n');
  else host.stdout(lines + '\n');
}

var consoleObj = {
  log: function () { writeConsole(formatLogArgs(arguments), false); },
  info: function () { writeConsole(formatLogArgs(arguments), false); },
  debug: function () { writeConsole(formatLogArgs(arguments), false); },
  warn: function () { writeConsole(formatLogArgs(arguments), true); },
  error: function () { writeConsole(formatLogArgs(arguments), true); },
  trace: function () {
    var message = formatLogArgs(arguments);
    writeConsole('Trace' + (message ? ': ' + message : ''), true);
  },
  dir: function (value, opts) { writeConsole(inspectValue(value, opts), false); },
  table: function (value) { writeConsole(inspectValue(value), false); },
  assert: function (condition) {
    if (condition) return;
    var rest = Array.prototype.slice.call(arguments, 1);
    writeConsole('Assertion failed' + (rest.length ? ': ' + formatLogArgs(rest) : ''), true);
  },
  count: function (label) {
    var name = label === undefined ? 'default' : String(label);
    counters[name] = (counters[name] || 0) + 1;
    writeConsole(name + ': ' + counters[name], false);
  },
  countReset: function (label) {
    delete counters[label === undefined ? 'default' : String(label)];
  },
  time: function (label) {
    timeLabels[label === undefined ? 'default' : String(label)] = host.now();
  },
  timeLog: function (label) {
    var name = label === undefined ? 'default' : String(label);
    if (timeLabels[name] === undefined) return;
    writeConsole(name + ': ' + (host.now() - timeLabels[name]).toFixed(3) + 'ms', false);
  },
  timeEnd: function (label) {
    var name = label === undefined ? 'default' : String(label);
    if (timeLabels[name] === undefined) return;
    writeConsole(name + ': ' + (host.now() - timeLabels[name]).toFixed(3) + 'ms', false);
    delete timeLabels[name];
  },
  group: function () {
    if (arguments.length) writeConsole(formatLogArgs(arguments), false);
    groupIndent += '  ';
  },
  groupEnd: function () {
    groupIndent = groupIndent.slice(2);
  }
};
consoleObj.groupCollapsed = consoleObj.group;
globalThis.console = consoleObj;

/*
 * The URL global -- and the URL the url module hands out, since in Node the two are one class.
 * What this parser adds to the url module's own is the normalisation Node does: a path is
 * percent-encoded, a tab or newline inside the input is dropped rather than kept, an IPv6 literal
 * in brackets is one host instead of a stray bracket and a path behind it, a query or fragment
 * that carries no value still shows in href, and a special scheme written without its two slashes
 * still has an authority. State lives in a WeakMap, so a URL carries no own properties of its own,
 * as in Node, and every field is a prototype accessor: a caller that assigns one -- the WebSocket
 * client rewrites the scheme and the path of the URL it parsed -- sets what href reads back.
 */
function urlGlobalOf(nodeUrl) {
  var Base = nodeUrl.URL;
  var URLSearchParams = nodeUrl.URLSearchParams;
  var STATE = new WeakMap();
  var DEFAULT_PORTS = { 'http:': '80', 'https:': '443', 'ws:': '80', 'wss:': '443', 'ftp:': '21', 'file:': '' };
  var SCHEME_RE = /^([A-Za-z][A-Za-z0-9+.\-]*):/;
  /* The path percent-encode set: C0 controls, space, '"', '#', '<', '>', '?', '{', '}', DEL and a
     backtick -- spelled as a code point because this source is itself a template literal. */
  var PATH_ENCODE_CHARS = '"#<>?^' + String.fromCharCode(96) + '{}';
  function percentEncode(ch, code) {
    return code <= 0x20 || code === 0x7f || PATH_ENCODE_CHARS.indexOf(ch) >= 0;
  }

  function invalidUrl(input) {
    var err = new TypeError('Invalid URL');
    err.code = 'ERR_INVALID_URL';
    err.input = input;
    return err;
  }

  /* WHATWG: leading and trailing C0 controls and spaces go, and every tab, line feed and carriage
     return inside the string is removed before anything else reads it. */
  function cleaned(text) {
    var stripped = String(text).replace(/[\t\n\r]/g, '');
    var start = 0;
    var end = stripped.length;
    while (start < end && stripped.charCodeAt(start) <= 0x20) start++;
    while (end > start && stripped.charCodeAt(end - 1) <= 0x20) end--;
    return stripped.slice(start, end);
  }

  /* The path percent-encode set, and the escape it is written as. An escape already in the path is
     left as it stands, so what the caller encoded survives. */
  function encodePath(text) {
    var out = '';
    for (var i = 0; i < text.length; i++) {
      var ch = text.charAt(i);
      out += percentEncode(ch, text.charCodeAt(i)) ? encodeURIComponent(ch) : ch;
    }
    return out;
  }

  /* RFC 3986 5.2.4: '.' and '..' segments are resolved out, and a percent-encoded dot segment
     counts as one, the way the url module's own parser reads it. */
  function removeDotSegments(pathname) {
    if (pathname.charAt(0) !== '/') return pathname;
    var segments = pathname.split('/');
    var out = [''];
    var trailing = false;
    for (var i = 1; i < segments.length; i++) {
      var segment = segments[i];
      var decoded = segment;
      try { decoded = decodeURIComponent(segment); } catch (err) { /* an invalid escape is itself */ }
      if (decoded === '.') { trailing = true; continue; }
      if (decoded === '..') { if (out.length > 1) out.pop(); trailing = true; continue; }
      if (segment === '' && i === segments.length - 1) { trailing = true; continue; }
      trailing = false;
      out.push(segment);
    }
    var resolved = out.join('/');
    if (trailing && resolved.charAt(resolved.length - 1) !== '/') resolved += '/';
    return resolved === '' ? '/' : resolved;
  }

  function portOf(text, raw) {
    if (text === '') return '';
    if (!/^[0-9]+$/.test(text)) throw invalidUrl(raw);
    var digits = text.replace(/^0+/, '');
    if (digits === '') digits = '0';
    if (Number(digits) > 65535) throw invalidUrl(raw);
    return digits;
  }

  /* The query as it is serialised: the searchParams the caller was handed once it has been changed,
     and otherwise the query the parser read -- which is the empty string, not nothing, for a '?'
     that carries no name. */
  function queryPartOf(state) {
    if (state.dirty) {
      var written = state.sp.toString();
      return written === '' ? '' : '?' + written;
    }
    return state.query === null ? '' : '?' + state.query;
  }

  /* A reference resolved against a base: the pieces of the base it keeps, the same way the url
     module resolves one, rewritten here against the parser's own state. */
  function referenceAgainst(base, rel) {
    var prefix = base.protocol +
      (base.hasHost || base.protocol === 'file:' ? '//' + base.hostname + (base.port ? ':' + base.port : '') : '');
    var search = base.query === null ? '' : '?' + base.query;
    var fragment = base.hash === null ? '' : '#' + base.hash;
    if (rel.slice(0, 2) === '//') return base.protocol + rel;
    if (rel === '') return prefix + base.pathname + search + fragment;
    if (rel.charAt(0) === '/') return prefix + rel;
    if (rel.charAt(0) === '?') return prefix + base.pathname + rel;
    if (rel.charAt(0) === '#') return prefix + base.pathname + search + rel;
    /* a base path that ends in '/' names a directory, so the reference goes inside it; only
       otherwise is the last segment the file it replaces */
    var cut = base.pathname.lastIndexOf('/');
    var dir = cut >= 0 ? base.pathname.slice(0, cut + 1) : (base.hasHost ? '/' : '');
    return prefix + dir + rel;
  }

  function parseUrl(input, base, raw) {
    var text = cleaned(input);
    var scheme = SCHEME_RE.exec(text);
    if (scheme === null) {
      if (base === null || base === undefined) throw invalidUrl(raw);
      text = referenceAgainst(base, text);
      scheme = SCHEME_RE.exec(text);
      if (scheme === null) throw invalidUrl(raw);
    }
    var protocol = scheme[1].toLowerCase() + ':';
    var special = Object.prototype.hasOwnProperty.call(DEFAULT_PORTS, protocol);
    var rest = text.slice(scheme[0].length);
    var state = {
      protocol: protocol, username: '', password: '', hostname: '', port: '', pathname: '',
      query: null, hash: null, hasHost: false, dirty: false, sp: undefined
    };
    /* A special scheme has an authority whether the caller wrote the two slashes or not -- and a
       backslash counts as one of them, as it does everywhere else in a special URL. Anything else
       has one only where '//' was written. */
    var hasHost = false;
    if (special) {
      var slashes = 0;
      while (slashes < 2 && rest.length > 0 && (rest.charAt(0) === '/' || rest.charAt(0) === '\\')) {
        rest = rest.slice(1);
        slashes++;
      }
      hasHost = true;
    } else if (rest.slice(0, 2) === '//') {
      hasHost = true;
      rest = rest.slice(2);
    }
    if (hasHost) {
      var stop = rest.length;
      for (var i = 0; i < rest.length; i++) {
        var ch = rest.charAt(i);
        if (ch === '/' || ch === '?' || ch === '#' || (special && ch === '\\')) { stop = i; break; }
      }
      var authority = rest.slice(0, stop);
      rest = rest.slice(stop);
      var at = authority.lastIndexOf('@');
      var hostport = authority;
      if (at >= 0) {
        var userinfo = authority.slice(0, at);
        hostport = authority.slice(at + 1);
        var colon = userinfo.indexOf(':');
        state.username = colon >= 0 ? userinfo.slice(0, colon) : userinfo;
        state.password = colon >= 0 ? userinfo.slice(colon + 1) : '';
      }
      if (hostport.charAt(0) === '[') {
        /* an IPv6 literal is one host, brackets and all: the ':' inside it is not a port */
        var close = hostport.indexOf(']');
        if (close < 0) throw invalidUrl(raw);
        state.hostname = '[' + hostport.slice(1, close).toLowerCase() + ']';
        var after = hostport.slice(close + 1);
        if (after !== '') {
          if (after.charAt(0) !== ':') throw invalidUrl(raw);
          state.port = portOf(after.slice(1), raw);
        }
      } else {
        var portAt = hostport.indexOf(':');
        state.hostname = (portAt >= 0 ? hostport.slice(0, portAt) : hostport).toLowerCase();
        if (portAt >= 0) state.port = portOf(hostport.slice(portAt + 1), raw);
      }
      state.hasHost = true;
      /* a special scheme that names no host is no URL at all -- except file:, which has none */
      if (special && state.hostname === '' && protocol !== 'file:') throw invalidUrl(raw);
      if (state.port !== '' && DEFAULT_PORTS[protocol] === state.port) state.port = '';
    }
    var hashAt = rest.indexOf('#');
    if (hashAt >= 0) { state.hash = rest.slice(hashAt + 1); rest = rest.slice(0, hashAt); }
    var queryAt = rest.indexOf('?');
    if (queryAt >= 0) { state.query = rest.slice(queryAt + 1); rest = rest.slice(0, queryAt); }
    var path = special ? rest.replace(/\\/g, '/') : rest;
    if (path === '') path = special ? '/' : '';
    else if (hasHost && path.charAt(0) !== '/') path = '/' + path;
    state.pathname = encodePath(removeDotSegments(path));
    return state;
  }

  /* The parsed state of whatever a caller passed as the base: another URL's own, or one read from
     a string -- including a URL the url module's parser built, which carries no state of ours. */
  function stateOf(value) {
    if (value === null || value === undefined) return null;
    var own = STATE.get(value);
    if (own !== undefined) return own;
    if (typeof value === 'object' && typeof value.href === 'string') return parseUrl(value.href, null, value.href);
    return parseUrl(value, null, String(value));
  }

  function field(name, get, set) {
    Object.defineProperty(URL.prototype, name, { get: get, set: set, enumerable: true, configurable: true });
  }

  function URL(input, base) {
    if (!(this instanceof URL)) throw new TypeError("Class constructor URL cannot be invoked without 'new'");
    if (arguments.length < 1) throw new TypeError('The "url" argument must be specified');
    if (typeof input === 'symbol') throw new TypeError('Cannot convert a Symbol value to a string');
    STATE.set(this, parseUrl(input, stateOf(base), String(input)));
  }
  URL.prototype = Object.create(Base.prototype);
  Object.defineProperty(URL.prototype, 'constructor', { value: URL, writable: true, configurable: true });

  field('protocol', function () {
    return STATE.get(this).protocol;
  }, function (value) {
    var text = String(value);
    STATE.get(this).protocol = (text.charAt(text.length - 1) === ':' ? text : text + ':').toLowerCase();
  });
  field('username', function () {
    return STATE.get(this).username;
  }, function (value) { STATE.get(this).username = String(value); });
  field('password', function () {
    return STATE.get(this).password;
  }, function (value) { STATE.get(this).password = String(value); });
  field('hostname', function () {
    return STATE.get(this).hostname;
  }, function (value) { STATE.get(this).hostname = String(value).toLowerCase(); });
  /* WHATWG: a port that is the scheme's own is not a port at all, so writing it leaves the port
     empty -- http://h/ with port 80 written is still http://h/. */
  function assignedPort(state, text, raw) {
    var port = text === '' ? '' : portOf(text, raw);
    return port !== '' && DEFAULT_PORTS[state.protocol] === port ? '' : port;
  }

  field('port', function () {
    return STATE.get(this).port;
  }, function (value) {
    var state = STATE.get(this);
    var text = String(value);
    state.port = assignedPort(state, text, state.protocol + '//' + state.hostname);
  });
  field('host', function () {
    var state = STATE.get(this);
    return state.hostname + (state.port ? ':' + state.port : '');
  }, function (value) {
    var state = STATE.get(this);
    var text = String(value);
    var at = text.indexOf(':');
    state.hostname = (at >= 0 ? text.slice(0, at) : text).toLowerCase();
    state.port = at >= 0 ? assignedPort(state, text.slice(at + 1), text) : '';
  });
  field('pathname', function () {
    return STATE.get(this).pathname;
  }, function (value) {
    var state = STATE.get(this);
    var text = String(value);
    state.pathname = encodePath(removeDotSegments(state.hasHost && text.charAt(0) !== '/' ? '/' + text : text));
  });
  field('search', function () {
    var state = STATE.get(this);
    if (state.dirty) {
      var written = state.sp.toString();
      return written === '' ? '' : '?' + written;
    }
    return state.query === null || state.query === '' ? '' : '?' + state.query;
  }, function (value) {
    var state = STATE.get(this);
    var text = String(value);
    state.query = text === '' ? null : (text.charAt(0) === '?' ? text.slice(1) : text);
    state.dirty = false;
    state.sp = undefined;
  });
  field('hash', function () {
    var state = STATE.get(this);
    return state.hash === null || state.hash === '' ? '' : '#' + state.hash;
  }, function (value) {
    var state = STATE.get(this);
    var text = String(value);
    state.hash = text === '' ? null : (text.charAt(0) === '#' ? text.slice(1) : text);
  });
  /* WHATWG: only a scheme with a host of its own has an origin -- an opaque host, and file:, have
     the opaque origin 'null' -- except blob:, whose origin is the origin of the URL in its path. */
  field('origin', function () {
    var state = STATE.get(this);
    if (state.protocol === 'blob:') {
      try { return new URL(state.pathname).origin; } catch (notAUrl) { return 'null'; }
    }
    if (state.protocol === 'file:' || !DEFAULT_PORTS.hasOwnProperty(state.protocol) || !state.hasHost) return 'null';
    return state.protocol + '//' + state.hostname + (state.port ? ':' + state.port : '');
  }, undefined);
  field('href', function () {
    var state = STATE.get(this);
    var authority = '';
    if (state.hasHost || state.protocol === 'file:') {
      var userinfo = (state.username || state.password)
        ? state.username + (state.password ? ':' + state.password : '') + '@'
        : '';
      authority = '//' + userinfo + state.hostname + (state.port ? ':' + state.port : '');
    }
    return state.protocol + authority + state.pathname + queryPartOf(state) +
      (state.hash === null ? '' : '#' + state.hash);
  }, function (value) {
    var state = STATE.get(this);
    var made = parseUrl(value, null, String(value));
    for (var key in made) state[key] = made[key];
  });
  /* The params of the query, kept: a caller that changes them changes href, as in Node, so the
     mutators mark the state dirty and the serialiser reads them back rather than the raw query. */
  Object.defineProperty(URL.prototype, 'searchParams', {
    get: function () {
      var state = STATE.get(this);
      if (state.sp !== undefined) return state.sp;
      var sp = new URLSearchParams(state.query === null ? '' : state.query);
      var proto = URLSearchParams.prototype;
      ['append', 'set', 'delete', 'sort'].forEach(function (name) {
        Object.defineProperty(sp, name, {
          value: function () {
            state.dirty = true;
            return proto[name].apply(sp, arguments);
          },
          writable: true, configurable: true
        });
      });
      state.sp = sp;
      return sp;
    },
    enumerable: true, configurable: true
  });
  URL.prototype.toString = function () { return this.href; };
  URL.prototype.toJSON = function () { return this.href; };
  /* Node's order on the prototype: toString first, then the fields in the order it declares them,
     and toJSON last. Deleting and re-adding is what rewrites that order. */
  ['toString', 'href', 'origin', 'protocol', 'username', 'password', 'host', 'hostname', 'port',
   'pathname', 'search', 'searchParams', 'hash', 'toJSON'].forEach(function (name) {
    var desc = Object.getOwnPropertyDescriptor(URL.prototype, name);
    if (desc === undefined) return;
    delete URL.prototype[name];
    Object.defineProperty(URL.prototype, name, desc);
  });
  /* What Node prints: the same fields in the same order, each value written by util.inspect. */
  var URL_INSPECT = typeof Symbol.for === 'function' ? Symbol.for('nodejs.util.inspect.custom') : undefined;
  if (URL_INSPECT !== undefined) {
    Object.defineProperty(URL.prototype, URL_INSPECT, {
      value: function (depth, options, inspect) {
        var self = this;
        var pairs = [['href', self.href], ['origin', self.origin], ['protocol', self.protocol],
          ['username', self.username], ['password', self.password], ['host', self.host],
          ['hostname', self.hostname], ['port', self.port], ['pathname', self.pathname],
          ['search', self.search], ['searchParams', self.searchParams], ['hash', self.hash]];
        var body = '';
        for (var i = 0; i < pairs.length; i++) {
          body += (i === 0 ? '' : ',\n  ') + pairs[i][0] + ': ' + inspect(pairs[i][1]);
        }
        return 'URL {\n  ' + body + '\n}';
      },
      writable: true, configurable: true
    });
  }
  Object.defineProperty(URL.prototype, Symbol.toStringTag, { value: 'URL', configurable: true });
  URL.canParse = function (input, base) {
    try {
      new URL(input, base);
      return true;
    } catch (err) {
      return false;
    }
  };
  /* require('url').URL and the global are one class in Node, so the module is handed this one too */
  nodeUrl.URL = URL;
  /* Node's URL takes one argument as far as URL.length is concerned: the base is optional. */
  Object.defineProperty(URL, 'length', { value: 1, configurable: true });
  return URL;
}

var nodeUrl = requireBuiltin('url');
var nodeUtil = requireBuiltin('util');
var nodeBuffer = requireBuiltin('buffer');
var nodeCrypto = requireBuiltin('crypto');
globalThis.global = globalThis;
globalThis.Buffer = nodeBuffer.Buffer;
/* Node's Buffer[Symbol.species] is its pooled view class (FastBuffer). ws reads it at load and calls new on it in its frame parser; the engine build leaves it undefined, so it is supplied here with the same shape: a Uint8Array view whose prototype is Buffer.prototype. */
(function () {
  function FastBuffer(bufferOrLength, byteOffset, length) {
    return Reflect.construct(Uint8Array, arguments, Buffer);
  }
  Object.defineProperty(Buffer, Symbol.species, { get: function () { return FastBuffer; }, configurable: true });
})();
globalThis.setTimeout = setTimeoutImpl;
globalThis.clearTimeout = clearTimer;
globalThis.setInterval = setIntervalImpl;
globalThis.clearInterval = clearTimer;
globalThis.setImmediate = setImmediateImpl;
globalThis.clearImmediate = clearTimer;
globalThis.queueMicrotask = queueMicrotaskImpl;
globalThis.TextEncoder = nodeUtil.TextEncoder;
globalThis.TextDecoder = nodeUtil.TextDecoder;
globalThis.Blob = requireBuiltin('buffer').Blob;
globalThis.File = (function () {
  class File extends globalThis.Blob {
    constructor(bits, name, options) {
      super(bits, options);
      if (arguments.length < 2) throw new TypeError('The "fileName" argument must be specified');
      this.name = String(name);
      this.lastModified = options && options.lastModified !== undefined ? Number(options.lastModified) : Date.now();
    }
  }
  Object.defineProperty(File.prototype, Symbol.toStringTag, { value: 'File', configurable: true });
  return File;
})();
globalThis.URL = typeof nodeUrl.URL === 'function' ? urlGlobalOf(nodeUrl) : nodeUrl.URL;
globalThis.URLSearchParams = nodeUrl.URLSearchParams;
globalThis.atob = function (input) {
  return decodeBytes(decodeBase64(String(input)), 'latin1');
};
globalThis.btoa = function (input) {
  return encodeBase64(encodeString(String(input), 'latin1'));
};
globalThis.performance = {
  timeOrigin: Date.now() - (host.now() - startedAt),
  now: function () { return host.now() - startedAt; }
};
globalThis.structuredClone = function (value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
};
globalThis.crypto = nodeCrypto.webcrypto;
/*
 * fetch, with the three classes Node also defines beside it (Headers, Request, Response). The
 * request goes out on the container's own http and https client, so a URL on the virtual network
 * reaches the server that listens there and a host the container has no route to fails the way a
 * real socket would; there is no host network behind it. A rejection is Node's shape: a TypeError
 * 'fetch failed' carrying the transport error as its cause, so err.cause.code is ENOTFOUND or
 * ECONNREFUSED as it is in Node.
 */
(function () {
  /*
   * Resolved on first use rather than here: the module registers itself further down the
   * bootstrap than this file runs, so asking for it now would leave every name below
   * undefined and take the whole bootstrap down with it.
   */
  var webFetch = null;
  function undici () {
    if (webFetch === null) webFetch = requireBuiltin('undici');
    return webFetch;
  }
  globalThis.fetch = function fetch(target, options) {
    var signal = (options && options.signal) || (target && target.signal);
    return undici().fetch(target, options).then(null, function (cause) {
      /* An abort is not a transport failure: Node rejects with the signal's own reason, a
         DOMException AbortError or TimeoutError, and never wraps it in 'fetch failed'. */
      if (signal && signal.aborted) throw signal.reason !== undefined ? signal.reason : cause;
      /* a Request that cannot be used is the caller's error, not a transport failure */
      if (cause && cause.owcNotTransport) throw cause;
      var failed = new TypeError('fetch failed');
      failed.cause = cause;
      throw failed;
    });
  };
  /* Node declares fetch's second argument with a default, so the function it hands out takes one
     argument as far as fetch.length is concerned. */
  Object.defineProperty(globalThis.fetch, 'length', { value: 1, configurable: true });
  ['Headers', 'Request', 'Response', 'FormData', 'WebSocket'].forEach(function (name) {
    Object.defineProperty(globalThis, name, {
      get: function () { return undici()[name]; },
      // an assignment replaces the lazy getter with the value, so a package that installs its own
      // class under one of these names still finds what it put there
      set: function (value) {
        Object.defineProperty(globalThis, name, { value: value, writable: true, configurable: true });
      },
      configurable: true
    });
  });
})();
(function () {
  var STATE = new WeakMap();
  var CONTROLLER_SIGNAL = new WeakMap();
  function AbortSignal() {
    throw new TypeError('Illegal constructor');
  }
  Object.defineProperty(AbortSignal.prototype, 'aborted', {
    get: function () { return STATE.get(this).aborted; },
    configurable: true
  });
  Object.defineProperty(AbortSignal.prototype, 'reason', {
    get: function () { return STATE.get(this).reason; },
    configurable: true
  });
  Object.defineProperty(AbortSignal.prototype, Symbol.toStringTag, { value: 'AbortSignal', configurable: true });
  /* What Node prints for a signal: whether it has been aborted, and nothing else. */
  var ABORT_INSPECT = typeof Symbol.for === 'function' ? Symbol.for('nodejs.util.inspect.custom') : undefined;
  if (ABORT_INSPECT !== undefined) {
    Object.defineProperty(AbortSignal.prototype, ABORT_INSPECT, {
      value: function () { return 'AbortSignal { aborted: ' + this.aborted + ' }'; },
      writable: true, configurable: true
    });
  }
  AbortSignal.prototype.addEventListener = function addEventListener(type, fn) {
    if (type === 'abort') STATE.get(this).listeners.push(fn);
  };
  AbortSignal.prototype.removeEventListener = function removeEventListener(type, fn) {
    var st = STATE.get(this);
    st.listeners = st.listeners.filter(function (l) { return l !== fn; });
  };
  AbortSignal.prototype.throwIfAborted = function throwIfAborted() {
    var st = STATE.get(this);
    if (st.aborted) throw st.reason;
  };
  function createSignal() {
    var signal = Object.create(AbortSignal.prototype);
    STATE.set(signal, { aborted: false, reason: undefined, listeners: [] });
    return signal;
  }
  function abortSignal(signal, reason) {
    var st = STATE.get(signal);
    if (st.aborted) return;
    st.aborted = true;
    if (reason === undefined) {
      // Node's default reason: a DOMException AbortError, code 20 (ABORT_ERR)
      reason = new DOMException('This operation was aborted', 'AbortError');
    }
    st.reason = reason;
    var listeners = st.listeners;
    st.listeners = [];
    listeners.forEach(function (fn) { fn({ type: 'abort' }); });
  }
  AbortSignal.abort = function abort(reason) {
    var signal = createSignal();
    abortSignal(signal, reason);
    return signal;
  };
  /*
   * How Node writes the value an ERR_OUT_OF_RANGE carries: an integer past 2**32 is printed with
   * numeric separators (1_099_511_627_776), and anything else -- a fraction, NaN, Infinity, a number
   * small enough to sit inside 32 bits -- the way String() writes it.
   */
  function outOfRangeText(value) {
    if (Number.isInteger(value) && Math.abs(value) > 4294967296) {
      var text = String(value);
      var at = text.length;
      var start = text.charCodeAt(0) === 45 ? 1 : 0;
      var grouped = '';
      while (at > start + 3) {
        at -= 3;
        grouped = '_' + text.slice(at, at + 3) + grouped;
      }
      return text.slice(0, at) + grouped;
    }
    return String(value);
  }
  function delayOutOfRange(value, range) {
    var bad = new RangeError('The value of "delay" is out of range. It must be ' + range + '. Received ' + outOfRangeText(value));
    bad.code = 'ERR_OUT_OF_RANGE';
    return bad;
  }
  function delayNotANumber(value) {
    var kind = value === null ? 'Received null'
      : value === undefined ? 'Received undefined'
        : typeof value === 'string' ? "Received type string ('" + value + "')"
          : 'Received type ' + typeof value;
    var bad = new TypeError('The "delay" argument must be of type number. ' + kind);
    bad.code = 'ERR_INVALID_ARG_TYPE';
    return bad;
  }
  /* Node checks a timeout against the same bounds it checks any uint32 against, and refuses it
     before anything is scheduled: not an integer is one error, outside 0..2**32-1 another. */
  AbortSignal.timeout = function timeout(ms) {
    if (typeof ms !== 'number') throw delayNotANumber(ms);
    if (!Number.isInteger(ms)) throw delayOutOfRange(ms, 'an integer');
    if (ms < 0 || ms > 4294967295) throw delayOutOfRange(ms, '>= 0 && <= 4294967295');
    var signal = createSignal();
    setTimeout(function () {
      var reason = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      abortSignal(signal, reason);
    }, ms);
    return signal;
  };
  AbortSignal.any = function any(signals) {
    var signal = createSignal();
    Array.prototype.forEach.call(signals, function (source) {
      source.addEventListener('abort', function () { abortSignal(signal, source.reason); });
    });
    return signal;
  };
  function AbortController() {
    CONTROLLER_SIGNAL.set(this, createSignal());
  }
  Object.defineProperty(AbortController.prototype, 'signal', {
    get: function () { return CONTROLLER_SIGNAL.get(this); },
    configurable: true
  });
  AbortController.prototype.abort = function abort(reason) {
    abortSignal(CONTROLLER_SIGNAL.get(this), reason);
  };
  globalThis.AbortSignal = AbortSignal;
  globalThis.AbortController = AbortController;
  /*
   * CloseEvent, which Node delivers to a WebSocket's close handler: code, reason and wasClean, and
   * the socket it happened to. The engine has no such class, so a close would otherwise arrive as a
   * plain object, so an "event instanceof CloseEvent" check -- the one a program makes to tell a
   * real close from a hand-built one -- would be false. The attributes sit on a prototype backed by
   * the values of the one event, the way Node's own events keep theirs on a prototype backed by
   * internal slots: that also makes it an Event, and leaves no attribute an own property.
   */
  globalThis.CloseEvent = (function () {
    function CloseEvent(type, init) {
      init = init || {};
      var values = {
        type: String(type === undefined ? 'close' : type),
        code: init.code === undefined ? 0 : Number(init.code),
        reason: init.reason === undefined ? '' : String(init.reason),
        wasClean: init.wasClean === undefined ? false : !!init.wasClean,
        target: init.target === undefined ? null : init.target,
        currentTarget: null,
        bubbles: false,
        cancelable: false,
        defaultPrevented: false,
        timeStamp: 0
      };
      /*
       * Node's own Event is installed further down the bootstrap than this file runs, so the
       * parent is joined on first use rather than here, or a close event would not be an Event.
       */
      var Base = typeof globalThis.Event === 'function' ? globalThis.Event.prototype : Object.prototype;
      if (Object.getPrototypeOf(CloseEvent.prototype) !== Base) Object.setPrototypeOf(CloseEvent.prototype, Base);
      var proto = Object.create(CloseEvent.prototype);
      Object.keys(values).forEach(function (key) {
        Object.defineProperty(proto, key, { get: function () { return values[key]; }, configurable: true });
      });
      return Object.create(proto);
    }
    CloseEvent.prototype = Object.create(Object.prototype);
    Object.defineProperty(CloseEvent.prototype, 'constructor', { value: CloseEvent, writable: true, configurable: true });
    CloseEvent.prototype.preventDefault = function () {};
    CloseEvent.prototype.stopPropagation = function () {};
    Object.defineProperty(CloseEvent.prototype, Symbol.toStringTag, { value: 'CloseEvent', configurable: true });
    return CloseEvent;
  })();
})();

/* Legacy RegExp statics: RegExp.$1-$9, input, lastMatch, lastParen, leftContext, rightContext. V8 keeps them from the last successful exec or test, and showdown reads RegExp.$1 right after RegExp.prototype.test. The engine build has none, so exec and test record the match here. */
(function () {
  var nativeExec = RegExp.prototype.exec;
  var last = null;
  function group(index) {
    if (last === null) return '';
    var value = last[index];
    return value === undefined ? '' : value;
  }
  function subject() {
    return last === null ? '' : last.input;
  }
  function before() {
    return last === null ? '' : last.input.slice(0, last.index);
  }
  function after() {
    return last === null ? '' : last.input.slice(last.index + last[0].length);
  }
  function lastGroup() {
    return last === null || last.length < 2 ? '' : group(last.length - 1);
  }
  function define(name, read) {
    Object.defineProperty(RegExp, name, { get: read, set: function () {}, enumerable: false, configurable: true });
  }
  RegExp.prototype.exec = function exec(string) {
    var match = nativeExec.call(this, string);
    if (match !== null) last = match;
    return match;
  };
  RegExp.prototype.test = function test(string) {
    return this.exec(string) !== null;
  };
  for (var n = 1; n <= 9; n++) {
    (function (index) {
      define('$' + index, function () { return group(index); });
    })(n);
  }
  define('input', subject);
  define('$_', subject);
  define('lastMatch', function () { return group(0); });
  define('$&', function () { return group(0); });
  define('lastParen', lastGroup);
  define('$+', lastGroup);
  define('leftContext', before);
  define('$' + String.fromCharCode(96), before);
  define('rightContext', after);
  define("$'", after);
})();

api.finalExitCode = function () {
  var code = proc.exitCode;
  return typeof code === 'number' ? code : 0;
};
var exitEmitted = false;
api.emitExit = function (code) {
  if (exitEmitted) return;
  exitEmitted = true;
  proc.emit('exit', code);
};
api.formatUncaught = function (err) {
  if (err instanceof Error) return formatErrorStack(err);
  return inspectValue(err);
};
api.isExitSignal = function (value) {
  return value === EXIT_SIGNAL;
};
api.setArgv = function (argv) {
  proc.argv = argv;
};
`;
