/**
 * Sub-Store user script execution via QuickJS (WASM)
 *
 * Goal: Provide a Workers-safe replacement for upstream `new Function(...)` user scripts,
 * while keeping the script API surface as compatible as possible.
 */

import { debug, warn } from '../../utils/logger.js';

let quickJsModuleLoaderPromise = null;

async function getQuickJsModule() {
    if (!quickJsModuleLoaderPromise) {
        quickJsModuleLoaderPromise = import('./quickjs-module.js').then((mod) => mod.getQuickJsModule());
    }
    return await quickJsModuleLoaderPromise;
}

const GLOBAL_CREATE_DYNAMIC_FUNCTION = '__substore_workers_createDynamicFunction__';

const DEFAULT_LIMITS = {
    timeoutMs: 15000,
    memoryLimitBytes: 32 * 1024 * 1024,
    maxStackSizeBytes: 512 * 1024,
};

function declaresNamedFunction(source, fnName) {
    const s = String(source || '');
    // Basic heuristic: if user already provides a full function definition, don't rewrite.
    return new RegExp(`\\basync\\s+function\\s+${fnName}\\b|\\bfunction\\s+${fnName}\\b`).test(s);
}

function looksLikeShortcutScript(source) {
    const s = String(source || '');
    // Shortcut scripts in Sub-Store commonly rely on these injected identifiers.
    return s.includes('$server') || s.includes('$content') || s.includes('$files');
}

function wrapSubStoreShortcutScript(name, script) {
    // Mirror upstream fallback wrappers (processors/index.js ScriptFilter.nodeFunc / ScriptOperator.nodeFunc)
    if (name === 'filter') {
        return `async function filter(input = [], targetPlatform, context) {
            let proxies = input
            let list = []
            const fn = async ($server) => {
                ${script}
            }
            for await (let $server of proxies) {
                list.push(await fn($server))
            }
            return list
        }`;
    }

    if (name === 'operator') {
        return `async function operator(input = [], targetPlatform, context) {
            if (input && (input.$files || input.$content)) {
                let { $content, $files, $options, $file } = input
                if($file.type === 'mihomoProfile') {
                    ${script}
                    if(typeof main === 'function') {
                        let config;
                        if ($content) {
                            try {
                                config = ProxyUtils.yaml.safeLoad($content);
                            } catch (e) {
                                console.log(e.message ?? e);
                            }
                        }
                        $content = ProxyUtils.yaml.safeDump(await main(config || ($file.sourceType === 'none' ? {} : {
                            proxies: await produceArtifact({
                                type: $file.sourceType || 'collection',
                                name: $file.sourceName,
                                platform: 'mihomo',
                                produceType: 'internal',
                                produceOpts: {
                                    'delete-underscore-fields': true
                                }
                            }),
                        })))
                    }
                } else {
                    ${script}
                }
                return { $content, $files, $options, $file }
            } else {
                let proxies = input
                let list = []
                for await (let $server of proxies) {
                    ${script}
                    list.push($server)
                }
                return list
            }
        }`;
    }

    return script;
}

function normalizeSubStoreScriptForQuickJs(name, script) {
    // Sub-Store officially supports "shortcut script" for Script Filter/Operator.
    // Example: `return $server._geo && $server._entrance` (no function declaration)
    // Upstream runs a fallback wrapper that defines `$server` per proxy.
    if ((name === 'filter' || name === 'operator') && !declaresNamedFunction(script, name) && looksLikeShortcutScript(script)) {
        return wrapSubStoreShortcutScript(name, script);
    }
    return script;
}

function isThenable(x) {
    return !!x && (typeof x === 'object' || typeof x === 'function') && typeof x.then === 'function';
}

function isSafePathSegment(seg) {
    if (!seg) return false;
    if (seg === '__proto__' || seg === 'prototype' || seg === 'constructor') return false;
    // Avoid Function.prototype escape hatches for callable roots.
    if (seg === 'apply' || seg === 'call' || seg === 'bind') return false;
    return true;
}

