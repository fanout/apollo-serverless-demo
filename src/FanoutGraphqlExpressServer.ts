import { PubSub } from "apollo-server";
import {
  ApolloServer,
  ApolloServerExpressConfig,
  buildSchemaFromTypeDefinitions,
  PubSubEngine,
} from "apollo-server-express";
import { getMainDefinition } from "apollo-utilities";
import * as assert from "assert";
import * as bodyParser from "body-parser";
import { EventEmitter } from "events";
import * as express from "express";
import { GraphQLObjectType, GraphQLSchema } from "graphql";
import gql from "graphql-tag";
import * as grip from "grip";
import * as http from "http";
import * as pubcontrol from "pubcontrol";
import { SubscriptionServer as WebSocketSubscriptionServer } from "subscriptions-transport-ws";
import { format as urlFormat } from "url";
import * as util from "util";
import FanoutGraphqlApolloConfig, {
  FanoutGraphqlTypeDefs,
  IFanoutGraphqlTables,
  INote,
} from "./FanoutGraphqlApolloConfig";
import { MapSimpleTable } from "./SimpleTable";
import { ApolloSubscriptionServerOptions } from "./subscriptions-transport-apollo/ApolloSubscriptionServerOptions";
import { createApolloSubscriptionsOptions } from "./subscriptions-transport-apollo/ApolloSubscriptionServerOptions";
import {
  SocketReadyState,
  SocketSubscriptionServer,
  SubscriptionSocket,
} from "./subscriptions-transport-core/server";

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
export const ApolloServerExpressApp = (apolloServer: ApolloServer, path: string) => {
  const apolloServerExpressApp = express().use((req, res, next) => {
    console.log("in ApolloServerExpressApp log middleware", req.path);
    return next();
  });
  const thisApolloServer = Object.create(apolloServer);
  thisApolloServer.subscriptionsPath = path
  thisApolloServer.applyMiddleware(
    {
      app: apolloServerExpressApp,
      path,
    }
  );
  return apolloServerExpressApp;
};

interface IGraphqlSubscriptionsMessageHandlerOptions {
  /** Called with graphql-ws start event. Return messages to respond with */
  onStart?(startEvent: object): void | string;
}

/**
 * WebSocket Message Handler that does a minimal handshake of graphql-ws.
 * Just for testing/mocking.
 */
