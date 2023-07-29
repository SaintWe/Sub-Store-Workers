import $ from '../core/app';
import {
    ARTIFACTS_KEY,
    COLLECTIONS_KEY,
    RULES_KEY,
    SUBS_KEY,
} from '../constants';
import { failed, success } from './response';
import { InternalServerError, ResourceNotFoundError } from './errors';
import { findByName } from '../utils/database';
import download from '../utils/download';
import { ProxyUtils } from '../core/proxy-utils';
import { RuleUtils } from '../core/rule-utils';
import { syncToGist } from './artifacts';
import { Context, Hono } from 'hono';

export default async function register($app: Hono) {
    // Initialization
    if (! await $.read(ARTIFACTS_KEY)) await $.write([], ARTIFACTS_KEY);

    // sync all artifacts
    const route = new Hono();
    route.get('/artifacts', syncAllArtifacts);
    route.get('/artifact/:name', syncArtifact);
    $app.route('/api/sync', route);
}

type ArtifactType = {
    type: string,
    name: string,
    platform: string,
}

async function produceArtifact({ type, name, platform }: ArtifactType) {
    platform = platform || 'JSON';

    // produce Clash node format for ShadowRocket
    if (platform === 'ShadowRocket') platform = 'Clash';

    if (type === 'subscription') {
        const allSubs = await $.read(SUBS_KEY);
        const sub = findByName(allSubs, name);
        let raw;
        if (sub.source === 'local') {
            raw = sub.content;
        } else {
            raw = await download(sub.url, sub.ua);
        }
        $.info('down done')

        // parse proxies
        let proxies = ProxyUtils.parse(raw);
        // apply processors
        proxies = await ProxyUtils.process(
            proxies,
            sub.process || [],
            platform,
        );
        // check duplicate
        const exist = {};
        for (const proxy of proxies) {
            if (exist[proxy.name]) {
                $.notify(
                    '🌍 Sub-Store',
                    '⚠️ 订阅包含重复节点！',
                    '请仔细检测配置！',
                    {
                        'media-url':
                            'https://cdn3.iconfinder.com/data/icons/seo-outline-1/512/25_code_program_programming_develop_bug_search_developer-512.png',
                    },
                );
                break;
            }
            exist[proxy.name] = true;
        }
        // produce
        return ProxyUtils.produce(proxies, platform);
    } else if (type === 'collection') {
        const allSubs = await $.read(SUBS_KEY);
        const allCols = await $.read(COLLECTIONS_KEY);
        const collection = findByName(allCols, name);
        const subnames = collection.subscriptions;
        const results = {};
        let processed = 0;

        await Promise.all(
            subnames.map(async (name) => {
                const sub = findByName(allSubs, name);
                try {
                    $.info(`正在处理子订阅：${sub.name}...`);
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
                        platform,
                    );
                    results[name] = currentProxies;
                    processed++;
                    $.info(
                        `✅ 子订阅：${sub.name}加载成功，进度--${
                            100 * (processed / subnames.length).toFixed(1)
                        }% `,
                    );
                } catch (err) {
                    processed++;
                    $.error(
                        `❌ 处理组合订阅中的子订阅: ${
                            sub.name
                        }时出现错误：${err}，该订阅已被跳过！进度--${
                            100 * (processed / subnames.length).toFixed(1)
                        }%`,
                    );
                }
            }),
        );

        // merge proxies with the original order
        let proxies = Array.prototype.concat.apply(
            [],
            subnames.map((name) => results[name]),
        );

        // apply own processors
        proxies = await ProxyUtils.process(
            proxies,
            collection.process || [],
            platform,
        );
        if (proxies.length === 0) {
            throw new Error(`组合订阅中不含有效节点！`);
        }
        // check duplicate
        const exist = {};
        for (const proxy of proxies) {
            if (exist[proxy.name]) {
                $.notify(
                    '🌍 Sub-Store',
                    '⚠️ 订阅包含重复节点！',
                    '请仔细检测配置！',
                    {
                        'media-url':
                            'https://cdn3.iconfinder.com/data/icons/seo-outline-1/512/25_code_program_programming_develop_bug_search_developer-512.png',
                    },
                );
                break;
            }
            exist[proxy.name] = true;
        }
        return ProxyUtils.produce(proxies, platform);
    } else if (type === 'rule') {
        const allRules = await $.read(RULES_KEY);
        const rule = findByName(allRules, name);
        let rules = [];
        for (let i = 0; i < rule.urls.length; i++) {
            const url = rule.urls[i];
            $.info(
                `正在处理URL：${url}，进度--${
                    100 * ((i + 1) / rule.urls.length).toFixed(1)
                }% `,
            );
            try {
                const { body } = await download(url);
                const currentRules = RuleUtils.parse(body);
                rules = rules.concat(currentRules);
            } catch (err) {
                $.error(
                    `处理分流订阅中的URL: ${url}时出现错误：${err}! 该订阅已被跳过。`,
                );
            }
        }
        // remove duplicates
        rules = await RuleUtils.process(rules, [
            { type: 'Remove Duplicate Filter' },
        ]);
        // produce output
        return RuleUtils.produce(rules, platform);
    }
}

