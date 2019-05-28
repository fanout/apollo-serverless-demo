/**
 * API from https://www.apollographql.com/docs/apollo-server/features/subscriptions#middleware
 */
import { ApolloServer, PubSub } from 'apollo-server-express'
import * as express from "express"
import * as http from "http"
import FanoutGraphqlApolloConfig from '../FanoutGraphqlApolloConfig';
import { MapSimpleTable } from '../SimpleTable';

const PORT = process.env.PORT || 4000;
const app = express();
const server = new ApolloServer(FanoutGraphqlApolloConfig({
  pubsub: new PubSub(),
  subscriptions: true,
  tables: {
    notes: MapSimpleTable(),
  },
}));

server.applyMiddleware({app})

const httpServer = http.createServer(app);
server.installSubscriptionHandlers(httpServer);

// ⚠️ Pay attention to the fact that we are calling `listen` on the http server variable, and not on `app`.
httpServer.listen(PORT, () => {
  console.log(`🚀 Server ready at http://localhost:${PORT}${server.graphqlPath}`)
  console.log(`🚀 Subscriptions ready at ws://localhost:${PORT}${server.subscriptionsPath}`)
})
