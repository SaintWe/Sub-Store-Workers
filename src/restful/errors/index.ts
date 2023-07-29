class BaseError {
    code; message; details; type: any;
    constructor(code: any, message: any, details?: any) {
        this.code = code;
        this.message = message;
        this.details = details;
    }
}

export class InternalServerError extends BaseError {
    constructor(code: any, message: any, details?: any) {
        super(code, message, details);
        this.type = 'InternalServerError';
    }
}

export class RequestInvalidError extends BaseError {
    constructor(code: any, message: any, details?: any) {
        super(code, message, details);
        this.type = 'RequestInvalidError';
    }
}

export class ResourceNotFoundError extends BaseError {
    constructor(code: any, message: any, details?: any) {
        super(code, message, details);
        this.type = 'ResourceNotFoundError';
    }
}

export class NetworkError extends BaseError {
    constructor(code: any, message: any, details?: any) {
        super(code, message, details);
        this.type = 'NetworkError';
    }
}
