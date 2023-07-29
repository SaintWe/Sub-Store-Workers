import { deleteByName, findByName, updateByName } from '../utils/database';
import { COLLECTIONS_KEY, ARTIFACTS_KEY } from '../constants';
import { failed, success } from './response';
import $ from '../core/app';
import { RequestInvalidError, ResourceNotFoundError } from './errors';
import { Context, Hono } from 'hono';

export default async function register($app: Hono) {
    if (! await $.read(COLLECTIONS_KEY)) await $.write([], COLLECTIONS_KEY);

    $app.get('/api/collections', getAllCollections).post(createCollection);
    $app.get('/api/collection/:name', getCollection).patch(updateCollection).delete(deleteCollection);
}

// collection API
const createCollection = async (c: Context) => {
    // req, res
    const collection = await c.req.json();
    $.info(`正在创建组合订阅：${collection.name}`);
    const allCols = await $.read(COLLECTIONS_KEY);
    if (findByName(allCols, collection.name)) {
        return failed(
            c,
            new RequestInvalidError(
                'DUPLICATE_KEY',
                `Collection ${collection.name} already exists.`,
            ),
        );
    }
    allCols.push(collection);
    await $.write(allCols, COLLECTIONS_KEY);
    return success(c, collection, 201);
}

const getCollection = async (c: Context) => {
    let { name } = c.req.param();
    name = decodeURIComponent(name);
    const allCols = await $.read(COLLECTIONS_KEY);
    const collection = findByName(allCols, name);
    if (collection) {
        return success(c, collection);
    } else {
        return failed(
            c,
            new ResourceNotFoundError(
                `SUBSCRIPTION_NOT_FOUND`,
                `Collection ${name} does not exist`,
                404,
            ),
        );
    }
}

const updateCollection = async (c: Context) => {
    let { name } = c.req.param();
    name = decodeURIComponent(name);
    let collection = await c.req.json();
    const allCols = await $.read(COLLECTIONS_KEY);
    const oldCol = findByName(allCols, name);
    if (oldCol) {
        const newCol = {
            ...oldCol,
            ...collection,
        };
        $.info(`正在更新组合订阅：${name}...`);

        if (name !== newCol.name) {
            // update all artifacts referring this collection
            const allArtifacts = await $.read(ARTIFACTS_KEY) || [];
            for (const artifact of allArtifacts) {
                if (
                    artifact.type === 'collection' &&
                    artifact.source === oldCol.name
                ) {
                    artifact.source = newCol.name;
                }
            }
            await $.write(allArtifacts, ARTIFACTS_KEY);
        }

        updateByName(allCols, name, newCol);
        await $.write(allCols, COLLECTIONS_KEY);
        return success(c, newCol);
    } else {
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

const deleteCollection = async (c: Context) => {
    let { name } = c.req.param();
    name = decodeURIComponent(name);
    $.info(`正在删除组合订阅：${name}`);
    let allCols = await $.read(COLLECTIONS_KEY);
    allCols = deleteByName(allCols, name);
    await $.write(allCols, COLLECTIONS_KEY);
    return success(c);
}

const getAllCollections = async (c: Context) => {
    const allCols = await $.read(COLLECTIONS_KEY);
    return success(c, allCols);
}
