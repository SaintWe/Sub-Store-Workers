import { CACHE_EXPIRATION_TIME_MS, RESOURCE_CACHE_KEY } from '../constants';
import { DB } from '../db';

class ResourceCache {
    expires: number;
    constructor(expires: number) {
        this.expires = expires;
    }

    async revokeAll() {
        await DB.deleteFrom('resource_cache').execute();
    }

    async get(key: string): Promise<any> {
        const time = new Date().getTime() - this.expires;
        const result = await DB.selectFrom('resource_cache').selectAll().where('key', '=', key).where('time', '>', time).executeTakeFirst();
        return !result ? null : JSON.parse(result.data);
    }

    async set(key: string, data: any): Promise<void> {
        data = JSON.stringify(data);
        const time = new Date().getTime();
        try {
            await DB
                .insertInto('resource_cache')
                .values([{ key, data, time }])
                .onConflict((oc) => oc.column('key').doUpdateSet({ data, time }))
                .execute();
        } catch (err) {
            throw err;
        }
    }
}

export default new ResourceCache(CACHE_EXPIRATION_TIME_MS);
