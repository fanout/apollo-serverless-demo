import { PubSub } from "apollo-server";
import { ApolloServer } from "apollo-server-express";
import * as express from "express";
import * as http from "http";
import { format as urlFormat } from "url";
import * as util from "util";
import FanoutGraphqlApolloConfig, {
  IFanoutGraphqlTables,
  INote,
} from "./FanoutGraphqlApolloConfig";
import { MapSimpleTable } from "./SimpleTable";

const apolloServerInfo = (
  httpServer: http.Server,
  apolloServer: ApolloServer,
) => {
  const httpServerAddress = httpServer.address();
  if (!(httpServerAddress && typeof httpServerAddress === "object")) {
    throw TypeError(`expected httpServerAddress to be object`);
  }
  const hostForUrl =
    httpServerAddress.address === "" || httpServerAddress.address === "::"
      ? "localhost"
      : httpServerAddress.address;
  return {
    subscriptionsUrl: urlFormat({
      hostname: hostForUrl,
      pathname: apolloServer.subscriptionsPath,
      port: httpServerAddress.port,
      protocol: "ws",
      slashes: true,
    }),
    url: urlFormat({
      hostname: hostForUrl,
      pathname: apolloServer.graphqlPath,
      port: httpServerAddress.port,
      protocol: "http",
    }),
  };
};

/**
 * ApolloServer configured for FanoutGraphql (not in lambda).
 */
export const FanoutGraphqlServer = (tables: IFanoutGraphqlTables) => {
  const expressApp = express();
  expressApp.use((req, res, next) => {
    next();
  });
  const apolloServer = new ApolloServer({
    ...FanoutGraphqlApolloConfig(tables, new PubSub()),
  });
  apolloServer.applyMiddleware({
    app: expressApp,
    path: "/",
  });
  const requestListener = expressApp;
  return {
    apolloServer,
    async listen(port: number | string) {
      const httpServer = http.createServer(requestListener);
      apolloServer.installSubscriptionHandlers(httpServer);
      await new Promise((resolve, reject) => {
        httpServer.on("listening", resolve);
        httpServer.on("error", reject);
        httpServer.listen(port);
      });
      return apolloServerInfo(httpServer, apolloServer);
    },
    requestListener,
  };
};

const main = async () => {
  const server = FanoutGraphqlServer({
    notes: MapSimpleTable<INote>(),
  });
  server.listen(process.env.PORT || 0).then(({ url, subscriptionsUrl }) => {
    console.log(`🚀 Server ready at ${url}`);
    console.log(`🚀 Subscriptions ready at ${subscriptionsUrl}`);
  });
};

if (require.main === module) {
  main().catch(error => {
    throw error;
  });
}
