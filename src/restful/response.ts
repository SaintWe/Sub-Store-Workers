import { Context } from "hono";

export function success(c: Context, data: any = '', statusCode: number = 200) {
    return c.json(
        {
            status: 'success',
            data,
        },
        statusCode
    );
}

export function failed(c: Context, error: any, statusCode: number = 500) {
    return c.json(
        {
            status: 'failed',
            error: {
                code: error.code,
                type: error.type,
                message: error.message,
                details: error.details,
            },
        },
        statusCode
    );
}
