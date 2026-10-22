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
 * Node's own process.env is not a plain object: its prototype is an object of node's that is not
 * Object.prototype, and a package that asks which it is gets the answer the host gives. An empty
 * object stands in for it, so the properties still read, write and enumerate as an ordinary
 * object's do while Object.getPrototypeOf(process.env) === Object.prototype is false, as on the
 * host.
 */
var ENV_PROTO = {};
Object.setPrototypeOf(envStore, ENV_PROTO);
/*
 * A write to the environment is a change to *this process's* environment, and on the host that is
 * what a child inherits: process.env.X = v followed by a spawn hands X down. Publishing the
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
 * a package asks has() of it before it puts a flag in the options it spawns with, and an
 * undefined here made that ask throw. The list is the one that node's own build reports, written
 * out rather than generated, because no guest can ask the node it models what it accepts.
 */
var ENV_FLAGS = '--abort-on-uncaught-exception --addons --allow-addons --allow-child-process --allow-fs-read --allow-fs-write --allow-inspector --allow-wasi --allow-worker --async-context-frame --conditions --cpu-prof --cpu-prof-dir --cpu-prof-interval --cpu-prof-name --debug-arraybuffer-allocations --debug-port --deprecation --diagnostic-dir --disable-proto --disable-sigusr1 --disable-warning --disable-wasm-trap-handler --disallow-code-generation-from-strings --dns-result-order --enable-etw-stack-walking --enable-fips --enable-network-family-autoselection --enable-source-maps --entry-url --es-module-specifier-resolution --experimental-abortcontroller --experimental-addon-modules --experimental-detect-module --experimental-eventsource --experimental-fetch --experimental-global-customevent --experimental-global-navigator --experimental-global-webcrypto --experimental-import-meta-resolve --experimental-json-modules --experimental-loader --experimental-modules --experimental-print-required-tla --experimental-quic --experimental-repl-await --experimental-report --experimental-require-module --experimental-shadow-realm --experimental-specifier-resolution --experimental-sqlite --experimental-strip-types --experimental-test-isolation --experimental-top-level-await --experimental-transform-types --experimental-vm-modules --experimental-wasi-unstable-preview1 --experimental-wasm-modules --experimental-websocket --experimental-webstorage --experimental-worker --expose-gc --extra-info-on-fatal-exception --force-async-hooks-checks --force-context-aware --force-fips --force-node-api-uncaught-exceptions-policy --frozen-intrinsics --global-search-paths --heap-prof --heap-prof-dir --heap-prof-interval --heap-prof-name --heapsnapshot-near-heap-limit --heapsnapshot-signal --http-parser --icu-data-dir --import --input-type --insecure-http-parser --inspect --inspect-brk --inspect-port --inspect-publish-uid --inspect-wait --interpreted-frames-native-stack --jitless --loader --localstorage-file --max-heap-size --max-http-header-size --max-old-space-size --max-old-space-size-percentage --max-semi-space-size --napi-modules --network-family-autoselection --network-family-autoselection-attempt-timeout --no-addons --no-allow-addons --no-allow-child-process --no-allow-inspector --no-allow-wasi --no-allow-worker --no-async-context-frame --no-cpu-prof --no-debug-arraybuffer-allocations --no-deprecation --no-disable-sigusr1 --no-disable-wasm-trap-handler --no-enable-fips --no-enable-source-maps --no-entry-url --no-experimental-addon-modules --no-experimental-detect-module --no-experimental-eventsource --no-experimental-global-navigator --no-experimental-import-meta-resolve --no-experimental-print-required-tla --no-experimental-repl-await --no-experimental-require-module --no-experimental-shadow-realm --no-experimental-sqlite --no-experimental-transform-types --no-experimental-vm-modules --no-experimental-websocket --no-experimental-webstorage --no-extra-info-on-fatal-exception --no-force-async-hooks-checks --no-force-context-aware --no-force-fips --no-force-node-api-uncaught-exceptions-policy --no-frozen-intrinsics --no-global-search-paths --no-heap-prof --no-insecure-http-parser --no-inspect --no-inspect-brk --no-inspect-wait --no-network-family-autoselection --no-node-snapshot --no-openssl-legacy-provider --no-openssl-shared-config --no-pending-deprecation --no-permission --no-preserve-symlinks --no-preserve-symlinks-main --no-report-compact --no-report-exclude-env --no-report-exclude-network --no-report-on-fatalerror --no-report-on-signal --no-report-uncaught-exception --no-require-module --no-strip-types --no-test-only --no-throw-deprecation --no-tls-max-v1.2 --no-tls-max-v1.3 --no-tls-min-v1.0 --no-tls-min-v1.1 --no-tls-min-v1.2 --no-tls-min-v1.3 --no-trace-deprecation --no-trace-env --no-trace-env-js-stack --no-trace-env-native-stack --no-trace-exit --no-trace-promises --no-trace-sigint --no-trace-sync-io --no-trace-tls --no-trace-uncaught --no-trace-warnings --no-track-heap-objects --no-use-bundled-ca --no-use-env-proxy --no-use-openssl-ca --no-use-system-ca --no-verify-base-objects --no-warnings --no-watch --no-watch-preserve-output --no-zero-fill-buffers --node-memory-debug --node-snapshot --openssl-config --openssl-legacy-provider --openssl-shared-config --pending-deprecation --perf-basic-prof --perf-basic-prof-only-functions --perf-prof --perf-prof-unwinding-info --permission --preserve-symlinks --preserve-symlinks-main --prof-process --redirect-warnings --report-compact --report-dir --report-directory --report-exclude-env --report-exclude-network --report-filename --report-on-fatalerror --report-on-signal --report-signal --report-uncaught-exception --require --require-module --secure-heap --secure-heap-min --snapshot-blob --stack-trace-limit --strip-types --test-coverage-branches --test-coverage-exclude --test-coverage-functions --test-coverage-include --test-coverage-lines --test-global-setup --test-isolation --test-name-pattern --test-only --test-reporter --test-reporter-destination --test-rerun-failures --test-shard --test-skip-pattern --throw-deprecation --title --tls-cipher-list --tls-keylog --tls-max-v1.2 --tls-max-v1.3 --tls-min-v1.0 --tls-min-v1.1 --tls-min-v1.2 --tls-min-v1.3 --trace-deprecation --trace-env --trace-env-js-stack --trace-env-native-stack --trace-event-categories --trace-event-file-pattern --trace-events-enabled --trace-exit --trace-promises --trace-require-module --trace-sigint --trace-sync-io --trace-tls --trace-uncaught --trace-warnings --track-heap-objects --unhandled-rejections --use-bundled-ca --use-env-proxy --use-largepages --use-openssl-ca --use-system-ca --v8-pool-size --verify-base-objects --warnings --watch --watch-kill-signal --watch-path --watch-preserve-output --zero-fill-buffers -C -r'.split(' ');
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
/*
 * argv[0] exactly as this process received it. On a host that is the path node was invoked by --
 * the same string as execPath for every run, because node is started by the node at execPath and
 * not by a name on PATH that resolves somewhere else. A host's argv0 is a string, and a package
 * that asks how the process was started reads it; left off, it is undefined and the same package
 * takes the branch a host never takes.
 */
