/**
 * L4 - Atom
 * 在 User 域内执行 Sub-Store Cron 请求（每个用户串行）。
 *
 * 说明：
 * - 该 atom 是“Sub-Store 引擎”的运行封装（对本项目来说属于实现细节）。
 * - 为避免混层，已不再依赖 `src/core/substore.js`。
 */

import { createNotificationGateway } from '../../orchestration/diplomat/notificationGateway.js';
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

function buildRefreshRequest() {
    return {
        method: 'GET',
        url: '/api/utils/refresh',
        path: '/api/utils/refresh',
        headers: {},
        body: '',
    };
}

function ensurePolyfills() {
    globalThis.Buffer = Buffer;
    globalThis.__path_shim__ = path;
    globalThis.__stream_promises_shim__ = streamPromises;

    if (!globalThis.process) {
        globalThis.process = {
            env: {},
            version: 'v20.0.0',
            argv: [],
            cwd: () => '/',
        };
    }

    if (!globalThis.__fs_shim__) {
        globalThis.__fs_shim__ = {
            existsSync: () => false,
            readFileSync: () => '',
            writeFileSync: () => {},
            copyFileSync: () => {},
        };
    }

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

function setupGlobalsForSubStore(env, userSettings) {
    globalThis.$httpClient = createHttpClient();

    const notificationProxy = createNotificationGateway(userSettings);

    const environment = {
        'surge-version': userSettings?.surgeVersion || '5.0.0',
        'surge-build': userSettings?.surgeBuild || '2000',
        language: 'zh-Hans',
    };
    return { notification: notificationProxy, environment };
}

export async function runSubStoreCronForUser({ user, env }) {
    ensurePolyfills();

    // Install QuickJS script engine hook before Sub-Store handles user scripts.
    ensureSubStoreQuickJsScriptEngineInstalled();

    const userSettings = parseUserSettings(user);
    const subStoreGlobals = setupGlobalsForSubStore(env, userSettings);

    const requestId = `cron-${user?.id || 'unknown'}-${Date.now()}`;

    // Surge $utils.geoip/ipasn/ipaso (GeoIP)
    await ensureSurgeGeoipInstalled(env, { requestId });

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

    const $request = buildRefreshRequest();
    $request.__requestId = requestId;
    subStoreContext = createSubStoreRequestContext({
        requestId,
        request: $request,
        user,
        env,
        persistentStore: userStorage,
        notification: subStoreGlobals.notification,
        environment: subStoreGlobals.environment,
        cache: cacheData,
    });
    debug(`[SubStoreAtom] [${requestId}] cron refresh`);

    await runWithSubStoreContext(subStoreContext, async () => {
        let timeoutId = null;
        await new Promise((resolve) => {
            subStoreContext.done = () => {
                if (timeoutId) clearTimeout(timeoutId);
                subStoreContext.done = null;
                resolve();
            };
            timeoutId = setTimeout(() => {
                warn(`[SubStoreAtom] [${requestId}] cron 超时`);
                // 取消未完成的执行：置位 aborted、摘掉 done 回调，
                // 超时后底层脚本的存储写入等副作用出口全部被闸掉。
                subStoreContext.cancel();
                resolve();
            }, 60000);

            initSubStore($request).catch((e) => {
                if (timeoutId) clearTimeout(timeoutId);
                subStoreContext.done = null;
                logError(`[SubStoreAtom] [${requestId}] initSubStore failed:`, e?.stack || e?.message || e);
                resolve();
            });
        });
    });

    const dataString = flushSubStoreRequestContext(subStoreContext);

    if (typeof env?.__saveUserData === 'function') {
        await env.__saveUserData(user?.id, dataString);
    }

    deleteSubStoreRequestContext(requestId);
}
