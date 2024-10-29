import { PubSub } from "apollo-server";
import {
  ApolloServer,
  ApolloServerExpressConfig,
  PubSubEngine,
} from "apollo-server-express";
import { getMainDefinition } from "apollo-utilities";
import * as bodyParser from "body-parser";
import * as express from "express";
import { MapSimpleTable } from "fanout-graphql-tools";
import { GraphqlWsOverWebSocketOverHttpExpressMiddleware } from "fanout-graphql-tools";
import gql from "graphql-tag";
import * as http from "http";
import { ConnectionContext } from "subscriptions-transport-ws";
import { format as urlFormat } from "url";
import * as WebSocket from "ws";
import FanoutGraphqlApolloConfig, {
  FanoutGraphqlGripChannelsForSubscription,
  IFanoutGraphqlTables,
  INote,
} from "./FanoutGraphqlApolloConfig";

/** Info about what paths ApolloClient should connect to */
export interface IApolloServerPathInfo {
  /** path to make subscriptions connections to */
  subscriptionsPath?: string;
  /** http path for graphql query/mutation endpoint */
  graphqlPath?: string;
}

/** Info about what URLs ApolloClient should connect to */
export interface IApolloServerUrlInfo {
  /** path to make subscriptions connections to */
  subscriptionsUrl: string;
  /** http path for graphql query/mutation endpoint */
  url: string;
}

/** Return url and subscriptionsUrl for provided servers */
export const apolloServerInfo = (
  httpServer: http.Server,
  pathInfo: IApolloServerPathInfo,
): IApolloServerUrlInfo => {
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
      pathname: pathInfo.subscriptionsPath,
      port: httpServerAddress.port,
      protocol: "ws",
      slashes: true,
    }),
    url: urlFormat({
      hostname: hostForUrl,
      pathname: pathInfo.graphqlPath,
      port: httpServerAddress.port,
      protocol: "http",
    }),
  };
};

/** Create an Express Application for the ApolloServer */
export const ApolloServerExpressApp = (
  apolloServer: ApolloServer,
  path: string,
) => {
  const apolloServerExpressApp = express();
  // .applyMiddleware reads from this.subscriptionsPath :|
  Object.assign(Object.create(apolloServer), {
    subscriptionsPath: path,
  }).applyMiddleware({
    app: apolloServerExpressApp,
    path,
  });
  return apolloServerExpressApp;
};

const apolloConfigWithOnConnect = (onConnect: (...args: any) => any) => <
  T extends Partial<ApolloServerExpressConfig>
>(
  config: T,
): T => {
  const existingSubscriptions = (() => {
    if (typeof config.subscriptions === "string") {
      return { path: config.subscriptions };
    }
    return config.subscriptions;
  })();
  const fanoutGraphqlApolloConfigWithOnConnect = {
    ...config,
    subscriptions: {
      ...existingSubscriptions,
      onConnect(
        connection: object,
        socket: WebSocket,
        context: ConnectionContext,
      ) {
        if (onConnect) {
          onConnect(connection, socket, context);
        }
        if (existingSubscriptions && existingSubscriptions.onConnect) {
          return existingSubscriptions.onConnect(connection, socket, context);
        }
      },
    },
  };
  return fanoutGraphqlApolloConfigWithOnConnect;
};

/** Configure FanoutGraphqlServer's grip implementation */
export interface IFanoutGraphqlServerGripOptions {
  /** Grip Control URL */
  url: string;
}

/** Options passed to FanoutGraphqlExpress */
interface IFanoutGraphqlExpressServerOptions {
  /** Configure grip */
  grip: false | IFanoutGraphqlServerGripOptions;
  /** objects that store data for the app */
  tables: IFanoutGraphqlTables;
  /** called whenever a new GraphQL subscription connects */
  onSubscriptionConnection?: (...args: any[]) => any;
  /** called when a GraphQL subscription is stopped */
  onSubscriptionStop?: (...args: any[]) => any;
  /** pubsub engine to use for pubsub */
  pubsub?: PubSubEngine;
  /** WebSocket-Over-HTTP options */
  webSocketOverHttp?: {
    /** how often to ask ws-over-http gateway to make keepalive requests */
    keepAliveIntervalSeconds?: number;
  };
}

/**
 * ApolloServer configured for FanoutGraphql (not in lambda).
 */
