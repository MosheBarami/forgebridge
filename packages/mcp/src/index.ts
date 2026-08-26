/**
 * The SDK-free half of this package.
 *
 * `./server` is deliberately not re-exported here. It is the only module that
 * imports `@modelcontextprotocol/sdk`, and keeping it behind its own entry
 * point means the tool surface, the schemas, the error mapping and the daemon
 * client can be imported — and tested — without loading a protocol library at
 * all. Reach for `@forgebridge/mcp/server` when you want a running server.
 */
export * from './config.js';
export * from './daemon-client.js';
export * from './errors.js';
export * from './register.js';
export * from './schemas.js';
export * from './tools.js';
