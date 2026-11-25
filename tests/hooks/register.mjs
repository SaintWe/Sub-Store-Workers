/**
 * 通过 --import 注册 cloudflare stub loader hook。
 * 用法：node --import ./tests/hooks/register.mjs --test tests/
 */
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

register(
    new URL('./cloudflare-stub.mjs', import.meta.url).href,
    pathToFileURL(import.meta.url),
);
