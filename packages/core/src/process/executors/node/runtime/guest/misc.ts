/**
 * Guest-side remaining built-ins: os, timers, timers/promises, url, crypto, module,
 * tty and http (the existing in-memory network bridge). Plain JavaScript inside a
 * String.raw snippet.
 */
export const MISC_SRC = String.raw`
BF.os = function () {
  var signals = {
    SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGILL: 4, SIGTRAP: 5, SIGABRT: 6, SIGIOT: 6, SIGBUS: 7,
    SIGFPE: 8, SIGKILL: 9, SIGUSR1: 10, SIGSEGV: 11, SIGUSR2: 12, SIGPIPE: 13, SIGALRM: 14,
    SIGTERM: 15, SIGCHLD: 17, SIGSTKFLT: 16, SIGCONT: 18, SIGSTOP: 19, SIGTSTP: 20, SIGTTIN: 21,
    SIGTTOU: 22, SIGURG: 23, SIGXCPU: 24, SIGXFSZ: 25, SIGVTALRM: 26, SIGPROF: 27, SIGWINCH: 28,
    SIGIO: 29, SIGPOLL: 29, SIGPWR: 30, SIGSYS: 31
  };
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
    uptime: function () { return 0; },
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
    userInfo: function () { return { username: 'user', uid: 1000, gid: 1000, shell: '/bin/sh', homedir: '/home' }; },
    constants: { signals: signals, errno: errno }
  };
};

BF.timers = function () {
  return {
    setTimeout: setTimeoutImpl,
    clearTimeout: clearTimer,
    setInterval: setIntervalImpl,
    clearInterval: clearTimer,
    setImmediate: setImmediateImpl,
    clearImmediate: clearTimer
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

  function decodeComponent(s) {
    try {
      return decodeURIComponent(s.replace(/\+/g, ' '));
    } catch (err) {
      return s;
    }
  }

  function encodeComponent(s) {
    return encodeURIComponent(s).replace(/%20/g, '+');
  }

  /* The pairs a caller stores: an own property in this runtime's own implementation, but not one
     Node's shows -- Object.keys, JSON.stringify and for-in of a URLSearchParams are all empty. */
  function quoteString(text) {
    return "'" + String(text).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
  }

  function initList(self) {
    Object.defineProperty(self, '_list', { value: [], writable: true, configurable: true });
    return self._list;
  }

  function URLSearchParams(init) {
    initList(this);
    if (typeof init === 'string') {
      var s = init.charAt(0) === '?' ? init.slice(1) : init;
      if (s.length) {
        var pairs = s.split('&');
        for (var i = 0; i < pairs.length; i++) {
          if (!pairs[i]) continue;
          var idx = pairs[i].indexOf('=');
          var k = idx >= 0 ? pairs[i].slice(0, idx) : pairs[i];
          var v = idx >= 0 ? pairs[i].slice(idx + 1) : '';
          this._list.push([decodeComponent(k), decodeComponent(v)]);
        }
      }
    } else if (init && typeof init === 'object' && typeof init[Symbol.iterator] === 'function') {
      /* A sequence of pairs: an array of [name, value] tuples, another URLSearchParams, a Map, or
         anything else iterable. Each item has to be an iterable of exactly two values. */
      var iter = init[Symbol.iterator]();
      var step = iter.next();
      while (!step.done) {
        var item = step.value;
        var pair = [];
        if (item !== undefined && item !== null && typeof item[Symbol.iterator] === 'function') {
          var inner = item[Symbol.iterator]();
          var part = inner.next();
          while (!part.done) { pair.push(part.value); part = inner.next(); }
        }
        if (pair.length !== 2) throw new TypeError('Each query pair must be an iterable [name, value] tuple');
        this._list.push([String(pair[0]), String(pair[1])]);
        step = iter.next();
      }
    } else if (init && typeof init === 'object') {
      var keys = Object.keys(init);
      for (var j = 0; j < keys.length; j++) this._list.push([keys[j], String(init[keys[j]])]);
    }
  }
  URLSearchParams.prototype.append = function (k, v) {
    this._list.push([String(k), String(v)]);
  };
  URLSearchParams.prototype.set = function (k, v) {
    var key = String(k);
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
  URLSearchParams.prototype.keys = function () {
    return this._list.map(function (pair) { return pair[0]; })[Symbol.iterator]();
  };
  URLSearchParams.prototype.values = function () {
    return this._list.map(function (pair) { return pair[1]; })[Symbol.iterator]();
  };
  URLSearchParams.prototype.entries = function () {
    return this._list.map(function (pair) { return [pair[0], pair[1]]; })[Symbol.iterator]();
  };
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
        return 'URLSearchParams {' + (shown === '' ? '' : ' ' + shown) + ' }';
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

  function domainToASCII(domain) {
    var text = String(domain);
    if (text === '') return '';
    var labels = text.split('.');
    var out = [];
    for (var i = 0; i < labels.length; i++) {
      if (labels[i] === '') { out.push(''); continue; }
      var ascii = asciiLabelOf(labels[i]);
      if (ascii === null) return '';
      out.push(ascii);
    }
    return out.join('.');
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
    var parsed = typeof u === 'string' ? new URL(u) : (u instanceof URL ? u : new URL(String(u.href)));
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
     */
    return new URL('file://' + encodeURI(resolved).replace(/#/g, '%23').replace(/\?/g, '%3F'));
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
   * seen -- the browser behaviour Node copies, which is what makes 'a\b' the path 'a/b'.
   */
  function legacyTrimmed(text) {
    var start = -1;
    var end = -1;
    var lastPos = 0;
    var acc = '';
    var inWs = false;
    var split = false;
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
        if (code === 35 || code === 63) split = true;
        else if (code === 92) {
          if (i - lastPos > 0) acc += text.slice(lastPos, i);
          acc += '/';
          lastPos = i + 1;
        }
      }
    }
    if (start === -1) return '';
    if (lastPos === start) return end === -1 ? (start === 0 ? text : text.slice(start)) : text.slice(start, end);
    if (end === -1) return lastPos < text.length ? acc + text.slice(lastPos) : acc;
    return lastPos < end ? acc + text.slice(lastPos, end) : acc;
  }

  /*
   * legacy url.parse: Node's own parser, field for field. A Url is a set of strings, null where
   * Node leaves one null -- and href is what format writes back from those fields, so the '//' a
   * caller never wrote is not put in and an auth carrying an '@' comes out as 'a%40b'.
   */
  function parse(input, parseQuery) {
    var text = String(input);
    var rest = legacyTrimmed(text);
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
    var hasSlashes = false;
    if (proto || LEGACY_HOST_RE.test(rest)) {
      var doubled = rest.charAt(0) === '/' && rest.charAt(1) === '/';
      if (doubled && !(proto && HOSTLESS_SCHEME[lowerProto])) {
        rest = rest.slice(2);
        hasSlashes = true;
        slashes = true;
      }
    }

    var host = null;
    var hostname = null;
    var port = null;
    var auth = null;
    if (!HOSTLESS_SCHEME[lowerProto] && (hasSlashes || (proto && !SLASHED_SCHEME[proto]))) {
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
      if (!ipv6) {
        for (var j = 0; j < name.length; j++) {
          /* a ':' no host may hold ends it, and what follows it becomes the path */
          if (name.charAt(j) === ':') {
            var tail = name.slice(j) + rest;
            name = name.slice(0, j);
            rest = tail.charAt(0) === '/' ? tail : '/' + tail;
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
          name = domainToASCII(name);
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
      if (parseQuery) {
        query = {};
        new URLSearchParams(rest.slice(questionIdx + 1, hashIdx === -1 ? rest.length : hashIdx)).forEach(function (value, key) {
          if (Object.prototype.hasOwnProperty.call(query, key)) query[key] = [].concat(query[key], value);
          else query[key] = value;
        });
      }
    } else if (parseQuery) {
      query = {};
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

    var fields = {
      protocol: protocol,
      slashes: slashes,
      auth: auth,
      host: host,
      port: port,
      hostname: hostname,
      hash: hash,
      search: search,
      query: query,
      pathname: pathname,
      path: path
    };
    fields.href = formatUrl(fields);
    return fields;
  }

  function resolveUrl(from, to) {
    var absolute = SCHEME_RE.test(String(from)) || SCHEME_RE.test(String(to));
    var base = new URL(String(from), 'http://relative.invalid');
    var target = new URL(String(to), base);
    return absolute ? target.href : target.pathname + target.search + target.hash;
  }

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

  return {
    URL: URL,
    /* Node's legacy constructor, still on the module beside the WHATWG class */
    Url: URL,
    URLSearchParams: URLSearchParams,
    domainToASCII: domainToASCII,
    domainToUnicode: domainToUnicode,
    fileURLToPath: fileURLToPath,
    pathToFileURL: pathToFileURL,
    urlToHttpOptions: urlToHttpOptions,
    parse: parse,
    resolve: resolveUrl,
    format: formatUrl
  };
};

BF.crypto = function () {
  var Buf = requireBuiltin('buffer').Buffer;

  /* key bytes and CryptoKey state live here, never on the key objects, so user code sees only Node's surface */
  var KEY_STATE = new WeakMap();

  function invalidArgType(name, expected, value) {
    var err = new TypeError('The "' + name + '" argument must be ' + expected + '. Received ' + (value === null ? 'null' : typeof value));
    err.code = 'ERR_INVALID_ARG_TYPE';
    return err;
  }

  function outOfRange(name, range, value) {
    var err = new RangeError('The value of "' + name + '" is out of range. It must be ' + range + '. Received ' + value);
    err.code = 'ERR_OUT_OF_RANGE';
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

  function randomBytes(size, callback) {
    var bytes = Buf.from(decodeBase64(host.randomBase64(size)));
    if (typeof callback === 'function') {
      queueMicrotask(function () { callback(null, bytes); });
      return undefined;
    }
    return bytes;
  }

  function randomUUID() {
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
    var r = randomBytes(4).readUInt32BE(0) / 4294967296;
    return min + Math.floor(r * (max - min));
  }

  function getRandomValues(typed) {
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
    var start = offset === undefined ? 0 : offset;
    if (typeof start !== 'number' || !(start >= 0 && start <= elements) || Math.floor(start) !== start) {
      throw outOfRange('offset', '>= 0 && <= ' + elements, start);
    }
    var count = size === undefined ? elements - start : size;
    if (typeof count !== 'number' || !(count >= 0 && start + count <= elements) || Math.floor(count) !== count) {
      throw outOfRange('size', '>= 0 && <= ' + (elements - start), count);
    }
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

  /* bytes from a string (with its encoding), a Buffer, a TypedArray, a DataView or an ArrayBuffer */
  function toBytes(data, encoding, name) {
    if (typeof data === 'string') return Buf.from(data, encoding || 'utf8');
    if (data instanceof ArrayBuffer) return Buf.from(data);
    if (ArrayBuffer.isView(data)) return Buf.from(data.buffer, data.byteOffset, data.byteLength);
    var err = new TypeError('The "' + name + '" argument must be of type string or an instance of Buffer, TypedArray, or DataView.');
    err.code = 'ERR_INVALID_ARG_TYPE';
    throw err;
  }

  function outputOf(bytes, encoding) {
    return encoding === undefined || encoding === 'buffer' ? bytes : bytes.toString(encoding);
  }

  /* KeyObject: secret keys carry their bytes; asymmetric keys are not available in this runtime */
  function KeyObject(type, bytes) {
    KEY_STATE.set(this, { kind: 'key', type: type, bytes: bytes });
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
    asymmetricKeyType: { get: function () { return undefined; } }
  });

  KeyObject.prototype.export = function (options) {
    var state = keyStateOf(this, 'key');
    if (state.type !== 'secret') throw asymmetricUnavailable('KeyObject.export');
    if (options !== undefined && options !== null && options.format === 'jwk') {
      return { kty: 'oct', k: base64url(state.bytes) };
    }
    return Buf.from(state.bytes);
  };

  KeyObject.prototype.equals = function (other) {
    if (!(other instanceof KeyObject)) throw invalidArgType('otherKeyObject', 'an instance of KeyObject', other);
    var a = keyStateOf(this, 'key');
    var b = keyStateOf(other, 'key');
    if (a.type !== b.type || a.bytes.length !== b.bytes.length) return false;
    return timingSafeEqual(a.bytes, b.bytes);
  };

  function createSecretKey(key, encoding) {
    var bytes = typeof key === 'string' ? Buf.from(key, encoding) : toBytes(key, undefined, 'key');
    return new KeyObject('secret', Buf.from(bytes));
  }

  function createPublicKey() {
    throw asymmetricUnavailable('createPublicKey');
  }

  function createPrivateKey() {
    throw asymmetricUnavailable('createPrivateKey');
  }

  function keyBytesOf(key) {
    var state = keyStateOf(key, 'key');
    if (state === undefined) return toBytes(key, undefined, 'key');
    if (state.type !== 'secret') throw asymmetricUnavailable('createHmac');
    return state.bytes;
  }

  /* createHash and createHmac: the bytes are collected here and digested by the host in one call */
  function Hash(algorithm, key) {
    this._algorithm = String(algorithm);
    this._key = key;
    this._chunks = [];
    this._finished = false;
  }
  Hash.prototype.update = function (data, encoding) {
    if (this._finished) {
      var sealed = new Error('Digest already called');
      sealed.code = 'ERR_CRYPTO_HASH_FINALIZED';
      throw sealed;
    }
    this._chunks.push(toBytes(data, encoding, 'data'));
    return this;
  };
  Hash.prototype.digest = function (encoding) {
    if (this._finished) {
      var again = new Error('Digest already called');
      again.code = 'ERR_CRYPTO_HASH_FINALIZED';
      throw again;
    }
    this._finished = true;
    var data = Buf.concat(this._chunks).toString('base64');
    var out = this._key === undefined
      ? callCap('crypto.digest', { algorithm: this._algorithm, data: data })
      : callCap('crypto.hmac', { algorithm: this._algorithm, key: this._key.toString('base64'), data: data });
    return outputOf(Buf.from(out, 'base64'), encoding);
  };
  Hash.prototype.copy = function () {
    var copy = new Hash(this._algorithm, this._key);
    copy._chunks = this._chunks.slice();
    return copy;
  };

  function createHash(algorithm) {
    return new Hash(algorithm, undefined);
  }

  function createHmac(algorithm, key) {
    return new Hash(algorithm, keyBytesOf(key));
  }

  function hash(algorithm, data, outputEncoding) {
    return createHash(algorithm).update(data).digest(outputEncoding === undefined ? 'hex' : outputEncoding);
  }

  function pbkdf2Sync(password, salt, iterations, keylen, digest) {
    var out = callCap('crypto.pbkdf2', {
      digest: digest === undefined ? 'sha1' : String(digest),
      password: toBytes(password, undefined, 'password').toString('base64'),
      salt: toBytes(salt, undefined, 'salt').toString('base64'),
      iterations: Number(iterations),
      keylen: Number(keylen)
    });
    return Buf.from(out, 'base64');
  }

  function pbkdf2(password, salt, iterations, keylen, digest, callback) {
    var key = pbkdf2Sync(password, salt, iterations, keylen, digest);
    queueMicrotask(function () { callback(null, key); });
  }

  function timingSafeEqual(a, b) {
    var left = toBytes(a, undefined, 'buf1');
    var right = toBytes(b, undefined, 'buf2');
    if (left.length !== right.length) {
      var length = new RangeError('Input buffers must have the same byte length');
      length.code = 'ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH';
      throw length;
    }
    var diff = 0;
    for (var i = 0; i < left.length; i++) diff |= left[i] ^ right[i];
    return diff === 0;
  }

  function getHashes() {
    return ['md5', 'sha1', 'sha224', 'sha256', 'sha384', 'sha512'];
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
    return callOp('crypto.hmac', {
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
        return callOp('crypto.digest', { algorithm: alg.digest, data: bytes.toString('base64') }).then(function (b64) {
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
    try {
      return callCap(op, args);
    } catch (err) {
      var Ctor = err && err.owcErrorClass === 'RangeError' ? RangeError : err && err.owcErrorClass === 'TypeError' ? TypeError : Error;
      var again = new Ctor(err && err.message !== undefined ? err.message : String(err));
      if (err && err.code !== undefined && !err.owcUncoded) again.code = err.code;
      if (err && err.errno !== undefined) again.errno = err.errno;
      throw again;
    }
  }

  function cipherStateError(message) {
    var err = new Error(message);
    err.code = 'ERR_CRYPTO_INVALID_STATE';
    return err;
  }

  function cipherBytes(data, encoding, name) {
    return typeof data === 'string' ? Buf.from(data, encoding || 'utf8') : toBytes(data, undefined, name);
  }

  function cipherKeyBytes(key) {
    var state = keyStateOf(key, 'key');
    if (state !== undefined) {
      if (state.type !== 'secret') throw asymmetricUnavailable('createCipheriv');
      return state.bytes;
    }
    return cipherBytes(key, undefined, 'key');
  }

  function Cipher(algorithm, direction, id, aead) {
    this._algorithm = algorithm;
    this._direction = direction;
    this._id = id;
    this._aead = aead;
    this._finalized = false;
    this._tag = undefined;
  }

  Cipher.prototype.update = function (data, inputEncoding, outputEncoding) {
    if (this._finalized) throw new Error('Trying to add data in unsupported state');
    var bytes = cipherBytes(data, inputEncoding, 'data');
    var out = Buf.from(cipherCap('crypto.cipher.update', { id: this._id, data: bytes.toString('base64') }), 'base64');
    return typeof outputEncoding === 'string' ? out.toString(outputEncoding) : out;
  };

  Cipher.prototype.final = function (outputEncoding) {
    if (this._finalized) throw cipherStateError('Invalid state');
    this._finalized = true;
    var result = cipherCap('crypto.cipher.final', { id: this._id });
    if (result.tag !== undefined) this._tag = Buf.from(result.tag, 'base64');
    var out = Buf.from(result.data, 'base64');
    return typeof outputEncoding === 'string' ? out.toString(outputEncoding) : out;
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
      var opened = cipherCap('crypto.cipher.open', {
        algorithm: String(algorithm),
        direction: direction,
        key: cipherKeyBytes(key).toString('base64'),
        iv: iv === null || iv === undefined ? null : cipherBytes(iv, undefined, 'iv').toString('base64')
      });
      var cipher = new Cipher(String(algorithm), direction, opened.id, opened.aead === true);
      if (direction === 'decrypt') cipher.setAuthTag = decipherSetAuthTag;
      else cipher.getAuthTag = cipherGetAuthTag;
      return cipher;
    };
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
    timingSafeEqual: timingSafeEqual,
    getHashes: getHashes,
    KeyObject: KeyObject,
    createSecretKey: createSecretKey,
    createPublicKey: createPublicKey,
    createPrivateKey: createPrivateKey,
    subtle: subtle,
    webcrypto: webcrypto,
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
      RSA_PSS_SALTLEN_AUTO: -2
    },
    getCiphers: function () { return callCap('crypto.ciphers'); },
    sign: function sign(algorithm, data, key, callback) { throw featureUnavailable('sign'); },
    verify: function verify(algorithm, data, key, signature, callback) { throw featureUnavailable('verify'); },
    createCipheriv: createCipher('encrypt'),
    createDecipheriv: createCipher('decrypt'),
    diffieHellman: unavailable('diffieHellman'),
    generateKeyPair: unavailable('generateKeyPair'),
    privateDecrypt: unavailable('privateDecrypt'),
    publicEncrypt: unavailable('publicEncrypt')
  };
};

/* require('module') is the Module class the loader builds modules with, carrying Node's statics;
   builtinModules is filled in here, where every builtin factory has registered itself. */
BF.module = function () {
  Module.builtinModules = Object.keys(BF).filter(function (n) { return n.indexOf('/') < 0; }).sort();
  return Module;
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

`;