function resolveCallable(rootMap, path) {
    const parts = String(path || '').split('.').filter(Boolean);
    if (parts.length === 0) throw new Error('empty path');

    const rootName = parts[0];
    if (!(rootName in rootMap)) {
        throw new Error(`host api root not allowed: ${rootName}`);
    }

    let receiver = undefined;
    let cur = rootMap[rootName];
    for (const seg of parts.slice(1)) {
        if (!isSafePathSegment(seg)) throw new Error(`unsafe property access: ${seg}`);
        receiver = cur;
        cur = cur?.[seg];
    }

    return { fn: cur, receiver };
}

function resolvePath(rootMap, path) {
    const parts = String(path || '').split('.').filter(Boolean);
    if (parts.length === 0) throw new Error('empty path');

    const rootName = parts[0];
    if (!(rootName in rootMap)) {
        throw new Error(`host api root not allowed: ${rootName}`);
    }

    let cur = rootMap[rootName];
    for (const seg of parts.slice(1)) {
        if (!isSafePathSegment(seg)) throw new Error(`unsafe property access: ${seg}`);
        cur = cur?.[seg];
    }
    return cur;
}

function nativeToQuickJsHandle(vm, value) {
    if (value === null) return vm.null;
    if (value === undefined) return vm.undefined;
    if (typeof value === 'string') return vm.newString(value);
    if (typeof value === 'number') return vm.newNumber(value);
    if (typeof value === 'boolean') return value ? vm.true : vm.false;

    if (Array.isArray(value)) {
        const arr = vm.newArray();
        for (let i = 0; i < value.length; i += 1) {
            const h = nativeToQuickJsHandle(vm, value[i]);
            vm.setProp(arr, i, h);
            h.dispose();
        }
        return arr;
    }

    if (typeof value === 'object') {
        const obj = vm.newObject();
        for (const [k, v] of Object.entries(value)) {
            const h = nativeToQuickJsHandle(vm, v);
            vm.setProp(obj, k, h);
            h.dispose();
        }
        return obj;
    }

    // Fallback: stringification
    return vm.newString(String(value));
}

function buildEnvSnapshot($substore) {
    const env = $substore?.env && typeof $substore.env === 'object' ? $substore.env : {};
    const snapshot = {
        isSurge: !!env.isSurge,
        isLoon: !!env.isLoon,
        isQuanX: !!env.isQuanX,
        isNode: !!env.isNode,
        isStash: !!env.isStash,
        isShadowrocket: !!env.isShadowrocket,
        isVercel: !!env.isVercel,
    };
    return snapshot;
}

