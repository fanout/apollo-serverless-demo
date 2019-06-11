import {
  AsyncTest,
  Expect,
  FocusTest,
  IgnoreTest,
  TestFixture,
  Timeout,
} from "alsatian";
import { gql, PubSub } from "apollo-server-express";
import { EventEmitter } from "events";
import { IGraphqlWsStartMessage, MapSimpleTable } from "fanout-graphql-tools";
import { IGraphqlSubscription } from "fanout-graphql-tools/dist/src/subscriptions-transport-ws-over-http/GraphqlSubscription";
import * as http from "http";
import * as killable from "killable";
import { AddressInfo } from "net";
import * as url from "url";
import * as WebSocket from "ws";
import {
  FanoutGraphqlSubscriptionQueries,
  INote,
} from "./FanoutGraphqlApolloConfig";
import {
  apolloServerInfo,
  FanoutGraphqlExpressServer,
} from "./FanoutGraphqlExpressServer";
import { cli } from "./test/cli";
import {
  FanoutGraphqlHttpAtUrlTest,
  itemsFromLinkObservable,
  timer,
} from "./test/testFanoutGraphqlAtUrl";
import WebSocketApolloClient from "./WebSocketApolloClient";

const hostOfAddressInfo = (address: AddressInfo): string => {
  const host =
    address.address === "" || address.address === "::"
      ? "localhost"
      : address.address;
  return host;
};

