/**
 * API from https://www.apollographql.com/docs/apollo-server/features/subscriptions#middleware
 */
import { ApolloServer } from "apollo-server-express";
import express from "express";
import {
  IStoredConnection,
  IStoredPubSubSubscription,
} from "fanout-graphql-tools";
import { GraphqlWsOverWebSocketOverHttpExpressMiddleware } from "fanout-graphql-tools";
import { MapSimpleTable } from "fanout-graphql-tools";
import * as http from "http";
import FanoutGraphqlApolloConfig, {
  FanoutGraphqlGripChannelsForSubscription,
} from "../FanoutGraphqlApolloConfig";

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

const PORT = process.env.PORT || 4000;
const app = express().use(
  // This is what you need to support WebSocket-Over-Http Subscribes
  GraphqlWsOverWebSocketOverHttpExpressMiddleware({
    connectionStorage: webSocketOverHttpStorage.connections,
    getGripChannel: FanoutGraphqlGripChannelsForSubscription,
    pubSubSubscriptionStorage: webSocketOverHttpStorage.pubSubSubscriptions,
    schema: apolloServerConfig.schema,
  }),
);

apolloServer.applyMiddleware({ app });

const httpServer = http.createServer(app);
apolloServer.installSubscriptionHandlers(httpServer);

// ⚠️ Pay attention to the fact that we are calling `listen` on the http server variable, and not on `app`.
httpServer.listen(PORT, () => {
  console.log(
    `🚀 Server ready at http://localhost:${PORT}${apolloServer.graphqlPath}`,
  );
  console.log(
    `🚀 Subscriptions ready at ws://localhost:${PORT}${
      apolloServer.subscriptionsPath
    }`,
  );
});
