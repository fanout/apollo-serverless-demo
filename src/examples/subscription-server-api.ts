/**
 * The file is meant to be a recreation of the first example in how to use subscription-transport-ws.
 * The goal is to show how this library can be a drop-in addition to an existing app that now also wants to support WebSocket-Over-Http (e.g. with fanout.io).
 */
import { PubSub } from "apollo-server";
import { execute, subscribe } from "graphql";
import { createServer } from "http";
import { SubscriptionServer } from "subscriptions-transport-ws";
import FanoutGraphqlApolloConfig from "../FanoutGraphqlApolloConfig";
import { MapSimpleTable } from "../SimpleTable";

const WS_PORT = 5000;

const websocketServer = createServer((request, response) => {
  response.writeHead(404);
  response.end();
});

websocketServer.listen(WS_PORT, () => {
  console.log(`Websocket Server is now running on http://localhost:${WS_PORT}`);
});

const { schema } = FanoutGraphqlApolloConfig({
  pubsub: new PubSub(),
  subscriptions: true,
  tables: {
    notes: MapSimpleTable(),
  },
});

const subscriptionServer = SubscriptionServer.create(
  {
    execute,
    schema,
    subscribe,
  },
  {
    path: "/graphql",
    server: websocketServer,
  },
);