proc.argv0 = proc.execPath;
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
/*
 * The ids this process runs as, which are the ids its own os.userInfo() names: the container is one
 * user, and that user is decided in the one place userInfo decides it. Node has these accessors on
 * a POSIX host and not elsewhere, and a package tests for the accessor before it reads the number --
 * the typeof process.getuid === 'function' guard -- so it is the missing function, not the
 * number, that sends such a package down the branch a container never takes. The effective ids are
 * the real ones because nothing here changes identity: there is no setuid, and nothing to set.
 */
proc.getuid = function () { return requireBuiltin('os').userInfo().uid; };
proc.geteuid = function () { return requireBuiltin('os').userInfo().uid; };
proc.getgid = function () { return requireBuiltin('os').userInfo().gid; };
proc.getegid = function () { return requireBuiltin('os').userInfo().gid; };
proc.emitWarning = function (warning) {
  host.stderr('(node) Warning: ' + (warning && warning.message ? warning.message : String(warning)) + '\n');
};
/*
 * The chain a host's process.stdout has: SyncWriteStream over Writable over Stream over
 * EventEmitter, which is what a package looks at -- isStreamLike(process.stdout), a prototype test,
 * a check that typeof process.stdout.pipe is a function. This container has no descriptor to open,
 * so the chain is built by name and the state behind it sits in a _writableState, which is where a
 * host keeps what these accessors read and why they are not own properties of the stream. A write is
 * still one synchronous call into the host, as it always was: nothing buffers and nothing waits.
 *
 * The name is the one node gives the stream it opens when its output is not a socket and not a
 * terminal -- a write that returns as soon as it is made -- which is what this stream is.
 */
function Stream() {}
function Writable() {}
function SyncWriteStream() {}
Stream.prototype = Object.create(EventEmitterCls.prototype);
Writable.prototype = Object.create(Stream.prototype);
SyncWriteStream.prototype = Object.create(Writable.prototype);
Stream.prototype.constructor = Stream;
Writable.prototype.constructor = Writable;
SyncWriteStream.prototype.constructor = SyncWriteStream;
/*
 * Writable.prototype.pipe, as node writes it: nothing can be piped *out of* a stream that cannot be
 * read, and node reports that by emitting the error rather than by returning one.
 */
SyncWriteStream.prototype.pipe = function (dest) {
  var cannot = new Error('Cannot pipe, not readable');
  cannot.code = 'ERR_STREAM_CANNOT_PIPE';
  var self = this;
  queueMicrotask(function () { self.emit('error', cannot); });
  return dest;
};
/* Everything a Writable reports about itself, read from the state object as node reads it. */
[
  ['writable', 'writable'], ['destroyed', 'destroyed'], ['writableEnded', 'ended'],
  ['writableFinished', 'finished'], ['writableHighWaterMark', 'highWaterMark'],
  ['writableLength', 'length'], ['writableCorked', 'corked'], ['writableNeedDrain', 'needDrain'],
  ['writableObjectMode', 'objectMode'], ['errored', 'errored']
].forEach(function (pair) {
  Object.defineProperty(SyncWriteStream.prototype, pair[0], {
    configurable: true,
    get: function () { return this._writableState[pair[1]]; }
  });
});
function makeStdioStream(fd, writeText) {
  var stream = new SyncWriteStream();
  EventEmitterCls.call(stream);
  stream._writableState = { writable: true, destroyed: false, ended: false, finished: false,
    highWaterMark: 65536, length: 0, corked: 0, needDrain: false, objectMode: false, errored: null };
  stream.fd = fd;
  stream.readable = false;
  /*
   * No terminal is attached, and a stream node has with no terminal behind it has *no* isTTY and
   * *no* columns: a host run with its output piped reports undefined for both, not false and 80.
   * The difference is observable -- columns || 80 never falls back here, and a library that reads
   * isTTY to decide whether it is talking to a person is answered with a value that says it is
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
    stream._writableState.ended = true;
    stream._writableState.finished = true;
    return stream;
  };
  stream.cork = function () { stream._writableState.corked = stream._writableState.corked + 1; };
  stream.uncork = function () { if (stream._writableState.corked > 0) stream._writableState.corked = stream._writableState.corked - 1; };
  stream.setEncoding = function () { return stream; };
  return stream;
}
proc.stdout = makeStdioStream(1, function (text) {
  host.stdout(text);
});
proc.stderr = makeStdioStream(2, function (text) {
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
    /*
     * A ReadStream, which is what a host's process.stdin is: the Readable node wraps fd 0 in, named
     * as node names it, so a package that asks which class it is holding gets the answer a host
     * gives. The Readable behind it is the same one this used, built the same way.
     */
    function ReadStream(options) { Readable.call(this, options); }
    ReadStream.prototype = Object.create(Readable.prototype);
    ReadStream.prototype.constructor = ReadStream;
    stdinStream = new ReadStream({ read: function () {} });
    /* fd 0, the descriptor a process reads its input from, whether anything is fed through it. */
    stdinStream.fd = 0;
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
    var lines = String(new Error('').stack || '').split('\n');
    /* What the engine hands back opens with the line naming the error once the constructors below
       are in place, and with a frame when it is not; either way the line that follows is this call,
       which is not a frame of the caller's and is dropped with it. */
    if (lines.length > 0 && lines[0].indexOf('    at ') !== 0) lines = lines.slice(1);
    var frames = lines.slice(1);
    if (typeof Error.prepareStackTrace === 'function') {
      target.stack = Error.prepareStackTrace(target, frames.map(makeCallSite));
      return;
    }
    var header = String(target.name || 'Error') + (target.message ? ': ' + target.message : '');
    target.stack = frames.length ? header + '\n' + frames.join('\n') : header;
  };
}
if (Error.stackTraceLimit === undefined) Error.stackTraceLimit = 10;

