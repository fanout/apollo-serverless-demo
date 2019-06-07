import * as assert from "assert";
import * as express from "express";
import { v4 as uuidv4 } from "uuid";
import { IGraphqlSubscription } from "../FanoutGraphqlApolloConfig";
import AcceptAllGraphqlSubscriptionsMessageHandler from "../graphql-ws/AcceptAllGraphqlSubscriptionsMessageHandler";
import { ISimpleTable } from "../SimpleTable";
import WebSocketOverHttpExpress from "../WebSocketOverHttpExpress";
import GraphqlWebSocketOverHttpConnectionListener, {
  getSubscriptionOperationFieldName,
  IConnectionListener,
  IGraphqlWsStartEventPayload,
} from "./GraphqlWebSocketOverHttpConnectionListener";

/**
 * Websocket message handler that will watch for graphql-ws GQL_START events that initiate subscriptions
 * and store information about each subscription to the provided subscriptionStorage.
 */
const SubscriptionStoringMessageHandler = (
  subscriptionStorage: ISimpleTable<IGraphqlSubscription>,
) => async (message: string) => {
  const graphqlWsEvent = JSON.parse(message);
  if (!graphqlWsEvent) {
    return;
  }
  switch (graphqlWsEvent.type) {
    case "start":
      const operationId = graphqlWsEvent.id;
      assert(operationId, "graphql-ws GQL_START message must have id");
      const payload = graphqlWsEvent.payload;
      const query = payload && payload.query;
      assert(query, "graphql-ws GQL_START message must have query");
      const subscriptionFieldName = getSubscriptionOperationFieldName(
        graphqlWsEvent.payload,
      );
      subscriptionStorage.insert({
        id: uuidv4(),
        operationId,
        startMessage: message,
        subscriptionFieldName,
      });
      break;
  }
};

type IMessageListener = IConnectionListener["onMessage"];
const composeMessageHandlers = (
  handlers: IMessageListener[],
): IMessageListener => {
  const composedMessageHandler = async (message: string) => {
    const responses = await Promise.all(
      handlers.map(handler => handler(message)),
    );
    return responses.filter(Boolean).join("\n");
  };
  return composedMessageHandler;
};

interface IGraphqlWsOverWebSocketOverHttpExpressMiddlewareOptions {
  /** table to store information about each Graphql Subscription */
  subscriptionStorage: ISimpleTable<IGraphqlSubscription>;
  /** Given a subscription operation, return a string that is the Grip-Channel that the GRIP server should subscribe to for updates */
  getGripChannel(subscriptionOperation: IGraphqlWsStartEventPayload): string;
  /** Called when a new subscrpition connection is made */
  onSubscriptionStart?(...args: any[]): any;
}

/**
 * Create an Express Middleware that will accept graphql-ws connections that come in over WebSocket-Over-Http
 */
const GraphqlWsOverWebSocketOverHttpExpressMiddleware = (
  options: IGraphqlWsOverWebSocketOverHttpExpressMiddlewareOptions,
): express.RequestHandler => {
  return WebSocketOverHttpExpress({
    getConnectionListener(connection) {
      /** This connectionListener will respond to graphql-ws messages in a way that accepts all incoming subscriptions */
      const graphqlWsConnectionListener = GraphqlWebSocketOverHttpConnectionListener(
        {
          connection,
          getGripChannel: options.getGripChannel,
          getMessageResponse: AcceptAllGraphqlSubscriptionsMessageHandler({
            onStart: options.onSubscriptionStart,
          }),
        },
      );
      /**
       * We also want to keep track of all subscriptions in a table so we can look them up later when publishing.
       * So this message handler will watch for graphql-ws GQL_START mesages and store subscription info based on them
       */
      const storeSubscriptionsOnMessage = SubscriptionStoringMessageHandler(
        options.subscriptionStorage,
      );
      // So the returned onMessage is going to be a composition of the above message handlers
      const onMessage = composeMessageHandlers([
        graphqlWsConnectionListener.onMessage,
        storeSubscriptionsOnMessage,
      ]);
      return {
        ...graphqlWsConnectionListener,
        onMessage,
      };
    },
  });
};

export default GraphqlWsOverWebSocketOverHttpExpressMiddleware;
