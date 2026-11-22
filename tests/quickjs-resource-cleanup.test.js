/**
 * 问题二回归测试：QuickJS runScriptOnce 的异常/超时路径必须释放 Runtime/Context。
 *
 * 反复触发脚本异常或超时，不能泄漏 WASM Runtime 和 Context。
 * 通过 quickjs-emscripten 的 LeakedHandles / runtime 存活计数验证：
 * 每次 runScriptOnce 结束（无论成功/失败），runtime 必须被 dispose。
 *
 * 验证手段：quickjs-emscripten 的 Runtime 对象在 dispose 后再次调用
 * newContext() 会抛错；用 weak ref + GC 不可靠，改用内存上限重启探测：
 * 每轮跑一个失败脚本，循环 N 次，最后验证模块层 rt 计数（通过
 * runtime.alive 标志）——dispose 后 runtime.alive === false。
 *
 * runScriptOnce 是模块私有函数，通过公开入口
 * ensureSubStoreQuickJsScriptEngineInstalled() 拿到引擎并触发执行。
 *
 * 运行（需 quickjs-emscripten，路径经 QJS_DEPS_DIR 注入）：
 *   QJS_DEPS_DIR=<path> node --import ./tests/hooks/register.mjs --test tests/quickjs-resource-cleanup.test.js
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const QJS_DEPS_DIR = process.env.QJS_DEPS_DIR || '';

// 泄漏探测：包装 QuickJS.newRuntime，记录本进程创建的每个 runtime；
// 全部测试结束后断言每个 runtime 都已 dispose（alive === false）。
// 泄漏 = 有 runtime 永远 alive。
const createdRuntimes = [];

async function setupQuickJsLoader() {
    if (!QJS_DEPS_DIR) {
        throw new Error('QJS_DEPS_DIR not set; install quickjs-emscripten first');
    }
    if (globalThis.__loadQuickJsModule__) return globalThis.__loadQuickJsModule__();

    const pkgDir = path.resolve(QJS_DEPS_DIR);
    assert.ok(existsSync(path.join(pkgDir, 'node_modules', 'quickjs-emscripten')), 'quickjs-emscripten not installed');

    const qjsPath = pathToFileURL(path.join(pkgDir, 'node_modules', 'quickjs-emscripten', 'dist', 'index.mjs')).href;
    const variantPkg = path.join(pkgDir, 'node_modules', '@jitl', 'quickjs-wasmfile-release-sync');
    const variantPath = pathToFileURL(path.join(variantPkg, 'dist', 'index.mjs')).href;

    const mod = await import(qjsPath);
    const variantMod = await import(variantPath);
    const variant = variantMod.default;
    const QuickJS = await mod.newQuickJSWASMModuleFromVariant(variant);

    const origNewRuntime = QuickJS.newRuntime.bind(QuickJS);
    QuickJS.newRuntime = (...args) => {
        const rt = origNewRuntime(...args);
        createdRuntimes.push(rt);
        return rt;
    };

    globalThis.__loadQuickJsModule__ = async () => QuickJS;
    return QuickJS;
}

after(() => {
    assert.ok(createdRuntimes.length >= 15, `应已创建足够多的 runtime 供探测（实际 ${createdRuntimes.length}）`);
    const leaked = createdRuntimes.filter((rt) => rt.alive);
    assert.equal(
        leaked.length,
        0,
        `${leaked.length}/${createdRuntimes.length} 个 QuickJS Runtime 未释放（WASM Runtime 泄漏）`,
    );
});

async function getEngine() {
    const { ensureSubStoreQuickJsScriptEngineInstalled } = await import('../src/adapters/quickjs/substore-script-engine.js');
    ensureSubStoreQuickJsScriptEngineInstalled();
    return globalThis.__substore_workers_createDynamicFunction__;
}

function makeCallContext() {
    return {
        requestId: 'qjs-test',
    };
}

async function makeRunner(script) {
    const create = await getEngine();
    return create({
        name: 'operator',
        script,
        $arguments: {},
        $options: {},
        $substore: { env: {} },
        lodash: {},
        ProxyUtils: {},
        DOMAIN_RESOLVERS: {},
        scriptResourceCache: {},
        flowUtils: {},
        produceArtifact: () => {},
    });
}

test('QuickJS：编译失败反复触发不泄漏 Runtime', async () => {
    await setupQuickJsLoader();
    const runner = await makeRunner('function operator(}}{ bad syntax');

    await assert.rejects(() => runner([], 'target', makeCallContext()), /QuickJS compile failed/);
    await assert.rejects(() => runner([], 'target', makeCallContext()), /QuickJS compile failed/);
    await assert.rejects(() => runner([], 'target', makeCallContext()), /QuickJS compile failed/);
});

test('QuickJS：脚本同步抛异常反复触发不泄漏', async () => {
    await setupQuickJsLoader();
    const runner = await makeRunner('function operator(input) { throw new Error("boom"); }');

    for (let i = 0; i < 5; i++) {
        await assert.rejects(() => runner([], 'target', makeCallContext()), /QuickJS script threw:/);
    }
});

test('QuickJS：promise rejected 反复触发不泄漏', async () => {
    await setupQuickJsLoader();
    const runner = await makeRunner('async function operator(input) { throw new Error("async boom"); }');

    for (let i = 0; i < 5; i++) {
        await assert.rejects(() => runner([], 'target', makeCallContext()), /QuickJS promise rejected:/);
    }
});

test('QuickJS：成功脚本照常返回且 runtime 已释放', async () => {
    await setupQuickJsLoader();
    const runner = await makeRunner('async function operator(input) { return input.map(p => ({ ...p, ok: true })); }');

    const out = await runner([{ name: 'a' }], 'target', makeCallContext());
    assert.deepEqual(out, [{ name: 'a', ok: true }]);
});

test('QuickJS：反复失败后紧跟成功执行，无状态污染（泄漏会导致 VM 分配失败/崩溃）', async () => {
    await setupQuickJsLoader();
    const badRunner = await makeRunner('function operator(}}{ bad syntax');
    for (let i = 0; i < 10; i++) {
        await assert.rejects(() => badRunner([], 'target', makeCallContext()));
    }

    const goodRunner = await makeRunner('async function operator(input) { return { count: (input && input.length) || 0 }; }');
    const out = await goodRunner([1, 2, 3], 'target', makeCallContext());
    assert.deepEqual(out, { count: 3 });
});
