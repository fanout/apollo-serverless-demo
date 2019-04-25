import { PubSub } from "apollo-server";
import { ApolloServer, ApolloServerExpressConfig } from "apollo-server-express";
import * as bodyParser from "body-parser";
import { EventEmitter } from "events";
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
import { ApolloSubscriptionServerOptions } from "./subscriptions-transport-apollo/ApolloSubscriptionServerOptions";
import { createApolloSubscriptionsOptions } from "./subscriptions-transport-apollo/ApolloSubscriptionServerOptions";
import { SocketReadyState, SocketSubscriptionServer, SubscriptionSocket } from "./subscriptions-transport-core/server";

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

type AsyncRequestHandler = (req: express.Request, res: express.Response, next: express.NextFunction) => Promise<void>
const AsyncExpress = (handleRequestAsync: AsyncRequestHandler): express.RequestHandler => {
  return (req, res, next) => {
    Promise.resolve(handleRequestAsync(req, res, next)).catch(next)
  }
}

interface IConnectionListener {
  /** Called when connection is closed explicitly */
  onClose(closeCode: string): Promise<void>;
  /** Called when connection is disconnected uncleanly */
  onDisconnect(): Promise<void>;
  /** Called with each message on the socket. Should return promise of messages to issue in response */
  onMessage(message: string): Promise<string|void>;
  /** Called when connection opens */
  onOpen(): Promise<void>;
}

interface IWebSocketOverHTTPConnectionInfo {
  /** Connection-ID from Pushpin */
  id: string;
  /** Sec-WebSocket-Protocol */
  protocol?: string;
}

interface IWebSocketOverHTTPExpressOptions {
  /** look up a listener for the given connection */
  getConnectionListener(info: IWebSocketOverHTTPConnectionInfo): IConnectionListener;
}

/**
 * Express App that does WebSocket-Over-HTTP when getting requests from Pushpin
 */
const WebSocketOverHTTPExpress = (
  options: IWebSocketOverHTTPExpressOptions,
): express.RequestHandler => {
  const app = express()
    .use(bodyParser.raw({ type: "application/websocket-events" }))
    .use(AsyncExpress(async (req, res, next) => {
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
      const connectionId = req.get('connection-id')
      if ( ! connectionId) {
        throw new Error(`Expected connection-id header but none is present`)
      }
      const connectionListener = options.getConnectionListener({
        id: connectionId,
        protocol: req.get('sec-websocket-protocol'),
      })
      const eventsOut: grip.WebSocketEvent[] = [];
      for (const event of events) {
        switch (event.getType()) {
          case "CLOSE": // "Close message with 16-bit close code."
            const closeCode = (event.getContent() || "").toString()
            await connectionListener.onClose(closeCode)
            eventsOut.push(new grip.WebSocketEvent("CLOSE", closeCode));
            break;
          case "DISCONNECT": // "Indicates connection closed uncleanly or does not exist."
            await connectionListener.onDisconnect();
            eventsOut.push(new grip.WebSocketEvent("DISCONNECT"));
            break;
          case "OPEN":
            await connectionListener.onOpen();
            eventsOut.push(new grip.WebSocketEvent("OPEN"));
            break;
          case "TEXT":
            const content = event.getContent();
            if (!content) {
              break;
            }
            const message = content.toString()
            const response = await connectionListener.onMessage(message);
            if (response) {
              eventsOut.push(new grip.WebSocketEvent("TEXT", response));
            }
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
    }));
  return app;
};


/** TypeScript helper for exhaustive switches https://www.typescriptlang.org/docs/handbook/advanced-types.html  */
function assertNever(x: never): never {
  throw new Error("Unexpected object: " + x);
}

const LoggingConnectionListener = (connectionId: string) => {
  return {
    async onDisconnect() {
      console.log('connection disconnect', connectionId)
      return
    },
    async onMessage(message: string) {
      console.log('connection message', connectionId, message)
      return
    },
    async onOpen() {
      console.log('connection open', connectionId)
      return
    }
  }
}

const SubscriptionSocketConnectionListener = (connection: IWebSocketOverHTTPConnectionInfo, handleConnection: (socket: SubscriptionSocket) => void): IConnectionListener => {
  // "error" | "close" | "message"
  const events = new EventEmitter()
  const socket : SubscriptionSocket = {
    close(code?: number, data?: string) {
      socket.readyState = SocketReadyState.CLOSED
      console.log('SubscriptionSocketConnectionListener socket got close()', code, data)
      console.log("TODO: Need to raise this to WebSocketOverHttpExpress so it can close its side")
      return
    },
    protocol: connection.protocol || "",
    readyState: SocketReadyState.OPEN,
    on(eventName: string, eventHandler) {
      events.on(eventName, (...args: any[]) => {
        eventHandler(...args)
      })
    },
    send(message: string) {
      console.log('SubscriptionSocketConnectionListener socket got send()', message)
      console.log("Where should it go? It needs to be buffered somewhere, e.g. in memory for now? Or should it publish it via pubcontrol?")
      return
    }
  }
  handleConnection(socket);
  return {
    async onClose(closeCode: string) {
      console.log('connectionListener#onClose', connection.id, closeCode)
      // const closeCodeInt = parseInt(closeCode, 10)
      events.emit("close");
      return
    },
    async onDisconnect() {
      console.log('connectionListener#onDisconnect', connection.id)
      events.emit("error", new Error("Unexpected disconnect"))
      return
    },
    async onMessage(message: string) {
      console.log('connectionListener#onMessage', connection.id, message)
      events.emit("message", message)
      return
    },
    async onOpen() {
      console.log('connectionListener#onOpen', connection.id)
      socket.readyState = SocketReadyState.OPEN
      return
    }
  }
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
  const apolloSubscriptionServerOptions = ApolloSubscriptionServerOptions(
    apolloServer,
    fanoutGraphqlApolloConfigWithOnConnect,
    fanoutGraphqlApolloConfig.schema,
  )
  const socketSubscriptionServer = new SocketSubscriptionServer(apolloSubscriptionServerOptions);
  const connectionListeners = new Map<string, IConnectionListener>()
  const rootExpressApp = express()
    .use((req, res, next) => {
      next();
    })
    .use(
      WebSocketOverHTTPExpress({
        getConnectionListener(info: IWebSocketOverHTTPConnectionInfo): IConnectionListener {
          return SubscriptionSocketConnectionListener(info, (socket) => socketSubscriptionServer.handleConnection(socket))
          // return LoggingConnectionListener(connectionId);
        }
      }),
    )
    .use(ApolloServerExpressApp(apolloServer));

  const httpServer = http.createServer(rootExpressApp);

  // Use instead of ws-specific apolloServer.installSubscriptionHandlers(httpServer);
  const subscriptionServer = new WebSocketSubscriptionServer(
    apolloSubscriptionServerOptions,
    {
      path: createApolloSubscriptionsOptions(
        fanoutGraphqlApolloConfigWithOnConnect.subscriptions,
        apolloServer.graphqlPath,
      ).path,
      server: httpServer,
    },
  );
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
