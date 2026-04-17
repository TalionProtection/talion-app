"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// node_modules/.pnpm/ws@8.20.0/node_modules/ws/lib/constants.js
var require_constants = __commonJS({
  "node_modules/.pnpm/ws@8.20.0/node_modules/ws/lib/constants.js"(exports2, module2) {
    "use strict";
    var BINARY_TYPES = ["nodebuffer", "arraybuffer", "fragments"];
    var hasBlob = typeof Blob !== "undefined";
    if (hasBlob) BINARY_TYPES.push("blob");
    module2.exports = {
      BINARY_TYPES,
      CLOSE_TIMEOUT: 3e4,
      EMPTY_BUFFER: Buffer.alloc(0),
      GUID: "258EAFA5-E914-47DA-95CA-C5AB0DC85B11",
      hasBlob,
      kForOnEventAttribute: /* @__PURE__ */ Symbol("kIsForOnEventAttribute"),
      kListener: /* @__PURE__ */ Symbol("kListener"),
      kStatusCode: /* @__PURE__ */ Symbol("status-code"),
      kWebSocket: /* @__PURE__ */ Symbol("websocket"),
      NOOP: () => {
      }
    };
  }
});

// node_modules/.pnpm/ws@8.20.0/node_modules/ws/lib/buffer-util.js
var require_buffer_util = __commonJS({
  "node_modules/.pnpm/ws@8.20.0/node_modules/ws/lib/buffer-util.js"(exports2, module2) {
    "use strict";
    var { EMPTY_BUFFER } = require_constants();
    var FastBuffer = Buffer[Symbol.species];
    function concat(list, totalLength) {
      if (list.length === 0) return EMPTY_BUFFER;
      if (list.length === 1) return list[0];
      const target = Buffer.allocUnsafe(totalLength);
      let offset = 0;
      for (let i = 0; i < list.length; i++) {
        const buf = list[i];
        target.set(buf, offset);
        offset += buf.length;
      }
      if (offset < totalLength) {
        return new FastBuffer(target.buffer, target.byteOffset, offset);
      }
      return target;
    }
    function _mask(source, mask, output, offset, length) {
      for (let i = 0; i < length; i++) {
        output[offset + i] = source[i] ^ mask[i & 3];
      }
    }
    function _unmask(buffer, mask) {
      for (let i = 0; i < buffer.length; i++) {
        buffer[i] ^= mask[i & 3];
      }
    }
    function toArrayBuffer(buf) {
      if (buf.length === buf.buffer.byteLength) {
        return buf.buffer;
      }
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length);
    }
    function toBuffer(data) {
      toBuffer.readOnly = true;
      if (Buffer.isBuffer(data)) return data;
      let buf;
      if (data instanceof ArrayBuffer) {
        buf = new FastBuffer(data);
      } else if (ArrayBuffer.isView(data)) {
        buf = new FastBuffer(data.buffer, data.byteOffset, data.byteLength);
      } else {
        buf = Buffer.from(data);
        toBuffer.readOnly = false;
      }
      return buf;
    }
    module2.exports = {
      concat,
      mask: _mask,
      toArrayBuffer,
      toBuffer,
      unmask: _unmask
    };
    if (!process.env.WS_NO_BUFFER_UTIL) {
      try {
        const bufferUtil = require("bufferutil");
        module2.exports.mask = function(source, mask, output, offset, length) {
          if (length < 48) _mask(source, mask, output, offset, length);
          else bufferUtil.mask(source, mask, output, offset, length);
        };
        module2.exports.unmask = function(buffer, mask) {
          if (buffer.length < 32) _unmask(buffer, mask);
          else bufferUtil.unmask(buffer, mask);
        };
      } catch (e) {
      }
    }
  }
});

// node_modules/.pnpm/ws@8.20.0/node_modules/ws/lib/limiter.js
var require_limiter = __commonJS({
  "node_modules/.pnpm/ws@8.20.0/node_modules/ws/lib/limiter.js"(exports2, module2) {
    "use strict";
    var kDone = /* @__PURE__ */ Symbol("kDone");
    var kRun = /* @__PURE__ */ Symbol("kRun");
    var Limiter = class {
      /**
       * Creates a new `Limiter`.
       *
       * @param {Number} [concurrency=Infinity] The maximum number of jobs allowed
       *     to run concurrently
       */
      constructor(concurrency) {
        this[kDone] = () => {
          this.pending--;
          this[kRun]();
        };
        this.concurrency = concurrency || Infinity;
        this.jobs = [];
        this.pending = 0;
      }
      /**
       * Adds a job to the queue.
       *
       * @param {Function} job The job to run
       * @public
       */
      add(job) {
        this.jobs.push(job);
        this[kRun]();
      }
      /**
       * Removes a job from the queue and runs it if possible.
       *
       * @private
       */
      [kRun]() {
        if (this.pending === this.concurrency) return;
        if (this.jobs.length) {
          const job = this.jobs.shift();
          this.pending++;
          job(this[kDone]);
        }
      }
    };
    module2.exports = Limiter;
  }
});

// node_modules/.pnpm/ws@8.20.0/node_modules/ws/lib/permessage-deflate.js
var require_permessage_deflate = __commonJS({
  "node_modules/.pnpm/ws@8.20.0/node_modules/ws/lib/permessage-deflate.js"(exports2, module2) {
    "use strict";
    var zlib = require("zlib");
    var bufferUtil = require_buffer_util();
    var Limiter = require_limiter();
    var { kStatusCode } = require_constants();
    var FastBuffer = Buffer[Symbol.species];
    var TRAILER = Buffer.from([0, 0, 255, 255]);
    var kPerMessageDeflate = /* @__PURE__ */ Symbol("permessage-deflate");
    var kTotalLength = /* @__PURE__ */ Symbol("total-length");
    var kCallback = /* @__PURE__ */ Symbol("callback");
    var kBuffers = /* @__PURE__ */ Symbol("buffers");
    var kError = /* @__PURE__ */ Symbol("error");
    var zlibLimiter;
    var PerMessageDeflate2 = class {
      /**
       * Creates a PerMessageDeflate instance.
       *
       * @param {Object} [options] Configuration options
       * @param {(Boolean|Number)} [options.clientMaxWindowBits] Advertise support
       *     for, or request, a custom client window size
       * @param {Boolean} [options.clientNoContextTakeover=false] Advertise/
       *     acknowledge disabling of client context takeover
       * @param {Number} [options.concurrencyLimit=10] The number of concurrent
       *     calls to zlib
       * @param {Boolean} [options.isServer=false] Create the instance in either
       *     server or client mode
       * @param {Number} [options.maxPayload=0] The maximum allowed message length
       * @param {(Boolean|Number)} [options.serverMaxWindowBits] Request/confirm the
       *     use of a custom server window size
       * @param {Boolean} [options.serverNoContextTakeover=false] Request/accept
       *     disabling of server context takeover
       * @param {Number} [options.threshold=1024] Size (in bytes) below which
       *     messages should not be compressed if context takeover is disabled
       * @param {Object} [options.zlibDeflateOptions] Options to pass to zlib on
       *     deflate
       * @param {Object} [options.zlibInflateOptions] Options to pass to zlib on
       *     inflate
       */
      constructor(options) {
        this._options = options || {};
        this._threshold = this._options.threshold !== void 0 ? this._options.threshold : 1024;
        this._maxPayload = this._options.maxPayload | 0;
        this._isServer = !!this._options.isServer;
        this._deflate = null;
        this._inflate = null;
        this.params = null;
        if (!zlibLimiter) {
          const concurrency = this._options.concurrencyLimit !== void 0 ? this._options.concurrencyLimit : 10;
          zlibLimiter = new Limiter(concurrency);
        }
      }
      /**
       * @type {String}
       */
      static get extensionName() {
        return "permessage-deflate";
      }
      /**
       * Create an extension negotiation offer.
       *
       * @return {Object} Extension parameters
       * @public
       */
      offer() {
        const params = {};
        if (this._options.serverNoContextTakeover) {
          params.server_no_context_takeover = true;
        }
        if (this._options.clientNoContextTakeover) {
          params.client_no_context_takeover = true;
        }
        if (this._options.serverMaxWindowBits) {
          params.server_max_window_bits = this._options.serverMaxWindowBits;
        }
        if (this._options.clientMaxWindowBits) {
          params.client_max_window_bits = this._options.clientMaxWindowBits;
        } else if (this._options.clientMaxWindowBits == null) {
          params.client_max_window_bits = true;
        }
        return params;
      }
      /**
       * Accept an extension negotiation offer/response.
       *
       * @param {Array} configurations The extension negotiation offers/reponse
       * @return {Object} Accepted configuration
       * @public
       */
      accept(configurations) {
        configurations = this.normalizeParams(configurations);
        this.params = this._isServer ? this.acceptAsServer(configurations) : this.acceptAsClient(configurations);
        return this.params;
      }
      /**
       * Releases all resources used by the extension.
       *
       * @public
       */
      cleanup() {
        if (this._inflate) {
          this._inflate.close();
          this._inflate = null;
        }
        if (this._deflate) {
          const callback = this._deflate[kCallback];
          this._deflate.close();
          this._deflate = null;
          if (callback) {
            callback(
              new Error(
                "The deflate stream was closed while data was being processed"
              )
            );
          }
        }
      }
      /**
       *  Accept an extension negotiation offer.
       *
       * @param {Array} offers The extension negotiation offers
       * @return {Object} Accepted configuration
       * @private
       */
      acceptAsServer(offers) {
        const opts = this._options;
        const accepted = offers.find((params) => {
          if (opts.serverNoContextTakeover === false && params.server_no_context_takeover || params.server_max_window_bits && (opts.serverMaxWindowBits === false || typeof opts.serverMaxWindowBits === "number" && opts.serverMaxWindowBits > params.server_max_window_bits) || typeof opts.clientMaxWindowBits === "number" && !params.client_max_window_bits) {
            return false;
          }
          return true;
        });
        if (!accepted) {
          throw new Error("None of the extension offers can be accepted");
        }
        if (opts.serverNoContextTakeover) {
          accepted.server_no_context_takeover = true;
        }
        if (opts.clientNoContextTakeover) {
          accepted.client_no_context_takeover = true;
        }
        if (typeof opts.serverMaxWindowBits === "number") {
          accepted.server_max_window_bits = opts.serverMaxWindowBits;
        }
        if (typeof opts.clientMaxWindowBits === "number") {
          accepted.client_max_window_bits = opts.clientMaxWindowBits;
        } else if (accepted.client_max_window_bits === true || opts.clientMaxWindowBits === false) {
          delete accepted.client_max_window_bits;
        }
        return accepted;
      }
      /**
       * Accept the extension negotiation response.
       *
       * @param {Array} response The extension negotiation response
       * @return {Object} Accepted configuration
       * @private
       */
      acceptAsClient(response) {
        const params = response[0];
        if (this._options.clientNoContextTakeover === false && params.client_no_context_takeover) {
          throw new Error('Unexpected parameter "client_no_context_takeover"');
        }
        if (!params.client_max_window_bits) {
          if (typeof this._options.clientMaxWindowBits === "number") {
            params.client_max_window_bits = this._options.clientMaxWindowBits;
          }
        } else if (this._options.clientMaxWindowBits === false || typeof this._options.clientMaxWindowBits === "number" && params.client_max_window_bits > this._options.clientMaxWindowBits) {
          throw new Error(
            'Unexpected or invalid parameter "client_max_window_bits"'
          );
        }
        return params;
      }
      /**
       * Normalize parameters.
       *
       * @param {Array} configurations The extension negotiation offers/reponse
       * @return {Array} The offers/response with normalized parameters
       * @private
       */
      normalizeParams(configurations) {
        configurations.forEach((params) => {
          Object.keys(params).forEach((key) => {
            let value = params[key];
            if (value.length > 1) {
              throw new Error(`Parameter "${key}" must have only a single value`);
            }
            value = value[0];
            if (key === "client_max_window_bits") {
              if (value !== true) {
                const num = +value;
                if (!Number.isInteger(num) || num < 8 || num > 15) {
                  throw new TypeError(
                    `Invalid value for parameter "${key}": ${value}`
                  );
                }
                value = num;
              } else if (!this._isServer) {
                throw new TypeError(
                  `Invalid value for parameter "${key}": ${value}`
                );
              }
            } else if (key === "server_max_window_bits") {
              const num = +value;
              if (!Number.isInteger(num) || num < 8 || num > 15) {
                throw new TypeError(
                  `Invalid value for parameter "${key}": ${value}`
                );
              }
              value = num;
            } else if (key === "client_no_context_takeover" || key === "server_no_context_takeover") {
              if (value !== true) {
                throw new TypeError(
                  `Invalid value for parameter "${key}": ${value}`
                );
              }
            } else {
              throw new Error(`Unknown parameter "${key}"`);
            }
            params[key] = value;
          });
        });
        return configurations;
      }
      /**
       * Decompress data. Concurrency limited.
       *
       * @param {Buffer} data Compressed data
       * @param {Boolean} fin Specifies whether or not this is the last fragment
       * @param {Function} callback Callback
       * @public
       */
      decompress(data, fin, callback) {
        zlibLimiter.add((done) => {
          this._decompress(data, fin, (err, result) => {
            done();
            callback(err, result);
          });
        });
      }
      /**
       * Compress data. Concurrency limited.
       *
       * @param {(Buffer|String)} data Data to compress
       * @param {Boolean} fin Specifies whether or not this is the last fragment
       * @param {Function} callback Callback
       * @public
       */
      compress(data, fin, callback) {
        zlibLimiter.add((done) => {
          this._compress(data, fin, (err, result) => {
            done();
            callback(err, result);
          });
        });
      }
      /**
       * Decompress data.
       *
       * @param {Buffer} data Compressed data
       * @param {Boolean} fin Specifies whether or not this is the last fragment
       * @param {Function} callback Callback
       * @private
       */
      _decompress(data, fin, callback) {
        const endpoint = this._isServer ? "client" : "server";
        if (!this._inflate) {
          const key = `${endpoint}_max_window_bits`;
          const windowBits = typeof this.params[key] !== "number" ? zlib.Z_DEFAULT_WINDOWBITS : this.params[key];
          this._inflate = zlib.createInflateRaw({
            ...this._options.zlibInflateOptions,
            windowBits
          });
          this._inflate[kPerMessageDeflate] = this;
          this._inflate[kTotalLength] = 0;
          this._inflate[kBuffers] = [];
          this._inflate.on("error", inflateOnError);
          this._inflate.on("data", inflateOnData);
        }
        this._inflate[kCallback] = callback;
        this._inflate.write(data);
        if (fin) this._inflate.write(TRAILER);
        this._inflate.flush(() => {
          const err = this._inflate[kError];
          if (err) {
            this._inflate.close();
            this._inflate = null;
            callback(err);
            return;
          }
          const data2 = bufferUtil.concat(
            this._inflate[kBuffers],
            this._inflate[kTotalLength]
          );
          if (this._inflate._readableState.endEmitted) {
            this._inflate.close();
            this._inflate = null;
          } else {
            this._inflate[kTotalLength] = 0;
            this._inflate[kBuffers] = [];
            if (fin && this.params[`${endpoint}_no_context_takeover`]) {
              this._inflate.reset();
            }
          }
          callback(null, data2);
        });
      }
      /**
       * Compress data.
       *
       * @param {(Buffer|String)} data Data to compress
       * @param {Boolean} fin Specifies whether or not this is the last fragment
       * @param {Function} callback Callback
       * @private
       */
      _compress(data, fin, callback) {
        const endpoint = this._isServer ? "server" : "client";
        if (!this._deflate) {
          const key = `${endpoint}_max_window_bits`;
          const windowBits = typeof this.params[key] !== "number" ? zlib.Z_DEFAULT_WINDOWBITS : this.params[key];
          this._deflate = zlib.createDeflateRaw({
            ...this._options.zlibDeflateOptions,
            windowBits
          });
          this._deflate[kTotalLength] = 0;
          this._deflate[kBuffers] = [];
          this._deflate.on("data", deflateOnData);
        }
        this._deflate[kCallback] = callback;
        this._deflate.write(data);
        this._deflate.flush(zlib.Z_SYNC_FLUSH, () => {
          if (!this._deflate) {
            return;
          }
          let data2 = bufferUtil.concat(
            this._deflate[kBuffers],
            this._deflate[kTotalLength]
          );
          if (fin) {
            data2 = new FastBuffer(data2.buffer, data2.byteOffset, data2.length - 4);
          }
          this._deflate[kCallback] = null;
          this._deflate[kTotalLength] = 0;
          this._deflate[kBuffers] = [];
          if (fin && this.params[`${endpoint}_no_context_takeover`]) {
            this._deflate.reset();
          }
          callback(null, data2);
        });
      }
    };
    module2.exports = PerMessageDeflate2;
    function deflateOnData(chunk) {
      this[kBuffers].push(chunk);
      this[kTotalLength] += chunk.length;
    }
    function inflateOnData(chunk) {
      this[kTotalLength] += chunk.length;
      if (this[kPerMessageDeflate]._maxPayload < 1 || this[kTotalLength] <= this[kPerMessageDeflate]._maxPayload) {
        this[kBuffers].push(chunk);
        return;
      }
      this[kError] = new RangeError("Max payload size exceeded");
      this[kError].code = "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH";
      this[kError][kStatusCode] = 1009;
      this.removeListener("data", inflateOnData);
      this.reset();
    }
    function inflateOnError(err) {
      this[kPerMessageDeflate]._inflate = null;
      if (this[kError]) {
        this[kCallback](this[kError]);
        return;
      }
      err[kStatusCode] = 1007;
      this[kCallback](err);
    }
  }
});

// node_modules/.pnpm/ws@8.20.0/node_modules/ws/lib/validation.js
var require_validation = __commonJS({
  "node_modules/.pnpm/ws@8.20.0/node_modules/ws/lib/validation.js"(exports2, module2) {
    "use strict";
    var { isUtf8 } = require("buffer");
    var { hasBlob } = require_constants();
    var tokenChars = [
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      // 0 - 15
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      // 16 - 31
      0,
      1,
      0,
      1,
      1,
      1,
      1,
      1,
      0,
      0,
      1,
      1,
      0,
      1,
      1,
      0,
      // 32 - 47
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      0,
      0,
      0,
      0,
      0,
      0,
      // 48 - 63
      0,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      // 64 - 79
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      0,
      0,
      0,
      1,
      1,
      // 80 - 95
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      // 96 - 111
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      0,
      1,
      0,
      1,
      0
      // 112 - 127
    ];
    function isValidStatusCode(code) {
      return code >= 1e3 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006 || code >= 3e3 && code <= 4999;
    }
    function _isValidUTF8(buf) {
      const len = buf.length;
      let i = 0;
      while (i < len) {
        if ((buf[i] & 128) === 0) {
          i++;
        } else if ((buf[i] & 224) === 192) {
          if (i + 1 === len || (buf[i + 1] & 192) !== 128 || (buf[i] & 254) === 192) {
            return false;
          }
          i += 2;
        } else if ((buf[i] & 240) === 224) {
          if (i + 2 >= len || (buf[i + 1] & 192) !== 128 || (buf[i + 2] & 192) !== 128 || buf[i] === 224 && (buf[i + 1] & 224) === 128 || // Overlong
          buf[i] === 237 && (buf[i + 1] & 224) === 160) {
            return false;
          }
          i += 3;
        } else if ((buf[i] & 248) === 240) {
          if (i + 3 >= len || (buf[i + 1] & 192) !== 128 || (buf[i + 2] & 192) !== 128 || (buf[i + 3] & 192) !== 128 || buf[i] === 240 && (buf[i + 1] & 240) === 128 || // Overlong
          buf[i] === 244 && buf[i + 1] > 143 || buf[i] > 244) {
            return false;
          }
          i += 4;
        } else {
          return false;
        }
      }
      return true;
    }
    function isBlob(value) {
      return hasBlob && typeof value === "object" && typeof value.arrayBuffer === "function" && typeof value.type === "string" && typeof value.stream === "function" && (value[Symbol.toStringTag] === "Blob" || value[Symbol.toStringTag] === "File");
    }
    module2.exports = {
      isBlob,
      isValidStatusCode,
      isValidUTF8: _isValidUTF8,
      tokenChars
    };
    if (isUtf8) {
      module2.exports.isValidUTF8 = function(buf) {
        return buf.length < 24 ? _isValidUTF8(buf) : isUtf8(buf);
      };
    } else if (!process.env.WS_NO_UTF_8_VALIDATE) {
      try {
        const isValidUTF8 = require("utf-8-validate");
        module2.exports.isValidUTF8 = function(buf) {
          return buf.length < 32 ? _isValidUTF8(buf) : isValidUTF8(buf);
        };
      } catch (e) {
      }
    }
  }
});

// node_modules/.pnpm/ws@8.20.0/node_modules/ws/lib/receiver.js
var require_receiver = __commonJS({
  "node_modules/.pnpm/ws@8.20.0/node_modules/ws/lib/receiver.js"(exports2, module2) {
    "use strict";
    var { Writable } = require("stream");
    var PerMessageDeflate2 = require_permessage_deflate();
    var {
      BINARY_TYPES,
      EMPTY_BUFFER,
      kStatusCode,
      kWebSocket
    } = require_constants();
    var { concat, toArrayBuffer, unmask } = require_buffer_util();
    var { isValidStatusCode, isValidUTF8 } = require_validation();
    var FastBuffer = Buffer[Symbol.species];
    var GET_INFO = 0;
    var GET_PAYLOAD_LENGTH_16 = 1;
    var GET_PAYLOAD_LENGTH_64 = 2;
    var GET_MASK = 3;
    var GET_DATA = 4;
    var INFLATING = 5;
    var DEFER_EVENT = 6;
    var Receiver2 = class extends Writable {
      /**
       * Creates a Receiver instance.
       *
       * @param {Object} [options] Options object
       * @param {Boolean} [options.allowSynchronousEvents=true] Specifies whether
       *     any of the `'message'`, `'ping'`, and `'pong'` events can be emitted
       *     multiple times in the same tick
       * @param {String} [options.binaryType=nodebuffer] The type for binary data
       * @param {Object} [options.extensions] An object containing the negotiated
       *     extensions
       * @param {Boolean} [options.isServer=false] Specifies whether to operate in
       *     client or server mode
       * @param {Number} [options.maxPayload=0] The maximum allowed message length
       * @param {Boolean} [options.skipUTF8Validation=false] Specifies whether or
       *     not to skip UTF-8 validation for text and close messages
       */
      constructor(options = {}) {
        super();
        this._allowSynchronousEvents = options.allowSynchronousEvents !== void 0 ? options.allowSynchronousEvents : true;
        this._binaryType = options.binaryType || BINARY_TYPES[0];
        this._extensions = options.extensions || {};
        this._isServer = !!options.isServer;
        this._maxPayload = options.maxPayload | 0;
        this._skipUTF8Validation = !!options.skipUTF8Validation;
        this[kWebSocket] = void 0;
        this._bufferedBytes = 0;
        this._buffers = [];
        this._compressed = false;
        this._payloadLength = 0;
        this._mask = void 0;
        this._fragmented = 0;
        this._masked = false;
        this._fin = false;
        this._opcode = 0;
        this._totalPayloadLength = 0;
        this._messageLength = 0;
        this._fragments = [];
        this._errored = false;
        this._loop = false;
        this._state = GET_INFO;
      }
      /**
       * Implements `Writable.prototype._write()`.
       *
       * @param {Buffer} chunk The chunk of data to write
       * @param {String} encoding The character encoding of `chunk`
       * @param {Function} cb Callback
       * @private
       */
      _write(chunk, encoding, cb) {
        if (this._opcode === 8 && this._state == GET_INFO) return cb();
        this._bufferedBytes += chunk.length;
        this._buffers.push(chunk);
        this.startLoop(cb);
      }
      /**
       * Consumes `n` bytes from the buffered data.
       *
       * @param {Number} n The number of bytes to consume
       * @return {Buffer} The consumed bytes
       * @private
       */
      consume(n) {
        this._bufferedBytes -= n;
        if (n === this._buffers[0].length) return this._buffers.shift();
        if (n < this._buffers[0].length) {
          const buf = this._buffers[0];
          this._buffers[0] = new FastBuffer(
            buf.buffer,
            buf.byteOffset + n,
            buf.length - n
          );
          return new FastBuffer(buf.buffer, buf.byteOffset, n);
        }
        const dst = Buffer.allocUnsafe(n);
        do {
          const buf = this._buffers[0];
          const offset = dst.length - n;
          if (n >= buf.length) {
            dst.set(this._buffers.shift(), offset);
          } else {
            dst.set(new Uint8Array(buf.buffer, buf.byteOffset, n), offset);
            this._buffers[0] = new FastBuffer(
              buf.buffer,
              buf.byteOffset + n,
              buf.length - n
            );
          }
          n -= buf.length;
        } while (n > 0);
        return dst;
      }
      /**
       * Starts the parsing loop.
       *
       * @param {Function} cb Callback
       * @private
       */
      startLoop(cb) {
        this._loop = true;
        do {
          switch (this._state) {
            case GET_INFO:
              this.getInfo(cb);
              break;
            case GET_PAYLOAD_LENGTH_16:
              this.getPayloadLength16(cb);
              break;
            case GET_PAYLOAD_LENGTH_64:
              this.getPayloadLength64(cb);
              break;
            case GET_MASK:
              this.getMask();
              break;
            case GET_DATA:
              this.getData(cb);
              break;
            case INFLATING:
            case DEFER_EVENT:
              this._loop = false;
              return;
          }
        } while (this._loop);
        if (!this._errored) cb();
      }
      /**
       * Reads the first two bytes of a frame.
       *
       * @param {Function} cb Callback
       * @private
       */
      getInfo(cb) {
        if (this._bufferedBytes < 2) {
          this._loop = false;
          return;
        }
        const buf = this.consume(2);
        if ((buf[0] & 48) !== 0) {
          const error = this.createError(
            RangeError,
            "RSV2 and RSV3 must be clear",
            true,
            1002,
            "WS_ERR_UNEXPECTED_RSV_2_3"
          );
          cb(error);
          return;
        }
        const compressed = (buf[0] & 64) === 64;
        if (compressed && !this._extensions[PerMessageDeflate2.extensionName]) {
          const error = this.createError(
            RangeError,
            "RSV1 must be clear",
            true,
            1002,
            "WS_ERR_UNEXPECTED_RSV_1"
          );
          cb(error);
          return;
        }
        this._fin = (buf[0] & 128) === 128;
        this._opcode = buf[0] & 15;
        this._payloadLength = buf[1] & 127;
        if (this._opcode === 0) {
          if (compressed) {
            const error = this.createError(
              RangeError,
              "RSV1 must be clear",
              true,
              1002,
              "WS_ERR_UNEXPECTED_RSV_1"
            );
            cb(error);
            return;
          }
          if (!this._fragmented) {
            const error = this.createError(
              RangeError,
              "invalid opcode 0",
              true,
              1002,
              "WS_ERR_INVALID_OPCODE"
            );
            cb(error);
            return;
          }
          this._opcode = this._fragmented;
        } else if (this._opcode === 1 || this._opcode === 2) {
          if (this._fragmented) {
            const error = this.createError(
              RangeError,
              `invalid opcode ${this._opcode}`,
              true,
              1002,
              "WS_ERR_INVALID_OPCODE"
            );
            cb(error);
            return;
          }
          this._compressed = compressed;
        } else if (this._opcode > 7 && this._opcode < 11) {
          if (!this._fin) {
            const error = this.createError(
              RangeError,
              "FIN must be set",
              true,
              1002,
              "WS_ERR_EXPECTED_FIN"
            );
            cb(error);
            return;
          }
          if (compressed) {
            const error = this.createError(
              RangeError,
              "RSV1 must be clear",
              true,
              1002,
              "WS_ERR_UNEXPECTED_RSV_1"
            );
            cb(error);
            return;
          }
          if (this._payloadLength > 125 || this._opcode === 8 && this._payloadLength === 1) {
            const error = this.createError(
              RangeError,
              `invalid payload length ${this._payloadLength}`,
              true,
              1002,
              "WS_ERR_INVALID_CONTROL_PAYLOAD_LENGTH"
            );
            cb(error);
            return;
          }
        } else {
          const error = this.createError(
            RangeError,
            `invalid opcode ${this._opcode}`,
            true,
            1002,
            "WS_ERR_INVALID_OPCODE"
          );
          cb(error);
          return;
        }
        if (!this._fin && !this._fragmented) this._fragmented = this._opcode;
        this._masked = (buf[1] & 128) === 128;
        if (this._isServer) {
          if (!this._masked) {
            const error = this.createError(
              RangeError,
              "MASK must be set",
              true,
              1002,
              "WS_ERR_EXPECTED_MASK"
            );
            cb(error);
            return;
          }
        } else if (this._masked) {
          const error = this.createError(
            RangeError,
            "MASK must be clear",
            true,
            1002,
            "WS_ERR_UNEXPECTED_MASK"
          );
          cb(error);
          return;
        }
        if (this._payloadLength === 126) this._state = GET_PAYLOAD_LENGTH_16;
        else if (this._payloadLength === 127) this._state = GET_PAYLOAD_LENGTH_64;
        else this.haveLength(cb);
      }
      /**
       * Gets extended payload length (7+16).
       *
       * @param {Function} cb Callback
       * @private
       */
      getPayloadLength16(cb) {
        if (this._bufferedBytes < 2) {
          this._loop = false;
          return;
        }
        this._payloadLength = this.consume(2).readUInt16BE(0);
        this.haveLength(cb);
      }
      /**
       * Gets extended payload length (7+64).
       *
       * @param {Function} cb Callback
       * @private
       */
      getPayloadLength64(cb) {
        if (this._bufferedBytes < 8) {
          this._loop = false;
          return;
        }
        const buf = this.consume(8);
        const num = buf.readUInt32BE(0);
        if (num > Math.pow(2, 53 - 32) - 1) {
          const error = this.createError(
            RangeError,
            "Unsupported WebSocket frame: payload length > 2^53 - 1",
            false,
            1009,
            "WS_ERR_UNSUPPORTED_DATA_PAYLOAD_LENGTH"
          );
          cb(error);
          return;
        }
        this._payloadLength = num * Math.pow(2, 32) + buf.readUInt32BE(4);
        this.haveLength(cb);
      }
      /**
       * Payload length has been read.
       *
       * @param {Function} cb Callback
       * @private
       */
      haveLength(cb) {
        if (this._payloadLength && this._opcode < 8) {
          this._totalPayloadLength += this._payloadLength;
          if (this._totalPayloadLength > this._maxPayload && this._maxPayload > 0) {
            const error = this.createError(
              RangeError,
              "Max payload size exceeded",
              false,
              1009,
              "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH"
            );
            cb(error);
            return;
          }
        }
        if (this._masked) this._state = GET_MASK;
        else this._state = GET_DATA;
      }
      /**
       * Reads mask bytes.
       *
       * @private
       */
      getMask() {
        if (this._bufferedBytes < 4) {
          this._loop = false;
          return;
        }
        this._mask = this.consume(4);
        this._state = GET_DATA;
      }
      /**
       * Reads data bytes.
       *
       * @param {Function} cb Callback
       * @private
       */
      getData(cb) {
        let data = EMPTY_BUFFER;
        if (this._payloadLength) {
          if (this._bufferedBytes < this._payloadLength) {
            this._loop = false;
            return;
          }
          data = this.consume(this._payloadLength);
          if (this._masked && (this._mask[0] | this._mask[1] | this._mask[2] | this._mask[3]) !== 0) {
            unmask(data, this._mask);
          }
        }
        if (this._opcode > 7) {
          this.controlMessage(data, cb);
          return;
        }
        if (this._compressed) {
          this._state = INFLATING;
          this.decompress(data, cb);
          return;
        }
        if (data.length) {
          this._messageLength = this._totalPayloadLength;
          this._fragments.push(data);
        }
        this.dataMessage(cb);
      }
      /**
       * Decompresses data.
       *
       * @param {Buffer} data Compressed data
       * @param {Function} cb Callback
       * @private
       */
      decompress(data, cb) {
        const perMessageDeflate = this._extensions[PerMessageDeflate2.extensionName];
        perMessageDeflate.decompress(data, this._fin, (err, buf) => {
          if (err) return cb(err);
          if (buf.length) {
            this._messageLength += buf.length;
            if (this._messageLength > this._maxPayload && this._maxPayload > 0) {
              const error = this.createError(
                RangeError,
                "Max payload size exceeded",
                false,
                1009,
                "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH"
              );
              cb(error);
              return;
            }
            this._fragments.push(buf);
          }
          this.dataMessage(cb);
          if (this._state === GET_INFO) this.startLoop(cb);
        });
      }
      /**
       * Handles a data message.
       *
       * @param {Function} cb Callback
       * @private
       */
      dataMessage(cb) {
        if (!this._fin) {
          this._state = GET_INFO;
          return;
        }
        const messageLength = this._messageLength;
        const fragments = this._fragments;
        this._totalPayloadLength = 0;
        this._messageLength = 0;
        this._fragmented = 0;
        this._fragments = [];
        if (this._opcode === 2) {
          let data;
          if (this._binaryType === "nodebuffer") {
            data = concat(fragments, messageLength);
          } else if (this._binaryType === "arraybuffer") {
            data = toArrayBuffer(concat(fragments, messageLength));
          } else if (this._binaryType === "blob") {
            data = new Blob(fragments);
          } else {
            data = fragments;
          }
          if (this._allowSynchronousEvents) {
            this.emit("message", data, true);
            this._state = GET_INFO;
          } else {
            this._state = DEFER_EVENT;
            setImmediate(() => {
              this.emit("message", data, true);
              this._state = GET_INFO;
              this.startLoop(cb);
            });
          }
        } else {
          const buf = concat(fragments, messageLength);
          if (!this._skipUTF8Validation && !isValidUTF8(buf)) {
            const error = this.createError(
              Error,
              "invalid UTF-8 sequence",
              true,
              1007,
              "WS_ERR_INVALID_UTF8"
            );
            cb(error);
            return;
          }
          if (this._state === INFLATING || this._allowSynchronousEvents) {
            this.emit("message", buf, false);
            this._state = GET_INFO;
          } else {
            this._state = DEFER_EVENT;
            setImmediate(() => {
              this.emit("message", buf, false);
              this._state = GET_INFO;
              this.startLoop(cb);
            });
          }
        }
      }
      /**
       * Handles a control message.
       *
       * @param {Buffer} data Data to handle
       * @return {(Error|RangeError|undefined)} A possible error
       * @private
       */
      controlMessage(data, cb) {
        if (this._opcode === 8) {
          if (data.length === 0) {
            this._loop = false;
            this.emit("conclude", 1005, EMPTY_BUFFER);
            this.end();
          } else {
            const code = data.readUInt16BE(0);
            if (!isValidStatusCode(code)) {
              const error = this.createError(
                RangeError,
                `invalid status code ${code}`,
                true,
                1002,
                "WS_ERR_INVALID_CLOSE_CODE"
              );
              cb(error);
              return;
            }
            const buf = new FastBuffer(
              data.buffer,
              data.byteOffset + 2,
              data.length - 2
            );
            if (!this._skipUTF8Validation && !isValidUTF8(buf)) {
              const error = this.createError(
                Error,
                "invalid UTF-8 sequence",
                true,
                1007,
                "WS_ERR_INVALID_UTF8"
              );
              cb(error);
              return;
            }
            this._loop = false;
            this.emit("conclude", code, buf);
            this.end();
          }
          this._state = GET_INFO;
          return;
        }
        if (this._allowSynchronousEvents) {
          this.emit(this._opcode === 9 ? "ping" : "pong", data);
          this._state = GET_INFO;
        } else {
          this._state = DEFER_EVENT;
          setImmediate(() => {
            this.emit(this._opcode === 9 ? "ping" : "pong", data);
            this._state = GET_INFO;
            this.startLoop(cb);
          });
        }
      }
      /**
       * Builds an error object.
       *
       * @param {function(new:Error|RangeError)} ErrorCtor The error constructor
       * @param {String} message The error message
       * @param {Boolean} prefix Specifies whether or not to add a default prefix to
       *     `message`
       * @param {Number} statusCode The status code
       * @param {String} errorCode The exposed error code
       * @return {(Error|RangeError)} The error
       * @private
       */
      createError(ErrorCtor, message, prefix, statusCode, errorCode) {
        this._loop = false;
        this._errored = true;
        const err = new ErrorCtor(
          prefix ? `Invalid WebSocket frame: ${message}` : message
        );
        Error.captureStackTrace(err, this.createError);
        err.code = errorCode;
        err[kStatusCode] = statusCode;
        return err;
      }
    };
    module2.exports = Receiver2;
  }
});

// node_modules/.pnpm/ws@8.20.0/node_modules/ws/lib/sender.js
var require_sender = __commonJS({
  "node_modules/.pnpm/ws@8.20.0/node_modules/ws/lib/sender.js"(exports2, module2) {
    "use strict";
    var { Duplex } = require("stream");
    var { randomFillSync: randomFillSync2 } = require("crypto");
    var PerMessageDeflate2 = require_permessage_deflate();
    var { EMPTY_BUFFER, kWebSocket, NOOP } = require_constants();
    var { isBlob, isValidStatusCode } = require_validation();
    var { mask: applyMask, toBuffer } = require_buffer_util();
    var kByteLength = /* @__PURE__ */ Symbol("kByteLength");
    var maskBuffer = Buffer.alloc(4);
    var RANDOM_POOL_SIZE = 8 * 1024;
    var randomPool;
    var randomPoolPointer = RANDOM_POOL_SIZE;
    var DEFAULT = 0;
    var DEFLATING = 1;
    var GET_BLOB_DATA = 2;
    var Sender2 = class _Sender {
      /**
       * Creates a Sender instance.
       *
       * @param {Duplex} socket The connection socket
       * @param {Object} [extensions] An object containing the negotiated extensions
       * @param {Function} [generateMask] The function used to generate the masking
       *     key
       */
      constructor(socket, extensions, generateMask) {
        this._extensions = extensions || {};
        if (generateMask) {
          this._generateMask = generateMask;
          this._maskBuffer = Buffer.alloc(4);
        }
        this._socket = socket;
        this._firstFragment = true;
        this._compress = false;
        this._bufferedBytes = 0;
        this._queue = [];
        this._state = DEFAULT;
        this.onerror = NOOP;
        this[kWebSocket] = void 0;
      }
      /**
       * Frames a piece of data according to the HyBi WebSocket protocol.
       *
       * @param {(Buffer|String)} data The data to frame
       * @param {Object} options Options object
       * @param {Boolean} [options.fin=false] Specifies whether or not to set the
       *     FIN bit
       * @param {Function} [options.generateMask] The function used to generate the
       *     masking key
       * @param {Boolean} [options.mask=false] Specifies whether or not to mask
       *     `data`
       * @param {Buffer} [options.maskBuffer] The buffer used to store the masking
       *     key
       * @param {Number} options.opcode The opcode
       * @param {Boolean} [options.readOnly=false] Specifies whether `data` can be
       *     modified
       * @param {Boolean} [options.rsv1=false] Specifies whether or not to set the
       *     RSV1 bit
       * @return {(Buffer|String)[]} The framed data
       * @public
       */
      static frame(data, options) {
        let mask;
        let merge = false;
        let offset = 2;
        let skipMasking = false;
        if (options.mask) {
          mask = options.maskBuffer || maskBuffer;
          if (options.generateMask) {
            options.generateMask(mask);
          } else {
            if (randomPoolPointer === RANDOM_POOL_SIZE) {
              if (randomPool === void 0) {
                randomPool = Buffer.alloc(RANDOM_POOL_SIZE);
              }
              randomFillSync2(randomPool, 0, RANDOM_POOL_SIZE);
              randomPoolPointer = 0;
            }
            mask[0] = randomPool[randomPoolPointer++];
            mask[1] = randomPool[randomPoolPointer++];
            mask[2] = randomPool[randomPoolPointer++];
            mask[3] = randomPool[randomPoolPointer++];
          }
          skipMasking = (mask[0] | mask[1] | mask[2] | mask[3]) === 0;
          offset = 6;
        }
        let dataLength;
        if (typeof data === "string") {
          if ((!options.mask || skipMasking) && options[kByteLength] !== void 0) {
            dataLength = options[kByteLength];
          } else {
            data = Buffer.from(data);
            dataLength = data.length;
          }
        } else {
          dataLength = data.length;
          merge = options.mask && options.readOnly && !skipMasking;
        }
        let payloadLength = dataLength;
        if (dataLength >= 65536) {
          offset += 8;
          payloadLength = 127;
        } else if (dataLength > 125) {
          offset += 2;
          payloadLength = 126;
        }
        const target = Buffer.allocUnsafe(merge ? dataLength + offset : offset);
        target[0] = options.fin ? options.opcode | 128 : options.opcode;
        if (options.rsv1) target[0] |= 64;
        target[1] = payloadLength;
        if (payloadLength === 126) {
          target.writeUInt16BE(dataLength, 2);
        } else if (payloadLength === 127) {
          target[2] = target[3] = 0;
          target.writeUIntBE(dataLength, 4, 6);
        }
        if (!options.mask) return [target, data];
        target[1] |= 128;
        target[offset - 4] = mask[0];
        target[offset - 3] = mask[1];
        target[offset - 2] = mask[2];
        target[offset - 1] = mask[3];
        if (skipMasking) return [target, data];
        if (merge) {
          applyMask(data, mask, target, offset, dataLength);
          return [target];
        }
        applyMask(data, mask, data, 0, dataLength);
        return [target, data];
      }
      /**
       * Sends a close message to the other peer.
       *
       * @param {Number} [code] The status code component of the body
       * @param {(String|Buffer)} [data] The message component of the body
       * @param {Boolean} [mask=false] Specifies whether or not to mask the message
       * @param {Function} [cb] Callback
       * @public
       */
      close(code, data, mask, cb) {
        let buf;
        if (code === void 0) {
          buf = EMPTY_BUFFER;
        } else if (typeof code !== "number" || !isValidStatusCode(code)) {
          throw new TypeError("First argument must be a valid error code number");
        } else if (data === void 0 || !data.length) {
          buf = Buffer.allocUnsafe(2);
          buf.writeUInt16BE(code, 0);
        } else {
          const length = Buffer.byteLength(data);
          if (length > 123) {
            throw new RangeError("The message must not be greater than 123 bytes");
          }
          buf = Buffer.allocUnsafe(2 + length);
          buf.writeUInt16BE(code, 0);
          if (typeof data === "string") {
            buf.write(data, 2);
          } else {
            buf.set(data, 2);
          }
        }
        const options = {
          [kByteLength]: buf.length,
          fin: true,
          generateMask: this._generateMask,
          mask,
          maskBuffer: this._maskBuffer,
          opcode: 8,
          readOnly: false,
          rsv1: false
        };
        if (this._state !== DEFAULT) {
          this.enqueue([this.dispatch, buf, false, options, cb]);
        } else {
          this.sendFrame(_Sender.frame(buf, options), cb);
        }
      }
      /**
       * Sends a ping message to the other peer.
       *
       * @param {*} data The message to send
       * @param {Boolean} [mask=false] Specifies whether or not to mask `data`
       * @param {Function} [cb] Callback
       * @public
       */
      ping(data, mask, cb) {
        let byteLength;
        let readOnly;
        if (typeof data === "string") {
          byteLength = Buffer.byteLength(data);
          readOnly = false;
        } else if (isBlob(data)) {
          byteLength = data.size;
          readOnly = false;
        } else {
          data = toBuffer(data);
          byteLength = data.length;
          readOnly = toBuffer.readOnly;
        }
        if (byteLength > 125) {
          throw new RangeError("The data size must not be greater than 125 bytes");
        }
        const options = {
          [kByteLength]: byteLength,
          fin: true,
          generateMask: this._generateMask,
          mask,
          maskBuffer: this._maskBuffer,
          opcode: 9,
          readOnly,
          rsv1: false
        };
        if (isBlob(data)) {
          if (this._state !== DEFAULT) {
            this.enqueue([this.getBlobData, data, false, options, cb]);
          } else {
            this.getBlobData(data, false, options, cb);
          }
        } else if (this._state !== DEFAULT) {
          this.enqueue([this.dispatch, data, false, options, cb]);
        } else {
          this.sendFrame(_Sender.frame(data, options), cb);
        }
      }
      /**
       * Sends a pong message to the other peer.
       *
       * @param {*} data The message to send
       * @param {Boolean} [mask=false] Specifies whether or not to mask `data`
       * @param {Function} [cb] Callback
       * @public
       */
      pong(data, mask, cb) {
        let byteLength;
        let readOnly;
        if (typeof data === "string") {
          byteLength = Buffer.byteLength(data);
          readOnly = false;
        } else if (isBlob(data)) {
          byteLength = data.size;
          readOnly = false;
        } else {
          data = toBuffer(data);
          byteLength = data.length;
          readOnly = toBuffer.readOnly;
        }
        if (byteLength > 125) {
          throw new RangeError("The data size must not be greater than 125 bytes");
        }
        const options = {
          [kByteLength]: byteLength,
          fin: true,
          generateMask: this._generateMask,
          mask,
          maskBuffer: this._maskBuffer,
          opcode: 10,
          readOnly,
          rsv1: false
        };
        if (isBlob(data)) {
          if (this._state !== DEFAULT) {
            this.enqueue([this.getBlobData, data, false, options, cb]);
          } else {
            this.getBlobData(data, false, options, cb);
          }
        } else if (this._state !== DEFAULT) {
          this.enqueue([this.dispatch, data, false, options, cb]);
        } else {
          this.sendFrame(_Sender.frame(data, options), cb);
        }
      }
      /**
       * Sends a data message to the other peer.
       *
       * @param {*} data The message to send
       * @param {Object} options Options object
       * @param {Boolean} [options.binary=false] Specifies whether `data` is binary
       *     or text
       * @param {Boolean} [options.compress=false] Specifies whether or not to
       *     compress `data`
       * @param {Boolean} [options.fin=false] Specifies whether the fragment is the
       *     last one
       * @param {Boolean} [options.mask=false] Specifies whether or not to mask
       *     `data`
       * @param {Function} [cb] Callback
       * @public
       */
      send(data, options, cb) {
        const perMessageDeflate = this._extensions[PerMessageDeflate2.extensionName];
        let opcode = options.binary ? 2 : 1;
        let rsv1 = options.compress;
        let byteLength;
        let readOnly;
        if (typeof data === "string") {
          byteLength = Buffer.byteLength(data);
          readOnly = false;
        } else if (isBlob(data)) {
          byteLength = data.size;
          readOnly = false;
        } else {
          data = toBuffer(data);
          byteLength = data.length;
          readOnly = toBuffer.readOnly;
        }
        if (this._firstFragment) {
          this._firstFragment = false;
          if (rsv1 && perMessageDeflate && perMessageDeflate.params[perMessageDeflate._isServer ? "server_no_context_takeover" : "client_no_context_takeover"]) {
            rsv1 = byteLength >= perMessageDeflate._threshold;
          }
          this._compress = rsv1;
        } else {
          rsv1 = false;
          opcode = 0;
        }
        if (options.fin) this._firstFragment = true;
        const opts = {
          [kByteLength]: byteLength,
          fin: options.fin,
          generateMask: this._generateMask,
          mask: options.mask,
          maskBuffer: this._maskBuffer,
          opcode,
          readOnly,
          rsv1
        };
        if (isBlob(data)) {
          if (this._state !== DEFAULT) {
            this.enqueue([this.getBlobData, data, this._compress, opts, cb]);
          } else {
            this.getBlobData(data, this._compress, opts, cb);
          }
        } else if (this._state !== DEFAULT) {
          this.enqueue([this.dispatch, data, this._compress, opts, cb]);
        } else {
          this.dispatch(data, this._compress, opts, cb);
        }
      }
      /**
       * Gets the contents of a blob as binary data.
       *
       * @param {Blob} blob The blob
       * @param {Boolean} [compress=false] Specifies whether or not to compress
       *     the data
       * @param {Object} options Options object
       * @param {Boolean} [options.fin=false] Specifies whether or not to set the
       *     FIN bit
       * @param {Function} [options.generateMask] The function used to generate the
       *     masking key
       * @param {Boolean} [options.mask=false] Specifies whether or not to mask
       *     `data`
       * @param {Buffer} [options.maskBuffer] The buffer used to store the masking
       *     key
       * @param {Number} options.opcode The opcode
       * @param {Boolean} [options.readOnly=false] Specifies whether `data` can be
       *     modified
       * @param {Boolean} [options.rsv1=false] Specifies whether or not to set the
       *     RSV1 bit
       * @param {Function} [cb] Callback
       * @private
       */
      getBlobData(blob, compress, options, cb) {
        this._bufferedBytes += options[kByteLength];
        this._state = GET_BLOB_DATA;
        blob.arrayBuffer().then((arrayBuffer) => {
          if (this._socket.destroyed) {
            const err = new Error(
              "The socket was closed while the blob was being read"
            );
            process.nextTick(callCallbacks, this, err, cb);
            return;
          }
          this._bufferedBytes -= options[kByteLength];
          const data = toBuffer(arrayBuffer);
          if (!compress) {
            this._state = DEFAULT;
            this.sendFrame(_Sender.frame(data, options), cb);
            this.dequeue();
          } else {
            this.dispatch(data, compress, options, cb);
          }
        }).catch((err) => {
          process.nextTick(onError, this, err, cb);
        });
      }
      /**
       * Dispatches a message.
       *
       * @param {(Buffer|String)} data The message to send
       * @param {Boolean} [compress=false] Specifies whether or not to compress
       *     `data`
       * @param {Object} options Options object
       * @param {Boolean} [options.fin=false] Specifies whether or not to set the
       *     FIN bit
       * @param {Function} [options.generateMask] The function used to generate the
       *     masking key
       * @param {Boolean} [options.mask=false] Specifies whether or not to mask
       *     `data`
       * @param {Buffer} [options.maskBuffer] The buffer used to store the masking
       *     key
       * @param {Number} options.opcode The opcode
       * @param {Boolean} [options.readOnly=false] Specifies whether `data` can be
       *     modified
       * @param {Boolean} [options.rsv1=false] Specifies whether or not to set the
       *     RSV1 bit
       * @param {Function} [cb] Callback
       * @private
       */
      dispatch(data, compress, options, cb) {
        if (!compress) {
          this.sendFrame(_Sender.frame(data, options), cb);
          return;
        }
        const perMessageDeflate = this._extensions[PerMessageDeflate2.extensionName];
        this._bufferedBytes += options[kByteLength];
        this._state = DEFLATING;
        perMessageDeflate.compress(data, options.fin, (_, buf) => {
          if (this._socket.destroyed) {
            const err = new Error(
              "The socket was closed while data was being compressed"
            );
            callCallbacks(this, err, cb);
            return;
          }
          this._bufferedBytes -= options[kByteLength];
          this._state = DEFAULT;
          options.readOnly = false;
          this.sendFrame(_Sender.frame(buf, options), cb);
          this.dequeue();
        });
      }
      /**
       * Executes queued send operations.
       *
       * @private
       */
      dequeue() {
        while (this._state === DEFAULT && this._queue.length) {
          const params = this._queue.shift();
          this._bufferedBytes -= params[3][kByteLength];
          Reflect.apply(params[0], this, params.slice(1));
        }
      }
      /**
       * Enqueues a send operation.
       *
       * @param {Array} params Send operation parameters.
       * @private
       */
      enqueue(params) {
        this._bufferedBytes += params[3][kByteLength];
        this._queue.push(params);
      }
      /**
       * Sends a frame.
       *
       * @param {(Buffer | String)[]} list The frame to send
       * @param {Function} [cb] Callback
       * @private
       */
      sendFrame(list, cb) {
        if (list.length === 2) {
          this._socket.cork();
          this._socket.write(list[0]);
          this._socket.write(list[1], cb);
          this._socket.uncork();
        } else {
          this._socket.write(list[0], cb);
        }
      }
    };
    module2.exports = Sender2;
    function callCallbacks(sender, err, cb) {
      if (typeof cb === "function") cb(err);
      for (let i = 0; i < sender._queue.length; i++) {
        const params = sender._queue[i];
        const callback = params[params.length - 1];
        if (typeof callback === "function") callback(err);
      }
    }
    function onError(sender, err, cb) {
      callCallbacks(sender, err, cb);
      sender.onerror(err);
    }
  }
});

// node_modules/.pnpm/ws@8.20.0/node_modules/ws/lib/event-target.js
var require_event_target = __commonJS({
  "node_modules/.pnpm/ws@8.20.0/node_modules/ws/lib/event-target.js"(exports2, module2) {
    "use strict";
    var { kForOnEventAttribute, kListener } = require_constants();
    var kCode = /* @__PURE__ */ Symbol("kCode");
    var kData = /* @__PURE__ */ Symbol("kData");
    var kError = /* @__PURE__ */ Symbol("kError");
    var kMessage = /* @__PURE__ */ Symbol("kMessage");
    var kReason = /* @__PURE__ */ Symbol("kReason");
    var kTarget = /* @__PURE__ */ Symbol("kTarget");
    var kType = /* @__PURE__ */ Symbol("kType");
    var kWasClean = /* @__PURE__ */ Symbol("kWasClean");
    var Event = class {
      /**
       * Create a new `Event`.
       *
       * @param {String} type The name of the event
       * @throws {TypeError} If the `type` argument is not specified
       */
      constructor(type) {
        this[kTarget] = null;
        this[kType] = type;
      }
      /**
       * @type {*}
       */
      get target() {
        return this[kTarget];
      }
      /**
       * @type {String}
       */
      get type() {
        return this[kType];
      }
    };
    Object.defineProperty(Event.prototype, "target", { enumerable: true });
    Object.defineProperty(Event.prototype, "type", { enumerable: true });
    var CloseEvent = class extends Event {
      /**
       * Create a new `CloseEvent`.
       *
       * @param {String} type The name of the event
       * @param {Object} [options] A dictionary object that allows for setting
       *     attributes via object members of the same name
       * @param {Number} [options.code=0] The status code explaining why the
       *     connection was closed
       * @param {String} [options.reason=''] A human-readable string explaining why
       *     the connection was closed
       * @param {Boolean} [options.wasClean=false] Indicates whether or not the
       *     connection was cleanly closed
       */
      constructor(type, options = {}) {
        super(type);
        this[kCode] = options.code === void 0 ? 0 : options.code;
        this[kReason] = options.reason === void 0 ? "" : options.reason;
        this[kWasClean] = options.wasClean === void 0 ? false : options.wasClean;
      }
      /**
       * @type {Number}
       */
      get code() {
        return this[kCode];
      }
      /**
       * @type {String}
       */
      get reason() {
        return this[kReason];
      }
      /**
       * @type {Boolean}
       */
      get wasClean() {
        return this[kWasClean];
      }
    };
    Object.defineProperty(CloseEvent.prototype, "code", { enumerable: true });
    Object.defineProperty(CloseEvent.prototype, "reason", { enumerable: true });
    Object.defineProperty(CloseEvent.prototype, "wasClean", { enumerable: true });
    var ErrorEvent = class extends Event {
      /**
       * Create a new `ErrorEvent`.
       *
       * @param {String} type The name of the event
       * @param {Object} [options] A dictionary object that allows for setting
       *     attributes via object members of the same name
       * @param {*} [options.error=null] The error that generated this event
       * @param {String} [options.message=''] The error message
       */
      constructor(type, options = {}) {
        super(type);
        this[kError] = options.error === void 0 ? null : options.error;
        this[kMessage] = options.message === void 0 ? "" : options.message;
      }
      /**
       * @type {*}
       */
      get error() {
        return this[kError];
      }
      /**
       * @type {String}
       */
      get message() {
        return this[kMessage];
      }
    };
    Object.defineProperty(ErrorEvent.prototype, "error", { enumerable: true });
    Object.defineProperty(ErrorEvent.prototype, "message", { enumerable: true });
    var MessageEvent = class extends Event {
      /**
       * Create a new `MessageEvent`.
       *
       * @param {String} type The name of the event
       * @param {Object} [options] A dictionary object that allows for setting
       *     attributes via object members of the same name
       * @param {*} [options.data=null] The message content
       */
      constructor(type, options = {}) {
        super(type);
        this[kData] = options.data === void 0 ? null : options.data;
      }
      /**
       * @type {*}
       */
      get data() {
        return this[kData];
      }
    };
    Object.defineProperty(MessageEvent.prototype, "data", { enumerable: true });
    var EventTarget = {
      /**
       * Register an event listener.
       *
       * @param {String} type A string representing the event type to listen for
       * @param {(Function|Object)} handler The listener to add
       * @param {Object} [options] An options object specifies characteristics about
       *     the event listener
       * @param {Boolean} [options.once=false] A `Boolean` indicating that the
       *     listener should be invoked at most once after being added. If `true`,
       *     the listener would be automatically removed when invoked.
       * @public
       */
      addEventListener(type, handler, options = {}) {
        for (const listener of this.listeners(type)) {
          if (!options[kForOnEventAttribute] && listener[kListener] === handler && !listener[kForOnEventAttribute]) {
            return;
          }
        }
        let wrapper;
        if (type === "message") {
          wrapper = function onMessage(data, isBinary) {
            const event = new MessageEvent("message", {
              data: isBinary ? data : data.toString()
            });
            event[kTarget] = this;
            callListener(handler, this, event);
          };
        } else if (type === "close") {
          wrapper = function onClose(code, message) {
            const event = new CloseEvent("close", {
              code,
              reason: message.toString(),
              wasClean: this._closeFrameReceived && this._closeFrameSent
            });
            event[kTarget] = this;
            callListener(handler, this, event);
          };
        } else if (type === "error") {
          wrapper = function onError(error) {
            const event = new ErrorEvent("error", {
              error,
              message: error.message
            });
            event[kTarget] = this;
            callListener(handler, this, event);
          };
        } else if (type === "open") {
          wrapper = function onOpen() {
            const event = new Event("open");
            event[kTarget] = this;
            callListener(handler, this, event);
          };
        } else {
          return;
        }
        wrapper[kForOnEventAttribute] = !!options[kForOnEventAttribute];
        wrapper[kListener] = handler;
        if (options.once) {
          this.once(type, wrapper);
        } else {
          this.on(type, wrapper);
        }
      },
      /**
       * Remove an event listener.
       *
       * @param {String} type A string representing the event type to remove
       * @param {(Function|Object)} handler The listener to remove
       * @public
       */
      removeEventListener(type, handler) {
        for (const listener of this.listeners(type)) {
          if (listener[kListener] === handler && !listener[kForOnEventAttribute]) {
            this.removeListener(type, listener);
            break;
          }
        }
      }
    };
    module2.exports = {
      CloseEvent,
      ErrorEvent,
      Event,
      EventTarget,
      MessageEvent
    };
    function callListener(listener, thisArg, event) {
      if (typeof listener === "object" && listener.handleEvent) {
        listener.handleEvent.call(listener, event);
      } else {
        listener.call(thisArg, event);
      }
    }
  }
});

// node_modules/.pnpm/ws@8.20.0/node_modules/ws/lib/extension.js
var require_extension = __commonJS({
  "node_modules/.pnpm/ws@8.20.0/node_modules/ws/lib/extension.js"(exports2, module2) {
    "use strict";
    var { tokenChars } = require_validation();
    function push(dest, name, elem) {
      if (dest[name] === void 0) dest[name] = [elem];
      else dest[name].push(elem);
    }
    function parse(header) {
      const offers = /* @__PURE__ */ Object.create(null);
      let params = /* @__PURE__ */ Object.create(null);
      let mustUnescape = false;
      let isEscaping = false;
      let inQuotes = false;
      let extensionName;
      let paramName;
      let start = -1;
      let code = -1;
      let end = -1;
      let i = 0;
      for (; i < header.length; i++) {
        code = header.charCodeAt(i);
        if (extensionName === void 0) {
          if (end === -1 && tokenChars[code] === 1) {
            if (start === -1) start = i;
          } else if (i !== 0 && (code === 32 || code === 9)) {
            if (end === -1 && start !== -1) end = i;
          } else if (code === 59 || code === 44) {
            if (start === -1) {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
            if (end === -1) end = i;
            const name = header.slice(start, end);
            if (code === 44) {
              push(offers, name, params);
              params = /* @__PURE__ */ Object.create(null);
            } else {
              extensionName = name;
            }
            start = end = -1;
          } else {
            throw new SyntaxError(`Unexpected character at index ${i}`);
          }
        } else if (paramName === void 0) {
          if (end === -1 && tokenChars[code] === 1) {
            if (start === -1) start = i;
          } else if (code === 32 || code === 9) {
            if (end === -1 && start !== -1) end = i;
          } else if (code === 59 || code === 44) {
            if (start === -1) {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
            if (end === -1) end = i;
            push(params, header.slice(start, end), true);
            if (code === 44) {
              push(offers, extensionName, params);
              params = /* @__PURE__ */ Object.create(null);
              extensionName = void 0;
            }
            start = end = -1;
          } else if (code === 61 && start !== -1 && end === -1) {
            paramName = header.slice(start, i);
            start = end = -1;
          } else {
            throw new SyntaxError(`Unexpected character at index ${i}`);
          }
        } else {
          if (isEscaping) {
            if (tokenChars[code] !== 1) {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
            if (start === -1) start = i;
            else if (!mustUnescape) mustUnescape = true;
            isEscaping = false;
          } else if (inQuotes) {
            if (tokenChars[code] === 1) {
              if (start === -1) start = i;
            } else if (code === 34 && start !== -1) {
              inQuotes = false;
              end = i;
            } else if (code === 92) {
              isEscaping = true;
            } else {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
          } else if (code === 34 && header.charCodeAt(i - 1) === 61) {
            inQuotes = true;
          } else if (end === -1 && tokenChars[code] === 1) {
            if (start === -1) start = i;
          } else if (start !== -1 && (code === 32 || code === 9)) {
            if (end === -1) end = i;
          } else if (code === 59 || code === 44) {
            if (start === -1) {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
            if (end === -1) end = i;
            let value = header.slice(start, end);
            if (mustUnescape) {
              value = value.replace(/\\/g, "");
              mustUnescape = false;
            }
            push(params, paramName, value);
            if (code === 44) {
              push(offers, extensionName, params);
              params = /* @__PURE__ */ Object.create(null);
              extensionName = void 0;
            }
            paramName = void 0;
            start = end = -1;
          } else {
            throw new SyntaxError(`Unexpected character at index ${i}`);
          }
        }
      }
      if (start === -1 || inQuotes || code === 32 || code === 9) {
        throw new SyntaxError("Unexpected end of input");
      }
      if (end === -1) end = i;
      const token = header.slice(start, end);
      if (extensionName === void 0) {
        push(offers, token, params);
      } else {
        if (paramName === void 0) {
          push(params, token, true);
        } else if (mustUnescape) {
          push(params, paramName, token.replace(/\\/g, ""));
        } else {
          push(params, paramName, token);
        }
        push(offers, extensionName, params);
      }
      return offers;
    }
    function format(extensions) {
      return Object.keys(extensions).map((extension2) => {
        let configurations = extensions[extension2];
        if (!Array.isArray(configurations)) configurations = [configurations];
        return configurations.map((params) => {
          return [extension2].concat(
            Object.keys(params).map((k) => {
              let values = params[k];
              if (!Array.isArray(values)) values = [values];
              return values.map((v) => v === true ? k : `${k}=${v}`).join("; ");
            })
          ).join("; ");
        }).join(", ");
      }).join(", ");
    }
    module2.exports = { format, parse };
  }
});

// node_modules/.pnpm/ws@8.20.0/node_modules/ws/lib/websocket.js
var require_websocket = __commonJS({
  "node_modules/.pnpm/ws@8.20.0/node_modules/ws/lib/websocket.js"(exports2, module2) {
    "use strict";
    var EventEmitter = require("events");
    var https = require("https");
    var http = require("http");
    var net = require("net");
    var tls = require("tls");
    var { randomBytes: randomBytes2, createHash } = require("crypto");
    var { Duplex, Readable } = require("stream");
    var { URL } = require("url");
    var PerMessageDeflate2 = require_permessage_deflate();
    var Receiver2 = require_receiver();
    var Sender2 = require_sender();
    var { isBlob } = require_validation();
    var {
      BINARY_TYPES,
      CLOSE_TIMEOUT,
      EMPTY_BUFFER,
      GUID,
      kForOnEventAttribute,
      kListener,
      kStatusCode,
      kWebSocket,
      NOOP
    } = require_constants();
    var {
      EventTarget: { addEventListener, removeEventListener }
    } = require_event_target();
    var { format, parse } = require_extension();
    var { toBuffer } = require_buffer_util();
    var kAborted = /* @__PURE__ */ Symbol("kAborted");
    var protocolVersions = [8, 13];
    var readyStates = ["CONNECTING", "OPEN", "CLOSING", "CLOSED"];
    var subprotocolRegex = /^[!#$%&'*+\-.0-9A-Z^_`|a-z~]+$/;
    var WebSocket2 = class _WebSocket extends EventEmitter {
      /**
       * Create a new `WebSocket`.
       *
       * @param {(String|URL)} address The URL to which to connect
       * @param {(String|String[])} [protocols] The subprotocols
       * @param {Object} [options] Connection options
       */
      constructor(address, protocols, options) {
        super();
        this._binaryType = BINARY_TYPES[0];
        this._closeCode = 1006;
        this._closeFrameReceived = false;
        this._closeFrameSent = false;
        this._closeMessage = EMPTY_BUFFER;
        this._closeTimer = null;
        this._errorEmitted = false;
        this._extensions = {};
        this._paused = false;
        this._protocol = "";
        this._readyState = _WebSocket.CONNECTING;
        this._receiver = null;
        this._sender = null;
        this._socket = null;
        if (address !== null) {
          this._bufferedAmount = 0;
          this._isServer = false;
          this._redirects = 0;
          if (protocols === void 0) {
            protocols = [];
          } else if (!Array.isArray(protocols)) {
            if (typeof protocols === "object" && protocols !== null) {
              options = protocols;
              protocols = [];
            } else {
              protocols = [protocols];
            }
          }
          initAsClient(this, address, protocols, options);
        } else {
          this._autoPong = options.autoPong;
          this._closeTimeout = options.closeTimeout;
          this._isServer = true;
        }
      }
      /**
       * For historical reasons, the custom "nodebuffer" type is used by the default
       * instead of "blob".
       *
       * @type {String}
       */
      get binaryType() {
        return this._binaryType;
      }
      set binaryType(type) {
        if (!BINARY_TYPES.includes(type)) return;
        this._binaryType = type;
        if (this._receiver) this._receiver._binaryType = type;
      }
      /**
       * @type {Number}
       */
      get bufferedAmount() {
        if (!this._socket) return this._bufferedAmount;
        return this._socket._writableState.length + this._sender._bufferedBytes;
      }
      /**
       * @type {String}
       */
      get extensions() {
        return Object.keys(this._extensions).join();
      }
      /**
       * @type {Boolean}
       */
      get isPaused() {
        return this._paused;
      }
      /**
       * @type {Function}
       */
      /* istanbul ignore next */
      get onclose() {
        return null;
      }
      /**
       * @type {Function}
       */
      /* istanbul ignore next */
      get onerror() {
        return null;
      }
      /**
       * @type {Function}
       */
      /* istanbul ignore next */
      get onopen() {
        return null;
      }
      /**
       * @type {Function}
       */
      /* istanbul ignore next */
      get onmessage() {
        return null;
      }
      /**
       * @type {String}
       */
      get protocol() {
        return this._protocol;
      }
      /**
       * @type {Number}
       */
      get readyState() {
        return this._readyState;
      }
      /**
       * @type {String}
       */
      get url() {
        return this._url;
      }
      /**
       * Set up the socket and the internal resources.
       *
       * @param {Duplex} socket The network socket between the server and client
       * @param {Buffer} head The first packet of the upgraded stream
       * @param {Object} options Options object
       * @param {Boolean} [options.allowSynchronousEvents=false] Specifies whether
       *     any of the `'message'`, `'ping'`, and `'pong'` events can be emitted
       *     multiple times in the same tick
       * @param {Function} [options.generateMask] The function used to generate the
       *     masking key
       * @param {Number} [options.maxPayload=0] The maximum allowed message size
       * @param {Boolean} [options.skipUTF8Validation=false] Specifies whether or
       *     not to skip UTF-8 validation for text and close messages
       * @private
       */
      setSocket(socket, head, options) {
        const receiver = new Receiver2({
          allowSynchronousEvents: options.allowSynchronousEvents,
          binaryType: this.binaryType,
          extensions: this._extensions,
          isServer: this._isServer,
          maxPayload: options.maxPayload,
          skipUTF8Validation: options.skipUTF8Validation
        });
        const sender = new Sender2(socket, this._extensions, options.generateMask);
        this._receiver = receiver;
        this._sender = sender;
        this._socket = socket;
        receiver[kWebSocket] = this;
        sender[kWebSocket] = this;
        socket[kWebSocket] = this;
        receiver.on("conclude", receiverOnConclude);
        receiver.on("drain", receiverOnDrain);
        receiver.on("error", receiverOnError);
        receiver.on("message", receiverOnMessage);
        receiver.on("ping", receiverOnPing);
        receiver.on("pong", receiverOnPong);
        sender.onerror = senderOnError;
        if (socket.setTimeout) socket.setTimeout(0);
        if (socket.setNoDelay) socket.setNoDelay();
        if (head.length > 0) socket.unshift(head);
        socket.on("close", socketOnClose);
        socket.on("data", socketOnData);
        socket.on("end", socketOnEnd);
        socket.on("error", socketOnError);
        this._readyState = _WebSocket.OPEN;
        this.emit("open");
      }
      /**
       * Emit the `'close'` event.
       *
       * @private
       */
      emitClose() {
        if (!this._socket) {
          this._readyState = _WebSocket.CLOSED;
          this.emit("close", this._closeCode, this._closeMessage);
          return;
        }
        if (this._extensions[PerMessageDeflate2.extensionName]) {
          this._extensions[PerMessageDeflate2.extensionName].cleanup();
        }
        this._receiver.removeAllListeners();
        this._readyState = _WebSocket.CLOSED;
        this.emit("close", this._closeCode, this._closeMessage);
      }
      /**
       * Start a closing handshake.
       *
       *          +----------+   +-----------+   +----------+
       *     - - -|ws.close()|-->|close frame|-->|ws.close()|- - -
       *    |     +----------+   +-----------+   +----------+     |
       *          +----------+   +-----------+         |
       * CLOSING  |ws.close()|<--|close frame|<--+-----+       CLOSING
       *          +----------+   +-----------+   |
       *    |           |                        |   +---+        |
       *                +------------------------+-->|fin| - - - -
       *    |         +---+                      |   +---+
       *     - - - - -|fin|<---------------------+
       *              +---+
       *
       * @param {Number} [code] Status code explaining why the connection is closing
       * @param {(String|Buffer)} [data] The reason why the connection is
       *     closing
       * @public
       */
      close(code, data) {
        if (this.readyState === _WebSocket.CLOSED) return;
        if (this.readyState === _WebSocket.CONNECTING) {
          const msg = "WebSocket was closed before the connection was established";
          abortHandshake(this, this._req, msg);
          return;
        }
        if (this.readyState === _WebSocket.CLOSING) {
          if (this._closeFrameSent && (this._closeFrameReceived || this._receiver._writableState.errorEmitted)) {
            this._socket.end();
          }
          return;
        }
        this._readyState = _WebSocket.CLOSING;
        this._sender.close(code, data, !this._isServer, (err) => {
          if (err) return;
          this._closeFrameSent = true;
          if (this._closeFrameReceived || this._receiver._writableState.errorEmitted) {
            this._socket.end();
          }
        });
        setCloseTimer(this);
      }
      /**
       * Pause the socket.
       *
       * @public
       */
      pause() {
        if (this.readyState === _WebSocket.CONNECTING || this.readyState === _WebSocket.CLOSED) {
          return;
        }
        this._paused = true;
        this._socket.pause();
      }
      /**
       * Send a ping.
       *
       * @param {*} [data] The data to send
       * @param {Boolean} [mask] Indicates whether or not to mask `data`
       * @param {Function} [cb] Callback which is executed when the ping is sent
       * @public
       */
      ping(data, mask, cb) {
        if (this.readyState === _WebSocket.CONNECTING) {
          throw new Error("WebSocket is not open: readyState 0 (CONNECTING)");
        }
        if (typeof data === "function") {
          cb = data;
          data = mask = void 0;
        } else if (typeof mask === "function") {
          cb = mask;
          mask = void 0;
        }
        if (typeof data === "number") data = data.toString();
        if (this.readyState !== _WebSocket.OPEN) {
          sendAfterClose(this, data, cb);
          return;
        }
        if (mask === void 0) mask = !this._isServer;
        this._sender.ping(data || EMPTY_BUFFER, mask, cb);
      }
      /**
       * Send a pong.
       *
       * @param {*} [data] The data to send
       * @param {Boolean} [mask] Indicates whether or not to mask `data`
       * @param {Function} [cb] Callback which is executed when the pong is sent
       * @public
       */
      pong(data, mask, cb) {
        if (this.readyState === _WebSocket.CONNECTING) {
          throw new Error("WebSocket is not open: readyState 0 (CONNECTING)");
        }
        if (typeof data === "function") {
          cb = data;
          data = mask = void 0;
        } else if (typeof mask === "function") {
          cb = mask;
          mask = void 0;
        }
        if (typeof data === "number") data = data.toString();
        if (this.readyState !== _WebSocket.OPEN) {
          sendAfterClose(this, data, cb);
          return;
        }
        if (mask === void 0) mask = !this._isServer;
        this._sender.pong(data || EMPTY_BUFFER, mask, cb);
      }
      /**
       * Resume the socket.
       *
       * @public
       */
      resume() {
        if (this.readyState === _WebSocket.CONNECTING || this.readyState === _WebSocket.CLOSED) {
          return;
        }
        this._paused = false;
        if (!this._receiver._writableState.needDrain) this._socket.resume();
      }
      /**
       * Send a data message.
       *
       * @param {*} data The message to send
       * @param {Object} [options] Options object
       * @param {Boolean} [options.binary] Specifies whether `data` is binary or
       *     text
       * @param {Boolean} [options.compress] Specifies whether or not to compress
       *     `data`
       * @param {Boolean} [options.fin=true] Specifies whether the fragment is the
       *     last one
       * @param {Boolean} [options.mask] Specifies whether or not to mask `data`
       * @param {Function} [cb] Callback which is executed when data is written out
       * @public
       */
      send(data, options, cb) {
        if (this.readyState === _WebSocket.CONNECTING) {
          throw new Error("WebSocket is not open: readyState 0 (CONNECTING)");
        }
        if (typeof options === "function") {
          cb = options;
          options = {};
        }
        if (typeof data === "number") data = data.toString();
        if (this.readyState !== _WebSocket.OPEN) {
          sendAfterClose(this, data, cb);
          return;
        }
        const opts = {
          binary: typeof data !== "string",
          mask: !this._isServer,
          compress: true,
          fin: true,
          ...options
        };
        if (!this._extensions[PerMessageDeflate2.extensionName]) {
          opts.compress = false;
        }
        this._sender.send(data || EMPTY_BUFFER, opts, cb);
      }
      /**
       * Forcibly close the connection.
       *
       * @public
       */
      terminate() {
        if (this.readyState === _WebSocket.CLOSED) return;
        if (this.readyState === _WebSocket.CONNECTING) {
          const msg = "WebSocket was closed before the connection was established";
          abortHandshake(this, this._req, msg);
          return;
        }
        if (this._socket) {
          this._readyState = _WebSocket.CLOSING;
          this._socket.destroy();
        }
      }
    };
    Object.defineProperty(WebSocket2, "CONNECTING", {
      enumerable: true,
      value: readyStates.indexOf("CONNECTING")
    });
    Object.defineProperty(WebSocket2.prototype, "CONNECTING", {
      enumerable: true,
      value: readyStates.indexOf("CONNECTING")
    });
    Object.defineProperty(WebSocket2, "OPEN", {
      enumerable: true,
      value: readyStates.indexOf("OPEN")
    });
    Object.defineProperty(WebSocket2.prototype, "OPEN", {
      enumerable: true,
      value: readyStates.indexOf("OPEN")
    });
    Object.defineProperty(WebSocket2, "CLOSING", {
      enumerable: true,
      value: readyStates.indexOf("CLOSING")
    });
    Object.defineProperty(WebSocket2.prototype, "CLOSING", {
      enumerable: true,
      value: readyStates.indexOf("CLOSING")
    });
    Object.defineProperty(WebSocket2, "CLOSED", {
      enumerable: true,
      value: readyStates.indexOf("CLOSED")
    });
    Object.defineProperty(WebSocket2.prototype, "CLOSED", {
      enumerable: true,
      value: readyStates.indexOf("CLOSED")
    });
    [
      "binaryType",
      "bufferedAmount",
      "extensions",
      "isPaused",
      "protocol",
      "readyState",
      "url"
    ].forEach((property) => {
      Object.defineProperty(WebSocket2.prototype, property, { enumerable: true });
    });
    ["open", "error", "close", "message"].forEach((method) => {
      Object.defineProperty(WebSocket2.prototype, `on${method}`, {
        enumerable: true,
        get() {
          for (const listener of this.listeners(method)) {
            if (listener[kForOnEventAttribute]) return listener[kListener];
          }
          return null;
        },
        set(handler) {
          for (const listener of this.listeners(method)) {
            if (listener[kForOnEventAttribute]) {
              this.removeListener(method, listener);
              break;
            }
          }
          if (typeof handler !== "function") return;
          this.addEventListener(method, handler, {
            [kForOnEventAttribute]: true
          });
        }
      });
    });
    WebSocket2.prototype.addEventListener = addEventListener;
    WebSocket2.prototype.removeEventListener = removeEventListener;
    module2.exports = WebSocket2;
    function initAsClient(websocket, address, protocols, options) {
      const opts = {
        allowSynchronousEvents: true,
        autoPong: true,
        closeTimeout: CLOSE_TIMEOUT,
        protocolVersion: protocolVersions[1],
        maxPayload: 100 * 1024 * 1024,
        skipUTF8Validation: false,
        perMessageDeflate: true,
        followRedirects: false,
        maxRedirects: 10,
        ...options,
        socketPath: void 0,
        hostname: void 0,
        protocol: void 0,
        timeout: void 0,
        method: "GET",
        host: void 0,
        path: void 0,
        port: void 0
      };
      websocket._autoPong = opts.autoPong;
      websocket._closeTimeout = opts.closeTimeout;
      if (!protocolVersions.includes(opts.protocolVersion)) {
        throw new RangeError(
          `Unsupported protocol version: ${opts.protocolVersion} (supported versions: ${protocolVersions.join(", ")})`
        );
      }
      let parsedUrl;
      if (address instanceof URL) {
        parsedUrl = address;
      } else {
        try {
          parsedUrl = new URL(address);
        } catch {
          throw new SyntaxError(`Invalid URL: ${address}`);
        }
      }
      if (parsedUrl.protocol === "http:") {
        parsedUrl.protocol = "ws:";
      } else if (parsedUrl.protocol === "https:") {
        parsedUrl.protocol = "wss:";
      }
      websocket._url = parsedUrl.href;
      const isSecure = parsedUrl.protocol === "wss:";
      const isIpcUrl = parsedUrl.protocol === "ws+unix:";
      let invalidUrlMessage;
      if (parsedUrl.protocol !== "ws:" && !isSecure && !isIpcUrl) {
        invalidUrlMessage = `The URL's protocol must be one of "ws:", "wss:", "http:", "https:", or "ws+unix:"`;
      } else if (isIpcUrl && !parsedUrl.pathname) {
        invalidUrlMessage = "The URL's pathname is empty";
      } else if (parsedUrl.hash) {
        invalidUrlMessage = "The URL contains a fragment identifier";
      }
      if (invalidUrlMessage) {
        const err = new SyntaxError(invalidUrlMessage);
        if (websocket._redirects === 0) {
          throw err;
        } else {
          emitErrorAndClose(websocket, err);
          return;
        }
      }
      const defaultPort = isSecure ? 443 : 80;
      const key = randomBytes2(16).toString("base64");
      const request = isSecure ? https.request : http.request;
      const protocolSet = /* @__PURE__ */ new Set();
      let perMessageDeflate;
      opts.createConnection = opts.createConnection || (isSecure ? tlsConnect : netConnect);
      opts.defaultPort = opts.defaultPort || defaultPort;
      opts.port = parsedUrl.port || defaultPort;
      opts.host = parsedUrl.hostname.startsWith("[") ? parsedUrl.hostname.slice(1, -1) : parsedUrl.hostname;
      opts.headers = {
        ...opts.headers,
        "Sec-WebSocket-Version": opts.protocolVersion,
        "Sec-WebSocket-Key": key,
        Connection: "Upgrade",
        Upgrade: "websocket"
      };
      opts.path = parsedUrl.pathname + parsedUrl.search;
      opts.timeout = opts.handshakeTimeout;
      if (opts.perMessageDeflate) {
        perMessageDeflate = new PerMessageDeflate2({
          ...opts.perMessageDeflate,
          isServer: false,
          maxPayload: opts.maxPayload
        });
        opts.headers["Sec-WebSocket-Extensions"] = format({
          [PerMessageDeflate2.extensionName]: perMessageDeflate.offer()
        });
      }
      if (protocols.length) {
        for (const protocol of protocols) {
          if (typeof protocol !== "string" || !subprotocolRegex.test(protocol) || protocolSet.has(protocol)) {
            throw new SyntaxError(
              "An invalid or duplicated subprotocol was specified"
            );
          }
          protocolSet.add(protocol);
        }
        opts.headers["Sec-WebSocket-Protocol"] = protocols.join(",");
      }
      if (opts.origin) {
        if (opts.protocolVersion < 13) {
          opts.headers["Sec-WebSocket-Origin"] = opts.origin;
        } else {
          opts.headers.Origin = opts.origin;
        }
      }
      if (parsedUrl.username || parsedUrl.password) {
        opts.auth = `${parsedUrl.username}:${parsedUrl.password}`;
      }
      if (isIpcUrl) {
        const parts = opts.path.split(":");
        opts.socketPath = parts[0];
        opts.path = parts[1];
      }
      let req;
      if (opts.followRedirects) {
        if (websocket._redirects === 0) {
          websocket._originalIpc = isIpcUrl;
          websocket._originalSecure = isSecure;
          websocket._originalHostOrSocketPath = isIpcUrl ? opts.socketPath : parsedUrl.host;
          const headers = options && options.headers;
          options = { ...options, headers: {} };
          if (headers) {
            for (const [key2, value] of Object.entries(headers)) {
              options.headers[key2.toLowerCase()] = value;
            }
          }
        } else if (websocket.listenerCount("redirect") === 0) {
          const isSameHost = isIpcUrl ? websocket._originalIpc ? opts.socketPath === websocket._originalHostOrSocketPath : false : websocket._originalIpc ? false : parsedUrl.host === websocket._originalHostOrSocketPath;
          if (!isSameHost || websocket._originalSecure && !isSecure) {
            delete opts.headers.authorization;
            delete opts.headers.cookie;
            if (!isSameHost) delete opts.headers.host;
            opts.auth = void 0;
          }
        }
        if (opts.auth && !options.headers.authorization) {
          options.headers.authorization = "Basic " + Buffer.from(opts.auth).toString("base64");
        }
        req = websocket._req = request(opts);
        if (websocket._redirects) {
          websocket.emit("redirect", websocket.url, req);
        }
      } else {
        req = websocket._req = request(opts);
      }
      if (opts.timeout) {
        req.on("timeout", () => {
          abortHandshake(websocket, req, "Opening handshake has timed out");
        });
      }
      req.on("error", (err) => {
        if (req === null || req[kAborted]) return;
        req = websocket._req = null;
        emitErrorAndClose(websocket, err);
      });
      req.on("response", (res) => {
        const location = res.headers.location;
        const statusCode = res.statusCode;
        if (location && opts.followRedirects && statusCode >= 300 && statusCode < 400) {
          if (++websocket._redirects > opts.maxRedirects) {
            abortHandshake(websocket, req, "Maximum redirects exceeded");
            return;
          }
          req.abort();
          let addr;
          try {
            addr = new URL(location, address);
          } catch (e) {
            const err = new SyntaxError(`Invalid URL: ${location}`);
            emitErrorAndClose(websocket, err);
            return;
          }
          initAsClient(websocket, addr, protocols, options);
        } else if (!websocket.emit("unexpected-response", req, res)) {
          abortHandshake(
            websocket,
            req,
            `Unexpected server response: ${res.statusCode}`
          );
        }
      });
      req.on("upgrade", (res, socket, head) => {
        websocket.emit("upgrade", res);
        if (websocket.readyState !== WebSocket2.CONNECTING) return;
        req = websocket._req = null;
        const upgrade = res.headers.upgrade;
        if (upgrade === void 0 || upgrade.toLowerCase() !== "websocket") {
          abortHandshake(websocket, socket, "Invalid Upgrade header");
          return;
        }
        const digest = createHash("sha1").update(key + GUID).digest("base64");
        if (res.headers["sec-websocket-accept"] !== digest) {
          abortHandshake(websocket, socket, "Invalid Sec-WebSocket-Accept header");
          return;
        }
        const serverProt = res.headers["sec-websocket-protocol"];
        let protError;
        if (serverProt !== void 0) {
          if (!protocolSet.size) {
            protError = "Server sent a subprotocol but none was requested";
          } else if (!protocolSet.has(serverProt)) {
            protError = "Server sent an invalid subprotocol";
          }
        } else if (protocolSet.size) {
          protError = "Server sent no subprotocol";
        }
        if (protError) {
          abortHandshake(websocket, socket, protError);
          return;
        }
        if (serverProt) websocket._protocol = serverProt;
        const secWebSocketExtensions = res.headers["sec-websocket-extensions"];
        if (secWebSocketExtensions !== void 0) {
          if (!perMessageDeflate) {
            const message = "Server sent a Sec-WebSocket-Extensions header but no extension was requested";
            abortHandshake(websocket, socket, message);
            return;
          }
          let extensions;
          try {
            extensions = parse(secWebSocketExtensions);
          } catch (err) {
            const message = "Invalid Sec-WebSocket-Extensions header";
            abortHandshake(websocket, socket, message);
            return;
          }
          const extensionNames = Object.keys(extensions);
          if (extensionNames.length !== 1 || extensionNames[0] !== PerMessageDeflate2.extensionName) {
            const message = "Server indicated an extension that was not requested";
            abortHandshake(websocket, socket, message);
            return;
          }
          try {
            perMessageDeflate.accept(extensions[PerMessageDeflate2.extensionName]);
          } catch (err) {
            const message = "Invalid Sec-WebSocket-Extensions header";
            abortHandshake(websocket, socket, message);
            return;
          }
          websocket._extensions[PerMessageDeflate2.extensionName] = perMessageDeflate;
        }
        websocket.setSocket(socket, head, {
          allowSynchronousEvents: opts.allowSynchronousEvents,
          generateMask: opts.generateMask,
          maxPayload: opts.maxPayload,
          skipUTF8Validation: opts.skipUTF8Validation
        });
      });
      if (opts.finishRequest) {
        opts.finishRequest(req, websocket);
      } else {
        req.end();
      }
    }
    function emitErrorAndClose(websocket, err) {
      websocket._readyState = WebSocket2.CLOSING;
      websocket._errorEmitted = true;
      websocket.emit("error", err);
      websocket.emitClose();
    }
    function netConnect(options) {
      options.path = options.socketPath;
      return net.connect(options);
    }
    function tlsConnect(options) {
      options.path = void 0;
      if (!options.servername && options.servername !== "") {
        options.servername = net.isIP(options.host) ? "" : options.host;
      }
      return tls.connect(options);
    }
    function abortHandshake(websocket, stream, message) {
      websocket._readyState = WebSocket2.CLOSING;
      const err = new Error(message);
      Error.captureStackTrace(err, abortHandshake);
      if (stream.setHeader) {
        stream[kAborted] = true;
        stream.abort();
        if (stream.socket && !stream.socket.destroyed) {
          stream.socket.destroy();
        }
        process.nextTick(emitErrorAndClose, websocket, err);
      } else {
        stream.destroy(err);
        stream.once("error", websocket.emit.bind(websocket, "error"));
        stream.once("close", websocket.emitClose.bind(websocket));
      }
    }
    function sendAfterClose(websocket, data, cb) {
      if (data) {
        const length = isBlob(data) ? data.size : toBuffer(data).length;
        if (websocket._socket) websocket._sender._bufferedBytes += length;
        else websocket._bufferedAmount += length;
      }
      if (cb) {
        const err = new Error(
          `WebSocket is not open: readyState ${websocket.readyState} (${readyStates[websocket.readyState]})`
        );
        process.nextTick(cb, err);
      }
    }
    function receiverOnConclude(code, reason) {
      const websocket = this[kWebSocket];
      websocket._closeFrameReceived = true;
      websocket._closeMessage = reason;
      websocket._closeCode = code;
      if (websocket._socket[kWebSocket] === void 0) return;
      websocket._socket.removeListener("data", socketOnData);
      process.nextTick(resume, websocket._socket);
      if (code === 1005) websocket.close();
      else websocket.close(code, reason);
    }
    function receiverOnDrain() {
      const websocket = this[kWebSocket];
      if (!websocket.isPaused) websocket._socket.resume();
    }
    function receiverOnError(err) {
      const websocket = this[kWebSocket];
      if (websocket._socket[kWebSocket] !== void 0) {
        websocket._socket.removeListener("data", socketOnData);
        process.nextTick(resume, websocket._socket);
        websocket.close(err[kStatusCode]);
      }
      if (!websocket._errorEmitted) {
        websocket._errorEmitted = true;
        websocket.emit("error", err);
      }
    }
    function receiverOnFinish() {
      this[kWebSocket].emitClose();
    }
    function receiverOnMessage(data, isBinary) {
      this[kWebSocket].emit("message", data, isBinary);
    }
    function receiverOnPing(data) {
      const websocket = this[kWebSocket];
      if (websocket._autoPong) websocket.pong(data, !this._isServer, NOOP);
      websocket.emit("ping", data);
    }
    function receiverOnPong(data) {
      this[kWebSocket].emit("pong", data);
    }
    function resume(stream) {
      stream.resume();
    }
    function senderOnError(err) {
      const websocket = this[kWebSocket];
      if (websocket.readyState === WebSocket2.CLOSED) return;
      if (websocket.readyState === WebSocket2.OPEN) {
        websocket._readyState = WebSocket2.CLOSING;
        setCloseTimer(websocket);
      }
      this._socket.end();
      if (!websocket._errorEmitted) {
        websocket._errorEmitted = true;
        websocket.emit("error", err);
      }
    }
    function setCloseTimer(websocket) {
      websocket._closeTimer = setTimeout(
        websocket._socket.destroy.bind(websocket._socket),
        websocket._closeTimeout
      );
    }
    function socketOnClose() {
      const websocket = this[kWebSocket];
      this.removeListener("close", socketOnClose);
      this.removeListener("data", socketOnData);
      this.removeListener("end", socketOnEnd);
      websocket._readyState = WebSocket2.CLOSING;
      if (!this._readableState.endEmitted && !websocket._closeFrameReceived && !websocket._receiver._writableState.errorEmitted && this._readableState.length !== 0) {
        const chunk = this.read(this._readableState.length);
        websocket._receiver.write(chunk);
      }
      websocket._receiver.end();
      this[kWebSocket] = void 0;
      clearTimeout(websocket._closeTimer);
      if (websocket._receiver._writableState.finished || websocket._receiver._writableState.errorEmitted) {
        websocket.emitClose();
      } else {
        websocket._receiver.on("error", receiverOnFinish);
        websocket._receiver.on("finish", receiverOnFinish);
      }
    }
    function socketOnData(chunk) {
      if (!this[kWebSocket]._receiver.write(chunk)) {
        this.pause();
      }
    }
    function socketOnEnd() {
      const websocket = this[kWebSocket];
      websocket._readyState = WebSocket2.CLOSING;
      websocket._receiver.end();
      this.end();
    }
    function socketOnError() {
      const websocket = this[kWebSocket];
      this.removeListener("error", socketOnError);
      this.on("error", NOOP);
      if (websocket) {
        websocket._readyState = WebSocket2.CLOSING;
        this.destroy();
      }
    }
  }
});

// node_modules/.pnpm/ws@8.20.0/node_modules/ws/lib/stream.js
var require_stream = __commonJS({
  "node_modules/.pnpm/ws@8.20.0/node_modules/ws/lib/stream.js"(exports2, module2) {
    "use strict";
    var WebSocket2 = require_websocket();
    var { Duplex } = require("stream");
    function emitClose(stream) {
      stream.emit("close");
    }
    function duplexOnEnd() {
      if (!this.destroyed && this._writableState.finished) {
        this.destroy();
      }
    }
    function duplexOnError(err) {
      this.removeListener("error", duplexOnError);
      this.destroy();
      if (this.listenerCount("error") === 0) {
        this.emit("error", err);
      }
    }
    function createWebSocketStream2(ws, options) {
      let terminateOnDestroy = true;
      const duplex = new Duplex({
        ...options,
        autoDestroy: false,
        emitClose: false,
        objectMode: false,
        writableObjectMode: false
      });
      ws.on("message", function message(msg, isBinary) {
        const data = !isBinary && duplex._readableState.objectMode ? msg.toString() : msg;
        if (!duplex.push(data)) ws.pause();
      });
      ws.once("error", function error(err) {
        if (duplex.destroyed) return;
        terminateOnDestroy = false;
        duplex.destroy(err);
      });
      ws.once("close", function close() {
        if (duplex.destroyed) return;
        duplex.push(null);
      });
      duplex._destroy = function(err, callback) {
        if (ws.readyState === ws.CLOSED) {
          callback(err);
          process.nextTick(emitClose, duplex);
          return;
        }
        let called = false;
        ws.once("error", function error(err2) {
          called = true;
          callback(err2);
        });
        ws.once("close", function close() {
          if (!called) callback(err);
          process.nextTick(emitClose, duplex);
        });
        if (terminateOnDestroy) ws.terminate();
      };
      duplex._final = function(callback) {
        if (ws.readyState === ws.CONNECTING) {
          ws.once("open", function open() {
            duplex._final(callback);
          });
          return;
        }
        if (ws._socket === null) return;
        if (ws._socket._writableState.finished) {
          callback();
          if (duplex._readableState.endEmitted) duplex.destroy();
        } else {
          ws._socket.once("finish", function finish() {
            callback();
          });
          ws.close();
        }
      };
      duplex._read = function() {
        if (ws.isPaused) ws.resume();
      };
      duplex._write = function(chunk, encoding, callback) {
        if (ws.readyState === ws.CONNECTING) {
          ws.once("open", function open() {
            duplex._write(chunk, encoding, callback);
          });
          return;
        }
        ws.send(chunk, callback);
      };
      duplex.on("end", duplexOnEnd);
      duplex.on("error", duplexOnError);
      return duplex;
    }
    module2.exports = createWebSocketStream2;
  }
});

// node_modules/.pnpm/ws@8.20.0/node_modules/ws/lib/subprotocol.js
var require_subprotocol = __commonJS({
  "node_modules/.pnpm/ws@8.20.0/node_modules/ws/lib/subprotocol.js"(exports2, module2) {
    "use strict";
    var { tokenChars } = require_validation();
    function parse(header) {
      const protocols = /* @__PURE__ */ new Set();
      let start = -1;
      let end = -1;
      let i = 0;
      for (i; i < header.length; i++) {
        const code = header.charCodeAt(i);
        if (end === -1 && tokenChars[code] === 1) {
          if (start === -1) start = i;
        } else if (i !== 0 && (code === 32 || code === 9)) {
          if (end === -1 && start !== -1) end = i;
        } else if (code === 44) {
          if (start === -1) {
            throw new SyntaxError(`Unexpected character at index ${i}`);
          }
          if (end === -1) end = i;
          const protocol2 = header.slice(start, end);
          if (protocols.has(protocol2)) {
            throw new SyntaxError(`The "${protocol2}" subprotocol is duplicated`);
          }
          protocols.add(protocol2);
          start = end = -1;
        } else {
          throw new SyntaxError(`Unexpected character at index ${i}`);
        }
      }
      if (start === -1 || end !== -1) {
        throw new SyntaxError("Unexpected end of input");
      }
      const protocol = header.slice(start, i);
      if (protocols.has(protocol)) {
        throw new SyntaxError(`The "${protocol}" subprotocol is duplicated`);
      }
      protocols.add(protocol);
      return protocols;
    }
    module2.exports = { parse };
  }
});

// node_modules/.pnpm/ws@8.20.0/node_modules/ws/lib/websocket-server.js
var require_websocket_server = __commonJS({
  "node_modules/.pnpm/ws@8.20.0/node_modules/ws/lib/websocket-server.js"(exports2, module2) {
    "use strict";
    var EventEmitter = require("events");
    var http = require("http");
    var { Duplex } = require("stream");
    var { createHash } = require("crypto");
    var extension2 = require_extension();
    var PerMessageDeflate2 = require_permessage_deflate();
    var subprotocol2 = require_subprotocol();
    var WebSocket2 = require_websocket();
    var { CLOSE_TIMEOUT, GUID, kWebSocket } = require_constants();
    var keyRegex = /^[+/0-9A-Za-z]{22}==$/;
    var RUNNING = 0;
    var CLOSING = 1;
    var CLOSED = 2;
    var WebSocketServer2 = class extends EventEmitter {
      /**
       * Create a `WebSocketServer` instance.
       *
       * @param {Object} options Configuration options
       * @param {Boolean} [options.allowSynchronousEvents=true] Specifies whether
       *     any of the `'message'`, `'ping'`, and `'pong'` events can be emitted
       *     multiple times in the same tick
       * @param {Boolean} [options.autoPong=true] Specifies whether or not to
       *     automatically send a pong in response to a ping
       * @param {Number} [options.backlog=511] The maximum length of the queue of
       *     pending connections
       * @param {Boolean} [options.clientTracking=true] Specifies whether or not to
       *     track clients
       * @param {Number} [options.closeTimeout=30000] Duration in milliseconds to
       *     wait for the closing handshake to finish after `websocket.close()` is
       *     called
       * @param {Function} [options.handleProtocols] A hook to handle protocols
       * @param {String} [options.host] The hostname where to bind the server
       * @param {Number} [options.maxPayload=104857600] The maximum allowed message
       *     size
       * @param {Boolean} [options.noServer=false] Enable no server mode
       * @param {String} [options.path] Accept only connections matching this path
       * @param {(Boolean|Object)} [options.perMessageDeflate=false] Enable/disable
       *     permessage-deflate
       * @param {Number} [options.port] The port where to bind the server
       * @param {(http.Server|https.Server)} [options.server] A pre-created HTTP/S
       *     server to use
       * @param {Boolean} [options.skipUTF8Validation=false] Specifies whether or
       *     not to skip UTF-8 validation for text and close messages
       * @param {Function} [options.verifyClient] A hook to reject connections
       * @param {Function} [options.WebSocket=WebSocket] Specifies the `WebSocket`
       *     class to use. It must be the `WebSocket` class or class that extends it
       * @param {Function} [callback] A listener for the `listening` event
       */
      constructor(options, callback) {
        super();
        options = {
          allowSynchronousEvents: true,
          autoPong: true,
          maxPayload: 100 * 1024 * 1024,
          skipUTF8Validation: false,
          perMessageDeflate: false,
          handleProtocols: null,
          clientTracking: true,
          closeTimeout: CLOSE_TIMEOUT,
          verifyClient: null,
          noServer: false,
          backlog: null,
          // use default (511 as implemented in net.js)
          server: null,
          host: null,
          path: null,
          port: null,
          WebSocket: WebSocket2,
          ...options
        };
        if (options.port == null && !options.server && !options.noServer || options.port != null && (options.server || options.noServer) || options.server && options.noServer) {
          throw new TypeError(
            'One and only one of the "port", "server", or "noServer" options must be specified'
          );
        }
        if (options.port != null) {
          this._server = http.createServer((req, res) => {
            const body = http.STATUS_CODES[426];
            res.writeHead(426, {
              "Content-Length": body.length,
              "Content-Type": "text/plain"
            });
            res.end(body);
          });
          this._server.listen(
            options.port,
            options.host,
            options.backlog,
            callback
          );
        } else if (options.server) {
          this._server = options.server;
        }
        if (this._server) {
          const emitConnection = this.emit.bind(this, "connection");
          this._removeListeners = addListeners(this._server, {
            listening: this.emit.bind(this, "listening"),
            error: this.emit.bind(this, "error"),
            upgrade: (req, socket, head) => {
              this.handleUpgrade(req, socket, head, emitConnection);
            }
          });
        }
        if (options.perMessageDeflate === true) options.perMessageDeflate = {};
        if (options.clientTracking) {
          this.clients = /* @__PURE__ */ new Set();
          this._shouldEmitClose = false;
        }
        this.options = options;
        this._state = RUNNING;
      }
      /**
       * Returns the bound address, the address family name, and port of the server
       * as reported by the operating system if listening on an IP socket.
       * If the server is listening on a pipe or UNIX domain socket, the name is
       * returned as a string.
       *
       * @return {(Object|String|null)} The address of the server
       * @public
       */
      address() {
        if (this.options.noServer) {
          throw new Error('The server is operating in "noServer" mode');
        }
        if (!this._server) return null;
        return this._server.address();
      }
      /**
       * Stop the server from accepting new connections and emit the `'close'` event
       * when all existing connections are closed.
       *
       * @param {Function} [cb] A one-time listener for the `'close'` event
       * @public
       */
      close(cb) {
        if (this._state === CLOSED) {
          if (cb) {
            this.once("close", () => {
              cb(new Error("The server is not running"));
            });
          }
          process.nextTick(emitClose, this);
          return;
        }
        if (cb) this.once("close", cb);
        if (this._state === CLOSING) return;
        this._state = CLOSING;
        if (this.options.noServer || this.options.server) {
          if (this._server) {
            this._removeListeners();
            this._removeListeners = this._server = null;
          }
          if (this.clients) {
            if (!this.clients.size) {
              process.nextTick(emitClose, this);
            } else {
              this._shouldEmitClose = true;
            }
          } else {
            process.nextTick(emitClose, this);
          }
        } else {
          const server2 = this._server;
          this._removeListeners();
          this._removeListeners = this._server = null;
          server2.close(() => {
            emitClose(this);
          });
        }
      }
      /**
       * See if a given request should be handled by this server instance.
       *
       * @param {http.IncomingMessage} req Request object to inspect
       * @return {Boolean} `true` if the request is valid, else `false`
       * @public
       */
      shouldHandle(req) {
        if (this.options.path) {
          const index = req.url.indexOf("?");
          const pathname = index !== -1 ? req.url.slice(0, index) : req.url;
          if (pathname !== this.options.path) return false;
        }
        return true;
      }
      /**
       * Handle a HTTP Upgrade request.
       *
       * @param {http.IncomingMessage} req The request object
       * @param {Duplex} socket The network socket between the server and client
       * @param {Buffer} head The first packet of the upgraded stream
       * @param {Function} cb Callback
       * @public
       */
      handleUpgrade(req, socket, head, cb) {
        socket.on("error", socketOnError);
        const key = req.headers["sec-websocket-key"];
        const upgrade = req.headers.upgrade;
        const version = +req.headers["sec-websocket-version"];
        if (req.method !== "GET") {
          const message = "Invalid HTTP method";
          abortHandshakeOrEmitwsClientError(this, req, socket, 405, message);
          return;
        }
        if (upgrade === void 0 || upgrade.toLowerCase() !== "websocket") {
          const message = "Invalid Upgrade header";
          abortHandshakeOrEmitwsClientError(this, req, socket, 400, message);
          return;
        }
        if (key === void 0 || !keyRegex.test(key)) {
          const message = "Missing or invalid Sec-WebSocket-Key header";
          abortHandshakeOrEmitwsClientError(this, req, socket, 400, message);
          return;
        }
        if (version !== 13 && version !== 8) {
          const message = "Missing or invalid Sec-WebSocket-Version header";
          abortHandshakeOrEmitwsClientError(this, req, socket, 400, message, {
            "Sec-WebSocket-Version": "13, 8"
          });
          return;
        }
        if (!this.shouldHandle(req)) {
          abortHandshake(socket, 400);
          return;
        }
        const secWebSocketProtocol = req.headers["sec-websocket-protocol"];
        let protocols = /* @__PURE__ */ new Set();
        if (secWebSocketProtocol !== void 0) {
          try {
            protocols = subprotocol2.parse(secWebSocketProtocol);
          } catch (err) {
            const message = "Invalid Sec-WebSocket-Protocol header";
            abortHandshakeOrEmitwsClientError(this, req, socket, 400, message);
            return;
          }
        }
        const secWebSocketExtensions = req.headers["sec-websocket-extensions"];
        const extensions = {};
        if (this.options.perMessageDeflate && secWebSocketExtensions !== void 0) {
          const perMessageDeflate = new PerMessageDeflate2({
            ...this.options.perMessageDeflate,
            isServer: true,
            maxPayload: this.options.maxPayload
          });
          try {
            const offers = extension2.parse(secWebSocketExtensions);
            if (offers[PerMessageDeflate2.extensionName]) {
              perMessageDeflate.accept(offers[PerMessageDeflate2.extensionName]);
              extensions[PerMessageDeflate2.extensionName] = perMessageDeflate;
            }
          } catch (err) {
            const message = "Invalid or unacceptable Sec-WebSocket-Extensions header";
            abortHandshakeOrEmitwsClientError(this, req, socket, 400, message);
            return;
          }
        }
        if (this.options.verifyClient) {
          const info = {
            origin: req.headers[`${version === 8 ? "sec-websocket-origin" : "origin"}`],
            secure: !!(req.socket.authorized || req.socket.encrypted),
            req
          };
          if (this.options.verifyClient.length === 2) {
            this.options.verifyClient(info, (verified, code, message, headers) => {
              if (!verified) {
                return abortHandshake(socket, code || 401, message, headers);
              }
              this.completeUpgrade(
                extensions,
                key,
                protocols,
                req,
                socket,
                head,
                cb
              );
            });
            return;
          }
          if (!this.options.verifyClient(info)) return abortHandshake(socket, 401);
        }
        this.completeUpgrade(extensions, key, protocols, req, socket, head, cb);
      }
      /**
       * Upgrade the connection to WebSocket.
       *
       * @param {Object} extensions The accepted extensions
       * @param {String} key The value of the `Sec-WebSocket-Key` header
       * @param {Set} protocols The subprotocols
       * @param {http.IncomingMessage} req The request object
       * @param {Duplex} socket The network socket between the server and client
       * @param {Buffer} head The first packet of the upgraded stream
       * @param {Function} cb Callback
       * @throws {Error} If called more than once with the same socket
       * @private
       */
      completeUpgrade(extensions, key, protocols, req, socket, head, cb) {
        if (!socket.readable || !socket.writable) return socket.destroy();
        if (socket[kWebSocket]) {
          throw new Error(
            "server.handleUpgrade() was called more than once with the same socket, possibly due to a misconfiguration"
          );
        }
        if (this._state > RUNNING) return abortHandshake(socket, 503);
        const digest = createHash("sha1").update(key + GUID).digest("base64");
        const headers = [
          "HTTP/1.1 101 Switching Protocols",
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Accept: ${digest}`
        ];
        const ws = new this.options.WebSocket(null, void 0, this.options);
        if (protocols.size) {
          const protocol = this.options.handleProtocols ? this.options.handleProtocols(protocols, req) : protocols.values().next().value;
          if (protocol) {
            headers.push(`Sec-WebSocket-Protocol: ${protocol}`);
            ws._protocol = protocol;
          }
        }
        if (extensions[PerMessageDeflate2.extensionName]) {
          const params = extensions[PerMessageDeflate2.extensionName].params;
          const value = extension2.format({
            [PerMessageDeflate2.extensionName]: [params]
          });
          headers.push(`Sec-WebSocket-Extensions: ${value}`);
          ws._extensions = extensions;
        }
        this.emit("headers", headers, req);
        socket.write(headers.concat("\r\n").join("\r\n"));
        socket.removeListener("error", socketOnError);
        ws.setSocket(socket, head, {
          allowSynchronousEvents: this.options.allowSynchronousEvents,
          maxPayload: this.options.maxPayload,
          skipUTF8Validation: this.options.skipUTF8Validation
        });
        if (this.clients) {
          this.clients.add(ws);
          ws.on("close", () => {
            this.clients.delete(ws);
            if (this._shouldEmitClose && !this.clients.size) {
              process.nextTick(emitClose, this);
            }
          });
        }
        cb(ws, req);
      }
    };
    module2.exports = WebSocketServer2;
    function addListeners(server2, map) {
      for (const event of Object.keys(map)) server2.on(event, map[event]);
      return function removeListeners() {
        for (const event of Object.keys(map)) {
          server2.removeListener(event, map[event]);
        }
      };
    }
    function emitClose(server2) {
      server2._state = CLOSED;
      server2.emit("close");
    }
    function socketOnError() {
      this.destroy();
    }
    function abortHandshake(socket, code, message, headers) {
      message = message || http.STATUS_CODES[code];
      headers = {
        Connection: "close",
        "Content-Type": "text/html",
        "Content-Length": Buffer.byteLength(message),
        ...headers
      };
      socket.once("finish", socket.destroy);
      socket.end(
        `HTTP/1.1 ${code} ${http.STATUS_CODES[code]}\r
` + Object.keys(headers).map((h) => `${h}: ${headers[h]}`).join("\r\n") + "\r\n\r\n" + message
      );
    }
    function abortHandshakeOrEmitwsClientError(server2, req, socket, code, message, headers) {
      if (server2.listenerCount("wsClientError")) {
        const err = new Error(message);
        Error.captureStackTrace(err, abortHandshakeOrEmitwsClientError);
        server2.emit("wsClientError", err, socket, req);
      } else {
        abortHandshake(socket, code, message, headers);
      }
    }
  }
});

// node_modules/.pnpm/object-assign@4.1.1/node_modules/object-assign/index.js
var require_object_assign = __commonJS({
  "node_modules/.pnpm/object-assign@4.1.1/node_modules/object-assign/index.js"(exports2, module2) {
    "use strict";
    var getOwnPropertySymbols = Object.getOwnPropertySymbols;
    var hasOwnProperty = Object.prototype.hasOwnProperty;
    var propIsEnumerable = Object.prototype.propertyIsEnumerable;
    function toObject(val) {
      if (val === null || val === void 0) {
        throw new TypeError("Object.assign cannot be called with null or undefined");
      }
      return Object(val);
    }
    function shouldUseNative() {
      try {
        if (!Object.assign) {
          return false;
        }
        var test1 = new String("abc");
        test1[5] = "de";
        if (Object.getOwnPropertyNames(test1)[0] === "5") {
          return false;
        }
        var test2 = {};
        for (var i = 0; i < 10; i++) {
          test2["_" + String.fromCharCode(i)] = i;
        }
        var order2 = Object.getOwnPropertyNames(test2).map(function(n) {
          return test2[n];
        });
        if (order2.join("") !== "0123456789") {
          return false;
        }
        var test3 = {};
        "abcdefghijklmnopqrst".split("").forEach(function(letter) {
          test3[letter] = letter;
        });
        if (Object.keys(Object.assign({}, test3)).join("") !== "abcdefghijklmnopqrst") {
          return false;
        }
        return true;
      } catch (err) {
        return false;
      }
    }
    module2.exports = shouldUseNative() ? Object.assign : function(target, source) {
      var from;
      var to = toObject(target);
      var symbols;
      for (var s = 1; s < arguments.length; s++) {
        from = Object(arguments[s]);
        for (var key in from) {
          if (hasOwnProperty.call(from, key)) {
            to[key] = from[key];
          }
        }
        if (getOwnPropertySymbols) {
          symbols = getOwnPropertySymbols(from);
          for (var i = 0; i < symbols.length; i++) {
            if (propIsEnumerable.call(from, symbols[i])) {
              to[symbols[i]] = from[symbols[i]];
            }
          }
        }
      }
      return to;
    };
  }
});

// node_modules/.pnpm/vary@1.1.2/node_modules/vary/index.js
var require_vary = __commonJS({
  "node_modules/.pnpm/vary@1.1.2/node_modules/vary/index.js"(exports2, module2) {
    "use strict";
    module2.exports = vary;
    module2.exports.append = append;
    var FIELD_NAME_REGEXP = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
    function append(header, field) {
      if (typeof header !== "string") {
        throw new TypeError("header argument is required");
      }
      if (!field) {
        throw new TypeError("field argument is required");
      }
      var fields = !Array.isArray(field) ? parse(String(field)) : field;
      for (var j = 0; j < fields.length; j++) {
        if (!FIELD_NAME_REGEXP.test(fields[j])) {
          throw new TypeError("field argument contains an invalid header name");
        }
      }
      if (header === "*") {
        return header;
      }
      var val = header;
      var vals = parse(header.toLowerCase());
      if (fields.indexOf("*") !== -1 || vals.indexOf("*") !== -1) {
        return "*";
      }
      for (var i = 0; i < fields.length; i++) {
        var fld = fields[i].toLowerCase();
        if (vals.indexOf(fld) === -1) {
          vals.push(fld);
          val = val ? val + ", " + fields[i] : fields[i];
        }
      }
      return val;
    }
    function parse(header) {
      var end = 0;
      var list = [];
      var start = 0;
      for (var i = 0, len = header.length; i < len; i++) {
        switch (header.charCodeAt(i)) {
          case 32:
            if (start === end) {
              start = end = i + 1;
            }
            break;
          case 44:
            list.push(header.substring(start, end));
            start = end = i + 1;
            break;
          default:
            end = i + 1;
            break;
        }
      }
      list.push(header.substring(start, end));
      return list;
    }
    function vary(res, field) {
      if (!res || !res.getHeader || !res.setHeader) {
        throw new TypeError("res argument is required");
      }
      var val = res.getHeader("Vary") || "";
      var header = Array.isArray(val) ? val.join(", ") : String(val);
      if (val = append(header, field)) {
        res.setHeader("Vary", val);
      }
    }
  }
});

// node_modules/.pnpm/cors@2.8.6/node_modules/cors/lib/index.js
var require_lib = __commonJS({
  "node_modules/.pnpm/cors@2.8.6/node_modules/cors/lib/index.js"(exports2, module2) {
    (function() {
      "use strict";
      var assign = require_object_assign();
      var vary = require_vary();
      var defaults = {
        origin: "*",
        methods: "GET,HEAD,PUT,PATCH,POST,DELETE",
        preflightContinue: false,
        optionsSuccessStatus: 204
      };
      function isString(s) {
        return typeof s === "string" || s instanceof String;
      }
      function isOriginAllowed(origin, allowedOrigin) {
        if (Array.isArray(allowedOrigin)) {
          for (var i = 0; i < allowedOrigin.length; ++i) {
            if (isOriginAllowed(origin, allowedOrigin[i])) {
              return true;
            }
          }
          return false;
        } else if (isString(allowedOrigin)) {
          return origin === allowedOrigin;
        } else if (allowedOrigin instanceof RegExp) {
          return allowedOrigin.test(origin);
        } else {
          return !!allowedOrigin;
        }
      }
      function configureOrigin(options, req) {
        var requestOrigin = req.headers.origin, headers = [], isAllowed;
        if (!options.origin || options.origin === "*") {
          headers.push([{
            key: "Access-Control-Allow-Origin",
            value: "*"
          }]);
        } else if (isString(options.origin)) {
          headers.push([{
            key: "Access-Control-Allow-Origin",
            value: options.origin
          }]);
          headers.push([{
            key: "Vary",
            value: "Origin"
          }]);
        } else {
          isAllowed = isOriginAllowed(requestOrigin, options.origin);
          headers.push([{
            key: "Access-Control-Allow-Origin",
            value: isAllowed ? requestOrigin : false
          }]);
          headers.push([{
            key: "Vary",
            value: "Origin"
          }]);
        }
        return headers;
      }
      function configureMethods(options) {
        var methods = options.methods;
        if (methods.join) {
          methods = options.methods.join(",");
        }
        return {
          key: "Access-Control-Allow-Methods",
          value: methods
        };
      }
      function configureCredentials(options) {
        if (options.credentials === true) {
          return {
            key: "Access-Control-Allow-Credentials",
            value: "true"
          };
        }
        return null;
      }
      function configureAllowedHeaders(options, req) {
        var allowedHeaders = options.allowedHeaders || options.headers;
        var headers = [];
        if (!allowedHeaders) {
          allowedHeaders = req.headers["access-control-request-headers"];
          headers.push([{
            key: "Vary",
            value: "Access-Control-Request-Headers"
          }]);
        } else if (allowedHeaders.join) {
          allowedHeaders = allowedHeaders.join(",");
        }
        if (allowedHeaders && allowedHeaders.length) {
          headers.push([{
            key: "Access-Control-Allow-Headers",
            value: allowedHeaders
          }]);
        }
        return headers;
      }
      function configureExposedHeaders(options) {
        var headers = options.exposedHeaders;
        if (!headers) {
          return null;
        } else if (headers.join) {
          headers = headers.join(",");
        }
        if (headers && headers.length) {
          return {
            key: "Access-Control-Expose-Headers",
            value: headers
          };
        }
        return null;
      }
      function configureMaxAge(options) {
        var maxAge = (typeof options.maxAge === "number" || options.maxAge) && options.maxAge.toString();
        if (maxAge && maxAge.length) {
          return {
            key: "Access-Control-Max-Age",
            value: maxAge
          };
        }
        return null;
      }
      function applyHeaders(headers, res) {
        for (var i = 0, n = headers.length; i < n; i++) {
          var header = headers[i];
          if (header) {
            if (Array.isArray(header)) {
              applyHeaders(header, res);
            } else if (header.key === "Vary" && header.value) {
              vary(res, header.value);
            } else if (header.value) {
              res.setHeader(header.key, header.value);
            }
          }
        }
      }
      function cors2(options, req, res, next) {
        var headers = [], method = req.method && req.method.toUpperCase && req.method.toUpperCase();
        if (method === "OPTIONS") {
          headers.push(configureOrigin(options, req));
          headers.push(configureCredentials(options));
          headers.push(configureMethods(options));
          headers.push(configureAllowedHeaders(options, req));
          headers.push(configureMaxAge(options));
          headers.push(configureExposedHeaders(options));
          applyHeaders(headers, res);
          if (options.preflightContinue) {
            next();
          } else {
            res.statusCode = options.optionsSuccessStatus;
            res.setHeader("Content-Length", "0");
            res.end();
          }
        } else {
          headers.push(configureOrigin(options, req));
          headers.push(configureCredentials(options));
          headers.push(configureExposedHeaders(options));
          applyHeaders(headers, res);
          next();
        }
      }
      function middlewareWrapper(o) {
        var optionsCallback = null;
        if (typeof o === "function") {
          optionsCallback = o;
        } else {
          optionsCallback = function(req, cb) {
            cb(null, o);
          };
        }
        return function corsMiddleware(req, res, next) {
          optionsCallback(req, function(err, options) {
            if (err) {
              next(err);
            } else {
              var corsOptions = assign({}, defaults, options);
              var originCallback = null;
              if (corsOptions.origin && typeof corsOptions.origin === "function") {
                originCallback = corsOptions.origin;
              } else if (corsOptions.origin) {
                originCallback = function(origin, cb) {
                  cb(null, corsOptions.origin);
                };
              }
              if (originCallback) {
                originCallback(req.headers.origin, function(err2, origin) {
                  if (err2 || !origin) {
                    next(err2);
                  } else {
                    corsOptions.origin = origin;
                    cors2(corsOptions, req, res, next);
                  }
                });
              } else {
                next();
              }
            }
          });
        };
      }
      module2.exports = middlewareWrapper;
    })();
  }
});

// server/index.ts
var index_exports = {};
__export(index_exports, {
  app: () => app,
  server: () => server,
  wss: () => wss
});
module.exports = __toCommonJS(index_exports);
var import_express = __toESM(require("express"));
var import_http = require("http");

// node_modules/.pnpm/ws@8.20.0/node_modules/ws/wrapper.mjs
var import_stream = __toESM(require_stream(), 1);
var import_extension = __toESM(require_extension(), 1);
var import_permessage_deflate = __toESM(require_permessage_deflate(), 1);
var import_receiver = __toESM(require_receiver(), 1);
var import_sender = __toESM(require_sender(), 1);
var import_subprotocol = __toESM(require_subprotocol(), 1);
var import_websocket = __toESM(require_websocket(), 1);
var import_websocket_server = __toESM(require_websocket_server(), 1);

// node_modules/.pnpm/uuid@13.0.0/node_modules/uuid/dist-node/stringify.js
var byteToHex = [];
for (let i = 0; i < 256; ++i) {
  byteToHex.push((i + 256).toString(16).slice(1));
}
function unsafeStringify(arr, offset = 0) {
  return (byteToHex[arr[offset + 0]] + byteToHex[arr[offset + 1]] + byteToHex[arr[offset + 2]] + byteToHex[arr[offset + 3]] + "-" + byteToHex[arr[offset + 4]] + byteToHex[arr[offset + 5]] + "-" + byteToHex[arr[offset + 6]] + byteToHex[arr[offset + 7]] + "-" + byteToHex[arr[offset + 8]] + byteToHex[arr[offset + 9]] + "-" + byteToHex[arr[offset + 10]] + byteToHex[arr[offset + 11]] + byteToHex[arr[offset + 12]] + byteToHex[arr[offset + 13]] + byteToHex[arr[offset + 14]] + byteToHex[arr[offset + 15]]).toLowerCase();
}

// node_modules/.pnpm/uuid@13.0.0/node_modules/uuid/dist-node/rng.js
var import_node_crypto = require("node:crypto");
var rnds8Pool = new Uint8Array(256);
var poolPtr = rnds8Pool.length;
function rng() {
  if (poolPtr > rnds8Pool.length - 16) {
    (0, import_node_crypto.randomFillSync)(rnds8Pool);
    poolPtr = 0;
  }
  return rnds8Pool.slice(poolPtr, poolPtr += 16);
}

// node_modules/.pnpm/uuid@13.0.0/node_modules/uuid/dist-node/native.js
var import_node_crypto2 = require("node:crypto");
var native_default = { randomUUID: import_node_crypto2.randomUUID };

// node_modules/.pnpm/uuid@13.0.0/node_modules/uuid/dist-node/v4.js
function _v4(options, buf, offset) {
  options = options || {};
  const rnds = options.random ?? options.rng?.() ?? rng();
  if (rnds.length < 16) {
    throw new Error("Random bytes length must be >= 16");
  }
  rnds[6] = rnds[6] & 15 | 64;
  rnds[8] = rnds[8] & 63 | 128;
  if (buf) {
    offset = offset || 0;
    if (offset < 0 || offset + 16 > buf.length) {
      throw new RangeError(`UUID byte range ${offset}:${offset + 15} is out of buffer bounds`);
    }
    for (let i = 0; i < 16; ++i) {
      buf[offset + i] = rnds[i];
    }
    return buf;
  }
  return unsafeStringify(rnds);
}
function v4(options, buf, offset) {
  if (native_default.randomUUID && !buf && !options) {
    return native_default.randomUUID();
  }
  return _v4(options, buf, offset);
}
var v4_default = v4;

// server/index.ts
var import_cors = __toESM(require_lib());
var import_path = __toESM(require("path"));

// node_modules/.pnpm/bcryptjs@3.0.3/node_modules/bcryptjs/index.js
var import_crypto = __toESM(require("crypto"), 1);
var randomFallback = null;
function randomBytes(len) {
  try {
    return crypto.getRandomValues(new Uint8Array(len));
  } catch {
  }
  try {
    return import_crypto.default.randomBytes(len);
  } catch {
  }
  if (!randomFallback) {
    throw Error(
      "Neither WebCryptoAPI nor a crypto module is available. Use bcrypt.setRandomFallback to set an alternative"
    );
  }
  return randomFallback(len);
}
function setRandomFallback(random) {
  randomFallback = random;
}
function genSaltSync(rounds, seed_length) {
  rounds = rounds || GENSALT_DEFAULT_LOG2_ROUNDS;
  if (typeof rounds !== "number")
    throw Error(
      "Illegal arguments: " + typeof rounds + ", " + typeof seed_length
    );
  if (rounds < 4) rounds = 4;
  else if (rounds > 31) rounds = 31;
  var salt = [];
  salt.push("$2b$");
  if (rounds < 10) salt.push("0");
  salt.push(rounds.toString());
  salt.push("$");
  salt.push(base64_encode(randomBytes(BCRYPT_SALT_LEN), BCRYPT_SALT_LEN));
  return salt.join("");
}
function genSalt(rounds, seed_length, callback) {
  if (typeof seed_length === "function")
    callback = seed_length, seed_length = void 0;
  if (typeof rounds === "function") callback = rounds, rounds = void 0;
  if (typeof rounds === "undefined") rounds = GENSALT_DEFAULT_LOG2_ROUNDS;
  else if (typeof rounds !== "number")
    throw Error("illegal arguments: " + typeof rounds);
  function _async(callback2) {
    nextTick(function() {
      try {
        callback2(null, genSaltSync(rounds));
      } catch (err) {
        callback2(err);
      }
    });
  }
  if (callback) {
    if (typeof callback !== "function")
      throw Error("Illegal callback: " + typeof callback);
    _async(callback);
  } else
    return new Promise(function(resolve, reject) {
      _async(function(err, res) {
        if (err) {
          reject(err);
          return;
        }
        resolve(res);
      });
    });
}
function hashSync(password, salt) {
  if (typeof salt === "undefined") salt = GENSALT_DEFAULT_LOG2_ROUNDS;
  if (typeof salt === "number") salt = genSaltSync(salt);
  if (typeof password !== "string" || typeof salt !== "string")
    throw Error("Illegal arguments: " + typeof password + ", " + typeof salt);
  return _hash(password, salt);
}
function hash(password, salt, callback, progressCallback) {
  function _async(callback2) {
    if (typeof password === "string" && typeof salt === "number")
      genSalt(salt, function(err, salt2) {
        _hash(password, salt2, callback2, progressCallback);
      });
    else if (typeof password === "string" && typeof salt === "string")
      _hash(password, salt, callback2, progressCallback);
    else
      nextTick(
        callback2.bind(
          this,
          Error("Illegal arguments: " + typeof password + ", " + typeof salt)
        )
      );
  }
  if (callback) {
    if (typeof callback !== "function")
      throw Error("Illegal callback: " + typeof callback);
    _async(callback);
  } else
    return new Promise(function(resolve, reject) {
      _async(function(err, res) {
        if (err) {
          reject(err);
          return;
        }
        resolve(res);
      });
    });
}
function safeStringCompare(known, unknown) {
  var diff = known.length ^ unknown.length;
  for (var i = 0; i < known.length; ++i) {
    diff |= known.charCodeAt(i) ^ unknown.charCodeAt(i);
  }
  return diff === 0;
}
function compareSync(password, hash2) {
  if (typeof password !== "string" || typeof hash2 !== "string")
    throw Error("Illegal arguments: " + typeof password + ", " + typeof hash2);
  if (hash2.length !== 60) return false;
  return safeStringCompare(
    hashSync(password, hash2.substring(0, hash2.length - 31)),
    hash2
  );
}
function compare(password, hashValue, callback, progressCallback) {
  function _async(callback2) {
    if (typeof password !== "string" || typeof hashValue !== "string") {
      nextTick(
        callback2.bind(
          this,
          Error(
            "Illegal arguments: " + typeof password + ", " + typeof hashValue
          )
        )
      );
      return;
    }
    if (hashValue.length !== 60) {
      nextTick(callback2.bind(this, null, false));
      return;
    }
    hash(
      password,
      hashValue.substring(0, 29),
      function(err, comp) {
        if (err) callback2(err);
        else callback2(null, safeStringCompare(comp, hashValue));
      },
      progressCallback
    );
  }
  if (callback) {
    if (typeof callback !== "function")
      throw Error("Illegal callback: " + typeof callback);
    _async(callback);
  } else
    return new Promise(function(resolve, reject) {
      _async(function(err, res) {
        if (err) {
          reject(err);
          return;
        }
        resolve(res);
      });
    });
}
function getRounds(hash2) {
  if (typeof hash2 !== "string")
    throw Error("Illegal arguments: " + typeof hash2);
  return parseInt(hash2.split("$")[2], 10);
}
function getSalt(hash2) {
  if (typeof hash2 !== "string")
    throw Error("Illegal arguments: " + typeof hash2);
  if (hash2.length !== 60)
    throw Error("Illegal hash length: " + hash2.length + " != 60");
  return hash2.substring(0, 29);
}
function truncates(password) {
  if (typeof password !== "string")
    throw Error("Illegal arguments: " + typeof password);
  return utf8Length(password) > 72;
}
var nextTick = typeof setImmediate === "function" ? setImmediate : typeof scheduler === "object" && typeof scheduler.postTask === "function" ? scheduler.postTask.bind(scheduler) : setTimeout;
function utf8Length(string) {
  var len = 0, c = 0;
  for (var i = 0; i < string.length; ++i) {
    c = string.charCodeAt(i);
    if (c < 128) len += 1;
    else if (c < 2048) len += 2;
    else if ((c & 64512) === 55296 && (string.charCodeAt(i + 1) & 64512) === 56320) {
      ++i;
      len += 4;
    } else len += 3;
  }
  return len;
}
function utf8Array(string) {
  var offset = 0, c1, c2;
  var buffer = new Array(utf8Length(string));
  for (var i = 0, k = string.length; i < k; ++i) {
    c1 = string.charCodeAt(i);
    if (c1 < 128) {
      buffer[offset++] = c1;
    } else if (c1 < 2048) {
      buffer[offset++] = c1 >> 6 | 192;
      buffer[offset++] = c1 & 63 | 128;
    } else if ((c1 & 64512) === 55296 && ((c2 = string.charCodeAt(i + 1)) & 64512) === 56320) {
      c1 = 65536 + ((c1 & 1023) << 10) + (c2 & 1023);
      ++i;
      buffer[offset++] = c1 >> 18 | 240;
      buffer[offset++] = c1 >> 12 & 63 | 128;
      buffer[offset++] = c1 >> 6 & 63 | 128;
      buffer[offset++] = c1 & 63 | 128;
    } else {
      buffer[offset++] = c1 >> 12 | 224;
      buffer[offset++] = c1 >> 6 & 63 | 128;
      buffer[offset++] = c1 & 63 | 128;
    }
  }
  return buffer;
}
var BASE64_CODE = "./ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789".split("");
var BASE64_INDEX = [
  -1,
  -1,
  -1,
  -1,
  -1,
  -1,
  -1,
  -1,
  -1,
  -1,
  -1,
  -1,
  -1,
  -1,
  -1,
  -1,
  -1,
  -1,
  -1,
  -1,
  -1,
  -1,
  -1,
  -1,
  -1,
  -1,
  -1,
  -1,
  -1,
  -1,
  -1,
  -1,
  -1,
  -1,
  -1,
  -1,
  -1,
  -1,
  -1,
  -1,
  -1,
  -1,
  -1,
  -1,
  -1,
  -1,
  0,
  1,
  54,
  55,
  56,
  57,
  58,
  59,
  60,
  61,
  62,
  63,
  -1,
  -1,
  -1,
  -1,
  -1,
  -1,
  -1,
  2,
  3,
  4,
  5,
  6,
  7,
  8,
  9,
  10,
  11,
  12,
  13,
  14,
  15,
  16,
  17,
  18,
  19,
  20,
  21,
  22,
  23,
  24,
  25,
  26,
  27,
  -1,
  -1,
  -1,
  -1,
  -1,
  -1,
  28,
  29,
  30,
  31,
  32,
  33,
  34,
  35,
  36,
  37,
  38,
  39,
  40,
  41,
  42,
  43,
  44,
  45,
  46,
  47,
  48,
  49,
  50,
  51,
  52,
  53,
  -1,
  -1,
  -1,
  -1,
  -1
];
function base64_encode(b, len) {
  var off = 0, rs = [], c1, c2;
  if (len <= 0 || len > b.length) throw Error("Illegal len: " + len);
  while (off < len) {
    c1 = b[off++] & 255;
    rs.push(BASE64_CODE[c1 >> 2 & 63]);
    c1 = (c1 & 3) << 4;
    if (off >= len) {
      rs.push(BASE64_CODE[c1 & 63]);
      break;
    }
    c2 = b[off++] & 255;
    c1 |= c2 >> 4 & 15;
    rs.push(BASE64_CODE[c1 & 63]);
    c1 = (c2 & 15) << 2;
    if (off >= len) {
      rs.push(BASE64_CODE[c1 & 63]);
      break;
    }
    c2 = b[off++] & 255;
    c1 |= c2 >> 6 & 3;
    rs.push(BASE64_CODE[c1 & 63]);
    rs.push(BASE64_CODE[c2 & 63]);
  }
  return rs.join("");
}
function base64_decode(s, len) {
  var off = 0, slen = s.length, olen = 0, rs = [], c1, c2, c3, c4, o, code;
  if (len <= 0) throw Error("Illegal len: " + len);
  while (off < slen - 1 && olen < len) {
    code = s.charCodeAt(off++);
    c1 = code < BASE64_INDEX.length ? BASE64_INDEX[code] : -1;
    code = s.charCodeAt(off++);
    c2 = code < BASE64_INDEX.length ? BASE64_INDEX[code] : -1;
    if (c1 == -1 || c2 == -1) break;
    o = c1 << 2 >>> 0;
    o |= (c2 & 48) >> 4;
    rs.push(String.fromCharCode(o));
    if (++olen >= len || off >= slen) break;
    code = s.charCodeAt(off++);
    c3 = code < BASE64_INDEX.length ? BASE64_INDEX[code] : -1;
    if (c3 == -1) break;
    o = (c2 & 15) << 4 >>> 0;
    o |= (c3 & 60) >> 2;
    rs.push(String.fromCharCode(o));
    if (++olen >= len || off >= slen) break;
    code = s.charCodeAt(off++);
    c4 = code < BASE64_INDEX.length ? BASE64_INDEX[code] : -1;
    o = (c3 & 3) << 6 >>> 0;
    o |= c4;
    rs.push(String.fromCharCode(o));
    ++olen;
  }
  var res = [];
  for (off = 0; off < olen; off++) res.push(rs[off].charCodeAt(0));
  return res;
}
var BCRYPT_SALT_LEN = 16;
var GENSALT_DEFAULT_LOG2_ROUNDS = 10;
var BLOWFISH_NUM_ROUNDS = 16;
var MAX_EXECUTION_TIME = 100;
var P_ORIG = [
  608135816,
  2242054355,
  320440878,
  57701188,
  2752067618,
  698298832,
  137296536,
  3964562569,
  1160258022,
  953160567,
  3193202383,
  887688300,
  3232508343,
  3380367581,
  1065670069,
  3041331479,
  2450970073,
  2306472731
];
var S_ORIG = [
  3509652390,
  2564797868,
  805139163,
  3491422135,
  3101798381,
  1780907670,
  3128725573,
  4046225305,
  614570311,
  3012652279,
  134345442,
  2240740374,
  1667834072,
  1901547113,
  2757295779,
  4103290238,
  227898511,
  1921955416,
  1904987480,
  2182433518,
  2069144605,
  3260701109,
  2620446009,
  720527379,
  3318853667,
  677414384,
  3393288472,
  3101374703,
  2390351024,
  1614419982,
  1822297739,
  2954791486,
  3608508353,
  3174124327,
  2024746970,
  1432378464,
  3864339955,
  2857741204,
  1464375394,
  1676153920,
  1439316330,
  715854006,
  3033291828,
  289532110,
  2706671279,
  2087905683,
  3018724369,
  1668267050,
  732546397,
  1947742710,
  3462151702,
  2609353502,
  2950085171,
  1814351708,
  2050118529,
  680887927,
  999245976,
  1800124847,
  3300911131,
  1713906067,
  1641548236,
  4213287313,
  1216130144,
  1575780402,
  4018429277,
  3917837745,
  3693486850,
  3949271944,
  596196993,
  3549867205,
  258830323,
  2213823033,
  772490370,
  2760122372,
  1774776394,
  2652871518,
  566650946,
  4142492826,
  1728879713,
  2882767088,
  1783734482,
  3629395816,
  2517608232,
  2874225571,
  1861159788,
  326777828,
  3124490320,
  2130389656,
  2716951837,
  967770486,
  1724537150,
  2185432712,
  2364442137,
  1164943284,
  2105845187,
  998989502,
  3765401048,
  2244026483,
  1075463327,
  1455516326,
  1322494562,
  910128902,
  469688178,
  1117454909,
  936433444,
  3490320968,
  3675253459,
  1240580251,
  122909385,
  2157517691,
  634681816,
  4142456567,
  3825094682,
  3061402683,
  2540495037,
  79693498,
  3249098678,
  1084186820,
  1583128258,
  426386531,
  1761308591,
  1047286709,
  322548459,
  995290223,
  1845252383,
  2603652396,
  3431023940,
  2942221577,
  3202600964,
  3727903485,
  1712269319,
  422464435,
  3234572375,
  1170764815,
  3523960633,
  3117677531,
  1434042557,
  442511882,
  3600875718,
  1076654713,
  1738483198,
  4213154764,
  2393238008,
  3677496056,
  1014306527,
  4251020053,
  793779912,
  2902807211,
  842905082,
  4246964064,
  1395751752,
  1040244610,
  2656851899,
  3396308128,
  445077038,
  3742853595,
  3577915638,
  679411651,
  2892444358,
  2354009459,
  1767581616,
  3150600392,
  3791627101,
  3102740896,
  284835224,
  4246832056,
  1258075500,
  768725851,
  2589189241,
  3069724005,
  3532540348,
  1274779536,
  3789419226,
  2764799539,
  1660621633,
  3471099624,
  4011903706,
  913787905,
  3497959166,
  737222580,
  2514213453,
  2928710040,
  3937242737,
  1804850592,
  3499020752,
  2949064160,
  2386320175,
  2390070455,
  2415321851,
  4061277028,
  2290661394,
  2416832540,
  1336762016,
  1754252060,
  3520065937,
  3014181293,
  791618072,
  3188594551,
  3933548030,
  2332172193,
  3852520463,
  3043980520,
  413987798,
  3465142937,
  3030929376,
  4245938359,
  2093235073,
  3534596313,
  375366246,
  2157278981,
  2479649556,
  555357303,
  3870105701,
  2008414854,
  3344188149,
  4221384143,
  3956125452,
  2067696032,
  3594591187,
  2921233993,
  2428461,
  544322398,
  577241275,
  1471733935,
  610547355,
  4027169054,
  1432588573,
  1507829418,
  2025931657,
  3646575487,
  545086370,
  48609733,
  2200306550,
  1653985193,
  298326376,
  1316178497,
  3007786442,
  2064951626,
  458293330,
  2589141269,
  3591329599,
  3164325604,
  727753846,
  2179363840,
  146436021,
  1461446943,
  4069977195,
  705550613,
  3059967265,
  3887724982,
  4281599278,
  3313849956,
  1404054877,
  2845806497,
  146425753,
  1854211946,
  1266315497,
  3048417604,
  3681880366,
  3289982499,
  290971e4,
  1235738493,
  2632868024,
  2414719590,
  3970600049,
  1771706367,
  1449415276,
  3266420449,
  422970021,
  1963543593,
  2690192192,
  3826793022,
  1062508698,
  1531092325,
  1804592342,
  2583117782,
  2714934279,
  4024971509,
  1294809318,
  4028980673,
  1289560198,
  2221992742,
  1669523910,
  35572830,
  157838143,
  1052438473,
  1016535060,
  1802137761,
  1753167236,
  1386275462,
  3080475397,
  2857371447,
  1040679964,
  2145300060,
  2390574316,
  1461121720,
  2956646967,
  4031777805,
  4028374788,
  33600511,
  2920084762,
  1018524850,
  629373528,
  3691585981,
  3515945977,
  2091462646,
  2486323059,
  586499841,
  988145025,
  935516892,
  3367335476,
  2599673255,
  2839830854,
  265290510,
  3972581182,
  2759138881,
  3795373465,
  1005194799,
  847297441,
  406762289,
  1314163512,
  1332590856,
  1866599683,
  4127851711,
  750260880,
  613907577,
  1450815602,
  3165620655,
  3734664991,
  3650291728,
  3012275730,
  3704569646,
  1427272223,
  778793252,
  1343938022,
  2676280711,
  2052605720,
  1946737175,
  3164576444,
  3914038668,
  3967478842,
  3682934266,
  1661551462,
  3294938066,
  4011595847,
  840292616,
  3712170807,
  616741398,
  312560963,
  711312465,
  1351876610,
  322626781,
  1910503582,
  271666773,
  2175563734,
  1594956187,
  70604529,
  3617834859,
  1007753275,
  1495573769,
  4069517037,
  2549218298,
  2663038764,
  504708206,
  2263041392,
  3941167025,
  2249088522,
  1514023603,
  1998579484,
  1312622330,
  694541497,
  2582060303,
  2151582166,
  1382467621,
  776784248,
  2618340202,
  3323268794,
  2497899128,
  2784771155,
  503983604,
  4076293799,
  907881277,
  423175695,
  432175456,
  1378068232,
  4145222326,
  3954048622,
  3938656102,
  3820766613,
  2793130115,
  2977904593,
  26017576,
  3274890735,
  3194772133,
  1700274565,
  1756076034,
  4006520079,
  3677328699,
  720338349,
  1533947780,
  354530856,
  688349552,
  3973924725,
  1637815568,
  332179504,
  3949051286,
  53804574,
  2852348879,
  3044236432,
  1282449977,
  3583942155,
  3416972820,
  4006381244,
  1617046695,
  2628476075,
  3002303598,
  1686838959,
  431878346,
  2686675385,
  1700445008,
  1080580658,
  1009431731,
  832498133,
  3223435511,
  2605976345,
  2271191193,
  2516031870,
  1648197032,
  4164389018,
  2548247927,
  300782431,
  375919233,
  238389289,
  3353747414,
  2531188641,
  2019080857,
  1475708069,
  455242339,
  2609103871,
  448939670,
  3451063019,
  1395535956,
  2413381860,
  1841049896,
  1491858159,
  885456874,
  4264095073,
  4001119347,
  1565136089,
  3898914787,
  1108368660,
  540939232,
  1173283510,
  2745871338,
  3681308437,
  4207628240,
  3343053890,
  4016749493,
  1699691293,
  1103962373,
  3625875870,
  2256883143,
  3830138730,
  1031889488,
  3479347698,
  1535977030,
  4236805024,
  3251091107,
  2132092099,
  1774941330,
  1199868427,
  1452454533,
  157007616,
  2904115357,
  342012276,
  595725824,
  1480756522,
  206960106,
  497939518,
  591360097,
  863170706,
  2375253569,
  3596610801,
  1814182875,
  2094937945,
  3421402208,
  1082520231,
  3463918190,
  2785509508,
  435703966,
  3908032597,
  1641649973,
  2842273706,
  3305899714,
  1510255612,
  2148256476,
  2655287854,
  3276092548,
  4258621189,
  236887753,
  3681803219,
  274041037,
  1734335097,
  3815195456,
  3317970021,
  1899903192,
  1026095262,
  4050517792,
  356393447,
  2410691914,
  3873677099,
  3682840055,
  3913112168,
  2491498743,
  4132185628,
  2489919796,
  1091903735,
  1979897079,
  3170134830,
  3567386728,
  3557303409,
  857797738,
  1136121015,
  1342202287,
  507115054,
  2535736646,
  337727348,
  3213592640,
  1301675037,
  2528481711,
  1895095763,
  1721773893,
  3216771564,
  62756741,
  2142006736,
  835421444,
  2531993523,
  1442658625,
  3659876326,
  2882144922,
  676362277,
  1392781812,
  170690266,
  3921047035,
  1759253602,
  3611846912,
  1745797284,
  664899054,
  1329594018,
  3901205900,
  3045908486,
  2062866102,
  2865634940,
  3543621612,
  3464012697,
  1080764994,
  553557557,
  3656615353,
  3996768171,
  991055499,
  499776247,
  1265440854,
  648242737,
  3940784050,
  980351604,
  3713745714,
  1749149687,
  3396870395,
  4211799374,
  3640570775,
  1161844396,
  3125318951,
  1431517754,
  545492359,
  4268468663,
  3499529547,
  1437099964,
  2702547544,
  3433638243,
  2581715763,
  2787789398,
  1060185593,
  1593081372,
  2418618748,
  4260947970,
  69676912,
  2159744348,
  86519011,
  2512459080,
  3838209314,
  1220612927,
  3339683548,
  133810670,
  1090789135,
  1078426020,
  1569222167,
  845107691,
  3583754449,
  4072456591,
  1091646820,
  628848692,
  1613405280,
  3757631651,
  526609435,
  236106946,
  48312990,
  2942717905,
  3402727701,
  1797494240,
  859738849,
  992217954,
  4005476642,
  2243076622,
  3870952857,
  3732016268,
  765654824,
  3490871365,
  2511836413,
  1685915746,
  3888969200,
  1414112111,
  2273134842,
  3281911079,
  4080962846,
  172450625,
  2569994100,
  980381355,
  4109958455,
  2819808352,
  2716589560,
  2568741196,
  3681446669,
  3329971472,
  1835478071,
  660984891,
  3704678404,
  4045999559,
  3422617507,
  3040415634,
  1762651403,
  1719377915,
  3470491036,
  2693910283,
  3642056355,
  3138596744,
  1364962596,
  2073328063,
  1983633131,
  926494387,
  3423689081,
  2150032023,
  4096667949,
  1749200295,
  3328846651,
  309677260,
  2016342300,
  1779581495,
  3079819751,
  111262694,
  1274766160,
  443224088,
  298511866,
  1025883608,
  3806446537,
  1145181785,
  168956806,
  3641502830,
  3584813610,
  1689216846,
  3666258015,
  3200248200,
  1692713982,
  2646376535,
  4042768518,
  1618508792,
  1610833997,
  3523052358,
  4130873264,
  2001055236,
  3610705100,
  2202168115,
  4028541809,
  2961195399,
  1006657119,
  2006996926,
  3186142756,
  1430667929,
  3210227297,
  1314452623,
  4074634658,
  4101304120,
  2273951170,
  1399257539,
  3367210612,
  3027628629,
  1190975929,
  2062231137,
  2333990788,
  2221543033,
  2438960610,
  1181637006,
  548689776,
  2362791313,
  3372408396,
  3104550113,
  3145860560,
  296247880,
  1970579870,
  3078560182,
  3769228297,
  1714227617,
  3291629107,
  3898220290,
  166772364,
  1251581989,
  493813264,
  448347421,
  195405023,
  2709975567,
  677966185,
  3703036547,
  1463355134,
  2715995803,
  1338867538,
  1343315457,
  2802222074,
  2684532164,
  233230375,
  2599980071,
  2000651841,
  3277868038,
  1638401717,
  4028070440,
  3237316320,
  6314154,
  819756386,
  300326615,
  590932579,
  1405279636,
  3267499572,
  3150704214,
  2428286686,
  3959192993,
  3461946742,
  1862657033,
  1266418056,
  963775037,
  2089974820,
  2263052895,
  1917689273,
  448879540,
  3550394620,
  3981727096,
  150775221,
  3627908307,
  1303187396,
  508620638,
  2975983352,
  2726630617,
  1817252668,
  1876281319,
  1457606340,
  908771278,
  3720792119,
  3617206836,
  2455994898,
  1729034894,
  1080033504,
  976866871,
  3556439503,
  2881648439,
  1522871579,
  1555064734,
  1336096578,
  3548522304,
  2579274686,
  3574697629,
  3205460757,
  3593280638,
  3338716283,
  3079412587,
  564236357,
  2993598910,
  1781952180,
  1464380207,
  3163844217,
  3332601554,
  1699332808,
  1393555694,
  1183702653,
  3581086237,
  1288719814,
  691649499,
  2847557200,
  2895455976,
  3193889540,
  2717570544,
  1781354906,
  1676643554,
  2592534050,
  3230253752,
  1126444790,
  2770207658,
  2633158820,
  2210423226,
  2615765581,
  2414155088,
  3127139286,
  673620729,
  2805611233,
  1269405062,
  4015350505,
  3341807571,
  4149409754,
  1057255273,
  2012875353,
  2162469141,
  2276492801,
  2601117357,
  993977747,
  3918593370,
  2654263191,
  753973209,
  36408145,
  2530585658,
  25011837,
  3520020182,
  2088578344,
  530523599,
  2918365339,
  1524020338,
  1518925132,
  3760827505,
  3759777254,
  1202760957,
  3985898139,
  3906192525,
  674977740,
  4174734889,
  2031300136,
  2019492241,
  3983892565,
  4153806404,
  3822280332,
  352677332,
  2297720250,
  60907813,
  90501309,
  3286998549,
  1016092578,
  2535922412,
  2839152426,
  457141659,
  509813237,
  4120667899,
  652014361,
  1966332200,
  2975202805,
  55981186,
  2327461051,
  676427537,
  3255491064,
  2882294119,
  3433927263,
  1307055953,
  942726286,
  933058658,
  2468411793,
  3933900994,
  4215176142,
  1361170020,
  2001714738,
  2830558078,
  3274259782,
  1222529897,
  1679025792,
  2729314320,
  3714953764,
  1770335741,
  151462246,
  3013232138,
  1682292957,
  1483529935,
  471910574,
  1539241949,
  458788160,
  3436315007,
  1807016891,
  3718408830,
  978976581,
  1043663428,
  3165965781,
  1927990952,
  4200891579,
  2372276910,
  3208408903,
  3533431907,
  1412390302,
  2931980059,
  4132332400,
  1947078029,
  3881505623,
  4168226417,
  2941484381,
  1077988104,
  1320477388,
  886195818,
  18198404,
  3786409e3,
  2509781533,
  112762804,
  3463356488,
  1866414978,
  891333506,
  18488651,
  661792760,
  1628790961,
  3885187036,
  3141171499,
  876946877,
  2693282273,
  1372485963,
  791857591,
  2686433993,
  3759982718,
  3167212022,
  3472953795,
  2716379847,
  445679433,
  3561995674,
  3504004811,
  3574258232,
  54117162,
  3331405415,
  2381918588,
  3769707343,
  4154350007,
  1140177722,
  4074052095,
  668550556,
  3214352940,
  367459370,
  261225585,
  2610173221,
  4209349473,
  3468074219,
  3265815641,
  314222801,
  3066103646,
  3808782860,
  282218597,
  3406013506,
  3773591054,
  379116347,
  1285071038,
  846784868,
  2669647154,
  3771962079,
  3550491691,
  2305946142,
  453669953,
  1268987020,
  3317592352,
  3279303384,
  3744833421,
  2610507566,
  3859509063,
  266596637,
  3847019092,
  517658769,
  3462560207,
  3443424879,
  370717030,
  4247526661,
  2224018117,
  4143653529,
  4112773975,
  2788324899,
  2477274417,
  1456262402,
  2901442914,
  1517677493,
  1846949527,
  2295493580,
  3734397586,
  2176403920,
  1280348187,
  1908823572,
  3871786941,
  846861322,
  1172426758,
  3287448474,
  3383383037,
  1655181056,
  3139813346,
  901632758,
  1897031941,
  2986607138,
  3066810236,
  3447102507,
  1393639104,
  373351379,
  950779232,
  625454576,
  3124240540,
  4148612726,
  2007998917,
  544563296,
  2244738638,
  2330496472,
  2058025392,
  1291430526,
  424198748,
  50039436,
  29584100,
  3605783033,
  2429876329,
  2791104160,
  1057563949,
  3255363231,
  3075367218,
  3463963227,
  1469046755,
  985887462
];
var C_ORIG = [
  1332899944,
  1700884034,
  1701343084,
  1684370003,
  1668446532,
  1869963892
];
function _encipher(lr, off, P, S) {
  var n, l = lr[off], r = lr[off + 1];
  l ^= P[0];
  n = S[l >>> 24];
  n += S[256 | l >> 16 & 255];
  n ^= S[512 | l >> 8 & 255];
  n += S[768 | l & 255];
  r ^= n ^ P[1];
  n = S[r >>> 24];
  n += S[256 | r >> 16 & 255];
  n ^= S[512 | r >> 8 & 255];
  n += S[768 | r & 255];
  l ^= n ^ P[2];
  n = S[l >>> 24];
  n += S[256 | l >> 16 & 255];
  n ^= S[512 | l >> 8 & 255];
  n += S[768 | l & 255];
  r ^= n ^ P[3];
  n = S[r >>> 24];
  n += S[256 | r >> 16 & 255];
  n ^= S[512 | r >> 8 & 255];
  n += S[768 | r & 255];
  l ^= n ^ P[4];
  n = S[l >>> 24];
  n += S[256 | l >> 16 & 255];
  n ^= S[512 | l >> 8 & 255];
  n += S[768 | l & 255];
  r ^= n ^ P[5];
  n = S[r >>> 24];
  n += S[256 | r >> 16 & 255];
  n ^= S[512 | r >> 8 & 255];
  n += S[768 | r & 255];
  l ^= n ^ P[6];
  n = S[l >>> 24];
  n += S[256 | l >> 16 & 255];
  n ^= S[512 | l >> 8 & 255];
  n += S[768 | l & 255];
  r ^= n ^ P[7];
  n = S[r >>> 24];
  n += S[256 | r >> 16 & 255];
  n ^= S[512 | r >> 8 & 255];
  n += S[768 | r & 255];
  l ^= n ^ P[8];
  n = S[l >>> 24];
  n += S[256 | l >> 16 & 255];
  n ^= S[512 | l >> 8 & 255];
  n += S[768 | l & 255];
  r ^= n ^ P[9];
  n = S[r >>> 24];
  n += S[256 | r >> 16 & 255];
  n ^= S[512 | r >> 8 & 255];
  n += S[768 | r & 255];
  l ^= n ^ P[10];
  n = S[l >>> 24];
  n += S[256 | l >> 16 & 255];
  n ^= S[512 | l >> 8 & 255];
  n += S[768 | l & 255];
  r ^= n ^ P[11];
  n = S[r >>> 24];
  n += S[256 | r >> 16 & 255];
  n ^= S[512 | r >> 8 & 255];
  n += S[768 | r & 255];
  l ^= n ^ P[12];
  n = S[l >>> 24];
  n += S[256 | l >> 16 & 255];
  n ^= S[512 | l >> 8 & 255];
  n += S[768 | l & 255];
  r ^= n ^ P[13];
  n = S[r >>> 24];
  n += S[256 | r >> 16 & 255];
  n ^= S[512 | r >> 8 & 255];
  n += S[768 | r & 255];
  l ^= n ^ P[14];
  n = S[l >>> 24];
  n += S[256 | l >> 16 & 255];
  n ^= S[512 | l >> 8 & 255];
  n += S[768 | l & 255];
  r ^= n ^ P[15];
  n = S[r >>> 24];
  n += S[256 | r >> 16 & 255];
  n ^= S[512 | r >> 8 & 255];
  n += S[768 | r & 255];
  l ^= n ^ P[16];
  lr[off] = r ^ P[BLOWFISH_NUM_ROUNDS + 1];
  lr[off + 1] = l;
  return lr;
}
function _streamtoword(data, offp) {
  for (var i = 0, word = 0; i < 4; ++i)
    word = word << 8 | data[offp] & 255, offp = (offp + 1) % data.length;
  return { key: word, offp };
}
function _key(key, P, S) {
  var offset = 0, lr = [0, 0], plen = P.length, slen = S.length, sw;
  for (var i = 0; i < plen; i++)
    sw = _streamtoword(key, offset), offset = sw.offp, P[i] = P[i] ^ sw.key;
  for (i = 0; i < plen; i += 2)
    lr = _encipher(lr, 0, P, S), P[i] = lr[0], P[i + 1] = lr[1];
  for (i = 0; i < slen; i += 2)
    lr = _encipher(lr, 0, P, S), S[i] = lr[0], S[i + 1] = lr[1];
}
function _ekskey(data, key, P, S) {
  var offp = 0, lr = [0, 0], plen = P.length, slen = S.length, sw;
  for (var i = 0; i < plen; i++)
    sw = _streamtoword(key, offp), offp = sw.offp, P[i] = P[i] ^ sw.key;
  offp = 0;
  for (i = 0; i < plen; i += 2)
    sw = _streamtoword(data, offp), offp = sw.offp, lr[0] ^= sw.key, sw = _streamtoword(data, offp), offp = sw.offp, lr[1] ^= sw.key, lr = _encipher(lr, 0, P, S), P[i] = lr[0], P[i + 1] = lr[1];
  for (i = 0; i < slen; i += 2)
    sw = _streamtoword(data, offp), offp = sw.offp, lr[0] ^= sw.key, sw = _streamtoword(data, offp), offp = sw.offp, lr[1] ^= sw.key, lr = _encipher(lr, 0, P, S), S[i] = lr[0], S[i + 1] = lr[1];
}
function _crypt(b, salt, rounds, callback, progressCallback) {
  var cdata = C_ORIG.slice(), clen = cdata.length, err;
  if (rounds < 4 || rounds > 31) {
    err = Error("Illegal number of rounds (4-31): " + rounds);
    if (callback) {
      nextTick(callback.bind(this, err));
      return;
    } else throw err;
  }
  if (salt.length !== BCRYPT_SALT_LEN) {
    err = Error(
      "Illegal salt length: " + salt.length + " != " + BCRYPT_SALT_LEN
    );
    if (callback) {
      nextTick(callback.bind(this, err));
      return;
    } else throw err;
  }
  rounds = 1 << rounds >>> 0;
  var P, S, i = 0, j;
  if (typeof Int32Array === "function") {
    P = new Int32Array(P_ORIG);
    S = new Int32Array(S_ORIG);
  } else {
    P = P_ORIG.slice();
    S = S_ORIG.slice();
  }
  _ekskey(salt, b, P, S);
  function next() {
    if (progressCallback) progressCallback(i / rounds);
    if (i < rounds) {
      var start = Date.now();
      for (; i < rounds; ) {
        i = i + 1;
        _key(b, P, S);
        _key(salt, P, S);
        if (Date.now() - start > MAX_EXECUTION_TIME) break;
      }
    } else {
      for (i = 0; i < 64; i++)
        for (j = 0; j < clen >> 1; j++) _encipher(cdata, j << 1, P, S);
      var ret = [];
      for (i = 0; i < clen; i++)
        ret.push((cdata[i] >> 24 & 255) >>> 0), ret.push((cdata[i] >> 16 & 255) >>> 0), ret.push((cdata[i] >> 8 & 255) >>> 0), ret.push((cdata[i] & 255) >>> 0);
      if (callback) {
        callback(null, ret);
        return;
      } else return ret;
    }
    if (callback) nextTick(next);
  }
  if (typeof callback !== "undefined") {
    next();
  } else {
    var res;
    while (true) if (typeof (res = next()) !== "undefined") return res || [];
  }
}
function _hash(password, salt, callback, progressCallback) {
  var err;
  if (typeof password !== "string" || typeof salt !== "string") {
    err = Error("Invalid string / salt: Not a string");
    if (callback) {
      nextTick(callback.bind(this, err));
      return;
    } else throw err;
  }
  var minor, offset;
  if (salt.charAt(0) !== "$" || salt.charAt(1) !== "2") {
    err = Error("Invalid salt version: " + salt.substring(0, 2));
    if (callback) {
      nextTick(callback.bind(this, err));
      return;
    } else throw err;
  }
  if (salt.charAt(2) === "$") minor = String.fromCharCode(0), offset = 3;
  else {
    minor = salt.charAt(2);
    if (minor !== "a" && minor !== "b" && minor !== "y" || salt.charAt(3) !== "$") {
      err = Error("Invalid salt revision: " + salt.substring(2, 4));
      if (callback) {
        nextTick(callback.bind(this, err));
        return;
      } else throw err;
    }
    offset = 4;
  }
  if (salt.charAt(offset + 2) > "$") {
    err = Error("Missing salt rounds");
    if (callback) {
      nextTick(callback.bind(this, err));
      return;
    } else throw err;
  }
  var r1 = parseInt(salt.substring(offset, offset + 1), 10) * 10, r2 = parseInt(salt.substring(offset + 1, offset + 2), 10), rounds = r1 + r2, real_salt = salt.substring(offset + 3, offset + 25);
  password += minor >= "a" ? "\0" : "";
  var passwordb = utf8Array(password), saltb = base64_decode(real_salt, BCRYPT_SALT_LEN);
  function finish(bytes) {
    var res = [];
    res.push("$2");
    if (minor >= "a") res.push(minor);
    res.push("$");
    if (rounds < 10) res.push("0");
    res.push(rounds.toString());
    res.push("$");
    res.push(base64_encode(saltb, saltb.length));
    res.push(base64_encode(bytes, C_ORIG.length * 4 - 1));
    return res.join("");
  }
  if (typeof callback == "undefined")
    return finish(_crypt(passwordb, saltb, rounds));
  else {
    _crypt(
      passwordb,
      saltb,
      rounds,
      function(err2, bytes) {
        if (err2) callback(err2, null);
        else callback(null, finish(bytes));
      },
      progressCallback
    );
  }
}
function encodeBase64(bytes, length) {
  return base64_encode(bytes, length);
}
function decodeBase64(string, length) {
  return base64_decode(string, length);
}
var bcryptjs_default = {
  setRandomFallback,
  genSaltSync,
  genSalt,
  hashSync,
  hash,
  compareSync,
  compare,
  getRounds,
  getSalt,
  truncates,
  encodeBase64,
  decodeBase64
};

// server/index.ts
var import_multer = __toESM(require("multer"));
var import_fs = __toESM(require("fs"));

// server/auth-middleware.ts
var import_supabase_js = require("@supabase/supabase-js");
var _supabaseAdmin = null;
function getSupabaseAdmin() {
  if (!_supabaseAdmin) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) throw new Error("SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set");
    _supabaseAdmin = (0, import_supabase_js.createClient)(url, key, {
      auth: { autoRefreshToken: false, persistSession: false }
    });
  }
  return _supabaseAdmin;
}
async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) return res.status(401).json({ error: "Missing or invalid Authorization header" });
  const token = authHeader.split(" ")[1];
  try {
    const supabase = getSupabaseAdmin();
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return res.status(401).json({ error: "Invalid or expired token" });
    const { data: adminUser } = await supabase.from("admin_users").select("role").eq("id", user.id).single();
    const role = adminUser?.role ?? "user";
    req.supabaseUser = { id: user.id, email: user.email, role };
    next();
  } catch (err) {
    console.error("[requireAuth] Error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}

// server/index.ts
var import_supabase_js2 = require("@supabase/supabase-js");
var supabaseAdmin = (0, import_supabase_js2.createClient)(
  process.env.SUPABASE_URL || "",
  process.env.SUPABASE_SERVICE_ROLE_KEY || "",
  { auth: { autoRefreshToken: false, persistSession: false } }
);
var app = (0, import_express.default)();
var server = (0, import_http.createServer)(app);
var wss = new import_websocket_server.default({ server, maxPayload: 50 * 1024 * 1024 });
app.use((0, import_cors.default)());
app.use(import_express.default.json({ limit: "50mb" }));
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.warn("[Auth] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set \u2014 auth middleware disabled");
}
var PROJECT_ROOT = import_path.default.resolve(__dirname, "..");
var dataDir = import_path.default.join(PROJECT_ROOT, "data");
if (!import_fs.default.existsSync(dataDir)) import_fs.default.mkdirSync(dataDir, { recursive: true });
var ALERTS_FILE = import_path.default.join(dataDir, "alerts.json");
var LOCATION_HISTORY_FILE = import_path.default.join(dataDir, "location-history.json");
var FAMILY_PERIMETERS_FILE = import_path.default.join(dataDir, "family-perimeters.json");
var PROXIMITY_ALERTS_FILE = import_path.default.join(dataDir, "proximity-alerts.json");
var PATROL_REPORTS_FILE = import_path.default.join(dataDir, "patrol-reports.json");
var PTT_CHANNELS_FILE = import_path.default.join(dataDir, "ptt-channels.json");
var PTT_MESSAGES_FILE = import_path.default.join(dataDir, "ptt-messages.json");
function loadJsonFile(filePath, defaultValue) {
  try {
    if (import_fs.default.existsSync(filePath)) {
      return JSON.parse(import_fs.default.readFileSync(filePath, "utf-8"));
    }
  } catch (e) {
    console.error(`[Persist] Failed to load ${filePath}:`, e);
  }
  return defaultValue;
}
function saveJsonFile(filePath, data) {
  try {
    import_fs.default.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
  } catch (e) {
    console.error(`[Persist] Failed to save ${filePath}:`, e);
  }
}
var ACCEPTANCE_TIMEOUT_MS = 5 * 60 * 1e3;
var acceptanceTimers = /* @__PURE__ */ new Map();
function startAcceptanceTimer(alertId, responderId) {
  const timerKey = `${alertId}:${responderId}`;
  const existing = acceptanceTimers.get(timerKey);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    acceptanceTimers.delete(timerKey);
    const alert = alerts.get(alertId);
    if (!alert) return;
    const currentStatus = alert.responderStatuses?.[responderId];
    if (currentStatus && currentStatus !== "assigned") return;
    const responderName = adminUsers.get(responderId)?.name || responderId;
    console.log(`[AcceptanceTimer] ${responderName} did not accept incident ${alertId} within 5 minutes`);
    if (!alert.statusHistory) alert.statusHistory = [];
    alert.statusHistory.push({
      responderId,
      responderName,
      status: "assigned",
      // still assigned, but timed out
      timestamp: Date.now()
    });
    addAuditEntry("incident", "Acceptance Timeout", "System", `${responderName} n'a pas accept\xE9 l'incident ${alertId} dans les 5 minutes`, responderId);
    const TYPE_LABELS = {
      sos: "SOS",
      medical: "M\xE9dical",
      fire: "Incendie",
      security: "S\xE9curit\xE9",
      accident: "Accident",
      broadcast: "Broadcast",
      other: "Autre",
      home_jacking: "Home-Jacking",
      cambriolage: "Cambriolage",
      animal_perdu: "Animal perdu",
      evenement_climatique: "\xC9v\xE9nement climatique",
      rodage: "Rodage",
      vehicule_suspect: "V\xE9hicule suspect",
      fugue: "Fugue",
      route_bloquee: "Route bloqu\xE9e",
      route_fermee: "Route ferm\xE9e"
    };
    const typeLabel = TYPE_LABELS[alert.type] || alert.type;
    const notifiedDispatchers = /* @__PURE__ */ new Set();
    for (const [_token, entry] of pushTokens) {
      if ((entry.userRole === "dispatcher" || entry.userRole === "admin") && !notifiedDispatchers.has(entry.userId)) {
        notifiedDispatchers.add(entry.userId);
        sendPushToUser(
          entry.userId,
          `\u23F0 D\xE9lai d'acceptation d\xE9pass\xE9`,
          `${responderName} n'a pas accept\xE9 l'incident ${typeLabel} (${alertId}) dans les 5 minutes. Veuillez r\xE9assigner.`,
          { type: "acceptance_timeout", alertId, responderId }
        ).catch(() => {
        });
      }
    }
    broadcastMessage({
      type: "acceptanceTimeout",
      alertId,
      responderId,
      responderName,
      timestamp: Date.now()
    });
  }, ACCEPTANCE_TIMEOUT_MS);
  acceptanceTimers.set(timerKey, timer);
}
function clearAcceptanceTimer(alertId, responderId) {
  const timerKey = `${alertId}:${responderId}`;
  const timer = acceptanceTimers.get(timerKey);
  if (timer) {
    clearTimeout(timer);
    acceptanceTimers.delete(timerKey);
  }
}
var saveTimers = /* @__PURE__ */ new Map();
function debouncedSave(filePath, data, delayMs = 2e3) {
  const existing = saveTimers.get(filePath);
  if (existing) clearTimeout(existing);
  saveTimers.set(filePath, setTimeout(() => {
    saveJsonFile(filePath, data);
    saveTimers.delete(filePath);
  }, delayMs));
}
var uploadsDir = import_path.default.join(PROJECT_ROOT, "uploads");
if (!import_fs.default.existsSync(uploadsDir)) import_fs.default.mkdirSync(uploadsDir, { recursive: true });
var storage = import_multer.default.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (_req, file, cb) => cb(null, `${Date.now()}-${file.originalname.replace(/[^a-zA-Z0-9.]/g, "_")}`)
});
var upload = (0, import_multer.default)({ storage, limits: { fileSize: 5 * 1024 * 1024 } });
var uploadMedia = (0, import_multer.default)({ storage, limits: { fileSize: 50 * 1024 * 1024 } });
app.use("/uploads", import_express.default.static(uploadsDir));
app.use("/assets", import_express.default.static(import_path.default.join(PROJECT_ROOT, "assets")));
var MIME_TYPES = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf"
};
function serveConsoleDynamic(basePath) {
  return (req, res) => {
    let filePath = req.path === "/" ? "/index.html" : req.path;
    filePath = filePath.split("?")[0];
    const fullPath = import_path.default.join(basePath, filePath);
    if (!fullPath.startsWith(basePath)) return res.status(403).send("Forbidden");
    try {
      if (!import_fs.default.existsSync(fullPath) || import_fs.default.statSync(fullPath).isDirectory()) {
        const indexPath = import_path.default.join(fullPath, "index.html");
        if (import_fs.default.existsSync(indexPath)) {
          const content2 = import_fs.default.readFileSync(indexPath, "utf-8");
          res.set("Content-Type", "text/html");
          res.set("Cache-Control", "no-cache, no-store, must-revalidate");
          res.set("Pragma", "no-cache");
          return res.send(content2);
        }
        return res.status(404).send("Not Found");
      }
      const ext = import_path.default.extname(fullPath).toLowerCase();
      const mime = MIME_TYPES[ext] || "application/octet-stream";
      const content = import_fs.default.readFileSync(fullPath);
      res.set("Content-Type", mime);
      res.set("Cache-Control", "no-cache, no-store, must-revalidate");
      res.set("Pragma", "no-cache");
      res.set("Expires", "0");
      res.send(content);
    } catch (e) {
      res.status(500).send("Internal Server Error");
    }
  };
}
app.use("/admin-console", serveConsoleDynamic(import_path.default.join(PROJECT_ROOT, "server", "admin-web")));
app.use("/dispatch-v2", serveConsoleDynamic(import_path.default.join(PROJECT_ROOT, "server", "dispatch-web")));
app.use("/dispatch-console", serveConsoleDynamic(import_path.default.join(PROJECT_ROOT, "server", "dispatch-web")));
app.use("/console", serveConsoleDynamic(import_path.default.join(PROJECT_ROOT, "server", "console-login")));
app.use("/console-login", serveConsoleDynamic(import_path.default.join(PROJECT_ROOT, "server", "console-login")));
var loginHistory = [];
function parseDevice(ua) {
  if (!ua) return "Unknown";
  if (/iPhone/i.test(ua)) return "iPhone";
  if (/iPad/i.test(ua)) return "iPad";
  if (/Android/i.test(ua)) return "Android";
  if (/Windows/i.test(ua)) return "Windows PC";
  if (/Macintosh|Mac OS/i.test(ua)) return "Mac";
  if (/Linux/i.test(ua)) return "Linux";
  return "Other";
}
function addLoginHistory(entry) {
  const record = {
    ...entry,
    id: `login-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    device: parseDevice(entry.userAgent)
  };
  loginHistory.unshift(record);
  if (loginHistory.length > 1e3) loginHistory.length = 1e3;
}
var users = /* @__PURE__ */ new Map();
var alerts = /* @__PURE__ */ new Map();
var userConnections = /* @__PURE__ */ new Map();
var wsClientMap = /* @__PURE__ */ new Map();
var adminUsers = /* @__PURE__ */ new Map();
var auditLog = [];
var responderStatusOverrides = /* @__PURE__ */ new Map();
var pushTokens = /* @__PURE__ */ new Map();
var conversations = /* @__PURE__ */ new Map();
var messages = /* @__PURE__ */ new Map();
var geofenceZones = /* @__PURE__ */ new Map();
var geofenceEvents = [];
var familyPerimeters = /* @__PURE__ */ new Map();
var proximityAlerts = [];
var perimeterState = /* @__PURE__ */ new Map();
var patrolReports = [];
var DEFAULT_PTT_CHANNELS = [
  { id: "emergency", name: "Urgence", description: "Canal d'urgence - tous les r\xF4les", allowedRoles: ["user", "responder", "dispatcher", "admin"], isActive: true, isDefault: true, createdBy: "system", createdAt: Date.now() },
  { id: "dispatch", name: "Dispatch", description: "Canal de coordination dispatch", allowedRoles: ["responder", "dispatcher", "admin"], isActive: true, isDefault: true, createdBy: "system", createdAt: Date.now() },
  { id: "responders", name: "Intervenants", description: "Canal \xE9quipe intervenants", allowedRoles: ["responder", "dispatcher", "admin"], isActive: true, isDefault: true, createdBy: "system", createdAt: Date.now() },
  { id: "general", name: "G\xE9n\xE9ral", description: "Canal de communication g\xE9n\xE9ral", allowedRoles: ["user", "responder", "dispatcher", "admin"], isActive: true, isDefault: true, createdBy: "system", createdAt: Date.now() }
];
var pttChannels = loadJsonFile(PTT_CHANNELS_FILE, [...DEFAULT_PTT_CHANNELS]);
var pttMessages = loadJsonFile(PTT_MESSAGES_FILE, []);
if (pttMessages.length > 200) pttMessages = pttMessages.slice(-200);
function persistPTTChannels() {
  import_fs.default.writeFileSync(PTT_CHANNELS_FILE, JSON.stringify(pttChannels, null, 2));
  pttChannels.forEach((c) => savePTTChannelToSupabase(c));
}
function persistPTTMessages() {
  import_fs.default.writeFileSync(PTT_MESSAGES_FILE, JSON.stringify(pttMessages.slice(-200), null, 2));
}
var locationHistory = /* @__PURE__ */ new Map();
var MAX_HISTORY_PER_USER = 200;
var responderZoneState = /* @__PURE__ */ new Map();
function seedDemoData() {
  const now = Date.now();
  const hour = 36e5;
  const day = 864e5;
  const defaultPwHash = bcryptjs_default.hashSync("talion2026", 10);
  const demoUsers = [
    { id: "admin-001", firstName: "Marie", lastName: "Dupont", name: "Marie Dupont", email: "admin@talion.io", role: "admin", status: "active", lastLogin: now - 5 * 6e4, createdAt: now - 90 * day, tags: ["command", "zone-champel"], address: "Avenue de Champel 24, 1206 Gen\xE8ve, Suisse", phoneMobile: "+41 79 123 45 67", phoneLandline: "+41 22 700 00 01", comments: "Administratrice principale", passwordHash: defaultPwHash },
    { id: "disp-001", firstName: "Jean", lastName: "Moreau", name: "Jean Moreau", email: "dispatch@talion.io", role: "dispatcher", status: "active", lastLogin: now - 12 * 6e4, createdAt: now - 75 * day, tags: ["equipe-alpha", "zone-florissant"], address: "Route de Florissant 62, 1206 Gen\xE8ve, Suisse", phoneMobile: "+41 79 234 56 78", comments: "Dispatcher senior, equipe jour", passwordHash: defaultPwHash },
    { id: "disp-002", firstName: "Sophie", lastName: "Laurent", name: "Sophie Laurent", email: "dispatch2@talion.io", role: "dispatcher", status: "active", lastLogin: now - 2 * hour, createdAt: now - 60 * day, tags: ["equipe-bravo", "zone-malagnou"], address: "Route de Malagnou 32, 1208 Gen\xE8ve, Suisse", phoneMobile: "+41 79 345 67 89", passwordHash: defaultPwHash },
    { id: "resp-001", firstName: "Pierre", lastName: "Martin", name: "Pierre Martin", email: "responder@talion.io", role: "responder", status: "active", lastLogin: now - 8 * 6e4, createdAt: now - 80 * day, tags: ["equipe-alpha", "zone-champel", "medical"], address: "Chemin de Beau-Soleil 8, 1206 Gen\xE8ve, Suisse", phoneMobile: "+41 79 456 78 90", comments: "Secouriste certifie", passwordHash: defaultPwHash },
    { id: "resp-002", firstName: "Camille", lastName: "Bernard", name: "Camille Bernard", email: "responder2@talion.io", role: "responder", status: "active", lastLogin: now - 30 * 6e4, createdAt: now - 65 * day, tags: ["equipe-alpha", "zone-malagnou", "fire"], address: "Avenue de Frontenex 45, 1207 Gen\xE8ve, Suisse", phoneMobile: "+41 79 567 89 01", passwordHash: defaultPwHash },
    { id: "resp-003", firstName: "Lucas", lastName: "Petit", name: "Lucas Petit", email: "responder3@talion.io", role: "responder", status: "active", lastLogin: now - 1 * hour, createdAt: now - 50 * day, tags: ["equipe-bravo", "zone-vesenaz"], address: "Route de Thonon 85, 1222 V\xE9senaz, Suisse", phoneMobile: "+41 79 678 90 12", passwordHash: defaultPwHash },
    { id: "resp-004", firstName: "Emma", lastName: "Roux", name: "Emma Roux", email: "responder4@talion.io", role: "responder", status: "suspended", lastLogin: now - 5 * day, createdAt: now - 45 * day, tags: ["equipe-bravo", "medical"], address: "Chemin de la Capite 12, 1222 V\xE9senaz, Suisse", phoneMobile: "+41 79 789 01 23", passwordHash: defaultPwHash },
    { id: "user-001", firstName: "Thomas", lastName: "Leroy", name: "Thomas Leroy", email: "thomas@example.com", role: "user", status: "active", lastLogin: now - 3 * hour, createdAt: now - 30 * day, tags: ["zone-champel", "observateur"], address: "Avenue de Miremont 30, 1206 Gen\xE8ve, Suisse", phoneMobile: "+41 79 890 12 34", relationships: [{ userId: "user-002", type: "spouse" }, { userId: "user-004", type: "parent" }, { userId: "user-005", type: "parent" }], passwordHash: defaultPwHash },
    { id: "user-002", firstName: "Julie", lastName: "Morel", name: "Julie Morel", email: "julie@example.com", role: "user", status: "active", lastLogin: now - 6 * hour, createdAt: now - 25 * day, tags: ["zone-florissant", "observateur"], address: "Avenue de Miremont 30, 1206 Gen\xE8ve, Suisse", phoneMobile: "+41 79 901 23 45", relationships: [{ userId: "user-001", type: "spouse" }, { userId: "user-004", type: "parent" }, { userId: "user-005", type: "parent" }], passwordHash: defaultPwHash },
    { id: "user-003", firstName: "Nicolas", lastName: "Fournier", name: "Nicolas Fournier", email: "nicolas@example.com", role: "user", status: "deactivated", lastLogin: now - 15 * day, createdAt: now - 40 * day, tags: [], address: "Chemin du Velours 10, 1208 Gen\xE8ve, Suisse", passwordHash: defaultPwHash },
    { id: "user-004", firstName: "Lea", lastName: "Leroy", name: "Lea Leroy", email: "lea@example.com", role: "user", status: "active", lastLogin: now - 45 * 6e4, createdAt: now - 20 * day, tags: ["zone-champel"], address: "Avenue de Miremont 30, 1206 Gen\xE8ve, Suisse", phoneMobile: "+41 79 012 34 56", relationships: [{ userId: "user-005", type: "sibling" }, { userId: "user-001", type: "child" }, { userId: "user-002", type: "child" }], passwordHash: defaultPwHash },
    { id: "user-005", firstName: "Hugo", lastName: "Leroy", name: "Hugo Leroy", email: "hugo@example.com", role: "user", status: "active", lastLogin: now - 2 * day, createdAt: now - 10 * day, tags: ["zone-vesenaz"], address: "Avenue de Miremont 30, 1206 Gen\xE8ve, Suisse", phoneMobile: "+41 79 123 45 00", relationships: [{ userId: "user-004", type: "sibling" }, { userId: "user-001", type: "child" }, { userId: "user-002", type: "child" }], passwordHash: defaultPwHash }
  ];
  demoUsers.forEach((u) => adminUsers.set(u.id, u));
  const demoAudit = [
    { id: v4_default(), timestamp: now - 2 * 6e4, category: "incident", action: "Incident Created", performedBy: "Jean Moreau", details: "Created INC-001: Urgence m\xE9dicale \xE0 Avenue de Champel" },
    { id: v4_default(), timestamp: now - 5 * 6e4, category: "incident", action: "Incident Created", performedBy: "Sophie Laurent", details: "Created INC-008: Feu de cuisine au Chemin du Velours" },
    { id: v4_default(), timestamp: now - 5 * 6e4, category: "auth", action: "User Login", performedBy: "Marie Dupont", details: "Admin login from 192.168.1.100" },
    { id: v4_default(), timestamp: now - 8 * 6e4, category: "incident", action: "Alert Acknowledged", performedBy: "Pierre Martin", details: "Acknowledged INC-002: Alarme incendie Route de Florissant" },
    { id: v4_default(), timestamp: now - 12 * 6e4, category: "auth", action: "User Login", performedBy: "Jean Moreau", details: "Dispatcher login from mobile device" },
    { id: v4_default(), timestamp: now - 15 * 6e4, category: "user", action: "Role Changed", performedBy: "Marie Dupont", targetUser: "Lucas Petit", details: "Role changed from user to responder" },
    { id: v4_default(), timestamp: now - 30 * 6e4, category: "incident", action: "Responder Assigned", performedBy: "Jean Moreau", targetUser: "Camille Bernard", details: "Assigned to INC-003: Chemical spill" },
    { id: v4_default(), timestamp: now - 45 * 6e4, category: "incident", action: "Incident Resolved", performedBy: "Pierre Martin", details: "Resolved INC-005: Alerte SOS \xE0 V\xE9senaz" },
    { id: v4_default(), timestamp: now - 1 * hour, category: "broadcast", action: "Zone Broadcast Sent", performedBy: "Sophie Laurent", details: "Alerte broadcast dans un rayon de 2km autour de Route de Malagnou" },
    { id: v4_default(), timestamp: now - 2 * hour, category: "system", action: "Server Restart", performedBy: "System", details: "Scheduled maintenance restart completed" },
    { id: v4_default(), timestamp: now - 2 * hour, category: "incident", action: "Incident Resolved", performedBy: "Lucas Petit", details: "Resolved INC-006: Chute personne \xE2g\xE9e \xE0 V\xE9senaz" },
    { id: v4_default(), timestamp: now - 3 * hour, category: "user", action: "User Suspended", performedBy: "Marie Dupont", targetUser: "Emma Roux", details: "Suspended for policy violation" },
    { id: v4_default(), timestamp: now - 4 * hour, category: "incident", action: "Incident Resolved", performedBy: "Pierre Martin", details: "Resolved INC-007: Minor vehicle collision" },
    { id: v4_default(), timestamp: now - 5 * hour, category: "auth", action: "User Login", performedBy: "Thomas Leroy", details: "User login from mobile device" },
    { id: v4_default(), timestamp: now - 6 * hour, category: "system", action: "Backup Completed", performedBy: "System", details: "Automated daily backup completed successfully" },
    { id: v4_default(), timestamp: now - 1 * day, category: "user", action: "User Deactivated", performedBy: "Marie Dupont", targetUser: "Nicolas Fournier", details: "Account deactivated upon request" }
  ];
  auditLog.push(...demoAudit);
}
seedDemoData();
(function loadPersistedData() {
  const savedAlerts = loadJsonFile(ALERTS_FILE, []);
  if (savedAlerts.length > 0) {
    alerts.clear();
    savedAlerts.forEach((a) => alerts.set(a.id, a));
    console.log(`[Persist] Loaded ${savedAlerts.length} alerts from disk`);
  }
  const savedPerimeters = loadJsonFile(FAMILY_PERIMETERS_FILE, []);
  savedPerimeters.forEach((p) => familyPerimeters.set(p.id, p));
  if (savedPerimeters.length > 0) {
    console.log(`[Persist] Loaded ${savedPerimeters.length} family perimeters from disk`);
  }
  const savedProxAlerts = loadJsonFile(PROXIMITY_ALERTS_FILE, []);
  proximityAlerts.push(...savedProxAlerts);
  if (savedProxAlerts.length > 0) {
    console.log(`[Persist] Loaded ${savedProxAlerts.length} proximity alerts from disk`);
  }
  const savedHistory = loadJsonFile(LOCATION_HISTORY_FILE, {});
  for (const [uid, entries] of Object.entries(savedHistory)) {
    locationHistory.set(uid, entries);
  }
  const totalEntries = Object.values(savedHistory).reduce((sum, arr) => sum + arr.length, 0);
  if (totalEntries > 0) {
    console.log(`[Persist] Loaded ${totalEntries} location history entries for ${Object.keys(savedHistory).length} users`);
  }
  const savedPatrolReports = loadJsonFile(PATROL_REPORTS_FILE, []);
  patrolReports.push(...savedPatrolReports);
  if (savedPatrolReports.length > 0) {
    console.log(`[Persist] Loaded ${savedPatrolReports.length} patrol reports from disk`);
  }
})();
function persistAlerts() {
  debouncedSave(ALERTS_FILE, Array.from(alerts.values()));
  alerts.forEach((alert) => saveAlertToSupabase(alert));
}
function persistPerimeters() {
  debouncedSave(FAMILY_PERIMETERS_FILE, Array.from(familyPerimeters.values()));
  familyPerimeters.forEach((p) => saveFamilyPerimeterToSupabase(p));
}
function persistProximityAlerts() {
  debouncedSave(PROXIMITY_ALERTS_FILE, proximityAlerts);
}
function persistPatrolReports() {
  debouncedSave(PATROL_REPORTS_FILE, patrolReports);
  patrolReports.forEach((r) => savePatrolReportToSupabase(r));
}
function persistLocationHistory() {
  const obj = {};
  locationHistory.forEach((entries, uid) => {
    obj[uid] = entries;
  });
  debouncedSave(LOCATION_HISTORY_FILE, obj, 5e3);
}
function addAuditEntry(category, action, performedBy, details, targetUser) {
  auditLog.unshift({
    id: v4_default(),
    timestamp: Date.now(),
    category,
    action,
    performedBy,
    targetUser,
    details
  });
}
var WS_PING_INTERVAL = 25e3;
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      console.log("[WS] Terminating dead connection");
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, WS_PING_INTERVAL);
wss.on("connection", (ws) => {
  console.log("New WebSocket connection");
  ws.isAlive = true;
  ws.on("pong", () => {
    ws.isAlive = true;
  });
  let userId = null;
  let userRole = null;
  ws.on("message", (rawData) => {
    try {
      const dataStr = rawData.toString();
      const message = JSON.parse(dataStr);
      if (message.type === "pttTransmit" || message.type === "pttEmergency") {
        console.log(`[WS] Received ${message.type} from ${message.userId || userId}: ${(dataStr.length / 1024).toFixed(1)} KB total, audioBase64: ${message.data?.audioBase64 ? (message.data.audioBase64.length / 1024).toFixed(1) + " KB" : "MISSING"}`);
      }
      handleMessage(ws, message, (id, role) => {
        userId = id;
        userRole = role;
      }, userId, userRole);
    } catch (error) {
      console.error("Failed to parse message:", error);
      ws.send(JSON.stringify({ type: "error", message: "Invalid message format" }));
    }
  });
  ws.on("close", () => {
    wsClientMap.delete(ws);
    if (userId) {
      console.log(`User ${userId} disconnected`);
      const conns = userConnections.get(userId);
      if (conns) {
        conns.delete(ws);
        if (conns.size === 0) userConnections.delete(userId);
      }
      broadcastUserStatus(userId, "offline");
    }
  });
  ws.on("error", (error) => {
    console.error("WebSocket error:", error);
  });
});
function handleMessage(ws, message, setUserContext, connUserId, connUserRole) {
  const userId = message.userId || connUserId || void 0;
  const userRole = message.userRole || connUserRole || void 0;
  const { type, data, timestamp } = message;
  switch (type) {
    case "auth":
      handleAuth(ws, userId, userRole, setUserContext);
      break;
    case "sendAlert":
      if (userId && userRole) {
        handleCreateAlert(ws, userId, userRole, data);
      } else {
        ws.send(JSON.stringify({ type: "error", message: "Unauthorized to create alerts - not authenticated" }));
      }
      break;
    case "updateLocation":
      handleLocationUpdate(ws, userId, userRole, data);
      break;
    case "updateStatus":
      if (userRole === "responder") {
        handleStatusUpdate(ws, userId, data);
      }
      break;
    case "acknowledgeAlert":
      handleAcknowledgeAlert(ws, userId, data);
      break;
    case "getAlerts":
      handleGetAlerts(ws, userId, userRole);
      break;
    case "getResponders":
      if (userRole === "dispatcher") {
        handleGetResponders(ws);
      }
      break;
    case "ping":
      ws.send(JSON.stringify({ type: "pong", timestamp: Date.now() }));
      break;
    // ─── PTT WebSocket Messages ────────────────────────────────────────────────
    case "pttTransmit":
      if (userId && userRole) {
        handlePTTTransmit(ws, userId, userRole, data);
      }
      break;
    case "pttJoinChannel":
      if (userId && userRole) {
        handlePTTJoinChannel(ws, userId, userRole, data);
      }
      break;
    case "pttStartTalking":
      if (userId && userRole) {
        handlePTTTalkingState(ws, userId, userRole, data, true);
      }
      break;
    case "pttStopTalking":
      if (userId && userRole) {
        handlePTTTalkingState(ws, userId, userRole, data, false);
      }
      break;
    case "pttEmergency":
      if (userId && userRole) {
        handlePTTEmergency(ws, userId, userRole, data);
      }
      break;
    default:
      console.warn(`Unknown message type: ${type}`);
  }
}
function handleAuth(ws, userId, userRole, setUserContext) {
  if (!userId || !userRole) {
    ws.send(JSON.stringify({ type: "error", message: "Missing userId or userRole" }));
    return;
  }
  const user = {
    id: userId,
    email: `${userId}@talion.local`,
    role: userRole,
    status: userRole === "responder" ? "available" : void 0,
    lastSeen: Date.now()
  };
  users.set(userId, user);
  if (!userConnections.has(userId)) {
    userConnections.set(userId, /* @__PURE__ */ new Set());
  }
  userConnections.get(userId).add(ws);
  wsClientMap.set(ws, userId);
  setUserContext(userId, userRole);
  ws.send(JSON.stringify({
    type: "authSuccess",
    userId,
    userRole,
    timestamp: Date.now()
  }));
  console.log(`User ${userId} (${userRole}) authenticated`);
  addAuditEntry("auth", "User Login", userId, `${userRole} login via WebSocket`);
  const activeAlerts = Array.from(alerts.values()).filter((a) => a.status === "active").map((a) => ({
    ...a,
    respondingNames: (a.respondingUsers || []).map((uid) => adminUsers.get(uid)?.name || uid)
  }));
  ws.send(JSON.stringify({
    type: "alertsSnapshot",
    data: activeAlerts
  }));
  broadcastUserStatus(userId, "online");
}
async function handleCreateAlert(ws, userId, userRole, alertData) {
  const alert = {
    id: await generateIncidentId(alertData.type || "other", userId, alertData.location || {}),
    type: alertData.type || "other",
    severity: alertData.severity || "medium",
    location: alertData.location || { latitude: 0, longitude: 0, address: "Unknown" },
    description: alertData.description || "",
    createdBy: userId,
    createdAt: Date.now(),
    status: "active",
    respondingUsers: [],
    photos: []
  };
  alerts.set(alert.id, alert);
  persistAlerts();
  console.log(`New alert created: ${alert.id} by ${userId}`);
  addAuditEntry("incident", "Incident Created", userId, `Created ${alert.id}: ${alert.type} at ${alert.location.address}`);
  broadcastMessage({ type: "newAlert", data: alert });
  ws.send(JSON.stringify({ type: "alertCreated", alertId: alert.id, timestamp: Date.now() }));
}
function haversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371e3;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
function checkGeofences(userId, location) {
  const responderUser = users.get(userId);
  const responderName = responderUser ? adminUsers.get(userId)?.name || userId : userId;
  geofenceZones.forEach((zone, zoneId) => {
    const dist = haversineDistance(location.latitude, location.longitude, zone.center.latitude, zone.center.longitude);
    const insideNow = dist <= zone.radiusKm * 1e3;
    if (!responderZoneState.has(zoneId)) {
      responderZoneState.set(zoneId, /* @__PURE__ */ new Set());
    }
    const zoneSet = responderZoneState.get(zoneId);
    const wasInside = zoneSet.has(userId);
    if (insideNow && !wasInside) {
      zoneSet.add(userId);
      const event = {
        id: v4_default(),
        zoneId,
        responderId: userId,
        responderName,
        eventType: "entry",
        timestamp: Date.now(),
        location
      };
      geofenceEvents.unshift(event);
      addAuditEntry("broadcast", "Geofence Entry", userId, `${responderName} entered zone ${zoneId} (${zone.severity} \u2014 ${zone.radiusKm}km)`);
      broadcastMessage({
        type: "geofenceEntry",
        data: { ...event, zone: { id: zone.id, severity: zone.severity, radiusKm: zone.radiusKm, message: zone.message } }
      });
      console.log(`[Geofence] ${responderName} ENTERED zone ${zoneId}`);
    } else if (!insideNow && wasInside) {
      zoneSet.delete(userId);
      const event = {
        id: v4_default(),
        zoneId,
        responderId: userId,
        responderName,
        eventType: "exit",
        timestamp: Date.now(),
        location
      };
      geofenceEvents.unshift(event);
      addAuditEntry("broadcast", "Geofence Exit", userId, `${responderName} exited zone ${zoneId} (${zone.severity} \u2014 ${zone.radiusKm}km)`);
      broadcastMessage({
        type: "geofenceExit",
        data: { ...event, zone: { id: zone.id, severity: zone.severity, radiusKm: zone.radiusKm, message: zone.message } }
      });
      console.log(`[Geofence] ${responderName} EXITED zone ${zoneId}`);
    }
  });
}
var sharingUsers = /* @__PURE__ */ new Set();
var LOCATION_TTL_MS = 3e4;
function getFamilyMemberIds(userId) {
  const adminUser = adminUsers.get(userId);
  if (!adminUser || !adminUser.relationships) return [];
  const familyTypes = ["parent", "child", "sibling", "spouse"];
  return adminUser.relationships.filter((r) => familyTypes.includes(r.type)).map((r) => r.userId);
}
function broadcastToUsers(userIds, message) {
  const data = JSON.stringify(message);
  userIds.forEach((uid) => {
    const connections = userConnections.get(uid);
    if (connections) {
      connections.forEach((client) => {
        if (client.readyState === 1) {
          client.send(data);
        }
      });
    }
  });
}
function checkFamilyPerimeters(userId, locationData) {
  if (!locationData?.latitude || !locationData?.longitude) return;
  for (const [pId, perimeter] of familyPerimeters) {
    if (!perimeter.active || perimeter.targetUserId !== userId) continue;
    const dist = haversineDistance(
      perimeter.center.latitude,
      perimeter.center.longitude,
      locationData.latitude,
      locationData.longitude
    );
    const isOutside = dist > perimeter.radiusMeters;
    const wasOutside = perimeterState.get(pId) || false;
    if (isOutside && !wasOutside) {
      perimeterState.set(pId, true);
      const alert = {
        id: v4_default(),
        perimeterId: pId,
        targetUserId: userId,
        targetUserName: perimeter.targetUserName,
        ownerId: perimeter.ownerId,
        eventType: "exit",
        distanceMeters: Math.round(dist),
        location: { latitude: locationData.latitude, longitude: locationData.longitude },
        timestamp: Date.now(),
        acknowledged: false
      };
      proximityAlerts.unshift(alert);
      if (proximityAlerts.length > 500) proximityAlerts.length = 500;
      persistProximityAlerts();
      broadcastToUsers([perimeter.ownerId], {
        type: "proximityAlert",
        data: alert
      });
      sendProximityPush(perimeter.ownerId, alert, perimeter);
      console.log(`[Proximity] ${perimeter.targetUserName} LEFT perimeter ${pId} (${Math.round(dist)}m from center, radius ${perimeter.radiusMeters}m)`);
    } else if (!isOutside && wasOutside) {
      perimeterState.set(pId, false);
      const alert = {
        id: v4_default(),
        perimeterId: pId,
        targetUserId: userId,
        targetUserName: perimeter.targetUserName,
        ownerId: perimeter.ownerId,
        eventType: "entry",
        distanceMeters: Math.round(dist),
        location: { latitude: locationData.latitude, longitude: locationData.longitude },
        timestamp: Date.now(),
        acknowledged: false
      };
      proximityAlerts.unshift(alert);
      if (proximityAlerts.length > 500) proximityAlerts.length = 500;
      persistProximityAlerts();
      broadcastToUsers([perimeter.ownerId], {
        type: "proximityAlert",
        data: alert
      });
      console.log(`[Proximity] ${perimeter.targetUserName} RETURNED to perimeter ${pId}`);
    }
  }
}
async function sendProximityPush(ownerId, alert, perimeter) {
  const targetTokens = [];
  for (const [token, entry] of pushTokens) {
    if (entry.userId === ownerId) targetTokens.push(token);
  }
  if (targetTokens.length === 0) return;
  const emoji = alert.eventType === "exit" ? "\u26A0\uFE0F" : "\u2705";
  const action = alert.eventType === "exit" ? "a quitt\xE9" : "est revenu(e) dans";
  const messages2 = targetTokens.map((token) => ({
    to: token,
    sound: "default",
    title: `${emoji} Alerte de proximit\xE9`,
    body: `${alert.targetUserName} ${action} le p\xE9rim\xE8tre (${Math.round(alert.distanceMeters)}m${perimeter.center.address ? " - " + perimeter.center.address : ""})`,
    data: { type: "proximity", alertId: alert.id, perimeterId: perimeter.id },
    priority: alert.eventType === "exit" ? "high" : "normal",
    channelId: "family-alerts"
  }));
  try {
    await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: { "Accept": "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(messages2)
    });
  } catch (e) {
    console.error("[Proximity Push] Error:", e);
  }
}
function handleLocationUpdate(ws, userId, userRole, locationData) {
  if (!userId) return;
  console.log(`[Location] WS update from ${userId} (${userRole}): lat=${locationData?.latitude}, lng=${locationData?.longitude}`);
  let user = users.get(userId);
  if (!user) {
    const adminUser = adminUsers.get(userId);
    user = {
      id: userId,
      email: adminUser?.email || `${userId}@unknown`,
      role: userRole,
      status: "active",
      lastSeen: Date.now()
    };
    users.set(userId, user);
    console.log(`[Location] Created user entry for ${userId} (${userRole})`);
  }
  user.location = locationData;
  user.lastSeen = Date.now();
  users.set(userId, user);
  sharingUsers.add(userId);
  if (locationData?.latitude != null && locationData?.longitude != null) {
    const entry = {
      userId,
      latitude: locationData.latitude,
      longitude: locationData.longitude,
      timestamp: Date.now()
    };
    let history = locationHistory.get(userId);
    if (!history) {
      history = [];
      locationHistory.set(userId, history);
    }
    history.push(entry);
    if (history.length > MAX_HISTORY_PER_USER) {
      history.splice(0, history.length - MAX_HISTORY_PER_USER);
    }
    persistLocationHistory();
  }
  checkFamilyPerimeters(userId, locationData);
  if (user.role === "responder") {
    broadcastToRole("dispatcher", {
      type: "responderLocationUpdate",
      userId,
      location: locationData,
      timestamp: Date.now()
    });
    broadcastToRole("admin", {
      type: "responderLocationUpdate",
      userId,
      location: locationData,
      timestamp: Date.now()
    });
    checkGeofences(userId, locationData);
  } else {
    broadcastToRole("dispatcher", {
      type: "userLocationUpdate",
      userId,
      location: locationData,
      timestamp: Date.now()
    });
  }
  const familyIds = getFamilyMemberIds(userId);
  if (familyIds.length > 0) {
    const adminUser = adminUsers.get(userId);
    broadcastToUsers(familyIds, {
      type: "familyLocationUpdate",
      userId,
      userName: adminUser?.name || userId,
      location: locationData,
      timestamp: Date.now()
    });
  }
}
function handleStatusUpdate(ws, userId, statusData) {
  const user = users.get(userId);
  if (user && user.role === "responder") {
    user.status = statusData.status;
    user.lastSeen = Date.now();
    users.set(userId, user);
    console.log(`Responder ${userId} status updated to ${statusData.status}`);
    broadcastToRole("dispatcher", {
      type: "responderStatusUpdate",
      userId,
      status: statusData.status,
      timestamp: Date.now()
    });
  }
}
function handleAcknowledgeAlert(ws, userId, alertData) {
  const alert = alerts.get(alertData.alertId);
  if (alert) {
    if (!alert.respondingUsers.includes(userId)) {
      alert.respondingUsers.push(userId);
    }
    alert.status = "acknowledged";
    alerts.set(alert.id, alert);
    persistAlerts();
    console.log(`Alert ${alert.id} acknowledged by ${userId}`);
    addAuditEntry("incident", "Alert Acknowledged", userId, `Acknowledged ${alert.id}`);
    broadcastMessage({ type: "alertAcknowledged", alertId: alert.id, userId, timestamp: Date.now() });
  }
}
function handleGetAlerts(ws, userId, userRole) {
  const userAlerts = Array.from(alerts.values()).filter((alert) => {
    if (alert.status === "resolved" || alert.status === "cancelled") return false;
    return true;
  });
  ws.send(JSON.stringify({ type: "alertsList", data: userAlerts, timestamp: Date.now() }));
}
function handleGetResponders(ws) {
  const connectedResponders = Array.from(users.values()).filter((u) => u.role === "responder");
  const enriched = connectedResponders.map((r) => {
    const adminUser = adminUsers.get(r.id);
    return {
      ...r,
      name: adminUser?.name || r.id,
      firstName: adminUser?.firstName || "",
      lastName: adminUser?.lastName || "",
      email: adminUser?.email || "",
      phone: adminUser?.phoneMobile || "",
      tags: adminUser?.tags || [],
      isConnected: true
    };
  });
  ws.send(JSON.stringify({ type: "respondersList", data: enriched, timestamp: Date.now() }));
}
function broadcastMessage(message) {
  const data = JSON.stringify(message);
  wss.clients.forEach((client) => {
    if (client.readyState === 1) {
      client.send(data);
    }
  });
}
function broadcastToRole(role, message) {
  const data = JSON.stringify(message);
  const targetUsers = Array.from(users.values()).filter((u) => u.role === role);
  targetUsers.forEach((user) => {
    const connections = userConnections.get(user.id);
    if (connections) {
      connections.forEach((client) => {
        if (client.readyState === 1) {
          client.send(data);
        }
      });
    }
  });
}
function broadcastUserStatus(userId, status) {
  broadcastToRole("dispatcher", {
    type: "userStatusChange",
    userId,
    status,
    timestamp: Date.now()
  });
}
app.post("/auth/login", (req, res) => {
  const { email, password } = req.body;
  const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown").split(",")[0].trim();
  const userAgent = req.headers["user-agent"] || "unknown";
  if (!email || !password) {
    return res.status(400).json({ error: "Email and password are required" });
  }
  const user = Array.from(adminUsers.values()).find((u) => u.email.toLowerCase() === email.toLowerCase());
  if (!user) {
    addLoginHistory({ userId: "unknown", userName: "Unknown", email, timestamp: Date.now(), ip, userAgent, status: "failed_email" });
    return res.status(401).json({ error: "Invalid email or password" });
  }
  if (user.status === "deactivated") {
    addLoginHistory({ userId: user.id, userName: user.name, email, timestamp: Date.now(), ip, userAgent, status: "account_deactivated" });
    return res.status(403).json({ error: "Account is deactivated. Contact your administrator." });
  }
  if (user.status === "suspended") {
    addLoginHistory({ userId: user.id, userName: user.name, email, timestamp: Date.now(), ip, userAgent, status: "account_suspended" });
    return res.status(403).json({ error: "Account is suspended. Contact your administrator." });
  }
  if (!user.passwordHash) {
    addLoginHistory({ userId: user.id, userName: user.name, email, timestamp: Date.now(), ip, userAgent, status: "no_password" });
    return res.status(401).json({ error: "No password set for this account. Contact your administrator." });
  }
  const valid = bcryptjs_default.compareSync(password, user.passwordHash);
  if (!valid) {
    addLoginHistory({ userId: user.id, userName: user.name, email, timestamp: Date.now(), ip, userAgent, status: "failed_password" });
    return res.status(401).json({ error: "Invalid email or password" });
  }
  addLoginHistory({ userId: user.id, userName: user.name, email, timestamp: Date.now(), ip, userAgent, status: "success" });
  user.lastLogin = Date.now();
  adminUsers.set(user.id, user);
  addAuditEntry("auth", "User Login", user.name, `Login via email/password from ${parseDevice(userAgent)} (${ip})`, void 0);
  const { passwordHash, ...safeUser } = user;
  res.json({
    success: true,
    user: safeUser,
    token: `session-${user.id}-${Date.now()}`
  });
});
app.put("/auth/change-password", (req, res) => {
  const { userId, currentPassword, newPassword } = req.body;
  if (!userId || !newPassword) {
    return res.status(400).json({ error: "userId and newPassword are required" });
  }
  const user = adminUsers.get(userId);
  if (!user) return res.status(404).json({ error: "User not found" });
  if (user.passwordHash && currentPassword) {
    if (!bcryptjs_default.compareSync(currentPassword, user.passwordHash)) {
      return res.status(401).json({ error: "Current password is incorrect" });
    }
  }
  user.passwordHash = bcryptjs_default.hashSync(newPassword, 10);
  adminUsers.set(user.id, user);
  addAuditEntry("auth", "Password Changed", user.name, "Password updated", void 0);
  res.json({ success: true });
});
var passwordResetCodes = /* @__PURE__ */ new Map();
app.post("/auth/request-password-reset", (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: "Email is required" });
  const user = Array.from(adminUsers.values()).find((u) => u.email.toLowerCase() === email.toLowerCase());
  if (!user) {
    return res.json({ success: true, message: "Si un compte existe avec cet email, un code de r\xE9initialisation a \xE9t\xE9 g\xE9n\xE9r\xE9." });
  }
  if (user.status === "deactivated" || user.status === "suspended") {
    return res.json({ success: true, message: "Si un compte existe avec cet email, un code de r\xE9initialisation a \xE9t\xE9 g\xE9n\xE9r\xE9." });
  }
  const code = String(Math.floor(1e5 + Math.random() * 9e5));
  const expiresAt = Date.now() + 15 * 60 * 1e3;
  passwordResetCodes.set(code, { userId: user.id, code, expiresAt });
  addAuditEntry("auth", "Password Reset Requested", user.name, `Reset code generated for ${user.email}`, void 0);
  wss.clients.forEach((client) => {
    if (client.readyState === 1 && (client.userRole === "admin" || client.userRole === "dispatcher")) {
      client.send(JSON.stringify({
        type: "passwordResetRequest",
        userId: user.id,
        userName: user.name,
        email: user.email,
        code,
        expiresAt
      }));
    }
  });
  console.log(`[Auth] Password reset code for ${user.email}: ${code} (expires in 15 min)`);
  res.json({ success: true, message: "Si un compte existe avec cet email, un code de r\xE9initialisation a \xE9t\xE9 g\xE9n\xE9r\xE9." });
});
app.post("/auth/reset-password", (req, res) => {
  const { code, newPassword } = req.body;
  if (!code || !newPassword) return res.status(400).json({ error: "Code and new password are required" });
  if (newPassword.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });
  const resetEntry = passwordResetCodes.get(code);
  if (!resetEntry) return res.status(400).json({ error: "Code invalide ou expir\xE9" });
  if (Date.now() > resetEntry.expiresAt) {
    passwordResetCodes.delete(code);
    return res.status(400).json({ error: "Code expir\xE9. Veuillez en demander un nouveau." });
  }
  const user = adminUsers.get(resetEntry.userId);
  if (!user) {
    passwordResetCodes.delete(code);
    return res.status(404).json({ error: "User not found" });
  }
  user.passwordHash = bcryptjs_default.hashSync(newPassword, 10);
  adminUsers.set(user.id, user);
  passwordResetCodes.delete(code);
  addAuditEntry("auth", "Password Reset Completed", user.name, `Password reset via code for ${user.email}`, void 0);
  console.log(`[Auth] Password reset completed for ${user.email}`);
  res.json({ success: true, message: "Mot de passe r\xE9initialis\xE9 avec succ\xE8s." });
});
app.get("/admin/login-history", (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 50;
  const status = req.query.status;
  const userId = req.query.userId;
  const search = (req.query.search || "").toLowerCase();
  let filtered = [...loginHistory];
  if (status && status !== "all") {
    filtered = filtered.filter((e) => e.status === status);
  }
  if (userId) {
    filtered = filtered.filter((e) => e.userId === userId);
  }
  if (search) {
    filtered = filtered.filter(
      (e) => e.userName.toLowerCase().includes(search) || e.email.toLowerCase().includes(search) || e.ip.includes(search) || e.device.toLowerCase().includes(search)
    );
  }
  const total = filtered.length;
  const start = (page - 1) * limit;
  const entries = filtered.slice(start, start + limit);
  res.json({
    entries,
    total,
    page,
    totalPages: Math.ceil(total / limit)
  });
});
app.get("/admin/users/:id/login-history", (req, res) => {
  const userId = req.params.id;
  const user = adminUsers.get(userId);
  if (!user) return res.status(404).json({ error: "User not found" });
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 50;
  const entries = loginHistory.filter((e) => e.userId === userId);
  const total = entries.length;
  const start = (page - 1) * limit;
  res.json({
    user: { id: user.id, name: user.name, email: user.email },
    entries: entries.slice(start, start + limit),
    total,
    page,
    totalPages: Math.ceil(total / limit)
  });
});
app.get("/admin/login-stats", (req, res) => {
  const now = Date.now();
  const last24h = loginHistory.filter((e) => e.timestamp > now - 864e5);
  const last7d = loginHistory.filter((e) => e.timestamp > now - 7 * 864e5);
  const successCount24h = last24h.filter((e) => e.status === "success").length;
  const failedCount24h = last24h.filter((e) => e.status !== "success").length;
  const successCount7d = last7d.filter((e) => e.status === "success").length;
  const failedCount7d = last7d.filter((e) => e.status !== "success").length;
  const uniqueUsers24h = new Set(last24h.filter((e) => e.status === "success").map((e) => e.userId)).size;
  const userCounts = {};
  last7d.filter((e) => e.status === "success").forEach((e) => {
    if (!userCounts[e.userId]) userCounts[e.userId] = { name: e.userName, count: 0 };
    userCounts[e.userId].count++;
  });
  const topUsers = Object.entries(userCounts).sort((a, b) => b[1].count - a[1].count).slice(0, 5).map(([id, data]) => ({ userId: id, name: data.name, loginCount: data.count }));
  const failedByIp = {};
  last24h.filter((e) => e.status !== "success").forEach((e) => {
    failedByIp[e.ip] = (failedByIp[e.ip] || 0) + 1;
  });
  const suspiciousIps = Object.entries(failedByIp).filter(([_, count]) => count >= 3).map(([ip, count]) => ({ ip, failedAttempts: count }));
  res.json({
    last24h: { success: successCount24h, failed: failedCount24h, uniqueUsers: uniqueUsers24h },
    last7d: { success: successCount7d, failed: failedCount7d },
    topUsers,
    suspiciousIps,
    totalEntries: loginHistory.length
  });
});
app.post("/admin/users/:id/photo", upload.single("photo"), (req, res) => {
  const user = adminUsers.get(req.params.id);
  if (!user) return res.status(404).json({ error: "User not found" });
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  user.photoUrl = `/uploads/${req.file.filename}`;
  adminUsers.set(user.id, user);
  saveAdminUserToSupabase(user);
  addAuditEntry("user_updated", `Profile photo updated for ${user.firstName} ${user.lastName}`, "admin");
  const { passwordHash, ...safe } = user;
  res.json({ success: true, user: safe });
});
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    connectedUsers: users.size,
    activeAlerts: Array.from(alerts.values()).filter((a) => a.status === "active").length,
    timestamp: Date.now()
  });
});
var geocodeCache = /* @__PURE__ */ new Map();
app.get("/api/geocode", async (req, res) => {
  const q = req.query.q;
  if (!q || q.length < 2) return res.json([]);
  const cached = geocodeCache.get(q);
  if (cached && Date.now() - cached.ts < 3e5) return res.json(cached.data);
  try {
    const mapboxToken = process.env.MAPBOX_TOKEN;
    if (mapboxToken) {
      const url2 = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(q)}.json?access_token=${mapboxToken}&limit=5&types=address&language=fr`;
      const response2 = await fetch(url2);
      if (!response2.ok) throw new Error("Mapbox error");
      const data2 = await response2.json();
      const results = (data2.features || []).map((f) => {
        const ctx = f.context || [];
        const city = ctx.find((c) => c.id?.startsWith("place"))?.text || "";
        const country = ctx.find((c) => c.id?.startsWith("country"))?.text || "";
        const postcode = ctx.find((c) => c.id?.startsWith("postcode"))?.text || "";
        return {
          display_name: f.place_name,
          lat: f.center[1].toString(),
          lon: f.center[0].toString(),
          address: {
            house_number: f.address || "",
            road: f.text || "",
            city,
            town: city,
            postcode,
            country
          }
        };
      });
      geocodeCache.set(q, { data: results, ts: Date.now() });
      return res.json(results);
    }
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&addressdetails=1&limit=5`;
    const response = await fetch(url, { headers: { "User-Agent": "TalionCrisisComm/1.0" } });
    if (!response.ok) return res.status(response.status).json({ error: "Geocode error" });
    const data = await response.json();
    geocodeCache.set(q, { data, ts: Date.now() });
    res.json(data);
  } catch (err) {
    console.error("Geocode proxy error:", err);
    res.status(500).json({ error: "Geocode proxy failed" });
  }
});
app.get("/alerts", (req, res) => {
  const userRole = req.query.role;
  const userId = req.query.userId;
  const visibleAlerts = Array.from(alerts.values()).filter((a) => {
    if (a.status === "resolved") return false;
    if (userRole === "user") {
      const userName = adminUsers.get(userId)?.name || userId;
      return a.createdBy === userId || a.createdBy === userName || (a.respondingUsers || []).includes(userId) || (a.status === "active" || a.status === "acknowledged" || a.status === "dispatched");
    }
    return true;
  }).map((a) => {
    const respondingNames = (a.respondingUsers || []).map((uid) => {
      const admin = adminUsers.get(uid);
      return admin?.name || uid;
    });
    const creatorName = adminUsers.get(a.createdBy)?.name || a.createdBy;
    return { ...a, respondingNames, createdByName: creatorName };
  });
  res.json(visibleAlerts);
});
app.get("/alerts/:id", (req, res) => {
  const alert = alerts.get(req.params.id);
  if (!alert) return res.status(404).json({ error: "Alert not found" });
  const respondingDetails = alert.respondingUsers.map((uid) => {
    const user = users.get(uid);
    const admin = adminUsers.get(uid);
    return {
      id: uid,
      name: admin?.name || uid,
      phone: admin?.phoneMobile || "",
      tags: admin?.tags || [],
      status: user?.status || responderStatusOverrides.get(uid)?.status || "unknown",
      location: user?.location || null,
      isConnected: !!user
    };
  });
  const respondingNames = alert.respondingUsers.map((uid) => adminUsers.get(uid)?.name || uid);
  res.json({ ...alert, respondingDetails, respondingNames });
});
app.put("/alerts/:id", (req, res) => {
  const alert = alerts.get(req.params.id);
  if (!alert) return res.status(404).json({ error: "Alert not found" });
  const { location, description } = req.body;
  if (location) alert.location = location;
  if (description) alert.description = description;
  alerts.set(alert.id, alert);
  persistAlerts();
  saveAlertToSupabase(alert).catch((e) => console.error("[Unassign] Supabase save error:", e));
  broadcastMessage({ type: "alertUpdate", data: { ...alert, respondingNames: (alert.respondingUsers || []).map((uid) => adminUsers.get(uid)?.name || uid) } });
  res.json({ success: true });
});
app.put("/alerts/:id/acknowledge", (req, res) => {
  const alert = alerts.get(req.params.id);
  if (!alert) return res.status(404).json({ error: "Alert not found" });
  alert.status = "acknowledged";
  alerts.set(alert.id, alert);
  persistAlerts();
  addAuditEntry("incident", "Alert Acknowledged", req.body?.userId || "Mobile App", `Acknowledged ${alert.id}`);
  broadcastMessage({ type: "alertAcknowledged", alertId: alert.id, timestamp: Date.now() });
  res.json({ success: true });
});
app.put("/alerts/:id/resolve", (req, res) => {
  const alert = alerts.get(req.params.id);
  if (!alert) return res.status(404).json({ error: "Alert not found" });
  alert.status = "resolved";
  alerts.set(alert.id, alert);
  persistAlerts();
  addAuditEntry("incident", "Incident Resolved", req.body?.userId || "Mobile App", `Resolved ${alert.id}: ${alert.type} at ${alert.location.address}`);
  broadcastMessage({ type: "alertResolved", alertId: alert.id, timestamp: Date.now() });
  res.json({ success: true });
});
app.get("/responders", (req, res) => {
  const responders = Array.from(users.values()).filter((u) => u.role === "responder");
  res.json(responders);
});
app.post("/dispatch/incidents", async (req, res) => {
  const { type, severity, location, description, createdBy } = req.body;
  const alert = {
    id: await generateIncidentId(type || "other", createdBy || "Dispatch Console", location || {}),
    type: type || "other",
    severity: severity || "medium",
    location: location || { latitude: 0, longitude: 0, address: "Unknown" },
    description: description || "",
    createdBy: createdBy || "Dispatch Console",
    createdAt: Date.now(),
    status: "active",
    respondingUsers: []
  };
  alerts.set(alert.id, alert);
  persistAlerts();
  saveAlertToSupabase(alert).catch(() => {
  });
  broadcastMessage({ type: "newAlert", data: alert });
  sendPushToDispatchersAndResponders(alert, alert.createdBy).catch(() => {
  });
  for (const [token, entry] of pushTokens) {
    if (entry.userRole === "user") {
      sendPushToUser(
        entry.userId,
        `\u{1F6A8} Nouvel incident \u2014 ${alert.type.toUpperCase()}`,
        alert.description || alert.location?.address || "Incident signal\xE9",
        { type: alert.type, alertId: alert.id }
      ).catch(() => {
      });
    }
  }
  res.json({ success: true, id: alert.id, alert });
});
app.post("/alerts", requireAuth, async (req, res) => {
  const { type, severity, location, description, createdBy } = req.body;
  const alert = {
    id: await generateIncidentId(type || "other", createdBy || "system", location || {}),
    type: type || "other",
    severity: severity || "medium",
    location: location || { latitude: 0, longitude: 0, address: "Unknown" },
    description: description || "",
    createdBy: createdBy || "system",
    createdAt: Date.now(),
    status: "active",
    respondingUsers: []
  };
  alerts.set(alert.id, alert);
  persistAlerts();
  broadcastMessage({ type: "newAlert", data: alert });
  if (alert.type === "sos") {
    sendPushToDispatchersAndResponders(alert, createdBy || "system");
  } else {
    sendPushToAllUsers({
      title: `\u{1F6A8} ${(alert.type || "Incident").toUpperCase()} - ${(alert.severity || "medium").toUpperCase()}`,
      body: `${alert.description || "New incident reported"}${alert.location?.address ? "\n\u{1F4CD} " + alert.location.address : ""}`,
      data: { type: "incident", alertId: alert.id, severity: alert.severity }
    });
  }
  res.json({ success: true, alertId: alert.id });
});
app.post("/api/push-token", (req, res) => {
  const { token, userId, userRole } = req.body;
  if (!token || !userId) {
    return res.status(400).json({ error: "Missing token or userId" });
  }
  pushTokens.set(token, {
    token,
    userId,
    userRole: userRole || "user",
    registeredAt: Date.now()
  });
  savePushTokenToSupabase({ token, userId, userRole: userRole || "user", registeredAt: Date.now() });
  console.log(`[Push] Token registered for ${userId} (${userRole}). Total tokens: ${pushTokens.size}`);
  res.json({ success: true });
});
app.get("/api/debug/push-tokens", (_req, res) => {
  const tokens = Array.from(pushTokens.values()).map((e) => ({
    userId: e.userId,
    userRole: e.userRole,
    token: e.token,
    registeredAt: e.registeredAt
  }));
  res.json(tokens);
});
app.delete("/api/push-token", (req, res) => {
  const { token } = req.body;
  if (token) {
    pushTokens.delete(token);
    deletePushTokenFromSupabase(token);
  }
  res.json({ success: true });
});
async function sendPushToUser(userId, title, body, data = {}) {
  const targetTokens = [];
  for (const [token, entry] of pushTokens) {
    if (entry.userId === userId) {
      targetTokens.push(token);
    }
  }
  if (targetTokens.length === 0) {
    console.log(`[Push] No tokens for user ${userId}, skipping`);
    return;
  }
  console.log(`[Push] Sending targeted push to ${userId} (${targetTokens.length} device(s))`);
  const messages2 = targetTokens.map((token) => ({
    to: token,
    sound: "default",
    title,
    body,
    data,
    priority: "high",
    channelId: "incident-updates"
  }));
  try {
    const response = await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: {
        "Accept": "application/json",
        "Accept-Encoding": "gzip, deflate",
        "Content-Type": "application/json"
      },
      body: JSON.stringify(messages2)
    });
    if (!response.ok) {
      console.error(`[Push] Expo API error for ${userId}: ${response.status}`);
    } else {
      const result = await response.json();
      console.log(`[Push] Sent to ${userId}:`, result.data?.length || 0, "tickets");
    }
  } catch (err) {
    console.error(`[Push] Failed to send to ${userId}:`, err);
  }
}
async function sendPushToDispatchersAndResponders(alert, senderName) {
  const targetTokens = [];
  for (const [token, entry] of pushTokens) {
    if (entry.userRole === "dispatcher" || entry.userRole === "responder" || entry.userRole === "admin") {
      if (entry.userId !== alert.createdBy) {
        targetTokens.push(token);
      }
    }
  }
  if (targetTokens.length === 0) {
    console.log("[Push] No dispatcher/responder tokens registered, skipping push");
    return;
  }
  console.log(`[Push] Sending SOS push to ${targetTokens.length} dispatcher/responder devices`);
  const messages2 = targetTokens.map((token) => ({
    to: token,
    sound: "default",
    title: `\u{1F6A8} SOS ALERT - ${alert.type.toUpperCase()}`,
    body: `${senderName} triggered an emergency alert. ${alert.location?.address || "Location shared"}`,
    data: {
      type: "sos",
      alertId: alert.id,
      severity: alert.severity,
      alertType: alert.type
    },
    priority: "high",
    channelId: "sos-alerts"
  }));
  try {
    const chunks = [];
    for (let i = 0; i < messages2.length; i += 100) {
      chunks.push(messages2.slice(i, i + 100));
    }
    for (const chunk of chunks) {
      const response = await fetch("https://exp.host/--/api/v2/push/send", {
        method: "POST",
        headers: {
          "Accept": "application/json",
          "Accept-Encoding": "gzip, deflate",
          "Content-Type": "application/json"
        },
        body: JSON.stringify(chunk)
      });
      if (!response.ok) {
        console.error(`[Push] Expo API error: ${response.status} ${response.statusText}`);
      } else {
        const result = await response.json();
        console.log(`[Push] Expo API response:`, JSON.stringify(result.data?.length || 0), "tickets");
      }
    }
  } catch (error) {
    console.error("[Push] Failed to send push notifications:", error);
  }
}
async function sendPushToAllUsers(alert, senderName) {
  const targetTokens = [];
  for (const [token, _entry] of pushTokens) {
    targetTokens.push(token);
  }
  if (targetTokens.length === 0) {
    console.log("[Push] No tokens registered, skipping broadcast push");
    return;
  }
  console.log(`[Push] Sending broadcast push to ${targetTokens.length} devices`);
  const SEVERITY_EMOJI = { critical: "\u{1F6A8}", high: "\u26A0\uFE0F", medium: "\u{1F4E2}", low: "\u2139\uFE0F" };
  const emoji = SEVERITY_EMOJI[alert.severity] || "\u{1F4E2}";
  const messages2 = targetTokens.map((token) => ({
    to: token,
    sound: "default",
    title: `${emoji} BROADCAST - ${alert.severity.toUpperCase()}`,
    body: `${senderName}: ${alert.description}`,
    data: {
      type: "broadcast",
      alertId: alert.id,
      severity: alert.severity
    },
    priority: alert.severity === "critical" || alert.severity === "high" ? "high" : "normal",
    channelId: "broadcast-alerts"
  }));
  try {
    const chunks = [];
    for (let i = 0; i < messages2.length; i += 100) {
      chunks.push(messages2.slice(i, i + 100));
    }
    for (const chunk of chunks) {
      const response = await fetch("https://exp.host/--/api/v2/push/send", {
        method: "POST",
        headers: {
          "Accept": "application/json",
          "Accept-Encoding": "gzip, deflate",
          "Content-Type": "application/json"
        },
        body: JSON.stringify(chunk)
      });
      if (!response.ok) {
        console.error(`[Push] Expo API error: ${response.status} ${response.statusText}`);
      } else {
        const result = await response.json();
        console.log(`[Push] Broadcast push sent:`, JSON.stringify(result.data?.length || 0), "tickets");
      }
    }
  } catch (error) {
    console.error("[Push] Failed to send broadcast push notifications:", error);
  }
}
app.post("/api/sos", async (req, res) => {
  const { type, severity, location, description, userId, userName, userRole } = req.body;
  console.log(`[SOS REST] Received SOS from ${userName || userId || "unknown"}`);
  const alert = {
    id: await generateIncidentId(type || "sos", userName || userId || "mobile-user", location || {}),
    type: type || "sos",
    severity: severity || "critical",
    location: location || { latitude: 0, longitude: 0, address: "Unknown" },
    description: description || `SOS Alert from ${userName || "Unknown"}`,
    createdBy: userName || userId || "mobile-user",
    createdAt: Date.now(),
    status: "active",
    respondingUsers: [],
    photos: []
  };
  alerts.set(alert.id, alert);
  persistAlerts();
  addAuditEntry("incident", "SOS Alert Created (REST)", userId || "unknown", `SOS ${alert.id}: ${alert.location.address}`);
  broadcastMessage({ type: "newAlert", data: alert });
  sendPushToDispatchersAndResponders(alert, userName || userId || "Unknown").catch((err) => {
    console.error("[SOS REST] Push notification error:", err);
  });
  console.log(`[SOS REST] Alert ${alert.id} created and broadcast to ${wss.clients.size} clients`);
  res.json({ success: true, alertId: alert.id, broadcast: true });
});
app.post("/api/alerts/:id/photos", upload.array("photos", 4), (req, res) => {
  const alert = alerts.get(req.params.id);
  if (!alert) return res.status(404).json({ error: "Alert not found" });
  if (!req.files || req.files.length === 0) return res.status(400).json({ error: "No files uploaded" });
  const photoUrls = req.files.map((f) => `/uploads/${f.filename}`);
  if (!alert.photos) alert.photos = [];
  alert.photos.push(...photoUrls);
  persistAlerts();
  console.log(`[Alert Photos] ${photoUrls.length} photo(s) uploaded to alert ${alert.id}`);
  broadcastMessage({ type: "alertPhotosUpdated", data: { alertId: alert.id, photos: alert.photos } });
  res.json({ success: true, photos: alert.photos });
});
app.get("/api/alerts/:id/photos", (req, res) => {
  const alert = alerts.get(req.params.id);
  if (!alert) return res.status(404).json({ error: "Alert not found" });
  res.json({ photos: alert.photos || [] });
});
app.post("/api/location", (req, res) => {
  const { userId, userRole, latitude, longitude } = req.body;
  console.log(`[Location REST] Received from userId=${userId} (${userRole}): lat=${latitude}, lng=${longitude}`);
  if (latitude == null || longitude == null) {
    return res.status(400).json({ error: "latitude and longitude required" });
  }
  const resolvedUserId = userId || `anon-${Date.now()}`;
  const locationData = { latitude: Number(latitude), longitude: Number(longitude) };
  handleLocationUpdate(null, resolvedUserId, userRole || "user", locationData);
  sharingUsers.add(resolvedUserId);
  console.log(`[Location REST] Processed for ${resolvedUserId}, now in users map: ${users.has(resolvedUserId)}, sharing: true`);
  res.json({ success: true, userId: resolvedUserId, location: locationData, timestamp: Date.now() });
});
setInterval(() => {
  const now = Date.now();
  const staleUsers = [];
  sharingUsers.forEach((userId) => {
    const user = users.get(userId);
    if (!user || !user.lastSeen || now - user.lastSeen > LOCATION_TTL_MS) {
      staleUsers.push(userId);
    }
  });
  staleUsers.forEach((userId) => {
    console.log(`[Location TTL] Removing stale user ${userId} (no update for ${LOCATION_TTL_MS / 1e3}s)`);
    sharingUsers.delete(userId);
    const user = users.get(userId);
    if (user) {
      user.location = void 0;
      users.set(userId, user);
    }
    broadcastToRole("dispatcher", {
      type: "userLocationRemoved",
      userId,
      timestamp: Date.now()
    });
  });
  if (staleUsers.length > 0) {
    console.log(`[Location TTL] Cleaned up ${staleUsers.length} stale users`);
  }
}, 15e3);
function handleStopSharing(userId, res) {
  console.log(`[Location REST] Stop sharing from userId=${userId}`);
  if (!userId) {
    return res.status(400).json({ error: "userId required" });
  }
  sharingUsers.delete(userId);
  const user = users.get(userId);
  if (user) {
    user.location = void 0;
    users.set(userId, user);
  }
  console.log(`[Location REST] Removed ${userId} from users map entirely`);
  broadcastToRole("dispatcher", {
    type: "userLocationRemoved",
    userId,
    timestamp: Date.now()
  });
  res.json({ success: true, userId, timestamp: Date.now() });
}
app.delete("/api/location", (req, res) => {
  const userId = req.body?.userId || req.query.userId;
  handleStopSharing(userId, res);
});
app.post("/api/location/stop", (req, res) => {
  const userId = req.body?.userId || req.query.userId;
  handleStopSharing(userId, res);
});
app.get("/api/location/live-count", (_req, res) => {
  res.json({ count: sharingUsers.size, userIds: Array.from(sharingUsers) });
});
app.get("/api/family/locations", (req, res) => {
  const userId = req.query.userId;
  if (!userId) return res.status(400).json({ error: "userId required" });
  const familyIds = getFamilyMemberIds(userId);
  const familyLocations = familyIds.map((fid) => {
    const u = users.get(fid);
    const adminUser = adminUsers.get(fid);
    const rel = adminUsers.get(userId)?.relationships?.find((r) => r.userId === fid);
    if (!u || !u.location) return null;
    return {
      userId: fid,
      userName: adminUser?.name || fid,
      relationship: rel?.type || "family",
      latitude: u.location.latitude,
      longitude: u.location.longitude,
      lastSeen: u.lastSeen || Date.now()
    };
  }).filter(Boolean);
  res.json({ familyMembers: familyIds.length, locations: familyLocations });
});
app.get("/api/family/members", (req, res) => {
  const userId = req.query.userId;
  if (!userId) return res.status(400).json({ error: "userId required" });
  const adminUser = adminUsers.get(userId);
  if (!adminUser) return res.status(404).json({ error: "User not found" });
  const familyTypes = ["parent", "child", "sibling", "spouse"];
  const members = (adminUser.relationships || []).filter((r) => familyTypes.includes(r.type)).map((r) => {
    const relUser = adminUsers.get(r.userId);
    const isSharing = sharingUsers.has(r.userId);
    const runtimeUser = users.get(r.userId);
    return {
      userId: r.userId,
      name: relUser?.name || "Unknown",
      relationship: r.type,
      isSharing,
      lastSeen: runtimeUser?.lastSeen || null
    };
  });
  res.json(members);
});
app.get("/api/family/perimeters", (req, res) => {
  const userId = req.query.userId;
  if (!userId) return res.status(400).json({ error: "userId required" });
  const userPerimeters = Array.from(familyPerimeters.values()).filter((p) => p.ownerId === userId).sort((a, b) => b.createdAt - a.createdAt);
  res.json(userPerimeters);
});
app.post("/api/family/perimeters", (req, res) => {
  const { ownerId, targetUserId, center, radiusMeters } = req.body;
  if (!ownerId || !targetUserId || !center?.latitude || !center?.longitude || !radiusMeters) {
    return res.status(400).json({ error: "ownerId, targetUserId, center {latitude, longitude}, and radiusMeters required" });
  }
  const familyIds = getFamilyMemberIds(ownerId);
  if (!familyIds.includes(targetUserId)) {
    return res.status(403).json({ error: "Target user is not a family member" });
  }
  const targetAdmin = adminUsers.get(targetUserId);
  const perimeter = {
    id: v4_default(),
    ownerId,
    targetUserId,
    targetUserName: targetAdmin?.name || targetUserId,
    center: { latitude: center.latitude, longitude: center.longitude, address: center.address || void 0 },
    radiusMeters: Number(radiusMeters),
    active: true,
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  familyPerimeters.set(perimeter.id, perimeter);
  persistPerimeters();
  console.log(`[Perimeter] Created ${perimeter.id} for ${targetAdmin?.name || targetUserId} by ${ownerId} (${radiusMeters}m)`);
  res.json(perimeter);
});
app.put("/api/family/perimeters/:id", (req, res) => {
  const perimeter = familyPerimeters.get(req.params.id);
  if (!perimeter) return res.status(404).json({ error: "Perimeter not found" });
  const { center, radiusMeters, active } = req.body;
  if (center) {
    perimeter.center = { latitude: center.latitude, longitude: center.longitude, address: center.address || perimeter.center.address };
  }
  if (radiusMeters != null) perimeter.radiusMeters = Number(radiusMeters);
  if (active != null) perimeter.active = Boolean(active);
  perimeter.updatedAt = Date.now();
  familyPerimeters.set(perimeter.id, perimeter);
  persistPerimeters();
  res.json(perimeter);
});
app.delete("/api/family/perimeters/:id", (req, res) => {
  const existed = familyPerimeters.delete(req.params.id);
  if (existed) deleteFamilyPerimeterFromSupabase(req.params.id);
  perimeterState.delete(req.params.id);
  if (existed) persistPerimeters();
  res.json({ success: existed });
});
app.get("/api/family/proximity-alerts", (req, res) => {
  const userId = req.query.userId;
  if (!userId) return res.status(400).json({ error: "userId required" });
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const userAlerts = proximityAlerts.filter((a) => a.ownerId === userId).slice(0, limit);
  res.json(userAlerts);
});
app.put("/api/family/proximity-alerts/:id/acknowledge", (req, res) => {
  const alert = proximityAlerts.find((a) => a.id === req.params.id);
  if (!alert) return res.status(404).json({ error: "Alert not found" });
  alert.acknowledged = true;
  persistProximityAlerts();
  res.json({ success: true });
});
app.get("/api/family/location-history", (req, res) => {
  const userId = req.query.userId;
  const targetUserId = req.query.targetUserId;
  if (!userId || !targetUserId) return res.status(400).json({ error: "userId and targetUserId required" });
  if (userId !== targetUserId) {
    const familyIds = getFamilyMemberIds(userId);
    if (!familyIds.includes(targetUserId)) {
      return res.status(403).json({ error: "Target user is not a family member" });
    }
  }
  const history = locationHistory.get(targetUserId) || [];
  const since = Number(req.query.since) || 0;
  const filtered = since > 0 ? history.filter((h) => h.timestamp >= since) : history;
  res.json(filtered.slice(-100));
});
app.get("/admin/health", (req, res) => {
  res.json({
    status: "ok",
    connectedUsers: userConnections.size,
    totalUsers: adminUsers.size,
    activeAlerts: Array.from(alerts.values()).filter((a) => a.status === "active").length,
    totalAlerts: alerts.size,
    wsClients: wss.clients.size,
    timestamp: Date.now()
  });
});
app.get("/admin/users", (req, res) => {
  const users2 = Array.from(adminUsers.values()).map((u) => {
    const { passwordHash, ...safeUser } = u;
    return { ...safeUser, hasPassword: !!passwordHash };
  });
  res.json(users2);
});
app.put("/admin/users/:id/role", (req, res) => {
  const user = adminUsers.get(req.params.id);
  if (!user) return res.status(404).json({ error: "User not found" });
  const { role } = req.body;
  if (!["admin", "dispatcher", "responder", "user"].includes(role)) {
    return res.status(400).json({ error: "Invalid role" });
  }
  const oldRole = user.role;
  user.role = role;
  adminUsers.set(user.id, user);
  saveAdminUserToSupabase(user);
  addAuditEntry("user", "Role Changed", "Admin", `Role changed from ${oldRole} to ${role}`, user.name);
  res.json({ success: true });
});
app.put("/admin/users/:id/status", (req, res) => {
  const user = adminUsers.get(req.params.id);
  if (!user) return res.status(404).json({ error: "User not found" });
  const { status } = req.body;
  if (!["active", "suspended", "deactivated"].includes(status)) {
    return res.status(400).json({ error: "Invalid status" });
  }
  const oldStatus = user.status;
  user.status = status;
  adminUsers.set(user.id, user);
  saveAdminUserToSupabase(user);
  const actionName = status === "suspended" ? "User Suspended" : status === "deactivated" ? "User Deactivated" : "User Reactivated";
  addAuditEntry("user", actionName, "Admin", `Status changed from ${oldStatus} to ${status}`, user.name);
  res.json({ success: true });
});
app.get("/admin/users/:id", (req, res) => {
  const user = adminUsers.get(req.params.id);
  if (!user) return res.status(404).json({ error: "User not found" });
  const enrichedRelationships = (user.relationships || []).map((r) => {
    const relUser = adminUsers.get(r.userId);
    return { ...r, userName: relUser?.name || r.userId, relatedUser: relUser ? { name: relUser.name, role: relUser.role, email: relUser.email } : null };
  });
  const sameAddress = [];
  if (user.address) {
    adminUsers.forEach((u) => {
      if (u.id !== user.id && u.address && u.address === user.address) {
        sameAddress.push({ id: u.id, name: u.name, role: u.role });
      }
    });
  }
  const { passwordHash, ...safeUser } = user;
  res.json({ ...safeUser, hasPassword: !!passwordHash, relationships: enrichedRelationships, sameAddress });
});
app.post("/admin/users", async (req, res) => {
  const { firstName, lastName, email, role, tags, address, addressComponents, phoneLandline, phoneMobile, comments, photoUrl, relationships, password } = req.body;
  if (!firstName || !lastName || !email) {
    return res.status(400).json({ error: "firstName, lastName, and email are required" });
  }
  if (role && !["admin", "dispatcher", "responder", "user"].includes(role)) {
    return res.status(400).json({ error: "Invalid role" });
  }
  const existing = Array.from(adminUsers.values()).find((u) => u.email === email);
  if (existing) {
    return res.status(409).json({ error: "A user with this email already exists" });
  }
  let supabaseUserId = null;
  try {
    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
      email,
      password: password || Math.random().toString(36).slice(-12),
      // mot de passe aléatoire si non fourni
      email_confirm: true
    });
    if (authError) {
      console.error("[Admin] Supabase Auth create error:", authError.message, authError.status);
    } else {
      supabaseUserId = authData.user.id;
      console.log("[Admin] Supabase Auth user created:", supabaseUserId);
    }
  } catch (e) {
    console.error("[Admin] Supabase Auth import error:", e);
  }
  const id = supabaseUserId || `usr-${v4_default().slice(0, 8)}`;
  const now = Date.now();
  const newUser = {
    id,
    firstName,
    lastName,
    name: `${firstName} ${lastName}`,
    email,
    role: role || "user",
    status: "active",
    lastLogin: 0,
    createdAt: now,
    tags: tags || [],
    address: address || "",
    addressComponents: addressComponents || void 0,
    phoneLandline: phoneLandline || "",
    phoneMobile: phoneMobile || "",
    comments: comments || "",
    photoUrl: photoUrl || "",
    relationships: relationships || [],
    passwordHash: password ? bcryptjs_default.hashSync(password, 10) : void 0
  };
  adminUsers.set(id, newUser);
  saveAdminUserToSupabase(newUser);
  (relationships || []).forEach((rel) => {
    const relUser = adminUsers.get(rel.userId);
    if (relUser) {
      const reciprocal = getReciprocalRelType(rel.type);
      if (!relUser.relationships) relUser.relationships = [];
      if (!relUser.relationships.find((r) => r.userId === id)) {
        relUser.relationships.push({ userId: id, type: reciprocal });
        adminUsers.set(relUser.id, relUser);
      }
    }
  });
  addAuditEntry("user", "User Created", "Admin", `New ${role || "user"}: ${firstName} ${lastName} (${email})`, newUser.name);
  const { passwordHash: _pwh, ...safeNewUser } = newUser;
  res.status(201).json({ ...safeNewUser, hasPassword: !!newUser.passwordHash });
});
app.put("/admin/users/:id", (req, res) => {
  const user = adminUsers.get(req.params.id);
  if (!user) return res.status(404).json({ error: "User not found" });
  const { firstName, lastName, email, role, tags, address, addressComponents, phoneLandline, phoneMobile, comments, photoUrl, relationships, status, password } = req.body;
  if (email && email !== user.email) {
    const existing = Array.from(adminUsers.values()).find((u) => u.email === email && u.id !== user.id);
    if (existing) return res.status(409).json({ error: "A user with this email already exists" });
  }
  if (role && !["admin", "dispatcher", "responder", "user"].includes(role)) {
    return res.status(400).json({ error: "Invalid role" });
  }
  const changes = [];
  if (firstName !== void 0) {
    user.firstName = firstName;
    changes.push("firstName");
  }
  if (lastName !== void 0) {
    user.lastName = lastName;
    changes.push("lastName");
  }
  if (firstName !== void 0 || lastName !== void 0) {
    user.name = `${user.firstName} ${user.lastName}`;
  }
  if (email !== void 0) {
    user.email = email;
    changes.push("email");
  }
  if (role !== void 0 && role !== user.role) {
    const old = user.role;
    user.role = role;
    changes.push(`role:${old}->${role}`);
  }
  if (status !== void 0 && status !== user.status) {
    const old = user.status;
    user.status = status;
    changes.push(`status:${old}->${status}`);
  }
  if (tags !== void 0) {
    user.tags = tags;
    changes.push("tags");
  }
  if (address !== void 0) {
    user.address = address;
    changes.push("address");
  }
  if (addressComponents !== void 0) {
    user.addressComponents = addressComponents;
  }
  if (phoneLandline !== void 0) {
    user.phoneLandline = phoneLandline;
    changes.push("phoneLandline");
  }
  if (phoneMobile !== void 0) {
    user.phoneMobile = phoneMobile;
    changes.push("phoneMobile");
  }
  if (comments !== void 0) {
    user.comments = comments;
    changes.push("comments");
  }
  if (photoUrl !== void 0) {
    user.photoUrl = photoUrl;
    changes.push("photo");
  }
  if (password) {
    user.passwordHash = bcryptjs_default.hashSync(password, 10);
    changes.push("password");
  }
  if (relationships !== void 0) {
    (user.relationships || []).forEach((oldRel) => {
      const relUser = adminUsers.get(oldRel.userId);
      if (relUser && relUser.relationships) {
        relUser.relationships = relUser.relationships.filter((r) => r.userId !== user.id);
        adminUsers.set(relUser.id, relUser);
      }
    });
    user.relationships = relationships;
    relationships.forEach((rel) => {
      const relUser = adminUsers.get(rel.userId);
      if (relUser) {
        const reciprocal = getReciprocalRelType(rel.type);
        if (!relUser.relationships) relUser.relationships = [];
        if (!relUser.relationships.find((r) => r.userId === user.id)) {
          relUser.relationships.push({ userId: user.id, type: reciprocal });
          adminUsers.set(relUser.id, relUser);
          saveAdminUserToSupabase(relUser);
        }
      }
    });
    changes.push("relationships");
  }
  adminUsers.set(user.id, user);
  saveAdminUserToSupabase(user);
  addAuditEntry("user", "User Updated", "Admin", `Updated: ${changes.join(", ")}`, user.name);
  const { passwordHash: _pw, ...safeUpdatedUser } = user;
  res.json({ ...safeUpdatedUser, hasPassword: !!user.passwordHash });
});
app.delete("/admin/users/:id", (req, res) => {
  const user = adminUsers.get(req.params.id);
  if (!user) return res.status(404).json({ error: "User not found" });
  (user.relationships || []).forEach((rel) => {
    const relUser = adminUsers.get(rel.userId);
    if (relUser && relUser.relationships) {
      relUser.relationships = relUser.relationships.filter((r) => r.userId !== user.id);
      adminUsers.set(relUser.id, relUser);
    }
  });
  adminUsers.delete(user.id);
  deleteAdminUserFromSupabase(user.id);
  addAuditEntry("user", "User Deleted", "Admin", `Deleted user: ${user.name} (${user.email})`, user.name);
  res.json({ success: true, deletedUser: user.name });
});
app.get("/admin/users/:id/cohabitants", (req, res) => {
  const user = adminUsers.get(req.params.id);
  if (!user) return res.status(404).json({ error: "User not found" });
  if (!user.address) return res.json([]);
  const cohabitants = [];
  adminUsers.forEach((u) => {
    if (u.id !== user.id && u.address && u.address === user.address) {
      cohabitants.push(u);
    }
  });
  res.json(cohabitants);
});
app.get("/admin/users/:id/relationships", (req, res) => {
  const user = adminUsers.get(req.params.id);
  if (!user) return res.status(404).json({ error: "User not found" });
  const enriched = (user.relationships || []).map((r) => {
    const relUser = adminUsers.get(r.userId);
    return { ...r, userName: relUser?.name || "Unknown", userEmail: relUser?.email || "", userRole: relUser?.role || "" };
  });
  res.json(enriched);
});
function getReciprocalRelType(type) {
  const map = {
    "parent": "child",
    "child": "parent",
    "spouse": "spouse",
    "sibling": "sibling",
    "cohabitant": "cohabitant",
    "other": "other"
  };
  return map[type] || "other";
}
app.get("/admin/incidents", (req, res) => {
  const incidents = Array.from(alerts.values()).map((a) => ({
    id: a.id,
    type: a.type,
    severity: a.severity,
    status: a.status,
    reportedBy: a.createdBy,
    address: a.location.address,
    timestamp: a.createdAt,
    resolvedAt: a.status === "resolved" ? a.createdAt + Math.floor(Math.random() * 36e5) : void 0,
    assignedCount: a.respondingUsers.length
  }));
  res.json(incidents);
});
app.get("/admin/audit", (req, res) => {
  res.json(auditLog);
});
app.get("/admin", (req, res) => {
  res.redirect("/admin-console/");
});
app.get("/dispatch", (req, res) => {
  res.redirect("/dispatch-v2/");
});
app.get("/dispatch/responders", (req, res) => {
  const now = Date.now();
  const allResponders = [];
  adminUsers.forEach((user) => {
    if (user.role !== "responder") return;
    if (user.status === "deactivated") return;
    const runtimeUser = users.get(user.id);
    const assignedIncidents = [];
    alerts.forEach((alert) => {
      if (alert.status !== "resolved" && alert.respondingUsers.includes(user.id)) {
        const respStatus = alert.responderStatuses?.[user.id] || "assigned";
        assignedIncidents.push({
          id: alert.id,
          type: alert.type,
          severity: alert.severity,
          status: alert.status,
          address: alert.location?.address || "Unknown",
          latitude: alert.location?.latitude,
          longitude: alert.location?.longitude,
          responderStatus: respStatus
        });
      }
    });
    allResponders.push({
      id: user.id,
      name: user.name,
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      phone: user.phoneMobile || "",
      tags: user.tags || [],
      accountStatus: user.status,
      // 'active' | 'suspended'
      // Runtime status from WS connection, then dispatch override, then default
      status: runtimeUser?.status || responderStatusOverrides.get(user.id)?.status || "off_duty",
      location: runtimeUser?.location || null,
      lastSeen: runtimeUser?.lastSeen || user.lastLogin || now - 36e5,
      isConnected: !!runtimeUser,
      assignedIncidents,
      assignedCount: assignedIncidents.length
    });
  });
  const statusOrder = { on_duty: 0, available: 1, responding: 1, off_duty: 2 };
  allResponders.sort((a, b) => {
    if (a.isConnected !== b.isConnected) return a.isConnected ? -1 : 1;
    const sa = statusOrder[a.status] ?? 3;
    const sb = statusOrder[b.status] ?? 3;
    if (sa !== sb) return sa - sb;
    return a.name.localeCompare(b.name);
  });
  res.json(allResponders);
});
app.put("/dispatch/responders/:id/status", (req, res) => {
  const responderId = req.params.id;
  const { status } = req.body;
  const validStatuses = ["available", "on_duty", "off_duty", "responding"];
  if (!status || !validStatuses.includes(status)) {
    return res.status(400).json({ error: `Invalid status. Must be one of: ${validStatuses.join(", ")}` });
  }
  const runtimeUser = users.get(responderId);
  if (runtimeUser) {
    runtimeUser.status = status;
    runtimeUser.lastSeen = Date.now();
    users.set(responderId, runtimeUser);
  }
  responderStatusOverrides.set(responderId, { status, updatedAt: Date.now(), updatedBy: "dispatch" });
  const adminUser = adminUsers.get(responderId);
  const responderName = adminUser?.name || responderId;
  addAuditEntry("responder", "Status Changed", "Dispatch Console", `${responderName} status changed to ${status}`, responderId);
  broadcastToRole("dispatcher", {
    type: "responderStatusUpdate",
    userId: responderId,
    status,
    timestamp: Date.now()
  });
  res.json({ success: true, responderId, status, name: responderName });
});
app.put("/dispatch/incidents/:id/acknowledge", (req, res) => {
  const alert = alerts.get(req.params.id);
  if (!alert) return res.status(404).json({ error: "Incident not found" });
  alert.status = "acknowledged";
  alerts.set(alert.id, alert);
  persistAlerts();
  addAuditEntry("incident", "Alert Acknowledged", "Dispatch Console", `Acknowledged ${alert.id}`);
  broadcastMessage({ type: "alertAcknowledged", alertId: alert.id, timestamp: Date.now() });
  res.json({ success: true });
});
app.put("/dispatch/incidents/:id/assign", (req, res) => {
  const alert = alerts.get(req.params.id);
  if (!alert) return res.status(404).json({ error: "Incident not found" });
  const { responderId } = req.body;
  if (responderId && !alert.respondingUsers.includes(responderId)) {
    alert.respondingUsers.push(responderId);
  }
  if (alert.status === "active" || alert.status === "acknowledged") {
    alert.status = "acknowledged";
  }
  alerts.set(alert.id, alert);
  persistAlerts();
  if (!alert.responderStatuses) alert.responderStatuses = {};
  if (!alert.statusHistory) alert.statusHistory = [];
  if (responderId && !alert.responderStatuses[responderId]) {
    alert.responderStatuses[responderId] = "assigned";
  }
  const responderName = adminUsers.get(responderId)?.name || responderId;
  alert.statusHistory.push({
    responderId,
    responderName,
    status: "assigned",
    timestamp: Date.now()
  });
  alerts.set(alert.id, alert);
  persistAlerts();
  saveAlertToSupabase(alert).catch((e) => console.error("[Assign] Supabase save error:", e));
  addAuditEntry("incident", "Responder Assigned", "Dispatch Console", `Assigned ${responderName} to ${alert.id}`, responderId);
  const enrichedAlert = {
    ...alert,
    respondingNames: (alert.respondingUsers || []).map((uid) => adminUsers.get(uid)?.name || uid)
  };
  broadcastMessage({ type: "alertUpdate", data: enrichedAlert });
  const TYPE_LABELS = {
    sos: "SOS",
    medical: "M\xE9dical",
    fire: "Incendie",
    security: "S\xE9curit\xE9",
    hazard: "Danger",
    accident: "Accident",
    broadcast: "Broadcast",
    home_jacking: "Home-Jacking",
    cambriolage: "Cambriolage",
    animal_perdu: "Animal perdu",
    evenement_climatique: "\xC9v\xE9nement climatique",
    rodage: "Rodage",
    vehicule_suspect: "V\xE9hicule suspect",
    fugue: "Fugue",
    route_bloquee: "Route bloqu\xE9e",
    route_fermee: "Route ferm\xE9e",
    other: "Autre"
  };
  const typeLabel = TYPE_LABELS[alert.type] || alert.type;
  const sevLabel = alert.severity === "critical" ? "CRITIQUE" : alert.severity === "high" ? "\xC9LEV\xC9" : alert.severity === "medium" ? "MOYEN" : "FAIBLE";
  sendPushToUser(
    responderId,
    `\u{1F6A8} Incident assign\xE9 \u2014 ${typeLabel} (${sevLabel})`,
    `Vous avez \xE9t\xE9 assign\xE9 \xE0 l'incident ${alert.id}.
\u{1F4CD} ${alert.location?.address || "Adresse inconnue"}`,
    { type: "assignment", alertId: alert.id, severity: alert.severity, alertType: alert.type }
  ).catch((err) => console.error("[Assign Push] Error:", err));
  if (responderId) {
    startAcceptanceTimer(alert.id, responderId);
  }
  res.json({ success: true, responderName });
});
app.put("/dispatch/incidents/:id/unassign", (req, res) => {
  const alert = alerts.get(req.params.id);
  if (!alert) return res.status(404).json({ error: "Incident not found" });
  const { responderId } = req.body;
  if (!responderId) return res.status(400).json({ error: "responderId required" });
  const idx = alert.respondingUsers.indexOf(responderId);
  if (idx === -1) return res.status(400).json({ error: "Responder not assigned to this incident" });
  alert.respondingUsers.splice(idx, 1);
  clearAcceptanceTimer(alert.id, responderId);
  if (alert.responderStatuses) delete alert.responderStatuses[responderId];
  alerts.set(alert.id, alert);
  persistAlerts();
  const responderName = adminUsers.get(responderId)?.name || responderId;
  addAuditEntry("incident", "Responder Unassigned", "Dispatch Console", `Unassigned ${responderName} from ${alert.id}`, responderId);
  const enrichedAlert = {
    ...alert,
    respondingNames: (alert.respondingUsers || []).map((uid) => adminUsers.get(uid)?.name || uid)
  };
  broadcastMessage({ type: "alertUpdate", data: enrichedAlert });
  res.json({ success: true, responderName });
});
app.get("/dispatch/incidents/:id/responders-nearby", (req, res) => {
  const alert = alerts.get(req.params.id);
  if (!alert) return res.status(404).json({ error: "Incident not found" });
  const incidentLat = alert.location.latitude;
  const incidentLng = alert.location.longitude;
  const now = Date.now();
  const result = [];
  adminUsers.forEach((user) => {
    if (user.role !== "responder") return;
    if (user.status === "deactivated") return;
    const runtimeUser = users.get(user.id);
    const location = runtimeUser?.location || null;
    let distanceMeters = null;
    let distanceLabel = "Position inconnue";
    if (location && location.latitude && location.longitude) {
      distanceMeters = haversineDistance(location.latitude, location.longitude, incidentLat, incidentLng);
      if (distanceMeters < 1e3) {
        distanceLabel = `${Math.round(distanceMeters)} m`;
      } else {
        distanceLabel = `${(distanceMeters / 1e3).toFixed(1)} km`;
      }
    }
    const isAssigned = alert.respondingUsers.includes(user.id);
    result.push({
      id: user.id,
      name: user.name,
      phone: user.phoneMobile || "",
      tags: user.tags || [],
      status: runtimeUser?.status || responderStatusOverrides.get(user.id)?.status || "off_duty",
      isConnected: !!runtimeUser,
      isAssigned,
      distanceMeters,
      distanceLabel
    });
  });
  result.sort((a, b) => {
    if (a.isAssigned !== b.isAssigned) return a.isAssigned ? -1 : 1;
    if (a.distanceMeters !== null && b.distanceMeters !== null) return a.distanceMeters - b.distanceMeters;
    if (a.distanceMeters !== null) return -1;
    if (b.distanceMeters !== null) return 1;
    return a.name.localeCompare(b.name);
  });
  res.json({ incidentId: alert.id, incidentAddress: alert.location.address, responders: result });
});
app.put("/dispatch/incidents/:id/resolve", (req, res) => {
  const alert = alerts.get(req.params.id);
  if (!alert) return res.status(404).json({ error: "Incident not found" });
  alert.status = "resolved";
  alerts.set(alert.id, alert);
  persistAlerts();
  addAuditEntry("incident", "Incident Resolved", "Dispatch Console", `Resolved ${alert.id}: ${alert.type} at ${alert.location.address}`);
  broadcastMessage({ type: "alertResolved", alertId: alert.id, timestamp: Date.now() });
  res.json({ success: true });
});
app.put("/alerts/:id/respond", (req, res) => {
  let alert = alerts.get(req.params.id);
  if (!alert) {
    try {
      alert = alerts.get(decodeURIComponent(req.params.id));
    } catch (e) {
    }
  }
  if (!alert) {
    for (const [key, val] of alerts) {
      if (key.includes(req.params.id) || req.params.id.includes(key)) {
        alert = val;
        break;
      }
    }
  }
  if (!alert) return res.status(404).json({ error: "Incident not found" });
  const { responderId, status } = req.body;
  if (!responderId) return res.status(400).json({ error: "responderId required" });
  const validStatuses = ["accepted", "en_route", "on_scene"];
  if (!status || !validStatuses.includes(status)) {
    return res.status(400).json({ error: `Invalid status. Must be one of: ${validStatuses.join(", ")}` });
  }
  if (!alert.respondingUsers.includes(responderId)) {
    return res.status(400).json({ error: "Responder not assigned to this incident" });
  }
  if (!alert.responderStatuses) alert.responderStatuses = {};
  if (!alert.statusHistory) alert.statusHistory = [];
  alert.responderStatuses[responderId] = status;
  clearAcceptanceTimer(alert.id, responderId);
  const responderName = adminUsers.get(responderId)?.name || responderId;
  alert.statusHistory.push({
    responderId,
    responderName,
    status,
    timestamp: Date.now()
  });
  alerts.set(alert.id, alert);
  persistAlerts();
  saveAlertToSupabase(alert).catch((e) => console.error("[Respond] Supabase save error:", e));
  const STATUS_LABELS = { accepted: "Accept\xE9", en_route: "En route", on_scene: "Sur place" };
  const statusLabel = STATUS_LABELS[status] || status;
  addAuditEntry("incident", `Responder ${statusLabel}`, responderName, `${responderName} \u2014 ${statusLabel} pour ${alert.id}`, responderId);
  const enrichedAlert = {
    ...alert,
    respondingNames: (alert.respondingUsers || []).map((uid) => adminUsers.get(uid)?.name || uid)
  };
  broadcastMessage({ type: "alertUpdate", data: enrichedAlert });
  for (const [token, entry] of pushTokens) {
    if (entry.userRole === "dispatcher" || entry.userRole === "admin") {
      sendPushToUser(entry.userId, `${responderName} \u2014 ${statusLabel}`, `Incident ${alert.id}: ${responderName} est ${statusLabel.toLowerCase()}`, { type: "responder_status", alertId: alert.id, responderId, status }).catch(() => {
      });
      break;
    }
  }
  res.json({ success: true, responderId, status, statusLabel });
});
app.post("/dispatch/broadcast", async (req, res) => {
  const { message, severity, radiusKm, by, latitude, longitude } = req.body;
  if (!message) return res.status(400).json({ error: "Message required" });
  const sev = severity || "medium";
  const alert = {
    id: await generateIncidentId("broadcast", by || "Dispatch Console", { address: `Zone broadcast (${radiusKm || 5}km radius)` }),
    type: "broadcast",
    severity: sev,
    location: {
      latitude: latitude || 46.195,
      longitude: longitude || 6.158,
      address: `Zone broadcast (${radiusKm || 5}km radius)`
    },
    description: message,
    createdBy: by || "Dispatch Console",
    createdAt: Date.now(),
    status: "active",
    respondingUsers: []
  };
  alerts.set(alert.id, alert);
  persistAlerts();
  addAuditEntry("broadcast", "Zone Broadcast Sent", by || "Dispatch Console", `[${sev.toUpperCase()}] ${message} (${radiusKm || 5}km radius)`);
  broadcastMessage({ type: "newAlert", data: alert });
  broadcastMessage({ type: "zoneBroadcast", data: { message, severity: sev, radiusKm, by, timestamp: Date.now() } });
  sendPushToAllUsers(alert, by || "Dispatch Console").catch((err) => {
    console.error("[Broadcast] Push notification error:", err);
  });
  console.log(`[Broadcast] Alert ${alert.id} created and broadcast to ${wss.clients.size} clients`);
  res.json({ success: true, alertId: alert.id });
});
app.post("/dispatch/geofence/zones", (req, res) => {
  const { center, radiusKm, severity, message, createdBy } = req.body;
  if (!center || !radiusKm) return res.status(400).json({ error: "center and radiusKm required" });
  const normalizedCenter = {
    latitude: center.latitude ?? center.lat,
    longitude: center.longitude ?? center.lng
  };
  const zone = {
    id: "gf-" + Date.now(),
    center: normalizedCenter,
    radiusKm: parseFloat(radiusKm),
    severity: severity || "medium",
    message: message || "",
    createdAt: Date.now(),
    createdBy: createdBy || "Dispatch Console"
  };
  geofenceZones.set(zone.id, zone);
  responderZoneState.set(zone.id, /* @__PURE__ */ new Set());
  const demoResponderLocations = [
    { id: "resp-001", lat: 46.193, lng: 6.154 },
    { id: "resp-002", lat: 46.201, lng: 6.162 },
    { id: "resp-003", lat: 46.196, lng: 6.168 },
    { id: "resp-004", lat: 46.231, lng: 6.205 }
  ];
  const allResponders = Array.from(users.values()).filter((u) => u.role === "responder" && u.location);
  const respondersToCheck = allResponders.length > 0 ? allResponders.map((r) => ({ id: r.id, lat: r.location.latitude, lng: r.location.longitude })) : demoResponderLocations;
  respondersToCheck.forEach((r) => {
    const dist = haversineDistance(r.lat, r.lng, zone.center.latitude, zone.center.longitude);
    if (dist <= zone.radiusKm * 1e3) {
      responderZoneState.get(zone.id).add(r.id);
    }
  });
  addAuditEntry("broadcast", "Geofence Zone Created", zone.createdBy, `Zone ${zone.id}: ${zone.severity} \u2014 ${zone.radiusKm}km radius`);
  broadcastMessage({ type: "geofenceZoneCreated", data: zone });
  res.json({ success: true, zone });
});
app.get("/dispatch/geofence/zones", (req, res) => {
  const zones = Array.from(geofenceZones.values()).map((z) => ({
    ...z,
    respondersInside: responderZoneState.get(z.id)?.size || 0
  }));
  res.json(zones);
});
app.delete("/dispatch/geofence/zones/:id", (req, res) => {
  const zoneId = req.params.id;
  if (!geofenceZones.has(zoneId)) return res.status(404).json({ error: "Zone not found" });
  geofenceZones.delete(zoneId);
  responderZoneState.delete(zoneId);
  addAuditEntry("broadcast", "Geofence Zone Deleted", "Dispatch Console", `Zone ${zoneId} removed`);
  broadcastMessage({ type: "geofenceZoneDeleted", data: { zoneId } });
  res.json({ success: true });
});
app.get("/dispatch/geofence/events", (req, res) => {
  res.json({ success: true, events: geofenceEvents.slice(0, 100) });
});
app.post("/dispatch/geofence/simulate-move", (req, res) => {
  const { responderId, latitude, longitude } = req.body;
  if (!responderId || latitude == null || longitude == null) {
    return res.status(400).json({ error: "responderId, latitude, longitude required" });
  }
  let user = users.get(responderId);
  if (!user) {
    user = { id: responderId, email: `${responderId}@talion.local`, role: "responder", status: "on_duty", lastSeen: Date.now() };
    users.set(responderId, user);
  }
  user.location = { latitude, longitude };
  user.lastSeen = Date.now();
  users.set(responderId, user);
  checkGeofences(responderId, { latitude, longitude });
  broadcastMessage({
    type: "responderLocationUpdate",
    userId: responderId,
    location: { latitude, longitude },
    timestamp: Date.now()
  });
  res.json({ success: true, responderId, location: { latitude, longitude } });
});
app.get("/dispatch/map/users", (req, res) => {
  const now = Date.now();
  const connectedUsersList = Array.from(users.values()).filter((u) => u.location && u.role !== "responder").map((u) => {
    const adminUser = adminUsers.get(u.id);
    const name = adminUser ? `${adminUser.firstName} ${adminUser.lastName}`.trim() : u.id;
    return {
      id: u.id,
      name,
      role: u.role,
      status: u.status || "available",
      location: u.location,
      lastSeen: u.lastSeen || now
    };
  });
  const demoUserLocations = [
    { id: "user-001", name: "Thomas Leroy", role: "user", status: "active", location: { latitude: 46.194, longitude: 6.156 }, lastSeen: now - 3 * 36e5 },
    { id: "user-002", name: "Julie Morel", role: "user", status: "active", location: { latitude: 46.195, longitude: 6.167 }, lastSeen: now - 6 * 36e5 },
    { id: "user-004", name: "Lea Leroy", role: "user", status: "active", location: { latitude: 46.202, longitude: 6.164 }, lastSeen: now - 45 * 6e4 },
    { id: "user-005", name: "Hugo Leroy", role: "user", status: "active", location: { latitude: 46.232, longitude: 6.207 }, lastSeen: now - 2 * 864e5 },
    { id: "disp-001", name: "Jean Moreau", role: "dispatcher", status: "active", location: { latitude: 46.1955, longitude: 6.1675 }, lastSeen: now - 12 * 6e4 },
    { id: "disp-002", name: "Sophie Laurent", role: "dispatcher", status: "active", location: { latitude: 46.2005, longitude: 6.1615 }, lastSeen: now - 2 * 36e5 },
    { id: "admin-001", name: "Marie Dupont", role: "admin", status: "active", location: { latitude: 46.1925, longitude: 6.1535 }, lastSeen: now - 5 * 6e4 }
  ];
  const mergedIds = new Set(connectedUsersList.map((u) => u.id));
  const merged = [
    ...connectedUsersList,
    ...demoUserLocations.filter((d) => !mergedIds.has(d.id))
  ];
  res.json(merged);
});
app.get("/dispatch/map/all", (req, res) => {
  const now = Date.now();
  const allAlerts = Array.from(alerts.values()).map((a) => ({
    entityType: "incident",
    id: a.id,
    type: a.type,
    severity: a.severity,
    status: a.status,
    location: a.location,
    description: a.description,
    createdBy: a.createdBy,
    createdAt: a.createdAt,
    respondingUsers: a.respondingUsers,
    photos: a.photos || []
  }));
  res.json({ incidents: allAlerts, timestamp: now });
});
function resolveGroupParticipants(conv) {
  const ids = new Set(conv.participantIds);
  const activeStatuses = ["active", "available", "on_duty"];
  if (conv.filterRole) {
    adminUsers.forEach((u) => {
      if (u.role === conv.filterRole && activeStatuses.includes(u.status)) ids.add(u.id);
    });
  }
  if (conv.filterTags && conv.filterTags.length > 0) {
    adminUsers.forEach((u) => {
      if (activeStatuses.includes(u.status) && u.tags && conv.filterTags.some((t) => u.tags.includes(t))) ids.add(u.id);
    });
  }
  return Array.from(ids);
}
app.get("/api/users", (req, res) => {
  const allUsers = Array.from(adminUsers.values()).filter((u) => u.status === "active").map((u) => ({ id: u.id, name: u.name, email: u.email, role: u.role, tags: u.tags || [] }));
  res.json(allUsers);
});
app.get("/api/tags", (req, res) => {
  const tagSet = /* @__PURE__ */ new Set();
  adminUsers.forEach((u) => (u.tags || []).forEach((t) => tagSet.add(t)));
  res.json(Array.from(tagSet).sort());
});
app.put("/api/users/:id/tags", (req, res) => {
  const user = adminUsers.get(req.params.id);
  if (!user) return res.status(404).json({ error: "User not found" });
  user.tags = req.body.tags || [];
  adminUsers.set(user.id, user);
  res.json({ success: true, user: { id: user.id, name: user.name, tags: user.tags } });
});
app.get("/api/conversations", (req, res) => {
  const userId = req.query.userId;
  if (!userId) return res.status(400).json({ error: "userId required" });
  const userConvos = [];
  conversations.forEach((conv) => {
    const allParticipants = resolveGroupParticipants(conv);
    if (allParticipants.includes(userId) || conv.createdBy === userId) {
      const convMessages = messages.get(conv.id) || [];
      const lastMsg = convMessages.length > 0 ? convMessages[convMessages.length - 1] : null;
      let displayName = conv.name;
      if (conv.type === "direct") {
        const otherId = conv.participantIds.find((id) => id !== userId);
        const otherUser = otherId ? adminUsers.get(otherId) : null;
        displayName = otherUser ? otherUser.name : conv.name;
      }
      const unreadCounts = conv.unreadCounts || {};
      userConvos.push({
        ...conv,
        displayName,
        participantCount: allParticipants.length,
        lastMessage: lastMsg ? lastMsg.text : conv.lastMessage,
        lastMessageTime: lastMsg ? lastMsg.timestamp : conv.lastMessageTime,
        lastSenderName: lastMsg ? lastMsg.senderName : "",
        unreadCount: unreadCounts[userId] || 0
      });
    }
  });
  userConvos.sort((a, b) => b.lastMessageTime - a.lastMessageTime);
  res.json(userConvos);
});
app.post("/api/conversations", (req, res) => {
  const { type, name, participantIds, filterRole, filterTags, createdBy } = req.body;
  if (!createdBy) return res.status(400).json({ error: "createdBy required" });
  if (!type) return res.status(400).json({ error: "type required (direct or group)" });
  if (type === "direct" && participantIds && participantIds.length === 2) {
    const sorted = [...participantIds].sort();
    const existingId = `dm-${sorted[0]}-${sorted[1]}`;
    const existing = conversations.get(existingId);
    if (existing) return res.json(existing);
    const conv2 = {
      id: existingId,
      type: "direct",
      name: name || "Direct Message",
      participantIds: sorted,
      createdBy,
      createdAt: Date.now(),
      lastMessageTime: Date.now(),
      lastMessage: ""
    };
    conversations.set(conv2.id, conv2);
    messages.set(conv2.id, []);
    return res.json(conv2);
  }
  const convId = `grp-${v4_default().slice(0, 8)}`;
  const conv = {
    id: convId,
    type: "group",
    name: name || "Group Chat",
    participantIds: participantIds || [createdBy],
    filterRole: filterRole || void 0,
    filterTags: filterTags || void 0,
    createdBy,
    createdAt: Date.now(),
    lastMessageTime: Date.now(),
    lastMessage: ""
  };
  conversations.set(conv.id, conv);
  messages.set(conv.id, []);
  const creatorUser = adminUsers.get(createdBy);
  const sysMsg = {
    id: v4_default(),
    conversationId: convId,
    senderId: "system",
    senderName: "System",
    senderRole: "system",
    text: `Group "${conv.name}" created by ${creatorUser?.name || createdBy}`,
    type: "system",
    timestamp: Date.now()
  };
  messages.get(convId).push(sysMsg);
  res.json(conv);
});
app.post("/api/conversations/:id/media", uploadMedia.single("file"), async (req, res) => {
  const conv = conversations.get(req.params.id);
  if (!conv) return res.status(404).json({ error: "Conversation not found" });
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  const { senderId, senderName, mediaType } = req.body;
  if (!senderId) return res.status(400).json({ error: "senderId required" });
  const senderUser = adminUsers.get(senderId);
  let mediaUrl = `/uploads/${req.file.filename}`;
  try {
    const fileBuffer = import_fs.default.readFileSync(req.file.path);
    const fileName2 = `${Date.now()}-${req.file.filename}`;
    const mimeType = req.file.mimetype || (mediaType === "audio" ? "audio/m4a" : "image/jpeg");
    const { data: uploadData, error: uploadError } = await supabaseAdmin.storage.from("media").upload(fileName2, fileBuffer, { contentType: mimeType, upsert: false });
    if (!uploadError && uploadData) {
      const { data: { publicUrl } } = supabaseAdmin.storage.from("media").getPublicUrl(fileName2);
      mediaUrl = publicUrl;
      console.log("[Media] Uploaded to Supabase Storage:", mediaUrl);
    } else {
      console.warn("[Media] Supabase Storage upload failed, using local:", uploadError?.message);
    }
  } catch (e) {
    console.warn("[Media] Storage error, using local fallback:", e);
  }
  const msgType = mediaType === "audio" ? "audio" : mediaType === "document" ? "document" : "image";
  const fileName = req.body.fileName || req.file.originalname || "Document";
  const text = mediaType === "audio" ? "\u{1F3A4} Message vocal" : mediaType === "document" ? `\u{1F4CE} ${fileName}` : "\u{1F4F7} Photo";
  const msg = {
    id: v4_default(),
    conversationId: conv.id,
    senderId,
    senderName: senderName || senderUser?.name || senderId,
    senderRole: senderUser?.role || "user",
    text,
    type: msgType,
    mediaUrl,
    mediaType: msgType,
    timestamp: Date.now()
  };
  if (!messages.has(conv.id)) messages.set(conv.id, []);
  messages.get(conv.id).push(msg);
  saveMessageToSupabase(msg).catch(() => {
  });
  conv.lastMessage = text;
  conv.lastMessageTime = msg.timestamp;
  conversations.set(conv.id, conv);
  saveConversationToSupabase(conv).catch(() => {
  });
  const allParticipants = resolveGroupParticipants(conv);
  const wsPayload = JSON.stringify({ type: "newMessage", data: { ...msg, conversationName: conv.name, conversationType: conv.type } });
  allParticipants.forEach((pid) => {
    const conns = userConnections.get(pid);
    if (conns) conns.forEach((ws) => {
      try {
        ws.send(wsPayload);
      } catch {
      }
    });
  });
  for (const pid of allParticipants) {
    if (pid === senderId) continue;
    sendPushToUser(
      pid,
      `${msgType === "audio" ? "\u{1F3A4}" : "\u{1F4F7}"} ${msg.senderName}`,
      msgType === "audio" ? "Message vocal" : msgType === "document" ? "Document partag\xE9" : "Photo",
      { type: "message", conversationId: conv.id, senderId }
    ).catch(() => {
    });
  }
  console.log(`[MSG Media] ${msg.senderName} -> ${conv.name} (${conv.id}): ${msgType}`);
  res.json({ message: { ...msg, content: msg.text } });
});
app.put("/api/conversations/:id/read", async (req, res) => {
  const conv = conversations.get(req.params.id);
  if (!conv) return res.status(404).json({ error: "Conversation not found" });
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: "userId required" });
  const unreadCounts = conv.unreadCounts || {};
  unreadCounts[userId] = 0;
  conv.unreadCounts = unreadCounts;
  conversations.set(conv.id, conv);
  await supabaseAdmin.from("conversations").update({ unread_counts: unreadCounts }).eq("id", conv.id);
  res.json({ success: true });
});
app.get("/api/conversations/:id/messages", async (req, res) => {
  const conv = conversations.get(req.params.id);
  if (!conv) return res.status(404).json({ error: "Conversation not found" });
  if (!messages.has(conv.id)) {
    try {
      const { data } = await supabaseAdmin.from("messages").select("*").eq("conversation_id", conv.id).order("timestamp", { ascending: true });
      if (data && data.length > 0) {
        const loaded = data.map((m) => ({
          id: m.id,
          conversationId: m.conversation_id,
          senderId: m.sender_id,
          senderName: m.sender_name,
          senderRole: m.sender_role,
          text: m.text,
          type: m.type,
          timestamp: m.timestamp,
          mediaUrl: m.media_url || void 0,
          mediaType: m.media_type || void 0,
          location: m.location || void 0
        }));
        messages.set(conv.id, loaded);
      }
    } catch (e) {
      console.error("[Messages] Supabase load error:", e);
    }
  }
  const convMessages = messages.get(conv.id) || [];
  const since = req.query.since ? parseInt(req.query.since) : 0;
  const filtered = since > 0 ? convMessages.filter((m) => m.timestamp > since) : convMessages;
  res.json(filtered);
});
app.post("/api/conversations/:id/messages", (req, res) => {
  const conv = conversations.get(req.params.id);
  if (!conv) return res.status(404).json({ error: "Conversation not found" });
  const { senderId, text, type: msgType } = req.body;
  if (!senderId || !text) return res.status(400).json({ error: "senderId and text required" });
  const senderUser = adminUsers.get(senderId);
  const msg = {
    id: v4_default(),
    conversationId: conv.id,
    senderId,
    senderName: senderUser?.name || senderId,
    senderRole: senderUser?.role || "user",
    text,
    type: msgType || "text",
    timestamp: Date.now()
  };
  if (!messages.has(conv.id)) messages.set(conv.id, []);
  messages.get(conv.id).push(msg);
  saveMessageToSupabase(msg).catch(() => {
  });
  conv.lastMessage = text;
  conv.lastMessageTime = msg.timestamp;
  const allPartsForUnread = resolveGroupParticipants(conv);
  const unreadCounts = conv.unreadCounts || {};
  for (const pid of allPartsForUnread) {
    if (pid !== senderId) {
      unreadCounts[pid] = (unreadCounts[pid] || 0) + 1;
    }
  }
  conv.unreadCounts = unreadCounts;
  conversations.set(conv.id, conv);
  saveConversationToSupabase(conv).catch(() => {
  });
  supabaseAdmin.from("conversations").update({ unread_counts: unreadCounts }).eq("id", conv.id).then(() => {
  }).catch(() => {
  });
  const allParticipants = resolveGroupParticipants(conv);
  const wsPayload = JSON.stringify({
    type: "newMessage",
    data: { ...msg, conversationName: conv.name, conversationType: conv.type }
  });
  allParticipants.forEach((pid) => {
    const conns = userConnections.get(pid);
    if (conns) {
      conns.forEach((ws) => {
        try {
          ws.send(wsPayload);
        } catch (e) {
        }
      });
    }
  });
  userConnections.forEach((conns, uid) => {
    const u = adminUsers.get(uid);
    if (u && (u.role === "dispatcher" || u.role === "admin") && !allParticipants.includes(uid)) {
      conns.forEach((ws) => {
        try {
          ws.send(wsPayload);
        } catch (e) {
        }
      });
    }
  });
  for (const pid of allParticipants) {
    if (pid === senderId) continue;
    sendPushToUser(
      pid,
      `\u{1F4AC} ${msg.senderName}`,
      text.substring(0, 100),
      { type: "message", conversationId: conv.id, senderId, senderName: msg.senderName }
    ).catch(() => {
    });
  }
  console.log(`[MSG] ${msg.senderName} -> ${conv.name} (${conv.id}): ${text.substring(0, 50)}`);
  res.json(msg);
});
app.get("/api/messaging/users", (_req, res) => {
  const users2 = Array.from(adminUsers.values()).map((u) => ({
    id: u.id,
    name: u.name,
    role: u.role,
    tags: u.tags || [],
    status: u.status
  }));
  res.json({ users: users2 });
});
app.get("/api/messaging/conversations", (req, res) => {
  const userId = req.query.userId;
  const allConvs = Array.from(conversations.values());
  const filtered = userId ? allConvs.filter((c) => {
    const participants = resolveGroupParticipants(c);
    return participants.includes(userId);
  }) : allConvs;
  const result = filtered.map((c) => {
    const msgs = messages.get(c.id) || [];
    const lastMsg = msgs.length > 0 ? msgs[msgs.length - 1] : null;
    return {
      ...c,
      participants: resolveGroupParticipants(c),
      lastMessage: lastMsg ? lastMsg.text : c.lastMessage,
      lastMessageAt: lastMsg ? new Date(lastMsg.timestamp).toISOString() : c.lastMessageTime ? new Date(c.lastMessageTime).toISOString() : null
    };
  });
  result.sort((a, b) => new Date(b.lastMessageAt || 0).getTime() - new Date(a.lastMessageAt || 0).getTime());
  res.json({ conversations: result });
});
app.post("/api/messaging/conversations", (req, res) => {
  const { type, name, groupType, createdBy, participants, tags } = req.body;
  if (!type || !createdBy) return res.status(400).json({ error: "type and createdBy required" });
  let finalParticipants = participants || [];
  if (tags && tags.length > 0 && (!participants || participants.length <= 1)) {
    const tagUsers = Array.from(adminUsers.values()).filter((u) => u.tags && u.tags.some((t) => tags.includes(t))).map((u) => u.id);
    finalParticipants = [.../* @__PURE__ */ new Set([createdBy, ...tagUsers])];
  }
  if (type === "direct" && finalParticipants.length === 2) {
    const sorted = [...finalParticipants].sort();
    const existingId = `dm-${sorted[0]}-${sorted[1]}`;
    const existing = conversations.get(existingId);
    if (existing) {
      return res.json({ conversation: { ...existing, participants: existing.participantIds } });
    }
  }
  let filterTags;
  let filterRole;
  if (groupType?.startsWith("role:")) {
    filterRole = groupType.replace("role:", "");
  }
  if (groupType?.startsWith("tags:") || tags && tags.length > 0) {
    filterTags = tags || groupType?.replace("tags:", "").split(",");
  }
  const convId = type === "direct" && finalParticipants.length === 2 ? `dm-${[...finalParticipants].sort().join("-")}` : `grp-${v4_default().slice(0, 8)}`;
  const conv = {
    id: convId,
    type: type || "direct",
    name: name || (type === "direct" ? "Direct Message" : "Group"),
    participantIds: finalParticipants,
    filterRole,
    filterTags,
    createdBy,
    createdAt: Date.now(),
    lastMessage: "",
    lastMessageTime: Date.now()
  };
  conversations.set(conv.id, conv);
  messages.set(conv.id, []);
  if (type === "group") {
    const creatorUser = adminUsers.get(createdBy);
    const sysMsg = {
      id: v4_default(),
      conversationId: convId,
      senderId: "system",
      senderName: "System",
      senderRole: "system",
      text: `Group "${conv.name}" created by ${creatorUser?.name || createdBy}`,
      type: "system",
      timestamp: Date.now()
    };
    messages.get(convId).push(sysMsg);
  }
  saveConversationToSupabase(conv).catch(() => {
  });
  console.log(`[MSG] Conversation created: ${conv.name || conv.type} (${conv.id}) by ${createdBy}`);
  res.json({ conversation: { ...conv, participants: conv.participantIds } });
});
app.get("/api/messaging/conversations/:id/messages", async (req, res) => {
  const conv = conversations.get(req.params.id);
  if (!conv) return res.status(404).json({ error: "Conversation not found" });
  if (!messages.has(conv.id)) {
    try {
      const { data } = await supabaseAdmin.from("messages").select("*").eq("conversation_id", conv.id).order("timestamp", { ascending: true });
      if (data && data.length > 0) {
        const loaded = data.map((m) => ({
          id: m.id,
          conversationId: m.conversation_id,
          senderId: m.sender_id,
          senderName: m.sender_name,
          senderRole: m.sender_role,
          text: m.text,
          type: m.type,
          timestamp: m.timestamp,
          mediaUrl: m.media_url || void 0,
          mediaType: m.media_type || void 0,
          location: m.location || void 0
        }));
        messages.set(conv.id, loaded);
      }
    } catch (e) {
      console.error("[Messages] Supabase load error:", e);
    }
  }
  const msgs = messages.get(conv.id) || [];
  const mapped = msgs.map((m) => ({
    id: m.id,
    conversationId: m.conversationId,
    senderId: m.senderId,
    senderName: m.senderName,
    senderRole: m.senderRole,
    content: m.text,
    text: m.text,
    type: m.type,
    timestamp: new Date(m.timestamp).toISOString(),
    mediaUrl: m.mediaUrl || void 0,
    mediaType: m.mediaType || void 0,
    location: m.location || void 0
  }));
  res.json({ messages: mapped });
});
app.post("/api/messaging/conversations/:id/messages", (req, res) => {
  const conv = conversations.get(req.params.id);
  if (!conv) return res.status(404).json({ error: "Conversation not found" });
  const { senderId, senderName, content } = req.body;
  if (!senderId || !content) return res.status(400).json({ error: "senderId and content required" });
  const senderUser = adminUsers.get(senderId);
  const msg = {
    id: v4_default(),
    conversationId: conv.id,
    senderId,
    senderName: senderName || senderUser?.name || senderId,
    senderRole: senderUser?.role || "dispatcher",
    text: content,
    type: "text",
    timestamp: Date.now()
  };
  if (!messages.has(conv.id)) messages.set(conv.id, []);
  messages.get(conv.id).push(msg);
  saveMessageToSupabase(msg).catch(() => {
  });
  conv.lastMessage = content;
  conv.lastMessageTime = msg.timestamp;
  const unreadCountsMsg = conv.unreadCounts || {};
  const allPartsMsg = resolveGroupParticipants(conv);
  for (const pid of allPartsMsg) {
    if (pid !== senderId) {
      unreadCountsMsg[pid] = (unreadCountsMsg[pid] || 0) + 1;
    }
  }
  conv.unreadCounts = unreadCountsMsg;
  conversations.set(conv.id, conv);
  saveConversationToSupabase(conv).catch(() => {
  });
  supabaseAdmin.from("conversations").update({ unread_counts: unreadCountsMsg }).eq("id", conv.id).then(() => {
  }).catch(() => {
  });
  const allParticipants = resolveGroupParticipants(conv);
  const wsPayload = JSON.stringify({
    type: "newMessage",
    data: { ...msg, content: msg.text, conversationName: conv.name, conversationType: conv.type }
  });
  allParticipants.forEach((pid) => {
    const conns = userConnections.get(pid);
    if (conns) {
      conns.forEach((ws) => {
        try {
          ws.send(wsPayload);
        } catch (e) {
        }
      });
    }
  });
  userConnections.forEach((conns, uid) => {
    const u = adminUsers.get(uid);
    if (u && (u.role === "dispatcher" || u.role === "admin") && !allParticipants.includes(uid)) {
      conns.forEach((ws) => {
        try {
          ws.send(wsPayload);
        } catch (e) {
        }
      });
    }
  });
  const notifiedPids = /* @__PURE__ */ new Set([senderId]);
  for (const pid of allParticipants) {
    if (notifiedPids.has(pid)) continue;
    notifiedPids.add(pid);
    sendPushToUser(
      pid,
      `\u{1F4AC} ${msg.senderName}`,
      content.substring(0, 100),
      { type: "message", conversationId: conv.id, senderId, senderName: msg.senderName }
    ).catch(() => {
    });
  }
  console.log(`[MSG] ${msg.senderName} -> ${conv.name || conv.type} (${conv.id}): ${content.substring(0, 50)}`);
  res.json({ message: { ...msg, content: msg.text } });
});
app.get("/api/messaging/tags", (_req, res) => {
  const tagSet = /* @__PURE__ */ new Set();
  adminUsers.forEach((u) => (u.tags || []).forEach((t) => tagSet.add(t)));
  res.json({ tags: [...tagSet].sort() });
});
var PATROL_SITES = [
  "Champel \u2014 Avenue de Champel 24",
  "Champel \u2014 Chemin des Cr\xEAts-de-Champel 2",
  "Florissant \u2014 Route de Florissant 62",
  "Florissant \u2014 Avenue de Miremont 30",
  "Malagnou \u2014 Route de Malagnou 32",
  "Malagnou \u2014 Chemin du Velours 10",
  "V\xE9senaz \u2014 Route de Thonon 85",
  "V\xE9senaz \u2014 Chemin de la Capite 12"
];
var PATROL_STATUS_CONFIG = {
  habituel: { label: "Habituel", color: "#22C55E", severity: 0 },
  inhabituel: { label: "Inhabituel", color: "#EAB308", severity: 1 },
  identification: { label: "Identification", color: "#F97316", severity: 2 },
  suspect: { label: "Suspect", color: "#EF4444", severity: 3 },
  menace: { label: "Menace", color: "#8B5CF6", severity: 4 },
  attaque: { label: "Attaque", color: "#000000", severity: 5 }
};
app.get("/api/patrol/sites", (_req, res) => {
  res.json({ sites: PATROL_SITES });
});
app.get("/api/patrol/statuses", (_req, res) => {
  res.json({ statuses: PATROL_STATUS_CONFIG });
});
app.post("/api/patrol/reports", (req, res) => {
  const { createdBy, location, status, tasks, notes } = req.body;
  if (!createdBy || !location || !status || !tasks) {
    return res.status(400).json({ error: "createdBy, location, status, and tasks are required" });
  }
  if (!PATROL_STATUS_CONFIG[status]) {
    return res.status(400).json({ error: `Invalid status. Must be one of: ${Object.keys(PATROL_STATUS_CONFIG).join(", ")}` });
  }
  const user = adminUsers.get(createdBy);
  if (!user || user.role !== "responder" && user.role !== "dispatcher" && user.role !== "admin") {
    return res.status(403).json({ error: "Only responders, dispatchers, and admins can create patrol reports" });
  }
  const report = {
    id: `PR-${v4_default().slice(0, 8)}`,
    createdAt: Date.now(),
    createdBy,
    createdByName: user.name || createdBy,
    location,
    status,
    tasks,
    notes: notes || void 0,
    media: []
  };
  patrolReports.unshift(report);
  persistPatrolReports();
  const statusConf = PATROL_STATUS_CONFIG[report.status];
  auditLog.unshift({
    id: v4_default(),
    timestamp: Date.now(),
    category: "patrol",
    action: "Patrol Report Created",
    performedBy: report.createdByName,
    details: `Rapport de ronde: ${report.location} \u2014 Statut: ${statusConf.label}`
  });
  if (report.status !== "habituel") {
    const alertMsg = {
      type: "patrolAlert",
      data: {
        reportId: report.id,
        location: report.location,
        status: report.status,
        statusLabel: statusConf.label,
        statusColor: statusConf.color,
        createdByName: report.createdByName,
        createdAt: report.createdAt,
        tasks: report.tasks,
        notes: report.notes
      }
    };
    broadcastToRole("dispatcher", alertMsg);
    broadcastToRole("admin", alertMsg);
    const pushTitle = `\u26A0\uFE0F Ronde ${statusConf.label}`;
    const pushBody = `${report.createdByName} \u2014 ${report.location}
Statut: ${statusConf.label}${report.notes ? "\n" + report.notes : ""}`;
    const pushTokenEntries = Array.from(pushTokens.entries());
    const dispatchAdminTokens = pushTokenEntries.filter(([_, entry]) => {
      const u = adminUsers.get(entry.userId);
      return u && (u.role === "dispatcher" || u.role === "admin");
    }).map(([token]) => token);
    if (dispatchAdminTokens.length > 0) {
      const pushMessages = dispatchAdminTokens.map((token) => ({
        to: token,
        sound: "default",
        title: pushTitle,
        body: pushBody,
        data: { type: "patrol_alert", reportId: report.id }
      }));
      fetch("https://exp.host/--/api/v2/push/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(pushMessages)
      }).catch((err) => console.error("[Patrol] Push notification error:", err));
    }
    console.log(`[Patrol] ALERT: ${statusConf.label} report at ${report.location} by ${report.createdByName}`);
  } else {
    console.log(`[Patrol] Report created: ${report.location} by ${report.createdByName} (Habituel)`);
  }
  res.json({ success: true, report });
});
app.get("/api/patrol/reports", (req, res) => {
  const userId = req.query.userId;
  const role = req.query.role;
  const locationFilter = req.query.location;
  const statusFilter = req.query.status;
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  if (userId) {
    const user = adminUsers.get(userId);
    if (user && user.role === "user") {
      return res.status(403).json({ error: "Regular users cannot access patrol reports" });
    }
  }
  let filtered = [...patrolReports];
  if (locationFilter) {
    filtered = filtered.filter((r) => r.location === locationFilter);
  }
  if (statusFilter) {
    filtered = filtered.filter((r) => r.status === statusFilter);
  }
  if (role === "responder" && userId) {
    filtered = filtered.filter((r) => r.createdBy === userId);
  }
  res.json({ reports: filtered.slice(0, limit), total: filtered.length });
});
app.get("/api/patrol/reports/:id", (req, res) => {
  const report = patrolReports.find((r) => r.id === req.params.id);
  if (!report) return res.status(404).json({ error: "Patrol report not found" });
  res.json(report);
});
app.post("/api/patrol/reports/:id/media", uploadMedia.single("media"), (req, res) => {
  const report = patrolReports.find((r) => r.id === req.params.id);
  if (!report) return res.status(404).json({ error: "Patrol report not found" });
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  const ext = req.file.originalname.split(".").pop()?.toLowerCase() || "";
  const isVideo = ["mp4", "mov", "avi", "webm", "m4v"].includes(ext);
  const mediaItem = {
    id: v4_default().slice(0, 8),
    type: isVideo ? "video" : "photo",
    url: `/uploads/${req.file.filename}`,
    filename: req.file.originalname,
    uploadedAt: Date.now()
  };
  if (!report.media) report.media = [];
  report.media.push(mediaItem);
  persistPatrolReports();
  console.log(`[Patrol] Media uploaded to report ${report.id}: ${mediaItem.type} ${mediaItem.filename}`);
  res.json({ success: true, media: mediaItem });
});
app.delete("/api/patrol/reports/:id/media/:mediaId", (req, res) => {
  const report = patrolReports.find((r) => r.id === req.params.id);
  if (!report) return res.status(404).json({ error: "Patrol report not found" });
  if (!report.media) return res.status(404).json({ error: "No media found" });
  const idx = report.media.findIndex((m) => m.id === req.params.mediaId);
  if (idx < 0) return res.status(404).json({ error: "Media not found" });
  const removed = report.media.splice(idx, 1)[0];
  persistPatrolReports();
  const filePath = import_path.default.join(uploadsDir, removed.url.replace("/uploads/", ""));
  import_fs.default.unlink(filePath, () => {
  });
  res.json({ success: true });
});
function handlePTTTransmit(ws, senderId, senderRole, data) {
  const { channelId, audioBase64, duration, senderName, mimeType } = data;
  if (!channelId || !audioBase64) {
    console.error(`[PTT] REJECTED: Missing channelId=${channelId ? "yes" : "NO"} or audioBase64=${audioBase64 ? audioBase64.length + " chars" : "EMPTY/MISSING"}. Full data keys: ${Object.keys(data || {}).join(", ")}`);
    ws.send(JSON.stringify({ type: "error", message: `Missing channelId or audioBase64. Got channelId=${!!channelId}, audioBase64=${!!audioBase64}` }));
    return;
  }
  const channel = pttChannels.find((c) => c.id === channelId);
  if (!channel) {
    ws.send(JSON.stringify({ type: "error", message: "Channel not found" }));
    return;
  }
  if (!channel.allowedRoles.includes(senderRole) && senderRole !== "admin") {
    ws.send(JSON.stringify({ type: "error", message: "Not authorized to transmit on this channel" }));
    return;
  }
  if (channel.members && channel.members.length > 0 && senderRole !== "admin") {
    if (!channel.members.includes(senderId)) {
      ws.send(JSON.stringify({ type: "error", message: "Not a member of this channel" }));
      return;
    }
  }
  const pttMsg = {
    id: `ptt-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    channelId,
    senderId,
    senderName: senderName || senderId,
    senderRole,
    audioBase64,
    mimeType: mimeType || "audio/webm",
    duration: duration || 0,
    timestamp: Date.now()
  };
  pttMessages.push(pttMsg);
  if (pttMessages.length > 200) pttMessages = pttMessages.slice(-200);
  persistPTTMessages();
  console.log(`[PTT] ${senderName} (${senderRole}) transmitted on ${channel.name} - ${duration?.toFixed(1)}s, audioBase64: ${audioBase64 ? (audioBase64.length / 1024).toFixed(1) + " KB" : "EMPTY"}, mimeType: ${mimeType || "default"}`);
  const broadcastData = JSON.stringify({
    type: "pttMessage",
    data: {
      id: pttMsg.id,
      channelId: pttMsg.channelId,
      senderId: pttMsg.senderId,
      senderName: pttMsg.senderName,
      senderRole: pttMsg.senderRole,
      audioBase64: pttMsg.audioBase64,
      mimeType: pttMsg.mimeType,
      duration: pttMsg.duration,
      timestamp: pttMsg.timestamp
    }
  });
  wss.clients.forEach((client) => {
    if (client.readyState !== 1) return;
    if (client === ws) return;
    const connUserId = wsClientMap.get(client);
    if (!connUserId) return;
    const connUserData = users.get(connUserId);
    if (!connUserData) return;
    const role = connUserData.role || "user";
    if (role === "admin" || role === "dispatcher") {
      client.send(broadcastData);
      return;
    }
    if (channel.allowedRoles.includes(role)) {
      if (channel.members && channel.members.length > 0) {
        if (!channel.members.includes(connUserId)) return;
      }
      client.send(broadcastData);
    }
  });
  ws.send(JSON.stringify({ type: "pttTransmitAck", messageId: pttMsg.id, timestamp: pttMsg.timestamp }));
}
function handlePTTJoinChannel(ws, userId, userRole, data) {
  const { channelId } = data;
  const channel = pttChannels.find((c) => c.id === channelId);
  if (!channel) {
    ws.send(JSON.stringify({ type: "error", message: "Channel not found" }));
    return;
  }
  const channelMsgs = pttMessages.filter((m) => m.channelId === channelId).slice(-50).map((m) => ({
    id: m.id,
    channelId: m.channelId,
    senderId: m.senderId,
    senderName: m.senderName,
    senderRole: m.senderRole,
    audioBase64: m.audioBase64,
    mimeType: m.mimeType || "audio/webm",
    duration: m.duration,
    timestamp: m.timestamp
  }));
  ws.send(JSON.stringify({
    type: "pttChannelHistory",
    channelId,
    data: channelMsgs
  }));
}
function handlePTTTalkingState(ws, userId, userRole, data, isTalking) {
  const { channelId, userName } = data;
  const channel = pttChannels.find((c) => c.id === channelId);
  if (!channel) return;
  const broadcastData = JSON.stringify({
    type: isTalking ? "pttTalkingStart" : "pttTalkingStop",
    data: {
      channelId,
      userId,
      userName: userName || userId,
      userRole
    }
  });
  wss.clients.forEach((client) => {
    if (client.readyState !== 1) return;
    if (client === ws) return;
    const connUserId = wsClientMap.get(client);
    if (!connUserId) return;
    const connUserData = users.get(connUserId);
    if (!connUserData) return;
    const role = connUserData.role || "user";
    if (role === "admin" || role === "dispatcher") {
      client.send(broadcastData);
      return;
    }
    if (channel.allowedRoles.includes(role)) {
      if (channel.members && channel.members.length > 0) {
        if (!channel.members.includes(connUserId)) return;
      }
      client.send(broadcastData);
    }
  });
}
function handlePTTEmergency(ws, userId, userRole, data) {
  if (userRole !== "dispatcher" && userRole !== "admin") {
    ws.send(JSON.stringify({ type: "error", message: "Only dispatchers and admins can trigger emergency PTT" }));
    return;
  }
  const { audioBase64, duration, senderName, mimeType } = data;
  const emergencyMsg = {
    id: `ptt-emergency-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    channelId: "emergency",
    senderId: userId,
    senderName: senderName || userId,
    senderRole: userRole,
    audioBase64: audioBase64 || "",
    mimeType: mimeType || "audio/webm",
    duration: duration || 0,
    timestamp: Date.now()
  };
  pttMessages.push(emergencyMsg);
  if (pttMessages.length > 200) pttMessages = pttMessages.slice(-200);
  persistPTTMessages();
  console.log(`[PTT] EMERGENCY broadcast by ${senderName} (${userRole}) - ${duration?.toFixed(1)}s`);
  const broadcastData = JSON.stringify({
    type: "pttEmergencyMessage",
    data: {
      id: emergencyMsg.id,
      channelId: "emergency",
      senderId: emergencyMsg.senderId,
      senderName: emergencyMsg.senderName,
      senderRole: emergencyMsg.senderRole,
      audioBase64: emergencyMsg.audioBase64,
      mimeType: emergencyMsg.mimeType,
      duration: emergencyMsg.duration,
      timestamp: emergencyMsg.timestamp
    }
  });
  wss.clients.forEach((client) => {
    if (client.readyState !== 1) return;
    if (client === ws) return;
    client.send(broadcastData);
  });
  const allUserIds = Array.from(users.keys());
  allUserIds.forEach((uid) => {
    if (uid === userId) return;
    const tokens = pushTokens.get(uid);
    if (tokens) {
      tokens.forEach((token) => {
        sendPushNotification(token, {
          title: "\u{1F6A8} ALERTE URGENCE PTT",
          body: `Message d'urgence de ${senderName} (${userRole})`,
          data: { type: "pttEmergency", messageId: emergencyMsg.id }
        });
      });
    }
  });
  ws.send(JSON.stringify({ type: "pttEmergencyAck", messageId: emergencyMsg.id }));
}
app.get("/api/ptt/channels", (req, res) => {
  const userRole = req.query.role || "user";
  const userId = req.query.userId;
  const accessible = pttChannels.filter((ch) => {
    if (userRole === "admin") return true;
    if (userRole === "dispatcher") {
      if (!ch.allowedRoles.includes("dispatcher")) return false;
      return true;
    }
    if (!ch.allowedRoles.includes(userRole)) return false;
    if (ch.members && ch.members.length > 0 && !ch.members.includes(userId)) return false;
    return true;
  });
  res.json(accessible);
});
app.post("/api/ptt/channels", (req, res) => {
  const { name, description, allowedRoles, members, createdBy, createdByRole } = req.body;
  if (!name || !createdBy) {
    return res.status(400).json({ error: "name and createdBy are required" });
  }
  if (createdByRole !== "dispatcher" && createdByRole !== "admin") {
    return res.status(403).json({ error: "Only dispatchers and admins can create channels" });
  }
  const channel = {
    id: `custom-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
    name,
    description: description || "",
    allowedRoles: allowedRoles || ["user", "responder", "dispatcher", "admin"],
    isActive: true,
    isDefault: false,
    createdBy,
    createdAt: Date.now(),
    members: members || []
  };
  pttChannels.push(channel);
  persistPTTChannels();
  broadcastMessage({ type: "pttChannelCreated", data: channel });
  console.log(`[PTT] Channel "${name}" created by ${createdBy}`);
  res.json(channel);
});
app.delete("/api/ptt/channels/:id", (req, res) => {
  const { id } = req.params;
  const { userRole } = req.query;
  if (userRole !== "dispatcher" && userRole !== "admin") {
    return res.status(403).json({ error: "Only dispatchers and admins can delete channels" });
  }
  const idx = pttChannels.findIndex((c) => c.id === id);
  if (idx === -1) return res.status(404).json({ error: "Channel not found" });
  if (pttChannels[idx].isDefault) return res.status(400).json({ error: "Cannot delete default channels" });
  const removed = pttChannels.splice(idx, 1)[0];
  deletePTTChannelFromSupabase(id);
  persistPTTChannels();
  pttMessages = pttMessages.filter((m) => m.channelId !== id);
  persistPTTMessages();
  broadcastMessage({ type: "pttChannelDeleted", channelId: id });
  console.log(`[PTT] Channel "${removed.name}" deleted`);
  res.json({ success: true });
});
app.post("/api/ptt/channels/direct", (req, res) => {
  const { userId1, userId2, userName1, userName2 } = req.body;
  if (!userId1 || !userId2) {
    return res.status(400).json({ error: "userId1 and userId2 are required" });
  }
  const existing = pttChannels.find(
    (ch) => ch.members && ch.members.length === 2 && ch.members.includes(userId1) && ch.members.includes(userId2) && ch.id.startsWith("direct-")
  );
  if (existing) {
    return res.json(existing);
  }
  const name1 = userName1 || userId1;
  const name2 = userName2 || userId2;
  const channel = {
    id: `direct-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
    name: `${name1} \u2194 ${name2}`,
    description: `Appel direct entre ${name1} et ${name2}`,
    allowedRoles: ["user", "responder", "dispatcher", "admin"],
    isActive: true,
    isDefault: false,
    createdBy: userId1,
    createdAt: Date.now(),
    members: [userId1, userId2]
  };
  pttChannels.push(channel);
  persistPTTChannels();
  broadcastMessage({ type: "pttChannelCreated", data: channel });
  console.log(`[PTT] Direct channel created: ${name1} \u2194 ${name2}`);
  res.json(channel);
});
app.get("/api/ptt/messages/:channelId", (req, res) => {
  const { channelId } = req.params;
  const limit = parseInt(req.query.limit) || 50;
  const msgs = pttMessages.filter((m) => m.channelId === channelId).slice(-limit);
  res.json(msgs);
});
app.post("/api/ptt/transmit", (req, res) => {
  const { channelId, audioBase64, mimeType, duration, senderId, senderName, senderRole } = req.body;
  if (!channelId || !audioBase64 || !senderId) {
    return res.status(400).json({ error: "Missing required fields" });
  }
  const channel = pttChannels.find((c) => c.id === channelId);
  if (!channel) return res.status(404).json({ error: "Channel not found" });
  if (!channel.allowedRoles.includes(senderRole) && senderRole !== "admin") {
    return res.status(403).json({ error: "Not authorized to transmit on this channel" });
  }
  const pttMsg = {
    id: `ptt-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    channelId,
    senderId,
    senderName: senderName || senderId,
    senderRole: senderRole || "user",
    audioBase64,
    mimeType: mimeType || "audio/webm",
    duration: duration || 0,
    timestamp: Date.now()
  };
  pttMessages.push(pttMsg);
  if (pttMessages.length > 200) pttMessages = pttMessages.slice(-200);
  persistPTTMessages();
  broadcastMessage({
    type: "pttMessage",
    data: {
      id: pttMsg.id,
      channelId: pttMsg.channelId,
      senderId: pttMsg.senderId,
      senderName: pttMsg.senderName,
      senderRole: pttMsg.senderRole,
      audioBase64: pttMsg.audioBase64,
      mimeType: pttMsg.mimeType,
      duration: pttMsg.duration,
      timestamp: pttMsg.timestamp
    }
  });
  res.json({ success: true, messageId: pttMsg.id });
});
var PORT = process.env.PORT || 3e3;
server.keepAliveTimeout = 65e3;
server.headersTimeout = 66e3;
server.listen(Number(PORT), "0.0.0.0", async () => {
  console.log(`Talion Crisis Comm Server running on port ${PORT}`);
  await Promise.all([
    loadAdminUsersFromSupabase(),
    loadAlertsFromSupabase(),
    loadPatrolReportsFromSupabase(),
    loadPTTChannelsFromSupabase(),
    loadFamilyPerimetersFromSupabase(),
    loadPushTokensFromSupabase(),
    loadUserAddressesFromSupabase(),
    loadConversationsFromSupabase(),
    loadMessagesFromSupabase()
  ]);
  console.log("[Startup] All Supabase data loaded \u2014 ready to serve requests");
  console.log(`WebSocket endpoint: ws://localhost:${PORT}`);
  console.log(`Admin Console: http://localhost:${PORT}/admin-console/`);
  console.log(`Dispatch Console: http://localhost:${PORT}/dispatch-console/`);
  console.log(`Console Login: http://localhost:${PORT}/console/`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});
async function loadAdminUsersFromSupabase() {
  try {
    const { data, error } = await supabaseAdmin.from("admin_users").select("*");
    if (error) {
      console.error("[Supabase] Failed to load admin_users:", error.message);
      return;
    }
    if (data && data.length > 0) {
      adminUsers.clear();
      data.forEach((u) => {
        adminUsers.set(u.id, {
          id: u.id,
          firstName: u.first_name || "",
          lastName: u.last_name || "",
          name: u.name || `${u.first_name} ${u.last_name}`.trim(),
          email: u.email,
          role: u.role,
          status: u.status || "active",
          lastLogin: u.last_login || 0,
          createdAt: u.created_at || Date.now(),
          tags: u.tags || [],
          address: u.address || "",
          phoneLandline: u.phone_landline || "",
          phoneMobile: u.phone_mobile || "",
          comments: u.comments || "",
          photoUrl: u.photo_url || "",
          relationships: u.relationships || [],
          passwordHash: u.password_hash || void 0
        });
      });
      console.log(`[Supabase] Loaded ${data.length} users from admin_users`);
    }
  } catch (e) {
    console.error("[Supabase] loadAdminUsersFromSupabase error:", e);
  }
}
async function saveAdminUserToSupabase(user) {
  try {
    const { error } = await supabaseAdmin.from("admin_users").upsert({
      id: user.id,
      first_name: user.firstName,
      last_name: user.lastName,
      name: user.name,
      email: user.email,
      role: user.role,
      status: user.status,
      last_login: user.lastLogin,
      created_at: user.createdAt,
      tags: user.tags || [],
      address: user.address || "",
      phone_landline: user.phoneLandline || "",
      phone_mobile: user.phoneMobile || "",
      comments: user.comments || "",
      photo_url: user.photoUrl || "",
      relationships: user.relationships || [],
      password_hash: user.passwordHash || null
    });
    if (error) console.error("[Supabase] saveAdminUserToSupabase error:", error.message);
  } catch (e) {
    console.error("[Supabase] saveAdminUserToSupabase error:", e);
  }
}
async function deleteAdminUserFromSupabase(userId) {
  try {
    const { error } = await supabaseAdmin.from("admin_users").delete().eq("id", userId);
    if (error) console.error("[Supabase] deleteAdminUserFromSupabase error:", error.message);
  } catch (e) {
    console.error("[Supabase] deleteAdminUserFromSupabase error:", e);
  }
}
async function loadAlertsFromSupabase() {
  try {
    const { data, error } = await supabaseAdmin.from("alerts").select("*");
    if (error) {
      console.error("[Supabase] Failed to load alerts:", error.message);
      return;
    }
    if (data && data.length > 0) {
      alerts.clear();
      data.forEach((a) => {
        alerts.set(a.id, {
          id: a.id,
          type: a.type,
          severity: a.severity,
          status: a.status,
          description: a.description || "",
          createdBy: a.created_by,
          createdAt: a.created_at,
          location: a.location || { latitude: 0, longitude: 0, address: "Unknown" },
          respondingUsers: a.responding_users || [],
          responderStatuses: a.responder_statuses || {},
          statusHistory: a.status_history || [],
          photos: a.photos || []
        });
      });
      console.log(`[Supabase] Loaded ${data.length} alerts`);
    }
  } catch (e) {
    console.error("[Supabase] loadAlertsFromSupabase error:", e);
  }
}
async function saveAlertToSupabase(alert) {
  try {
    const { error } = await supabaseAdmin.from("alerts").upsert({
      id: alert.id,
      type: alert.type,
      severity: alert.severity,
      status: alert.status,
      description: alert.description,
      created_by: alert.createdBy,
      created_at: alert.createdAt,
      location: alert.location,
      responding_users: alert.respondingUsers || [],
      responder_statuses: alert.responderStatuses || {},
      status_history: alert.statusHistory || [],
      photos: alert.photos || []
    });
    if (error) console.error("[Supabase] saveAlertToSupabase error:", error.message);
  } catch (e) {
    console.error("[Supabase] saveAlertToSupabase error:", e);
  }
}
async function loadPatrolReportsFromSupabase() {
  try {
    const { data, error } = await supabaseAdmin.from("patrol_reports").select("*").order("created_at", { ascending: false });
    if (error) {
      console.error("[Supabase] Failed to load patrol_reports:", error.message);
      return;
    }
    if (data && data.length > 0) {
      patrolReports.length = 0;
      data.forEach((r) => patrolReports.push({
        id: r.id,
        createdAt: r.created_at,
        createdBy: r.created_by,
        createdByName: r.created_by_name,
        location: r.location,
        status: r.status,
        tasks: r.tasks || [],
        notes: r.notes,
        media: r.media || []
      }));
      console.log(`[Supabase] Loaded ${data.length} patrol reports`);
    }
  } catch (e) {
    console.error("[Supabase] loadPatrolReportsFromSupabase error:", e);
  }
}
async function savePatrolReportToSupabase(report) {
  try {
    const { error } = await supabaseAdmin.from("patrol_reports").upsert({
      id: report.id,
      created_at: report.createdAt,
      created_by: report.createdBy,
      created_by_name: report.createdByName,
      location: report.location,
      status: report.status,
      tasks: report.tasks,
      notes: report.notes || null,
      media: report.media || []
    });
    if (error) console.error("[Supabase] savePatrolReportToSupabase error:", error.message);
  } catch (e) {
    console.error("[Supabase] savePatrolReportToSupabase error:", e);
  }
}
async function loadPTTChannelsFromSupabase() {
  try {
    const { data, error } = await supabaseAdmin.from("ptt_channels").select("*");
    if (error) {
      console.error("[Supabase] Failed to load ptt_channels:", error.message);
      return;
    }
    if (data && data.length > 0) {
      pttChannels.length = 0;
      data.forEach((c) => pttChannels.push({
        id: c.id,
        name: c.name,
        description: c.description || "",
        allowedRoles: c.allowed_roles || [],
        isActive: c.is_active,
        isDefault: c.is_default,
        createdBy: c.created_by,
        createdAt: c.created_at,
        members: c.members || []
      }));
      console.log(`[Supabase] Loaded ${data.length} PTT channels`);
    }
  } catch (e) {
    console.error("[Supabase] loadPTTChannelsFromSupabase error:", e);
  }
}
async function savePTTChannelToSupabase(channel) {
  try {
    const { error } = await supabaseAdmin.from("ptt_channels").upsert({
      id: channel.id,
      name: channel.name,
      description: channel.description,
      allowed_roles: channel.allowedRoles,
      is_active: channel.isActive,
      is_default: channel.isDefault,
      created_by: channel.createdBy,
      created_at: channel.createdAt,
      members: channel.members || []
    });
    if (error) console.error("[Supabase] savePTTChannelToSupabase error:", error.message);
  } catch (e) {
    console.error("[Supabase] savePTTChannelToSupabase error:", e);
  }
}
async function deletePTTChannelFromSupabase(channelId) {
  try {
    const { error } = await supabaseAdmin.from("ptt_channels").delete().eq("id", channelId);
    if (error) console.error("[Supabase] deletePTTChannelFromSupabase error:", error.message);
  } catch (e) {
    console.error("[Supabase] deletePTTChannelFromSupabase error:", e);
  }
}
async function loadFamilyPerimetersFromSupabase() {
  try {
    const { data, error } = await supabaseAdmin.from("family_perimeters").select("*");
    if (error) {
      console.error("[Supabase] Failed to load family_perimeters:", error.message);
      return;
    }
    if (data && data.length > 0) {
      familyPerimeters.clear();
      data.forEach((p) => familyPerimeters.set(p.id, {
        id: p.id,
        ownerId: p.owner_id,
        targetUserId: p.target_user_id,
        targetUserName: p.target_user_name,
        center: p.center,
        radiusMeters: p.radius_meters,
        active: p.active,
        createdAt: p.created_at,
        updatedAt: p.updated_at
      }));
      console.log(`[Supabase] Loaded ${data.length} family perimeters`);
    }
  } catch (e) {
    console.error("[Supabase] loadFamilyPerimetersFromSupabase error:", e);
  }
}
async function saveFamilyPerimeterToSupabase(p) {
  try {
    const { error } = await supabaseAdmin.from("family_perimeters").upsert({
      id: p.id,
      owner_id: p.ownerId,
      target_user_id: p.targetUserId,
      target_user_name: p.targetUserName,
      center: p.center,
      radius_meters: p.radiusMeters,
      active: p.active,
      created_at: p.createdAt,
      updated_at: p.updatedAt
    });
    if (error) console.error("[Supabase] saveFamilyPerimeterToSupabase error:", error.message);
  } catch (e) {
    console.error("[Supabase] saveFamilyPerimeterToSupabase error:", e);
  }
}
async function deleteFamilyPerimeterFromSupabase(perimeterId) {
  try {
    const { error } = await supabaseAdmin.from("family_perimeters").delete().eq("id", perimeterId);
    if (error) console.error("[Supabase] deleteFamilyPerimeterFromSupabase error:", error.message);
  } catch (e) {
    console.error("[Supabase] deleteFamilyPerimeterFromSupabase error:", e);
  }
}
async function loadPushTokensFromSupabase() {
  try {
    const { data, error } = await supabaseAdmin.from("push_tokens").select("*");
    if (error) {
      console.error("[Supabase] Failed to load push_tokens:", error.message);
      return;
    }
    if (data && data.length > 0) {
      pushTokens.clear();
      data.forEach((t) => {
        pushTokens.set(t.token, {
          token: t.token,
          userId: t.user_id,
          userRole: t.user_role,
          registeredAt: t.registered_at
        });
      });
      console.log(`[Supabase] Loaded ${data.length} push tokens`);
    }
  } catch (e) {
    console.error("[Supabase] loadPushTokensFromSupabase error:", e);
  }
}
async function savePushTokenToSupabase(entry) {
  try {
    console.log("[Supabase] Saving push token for", entry.userId, entry.userRole);
    const { error } = await supabaseAdmin.from("push_tokens").upsert({
      token: entry.token,
      user_id: entry.userId,
      user_role: entry.userRole,
      registered_at: entry.registeredAt
    });
    if (error) {
      console.error("[Supabase] savePushTokenToSupabase error:", error.message, "code:", error.code);
    } else {
      console.log("[Supabase] Push token saved OK for", entry.userId);
    }
  } catch (e) {
    console.error("[Supabase] savePushTokenToSupabase error:", e);
  }
}
async function deletePushTokenFromSupabase(token) {
  try {
    const { error } = await supabaseAdmin.from("push_tokens").delete().eq("token", token);
    if (error) console.error("[Supabase] deletePushTokenFromSupabase error:", error.message);
  } catch (e) {
    console.error("[Supabase] deletePushTokenFromSupabase error:", e);
  }
}
async function generateIncidentId(type, createdBy, location) {
  try {
    const { data, error } = await supabaseAdmin.rpc("increment_incident_counter");
    const num = !error && data ? data : Date.now() % 1e4;
    const creator = adminUsers.get(createdBy);
    const creatorName = creator?.name || createdBy;
    const address = location?.address || "";
    let city = "";
    if (address) {
      const parts2 = address.split(",").map((p) => p.trim());
      city = parts2[1] || parts2[0] || "";
      if (city.length > 20) city = city.substring(0, 20);
    }
    const TYPE_LABELS = {
      sos: "SOS",
      medical: "M\xC9DICAL",
      fire: "INCENDIE",
      security: "S\xC9CURIT\xC9",
      accident: "ACCIDENT",
      broadcast: "BROADCAST",
      home_jacking: "HOME-JACKING",
      cambriolage: "CAMBRIOLAGE",
      other: "INCIDENT"
    };
    const typeLabel = TYPE_LABELS[type] || type.toUpperCase();
    const parts = [typeLabel];
    if (creatorName && creatorName !== "system" && creatorName !== "mobile-user") parts.push(creatorName);
    if (city) parts.push(city);
    parts.push(`#${String(num).padStart(4, "0")}`);
    return parts.join(" \u2014 ");
  } catch (e) {
    return `INC-${v4_default().slice(0, 8).toUpperCase()}`;
  }
}
async function geocodeAddress(addressText) {
  try {
    const token = process.env.MAPBOX_TOKEN;
    if (!token) {
      console.warn("[Geocode] MAPBOX_TOKEN not set");
      return null;
    }
    const encoded = encodeURIComponent(addressText);
    const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encoded}.json?access_token=${token}&limit=1`;
    const resp = await fetch(url);
    if (!resp.ok) {
      console.warn("[Geocode] Mapbox error", resp.status);
      return null;
    }
    const data = await resp.json();
    const feature = data.features?.[0];
    if (!feature) {
      console.warn("[Geocode] No results for:", addressText);
      return null;
    }
    const [longitude, latitude] = feature.center;
    return { latitude, longitude };
  } catch (e) {
    console.error("[Geocode] geocodeAddress error:", e);
    return null;
  }
}
async function saveConversationToSupabase(conv) {
  try {
    const { error } = await supabaseAdmin.from("conversations").upsert({
      id: conv.id,
      type: conv.type,
      name: conv.name,
      participant_ids: conv.participantIds,
      filter_role: conv.filterRole || null,
      filter_tags: conv.filterTags || null,
      created_by: conv.createdBy,
      created_at: conv.createdAt,
      last_message: conv.lastMessage || "",
      last_message_time: conv.lastMessageTime || 0
    });
    if (error) console.error("[Supabase] saveConversation error:", error.message);
  } catch (e) {
    console.error("[Supabase] saveConversation error:", e);
  }
}
async function saveMessageToSupabase(msg) {
  try {
    const { error } = await supabaseAdmin.from("messages").upsert({
      id: msg.id,
      conversation_id: msg.conversationId,
      sender_id: msg.senderId,
      sender_name: msg.senderName,
      sender_role: msg.senderRole,
      text: msg.text,
      type: msg.type,
      timestamp: msg.timestamp,
      media_url: msg.mediaUrl || null,
      media_type: msg.mediaType || null,
      location: msg.location || null
    });
    if (error) console.error("[Supabase] saveMessage error:", error.message);
  } catch (e) {
    console.error("[Supabase] saveMessage error:", e);
  }
}
async function loadConversationsFromSupabase() {
  try {
    const { data, error } = await supabaseAdmin.from("conversations").select("*");
    if (error) {
      console.error("[Supabase] loadConversations error:", error.message);
      return;
    }
    if (data && data.length > 0) {
      conversations.clear();
      data.forEach((c) => {
        const conv = {
          id: c.id,
          type: c.type,
          name: c.name,
          participantIds: c.participant_ids || [],
          filterRole: c.filter_role,
          filterTags: c.filter_tags,
          createdBy: c.created_by,
          createdAt: c.created_at,
          lastMessage: c.last_message || "",
          lastMessageTime: c.last_message_time || 0,
          unreadCounts: c.unread_counts || {}
        };
        conversations.set(c.id, conv);
      });
      console.log(`[Supabase] Loaded ${data.length} conversations`);
    }
  } catch (e) {
    console.error("[Supabase] loadConversations error:", e);
  }
}
async function loadMessagesFromSupabase() {
  try {
    const { data, error } = await supabaseAdmin.from("messages").select("*").order("timestamp", { ascending: true });
    if (error) {
      console.error("[Supabase] loadMessages error:", error.message);
      return;
    }
    if (data && data.length > 0) {
      messages.clear();
      data.forEach((m) => {
        const msg = {
          id: m.id,
          conversationId: m.conversation_id,
          senderId: m.sender_id,
          senderName: m.sender_name,
          senderRole: m.sender_role,
          text: m.text,
          type: m.type,
          timestamp: m.timestamp,
          mediaUrl: m.media_url || void 0,
          mediaType: m.media_type || void 0,
          location: m.location || void 0
        };
        if (!messages.has(msg.conversationId)) messages.set(msg.conversationId, []);
        messages.get(msg.conversationId).push(msg);
      });
      console.log(`[Supabase] Loaded ${data.length} messages`);
    }
  } catch (e) {
    console.error("[Supabase] loadMessages error:", e);
  }
}
app.post("/api/livekit/token", async (req, res) => {
  const { userId, userName, roomName } = req.body;
  if (!userId || !roomName) return res.status(400).json({ error: "userId and roomName required" });
  try {
    const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
      identity: userId,
      name: userName || userId,
      ttl: "4h"
    });
    at.addGrant({
      roomJoin: true,
      room: roomName,
      canPublish: true,
      canSubscribe: true,
      canPublishSources: ["microphone"]
    });
    const token = await at.toJwt();
    res.json({ token, url: LIVEKIT_URL, room: roomName });
    console.log(`[LiveKit] Token g\xE9n\xE9r\xE9 pour ${userName} dans room ${roomName}`);
  } catch (e) {
    console.error("[LiveKit] Token error:", e);
    res.status(500).json({ error: e.message });
  }
});
app.get("/api/livekit/rooms", async (req, res) => {
  res.json({
    rooms: [
      { name: "dispatch", label: "Canal Dispatch", type: "group" }
    ],
    livekitUrl: LIVEKIT_URL
  });
});
var userAddresses = /* @__PURE__ */ new Map();
async function loadUserAddressesFromSupabase() {
  try {
    const { data, error } = await supabaseAdmin.from("user_addresses").select("*");
    if (error) {
      console.error("[Supabase] Failed to load user_addresses:", error.message);
      return;
    }
    if (data && data.length > 0) {
      userAddresses.clear();
      data.forEach((a) => {
        const addr = {
          id: a.id,
          userId: a.user_id,
          label: a.label,
          address: a.address,
          latitude: a.latitude,
          longitude: a.longitude,
          placeId: a.place_id,
          isPrimary: a.is_primary,
          alarmCode: a.alarm_code,
          notes: a.notes,
          createdAt: a.created_at,
          updatedAt: a.updated_at
        };
        if (!userAddresses.has(addr.userId)) userAddresses.set(addr.userId, []);
        userAddresses.get(addr.userId).push(addr);
      });
      console.log(`[Supabase] Loaded ${data.length} user addresses`);
    }
  } catch (e) {
    console.error("[Supabase] loadUserAddressesFromSupabase error:", e);
  }
}
app.get("/api/users/:id/addresses", (req, res) => {
  const addresses = userAddresses.get(req.params.id) || [];
  res.json(addresses);
});
app.post("/api/users/:id/addresses", async (req, res) => {
  const { label, address, latitude, longitude, placeId, isPrimary, alarmCode, notes } = req.body;
  if (!label || !address) return res.status(400).json({ error: "label and address are required" });
  const userId = req.params.id;
  const now = Date.now();
  let lat = latitude || null;
  let lng = longitude || null;
  if (!lat || !lng) {
    const coords = await geocodeAddress(address);
    if (coords) {
      lat = coords.latitude;
      lng = coords.longitude;
    } else console.warn("[Addresses] Could not geocode: " + address);
  }
  const newAddr = {
    id: require("crypto").randomUUID(),
    userId,
    label,
    address,
    latitude: lat,
    longitude: lng,
    placeId: placeId || null,
    isPrimary: isPrimary || false,
    alarmCode: alarmCode || null,
    notes: notes || null,
    createdAt: now,
    updatedAt: now
  };
  if (isPrimary) {
    const existing = userAddresses.get(userId) || [];
    existing.forEach((a) => {
      if (a.isPrimary) a.isPrimary = false;
    });
  }
  if (!userAddresses.has(userId)) userAddresses.set(userId, []);
  userAddresses.get(userId).push(newAddr);
  await supabaseAdmin.from("user_addresses").insert({
    id: newAddr.id,
    user_id: userId,
    label,
    address,
    latitude: newAddr.latitude,
    longitude: newAddr.longitude,
    place_id: newAddr.placeId,
    is_primary: newAddr.isPrimary,
    alarm_code: newAddr.alarmCode,
    notes: newAddr.notes,
    created_at: now,
    updated_at: now
  });
  res.status(201).json(newAddr);
});
app.put("/api/users/:id/addresses/:addressId", async (req, res) => {
  const { label, address, latitude, longitude, placeId, isPrimary, alarmCode, notes } = req.body;
  const userId = req.params.id;
  const addresses = userAddresses.get(userId) || [];
  const idx = addresses.findIndex((a) => a.id === req.params.addressId);
  if (idx === -1) return res.status(404).json({ error: "Address not found" });
  if (isPrimary) addresses.forEach((a) => {
    a.isPrimary = false;
  });
  let finalLat = latitude ?? addresses[idx].latitude;
  let finalLng = longitude ?? addresses[idx].longitude;
  const addressChanged = address && address !== addresses[idx].address;
  if (addressChanged && !latitude && !longitude) {
    const coords = await geocodeAddress(address ?? addresses[idx].address);
    if (coords) {
      finalLat = coords.latitude;
      finalLng = coords.longitude;
    }
  }
  const updated = {
    ...addresses[idx],
    label: label ?? addresses[idx].label,
    address: address ?? addresses[idx].address,
    latitude: finalLat,
    longitude: finalLng,
    isPrimary: isPrimary ?? addresses[idx].isPrimary,
    alarmCode: alarmCode ?? addresses[idx].alarmCode,
    notes: notes ?? addresses[idx].notes,
    updatedAt: Date.now()
  };
  addresses[idx] = updated;
  await supabaseAdmin.from("user_addresses").update({
    label: updated.label,
    address: updated.address,
    latitude: updated.latitude,
    longitude: updated.longitude,
    is_primary: updated.isPrimary,
    alarm_code: updated.alarmCode,
    notes: updated.notes,
    updated_at: updated.updatedAt
  }).eq("id", updated.id);
  res.json(updated);
});
app.delete("/api/users/:id/addresses/:addressId", async (req, res) => {
  const userId = req.params.id;
  const addresses = userAddresses.get(userId) || [];
  const idx = addresses.findIndex((a) => a.id === req.params.addressId);
  if (idx === -1) return res.status(404).json({ error: "Address not found" });
  addresses.splice(idx, 1);
  await supabaseAdmin.from("user_addresses").delete().eq("id", req.params.addressId);
  res.json({ success: true });
});
app.post("/api/admin/geocode-addresses", async (req, res) => {
  let processed = 0, updated = 0, failed = 0;
  for (const [userId, addrs] of userAddresses) {
    for (const addr of addrs) {
      if (addr.latitude && addr.longitude) continue;
      processed++;
      const coords = await geocodeAddress(addr.address);
      if (!coords) {
        failed++;
        console.warn("[BatchGeocode] Failed: " + addr.address);
        continue;
      }
      addr.latitude = coords.latitude;
      addr.longitude = coords.longitude;
      addr.updatedAt = Date.now();
      await supabaseAdmin.from("user_addresses").update({
        latitude: coords.latitude,
        longitude: coords.longitude,
        updated_at: addr.updatedAt
      }).eq("id", addr.id);
      updated++;
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  res.json({ processed, updated, failed });
});
app.get("/api/alerts/:id/context", async (req, res) => {
  const alert = alerts.get(req.params.id);
  if (!alert) return res.status(404).json({ error: "Alert not found" });
  const createdBy = alert.createdBy;
  let user = adminUsers.get(createdBy);
  let resolvedUserId = createdBy;
  if (!user) {
    for (const [uid, u] of adminUsers) {
      const fullName = [u.firstName, u.lastName].filter(Boolean).join(" ").trim() || u.name || "";
      if (fullName === createdBy || u.name === createdBy || u.email === createdBy) {
        user = u;
        resolvedUserId = uid;
        break;
      }
    }
  }
  if (!user) return res.json({ alert, user: null, addresses: [], family: [], locationContext: null });
  const addresses = userAddresses.get(resolvedUserId) || [];
  let locationContext = null;
  if (alert.location?.latitude && alert.location?.longitude && addresses.length > 0) {
    let closest = null;
    let minDist = Infinity;
    for (const addr of addresses) {
      if (!addr.latitude || !addr.longitude) continue;
      const dist = haversineDistance(alert.location.latitude, alert.location.longitude, addr.latitude, addr.longitude);
      if (dist < minDist) {
        minDist = dist;
        closest = addr;
      }
    }
    if (closest && minDist < 500) {
      locationContext = {
        type: "known_address",
        label: closest.label,
        address: closest.address,
        distanceMeters: Math.round(minDist),
        alarmCode: closest.alarmCode,
        isHomeJacking: minDist < 100
      };
    }
  }
  const family = (user.relationships || []).map((rel) => {
    let member = adminUsers.get(rel.userId);
    if (!member) {
      for (const [, u] of adminUsers) {
        if (u.id === rel.userId) {
          member = u;
          break;
        }
      }
    }
    if (!member) return null;
    return { id: member.id, name: member.name, role: rel.type, phone: member.phoneMobile, photoUrl: member.photoUrl };
  }).filter(Boolean);
  const { passwordHash, ...safeUser } = user;
  res.json({ user: { ...safeUser, hasPassword: !!user.passwordHash }, addresses, family, locationContext });
});
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  app,
  server,
  wss
});
/*! Bundled license information:

object-assign/index.js:
  (*
  object-assign
  (c) Sindre Sorhus
  @license MIT
  *)

vary/index.js:
  (*!
   * vary
   * Copyright(c) 2014-2017 Douglas Christopher Wilson
   * MIT Licensed
   *)
*/
