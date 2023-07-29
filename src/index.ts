import { Context, Hono } from 'hono';
import { cors } from 'hono/cors';
import { bearerAuth } from 'hono/bearer-auth'
import registerCollectionRoutes from './restful/collections';
import registerSubscriptionRoutes from './restful/subscriptions';
import registerArtifactRoutes from './restful/artifacts';
import registerSyncRoutes from './restful/sync';
import registerDownloadRoutes from './restful/download';
import registerSettingRoutes from './restful/settings';
import registerPreviewRoutes from './restful/preview';
import registerSortingRoutes from './restful/sort';
import registerMiscRoutes from './restful/miscs';
import registerNodeInfoRoutes from './restful/node-info';
import { setDBClient } from './db';
import { setEnvironment } from './env';

type Bindings = {
    DB: D1Database
}

export interface Env {
    __STATIC_CONTENT: KVNamespace<string>;
    DB: D1Database;
    BEARER_TOKEN: string;
    D_TOKEN: string;
}

export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext) {

        setEnvironment(env);
        setDBClient(env);

        await env.DB.prepare("CREATE TABLE IF NOT EXISTS sub_store (key TEXT NOT NULL PRIMARY KEY, data TEXT)").run()
        await env.DB.prepare("CREATE TABLE IF NOT EXISTS resource_cache (key TEXT NOT NULL PRIMARY KEY, data TEXT, time INTEGER)").run()

        const $app = new Hono<{ Bindings: Bindings }>();

        $app.use('/*', cors());

        if (env.BEARER_TOKEN) {
            $app.use('/api/*', bearerAuth({ token: env.BEARER_TOKEN }));
        }

        if (env.D_TOKEN) {
            $app.use('/download/*', async (c, next) => {
                if (c.req.query('d_token') !== env.D_TOKEN) {
                    return c.text('由于开启了 d_token 验证，当前 d_token 不正确或未提供', 401);
                }
                await next();
            });
        }

        $app.get('/subs', (c: Context) => c.redirect('/', 302));
        $app.get('/sync', (c: Context) => c.redirect('/', 302));
        $app.get('/my', (c: Context) => c.redirect('/', 302));

        await registerCollectionRoutes($app);
        await registerSubscriptionRoutes($app);
        await registerDownloadRoutes($app);
        await registerPreviewRoutes($app);
        await registerSortingRoutes($app);
        await registerSettingRoutes($app);
        await registerArtifactRoutes($app);
        await registerSyncRoutes($app);
        await registerNodeInfoRoutes($app);
        await registerMiscRoutes($app);

        return $app.fetch(request, env, ctx);
    },
}
