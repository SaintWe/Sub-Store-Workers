import { Kysely } from 'kysely';
import { D1Dialect } from 'kysely-d1';
import { Env } from '.';

interface SubStoreTable {
    key: string;
    data: string;
};

interface ResourceCacheTable {
    key: string;
    data: string;
    time: number;
};

interface Database {
    sub_store: SubStoreTable;
    resource_cache: ResourceCacheTable;
};

let DB: Kysely<Database>;

export function setDBClient(env: Env) {
    DB = new Kysely<Database>({
        dialect: new D1Dialect({ database: env.DB }),
    });
}

export { DB };
