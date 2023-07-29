import $ from '../core/app';
import { failed, success } from './response';
import { version as substoreVersion } from '../../package.json';
import { updateArtifactStore, updateGitHubAvatar } from './settings';
import resourceCache from '../utils/resource-cache';
import {
    GIST_BACKUP_FILE_NAME,
    GIST_BACKUP_KEY,
    SETTINGS_KEY,
} from '../constants';
import { InternalServerError, RequestInvalidError } from './errors';
import Gist from '../utils/gist';
import migrate from '../utils/migration';
import { Context, Hono } from 'hono';

export default async function register($app: Hono) {
    // utils
    $app.get('/api/utils/env', getEnv); // get runtime environment
    $app.get('/api/utils/backup', gistBackup); // gist backup actions
    $app.get('/api/utils/refresh', refresh);

    // Storage management
    $app.get('/api/storage', async (c: Context) => {
        return c.json(await $.read('#sub-store'));
    }).post(async (c: Context) => {
        const data = await c.req.json();
        await $.write(data, '#sub-store');
        return c.json({});
    });

    // Redirect sub.store to vercel webpage
    $app.get('/', async (c: Context) => c.redirect('https://sub-store-workers.vercel.app/', 302));

    $app.all('/', (c: Context) => {
        return c.text('Hello from sub-store, made with ❤️ by Peng-YM');
    });
}

const getEnv = async (c: Context) => {
    let backend = 'CloudFlareWorkers';

    return success(c, {
        backend,
        version: substoreVersion,
    });
}

const refresh = async (c: Context) => {
    // 1. get GitHub avatar and artifact store
    await updateGitHubAvatar();
    await updateArtifactStore();

    // 2. clear resource cache
    await resourceCache.revokeAll();
    return success(c);
}

const gistBackup = async (c: Context) => {
    const { action } = c.req.query();
    // read token
    const { gistToken } = await $.read(SETTINGS_KEY);
    if (!gistToken) {
        return failed(
            c,
            new RequestInvalidError(
                'GIST_TOKEN_NOT_FOUND',
                `GitHub Token is required for backup!`,
            ),
        );
    } else {
        const gist = new Gist({
            token: gistToken,
            key: GIST_BACKUP_KEY,
        });
        try {
            let content;
            const settings = await $.read(SETTINGS_KEY);
            const updated = settings.syncTime;
            switch (action) {
                case 'upload':
                    // update syncTime
                    settings.syncTime = new Date().getTime();
                    await $.write(settings, SETTINGS_KEY);
                    content = await $.read('#sub-store');
                    $.info(`上传备份中...`);
                    try {
                        await gist.upload({
                            [GIST_BACKUP_FILE_NAME]: { content },
                        });
                    } catch (err) {
                        // restore syncTime if upload failed
                        settings.syncTime = updated;
                        await $.write(settings, SETTINGS_KEY);
                        throw err;
                    }
                    break;
                case 'download':
                    $.info(`还原备份中...`);
                    content = await gist.download(GIST_BACKUP_FILE_NAME);
                    // restore settings
                    await $.write(content, '#sub-store');
                    // perform migration after restoring from gist
                    migrate();
                    break;
            }
            return success(c);
        } catch (err) {
            return failed(
                c,
                new InternalServerError(
                    'BACKUP_FAILED',
                    `Failed to ${action} data to gist!`,
                    `Reason: ${JSON.stringify(err)}`,
                ),
            );
        }
    }
}
