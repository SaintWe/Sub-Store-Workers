import { requestContext } from '../../utils/context.js';

const REGISTRY_KEY = '__substore_request_contexts__';
const PROXIES_INSTALLED_KEY = '__substore_context_proxies_installed__';
const RUNTIME_GLOBALS_INSTALLED_KEY = '__substore_runtime_globals_installed__';
const FALLBACK_ENV_KEY = '__substore_runtime_fallback_env__';
const IMPORT_CONTEXT_KEY = '__substore_import_context__';

function getRegistry() {
    if (!globalThis[REGISTRY_KEY]) {
        globalThis[REGISTRY_KEY] = new Map();
    }
    return globalThis[REGISTRY_KEY];
}

export function getActiveSubStoreContext() {
    return requestContext.getStore()?.subStore || null;
}

function getImportCapableSubStoreContext() {
    return getActiveSubStoreContext() || globalThis[IMPORT_CONTEXT_KEY] || null;
}

function createImportPersistentStore(realStore) {
    const values = new Map();
    return {
        read(key) {
            const storageKey = key || '__default__';
            if (values.has(storageKey)) return values.get(storageKey);
            return realStore?.read?.(key) ?? null;
        },
        write(data, key) {
            const storageKey = key || '__default__';
            values.set(storageKey, data);
            return true;
        },
    };
}

function createImportContext(context) {
    return {
        ...context,
        persistentStore: createImportPersistentStore(context.persistentStore),
    };
}

export async function runWithSubStoreImportContext(fn) {
    const context = getActiveSubStoreContext();
    if (!context) return await fn();
    const importContext = createImportContext(context);
    globalThis[IMPORT_CONTEXT_KEY] = importContext;
    try {
        return await fn();
    } finally {
        if (globalThis[IMPORT_CONTEXT_KEY] === importContext) {
            delete globalThis[IMPORT_CONTEXT_KEY];
        }
    }
}

export function getSubStoreContextById(requestId) {
    if (!requestId) return null;
    return getRegistry().get(requestId) || null;
}

function getActiveSubStoreEnv() {
    return getImportCapableSubStoreContext()?.env || globalThis[FALLBACK_ENV_KEY] || {};
}

function createEnvProxy() {
    return new Proxy({}, {
        get(_target, prop) {
            return getActiveSubStoreEnv()?.[prop];
        },
        set(_target, prop, value) {
            const env = getActiveSubStoreEnv();
            env[prop] = value;
            return true;
        },
        has(_target, prop) {
            return prop in (getActiveSubStoreEnv() || {});
        },
        ownKeys() {
            return Reflect.ownKeys(getActiveSubStoreEnv() || {});
        },
        getOwnPropertyDescriptor(_target, prop) {
            const env = getActiveSubStoreEnv() || {};
            if (!(prop in env)) return undefined;
            return { enumerable: true, configurable: true };
        },
    });
}

export function installSubStoreRuntimeGlobals() {
    if (globalThis[RUNTIME_GLOBALS_INSTALLED_KEY]) return;

    const existingProcess = globalThis.process && typeof globalThis.process === 'object' ? globalThis.process : {};
    globalThis[FALLBACK_ENV_KEY] = existingProcess.env || {};
    const envProxy = createEnvProxy();

    Object.defineProperty(globalThis, '__env__', {
        configurable: true,
        get: getActiveSubStoreEnv,
    });

    globalThis.process = {
        ...existingProcess,
        version: existingProcess.version || 'v20.0.0',
        argv: existingProcess.argv || [],
        cwd: existingProcess.cwd || (() => '/'),
    };
    Object.defineProperty(globalThis.process, 'env', {
        configurable: true,
        get() {
            return envProxy;
        },
    });

    globalThis.__filename = '/worker.js';
    globalThis.__dirname = '/';
    globalThis[RUNTIME_GLOBALS_INSTALLED_KEY] = true;
}

export function installSubStoreContextGlobals() {
    if (globalThis[PROXIES_INSTALLED_KEY]) return;

    globalThis.__substore_get_active_context__ = getActiveSubStoreContext;
    globalThis.__substore_get_context_by_id__ = getSubStoreContextById;

    Object.defineProperty(globalThis, '$request', {
        configurable: true,
        get() {
            return getActiveSubStoreContext()?.request;
        },
    });

    globalThis.$persistentStore = {
        read(key) {
            return getImportCapableSubStoreContext()?.persistentStore?.read(key) ?? null;
        },
        write(data, key) {
            return getImportCapableSubStoreContext()?.persistentStore?.write(data, key) ?? false;
        },
    };

    globalThis.$done = (response) => {
        const ctx = getActiveSubStoreContext();
        if (ctx && !ctx.aborted && typeof ctx.done === 'function') {
            ctx.done(response);
        }
    };

    globalThis.$notification = {
        post(...args) {
            const ctx = getActiveSubStoreContext();
            if (ctx?.aborted) return;
            return ctx?.notification?.post?.(...args);
        },
    };

    globalThis.$environment = new Proxy({}, {
        get(_target, prop) {
            return getActiveSubStoreContext()?.environment?.[prop];
        },
        has(_target, prop) {
            return prop in (getActiveSubStoreContext()?.environment || {});
        },
        ownKeys() {
            return Reflect.ownKeys(getActiveSubStoreContext()?.environment || {});
        },
        getOwnPropertyDescriptor(_target, prop) {
            const environment = getActiveSubStoreContext()?.environment || {};
            if (!(prop in environment)) return undefined;
            return { enumerable: true, configurable: true };
        },
    });

    globalThis[PROXIES_INSTALLED_KEY] = true;
}

export function createSubStoreRequestContext({ requestId, request, user, env, persistentStore, notification, environment, cache = {} }) {
    return {
        requestId,
        request,
        user,
        env,
        persistentStore,
        notification,
        environment,
        cache,
        dirty: false,
        userData: null,
        done: null,
        // 超时取消标志：置位后，底层脚本的所有副作用出口（存储写入、通知、
        // flush 落盘）全部被闸掉，避免超时后仍产生数据写入。
        aborted: false,
        // 取消执行：置位 aborted、摘掉 done 回调，使未完成的请求无法再回写结果。
        cancel() {
            this.aborted = true;
            this.done = null;
        },
    };
}

export async function runWithSubStoreContext(subStoreContext, fn) {
    installSubStoreContextGlobals();
    getRegistry().set(subStoreContext.requestId, subStoreContext);
    const parent = requestContext.getStore() || {};
    return await requestContext.run({ ...parent, subStore: subStoreContext }, fn);
}

export function flushSubStoreRequestContext(subStoreContext) {
    if (!subStoreContext?.dirty || !subStoreContext.userData) return null;
    // 已取消（超时）的请求不得落盘：底层脚本可能在超时后继续写入，
    // 把这些写入持久化会污染用户数据。
    if (subStoreContext.aborted) {
        subStoreContext.dirty = false;
        subStoreContext.userData = null;
        return null;
    }
    const dataString = JSON.stringify(subStoreContext.userData);
    subStoreContext.dirty = false;
    subStoreContext.userData = null;
    return dataString;
}

export function deleteSubStoreRequestContext(requestId) {
    if (!requestId) return;
    getRegistry().delete(requestId);
}
