import { PubSub } from "apollo-server";
import { ApolloServer, ApolloServerExpressConfig } from "apollo-server-express";
import * as bodyParser from "body-parser";
import * as express from "express";
import * as grip from "grip";
import * as http from "http";
import { SubscriptionServer as WebSocketSubscriptionServer } from "subscriptions-transport-ws";
import { format as urlFormat } from "url";
import * as util from "util";
import FanoutGraphqlApolloConfig, {
  IFanoutGraphqlTables,
  INote,
} from "./FanoutGraphqlApolloConfig";
import { MapSimpleTable } from "./SimpleTable";
import { installSubscriptionServer } from "./SubscriptionServer";

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
export const ApolloServerExpressApp = (apolloServer: ApolloServer) => {
  const apolloServerExpressApp = express();
  apolloServer.applyMiddleware({
    app: apolloServerExpressApp,
    path: "/",
  });
  return apolloServerExpressApp;
};

/**
 * WebSocket Message Handler that does a minimal handshake of graphql-ws.
 * Just for testing/mocking.
 */
const DummyGraphqlSubscriptionsMessageHandler = () => (
  message: string,
): string | void => {
  const graphqlWsEvent = JSON.parse(message);
  switch (graphqlWsEvent.type) {
    case "connection_init":
      return JSON.stringify({ type: "connection_ack" });
      break;
    case "start":
      // send fake data message
      return JSON.stringify({
        id: graphqlWsEvent.id,
        payload: {
          data: {
            noteAdded: {
              __typename: "Note",
              content: "I am a fake note from WebSocketOverHTTPExpress",
            },
          },
        },
        type: "data",
      });
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

/**
 * WebSocket message handler that speaks graphql-ws for an ApolloServer.
 */
const ApolloGraphqlSubscriptionsMessageHandler = () => (message: string) => {
  const graphqlWsEvent = JSON.parse(message);
  switch (graphqlWsEvent.type) {
    case "connection_init":
      return JSON.stringify({ type: "connection_ack" });
      break;
    case "start":
      // do nothing for now
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
  return;
};

interface IWebSocketOverHTTPExpressOptions {
  /**
   * Function to call with each WebSocket-Over-HTTP TEXT event content.
   * It should return a string to send back to the client in response.
   */
  onMessage(message: string): string | void;
}

/**
 * Express App that does WebSocket-Over-HTTP when getting requests from Pushpin
 */
const WebSocketOverHTTPExpress = (
  options: IWebSocketOverHTTPExpressOptions,
): express.RequestHandler => {
  const app = express()
    .use(bodyParser.raw({ type: "application/websocket-events" }))
    .use((req, res, next) => {
      if (
        !(
          req.headers["grip-sig"] &&
          req.headers["content-type"] === "application/websocket-events"
        )
      ) {
        return next();
      }
      // ok it's a Websocket-Over-Http connection https://pushpin.org/docs/protocols/websocket-over-http/
      const events = grip.decodeWebSocketEvents(req.body);
      if (!events.length) {
        return res
          .status(400)
          .end("Failed to parse any events from application/websocket-events");
      }
      const eventsOut: grip.WebSocketEvent[] = [];
      for (const event of events) {
        switch (event.getType()) {
          case "OPEN":
            eventsOut.push(new grip.WebSocketEvent("OPEN"));
            break;
          case "TEXT":
            const content = event.getContent();
            if (!content) {
              break;
            }
            const response = options.onMessage(content.toString());
            if (response) {
              eventsOut.push(new grip.WebSocketEvent("TEXT", response));
            }
            break;
          case "DISCONNECT":
            eventsOut.push(new grip.WebSocketEvent("DISCONNECT"));
            break;
          default:
            throw new Error(`Unexpected event type ${event.getType()}`);
          // assertNever(event)
        }
      }
      res.status(200);
      res.setHeader("content-type", "application/websocket-events");
      if (req.headers["sec-websocket-protocol"] === "graphql-ws") {
        res.setHeader("sec-websocket-protocol", "graphql-ws");
      }
      res.write(grip.encodeWebSocketEvents(eventsOut));
      res.end();
    });
  return app;
};

/** TypeScript helper for exhaustive switches https://www.typescriptlang.org/docs/handbook/advanced-types.html  */
function assertNever(x: never): never {
  throw new Error("Unexpected object: " + x);
}

/** Options passed to FanoutGraphqlExpress */
interface IFanoutGraphqlExpressServerOptions {
  /** objects that store data for the app */
  tables: IFanoutGraphqlTables;
  /** called whenever a new GraphQL subscription connects */
  onSubscriptionConnection?: (...args: any[]) => any;
}

/**
 * ApolloServer configured for FanoutGraphql (not in lambda).
 */
export const FanoutGraphqlExpressServer = ({
  onSubscriptionConnection,
  tables,
}: IFanoutGraphqlExpressServerOptions) => {
  const fanoutGraphqlApolloConfig = FanoutGraphqlApolloConfig(
    tables,
    new PubSub(),
  );
  const fanoutGraphqlApolloConfigWithOnConnect: Partial<
    ApolloServerExpressConfig
  > = {
    ...fanoutGraphqlApolloConfig,
    subscriptions: {
      ...fanoutGraphqlApolloConfig.subscriptions,
      onConnect(connection, socket, context) {
        if (onSubscriptionConnection) {
          onSubscriptionConnection(connection, socket, context);
        }
        if (
          fanoutGraphqlApolloConfig &&
          fanoutGraphqlApolloConfig.subscriptions &&
          fanoutGraphqlApolloConfig.subscriptions.onConnect
        ) {
          return fanoutGraphqlApolloConfig.subscriptions.onConnect(
            connection,
            socket,
            context,
          );
        }
      },
    },
  };
  const apolloServer = new ApolloServer(fanoutGraphqlApolloConfigWithOnConnect);
  const rootExpressApp = express()
    .use((req, res, next) => {
      next();
    })
    .use(
      WebSocketOverHTTPExpress({
        onMessage: ApolloGraphqlSubscriptionsMessageHandler(),
      }),
    )
    .use(ApolloServerExpressApp(apolloServer));
  const httpServer = http.createServer(rootExpressApp);
  installSubscriptionServer(
    WebSocketSubscriptionServer.create,
    httpServer,
    apolloServer,
    fanoutGraphqlApolloConfigWithOnConnect,
    fanoutGraphqlApolloConfig.schema,
  );
  // apolloServer.installSubscriptionHandlers(httpServer);
  return {
    apolloServer,
    graphqlPath: "/",
    httpServer,
    async listen(port: number | string) {
      await new Promise((resolve, reject) => {
        httpServer.on("listening", resolve);
        httpServer.on("error", reject);
        httpServer.listen(port);
      });
      return apolloServerInfo(httpServer, apolloServer);
    },
    requestListener: rootExpressApp,
    subscriptionsPath: "/",
  };
};

const main = async () => {
  FanoutGraphqlExpressServer({
    tables: {
      notes: MapSimpleTable<INote>(),
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
