import {
  AsyncTest,
  Expect,
  Test,
  TestCase,
  TestFixture,
  Timeout,
} from "alsatian";
import { InMemoryCache } from "apollo-cache-inmemory";
import { ApolloClient, SubscriptionOptions } from "apollo-client";
import { Observable } from "apollo-client/util/Observable";
import { Operation, split } from "apollo-link";
import { createHttpLink } from "apollo-link-http";
import { WebSocketLink } from "apollo-link-ws";
import { ApolloServer, gql, PubSub } from "apollo-server";
import { ApolloServer as ApolloServerExpress } from "apollo-server-express";
import { getMainDefinition } from "apollo-utilities";
import bodyParser = require("body-parser");
import { EventEmitter } from "events";
import * as express from "express";
import * as http from "http";
import { AddressInfo } from "net";
import fetch from "node-fetch";
import { SubscriptionServer as WebsocketSubscriptionServer } from "subscriptions-transport-ws";
import { format as urlFormat } from "url";
import { promisify } from "util";
import * as WebSocket from "ws";
import FanoutGraphqlApolloConfig from "./FanoutGraphqlApolloConfig";
import {
  ApolloServerExpressApp,
  apolloServerInfo,
  IApolloServerPathInfo,
  IApolloServerUrlInfo,
} from "./FanoutGraphqlServer";
import { MapSimpleTable } from "./SimpleTable";
import { SubscriptionServer as WebSocketOverHttpSubscriptionServer } from "./subscriptions-transport-ws-over-http/src";
import { cli } from "./test/cli";

// const createWebSocketSubscriptionServer = (): WebsocketSubscriptionServer => {

// }

const subscriptionQueries = {
  noteAdded: `
    subscription {
      noteAdded {
        content
      }
    }
  `,
};

const hostOfAddressInfo = (address: AddressInfo): string => {
  const host = address.address;
  // address.address === "" || address.address === "::"
  //   ? "localhost"
  //   : address.address;
  return host;
};

const urlOfServerAddress = (address: AddressInfo): string => {
  return urlFormat({
    hostname: hostOfAddressInfo(address),
    port: address.port,
    protocol: "http",
  });
};

interface IListeningServerInfo {
  /** url at which the server can be reached */
  url: string;
  /** host of server */
  hostname: string;
  /** port of server */
  port: number;
}

const withListeningServer = (httpServer: http.Server) => async (
  doWorkWithServer: (serverInfo: IListeningServerInfo) => Promise<void>,
) => {
  // listen
  await new Promise((resolve, reject) => {
    httpServer.on("listening", resolve);
    httpServer.on("error", error => {
      reject(error);
    });
    httpServer.listen(0);
  });
  const address = httpServer.address();
  if (typeof address === "string" || !address) {
    throw new Error(`Can't determine URL from address ${address}`);
  }
  await doWorkWithServer({
    hostname: hostOfAddressInfo(address),
    port: address.port,
    url: urlOfServerAddress(address),
  });
  await promisify(httpServer.close.bind(httpServer));
};

const WebsocketApolloClient = ({
  url,
  subscriptionsUrl,
}: IApolloServerUrlInfo) => {
  const httpLink = createHttpLink({
    fetch,
    uri: url,
    useGETForQueries: true,
  });
  const wsLink = new WebSocketLink({
    options: {
      reconnect: true,
      timeout: 999999999,
    },
    uri: subscriptionsUrl,
    webSocketImpl: WebSocket,
  });
  const link = split(
    // split based on operation type
    ({ query }) => {
      const definition = getMainDefinition(query);
      return (
        definition.kind === "OperationDefinition" &&
        definition.operation === "subscription"
      );
    },
    wsLink,
    httpLink,
  );
  const apolloClient = new ApolloClient({
    cache: new InMemoryCache(),
    link,
  });
  return apolloClient;
};

/** return promise of one item on observable */
const takeOne = async <T extends any>(
  observable: Observable<T>,
): Promise<T> => {
  return new Promise((resolve, reject) => {
    const subscription = observable.subscribe({
      error: error => {
        subscription.unsubscribe();
        reject(error);
      },
      next: val => {
        subscription.unsubscribe();
        resolve(val);
      },
    });
  });
};

const ChangingValue = <T>(): [
  (v: T) => void,
  () => Promise<T>,
  () => Promise<T>
] => {
  let value: T | undefined;
  let valueIsSet = false;
  const emitter = new EventEmitter();
  const setValue = (valueIn: T) => {
    value = valueIn;
    valueIsSet = true;
    emitter.emit("value", value);
  };
  const getNextValue = async (): Promise<T> => {
    return new Promise((resolve, reject) => {
      emitter.on("value", resolve);
    });
  };
  const getValue = async (): Promise<T> => {
    if (valueIsSet) {
      return value as T;
    }
    return getNextValue();
  };
  return [setValue, getValue, getNextValue];
};

/** Test SubscriptionsTransportWebsocketOverHttp */
@TestFixture()
export class SubscriptionsTransportWebsocketOverHttpTestSuite {
  /** test */
  @Timeout(1000 * 60 * 60)
  @AsyncTest()
  public async testCreateWebsocketSubscriptionServer() {
    const apolloConfig = FanoutGraphqlApolloConfig(
      {
        notes: MapSimpleTable(),
      },
      new PubSub(),
    );
    /** Keep track of subscription connections so we can wait for them to be established below */
    const [setLatestSocket, _, socketChangedEvent] = ChangingValue();
    const apolloServer = new ApolloServerExpress({
      ...apolloConfig,
      introspection: true,
      playground: true,
      subscriptions: {
        ...apolloConfig.subscriptions,
        onConnect(opts, socket) {
          setLatestSocket(socket);
        },
      },
    });
    const expressApp = express()
      .use((req, res, next) => {
        next();
      })
      .use(ApolloServerExpressApp(apolloServer));
    const httpServer = http.createServer(expressApp);
    apolloServer.installSubscriptionHandlers(httpServer);
    await testFanoutGraphqlHttpServer(httpServer, socketChangedEvent);
  }
}

/** Test an httpServer to ensure it properly serves Fanout GraphQL Demo (notes, addNote, noteAdded) */
async function testFanoutGraphqlHttpServer(
  httpServer: http.Server,
  /** return promise of when the latest websocket changes. Will be waited for between subscription and mutation */
  socketChangedEvent: () => Promise<any>,
) {
  await withListeningServer(httpServer)(async () => {
    const newNoteContent = "I'm from a test";
    const apolloClient = WebsocketApolloClient(
      apolloServerInfo(httpServer, {
        graphqlPath: "/",
        subscriptionsPath: "/",
      }),
    );
    const subscriptionObservable = apolloClient.subscribe({
      query: gql(subscriptionQueries.noteAdded),
      variables: {},
    });
    const promiseFirstSubscriptionEvent = takeOne(subscriptionObservable);
    // Wait until the server actually gets the subscription connection to issue the mutation,
    // otherwise we may not actually receive it.
    await socketChangedEvent();
    const mutationResult = await apolloClient.mutate({
      mutation: gql`
        mutation {
          addNote(note: { content: "${newNoteContent}" }) {
            content
          }
        }
      `,
    });
    const firstEvent = await promiseFirstSubscriptionEvent;
    Expect(firstEvent.data.noteAdded.content).toEqual(newNoteContent);
  });
}

if (require.main === module) {
  cli(__filename).catch((error: Error) => {
    throw error;
  });
}
