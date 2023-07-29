import {
    NetworkError,
    InternalServerError,
    ResourceNotFoundError,
    RequestInvalidError,
} from './errors';
import { deleteByName, findByName, updateByName } from '../utils/database';
import { SUBS_KEY, COLLECTIONS_KEY, ARTIFACTS_KEY } from '../constants';
import { getFlowHeaders } from '../utils/flow';
import { success, failed } from './response';
import { Context, Hono } from 'hono';
import $ from '../core/app';

export default async function register($app: Hono) {
    if (!await $.read(SUBS_KEY)) await $.write([], SUBS_KEY);

    const route = new Hono();
    route.get('/flow/:flow_name', getFlowInfo);
    route.get('/:name', getSubscription).patch(updateSubscription).delete(deleteSubscription);

    $app.route('/api/sub', route);
    $app.get('/api/subs', getAllSubscriptions).post(createSubscription);
}

// subscriptions API
const getFlowInfo = async (c: Context) => {
    let name = c.req.param('flow_name');
    name = decodeURIComponent(name);
    const allSubs = await $.read(SUBS_KEY);
    const sub = findByName(allSubs, name);
    if (!sub) {
        return failed(
            c,
            new ResourceNotFoundError(
                'RESOURCE_NOT_FOUND',
                `Subscription ${name} does not exist!`,
            ),
            404,
        );
    }
    if (sub.source === 'local') {
        return failed(
            c,
            new RequestInvalidError(
                'NO_FLOW_INFO',
                'N/A',
                `Local subscription ${name} has no flow information!`,
            ),
        );
    }
    try {
        const flowHeaders = await getFlowHeaders(sub.url);
        if (!flowHeaders) {
            return failed(
                c,
                new InternalServerError(
                    'NO_FLOW_INFO',
                    'No flow info',
                    `Failed to fetch flow headers`,
                ),
            );
        }

        // unit is KB
        const uploadMatch = flowHeaders.match(/upload=(-?)(\d+)/)
        const upload = Number(uploadMatch[1] + uploadMatch[2]);

        const downloadMatch = flowHeaders.match(/download=(-?)(\d+)/)
        const download = Number(downloadMatch[1] + downloadMatch[2]);

        const total = Number(flowHeaders.match(/total=(\d+)/)[1]);

        // optional expire timestamp
        const match = flowHeaders.match(/expire=(\d+)/);
        const expires = match ? Number(match[1]) : undefined;

        return success(c, { expires, total, usage: { upload, download } });
    } catch (err) {
        return failed(
            c,
            new NetworkError(
                `URL_NOT_ACCESSIBLE`,
                `The URL for subscription ${name} is inaccessible.`,
            ),
        );
    }
}

const createSubscription = async (c: Context) => {
    const sub = await c.req.json();
    $.info(`正在创建订阅： ${sub.name}`);
    let allSubs = await $.read(SUBS_KEY);
    if (findByName(allSubs, sub.name)) {
        return failed(
            c,
            new RequestInvalidError(
                'DUPLICATE_KEY',
                `Subscription ${sub.name} already exists.`,
            ),
        );
    }
    allSubs.push(sub);
    await $.write(allSubs, SUBS_KEY);
    return success(c, sub, 201);
}

const getSubscription = async (c: Context) => {
    let { name } = c.req.param();
    name = decodeURIComponent(name);
    const allSubs = await $.read(SUBS_KEY);
    const sub = findByName(allSubs, name);
    if (sub) {
        return success(c, sub);
    } else {
        return failed(
            c,
            new ResourceNotFoundError(
                `SUBSCRIPTION_NOT_FOUND`,
                `Subscription ${name} does not exist`,
                404,
            ),
        );
    }
}

const updateSubscription = async (c: Context) => {
    let { name } = c.req.param();
    name = decodeURIComponent(name); // the original name
    let sub = await c.req.json();
    const allSubs = await $.read(SUBS_KEY);
    const oldSub = findByName(allSubs, name);
    if (oldSub) {
        const newSub = {
            ...oldSub,
            ...sub,
        };
        $.info(`正在更新订阅： ${name}`);
        // allow users to update the subscription name
        if (name !== sub.name) {
            // update all collections refer to this name
            const allCols = await $.read(COLLECTIONS_KEY) || [];
            for (const collection of allCols) {
                const idx = collection.subscriptions.indexOf(name);
                if (idx !== -1) {
                    collection.subscriptions[idx] = sub.name;
                }
            }

            // update all artifacts referring this subscription
            const allArtifacts = await $.read(ARTIFACTS_KEY) || [];
            for (const artifact of allArtifacts) {
                if (
                    artifact.type === 'subscription' &&
                    artifact.source == name
                ) {
                    artifact.source = sub.name;
                }
            }

            await $.write(allCols, COLLECTIONS_KEY);
            await $.write(allArtifacts, ARTIFACTS_KEY);
        }
        updateByName(allSubs, name, newSub);
        await $.write(allSubs, SUBS_KEY);
        return success(c, newSub);
    } else {
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

const deleteSubscription = async (c: Context) => {
    let { name } = c.req.param();
    name = decodeURIComponent(name);
    $.info(`删除订阅：${name}...`);
    // delete from subscriptions
    let allSubs = await $.read(SUBS_KEY);
    allSubs = deleteByName(allSubs, name)
    await $.write(allSubs, SUBS_KEY);
    // delete from collections
    const allCols = await $.read(COLLECTIONS_KEY);
    if (allCols) {
        for (const collection of allCols) {
            collection.subscriptions = collection.subscriptions.filter(
                (s: any) => s !== name,
            );
        }
        await $.write(allCols, COLLECTIONS_KEY);
    }
    return success(c);
}

const getAllSubscriptions = async (c: Context) => {
    const allSubs = await $.read(SUBS_KEY);
    return success(c, allSubs);
}
