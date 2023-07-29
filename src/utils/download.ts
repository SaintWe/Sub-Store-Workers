import { HTTP } from '../vendor/open-api';
import { hex_md5 } from '../vendor/md5';
import resourceCache from '../utils/resource-cache';

export default async function download(url: string, ua: string) {

    ua = ua || 'Quantumult%20X/1.0.29 (iPhone14,5; iOS 15.4.1)';
    const id = hex_md5(ua + url);
    const http = HTTP({
        headers: {
            'User-Agent': ua,
        },
    });

    const result = new Promise(async (resolve, reject) => {
        // try to find in app cache
        const cached = await resourceCache.get(id);
        if (cached) {
            resolve(cached);
        } else {
            await http.get(url)
                .then(async (resp: Response) => {
                    const body = await resp.text();
                    if (body.replace(/\s/g, '').length === 0)
                        reject(new Error('远程资源内容为空！'));
                    else {
                        await resourceCache.set(id, body);
                        resolve(body);
                    }
                })
                .catch(() => {
                    reject(new Error(`无法下载 URL：${url}`));
                });
        }
    });
    return await result;
}
