import { SETTINGS_KEY, ARTIFACT_REPOSITORY_KEY } from '../constants';
import { success } from './response';
import $ from '../core/app';
import Gist from '../utils/gist';
import { Context, Hono } from 'hono';

export default async function register($app: Hono) {
    const settings = await $.read(SETTINGS_KEY);
    if (!settings) {
        await $.write(
            {
                username: '',
            },
            SETTINGS_KEY
        )
    };
    $app.get('/api/settings', getSettings).patch(updateSettings);
}

const getSettings = async (c: Context) => {
    await updateGitHubAvatar();
    const settings = await $.read(SETTINGS_KEY);
    if (!settings.avatarUrl) await updateGitHubAvatar();
    if (!settings.artifactStore) await updateArtifactStore();
    return success(c, settings);
}

const updateSettings = async (c: Context) => {
    const settings = await $.read(SETTINGS_KEY);
    const newSettings = {
        ...settings,
        ...await c.req.json(),
    };
    await $.write(newSettings, SETTINGS_KEY);
    await updateGitHubAvatar();
    await updateArtifactStore();
    return success(c, newSettings);
}

export const updateGitHubAvatar = async () => {
    const settings = await $.read(SETTINGS_KEY);
    const username = settings.githubUser;
    if (username) {
        try {
            const data = await $.http
                .get({
                    url: `https://api.github.com/users/${username}`,
                    headers: {
                        'User-Agent':
                            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/81.0.4044.141 Safari/537.36',
                    },
                })
                .then((resp: Response) => resp.json());
            settings.avatarUrl = data['avatar_url'];
            await $.write(settings, SETTINGS_KEY);
        } catch (e) {
            $.error('Failed to fetch GitHub avatar for User: ' + username);
        }
    }
}

export const updateArtifactStore = async () => {
    $.log('Updating artifact store');
    const settings = await $.read(SETTINGS_KEY);
    const { githubUser, gistToken } = settings;
    if (githubUser && gistToken) {
        const manager = new Gist({
            token: gistToken,
            key: ARTIFACT_REPOSITORY_KEY,
        });
        try {
            const gistId = await manager.locate();
            if (gistId !== -1) {
                settings.artifactStore = `https://gist.github.com/${githubUser}/${gistId}`;
                await $.write(settings, SETTINGS_KEY);
            }
        } catch (err) {
            $.error('Failed to fetch artifact store for User: ' + githubUser);
        }
    }
}