/*
 * The header a V8 stack starts with: the error's own name and message, then the frames. This engine
 * writes the frames alone, as a plain data property with nothing in front of them, so the first
 * line of a guest err.stack is a frame where the host's is "Error: boom". The frames are moved
 * behind an accessor -- the shape the host has -- and the stack is built the first time it is read
 * and kept from then on, which is what makes a name or a message written before that first read the
 * one the stack shows and one written after it nothing at all.
 */
var STACK_HEADER_CTORS = [
  'Error', 'EvalError', 'RangeError', 'ReferenceError', 'SyntaxError', 'TypeError', 'URIError', 'AggregateError'
];
var CONSTRUCT_FRAME = '    at construct (native)';

function stackHeaderOf(err) {
  var name = 'Error';
  var message = '';
  try {
    name = String(err.name || 'Error');
    message = String(err.message === undefined || err.message === null ? '' : err.message);
  } catch (ignored) {
    /* A message that throws when it is read: the host read it once, before it threw. */
  }
  return message === '' ? name : name + ': ' + message;
}

/*
 * The frames of a stack the engine built, less the two the wrapper puts there of its own -- the
 * Reflect.construct call and the wrapper itself, neither of which was on the stack the caller asked
 * about -- and less the empty line the engine ends every stack with. The count is the limit the
 * host keeps on Error.stackTraceLimit.
 */
function framesOfEngineStack(stack, ownFrame) {
  var lines = typeof stack === 'string' && stack !== '' ? stack.split('\n') : [];
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  var at = 0;
  while (at < lines.length && (lines[at] === CONSTRUCT_FRAME || lines[at] === ownFrame)) at++;
  lines = lines.slice(at);
  var limit = Error.stackTraceLimit;
  if (typeof limit === 'number' && limit >= 0 && lines.length > limit) lines = lines.slice(0, limit);
  return lines.join('\n');
}

/*
 * err.stack as the host has it: an accessor that builds the stack once and keeps it, that a
 * prepareStackTrace is asked for, and that an assignment turns into the plain data property the
 * host's own assignment turns it into -- a value written back is the value read, with no header
 * put in front of it.
 */
function installErrorStack(err, frames) {
  var kept = null;
  Object.defineProperty(err, 'stack', {
    get: function () {
      if (kept !== null) return kept;
      if (typeof Error.prepareStackTrace === 'function') {
        kept = String(Error.prepareStackTrace(err, frames === '' ? [] : frames.split('\n').map(makeCallSite)));
        return kept;
      }
      var header = stackHeaderOf(err);
      kept = frames === '' ? header : (frames.indexOf(header) === 0 ? frames : header + '\n' + frames);
      return kept;
    },
    set: function (value) {
      /* V8's own assignment: the accessor is replaced by the value, so what is written is what is
         read and nothing that follows changes it. */
      Object.defineProperty(err, 'stack', { value: value, writable: true, enumerable: false, configurable: true });
    },
    enumerable: false,
    configurable: true
  });
}

