export interface IGraphqlSubscriptionsMessageHandlerOptions {
  /** Called with graphql-ws start event. Return messages to respond with */
  onStart?(startEvent: object): void | string;
}

/**
 * WebSocket Message Handler that does a minimal handshake of graphql-ws.
 * It will allow all incoming connections, but won't actually send anything to the subscriber.
 * It's intended that messages will be published to subscribers out of band.
 */
export default (opts: IGraphqlSubscriptionsMessageHandlerOptions = {}) => (
  message: string,
): string | void => {
  const graphqlWsEvent = JSON.parse(message);
  switch (graphqlWsEvent.type) {
    case "connection_init":
      return JSON.stringify({ type: "connection_ack" });
      break;
    case "start":
      if (opts.onStart) {
        return opts.onStart(graphqlWsEvent);
      }
      break;
    case "stop":
      return JSON.stringify({
        id: graphqlWsEvent.id,
        payload: null,
        type: "complete",
      });
      break;
    default:
      console.log("Unexpected graphql-ws event type", graphqlWsEvent);
      throw new Error(`Unexpected graphql-ws event type ${graphqlWsEvent}`);
  }
};
