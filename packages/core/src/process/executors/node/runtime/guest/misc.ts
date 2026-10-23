/**
 * Guest-side remaining built-ins: os, timers, timers/promises, url, crypto, module,
 * tty and http (the existing in-memory network bridge). Plain JavaScript inside a
 * String.raw snippet.
 */
export const MISC_SRC = String.raw`
BF.os = function () {
  /*
   * The signals the machine under the host actually has, which is the set Node's own os.constants
   * carries there: SIGINFO is a BSD signal a Linux box has no number for, and SIGPOLL, SIGPWR and
   * SIGSTKFLT are the other way round -- they belong to Linux and the host does not list them. A
   * set of 33 answered every one of the 31 a host prints plus three a host does not have.
   */
  var signals = {
    SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGILL: 4, SIGTRAP: 5, SIGABRT: 6, SIGIOT: 6, SIGBUS: 10,
    SIGFPE: 8, SIGKILL: 9, SIGUSR1: 30, SIGSEGV: 11, SIGUSR2: 31, SIGPIPE: 13, SIGALRM: 14,
    SIGTERM: 15, SIGCHLD: 20, SIGCONT: 19, SIGSTOP: 17, SIGTSTP: 18, SIGTTIN: 21,
    SIGTTOU: 22, SIGURG: 16, SIGXCPU: 24, SIGXFSZ: 25, SIGVTALRM: 26, SIGPROF: 27, SIGWINCH: 28,
    SIGIO: 23, SIGINFO: 29, SIGSYS: 12
  };
  var priority = {
    PRIORITY_LOW: 19, PRIORITY_BELOW_NORMAL: 10, PRIORITY_NORMAL: 0,
    PRIORITY_ABOVE_NORMAL: -7, PRIORITY_HIGH: -14, PRIORITY_HIGHEST: -20
  };
  var dlopen = { RTLD_LAZY: 1, RTLD_NOW: 2, RTLD_GLOBAL: 8, RTLD_LOCAL: 4 };

  /*
   * The argument check the two priority calls share: not a number at all is ERR_INVALID_ARG_TYPE,
   * a number that is not a 32-bit integer is ERR_OUT_OF_RANGE, and a priority outside the host's
   * own -20..19 is ERR_OUT_OF_RANGE with that range named. A pid of undefined is the caller's own.
   */
  function priorityArgError(name, value, isPriority) {
    if (typeof value !== 'number') {
      var shown = typeof value === 'string' ? "'" + value + "'" : String(value);
      var typeErr = new TypeError('The "' + name + '" argument must be of type number. Received type ' + typeof value + ' (' + shown + ')');
      typeErr.code = 'ERR_INVALID_ARG_TYPE';
      return typeErr;
    }
    if (value !== (value | 0)) {
      var intErr = new RangeError('The value of "' + name + '" is out of range. It must be an integer. Received ' + value);
      intErr.code = 'ERR_OUT_OF_RANGE';
      return intErr;
    }
    if (isPriority === true && (value < -20 || value > 19)) {
      var rangeErr = new RangeError('The value of "' + name + '" is out of range. It must be >= -20 && <= 19. Received ' + value);
      rangeErr.code = 'ERR_OUT_OF_RANGE';
      return rangeErr;
    }
    return null;
  }
  var errno = {
    E2BIG: 7, EACCES: 13, EADDRINUSE: 98, EADDRNOTAVAIL: 99, EAFNOSUPPORT: 97, EAGAIN: 11,
    EALREADY: 114, EBADF: 9, EBADMSG: 74, EBUSY: 16, ECANCELED: 125, ECHILD: 10,
    ECONNABORTED: 103, ECONNREFUSED: 111, ECONNRESET: 104, EDEADLK: 35, EDESTADDRREQ: 89,
    EDOM: 33, EDQUOT: 122, EEXIST: 17, EFAULT: 14, EFBIG: 27, EHOSTUNREACH: 113, EIDRM: 43,
    EILSEQ: 84, EINPROGRESS: 115, EINTR: 4, EINVAL: 22, EIO: 5, EISCONN: 106, EISDIR: 21,
    ELOOP: 40, EMFILE: 24, EMLINK: 31, EMSGSIZE: 90, EMULTIHOP: 72, ENAMETOOLONG: 36,
    ENETDOWN: 100, ENETRESET: 102, ENETUNREACH: 101, ENFILE: 23, ENOBUFS: 105, ENODATA: 61,
    ENODEV: 19, ENOENT: 2, ENOEXEC: 8, ENOLCK: 37, ENOLINK: 67, ENOMEM: 12, ENOMSG: 42,
    ENOPROTOOPT: 92, ENOSPC: 28, ENOSR: 63, ENOSTR: 60, ENOSYS: 38, ENOTCONN: 107, ENOTDIR: 20,
    ENOTEMPTY: 39, ENOTSOCK: 88, ENOTSUP: 95, ENOTTY: 25, ENXIO: 6, EOPNOTSUPP: 95,
    EOVERFLOW: 75, EPERM: 1, EPIPE: 32, EPROTO: 71, EPROTONOSUPPORT: 93, EPROTOTYPE: 91,
    ERANGE: 34, EROFS: 30, ESPIPE: 29, ESRCH: 3, ESTALE: 116, ETIME: 62, ETIMEDOUT: 110,
    ETXTBSY: 26, EWOULDBLOCK: 11, EXDEV: 18
  };
  return {
    EOL: '\n',
    devNull: '/dev/null',
    platform: function () { return 'linux'; },
    type: function () { return 'Linux'; },
    arch: function () { return 'x64'; },
    release: function () { return '6.0.0'; },
    hostname: function () { return 'localhost'; },
    homedir: function () { return (globalThis.process && process.env.HOME) || '/home'; },
    /*
     * Node reads TMPDIR fresh on every call, so a process that sets it and then asks sees its own
     * value from that point on, and falls back to TMP, TEMP and then /tmp. A fixed /tmp answered
     * the value the environment happened to carry at boot and nothing after it.
     */
    tmpdir: function () {
      var env = (globalThis.process && process.env) || {};
      var path = env.TMPDIR || env.TMP || env.TEMP || '/tmp';
      while (path.length > 1 && path.charAt(path.length - 1) === '/') path = path.slice(0, -1);
      return path;
    },
    endianness: function () { return 'LE'; },
    /*
     * One entry per cpu the machine under the container has, which is what a container sees: it is
     * not given cpus of its own. The count is the host's navigator.hardwareConcurrency, asked for
     * through the bridge, so os.cpus().length and os.availableParallelism() agree with it and
     * with each other, as they do on the host. An empty list, which this was, makes a package that
     * divides by the cpu count divide by zero and one that sizes a worker pool by it size it at 0.
     */
    cpus: function () {
      var count = host.cpuCount();
      var out = [];
      for (var i = 0; i < count; i++) {
        out.push({
          model: 'OpenWebContainer virtual cpu',
          speed: 2400,
          times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 }
        });
      }
      return out;
    },
    availableParallelism: function () { return host.cpuCount(); },
    /* os.version is the release string uname -v prints; os.machine is what uname -m prints, which
       for this container's own architecture (x64, the process.arch it reports) is x86_64. */
    version: function () { return '#1 SMP PREEMPT_DYNAMIC Mon Jan 1 00:00:00 UTC 2024'; },
    machine: function () { return 'x86_64'; },
    totalmem: function () { return 4294967296; },
    freemem: function () { return 2147483648; },
    /*
     * System uptime, which for this container is how long it has been up: there is no host behind
     * it to ask, and a flat 0 -- which this was -- is the one answer no host ever gives, so a
     * package that divides by it divides by zero and one that prints it prints "0 seconds".
     */
    uptime: function () {
      var proc = globalThis.process;
      return proc && typeof proc.uptime === 'function' ? proc.uptime() : 0;
    },
    loadavg: function () { return [0, 0, 0]; },
    /*
     * The loopback, which is the one interface every container and every host has and the only one
     * this container can name: its sockets are the host's, so there is no address of a network of
     * its own to report, but an empty map -- which this was -- leaves a package that picks an
     * address out of it, or counts the machine's interfaces, with nothing where a host has eleven
     * entries. 127.0.0.1 and ::1 are marked internal, as a host marks lo0, and carry the netmask,
     * family and cidr a host's entries carry, so the shape read out of the map is the host's shape.
     */
    networkInterfaces: function () {
      return {
        lo: [
          { address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', mac: '00:00:00:00:00:00',
            internal: true, cidr: '127.0.0.1/8' },
          { address: '::1', netmask: 'ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', family: 'IPv6',
            mac: '00:00:00:00:00:00', internal: true, cidr: '::1/128', scopeid: 0 }
        ]
      };
    },
    /*
     * os.getPriority and os.setPriority read and write the nice value of a process. This runtime
     * has no scheduler of its own and cannot ask about another process, so the answer is the one a
     * host gives for a process that has never been reniced: 0, and a set that changes nothing.
     * What is not shimmed is the argument checking -- a pid has to be a 32-bit integer and a
     * priority has to sit in the range the host's own does, with the host's wording for both --
     * because a program that validates against a real host validates against those messages.
     */
    getPriority: function (pid) {
      var value = pid === undefined ? 0 : pid;
      var err = priorityArgError('pid', value, false);
      if (err !== null) throw err;
      return 0;
    },
    setPriority: function (pid, priorityValue) {
      var err = priorityArgError('pid', pid === undefined ? 0 : pid, false);
      if (err !== null) throw err;
      if (priorityValue === undefined) return undefined;
      err = priorityArgError('priority', priorityValue, true);
      if (err !== null) throw err;
      return undefined;
    },
    userInfo: function () { return { username: 'user', uid: 1000, gid: 1000, shell: '/bin/sh', homedir: '/home' }; },
    constants: {
      UV_UDP_REUSEADDR: 4,
      dlopen: dlopen,
      errno: errno,
      priority: priority,
      signals: signals
    }
  };
};

BF.timers = function () {
  return {
    setTimeout: setTimeoutImpl,
    clearTimeout: clearTimer,
    setInterval: setIntervalImpl,
    clearInterval: clearTimer,
    setImmediate: setImmediateImpl,
    clearImmediate: clearTimer,
    /*
     * Node hangs the promise form off the callback module itself -- timers.promises *is* the
     * node:timers/promises namespace, and a program that compares the two, or reaches setTimeout
     * through either, sees one object. It is asked for through requireBuiltin, which caches, so
     * the identity a host has between the two holds here.
     */
    promises: requireBuiltin('timers/promises')
  };
};

BF['timers/promises'] = function () {
  function Scheduler() {}
  Scheduler.prototype.wait = function (delay, options) {
    return new Promise(function (resolve) {
      setTimeoutImpl(function () { resolve(undefined); }, delay);
    });
  };
  Scheduler.prototype.yield = function () {
    return new Promise(function (resolve) {
      setImmediateImpl(function () { resolve(undefined); });
    });
  };
  /* one value per interval tick; ticks that elapse while the consumer is busy are yielded in turn */
  async function* intervalValues(delay, value) {
    var pending = 0;
    var wake = null;
    var handle = setIntervalImpl(function () {
      pending++;
      if (wake !== null) {
        var resume = wake;
        wake = null;
        resume();
      }
    }, delay);
    try {
      while (true) {
        if (pending === 0) {
          await new Promise(function (resolve) { wake = resolve; });
        }
        while (pending > 0) {
          pending--;
          yield value;
        }
      }
    } finally {
      clearTimer(handle);
    }
  }
  return {
    setTimeout: function (ms, value) {
      return new Promise(function (resolve) {
        setTimeoutImpl(function () { resolve(value); }, ms);
      });
    },
    setImmediate: function (value) {
      return new Promise(function (resolve) {
        setImmediateImpl(function () { resolve(value); });
      });
    },
    setInterval: function (delay, value) {
      return intervalValues(delay, value);
    },
    scheduler: new Scheduler()
  };
};

BF.url = function () {
  var P = requireBuiltin('path');

  var HEX = '0123456789ABCDEF';

  /* the UTF-8 bytes of one code point, each as '%XX' */
  function pctCodePoint(cp) {
    var bytes;
    if (cp < 0x80) bytes = [cp];
    else if (cp < 0x800) bytes = [0xc0 | (cp >> 6), 0x80 | (cp & 0x3f)];
    else if (cp < 0x10000) bytes = [0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f)];
    else bytes = [0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f)];
    var out = '';
    for (var i = 0; i < bytes.length; i++) out += '%' + HEX.charAt(bytes[i] >> 4) + HEX.charAt(bytes[i] & 0xf);
    return out;
  }

  /* the UTF-8 bytes of one UTF-16 code unit */
  function utf8Flat(cp) {
    if (cp < 0x80) return [cp];
    if (cp < 0x800) return [0xc0 | (cp >> 6), 0x80 | (cp & 0x3f)];
    return [0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f)];
  }

  /*
   * UTF-8 decode with replacement: a byte that cannot start a sequence, a sequence cut short, an
   * overlong one, a surrogate or one past the last code point is each one U+FFFD, which is what
   * makes 'a=%C3' the value '�' rather than the escape '%C3' written back out.
   */
  function utf8Decode(bytes) {
    var out = '';
    var i = 0;
    while (i < bytes.length) {
      var b = bytes[i];
      var need, cp, min;
      if (b < 0x80) { out += String.fromCharCode(b); i++; continue; }
      if (b >= 0xc2 && b <= 0xdf) { need = 1; cp = b & 0x1f; min = 0x80; }
      else if (b >= 0xe0 && b <= 0xef) { need = 2; cp = b & 0x0f; min = 0x800; }
      else if (b >= 0xf0 && b <= 0xf4) { need = 3; cp = b & 0x07; min = 0x10000; }
      else { out += '�'; i++; continue; }
      /*
       * The second byte of a sequence has a range of its own -- 'E0' takes A0..BF and 'ED' takes
       * 80..9F, because the sequences either side of them would otherwise spell an overlong form or
       * a surrogate -- and a byte outside it ends the sequence there.
       */
      var low2 = 0x80;
      var high2 = 0xbf;
      if (b === 0xe0) low2 = 0xa0;
      else if (b === 0xed) high2 = 0x9f;
      else if (b === 0xf0) low2 = 0x90;
      else if (b === 0xf4) high2 = 0x8f;
      var ok = true;
      var eaten = need;
      for (var j = 1; j <= need; j++) {
        var c = bytes[i + j];
        if (c === undefined) { ok = false; eaten = j; break; }
        if (c < (j === 1 ? low2 : 0x80) || c > (j === 1 ? high2 : 0xbf)) { ok = false; eaten = j; break; }
        cp = (cp << 6) | (c & 0x3f);
      }
      /*
       * A sequence that will not finish is one U+FFFD and no more, and the byte that ended it is
       * read again as the start of the next one: 'a=%E0%A4%A' is the value '�' + 'A' and not
       * the two replacements the bytes of the broken sequence would each be.
       */
      if (!ok) { out += '�'; i += eaten; continue; }
      if (cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) { out += '�'; i += need + 1; continue; }
      out += String.fromCodePoint(cp);
      i += need + 1;
    }
    return out;
  }

  function isHexPair(text, at) {
    return /^[0-9A-Fa-f]{2}$/.test(text.substr(at, 2));
  }

  /* the bytes a literal character contributes; a '+' is a space, as in a form body */
  function literalBytes(code) {
    if (code === 0x2b) return [0x20];
    if (code >= 0xd800 && code <= 0xdfff) return [0xef, 0xbf, 0xbd];
    return utf8Flat(code);
  }

  function decodeComponent(s) {
    var text = String(s);
    var bytes = [];
    var i = 0;
    while (i < text.length) {
      /* a '%' that does not introduce two hex digits is itself: 'b%c' stays 'b%c' */
      if (text.charAt(i) === '%' && i + 2 < text.length && isHexPair(text, i + 1)) {
        bytes.push(parseInt(text.substr(i + 1, 2), 16));
        i += 3;
        continue;
      }
      var more = literalBytes(text.charCodeAt(i));
      for (var k = 0; k < more.length; k++) bytes.push(more[k]);
      i++;
    }
    return utf8Decode(bytes);
  }

  /*
   * The application/x-www-form-urlencoded serializer: every byte of the UTF-8 encoding is '%XX'
   * but an ASCII letter or digit, '*', '-', '.' and '_', and a space, which is '+'. '!' ''' '(' ')'
   * '~' are escaped -- encodeURIComponent leaves them alone, which is what left them bare.
   */
  function encodeComponent(s) {
    var text = String(s);
    var out = '';
    for (var i = 0; i < text.length; i++) {
      var code = text.charCodeAt(i);
      if (code === 0x20) { out += '+'; continue; }
      if ((code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a) ||
        code === 0x2a || code === 0x2d || code === 0x2e || code === 0x5f) {
        out += text.charAt(i);
        continue;
      }
      /* a half of a surrogate pair is read with the half behind it; a lone one is U+FFFD */
      var next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
      if (code >= 0xd800 && code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
        out += pctCodePoint(0x10000 + (code - 0xd800) * 0x400 + (next - 0xdc00));
        i++;
        continue;
      }
      if (code >= 0xd800 && code <= 0xdfff) { out += '%EF%BF%BD'; continue; }
      out += pctCodePoint(code);
    }
    return out;
  }

  /* The pairs a caller stores: an own property in this runtime's own implementation, but not one
     Node's shows -- Object.keys, JSON.stringify and for-in of a URLSearchParams are all empty. */
  function quoteString(text) {
    return "'" + String(text).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
  }

  /* The pairs live in a side map rather than in an own property: Node's params object carries no
     own properties at all, and Object.getOwnPropertyNames of one is empty. */
  var PAIRS = new WeakMap();

  function listOf(self) {
    var list = PAIRS.get(self);
    return list === undefined ? [] : list;
  }

  function initList(self) {
    PAIRS.set(self, []);
    return PAIRS.get(self);
  }

  /* WebIDL's USVString: every value has a string form but a Symbol, so the conversion refuses it. */
  function usvString(v) {
    if (typeof v === 'symbol') throw new TypeError('Cannot convert a Symbol value to a string');
    return String(v);
  }

  function URLSearchParams(init) {
    var list = initList(this);
    if (init !== undefined && init !== null && typeof init === 'object') {
      if (typeof init[Symbol.iterator] === 'function') {
        /* A sequence of pairs: an array of [name, value] tuples, another URLSearchParams, a Map, or
           anything else iterable. Each item has to be an iterable of exactly two values -- and a
           string is not one of those, so ['ab'] is refused the way Node refuses it. */
        var iter = init[Symbol.iterator]();
        var step = iter.next();
        while (!step.done) {
          var item = step.value;
          var pair = [];
          if (item !== undefined && item !== null && typeof item !== 'string' &&
            typeof item[Symbol.iterator] === 'function') {
            var inner = item[Symbol.iterator]();
            var part = inner.next();
            while (!part.done) { pair.push(part.value); part = inner.next(); }
          }
          if (pair.length !== 2) throw new TypeError('Each query pair must be an iterable [name, value] tuple');
          list.push([usvString(pair[0]), usvString(pair[1])]);
          step = iter.next();
        }
        return;
      }
      var keys = Object.keys(init);
      for (var j = 0; j < keys.length; j++) list.push([keys[j], usvString(init[keys[j]])]);
      return;
    }
    /* Anything else is a USVString, coerced and then parsed as a query string: 'new
       URLSearchParams(0)' holds the one pair ['0', '']. A null or an absent argument is the
       default empty string, so both hold nothing -- Node answers size 0 for each. */
    var s = (init === undefined || init === null) ? '' : usvString(init);
    if (s.charAt(0) === '?') s = s.slice(1);
    if (s.length) {
      var pairs = s.split('&');
      for (var i = 0; i < pairs.length; i++) {
        if (!pairs[i]) continue;
        var idx = pairs[i].indexOf('=');
        var k = idx >= 0 ? pairs[i].slice(0, idx) : pairs[i];
        var v = idx >= 0 ? pairs[i].slice(idx + 1) : '';
        list.push([decodeComponent(k), decodeComponent(v)]);
      }
    }
  }
  /* the list as the methods read it, off the prototype and out of the instance's own names */
  Object.defineProperty(URLSearchParams.prototype, '_list', {
    get: function () { return listOf(this); },
    set: function (list) { PAIRS.set(this, list); },
    configurable: true
  });
  URLSearchParams.prototype.append = function (k, v) {
    this._list.push([usvString(k), usvString(v)]);
  };
  URLSearchParams.prototype.set = function (k, v) {
    var key = usvString(k);
    var value = usvString(v);
    var found = false;
    var out = [];
    for (var i = 0; i < this._list.length; i++) {
      if (this._list[i][0] === key) {
        if (!found) out.push([key, String(v)]);
        found = true;
      } else {
        out.push(this._list[i]);
      }
    }
    if (!found) out.push([key, String(v)]);
    this._list = out;
  };
  URLSearchParams.prototype.get = function (k) {
    for (var i = 0; i < this._list.length; i++) {
      if (this._list[i][0] === String(k)) return this._list[i][1];
    }
    return null;
  };
  URLSearchParams.prototype.getAll = function (k) {
    return this._list.filter(function (pair) { return pair[0] === String(k); }).map(function (pair) { return pair[1]; });
  };
  URLSearchParams.prototype.has = function (k) {
    return this._list.some(function (pair) { return pair[0] === String(k); });
  };
  URLSearchParams.prototype.delete = function (k) {
    this._list = this._list.filter(function (pair) { return pair[0] !== String(k); });
  };
  URLSearchParams.prototype.forEach = function (cb, thisArg) {
    for (var i = 0; i < this._list.length; i++) cb.call(thisArg, this._list[i][1], this._list[i][0], this);
  };
  /* WHATWG url: the three iterators hand out an iterator, not an array -- that is what makes a
     URLSearchParams spreadable, and what for..of walks. */
  /* WHATWG url: the three iterators walk the live list, so a pair appended after one was made is
     still reached by it -- Node answers ['a', 'b'] where a snapshot taken at call time answers
     ['a']. */
  function pairIterator(self, kind) {
    var at = 0;
    var it = {
      next: function () {
        var list = listOf(self);
        if (at >= list.length) return { value: undefined, done: true };
        var pair = list[at++];
        return { value: kind === 0 ? pair[0] : (kind === 1 ? pair[1] : [pair[0], pair[1]]), done: false };
      }
    };
    it[Symbol.iterator] = function () { return it; };
    return it;
  }
  URLSearchParams.prototype.keys = function () { return pairIterator(this, 0); };
  URLSearchParams.prototype.values = function () { return pairIterator(this, 1); };
  URLSearchParams.prototype.entries = function () { return pairIterator(this, 2); };
  URLSearchParams.prototype[Symbol.iterator] = URLSearchParams.prototype.entries;
  /* WHATWG url: size is the number of pairs, a getter over the list rather than a field on it. */
  Object.defineProperty(URLSearchParams.prototype, 'size', {
    get: function () { return this._list.length; },
    configurable: true
  });
  /* What Node prints for a params object: each pair as name => value, and nothing but braces when
     there are none. */
  var USP_INSPECT = typeof Symbol.for === 'function' ? Symbol.for('nodejs.util.inspect.custom') : undefined;
  if (USP_INSPECT !== undefined) {
    Object.defineProperty(URLSearchParams.prototype, USP_INSPECT, {
      value: function () {
        var shown = '';
        for (var i = 0; i < this._list.length; i++) {
          shown += (i === 0 ? '' : ', ') + quoteString(this._list[i][0]) + ' => ' + quoteString(this._list[i][1]);
        }
        return 'URLSearchParams {' + (shown === '' ? '' : ' ' + shown + ' ') + '}';
      },
      writable: true, configurable: true
    });
  }
  Object.defineProperty(URLSearchParams.prototype, Symbol.toStringTag, { value: 'URLSearchParams', configurable: true });
  URLSearchParams.prototype.toString = function () {
    return this._list.map(function (pair) { return encodeComponent(pair[0]) + '=' + encodeComponent(pair[1]); }).join('&');
  };
  /* WHATWG url: sort is a stable sort on the name of each pair, comparing code units. */
  URLSearchParams.prototype.sort = function () {
    this._list.sort(function (a, b) { return a[0] < b[0] ? -1 : (a[0] > b[0] ? 1 : 0); });
  };
  /* Node's own order: size first among the methods, the mutators next, then the iterators and
     toString; and among the symbols its inspect hook, then the tag, then the iterator. Deleting
     and re-adding is what rewrites an order that was already written. */
  ['size', 'append', 'delete', 'get', 'getAll', 'has', 'set', 'sort', 'entries', 'forEach',
   'keys', 'values', 'toString'].forEach(function (name) {
    var desc = Object.getOwnPropertyDescriptor(URLSearchParams.prototype, name);
    if (desc === undefined) return;
    delete URLSearchParams.prototype[name];
    Object.defineProperty(URLSearchParams.prototype, name, desc);
  });
  [USP_INSPECT, Symbol.toStringTag, Symbol.iterator].forEach(function (sym) {
    if (sym === undefined) return;
    var desc = Object.getOwnPropertyDescriptor(URLSearchParams.prototype, sym);
    if (desc === undefined) return;
    delete URLSearchParams.prototype[sym];
    Object.defineProperty(URLSearchParams.prototype, sym, desc);
  });

  /* WHATWG url: a path is resolved by removing its dot segments (RFC 3986 5.2.4). A percent-encoded
     dot segment counts as one, but the segment is written back as the caller encoded it. */
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

  var SCHEME_RE = /^([A-Za-z][A-Za-z0-9+.\-]*:)/;
  /*
   * A bracketed IPv6 literal is one host, brackets and all, so it is read whole and the ':' inside
   * it is never taken for the start of a port -- which is what left 'http://[::1]:99/a' as the host
   * '[' with the path ':1]:99/a' behind it.
   */
  var AUTHORITY_RE = /^([A-Za-z][A-Za-z0-9+.\-]*:)(\/\/(?:([^:@\/?#]*)(?::([^@\/?#]*))?@)?(\[[^\]\/?#]*\]|[^:\/?#]*)(?::(\d*))?)?([^?#]*)(\?[^#]*)?(#.*)?$/;

  function invalidUrl(input) {
    var err = new TypeError('Invalid URL');
    err.code = 'ERR_INVALID_URL';
    err.input = input;
    return err;
  }

  function URL(input, base) {
    var str = String(input).trim();
    if (!SCHEME_RE.test(str)) {
      if (base === undefined) throw invalidUrl(str);
      var b = base instanceof URL ? base : new URL(String(base));
      str = resolveAgainst(b, str);
    }
    var m = AUTHORITY_RE.exec(str);
    if (!m) throw invalidUrl(String(input));
    this.protocol = m[1].toLowerCase();
    var authority = m[2] !== undefined;
    this.username = authority ? (m[3] || '') : '';
    this.password = authority ? (m[4] || '') : '';
    var written = authority ? (m[5] || '') : '';
    /* hostname carries the address without its brackets; host writes them back */
    if (written.charAt(0) === '[' && written.charAt(written.length - 1) === ']') {
      written = written.slice(1, written.length - 1);
    }
    /* a host is IDNA: 'пример.рф' is the host 'xn--e1afmkfd.xn--p1ai', as it is in Node */
    this.hostname = written === '' ? '' : domainToASCII(written);
    /*
     * The port stays exactly as it was written. The WHATWG parser drops a port that is the scheme's
     * own default, but url.parse reports '80' for 'http://h:80/' and 'h:80' as its host.
     */
    this.port = authority && m[6] ? m[6] : '';
    this.pathname = removeDotSegments(m[7] !== undefined && m[7] !== '' ? m[7] : (authority ? '/' : ''));
    this.search = m[8] && m[8].length > 1 ? m[8] : '';
    this.hash = m[9] && m[9].length > 1 ? m[9] : '';
    this.searchParams = new URLSearchParams(this.search);
  }

  function resolveAgainst(base, rel) {
    // origin is the string 'null' for file: URLs, so the prefix is rebuilt from protocol and host
    var prefix = base.protocol + '//' + base.host;
    if (rel.indexOf('//') === 0) return base.protocol + rel;
    if (rel.charAt(0) === '/') return prefix + rel;
    if (rel.charAt(0) === '?') return prefix + base.pathname + rel;
    if (rel.charAt(0) === '#') return prefix + base.pathname + base.search + rel;
    // a base path that ends in '/' names a directory, so the reference is appended inside it;
    // only otherwise is the last segment the file to be replaced (WHATWG URL, reference resolution)
    if (base.pathname.charAt(base.pathname.length - 1) === '/') return prefix + P.join(base.pathname, rel);
    return prefix + P.join(P.dirname(base.pathname), rel);
  }

  Object.defineProperty(URL.prototype, 'host', {
    get: function () {
      var name = this.hostname.indexOf(':') >= 0 ? '[' + this.hostname + ']' : this.hostname;
      return name + (this.port ? ':' + this.port : '');
    }
  });
  Object.defineProperty(URL.prototype, 'origin', {
    get: function () { return this.protocol === 'file:' ? 'null' : this.protocol + '//' + this.host; }
  });
  Object.defineProperty(URL.prototype, 'href', {
    get: function () {
      var auth = '';
      if (this.hostname || this.protocol === 'file:' || this.protocol === 'http:' || this.protocol === 'https:') {
        var userinfo = this.username ? this.username + (this.password ? ':' + this.password : '') + '@' : '';
        auth = '//' + userinfo + this.host;
      }
      /* the query as it was written, not as the params re-serialise it: a '?' carrying no '=' is
         '?q' in href, where the params would write '?q=' */
      return this.protocol + auth + this.pathname + this.search + this.hash;
    }
  });
  URL.prototype.toString = function () { return this.href; };
  URL.prototype.toJSON = function () { return this.href; };
  URL.canParse = function (input, base) {
    try {
      new URL(input, base);
      return true;
    } catch (err) {
      return false;
    }
  };

  /*
   * IDNA: punycode (RFC 3492) over one label, and the two domain functions Node's url module hands
   * out beside it. A domain is a run of dot-separated labels, each mapped on its own -- NFC and
   * case-folded, the way UTS-46 maps it -- and any label that will not map makes the whole domain
   * the empty string, which is what Node answers for a domain it cannot turn into ASCII.
   */
  var PUNY_BASE = 36, PUNY_TMIN = 1, PUNY_TMAX = 26, PUNY_SKEW = 38, PUNY_DAMP = 700;
  var PUNY_INITIAL_N = 128, PUNY_INITIAL_BIAS = 72, PUNY_MAX = 0x10FFFF;

  function punyAdapt(delta, numPoints, firstTime) {
    delta = firstTime ? Math.floor(delta / PUNY_DAMP) : Math.floor(delta / 2);
    delta += Math.floor(delta / numPoints);
    var k = 0;
    while (delta > Math.floor((PUNY_BASE - PUNY_TMIN) * PUNY_TMAX / 2)) {
      delta = Math.floor(delta / (PUNY_BASE - PUNY_TMIN));
      k += PUNY_BASE;
    }
    return k + Math.floor((PUNY_BASE - PUNY_TMIN + 1) * delta / (delta + PUNY_SKEW));
  }

  function punyDigitToBasic(digit) {
    return digit + 22 + 75 * (digit < 26 ? 1 : 0);
  }

  function punyBasicToDigit(code) {
    if (code - 48 < 10) return code - 22;
    if (code - 65 < 26) return code - 65;
    if (code - 97 < 26) return code - 97;
    return PUNY_BASE;
  }

  function punyEncode(text) {
    var input = [];
    for (var i = 0; i < text.length; i++) input.push(text.codePointAt(i));
    var output = [];
    var n = PUNY_INITIAL_N, delta = 0, bias = PUNY_INITIAL_BIAS;
    var h = 0, b = 0, j, k, q, t, m;
    for (j = 0; j < input.length; j++) if (input[j] < 0x80) output.push(String.fromCharCode(input[j]));
    h = b = output.length;
    if (b > 0) output.push('-');
    while (h < input.length) {
      m = PUNY_MAX;
      for (j = 0; j < input.length; j++) if (input[j] >= n && input[j] < m) m = input[j];
      delta += (m - n) * (h + 1);
      n = m;
      for (j = 0; j < input.length; j++) {
        if (input[j] < n) delta++;
        if (input[j] !== n) continue;
        q = delta;
        for (k = PUNY_BASE; ; k += PUNY_BASE) {
          t = k <= bias + PUNY_TMIN ? PUNY_TMIN : (k >= bias + PUNY_TMAX ? PUNY_TMAX : k - bias);
          if (q < t) break;
          output.push(String.fromCharCode(punyDigitToBasic(t + (q - t) % (PUNY_BASE - t))));
          q = Math.floor((q - t) / (PUNY_BASE - t));
        }
        output.push(String.fromCharCode(punyDigitToBasic(q)));
        bias = punyAdapt(delta, h + 1, h === b);
        delta = 0;
        h++;
      }
      delta++;
      n++;
    }
    return output.join('');
  }

  function punyDecode(text) {
    var output = [];
    var n = PUNY_INITIAL_N, i = 0, bias = PUNY_INITIAL_BIAS, at = 0;
    var split = text.lastIndexOf('-');
    if (split > 0) {
      for (var j = 0; j < split; j++) output.push(text.charCodeAt(j));
      at = split + 1;
    }
    while (at < text.length) {
      var oldi = i;
      var w = 1;
      var k = PUNY_BASE;
      for (;;) {
        var digit = punyBasicToDigit(text.charCodeAt(at++));
        if (digit >= PUNY_BASE) throw invalidUrl(text);
        i += digit * w;
        var t = k <= bias + PUNY_TMIN ? PUNY_TMIN : (k >= bias + PUNY_TMAX ? PUNY_TMAX : k - bias);
        if (digit < t) break;
        w *= (PUNY_BASE - t);
        k += PUNY_BASE;
      }
      bias = punyAdapt(i - oldi, output.length + 1, oldi === 0);
      n += Math.floor(i / (output.length + 1));
      i = i % (output.length + 1);
      output.splice(i, 0, n);
      i++;
    }
    return output.map(function (code) { return String.fromCodePoint(code); }).join('');
  }

  function isAsciiLabel(text) {
    for (var i = 0; i < text.length; i++) if (text.charCodeAt(i) > 0x7f) return false;
    return true;
  }

  /* UTS-46 DISALLOWED, in the rough: a label holding a control or one of the C1 bytes is refused. */
  function idnaValid(text) {
    for (var i = 0; i < text.length; i++) {
      var code = text.codePointAt(i);
      if (code > 0xffff) i++;
      if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return false;
    }
    return true;
  }

  function mapLabel(label) {
    var folded = label.toLowerCase();
    return typeof folded.normalize === 'function' ? folded.normalize('NFC') : folded;
  }

  function asciiLabelOf(label) {
    if (label.length >= 4 && label.slice(0, 4).toLowerCase() === 'xn--') {
      var inner = label.slice(4);
      if (inner === '') return null;
      var decoded;
      try { decoded = punyDecode(inner); } catch (notPunycode) { return null; }
      if (!idnaValid(decoded)) return null;
      var recoded = punyEncode(decoded);
      /* an escape that does not re-encode to itself is not a domain: 'xn--abc' is refused */
      if (recoded.toLowerCase() !== inner.toLowerCase()) return null;
      return 'xn--' + recoded;
    }
    var mapped = mapLabel(label);
    if (isAsciiLabel(mapped)) return mapped;
    if (!idnaValid(mapped)) return null;
    return 'xn--' + punyEncode(mapped);
  }

  /* whether every part is a number the IPv4 parser reads: decimal, hex behind 0x, or octal */
  var IPV4_PART_RE = /^(?:0[xX][0-9a-fA-F]+|0[0-7]*|[1-9][0-9]*)$/;

  function looksIpv4(text) {
    var parts = text.split('.');
    if (parts.length < 1 || parts.length > 4) return false;
    for (var i = 0; i < parts.length; i++) if (!IPV4_PART_RE.test(parts[i])) return false;
    return true;
  }

  /*
   * The IPv4 parser the URL parser uses: the last part covers every byte the earlier ones did not,
   * so '0x7f.1' is 127.0.0.1 and '2130706433' is 127.0.0.1 too, and a number past 2^32 is refused.
   */
  function parseIpv4(text) {
    var parts = text.split('.');
    var nums = [];
    for (var i = 0; i < parts.length; i++) {
      var part = parts[i];
      var radix = 10;
      if (part.length > 2 && part.charAt(0) === '0' && (part.charAt(1) === 'x' || part.charAt(1) === 'X')) {
        radix = 16;
        part = part.slice(2);
      } else if (part.length > 1 && part.charAt(0) === '0') {
        radix = 8;
        part = part.slice(1);
      }
      nums.push(parseInt(part, radix));
    }
    var last = nums.pop();
    var width = 4 - nums.length;
    if (!(last <= Math.pow(256, width) - 1)) return null;
    for (var j = 0; j < nums.length; j++) if (nums[j] > 255) return null;
    var tail = [];
    for (var k = 0; k < width; k++) { tail.unshift(last % 256); last = Math.floor(last / 256); }
    return nums.concat(tail).join('.');
  }

  /*
   * A domain is a run of dot-separated labels, each mapped on its own -- NFC and case-folded, the
   * way UTS-46 maps it -- and any label that will not map makes the whole domain the empty string,
   * which is what Node answers for a domain it cannot turn into ASCII.
   *
   * This is the mapping on its own, with no reading of a domain as an address beside it: the legacy
   * parser does not read one, so 'http://0x7f.1/' keeps the host '0x7f.1' it was written with where
   * the WHATWG parser writes '127.0.0.1'. Only the WHATWG parser, and domainToASCII itself, add the
   * IPv4 reading -- url.parse('http://0x7f.1/').host is '0x7f.1' in host Node, and url.parse is the
   * one caller here that must not have it.
   */
  function domainLabelsToASCII(domain) {
    var labels = String(domain).split('.');
    var out = [];
    for (var i = 0; i < labels.length; i++) {
      if (labels[i] === '') { out.push(''); continue; }
      var ascii = asciiLabelOf(labels[i]);
      if (ascii === null) return '';
      out.push(ascii);
    }
    return out.join('.');
  }

  /*
   * IDNA refuses what a browser would draw as nothing at all or as a break: the controls, the C1
   * block and every space separator -- the no-break space and the U+2000 run among them -- so a
   * domain carrying one is the empty string, as it is in Node. The whole of IDNA's derived-property
   * table, which is what tells 'a᠆b' from 'a٠b', is beyond this file: it is the one
   * reading of a domain that is still not Node's own.
   */
  /* '/', '?', '#' and the backslash: the four bytes that end the host of a URL, and so the domain */
  var TEXT_STOP = '/?#' + String.fromCharCode(92);

  function idnaSpaceCode(code) {
    return code === 0x20 || code === 0xa0 || code === 0x1680 ||
      (code >= 0x2000 && code <= 0x200a) ||
      code === 0x2028 || code === 0x2029 || code === 0x202f || code === 0x205f || code === 0x3000;
  }

  function idnaDisallowedIn(text) {
    for (var i = 0; i < text.length; i++) {
      var code = text.charCodeAt(i);
      if (code <= 0x20 || (code >= 0x7f && code <= 0x9f) || idnaSpaceCode(code)) return true;
    }
    return false;
  }

  function domainToASCII(domain) {
    var text = String(domain);
    if (text === '') return '';
    /*
     * Node reads a domain the way it would read the host of 'http://' written in front of it: a
     * '/', '?', '#' or '\' ends it -- 'x/y/z' is the domain 'x' -- and a ':' or an '@', which beside
     * a real host would name a port or a userinfo, is no domain at all.
     */
    var cut = text.length;
    for (var s = 0; s < 4; s++) {
      var found = text.indexOf(TEXT_STOP.charAt(s));
      if (found >= 0 && found < cut) cut = found;
    }
    if (cut >= 0 && cut < text.length) text = text.slice(0, cut);
    if (text.indexOf(':') >= 0 || text.indexOf('@') >= 0) return '';
    /*
     * An escape is decoded, as the parser decodes one -- '%41' is the domain 'a' -- and a '%' that
     * is not the start of an escape, or one the decoding left behind, is no domain: 'a%b' and
     * 'a%2541' are both the empty string.
     */
    var decoded = '';
    for (var p = 0; p < text.length; p++) {
      if (text.charAt(p) === '%') {
        if (p + 2 >= text.length || !isHexPair(text, p + 1)) return '';
        decoded += String.fromCharCode(parseInt(text.substr(p + 1, 2), 16));
        p += 2;
        continue;
      }
      decoded += text.charAt(p);
    }
    if (decoded.indexOf('%') >= 0) return '';
    text = decoded;
    /* the tab, the line feed and the carriage return are mapped to nothing, as UTS-46 maps them */
    text = text.replace(/[\t\n\r]/g, '');
    if (idnaDisallowedIn(text)) return '';
    /* Node reads a domain that is a number as the address it names: 123 is '0.0.0.123', and one
       too large for an address is no domain at all, which is the empty string. */
    if (looksIpv4(text)) {
      var address = parseIpv4(text);
      return address === null ? '' : address;
    }
    return domainLabelsToASCII(text);
  }

  function domainToUnicode(domain) {
    var text = String(domain);
    if (text === '') return '';
    var labels = text.split('.');
    var out = [];
    for (var i = 0; i < labels.length; i++) {
      var label = labels[i];
      if (label.length >= 4 && label.slice(0, 4).toLowerCase() === 'xn--') {
        var inner = label.slice(4);
        if (inner === '') return '';
        var decoded;
        try { decoded = punyDecode(inner); } catch (notPunycode) { return ''; }
        if (!idnaValid(decoded)) return '';
        if (punyEncode(decoded).toLowerCase() !== inner.toLowerCase()) return '';
        out.push(decoded);
        continue;
      }
      out.push(label);
    }
    return out.join('.');
  }

  function fileURLToPath(u) {
    var parsed = typeof u === 'string' ? new URL(u) : (u instanceof URL || u instanceof urlModule.URL ? u : new URL(String(u.href)));
    if (parsed.protocol !== 'file:') {
      var err = new TypeError('The URL must be of scheme file');
      err.code = 'ERR_INVALID_URL_SCHEME';
      throw err;
    }
    /*
     * A file: URL names no host but 'localhost', which names none at all. Node words the refusal
     * with the platform under it, and the platform this runtime reports is its own.
     */
    if (parsed.hostname !== '' && parsed.hostname !== 'localhost') {
      var hostErr = new TypeError(
        'File URL host must be "localhost" or empty on ' + requireBuiltin('os').platform());
      hostErr.code = 'ERR_INVALID_FILE_URL_HOST';
      throw hostErr;
    }
    /*
     * An encoded '/' is not a separator: 'file:///a%2Fb' names one file whose name holds a slash,
     * so Node refuses it rather than handing back the two-segment path '/a/b'.
     */
    if (/%2f/i.test(parsed.pathname)) {
      var slashErr = new TypeError('File URL path must not include encoded / characters');
      slashErr.code = 'ERR_INVALID_FILE_URL_PATH';
      throw slashErr;
    }
    return decodeURIComponent(parsed.pathname);
  }

  function pathToFileURL(p) {
    var text = String(p);
    var sep = P.sep || '/';
    var resolved = P.resolve(text);
    /*
     * resolve drops the slash a path ended on, and that slash is what said the path was a
     * directory, so it is put back: '/a/' is the URL 'file:///a/' and not 'file:///a'.
     */
    if (text.charAt(text.length - 1) === sep && resolved.charAt(resolved.length - 1) !== sep) resolved += sep;
    /*
     * A path is written into the URL component by component, so a '#' and a '?' of its own are
     * escaped: both end a URL's path and start its fragment or query, so '/a#b' is the file
     * '/a#b' and not the file '/a' carrying the fragment '#b'. encodeURI does the rest -- a space
     * is '%20' and 'ü' is '%C3%BC'.
     *
     * The class is read off the module rather than captured: require('url').URL and the global URL
     * are one class in Node, so the URL this hands back is the one a caller's 'instanceof URL'
     * recognises -- the same one the bootstrap puts on the module once the globals are built.
     */
    return new (urlModule.URL)('file://' + encodeURI(resolved).replace(/#/g, '%23').replace(/\?/g, '%3F'));
  }

  /* the options an http.request takes, read off a URL: the parts as Node words them, with a port
     only where one was written and an auth only where a userinfo was */
  function urlToHttpOptions(u) {
    var parsed = u instanceof URL ? u : new URL(String(u && typeof u === 'object' ? u.href : u));
    var options = {
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      hash: parsed.hash,
      search: parsed.search,
      pathname: parsed.pathname,
      path: parsed.pathname + parsed.search,
      href: parsed.href
    };
    if (parsed.port !== '') options.port = Number(parsed.port);
    if (parsed.username !== '' || parsed.password !== '') {
      options.auth = parsed.username + (parsed.password !== '' ? ':' + parsed.password : '');
    }
    return options;
  }

  /*
   * The tables Node's legacy parser reads, and the two shapes it decides between. A slashed scheme
   * carries its authority behind '//' and holds nothing but a path without it; any other scheme --
   * mailto:, foo:, data: -- takes the text right after the colon as its authority whether the two
   * slashes were written or not, which is what makes url.parse('mailto:x@y').host 'y' while
   * url.parse('http:x@y').host is null. javascript: is the one scheme that never has a host, and
   * the one whose text is left unescaped. The slashed table is read with the scheme as it was
   * written, case and all, so 'HTTP:x@y' has a host in Node where 'http:x@y' has none.
   */
  var SLASHED_SCHEME = { 'http:': true, 'https:': true, 'ftp:': true, 'gopher:': true, 'file:': true, 'ws:': true, 'wss:': true };
  var HOSTLESS_SCHEME = { 'javascript:': true };
  var UNSAFE_SCHEME = { 'javascript:': true };
  var LEGACY_SCHEME_RE = /^[A-Za-z0-9.+-]+:/;
  /* '//user@host' with no scheme at all still denotes a host, the way a browser resolves one */
  var LEGACY_HOST_RE = /^\/\/[^@/?#]+@[^@/?#]+/;
  var LEGACY_PORT_RE = /:[0-9]*$/;
  /* a byte no host may hold, from RFC 2396 -- the ones the parser moves out of the host and into
     the path rather than refusing the URL */
  var NON_HOST_CHARS = ' "%\';<>\\^' + String.fromCharCode(96) + '{|}';
  var FORBIDDEN_HOST_CHARS = '\u0000"%<>[\\]^' + String.fromCharCode(96) + '{|}';
  /* an IPv6 literal keeps its brackets, so those two are not among the bytes it may not hold */
  var FORBIDDEN_IPV6_CHARS = '\u0000"%<>\\^' + String.fromCharCode(96) + '{|}';
  /*
   * The bytes Node escapes in a path of its own accord, and the ones it leaves alone in a userinfo:
   * an unreserved byte, a sub-delim of the few it keeps, and the ':' that separates a name from a
   * password -- everything else in an auth is written as an escape, so 'a@b' is 'a%40b'.
   */
  var AUTO_ESCAPE = { 9: '%09', 10: '%0A', 13: '%0D', 32: '%20', 34: '%22', 39: '%27',
    60: '%3C', 62: '%3E', 92: '%5C', 94: '%5E', 96: '%60', 123: '%7B', 124: '%7C', 125: '%7D' };
  var NO_ESCAPE_AUTH = '!\'()*-._~:';

  function autoEscapeStr(text) {
    var out = '';
    for (var i = 0; i < text.length; i++) {
      var esc = AUTO_ESCAPE[text.charCodeAt(i)];
      out += esc === undefined ? text.charAt(i) : esc;
    }
    return out;
  }

  function authCharKept(code) {
    return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) ||
      NO_ESCAPE_AUTH.indexOf(String.fromCharCode(code)) >= 0;
  }

  function encodeAuth(text) {
    var out = '';
    for (var i = 0; i < text.length; i++) {
      var ch = text.charAt(i);
      if (authCharKept(text.charCodeAt(i))) out += ch;
      else {
        try { out += encodeURIComponent(ch); } catch (loneSurrogate) { out += ch; }
      }
    }
    return out;
  }

  function isIpv6Hostname(name) {
    return name.charAt(0) === '[' && name.charAt(name.length - 1) === ']';
  }

  /* whether any byte of text is one of the bytes in set */
  function holdsAny(text, set) {
    for (var i = 0; i < text.length; i++) if (set.indexOf(text.charAt(i)) >= 0) return true;
    return false;
  }

  /*
   * The trim and the backslash conversion that run before anything else reads the string: leading
   * and trailing whitespace goes, and a backslash becomes a slash while no '?' or '#' has been
   * seen -- the browser behaviour Node copies, which is what makes 'a\b' the path 'a/b'. Whether
   * an '@' or a '#' was seen comes back beside it: both keep the parser off its short path, the
   * '#' because a fragment may not reach it and the '@' because a userinfo always denotes a host.
   */
  function legacyTrim(text) {
    var start = -1;
    var end = -1;
    var lastPos = 0;
    var acc = '';
    var inWs = false;
    var split = false;
    var hasAt = false;
    var hasHash = false;
    for (var i = 0; i < text.length; i++) {
      var code = text.charCodeAt(i);
      var isWs = code < 33 || code === 0xa0 || code === 0xfeff;
      if (start === -1) {
        if (isWs) continue;
        lastPos = start = i;
      } else if (inWs) {
        if (!isWs) { end = -1; inWs = false; }
      } else if (isWs) { end = i; inWs = true; }
      if (!split) {
        if (code === 64) hasAt = true;
        else if (code === 35) {
          hasHash = true;
          split = true;
        } else if (code === 63) split = true;
        else if (code === 92) {
          if (i - lastPos > 0) acc += text.slice(lastPos, i);
          acc += '/';
          lastPos = i + 1;
        }
      } else if (!hasHash && code === 35) hasHash = true;
    }
    var rest = '';
    if (start === -1) rest = '';
    else if (lastPos === start) rest = end === -1 ? (start === 0 ? text : text.slice(start)) : text.slice(start, end);
    else if (end === -1) rest = lastPos < text.length ? acc + text.slice(lastPos) : acc;
    else rest = lastPos < end ? acc + text.slice(lastPos, end) : acc;
    return { rest: rest, hasAt: hasAt, hasHash: hasHash };
  }

  /* A path with no host, no userinfo and no fragment: the only shape the parser answers without
     walking the string, which is what leaves the space of 'url.parse("/a?b c")' alone. */
  var SIMPLE_PATH_RE = /^(\/\/?(?!\/)[^?\s]*)(\?[^\s]*)?$/;

  /*
   * A query the caller asked to have parsed. Node hands back an object with no prototype -- the
   * querystring module's own -- so a name of '__proto__' is one pair of the query it names rather
   * than the prototype of the object holding it, and '?__proto__=1' is the query {__proto__: '1'}.
   */
  function emptyQuery() {
    return Object.create(null);
  }

  function queryOf(text) {
    var out = emptyQuery();
    new URLSearchParams(text).forEach(function (value, key) {
      if (Object.prototype.hasOwnProperty.call(out, key)) out[key] = [].concat(out[key], value);
      else out[key] = value;
    });
    return out;
  }

  /*
   * Node's legacy Url: a set of strings, null where Node leaves one null, and href is what format
   * writes back from those fields -- so the '//' a caller never wrote is not put in and an auth
   * carrying an '@' comes out as 'a%40b'.
   */
  function Url() {
    this.protocol = null;
    this.slashes = null;
    this.auth = null;
    this.host = null;
    this.port = null;
    this.hostname = null;
    this.hash = null;
    this.search = null;
    this.query = null;
    this.pathname = null;
    this.path = null;
    this.href = null;
  }

  /*
   * Node reads the argument as a string before anything else: url.parse(1) is ERR_INVALID_ARG_TYPE,
   * not the fields of the text '1'.
   */
  Url.prototype.parse = function (input, parseQuery, slashesDenoteHost) {
    if (typeof input !== 'string') throw invalidArgType('url', 'string', input);
    var text = input;
    var trimmed = legacyTrim(text);
    var rest = trimmed.rest;
    if (!slashesDenoteHost && !trimmed.hasHash && !trimmed.hasAt) {
      var simple = SIMPLE_PATH_RE.exec(rest);
      if (simple) {
        this.path = rest;
        this.href = rest;
        this.pathname = simple[1];
        if (simple[2]) {
          this.search = simple[2];
          this.query = parseQuery ? queryOf(simple[2].slice(1)) : simple[2].slice(1);
        } else if (parseQuery) {
          this.search = null;
          this.query = emptyQuery();
        }
        return this;
      }
    }
    var proto = LEGACY_SCHEME_RE.exec(rest);
    var lowerProto;
    var protocol = null;
    if (proto) {
      proto = proto[0];
      lowerProto = proto.toLowerCase();
      protocol = lowerProto;
      rest = rest.slice(proto.length);
    }

    var slashes = null;
    /*
     * '//' denotes a host when the caller says it does -- as url.resolve and url.resolveObject do,
     * since a browser resolves '//a/b' as the host 'a' over the path '/b' -- or when a scheme was
     * written, or when the text is a bare '//user@host'.
     */
    if (slashesDenoteHost || proto || LEGACY_HOST_RE.test(rest)) {
      var doubled = rest.charAt(0) === '/' && rest.charAt(1) === '/';
      if (doubled && !(proto && HOSTLESS_SCHEME[lowerProto])) {
        rest = rest.slice(2);
        slashes = true;
      }
    }

    var host = null;
    var hostname = null;
    var port = null;
    var auth = null;
    if (!HOSTLESS_SCHEME[lowerProto] && (slashes || (proto && !SLASHED_SCHEME[proto]))) {
      var hostEnd = -1;
      var atSign = -1;
      var nonHost = -1;
      for (var i = 0; i < rest.length; i++) {
        var code = rest.charCodeAt(i);
        var ch = rest.charAt(i);
        if (code === 9 || code === 10 || code === 13) {
          rest = rest.slice(0, i) + rest.slice(i + 1);
          i -= 1;
        } else if (NON_HOST_CHARS.indexOf(ch) >= 0) {
          if (nonHost === -1) nonHost = i;
        } else if (ch === '#' || ch === '/' || ch === '?') {
          if (nonHost === -1) nonHost = i;
          hostEnd = i;
        } else if (code === 64) {
          /* the last '@' before the host ends is the one that separates an auth from a host, and
             it resets what was not a host, so 'a@b@c' is the auth 'a@b' over the host 'c' */
          atSign = i;
          nonHost = -1;
        }
        if (hostEnd !== -1) break;
      }
      var from = 0;
      if (atSign !== -1) {
        auth = decodeURIComponent(rest.slice(0, atSign));
        from = atSign + 1;
      }
      var hostText;
      if (nonHost === -1) {
        hostText = rest.slice(from);
        rest = '';
      } else {
        hostText = rest.slice(from, nonHost);
        rest = rest.slice(nonHost);
      }
      var portText = LEGACY_PORT_RE.exec(hostText);
      if (portText) {
        var written = portText[0];
        if (written !== ':') port = written.slice(1);
        hostText = hostText.slice(0, hostText.length - written.length);
      }
      if (hostText) hostname = hostText;
      /* there is a hostname, so even an empty one is present */
      var name = typeof hostname === 'string' ? hostname : '';
      var ipv6 = isIpv6Hostname(name);
      /*
       * A ':' is not the only byte that ends a host: a '\', a '?', a '#', a '/' and a ':' each do,
       * and what follows the first of them becomes the path -- 'http://h\x/a' is the host 'h' over
       * the path '/x/a', and 'http://h:80x/a' the host 'h' over '/80x/a'.
       */
      if (!ipv6) {
        for (var j = 0; j < name.length; j++) {
          var at = name.charAt(j);
          if (at === ':' || at === '\\' || at === '?' || at === '#' || at === '/') {
            rest = '/' + name.slice(j) + rest;
            name = name.slice(0, j);
            break;
          }
        }
      }
      if (name.length > 255) name = '';
      else name = name.toLowerCase();
      if (name !== '') {
        if (ipv6) {
          if (holdsAny(name, FORBIDDEN_IPV6_CHARS)) throw invalidUrl(text);
        } else {
          /* the labels are case-folded and punycoded, but not read as an address: url.parse keeps
             the host '0x7f.1' as it was written, and does not write '127.0.0.1' for it */
          name = domainLabelsToASCII(name);
          if (name === '' || holdsAny(name, FORBIDDEN_HOST_CHARS)) throw invalidUrl(text);
        }
      }
      host = name + (port ? ':' + port : '');
      hostname = name;
      if (ipv6) {
        hostname = name.slice(1, name.length - 1);
        if (rest.charAt(0) !== '/') rest = '/' + rest;
      }
    }

    if (!UNSAFE_SCHEME[lowerProto]) rest = autoEscapeStr(rest);

    var hash = null;
    var search = null;
    var query = null;
    var questionIdx = -1;
    var hashIdx = -1;
    for (var k = 0; k < rest.length; k++) {
      var at = rest.charCodeAt(k);
      if (at === 35) {
        hashIdx = k;
        hash = rest.slice(k);
        break;
      } else if (at === 63 && questionIdx === -1) questionIdx = k;
    }
    if (questionIdx !== -1) {
      if (hashIdx === -1) {
        search = rest.slice(questionIdx);
        query = rest.slice(questionIdx + 1);
      } else {
        search = rest.slice(questionIdx, hashIdx);
        query = rest.slice(questionIdx + 1, hashIdx);
      }
      if (parseQuery) query = queryOf(rest.slice(questionIdx + 1, hashIdx === -1 ? rest.length : hashIdx));
    } else if (parseQuery) {
      query = emptyQuery();
    }

    var pathname = null;
    var useQuestionIdx = questionIdx !== -1 && (hashIdx === -1 || questionIdx < hashIdx);
    var firstIdx = useQuestionIdx ? questionIdx : hashIdx;
    if (firstIdx === -1) {
      if (rest.length > 0) pathname = rest;
    } else if (firstIdx > 0) pathname = rest.slice(0, firstIdx);
    /* a slashed scheme with a host always has a path, even the one the caller left out */
    if (SLASHED_SCHEME[lowerProto] && hostname && !pathname) pathname = '/';

    var path = null;
    if (pathname || search) path = (pathname || '') + (search || '');

    this.protocol = protocol;
    this.slashes = slashes;
    this.auth = auth;
    this.host = host;
    this.port = port;
    this.hostname = hostname;
    this.hash = hash;
    this.search = search;
    this.query = query;
    this.pathname = pathname;
    this.path = path;
    this.href = formatUrl(this);
    return this;
  };

  /*
   * Node reads both arguments as strings before anything else: url.resolve('http://a/b', null) is
   * ERR_INVALID_ARG_TYPE, not the reference resolved against the text 'null'. The wording is
   * Node's own -- 'Received type number (1)', and 'Received null' for the two that are not types.
   */
  function specificTypeOf(value) {
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    var type = typeof value;
    if (type === 'string') return value === '' ? 'an empty string' : 'type string (' + value + ')';
    if (type === 'number' || type === 'boolean' || type === 'bigint') return 'type ' + type + ' (' + String(value) + ')';
    if (type === 'symbol') return 'type symbol (' + String(value) + ')';
    if (type === 'function') return 'type function (' + (value.name || '') + ')';
    if (Array.isArray(value)) return 'an array';
    var ctor = value.constructor;
    var name = ctor && typeof ctor.name === 'string' ? ctor.name : '';
    return name ? 'an instance of ' + name : 'an instance of Object';
  }

  function invalidArgType(name, expected, value) {
    var err = new TypeError('The "' + name + '" argument must be ' +
      (Array.isArray(expected) ? 'one of type ' + expected.join(' or ') : 'of type ' + expected) +
      '. Received ' + specificTypeOf(value));
    err.code = 'ERR_INVALID_ARG_TYPE';
    return err;
  }

  function spliceOne(list, index) {
    list.splice(index, 1);
  }

  /* url.parse: a Url of the text, or the one it was handed back unchanged */
  function parseLegacy(input, parseQuery, slashesDenoteHost) {
    if (input instanceof Url) return input;
    var u = new Url();
    u.parse(input, parseQuery, slashesDenoteHost);
    return u;
  }

  function resolveLegacy(source, relative) {
    return parseLegacy(source, false, true).resolve(relative);
  }

  /* url.resolveObject: with no source at all, the reference is the answer */
  function resolveObjectLegacy(source, relative) {
    if (!source) return relative;
    return parseLegacy(source, false, true).resolveObject(relative);
  }

  Url.prototype.format = function () {
    return formatUrl(this);
  };

  Url.prototype.resolve = function (relative) {
    return this.resolveObject(parseLegacy(relative, false, true)).format();
  };

  /*
   * Url.prototype.resolveObject: RFC 3986 5.2, the way Node walks it. The base's fields are the
   * starting point and the reference rewrites them part by part -- the hash always, the whole URL
   * when the reference is '//host', the path and its dot segments only when it is relative.
   */
  Url.prototype.resolveObject = function (relative) {
    if (typeof relative === 'string') relative = parseLegacy(relative, false, true);

    var result = new Url();
    var keys = Object.keys(this);
    for (var i = 0; i < keys.length; i++) result[keys[i]] = this[keys[i]];

    /* the hash is always the reference's, even when the reference is empty and so takes it away */
    result.hash = relative.hash;

    /* nothing at all to resolve: the base as it stands, with the hash written over it */
    if (relative.href === '') {
      result.href = result.format();
      return result;
    }

    /* '//foo/bar' cuts to the protocol: everything but the protocol comes from the reference */
    if (relative.slashes && !relative.protocol) {
      var rkeys = Object.keys(relative);
      for (var r = 0; r < rkeys.length; r++) {
        if (rkeys[r] !== 'protocol') result[rkeys[r]] = relative[rkeys[r]];
      }
      /* a slashed scheme with a host has a path even when none was written: 'http://c' is '/' */
      if (SLASHED_SCHEME[result.protocol] && result.hostname && !result.pathname) {
        result.path = result.pathname = '/';
      }
      result.href = result.format();
      return result;
    }

    if (relative.protocol && relative.protocol !== result.protocol) {
      /* a scheme that carries no authority takes the reference whole */
      if (!SLASHED_SCHEME[relative.protocol]) {
        var all = Object.keys(relative);
        for (var a = 0; a < all.length; a++) result[all[a]] = relative[all[a]];
        result.href = result.format();
        return result;
      }
      result.protocol = relative.protocol;
      if (!relative.host && !/^file:?$/.test(relative.protocol) && !HOSTLESS_SCHEME[relative.protocol]) {
        /* a slashed scheme that names no host takes the first path segment as its host: the
           reference 'http:a/b' is the host 'a' over the path '/b' */
        var relPath = (relative.pathname || '').split('/');
        while (relPath.length && !(relative.host = relPath.shift())) { /* no empty segment is one */ }
        if (!relative.host) relative.host = '';
        if (!relative.hostname) relative.hostname = '';
        if (relPath[0] !== '') relPath.unshift('');
        if (relPath.length < 2) relPath.unshift('');
        result.pathname = relPath.join('/');
      } else {
        result.pathname = relative.pathname;
      }
      result.search = relative.search;
      result.query = relative.query;
      result.host = relative.host || '';
      result.auth = relative.auth;
      result.hostname = relative.hostname || relative.host;
      result.port = relative.port;
      if (result.pathname || result.search) {
        result.path = (result.pathname || '') + (result.search || '');
      }
      if (!result.slashes) result.slashes = relative.slashes;
      result.href = result.format();
      return result;
    }

    var isSourceAbs = !!(result.pathname && result.pathname.charAt(0) === '/');
    var isRelAbs = !!(relative.host || (relative.pathname && relative.pathname.charAt(0) === '/'));
    var mustEndAbs = isRelAbs || isSourceAbs || !!(result.host && relative.pathname);
    var removeAllDots = mustEndAbs;
    var srcPath = (result.pathname && result.pathname.split('/')) || [];
    var refPath = (relative.pathname && relative.pathname.split('/')) || [];
    var noLeadingSlashes = !!(result.protocol && !SLASHED_SCHEME[result.protocol]);

    /*
     * A scheme that carries no authority lets '../..' crawl up into the host, which is strange but
     * is what Node does: the host is put into the path to be crawled, and taken back out of it at
     * the end -- 'mailto:local1@domain1' with 'local2@domain2' is 'mailto:local2@domain2'.
     */
    if (noLeadingSlashes) {
      result.hostname = '';
      result.port = null;
      if (result.host) {
        if (srcPath[0] === '') srcPath[0] = result.host;
        else srcPath.unshift(result.host);
      }
      result.host = '';
      if (relative.protocol) {
        relative.hostname = null;
        relative.port = null;
        result.auth = null;
        if (relative.host) {
          if (refPath[0] === '') refPath[0] = relative.host;
          else refPath.unshift(relative.host);
        }
        relative.host = null;
      }
      mustEndAbs = mustEndAbs && (refPath[0] === '' || srcPath[0] === '');
    }

    if (isRelAbs) {
      /* the reference is absolute: its host and its query replace the base's, path and all */
      if (relative.host || relative.host === '') {
        if (result.host !== relative.host) result.auth = null;
        result.host = relative.host;
        result.port = relative.port;
      }
      if (relative.hostname || relative.hostname === '') {
        if (result.hostname !== relative.hostname) result.auth = null;
        result.hostname = relative.hostname;
      }
      result.search = relative.search;
      result.query = relative.query;
      srcPath = refPath;
    } else if (refPath.length) {
      /* the reference is relative: the base's last segment goes and the reference follows it */
      srcPath.pop();
      srcPath = srcPath.concat(refPath);
      result.search = relative.search;
      result.query = relative.query;
    } else if (relative.search !== null && relative.search !== undefined) {
      /* nothing but a query: '?foo' */
      if (noLeadingSlashes) {
        result.hostname = result.host = srcPath.shift();
        /* an auth can be left stuck in the host, as it is in 'mailto:local1@domain1' */
        var authInHost = result.host && result.host.indexOf('@') > 0 && result.host.split('@');
        if (authInHost) {
          result.auth = authInHost.shift();
          result.host = result.hostname = authInHost.shift();
        }
      }
      result.search = relative.search;
      result.query = relative.query;
      if (result.pathname !== null || result.search !== null) {
        result.path = (result.pathname ? result.pathname : '') + (result.search ? result.search : '');
      }
      result.href = result.format();
      return result;
    }

    if (!srcPath.length) {
      result.pathname = null;
      /* to support http.request */
      result.path = result.search ? '/' + result.search : null;
      result.href = result.format();
      return result;
    }

    /* a path that ends in '.' or '..' ends in a slash; one that ends in anything else does not */
    var last = srcPath[srcPath.length - 1];
    var hasTrailingSlash = (((result.host || relative.host || srcPath.length > 1) &&
      (last === '.' || last === '..')) || last === '');

    /* strip the single dots, resolve the double ones, and count the ones that went past the root */
    var up = 0;
    for (var d = srcPath.length - 1; d >= 0; d--) {
      last = srcPath[d];
      if (last === '.') spliceOne(srcPath, d);
      else if (last === '..') {
        spliceOne(srcPath, d);
        up++;
      } else if (up) {
        spliceOne(srcPath, d);
        up--;
      }
    }

    /* a path that need not end absolute keeps the '..' that would have gone above the root */
    if (!mustEndAbs && !removeAllDots) {
      while (up-- > 0) srcPath.unshift('..');
    }

    if (mustEndAbs && srcPath[0] !== '' && (!srcPath[0] || srcPath[0].charAt(0) !== '/')) {
      srcPath.unshift('');
    }

    var joined = srcPath.join('/');
    if (hasTrailingSlash && joined.charAt(joined.length - 1) !== '/') srcPath.push('');

    var isAbsolute = srcPath[0] === '' || (srcPath[0] && srcPath[0].charAt(0) === '/');

    /* the host comes back out of the first segment, for a scheme that carries no authority */
    if (noLeadingSlashes) {
      result.hostname = result.host = isAbsolute ? '' : (srcPath.length ? srcPath.shift() : '');
      var stuckAuth = result.host && result.host.indexOf('@') > 0 ? result.host.split('@') : false;
      if (stuckAuth) {
        result.auth = stuckAuth.shift();
        result.host = result.hostname = stuckAuth.shift();
      }
    }

    if (!mustEndAbs) mustEndAbs = !!(result.host && srcPath.length);
    if (mustEndAbs && !isAbsolute) srcPath.unshift('');

    if (!srcPath.length) {
      result.pathname = null;
      result.path = null;
    } else {
      result.pathname = srcPath.join('/');
    }

    if (result.pathname !== null || result.search !== null) {
      result.path = (result.pathname ? result.pathname : '') + (result.search ? result.search : '');
    }
    result.auth = relative.auth || result.auth;
    if (!result.slashes) result.slashes = relative.slashes;
    result.href = result.format();
    return result;
  };

  /* the port is the run of digits behind the last ':' that ends the host, read off before the
     host is validated: 'h:' names no port at all and 'h:80' names the port 80 over the host 'h' */
  Url.prototype.parseHost = function () {
    var host = this.host || '';
    var port = LEGACY_PORT_RE.exec(host);
    if (port) {
      port = port[0];
      if (port !== ':') this.port = port.slice(1);
      host = host.slice(0, host.length - port.length);
    }
    if (host) this.hostname = host;
  };

  /*
   * A query written back out of the object a caller passed, the way querystring.stringify writes
   * one: each name and value escaped with encodeURIComponent, and a space as %20 rather than the
   * '+' a form body would use -- url.format and url.parse round-trip on %20, not on '+'.
   */
  function queryStringOf(values) {
    var keys = Object.keys(values);
    var parts = [];
    for (var i = 0; i < keys.length; i++) {
      var value = values[keys[i]];
      var name = encodeURIComponent(keys[i]);
      if (Array.isArray(value)) {
        for (var j = 0; j < value.length; j++) parts.push(name + '=' + encodeURIComponent(String(value[j])));
      } else if (value === null || value === undefined) {
        parts.push(name + '=');
      } else {
        parts.push(name + '=' + encodeURIComponent(String(value)));
      }
    }
    return parts.join('&');
  }

  /*
   * legacy url.format: a URL, a string, or a Url-shaped object (protocol, host or hostname and
   * port, pathname, search or query, hash). Only a slashed scheme -- or one the caller marked with
   * slashes -- writes the '//', and only behind a host: that is what keeps href of url.parse
   * ('mailto:x@y') 'mailto:x@y' and href of url.parse('http:x@y') 'http:x@y', and it is why an
   * auth is written into the host alone, escaped with the ':' it separates a password with kept.
   */
  function formatUrl(u) {
    if (u instanceof URL) return u.href;
    if (typeof u === 'string') return u;
    var auth = u.auth ? encodeAuth(String(u.auth)) + '@' : '';
    var protocol = u.protocol ? String(u.protocol) : '';
    if (protocol && protocol.charAt(protocol.length - 1) !== ':') protocol += ':';
    var pathname = u.pathname ? String(u.pathname) : '';
    var hash = u.hash ? String(u.hash) : '';
    var host = '';
    var query = '';
    if (u.host) {
      host = auth + String(u.host);
    } else if (u.hostname) {
      var name = String(u.hostname);
      /* a hostname holding a ':' is written back in brackets, unless it is an IPv6 literal, which
         carries its own */
      host = auth + (name.indexOf(':') >= 0 && !isIpv6Hostname(name) ? '[' + name + ']' : name);
      if (u.port) host += ':' + String(u.port);
    }
    if (u.query !== null && typeof u.query === 'object') query = queryStringOf(u.query);
    var search = u.search ? String(u.search) : (query && '?' + query) || '';
    /* a '?' or '#' in the path would end it, so it is escaped: the file '/a#b' and not the path
       '/a' carrying the fragment '#b' */
    if (pathname.indexOf('#') >= 0 || pathname.indexOf('?') >= 0) {
      pathname = pathname.replace(/#/g, '%23').replace(/\?/g, '%3F');
    }
    if (u.slashes || SLASHED_SCHEME[protocol]) {
      if (u.slashes || host) {
        if (pathname && pathname.charAt(0) !== '/') pathname = '/' + pathname;
        host = '//' + host;
      } else if (protocol.length >= 4 && protocol.slice(0, 4).toLowerCase() === 'file') {
        host = '//';
      }
    }
    if (search.indexOf('#') >= 0) search = search.replace(/#/g, '%23');
    if (hash && hash.charAt(0) !== '#') hash = '#' + hash;
    if (search && search.charAt(0) !== '?') search = '?' + search;
    return protocol + host + pathname + search + hash;
  }

  /*
   * url.format: a string is parsed before it is written back, and a WHATWG URL is written with the
   * parts the options name -- no fragment, no search, no userinfo, or a host in unicode rather
   * than in punycode.
   */
  function formatUrlExport(u, options) {
    if (typeof u === 'string') return parseLegacy(u, false, true).format();
    if (typeof u !== 'object' || u === null) throw invalidArgType('urlObject', ['object', 'string'], u);
    if (u instanceof URL || u instanceof urlModule.URL) {
      var fragment = true;
      var unicode = false;
      var search = true;
      var auth = true;
      if (options) {
        if (options.fragment != null) fragment = !!options.fragment;
        if (options.unicode != null) unicode = !!options.unicode;
        if (options.search != null) search = !!options.search;
        if (options.auth != null) auth = !!options.auth;
      }
      var name = unicode ? domainToUnicode(u.hostname) : u.hostname;
      var userinfo = auth && (u.username || u.password)
        ? u.username + (u.password ? ':' + u.password : '') + '@'
        : '';
      /* only a URL that carries a host writes the '//', and file: writes it with no host at all */
      var authority = '';
      if (u.hostname || u.host || u.protocol === 'file:') {
        authority = '//' + userinfo + (name === '' ? '' : name) + (u.port ? ':' + u.port : '');
      }
      return u.protocol + authority + u.pathname + (search ? u.search : '') + (fragment ? u.hash : '');
    }
    return formatUrl(u);
  }

  /*
   * fileURLToPath as a Buffer: the bytes the path names, decoded one escape at a time rather than
   * through decodeURIComponent, so a path that is not valid UTF-8 still comes back whole.
   */
  function fileURLToPathBuffer(u) {
    var parsed;
    if (typeof u === 'string') parsed = new URL(u);
    else if (u instanceof URL || u instanceof urlModule.URL) parsed = u;
    else throw invalidArgType('path', 'string or an instance of URL', u);
    if (parsed.protocol !== 'file:') {
      var err = new TypeError('The URL must be of scheme file');
      err.code = 'ERR_INVALID_URL_SCHEME';
      throw err;
    }
    /*
     * A file: URL names no host but 'localhost', and the parser has already taken 'localhost' for
     * no host at all, so any host that is left is one Node refuses.
     */
    if (parsed.hostname !== '') {
      var hostErr = new TypeError(
        'File URL host must be "localhost" or empty on ' + requireBuiltin('os').platform());
      hostErr.code = 'ERR_INVALID_FILE_URL_HOST';
      throw hostErr;
    }
    var pathname = parsed.pathname;
    var bytes = [];
    for (var i = 0; i < pathname.length; i++) {
      var code = pathname.charCodeAt(i);
      if (code === 37 && isHexPair(pathname, i + 1)) {
        bytes.push(parseInt(pathname.substr(i + 1, 2), 16));
        i += 2;
        continue;
      }
      /* a half of a surrogate pair is not a code point, and Node writes it as U+FFFD */
      var encoded = (code >= 0xd800 && code <= 0xdfff) ? [0xef, 0xbf, 0xbd] : utf8Flat(code);
      for (var b = 0; b < encoded.length; b++) bytes.push(encoded[b]);
    }
    return requireBuiltin('buffer').Buffer.from(bytes);
  }

  /*
   * URLPattern: a pattern per component -- protocol, username, password, hostname, port, pathname,
   * search and hash -- each compiled to a regular expression, so test() answers whether a URL
   * matches it and exec() answers what the named parts of that URL were. A component the pattern
   * never mentions is '*', which matches anything.
   */
  var PATTERN_COMPONENTS = ['protocol', 'username', 'password', 'hostname', 'port', 'pathname', 'search', 'hash'];
  /* the text one component may not hold, and so the class a named part of it is read against */
  var PATTERN_CLASS = {
    protocol: '[^:/?#]+?',
    username: '[^:/?#]+?',
    password: '[^:/?#]+?',
    hostname: '[^/:?#]+?',
    port: '[^/?#]+?',
    pathname: '[^?#]+?',
    search: '[^#]+?',
    hash: '.+?'
  };

  var PATTERN_STATE = new WeakMap();
  /* the bytes a regular expression reads as its own, written back escaped so they stay literal */
  var PATTERN_SPECIAL = '.*+?^$()|[]\\{}';

  function patternRegExp(text, component) {
    var out = '';
    var names = [];
    var i = 0;
    while (i < text.length) {
      var ch = text.charAt(i);
      /* a named part, ':id', or a wildcard, '*' */
      if (ch === ':' && /[A-Za-z_]/.test(text.charAt(i + 1) || '')) {
        i++;
        var name = '';
        while (i < text.length && /[A-Za-z0-9_$]/.test(text.charAt(i))) name += text.charAt(i++);
        names.push(name);
        out += '(' + PATTERN_CLASS[component] + ')';
        continue;
      }
      if (ch === '*') {
        out += '(.*)';
        names.push(names.length ? String(names.length) : '0');
        i++;
        continue;
      }
      /* a parenthesised group is a regular expression of the caller's own */
      if (ch === '(') {
        var depth = 1;
        var body = '(';
        i++;
        while (i < text.length && depth > 0) {
          if (text.charAt(i) === '(') depth++;
          else if (text.charAt(i) === ')') {
            depth--;
            if (depth === 0) {
              i++;
              break;
            }
          }
          body += text.charAt(i++);
        }
        if (depth === 0) {
          body += ')';
          names.push(String(names.length));
          out += body;
          continue;
        }
        out += '\\(';
        i++;
        continue;
      }
      /* an escape is the byte it names; anything else is itself, and a byte that means something
         to a regular expression is escaped so it stays literal */
      out += PATTERN_SPECIAL.indexOf(ch) >= 0 ? '\\' + ch : ch;
      i++;
    }
    try {
      return { re: new RegExp('^' + out + '$'), names: names };
    } catch (badPattern) {
      var err = new TypeError('Failed to construct URLPattern');
      throw err;
    }
  }

  /* the components of whatever a caller matched against: a string, or the parts of one */
  function patternInput(input, base) {
    if (typeof input === 'string' || input === undefined) {
      var parsed = new (urlModule.URL)(String(input === undefined ? '' : input), base);
      return {
        text: input,
        parts: {
          protocol: parsed.protocol.slice(0, parsed.protocol.length - 1),
          username: parsed.username,
          password: parsed.password,
          hostname: parsed.hostname,
          port: parsed.port,
          pathname: parsed.pathname,
          search: parsed.search ? parsed.search.slice(1) : '',
          hash: parsed.hash ? parsed.hash.slice(1) : ''
        }
      };
    }
    var parts = {};
    for (var i = 0; i < PATTERN_COMPONENTS.length; i++) {
      var name = PATTERN_COMPONENTS[i];
      parts[name] = input[name] === undefined ? '' : String(input[name]);
    }
    return { text: input, parts: parts };
  }

  function URLPattern(input, baseURL) {
    var patterns = {};
    var i;
    for (i = 0; i < PATTERN_COMPONENTS.length; i++) patterns[PATTERN_COMPONENTS[i]] = '*';
    if (typeof input === 'string' || input === undefined) {
      var text = input === undefined ? '' : input;
      var parsed = new (urlModule.URL)(text, baseURL);
      patterns.protocol = parsed.protocol.slice(0, parsed.protocol.length - 1) || '*';
      patterns.username = parsed.username || '*';
      patterns.password = parsed.password || '*';
      patterns.hostname = parsed.hostname || '*';
      patterns.port = parsed.port;
      patterns.pathname = parsed.pathname;
      patterns.search = parsed.search ? parsed.search.slice(1) : '*';
      patterns.hash = parsed.hash ? parsed.hash.slice(1) : '*';
      /* a base supplies the parts the pattern itself did not name, as it does in Node */
      if (baseURL !== undefined) {
        var baseParts = patternInput(baseURL, undefined).parts;
        if (text.indexOf('://') < 0 && text.charAt(0) !== '/') {
          if (patterns.protocol === '*') patterns.protocol = baseParts.protocol;
          if (patterns.hostname === '*') patterns.hostname = baseParts.hostname;
          if (patterns.port === '' && baseParts.port) patterns.port = baseParts.port;
        }
      }
    } else if (input !== null && typeof input === 'object') {
      for (i = 0; i < PATTERN_COMPONENTS.length; i++) {
        var name = PATTERN_COMPONENTS[i];
        if (input[name] !== undefined) patterns[name] = String(input[name]);
      }
      if (baseURL !== undefined) {
        var from = patternInput(baseURL, undefined).parts;
        for (i = 0; i < PATTERN_COMPONENTS.length; i++) {
          var key = PATTERN_COMPONENTS[i];
          if (input[key] === undefined && patterns[key] === '*' && from[key]) patterns[key] = from[key];
        }
      }
    }
    var compiled = {};
    var hasRegExpGroups = false;
    for (i = 0; i < PATTERN_COMPONENTS.length; i++) {
      var part = PATTERN_COMPONENTS[i];
      compiled[part] = patternRegExp(patterns[part], part);
      if (patterns[part].indexOf('(') >= 0) hasRegExpGroups = true;
    }
    PATTERN_STATE.set(this, { patterns: patterns, compiled: compiled, hasRegExpGroups: hasRegExpGroups });
  }

  function patternOf(self) {
    return PATTERN_STATE.get(self);
  }

  for (var pc = 0; pc < PATTERN_COMPONENTS.length; pc++) {
    (function (name) {
      Object.defineProperty(URLPattern.prototype, name, {
        get: function () { return patternOf(this).patterns[name]; },
        enumerable: true,
        configurable: true
      });
    })(PATTERN_COMPONENTS[pc]);
  }
  Object.defineProperty(URLPattern.prototype, 'hasRegExpGroups', {
    get: function () { return patternOf(this).hasRegExpGroups; },
    enumerable: true,
    configurable: true
  });
  URLPattern.prototype.exec = function (input, base) {
    var state = patternOf(this);
    var given = patternInput(input, base);
    var out = { inputs: [given.text] };
    for (var i = 0; i < PATTERN_COMPONENTS.length; i++) {
      var name = PATTERN_COMPONENTS[i];
      var match = state.compiled[name].re.exec(given.parts[name]);
      if (!match) return null;
      var groups = {};
      for (var g = 0; g < state.compiled[name].names.length; g++) {
        groups[state.compiled[name].names[g]] = match[g + 1] === undefined ? '' : match[g + 1];
      }
      out[name] = { input: given.parts[name], groups: groups };
    }
    return out;
  };
  URLPattern.prototype.test = function (input, base) {
    var state = patternOf(this);
    var parts = patternInput(input, base).parts;
    for (var i = 0; i < PATTERN_COMPONENTS.length; i++) {
      var name = PATTERN_COMPONENTS[i];
      if (!state.compiled[name].re.test(parts[name])) return false;
    }
    return true;
  };
  /* Node's order on the prototype: the parts, then hasRegExpGroups, exec, test and constructor.
     Deleting the constructor and putting it back is what rewrites that order. */
  var patternCtor = Object.getOwnPropertyDescriptor(URLPattern.prototype, 'constructor');
  if (patternCtor !== undefined) {
    delete URLPattern.prototype.constructor;
    Object.defineProperty(URLPattern.prototype, 'constructor', patternCtor);
  }

  /*
   * The names in the order Node hands them back: Object.keys(require('url')) walks the legacy
   * parser first, then the WHATWG parts, then the helpers -- not the alphabetical order an object
   * literal is written in would give.
   */
  var urlModule = {};
  urlModule.Url = Url;
  urlModule.parse = parseLegacy;
  urlModule.resolve = resolveLegacy;
  urlModule.resolveObject = resolveObjectLegacy;
  urlModule.format = formatUrlExport;
  urlModule.URL = URL;
  urlModule.URLPattern = URLPattern;
  urlModule.URLSearchParams = URLSearchParams;
  urlModule.domainToASCII = domainToASCII;
  urlModule.domainToUnicode = domainToUnicode;
  urlModule.pathToFileURL = pathToFileURL;
  urlModule.fileURLToPath = fileURLToPath;
  urlModule.fileURLToPathBuffer = fileURLToPathBuffer;
  urlModule.urlToHttpOptions = urlToHttpOptions;
  return urlModule;
};

BF.crypto = function () {
  var Buf = requireBuiltin('buffer').Buffer;

  /* key bytes and CryptoKey state live here, never on the key objects, so user code sees only Node's surface */
  var KEY_STATE = new WeakMap();

  /*
   * How Node names what it was handed at the end of an ERR_INVALID_ARG_TYPE: "Received null" and
   * "Received undefined" for the two that are neither, "Received type number (1)" -- the type and
   * the value -- for a primitive, and "Received an instance of ArrayBuffer" for an object.
   */
  function receivedAs(value) {
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    var kind = typeof value;
    /* Node renders a string the way util.inspect does, with its quotes on: "Received type string
       ('1')" for an offset handed in as text, which is not how a number is rendered. */
    if (kind === 'string') return "type string ('" + value + "')";
    /* A bigint keeps the suffix a script writes it with, and -0 keeps its sign: String() would
       flatten both -- 10n to '10' and -0 to '0' -- where Node renders a value as it is written. */
    if (kind === 'bigint') return 'type bigint (' + value.toString() + 'n)';
    if (kind === 'number') return 'type number (' + (value === 0 && 1 / value < 0 ? '-0' : String(value)) + ')';
    /* A function is named as one -- "Received function bar", and an anonymous one as "function "
       with nothing after it, which is not how an instance of Function is described. */
    if (kind === 'function') return 'function ' + (typeof value.name === 'string' ? value.name : '');
    if (kind !== 'object') return 'type ' + kind + ' (' + String(value) + ')';
    /* An object with no prototype has no constructor to name, so it is shown the way util.inspect
       renders one -- "[Object: null prototype] {}" -- and not as an instance of Object. */
    if (value.constructor === undefined) return requireBuiltin('util').inspect(value);
    var made = value.constructor;
    var named = made !== undefined && made !== null && typeof made.name === 'string' ? made.name : null;
    return named === null || named === '' ? 'an instance of Object' : 'an instance of ' + named;
  }

  function invalidArgType(name, expected, value) {
    var err = new TypeError('The "' + name + '" argument must be ' + expected + '. Received ' + receivedAs(value));
    err.code = 'ERR_INVALID_ARG_TYPE';
    return err;
  }

  /*
   * The same refusal about a property of an options object rather than an argument of a call: Node
   * says "property" where it is reading one out of options, and "argument" where it is not.
   */
  function invalidPropertyType(name, expected, value) {
    var err = new TypeError('The "' + name + '" property must be of type ' + expected + '. Received ' + receivedAs(value));
    err.code = 'ERR_INVALID_ARG_TYPE';
    return err;
  }

  function outOfRange(name, range, value) {
    var err = new RangeError('The value of "' + name + '" is out of range. It must be ' + range + '. Received ' + value);
    err.code = 'ERR_OUT_OF_RANGE';
    return err;
  }

  /* Node's ERR_CRYPTO_INVALID_DIGEST is a TypeError everywhere but in createHash, which answers a
     plain Error with no code: createSign names no digest in the message, pbkdf2 does. */
  function invalidDigest(name) {
    var err = new TypeError('Invalid digest' + (name === undefined ? '' : ': ' + String(name)));
    err.code = 'ERR_CRYPTO_INVALID_DIGEST';
    return err;
  }

  /*
   * The algorithm of a one-shot crypto.sign or crypto.verify, which Node checks before it reads
   * anything else: a value that is neither a string nor null is an ERR_INVALID_ARG_TYPE, and a
   * string naming no digest this runtime knows is an ERR_CRYPTO_INVALID_DIGEST. null and undefined
   * are the one form that names no digest at all -- the raw signature a caller asks for -- so they
   * pass through as null rather than being turned into the text 'null' or 'undefined'.
   */
  function algorithmOf(algorithm) {
    if (algorithm === undefined || algorithm === null) return null;
    if (typeof algorithm !== 'string') {
      var err = new TypeError('The "algorithm" argument must be of type string. Received ' + receivedAs(algorithm));
      err.code = 'ERR_INVALID_ARG_TYPE';
      throw err;
    }
    if (!digestKnown(algorithm)) throw invalidDigest(algorithm);
    return algorithm;
  }

  /* Node renders the value with util.inspect, so a Buffer shows as <Buffer 00> -- and an empty
     one as '<Buffer >', with the gap where its hex would have been. */
  function shownOf(value) {
    if (value === undefined) return 'undefined';
    if (typeof value === 'string') return "'" + value + "'";
    if (value !== null && typeof value === 'object') {
      if (Buf.isBuffer(value)) {
        var parts = [];
        for (var i = 0; i < value.length && i < 50; i++) parts.push(('00' + value[i].toString(16)).slice(-2));
        var more = value.length > 50 ? ' ... ' + (value.length - 50) + ' more bytes' : '';
        return '<Buffer' + (parts.length ? ' ' + parts.join(' ') : ' ') + more + '>';
      }
      return requireBuiltin('util').inspect(value);
    }
    return String(value);
  }

  /* Node's ERR_INVALID_ARG_VALUE: "The property 'a.b' is invalid. Received x", with an optional
     reason. Node raises it as a TypeError, so 'crypto.diffieHellman({...})' and a key's export
     format answer the constructor host Node 24.15 answers and not the RangeError they did here. */
  function invalidArgValue(name, value, reason) {
    var err = new TypeError("The property '" + name + "' " + (reason === undefined ? 'is invalid' : reason) + '. Received ' + shownOf(value));
    err.code = 'ERR_INVALID_ARG_VALUE';
    return err;
  }

  /* exports this runtime does not implement (Diffie-Hellman, key generation): present so modules load, and they fail clearly when called */
  function featureUnavailable(name) {
    var err = new Error(name + ' is not available in this runtime');
    err.code = 'ERR_FEATURE_UNAVAILABLE';
    return err;
  }

  function unavailable(name) {
    return function () {
      throw featureUnavailable(name);
    };
  }

  function asymmetricUnavailable(what) {
    var err = new Error(what + ' is not available: this runtime has no asymmetric key support (RSA, EC or Ed25519)');
    err.code = 'ERR_FEATURE_UNAVAILABLE';
    return err;
  }

  /*
   * A sign handed no key at all. Node asks for the key before it parses it, so null and undefined
   * answer their own code where a key of the wrong type is an argument error like any other.
   */
  function noKeyToSign() {
    var err = new Error('No key provided to sign');
    err.code = 'ERR_CRYPTO_SIGN_KEY_REQUIRED';
    return err;
  }

  function randomBytes(size, callback) {
    if (typeof size !== 'number') throw invalidArgType('size', 'of type number', size);
    /* Node bounds size before it allocates: a negative length is a range error, not a typed-array one. */
    if (!(size >= 0 && size <= 2147483647)) throw outOfRange('size', '>= 0 && <= 2147483647', size);
    var bytes = Buf.from(decodeBase64(host.randomBase64(size)));
    if (typeof callback === 'function') {
      queueMicrotask(function () { callback(null, bytes); });
      return undefined;
    }
    return bytes;
  }

  function randomUUID(options) {
    /* Node reads its options even though it has none to read yet, so a value that is not an object
       -- and not absent -- is refused before a UUID is drawn. */
    if (options !== undefined && (options === null || typeof options !== 'object')) {
      throw invalidArgType('options', 'of type object', options);
    }
    var b = randomBytes(16);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    var h = b.toString('hex');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  }

  function randomInt(min, max) {
    if (max === undefined) {
      max = min;
      min = 0;
    }
    /* Node reads both bounds as safe integers before it looks at either, and then insists the
       upper one is above the lower: a range the wrong way round is out of range, not empty. */
    if (typeof max !== 'number' || !Number.isSafeInteger(max)) throw invalidArgType('max', 'a safe integer', max);
    if (typeof min !== 'number' || !Number.isSafeInteger(min)) throw invalidArgType('min', 'a safe integer', min);
    if (!(max > min)) throw outOfRange('max', 'greater than the value of "min" (' + min + ')', max);
    var r = randomBytes(4).readUInt32BE(0) / 4294967296;
    return min + Math.floor(r * (max - min));
  }

  /* The integer-typed arrays webcrypto.getRandomValues fills: a floating-point one and a DataView
     are refused with the TypeError the webcrypto layer throws (code 17), as on a host. */
  var INTEGER_TYPED_ARRAYS = ['Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array',
    'Uint16Array', 'Int32Array', 'Uint32Array', 'BigInt64Array', 'BigUint64Array'];

  function getRandomValues(typed) {
    var tag = Object.prototype.toString.call(typed).slice(8, -1);
    if (INTEGER_TYPED_ARRAYS.indexOf(tag) < 0) {
      /* A webcrypto error is a DOMException: its name is the error's own and its class is the
         DOM's, which is what a caller reads off constructor.name and what util.inspect prints. */
      var mismatched = typeof DOMException === 'function'
        ? new DOMException('The data argument must be an integer-type TypedArray', 'TypeMismatchError')
        : new TypeError('The data argument must be an integer-type TypedArray');
      if (mismatched.code === undefined) mismatched.code = 17;
      if (mismatched.name !== 'TypeMismatchError') mismatched.name = 'TypeMismatchError';
      /* The tag is the last thing a host DOMException carries that a plain Error does not: it is
         what makes util.inspect print [object DOMException] and not [object Error]. */
      if (Object.prototype.toString.call(mismatched) !== '[object DOMException]' && typeof Symbol === 'function' && Symbol.toStringTag !== undefined) {
        Object.defineProperty(mismatched, Symbol.toStringTag, { value: 'DOMException', configurable: true });
      }
      throw mismatched;
    }
    var bytes = decodeBase64(host.randomBase64(typed.byteLength));
    new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength).set(bytes);
    return typed;
  }

  /* the view a random fill writes into: offset and size count elements of a typed array, as Node reads them */
  function fillTarget(buf, offset, size) {
    var isView = ArrayBuffer.isView(buf);
    if (!isView && !(buf instanceof ArrayBuffer)) {
      throw invalidArgType('buf', 'an instance of ArrayBuffer or ArrayBufferView', buf);
    }
    var elementSize = isView && buf.BYTES_PER_ELEMENT ? buf.BYTES_PER_ELEMENT : 1;
    var elements = buf.byteLength / elementSize;
    /*
     * Node reads an offset and a size as numbers it truncates rather than as integers it insists
     * on: a fill of 1.5 bytes fills one, and an offset of 1.5 starts one in. What it does bound
     * is the sum -- "The value of "size + offset" is out of range. It must be <= 4. Received 5" --
     * the offset on its own against the buffer, and a size against 2^31.
     */
    if (offset !== undefined && typeof offset !== 'number') throw invalidArgType('offset', 'of type number', offset);
    if (size !== undefined && typeof size !== 'number') throw invalidArgType('size', 'of type number', size);
    var start = offset === undefined ? 0 : Math.trunc(offset);
    if (!(start >= 0 && start <= elements)) throw outOfRange('offset', '>= 0 && <= ' + elements, offset);
    var count = size === undefined ? elements - start : Math.trunc(size);
    if (!(count >= 0 && count <= 2147483647)) throw outOfRange('size', '>= 0 && <= 2147483647', size);
    if (start + count > elements) throw outOfRange('size + offset', '<= ' + elements, start + count);
    var base = isView ? buf.byteOffset : 0;
    var backing = isView ? buf.buffer : buf;
    return new Uint8Array(backing, base + start * elementSize, count * elementSize);
  }

  function randomFillSync(buf, offset, size) {
    var view = fillTarget(buf, offset, size);
    if (view.length > 0) view.set(decodeBase64(host.randomBase64(view.length)));
    return buf;
  }

  function randomFill(buf, offset, size, callback) {
    var done = callback;
    var start = offset;
    var count = size;
    if (typeof offset === 'function') {
      done = offset;
      start = undefined;
      count = undefined;
    } else if (typeof size === 'function') {
      done = size;
      count = undefined;
    }
    if (typeof done !== 'function') throw invalidArgType('callback', 'of type function', done);
    randomFillSync(buf, start, count);
    queueMicrotask(function () { done(null, buf); });
  }

  /*
   * bytes from a string (with its encoding), a Buffer, a TypedArray, a DataView or an ArrayBuffer
   *
   * An ArrayBuffer is not in the list for one family of arguments: the data a hash, a sign or a
   * verify is fed. Node names "string or an instance of Buffer, TypedArray, or DataView" there and
   * refuses a bare buffer, while a password, a salt, a key or a signature -- the arguments named
   * anywhere else -- take one. So the list is the caller's to choose, and the value it was handed
   * is named at the end of the message as Node names it.
   */
  function toBytes(data, encoding, name, list) {
    var expected = typeof list === 'string'
      ? list : 'string or an instance of ArrayBuffer, Buffer, TypedArray, or DataView';
    /* Whether an ArrayBuffer is taken is read off the list itself: a family that does not name one
       does not take one, which is how Node reads the same message. */
    var allowArrayBuffer = expected.indexOf('ArrayBuffer') >= 0;
    function refused() {
      var err = new TypeError('The "' + name + '" argument must be of type ' + expected + '. Received ' + receivedAs(data));
      err.code = 'ERR_INVALID_ARG_TYPE';
      return err;
    }
    if (typeof data === 'string') return Buf.from(data, encoding || 'utf8');
    if (data instanceof ArrayBuffer) {
      if (allowArrayBuffer) return Buf.from(data);
      throw refused();
    }
    if (ArrayBuffer.isView(data)) return Buf.from(data.buffer, data.byteOffset, data.byteLength);
    throw refused();
  }

  /*
   * The one encoding whose length tells you it cannot fit: 'hex' takes two characters per byte, so
   * a string of an odd length is not data in it at all. Node refuses it rather than decoding what
   * it can -- which is what every other encoding does with a character it cannot read -- and names
   * the encoding it was handed, so an upper-case 'HEX' stays 'HEX' in the message.
   */
  function refuseOddHex(data, encoding) {
    if (typeof data !== 'string' || typeof encoding !== 'string') return;
    if (encoding.toLowerCase() !== 'hex' || data.length % 2 === 0) return;
    var err = new TypeError("The argument 'encoding' is invalid for data of length " + data.length + ". Received '" + encoding + "'");
    err.code = 'ERR_INVALID_ARG_VALUE';
    throw err;
  }

  /*
   * The data a hash, a sign or a verify is fed. Node reads an encoding it does not know as utf8
   * rather than refusing it, and that covers an encoding that is not text at all: a number, an
   * object, a Symbol or null all hash the string, so update('a', 1) is update('a') and only a value
   * that is not data reaches the type check above.
   */
  function toDataBytes(data, encoding, name, list) {
    refuseOddHex(data, encoding);
    var enc = encoding === undefined || encoding === null || typeof encoding === 'string' ? encoding : 'utf8';
    try {
      return toBytes(data, enc, name, list);
    } catch (unknown) {
      if (String(unknown && unknown.message).indexOf('Unknown encoding') !== 0) throw unknown;
      return toBytes(data, 'utf8', name, list);
    }
  }

  /*
   * The signature a one-shot crypto.verify reads. It is the one argument Node names a short list
   * for: a Buffer, a TypedArray or a DataView and not a string and not an ArrayBuffer, which is not
   * the list the same argument gets on a Verify object.
   */
  function signatureBytes(signature) {
    if (typeof signature === 'string' || !ArrayBuffer.isView(signature)) {
      var err = new TypeError('The "signature" argument must be an instance of Buffer, TypedArray, or DataView. Received ' + receivedAs(signature));
      err.code = 'ERR_INVALID_ARG_TYPE';
      throw err;
    }
    return Buf.from(signature.buffer, signature.byteOffset, signature.byteLength);
  }

  /*
   * The data a one-shot crypto.verify reads: a bare ArrayBuffer is refused, and it is refused with
   * the short list, where any other value that is not data gets the long one.
   */
  function verifyDataBytes(data) {
    if (data instanceof ArrayBuffer) {
      var err = new TypeError('The "data" argument must be an instance of Buffer, TypedArray, or DataView. Received an instance of ArrayBuffer');
      err.code = 'ERR_INVALID_ARG_TYPE';
      throw err;
    }
    return toBytes(data, undefined, 'data');
  }

  /*
   * Node's digest, sign and secret output encoding: an encoding it does not recognise is not an
   * error, it is simply no encoding at all -- digest('nope'), digest(32), digest(null) and
   * digest({}) all answer the Buffer. A Symbol is the one value that refuses: Node reads the
   * encoding with a template, which is the one form of ToString that throws on a Symbol, so
   * digest(Symbol()) raises a TypeError where digest(1) answers the Buffer.
   * 'buffer' names the same answer, and an alias like 'utf-8' or 'binary' is read as its own.
   */
  var OUTPUT_ENCODINGS = {
    hex: 'hex', base64: 'base64', base64url: 'base64url',
    utf8: 'utf8', 'utf-8': 'utf8', 'unicode-1-1-utf-8': 'utf8',
    utf16le: 'utf16le', 'utf-16le': 'utf16le', ucs2: 'utf16le', 'ucs-2': 'utf16le',
    latin1: 'latin1', binary: 'latin1', ascii: 'ascii', buffer: 'buffer'
  };

  function outputOf(bytes, encoding) {
    if (typeof encoding === 'symbol') throw new TypeError('Cannot convert a Symbol value to a string');
    var name = typeof encoding === 'string' ? encoding : String(encoding);
    var as = OUTPUT_ENCODINGS[name.toLowerCase()];
    return as === undefined || as === 'buffer' ? bytes : bytes.toString(as);
  }

  /*
   * The output encoding of a Sign and of a DiffieHellman's getters, which is strict where a
   * digest's is not: the value goes to Buffer.prototype.toString, so an encoding that is not one
   * is ERR_UNKNOWN_ENCODING -- "Unknown encoding: nope", and "Unknown encoding: 32" for a number,
   * which is the text it gets as a string. Nothing, an empty string and 'buffer' all mean the
   * Buffer itself, because Node tests the encoding for being there before it decodes with it.
   */
  function outputStrict(bytes, encoding) {
    if (typeof encoding === 'symbol') throw new TypeError('Cannot convert a Symbol value to a string');
    if (encoding === undefined || encoding === null || encoding === false || encoding === '' || encoding === 0) return bytes;
    var name = typeof encoding === 'string' ? encoding : String(encoding);
    var as = OUTPUT_ENCODINGS[name.toLowerCase()];
    if (as === undefined) {
      var err = new TypeError('Unknown encoding: ' + name);
      err.code = 'ERR_UNKNOWN_ENCODING';
      throw err;
    }
    return as === 'buffer' ? bytes : bytes.toString(as);
  }

  /*
   * KeyObject. A secret key keeps its bytes here, because nothing but its own bytes defines it; an
   * asymmetric key is a handle the host answers for, so its material never reaches this realm.
   */
  function KeyObject(type, bytes, id) {
    KEY_STATE.set(this, { kind: 'key', type: type, bytes: bytes, id: id });
  }

  function keyStateOf(key, kind) {
    var state = key !== null && typeof key === 'object' ? KEY_STATE.get(key) : undefined;
    if (state === undefined || (kind !== undefined && state.kind !== kind)) return undefined;
    return state;
  }

  function base64url(bytes) {
    return Buf.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  Object.defineProperties(KeyObject.prototype, {
    type: { get: function () { return keyStateOf(this, 'key').type; } },
    symmetricKeySize: {
      get: function () {
        var state = keyStateOf(this, 'key');
        return state.type === 'secret' ? state.bytes.length : undefined;
      }
    },
    asymmetricKeyType: { get: function () { return keyInfo(this).asymmetricKeyType; } },
    asymmetricKeyDetails: { get: function () { return keyInfo(this).asymmetricKeyDetails; } }
  });

  /* What a key is: answered by the host for a handle, and undefined for a secret key. */
  function keyInfo(key) {
    var state = keyStateOf(key, 'key');
    if (state === undefined) throw invalidArgType('key', 'an instance of KeyObject', key);
    if (state.id === undefined) return { asymmetricKeyType: undefined, asymmetricKeyDetails: undefined };
    if (state.info === undefined) {
      state.info = cryptoCap('crypto.key.info', { id: state.id });
      /* Node answers an RSA publicExponent as a BigInt, which no capability argument can carry. */
      var details = state.info.asymmetricKeyDetails;
      if (details !== undefined && details !== null && typeof details.publicExponent === 'string') {
        details.publicExponent = BigInt(details.publicExponent);
      }
    }
    return state.info;
  }

  KeyObject.prototype.export = function (options) {
    var state = keyStateOf(this, 'key');
    if (state.type === 'secret') {
      /* Node lets a secret key be exported with no options at all; only 'buffer' and 'jwk' are shapes. */
      if (options !== undefined && options !== null) {
        if (options === null || typeof options !== 'object') throw invalidArgType('options', 'of type object', options);
        if (options.format !== undefined && options.format !== 'buffer' && options.format !== 'jwk') {
          throw invalidArgValue('options.format', options.format, "must be one of: undefined, 'buffer', 'jwk'");
        }
        if (options.format === 'jwk') return { kty: 'oct', k: base64url(state.bytes) };
      }
      return Buf.from(state.bytes);
    }
    if (options === undefined || options === null) throw invalidArgType('options', 'of type object', options);
    if (typeof options !== 'object') throw invalidArgType('options', 'of type object', options);
    if (options.format !== 'pem' && options.format !== 'der' && options.format !== 'jwk') {
      throw invalidArgValue('options.format', options.format);
    }
    var opts = options;
    var format = opts.format;
    var result = cryptoCap('crypto.key.export', { id: state.id, format: format, type: opts.type });
    if (format === 'jwk') return result.jwk;
    /* A PEM export is text on Node, and a DER one is bytes: only the latter comes back as a Buffer. */
    var bytes = Buf.from(result.bytes, 'base64');
    return format === 'pem' ? bytes.toString('utf8') : bytes;
  };

  KeyObject.prototype.equals = function (other) {
    if (!(other instanceof KeyObject)) throw invalidArgType('otherKeyObject', 'an instance of KeyObject', other);
    var a = keyStateOf(this, 'key');
    var b = keyStateOf(other, 'key');
    if (a.id !== undefined || b.id !== undefined) {
      if (a.id === undefined || b.id === undefined) return false;
      return cryptoCap('crypto.key.equal', { a: a.id, b: b.id }) === true;
    }
    if (a.type !== b.type || a.bytes.length !== b.bytes.length) return false;
    return timingSafeEqual(a.bytes, b.bytes);
  };

  /* A secret key is bytes: a string is read with the encoding, and Node's message for anything
     else names no string of its own, so a KeyObject is refused as "Received an instance of ...". */
  function secretKeyBytes(value) {
    if (!(Buf.isBuffer(value) || ArrayBuffer.isView(value) || value instanceof ArrayBuffer)) {
      var err = new TypeError('The "key" argument must be an instance of ArrayBuffer, Buffer, TypedArray, or DataView. Received ' + receivedAs(value));
      err.code = 'ERR_INVALID_ARG_TYPE';
      throw err;
    }
    return toBytes(value, undefined, 'key');
  }

  function createSecretKey(key, encoding) {
    var bytes = typeof key === 'string' ? Buf.from(key, encoding) : secretKeyBytes(key);
    return new KeyObject('secret', Buf.from(bytes));
  }

  /*
   * createPublicKey and createPrivateKey. The key a caller hands in is PEM or DER text, a Buffer
   * holding either, a JWK, or -- for createPublicKey -- a private KeyObject whose public half is
   * what the caller wants back.
   */
  function isKeyObject(value) {
    var state = value !== null && typeof value === 'object' ? KEY_STATE.get(value) : undefined;
    return state !== undefined && state.kind === 'key';
  }

  /* Node names the class in the message for a key object: "Received an instance of PrivateKeyObject". */
  function asReceived(key) {
    var state = key !== null && typeof key === 'object' ? KEY_STATE.get(key) : undefined;
    if (state === undefined || state.kind !== 'key') return typeof key;
    if (state.type === 'secret') return 'an instance of SecretKeyObject';
    return state.type === 'public' ? 'an instance of PublicKeyObject' : 'an instance of PrivateKeyObject';
  }

  /* The shapes a {key, ...} wrapper may carry inside it: a string, a Buffer, a TypedArray, a
     DataView or an ArrayBuffer. Anything else is not key material, and Node says so by name. */
  function isKeyMaterial(value) {
    return typeof value === 'string' || Buf.isBuffer(value) || ArrayBuffer.isView(value) || value instanceof ArrayBuffer;
  }

  /* Node names the property inside a {key, ...} wrapper when what is in it is not key material.
     A public import names KeyObject and CryptoKey in the list, a private one does not. */
  function keyWrapperError(inner, withKeyObject) {
    var list = withKeyObject
      ? 'string or an instance of ArrayBuffer, Buffer, TypedArray, DataView, KeyObject, or CryptoKey'
      : 'string or an instance of ArrayBuffer, Buffer, TypedArray, or DataView';
    var err = new TypeError('The "key.key" property must be of type ' + list + '. Received ' + receivedAs(inner));
    err.code = 'ERR_INVALID_ARG_TYPE';
    return err;
  }

  function importKey(want, keyObjectNamed) {
    var named = keyObjectNamed === undefined ? want === 'public' : keyObjectNamed === true;
    return function (key) {
      if (key === undefined || key === null) {
        var list = named
          ? 'string or an instance of ArrayBuffer, Buffer, TypedArray, DataView, KeyObject, or CryptoKey'
          : 'string or an instance of ArrayBuffer, Buffer, TypedArray, or DataView';
        throw invalidArgType('key', 'of type ' + list, key);
      }
      /* A {key, format, type, passphrase} wrapper: Node's own callers pass the material inside it. */
      var given = key;
      var type = undefined;
      var passphrase = undefined;
      var wrapped = false;
      if (typeof key === 'object' && key !== null && Object.prototype.hasOwnProperty.call(key, 'key')) {
        given = key.key;
        type = key.type;
        passphrase = key.passphrase;
        wrapped = true;
      } else if (typeof key === 'object' && key !== null && key.format === 'jwk' && key.key !== undefined) {
        given = key.key;
        wrapped = true;
      }
      /* A KeyObject is accepted only as the source of a public key: Node derives the public half. */
      if (isKeyObject(given)) {
        var state = keyStateOf(given, 'key');
        if (want !== 'public') {
          var err = new TypeError('The "key" argument must be of type string or an instance of ArrayBuffer, Buffer, TypedArray, or DataView. Received ' + asReceived(given));
          err.code = 'ERR_INVALID_ARG_TYPE';
          throw err;
        }
        if (state.type !== 'private') {
          var wrong = new Error('Invalid key object type ' + state.type + ', expected private.');
          wrong.code = 'ERR_CRYPTO_INVALID_KEY_OBJECT_TYPE';
          throw wrong;
        }
        return new KeyObject('public', undefined, cryptoCap('crypto.key.public', { id: state.id }).id);
      }
      var jwk = undefined;
      var bytes = undefined;
      if (wrapped && !isKeyMaterial(given) && !(given !== null && typeof given === 'object' && typeof given.kty === 'string')) {
        throw keyWrapperError(given, named);
      }
      if (given !== null && typeof given === 'object' && !(given instanceof Buf) && !ArrayBuffer.isView(given) && !(given instanceof ArrayBuffer)) {
        /* A plain object with no key material in it is the wrapper Node reads it as, and the
           property it names in the message is the one inside: "The "key.key" property must be of
           type string or an instance of ArrayBuffer, Buffer, TypedArray, or DataView. Received
           undefined" for createPrivateKey({}), where createPublicKey names KeyObject and CryptoKey
           too and a sign or a verify names them as a public key does. */
        if (typeof given.kty !== 'string') throw keyWrapperError(key.key, named);
        jwk = given;
      } else {
        bytes = toBytes(given, undefined, 'key', named
          ? 'string or an instance of ArrayBuffer, Buffer, TypedArray, DataView, KeyObject, or CryptoKey'
          : undefined).toString('base64');
      }
      var opened = cryptoCap('crypto.key.import', { want: want, jwk: jwk, bytes: bytes, type: type, passphrase: passphrase === undefined ? undefined : String(passphrase) });
      return new KeyObject(want, undefined, opened.id);
    };
  }

  /* Any key form -- KeyObject, PEM, DER, JWK or a {key, ...} wrapper -- as a handle the host signs with. */
  function keyIdOf(key, want) {
    /* A {key, dsaEncoding} wrapper around a KeyObject: the encoding rides along, the key is inside. */
    if (key !== null && typeof key === 'object' && !isKeyObject(key) && Object.prototype.hasOwnProperty.call(key, 'key')) {
      var inner = keyStateOf(key.key, 'key');
      if (inner !== undefined) {
        if (inner.id === undefined) throw invalidArgType('key', 'an instance of KeyObject', key.key);
        if (want === 'public' && inner.type === 'private') return cryptoCap('crypto.key.public', { id: inner.id }).id;
        return inner.id;
      }
    }
    var state = keyStateOf(key, 'key');
    if (state !== undefined) {
      if (state.id === undefined) throw invalidArgType('key', 'an instance of KeyObject', key);
      if (want === 'public' && state.type === 'private') return cryptoCap('crypto.key.public', { id: state.id }).id;
      return state.id;
    }
    /* A sign or a verify names KeyObject and CryptoKey in the list, as a public import does. */
    return keyStateOf(importKey(want, true)(key), 'key').id;
  }

  var createPublicKey = importKey('public');
  var createPrivateKey = importKey('private');

  /*
   * generateKeyPairSync and generateKeyPair. Node's options carry the curve, the encoding of each
   * half and, for the asynchronous form, a callback; the pair itself is made on the host.
   */
  function keyPairOf(result, options) {
    var publicEncoding = options && options.publicKeyEncoding;
    var privateEncoding = options && options.privateKeyEncoding;
    var pair = {
      publicKey: new KeyObject('public', undefined, result.public),
      privateKey: new KeyObject('private', undefined, result.private)
    };
    if (publicEncoding !== undefined && publicEncoding !== null) {
      pair.publicKey = exportedKey(pair.publicKey, publicEncoding, 'spki');
    }
    if (privateEncoding !== undefined && privateEncoding !== null) {
      pair.privateKey = exportedKey(pair.privateKey, privateEncoding, 'pkcs8');
    }
    return pair;
  }

  /* A key half Node hands back as text instead of as a KeyObject, when its encoding asks for it.
     A '{format: 'jwk'}' encoding is the one shape that is not bytes at all: Node answers the JWK
     object itself, so 'generateKeyPairSync('ec', {publicKeyEncoding: {format: 'jwk'}})' gives a
     caller '{"kty": "EC", "crv": "P-256", ...}' and not a Buffer it never made. */
  function exportedKey(key, encoding, defaultType) {
    var result = cryptoCap('crypto.key.export', {
      id: keyStateOf(key, 'key').id,
      format: encoding.format === undefined ? 'pem' : encoding.format,
      type: encoding.type === undefined ? defaultType : encoding.type
    });
    if (encoding.format === 'jwk') return result.jwk;
    var bytes = Buf.from(result.bytes, 'base64');
    return typeof encoding.format === 'string' ? bytes.toString('utf8') : bytes;
  }

  /*
   * Node reads options as an object whenever a caller hands it one at all: ed25519, ed448, x25519,
   * x448 and ec need none and still refuse 1, while rsa, rsa-pss, dsa and dh refuse an absent one
   * too, because each of them reads a size out of it.
   */
  function generateKeyPairSync(type, options) {
    /*
     * Node reads the key type as text before it looks it up, so a value that is not text is a type
     * error and not the 'supported key type' refusal a name it does not know answers.
     */
    if (typeof type !== 'string') throw invalidArgType('type', 'of type string', type);
    /*
     * A null options object is Node's own failure: it destructures the encodings out of options
     * before it has established that there is an options object, so the message names the property
     * it reached for and not the argument it was handed.
     */
    if (options === null) {
      throw new TypeError("Cannot destructure property 'publicKeyEncoding' of 'options' as it is null.");
    }
    if (options !== undefined && typeof options !== 'object') {
      throw invalidArgType('options', 'of type object', options);
    }
    return keyPairOf(cryptoCap('crypto.key.generate', { type: String(type), options: options === undefined ? undefined : wrapOptions(options) }), options);
  }

  function generateKeyPair(type, options, callback) {
    var done = callback;
    var opts = options;
    if (typeof options === 'function') {
      done = options;
      opts = undefined;
    }
    if (typeof done !== 'function') throw invalidArgType('callback', 'of type function', done);
    var pair = generateKeyPairSync(type, opts);
    queueMicrotask(function () { done(null, pair.publicKey, pair.privateKey); });
  }

  /* Only the fields the host reads travel; a callback or an encoding it does not use stays here. */
  /*
   * A width has to be checked on this side of the call and not by the capability that receives it:
   * NaN, Infinity and a BigInt are values the JSON between the two cannot carry, and they would
   * arrive as null or refuse to be serialised at all. Node names the value it was handed, so the
   * type check and the whole-number check both happen here, before anything is sent.
   */
  function widthOption(options, name) {
    var value = options[name];
    if (typeof value !== 'number') throw invalidPropertyType('options.' + name, 'number', value);
    if (!Number.isInteger(value)) throw outOfRange('options.' + name, 'an integer', String(value));
    return value;
  }

  function wrapOptions(options) {
    if (options === null || typeof options !== 'object') return undefined;
    var out = {};
    if (options.namedCurve !== undefined) out.namedCurve = options.namedCurve;
    if (options.modulusLength !== undefined) out.modulusLength = widthOption(options, 'modulusLength');
    if (options.publicExponent !== undefined && typeof options.publicExponent !== 'number') {
      throw invalidPropertyType('options.publicExponent', 'number', options.publicExponent);
    }
    if (options.publicExponent !== undefined) out.publicExponent = options.publicExponent;
    if (options.paramType !== undefined) out.paramType = options.paramType;
    /* DSA names the width of its subprime, and DH the width of its prime, each in its own option. */
    if (options.divisorLength !== undefined) out.divisorLength = widthOption(options, 'divisorLength');
    if (options.primeLength !== undefined) out.primeLength = widthOption(options, 'primeLength');
    if (options.generator !== undefined) out.generator = options.generator;
    return out;
  }

  /*
   * createSign and createVerify. The message is collected here and signed or checked in one host
   * call, the way createHash digests: the streaming surface is Node's, the key is not.
   */
  function Sign(algorithm) {
    /* createSign names a digest: Node rejects null, which is what crypto.sign() takes instead. */
    if (typeof algorithm !== 'string') throw invalidArgType('algorithm', 'of type string', algorithm);
    if (!digestKnown(algorithm)) throw invalidDigest(undefined);
    this._algorithm = String(algorithm);
    this._chunks = [];
    /*
     * A Sign is consumed by its own answer: Node's object is uninitialised again the moment it
     * signs, and not even a fresh update() re-arms it, so a second sign() on it answers
     * 'Not initialised'. Signing nothing at all is allowed -- the message is simply empty.
     */
    this._used = false;
  }
  Sign.prototype.update = function (data, encoding) {
    this._chunks.push(toDataBytes(data, encoding, 'data', 'string or an instance of Buffer, TypedArray, or DataView'));
    return this;
  };
  Sign.prototype.sign = function (privateKey, encoding) {
    if (this._used) throw cipherStateError('Not initialised');
    if (privateKey === undefined || privateKey === null) throw noKeyToSign();
    this._used = true;
    var signature = cryptoCap('crypto.key.sign', {
      id: keyIdOf(privateKey, 'private'),
      algorithm: this._algorithm,
      data: Buf.concat(this._chunks).toString('base64'),
      dsaEncoding: privateKey !== null && typeof privateKey === 'object' ? privateKey.dsaEncoding : undefined,
      padding: privateKey !== null && typeof privateKey === 'object' ? privateKey.padding : undefined,
      saltLength: privateKey !== null && typeof privateKey === 'object' ? privateKey.saltLength : undefined,
      /* A Sign object always names a digest, and a pure key that is handed one answers
         "Unsupported crypto operation" where the one-shot crypto.sign names OpenSSL's digest. */
      fromSign: true
    });
    return outputStrict(Buf.from(signature, 'base64'), encoding);
  };
  Sign.prototype.end = function () { return this; };

  function Verify(algorithm) {
    if (typeof algorithm !== 'string') throw invalidArgType('algorithm', 'of type string', algorithm);
    if (!digestKnown(algorithm)) throw invalidDigest(undefined);
    this._algorithm = String(algorithm);
    this._chunks = [];
    this._used = false;
  }
  Verify.prototype.update = function (data, encoding) {
    this._chunks.push(toDataBytes(data, encoding, 'data', 'string or an instance of Buffer, TypedArray, or DataView'));
    return this;
  };
  Verify.prototype.verify = function (publicKey, signature, encoding) {
    /* A verify consumes what it was fed for good: Node's own object is uninitialised again the
       moment it answers, and not even a second update() re-arms it, so any later verify() on the
       same object throws 'Not initialised'. A verify that was fed nothing does not throw: it has
       nothing to check a signature against and answers false. */
    if (this._used) throw cipherStateError('Not initialised');
    this._used = true;
    if (this._chunks.length === 0) return false;
    var data = Buf.concat(this._chunks);
    this._chunks = [];
    return cryptoCap('crypto.key.verify', {
      id: keyIdOf(publicKey, 'public'),
      algorithm: this._algorithm,
      data: data.toString('base64'),
      /*
       * The encoding of the signature is read only when it is text: a number, a Symbol or null in
       * that slot leaves Node decoding the signature as a string, which is why verify(key, sig, 1)
       * answers false where verify(key, sig, 'nope') refuses the encoding outright.
       */
      signature: toBytes(signature, typeof encoding === 'string' ? encoding : 'utf8', 'signature').toString('base64'),
      dsaEncoding: publicKey !== null && typeof publicKey === 'object' ? publicKey.dsaEncoding : undefined,
      padding: publicKey !== null && typeof publicKey === 'object' ? publicKey.padding : undefined,
      saltLength: publicKey !== null && typeof publicKey === 'object' ? publicKey.saltLength : undefined,
      fromVerify: true
    }) === true;
  };
  Verify.prototype.end = function () { return this; };

  function createSign(algorithm) {
    return new Sign(algorithm);
  }

  function createVerify(algorithm) {
    return new Verify(algorithm);
  }

  /* sign and verify without a streaming object: one call over the same capability. */
  function signOne(algorithm, data, key, callback) {
    /* Node names the arguments in the order it reads them: the data, then the key. */
    var algo = algorithmOf(algorithm);
    var bytes = toBytes(data, undefined, 'data').toString('base64');
    if (key === undefined || key === null) throw noKeyToSign();
    var signature = Buf.from(cryptoCap('crypto.key.sign', {
      id: keyIdOf(key, 'private'),
      algorithm: algo,
      data: bytes,
      dsaEncoding: key !== null && typeof key === 'object' ? key.dsaEncoding : undefined,
      padding: key !== null && typeof key === 'object' ? key.padding : undefined,
      saltLength: key !== null && typeof key === 'object' ? key.saltLength : undefined
    }), 'base64');
    if (typeof callback === 'function') {
      queueMicrotask(function () { callback(null, signature); });
      return undefined;
    }
    return signature;
  }

  /*
   * The dsaEncoding, padding and saltLength a one-shot call reads off its key. The reads happen
   * before the data and the signature are looked at, so a key that is missing fails here -- on
   * the property read, the way Node's own code does -- rather than on a type check of its own.
   */
  function keyOptionsOf(key) {
    /*
     * Node reads the key's own options before it looks at the data or the signature, and it reads
     * padding first, so a key that is not there fails on that read and not on a type check. This
     * runtime's engine words the read its own way, and the host's wording is what a caller sees,
     * so the read is guarded and the message is the one V8 gives for it.
     */
    if (key === undefined || key === null) {
      throw new TypeError("Cannot read properties of " + String(key) + " (reading 'padding')");
    }
    var padding = key.padding;
    var dsaEncoding = key.dsaEncoding;
    var saltLength = key.saltLength;
    return { dsaEncoding: dsaEncoding, padding: padding, saltLength: saltLength };
  }

  function verifyOne(algorithm, data, key, signature, callback) {
    var algo = algorithmOf(algorithm);
    var bytes = verifyDataBytes(data).toString('base64');
    /*
     * The key's own options are read next, after the data and before the signature: a key that is
     * not there fails on that read -- Node's own code reads padding first, and its message names
     * padding -- while data that is not data is refused as data before the key is looked at.
     */
    var opts = keyOptionsOf(key);
    var sig = signatureBytes(signature).toString('base64');
    var answer = cryptoCap('crypto.key.verify', {
      id: keyIdOf(key, 'public'),
      algorithm: algo,
      data: bytes,
      signature: sig,
      dsaEncoding: opts.dsaEncoding,
      padding: opts.padding,
      saltLength: opts.saltLength
    }) === true;
    if (typeof callback === 'function') {
      queueMicrotask(function () { callback(null, answer); });
      return undefined;
    }
    return answer;
  }

  /*
   * Diffie-Hellman. The prime, the generator and the exponents live on the host; this object is
   * the surface Node's callers use, and every one of its calls is one capability round trip.
   */
  function DiffieHellman(id) {
    var self = this;
    /*
     * The host's handle and the cached bits are not part of Node's surface: a DiffieHellman that
     * somebody JSON.stringify()s carries verifyError and nothing else, so they sit on it hidden.
     */
    Object.defineProperty(self, '_id', { value: id, writable: true, configurable: true });
    Object.defineProperty(self, '_verifyError', { value: undefined, writable: true, configurable: true });
    /*
     * Node's DH_check bits, kept as the own enumerable property a DiffieHellman has them on. They
     * are read the first time a caller asks: deciding whether a 1024-bit modulus is prime is two
     * Miller-Rabin searches, and a DiffieHellman nobody asks about is made in the time those take.
     */
    Object.defineProperty(self, 'verifyError', {
      enumerable: true,
      configurable: true,
      get: function () {
        if (self._verifyError === undefined) self._verifyError = cryptoCap('crypto.dh.verify', { id: self._id }).code;
        return self._verifyError;
      }
    });
  }
  /*
   * Node's DiffieHellman hands back the number it computed and nothing else: a public key of 4 in
   * a 128-byte group is the one byte 0x04 and not 128 bytes with 127 zeroes in front of it. The
   * prime and the generator are the group's, and those are padded to the width of the prime.
   */
  function withoutLeadingZeros(bytes) {
    var at = 0;
    while (at < bytes.length && bytes[at] === 0) at++;
    return at === 0 ? bytes : bytes.slice(at);
  }

  DiffieHellman.prototype.generateKeys = function (encoding) {
    var keys = cryptoCap('crypto.dh.keys', { id: this._id });
    this._public = withoutLeadingZeros(Buf.from(keys.public, 'base64'));
    this._private = withoutLeadingZeros(Buf.from(keys.private, 'base64'));
    return outputStrict(this._public, encoding);
  };
  DiffieHellman.prototype.getPrime = function (encoding) {
    return outputStrict(Buf.from(cryptoCap('crypto.dh.info', { id: this._id }).prime, 'base64'), encoding);
  };
  DiffieHellman.prototype.getGenerator = function (encoding) {
    return outputStrict(Buf.from(cryptoCap('crypto.dh.info', { id: this._id }).generator, 'base64'), encoding);
  };
  /*
   * A public key is made from a private one by generateKeys(), not by setPrivateKey(): Node keeps
   * them separate, so setting one half leaves the other unset and getPublicKey() says so.
   */
  DiffieHellman.prototype.getPublicKey = function (encoding) {
    if (this._public === undefined) throw cipherStateError('No public key - did you forget to generate one?');
    return outputStrict(this._public, encoding);
  };
  DiffieHellman.prototype.getPrivateKey = function (encoding) {
    if (this._private === undefined) throw cipherStateError('No private key - did you forget to generate one?');
    return outputStrict(this._private, encoding);
  };
  DiffieHellman.prototype.setPublicKey = function (key, encoding) {
    this._public = toBytes(key, encoding, 'publicKey');
    cryptoCap('crypto.dh.set', { id: this._id, public: this._public.toString('base64') });
    return this;
  };
  DiffieHellman.prototype.setPrivateKey = function (key, encoding) {
    this._private = toBytes(key, encoding, 'privateKey');
    this._public = undefined;
    cryptoCap('crypto.dh.set', { id: this._id, private: this._private.toString('base64') });
    return this;
  };
  DiffieHellman.prototype.computeSecret = function (otherPublicKey, inputEncoding, outputEncoding) {
    var other = toBytes(otherPublicKey, inputEncoding, 'otherPublicKey');
    /*
     * A key with no bytes in it is refused before anything is computed, and an object that has no
     * private key of its own yet -- which is where a fresh createDiffieHellman starts, until
     * generateKeys() or setPrivateKey() gives it one -- answers nothing at all rather than
     * throwing: Node's computeSecret returns an empty buffer in that state, not an error.
     */
    if (other.length === 0) {
      var small = new RangeError('Supplied key is too small');
      small.code = 'ERR_CRYPTO_INVALID_KEYLEN';
      throw small;
    }
    if (this._private === undefined) return outputOf(Buf.alloc(0), outputEncoding);
    var secret = Buf.from(cryptoCap('crypto.dh.secret', {
      id: this._id,
      public: other.toString('base64')
    }), 'base64');
    return outputOf(secret, outputEncoding);
  };

  /*
   * createDiffieHellman: either a size in bits (which picks the standard group of that size, or a
   * fresh prime when there is none) or an explicit prime, with an optional generator.
   */
  function createDiffieHellman(prime, generatorOrEncoding, generator, generatorEncoding) {
    var args = { generatorIsNumber: false };
    if (typeof prime === 'number') {
      args.bits = prime;
      if (generatorOrEncoding !== undefined && generatorOrEncoding !== null) {
        if (typeof generatorOrEncoding === 'number') {
          args.generator = generatorOrEncoding;
          args.generatorIsNumber = true;
        } else {
          args.generator = toBytes(generatorOrEncoding, undefined, 'generator').toString('base64');
        }
      }
    } else {
      /* Node's one argument here is 'sizeOrKey' -- a width or the prime itself -- and its message
         names both in the list, so a value that is neither is refused under that name. */
      if (!(typeof prime === 'string' || Buf.isBuffer(prime) || ArrayBuffer.isView(prime) || prime instanceof ArrayBuffer)) {
        var sizeOrKey = new TypeError('The "sizeOrKey" argument must be one of type number or string or an instance of ArrayBuffer, Buffer, TypedArray, or DataView. Received ' + receivedAs(prime));
        sizeOrKey.code = 'ERR_INVALID_ARG_TYPE';
        throw sizeOrKey;
      }
      args.prime = toBytes(prime, typeof generatorOrEncoding === 'string' ? generatorOrEncoding : undefined, 'sizeOrKey').toString('base64');
      if (generator !== undefined && generator !== null) {
        if (typeof generator === 'number') {
          args.generator = generator;
          args.generatorIsNumber = true;
        } else {
          args.generator = toBytes(generator, generatorEncoding, 'generator').toString('base64');
        }
      } else if (typeof generatorOrEncoding === 'number') {
        args.generator = generatorOrEncoding;
        args.generatorIsNumber = true;
      }
    }
    return new DiffieHellman(cryptoCap('crypto.dh.create', args).id);
  }

  /* The width of the secret key generateKey and generateKeySync are asked for, in bytes. */
  function secretKeyLengthOf(type, options) {
    if (typeof type !== 'string') throw invalidArgType('type', 'of type string', type);
    if (type !== 'hmac' && type !== 'aes') throw invalidArgValue('type', type);
    if (options === null || typeof options !== 'object') {
      throw invalidArgType('options', 'of type object', options);
    }
    var length = options.length;
    if (typeof length !== 'number') throw invalidArgType('options.length', 'of type number', length);
    if (!(length >= 1 && length <= 4294967295)) {
      throw outOfRange('options.length', '>= 1 && <= 4294967295', length);
    }
    if (type === 'aes' && length !== 128 && length !== 192 && length !== 256) {
      throw invalidArgValue('options.length', length, 'must be one of: 128, 192, 256');
    }
    return Math.ceil(length / 8);
  }

  function createDiffieHellmanGroup(name) {
    /* Node reads the group name as a string before it looks it up, so a number is a type error and
       not the ERR_CRYPTO_UNKNOWN_DH_GROUP an unresolvable name answers. */
    if (typeof name !== 'string') {
      var notText = new TypeError('Group name must be a string');
      notText.code = 'ERR_INVALID_ARG_TYPE';
      throw notText;
    }
    return new DiffieHellman(cryptoCap('crypto.dh.group', { name: name }).id);
  }

  /* Node's getDiffieHellman is the same call under its older name: a standard MODP group by name. */
  var getDiffieHellman = createDiffieHellmanGroup;

  /*
   * diffieHellman({privateKey, publicKey}): the shared secret with no object to keep. Node takes two
   * KeyObjects and nothing else -- a prime belongs to createDiffieHellman, not here -- so anything
   * else in either slot is an invalid value rather than key material to import.
   */
  function diffieHellman(options) {
    /* Node reads the options object itself before it reads either key out of it: a call with no
       object at all is an argument type error naming 'options', not an invalid value. */
    if (options === null || typeof options !== 'object') {
      throw invalidArgType('options', 'of type object', options);
    }
    var opts = options;
    if (!isKeyObject(opts.privateKey)) throw invalidArgValue('options.privateKey', opts.privateKey);
    if (!isKeyObject(opts.publicKey)) throw invalidArgValue('options.publicKey', opts.publicKey);
    return Buf.from(cryptoCap('crypto.dh.ecdh', {
      private: keyIdOf(opts.privateKey, 'private'),
      public: keyIdOf(opts.publicKey, 'public')
    }), 'base64');
  }

  /*
   * privateEncrypt, publicDecrypt, publicEncrypt and privateDecrypt: the raw RSA operation with no
   * digest in the way. 'op' names which one, and 'want' the half of the key pair it runs with --
   * a private encrypt and a private decrypt need the private half, and the two public ones take
   * either, because a public exponent is what both of them raise with.
   */
  function rsaCipher(op, want) {
    return function (key, buffer) {
      var given = key;
      var padding = undefined;
      var oaepHash = undefined;
      var oaepLabel = undefined;
      /* A {key, padding, oaepHash, oaepLabel} wrapper, which is how a caller names the padding. */
      if (given !== null && typeof given === 'object' && !isKeyObject(given) &&
        Object.prototype.hasOwnProperty.call(given, 'key')) {
        padding = given.padding;
        oaepHash = given.oaepHash;
        oaepLabel = given.oaepLabel;
        given = given.key;
      }
      var state = keyStateOf(given, 'key');
      /* An OAEP hash Node does not carry is named before the operation runs, whatever padding the
         call asked for: OpenSSL resolves the digest and answers ERR_OSSL_EVP_INVALID_DIGEST. */
      if (oaepHash !== undefined && oaepHash !== null && !digestKnown(String(oaepHash))) {
        var noDigest = new Error('Invalid digest used');
        noDigest.code = 'ERR_OSSL_EVP_INVALID_DIGEST';
        throw noDigest;
      }
      if (state !== undefined && want === 'private' && state.type !== 'private') {
        var wrong = new TypeError('Invalid key object type ' + state.type + ', expected private.');
        wrong.code = 'ERR_CRYPTO_INVALID_KEY_OBJECT_TYPE';
        throw wrong;
      }
      var id = keyIdOf(given, want);
      var data = toBytes(buffer, undefined, 'buffer');
      var label = oaepLabel === undefined || oaepLabel === null
        ? undefined : toBytes(oaepLabel, undefined, 'oaepLabel').toString('base64');
      return Buf.from(cryptoCap('crypto.rsa.raw', {
        id: id,
        op: op,
        data: data.toString('base64'),
        padding: padding === undefined || padding === null ? undefined : Number(padding),
        oaepHash: oaepHash === undefined || oaepHash === null ? undefined : String(oaepHash),
        oaepLabel: label
      }), 'base64');
    };
  }

  var privateEncrypt = rsaCipher('private-encrypt', 'private');
  var publicDecrypt = rsaCipher('public-decrypt', 'public');
  var publicEncrypt = rsaCipher('public-encrypt', 'public');
  var privateDecrypt = rsaCipher('private-decrypt', 'private');

  function keyBytesOf(key) {
    var state = keyStateOf(key, 'key');
    if (state === undefined) {
      return toBytes(key, undefined, 'key', 'string or an instance of ArrayBuffer, Buffer, TypedArray, DataView, KeyObject, or CryptoKey');
    }
    if (state.type !== 'secret') throw asymmetricUnavailable('createHmac');
    return state.bytes;
  }

  /* createHash and createHmac: the bytes are collected here and digested by the host in one call */
  function Hash(algorithm, key, outputLength) {
    this._algorithm = String(algorithm);
    this._key = key;
    this._outputLength = outputLength;
    this._chunks = [];
    this._finished = false;
  }
  Hash.prototype.update = function (data, encoding) {
    if (this._finished) {
      var sealed = new Error('Digest already called');
      sealed.code = 'ERR_CRYPTO_HASH_FINALIZED';
      throw sealed;
    }
    var bytes = toDataBytes(data, encoding, 'data', 'string or an instance of Buffer, TypedArray, or DataView');
    this._chunks.push(bytes);
    return this;
  };
  Hash.prototype.digest = function (encoding) {
    if (this._finished) {
      /* Node's Hmac answers empty on a second digest where a Hash refuses: the two really differ. */
      if (this._key !== undefined) return outputOf(Buf.alloc(0), encoding);
      var again = new Error('Digest already called');
      again.code = 'ERR_CRYPTO_HASH_FINALIZED';
      throw again;
    }
    this._finished = true;
    var data = Buf.concat(this._chunks).toString('base64');
    var out = this._key === undefined
      ? cryptoCap('crypto.digest', { algorithm: this._algorithm, data: data, outputLength: this._outputLength })
      : cryptoCap('crypto.hmac', { algorithm: this._algorithm, key: this._key.toString('base64'), data: data });
    return outputOf(Buf.from(out, 'base64'), encoding);
  };
  Hash.prototype.copy = function () {
    var copy = new Hash(this._algorithm, this._key, this._outputLength);
    copy._chunks = this._chunks.slice();
    return copy;
  };

  /*
   * Only shake128 and shake256 read outputLength: they are the two extensible-output digests.
   * Node bounds it the same way it bounds any length, and accepts 0, which digests to nothing.
   */
  function outputLengthOf(options) {
    var given = options === undefined || options === null ? undefined : options.outputLength;
    if (given === undefined) return undefined;
    if (typeof given !== 'number') {
      var bad = new TypeError('The "options.outputLength" property must be of type number. Received type ' + typeof given + " ('" + String(given) + "')");
      bad.code = 'ERR_INVALID_ARG_TYPE';
      throw bad;
    }
    if (!(given >= 0 && given <= 4294967295)) throw outOfRange('options.outputLength', '>= 0 && <= 4294967295', given);
    return given;
  }

  function createHash(algorithm, options) {
    /* Node reads the algorithm as a string before it looks it up, so a number is a type error
       and not the bare 'Digest method not supported' an unresolvable name answers. */
    if (typeof algorithm !== 'string') throw invalidArgType('algorithm', 'of type string', algorithm);
    if (!digestKnown(algorithm)) throw new Error('Digest method not supported');
    return new Hash(algorithm, undefined, outputLengthOf(options));
  }

  function createHmac(algorithm, key, options) {
    if (!digestKnown(algorithm)) throw invalidDigest(String(algorithm));
    return new Hash(algorithm, keyBytesOf(key), outputLengthOf(options));
  }

  function hash(algorithm, data, outputEncoding) {
    /* Node's one-shot helper names the algorithm in its refusal, which createHash does not. */
    if (!digestKnown(algorithm)) throw new Error('Digest method ' + String(algorithm) + ' is not supported');
    return createHash(algorithm).update(data).digest(outputEncoding === undefined ? 'hex' : outputEncoding);
  }

  function pbkdf2Sync(password, salt, iterations, keylen, digest) {
    /* Node names the digest every time: there is no default, and an iteration count starts at 1. */
    if (typeof digest !== 'string') throw invalidArgType('digest', 'of type string', digest);
    if (!digestKnown(digest)) throw invalidDigest(digest);
    if (typeof iterations !== 'number') throw invalidArgType('iterations', 'of type number', iterations);
    if (Math.floor(iterations) !== iterations) throw outOfRange('iterations', 'an integer', iterations);
    if (typeof keylen !== 'number') throw invalidArgType('keylen', 'of type number', keylen);
    if (!(iterations >= 1 && iterations <= 2147483647)) {
      throw outOfRange('iterations', '>= 1 && <= 2147483647', iterations);
    }
    var len = keylen;
    if (!(len >= 0 && len <= 2147483647)) throw outOfRange('keylen', '>= 0 && <= 2147483647', keylen);
    /* A zero-length derivation is in range but produces nothing, which OpenSSL reports as a failure. */
    if (len === 0) throw new Error('Deriving bits failed');
    var out = cryptoCap('crypto.pbkdf2', {
      digest: String(digest),
      password: toBytes(password, undefined, 'password').toString('base64'),
      salt: toBytes(salt, undefined, 'salt').toString('base64'),
      iterations: iterations,
      keylen: len
    });
    return Buf.from(out, 'base64');
  }

  function pbkdf2(password, salt, iterations, keylen, digest, callback) {
    var key = pbkdf2Sync(password, salt, iterations, keylen, digest);
    queueMicrotask(function () { callback(null, key); });
  }

  /* The bytes of a timing-safe compare: Node's message for the pair ends at the list, it names no
     Received value and no "of type", and a string is not in the list -- the compare is over bytes. */
  function bufferInstance(value, name) {
    if (!(Buf.isBuffer(value) || ArrayBuffer.isView(value) || value instanceof ArrayBuffer)) {
      var err = new TypeError('The "' + name + '" argument must be an instance of ArrayBuffer, Buffer, TypedArray, or DataView.');
      err.code = 'ERR_INVALID_ARG_TYPE';
      throw err;
    }
    return toBytes(value, undefined, name);
  }

  function timingSafeEqual(a, b) {
    var left = bufferInstance(a, 'buf1');
    var right = bufferInstance(b, 'buf2');
    if (left.length !== right.length) {
      var length = new RangeError('Input buffers must have the same byte length');
      length.code = 'ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH';
      throw length;
    }
    var diff = 0;
    for (var i = 0; i < left.length; i++) diff |= left[i] ^ right[i];
    return diff === 0;
  }

  /*
   * getHashes, and the set it doubles as: Node rejects an unknown digest when the object is made,
   * not when it is used, so createHash and createHmac check the name against this list first.
   */
  var HASH_NAMES = null;
  function hashNames() {
    if (HASH_NAMES === null) {
      HASH_NAMES = {};
      var list = cryptoCap('crypto.hashes');
      for (var i = 0; i < list.length; i++) HASH_NAMES[String(list[i]).toLowerCase()] = true;
    }
    return HASH_NAMES;
  }

  function digestKnown(name) {
    return Object.prototype.hasOwnProperty.call(hashNames(), String(name).toLowerCase());
  }

  function getHashes() {
    return cryptoCap('crypto.hashes');
  }

  /*
   * getCurves is the curve directory OpenSSL ships, not the set this runtime can use: Node answers
   * all 82 names and then fails when a caller asks for a curve it has no arithmetic for, and so does
   * this. Only the four under EC_CURVES (plus ed25519/ed448/x25519/x448) actually generate or sign.
   */
  var CURVE_NAMES = [
        'Oakley-EC2N-3', 'Oakley-EC2N-4', 'SM2', 'brainpoolP160r1', 'brainpoolP160t1',
        'brainpoolP192r1', 'brainpoolP192t1', 'brainpoolP224r1', 'brainpoolP224t1', 'brainpoolP256r1',
        'brainpoolP256t1', 'brainpoolP320r1', 'brainpoolP320t1', 'brainpoolP384r1', 'brainpoolP384t1',
        'brainpoolP512r1', 'brainpoolP512t1', 'c2pnb163v1', 'c2pnb163v2', 'c2pnb163v3', 'c2pnb176v1',
        'c2pnb208w1', 'c2pnb272w1', 'c2pnb304w1', 'c2pnb368w1', 'c2tnb191v1', 'c2tnb191v2',
        'c2tnb191v3', 'c2tnb239v1', 'c2tnb239v2', 'c2tnb239v3', 'c2tnb359v1', 'c2tnb431r1',
        'prime192v1', 'prime192v2', 'prime192v3', 'prime239v1', 'prime239v2', 'prime239v3',
        'prime256v1', 'secp112r1', 'secp112r2', 'secp128r1', 'secp128r2', 'secp160k1', 'secp160r1',
        'secp160r2', 'secp192k1', 'secp224k1', 'secp224r1', 'secp256k1', 'secp384r1', 'secp521r1',
        'sect113r1', 'sect113r2', 'sect131r1', 'sect131r2', 'sect163k1', 'sect163r1', 'sect163r2',
        'sect193r1', 'sect193r2', 'sect233k1', 'sect233r1', 'sect239k1', 'sect283k1', 'sect283r1',
        'sect409k1', 'sect409r1', 'sect571k1', 'sect571r1', 'wap-wsg-idm-ecid-wtls1',
        'wap-wsg-idm-ecid-wtls10', 'wap-wsg-idm-ecid-wtls11', 'wap-wsg-idm-ecid-wtls12',
        'wap-wsg-idm-ecid-wtls3', 'wap-wsg-idm-ecid-wtls4', 'wap-wsg-idm-ecid-wtls5',
        'wap-wsg-idm-ecid-wtls6', 'wap-wsg-idm-ecid-wtls7', 'wap-wsg-idm-ecid-wtls8',
        'wap-wsg-idm-ecid-wtls9'
  ];

  function getCurves() {
    return CURVE_NAMES.slice();
  }

  /*
   * scrypt. Node derives on its thread pool and hands the key to a callback; here the derivation
   * is one synchronous host call and the callback still runs on a later microtask, so a caller
   * that awaits it behaves the same either way.
   */
  /*
   * scrypt names each parameter twice: N and cost, r and blockSize, p and parallelization. Node
   * reads whichever half it is handed and refuses to see both halves of one pair at once. A half
   * handed over as null was handed over, so it is a type error; one handed over as undefined was
   * not handed over at all, so it neither clashes with its pair nor offends the type check.
   */
  function scryptParam(opts, name, alias) {
    var own = opts[name];
    var other = opts[alias];
    if (own !== undefined && typeof own !== 'number') throw invalidArgType(name, 'of type number', own);
    if (other === undefined) return own;
    if (own !== undefined) {
      var clash = new TypeError('Option "' + name + '" cannot be used in combination with option "' + alias + '"');
      clash.code = 'ERR_INCOMPATIBLE_OPTION_PAIR';
      throw clash;
    }
    if (typeof other !== 'number') throw invalidArgType(alias, 'of type number', other);
    return other;
  }

  function scryptParams(message) {
    var err = new RangeError(message === undefined ? 'Invalid scrypt params' : message);
    err.code = 'ERR_CRYPTO_INVALID_SCRYPT_PARAMS';
    return err;
  }

  /* Node reads the refusal's reason off OpenSSL's error queue, and that queue is sticky: once a
     working set has failed its budget the reason stays on the queue, so a later bare 'invalid
     params' refusal -- N:1, say -- carries it too, until a scrypt call that succeeds clears it.
     A process that has never overrun its budget has an empty queue and answers bare. */
  var SCRYPT_MEM_REASON = 'error:030000AC:digital envelope routines::memory limit exceeded';
  var scryptReason = null;

  /* Node bounds N, r and p as unsigned 32-bit integers and maxmem as a safe integer before it
     reads a zero as 'not handed over': a value that is not an integer is an out-of-range error
     naming the integer, and one outside the range names the range -- so -1 and 4294967296 are
     refused where 0 still reaches the default and 16384 derives. */
  function scryptBound(name, value, top) {
    if (value === undefined) return;
    if (value !== Math.floor(value)) throw outOfRange(name, 'an integer', value);
    if (!(value >= 0 && value <= top)) throw outOfRange(name, '>= 0 && <= ' + top, value);
  }

  function scryptSync(password, salt, keylen, options) {
    var opts = options === undefined || options === null ? {} : options;
    /* keylen is a number first, then an integer, then inside 0..2147483647: Node names each fault
       in that order, so '8' is a type error, 1.5 an integer error and -1 a range error. */
    if (typeof keylen !== 'number') throw invalidArgType('keylen', 'of type number', keylen);
    var len = keylen;
    if (len !== Math.floor(len)) throw outOfRange('keylen', 'an integer', keylen);
    if (!(len >= 0 && len <= 2147483647)) throw outOfRange('keylen', '>= 0 && <= 2147483647', keylen);
    /* Node reaches its default for a parameter handed over as zero, and rejects a set it cannot
       derive with before it derives anything: N a power of two above one, r and p positive, and
       the whole 128*N*r working set inside the budget. */
    var cost = scryptParam(opts, 'N', 'cost');
    var block = scryptParam(opts, 'r', 'blockSize');
    var par = scryptParam(opts, 'p', 'parallelization');
    scryptBound('N', cost, 4294967295);
    scryptBound('r', block, 4294967295);
    scryptBound('p', par, 4294967295);
    var maxmem = opts.maxmem;
    /* A null was handed over, so it offends the type check the way undefined does not. */
    if (maxmem !== undefined && (maxmem === null || typeof maxmem !== 'number')) {
      throw invalidArgType('maxmem', 'of type number', maxmem);
    }
    var want = maxmem;
    scryptBound('maxmem', want, 9007199254740991);
    var n = cost === undefined || cost === 0 ? 16384 : cost;
    var r = block === undefined || block === 0 ? 8 : block;
    var p = par === undefined || par === 0 ? 1 : par;
    var budget = want === undefined || want === 0 ? 32 * 1024 * 1024 : want;
    if (!(n > 1) || (n & (n - 1)) !== 0 || !(r > 0) || !(p > 0)) {
      throw scryptParams(scryptReason === null ? undefined : 'Invalid scrypt params: ' + scryptReason);
    }
    if (128 * n * r > budget) {
      scryptReason = SCRYPT_MEM_REASON;
      throw scryptParams('Invalid scrypt params: ' + SCRYPT_MEM_REASON);
    }
    var out = cryptoCap('crypto.scrypt', {
      password: toBytes(password, undefined, 'password').toString('base64'),
      salt: toBytes(salt, undefined, 'salt').toString('base64'),
      keylen: len,
      N: cost,
      r: block,
      p: par,
      maxmem: want
    });
    /* A derivation that reached the end empties the queue, so the next refusal is bare again. */
    scryptReason = null;
    return Buf.from(out, 'base64');
  }

  function scrypt(password, salt, keylen, options, callback) {
    var done = callback;
    var opts = options;
    if (typeof options === 'function') {
      done = options;
      opts = undefined;
    }
    if (typeof done !== 'function') throw invalidArgType('callback', 'of type function', done);
    var key = scryptSync(password, salt, keylen, opts);
    queueMicrotask(function () { done(null, key); });
  }

  /*
   * hkdf. Node hands back an ArrayBuffer rather than a Buffer -- it is key material, not text --
   * so the bytes the host answers with are copied into one here.
   */
  function hkdfSync(digest, key, salt, info, keylen) {
    /* Node reads the five arguments in order -- digest, ikm, salt, info, length -- and names the
       first one that is wrong, so the checks sit in that order here. */
    if (typeof digest !== 'string') throw invalidArgType('digest', 'of type string', digest);
    var ikmOf = key !== null && typeof key === 'object' ? KEY_STATE.get(key) : undefined;
    var ikm = ikmOf !== undefined && ikmOf.kind === 'key' && ikmOf.type === 'secret'
      ? ikmOf.bytes
      : toBytes(key, undefined, 'ikm', 'string or an instance of SecretKeyObject, ArrayBuffer, TypedArray, DataView, or Buffer');
    if (salt === undefined || salt === null) {
      throw invalidArgType('salt', 'of type string or an instance of ArrayBuffer, TypedArray, DataView, or Buffer', salt);
    }
    /* An info is as required as a salt is: Node's HKDF takes five arguments, not four. */
    if (info === undefined || info === null) {
      throw invalidArgType('info', 'of type string or an instance of ArrayBuffer, TypedArray, DataView, or Buffer', info);
    }
    if (typeof keylen !== 'number') throw invalidArgType('length', 'of type number', keylen);
    if (!(keylen >= 0 && keylen <= 9007199254740991)) throw outOfRange('length', '>= 0 && <= 9007199254740991', keylen);
    if (Math.floor(keylen) !== keylen) throw outOfRange('length', 'an integer', keylen);
    /* An extensible-output digest cannot be the hash of an HKDF: OpenSSL derives nothing. */
    var hash = String(digest).toLowerCase();
    if (hash === 'shake128' || hash === 'shake256') throw new Error('Deriving bits failed');
    if (keylen === 0) throw new Error('Deriving bits failed');
    if (keylen > 8160) {
      var long = new RangeError('Invalid key length');
      long.code = 'ERR_CRYPTO_INVALID_KEYLEN';
      throw long;
    }
    var out = cryptoCap('crypto.hkdf', {
      algorithm: String(digest),
      ikm: Buf.from(ikm).toString('base64'),
      salt: toBytes(salt, undefined, 'salt', 'string or an instance of ArrayBuffer, TypedArray, DataView, or Buffer').toString('base64'),
      info: toBytes(info, undefined, 'info', 'string or an instance of ArrayBuffer, TypedArray, DataView, or Buffer').toString('base64'),
      keylen: Number(keylen)
    });
    var bytes = Buf.from(out, 'base64');
    var buffer = new ArrayBuffer(bytes.length);
    new Uint8Array(buffer).set(bytes);
    return buffer;
  }

  /* hkdf has no promise form on the host: Node asks for a callback and rejects a call without one. */
  function hkdf(digest, key, salt, info, keylen, callback) {
    if (typeof callback !== 'function') throw invalidArgType('callback', 'of type function', callback);
    var out = hkdfSync(digest, key, salt, info, keylen);
    queueMicrotask(function () { callback(null, out); });
  }

  /* SubtleCrypto: digests and HMAC run on the host through the asynchronous operation path */
  var SUBTLE_DIGESTS = { 'SHA-1': 'sha1', 'SHA-256': 'sha256', 'SHA-384': 'sha384', 'SHA-512': 'sha512' };

  function notSupported(message) {
    var err = new Error(message);
    err.name = 'NotSupportedError';
    return err;
  }

  function algorithmName(algorithm) {
    if (typeof algorithm === 'string') return algorithm;
    if (algorithm !== null && typeof algorithm === 'object' && typeof algorithm.name === 'string') return algorithm.name;
    throw invalidArgType('algorithm', 'a string or an object with a name', algorithm);
  }

  function digestOf(algorithm) {
    var name = String(algorithmName(algorithm)).toUpperCase();
    if (!Object.prototype.hasOwnProperty.call(SUBTLE_DIGESTS, name)) throw notSupported('Unrecognized algorithm name: ' + name);
    return { name: name, digest: SUBTLE_DIGESTS[name] };
  }

  function bufferSourceBytes(data, name) {
    if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) return toBytes(data, undefined, name);
    throw invalidArgType(name, 'an instance of ArrayBuffer, Buffer, TypedArray, or DataView', data);
  }

  function arrayBufferOf(bytes) {
    var out = new ArrayBuffer(bytes.length);
    new Uint8Array(out).set(bytes);
    return out;
  }

  function settled(work) {
    return new Promise(function (resolve) { resolve(work()); });
  }

  function CryptoKey() {
    throw new TypeError('Illegal constructor');
  }

  function cryptoKeyState(key) {
    return keyStateOf(key, 'crypto-key');
  }

  Object.defineProperties(CryptoKey.prototype, {
    type: { get: function () { return cryptoKeyState(this).type; } },
    extractable: { get: function () { return cryptoKeyState(this).extractable; } },
    algorithm: { get: function () { return cryptoKeyState(this).algorithm; } },
    usages: { get: function () { return cryptoKeyState(this).usages; } }
  });

  function hmacKeyFor(algorithm, key, usage) {
    var state = cryptoKeyState(key);
    if (state === undefined) throw invalidArgType('key', 'an instance of CryptoKey', key);
    if (String(algorithmName(algorithm)).toUpperCase() !== state.algorithm.name) throw notSupported('Algorithm mismatch');
    if (state.usages.indexOf(usage) < 0) {
      var denied = new Error('Key does not support the ' + usage + ' operation');
      denied.name = 'InvalidAccessError';
      throw denied;
    }
    return state;
  }

  function hmacDigest(state, bytes) {
    return cryptoOp('crypto.hmac', {
      algorithm: digestOf(state.algorithm.hash).digest,
      key: state.bytes.toString('base64'),
      data: bytes.toString('base64')
    });
  }

  var subtle = {
    digest: function (algorithm, data) {
      return settled(function () {
        var alg = digestOf(algorithm);
        var bytes = bufferSourceBytes(data, 'data');
        return cryptoOp('crypto.digest', { algorithm: alg.digest, data: bytes.toString('base64') }).then(function (b64) {
          return arrayBufferOf(Buf.from(b64, 'base64'));
        });
      });
    },
    importKey: function (format, keyData, algorithm, extractable, usages) {
      return settled(function () {
        if (format !== 'raw') throw notSupported('Unable to import key: format ' + format + ' is not supported');
        if (String(algorithmName(algorithm)).toUpperCase() !== 'HMAC') {
          throw notSupported('Unrecognized algorithm name: ' + String(algorithmName(algorithm)).toUpperCase());
        }
        var hashName = digestOf(algorithm.hash).name;
        var bytes = Buf.from(bufferSourceBytes(keyData, 'keyData'));
        var key = Object.create(CryptoKey.prototype);
        KEY_STATE.set(key, {
          kind: 'crypto-key',
          type: 'secret',
          bytes: bytes,
          extractable: extractable === true,
          algorithm: { name: 'HMAC', length: bytes.length * 8, hash: { name: hashName } },
          usages: Array.prototype.slice.call(usages)
        });
        return key;
      });
    },
    sign: function (algorithm, key, data) {
      return settled(function () {
        var state = hmacKeyFor(algorithm, key, 'sign');
        return hmacDigest(state, bufferSourceBytes(data, 'data')).then(function (b64) {
          return arrayBufferOf(Buf.from(b64, 'base64'));
        });
      });
    },
    verify: function (algorithm, key, signature, data) {
      return settled(function () {
        var state = hmacKeyFor(algorithm, key, 'verify');
        var given = bufferSourceBytes(signature, 'signature');
        return hmacDigest(state, bufferSourceBytes(data, 'data')).then(function (b64) {
          var expected = Buf.from(b64, 'base64');
          return given.length === expected.length && timingSafeEqual(given, expected);
        });
      });
    }
  };

  var webcrypto = {
    CryptoKey: CryptoKey,
    getRandomValues: getRandomValues,
    randomUUID: randomUUID,
    subtle: subtle
  };

  /*
   * createCipheriv and createDecipheriv. The cipher itself runs on the host (@noble/ciphers); the
   * guest keeps the id and the surface Node's callers use. Errors the host raises are rebuilt with
   * the constructor Node uses, which the capability envelope cannot carry.
   */
  function cipherCap(op, args) {
    return capabilityCall(op, args, callCap);
  }

  /*
   * A failing capability reaches the guest as a plain Error: the envelope carries a code and a
   * message but not a constructor, and the spine that rebuilds it has no class to rebuild. The
   * capability names the class it threw with in 'owcErrorClass', so every crypto call rebuilds
   * here -- 'crypto.sign' with a bad 'dsaEncoding' and 'createDiffieHellman(8)' are TypeErrors on
   * host Node 24.15 and were plain Errors here, and 'createDiffieHellman(1.5)' a RangeError.
   * The asynchronous path rejects the same way, so 'scrypt' and 'pbkdf2' with a callback agree.
   */
  function capabilityError(err) {
    var Ctor = err && err.owcErrorClass === 'RangeError' ? RangeError : err && err.owcErrorClass === 'TypeError' ? TypeError : Error;
    var again = new Ctor(err && err.message !== undefined ? err.message : String(err));
    if (err && err.code !== undefined && !err.owcUncoded) again.code = err.code;
    if (err && err.errno !== undefined) again.errno = err.errno;
    if (err && err.syscall !== undefined) again.syscall = err.syscall;
    return again;
  }

  function capabilityCall(op, args, send) {
    try {
      return send(op, args);
    } catch (err) {
      throw capabilityError(err);
    }
  }

  function cryptoCap(op, args) {
    return capabilityCall(op, args, callCap);
  }

  function cryptoOp(op, args) {
    return callOp(op, args).then(null, function (err) { throw capabilityError(err); });
  }

  function cipherStateError(message) {
    var err = new Error(message);
    err.code = 'ERR_CRYPTO_INVALID_STATE';
    return err;
  }

  function cipherBytes(data, encoding, name, list) {
    refuseOddHex(data, encoding);
    return typeof data === 'string' ? Buf.from(data, encoding || 'utf8') : toBytes(data, undefined, name, list);
  }

  /* A cipher key takes the same list a sign or a verify names: KeyObject and CryptoKey are in it. */
  function cipherKeyBytes(key) {
    var state = keyStateOf(key, 'key');
    if (state !== undefined) {
      if (state.type !== 'secret') throw asymmetricUnavailable('createCipheriv');
      return state.bytes;
    }
    return cipherBytes(key, undefined, 'key', 'string or an instance of ArrayBuffer, Buffer, TypedArray, DataView, KeyObject, or CryptoKey');
  }

  /*
   * Node fixes a cipher's output encoding on the first update() or final() that names one and
   * refuses a later call that names a different one, as an assertion rather than a type error.
   */
  function cipherOut(cipher, bytes, encoding) {
    if (encoding === null || encoding === undefined || encoding === false || encoding === 'buffer') return bytes;
    if (typeof encoding !== 'string') return bytes;
    if (cipher._encoding !== undefined && cipher._encoding !== encoding) {
      var clash = new Error('Cannot change encoding');
      clash.code = 'ERR_INTERNAL_ASSERTION';
      throw clash;
    }
    cipher._encoding = encoding;
    return bytes.toString(encoding);
  }

  function Cipher(algorithm, direction, id, aead) {
    this._algorithm = algorithm;
    this._direction = direction;
    this._id = id;
    this._aead = aead;
    this._finalized = false;
    this._tag = undefined;
    this._encoding = undefined;
  }

  Cipher.prototype.update = function (data, inputEncoding, outputEncoding) {
    if (this._finalized) throw new Error('Trying to add data in unsupported state');
    /* The data a cipher is fed is one of the families that take no bare ArrayBuffer, as a hash's is. */
    var bytes = cipherBytes(data, inputEncoding, 'data', 'string or an instance of Buffer, TypedArray, or DataView');
    var out = Buf.from(cipherCap('crypto.cipher.update', { id: this._id, data: bytes.toString('base64') }), 'base64');
    return cipherOut(this, out, outputEncoding);
  };

  Cipher.prototype.final = function (outputEncoding) {
    if (this._finalized) throw cipherStateError('Invalid state');
    this._finalized = true;
    var result = cipherCap('crypto.cipher.final', { id: this._id });
    if (result.tag !== undefined) this._tag = Buf.from(result.tag, 'base64');
    var out = Buf.from(result.data, 'base64');
    return cipherOut(this, out, outputEncoding);
  };

  Cipher.prototype.setAutoPadding = function (autoPadding) {
    cipherCap('crypto.cipher.setAutoPadding', { id: this._id, on: autoPadding !== false });
    return this;
  };

  Cipher.prototype.setAAD = function (buffer, options) {
    var aad = cipherBytes(buffer, typeof options === 'string' ? options : undefined, 'buffer');
    cipherCap('crypto.cipher.setAAD', { id: this._id, aad: aad.toString('base64') });
    return this;
  };

  /* Node puts getAuthTag on a cipher and setAuthTag on a decipher, and neither on the other. */
  function cipherGetAuthTag() {
    if (!this._aead || !this._finalized || this._tag === undefined) throw cipherStateError('Invalid state for operation getAuthTag');
    return this._tag;
  }

  function decipherSetAuthTag(buffer, inputEncoding) {
    var tag = cipherBytes(buffer, inputEncoding, 'buffer');
    cipherCap('crypto.cipher.setAuthTag', { id: this._id, tag: tag.toString('base64') });
    return this;
  }

  function createCipher(direction) {
    return function (algorithm, key, iv, options) {
      var opts = options !== undefined && options !== null && typeof options === 'object'
        ? { authTagLength: options.authTagLength }
        : undefined;
      var opened = cipherCap('crypto.cipher.open', {
        algorithm: String(algorithm),
        direction: direction,
        key: cipherKeyBytes(key).toString('base64'),
        iv: iv === null || iv === undefined ? null : cipherBytes(iv, undefined, 'iv').toString('base64'),
        options: opts
      });
      var cipher = new Cipher(String(algorithm), direction, opened.id, opened.aead === true);
      if (direction === 'decrypt') cipher.setAuthTag = decipherSetAuthTag;
      else cipher.getAuthTag = cipherGetAuthTag;
      return cipher;
    };
  }

  /*
   * Primality. A candidate is a Buffer, a TypedArray or a BigInt, and Node answers a Buffer from
   * generatePrime unless the caller asks for the BigInt it searched with.
   */
  function checkPrimeSync(candidate, options) {
    var isBig = typeof candidate === 'bigint';
    /* A candidate is a BigInt or bytes: Node names no string in the list, so text is refused. */
    if (!isBig && !(Buf.isBuffer(candidate) || ArrayBuffer.isView(candidate) || candidate instanceof ArrayBuffer)) {
      throw invalidArgType('candidate', 'of type bigint or an instance of ArrayBuffer, TypedArray, Buffer, or DataView', candidate);
    }
    return cryptoCap('crypto.checkPrime', {
      value: isBig ? String(candidate) : toBytes(candidate, undefined, 'candidate').toString('base64'),
      valueIsBigInt: isBig,
      checks: options === undefined || options === null ? undefined : Number(options.checks)
    }).prime;
  }

  function checkPrime(candidate, options, callback) {
    var done = callback;
    var opts = options;
    if (typeof options === 'function') {
      done = options;
      opts = undefined;
    }
    if (typeof done !== 'function') throw invalidArgType('callback', 'of type function', done);
    var answer = checkPrimeSync(candidate, opts);
    queueMicrotask(function () { done(null, answer); });
  }

  function generatePrimeSync(primeLength, options) {
    /* Node reads the width as a number first and names it "size", which is not the name the
       option carries inside generateKeyPairSync('dh'). */
    if (typeof primeLength !== 'number') throw invalidArgType('size', 'of type number', primeLength);
    var result = cryptoCap('crypto.generatePrime', {
      bits: Number(primeLength),
      safe: options !== undefined && options !== null && options.safe === true,
      bigint: options !== undefined && options !== null && options.bigint === true
    });
    if (options !== undefined && options !== null && options.bigint === true) return BigInt(result.value);
    /* Node answers an ArrayBuffer, the way hkdf does: a prime is bytes, not text. */
    var bytes = Buf.from(result.bytes, 'base64');
    var buffer = new ArrayBuffer(bytes.length);
    new Uint8Array(buffer).set(bytes);
    return buffer;
  }

  function generatePrime(primeLength, options, callback) {
    var done = callback;
    var opts = options;
    if (typeof options === 'function') {
      done = options;
      opts = undefined;
    }
    if (typeof done !== 'function') throw invalidArgType('callback', 'of type function', done);
    var prime = generatePrimeSync(primeLength, opts);
    queueMicrotask(function () { done(null, prime); });
  }

  return {
    randomBytes: randomBytes,
    randomUUID: randomUUID,
    randomInt: randomInt,
    randomFill: randomFill,
    randomFillSync: randomFillSync,
    getRandomValues: getRandomValues,
    createHash: createHash,
    createHmac: createHmac,
    hash: hash,
    pbkdf2Sync: pbkdf2Sync,
    pbkdf2: pbkdf2,
    scryptSync: scryptSync,
    scrypt: scrypt,
    hkdf: hkdf,
    hkdfSync: hkdfSync,
    timingSafeEqual: timingSafeEqual,
    getHashes: getHashes,
    getCurves: getCurves,
    KeyObject: KeyObject,
    createSecretKey: createSecretKey,
    createPublicKey: createPublicKey,
    createPrivateKey: createPrivateKey,
    createSign: createSign,
    createVerify: createVerify,
    generateKeyPairSync: generateKeyPairSync,
    generateKeyPair: generateKeyPair,
    createDiffieHellman: createDiffieHellman,
    createDiffieHellmanGroup: createDiffieHellmanGroup,
    getDiffieHellman: getDiffieHellman,
    diffieHellman: diffieHellman,
    subtle: subtle,
    webcrypto: webcrypto,
    /* The classes behind the four factories, which node exports in their own right: 'new
       crypto.Hash('sha256')' is the same object createHash gives, and so are the other three. */
    Hash: Hash,
    Hmac: function Hmac(algorithm, key, options) {
      return new Hash(algorithm, keyBytesOf(key), outputLengthOf(options));
    },
    Sign: Sign,
    Verify: Verify,
    Cipheriv: function Cipheriv(algorithm, key, iv, options) {
      return createCipher('encrypt')(algorithm, key, iv, options);
    },
    Decipheriv: function Decipheriv(algorithm, key, iv, options) {
      return createCipher('decrypt')(algorithm, key, iv, options);
    },
    /* The two classes behind createDiffieHellman and createDiffieHellmanGroup: one holds the prime
       and generator it was given, the other a MODP group it names, and they carry the same methods.
       Both are the factories themselves, because node's constructors take the same arguments --
       a width or a prime, then a generator -- and hand back the object the factory hands back. */
    DiffieHellman: function DiffieHellmanClass(prime, generator, generatorEncoding) {
      return createDiffieHellman(prime, generator, generatorEncoding);
    },
    DiffieHellmanGroup: function DiffieHellmanGroup(name) {
      return createDiffieHellmanGroup(name);
    },
    /* FIPS: this container is not built against a FIPS-capable provider, so it answers the way node
       does on such a build -- getFips is 0, and setFips accepts the flag and does nothing. */
    getFips: function getFips() { return 0; },
    setFips: function setFips(enabled) {
      if (typeof enabled !== 'boolean') {
        var badFips = new TypeError('The "enabled" argument must be of type boolean. Received '
          + receivedTypeOf(enabled));
        badFips.code = 'ERR_INVALID_ARG_TYPE';
        throw badFips;
      }
      return undefined;
    },
    /* No secure heap is ever allocated here, so the usage is node's own empty one: a utilization of
       NaN, which is what zero out of zero is. */
    secureHeapUsed: function secureHeapUsed() {
      return { total: 0, used: 0, utilization: NaN, min: 2 };
    },
    /* An OpenSSL engine this build carries no provider for: node names the one it was asked for. */
    setEngine: function setEngine(id) {
      var noEngine = new Error('Engine "' + String(id) + '" was not found');
      noEngine.code = 'ERR_CRYPTO_ENGINE_UNKNOWN';
      /* OpenSSL's own number for the error, which node carries on the error as it does on every
         one it raises out of a provider. */
      noEngine.opensslErrorStack = ['error:25078067:UI routines:UI_get_lib_method:unsupported'];
      throw noEngine;
    },
    /* generateKey is the secret-key counterpart of generateKeyPair: a width in bits, and the bytes
       are random. Only 'hmac' and 'aes' are secret keys -- a pair belongs to generateKeyPair -- and
       aes takes the three widths the cipher has. */
    generateKeySync: function generateKeySync(type, options) {
      return createSecretKey(randomBytes(secretKeyLengthOf(type, options)));
    },
    generateKey: function generateKey(type, options, callback) {
      var done = callback;
      if (typeof done !== 'function') throw invalidArgType('callback', 'of type function', done);
      var size = secretKeyLengthOf(type, options);
      queueMicrotask(function () { done(null, createSecretKey(randomBytes(size))); });
      return undefined;
    },
    constants: {
      RSA_PKCS1_PADDING: 1,
      RSA_NO_PADDING: 3,
      RSA_PKCS1_OAEP_PADDING: 4,
      RSA_PKCS1_PSS_PADDING: 6,
      POINT_CONVERSION_COMPRESSED: 2,
      POINT_CONVERSION_UNCOMPRESSED: 4,
      POINT_CONVERSION_HYBRID: 6,
      RSA_PSS_SALTLEN_DIGEST: -1,
      RSA_PSS_SALTLEN_MAX_SIGN: -2,
      RSA_PSS_SALTLEN_AUTO: -2,
      /* An OpenSSL option Node re-exports with the rest of the SSL_OP_* family. */
      SSL_OP_LEGACY_SERVER_CONNECT: 4
    },
    getCiphers: function () { return cryptoCap('crypto.ciphers'); },
    /* Node's getCipherInfo: name or nid, and undefined for a cipher this container has no table
       entry for, as on the host for one it does not carry either. */
    getCipherInfo: function (nameOrNid, options) {
      if (typeof nameOrNid !== 'string' && typeof nameOrNid !== 'number') {
        throw invalidArgType('nameOrNid', 'one of type string or number', nameOrNid);
      }
      var args = { nameOrNid: nameOrNid };
      if (options !== undefined && options !== null && typeof options === 'object') {
        args.options = { keyLength: options.keyLength, ivLength: options.ivLength };
      }
      /* A capability answer is JSON, so a name no cipher carries comes back null; Node answers
         undefined, and that is what a caller asks about with === undefined. */
      var info = cryptoCap('crypto.cipher.info', args);
      return info === null ? undefined : info;
    },
    sign: signOne,
    verify: verifyOne,
    createCipheriv: createCipher('encrypt'),
    createDecipheriv: createCipher('decrypt'),
    privateDecrypt: privateDecrypt,
    publicEncrypt: publicEncrypt,
    privateEncrypt: privateEncrypt,
    publicDecrypt: publicDecrypt,
    checkPrime: checkPrime,
    checkPrimeSync: checkPrimeSync,
    generatePrime: generatePrime,
    generatePrimeSync: generatePrimeSync
  };
};

/*
 * Node's own list of built-in names, in the order node sorts it. It is deliberately not the list of
 * factories registered in BF: node's list names every module its binary carries -- the private ones
 * with an underscore in front, which here are parts of http, of stream and of tls rather than
 * modules in their own right; the submodules with a slash, each registered in BF under that very
 * name; the aliases sys and wasi; and node:sea, node:sqlite and node:test. A name that is here and
 * not in node -- undici above all, a package this container serves as if it were built in -- is left
 * out of the list, and isBuiltin answers for the same list, so the two agree as they do in node.
 */
var NODE_BUILTIN_NAMES = [
  '_http_agent', '_http_client', '_http_common', '_http_incoming', '_http_outgoing', '_http_server',
  '_stream_duplex', '_stream_passthrough', '_stream_readable', '_stream_transform', '_stream_wrap',
  '_stream_writable', '_tls_common', '_tls_wrap', 'assert', 'assert/strict', 'async_hooks',
  'buffer', 'child_process', 'cluster', 'console', 'constants', 'crypto', 'dgram',
  'diagnostics_channel', 'dns', 'dns/promises', 'domain', 'events', 'fs', 'fs/promises', 'http',
  'http2', 'https', 'inspector', 'inspector/promises', 'module', 'net', 'os', 'path', 'path/posix',
  'path/win32', 'perf_hooks', 'process', 'punycode', 'querystring', 'readline', 'readline/promises',
  'repl', 'stream', 'stream/consumers', 'stream/promises', 'stream/web', 'string_decoder', 'sys',
  'timers', 'timers/promises', 'tls', 'trace_events', 'tty', 'url', 'util', 'util/types', 'v8',
  'vm', 'wasi', 'worker_threads', 'zlib',
  /* The four names node writes with its own prefix stand at the end of the list, after every bare
     name and not where a sort would put one: node appends them to the sorted bare names. */
  'node:sea', 'node:sqlite', 'node:test', 'node:test/reporters'
];
var BUILTIN_NAME_SET = Object.create(null);
for (var builtinNameIndex = 0; builtinNameIndex < NODE_BUILTIN_NAMES.length; builtinNameIndex++) {
  BUILTIN_NAME_SET[NODE_BUILTIN_NAMES[builtinNameIndex]] = true;
}

/*
 * A source map v3 payload, read the way node reads one: the mappings string decoded as base64 VLQ
 * into one entry per generated segment -- generated line and column, source, original line and
 * column, name -- sorted by position, and findEntry/findOrigin over them. Nothing in this container
 * writes a source map, so findSourceMap has none to hand back; the class is node's for a caller
 * that built a payload itself.
 */
var VLQ_DIGITS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
var VLQ_BASE_MASK = 31;
var VLQ_CONTINUATION_MASK = 32;
var VLQ_BASE_SHIFT = 5;

function vlqDecode(iterator) {
  var result = 0;
  var shift = 0;
  var digit = 0;
  var continuation = false;
  do {
    var at = VLQ_DIGITS.indexOf(iterator.next());
    /* A digit the iterator has no character for -- the end of the mappings, which node's own
       base64Map answers undefined for -- adds nothing and does not continue. */
    if (at < 0) { digit = 0; continuation = false; } else {
      digit = at & VLQ_BASE_MASK;
      continuation = (at & VLQ_CONTINUATION_MASK) !== 0;
    }
    result += digit << shift;
    shift += VLQ_BASE_SHIFT;
  } while (continuation);
  var negative = result & 1;
  result >>= 1;
  return negative ? -result : result;
}

function parseSourceMapInto(mappings, map, lineNumber, columnNumber) {
  var sourceIndex = 0;
  var sourceLineNumber = 0;
  var sourceColumnNumber = 0;
  var nameIndex = 0;
  var sources = [];
  var i;
  for (i = 0; i < map.sources.length; i++) sources.push(String(map.sources[i]));
  var text = String(map.mappings);
  var names = map.names;
  var cursor = 0;
  var sourceURL = sources[sourceIndex];
  var iterator = {
    next: function () { var ch = cursor < text.length ? text.charAt(cursor) : ''; cursor++; return ch; },
    peek: function () { return cursor < text.length ? text.charAt(cursor) : ''; }
  };
  while (true) {
    if (iterator.peek() === ',') iterator.next();
    else {
      while (iterator.peek() === ';') {
        lineNumber += 1;
        columnNumber = 0;
        iterator.next();
      }
      if (cursor >= text.length) break;
    }
    columnNumber += vlqDecode(iterator);
    if (iterator.peek() === ',' || iterator.peek() === ';') {
      mappings.push([lineNumber, columnNumber]);
      continue;
    }
    var sourceIndexDelta = vlqDecode(iterator);
    if (sourceIndexDelta) {
      sourceIndex += sourceIndexDelta;
      sourceURL = sources[sourceIndex];
    }
    sourceLineNumber += vlqDecode(iterator);
    sourceColumnNumber += vlqDecode(iterator);
    var name;
    if (iterator.peek() !== ',' && iterator.peek() !== ';') {
      nameIndex += vlqDecode(iterator);
      name = names ? names[nameIndex] : undefined;
    }
    mappings.push([lineNumber, columnNumber, sourceURL, sourceLineNumber, sourceColumnNumber, name]);
  }
}

function compareSourceMapEntry(a, b) {
  if (a[0] > b[0]) return 1;
  if (a[0] < b[0]) return -1;
  return a[1] > b[1] ? 1 : (a[1] < b[1] ? -1 : 0);
}

/* Node keeps a SourceMap's payload, mappings and line lengths in private fields, so an instance
   owns no property at all and Object.keys of one is empty; here they live in this map, keyed by
   the instance, which is the nearest thing to a private field this runtime has. */
var SOURCE_MAP_STATE = new WeakMap();
function SourceMap(payload) {
  /* The options object is the second argument node declares, so the constructor's arity is 1 and
     it is read off arguments rather than named. */
  var options = arguments[1];
  /* Node's own validator refuses anything that is not an object, a function and an array
     included, and names what it refused in the message; an object it accepts may still be too
     thin to parse, and then it fails later exactly as this does. */
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    var err = new TypeError('The "payload" argument must be of type object. Received ' + receivedTypeOf(payload));
    err.code = 'ERR_INVALID_ARG_TYPE';
    throw err;
  }
  var state = { payload: payload, mappings: [], lineLengths: undefined };
  if (payload.sections) {
    for (var i = 0; i < payload.sections.length; i++) {
      var section = payload.sections[i];
      parseSourceMapInto(state.mappings, section.map, section.offset.line, section.offset.column);
    }
  } else {
    parseSourceMapInto(state.mappings, payload, 0, 0);
  }
  state.mappings.sort(compareSourceMapEntry);
  if (options && options.lineLengths && options.lineLengths.length > 0) {
    state.lineLengths = options.lineLengths.slice();
  }
  SOURCE_MAP_STATE.set(this, state);
}
function sourceMapState(instance) {
  return SOURCE_MAP_STATE.get(instance);
}
Object.defineProperty(SourceMap.prototype, 'payload', {
  get: function () { var s = sourceMapState(this); return s ? s.payload : undefined; },
  configurable: true
});
Object.defineProperty(SourceMap.prototype, 'lineLengths', {
  get: function () { var s = sourceMapState(this); return s && s.lineLengths ? s.lineLengths.slice() : undefined; },
  configurable: true
});
/* The entry covering a 0-indexed generated position: the last one at or before it in the sorted
   list, or an empty object when the position stands before every entry. */
SourceMap.prototype.findEntry = function findEntry(lineOffset, columnOffset) {
  var mappings = sourceMapState(this).mappings;
  var first = 0;
  var count = mappings.length;
  while (count > 1) {
    var step = count >> 1;
    var middle = first + step;
    var mapping = mappings[middle];
    if (lineOffset < mapping[0] || (lineOffset === mapping[0] && columnOffset < mapping[1])) count = step;
    else { first = middle; count -= step; }
  }
  var entry = mappings[first];
  if (!first && entry && (lineOffset < entry[0] || (lineOffset === entry[0] && columnOffset < entry[1]))) return {};
  if (!entry) return {};
  return {
    generatedLine: entry[0],
    generatedColumn: entry[1],
    originalSource: entry[2],
    originalLine: entry[3],
    originalColumn: entry[4],
    name: entry[5]
  };
};
SourceMap.prototype.findOrigin = function findOrigin(lineNumber, columnNumber) {
  var range = this.findEntry(lineNumber - 1, columnNumber - 1);
  if (range.originalSource === undefined || range.originalLine === undefined
    || range.originalColumn === undefined || range.generatedLine === undefined
    || range.generatedColumn === undefined) return {};
  var lineOffset = lineNumber - range.generatedLine;
  var columnOffset = columnNumber - range.generatedColumn;
  return {
    name: range.name,
    fileName: range.originalSource,
    lineNumber: range.originalLine + lineOffset,
    columnNumber: range.originalColumn + columnOffset
  };
};

/* How node names the value it refused: 'undefined', 'null', 'an instance of Object', or 'type
   number (1)' -- the words its own validators put after 'must be of type'. A string is quoted the
   way util.inspect quotes it, a function is named after itself with nothing after an anonymous
   one, a bigint keeps its 'n', and an object with no constructor is printed as one rather than
   named, because node's own message prints the value there. */
function quotedStringOf(value) {
  return value.indexOf("'") >= 0 ? '"' + value + '"' : "'" + value + "'";
}
function receivedTypeOf(value) {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'object') {
    var ctor = value.constructor;
    if (ctor && typeof ctor.name === 'string' && ctor.name !== '') return 'an instance of ' + ctor.name;
    var keys = Object.keys(value);
    if (keys.length === 0) return '[Object: null prototype] {}';
    var parts = '';
    for (var i = 0; i < keys.length; i++) {
      parts += (i === 0 ? '' : ', ') + keys[i] + ': ' + String(value[keys[i]]);
    }
    return '[Object: null prototype] { ' + parts + ' }';
  }
  if (typeof value === 'function') return 'function ' + (value.name || '');
  if (typeof value === 'symbol') return 'type symbol (' + String(value) + ')';
  if (typeof value === 'bigint') return 'type bigint (' + String(value) + 'n)';
  if (typeof value === 'string') return 'type string (' + quotedStringOf(value) + ')';
  return 'type ' + typeof value + ' (' + String(value) + ')';
}

/* require('module') is the Module class the loader builds modules with, carrying Node's statics.
   They are filled in here rather than where the class is built, so that the ones which read the
   builtin registry, the file system or the loader's own tables see them once they are real. */
/*
 * TypeScript type stripping, offered as a call: the pass node runs over a .ts source before it
 * compiles it. A type is erasable syntax, so what comes back is the program with every type gone
 * and every other character standing where it stood -- node blanks what it strips, so a
 * 'const a: number = 1' comes back as 'const a         = 1' and a position or a source map read
 * over the input still names the same character in the output.
 *
 * It scans tokens rather than parsing the grammar, and it refuses with node's own
 * ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX the constructs only a parser can place -- an enum, a namespace
 * or 'declare module' declaration, a parameter property, a decorator and an import-equals alias --
 * which are the very ones node refuses itself in strip-only mode.
 */
var TS_REGEX_KEYWORDS = { 'return': true, 'typeof': true, 'instanceof': true, 'in': true, 'of': true,
  'new': true, 'delete': true, 'void': true, 'case': true, 'do': true, 'else': true, 'yield': true,
  'await': true };
var TS_MODIFIERS = { 'public': true, 'private': true, 'protected': true, 'readonly': true,
  'override': true, 'abstract': true };
/* A word that can only begin a statement, used to end a type that no punctuation ends: a cast on
   the last line of a block, or a type alias written without a semicolon. */
var TS_STATEMENT_STARTERS = { 'const': true, 'let': true, 'var': true, 'function': true,
  'class': true, 'return': true, 'if': true, 'for': true, 'while': true, 'switch': true,
  'export': true, 'import': true, 'interface': true, 'type': true, 'enum': true, 'throw': true };
var TS_CONTROL_BEFORE_PAREN = { 'if': true, 'while': true, 'for': true, 'switch': true,
  'catch': true, 'return': true, 'typeof': true, 'new': true, 'delete': true, 'void': true,
  'await': true, 'in': true, 'of': true, 'yield': true, 'case': true, 'do': true, 'else': true };

/* The tokens of a source: words, numbers, strings, template literals, regex literals, comments and
   single punctuation characters. Whitespace carries no token -- a range is what is cut, so only the
   offsets matter. A '/' is a division where a value could have stood in front of it and the start
   of a regex everywhere else, which is how node's own scanner reads one. */
function tsTokenize(src) {
  var tokens = [];
  var prev = null;
  var i = 0;
  var n = src.length;
  while (i < n) {
    var ch = src.charAt(i);
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v') { i++; continue; }
    if (ch === '/' && src.charAt(i + 1) === '/') {
      var lineEnd = src.indexOf('\n', i);
      if (lineEnd < 0) lineEnd = n;
      tokens.push({ k: 'c', s: i, e: lineEnd, v: '' });
      i = lineEnd;
      continue;
    }
    if (ch === '/' && src.charAt(i + 1) === '*') {
      var blockEnd = src.indexOf('*/', i + 2);
      blockEnd = blockEnd < 0 ? n : blockEnd + 2;
      tokens.push({ k: 'c', s: i, e: blockEnd, v: '' });
      i = blockEnd;
      continue;
    }
    if (ch === '"' || ch === "'") {
      var q = i + 1;
      while (q < n) {
        var qc = src.charAt(q);
        if (qc === '\\') { q += 2; continue; }
        if (qc === ch) { q++; break; }
        if (qc === '\n') break;
        q++;
      }
      prev = { k: 's', s: i, e: q, v: '' };
      tokens.push(prev);
      i = q;
      continue;
    }
    /* 96 is the backtick: a template literal, scanned through to its close with the substitutions
       inside it counted rather than parsed. Written as a code point because the character itself
       would end the string this whole file is held in. */
    if (src.charCodeAt(i) === 96) {
      var tpl = i + 1;
      while (tpl < n) {
        var tc = src.charAt(tpl);
        if (tc === '\\') { tpl += 2; continue; }
        if (src.charCodeAt(tpl) === 96) { tpl++; break; }
        if (tc === '$' && src.charAt(tpl + 1) === '{') {
          var nested = 1;
          tpl += 2;
          while (tpl < n && nested > 0) {
            var nc = src.charAt(tpl);
            if (nc === '{') nested++;
            else if (nc === '}') nested--;
            else if (nc === '\\') tpl++;
            tpl++;
          }
          continue;
        }
        tpl++;
      }
      prev = { k: 's', s: i, e: tpl, v: '' };
      tokens.push(prev);
      i = tpl;
      continue;
    }
    if (ch === '/' && tsRegexStarts(prev)) {
      var re = i + 1;
      var inClass = false;
      while (re < n) {
        var rc = src.charAt(re);
        if (rc === '\\') { re += 2; continue; }
        if (rc === '\n') break;
        if (inClass) { if (rc === ']') inClass = false; }
        else if (rc === '[') inClass = true;
        else if (rc === '/') { re++; break; }
        re++;
      }
      while (re < n && tsIsFlag(src.charAt(re))) re++;
      prev = { k: 'r', s: i, e: re, v: '' };
      tokens.push(prev);
      i = re;
      continue;
    }
    var c0 = src.charCodeAt(i);
    if ((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122) || c0 === 36 || c0 === 95) {
      var w = i + 1;
      while (w < n) {
        var wc = src.charCodeAt(w);
        if ((wc >= 65 && wc <= 90) || (wc >= 97 && wc <= 122) || (wc >= 48 && wc <= 57)
          || wc === 36 || wc === 95) w++;
        else break;
      }
      prev = { k: 'w', s: i, e: w, v: src.slice(i, w) };
      tokens.push(prev);
      i = w;
      continue;
    }
    if (c0 >= 48 && c0 <= 57) {
      var d = i + 1;
      while (d < n) {
        var dc = src.charAt(d);
        if ((dc >= '0' && dc <= '9') || dc === '.' || dc === 'e' || dc === 'E' || dc === 'x'
          || dc === 'X' || dc === '_') d++;
        else break;
      }
      prev = { k: 'n', s: i, e: d, v: '' };
      tokens.push(prev);
      i = d;
      continue;
    }
    prev = { k: 'p', s: i, e: i + 1, v: ch };
    tokens.push(prev);
    i++;
  }
  return tokens;
}

function tsIsFlag(ch) {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z');
}

function tsRegexStarts(prev) {
  if (prev === null) return true;
  if (prev.k === 'n' || prev.k === 's' || prev.k === 'r') return false;
  if (prev.k === 'w') return TS_REGEX_KEYWORDS[prev.v] === true;
  if (prev.k === 'p') return prev.v !== ')' && prev.v !== ']' && prev.v !== '}';
  return true;
}

function tsUnsupportedSyntax(what) {
  var err = new SyntaxError('TypeScript ' + what + ' is not supported in strip-only mode');
  err.code = 'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX';
  return err;
}

/*
 * The source with every type blanked out. A blanked character becomes a space, except a newline,
 * which stays a newline, so every line keeps its number and every column its character.
 */
function tsStripTypes(src) {
  var tokens = tsTokenize(src);
  var total = tokens.length;
  var gone = new Array(src.length);
  var open = [];
  var openIdx = [];
  var matchOf = Object.create(null);
  var i = 0;
  var classPending = false;
  var ternaries = 0;

  function isP(k, v) {
    var t = tokens[k];
    return t !== undefined && t.k === 'p' && t.v === v;
  }
  function isW(k, v) {
    var t = tokens[k];
    return t !== undefined && t.k === 'w' && t.v === v;
  }
  function isWord(k) {
    var t = tokens[k];
    return t !== undefined && t.k === 'w';
  }
  /* The index of the significant token before 'k' and after it, comments skipped; and the index of
     the bracket that matches the one at 'k', or -1. */
  function prevIdx(k) {
    var j = k - 1;
    while (j >= 0 && tokens[j].k === 'c') j--;
    return j;
  }
  function nextIdx(k) {
    var j = k + 1;
    while (j < total && tokens[j].k === 'c') j++;
    return j < total ? j : -1;
  }
  /* Whether the token at 'k' is one a value can end on -- everything but a bare operator. */
  function isValueAt(k) {
    var t = tokens[k];
    if (t === undefined) return false;
    return t.k === 'w' || t.k === 'n' || t.k === 's' || t.k === 'r'
      || t.v === ')' || t.v === ']' || t.v === '}';
  }
  function matchIdx(k) {
    var depth = 0;
    var j = k;
    while (j < total) {
      var t = tokens[j];
      if (t.k === 'p') {
        if (t.v === '(' || t.v === '[' || t.v === '{') depth++;
        else if (t.v === ')' || t.v === ']' || t.v === '}') {
          depth--;
          if (depth === 0) return j;
        }
      }
      j++;
    }
    return -1;
  }
  /* The '>' that closes the '<' at 'k', or -1 when the angles do not balance before a token that
     ends the declaration anyway. */
  function angleMatch(k) {
    var depth = 0;
    var j = k;
    while (j < total) {
      var t = tokens[j];
      if (t.k === 'p') {
        if (t.v === '<') depth++;
        else if (t.v === '>') {
          depth--;
          if (depth === 0) return j;
        } else if (t.v === '{' || t.v === ';' || t.v === ')' || t.v === '=') return -1;
      }
      j++;
    }
    return -1;
  }
  function blank(from, to) {
    for (var b = from; b < to && b < src.length; b++) {
      if (src.charAt(b) !== '\n') gone[b] = true;
    }
  }
  /* Whether the token stands first on its line: only whitespace between it and the last newline. */
  function atLineStart(k) {
    for (var b = tokens[k].s - 1; b >= 0; b--) {
      var c = src.charAt(b);
      if (c === '\n') return true;
      if (c !== ' ' && c !== '\t' && c !== '\r') return false;
    }
    return true;
  }
  /* Where a type that starts at token 'from' ends: the first comma, semicolon, assignment or
     closing bracket at its own depth, the brace that opens a function body when the caller is
     reading a return type, or the start of the next statement. An arrow in the type -- the '=>' of
     a function type -- is part of the type and not the assignment that ends it. */
  function typeEnd(from, stopAtBrace) {
    var k = from;
    var depth = 0;
    while (k < total) {
      var t = tokens[k];
      if (t.k === 'p') {
        if (t.v === '<' || t.v === '(' || t.v === '[') { depth++; k++; continue; }
        if (t.v === '{') {
          if (depth === 0 && stopAtBrace) return k;
          depth++;
          k++;
          continue;
        }
        if (t.v === '>' || t.v === ')' || t.v === ']' || t.v === '}') {
          if (depth === 0) return k;
          depth--;
          k++;
          continue;
        }
        if (depth === 0 && (t.v === ',' || t.v === ';')) return k;
        if (depth === 0 && t.v === '=') {
          if (isP(k + 1, '>')) { k += 2; continue; }
          return k;
        }
      }
      if (depth === 0 && t.k === 'w' && k > from && atLineStart(k)
        && TS_STATEMENT_STARTERS[t.v] === true) return k;
      k++;
    }
    return total;
  }
  /* The token after the closing bracket matching the one at 'k', or null. */
  function afterMatch(k) {
    var close = matchIdx(k);
    if (close < 0 || close + 1 >= total) return null;
    return tokens[close + 1];
  }

  while (i < total) {
    var t = tokens[i];
    if (t.k === 'c') { i++; continue; }
    if (t.k === 'p' && (t.v === '(' || t.v === '[' || t.v === '{')) {
      /* A brace is a class body, a block or an object literal, and which one it is decides whether
         a ':' inside it is a type annotation or the key of an object: '{ x: number }' declares a
         field, '{ x: 1 }' names a property. What stands in front of the brace says which -- an
         assignment, a comma, a colon or an opening bracket is an object; a class name or the ')'
         that closed a parameter list is not. */
      var kind = t.v;
      if (t.v === '{') {
        kind = 'block';
        if (classPending) kind = 'class';
        else {
          var pb = prevIdx(i);
          if (pb >= 0) {
            var ptb = tokens[pb];
            if (ptb.k === 'w' && ptb.v === 'return') kind = 'object';
            else if (ptb.k === 'p' && (ptb.v === '=' || ptb.v === '(' || ptb.v === ','
              || ptb.v === ':' || ptb.v === '[' || ptb.v === '?')) kind = 'object';
            else if (ptb.k === 'p' && ptb.v === '>') {
              var pbb = prevIdx(pb);
              if (pbb >= 0 && tokens[pbb].k === 'p' && tokens[pbb].v === '=') kind = 'object';
            }
          }
        }
        classPending = false;
      }
      open.push(kind);
      openIdx.push(i);
      i++;
      continue;
    }
    if (t.k === 'p' && (t.v === ')' || t.v === ']' || t.v === '}')) {
      var opened = openIdx.pop();
      if (opened !== undefined) matchOf[i] = opened;
      open.pop();
      i++;
      continue;
    }
    if (t.k === 'p' && t.v === '@') throw tsUnsupportedSyntax('decorator');
    if (t.k === 'w') {
      /* A 'class' name is followed by the class body's brace, which is the one brace a ':' inside it
         annotates a field of rather than a key of an object. */
      if (t.v === 'class') classPending = true;
      /* A modifier on a class member is erasable; the same word in a parameter list is a parameter
         property, which is not -- it declares a field the emitted constructor assigns. */
      if (TS_MODIFIERS[t.v] === true) {
        var bi = prevIdx(i);
        var before = bi >= 0 ? tokens[bi] : null;
        var inParams = open.length > 0 && open[open.length - 1] === '('
          && before !== null && (before.k === 'p' && (before.v === '(' || before.v === ','));
        if (inParams) throw tsUnsupportedSyntax('parameter property');
        blank(t.s, t.e);
        i++;
        continue;
      }
      /* An ambient declaration is a type and nothing else: node erases all of it, body and all.
         Where 'declare' stands on anything else -- a field of a class -- it is only the word that
         goes, as a modifier does. */
      if (t.v === 'declare') {
        var dw = isWord(i + 1) ? tokens[i + 1].v : '';
        if (dw === 'const' || dw === 'let' || dw === 'var' || dw === 'function' || dw === 'class'
          || dw === 'abstract' || dw === 'interface' || dw === 'type') {
          var de = i + 1;
          var dd = 0;
          var closeD = total - 1;
          while (de < total) {
            var dt = tokens[de];
            if (dt.k === 'p') {
              if (dt.v === '{') { closeD = matchIdx(de); break; }
              if (dt.v === ';' && dd === 0) { closeD = de; break; }
              if (dt.v === '(' || dt.v === '[') dd++;
              else if (dt.v === ')' || dt.v === ']') dd--;
            }
            de++;
          }
          if (closeD < 0) closeD = total - 1;
          blank(t.s, tokens[closeD].e);
          i = closeD + 1;
          continue;
        }
        blank(t.s, t.e);
        i++;
        continue;
      }
      if (t.v === 'enum') throw tsUnsupportedSyntax('enum');
      if (t.v === 'namespace' || t.v === 'module') throw tsUnsupportedSyntax('namespace');
      if (t.v === 'interface') {
        /* 'export interface' goes with the interface: node erases the export too, there being
           nothing left for it to export. */
        var fromI = isW(prevIdx(i), 'export') ? prevIdx(i) : i;
        var at = i + 1;
        var depthI = 0;
        var endI = total;
        while (at < total) {
          var it = tokens[at];
          if (it.k === 'p') {
            if (it.v === '(' || it.v === '[') depthI++;
            else if (it.v === ')' || it.v === ']') depthI--;
            else if (it.v === '<') depthI++;
            else if (it.v === '>') depthI--;
            else if (it.v === '{') {
              if (depthI === 0) {
                var closeI = matchIdx(at);
                endI = closeI < 0 ? total : closeI + 1;
                break;
              }
              depthI++;
            } else if (it.v === ';' && depthI === 0) { endI = at; break; }
          }
          at++;
        }
        /* endI is the token the declaration ends at; blank up to the end of the token before it,
           or through the whole brace group when it is one. */
        var lastI = endI - 1;
        blank(tokens[fromI].s, lastI >= fromI ? tokens[lastI].e : tokens[fromI].e);
        i = endI;
        continue;
      }
      /* A type alias: 'type X = ...' or 'type X<T> = ...'. A bare 'type' in an import or export
         brace list -- 'import { type A, B }' -- is only that one word. */
      if (t.v === 'type' && isWord(i + 1) && (isP(i + 2, '=') || isP(i + 2, '<'))) {
        var fromT = isW(prevIdx(i), 'export') ? prevIdx(i) : i;
        var te = typeEnd(i + 3, false);
        /* The semicolon ends the alias and goes with it: what node leaves is the newline alone. */
        var endT = (te < total && tokens[te].k === 'p' && tokens[te].v === ';') ? te : te - 1;
        if (endT < fromT) endT = fromT;
        blank(tokens[fromT].s, tokens[endT].e);
        i = endT + 1;
        continue;
      }
      if (t.v === 'type' && (isP(i - 1, '{') || isP(i - 1, ','))) { blank(t.s, t.e); i++; continue; }
      /* 'import type ... from ...' is one statement with nothing left of it. */
      if (t.v === 'import' && isW(i + 1, 'type')) {
        var ie = i + 1;
        while (ie < total && !isP(ie, ';')) {
          if (tokens[ie].k === 'w' && ie > i + 1 && atLineStart(ie)
            && TS_STATEMENT_STARTERS[tokens[ie].v] === true) break;
          ie++;
        }
        var lastIm = Math.min(ie, total - 1);
        blank(t.s, tokens[lastIm].e);
        i = ie + 1;
        continue;
      }
      if (t.v === 'as' || t.v === 'satisfies') {
        var ae = typeEnd(i + 1, false);
        var lastA = ae - 1;
        blank(t.s, lastA >= i ? tokens[lastA].e : t.e);
        i = ae;
        continue;
      }
      i++;
      continue;
    }
    if (t.k === 'p' && t.v === ':') {
      var pi = prevIdx(i);
      var p = pi >= 0 ? tokens[pi] : null;
      /* A ':' is a type annotation where a name can stand in front of it -- a declarator, a
         parameter, a class field, a catch clause -- and after the ')' that closes a parameter list,
         where it is the return type. Anywhere else it is a label, a ternary or the key of an object
         literal, and is left alone: inside an object literal no ':' is ever an annotation. */
      var annotates = false;
      var stopAtBrace = false;
      var inside = open.length > 0 ? open[open.length - 1] : '';
      /* The ':' of a ternary closes a '?' that is still open, and is never an annotation; one '?' can
         open inside another, so they are counted rather than flagged. */
      if (p !== null && ternaries > 0) { ternaries--; i++; continue; }
      if (p !== null && inside !== 'object' && inside !== '[') {
        if (p.k === 'w' || p.k === 'n' || p.k === 's' || p.v === ']' || p.v === '}') annotates = true;
        else if (p.v === '?') annotates = true;
        /* 'let m!: string' -- a definite assignment assertion, whose '!' goes with the annotation. */
        else if (p.v === '!' && isValueAt(prevIdx(pi))) annotates = true;
        else if (p.v === ')') {
          var openAt = matchOf[pi];
          if (openAt !== undefined) {
            var nameAt = prevIdx(openAt);
            /* The name the parameter list belongs to may sit behind a type parameter list the pass
               has already blanked, so '<' and '>' are walked over to reach it. */
            while (nameAt >= 0 && tokens[nameAt].k === 'p'
              && (tokens[nameAt].v === '>' || tokens[nameAt].v === '<')) nameAt = prevIdx(nameAt);
            var nameT = nameAt >= 0 ? tokens[nameAt] : null;
            if (nameT !== null && nameT.k === 'w' && TS_CONTROL_BEFORE_PAREN[nameT.v] !== true) {
              annotates = true;
              stopAtBrace = true;
            }
          }
        }
      }
      if (annotates) {
        if (p !== null && p.v === '?') blank(p.s, p.e);
        if (p !== null && p.v === '!') blank(p.s, p.e);
        var ce = typeEnd(i + 1, stopAtBrace);
        /* A member of a class that ends in a semicolon instead of a body -- an overload, or an
           abstract method -- is a signature with no code behind it, and node erases all of it,
           modifiers and all, rather than the type alone. */
        if (stopAtBrace && inside === 'class' && ce < total && tokens[ce].k === 'p'
          && tokens[ce].v === ';' && openAt !== undefined) {
          var memberAt = prevIdx(openAt);
          while (memberAt >= 0 && (tokens[memberAt].k === 'w' || (tokens[memberAt].k === 'p'
            && (tokens[memberAt].v === '>' || tokens[memberAt].v === '<')))) memberAt = prevIdx(memberAt);
          blank(tokens[memberAt + 1].s, tokens[ce].e);
          i = ce + 1;
          continue;
        }
        var lastC = ce - 1;
        blank(t.s, lastC >= i ? tokens[lastC].e : t.e);
        i = ce;
        continue;
      }
      i++;
      continue;
    }
    /* An optional member or parameter: 'a?: T' and 'a?(x: T)'. Any other '?' is the ternary's, and
       stays -- but it opens a ':' that is not an annotation, so it is counted here and closed there. */
    if (t.k === 'p' && t.v === '?') {
      if (isP(i + 1, ':') || isP(i + 1, '(')) { blank(t.s, t.e); i++; continue; }
      ternaries++;
      i++;
      continue;
    }
    /* A non-null assertion: 'a!.b', 'a!)', 'a!;', 'm!: string'. A '!' in front of an expression is
       not one, which is what the value in front of it says. */
    if (t.k === 'p' && t.v === '!') {
      var bpi = prevIdx(i);
      var bni = nextIdx(i);
      var bp = bpi >= 0 ? tokens[bpi] : null;
      var bn = bni >= 0 ? tokens[bni] : null;
      var afterValue = bp !== null && (bp.k === 'w' || bp.k === 'n' || bp.k === 's' || bp.k === 'r'
        || bp.v === ')' || bp.v === ']' || bp.v === '}');
      var closes = bn === null || bn.v === '.' || bn.v === ';' || bn.v === ',' || bn.v === ')'
        || bn.v === ']' || bn.v === '}' || bn.v === ':';
      if (afterValue && closes) { blank(t.s, t.e); i++; continue; }
      i++;
      continue;
    }
    /* A type parameter list: the '<...>' of a declaration of a class, of a function, of a method or
       of an 'extends' clause. Anything else that looks like one is a comparison and stays. */
    if (t.k === 'p' && t.v === '<') {
      var gi = prevIdx(i);
      var gp = gi >= 0 ? tokens[gi] : null;
      var declares = false;
      if (gp !== null && gp.k === 'w') {
        var gii = prevIdx(gi);
        var gpp = gii >= 0 ? tokens[gii] : null;
        if (gpp !== null && gpp.k === 'w' && (gpp.v === 'class' || gpp.v === 'function'
          || gpp.v === 'interface' || gpp.v === 'extends' || gpp.v === 'implements')) declares = true;
        else {
          /* Otherwise only a call can carry type arguments: what follows the matching '>' has to be
             the argument list, and that is all that tells 'f<T>(x)' from 'a < b && c > d', a
             comparison that has to survive. It also tells them apart from 'a < b) ', which no '>'
             ever closes. Node reads a '<' in front of a call the same way, which is why
             'a < b > (c)' is a call with a type argument there and not two comparisons. */
          var closeG = angleMatch(i);
          var afterG = closeG >= 0 ? nextIdx(closeG) : -1;
          if (afterG >= 0 && tokens[afterG].k === 'p' && tokens[afterG].v === '(') declares = true;
        }
      }
      if (declares) {
        var ge = angleMatch(i);
        if (ge < 0) { i++; continue; }
        blank(t.s, tokens[ge].e);
        i = ge + 1;
        continue;
      }
      i++;
      continue;
    }
    i++;
  }

  var out = '';
  for (var c2 = 0; c2 < src.length; c2++) out += gone[c2] ? ' ' : src.charAt(c2);
  return out;
}

BF.module = function () {
  /* Both of these are frozen on the host: a package that pushes onto builtinModules or patches
     constants.compileCacheStatus meets a TypeError there, not a silent change. */
  Module.builtinModules = Object.freeze(NODE_BUILTIN_NAMES.slice());
  Module.isBuiltin = function isBuiltin(name) {
    var id = typeof name === 'string' ? name : '';
    if (Object.prototype.hasOwnProperty.call(BUILTIN_NAME_SET, id)) return true;
    /* One 'node:' and no more: the remainder has to be a name of its own -- 'node:sea' is one, so
       'node:node:sea' is not, and neither is 'node:node:test/reporters' -- where 'node:fs' is,
       'fs' being one. Two prefixes stripped would make both of those true. */
    if (id.indexOf('node:') !== 0) return false;
    var rest = id.slice(5);
    if (rest.indexOf('node:') === 0) return false;
    return Object.prototype.hasOwnProperty.call(BUILTIN_NAME_SET, rest);
  };
  /* The table of extension handlers: var hoisting made the assignment where the class is built run
     before the table's own initialiser, so the static was undefined while require.extensions -- the
     same object, handed out to every module later -- was not. */
  Module._extensions = EXTENSIONS;
  Module.constants = Object.freeze({
    compileCacheStatus: Object.freeze({ FAILED: 0, ENABLED: 1, ALREADY_ENABLED: 2, DISABLED: 3 })
  });
  Module.SourceMap = SourceMap;
  /* Deprecated in node to the point of doing nothing: it prints no warning there and returns
     undefined, and so does this. */
  Module._debug = function _debug() { return undefined; };
  /* globalPaths is filled at bootstrap, from three places: the folders NODE_PATH names, then
     $HOME/.node_modules and $HOME/.node_libraries, then the install prefix's own lib/node -- the
     prefix being the directory two above the node binary, which is what makes the third one
     $PREFIX/lib/node. They are the machine's own home directory and its own install prefix,
     exactly as os.homedir() and process.execPath are, so the three folders named here are this
     container's and not the host's: what is host-identical is the count, the order, the derivation
     and the three a lookup path then carries, where an empty array dropped them from every lookup.
     Node reads the home directory out of the environment and not out of os.homedir() -- a program
     started with HOME set elsewhere gets the folders of the HOME it was given -- and an
     environment with no HOME at all gets the prefix folder alone. loader.ts assigns the empty
     array this replaces; the statics of require('module') are filled in here, so this is the
     assignment that stands. row owc-module-globalpaths-empty. */
  Module._initPaths = function _initPaths() {
    var pathFor = requireBuiltin('path');
    var proc = globalThis.process;
    var env = proc && proc.env ? proc.env : {};
    var isWindows = !!proc && proc.platform === 'win32';
    var homeDir = isWindows ? env.USERPROFILE : env.HOME;
    var paths = [];
    if (env.NODE_PATH) {
      var given = String(env.NODE_PATH).split(isWindows ? ';' : ':');
      for (var g = 0; g < given.length; g++) {
        if (given[g].length > 0) paths.push(pathFor.resolve(given[g]));
      }
    }
    if (homeDir) {
      paths.push(pathFor.resolve(homeDir, '.node_modules'));
      paths.push(pathFor.resolve(homeDir, '.node_libraries'));
    }
    if (proc && typeof proc.execPath === 'string') {
      paths.push(pathFor.resolve(proc.execPath, '..', '..', 'lib', 'node'));
    }
    Module.globalPaths = paths;
    /* Node's own answers undefined -- it fills the static and hands nothing back -- so a caller
       that reads the return of _initPaths() gets undefined here too. */
    return undefined;
  };
  Module._initPaths();
  /* internalModuleStat is one stat(2) call, so the errno it hands back is the kernel's, and three
     of them this filesystem's statSync cannot name at all: ENOTDIR for a '.' or a '..' that it
     folds into the path rather than walking through the component in front of it, ELOOP for a link
     chain that comes back on itself (statSync reports one as missing), and ENAMETOOLONG for a
     component past NAME_MAX. A path any of them decides is therefore walked here, component by
     component: every one but the leaf has to be a directory, '.' and '..' are read as the traversal
     they are instead of being dropped, and a link is followed under a hop count so a cycle ends as
     ELOOP and not as a hang. It answers null where it has nothing to say -- a path that is not
     absolute, or a link whose target will not read -- and the caller falls back to statSync and to
     the parent walk below. row owc-module-stat-enotdir-for-file-parent. */
  var STAT_ENOTDIR = -20;
  var STAT_ELOOP = -62;
  var STAT_ENAMETOOLONG = -63;
  var STAT_NAME_MAX = 255;
  function walkForStat(p) {
    var fsWalk = requireBuiltin('fs');
    if (typeof fsWalk.lstatSync !== 'function' || typeof fsWalk.readlinkSync !== 'function') return null;
    /* Only an absolute path has components this can name: a relative one is resolved against a
       working directory the loader, not this walk, is the authority on. */
    if (p.charAt(0) !== '/') return null;
    var pathWalk = requireBuiltin('path');
    var raw = p.split('/');
    var names = [];
    for (var i = 0; i < raw.length; i++) if (raw[i].length > 0) names.push(raw[i]);
    if (names.length === 0) return 1;
    var at = '/';
    var leaf = null;
    for (var n = 0; n < names.length; n++) {
      var seg = names[n];
      if (seg === '.' || seg === '..') {
        var here;
        try { here = fsWalk.lstatSync(at); } catch (e) { return null; }
        if (!here.isDirectory()) return STAT_ENOTDIR;
        if (seg === '..') at = pathWalk.dirname(at);
        leaf = null;
        continue;
      }
      var next = (at === '/' ? '/' : at + '/') + seg;
      var st;
      try { st = fsWalk.lstatSync(next); } catch (e2) { return null; }
      var hops = 0;
      while (st.isSymbolicLink()) {
        if (hops >= 40) return STAT_ELOOP;
        var target;
        try { target = fsWalk.readlinkSync(next); } catch (e3) { return null; }
        next = target.charAt(0) === '/' ? target : pathWalk.resolve(pathWalk.dirname(next), target);
        try { st = fsWalk.lstatSync(next); } catch (e4) { return null; }
        hops++;
      }
      if (n < names.length - 1 && !st.isDirectory()) return STAT_ENOTDIR;
      at = next;
      leaf = st;
    }
    if (leaf === null) {
      try { leaf = fsWalk.lstatSync(at); } catch (e5) { return null; }
    }
    return leaf.isDirectory() ? 1 : 0;
  }
  /* internalModuleStat's own answer: 0 for a file, 1 for a directory and the negated errno for a
     path that is not there, which is what a caller of _stat compares against. Node's own stat is
     not this filesystem's statSync -- it is a call of its own, and it names ENOTDIR where it finds
     a component that is not a directory. row owc-module-stat-enotdir-for-file-parent. */
  Module._stat = function _stat(filename) {
    /* Node asserts on a path that is not a string rather than reporting it as missing, and an
       empty one is one no filesystem of its own will look up: it is ENOENT there, not the
       directory this one's own statSync would fall back to. */
    if (typeof filename !== 'string') {
      var bad = new Error('This is caused by either a bug in Node.js or incorrect usage of Node.js internals.\n'
        + 'Please open an issue with this stack trace at https://github.com/nodejs/node/issues\n');
      bad.code = 'ERR_INTERNAL_ASSERTION';
      throw bad;
    }
    if (filename === '') return -2;
    var fsForStat = requireBuiltin('fs');
    var ENOENT = -2;
    var ENOTDIR = STAT_ENOTDIR;
    function isNotDir(err) {
      return !!err && (err.code === 'ENOTDIR' || err.errno === 20);
    }
    /* A component past NAME_MAX is one the kernel refuses before it looks at anything else, and
       ENAMETOOLONG is what node negates for it; statSync reads such a path as merely missing. */
    var components = filename.split('/');
    var dotSegment = false;
    for (var c = 0; c < components.length; c++) {
      if (components[c].length > STAT_NAME_MAX) return STAT_ENAMETOOLONG;
      if (components[c] === '.' || components[c] === '..') dotSegment = true;
    }
    /* A trailing slash is the one component no walk can name: 'plain.js/' is not 'plain.js' looked
       up inside itself, it is the same file asked for as a directory, and that is ENOTDIR on a
       host. This filesystem's statSync drops the slash and answers the file (the site is
       guest/buffer-fs.ts), so the slash has to be read here, before anything else is looked up. */
    var bare = filename;
    while (bare.length > 1 && bare.charAt(bare.length - 1) === '/') bare = bare.slice(0, -1);
    if (bare !== filename) {
      try {
        if (!fsForStat.statSync(bare).isDirectory()) return ENOTDIR;
      } catch (e) {
        /* Nothing there either: the walk below is what names it. */
      }
    }
    /* Where the path names a '.' or a '..', statSync's answer is the path with it folded away,
       which is not the answer of a call that has to walk through the component in front of it. */
    if (dotSegment) {
      var walkedDot = walkForStat(filename);
      if (walkedDot !== null) return walkedDot;
    }
    try {
      return fsForStat.statSync(filename).isDirectory() ? 1 : 0;
    } catch (e) {
      if (isNotDir(e)) return ENOTDIR;
      /* A path that is there only through a link this filesystem's own statSync will not follow,
         and one whose links come back on themselves, are two the walk can name and this catch
         cannot: it reads both as missing. */
      var walked = walkForStat(filename);
      if (walked !== null) return walked;
      /* Which of the two it is has to be read off the nearest parent that does exist: a parent
         that is a file makes every path under it ENOTDIR, one that is a directory or is itself
         missing makes it ENOENT, exactly as node's own walk from the leaf upwards reads it. */
      var at = dirnameOf(bare);
      for (var guard = 0; guard < 4096; guard++) {
        try {
          return fsForStat.statSync(at).isDirectory() ? ENOENT : ENOTDIR;
        } catch (inner) {
          if (isNotDir(inner)) return ENOTDIR;
          var up = dirnameOf(at);
          if (up === at) return ENOENT;
          at = up;
        }
      }
      return ENOENT;
    }
  };
  /* The file a request resolves to under one of the given directories, or false: node's own
     extension search, which the host resolver does, asked directory by directory. The cache is
     read and written in findPathCached, which is where node reads and writes it -- inside its
     own _findPath, keyed by the request and by the paths it was looked for in. */
  Module._findPath = function _findPath(request, paths, isMain) {
    return findPathCached(request, paths);
  };
  /* The package.json of a directory, as node's reader gives it: the few fields it reads out of the
     file -- name, main, type, exports and imports, in that order -- followed by exists and
     pjsonPath. exports and imports are always present in the record of a file that is there, as
     own keys worth undefined when the file names neither, and a type that is not one of the two
     node knows is read as 'none'. A directory with no package.json is the record of the file that
     is not there: type 'none' and exists false, and no field besides. */
  Module._readPackage = function _readPackage(requestPath) {
    if (typeof requestPath !== 'string') {
      var err = new TypeError('The "paths[0]" argument must be of type string. Received ' + receivedTypeOf(requestPath));
      err.code = 'ERR_INVALID_ARG_TYPE';
      throw err;
    }
    var pjsonPath = requireBuiltin('path').resolve(requestPath, 'package.json');
    var text = host.readText(pjsonPath);
    if (text === null) return { type: 'none', exists: false, pjsonPath: pjsonPath };
    var parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      /* A package.json that does not parse is a broken package, not a missing one. */
      var bad = new Error('Invalid package config ' + pjsonPath + '.');
      bad.code = 'ERR_INVALID_PACKAGE_CONFIG';
      throw bad;
    }
    if (parsed === null || typeof parsed !== 'object') parsed = {};
    var out = {};
    if (typeof parsed.name === 'string') out.name = parsed.name;
    if (typeof parsed.main === 'string') out.main = parsed.main;
    out.type = parsed.type === 'commonjs' || parsed.type === 'module' ? parsed.type : 'none';
    out.exports = parsed.exports;
    out.imports = parsed.imports;
    out.exists = true;
    out.pjsonPath = pjsonPath;
    return out;
  };
  /* Where a request is looked for: nothing at all for a built-in, the parent's node_modules paths
     ahead of the global ones for a bare name, and the parent's own directory for a relative one --
     '.' when there is no parent file, as in the REPL. */
  Module._resolveLookupPaths = function _resolveLookupPaths(request, parent) {
    if (Module.isBuiltin(request)) return null;
    /* Relative is what node calls a request beginning with '.' that a bare name does not hide
       behind: './x', '../x' and '.' are relative, '.hidden' is not, and neither is '/x', which
       node sends to the node_modules branch with every other bare name. A request that is not a
       string, the empty one included, is no relative request either and goes the same way. */
    var req = typeof request === 'string' ? request : '';
    var relative = req.charAt(0) === '.'
      && (req.length === 1 || req.charAt(1) === '.' || req.charAt(1) === '/');
    if (relative) {
      if (!parent || !parent.id || !parent.filename) return ['.'];
      return [dirnameOf(parent.filename)];
    }
    var paths = Module.globalPaths.slice();
    if (parent && parent.paths && parent.paths.length > 0) {
      paths = parent.paths.slice().concat(paths);
    }
    /* Node answers the array it built, empty or not, and only ever answers null for a request a
       built-in answers for; with no parent and no global folders it is an empty array, not null.
       row owc-module-globalpaths-empty. */
    return paths;
  };
  /* The package.json of the package a specifier names, as a path: the specifier is resolved as a
     module and the walk goes up from what it found to the nearest package.json carrying that name,
     the way node's own reader goes from a resolved package to its manifest. */
  Module.findPackageJSON = function findPackageJSON(specifier, base = undefined) {
    if (arguments.length === 0) {
      var missing = new TypeError('The "specifier" argument must be specified');
      missing.code = 'ERR_MISSING_ARGS';
      throw missing;
    }
    var name;
    try {
      /* Node stringifies with a template literal, which is the one conversion a symbol refuses:
         String() of one would quietly yield 'Symbol(s)', and node names it in the message its
         string validator gives rather than reporting it as unresolvable. */
      name = '' + specifier;
    } catch (e) {
      var notString = new TypeError('The "specifier" argument must be of type string. Received '
        + receivedTypeOf(specifier));
      notString.code = 'ERR_INVALID_ARG_TYPE';
      throw notString;
    }
    /* Node's own default base is 'data:', a URL no file path parses against, so with no base at
       all a bare name is an invalid URL there rather than a package it cannot find; a base that is
       neither a URL nor an absolute path fails the same way, and one that is not a string at all
       is refused as an argument first. */
    var from;
    if (base === undefined) {
      from = null;
    } else if (typeof base !== 'string') {
      var badBase = new TypeError('The "base" argument must be of type string. Received ' + receivedTypeOf(base));
      badBase.code = 'ERR_INVALID_ARG_TYPE';
      throw badBase;
    } else if (base.indexOf('file://') === 0) {
      from = base.slice(7);
    } else if (base.charAt(0) === '/') {
      from = base;
    } else {
      var badURL = new TypeError('Invalid URL');
      badURL.code = 'ERR_INVALID_URL';
      throw badURL;
    }
    /* A specifier carrying a scheme is not a bare name, and node's resolver refuses every scheme
       but file before it looks anywhere. */
    var scheme = /^[A-Za-z][A-Za-z0-9+\-.]*:/.exec(name);
    if (scheme && scheme[0].toLowerCase() !== 'file:') {
      var badScheme = new TypeError('The URL must be of scheme file');
      badScheme.code = 'ERR_INVALID_URL_SCHEME';
      throw badScheme;
    }
    if (from === null) {
      var noBase = new TypeError('Invalid URL');
      noBase.code = 'ERR_INVALID_URL';
      throw noBase;
    }
    /* Node resolves from the file it is handed, and reports that file, not the directory holding
       it, in the message it gives when the package is not there; the host resolver reads a
       package.json out of the directory it takes, and handing it a file makes it read that file as
       one, so the file is walked up to the directory holding it before it is resolved from. */
    var startDir = from;
    if (Module._stat(startDir) !== 1) startDir = dirnameOf(startDir);
    var found = host.resolve(name, startDir, 'require') || host.resolve(name, startDir, 'import');
    if (!found) {
      var err = new Error("Cannot find package '" + name + "' imported from " + from);
      err.code = 'ERR_MODULE_NOT_FOUND';
      throw err;
    }
    var dir = dirnameOf(found);
    while (true) {
      var pjsonPath = dir + '/package.json';
      var text = host.readText(pjsonPath);
      if (text !== null) {
        try {
          var parsed = JSON.parse(text);
          if (parsed && parsed.name === name) return pjsonPath;
        } catch (e) { /* a package.json that does not parse is not the one being looked for */ }
      }
      var up = dirnameOf(dir);
      if (up === dir) break;
      dir = up;
    }
    return undefined;
  };
  /* Nothing here writes a source map, so there is never one to find: node answers undefined for a
     builtin, for a file under node_modules while that support is off, and for any file it holds no
     map for, which is every file here. */
  Module.findSourceMap = function findSourceMap(sourceURL) {
    if (typeof sourceURL !== 'string') return undefined;
    return undefined;
  };
  var sourceMapsEnabled = false;
  Module.getSourceMapsSupport = function getSourceMapsSupport() {
    return { enabled: sourceMapsEnabled, nodeModules: false, generatedCode: false };
  };
  Module.setSourceMapsSupport = function setSourceMapsSupport(enabled) {
    if (typeof enabled !== 'boolean') {
      var err = new TypeError('The "enabled" argument must be of type boolean. Received '
        + receivedTypeOf(enabled));
      err.code = 'ERR_INVALID_ARG_TYPE';
      throw err;
    }
    sourceMapsEnabled = enabled;
  };
  /* Node's entry point runner: the file named, or argv[1], resolved and loaded as the main module.
     Node hands an entry that is one to the ESM loader, and loadCJS does the same here. The entry
     is read off arguments rather than named, because node declares no parameter and the arity a
     caller can read is 0. */
  Module.runMain = function runMain() {
    var main = arguments[0];
    var entry = main === undefined ? requireBuiltin('process').argv[1] : main;
    if (typeof entry !== 'string') {
      /* Node reaches this through the resolver's own path check, so it names paths[0] and not
         main, and it names the value the way every other argument error of its does. */
      var err = new TypeError('The "paths[0]" argument must be of type string. Received ' + receivedTypeOf(entry));
      err.code = 'ERR_INVALID_ARG_TYPE';
      throw err;
    }
    var filename = host.resolve(entry, host.cwd(), 'require');
    if (!filename) throw moduleNotFound(entry);
    /* The key node's own bootstrap leaves in Module._pathCache: it runs the entry through
       Module._load, and so through _resolveFilename and _findPath, and the file it found is
       cached under the request and the paths it was looked for in -- [''] for a path that is
       absolute, so the key is the path, a NUL and nothing after it. The loader here is asked for
       the entry directly, so the key is written from the same argument and the same paths. */
    var entryPaths;
    if (entry.charAt(0) === '/') entryPaths = [''];
    else if (entry.charAt(0) === '.' && (entry.length === 1 || entry.charAt(1) === '.'
      || entry.charAt(1) === '/')) entryPaths = ['.'];
    else entryPaths = Module.globalPaths;
    Module._pathCache[entry + PATH_CACHE_SEP + entryPaths.join(PATH_CACHE_SEP)] = filename;
    loadCJS(filename, undefined, true);
  };
  /* Node 24 exports no createRequireFromPath: the deprecated alias went with DEP0131, and a
     package asking for it here must see the same undefined it sees there. */
  delete Module.createRequireFromPath;
  /* Four statics node defines with enumerable false. They are own properties of its Module class
     exactly as they are of this one -- _stat and _readPackage are the loader's own stat and package
     reader, wrap and wrapper the CommonJS source wrapper -- but none of the four stands in
     Object.keys(require('module')) or in the namespace of an 'await import' of node:module, which is
     why node's count is 31 where this one's was 29. The values stay: the loader calls _stat and
     wrap itself, and only their enumerability is node's.
     Node keeps all four behind an accessor pair rather than behind a value, and it freezes the two
     halves of the wrapper while leaving the two loader hooks open: wrap and wrapper are
     configurable false there, _stat and _readPackage configurable true. An assignment lands through
     the setter, as it does on a host -- what a caller sets is what the getter hands back.
     row owc-module-export-table-incomplete. */
  var MODULE_HIDDEN_STATICS = [['_stat', true], ['_readPackage', true], ['wrap', false], ['wrapper', false]];
  function hideModuleStatic(owner, name, configurable) {
    var held = owner[name];
    Object.defineProperty(owner, name, {
      get: function () { return held; },
      set: function (value) { held = value; },
      enumerable: false,
      configurable: configurable
    });
  }
  for (var hiddenAt = 0; hiddenAt < MODULE_HIDDEN_STATICS.length; hiddenAt++) {
    var hiddenStatic = MODULE_HIDDEN_STATICS[hiddenAt][0];
    if (!Object.prototype.hasOwnProperty.call(Module, hiddenStatic)) continue;
    hideModuleStatic(Module, hiddenStatic, MODULE_HIDDEN_STATICS[hiddenAt][1]);
  }
  /* The compile cache is a V8 code cache written beside the modules node loads, and there is no
     code cache here: nothing is compiled to bytecode a later run could reuse. So the three entry
     points answer the way node's do when its own cache is off -- DISABLED, no directory, nothing
     to flush -- and the status is read off the frozen table above rather than written twice. */
  /* The directory a caller names is one no cache can be written into, so the status stays DISABLED
     whichever it is; the parameter is node's own arity, which is 1. The argument itself is still
     checked the way node checks it -- node raises ERR_INVALID_ARG_TYPE, a TypeError, for anything
     that is neither a string nor absent, and its message names the parameter alone. */
  Module.enableCompileCache = function enableCompileCache(cacheDir) {
    if (cacheDir !== undefined && typeof cacheDir !== 'string') {
      var badCacheDir = new TypeError('cacheDir should be a string');
      badCacheDir.code = 'ERR_INVALID_ARG_TYPE';
      throw badCacheDir;
    }
    return { status: Module.constants.compileCacheStatus.DISABLED, directory: undefined };
  };
  Module.flushCompileCache = function flushCompileCache() { return undefined; };
  Module.getCompileCacheDir = function getCompileCacheDir() { return undefined; };
  /* Module customization hooks. Node runs the hooks a registration names in a loader thread of its
     own, before every resolve and every load; this loader has no such thread, so a registration is
     recorded and no hook is ever called -- the graph a program sees is the one the loader resolves
     and reads itself. The two calls keep node's own argument handling, including the
     ERR_UNSUPPORTED_RESOLVE_REQUEST a specifier it cannot resolve raises: node resolves against the
     parent URL a second argument gives and against 'data:', which is not hierarchical, when there
     is none, so a relative specifier with no parent fails there exactly as it does here. */
  var registeredHooks = null;
  function unsupportedResolveRequest(specifier, base) {
    var err = new Error('Failed to resolve module specifier "' + specifier + '" from "' + base
      + '": Invalid relative URL or base scheme is not hierarchical.');
    err.code = 'ERR_UNSUPPORTED_RESOLVE_REQUEST';
    return err;
  }
  /* Node declares one parameter and reads the other two off its arguments -- the parent URL and the
     options both default -- so a caller that reads register.length sees 1 there. */
  Module.register = function register(specifier) {
    var parentURL = arguments[1];
    var options = arguments[2];
    var spec = typeof specifier === 'string' ? specifier : String(specifier);
    var base = typeof parentURL === 'string' && parentURL.length > 0 ? parentURL : 'data:';
    var resolved = '';
    if (base !== 'data:') {
      var from = base.indexOf('file://') === 0 ? base.slice(7) : base;
      var cut = from.lastIndexOf('/');
      resolved = host.resolve(spec, cut > 0 ? from.slice(0, cut) : '/', 'require');
    } else if (spec.charAt(0) !== '.' && spec.charAt(0) !== '/') {
      resolved = host.resolve(spec, host.cwd(), 'require');
    }
    if (!resolved) throw unsupportedResolveRequest(spec, base);
    registeredHooks = { specifier: resolved, options: options };
    return undefined;
  };
  Module.registerHooks = function registerHooks(hooks) {
    if (hooks === null || typeof hooks !== 'object') {
      var err = new TypeError('The "hooks" argument must be of type object. Received '
        + receivedTypeOf(hooks));
      err.code = 'ERR_INVALID_ARG_TYPE';
      throw err;
    }
    registeredHooks = { hooks: hooks };
    /* Node hands back a ModuleHooks carrying the two hooks a caller gave, as own keys worth
       undefined where it gave none. */
    return { resolve: hooks.resolve, load: hooks.load };
  };
  /* The type stripper as a call, over a string of TypeScript a caller holds: what comes back is the
     program with every type blanked out, which is what node's own .ts support compiles. It warns
     once, as node does, that the call is experimental. */
  var stripTypesWarned = false;
  /* The options are read off the arguments for the same reason register's are: node declares the
     code and nothing beside it, and its arity is 1. */
  Module.stripTypeScriptTypes = function stripTypeScriptTypes(code) {
    var options = arguments[1];
    if (typeof code !== 'string') {
      var badCode = new TypeError('The "code" argument must be of type string. Received '
        + receivedTypeOf(code));
      badCode.code = 'ERR_INVALID_ARG_TYPE';
      throw badCode;
    }
    if (options !== undefined && (options === null || typeof options !== 'object')) {
      var badOptions = new TypeError('The "options" argument must be of type object. Received '
        + receivedTypeOf(options));
      badOptions.code = 'ERR_INVALID_ARG_TYPE';
      throw badOptions;
    }
    if (!stripTypesWarned) {
      stripTypesWarned = true;
      var procWarn = globalThis.process;
      if (procWarn && typeof procWarn.emitWarning === 'function') {
        procWarn.emitWarning('stripTypeScriptTypes is an experimental feature and might change'
          + ' at any time', 'ExperimentalWarning');
      }
    }
    return tsStripTypes(code);
  };

  /*
   * Node's own instance surface, which the constructor in loader.ts does not carry. There 'parent'
   * is a field the constructor owns; on a host it is an accessor on the prototype, so a module
   * stores the one it was given without owning a key for it. 'isPreloading' is a getter answering
   * false -- a CJS graph this loader walks has no preload phase to be inside. row
   * owc-module-export-table-incomplete.
   */
  var moduleParents = typeof WeakMap === 'function' ? new WeakMap() : null;
  /* 'parent' is a getter/setter over a weak map, so a module the loader builds carries the one it
     was given without owning a key for it; the class require('module') hands out stores it under
     the symbol node's own constructor writes instead, so the getter reads that too. */
  Object.defineProperty(Module.prototype, 'parent', {
    get: function getParent() {
      if (moduleParents !== null && moduleParents.has(this)) return moduleParents.get(this);
      return this[kFirstModuleParent];
    },
    set: function setParent(value) {
      if (moduleParents !== null) moduleParents.set(this, value);
    },
    enumerable: false, configurable: false
  });
  Object.defineProperty(Module.prototype, 'isPreloading', {
    get: function getIsPreloading() { return false; },
    enumerable: false, configurable: false
  });

  /* The require of a module of one's own: makeRequire is the loader's local, so this is the same
     four keys over the module handed in -- resolve, main, extensions and cache -- with a request
     resolved from the module's own directory. */
  function requireForModule(mod) {
    var req = function requireOf(id) { return Module.prototype.require.call(mod, id); };
    req.resolve = function resolveOf(id) {
      if (typeof id === 'string' && Module.isBuiltin(id)) return String(id);
      var found = host.resolve(String(id), mod.path, 'require');
      if (!found) throw notFoundError(id, mod.path, mod);
      return found;
    };
    /* resolve.paths: the folders a bare request is looked for in, which is the module's own
       node_modules chain followed by the global folders -- the list _resolveLookupPaths builds,
       and null for a built-in, which has no folders to be looked for in. */
    req.resolve.paths = function paths(request) {
      if (typeof request !== 'string') {
        var badRequest = new TypeError('The "request" argument must be of type string. Received '
          + receivedTypeOf(request));
        badRequest.code = 'ERR_INVALID_ARG_TYPE';
        throw badRequest;
      }
      return Module._resolveLookupPaths(request, mod);
    };
    req.main = mainModule;
    req.extensions = Module._extensions;
    req.cache = Module._cache;
    return req;
  }

  /*
   * load and _compile are the two halves of what the loader otherwise does with copies of its own:
   * load names the file, builds the module's paths and hands the file to the extension handler,
   * and _compile runs node's wrapper over a string a caller already holds.
   */
  Module.prototype.load = function load(filename) {
    var pathForLoad = requireBuiltin('path');
    this.filename = filename;
    this.paths = Module._nodeModulePaths(pathForLoad.dirname(filename));
    var extension = pathForLoad.extname(filename);
    if (!Object.prototype.hasOwnProperty.call(Module._extensions, extension)) extension = '.js';
    /* Node reads the file itself, so a path that is not there is ENOENT out of open(2) and not the
       MODULE_NOT_FOUND a resolve that found nothing gives: the two are different errors there. */
    if (host.readText(filename) === null) {
      var noFile = new Error('ENOENT: no such file or directory, open \'' + filename + '\'');
      noFile.code = 'ENOENT';
      noFile.errno = -2;
      noFile.syscall = 'open';
      noFile.path = filename;
      throw noFile;
    }
    Module._extensions[extension](this, filename);
    this.loaded = true;
    return undefined;
  };
  Module.prototype._compile = function compile(content, filename) {
    var vmForCompile = requireBuiltin('vm');
    var pathForCompile = requireBuiltin('path');
    /* It does not name the module's file -- that is load()'s job -- so a caller of _compile alone
       leaves filename and loaded as they were, exactly as one does on a host. */
    var wrapper = vmForCompile.runInThisContext(Module.wrap(String(content)), { filename: filename });
    wrapper.call(this.exports, this.exports, requireForModule(this), this, filename,
      pathForCompile.dirname(filename));
    return undefined;
  };

  /* createRequire hands out a require with no resolve.paths on it (the site is makeRequire and
     createRequireFor in loader.ts, which is outside this grant); the require it builds resolves
     from the file it was given, so the parent a lookup reads paths off is that file's own. */
  var createRequireInner = Module.createRequire;
  /* The one argument node's createRequire accepts: a file: URL object, a 'file://' string, or an
     absolute path. Every other argument -- a relative path, an empty string, a number, a boolean,
     null, a plain object and a URL of any scheme but file: -- raises ERR_INVALID_ARG_VALUE with
     node's own wording, and the value it names is what util.inspect prints for the argument. A
     'file://x.js' with no path behind the scheme is refused too: a URL with no absolute path in it
     is the "not hierarchical" answer node gives there. row owc-module-export-table-incomplete. */
  var URLForRequire = typeof URL === 'function' ? URL : null;
  function createRequireBaseOf(filename) {
    if (URLForRequire !== null && filename instanceof URLForRequire) {
      if (String(filename.protocol) !== 'file:') return null;
      return decodeURIComponent(String(filename.pathname));
    }
    if (typeof filename !== 'string') return null;
    if (filename.indexOf('file://') === 0) {
      var afterScheme = filename.slice(7);
      var slashOf = afterScheme.indexOf('/');
      if (slashOf < 0) return null;
      return decodeURIComponent(afterScheme.slice(slashOf));
    }
    return requireBuiltin('path').isAbsolute(filename) ? filename : null;
  }
  Module.createRequire = function createRequire(filename) {
    var base = createRequireBaseOf(filename);
    if (base === null) {
      /* Node cuts the value it prints at 128 characters and marks the cut with three dots, so a
         URL argument is not the whole of its inspect in the message -- measured on host 24.15:
         a 126-character string prints whole and a 127-character one is cut. */
      var inspectedFilename = requireBuiltin('util').inspect(filename);
      if (inspectedFilename.length > 128) inspectedFilename = inspectedFilename.slice(0, 128) + '...';
      var badFilename = new TypeError("The argument 'filename' must be a file URL object, file URL"
        + ' string, or absolute path string. Received ' + inspectedFilename);
      badFilename.code = 'ERR_INVALID_ARG_VALUE';
      throw badFilename;
    }
    var req = createRequireInner(filename);
    var parentForPaths = {
      id: base, filename: base, path: dirnameOf(base),
      paths: Module._nodeModulePaths(dirnameOf(base))
    };
    req.resolve.paths = function paths(request) {
      if (typeof request !== 'string') {
        var badRequest = new TypeError('The "request" argument must be of type string. Received '
          + receivedTypeOf(request));
        badRequest.code = 'ERR_INVALID_ARG_TYPE';
        throw badRequest;
      }
      return Module._resolveLookupPaths(request, parentForPaths);
    };
    /* The order node's own makeRequire leaves on the require: resolve first, then main, extensions
       and cache. The loader's local builds the same four the other way about, and the order is what
       Object.keys(require) of one a caller asked for reads. */
    var cacheOf = req.cache;
    var mainOf = req.main;
    var extensionsOf = req.extensions;
    delete req.cache;
    delete req.main;
    delete req.extensions;
    req.main = mainOf;
    req.extensions = extensionsOf;
    req.cache = cacheOf;
    return req;
  };

  /*
   * The class require('module') hands out. It carries the same prototype and the same statics as the
   * loader's own Module -- the loader keeps that one, and fills a module's file name and its
   * node_modules list in it, which is what it resolves from -- but it builds a module the way node's
   * constructor does: a module names its file and builds its paths in load(), so one that has only
   * been constructed answers null for the first and has no key at all for the second. The keys it
   * does own are node's own six, in node's own order.
   *
   * String() of that class is its source text, and QuickJS hands back the text it parsed, so the
   * constructor is spelled the way node spells it -- the name node gives it, the defaulted first
   * parameter that makes its arity 0, the two-space body -- and the three helpers the body names
   * are node's own. That is the only reason the body sits inside an IIFE: Module is the loader's
   * class out here, so the name node's text carries has to be taken in a scope of its own, and
   * path is read when a module is built rather than when this class is, because the built-in that
   * answers it is not what the loader is filling yet.
   */
  var kFirstModuleParent = Symbol('kFirstModuleParent');
  var kLastModuleParent = Symbol('kLastModuleParent');
  function setOwnProperty(obj, prop, value) {
    Object.defineProperty(obj, prop,
      { value: value, writable: true, enumerable: true, configurable: true });
    return value;
  }
  function updateChildren(parent, child, scan) {
    var children = parent === null || parent === undefined ? undefined : parent.children;
    if (children && !(scan && children.indexOf(child) !== -1)) children.push(child);
  }
  var ModuleOf = (function () {
    var path = { dirname: function dirnameOf(p) { return requireBuiltin('path').dirname(p); } };
    return function Module(id = '', parent) {
  this.id = id;
  this.path = path.dirname(id);
  setOwnProperty(this, 'exports', {});
  this[kFirstModuleParent] = parent;
  this[kLastModuleParent] = parent;
  updateChildren(parent, this, false);
  this.filename = null;
  this.loaded = false;
  this.children = [];
};
  })();
  var moduleStatics = Object.getOwnPropertyNames(Module);
  for (var msAt = 0; msAt < moduleStatics.length; msAt++) {
    var staticName = moduleStatics[msAt];
    if (staticName === 'prototype' || staticName === 'name' || staticName === 'length') continue;
    Object.defineProperty(ModuleOf, staticName, Object.getOwnPropertyDescriptor(Module, staticName));
  }
  ModuleOf.prototype = Module.prototype;
  /* Node's own descriptor for it: a getter, so require('module').prototype.constructor is the class
     require('module') handed out and not the loader's own, and neither writable nor enumerable. */
  Object.defineProperty(Module.prototype, 'constructor', {
    get: function getConstructor() { return ModuleOf; },
    enumerable: false, configurable: false
  });
  Object.defineProperty(ModuleOf, 'name', { value: 'Module', writable: false, configurable: true });
  Object.defineProperty(ModuleOf, 'length', { value: 0, writable: false, configurable: true });
  /* The self-reference node carries: require('module').Module is the class itself. */
  ModuleOf.Module = ModuleOf;
  /* _initPaths fills the static on the loader's own Module, so the copy is filled from it. */
  var initPathsInner = ModuleOf._initPaths;
  ModuleOf._initPaths = function _initPaths() {
    var answer = initPathsInner();
    ModuleOf.globalPaths = Module.globalPaths;
    return answer;
  };
  return ModuleOf;
};

/*
 * The two halves of a resolution the loader keeps apart -- the name it answers and the file it
 * finds -- on the three shapes where they had drifted from node's own.
 */

/* The separator node joins the lookup paths with inside a path-cache key: a NUL, built this way
   because this source is a raw string and an escape written in it would reach the engine as six
   characters of its own. */
var PATH_CACHE_SEP = String.fromCharCode(0);

/* The file a request resolves to under one of the given directories, or false, and the cache node
   keeps of every resolution it has made: the key is the request, a NUL and the lookup paths joined
   with a NUL, and it is written only for a request that resolved -- a request that found nothing is
   not cached, and a later one asking for the same thing is answered from the cache without asking
   again. An absolute request is looked for in [''] alone whatever it was asked for in, which is why
   the entry's own key is its path with a NUL and nothing after it. Node validates the request here,
   so a caller handing it a number sees ERR_INVALID_ARG_TYPE naming "path" -- the argument its own
   path.isAbsolute refuses -- rather than the false a request that is merely unresolvable gets. */
function findPathCached(request, paths) {
  if (typeof request !== 'string') {
    var badPath = new TypeError('The "path" argument must be of type string. Received '
      + receivedTypeOf(request));
    badPath.code = 'ERR_INVALID_ARG_TYPE';
    throw badPath;
  }
  var list = paths;
  if (request.charAt(0) === '/') list = [''];
  else if (!list || list.length === 0) return false;
  var cacheKey = request + PATH_CACHE_SEP + list.join(PATH_CACHE_SEP);
  var cached = Module._pathCache[cacheKey];
  if (cached) return cached;
  for (var findAt = 0; findAt < list.length; findAt++) {
    var found = host.resolve(request, list[findAt] === '' ? '/' : list[findAt], 'require');
    if (found) {
      Module._pathCache[cacheKey] = found;
      return found;
    }
  }
  return false;
}

/* Module._resolveFilename: node answers a built-in with the request it was given -- 'node:fs' for
   'node:fs', not the bare name the prefix was stripped to -- and reads that request as a string
   before it does anything else, because its own BuiltinModule.normalizeRequirableId asks
   String.prototype.startsWith about it. That read is what refuses a null, an undefined and a
   symbol, with node's own two messages and no code on either; every other shape reaches the
   resolver, which is the one that names "path" and carries ERR_INVALID_ARG_TYPE. */
Module._resolveFilename = function _resolveFilename(request, parent, isMain, options) {
  if (request === null || request === undefined) {
    throw new TypeError('String.prototype.startsWith called on null or undefined');
  }
  if (typeof request === 'symbol') {
    throw new TypeError('Cannot convert a Symbol value to a string');
  }
  if (isBuiltinName(request)) return String(request);
  var paths = Module._resolveLookupPaths(request, parent);
  var filename = findPathCached(request, paths);
  if (filename) return filename;
  throw notFoundError(String(request), parent && parent.path ? parent.path : host.cwd(), parent);
};

/* Module.prototype.require: node's own is anonymous -- String() of it reads 'function(id)' and not
   a name -- and carries the entry's module as an own 'main' after 'prototype'. Node's is a value,
   written once the entry has been loaded; this one is read off the loader's main until it is asked
   for, and becomes the value it read from on that first read, so that what a caller sees is the
   same writable, enumerable, configurable data property a host has. */
Module.prototype.require = function (request) {
  return requireFrom(this, request);
};
Object.defineProperty(Module.prototype.require, 'main', {
  get: function getMainOfRequire() {
    var mainOfEntry = mainModule;
    if (mainOfEntry !== undefined) {
      Object.defineProperty(this, 'main',
        { value: mainOfEntry, writable: true, enumerable: true, configurable: true });
    }
    return mainOfEntry;
  },
  set: function setMainOfRequire(value) {
    mainModule = value;
    Object.defineProperty(this, 'main',
      { value: value, writable: true, enumerable: true, configurable: true });
  },
  enumerable: true,
  configurable: true
});

/* The require every CommonJS module is handed: the loader's own builds a resolve.paths whose
   refusal of a request that is not a string names only the typeof it was given and carries no
   code, where node's names the value the way every other argument error of its does and sets
   ERR_INVALID_ARG_TYPE. Only that one key is replaced -- the rest of the require is the loader's,
   and a request that is a string is answered by the same lookup paths it always was. */
var makeRequireOfLoader = makeRequire;
makeRequire = function makeRequire(mod) {
  var req = makeRequireOfLoader(mod);
  /* The main module is known by the time any module's body runs -- the loader names it before it
     compiles the entry -- so the value node writes once is written here, and a descriptor a caller
     reads off Module.prototype.require is the data property it is there rather than the accessor
     that waited for the entry. */
  if (mainModule !== undefined) {
    var mainOfPrototype = Object.getOwnPropertyDescriptor(Module.prototype.require, 'main');
    if (mainOfPrototype !== undefined && mainOfPrototype.get !== undefined) {
      Object.defineProperty(Module.prototype.require, 'main',
        { value: mainModule, writable: true, enumerable: true, configurable: true });
    }
  }
  req.resolve.paths = function paths(request) {
    if (typeof request !== 'string') {
      var badRequest = new TypeError('The "request" argument must be of type string. Received '
        + receivedTypeOf(request));
      badRequest.code = 'ERR_INVALID_ARG_TYPE';
      throw badRequest;
    }
    return Module._resolveLookupPaths(request, mod);
  };
  return req;
};

/* A request written with the 'node:' scheme and no built-in behind it is not a missing module in
   node but an unknown one: ERR_UNKNOWN_BUILTIN_MODULE, naming the request it was given. A bare
   name it does not know stays a missing module, and the validation of the request itself comes
   first in both, which is the loader's own order. */
var requireFromOfLoader = requireFrom;
requireFrom = function requireFrom(parent, id) {
  if (typeof id === 'string' && id.indexOf('node:') === 0 && !isBuiltinName(id)) {
    var unknownBuiltin = new Error('No such built-in module: ' + id);
    unknownBuiltin.code = 'ERR_UNKNOWN_BUILTIN_MODULE';
    throw unknownBuiltin;
  }
  return requireFromOfLoader(parent, id);
};

/* The entry's own key in that cache. Node runs the entry through Module._load -- Module.runMain
   asks for argv[1] and the resolver answers -- so the file it found is cached under the request
   and the paths it was looked for in before a line of the program has run: [''] for a request
   that is absolute, [''] or the global folders for one that is not. The loader here is handed the
   file itself, so the key is written from argv[1] and the same paths, with the file as its value. */
var loadCJSOfLoader = loadCJS;
loadCJS = function loadCJS(filename, parent, isMain) {
  if (isMain) {
    var procOfEntry = requireBuiltin('process');
    var request = procOfEntry && typeof procOfEntry.argv[1] === 'string' ? procOfEntry.argv[1] : filename;
    var entryPaths;
    if (request.charAt(0) === '/') entryPaths = [''];
    else if (request.charAt(0) === '.' && (request.length === 1 || request.charAt(1) === '.'
      || request.charAt(1) === '/')) entryPaths = ['.'];
    else entryPaths = Module.globalPaths;
    Module._pathCache[request + PATH_CACHE_SEP + entryPaths.join(PATH_CACHE_SEP)] = filename;
  }
  return loadCJSOfLoader(filename, parent, isMain);
};

/* Which names the registry answers a require for. Node's list is the authority for both
   directions: a factory registered for a name node has no built-in for -- undici, served here as
   though it were built in -- is not a built-in name, so require('undici') and require('node:undici')
   find nothing as they do there, while the factory itself stays where a fetch can reach it; and the
   four names the list writes with their 'node:' prefix are requirable with it and not without, so
   require('node:sea') answers and require('sea') does not. The two prefixes this container's own
   internals are registered under are the one exception, being no name node's list was ever asked
   about. */
var SCHEME_ONLY_NAMES = Object.create(null);
for (var schemeAt = 0; schemeAt < NODE_BUILTIN_NAMES.length; schemeAt++) {
  if (NODE_BUILTIN_NAMES[schemeAt].indexOf('node:') === 0) {
    SCHEME_ONLY_NAMES[NODE_BUILTIN_NAMES[schemeAt].slice(5)] = true;
  }
}
function isOwcInternalName(name) {
  return name.indexOf('owc:internal/') === 0 || name.indexOf('webstream/') === 0;
}
isBuiltinName = function isBuiltinName(name) {
  if (typeof name !== 'string') return false;
  var withScheme = name.indexOf('node:') === 0;
  var rest = withScheme ? name.slice(5) : name;
  /* One 'node:' and no more, as Module.isBuiltin reads it. */
  if (withScheme && rest.indexOf('node:') === 0) return false;
  if (!Object.prototype.hasOwnProperty.call(BF, rest)) return false;
  if (isOwcInternalName(rest)) return true;
  if (withScheme) {
    return Object.prototype.hasOwnProperty.call(BUILTIN_NAME_SET, name)
      || Object.prototype.hasOwnProperty.call(BUILTIN_NAME_SET, rest);
  }
  if (Object.prototype.hasOwnProperty.call(SCHEME_ONLY_NAMES, rest)) return false;
  return Object.prototype.hasOwnProperty.call(BUILTIN_NAME_SET, rest);
};


/* node:sys is util under another name: node's own sys module is a deprecation shim over it, so the
   two are the same object there and are the same object here -- requireBuiltin caches under the
   name it was asked for, and BC.sys is filled with what BC.util already holds. The name stands in
   NODE_BUILTIN_NAMES above, so isBuiltin('sys') was true while require('sys') found nothing; this
   is the factory that name was asking for. */
BF['sys'] = function () {
  return requireBuiltin('util');
};

BF.tty = function () {
  var EE = requireBuiltin('events');
  function recordOf(fd) {
    var table = globalThis.__owcPtyFds;
    return table ? table[fd] : undefined;
  }
  /*
   * A stream over a pty fd: an fd the node-pty shim (src/napi/node-pty) registered in
   * globalThis.__owcPtyFds when its fork() started a container child process. node-pty's
   * lib/unixTerminal.js builds one of these around the fd its add-on returns and reads the child's
   * output from it, and writes to it go through fs.write to the child's input.
   *
   * The container has no terminal, so this stream is not one: isTTY is false, and isatty below
   * answers false for every fd. A fd that is not one of the shim's gives an inert stream, so
   * new tty.ReadStream(0) does not fail.
   */
  function PtyReadStream(fd) {
    var self = this;
    var rec = recordOf(fd);
    EE.call(this);
    this.fd = fd;
    this.isTTY = false;
    this.readable = true;
    this.writable = false;
    this.columns = rec ? rec.cols : 80;
    this.rows = rec ? rec.rows : 24;
    this._encoding = undefined;
    this._decoder = undefined;
    this._paused = false;
    this._destroyed = false;
    if (rec) rec.socket = this;
    this._onData = function (chunk) {
      if (self._destroyed) return;
      self.emit('data', self._encoding ? chunk.toString(self._encoding) : chunk);
    };
    if (rec) rec.emitter.on('data', this._onData);
  }
  PtyReadStream.prototype = Object.create(EE.prototype);
  PtyReadStream.prototype.constructor = PtyReadStream;
  PtyReadStream.prototype.setEncoding = function (encoding) {
    this._encoding = encoding || undefined;
    this._decoder = encoding ? {} : undefined;
    return this;
  };
  PtyReadStream.prototype.pause = function () {
    this._paused = true;
    var rec = recordOf(this.fd);
    if (rec) rec.paused = true;
    return this;
  };
  PtyReadStream.prototype.resume = function () {
    this._paused = false;
    var rec = recordOf(this.fd);
    if (rec) {
      rec.paused = false;
      while (rec.queue.length > 0) rec.emitter.emit('data', rec.queue.shift());
    }
    return this;
  };
  PtyReadStream.prototype.destroy = function () {
    if (this._destroyed) return this;
    this._destroyed = true;
    this.readable = false;
    var rec = recordOf(this.fd);
    if (rec) {
      try { rec.emitter.removeListener('data', this._onData); } catch (e) {}
      if (rec.socket === this) rec.socket = null;
    }
    this.emit('close');
    return this;
  };
  PtyReadStream.prototype.end = function () { return this; };
  PtyReadStream.prototype.read = function () { return null; };
  PtyReadStream.prototype.pipe = function (dest) {
    var self = this;
    this.on('data', function (chunk) {
      try { dest.write(chunk); } catch (e) {}
    });
    return dest || self;
  };
  /* There is nothing to write to a terminal here: writes to a pty go through fs.write. */
  function PtyWriteStream(fd) {
    EE.call(this);
    this.fd = fd;
    this.isTTY = false;
    this.writable = true;
    this.columns = 80;
    this.rows = 24;
  }
  PtyWriteStream.prototype = Object.create(EE.prototype);
  PtyWriteStream.prototype.constructor = PtyWriteStream;
  PtyWriteStream.prototype.write = function () { return false; };
  PtyWriteStream.prototype.end = function () { return this; };
  return {
    isatty: function () { return false; },
    ReadStream: PtyReadStream,
    WriteStream: PtyWriteStream
  };
};

/*
 * What a decoder answers when what it was handed is not bytes. Node raises that refusal from two
 * places and they do not word it alike: the UTF-8 fast path decodes the whole input in one call
 * and names the argument 'list', and every other decode parses its input first, names it 'input'
 * and says what it received. Which of the two a UTF-8 decode takes is settled by the call and not
 * by the encoding -- a decode that is one of a stream, or one asked of a decoder still holding
 * the tail of an earlier chunk, parses, and only a whole decode with nothing held over is the
 * fast path. UTF-16 reaches the converter instead, which names the argument 'input' and lists
 * SharedArrayBuffer but never says what came, and the single-byte encodings parse whatever the
 * options say. node:stream/consumers hands every chunk to decode with { stream: true }, so a
 * stream whose chunks are not bytes meets the 'input' words and not the 'list' ones.
 */
function textDecoderReceivedType(value) {
  /* Node's own reading of a value into words: one that is neither an object nor a function names
     its type and shows itself, a function names itself, and an object names the constructor it
     was built by. */
  if (value === null) return 'null';
  if (typeof value === 'bigint') return 'type bigint (' + value + 'n)';
  if (typeof value === 'number') {
    /* Zero prints with its sign, which is the one thing a number's own string does not carry. */
    if (value === 0) return 1 / value === -Infinity ? 'type number (-0)' : 'type number (0)';
    if (value !== value) return 'type number (NaN)';
    if (value === Infinity) return 'type number (Infinity)';
    if (value === -Infinity) return 'type number (-Infinity)';
    return 'type number (' + value + ')';
  }
  if (typeof value === 'boolean') return value ? 'type boolean (true)' : 'type boolean (false)';
  if (typeof value === 'symbol') return 'type symbol (' + String(value) + ')';
  if (typeof value === 'function') return 'function ' + (typeof value.name === 'string' ? value.name : '');
  if (typeof value === 'string') {
    var shown = value.length > 28 ? value.slice(0, 25) + '...' : value;
    /* A string holding no apostrophe is quoted with one, the way Node quotes it; one that does is
       put in the other quotes Node reaches for, which are JSON's. */
    if (shown.indexOf("'") === -1) return "type string ('" + shown + "')";
    return 'type string (' + JSON.stringify(shown) + ')';
  }
  if (value.constructor && typeof value.constructor.name === 'string') return 'an instance of ' + value.constructor.name;
  /* An object no constructor made -- one whose prototype is null -- is inspected instead, which
     is the only shape Node names by its looks rather than by its maker. */
  return inspectValue(value, { depth: 0 });
}

function textDecoderInputTypeError(input, encoding, stream, carrying) {
  if (encoding === 'utf-16le' || encoding === 'utf-16be') {
    return textDecoderError(TypeError, 'ERR_INVALID_ARG_TYPE',
      'The "input" argument must be an instance of SharedArrayBuffer, ArrayBuffer or ArrayBufferView.');
  }
  if (encoding === 'utf-8' && !stream && !carrying) {
    return textDecoderError(TypeError, 'ERR_INVALID_ARG_TYPE',
      'The "list" argument must be an instance of SharedArrayBuffer, ArrayBuffer or ArrayBufferView.');
  }
  return textDecoderError(TypeError, 'ERR_INVALID_ARG_TYPE',
    'The "input" argument must be an instance of ArrayBuffer or ArrayBufferView. Received ' +
    textDecoderReceivedType(input));
}

/*
 * util-assert.ts installs TextDecoder with one refusal for an input that is not bytes -- the
 * 'list' one -- and the words belong to the call rather than to the module that makes them, so
 * the method is pointed again here, where that module has already been built. A 'this' no decoder
 * was made from, an options argument that is not one, and an input that is bytes or no input at
 * all are left to the method it had: only the refusal is answered over.
 */
var textDecoderDecodeBytes = TextDecoderImpl.prototype.decode;
TextDecoderImpl.prototype.decode = function (input, options) {
  var state = TEXT_DECODER_STATE.get(this);
  if (state === undefined || input === undefined) return textDecoderDecodeBytes.call(this, input, options);
  if (textDecoderOptionsError(options) !== undefined) return textDecoderDecodeBytes.call(this, input, options);
  if (decodeInputBytes(input) !== undefined) return textDecoderDecodeBytes.call(this, input, options);
  throw textDecoderInputTypeError(input, state.encoding,
    options !== undefined && options !== null && Boolean(options.stream), state.rest.length > 0);
};
/* The two arguments are optional in Node's own signature, so the arity a program reads off the
   method it was handed stays 0 here too -- and its name stays the name of the property it was
   pointed at, which a function written as an assignment onto a prototype does not take. */
Object.defineProperty(TextDecoderImpl.prototype.decode, 'length', { value: 0, configurable: true });
Object.defineProperty(TextDecoderImpl.prototype.decode, 'name', { value: 'decode', configurable: true });

`;
