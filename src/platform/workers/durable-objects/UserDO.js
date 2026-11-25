import { DurableObject } from 'cloudflare:workers';
import { Storage } from '@cloudflare/actors/storage';
import { getRequestId, initLogger, debug, error as logError } from '../../../utils/logger.js';
import { errorResponse } from '../../../atoms/http/httpAtoms.js';
import { ensureUserDoSchema } from '../../../atoms/userSql/userSqlAtoms.js';
import { handle as handleUserEntryRequest } from '../../../orchestration/commander/userEntryCommander.js';
import { createRuntimeServices } from '../runtime/createRuntimeServices.js';


export class UserDO extends DurableObject {
    constructor(state, env) {
        super(state, env);
        this.state = state;
        this.env = env;
        this.storage = new Storage(state.storage);
        this.runtimeServices = createRuntimeServices({ storage: this.storage, env, entry: 'user' });

        // 串行队列：DO 单线程只保证同一时刻只有一个请求在执行，
        // 但 await 期间不同请求仍会交错，user_data 等读-改-写流程
        // 可能互相覆盖。用 Promise 链把整个请求串行化，保证完整业务
        // 操作（含 Sub-Store HTTP 请求与 Cron 刷新）不交错。
        this._requestQueue = Promise.resolve();

        // schema 初始化下沉到 atom，避免在入口文件中散落 SQL
        ensureUserDoSchema(state.storage.sql, this.storage);
    }

    async fetch(request) {
        // 串行排队：前一个请求完全结束后才执行下一个。
        // 队列本身不能因某个请求失败而卡死，故单独 catch 掉排队链的异常。
        const task = this._requestQueue.then(() => this._handleFetch(request));
        this._requestQueue = task.catch(() => {});
        return task;
    }

    async _handleFetch(request) {
        initLogger(this.env);
        const requestId = getRequestId(request);
        const url = new URL(request.url);
        debug(`[UserDO] [${requestId}] ${request.method} ${url.pathname}`);

        try {
            return await handleUserEntryRequest({
                request,
                env: this.env,
                state: this.state,
                storage: this.storage,
                requestId,
                services: this.runtimeServices,
            });
        } catch (err) {
            logError(`[UserDO] [${requestId}] unhandled error:`, err?.stack || err?.message || err);
            return errorResponse('Internal Server Error', 500);
        }
    }
}
