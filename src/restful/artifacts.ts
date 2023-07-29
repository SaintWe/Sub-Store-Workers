import $ from '../core/app';
import {
    ARTIFACT_REPOSITORY_KEY,
    ARTIFACTS_KEY,
    SETTINGS_KEY,
} from '../constants';
import { deleteByName, findByName, updateByName } from '../utils/database';
import { failed, success } from './response';
import {
    InternalServerError,
    RequestInvalidError,
    ResourceNotFoundError,
} from './errors';
import Gist from '../utils/gist';
import { Context, Hono } from 'hono';

export default async function register($app: Hono) {
    // Initialization
    if (! await $.read(ARTIFACTS_KEY)) await $.write([], ARTIFACTS_KEY);

    // RESTful APIs
    $app.get('/api/artifacts', getAllArtifacts).post(createArtifact);
    $app.get('/api/artifact/:name', getArtifact).patch(updateArtifact).delete(deleteArtifact);
}

const getAllArtifacts = async (c: Context) => {
    const allArtifacts = await $.read(ARTIFACTS_KEY);
    return success(c, allArtifacts);
}

const getArtifact = async (c: Context) => {
    let { name } = c.req.param();
    name = decodeURIComponent(name);
    const allArtifacts = await $.read(ARTIFACTS_KEY);
    const artifact = findByName(allArtifacts, name);

    if (artifact) {
        return success(c, artifact);
    } else {
        return failed(
            c,
            new ResourceNotFoundError(
                'RESOURCE_NOT_FOUND',
                `Artifact ${name} does not exist!`,
            ),
            404,
        );
    }
}

const createArtifact = async (c: Context) => {
    const artifact = await c.req.json();
    if (!validateArtifactName(artifact.name)) {
        return failed(
            c,
            new RequestInvalidError(
                'INVALID_ARTIFACT_NAME',
                `Artifact name ${artifact.name} is invalid.`,
            ),
        );
    }

    $.info(`正在创建远程配置：${artifact.name}`);
    const allArtifacts = await $.read(ARTIFACTS_KEY);
    if (findByName(allArtifacts, artifact.name)) {
        return failed(
            c,
            new RequestInvalidError(
                'DUPLICATE_KEY',
                `Artifact ${artifact.name} already exists.`,
            ),
        );
    } else {
        allArtifacts.push(artifact);
        await $.write(allArtifacts, ARTIFACTS_KEY);
        return success(c, artifact, 201);
    }
}

const updateArtifact = async (c: Context) => {
    const allArtifacts = await $.read(ARTIFACTS_KEY);
    let oldName = c.req.param('name');
    oldName = decodeURIComponent(oldName);
    const artifact = findByName(allArtifacts, oldName);
    if (artifact) {
        $.info(`正在更新远程配置：${artifact.name}`);
        const newArtifact = {
            ...artifact,
            ...await c.req.json(),
        };
        if (!validateArtifactName(newArtifact.name)) {
            return failed(
                c,
                new RequestInvalidError(
                    'INVALID_ARTIFACT_NAME',
                    `Artifact name ${newArtifact.name} is invalid.`,
                ),
            );
        }
        updateByName(allArtifacts, oldName, newArtifact);
        await $.write(allArtifacts, ARTIFACTS_KEY);
        return success(c, newArtifact);
    } else {
        return failed(
            c,
            new RequestInvalidError(
                'DUPLICATE_KEY',
                `Artifact ${oldName} already exists.`,
            ),
        );
    }
}

const deleteArtifact = async (c: Context) => {
    let { name } = c.req.param();
    name = decodeURIComponent(name);
    $.info(`正在删除远程配置：${name}`);
    const allArtifacts = await $.read(ARTIFACTS_KEY);
    try {
        const artifact = findByName(allArtifacts, name);
        if (!artifact) throw new Error(`远程配置：${name}不存在！`);
        if (artifact.updated) {
            // delete gist
            const files = {};
            files[encodeURIComponent(artifact.name)] = {
                content: '',
            };
            await syncToGist(files);
        }
        // delete local cache
        deleteByName(allArtifacts, name);
        await $.write(allArtifacts, ARTIFACTS_KEY);
        return success(c);
    } catch (err) {
        $.error(`无法删除远程配置：${name}，原因：${err}`);
        return failed(
            c,
            new InternalServerError(
                `FAILED_TO_DELETE_ARTIFACT`,
                `Failed to delete artifact ${name}`,
                `Reason: ${err}`,
            ),
        );
    }
}

const validateArtifactName = (name: string) => {
    return /^[a-zA-Z0-9._-]*$/.test(name);
}

const syncToGist = async (files) => {
    const { gistToken } = await $.read(SETTINGS_KEY);
    if (!gistToken) {
        return Promise.reject('未设置Gist Token！');
    }
    const manager = new Gist({
        token: gistToken,
        key: ARTIFACT_REPOSITORY_KEY,
    });
    return manager.upload(files);
}

export { syncToGist };
