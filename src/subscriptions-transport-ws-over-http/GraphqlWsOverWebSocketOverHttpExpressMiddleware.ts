import * as express from "express";
import AcceptAllGraphqlSubscriptionsMessageHandler from "../graphql-ws/AcceptAllGraphqlSubscriptionsMessageHandler";
import WebSocketOverHttpExpress from "../WebSocketOverHttpExpress";
import GraphqlWebSocketOverHttpConnectionListener, {
  IGraphqlWsStartEventPayload,
} from "./GraphqlWebSocketOverHttpConnectionListener";

interface IGraphqlWsOverWebSocketOverHttpExpressMiddlewareOptions {
  /** Given a subscription operation, return a string that is the Grip-Channel that the GRIP server should subscribe to for updates */
  getGripChannel(subscriptionOperation: IGraphqlWsStartEventPayload): string;
}

/**
 * Create an Express Middleware that will accept graphql-ws connections that come in over WebSocket-Over-Http
 */
const GraphqlWsOverWebSocketOverHttpExpressMiddleware = (
  options: IGraphqlWsOverWebSocketOverHttpExpressMiddlewareOptions,
): express.RequestHandler => {
  return WebSocketOverHttpExpress({
    getConnectionListener(connection) {
      return GraphqlWebSocketOverHttpConnectionListener({
        connection,
        getGripChannel: options.getGripChannel,
        getMessageResponse: AcceptAllGraphqlSubscriptionsMessageHandler({
          onStart() {
            // console.debug(
            //   "GraphqlWsOverWebSocketOverHttpExpressMiddleware onStart",
            // );
          },
        }),
      });
    },
  });
};

export default GraphqlWsOverWebSocketOverHttpExpressMiddleware;
