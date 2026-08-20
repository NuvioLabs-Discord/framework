export class DiscordError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = 'DiscordError';
    this.code = options.code;
    this.status = options.status;
    this.details = options.details;
  }
}

export class GatewayError extends DiscordError {
  constructor(message, options = {}) {
    super(message, options);
    this.name = 'GatewayError';
    this.closeCode = options.closeCode;
    this.reconnect = options.reconnect;
  }
}

export class PreconditionError extends DiscordError {
  constructor(message, options = {}) {
    super(message, options);
    this.name = 'PreconditionError';
    this.response = options.response;
  }
}

export class DiscordHttpError extends DiscordError {
  constructor(message, options = {}) {
    super(message, options);
    this.name = 'DiscordHttpError';
    this.status = options.status;
    this.method = options.method;
    this.path = options.path;
    this.body = options.body;
    this.retryAfter = options.retryAfter;
  }
}
