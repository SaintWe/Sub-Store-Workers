/**
 * L4 - Atom
 * 在 User 域内执行 Sub-Store HTTP 请求（每个用户串行）。
 *
 * 说明：
 * - 该 atom 是“Sub-Store 引擎”的运行封装（对本项目来说属于实现细节）。
 * - 为避免混层，已不再依赖 `src/core/substore.js`。
 */

import { initSubStore } from '../../core/substore-loader.js';
import { debug, warn, error as logError } from '../../utils/logger.js';
import { createHttpClient } from '../../adapters/http-client.js';
import { ensureSubStoreQuickJsScriptEngineInstalled } from '../../adapters/quickjs/substore-script-engine.js';
import { ensureSurgeGeoipInstalled } from '../surge/geoip/ensureSurgeGeoipInstalled.js';
import {
    createSubStoreRequestContext,
    deleteSubStoreRequestContext,
    flushSubStoreRequestContext,
    installSubStoreRuntimeGlobals,
    runWithSubStoreContext,
} from './subStoreRequestContext.js';
import { createNotificationGateway } from '../../orchestration/diplomat/notificationGateway.js';
import path from 'node:path';
import { Buffer } from 'node:buffer';
import streamPromises from 'node:stream/promises';

function parseUserSettings(user) {
    try {
        const userData = JSON.parse(user?.data || '{}');
        return userData?.__settings__ || {};
    } catch {
        return {};
    }
}

function ensurePolyfills() {
    // Buffer
    globalThis.Buffer = Buffer;

    // Node.js 原生模块 shim（Sub-Store 代码替换需要）
    globalThis.__path_shim__ = path;
    globalThis.__stream_promises_shim__ = streamPromises;

    // process shim（必须在导入 Sub-Store 前可用）
    if (!globalThis.process) {
        globalThis.process = {
            env: {},
            version: 'v20.0.0',
            argv: [],
            cwd: () => '/',
        };
    }

    // fs shim（空实现）
    if (!globalThis.__fs_shim__) {
        globalThis.__fs_shim__ = {
            existsSync: () => false,
            readFileSync: () => '',
            writeFileSync: () => {},
            copyFileSync: () => {},
        };
    }

    // ms shim（时间字符串解析）
    if (!globalThis.__ms_shim__) {
        globalThis.__ms_shim__ = (val) => {
            if (typeof val === 'number') return val;
            const match = String(val).match(/^(\d+)(ms|s|m|h|d|w|y)?$/);
            if (!match) return 0;
            const num = parseInt(match[1], 10);
            const unit = match[2] || 'ms';
            const multipliers = { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000, w: 604800000, y: 31536000000 };
            return num * (multipliers[unit] || 1);
        };
    }

    installSubStoreRuntimeGlobals();
}

function setupGlobalsForSubStore(env, userSettings, ctx) {
    // Surge $httpClient
    globalThis.$httpClient = createHttpClient();

    const notificationProxy = createNotificationGateway(userSettings, ctx);

    const environment = {
        'surge-version': userSettings?.surgeVersion || '5.0.0',
        'surge-build': userSettings?.surgeBuild || '2000',
        language: 'zh-Hans',
    };

    return { notification: notificationProxy, environment };
}

async function buildSubStoreRequest(request, subStorePath) {
    const originalUrl = new URL(request.url);
    const rewrittenUrl = new URL(originalUrl);
    rewrittenUrl.pathname = String(subStorePath || '').split('?')[0];

    let body = '';
    if (request.method !== 'GET' && request.method !== 'HEAD') {
        try {
            body = await request.text();
        } catch {
            body = '';
        }
    }

    const headers = {};
    request.headers.forEach((value, key) => {
        headers[key] = value;
    });

    return {
        method: request.method,
        url: rewrittenUrl.href,
        path: subStorePath,
        headers,
        body,
    };
}

function buildResponseFromSubStoreResult(result) {
    if (!result) return new Response('No response', { status: 500 });

    const CORS_HEADERS = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST,GET,OPTIONS,PATCH,PUT,DELETE',
        'Access-Control-Allow-Headers': 'Origin, X-Requested-With, Content-Type, Accept',
    };

    const response = result.response || result;

    let status = 200;
    if (typeof response.status === 'number') status = response.status;
    else if (typeof response.status === 'string') {
        const match = response.status.match(/\d+/);
        status = match ? parseInt(match[0], 10) : 200;
    }

    return new Response(response.body || '', {
        status,
        headers: response.headers || { 'Content-Type': 'text/plain;charset=UTF-8', ...CORS_HEADERS },
    });
}