function buildPreludeSource() {
    // - __hostCall(path, args)
    // - __makeHostProxy(prefix) -> Proxy that calls __hostCall on apply
    // - Buffer polyfill (minimal)
    return `
// __SUB_STORE_WORKERS_QJS_PRELUDE__
function __makeHostProxy(prefix) {
  const fn = function(...args) { return __hostCall(prefix, args); };
  return new Proxy(fn, {
    get(_t, prop) {
      // Prevent thenable assimilation
      if (prop === 'then') return undefined;
      if (prop === Symbol.toStringTag) return 'HostProxy';
      if (prop === 'toJSON') return () => '[HostProxy ' + prefix + ']';
      return __makeHostProxy(prefix + '.' + String(prop));
    },
    apply(_t, _thisArg, args) {
      return __hostCall(prefix, args);
    }
  });
}
globalThis.__makeHostProxy__ = __makeHostProxy;

// Minimal Buffer polyfill (subset)
const __b64chars__ = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function __b64Encode__(bytes) {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += __b64chars__[(n >> 18) & 63] + __b64chars__[(n >> 12) & 63] + __b64chars__[(n >> 6) & 63] + __b64chars__[n & 63];
  }
  const remain = bytes.length - i;
  if (remain === 1) {
    const n = bytes[i] << 16;
    out += __b64chars__[(n >> 18) & 63] + __b64chars__[(n >> 12) & 63] + '==';
  } else if (remain === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += __b64chars__[(n >> 18) & 63] + __b64chars__[(n >> 12) & 63] + __b64chars__[(n >> 6) & 63] + '=';
  }
  return out;
}
function __b64Decode__(b64) {
  const clean = String(b64 || '').replace(/\s+/g, '');
  if (clean.length % 4 !== 0) throw new Error('Invalid base64');
  const pad = (clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0);
  const len = (clean.length / 4) * 3 - pad;
  const out = new Uint8Array(len);
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const c0 = __b64chars__.indexOf(clean[i]);
    const c1 = __b64chars__.indexOf(clean[i + 1]);
    const c2 = clean[i + 2] === '=' ? 0 : __b64chars__.indexOf(clean[i + 2]);
    const c3 = clean[i + 3] === '=' ? 0 : __b64chars__.indexOf(clean[i + 3]);
    const n = (c0 << 18) | (c1 << 12) | (c2 << 6) | c3;
    if (o < out.length) out[o++] = (n >> 16) & 255;
    if (o < out.length) out[o++] = (n >> 8) & 255;
    if (o < out.length) out[o++] = n & 255;
  }
  return out;
}

class BufferPolyfill {
  constructor(u8) { this._u8 = u8; }
  static from(input, encoding) {
    const enc = (encoding || 'utf8').toLowerCase();
    if (typeof input === 'string') {
      if (enc === 'base64') return new BufferPolyfill(__b64Decode__(input));
      return new BufferPolyfill(new TextEncoder().encode(input));
    }
    if (input instanceof Uint8Array) return new BufferPolyfill(new Uint8Array(input));
    if (input && input.buffer && input.byteLength !== undefined) return new BufferPolyfill(new Uint8Array(input.buffer));
    return new BufferPolyfill(new TextEncoder().encode(String(input)));
  }
  toString(encoding) {
    const enc = (encoding || 'utf8').toLowerCase();
    if (enc === 'base64') return __b64Encode__(this._u8);
    return new TextDecoder().decode(this._u8);
  }
  get length() { return this._u8.length; }
}
globalThis.__BufferPolyfill__ = BufferPolyfill;
`;
}

