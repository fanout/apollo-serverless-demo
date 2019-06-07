import * as express from "express";
import * as http from "http";
import { IGraphqlSubscription } from "../FanoutGraphqlApolloConfig";
import { ISimpleTable } from "../SimpleTable";
import { IGraphqlWsStartEventPayload } from "./GraphqlWebSocketOverHttpConnectionListener";
import GraphqlWsOverWebSocketOverHttpExpressMiddleware from "./GraphqlWsOverWebSocketOverHttpExpressMiddleware";

interface IGraphqlWsOverWebSocketOverHttpRequestListenerOptions {
  /** table to store information about each Graphql Subscription */
  subscriptionStorage: ISimpleTable<IGraphqlSubscription>;
  /** Given a subscription operation, return a string that is the Grip-Channel that the GRIP server should subscribe to for updates */
  getGripChannel(subscriptionOperation: IGraphqlWsStartEventPayload): string;
}

/**
 * GraphqlWsOverWebSocketOverHttpRequestListener.
 * Given an http RequestListener, return a new one that will respond to incoming WebSocket-Over-Http requests that are graphql-ws
 * Subscriptions and accept the subscriptions.
 */
export default (
  originalRequestListener: http.RequestListener,
  options: IGraphqlWsOverWebSocketOverHttpRequestListenerOptions,
): http.RequestListener => (req, res) => {
  const handleWebSocketOverHttpRequestHandler: http.RequestListener = express()
    .use(GraphqlWsOverWebSocketOverHttpExpressMiddleware(options))
    .use((expressRequest, expressResponse) => {
      // It wasn't handled by GraphqlWsOverWebSocketOverHttpExpressMiddleware
      originalRequestListener(req, res);
    });
  handleWebSocketOverHttpRequestHandler(req, res);
};
