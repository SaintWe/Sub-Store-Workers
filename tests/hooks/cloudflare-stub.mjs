/**
 * Node ESM loader hooks：为 UserDO 测试提供 cloudflare:workers /
 * @cloudflare/actors/storage 的最小 stub，使 Durable Object 类能在
 * 纯 Node 环境下被导入和实例化。
 */

const workersStubSource = `
export class DurableObject {
    constructor(state, env) {
        this.state = state;
        this.env = env;
    }
}
`;

const storageStubSource = `
export class Storage {
    constructor(storage) {
        this._raw = storage;
    }
    get sql() {
        return this._raw.sql;
    }
}
`;

// mmdb-lib 仅在运行期打开 .mmdb 文件时才真正被用；测试环境不打 IP 库，
// 给一个空实现让静态导入链能加载。
const mmdbStubSource = `
export async function open() {
    throw new Error('mmdb-lib is stubbed in tests');
}
`;

export async function resolve(specifier, context, nextResolve) {
    if (specifier === 'cloudflare:workers') {
        return {
            url: `data:text/javascript,${encodeURIComponent(workersStubSource)}`,
            shortCircuit: true,
        };
    }
    if (specifier === '@cloudflare/actors/storage') {
        return {
            url: `data:text/javascript,${encodeURIComponent(storageStubSource)}`,
            shortCircuit: true,
        };
    }
    if (specifier === 'mmdb-lib') {
        return {
            url: `data:text/javascript,${encodeURIComponent(mmdbStubSource)}`,
            shortCircuit: true,
        };
    }
    return nextResolve(specifier, context);
}
