/**
 * API from https://www.apollographql.com/docs/apollo-server/features/subscriptions#middleware
 */
import {
  ApolloServer,
  buildSchemaFromTypeDefinitions,
  PubSub,
} from "apollo-server-express";
import * as express from "express";
import { EpcpPubSubMixin, IStoredConnection } from "fanout-graphql-tools";
import { GraphqlWsOverWebSocketOverHttpExpressMiddleware } from "fanout-graphql-tools";
import { MapSimpleTable } from "fanout-graphql-tools";
import { IGraphqlSubscription } from "fanout-graphql-tools";
import * as http from "http";
import FanoutGraphqlApolloConfig, {
  FanoutGraphqlEpcpPublishesForPubSubEnginePublish,
  FanoutGraphqlGripChannelsForSubscription,
  FanoutGraphqlTypeDefs,
} from "../FanoutGraphqlApolloConfig";

const PORT = process.env.PORT || 4000;
const app = express();

/**
 * WebSocket-Over-HTTP Support requires storage to keep track of ws-over-http connections and subscriptions.
 * The Storage objects match an ISimpleTable interface that is a subset of the @pulumi/cloud Table interface. MapSimpleTable is an in-memory implementation, but you can use @pulumi/cloud implementations in production, e.g. to use DyanmoDB.
 */
const webSocketOverHttpStorage = {
  connections: MapSimpleTable<IStoredConnection>(),
  subscriptions: MapSimpleTable<IGraphqlSubscription>(),
};

// This is what you need to support WebSocket-Over-Http Subscribes
app.use(
  GraphqlWsOverWebSocketOverHttpExpressMiddleware({
    connectionStorage: webSocketOverHttpStorage.connections,
    getGripChannel: FanoutGraphqlGripChannelsForSubscription,
    subscriptionStorage: webSocketOverHttpStorage.subscriptions,
  }),
);

// Build a schema from typedefs here but without resolvers (since they will need the resulting pubsub to publish to)
const schema = buildSchemaFromTypeDefinitions(FanoutGraphqlTypeDefs(true));

// This is what you need to support EPCP Publishes (make sure it gets to your resolvers who call pubsub.publish)
const pubsub = EpcpPubSubMixin({
  epcpPublishForPubSubEnginePublish: FanoutGraphqlEpcpPublishesForPubSubEnginePublish(
    { schema, subscriptions: webSocketOverHttpStorage.subscriptions },
  ),
  grip: {
    url: process.env.GRIP_URL || "http://localhost:5561",
  },
  // Build a schema from typedefs here but without resolvers (since they will need the resulting pubsub to publish to)
  schema,
})(new PubSub());

const apolloServer = new ApolloServer(
  FanoutGraphqlApolloConfig({
    pubsub,
    subscriptions: true,
    tables: {
      notes: MapSimpleTable(),
      ...webSocketOverHttpStorage,
    },
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