async function runScriptOnce({
    name,
    script,
    $arguments,
    $options,
    $substore,
    hostRoots,
    callArgs,
    limits,
}) {
    const QuickJS = await getQuickJsModule();

    const runtime = QuickJS.newRuntime();

    // 异常/超时路径下 VM 会被销毁；置位后，仍在执行中的 Host Call 回调
    // 不再向 VM 回写结果（回写已销毁的 VM 会抛错）。
    let aborted = false;

    // 统一登记需要释放的 Handle：任何路径（成功 / 异常 / 超时）最终都由
    // finally 无条件释放，避免反复触发异常或超时造成 WASM Runtime/Context 泄漏。
    const handlesToDispose = [];
    const track = (h) => {
        if (h) handlesToDispose.push(h);
        return h;
    };
    // QuickJSDeferredPromise 是自持生命周期对象：宿主 Promise 永不 settle 时，
    // 必须显式 dispose deferred，否则 vm.dispose() 会触发 QuickJS GC 断言。
    const deferredsToDispose = [];
    const trackDeferred = (d) => {
        deferredsToDispose.push(d);
        return d;
    };

    // VM 创建与 Runtime 配置也可能抛错，必须一并纳入 try/finally，
    // 否则这些路径上刚创建的 runtime 会泄漏。
    let vm = null;
    let out;
    try {
        vm = runtime.newContext();

        const deadline = Date.now() + (limits.timeoutMs || DEFAULT_LIMITS.timeoutMs);
        runtime.setMemoryLimit(limits.memoryLimitBytes || DEFAULT_LIMITS.memoryLimitBytes);
        runtime.setMaxStackSize(limits.maxStackSizeBytes || DEFAULT_LIMITS.maxStackSizeBytes);
        runtime.setInterruptHandler(() => Date.now() > deadline);

        const executePendingJobs = () => {
            // 已取消（异常/超时路径）时 Runtime 即将/已经销毁，不再触碰。
            if (aborted) return;
            const r = runtime.executePendingJobs();
            // executePendingJobs may throw via unwrapResult if we want; here best-effort.
            if (r && r.error) {
                // dispose error handle to avoid leaking.
                try {
                    r.error.dispose();
                } catch {
                    // ignore
                }
            }
        };

        // Host-call bridge
        const hostCallHandle = vm.newFunction('__hostCall', (pathHandle, argsHandle) => {
            const path = vm.dump(pathHandle);
            const args = vm.dump(argsHandle) || [];

            const callable = resolveCallable(hostRoots, path);
            if (typeof callable.fn !== 'function') {
                throw new Error(`host api is not callable: ${String(path)}`);
            }

            let result;
            try {
                result = callable.fn.apply(callable.receiver, Array.isArray(args) ? args : [args]);
            } catch (e) {
                throw e;
            }

            if (isThenable(result)) {
                const deferred = trackDeferred(vm.newPromise());
                deferred.settled.then(executePendingJobs);

                Promise.resolve(result)
                    .then((value) => {
                        if (aborted) return;
                        const h = nativeToQuickJsHandle(vm, value);
                        deferred.resolve(h);
                        h.dispose();
                    })
                    .catch((err) => {
                        if (aborted) return;
                        const h = vm.newString(err?.message || String(err));
                        deferred.reject(h);
                        h.dispose();
                    });

                return deferred.handle;
            }

            return nativeToQuickJsHandle(vm, result);
        });

        // Expose hostCall to global
        vm.setProp(vm.global, '__hostCall', hostCallHandle);
        // Transfer ownership to the VM (the global now references it)
        hostCallHandle.dispose();

        // Install prelude (proxies + Buffer polyfill)
        const preludeResult = vm.evalCode(buildPreludeSource());
        if (preludeResult.error) {
            const msg = vm.dump(preludeResult.error);
            preludeResult.error.dispose();
            throw new Error(`QuickJS prelude failed: ${msg}`);
        }
        preludeResult.value.dispose();

        // Build injected values
        const envSnapshot = buildEnvSnapshot($substore);

        const qjsArguments = track(nativeToQuickJsHandle(vm, $arguments || {}));
        const qjsOptions = track(nativeToQuickJsHandle(vm, $options || {}));

        // $substore object: env snapshot + selected methods mapped to host api
        const qjsSubstore = track(vm.newObject());
        const qjsEnv = nativeToQuickJsHandle(vm, envSnapshot);
        vm.setProp(qjsSubstore, 'env', qjsEnv);
        qjsEnv.dispose();

        // $substore.http.* (very commonly used in Sub-Store scripts)
        {
            const qjsHttp = vm.newObject();
            const methods = ['get', 'post', 'put', 'delete', 'head', 'options', 'patch'];
            for (const method of methods) {
                const fn = vm.newFunction(method, (optionsHandle) => {
                    const options = vm.dump(optionsHandle);
                    const callable = resolveCallable(hostRoots, `substore.http.${method}`);
                    const res = callable.fn.apply(callable.receiver, [options]);
                    if (isThenable(res)) {
                        const deferred = trackDeferred(vm.newPromise());
                        deferred.settled.then(executePendingJobs);
                        Promise.resolve(res)
                            .then((v) => {
                                if (aborted) return;
                                const hv = nativeToQuickJsHandle(vm, v);
                                deferred.resolve(hv);
                                hv.dispose();
                            })
                            .catch((err) => {
                                if (aborted) return;
                                const he = vm.newError(err?.message || String(err));
                                deferred.reject(he);
                                he.dispose();
                            });
                        return deferred.handle;
                    }
                    return nativeToQuickJsHandle(vm, res);
                });
                vm.setProp(qjsHttp, method, fn);
                fn.dispose();
            }
            vm.setProp(qjsSubstore, 'http', qjsHttp);
            qjsHttp.dispose();
        }

        const substoreMethods = ['read', 'write', 'delete', 'log', 'info', 'error', 'notify', 'wait'];
        for (const m of substoreMethods) {
            const fn = vm.newFunction(m, (...args) => {
                // Forward to hostRoots.substore[m]
                const nativeArgs = args.map((h) => vm.dump(h));
                const callable = resolveCallable(hostRoots, `substore.${m}`);
                const res = callable.fn.apply(callable.receiver, nativeArgs);
                if (isThenable(res)) {
                    const deferred = trackDeferred(vm.newPromise());
                    deferred.settled.then(executePendingJobs);
                    Promise.resolve(res)
                        .then((v) => {
                            if (aborted) return;
                            const hv = nativeToQuickJsHandle(vm, v);
                            deferred.resolve(hv);
                            hv.dispose();
                        })
                        .catch((err) => {
                            if (aborted) return;
                            const he = vm.newString(err?.message || String(err));
                            deferred.reject(he);
                            he.dispose();
                        });
                    return deferred.handle;
                }
                return nativeToQuickJsHandle(vm, res);
            });
            vm.setProp(qjsSubstore, m, fn);
            fn.dispose();
        }

        // Provide console.* for common scripts
        {
            const consoleObj = vm.newObject();
            const levels = ['log', 'info', 'warn', 'error'];
            for (const level of levels) {
                const fn = vm.newFunction(level, (...args) => {
                    const nativeArgs = args.map((h) => vm.dump(h));
                    try {
                        // Prefer Sub-Store logger if available
                        const sub = hostRoots.substore;
                        const target = typeof sub?.[level] === 'function' ? sub[level] : console[level] || console.log;
                        if (typeof sub?.[level] === 'function') {
                            target.apply(sub, nativeArgs);
                        } else {
                            target(...nativeArgs);
                        }
                    } catch {
                        // ignore
                    }
                    return vm.undefined;
                });
                vm.setProp(consoleObj, level, fn);
                fn.dispose();
            }
            vm.setProp(vm.global, 'console', consoleObj);
            consoleObj.dispose();
        }

        // Provide Surge-like $utils (geoip/ipasn/ipaso) to QuickJS scripts.
        // These call back into the host's globalThis.$utils.
        {
            const utilsObj = vm.newObject();
            const methods = ['geoip', 'ipasn', 'ipaso'];
            for (const method of methods) {
                const fn = vm.newFunction(method, (ipHandle) => {
                    const ip = vm.dump(ipHandle);
                    const callable = resolveCallable(hostRoots, `surgeUtils.${method}`);
                    if (typeof callable.fn !== 'function') return vm.undefined;
                    const res = callable.fn.apply(callable.receiver, [ip]);
                    return nativeToQuickJsHandle(vm, res);
                });
                vm.setProp(utilsObj, method, fn);
                fn.dispose();
            }
            vm.setProp(vm.global, '$utils', utilsObj);
            utilsObj.dispose();
        }

        // Host proxies
        const makeHostProxy = track(vm.getProp(vm.global, '__makeHostProxy__'));
        const BufferPolyfill = track(vm.getProp(vm.global, '__BufferPolyfill__'));

        const mkProxy = (path) => {
            const pathHandle = vm.newString(path);
            const res = vm.callFunction(makeHostProxy, vm.undefined, pathHandle);
            pathHandle.dispose();
            return vm.unwrapResult(res);
        };

        const lodashProxy = track(mkProxy('lodash'));
        const proxyUtilsProxy = track(mkProxy('ProxyUtils'));
        const yamlProxy = track(mkProxy('ProxyUtils.yaml'));
        const b64dProxy = track(mkProxy('ProxyUtils.Base64.decode'));
        const b64eProxy = track(mkProxy('ProxyUtils.Base64.encode'));
        const domainResolversProxy = track(mkProxy('DOMAIN_RESOLVERS'));
        const cacheProxy = track(mkProxy('scriptResourceCache'));
        const flowUtilsProxy = track(mkProxy('flowUtils'));
        const produceArtifactProxy = track(mkProxy('produceArtifact'));

        // Wrapper that emulates upstream new Function signature
        const wrapperSource = `
(function($arguments,$options,$substore,lodash,ProxyUtils,yaml,Buffer,b64d,b64e,DOMAIN_RESOLVERS,scriptResourceCache,flowUtils,produceArtifact,require){
${script}\n
return ${name};
})
`;

        const wrapperEval = vm.evalCode(wrapperSource);
        if (wrapperEval.error) {
            const msg = vm.dump(wrapperEval.error);
            wrapperEval.error.dispose();
            throw new Error(`QuickJS compile failed: ${msg}`);
        }
        const wrapperFn = track(wrapperEval.value);

        const qjsRequire = vm.undefined;

        const fnHandle = track(
            vm.unwrapResult(
                vm.callFunction(
                    wrapperFn,
                    vm.undefined,
                    qjsArguments,
                    qjsOptions,
                    qjsSubstore,
                    lodashProxy,
                    proxyUtilsProxy,
                    yamlProxy,
                    BufferPolyfill,
                    b64dProxy,
                    b64eProxy,
                    domainResolversProxy,
                    cacheProxy,
                    flowUtilsProxy,
                    produceArtifactProxy,
                    qjsRequire,
                ),
            ),
        );

        const qjsCallArgs = [];
        try {
            for (const v of callArgs) {
                qjsCallArgs.push(nativeToQuickJsHandle(vm, v));
            }
        } catch (e) {
            // 构造参数句柄中途失败时，先释放已创建的句柄再抛出。
            for (const h of qjsCallArgs) {
                try {
                    h.dispose();
                } catch {
                    // ignore
                }
            }
            throw e;
        }

        let callResult;
        try {
            callResult = vm.callFunction(fnHandle, vm.undefined, ...qjsCallArgs);
        } finally {
            for (const h of qjsCallArgs) {
                try {
                    h.dispose();
                } catch {
                    // ignore
                }
            }
        }

        if (callResult.error) {
            const msg = vm.dump(callResult.error);
            callResult.error.dispose();
            throw new Error(`QuickJS script threw: ${msg}`);
        }

        const resultHandle = track(callResult.value);

        // Await promise by pumping pending jobs.
        // In QuickJS, async functions queue pendingJobs and they do not run unless the host calls executePendingJobs().
        // If we just await resolvePromise() without pumping jobs, even an immediately-resolving async function will hang.
        let finalHandle = null;
        let shouldDisposeFinal = false;
        while (true) {
            const state = vm.getPromiseState(resultHandle);
            if (state.type === 'pending') {
                if (Date.now() > deadline) {
                    throw new Error('QuickJS promise pending timeout');
                }
                if (runtime.hasPendingJob()) {
                    const r = runtime.executePendingJobs();
                    if (r && r.error) {
                        const msg = vm.dump(r.error);
                        try {
                            r.error.dispose();
                        } catch {
                            // ignore
                        }
                        throw new Error(`QuickJS executePendingJobs error: ${msg}`);
                    }
                    continue;
                }
                // No pending jobs: yield to host event loop so that any host-side promises can resolve.
                await new Promise((resolve) => setTimeout(resolve, 0));
                continue;
            }

            if (state.type === 'rejected') {
                const msg = vm.dump(state.error);
                state.error.dispose();
                throw new Error(`QuickJS promise rejected: ${msg}`);
            }

            // fulfilled
            if (state.notAPromise || state.value === resultHandle) {
                finalHandle = resultHandle;
                shouldDisposeFinal = false;
            } else {
                finalHandle = state.value;
                shouldDisposeFinal = true;
            }
            break;
        }

        // dump 必须在任何 Handle 释放之前完成。
        out = vm.dump(finalHandle);

        if (shouldDisposeFinal && finalHandle && finalHandle !== resultHandle) {
            track(finalHandle);
        }
    } finally {
        // 统一释放：无论成功、异常还是超时，都无条件释放所有登记的 Handle、
        // VM Context 与 WASM Runtime。
        aborted = true;
        for (const d of deferredsToDispose) {
            try {
                d.dispose();
            } catch {
                // best-effort cleanup
            }
        }
        deferredsToDispose.length = 0;
        for (const h of handlesToDispose) {
            try {
                h.dispose();
            } catch {
                // best-effort cleanup; vm.dispose() will still assert on leaks.
            }
        }
        handlesToDispose.length = 0;
        if (vm) {
            try {
                vm.dispose();
            } catch (e) {
                warn('[QuickJS] vm.dispose error:', e?.message || e);
            }
        }
        try {
            runtime.dispose();
        } catch (e) {
            warn('[QuickJS] runtime.dispose error:', e?.message || e);
        }
    }

    return out;
}