const syncAllArtifacts = async (c: Context) => {
    $.info('开始同步所有远程配置...');
    const allArtifacts = await $.read(ARTIFACTS_KEY);
    const files = {};

    try {
        await Promise.all(
            allArtifacts.map(async (artifact: any) => {
                if (artifact.sync) {
                    $.info(`正在同步云配置：${artifact.name}...`);
                    const output = await produceArtifact({
                        type: artifact.type,
                        name: artifact.source,
                        platform: artifact.platform,
                    });

                    files[artifact.name] = {
                        content: output,
                    };
                }
            }),
        );

        const resp = await syncToGist(files);
        const body = JSON.parse(resp.body);

        for (const artifact of allArtifacts) {
            if (artifact.sync) {
                artifact.updated = new Date().getTime();
                // extract real url from gist
                artifact.url = body.files[artifact.name].raw_url.replace(
                    /\/raw\/[^/]*\/(.*)/,
                    '/raw/$1',
                );
            }
        }

        await $.write(allArtifacts, ARTIFACTS_KEY);
        $.info('全部订阅同步成功！');
        return success(c);
    } catch (err) {
        $.info(`同步订阅失败，原因：${err}`);
        return failed(
            c,
            new InternalServerError(
                `FAILED_TO_SYNC_ARTIFACTS`,
                `Failed to sync all artifacts`,
                `Reason: ${err}`,
            ),
        );
    }
}

const syncArtifact = async (c: Context) => {
    let { name } = c.req.param();
    name = decodeURIComponent(name);
    const allArtifacts = await $.read(ARTIFACTS_KEY);
    const artifact = findByName(allArtifacts, name);

    if (!artifact) {
        return failed(
            c,
            new ResourceNotFoundError(
                'RESOURCE_NOT_FOUND',
                `Artifact ${name} does not exist!`,
            ),
            404,
        );
    }

    const output = await produceArtifact({
        type: artifact.type,
        name: artifact.source,
        platform: artifact.platform,
    });

    $.info(
        `正在上传配置：${artifact.name}\n>>>${JSON.stringify(
            artifact,
            null,
            2,
        )}`,
    );
    try {
        const resp = await syncToGist({
            [encodeURIComponent(artifact.name)]: {
                content: output,
            },
        });
        artifact.updated = new Date().getTime();
        const body = JSON.parse(resp.body);
        artifact.url = body.files[
            encodeURIComponent(artifact.name)
        ].raw_url.replace(/\/raw\/[^/]*\/(.*)/, '/raw/$1');
        await $.write(allArtifacts, ARTIFACTS_KEY);
        return success(c, artifact);
    } catch (err) {
         return failed(
            c,
            new InternalServerError(
                `FAILED_TO_SYNC_ARTIFACT`,
                `Failed to sync artifact ${name}`,
                `Reason: ${err}`,
            ),
        );
    }
}

export { produceArtifact };