export const FanoutGraphqlExpressServer = (
  options: IFanoutGraphqlExpressServerOptions,
) => {
  const { onSubscriptionConnection, tables } = options;
  const pubsub = options.pubsub || new PubSub();
  const createApolloServerConfig = (
    subscriptions: boolean,
    aPubSub?: PubSubEngine,
  ) => {
    let fanoutGraphqlApolloConfig = FanoutGraphqlApolloConfig({
      grip: options.grip && {
        ...options.grip,
        getGripChannel: FanoutGraphqlGripChannelsForSubscription,
      },
      pubsub: aPubSub,
      subscriptions,
      tables,
    });
    if (onSubscriptionConnection) {
      fanoutGraphqlApolloConfig = apolloConfigWithOnConnect(
        onSubscriptionConnection,
      )(fanoutGraphqlApolloConfig);
    }
    return fanoutGraphqlApolloConfig;
  };
  const rootExpressApp = express()
    .use(
      options.grip
        ? (req, res, next) =>
            GraphqlWsOverWebSocketOverHttpExpressMiddleware({
              connectionStorage: options.tables.connections,
              getGripChannel: FanoutGraphqlGripChannelsForSubscription,
              onSubscriptionStart: onSubscriptionConnection,
              onSubscriptionStop: options.onSubscriptionStop,
              pubSubSubscriptionStorage: options.tables.pubSubSubscriptions,
              schema: createApolloServerConfig(true, pubsub).schema,
              webSocketOverHttp: options.webSocketOverHttp,
            })(req, res, next)
        : (req, res, next) => next(),
    )
    .use(bodyParser.json(), (req, res, next) => {
      const requestIsGraphqlMutation = (request: express.Request): boolean => {
        if (!(request.body && request.body.query)) {
          return false;
        }
        const query = gql`
          ${request.body.query}
        `;
        const mainDefinition = getMainDefinition(query);
        // TODO: not sure what happens if mainDefinition.kind is FragmentDefinition
        const isMutation =
          mainDefinition.kind === "OperationDefinition" &&
          mainDefinition.operation === "mutation";
        return isMutation;
      };
      const isGripRequest = (request: express.Request) =>
        "grip-sig" in request.headers;
      const subscriptionsEnabledForRequest = (
        request: express.Request,
      ): boolean => {
        return isGripRequest(request) || requestIsGraphqlMutation(request);
      };
      const apolloServerConfig = createApolloServerConfig(
        subscriptionsEnabledForRequest(req),
        pubsub,
      );
      const apolloServer = new ApolloServer({
        ...apolloServerConfig,
        playground: {
          cdnUrl: "https://graphql-playground.fanoutapp.com",
          version: undefined,
        },
      });
      const apolloServerExpressApp = ApolloServerExpressApp(
        apolloServer,
        req.url,
      );
      return apolloServerExpressApp(req, res, next);
    });

  const httpServer = http.createServer(rootExpressApp);

  // Install handlers for WebSocket Connections
  const webSocketApolloServer = new ApolloServer(
    createApolloServerConfig(true, options.pubsub),
  );
  webSocketApolloServer.installSubscriptionHandlers(httpServer);

  return {
    graphqlPath: "/",
    // consider not expsoing/creating this, but instead exposing a installSubscriptionHandlers(httpServer) method
    httpServer,
    async listen(port: number | string) {
      await new Promise((resolve, reject) => {
        httpServer.on("listening", resolve);
        httpServer.on("error", reject);
        httpServer.listen(port);
      });
      return apolloServerInfo(httpServer, webSocketApolloServer);
    },
    requestListener: rootExpressApp,
    subscriptionsPath: "/",
  };
};

/** Starts the server */
export const main = async () => {
  FanoutGraphqlExpressServer({
    grip: {
      url: process.env.GRIP_URL || "http://localhost:5561",
    },
    pubsub: new PubSub(),
    tables: {
      connections: MapSimpleTable(),
      notes: MapSimpleTable<INote>(),
      pubSubSubscriptions: MapSimpleTable(),
    },
  })
    .listen(process.env.PORT || 57410)
    .then(({ url, subscriptionsUrl }) => {
      console.log(`🚀 Server ready at ${url}`);
      console.log(`🚀 Subscriptions ready at ${subscriptionsUrl}`);
    });
};

if (require.main === module) {
  main().catch(error => {
    throw error;
  });
}
