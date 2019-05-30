import { getMainDefinition } from "apollo-utilities";
import gql from "graphql-tag";
import * as grip from "grip";

interface IOnOpenResponse {
  /** response headers */
  headers: {
    [key: string]: string;
  };
}

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
}

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
      if (graphqlWsEvent.type === "start") {
        const query = gql`
          ${graphqlWsEvent.payload.query}
        `;
        const mainDefinition = getMainDefinition(query);
        const selections = mainDefinition.selectionSet.selections;
        const selection = selections[0];
        if (!selection) {
          throw new Error("could not parse selection from graphqlWsEvent");
        }
        if (selection.kind === "Field") {
          const selectedFieldName = selection.name.value;
          const gripChannel = selectedFieldName;
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
