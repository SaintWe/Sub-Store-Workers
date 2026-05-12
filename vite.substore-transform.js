import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const SUB_STORE_PATH = path.join(__dirname, 'sub-store/backend');
export const FASTEST_TEXT_ENCODER_DECODER_PATH = path.join(
    SUB_STORE_PATH,
    'node_modules/fastestsmallesttextencoderdecoder/NodeJS/EncoderAndDecoderNodeJS.min.mjs',
);

export function subStoreTransformPlugin() {
    let expressPatchApplied = 0;
    let expressFileSeen = false;
    let openApiPatchApplied = 0;
    let openApiFileSeen = false;
    let downloadPatchApplied = 0;
    let downloadFileSeen = false;
    let processorsPatchApplied = 0;
    let processorsFileSeen = false;
    let openApiDebugPatchApplied = 0;
    let openApiDebugFileSeen = false;
    let rsPatchApplied = 0;
    let rsFileSeen = false;
    let subStoreFileSeen = false;

    const requiredTargetFiles = [
        ['express.js', () => expressFileSeen, () => expressPatchApplied],
        ['open-api.js', () => openApiFileSeen, () => openApiPatchApplied],
        ['download.js', () => downloadFileSeen, () => downloadPatchApplied],
        ['processors/index.js', () => processorsFileSeen, () => processorsPatchApplied],
        ['core/app.js', () => openApiDebugFileSeen, () => openApiDebugPatchApplied],
        ['utils/rs.js', () => rsFileSeen, () => rsPatchApplied],
    ];

    const dangerousRequireNames = [
        'dotenv',
        'fs',
        'path',
        'undici',
        'fetch-socks',
        'express',
        'body-parser',
        'cron',
        'child_process',
        'connect-history-api-fallback',
        'http-proxy-middleware',
        'mime-types',
        'ms',
        'nanoid',
        '@maxmind/geoip2-node',
        'stream/promises',
    ];
    const dangerousRequirePatterns = dangerousRequireNames.flatMap((name) => {
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\//g, '\\/');
        return [
            new RegExp(`eval\\s*\\(\\s*['\"\`]require\\s*\\(\\s*['\"\`]${escaped}['\"\`]\\s*\\)['\"\`]\\s*,?\\s*\\)`),
            new RegExp(`(?<!['\"\`])\\brequire\\s*\\(\\s*['\"\`]${escaped}['\"\`]\\s*\\)`),
        ];
    });

    function replaceEvalRequire(contents, moduleName, replacement) {
        const escaped = moduleName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\//g, '\\/');
        return contents.replace(
            new RegExp(`eval\\s*\\(\\s*['\"\`]require\\s*\\(\\s*['\"\`]${escaped}['\"\`]\\s*\\)['\"\`]\\s*,?\\s*\\)`, 'g'),
            replacement,
        );
    }

    function assertNoDangerousRequireResidue(contents, id, pluginContext) {
        const matched = dangerousRequirePatterns.find((pattern) => pattern.test(contents));
        if (matched) {
            pluginContext.error(`[sub-store-transform] ${id} 仍包含未替换的危险 require/eval: ${matched}`);
        }
    }

    return {
        name: 'sub-store-transform',
        enforce: 'pre',
        transform(code, id) {
            if (!id.includes('sub-store/backend/src')) {
                return null;
            }
            subStoreFileSeen = true;

            let contents = code;

            contents = replaceEvalRequire(contents, 'dotenv', '({ config: () => {} })');
            contents = replaceEvalRequire(contents, 'fs', 'globalThis.__fs_shim__');
            contents = replaceEvalRequire(contents, 'path', 'globalThis.__path_shim__');
            contents = replaceEvalRequire(contents, 'undici', '({ request: globalThis.fetch, Agent: class {}, ProxyAgent: class {}, EnvHttpProxyAgent: class {} })');
            contents = replaceEvalRequire(contents, 'fetch-socks', '({ socksDispatcher: () => null })');
            contents = replaceEvalRequire(contents, 'express', 'null');
            contents = replaceEvalRequire(contents, 'body-parser', '({ json: () => (req, res, next) => next(), urlencoded: () => (req, res, next) => next(), raw: () => (req, res, next) => next() })');
            contents = replaceEvalRequire(contents, 'cron', '({ CronJob: class { constructor() {} } })');
            contents = replaceEvalRequire(contents, 'child_process', '({ execFile: () => {} })');
            contents = replaceEvalRequire(contents, 'connect-history-api-fallback', '(() => (req, res, next) => next())');
            contents = replaceEvalRequire(contents, 'http-proxy-middleware', '({ createProxyMiddleware: () => (req, res, next) => next() })');
            contents = replaceEvalRequire(contents, 'mime-types', '({ contentType: () => "text/plain" })');
            contents = replaceEvalRequire(contents, 'ms', 'globalThis.__ms_shim__');
            contents = replaceEvalRequire(contents, 'nanoid', '({ nanoid: (size = 21) => crypto.randomUUID().replace(/-/g, "").slice(0, size) })');
            contents = replaceEvalRequire(contents, '@maxmind/geoip2-node', '({ Reader: { openBuffer: () => ({ country: () => null, asn: () => null }) } })');
            contents = replaceEvalRequire(contents, 'stream/promises', 'globalThis.__stream_promises_shim__');

            contents = contents.replace(/const\s+isNode\s*=\s*eval\s*\(\s*`typeof\s+process\s*!==\s*"undefined"`\s*\)/g, 'const isNode = false');
            contents = contents.replace(/const\s+isSurge\s*=\s*typeof\s+\$httpClient\s*!==\s*['"]undefined['"]\s*&&\s*!isLoon\s*;/g, 'const isSurge = true;');

            assertNoDangerousRequireResidue(contents, id, this);

            if (id.includes('vendor/express.js')) {
                expressFileSeen = true;
                const before = contents;
                if (!contents.includes('__SUB_STORE_WORKERS_PATCH__REQUEST_DONE_DISPATCH__')) {
                    contents = contents.replace(
                        'const handlers = [];',
                        `// __SUB_STORE_WORKERS_PATCH__REQUEST_DONE_DISPATCH__
const handlers = [];

function __emitDone__(requestId, response) {
    const activeContext = globalThis.__substore_get_active_context__?.();
    if (activeContext && (!requestId || activeContext.requestId === requestId) && typeof activeContext.done === 'function') {
        activeContext.done(response);
        return;
    }
    const context = requestId ? globalThis.__substore_get_context_by_id__?.(requestId) : null;
    if (context && typeof context.done === 'function') {
        context.done(response);
        return;
    }
    if (typeof globalThis.$done === 'function') {
        globalThis.$done(response);
    }
}`,
                    );
                    contents = contents.replace(
                        'const req = {',
                        `const req = {
                __requestId: request.__requestId,`,
                    );
                    contents = contents.replace(
                        'const res = Response();',
                        'const res = Response(req.__requestId);',
                    );
                    contents = contents.replace(
                        /dispatch\s*\(\s*method\s*,\s*url\s*,\s*i\s*\)\s*;/g,
                        'dispatch(request, i + 1);',
                    );
                    contents = contents.replace(
                        'function Response() {',
                        'function Response(requestId) {',
                    );
                    contents = contents.replace(
                        '$done(response);',
                        '__emitDone__(requestId, response);',
                    );
                    contents = contents.replace(
                        `$done({
                        response,
                    });`,
                        `__emitDone__(requestId, {
                        response,
                    });`,
                    );
                }
                contents = contents.replace(
                    /app\.start\s*=\s*\(\)\s*=>\s*\{\s*dispatch\s*\(\s*\$request\s*\)\s*;\s*\}/g,
                    `app.start = () => {
                        // __SUB_STORE_WORKERS_PATCH__DISPATCH_EXPORT__
                        globalThis.__substore_dispatch__ = dispatch;
                    }`,
                );
                if (contents !== before) {
                    expressPatchApplied += 1;
                    if (!contents.includes('__SUB_STORE_WORKERS_PATCH__DISPATCH_EXPORT__')) {
                        this.error('[sub-store-transform] express.js 补丁自检失败：缺少 marker');
                    }
                    if (!contents.includes('__SUB_STORE_WORKERS_PATCH__REQUEST_DONE_DISPATCH__')) {
                        this.error('[sub-store-transform] express.js 请求级 done 补丁自检失败：缺少 marker');
                    }
                    if (!contents.includes('dispatch(request, i + 1);')) {
                        this.error('[sub-store-transform] express.js next() 补丁自检失败：仍可能把 method/url 当作 request 重新分发');
                    }
                } else {
                    this.error('[sub-store-transform] express.js 补丁未应用：未命中 app.start/dispatch($request) 片段');
                }
            }

            if (id.includes('vendor/open-api.js')) {
                openApiFileSeen = true;
                const beforeOpenApi = contents;

                const needsIsNodePatch = beforeOpenApi.includes('const isNode = eval(`typeof process');
                if (needsIsNodePatch && !contents.includes('const isNode = false')) {
                    this.error('[sub-store-transform] open-api.js 环境检测补丁未生效：isNode 仍可能触发 eval()');
                }
                const needsIsSurgePatch = beforeOpenApi.includes('const isSurge = typeof $httpClient');
                if (needsIsSurgePatch && !contents.includes('const isSurge = true;')) {
                    this.error('[sub-store-transform] open-api.js 环境检测补丁未生效：isSurge 未被固定为 true');
                }

                if (contents.includes('export class OpenAPI')) {
                    contents = contents.replace(
                        'export class OpenAPI',
                        `// 获取当前请求的缓存（请求级隔离）
// __SUB_STORE_WORKERS_PATCH__REQUEST_CACHE_ISOLATION__
function __getRequestCache__() {
    const context = globalThis.__substore_get_active_context__?.();
    if (!context) return {};
    if (!context.cache) context.cache = {};
    return context.cache;
}

function __setRequestCache__(key, value) {
    const context = globalThis.__substore_get_active_context__?.();
    if (!context) return;
    const cache = context.cache || (context.cache = {});
    cache[key] = value;
}

export class OpenAPI`,
                    );
                } else {
                    this.error('[sub-store-transform] open-api.js 补丁未应用：未找到 export class OpenAPI');
                }

                contents = contents.replace(/this\.cache\s*=\s*JSON\.parse\s*\(\s*\$persistentStore\.read\s*\(\s*this\.name\s*\)\s*\|\|\s*'{}'\s*\)/g, 'this.cache = __getRequestCache__()');
                contents = contents.replace(/const\s+data\s*=\s*JSON\.stringify\s*\(\s*this\.cache\s*,\s*null\s*,\s*2\s*\)/g, 'const data = JSON.stringify(__getRequestCache__(), null, 2)');
                contents = contents.replace(/this\.cache\[key\]\s*=\s*data;/g, '__setRequestCache__(key, data);');
                contents = contents.replace(/return\s+this\.cache\[key\];/g, 'return __getRequestCache__()[key];');
                contents = contents.replace(/delete\s+this\.cache\[key\];/g, 'const __cache__ = __getRequestCache__(); delete __cache__[key];');

                if (contents !== beforeOpenApi) openApiPatchApplied += 1;

                const requiredMarkers = [
                    '__SUB_STORE_WORKERS_PATCH__REQUEST_CACHE_ISOLATION__',
                    'this.cache = __getRequestCache__()',
                    'const data = JSON.stringify(__getRequestCache__(), null, 2)',
                    '__setRequestCache__(key, data);',
                    'return __getRequestCache__()[key];',
                    'const __cache__ = __getRequestCache__(); delete __cache__[key];',
                ];
                const missing = requiredMarkers.filter((m) => !contents.includes(m));
                if (missing.length > 0) {
                    this.error(`[sub-store-transform] open-api.js 补丁自检失败：缺少片段: ${missing.join(', ')}`);
                }
            }

            if (id.includes('sub-store/backend/src/utils/download.js')) {
                downloadFileSeen = true;
                if (!contents.includes('__SUB_STORE_WORKERS_PATCH__INFLIGHT_TASKS__')) {
                    const startMarker = 'export default async function download';
                    const endMarker = 'export async function downloadFile';
                    if (!contents.includes('const tasks = new Map();')) {
                        this.error('[sub-store-transform] download.js 结构已变化，补丁未应用：缺少 tasks 定义');
                    }
                    contents = contents.replace('const tasks = new Map();', `// __SUB_STORE_WORKERS_PATCH__INFLIGHT_TASKS__
const tasks = {
    has: () => false,
    get: () => undefined,
    set: () => {},
    delete: () => {},
};`);
                    const startIdx = contents.indexOf(startMarker);
                    const endIdx = contents.indexOf(endMarker);
                    if (startIdx === -1 || endIdx === -1 || startIdx >= endIdx) {
                        this.error(`[sub-store-transform] 无法定位 download() 的边界，补丁未应用：${id}`);
                    }
                    const before = contents.slice(0, startIdx);
                    const chunk = contents.slice(startIdx, endIdx);
                    const after = contents.slice(endIdx);
                    const requiredNeedles = ['tasks.has(id)', 'tasks.set(id, result)', 'const id = hex_md5('];
                    const missing = requiredNeedles.filter((n) => !chunk.includes(n));
                    if (missing.length > 0) {
                        this.error(`[sub-store-transform] download.js 结构已变化，补丁未应用：缺少关键片段: ${missing.join(', ')}`);
                    }
                    let patchedChunk = chunk.replace(startMarker, 'async function __download_impl__');
                    const wrapper = `export default async function download(
    rawUrl = '',
    ua,
    timeout,
    customProxy,
    skipCustomCache,
    awaitCustomCache,
    noCache,
    preprocess,
) {
    let $arguments = {};
    try {
        let url = String(rawUrl).replace(/#noFlow$/, '');
        const rawArgs = url.split('#');
        url = url.split('#')[0];
        if (rawArgs.length > 1) {
            try {
                $arguments = JSON.parse(decodeURIComponent(rawArgs[1]));
            } catch (e) {
                for (const pair of rawArgs[1].split('&')) {
                    const key = pair.split('=')[0];
                    const value = pair.split('=')[1];
                    $arguments[key] = value == null || value === '' ? true : decodeURIComponent(value);
                }
            }
        }
    } catch (e) {
        $arguments = {};
    }

    if (noCache || ($arguments && $arguments.noCache)) {
        return await __download_impl__(rawUrl, ua, timeout, customProxy, skipCustomCache, awaitCustomCache, noCache, preprocess);
    }

    const context = globalThis.__substore_get_active_context__?.();
    const scope = context?.user?.id ?? context?.requestId ?? '';
    const inflightKey = String(scope) + '::' + String(ua || '') + '::' + String(rawUrl) + '::' + (preprocess ? '1' : '0');
    if (!globalThis.__sub_store_workers_inflight_tasks__) {
        globalThis.__sub_store_workers_inflight_tasks__ = new Map();
    }
    if (globalThis.__sub_store_workers_inflight_tasks__.has(inflightKey)) {
        return await globalThis.__sub_store_workers_inflight_tasks__.get(inflightKey);
    }
    const p = (async () => {
        try {
            return await __download_impl__(rawUrl, ua, timeout, customProxy, skipCustomCache, awaitCustomCache, noCache, preprocess);
        } finally {
            globalThis.__sub_store_workers_inflight_tasks__.delete(inflightKey);
        }
    })();
    globalThis.__sub_store_workers_inflight_tasks__.set(inflightKey, p);
    return await p;
}
`;
                    patchedChunk = wrapper + '\n' + patchedChunk;
                    if (!patchedChunk.includes('export default async function download(')) {
                        this.error('[sub-store-transform] download.js 补丁自检失败：wrapper 未注入');
                    }
                    downloadPatchApplied += 1;
                    contents = before + patchedChunk + after;
                    if (!contents.includes('__SUB_STORE_WORKERS_PATCH__INFLIGHT_TASKS__')) {
                        this.error('[sub-store-transform] download.js 补丁自检失败：缺少 marker');
                    }
                }
            }

            if (id.includes('sub-store/backend/src/core/proxy-utils/processors/index.js')) {
                processorsFileSeen = true;
                if (!contents.includes('__SUB_STORE_WORKERS_PATCH__QUICKJS_CREATE_DYNAMIC_FUNCTION__')) {
                    const startMarker = 'function createDynamicFunction(name, script, $arguments, $options) {';
                    const startIdx = contents.indexOf(startMarker);
                    if (startIdx === -1) {
                        this.error('[sub-store-transform] processors/index.js 补丁未应用：未找到 createDynamicFunction 定义');
                    }
                    const before = contents.slice(0, startIdx);
                    const patched = `function createDynamicFunction(name, script, $arguments, $options) {
    // __SUB_STORE_WORKERS_PATCH__QUICKJS_CREATE_DYNAMIC_FUNCTION__
    const flowUtils = {
        getFlowField,
        getFlowHeaders,
        parseFlowHeaders,
        flowTransfer,
        validCheck,
        getRmainingDays,
        normalizeFlowHeader,
    };

    const factory = globalThis.__substore_workers_createDynamicFunction__;
    if (typeof factory !== 'function') {
        throw new Error('[Sub-Store Workers] QuickJS script engine not installed');
    }

    return factory({
        name,
        script,
        $arguments,
        $options,
        $substore: $,
        lodash,
        ProxyUtils,
        scriptResourceCache,
        flowUtils,
        produceArtifact,
    });
}
`;
                    processorsPatchApplied += 1;
                    contents = before + patched;
                    if (!contents.includes('__SUB_STORE_WORKERS_PATCH__QUICKJS_CREATE_DYNAMIC_FUNCTION__')) {
                        this.error('[sub-store-transform] processors/index.js 补丁自检失败：缺少 marker');
                    }
                }
            }

            if (id.includes('sub-store/backend/src/core/app.js')) {
                openApiDebugFileSeen = true;
                if (!contents.includes('__SUB_STORE_WORKERS_PATCH__OPENAPI_DEBUG__')) {
                    const beforeApp = contents;
                    contents = contents.replace(
                        "const $ = new OpenAPI('sub-store');",
                        "const $ = new OpenAPI('sub-store', (process.env.DEBUG === 'true' || process.env.DEBUG === true)); /* __SUB_STORE_WORKERS_PATCH__OPENAPI_DEBUG__ */",
                    );
                    if (contents !== beforeApp) {
                        openApiDebugPatchApplied += 1;
                    } else {
                        this.error('[sub-store-transform] core/app.js debug 补丁未应用：未命中 OpenAPI 初始化行');
                    }
                }
            }

            if (id.includes('sub-store/backend/src/utils/rs.js')) {
                rsFileSeen = true;
                contents = `// __SUB_STORE_WORKERS_PATCH__JSRSASIGN_FREE_SHA256_FINGERPRINT__
function pemToBytes(pem) {
    const b64 = String(pem || '')
        .replace(/-----BEGIN[^-]+-----/g, '')
        .replace(/-----END[^-]+-----/g, '')
        .replace(/\\s+/g, '');
    const bin = typeof atob === 'function'
        ? atob(b64)
        : globalThis.Buffer.from(b64, 'base64').toString('binary');
    const bytes = new Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i) & 0xff;
    return bytes;
}

function rightRotate(value, amount) {
    return (value >>> amount) | (value << (32 - amount));
}

function sha256Hex(bytes) {
    const k = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
        0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
        0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
    ];
    const h = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
        0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ];
    const msg = bytes.slice();
    const bitLength = msg.length * 8;
    msg.push(0x80);
    while ((msg.length % 64) !== 56) msg.push(0);
    const high = Math.floor(bitLength / 0x100000000);
    const low = bitLength >>> 0;
    msg.push((high >>> 24) & 0xff, (high >>> 16) & 0xff, (high >>> 8) & 0xff, high & 0xff);
    msg.push((low >>> 24) & 0xff, (low >>> 16) & 0xff, (low >>> 8) & 0xff, low & 0xff);

    const w = new Array(64);
    for (let offset = 0; offset < msg.length; offset += 64) {
        for (let i = 0; i < 16; i += 1) {
            const j = offset + i * 4;
            w[i] = ((msg[j] << 24) | (msg[j + 1] << 16) | (msg[j + 2] << 8) | msg[j + 3]) >>> 0;
        }
        for (let i = 16; i < 64; i += 1) {
            const s0 = rightRotate(w[i - 15], 7) ^ rightRotate(w[i - 15], 18) ^ (w[i - 15] >>> 3);
            const s1 = rightRotate(w[i - 2], 17) ^ rightRotate(w[i - 2], 19) ^ (w[i - 2] >>> 10);
            w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
        }
        let [a, b, c, d, e, f, g, hh] = h;
        for (let i = 0; i < 64; i += 1) {
            const s1 = rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25);
            const ch = (e & f) ^ (~e & g);
            const temp1 = (hh + s1 + ch + k[i] + w[i]) >>> 0;
            const s0 = rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22);
            const maj = (a & b) ^ (a & c) ^ (b & c);
            const temp2 = (s0 + maj) >>> 0;
            hh = g;
            g = f;
            f = e;
            e = (d + temp1) >>> 0;
            d = c;
            c = b;
            b = a;
            a = (temp1 + temp2) >>> 0;
        }
        h[0] = (h[0] + a) >>> 0;
        h[1] = (h[1] + b) >>> 0;
        h[2] = (h[2] + c) >>> 0;
        h[3] = (h[3] + d) >>> 0;
        h[4] = (h[4] + e) >>> 0;
        h[5] = (h[5] + f) >>> 0;
        h[6] = (h[6] + g) >>> 0;
        h[7] = (h[7] + hh) >>> 0;
    }
    return h.map((n) => n.toString(16).padStart(8, '0')).join('');
}

export function generateFingerprint(caStr) {
    const hex = sha256Hex(pemToBytes(caStr));
    return hex.match(/.{2}/g).join(':').toUpperCase();
}

export default {
    generateFingerprint,
};
`;
                rsPatchApplied += 1;
            }

            if (contents !== code) {
                return { code: contents, map: null };
            }
            return null;
        },

        buildEnd() {
            if (!subStoreFileSeen) return;
            for (const [name, seen] of requiredTargetFiles) {
                if (!seen()) this.error(`[sub-store-transform] 必需补丁目标未进入构建图：${name}`);
            }
            for (const [name, _seen, applied] of requiredTargetFiles) {
                const count = applied();
                if (count !== 1) this.error(`[sub-store-transform] ${name} 补丁未正确应用：期望 1 次，实际 ${count} 次`);
            }
        },
    };
}
