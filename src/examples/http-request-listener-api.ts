/**
 * API Demo of adding WebSocketOverHttp support to any http.RequestListener function (e.g. (req, res) => void).
 * Almost all node.js web libraries support creating one of these from the underlying Application object.
 * In this example, we use zeit/micro, but you can do something similar with koa, express, raw node http, etc.
 */

import { buildSchemaFromTypeDefinitions, PubSub } from "apollo-server";
import { ApolloServer } from "apollo-server-micro";
import * as http from "http";
import { run as microRun } from "micro";
import FanoutGraphqlApolloConfig, {
  FanoutGraphqlEpcpPublishesForPubSubEnginePublish,
  FanoutGraphqlGripChannelsForSubscription,
  FanoutGraphqlTypeDefs,
} from "../FanoutGraphqlApolloConfig";
import EpcpPubSubMixin from "../graphql-epcp-pubsub/EpcpPubSubMixin";
import { MapSimpleTable } from "../SimpleTable";
import GraphqlWsOverWebSocketOverHttpRequestListener from "../subscriptions-transport-ws-over-http/GraphqlWsOverWebSocketOverHttpRequestListener";

// Build a schema from typedefs here but without resolvers (since they will need the resulting pubsub to publish to)
const schema = buildSchemaFromTypeDefinitions(FanoutGraphqlTypeDefs(true));

// This is what you need to support EPCP Publishes (make sure it gets to your resolvers who call pubsub.publish)
const pubsub = EpcpPubSubMixin({
  epcpPublishForPubSubEnginePublish: FanoutGraphqlEpcpPublishesForPubSubEnginePublish(
    { schema },
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
      subscriptions: MapSimpleTable(),
    },
  }),
);

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
    getGripChannel: FanoutGraphqlGripChannelsForSubscription,
    subscriptionStorage: MapSimpleTable(),
  }),
);

const port = process.env.PORT || 57410;
httpServer.listen(port, () => {
  console.log(`Server is now running on http://localhost:${port}`);
});
