import { getMainDefinition } from "apollo-utilities";
import { OperationDefinitionNode } from "graphql";
import gql from "graphql-tag";
import * as grip from "grip";

interface IOnOpenResponse {
  /** response headers */
  headers: {
    [key: string]: string;
  };
}

/**
 * Given a subscription IGraphqlWsStartEventPayload, return the name of the subscription field.
 * This is useful to get an identifier for a subscription query as long as the query has no arguments.
 * It does not take query variables/arguments into account.
 */
export const getSubscriptionOperationFieldName = (
  graphqlWsEventPayload: IGraphqlWsStartEventPayload,
): string => {
  const query = gql`
    ${graphqlWsEventPayload.query}
  `;
  const mainDefinition = getMainDefinition(query);
  if (mainDefinition.kind === "FragmentDefinition") {
    throw new Error(
      `Did not expect subscription mainDefinition to be FragmentDefinition`,
    );
  }
  const selections = mainDefinition.selectionSet.selections;
  const selection = selections[0];
  if (!selection) {
    throw new Error("could not parse selection from graphqlWsEvent");
  }
  if (selection.kind !== "Field") {
    throw new Error(`could not get selection from graphqlWsEvent`);
  }
  const selectedFieldName = selection.name.value;
  const gripChannel = selectedFieldName;
  return gripChannel;
};

export interface IConnectionListener {
  /** Called when connection is closed explicitly */
  onClose?(closeCode: string): Promise<void>;
  /** Called when connection is disconnected uncleanly */
  onDisconnect?(): Promise<void>;
  /** Called with each message on the socket. Should return promise of messages to issue in response */
  onMessage(message: string): Promise<string | void>;
  /** Called when connection opens */
  onOpen?(): Promise<void | IOnOpenResponse>;
}

export interface IWebSocketOverHTTPConnectionInfo {
  /** Connection-ID from Pushpin */
  id: string;
  /** WebSocketContext for this connection. Can be used to issue grip control messages */
  webSocketContext: grip.WebSocketContext;
  /** Sec-WebSocket-Protocol */
  protocol?: string;
}

export interface IGraphqlWebSocketOverHttpConnectionListenerOptions {
  /** Info about the WebSocket-Over-HTTP Connection */
  connection: IWebSocketOverHTTPConnectionInfo;
  /** Handle a websocket message and optionally return a response */
  getMessageResponse(message: string): void | string | Promise<string | void>;
  /** Given a subscription operation, return a string that is the Grip-Channel that the GRIP server should subscribe to for updates */
  getGripChannel(subscriptionOperation: IGraphqlWsStartMessage): string;
}

/** interface for payload that comes up in a graphql-ws start event */
export interface IGraphqlWsStartEventPayload {
  /** graphql query operationName. Could be user-provided input */
  operationName: string | null;
  /** GraphQL query */
  query: string;
  /** Variables passed to GraphQL query */
  variables: { [variable: string]: any };
}

/**
 * https://github.com/apollographql/subscriptions-transport-ws/blob/master/PROTOCOL.md#gql_start
 */
export interface IGraphqlWsStartMessage {
  /** Subscription Operation ID */
  id: string;
  /** Message payload including subscription query */
  payload: IGraphqlWsStartEventPayload;
  /** Message type. Indicates that this is a start message */
  type: "start";
}

/** Return whether the provided value matches IGraphqlWsStartMessage  */
export const isGraphqlWsStartMessage = (
  o: any,
): o is IGraphqlWsStartMessage => {
  return (
    typeof o === "object" &&
    typeof o.id === "string" &&
    o.type === "start" &&
    typeof o.payload === "object" &&
    typeof o.payload.query === "string"
  );
};

/**
 * Connection Listener that tries to mock out a basic graphql-ws.
 * It's also grip and WebSocket-Over-HTTP aware.
 */
export default (
  options: IGraphqlWebSocketOverHttpConnectionListenerOptions,
): IConnectionListener => {
  return {
    async onMessage(message) {
      const graphqlWsEvent = JSON.parse(message);
      if (isGraphqlWsStartMessage(graphqlWsEvent)) {
        const gripChannel = options.getGripChannel(graphqlWsEvent);
        if (gripChannel) {
          console.debug(
            `GraphqlWebSocketOverHttpConnectionListener requesting grip subscribe to channel ${gripChannel}`,
          );
          options.connection.webSocketContext.subscribe(gripChannel);
        }
      }
      return options.getMessageResponse(message);
    },
    async onOpen() {
      const headers = {
        "sec-websocket-protocol": "graphql-ws",
      };
      return { headers };
    },
  };
};
