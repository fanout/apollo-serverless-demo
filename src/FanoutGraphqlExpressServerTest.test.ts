import {
  AsyncTest,
  Expect,
  FocusTest,
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
import { format as urlFormat } from "url";
import { promisify } from "util";
import FanoutGraphqlApolloConfig, { INote } from "./FanoutGraphqlApolloConfig";
import {
  ApolloServerExpressApp,
  apolloServerInfo,
  FanoutGraphqlExpressServer,
} from "./FanoutGraphqlExpressServer";
import { MapSimpleTable } from "./SimpleTable";
import { cli } from "./test/cli";
import { FanoutGraphqlHttpAtUrlTest } from "./test/testFanoutGraphqlAtUrl";

const hostOfAddressInfo = (address: AddressInfo): string => {
  const host =
    address.address === "" || address.address === "::"
      ? "localhost"
      : address.address;
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

/** Test FanoutGraphqlExpressServer */
@TestFixture()
export class FanoutGraphqlExpressServerTestSuite {
  /**
   * Test FanoutGraphqlExpressServer
   */
  @Timeout(1000 * 60 * 10)
  @AsyncTest()
  public async testFanoutGraphqlExpressServer() {
    const [setLatestSocket, _, socketChangedEvent] = ChangingValue();
    const fanoutGraphqlExpressServer = FanoutGraphqlExpressServer({
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
}

if (require.main === module) {
  cli(__filename).catch((error: Error) => {
    throw error;
  });
}
