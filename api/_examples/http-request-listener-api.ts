/**
 * API Demo of adding WebSocketOverHttp support to any http.RequestListener function (e.g. (req, res) => void).
 * Almost all node.js web libraries support creating one of these from the underlying Application object.
 * In this example, we use zeit/micro, but you can do something similar with koa, express, raw node http, etc.
 */

import { ApolloServer } from "apollo-server-micro";
import {
  IStoredConnection,
  IStoredPubSubSubscription,
} from "fanout-graphql-tools";
import {
  GraphqlWsOverWebSocketOverHttpRequestListener,
  MapSimpleTable,
} from "fanout-graphql-tools";
import * as http from "http";
import { run as microRun } from "micro";
import FanoutGraphqlApolloConfig, {
  FanoutGraphqlGripChannelsForSubscription,
} from "../_lib/FanoutGraphqlApolloConfig";

/**
 * WebSocket-Over-HTTP Support requires storage to keep track of ws-over-http connections and subscriptions.
 * The Storage objects match an ISimpleTable interface that is a subset of the @pulumi/cloud Table interface. MapSimpleTable is an in-memory implementation, but you can use @pulumi/cloud implementations in production, e.g. to use DyanmoDB.
 */
const webSocketOverHttpStorage = {
  connections: MapSimpleTable<IStoredConnection>(),
  pubSubSubscriptions: MapSimpleTable<IStoredPubSubSubscription>(),
};

const apolloServerConfig = FanoutGraphqlApolloConfig({
  grip: {
    url: process.env.GRIP_URL || "http://localhost:5561",
  },
  subscriptions: true,
  tables: {
    notes: MapSimpleTable(),
    ...webSocketOverHttpStorage,
  },
});
const apolloServer = new ApolloServer(apolloServerConfig);

// This won't throw, but it also won't result in working WebSocket Subscriptions (when you create the subscription via gql api, a response comes back mentioning:
// { "error": { "name": "TypeError", "message": "Cannot read property 'addListener' of undefined" }
// But there is nothing useful on stderr of the server.
// apolloServer.installSubscriptionHandlers(httpServer)

// In micro 9.3.5, the default export of micro(handler) will return an http.RequestListener (after https://github.com/zeit/micro/pull/399).
// As of this authoring, only 9.3.4 is out, which returns an http.Server. So we manually build the RequestListner here.
// After 9.3.5, the following will work:
// import micro from "micro"
// const microRequestListener = micro(apolloServer.createHandler())
const microRequestListener: http.RequestListener = (req, res) =>
  microRun(req, res, apolloServer.createHandler());

const httpServer = http.createServer(
  GraphqlWsOverWebSocketOverHttpRequestListener(microRequestListener, {
    connectionStorage: webSocketOverHttpStorage.connections,
    getGripChannel: FanoutGraphqlGripChannelsForSubscription,
    pubSubSubscriptionStorage: webSocketOverHttpStorage.pubSubSubscriptions,
    schema: apolloServerConfig.schema,
  }),
);

const port = process.env.PORT || 57410;
httpServer.listen(port, () => {
  console.log(`Server is now running on http://localhost:${port}`);
});
