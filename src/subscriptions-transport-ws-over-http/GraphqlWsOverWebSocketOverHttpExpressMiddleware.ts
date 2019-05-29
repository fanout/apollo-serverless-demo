import * as express from "express";
import AcceptAllGraphqlSubscriptionsMessageHandler from "../graphql-ws/AcceptAllGraphqlSubscriptionsMessageHandler";
import WebSocketOverHttpExpress from "../WebSocketOverHttpExpress";
import GraphqlWebSocketOverHttpConnectionListener from "./GraphqlWebSocketOverHttpConnectionListener";

/**
 * Create an Express Middleware that will accept graphql-ws connections that come in over WebSocket-Over-Http
 */
const GraphqlWsOverWebSocketOverHttpExpressMiddleware = (): express.RequestHandler => {
  return WebSocketOverHttpExpress({
    getConnectionListener(connection) {
      return GraphqlWebSocketOverHttpConnectionListener({
        connection,
        getMessageResponse: AcceptAllGraphqlSubscriptionsMessageHandler({
          onStart() {
            console.debug(
              "GraphqlWsOverWebSocketOverHttpExpressMiddleware onStart",
            );
          },
        }),
      });
    },
  });
};

export default GraphqlWsOverWebSocketOverHttpExpressMiddleware;