export function ensureSubStoreQuickJsScriptEngineInstalled({
    timeoutMs,
    memoryLimitBytes,
    maxStackSizeBytes,
} = {}) {
    if (typeof globalThis[GLOBAL_CREATE_DYNAMIC_FUNCTION] === 'function') return;

    globalThis[GLOBAL_CREATE_DYNAMIC_FUNCTION] = ({
        name,
        script,
        $arguments,
        $options,
        $substore,
        lodash,
        ProxyUtils,
        DOMAIN_RESOLVERS,
        scriptResourceCache,
        flowUtils,
        produceArtifact,
    }) => {
        const normalizedScript = normalizeSubStoreScriptForQuickJs(name, script);

        // Debug trace: whether Script Filter/Operator reached QuickJS.
        // This is intentionally lightweight and only logs when DEBUG=true.
        const requestId = globalThis.__substore_get_active_context__?.()?.requestId || 'unknown';
        if (name === 'filter' || name === 'operator') {
            const mode = normalizedScript !== script ? 'shortcut' : 'function';
            debug(`[SubStoreScript] [${requestId}] compile ${name} (${mode})`);
        }

        const limits = {
            timeoutMs: timeoutMs ?? DEFAULT_LIMITS.timeoutMs,
            memoryLimitBytes: memoryLimitBytes ?? DEFAULT_LIMITS.memoryLimitBytes,
            maxStackSizeBytes: maxStackSizeBytes ?? DEFAULT_LIMITS.maxStackSizeBytes,
        };

        const hostRoots = {
            // callable via __hostCall('substore.read', [...])
            substore: $substore,
            surgeUtils: globalThis.$utils,
            lodash,
            ProxyUtils,
            DOMAIN_RESOLVERS,
            scriptResourceCache,
            flowUtils,
            // function
            produceArtifact: (...args) => produceArtifact(...args),
        };

        // Return a function compatible with upstream createDynamicFunction() output.
        return async (input = [], targetPlatform, context) => {
            const requestId2 = globalThis.__substore_get_active_context__?.()?.requestId || 'unknown';
            if (name === 'filter' || name === 'operator') {
                const inputHint = Array.isArray(input) ? `list(${input.length})` : 'artifact';
                debug(`[SubStoreScript] [${requestId2}] run ${name} ${inputHint}`);
            }
            return await runScriptOnce({
                name,
                script: normalizedScript,
                $arguments,
                $options,
                $substore,
                hostRoots,
                callArgs: [input, targetPlatform, context],
                limits,
            });
        };
    };
}