const GraphqlSubscriptionsMessageHandler = (
  opts: IGraphqlSubscriptionsMessageHandlerOptions = {},
) => (message: string): string | void => {
  const graphqlWsEvent = JSON.parse(message);
  switch (graphqlWsEvent.type) {
    case "connection_init":
      return JSON.stringify({ type: "connection_ack" });
      break;
    case "start":
      if (opts.onStart) {
        return opts.onStart(graphqlWsEvent);
      }
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

type AsyncRequestHandler = (
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) => Promise<void>;
const AsyncExpress = (
  handleRequestAsync: AsyncRequestHandler,
): express.RequestHandler => {
  return (req, res, next) => {
    Promise.resolve(handleRequestAsync(req, res, next)).catch(next);
  };
};

interface IOnOpenResponse {
  /** response headers */
  headers: {
    [key: string]: string;
  };
}

interface IConnectionListener {
  /** Called when connection is closed explicitly */
  onClose?(closeCode: string): Promise<void>;
  /** Called when connection is disconnected uncleanly */
  onDisconnect?(): Promise<void>;
  /** Called with each message on the socket. Should return promise of messages to issue in response */
  onMessage(message: string): Promise<string | void>;
  /** Called when connection opens */
  onOpen?(): Promise<void | IOnOpenResponse>;
}

interface IWebSocketOverHTTPConnectionInfo {
  /** Connection-ID from Pushpin */
  id: string;
  /** WebSocketContext for this connection. Can be used to issue grip control messages */
  webSocketContext: grip.WebSocketContext;
  /** Sec-WebSocket-Protocol */
  protocol?: string;
}

interface IWebSocketOverHTTPExpressOptions {
  /** Configure to use GRIP */
  grip: {};
  /** GRIP control message prefix. see https://pushpin.org/docs/protocols/grip/ */
  gripPrefix?: string;
  /** look up a listener for the given connection */
  getConnectionListener(
    info: IWebSocketOverHTTPConnectionInfo,
  ): IConnectionListener;
}

/**
 * Express App that does WebSocket-Over-HTTP when getting requests from Pushpin
 */
const WebSocketOverHTTPExpress = (
  options: IWebSocketOverHTTPExpressOptions,
): express.RequestHandler => {
  const app = express()
    .use((req, res, next) => {
      console.log(
        "WebSocketOverHTTPExpress first middleware",
        req.url,
        req.headers,
        req.body,
      );
      return next();
    })
    .use(bodyParser.raw({ type: "application/websocket-events" }))
    .use(
      AsyncExpress(async (req, res, next) => {
        console.log(
          "WebSocketOverHTTPExpress main start",
          req.url,
          req.headers,
          req.body,
        );
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
        const connectionId = req.get("connection-id");
        const meta = {}; // TODO: get from req.headers that start with 'meta-'? Not sure why? https://github.com/fanout/node-faas-grip/blob/746e10ea90305d05e736ce6390ac9f536ecb061f/lib/faas-grip.js#L168
        const gripWebSocketContext = new grip.WebSocketContext(
          connectionId,
          meta,
          events,
          options.gripPrefix,
        );
        if (!events.length) {
          return res
            .status(400)
            .end(
              "Failed to parse any events from application/websocket-events",
            );
        }
        if (!connectionId) {
          throw new Error(`Expected connection-id header but none is present`);
        }
        const connectionListener = options.getConnectionListener({
          id: connectionId,
          protocol: req.get("sec-websocket-protocol"),
          webSocketContext: gripWebSocketContext,
        });
        const eventsOut: grip.WebSocketEvent[] = [];
        for (const event of events) {
          switch (event.getType()) {
            case "CLOSE": // "Close message with 16-bit close code."
              const closeCode = (event.getContent() || "").toString();
              if (connectionListener.onClose) {
                await connectionListener.onClose(closeCode);
              }
              eventsOut.push(new grip.WebSocketEvent("CLOSE", closeCode));
              break;
            case "DISCONNECT": // "Indicates connection closed uncleanly or does not exist."
              if (connectionListener.onDisconnect) {
                await connectionListener.onDisconnect();
              }
              eventsOut.push(new grip.WebSocketEvent("DISCONNECT"));
              break;
            case "OPEN":
              if (connectionListener.onOpen) {
                const onOpenResponse = await connectionListener.onOpen();
                if (onOpenResponse && onOpenResponse.headers) {
                  for (const [header, value] of Object.entries(
                    onOpenResponse.headers,
                  )) {
                    res.setHeader(header, value);
                  }
                }
              }
              eventsOut.push(new grip.WebSocketEvent("OPEN"));
              break;
            case "TEXT":
              const content = event.getContent();
              if (!content) {
                break;
              }
              const message = content.toString();
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
        res.setHeader("sec-websocket-extensions", 'grip; message-prefix=""');
        res.write(
          grip.encodeWebSocketEvents([...gripWebSocketContext.outEvents]),
        );
        res.write(grip.encodeWebSocketEvents([...eventsOut]));
        res.end();
      }),
    );
  return app;
};

/** TypeScript helper for exhaustive switches https://www.typescriptlang.org/docs/handbook/advanced-types.html  */
function assertNever(x: never): never {
  throw new Error("Unexpected object: " + x);
}

const LoggingConnectionListener = (connectionId: string) => {
  return {
    async onDisconnect() {
      console.log("connection disconnect", connectionId);
      return;
    },
    async onMessage(message: string) {
      console.log("connection message", connectionId, message);
      return;
    },
    async onOpen() {
      console.log("connection open", connectionId);
      return;
    },
  };
};

const SubscriptionSocketConnectionListener = (
  connection: IWebSocketOverHTTPConnectionInfo,
  handleConnection: (socket: SubscriptionSocket) => void,
): IConnectionListener => {
  // "error" | "close" | "message"
  const events = new EventEmitter();
  const socket: SubscriptionSocket = {
    close(code?: number, data?: string) {
      socket.readyState = SocketReadyState.CLOSED;
      console.log(
        "SubscriptionSocketConnectionListener socket got close()",
        code,
        data,
      );
      console.log(
        "TODO: Need to raise this to WebSocketOverHttpExpress so it can close its side",
      );
      return;
    },
    protocol: connection.protocol || "",
    readyState: SocketReadyState.OPEN,
    on(eventName: string, eventHandler) {
      events.on(eventName, (...args: any[]) => {
        eventHandler(...args);
      });
    },
    send(message: string) {
      console.log(
        "SubscriptionSocketConnectionListener socket got send()",
        message,
      );
      console.log(
        "Where should it go? It needs to be buffered somewhere, e.g. in memory for now? Or should it publish it via pubcontrol?",
      );
      return;
    },
  };
  handleConnection(socket);
  return {
    async onClose(closeCode: string) {
      console.log("connectionListener#onClose", connection.id, closeCode);
      // const closeCodeInt = parseInt(closeCode, 10)
      events.emit("close");
      return;
    },
    async onDisconnect() {
      console.log("connectionListener#onDisconnect", connection.id);
      events.emit("error", new Error("Unexpected disconnect"));
      return;
    },
    async onMessage(message: string) {
      console.log("connectionListener#onMessage", connection.id, message);
      events.emit("message", message);
      return;
    },
    async onOpen() {
      console.log("connectionListener#onOpen", connection.id);
      socket.readyState = SocketReadyState.OPEN;
      return;
    },
  };
};

interface IGraphqlWebSocketOverHttpConnectionListenerOptions {
  /** Info about the WebSocket-Over-HTTP Connection */
  connection: IWebSocketOverHTTPConnectionInfo;
  /** Grip configuration */
  grip: {};
  /** Handle a websocket message and optionally return a response */
  getMessageResponse(message: string): void | string | Promise<string | void>;
}

/**
 * Connection Listener that tries to mock out a basic graphql-ws.
 * It's also grip and WebSocket-Over-HTTP aware.
 */
const GraphqlWebSocketOverHttpConnectionListener = (
  options: IGraphqlWebSocketOverHttpConnectionListenerOptions,
): IConnectionListener => {
  return {
    async onMessage(message) {
      const graphqlWsEvent = JSON.parse(message);
      if (graphqlWsEvent.type === "start") {
        const query = gql`
          ${graphqlWsEvent.payload.query}
        `;
        const mainDefinition = getMainDefinition(query);
        const selections = mainDefinition.selectionSet.selections;
        const selection = selections[0];
        if (!selection) {
          throw new Error("could not parse selection from graphqlWsEvent");
        }
        if (selection.kind === "Field") {
          const selectedFieldName = selection.name.value;
          const gripChannel = selectedFieldName;
          console.debug(
            `GraphqlWebSocketOverHttpConnectionListener requesting grip subscribe to channel ${gripChannel}`,
          );
          options.connection.webSocketContext.subscribe(gripChannel);
        }
      }
      return options.getMessageResponse(message);
    },
    async onOpen() {
      const headers = {
        "sec-websocket-protocol": "graphql-ws",
      };
      return { headers };
    },
  };
};

interface IGripOptions {
  /** Grip Control URL */
  url: string;
}

interface IGripPubSubOptions {
  /** grip options */
  grip: IGripOptions;
}

const GripPubSub = (
  pubsub: PubSubEngine,
  subscriptionType: GraphQLObjectType,
  options: IGripPubSubOptions,
): PubSubEngine => {
  console.log("GripPubSub using control_uri", options.grip.url);
  const gripPubControl = new grip.GripPubControl({
    control_uri: options.grip.url,
  });
  const createGraphqlWsMessageForPublish = (
    triggerName: string,
    payload: any,
  ) => {
    const fieldForTrigger = subscriptionType.getFields()[triggerName];
    if (fieldForTrigger) {
      const fieldReturnTypeName = (() => {
        const fieldType = fieldForTrigger.type;
        if ("name" in fieldType) {
          return fieldType.name;
        }
        if ("ofType" in fieldType) {
          // e.g. a NotNullType
          return fieldType.ofType.name;
        }
        assertNever(fieldType);
      })();
      return JSON.stringify({
        id: "1", // TODO: this should be based on the subscription's graphqlWsEvent.id
        payload: {
          data: {
            [triggerName]: {
              __typename: fieldReturnTypeName,
              ...payload[triggerName],
            },
          },
        },
        type: "data",
      });
    } else {
      console.log(
        `createGraphqlWsMessageForPublish unexpected triggerName: ${triggerName}`,
      );
    }
    return;
  };
  return {
    asyncIterator: pubsub.asyncIterator,
    subscribe: pubsub.subscribe,
    unsubscribe: pubsub.unsubscribe,
    async publish(triggerName: string, payload: any) {
      await pubsub.publish(triggerName, payload);
      const graphqlWsMessage = createGraphqlWsMessageForPublish(
        triggerName,
        payload,
      );
      if (graphqlWsMessage) {
        await new Promise((resolve, reject) => {
          gripPubControl.publish(
            triggerName,
            new pubcontrol.Item(
              new grip.WebSocketMessageFormat(graphqlWsMessage),
            ),
            (success, error, context) => {
              console.log(
                `gripPubControl callback success=${success} error=${error} context=${context}`,
              );
              if (success) {
                return resolve(context);
              }
              return reject(error);
            },
          );
        });
      }
    },
  };
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
}

/**
 * ApolloServer configured for FanoutGraphql (not in lambda).
 */
export const FanoutGraphqlExpressServer = (
  options: IFanoutGraphqlExpressServerOptions,
) => {
  console.log("creating FanoutGraphqlExpressServer with options", options);
  const { onSubscriptionConnection, tables } = options;
  const basePubSub = new PubSub();
  const subscriptionType = buildSchemaFromTypeDefinitions(
    FanoutGraphqlTypeDefs(Boolean(basePubSub)),
  ).getSubscriptionType();
  if (!subscriptionType) {
    throw new Error(
      "Failed to build subscriptionType, but it is required for FanoutGraphqlExpressServer to work",
    );
  }
  const fanoutGraphqlApolloConfig = FanoutGraphqlApolloConfig(
    tables,
    options.grip
      ? GripPubSub(basePubSub, subscriptionType, { grip: options.grip })
      : basePubSub,
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
  );
  const socketSubscriptionServer = new SocketSubscriptionServer(
    apolloSubscriptionServerOptions,
  );
  const connectionListeners = new Map<string, IConnectionListener>();
  const rootExpressApp = express()
    .use((req, res, next) => {
      console.log(
        "FanoutGraphqlExpressServer - first middleware",
        req.path,
        req.originalUrl,
        req.headers,
      );
      next();
    })
    .use(
      options.grip
        ? WebSocketOverHTTPExpress({
            getConnectionListener(
              connection: IWebSocketOverHTTPConnectionInfo,
            ): IConnectionListener {
              return GraphqlWebSocketOverHttpConnectionListener({
                connection,
                getMessageResponse: GraphqlSubscriptionsMessageHandler({
                  onStart() {
                    if (onSubscriptionConnection) {
                      onSubscriptionConnection();
                    }
                  },
                }),
                grip: options.grip || {},
              });
            },
            // getConnectionListener(info: IWebSocketOverHTTPConnectionInfo): IConnectionListener {
            //   return LoggingConnectionListener(info.id);
            // },
            // getConnectionListener(info: IWebSocketOverHTTPConnectionInfo): IConnectionListener {
            //   return SubscriptionSocketConnectionListener(info, (socket) => socketSubscriptionServer.handleConnection(socket))
            //   // return LoggingConnectionListener(connectionId);
            // },
            grip: options.grip,
          })
        : (req, res, next) => next(),
    )
    .use((req, res, next) => {
      const apolloServerExpressApp = ApolloServerExpressApp(apolloServer, req.url)
      return apolloServerExpressApp(req, res, next)
    });

  rootExpressApp.use((req, res, next) => {
    console.log("FanoutGraphqlExpressServer rootExpressApp 404 middleare");
    res.status(404);
    res.end("FanoutGraphqlExpressServer 404");
  });
  rootExpressApp.use(
    (
      error: Error,
      req: express.Request,
      res: express.Response,
      next: express.NextFunction,
    ) => {
      console.log(
        "FanoutGraphqlExpressServer rootExpressApp error middleare",
        error,
      );
      res.status(500);
      res.end(`FanoutGraphqlExpressServer 500 ${error.message} ${error.stack}`);
    },
  );
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
    // consider not expsoing/creating this, but instead exposing a installSubscriptionHandlers(httpServer) method
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
    grip: {
      url: process.env.GRIP_URL || "http://localhost:5561",
    },
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