const urlOfServerAddress = (address: AddressInfo): string => {
  return url.format({
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

const withListeningServer = (
  httpServer: http.Server,
  port: string | number = 0,
) => async (
  doWorkWithServer: (serverInfo: IListeningServerInfo) => Promise<void>,
) => {
  const { kill } = killable(httpServer);
  // listen
  await new Promise((resolve, reject) => {
    httpServer.on("listening", resolve);
    httpServer.on("error", error => {
      reject(error);
    });
    try {
      httpServer.listen(port);
    } catch (error) {
      reject(error);
    }
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
  await new Promise((resolve, reject) => {
    try {
      kill((error: Error | undefined) => {
        reject(error);
      });
    } catch (error) {
      reject(error);
    }
  });
  return;
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

/** Given a base URL and a Path, return a new URL with that path on the baseUrl (existing path on baseUrl is ignored) */
const urlWithPath = (baseUrl: string, pathname: string): string => {
  const parsedBaseUrl = url.parse(baseUrl);
  const newUrl = url.format({ ...parsedBaseUrl, pathname });
  return newUrl;
};

/** Test FanoutGraphqlExpressServer */
@TestFixture()
export class FanoutGraphqlExpressServerTestSuite {
  /**
   * Test FanoutGraphqlExpressServer with defaults
   */
  @Timeout(1000 * 60 * 10)
  @AsyncTest()
  public async testFanoutGraphqlExpressServer() {
    const [setLatestSocket, _, socketChangedEvent] = ChangingValue();
    const fanoutGraphqlExpressServer = FanoutGraphqlExpressServer({
      grip: false,
      onSubscriptionConnection: setLatestSocket,
      pubsub: new PubSub(),
      tables: {
        notes: MapSimpleTable<INote>(),
        subscriptions: MapSimpleTable<IGraphqlSubscription>(),
      },
    });
    await withListeningServer(fanoutGraphqlExpressServer.httpServer)(
      async () => {
        await FanoutGraphqlHttpAtUrlTest(
          apolloServerInfo(
            fanoutGraphqlExpressServer.httpServer,
            fanoutGraphqlExpressServer,
          ),
          socketChangedEvent,
        );
        return;
      },
    );
    return;
  }

  /**
   * Test through pushpin, sending messages through pushpin EPCP.
   * @TODO (bengo) This test relies on assuming that ApolloClient instances uses '1' as the subscription operation id for the first subscription it makes as well as some otherwise encapsulated details about how FanoutGraphqlExpressServer creates Grip-Channel names.
   * Therefore it is somewhat brittle. It also doesn't test anything that testFanoutGraphqlExpressServerThroughPushpin doesn't also test (this was just written before testFanoutGraphqlExpressServerThroughPushpin worked). This test will probably be removed soon since it's not adding unique value, only drag.
   */
  @AsyncTest()
  public async testFanoutGraphqlExpressServerThroughPushpinAndPublishThroughPushpin(
    graphqlPort = 57410,
    pushpinProxyUrl = "http://localhost:7999",
    pushpinGripUrl = "http://localhost:5561",
  ) {
    const [setLatestSocket, _, socketChangedEvent] = ChangingValue();
    const testName =
      "testFanoutGraphqlExpressServerThroughPushpinAndPublishThroughPushpin";
    const noteContent = `I'm a test note from ${testName}`;
    const fanoutGraphqlExpressServer = FanoutGraphqlExpressServer({
      grip: {
        url: pushpinGripUrl,
      },
      onSubscriptionConnection: setLatestSocket,
      tables: {
        notes: MapSimpleTable<INote>(),
        subscriptions: MapSimpleTable<IGraphqlSubscription>(),
      },
    });
    await withListeningServer(
      fanoutGraphqlExpressServer.httpServer,
      graphqlPort,
    )(async () => {
      const urls = {
        subscriptionsUrl: urlWithPath(
          pushpinProxyUrl,
          fanoutGraphqlExpressServer.subscriptionsPath,
        ),
        url: urlWithPath(
          pushpinProxyUrl,
          fanoutGraphqlExpressServer.graphqlPath,
        ),
      };
      const apolloClient = WebSocketApolloClient(urls);
      const subscriptionObservable = apolloClient.subscribe(
        FanoutGraphqlSubscriptionQueries.noteAdded(),
      );
      const subscriptionGotItems: any[] = [];
      const { unsubscribe } = subscriptionObservable.subscribe({
        next(item) {
          subscriptionGotItems.push(item);
        },
      });
      // await socketChangedEvent();
      await timer(2000);
      const grip = require("grip");
      const pubcontrol = require("pubcontrol");
      const grippub = new grip.GripPubControl({
        control_uri: "http://localhost:5561/",
      });
      const graphqlWsEventToPublish = {
        id: "1",
        payload: {
          data: {
            noteAdded: {
              __typename: "Note",
              content: noteContent,
            },
          },
        },
        type: "data",
      };
      await new Promise((resolve, reject) => {
        grippub.publish(
          "noteAdded?subscription.operation.id=1",
          new pubcontrol.Item(
            new grip.WebSocketMessageFormat(
              JSON.stringify(graphqlWsEventToPublish),
            ),
          ),
          (success: boolean, errorMessage: string, context: object) => {
            if (success) {
              resolve();
            } else {
              reject(Object.assign(new Error(errorMessage), { context }));
            }
          },
        );
      });
      await timer(1000);
      const lastItem = subscriptionGotItems[subscriptionGotItems.length - 1];
      Expect(lastItem).toBeTruthy();
      Expect(lastItem.data.noteAdded.content).toEqual(noteContent);
    });
  }
  /**
   * Test FanoutGraphqlExpressServer as requested through pushpin (must be running outside of this test suite).
   * https://pushpin.org/docs/getting-started/
   * Your /etc/pushpin/routes file should be like:
   * ```
   * * localhost:57410,over_http
   * ```
   */
  @AsyncTest()
  @Timeout(1000 * 60 * 10)
  public async testFanoutGraphqlExpressServerThroughPushpin(
    graphqlPort = 57410,
    pushpinProxyUrl = "http://localhost:7999",
    pushpinGripUrl = "http://localhost:5561",
  ) {
    const [setLatestSocket, _, socketChangedEvent] = ChangingValue();
    const fanoutGraphqlExpressServer = FanoutGraphqlExpressServer({
      grip: {
        url: pushpinGripUrl,
      },
      onSubscriptionConnection: setLatestSocket,
      tables: {
        notes: MapSimpleTable<INote>(),
        subscriptions: MapSimpleTable<IGraphqlSubscription>(),
      },
    });
    await withListeningServer(
      fanoutGraphqlExpressServer.httpServer,
      graphqlPort,
    )(async () => {
      await FanoutGraphqlHttpAtUrlTest(
        {
          subscriptionsUrl: urlWithPath(
            pushpinProxyUrl,
            fanoutGraphqlExpressServer.subscriptionsPath,
          ),
          url: urlWithPath(
            pushpinProxyUrl,
            fanoutGraphqlExpressServer.graphqlPath,
          ),
        },
        socketChangedEvent,
      );
      return;
    });
  }
  /**
   * Test that the server deletes rows from the subscription table after a subscription cleanly closes.
   */
  @AsyncTest()
  @Timeout(1000 * 60 * 10)
  public async testFanoutGraphqlExpressServerThroughPushpinDeletesSubscriptionAfterGqlWsStop(
    graphqlPort = 57410,
    pushpinProxyUrl = "http://localhost:7999",
    pushpinGripUrl = "http://localhost:5561",
  ) {
    const [setLatestSocket, _, socketChangedEvent] = ChangingValue();
    const [
      setLastSubscriptionStop,
      ,
      lastSubscriptionStopChange,
    ] = ChangingValue();
    const subscriptions = MapSimpleTable<IGraphqlSubscription>();
    const fanoutGraphqlExpressServer = FanoutGraphqlExpressServer({
      grip: {
        url: pushpinGripUrl,
      },
      onSubscriptionConnection: setLatestSocket,
      onSubscriptionStop: setLastSubscriptionStop,
      tables: {
        notes: MapSimpleTable<INote>(),
        subscriptions,
      },
    });
    await withListeningServer(
      fanoutGraphqlExpressServer.httpServer,
      graphqlPort,
    )(async () => {
      // We're going to make a new ApolloClient to subscribe with, and assert that starting and stopping subscriptions results in the expected number of rows in subscriptions table.
      const apolloClient = WebSocketApolloClient({
        subscriptionsUrl: urlWithPath(
          pushpinProxyUrl,
          fanoutGraphqlExpressServer.subscriptionsPath,
        ),
        url: urlWithPath(
          pushpinProxyUrl,
          fanoutGraphqlExpressServer.graphqlPath,
        ),
      });

      // Before any subscriptions, there should be 0 subscriptions stored
      const storedSubscriptionsBeforeSubscribe = await subscriptions.scan();
      Expect(storedSubscriptionsBeforeSubscribe.length).toEqual(0);

      // Subscribe
      const noteAddedObservable = apolloClient.subscribe(
        FanoutGraphqlSubscriptionQueries.noteAdded(),
      );
      const { items, subscription } = itemsFromLinkObservable(
        noteAddedObservable,
      );
      await socketChangedEvent();
      // Now that the subscription is established, there should be one stored subscription
      const storedSubscriptionsOnceSubscribed = await subscriptions.scan();
      Expect(storedSubscriptionsOnceSubscribed.length).toEqual(1);

      // Now we'll unsubscribe and then make sure the stored subscription is deleted
      subscription.unsubscribe();
      await lastSubscriptionStopChange();
      // There should be no more stored subscriptions
      const storedSubscriptionsAfterUnsubscribe = await subscriptions.scan();
      Expect(storedSubscriptionsAfterUnsubscribe.length).toEqual(0);
    });
  }

  /** Test with a raw WebSocket client and make sure that subscriptions are cleaned up after WebSocket#close() */
  @AsyncTest()
  public async testFanoutGraphqlExpressServerThroughPushpinAndTestSubscriptionsDeletedAfterConnectionClose(
    graphqlPort = 57410,
    pushpinProxyUrl = "http://localhost:7999",
    pushpinGripUrl = "http://localhost:5561",
  ) {
    //
    const keepAliveIntervalSeconds = 5;
    const [setLatestSocket, _, subscriptionStartedEvent] = ChangingValue();
    const [
      setLastSubscriptionStop,
      ,
      lastSubscriptionStopChange,
    ] = ChangingValue();
    const subscriptions = MapSimpleTable<IGraphqlSubscription>();
    const fanoutGraphqlExpressServer = FanoutGraphqlExpressServer({
      grip: {
        url: pushpinGripUrl,
      },
      onSubscriptionConnection: setLatestSocket,
      onSubscriptionStop: setLastSubscriptionStop,
      tables: {
        notes: MapSimpleTable<INote>(),
        subscriptions,
      },
      webSocketOverHttp: {
        keepAliveIntervalSeconds,
      },
    });
    await withListeningServer(
      fanoutGraphqlExpressServer.httpServer,
      graphqlPort,
    )(async () => {
      try {
        const subscriptionsUrl = urlWithPath(
          pushpinProxyUrl,
          fanoutGraphqlExpressServer.subscriptionsPath,
        );
        interface IWebSocketMessageEvent {
          /** message data */
          data: string;
        }
        const nextWebSocketMessage = (
          socket: WebSocket,
        ): Promise<IWebSocketMessageEvent> =>
          new Promise((resolve, reject) => {
            socket.addEventListener("message", event => resolve(event));
          });
        const ws = new WebSocket(subscriptionsUrl);
        const opened = new Promise((resolve, reject) => {
          ws.addEventListener("error", reject);
          ws.addEventListener("open", resolve);
        });
        await opened;
        // write graphql-ws so that a subscription gets created
        // connection_init
        ws.send(JSON.stringify({ type: "connection_init", payload: {} }));
        const message = await nextWebSocketMessage(ws);
        Expect(JSON.parse(message.data).type).toEqual("connection_ack");
        const subscriptionStartMessage = (
          operationId: string,
        ): IGraphqlWsStartMessage => {
          return {
            id: operationId,
            payload: {
              // "extensions": {},
              operationName: null,
              query: `
                subscription {
                  noteAdded {
                    content
                    id
                    __typename
                  }
                }
              `,
              variables: {},
            },
            type: "start",
          };
        };

        // send start message up the websocket to create a few subscriptions
        let nextOperationId = 1;
        const subscriptionsToCreate = 3;
        for (const i of Array.from({ length: subscriptionsToCreate })) {
          ws.send(
            JSON.stringify(subscriptionStartMessage(String(nextOperationId++))),
          );
          await subscriptionStartedEvent();
        }
        // make sure subscriptions were stored, since we'll assert they are deleted later after connection close
        const storedSubscriptionsAfterSubscribe = await subscriptions.scan();
        Expect(storedSubscriptionsAfterSubscribe.length).toEqual(
          subscriptionsToCreate,
        );

        // now close the websocket ane make sure all the subscriptions got deleted
        const closed = new Promise((resolve, reject) => {
          ws.addEventListener("close", resolve);
        });
        ws.close();
        await closed;
        const storedSubscriptionsAfterWebSocketClose = await subscriptions.scan();
        Expect(storedSubscriptionsAfterWebSocketClose.length).toBe(0);
      } catch (error) {
        throw error;
      }
    });
  }
}

if (require.main === module) {
  cli(__filename).catch((error: Error) => {
    throw error;
  });
}
