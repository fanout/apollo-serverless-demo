import * as http from "http";
import GraphqlWsOverWebSocketOverHttpExpressMiddleware from "./GraphqlWsOverWebSocketOverHttpExpressMiddleware";
import * as express from "express";

/**
 * GraphqlWsOverWebSocketOverHttpRequestListener.
 * Given an http RequestListener, return a new one that will respond to incoming WebSocket-Over-Http requests that are graphql-ws
 * Subscriptions and accept the subscriptions.
 */
export default (
  originalRequestListener: http.RequestListener,
): http.RequestListener => (req, res) => {
  const handleWebSocketOverHttpRequestHandler: http.RequestListener = express()
    .use(GraphqlWsOverWebSocketOverHttpExpressMiddleware())
    .use((expressRequest, expressResponse) => {
      // It wasn't handled by GraphqlWsOverWebSocketOverHttpExpressMiddleware
      originalRequestListener(req, res);
    });
  handleWebSocketOverHttpRequestHandler(req, res);
};
