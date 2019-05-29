/**
 * API Demo of adding WebSocketOverHttp support patching any http.Server
 * Almost all node.js web libraries support creating one of these from the underlying Application object.
 * In this example, we use zeit/micro, but you can do something similar with koa, express, raw node http, etc.
 */

import { buildSchemaFromTypeDefinitions, PubSub } from "apollo-server";
import { ApolloServer } from "apollo-server-micro";
import * as http from "http";
import micro from "micro";
import FanoutGraphqlApolloConfig, {
  FanoutGraphqlTypeDefs,
} from "../FanoutGraphqlApolloConfig";
import EpcpPubSubMixin from "../graphql-epcp-pubsub/EpcpPubSubMixin";
import { MapSimpleTable } from "../SimpleTable";
import GraphqlWsOverWebSocketOverHttpSubscriptionHandlerInstaller from "../subscriptions-transport-ws-over-http/GraphqlWsOverWebSocketOverHttpSubscriptionHandlerInstaller";

// This is what you need to support EPCP Publishes (make sure it gets to your resolvers who call pubsub.publish)
const pubsub = EpcpPubSubMixin({
  grip: {
    url: process.env.GRIP_URL || "http://localhost:5561",
  },
  // Build a schema from typedefs here but without resolvers (since they will need the resulting pubsub to publish to)
  schema: buildSchemaFromTypeDefinitions(FanoutGraphqlTypeDefs(true)),
})(new PubSub());

const apolloServer = new ApolloServer(
  FanoutGraphqlApolloConfig({
    pubsub,
    subscriptions: true,
    tables: {
      notes: MapSimpleTable(),
    },
  }),
);

// Note: In micro 9.3.5 this will return an http.RequestListener instead (after https://github.com/zeit/micro/pull/399)
// Provide it to http.createServer to create an http.Server
const httpServer: http.Server = micro(apolloServer.createHandler());

// This won't throw, but it also won't result in working WebSocket Subscriptions (when you create the subscription via gql api, a response comes back mentioning:
// { "error": { "name": "TypeError", "message": "Cannot read property 'addListener' of undefined" }
// But there is nothing useful on stderr of the server.
// apolloServer.installSubscriptionHandlers(httpServer)
GraphqlWsOverWebSocketOverHttpSubscriptionHandlerInstaller()(httpServer);

const port = process.env.PORT || 57410;
httpServer.listen(port, () => {
  console.log(`Server is now running on http://localhost:${port}`);
});
