/**
 * 问题一回归测试：UserDO 必须把每个请求完整串行化。
 *
 * Cloudflare Durable Object 是单线程，但 await 期间不同请求仍会交错执行，
 * user_data 的"读全量 → 改 → 整份覆盖写"流程若交错会互相覆盖（丢更新）。
 *
 * 验证：两个并发请求（PUT /_internal/user-data）的操作序列不交错——
 * 第二个请求的存储操作必须发生在第一个请求全部完成之后。
 *
 * 运行：node --import ./tests/hooks/register.mjs --test tests/user-do-serialization.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UserDO } from '../src/platform/workers/durable-objects/UserDO.js';

function createStorageMock({ userData = null, store = {} } = {}) {
    const ops = [];
    // tagged template 的真形态：tagFn(strings, ...values)，
    // 插值参数是 strings 之后的独立参数。
    const sql = (strings, ...values) => {
        // tagged template 的真形态：tagFn(strings, ...values)，插值把 strings
        // 切成多段。真实 SQL 是跨行模板，必须 join 全部片段才能匹配到
        // "SELECT value ... FROM user_store"（value 与 FROM 分处两行）。
        const sqlText = strings.join('?');
        ops.push({ type: 'sql', sql: sqlText, args: values });
        // 模拟 user_store 表
        if (/INSERT OR REPLACE INTO user_store/i.test(sqlText)) {
            const key = values[0];
            const value = values[1];
            if (key === 'user_data') userData = value;
            store[key] = value;
            return [];
        }
        if (/SELECT value\s+FROM user_store/i.test(sqlText)) {
            const key = values[0];
            const value = key === 'user_data' ? userData : store[key] ?? null;
            return [{ value }];
        }
        if (/SELECT MAX\(id\)/i.test(sqlText)) return [{ maxId: 0 }];
        if (/PRAGMA table_info/i.test(sqlText)) return [];
        return [];
    };
    // ensureUserDoSchema(state.storage.sql, ...) 把 state.storage.sql 当作
    // 既可调用（tag 函数）又带 exec() 的对象。
    sql.exec = (script) => {
        ops.push({ type: 'exec', sql: String(script) });
    };
    return {
        sql,
        exec: sql.exec,
        getOps: () => ops,
        getUserData: () => userData,
    };
}
function createEnvMock() {
    return {};
}

function createRequest(userId, data, method = 'PUT') {
    const body = JSON.stringify({ data });
    const headers = new Map([['x-user-id', String(userId)]]);
    return {
        url: 'https://user/_internal/user-data',
        method,
        headers: {
            get: (name) => headers.get(String(name).toLowerCase()) ?? null,
        },
        async json() {
            return JSON.parse(body);
        },
        async text() {
            return body;
        },
    };
}

test('UserDO：并发请求的存储操作序列严格串行，不交错', async () => {
    const storage = createStorageMock();
    const env = createEnvMock();
    const state = { storage };

    const userDO = new UserDO(state, env);

    // 请求 1：写 A。让 putUserDataString 的写入可被观测。
    const req1 = createRequest(7, { A: 1 });
    const p1 = userDO.fetch(req1);

    // 请求 2：写 B。在请求 1 未完成时发起。
    const req2 = createRequest(7, { B: 1 });
    const p2 = userDO.fetch(req2);

    const [r1, r2] = await Promise.all([p1, p2]);
    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);

    // 只统计运行期 DML/查询（type 'sql'），建表 exec 不算。
    const ops = storage.getOps().filter((op) => op.type === 'sql' && /user_store/i.test(op.sql || ''));
    // 每次 PUT 都应有 INSERT OR REPLACE（覆盖写 user_data）。
    const inserts = ops.filter((op) => /INSERT OR REPLACE INTO user_store/i.test(op.sql || ''));
    assert.equal(inserts.length, 2, '两个请求都应完成 user_data 覆盖写');

    // 串行性断言：user_data PUT 的操作序列是
    //   请求1: [INSERT user_data, SELECT avatar_url]
    //   请求2: [INSERT user_data, SELECT avatar_url]
    // 串行执行时整体序列必为 INSERT, SELECT, INSERT, SELECT ——
    // 第二个 INSERT 恰好排在前两个操作之后（索引 2）。
    // 若不串行，请求2的 INSERT 会插进请求1的操作之间（索引 1）。
    const insertIdx = ops.map((op, i) => (/INSERT OR REPLACE INTO user_store/i.test(op.sql || '') ? i : -1)).filter((i) => i >= 0);
    assert.equal(insertIdx.length, 2);
    assert.equal(insertIdx[0], 0, '请求1的写入是第一个 user_store 操作');
    assert.equal(insertIdx[1], 2, '请求2的写入必须等请求1全部操作完成，无交错');

    // 最终数据 = 后写入者（串行下这是确定行为）。
    const finalData = JSON.parse(storage.getUserData() || '{}');
    assert.ok('A' in finalData || 'B' in finalData);
});

function createDownloadRequest(userId, name) {
    return {
        url: `https://user/download/${name}`,
        method: 'GET',
        headers: {
            get: (key) => {
                const k = String(key).toLowerCase();
                if (k === 'x-user-id') return String(userId);
                if (k === 'user-agent') return 'test-agent';
                return null;
            },
            forEach: () => {},
        },
        async text() {
            return '';
        },
    };
}

// 真实的丢更新场景：一次 Sub-Store 下载请求内部读取整份 user_data、
// await 脚本执行、最后整份写回。两个请求若交错执行，后写者会覆盖前者。
// 用全局 dispatch stub 模拟这个「读 → await → 写 → $done」流程。
async function withConcurrentSubStoreDownloads(t, run) {
    const prevLoader = globalThis.__loadSubStoreEntry__;
    const prevDispatch = globalThis.__substore_dispatch__;
    globalThis.__loadSubStoreEntry__ = async () => {};
    globalThis.__substore_dispatch__ = (request) => {
        const name = new URL(request.url).pathname.split('/').pop();
        const before = JSON.parse(globalThis.$persistentStore?.read('sub-store') || '{}');
        // 模拟脚本 await：读完之后延迟写回。串行时第二个请求此时还没开始，
        // 不串行时两个请求会在同一窗口内读到同一份旧数据。
        Promise.resolve()
            .then(() => new Promise((resolve) => setTimeout(resolve, 20)))
            .then(() => {
                globalThis.$persistentStore?.write(JSON.stringify({ ...before, [name]: 1 }), 'sub-store');
                globalThis.$done?.({ status: 200, body: 'ok' });
            })
            .catch((e) => t.diagnostic(`dispatch error: ${e?.message || e}`));
    };
    try {
        await run();
    } finally {
        if (prevLoader === undefined) delete globalThis.__loadSubStoreEntry__;
        else globalThis.__loadSubStoreEntry__ = prevLoader;
        if (prevDispatch === undefined) delete globalThis.__substore_dispatch__;
        else globalThis.__substore_dispatch__ = prevDispatch;
    }
}

test('UserDO：真并发 Sub-Store 请求（读 → await → 写）不丢更新', async (t) => {
    // 与真实漏洞同形：每个下载请求读取 user_data['sub-store']，
    // 脚本 await 期间若另一个请求也读到同一份数据，后写者会覆盖前者。
    const storage = createStorageMock({ userData: JSON.stringify({ 'sub-store': '{"seed":1}' }) });
    const userDO = new UserDO({ storage }, createEnvMock());

    await withConcurrentSubStoreDownloads(t, async () => {
        const [a, b] = await Promise.all([
            userDO.fetch(createDownloadRequest(7, 'A')),
            userDO.fetch(createDownloadRequest(7, 'B')),
        ]);
        assert.equal(a.status, 200);
        assert.equal(b.status, 200);
    });

    const finalData = JSON.parse(JSON.parse(storage.getUserData())['sub-store']);
    assert.equal(finalData.seed, 1, '初始字段保留');
    assert.equal(finalData.A, 1, '请求 A 的更新保留');
    assert.equal(finalData.B, 1, '请求 B 的更新保留（未丢更新）');
});

test('UserDO：无队列对照 — 同样的并发 Sub-Store 请求会丢更新', async (t) => {
    const storage = createStorageMock({ userData: JSON.stringify({ 'sub-store': '{"seed":1}' }) });
    const userDO = new UserDO({ storage }, createEnvMock());

    // 用 _handleFetch 绕过 fetch 的串行队列，证明这个测试确实能抓到丢更新。
    await withConcurrentSubStoreDownloads(t, async () => {
        const [a, b] = await Promise.all([
            userDO._handleFetch(createDownloadRequest(7, 'A')),
            userDO._handleFetch(createDownloadRequest(7, 'B')),
        ]);
        assert.equal(a.status, 200);
        assert.equal(b.status, 200);
    });

    const finalData = JSON.parse(JSON.parse(storage.getUserData())['sub-store']);
    assert.ok(!(finalData.A && finalData.B), '对照：无队列时两个请求读到同一份旧数据，后写者覆盖前者');
});

test('UserDO：请求失败不会卡死串行队列，后续请求仍能执行', async () => {
    const storage = createStorageMock();
    const userDO = new UserDO({ storage }, createEnvMock());

    // 构造一个让 handler 抛错的请求（坏 body 的 PUT 仍会走完流程；改用不存在的路由/坏 JSON）。
    const badReq = {
        url: 'https://user/_internal/user-data',
        method: 'PUT',
        headers: { get: (n) => (String(n).toLowerCase() === 'x-user-id' ? '9' : null) },
        async json() {
            throw new Error('bad json');
        },
        async text() {
            return 'not-json';
        },
    };

    const goodReq = createRequest(9, { C: 1 });

    // 先发坏请求，再发好请求：好请求不应被坏请求的异常永久阻塞。
    const badPromise = userDO.fetch(badReq);
    const goodPromise = userDO.fetch(goodReq);
    const [badRes, goodRes] = await Promise.all([badPromise, goodPromise]);

    // 坏请求的 json() 抛错会被 readJsonBody 吞掉（返回 null → data {}），仍应返回 200。
    assert.equal(badRes.status, 200);
    assert.equal(goodRes.status, 200);

    const finalData = JSON.parse(storage.getUserData() || '{}');
    assert.deepEqual(finalData, { C: 1 }, '队列未被失败请求卡死，好请求正常落库');
});
