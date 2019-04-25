import {
  AsyncTest,
  Expect,
  FocusTest,
  IgnoreTest,
  Test,
  TestCase,
  TestFixture,
  Timeout,
} from "alsatian";
import { PubSub } from "apollo-server";
import { ApolloServer as ApolloServerExpress } from "apollo-server-express";
import { EventEmitter } from "events";
import * as express from "express";
import * as http from "http";
import { AddressInfo } from "net";
import * as url from "url";
import { promisify } from "util";
import FanoutGraphqlApolloConfig, { INote } from "./FanoutGraphqlApolloConfig";
import {
  ApolloServerExpressApp,
  apolloServerInfo,
  FanoutGraphqlExpressServer,
} from "./FanoutGraphqlExpressServer";
import { MapSimpleTable } from "./SimpleTable";
import { cli } from "./test/cli";
import {
  FanoutGraphqlHttpAtUrlTest,
  timer,
} from "./test/testFanoutGraphqlAtUrl";

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
  // listen
  await new Promise((resolve, reject) => {
    httpServer.on("listening", resolve);
    httpServer.on("error", error => {
      reject(error);
    });
    httpServer.listen(port);
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
      },
    );
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
  // @IgnoreTest(
  //   "This test won't pass until getting further on WebSocketOverHttpSubscriptionServer and having FanoutGraphqlExpressServer use it",
  // )
  @Timeout(1000 * 60 * 10)
  public async testFanoutGraphqlExpressServerThroughPushpin(
    graphqlPort = 57410,
    pushpinUrl = "http://localhost:7999",
  ) {
    const [setLatestSocket, _, socketChangedEvent] = ChangingValue();
    const fanoutGraphqlExpressServer = FanoutGraphqlExpressServer({
      grip: {
        channel: "testFanoutGraphqlExpressServerThroughPushpin",
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
            pushpinUrl,
            fanoutGraphqlExpressServer.subscriptionsPath,
          ),
          url: urlWithPath(pushpinUrl, fanoutGraphqlExpressServer.graphqlPath),
        },
        // socketChangedEvent, // disabled for now since through pushpin everything is mocked. There isn't actually a socket changed event yet! Use a timer for now
        () => timer(2000),
      );
      console.log("after test");
    });
  }
}

if (require.main === module) {
  cli(__filename).catch((error: Error) => {
    throw error;
  });
}
