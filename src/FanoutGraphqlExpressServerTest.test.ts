import {
  AsyncTest,
  Expect,
  FocusTest,
  IgnoreTest,
  TestFixture,
  Timeout,
} from "alsatian";
import {
  ApolloServer as ApolloServerExpress,
  gql,
  PubSub,
} from "apollo-server-express";
import { EventEmitter } from "events";
import * as http from "http";
import * as killable from "killable";
import { AddressInfo } from "net";
import * as url from "url";
import {
  FanoutGraphqlSubscriptionQueries,
  INote,
} from "./FanoutGraphqlApolloConfig";
import {
  apolloServerInfo,
  FanoutGraphqlExpressServer,
} from "./FanoutGraphqlExpressServer";
import { MapSimpleTable } from "./SimpleTable";
import { cli } from "./test/cli";
import {
  FanoutGraphqlHttpAtUrlTest,
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
      kill((error: Error) => {
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

  /** Test through pushpin, sending messages through pushpin EPCP */
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
      const subscriptionObservable = apolloClient.subscribe({
        query: gql(FanoutGraphqlSubscriptionQueries.noteAdded),
        variables: {},
      });
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
          "noteAdded",
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
  @FocusTest
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
}

if (require.main === module) {
  cli(__filename).catch((error: Error) => {
    throw error;
  });
}