async function executeSubStoreRequest({ $request, subStoreContext, requestId, timeoutMs, timeoutLabel }) {
    let timeoutId = null;
    return await new Promise((resolve) => {
        subStoreContext.done = (res) => {
            if (timeoutId) clearTimeout(timeoutId);
            subStoreContext.done = null;
            resolve({ result: res, timedOut: false });
        };

        timeoutId = setTimeout(() => {
            warn(`[SubStoreAtom] [${requestId}] ${timeoutLabel}`);
            // 真正的执行生命周期管理，而不是仅提前返回 504：
            // cancel() 置位 aborted、摘掉 done 回调，底层脚本（无法在 JS 层
            // 强杀）的所有副作用出口——存储写入、通知、flush 落盘——全部被
            // 闸掉，超时后不会继续产生数据写入。
            subStoreContext.cancel();
            resolve({
                result: {
                    status: 504,
                    body: JSON.stringify({ status: 'failed', message: 'Gateway Timeout' }),
                    headers: { 'Content-Type': 'application/json' },
                },
                timedOut: true,
            });
        }, timeoutMs);

        initSubStore($request).catch((e) => {
            if (timeoutId) clearTimeout(timeoutId);
            subStoreContext.done = null;
            logError(`[SubStoreAtom] [${requestId}] initSubStore failed:`, e?.stack || e?.message || e);
            resolve({ result: { status: 500, body: 'Internal Server Error' }, timedOut: false });
        });
    });
}

function cleanupSubStoreAttempt(attemptId) {
    deleteSubStoreRequestContext(attemptId);
}

export async function runSubStoreHttpForUser({ user, env, state, request, subStorePath, timeoutMs = 25000 }) {
    const ctx = {
        waitUntil: (p) => {
            if (state?.waitUntil) return state.waitUntil(p);
            return Promise.resolve(p).catch(() => {});
        },
    };
    ensurePolyfills();

    // Install QuickJS script engine hook before Sub-Store handles user scripts.
    // (Upstream user scripts rely on new Function, which is forbidden in Workers.)
    ensureSubStoreQuickJsScriptEngineInstalled();

    const userSettings = parseUserSettings(user);
    const subStoreGlobals = setupGlobalsForSubStore(env, userSettings, ctx);

    // 兼容 open-api 补丁：使用 requestId 标识本次请求的缓存槽位
    const requestId = `${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
    const attemptId = `${requestId}:1`;

    // Surge $utils.geoip/ipasn/ipaso (GeoIP) — load once per isolate, then sync lookups.
    await ensureSurgeGeoipInstalled(env, { requestId: attemptId });

    // 初始化用户专属存储
    let subStoreContext = null;
    const userStorage = (() => {
        const DEFAULT_KEY = '__default__';
        let userData = {};
        try {
            userData = JSON.parse(user?.data || '{}');
        } catch {
            userData = {};
        }
        return {
            read: (key) => {
                const storageKey = key || DEFAULT_KEY;
                const value = userData[storageKey];
                if (value === undefined || value === null) return null;
                if (typeof value === 'object') return JSON.stringify(value);
                return String(value);
            },
            write: (data, key) => {
                const storageKey = key || DEFAULT_KEY;
                userData[storageKey] = data;
                if (subStoreContext) {
                    subStoreContext.dirty = true;
                    subStoreContext.userData = userData;
                }
                if (storageKey === 'sub-store') {
                    debug('[Workers] 检测到备份恢复，标记需要重新初始化');
                    globalThis.__need_reinit__ = true;
                }
                return true;
            },
            getData: () => userData,
        };
    })();

    const cacheData = (() => {
        try {
            return JSON.parse(userStorage.read('sub-store') || '{}');
        } catch {
            return {};
        }
    })();

    // 解析为 Sub-Store 期望的 $request
    const $request = await buildSubStoreRequest(request, subStorePath);
    $request.__requestId = attemptId;
    subStoreContext = createSubStoreRequestContext({
        requestId: attemptId,
        request: $request,
        user,
        env,
        persistentStore: userStorage,
        notification: subStoreGlobals.notification,
        environment: subStoreGlobals.environment,
        cache: cacheData,
    });

    const { result } = await runWithSubStoreContext(subStoreContext, async () => await executeSubStoreRequest({
        $request,
        subStoreContext,
        requestId,
        timeoutMs,
        timeoutLabel: '请求超时',
    }));

    const dataString = flushSubStoreRequestContext(subStoreContext);

    // 持久化（由外部注入 __saveUserData 落库到 User 域存储）
    if (typeof env?.__saveUserData === 'function') {
        const savePromise = Promise.resolve(env.__saveUserData(user?.id, dataString)).finally(() => {
            cleanupSubStoreAttempt(attemptId);
        });
        if (state?.waitUntil) state.waitUntil(savePromise);
        else await savePromise;
    } else {
        cleanupSubStoreAttempt(attemptId);
    }

    return buildResponseFromSubStoreResult(result);
}
