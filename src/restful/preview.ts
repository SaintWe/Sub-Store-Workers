import { InternalServerError, NetworkError } from './errors';
import { ProxyUtils } from '../core/proxy-utils';
import { findByName } from '../utils/database';
import { success, failed } from './response';
import download from '../utils/download';
import { SUBS_KEY } from '../constants';
import $ from '../core/app';
import { Context, Hono } from 'hono';

export default async function register($app: Hono) {
    const route = new Hono();
    route.post('/sub', compareSub);
    route.post('/collection', compareCollection);

    $app.route('/api/preview', route);
}

const compareSub = async (c: Context) => {
    const sub = await c.req.json();
    const target = c.req.query('target') || 'JSON';
    let content;
    if (sub.source === 'local') {
        content = sub.content;
    } else {
        try {
            content = await download(sub.url, sub.ua);
        } catch (err) {
            return failed(
                c,
                new NetworkError(
                    'FAILED_TO_DOWNLOAD_RESOURCE',
                    '无法下载远程资源',
                    `Reason: ${err}`,
                ),
            );
        }
    }
    // parse proxies
    const original = ProxyUtils.parse(content);

    // add id
    original.forEach((proxy: any, i: any) => {
        proxy.id = i;
    });

    // apply processors
    const processed = await ProxyUtils.process(
        original,
        sub.process || [],
        target,
    );

    // produce
    return success(c, { original, processed });
}

const compareCollection = async (c: Context) => {
    const allSubs = await $.read(SUBS_KEY);
    const collection = await c.req.json();
    const subnames = collection.subscriptions;
    const results = {};

    await Promise.all(
        subnames.map(async (name: string) => {
            const sub = findByName(allSubs, name);
            try {
                let raw;
                if (sub.source === 'local') {
                    raw = sub.content;
                } else {
                    raw = await download(sub.url, sub.ua);
                }
                // parse proxies
                let currentProxies = ProxyUtils.parse(raw);
                // apply processors
                currentProxies = await ProxyUtils.process(
                    currentProxies,
                    sub.process || [],
                    'JSON',
                );
                results[name] = currentProxies;
            } catch (err) {
                return failed(
                    c,
                    new InternalServerError(
                        'PROCESS_FAILED',
                        `处理子订阅 ${name} 失败`,
                        `Reason: ${err}`,
                    ),
                );
            }
        }),
    );

    // merge proxies with the original order
    const original = Array.prototype.concat.apply(
        [],
        subnames.map((name: any) => results[name] || []),
    );

    original.forEach((proxy, i) => {
        proxy.id = i;
    });

    const processed = await ProxyUtils.process(
        original,
        collection.process || [],
        'JSON',
    );

    return success(c, { original, processed });
}
