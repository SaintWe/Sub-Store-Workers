import producer from '../core/proxy-utils/producers';
import { HTTP } from '../vendor/open-api';
import { failed, success } from './response';
import { NetworkError } from './errors';
import { Context, Hono } from 'hono';

export default async function register($app: Hono) {
    $app.post('/api/utils/node-info', getNodeInfo);
}

const getNodeInfo = async (c: Context) => {
    const proxy = await c.req.json();
    const lang = c.req.query('lang') || 'zh-CN';
    let shareUrl;
    try {
        shareUrl = producer.URI.produce(proxy);
    } catch (err) {
        // do nothing
    }

    try {
        const $http = HTTP();
        const info = await $http
            .get({
                url: `http://ip-api.com/json/${encodeURIComponent(
                    proxy.server,
                )}?lang=${lang}`,
                headers: {
                    'User-Agent':
                        'Mozilla/5.0 (Macintosh; Intel Mac OS X 12_4) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.4 Safari/605.1.15',
                },
            })
            .then(
                (resp: Response) => resp.json()
            )
            .then((data) => {
                if (data.status !== 'success') {
                    throw new Error(data.message);
                }
                // remove unnecessary fields
                delete data.status;
                return data;
            });
        return success(c, {
            shareUrl,
            info,
        });
    } catch (err) {
        return failed(
            c,
            new NetworkError(
                'FAILED_TO_GET_NODE_INFO',
                `Failed to get node info`,
                `Reason: ${err}`,
            ),
        );
    }
}
