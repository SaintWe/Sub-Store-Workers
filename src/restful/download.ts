import { getPlatformFromHeaders } from '../utils/platform';
import { COLLECTIONS_KEY, SUBS_KEY } from '../constants';
import { findByName } from '../utils/database';
import { getFlowHeaders } from '../utils/flow';
import $ from '../core/app';
import { failed } from './response';
import { InternalServerError, ResourceNotFoundError } from './errors';
import { produceArtifact } from './sync';
import { Context, Hono } from 'hono';

export default async function register($app: Hono) {
    const route = new Hono();
    route.get('/collection/:collection_name', downloadCollection);
    route.get('/:name', downloadSubscription);

    $app.route('/download', route);
}

const downloadSubscription = async (c: Context) => {
    let { name } = c.req.param();
    name = decodeURIComponent(name);
    const platform = c.req.query('target') || getPlatformFromHeaders(c.req.headers) || 'JSON';
    $.info(`正在下载订阅：${name}`);

    const allSubs = await $.read(SUBS_KEY);
    const sub = findByName(allSubs, name);
    if (sub) {
        try {
            const output = await produceArtifact({
                type: 'subscription',
                name,
                platform,
            });
            if (sub.source !== 'local') {
                // forward flow headers
                const flowInfo = await getFlowHeaders(sub.url);
                if (flowInfo) {
                    c.header('subscription-userinfo', flowInfo);
                }
            }
            if (platform === 'JSON') {
                c.header('Content-Type', 'application/json;charset=utf-8');
                return c.body(
                    output,
                );
            } else {
                return c.body(output);
            }
        } catch (err) {
            $.notify(
                `🌍 Sub-Store 下载订阅失败`,
                `❌ 无法下载订阅：${name}！`,
                `🤔 原因：${JSON.stringify(err)}`,
            );
            $.error(JSON.stringify(err));
            return failed(
                c,
                new InternalServerError(
                    'INTERNAL_SERVER_ERROR',
                    `Failed to download subscription: ${name}`,
                    `Reason: ${JSON.stringify(err)}`,
                ),
            );
        }
    } else {
        $.notify(`🌍 Sub-Store 下载订阅失败`, `❌ 未找到订阅：${name}！`);
        return failed(
            c,
            new ResourceNotFoundError(
                'RESOURCE_NOT_FOUND',
                `Subscription ${name} does not exist!`,
            ),
            404,
        );
    }
}

const downloadCollection = async (c: Context) => {
    let name = c.req.param('collection_name');
    name = decodeURIComponent(name);

    const platform = c.req.query('target') || getPlatformFromHeaders(c.req.headers) || 'JSON';

    const allCols = await $.read(COLLECTIONS_KEY);
    const collection = findByName(allCols, name);

    $.info(`正在下载组合订阅：${name}`);

    if (collection) {
        try {
            const output = await produceArtifact({
                type: 'collection',
                name,
                platform,
            });

            // forward flow header from the first subscription in this collection
            const allSubs = await $.read(SUBS_KEY);
            const subnames = collection.subscriptions;
            if (subnames.length > 0) {
                const sub = findByName(allSubs, subnames[0]);
                if (sub.source !== 'local') {
                    const flowInfo = await getFlowHeaders(sub.url);
                    if (flowInfo) {
                        c.header('subscription-userinfo', flowInfo);
                    }
                }
            }
            if (platform === 'JSON') {
                c.header('Content-Type', 'application/json;charset=utf-8');
            }
            return c.body(output);
        } catch (err) {
            $.notify(
                `🌍 Sub-Store 下载组合订阅失败`,
                `❌ 下载组合订阅错误：${name}！`,
                `🤔 原因：${err}`,
            );
            return failed(
                c,
                new InternalServerError(
                    'INTERNAL_SERVER_ERROR',
                    `Failed to download collection: ${name}`,
                    `Reason: ${JSON.stringify(err)}`,
                ),
            );
        }
    } else {
        $.notify(
            `🌍 Sub-Store 下载组合订阅失败`,
            `❌ 未找到组合订阅：${name}！`,
        );
        return failed(
            c,
            new ResourceNotFoundError(
                'RESOURCE_NOT_FOUND',
                `Collection ${name} does not exist!`,
            ),
            404,
        );
    }
}
