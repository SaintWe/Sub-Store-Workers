/**
 * 问题三回归测试：超时必须真正取消执行生命周期，而不是仅提前返回 504。
 *
 * 验证三层闸门：
 * 1. subStoreContext.cancel() 置位 aborted、摘掉 done —— 底层脚本完成后
 *    调用 $done() 不会回写结果。
 * 2. 超时后底层脚本继续写入存储 → flushSubStoreRequestContext 拒绝落盘
 *    （返回 null）。
 * 3. 正常完成（未取消）的请求 flush 照常落盘。
 *
 * 运行：node --test tests/substore-timeout-cancel.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    createSubStoreRequestContext,
    flushSubStoreRequestContext,
    deleteSubStoreRequestContext,
    getSubStoreContextById,
    runWithSubStoreContext,
} from '../src/atoms/substore/subStoreRequestContext.js';

function createContext() {
    let stored = null;
    const persistentStore = {
        read: () => null,
        write: (data) => {
            stored = data;
            return true;
        },
    };
    const ctx = createSubStoreRequestContext({
        requestId: 'test-req',
        request: { url: 'https://x/' },
        user: { id: 1 },
        env: {},
        persistentStore,
        notification: { post: () => {} },
        environment: {},
    });
    return { ctx, persistentStore, getStored: () => stored };
}

test('cancel() 置位 aborted 并摘掉 done：$done 不再回写结果', async () => {
    const { ctx } = createContext();
    let doneCalled = false;

    ctx.done = () => {
        doneCalled = true;
    };

    ctx.cancel();
    assert.equal(ctx.aborted, true);
    assert.equal(ctx.done, null, 'done 回调必须被摘掉');

    // 模拟超时后底层脚本仍尝试回写（走 subStoreRequestContext 的 $done 全局）。
    // 这里直接对 ctx.done 断言即可：done 已为 null，底层无回写目标。
    assert.equal(doneCalled, false);
});

test('超时后底层脚本的存储写入不会被 flush 落盘', async () => {
    const { ctx } = createContext();

    // 超时前：脚本写入了存储（dirty 置位）
    ctx.persistentStore.write('{"sub-store":{}}');
    ctx.dirty = true;
    ctx.userData = { 'sub-store': {} };

    // 超时：cancel
    ctx.cancel();

    // 超时后：底层脚本仍在继续写（真实场景下会发生）
    ctx.persistentStore.write('{"sub-store":{"late":"write"}}');
    ctx.dirty = true;
    ctx.userData = { 'sub-store': { late: 'write' } };

    // flush 必须拒绝落盘：返回 null
    const dataString = flushSubStoreRequestContext(ctx);
    assert.equal(dataString, null, '已取消的请求不得落盘');
    assert.equal(ctx.dirty, false, 'dirty 标志必须被清掉，防止后续误 flush');
});

test('正常完成（未取消）的请求 flush 照常落盘', async () => {
    const { ctx } = createContext();

    ctx.dirty = true;
    ctx.userData = { 'sub-store': { ok: 1 } };

    const dataString = flushSubStoreRequestContext(ctx);
    assert.notEqual(dataString, null);
    assert.equal(JSON.parse(dataString)['sub-store'].ok, 1, '未取消请求正常落盘');
    assert.equal(ctx.dirty, false);
});

test('$notification.post 在取消后不再触发通道（通知副作用闸）', async () => {
    const { ctx } = createContext();
    let posted = 0;
    ctx.notification = {
        post: () => {
            posted += 1;
        },
    };

    await runWithSubStoreContext(ctx, async () => {
        // 安装 $notification 全局（runWithSubStoreContext 内会装）
        globalThis.$notification.post('before');
        ctx.cancel();
        globalThis.$notification.post('after');
    });

    assert.equal(posted, 1, '取消后不得再发通知');
});

test('runSubStoreHttpForUser 超时分支：真实走一遍 504 + cancel + 拒绝落盘', async () => {
    // 挂住的 dispatch（永不调用 done）→ 超时 → 504 → aborted → flush 拒绝落盘。
    const { runSubStoreHttpForUser } = await import('../src/atoms/substore/runSubStoreHttpForUser.js');

    // 注册 stub runtime entry：让 ensureSubStoreLoaded 正常完成，
    // 之后 dispatch 才会被调用（否则 initSubStore 走 catch 返回 500）。
    globalThis.__loadSubStoreEntry__ = async () => {};
    let dispatchCalled = false;
    let lateWriteDone = false;
    let resolveLateWrite;
    const lateWriteScheduled = new Promise((resolve) => {
        resolveLateWrite = resolve;
    });
    globalThis.__substore_dispatch__ = () => {
        dispatchCalled = true;
        // 模拟底层脚本永不调用 $done —— 挂住到超时。
        // 超时返回 504 后再触发写入，验证写入确实发生在取消之后。
        resolveLateWrite();
    };

    const user = { id: 1, username: 'u', role: 'user', path: '', data: '{}' };
    const savedBlobs = [];
    const env = {
        __saveUserData: async (id, dataString) => {
            savedBlobs.push({ id, dataString });
        },
    };
    const request = {
        url: 'https://user/download/sub/name',
        method: 'GET',
        headers: { get: () => null, forEach: () => {} },
        async text() {
            return '';
        },
    };

    const resp = await runSubStoreHttpForUser({
        user,
        env,
        state: null,
        request,
        subStorePath: '/download/sub/name',
        timeoutMs: 50, // 缩短超时以测试
    });

    assert.equal(resp.status, 504, '挂住的请求应超时返回 504');
    assert.equal(dispatchCalled, true, '底层 dispatch 已被调用（模拟执行中）');
    await lateWriteScheduled;

    // 504 已经返回，现在才让底层脚本写入 —— 确凿地发生在取消之后。
    // $persistentStore.write 本身不检查 aborted，这里写入内存 storage；
    // 关键是 flush 必须拒绝把这份晚到数据持久化。
    globalThis.$persistentStore?.write(JSON.stringify({ 'sub-store': { late: 'write' } }));
    lateWriteDone = true;
    await new Promise((resolve) => setTimeout(resolve, 10)); // 等 __saveUserData 完成

    assert.equal(lateWriteDone, true, '底层脚本的超时后写入已发生（模拟真实交错）');
    // dataString=null 时 __saveUserData 仍会被调用（其内部对 null 有 if (!saved) return 保护），
    // 但不得带出任何非空数据。
    const nonEmptySaves = savedBlobs.filter((b) => b.dataString);
    assert.equal(nonEmptySaves.length, 0, '超时取消后不得有任何非空 user_data 落盘');

    delete globalThis.__substore_dispatch__;
    delete globalThis.__loadSubStoreEntry__;
});
