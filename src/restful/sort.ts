import { ARTIFACTS_KEY, COLLECTIONS_KEY, SUBS_KEY } from '../constants';
import $ from '../core/app';
import { success } from './response';
import { Context, Hono } from 'hono';

export default async function register($app: Hono) {
    const route = new Hono();
    route.post('/subs', sortSubs);
    route.post('/collections', sortCollections);
    route.post('/artifacts', sortArtifacts);

    $app.route('/api/sort', route);
}

const sortSubs = async (c: Context) => {
    const orders = await c.req.json();
    const allSubs = await $.read(SUBS_KEY);
    allSubs.sort((a: any, b: any) => orders.indexOf(a) - orders.indexOf(b));
    await $.write(allSubs, SUBS_KEY);
    return success(c, allSubs);
}

const sortCollections = async (c: Context) => {
    const orders = await c.req.json();
    const allCols = await $.read(COLLECTIONS_KEY);
    allCols.sort((a: any, b: any) => orders.indexOf(a) - orders.indexOf(b));
    await $.write(allCols, COLLECTIONS_KEY);
    return success(c, allCols);
}

const sortArtifacts = async (c: Context) => {
    const orders = await c.req.json();
    const allArtifacts = await $.read(ARTIFACTS_KEY);
    allArtifacts.sort((a: any, b: any) => orders.indexOf(a) - orders.indexOf(b));
    await $.write(allArtifacts, ARTIFACTS_KEY);
    return success(c, allArtifacts);
}