function installStackHeader(name) {
  var Native = globalThis[name];
  if (typeof Native !== 'function') return;
  if (typeof Reflect === 'undefined' || typeof Reflect.construct !== 'function') return;
  var ownFrame = null;
  function Shim() {
    var err = Reflect.construct(Native, arguments, new.target === undefined ? Shim : new.target);
    var raw = err.stack;
    /* The first error built names the frame the wrapper itself contributes; every later one is
       asked to drop it. */
    if (ownFrame === null) {
      var built = typeof raw === 'string' && raw !== '' ? raw.split('\n') : [];
      ownFrame = built.length > 1 ? built[1] : '';
    }
    installErrorStack(err, framesOfEngineStack(raw, ownFrame));
    return err;
  }
  Shim.prototype = Native.prototype;
  Object.defineProperty(Shim, 'name', { value: name, configurable: true });
  Object.defineProperty(Shim, 'length', { value: Native.length, configurable: true });
  /* A wrapper is not the engine's own function and String(Error) is asked of it: the host reads
     "function Error() { [native code] }" there, and a package that tests for native code tests
     this very string. */
  Object.defineProperty(Shim, 'toString', {
    value: function () { return 'function ' + name + '() { [native code] }'; },
    writable: true,
    enumerable: false,
    configurable: true
  });
  var statics = Object.getOwnPropertyNames(Native);
  for (var s = 0; s < statics.length; s++) {
    if (statics[s] === 'length' || statics[s] === 'name' || statics[s] === 'prototype') continue;
    Object.defineProperty(Shim, statics[s], Object.getOwnPropertyDescriptor(Native, statics[s]));
  }
  /* err.constructor === Error is asked as often as err instanceof Error is, and the prototype the
     instances keep is still the engine's own, so it is its constructor that names the wrapper. */
  Object.defineProperty(Native.prototype, 'constructor', { value: Shim, writable: true, enumerable: false, configurable: true });
  globalThis[name] = Shim;
}
for (var headerAt = 0; headerAt < STACK_HEADER_CTORS.length; headerAt++) installStackHeader(STACK_HEADER_CTORS[headerAt]);

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
  /*
   * The percent-encode sets, as code points: every one of them holds the C0 controls and every code
   * point past ASCII -- which is what encodes 'ü' as %C3%BC and leaves '%C3%BC' the caller wrote
   * alone -- and they differ in the printable bytes they add. The backtick and the quote are spelled
   * as code points because this source is itself a template literal.
   */
  var PATH_EXTRA = [0x22, 0x23, 0x3c, 0x3e, 0x3f, 0x60, 0x7b, 0x7d, 0x5e];
  var QUERY_EXTRA = [0x22, 0x23, 0x3c, 0x3e];
  /* the special-query set adds the apostrophe, for the two schemes whose queries are HTML forms */
  var QUERY_SPECIAL_EXTRA = [0x22, 0x23, 0x27, 0x3c, 0x3e];
  var FRAGMENT_EXTRA = [0x22, 0x3c, 0x3e, 0x60];
  var USERINFO_EXTRA = [0x22, 0x23, 0x3c, 0x3e, 0x3f, 0x60, 0x7b, 0x7d, 0x5e,
    0x2f, 0x3a, 0x3b, 0x3d, 0x40, 0x5b, 0x5c, 0x5d, 0x7c];

  function percentEncodeIn(text, extra) {
    var out = '';
    for (var i = 0; i < text.length; i++) {
      var ch = text.charAt(i);
      var code = text.charCodeAt(i);
      if (code <= 0x20 || code > 0x7e || extra.indexOf(code) >= 0) {
        try { out += encodeURIComponent(ch); } catch (loneSurrogate) { out += ch; }
      } else out += ch;
    }
    return out;
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
    return percentEncodeIn(text, PATH_EXTRA);
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

  /* ---- hosts ----
   *
   * WHATWG: what a host is depends on what it looks like. An IPv6 literal sits in brackets and is
   * parsed and rewritten as one, so '[::ffff:1.2.3.4]' comes back as '[::ffff:102:304]'. Anything
   * else is a domain -- except that a domain whose last label is a number is an IPv4 address, which
   * is why '0x7f.1', '0177.0.0.1' and '2130706433' are all 127.0.0.1 while '4294967296', which is
   * one past the last address there is, is not a host at all. A byte no host may hold -- a control,
   * a space, '<', '>', '^', '|', a bracket or a backslash -- is refused outright.
   */
  var HEX_PAIR = /^[0-9A-Fa-f][0-9A-Fa-f]$/;
  var HEX_DIGIT = /^[0-9A-Fa-f]$/;
  var FORBIDDEN_HOST = '\u0000 <>^|[]\\';

  function forbiddenIn(text) {
    for (var i = 0; i < text.length; i++) if (FORBIDDEN_HOST.indexOf(text.charAt(i)) >= 0) return true;
    return false;
  }

  function percentDecode(text) {
    var out = '';
    for (var i = 0; i < text.length; i++) {
      if (text.charAt(i) === '%' && i + 2 < text.length && HEX_PAIR.test(text.substr(i + 1, 2))) {
        out += String.fromCharCode(parseInt(text.substr(i + 1, 2), 16));
        i += 2;
      } else out += text.charAt(i);
    }
    return out;
  }

  /* One label of an IPv4 address, as the URL parser reads it: a run of hex digits behind '0x', a
     run of octal digits behind a leading zero, or a run of decimal digits. */
  function ipv4NumberOf(text) {
    var s = text;
    var radix = 10;
    if (s.length > 1 && s.charAt(0) === '0' && (s.charAt(1) === 'x' || s.charAt(1) === 'X')) {
      radix = 16;
      s = s.slice(2);
    } else if (s.length > 1 && s.charAt(0) === '0') {
      radix = 8;
      s = s.slice(1);
    }
    if (s === '') return 0;
    if (radix === 16 && !/^[0-9A-Fa-f]+$/.test(s)) return null;
    if (radix === 8 && !/^[0-7]+$/.test(s)) return null;
    if (radix === 10 && !/^[0-9]+$/.test(s)) return null;
    var value = parseInt(s, radix);
    return isFinite(value) ? value : null;
  }

  /* '1.2.3.4.' is the address '1.2.3.4': a trailing empty label is dropped, the way URL drops it. */
  function ipv4LabelsOf(host) {
    var parts = host.split('.');
    if (parts[parts.length - 1] === '' && parts.length > 1) parts.pop();
    return parts;
  }

  function endsInANumber(host) {
    var parts = ipv4LabelsOf(host);
    var last = parts[parts.length - 1];
    if (last === undefined || last === '') return false;
    if (/^[0-9]+$/.test(last)) return true;
    return ipv4NumberOf(last) !== null;
  }

  function ipv4AddressOf(host) {
    var parts = ipv4LabelsOf(host);
    if (parts.length > 4) return null;
    var numbers = [];
    for (var i = 0; i < parts.length; i++) {
      if (parts[i] === '') return null;
      var label = ipv4NumberOf(parts[i]);
      if (label === null) return null;
      numbers.push(label);
    }
    /* every label but the last is one byte, and the last is whatever is left of the 32 bits */
    for (var j = 0; j < numbers.length - 1; j++) if (numbers[j] > 255) return null;
    if (numbers[numbers.length - 1] >= Math.pow(256, 5 - numbers.length)) return null;
    var address = numbers.pop();
    for (var k = 0; k < numbers.length; k++) address += numbers[k] * Math.pow(256, 3 - k);
    return address;
  }

  function ipv4TextOf(address) {
    var rest = address;
    var out = String(rest % 256);
    rest = Math.floor(rest / 256);
    for (var i = 1; i < 4; i++) {
      out = (rest % 256) + '.' + out;
      rest = Math.floor(rest / 256);
    }
    return out;
  }

  /* The eight 16-bit pieces of an IPv6 literal, or null for anything that is not one: zero or more
     hex groups, at most one '::' standing for as many zero groups as are missing, and -- in the
     last two pieces -- an IPv4 address in dotted decimal, which is what '[::ffff:1.2.3.4]' is. */
  function ipv6PiecesOf(text) {
    var pieces = [0, 0, 0, 0, 0, 0, 0, 0];
    var pieceIndex = 0;
    var compress = null;
    var at = 0;
    if (text.charAt(at) === ':') {
      if (text.charAt(at + 1) !== ':') return null;
      at += 2;
      pieceIndex += 1;
      compress = pieceIndex;
    }
    while (at < text.length) {
      if (pieceIndex === 8) return null;
      if (text.charAt(at) === ':') {
        if (compress !== null) return null;
        at += 1;
        pieceIndex += 1;
        compress = pieceIndex;
        continue;
      }
      var value = 0;
      var length = 0;
      while (length < 4 && at < text.length && HEX_DIGIT.test(text.charAt(at))) {
        value = value * 16 + parseInt(text.charAt(at), 16);
        at += 1;
        length += 1;
      }
      if (text.charAt(at) === '.') {
        if (length === 0) return null;
        at -= length;
        if (pieceIndex > 6) return null;
        var seen = 0;
        while (at < text.length) {
          var byteValue = null;
          if (seen > 0) {
            if (text.charAt(at) === '.' && seen < 4) at += 1;
            else return null;
          }
          if (text.charAt(at) < '0' || text.charAt(at) > '9') return null;
          while (at < text.length && text.charAt(at) >= '0' && text.charAt(at) <= '9') {
            var digit = text.charCodeAt(at) - 48;
            if (byteValue === null) byteValue = digit;
            else if (byteValue === 0) return null;
            else byteValue = byteValue * 10 + digit;
            if (byteValue > 255) return null;
            at += 1;
          }
          pieces[pieceIndex] = pieces[pieceIndex] * 0x100 + byteValue;
          seen += 1;
          if (seen === 2 || seen === 4) pieceIndex += 1;
        }
        if (seen !== 4) return null;
        break;
      }
      if (text.charAt(at) === ':') {
        at += 1;
        if (at >= text.length) return null;
      } else if (at < text.length) {
        /* a byte that is neither a hex digit nor a colon nor the end: a zone id, say */
        return null;
      }
      pieces[pieceIndex] = value;
      pieceIndex += 1;
    }
    if (compress !== null) {
      /* the groups '::' stands for are the ones that were never written: the pieces after it move
         to the end of the address, and zeros take their place */
      var swaps = pieceIndex - compress;
      pieceIndex = 7;
      while (pieceIndex !== 0 && swaps > 0) {
        var held = pieces[compress + swaps - 1];
        pieces[compress + swaps - 1] = pieces[pieceIndex];
        pieces[pieceIndex] = held;
        pieceIndex -= 1;
        swaps -= 1;
      }
    } else if (pieceIndex !== 8) {
      return null;
    }
    return pieces;
  }

  /* The shortest spelling of an address: the longest run of zero groups -- the first one, where two
     are the same length -- is written as '::', and one group on its own is not compressed at all. */
  function ipv6TextOf(pieces) {
    var bestAt = -1;
    var bestLen = 0;
    var runAt = -1;
    var runLen = 0;
    for (var i = 0; i <= 8; i++) {
      if (i < 8 && pieces[i] === 0) {
        if (runAt < 0) { runAt = i; runLen = 0; }
        runLen += 1;
        if (runLen > bestLen) { bestLen = runLen; bestAt = runAt; }
      } else {
        runAt = -1;
        runLen = 0;
      }
    }
    if (bestLen <= 1) bestAt = -1;
    var out = '';
    var at = 0;
    while (at < 8) {
      if (at === bestAt) {
        out += at === 0 ? '::' : ':';
        at += bestLen;
        continue;
      }
      out += pieces[at].toString(16);
      if (at < 7) out += ':';
      at += 1;
    }
    return out;
  }

  /*
   * A host written with no port beside it -- the host of a URL being parsed, or one assigned to
   * hostname. The same three readings as anywhere else: an IPv6 literal in brackets, a domain that
   * ends in a number, or a domain. null for anything that is no host at all, which is what makes an
   * assignment of one leave the URL as it was rather than write a host that cannot be parsed.
   */
  /* The C0 control percent-encode set, which is all an opaque host is ever encoded with: the
     controls and every code point past ASCII, and nothing else -- so '%20' survives as it was
     written, where a space of its own would not. */
  function encodeOpaqueHost(text) {
    var out = '';
    for (var i = 0; i < text.length; i++) {
      var code = text.charCodeAt(i);
      if (code <= 0x1f || code > 0x7e) {
        try { out += encodeURIComponent(text.charAt(i)); } catch (loneSurrogate) { out += text.charAt(i); }
      } else out += text.charAt(i);
    }
    return out;
  }

  function hostNameOf(hostText, protocol, special) {
    if (hostText.charAt(0) === '[') {
      if (hostText.charAt(hostText.length - 1) !== ']') return null;
      var pieces = ipv6PiecesOf(hostText.slice(1, hostText.length - 1));
      return pieces === null ? null : '[' + ipv6TextOf(pieces) + ']';
    }
    /* file: 'localhost' names no host at all, as it names none in Node */
    if (protocol === 'file:' && hostText.toLowerCase() === 'localhost') return '';
    /*
     * An opaque host -- the host of a scheme that is not special -- is not a domain: it keeps the
     * case it was written in and an escape it carries is left alone, and a byte that is not ASCII
     * is percent-encoded rather than punycoded. 'foo://ABC' is the host 'ABC',
     * 'foo://exämple' the host 'ex%C3%A4mple' and 'foo://a%20b' the host 'a%20b'. An opaque host is
     * never decoded, so it is refused for a byte it carries exactly as it was written.
     */
    if (!special) return forbiddenIn(hostText) ? null : encodeOpaqueHost(hostText);
    /* an escape in a host is decoded, so 'h%41' is the host 'ha' */
    var host = percentDecode(hostText).toLowerCase();
    /*
     * A byte no host may hold is read after the escapes are decoded, which is why
     * 'http://a%00b/' and 'http://a%20b/' are no URL at all: what the host holds is a NUL and a
     * space, and both are forbidden, though '%00' and '%20' as written carry neither.
     */
    if (forbiddenIn(host)) return null;
    if (special && host !== '' && endsInANumber(host)) {
      var address = ipv4AddressOf(host);
      return address === null ? null : ipv4TextOf(address);
    }
    /*
     * A domain is IDNA, so 'пример.рф' is the host 'xn--e1afmkfd.xn--p1ai' -- the punycode of the
     * url module, which is the one place it lives. An opaque host, the host of a scheme that is not
     * special, is not a domain and is left as it was written.
     */
    if (special && host !== '' && typeof nodeUrl.domainToASCII === 'function') {
      var ascii = nodeUrl.domainToASCII(host);
      /* a domain that will not turn into ASCII is no host at all */
      return ascii === '' ? null : ascii;
    }
    return host;
  }

  function specialScheme(protocol) {
    return Object.prototype.hasOwnProperty.call(DEFAULT_PORTS, protocol);
  }

  /* Whether a URL of this scheme may hold no host: only file: may among the special schemes, and
     every scheme that is not special may, so 'foo:///a' is a URL and 'http:///a' is not. */
  function refusesEmptyHost(state) {
    return specialScheme(state.protocol) && state.protocol !== 'file:';
  }

  function parseUrl(input, base, raw) {
    var text = cleaned(input);
    var scheme = SCHEME_RE.exec(text);
    if (scheme === null) {
      if (base === null || base === undefined) throw invalidUrl(raw);
      text = referenceAgainst(base, text);
      scheme = SCHEME_RE.exec(text);
      if (scheme === null) throw invalidUrl(raw);
    } else if (base !== null && base !== undefined &&
               base.protocol === scheme[1].toLowerCase() + ':' &&
               specialScheme(scheme[1].toLowerCase() + ':')) {
      /*
       * A reference that repeats the base's own special scheme -- 'http:h' against 'http://c/d' --
       * is not read as the absolute URL it looks like: the scheme is dropped and what follows it is
       * a relative reference, so the answer is 'http://c/h' and not 'http://h/'.
       */
      text = referenceAgainst(base, text.slice(scheme[0].length));
      scheme = SCHEME_RE.exec(text);
      if (scheme === null) throw invalidUrl(raw);
    }
    var protocol = scheme[1].toLowerCase() + ':';
    var special = specialScheme(protocol);
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
      var eaten = '';
      while (slashes < 2 && rest.length > 0 && (rest.charAt(0) === '/' || rest.charAt(0) === '\\')) {
        eaten += rest.charAt(0);
        rest = rest.slice(1);
        slashes++;
      }
      /* file: is the one special scheme with no authority unless both slashes were written:
         'file:/a' is a path on no host, which Node writes as 'file:///a'. The one slash it did
         write is a slash of that path, not of an authority, so it goes back. */
      hasHost = protocol === 'file:' ? slashes === 2 : true;
      if (!hasHost) rest = eaten.replace(/\\/g, '/') + rest;
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
        state.username = percentEncodeIn(colon >= 0 ? userinfo.slice(0, colon) : userinfo, USERINFO_EXTRA);
        state.password = colon >= 0 ? percentEncodeIn(userinfo.slice(colon + 1), USERINFO_EXTRA) : '';
      }
      if (hostport.charAt(0) === '[') {
        /* an IPv6 literal is one host, brackets and all: the ':' inside it is not a port */
        var close = hostport.indexOf(']');
        if (close < 0) throw invalidUrl(raw);
        var after = hostport.slice(close + 1);
        if (after !== '') {
          if (after.charAt(0) !== ':') throw invalidUrl(raw);
          state.port = portOf(after.slice(1), raw);
        }
        var pieces = ipv6PiecesOf(hostport.slice(1, close));
        if (pieces === null) throw invalidUrl(raw);
        state.hostname = '[' + ipv6TextOf(pieces) + ']';
      } else {
        var portAt = hostport.indexOf(':');
        var hostText = portAt >= 0 ? hostport.slice(0, portAt) : hostport;
        if (portAt >= 0) state.port = portOf(hostport.slice(portAt + 1), raw);
        var named = hostNameOf(hostText, protocol, special);
        if (named === null) throw invalidUrl(raw);
        state.hostname = named;
      }
      state.hasHost = true;
      /* a special scheme that names no host is no URL at all -- except file:, which has none */
      if (special && state.hostname === '' && protocol !== 'file:') throw invalidUrl(raw);
      if (state.port !== '' && DEFAULT_PORTS[protocol] === state.port) state.port = '';
    }
    var hashAt = rest.indexOf('#');
    if (hashAt >= 0) {
      state.hash = percentEncodeIn(rest.slice(hashAt + 1), FRAGMENT_EXTRA);
      rest = rest.slice(0, hashAt);
    }
    var queryAt = rest.indexOf('?');
    if (queryAt >= 0) {
      state.query = percentEncodeIn(rest.slice(queryAt + 1), special ? QUERY_SPECIAL_EXTRA : QUERY_EXTRA);
      rest = rest.slice(0, queryAt);
    }
    var path = special ? rest.replace(/\\/g, '/') : rest;
    if (path === '') path = special ? '/' : '';
    /* a file: URL has a path that starts at the root whether or not it named an authority, which is
       why 'file:a' is 'file:///a' and not 'file://a' with 'a' as its host */
    else if ((hasHost || protocol === 'file:') && path.charAt(0) !== '/') path = '/' + path;
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
    var state = STATE.get(this);
    var text = String(value);
    var next = (text.charAt(text.length - 1) === ':' ? text : text + ':').toLowerCase();
    if (!SCHEME_RE.test(next)) return;
    /*
     * WHATWG: a scheme the parser will not write leaves the URL as it stands. A special URL may not
     * become one that is not, nor one that is not become a special one -- which is why 'javascript:'
     * on an http: URL changes nothing at all -- a URL carrying credentials or a port may not become
     * a file: one, and a file: URL with no host may not become anything else.
     */
    if (specialScheme(state.protocol) !== specialScheme(next)) return;
    if (next === 'file:' && (state.username !== '' || state.password !== '' || state.port !== '')) return;
    if (state.protocol === 'file:' && state.hostname === '') return;
    state.protocol = next;
    /* the port the old scheme kept is the new scheme's own default for one URL in a thousand, and
       a default port is no port: https://h:80/ written to http: is http://h/ */
    if (state.port !== '' && DEFAULT_PORTS[next] === state.port) state.port = '';
  });
  field('username', function () {
    return STATE.get(this).username;
  }, function (value) { STATE.get(this).username = percentEncodeIn(String(value), USERINFO_EXTRA); });
  field('password', function () {
    return STATE.get(this).password;
  }, function (value) { STATE.get(this).password = percentEncodeIn(String(value), USERINFO_EXTRA); });
  field('hostname', function () {
    return STATE.get(this).hostname;
  }, function (value) {
    var state = STATE.get(this);
    var named = hostNameOf(String(value), state.protocol, specialScheme(state.protocol));
    /* a value that is no host leaves the URL as it stands, as it does in Node */
    if (named === null) return;
    /* so does no host at all, for every scheme but file: and the schemes that are not special:
       'http://h/a' with an empty hostname written is still 'http://h/a' */
    if (named === '' && refusesEmptyHost(state)) return;
    state.hostname = named;
  });
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
    /*
     * The port is what follows the last ':' outside a bracketed IPv6 literal -- '[::1]:8080' is one
     * host with the port 8080 behind it, and reading the first ':' instead would take '[' for the
     * host and ':1]:8080' for the port.
     */
    var at = text.lastIndexOf(':');
    if (text.charAt(0) === '[') {
      var close = text.indexOf(']');
      at = close >= 0 ? text.indexOf(':', close) : -1;
    }
    var hostText = at >= 0 ? text.slice(0, at) : text;
    var portText = at >= 0 ? text.slice(at + 1) : '';
    /* a host is read as the parser reads one: IDNA, IPv4, IPv6 and the forbidden bytes and all */
    var named = hostNameOf(hostText, state.protocol, specialScheme(state.protocol));
    /* a host that will not parse -- or, for every scheme but file: and the ones that are not
       special, no host at all -- leaves the URL as it stands, as it does in Node */
    if (named === null || (named === '' && refusesEmptyHost(state))) return;
    var port;
    /* a port that is no port leaves the whole assignment alone, 'h:abc' included */
    try { port = assignedPort(state, portText, text); } catch (badPort) { return; }
    state.hostname = named;
    state.port = port;
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
    state.query = text === ''
      ? null
      : percentEncodeIn(text.charAt(0) === '?' ? text.slice(1) : text,
        specialScheme(state.protocol) ? QUERY_SPECIAL_EXTRA : QUERY_EXTRA);
    state.dirty = false;
    state.sp = undefined;
  });
  field('hash', function () {
    var state = STATE.get(this);
    return state.hash === null || state.hash === '' ? '' : '#' + state.hash;
  }, function (value) {
    var state = STATE.get(this);
    var text = String(value);
    state.hash = text === ''
      ? null
      : percentEncodeIn(text.charAt(0) === '#' ? text.slice(1) : text, FRAGMENT_EXTRA);
  });
  /* WHATWG: only a scheme with a host of its own has an origin -- an opaque host, and file:, have
     the opaque origin 'null' -- except blob:, whose origin is the origin of the URL in its path. */
  field('origin', function () {
    var state = STATE.get(this);
    if (state.protocol === 'blob:') {
      /* One level only, and only into a scheme that carries a host of its own: the origin of
         'blob:blob:http://h/x' is 'null', not the 'http://h' a second step would reach. */
      try {
        var inner = new URL(state.pathname);
        if (DEFAULT_PORTS.hasOwnProperty(inner.protocol)) return inner.origin;
      } catch (notAUrl) { /* an unparseable path is the opaque origin */ }
      return 'null';
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
   * real close from a hand-built one -- would be false. Node declares the three attributes a close
   * adds as enumerable getters on CloseEvent.prototype and nothing else: no own property, and no
   * per-instance prototype in the chain, so a close event reads CloseEvent > Event.
   */
  globalThis.CloseEvent = (function () {
    var CLOSE = new WeakMap();
    function CloseEvent(type, init = {}) {
      if (arguments.length < 1) throw new TypeError('CloseEvent constructor: 1 argument required, but 0 found.');
      init = init || {};
      /*
       * Node's own Event is installed further down the bootstrap than this file runs, so the
       * parent is joined on first use rather than here, or a close event would not be an Event.
       */
      var Base = typeof globalThis.Event === 'function' ? globalThis.Event.prototype : Object.prototype;
      if (Object.getPrototypeOf(CloseEvent.prototype) !== Base) Object.setPrototypeOf(CloseEvent.prototype, Base);
      var self = this;
      if (typeof globalThis.Event === 'function') {
        /* Built through Event, so the slots its own accessors read -- type, timeStamp and the
           rest -- are the ones Event's constructor fills, then moved under CloseEvent: that is
           what leaves the chain at CloseEvent > Event rather than three prototypes deep. */
        self = new globalThis.Event(type, init);
        Object.setPrototypeOf(self, CloseEvent.prototype);
      }
      CLOSE.set(self, {
        code: init.code === undefined ? 0 : Number(init.code),
        reason: init.reason === undefined ? '' : String(init.reason),
        wasClean: init.wasClean === undefined ? false : !!init.wasClean
      });
      return self;
    }
    CloseEvent.prototype = Object.create(Object.prototype);
    Object.defineProperty(CloseEvent.prototype, 'constructor', { value: CloseEvent, writable: true, configurable: true });
    ['wasClean', 'code', 'reason'].forEach(function (name) {
      Object.defineProperty(CloseEvent.prototype, name, {
        get: function () { return CLOSE.get(this)[name]; },
        enumerable: true,
        configurable: true
      });
    });
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

/*
 * A cycle in a value handed to JSON.stringify: the engine says "circular reference" where V8 names
 * the constructor the circle starts at, each property walked to get there and the property that
 * closes it. Only the words are asked of a value the engine has already refused, so the walk that
 * finds the circle runs after the refusal and never before it, and a value that is accepted costs
 * nothing at all.
 */
function cycleConstructorName(value) {
  var proto = Object.getPrototypeOf(value);
  if (proto === null || proto === undefined) return 'Object';
  var ctor = proto.constructor;
  if (ctor !== null && ctor !== undefined && typeof ctor.name === 'string' && ctor.name !== '') return ctor.name;
  return 'Object';
}

/* How one step of the path is named: an index of an array, and otherwise a property. */
function cycleStepText(key, parentIsArray) {
  return parentIsArray ? 'index ' + key : "property '" + key + "'";
}

/*
 * The circle in a value, as the place on the path it starts at and the key that closes it, or null
 * when a walk of the value finds none -- a cycle a replacer or a toJSON built is one this walk does
 * not see, and for that one the engine's own words are left alone.
 */
function findCycleIn(value) {
  var path = [];
  var reached = [];
  var found = null;

  function walk(node, key, parentIsArray) {
    if (found !== null) return true;
    if (node === null || typeof node !== 'object') return false;
    /* V8 asks a value for its own JSON form before it walks into it, and a Date answers with a
       string that has nothing behind it. */
    if (typeof node.toJSON === 'function') {
      var form;
      try { form = node.toJSON(key); } catch (ignored) { return false; }
      if (form === null || typeof form !== 'object') return false;
      node = form;
    }
    var at = path.indexOf(node);
    if (at >= 0) {
      found = { start: at, key: key, parentIsArray: parentIsArray, path: path.slice(), reached: reached.slice() };
      return true;
    }
    path.push(node);
    reached.push({ key: key, parentIsArray: parentIsArray });
    var isArray = Array.isArray(node);
    var names = isArray ? null : Object.keys(node);
    var count = isArray ? node.length : names.length;
    for (var i = 0; i < count; i++) {
      var childKey = isArray ? i : names[i];
      var child;
      try { child = node[childKey]; } catch (ignored) { continue; }
      if (walk(child, childKey, isArray)) return true;
    }
    path.pop();
    reached.pop();
    return false;
  }

  walk(value, undefined, false);
  return found;
}

/*
 * The path V8 prints: every step of it when the circle closes within three, and otherwise the first
 * two, a line of dots, and the step that closed it -- a chain a hundred long is four lines and not
 * a hundred.
 */
function circularStructureText(value) {
  var cycle = findCycleIn(value);
  if (cycle === null) return null;
  var lines = ['Converting circular structure to JSON'];
  lines.push("    --> starting at object with constructor '" + cycleConstructorName(cycle.path[cycle.start]) + "'");
  var steps = [];
  for (var i = cycle.start + 1; i < cycle.path.length; i++) {
    steps.push('    |     ' + cycleStepText(cycle.reached[i].key, cycle.reached[i].parentIsArray) +
      " -> object with constructor '" + cycleConstructorName(cycle.path[i]) + "'");
  }
  if (steps.length > 3) steps = steps.slice(0, 2).concat(['    |     ...', steps[steps.length - 1]]);
  for (var s = 0; s < steps.length; s++) lines.push(steps[s]);
  lines.push('    --- ' + cycleStepText(cycle.key, cycle.parentIsArray) + ' closes the circle');
  return lines.join('\n');
}

(function installCircularStructureMessage() {
  var nativeStringify = JSON.stringify;
  if (typeof nativeStringify !== 'function') return;
  function stringify() {
    try {
      return nativeStringify.apply(JSON, arguments);
    } catch (err) {
      if (!(err instanceof TypeError) || String(err.message) !== 'circular reference') throw err;
      var text = circularStructureText(arguments[0]);
      if (text === null) throw err;
      /* The error the engine threw carries the stack of the call that asked for the string, so it
         is the one thrown back, with its words replaced; where a message cannot be written, a fresh
         error of the same kind carries them instead. */
      var rewritten = false;
      try {
        err.message = text;
        rewritten = String(err.message) === text;
      } catch (ignored) {
        rewritten = false;
      }
      throw rewritten ? err : new TypeError(text);
    }
  }
  /* The host's own JSON.stringify: three parameters, and the name a package reads off it. */
  Object.defineProperty(stringify, 'name', { value: 'stringify', configurable: true });
  Object.defineProperty(stringify, 'length', { value: 3, configurable: true });
  JSON.stringify = stringify;
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
